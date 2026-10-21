import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AcpOwnedGroup, type AcpOwnedGroupPorts } from "../src/adapters/acp-owned-group.ts";
import { peerChildEnv, readProcessTable, type ProcRow } from "../src/hub/child-process.ts";

function fixture() {
  const pid = 12345;
  const leader: ProcRow = { pid, ppid: process.pid, pgid: pid, started: "start-1", command: "fixture foreground" };
  let rows: ProcRow[] | undefined = [leader];
  let signature: string | undefined = "signature-1";
  let now = 0;
  const signals: [number, NodeJS.Signals][] = [];
  const child: { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null } = { pid, exitCode: null, signalCode: null };
  const proc = child as ChildProcess;
  const ports: AcpOwnedGroupPorts = {
    table: () => rows,
    signature: () => signature,
    signal: (target, signal) => { signals.push([target, signal]); if (signal === "SIGKILL") rows = []; },
    now: () => now,
    sleep: async ms => { now += ms; },
  };
  return { pid, leader, proc, child, ports, signals, rows: (value: ProcRow[] | undefined) => { rows = value; }, signature: (value: string | undefined) => { signature = value; } };
}

test("owned ACP capture requires a positive live foreground child group", async () => {
  const f = fixture();
  const proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  await proof.verify();
  expect(f.signals).toEqual([]);
  for (const rows of [undefined, [], [{ ...f.leader, pgid: 67890 }], [{ ...f.leader, ppid: 1 }]]) {
    f.rows(rows);
    await expect(AcpOwnedGroup.capture(f.proc, f.ports)).rejects.toThrow("ownership");
  }
  f.rows([f.leader]); f.signature(undefined);
  await expect(AcpOwnedGroup.capture(f.proc, f.ports)).rejects.toThrow("ownership");
  expect(f.signals).toEqual([]);
});

test("owned ACP stop freezes and kills only the positively verified original group", async () => {
  const f = fixture();
  const foreign = { ...f.leader, pid: 23456, ppid: f.pid, pgid: 23456 };
  f.rows([f.leader, { ...f.leader, pid: 12346, ppid: f.pid }, foreign]);
  const proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  const initialSignal = f.ports.signal;
  f.ports.signal = (target, signal) => { initialSignal(target, signal); if (signal === "SIGKILL") f.rows([foreign]); };
  await proof.stop();
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"], [-f.pid, "SIGKILL"]]);
});

test("owned ACP stop refuses missing evidence, PID reuse and changed groups without signalling", async () => {
  for (const mutation of ["unknown", "missing-signature", "started", "ppid", "pgid", "exited", "leader-gone"] as const) {
    const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
    if (mutation === "unknown") f.rows(undefined);
    if (mutation === "missing-signature") f.signature(undefined);
    if (mutation === "started") f.rows([{ ...f.leader, started: "start-2" }]);
    if (mutation === "ppid") f.rows([{ ...f.leader, ppid: 1 }]);
    if (mutation === "pgid") f.rows([{ ...f.leader, pgid: 67890 }]);
    if (mutation === "exited") f.child.exitCode = 0;
    if (mutation === "leader-gone") f.rows([{ ...f.leader, pid: 12346, ppid: 1 }]);
    await expect(proof.stop()).rejects.toThrow("ownership");
    expect(f.signals).toEqual([]);
  }
});

test("an exec shim keeps owned ACP identity when only its command and signature change", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  f.rows([{ ...f.leader, command: "native foreground after exec" }]);
  f.signature("native-signature-after-exec");
  await proof.verify();
  await proof.stop();
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"], [-f.pid, "SIGKILL"]]);
});

test("a real shell exec into a fake ACP server preserves verified ownership through stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-owned-acp-exec-"));
  const script = join(root, "native.ts");
  writeFileSync(script, `import { createInterface } from "node:readline";
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ nativeReady: true });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  send({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
    ? { protocolVersion: 1, agentInfo: { name: "Owned Exec Fixture", version: "1" } }
    : { sessionId: "owned-exec-session" } });
}`);
  // The shell remains alive until capture completes, then exec replaces it with the fake native process.
  const proc = spawn("/bin/sh", ["-c", 'printf "shell-ready\\n"; IFS= read -r gate; exec "$@"', "owned-acp-exec", process.execPath, script], {
    cwd: root, env: peerChildEnv("fixture"), detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => { proc.once("exit", () => resolve()); proc.once("error", () => resolve()); });
  const lines: string[] = [];
  const reader = createInterface({ input: proc.stdout }); reader.on("line", line => lines.push(line));
  proc.stdin.on("error", () => {}); proc.stderr.resume();
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 300 && !condition(); attempt++) await Bun.sleep(10);
    expect(condition()).toBe(true);
  };
  try {
    await until(() => lines.includes("shell-ready"));
    const proof = await AcpOwnedGroup.capture(proc);
    proc.stdin.write("exec-now\n");
    await until(() => lines.some(line => line.includes('"nativeReady":true')));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    await until(() => lines.some(line => line.includes('"name":"Owned Exec Fixture"')));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\n");
    await until(() => lines.some(line => line.includes('"sessionId":"owned-exec-session"')));
    await proof.verify();
    await proof.stop();
    await exited;
    const rows = await readProcessTable(); expect(rows).toBeDefined();
    expect(rows!.some(row => row.pid === proc.pid || row.pgid === proc.pid)).toBe(false);
  } finally {
    // This fixture starts no child beneath its foreground shell/native process. Cleanup targets only its own group.
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) try { process.kill(-proc.pid, "SIGKILL"); } catch { /* the child may already have exited */ }
    await exited; reader.close(); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an already empty original ACP group is confirmed without signals", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  f.child.exitCode = 0; f.rows([]); f.signature(undefined);
  await proof.stop();
  expect(f.signals).toEqual([]);
});

test("loss of proof after freezing never authorizes another signal", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  f.ports.signal = (target, signal) => { f.signals.push([target, signal]); f.signature(undefined); };
  await expect(proof.stop()).rejects.toThrow("ownership");
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"]]);
});

test("owned ACP stop refuses to confirm a group with surviving members", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  f.ports.signal = (target, signal) => { f.signals.push([target, signal]); };
  await expect(proof.stop({ killMs: 20 })).rejects.toThrow("shutdown incomplete");
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"], [-f.pid, "SIGKILL"]]);
});

test("after SIGKILL an original defunct row is polled to disappearance without more signals", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  let killed = false, postKillReads = 0;
  f.ports.signal = (target, signal) => { f.signals.push([target, signal]); if (signal === "SIGKILL") killed = true; };
  f.ports.table = () => killed
    ? ++postKillReads === 1 ? [{ ...f.leader, ppid: 1, command: "[fixture] <defunct>" }] : []
    : [f.leader];
  await proof.stop();
  expect(postKillReads).toBe(2);
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"], [-f.pid, "SIGKILL"]]);
});

test("a reused leader start after SIGKILL is never confirmed as the original group", async () => {
  const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
  f.ports.signal = (target, signal) => { f.signals.push([target, signal]); if (signal === "SIGKILL") f.rows([{ ...f.leader, started: "reused-start" }]); };
  await expect(proof.stop()).rejects.toThrow("ownership");
  expect(f.signals).toEqual([[-f.pid, "SIGSTOP"], [-f.pid, "SIGKILL"]]);
});

test("capture-failure cleanup confirms a missing PID without probing or signalling", async () => {
  const f = fixture();
  let reads = 0;
  f.ports.table = () => { reads++; throw new Error("must not probe an unspawned child"); };
  expect(await AcpOwnedGroup.confirmGone({ pid: undefined, exitCode: null, signalCode: null } as ChildProcess, f.ports)).toBe(true);
  expect(reads).toBe(0); expect(f.signals).toEqual([]);
});

test("capture-failure cleanup requires observed exit and an empty original PID/group", async () => {
  const f = fixture();
  f.rows([]);
  expect(await AcpOwnedGroup.confirmGone(f.proc, f.ports)).toBe(false);
  f.child.exitCode = 0;
  expect(await AcpOwnedGroup.confirmGone(f.proc, f.ports)).toBe(true);
  for (const rows of [undefined, [{ ...f.leader, started: "foreign-reused-pid", pgid: 45678 }], [{ ...f.leader, pid: 45678, ppid: 1 }]]) {
    f.rows(rows);
    expect(await AcpOwnedGroup.confirmGone(f.proc, f.ports)).toBe(false);
  }
  f.ports.table = () => { throw new Error("unknown process table"); };
  expect(await AcpOwnedGroup.confirmGone(f.proc, f.ports)).toBe(false);
  expect(f.signals).toEqual([]);
});
