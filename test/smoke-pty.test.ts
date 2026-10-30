import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MAX_PTY_OUTPUT_BYTES, runPty, runPtyWith } from "../src/cli/smoke-pty.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-smoke-pty-")); dirs.push(dir); return dir; };
const options = (cwd: string, patch: Partial<Parameters<typeof runPty>[1]> = {}) => ({
  cwd,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C", TERM: "dumb" },
  timeoutMs: 5_000,
  ...patch,
});

test("PTY runner captures output and returns a completed exit", async () => {
  const cwd = temp(), chunks: Buffer[] = [];
  const result = await runPty([process.execPath, "-e", "process.stdout.write('pty-ready'); process.exit(0)"], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(0);
  expect(result.outputBytes).toBeGreaterThan(0);
  expect(Buffer.concat(chunks).toString()).toContain("pty-ready");
  expect(result.cleaned).toBe(true);
});

test("ready callback completion stops the process group and reports completed", async () => {
  const cwd = temp();
  const result = await runPty([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, { ready: async () => {} }));
  expect(result.outcome).toBe("completed");
  expect(result.cleaned).toBe(true);
});

test("timeout cleans up a child and its detached descendant", async () => {
  const cwd = temp(), pidFile = join(cwd, "descendant.pid");
  const code = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
    "writeFileSync(process.env.PTY_DESCENDANT_PID, String(child.pid))",
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const result = await runPty([process.execPath, "-e", code], options(cwd, {
    env: { ...options(cwd).env, PTY_DESCENDANT_PID: pidFile },
    timeoutMs: 500,
    ready: async () => {
      const end = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      await new Promise<void>(() => {});
    },
  }));
  expect(result.outcome).toBe("timeout");
  expect(result.cleaned).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
  expect(alive).toBe(false);
});

test("argv metacharacters stay literal inside the PTY", async () => {
  const cwd = temp(), marker = join(cwd, "executed");
  let output = "";
  const literal = `; touch ${marker}; echo 'quoted'`;
  const result = await runPty(["/bin/echo", literal], options(cwd, { onOutput: chunk => { output += chunk.toString(); } }));
  expect(result.outcome).toBe("exited");
  expect(result.cleaned).toBe(true);
  expect(output).toContain(literal);
  expect(existsSync(marker)).toBe(false);
});

test("output over the bounded callback cap fails after cleanup", async () => {
  const cwd = temp();
  let delivered = 0;
  const code = `process.stdout.write('x'.repeat(${MAX_PTY_OUTPUT_BYTES + 1}))`;
  const result = await runPty([process.execPath, "-e", code], options(cwd, { onOutput: chunk => { delivered += chunk.length; } }));
  expect(result.outcome).toBe("failed");
  expect(result.cleaned).toBe(true);
  expect(delivered).toBeLessThanOrEqual(MAX_PTY_OUTPUT_BYTES);
});

test("output callback failure returns a cleaned failed result without exposing its error", async () => {
  const cwd = temp();
  const result = await runPty(["/bin/echo", "data"], options(cwd, { onOutput: () => { throw new Error("private callback detail"); } }));
  expect(result.outcome).toBe("failed");
  expect(result.cleaned).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private callback detail");
});

test("invalid timeout is refused before the command starts", async () => {
  const cwd = temp(), marker = join(cwd, "started");
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  await expect(runPty([process.execPath, "-e", code], options(cwd, { timeoutMs: 99 }))).rejects.toThrow("invalid PTY timeout");
  expect(existsSync(marker)).toBe(false);
});

test("an abort signal stops the owned process group", async () => {
  const cwd = temp(), controller = new AbortController();
  const resultPromise = runPty([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, {
    signal: controller.signal,
    ready: async () => { controller.abort(); },
  }));
  const result = await resultPromise;
  expect(result.outcome).toBe("aborted");
  expect(result.cleaned).toBe(true);
});

test("PTY gives the child a real fixed-size terminal and preserves a nonzero exit code", async () => {
  const cwd = temp(), chunks: Buffer[] = [];
  const code = "console.log(JSON.stringify({tty:!!process.stdin.isTTY&&!!process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows}));process.exit(7)";
  const result = await runPty([process.execPath, "-e", code], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(7);
  expect(result.cleaned).toBe(true);
  expect(JSON.parse(Buffer.concat(chunks).toString().trim())).toEqual({ tty: true, cols: 120, rows: 40 });
});

// ---- #560: the bridge is stopped with everything it started, and a bridge whose caller died does not run on ----
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
const waitFor = async (what: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end && !what(); ) await Bun.sleep(25); return what(); };
const BRIDGE = join(import.meta.dir, "../src/cli/smoke-pty-bridge.ts");

test("an injected bridge that ignores SIGTERM, never exits and has a descendant is killed with it on timeout, and cleaned is true only then", async () => {
  const cwd = temp(), pids = join(cwd, "pids");
  // The stand-in bridge: a hung process (SIGTERM ignored, no output, no exit) with a child in its own process group and a grandchild in another one. Nothing here depends on host load.
  const stub = join(cwd, "hung-bridge.sh");
  writeFileSync(stub, ["#!/bin/sh", "trap '' TERM", "(trap '' TERM; echo $$ >> \"$PIDS\"; while :; do sleep 1; done) &", "echo $$ >> \"$PIDS\"", "while :; do sleep 1; done", ""].join("\n"));
  chmodSync(stub, 0o755);
  const result = await runPtyWith(() => [stub], ["unused"], options(cwd, { env: { ...options(cwd).env, PIDS: pids }, timeoutMs: 700 }));
  expect(result.outcome).toBe("timeout");
  expect(result.outputBytes).toBe(0);
  expect(result.cleaned).toBe(true);
  const recorded = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  expect(recorded.length).toBe(2);
  // cleaned: true is a claim about every process the bridge started: none of them is alive.
  for (const pid of recorded) expect(alive(pid), `pid ${pid} survived a result that said cleaned`).toBe(false);
}, 20_000);

const PROBE = join(import.meta.dir, "fakes/pty-spawn-probe.ts");
const probed = (argv: readonly string[]) => [process.execPath, "--preload", PROBE, BRIDGE, ...argv];
const descendants = (root: number): number[] => {
  const rows = Bun.spawnSync(["ps", "-eo", "pid=,ppid="]).stdout.toString().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2 && row.every(Number.isFinite)) as [number, number][];
  const found = new Set<number>([root]);
  for (let grew = true; grew; ) { grew = false; for (const [pid, ppid] of rows) if (found.has(ppid) && !found.has(pid)) { found.add(pid); grew = true; } }
  return [...found].filter(pid => alive(pid));
};
/**
 * Starts the real bridge the way `runPty` does (detached, piped stdio) under a caller process, waits until its child says it is up, kills the caller, and reports which of the bridge and its
 * descendants were still alive after `ms`. `childCode` is a script for a bun child that writes `ready` once it is set up; `probe` names a preload mode for the bridge.
 */
async function killCaller(cwd: string, childCode: string, { probe, ms = 8_000 }: { probe?: { mode: string; delay?: number }; ms?: number } = {}) {
  const ready = join(cwd, "ready"), pidFile = join(cwd, "bridge.pid"), childFile = join(cwd, "child.js");
  writeFileSync(childFile, `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "up");\n${childCode}`);
  const bridgeArgv = probe ? probed([process.execPath, childFile]) : [process.execPath, BRIDGE, process.execPath, childFile];
  const caller = [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
    `const argv = ${JSON.stringify(bridgeArgv)}`,
    "const p = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })",
    "p.stdout.resume(); p.stderr.resume()",
    `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore", env: { ...process.env, PTY_PROBE_MODE: probe?.mode ?? "", PTY_PROBE_DELAY_MS: String(probe?.delay ?? 0) } });
  let up: number[] = [];
  try {
    if (!(await waitFor(() => existsSync(pidFile) && existsSync(ready), 8_000))) throw new Error("the bridge's child never came up");
    const bridge = Number(readFileSync(pidFile, "utf8"));
    up = descendants(bridge);
    expect(up.length).toBeGreaterThanOrEqual(2);
    callerProc.kill("SIGKILL");
    const gone = await waitFor(() => !up.some(alive), ms);
    return { bridge, up, gone, left: up.filter(alive), bridgeGone: !alive(bridge) };
  } finally {
    callerProc.kill("SIGKILL");
    for (const pid of up) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

test("the real bridge stops its terminal child when its caller is killed: neither the bridge nor the child outlives the caller", async () => {
  const result = await killCaller(temp(), "setInterval(() => {}, 1000)");
  expect(result.gone, `still alive after the caller died: ${result.left.join(", ")}`).toBe(true);
}, 20_000);

test("a bridge whose caller died asks its child to stop first: a child that handles SIGTERM gets to run its handler", async () => {
  const cwd = temp(), marker = join(cwd, "term-seen");
  const result = await killCaller(cwd, `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "t"); process.exit(0); }); setInterval(() => {}, 1000)`);
  expect(result.gone).toBe(true);
  expect(existsSync(marker), "the child was killed without being asked to stop first").toBe(true);
}, 20_000);

test("a bridge whose caller died asks its child to stop exactly once, however long the child takes to go", async () => {
  const cwd = temp(), terms = join(cwd, "terms");
  // the child counts every SIGTERM it gets and ignores them, so it stays up through the grace period and the bridge keeps its watch running as long as it can
  const result = await killCaller(cwd, `process.on("SIGTERM", () => { require("node:fs").appendFileSync(${JSON.stringify(terms)}, "T\\n"); }); setInterval(() => {}, 1000)`);
  expect(result.gone).toBe(true);
  expect(readFileSync(terms, "utf8").trim().split("\n"), "the child was asked to stop more than once: the watch kept firing after the caller was found gone").toEqual(["T"]);
}, 20_000);

test("a bridge whose caller died kills a child that ignores SIGTERM and SIGHUP, after a grace period", async () => {
  const result = await killCaller(temp(), 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)');
  expect(result.gone, `a child that ignores SIGTERM survived: ${result.left.join(", ")}`).toBe(true);
}, 20_000);

test("a bridge whose caller died exits even when the exit of its child is never reported", async () => {
  const result = await killCaller(temp(), 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)', { probe: { mode: "exited-never" } });
  expect(result.bridgeGone, "the bridge outlived its caller although its child's exit never settled").toBe(true);
}, 20_000);

test("a caller that dies while Bun.spawn is still running gets neither the bridge nor the child left behind, and its command never runs (the window #45300 widens)", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp"), pidFile = join(cwd, "bridge.pid"), ran = join(cwd, "ran"), ppidLog = join(cwd, "ppid.log"), mark = `pty560-spawn-${process.pid}-${Date.now()}`;
  mkdirSync(tmp);
  const caller = [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
    `const argv = ${JSON.stringify(probed([process.execPath, "-e", `/*${mark}*/ require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran'); setInterval(() => {}, 1000)`]))}`,
    "const p = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })",
    "p.stdout.resume(); p.stderr.resume()",
    `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("; ");
  // the probe holds the bridge for 2 s right after its Bun.spawn returned: the caller is killed inside that hold, so the bridge is already reparented when it looks at its parent
  const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp, PTY_PROBE_MODE: "spawn-delay", PTY_PROBE_DELAY_MS: "2000", PTY_PROBE_PPID_LOG: ppidLog } });
  let bridge = 0, up: number[] = [];
  try {
    expect(await waitFor(() => existsSync(pidFile), 8_000)).toBe(true);
    bridge = Number(readFileSync(pidFile, "utf8"));
    expect(await waitFor(() => descendants(bridge).length >= 2, 8_000)).toBe(true); // the gate shell exists: the bridge is inside the held spawn
    up = descendants(bridge);
    callerProc.kill("SIGKILL");
    expect(await waitFor(() => !up.some(alive), 8_000), `still alive after the caller died inside the spawn: ${up.filter(alive).join(", ")}`).toBe(true);
    expect(readFileSync(ppidLog, "utf8").trim(), "the bridge was not reparented inside the hold: the test did not reach the window").toBe("1");
    // The start gate exists only on macOS (Linux runs the child under script(1) and never starts the bridge in production; here it is started directly, so the command has no gate to wait behind
    // and runs inside the hold). The reaping above holds on both; "the command never ran" and the gate directory are properties of the gate.
    if (process.platform === "darwin") {
      expect(existsSync(ran), "the command ran although its caller was already gone").toBe(false);
      expect(readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"))).toEqual([]);
    }
  } finally {
    callerProc.kill("SIGKILL");
    for (const pid of up) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}, 20_000);

test("a failed spawn in the bridge is reported as 125 and leaves nothing behind, no gate directory included", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp");
  mkdirSync(tmp);
  const result = await runPtyWith(probed, ["/bin/echo", "x"], options(cwd, { env: { ...options(cwd).env, TMPDIR: tmp, PTY_PROBE_MODE: "spawn-throws" } }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(125);
  expect(result.cleaned).toBe(true);
  // on macOS the bridge made its gate directory before the spawn it could not do: the bridge's own cleanup removes it, no shell ever ran
  expect(readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"))).toEqual([]);
});

test.skipIf(process.platform !== "darwin")("a bridge killed with SIGKILL AFTER it released its child leaves no gate directory: the shell removed it when released", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp"), up = join(cwd, "up"), pidFile = join(cwd, "bridge.pid");
  mkdirSync(tmp);
  const childFile = join(cwd, "child.js");
  writeFileSync(childFile, `require("node:fs").writeFileSync(${JSON.stringify(up)}, "up"); setInterval(() => {}, 1000)`);
  const caller = [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
    `const argv = ${JSON.stringify([process.execPath, BRIDGE, process.execPath, childFile])}`,
    "const p = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })",
    "p.stdout.resume(); p.stderr.resume()",
    `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp } });
  let members: number[] = [];
  try {
    expect(await waitFor(() => existsSync(pidFile) && existsSync(up), 8_000)).toBe(true);
    const bridge = Number(readFileSync(pidFile, "utf8"));
    members = descendants(bridge);
    // the child is running, so the gate was opened and the shell has exec'd: nothing but a SIGKILL-proof removal can have emptied the directory now
    expect(readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"))).toEqual([]);
    process.kill(bridge, "SIGKILL");
    callerProc.kill("SIGKILL");
    await waitFor(() => !members.some(alive), 6_000);
    expect(readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"))).toEqual([]);
  } finally {
    callerProc.kill("SIGKILL");
    for (const pid of members) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}, 20_000);

test("a result is never cleaned while a member of the owned process group is still alive", async () => {
  const cwd = temp(), pidFile = join(cwd, "member.pid");
  // The stand-in bridge starts a member of its own group and exits at once: the leader is gone, a member runs, and the stop cannot confirm an empty group.
  const stub = join(cwd, "leaves-a-member.sh");
  writeFileSync(stub, ["#!/bin/sh", "sleep 30 &", "echo $! > \"$MEMBER_PID\"", "exit 0", ""].join("\n"));
  chmodSync(stub, 0o755);
  let member = 0;
  try {
    const result = await runPtyWith(() => [stub], ["unused"], options(cwd, { env: { ...options(cwd).env, MEMBER_PID: pidFile }, timeoutMs: 6_000 }));
    member = Number(readFileSync(pidFile, "utf8"));
    expect(alive(member)).toBe(true);
    expect(result.cleaned, "cleaned: true while a member of the owned group runs").toBe(false);
    expect(result.outcome).toBe("failed");
  } finally {
    if (member) { try { process.kill(member, "SIGKILL"); } catch { /* already gone */ } }
  }
}, 20_000);

// The bridge, and so its gate, is the macOS launcher: Linux runs the child under script(1) and never starts the bridge.
test.skipIf(process.platform !== "darwin")("the bridge opens its start gate, keeps a fast child's output and exit code, and leaves no gate directory behind", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp");
  mkdirSync(tmp);
  const gates = () => readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"));
  const env = { ...options(cwd).env, TMPDIR: tmp };
  // a long-running child is released (it is up when ready fires) and the gate is gone once it ran
  let up = false;
  const running = await runPty([process.execPath, "-e", "require('node:fs').writeFileSync(process.env.UP, 'up'); setInterval(() => {}, 1000)"], options(cwd, { env: { ...env, UP: join(cwd, "up") }, ready: async () => {
    up = await waitFor(() => existsSync(join(cwd, "up")), 6_000);
  } }));
  expect(running.outcome).toBe("completed");
  expect(up, "the child never ran: the gate was not opened").toBe(true);
  expect(gates()).toEqual([]);
  // a child that writes and exits at once keeps its output and code through the gate
  for (let i = 0; i < 5; i++) {
    let output = "";
    const result = await runPty(["/bin/sh", "-c", "printf gated; exit 3"], options(cwd, { env, onOutput: chunk => { output += chunk.toString(); } }));
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(3);
    expect(output).toContain("gated");
    expect(result.cleaned).toBe(true);
  }
  expect(gates()).toEqual([]);
}, 20_000);

test.skipIf(process.platform !== "darwin")("the child waits for the gate: it has not run when the bridge opens the gate late, and the gate was closed while Bun.spawn ran", async () => {
  const cwd = temp(), log = join(cwd, "probe.log"), marker = join(cwd, "child-ran"), tmp = join(cwd, "tmp");
  mkdirSync(tmp);
  const result = await runPtyWith(probed, ["/usr/bin/touch", marker], options(cwd, { env: { ...options(cwd).env, TMPDIR: tmp, PTY_PROBE_MODE: "spawn-delay", PTY_PROBE_DELAY_MS: "400", PTY_PROBE_LOG: log, PTY_PROBE_MARKER: marker } }));
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["enter gate=absent", "returned gate=absent", "after-delay child=waiting"]);
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(0);
  expect(existsSync(marker), "released by the gate, the child ran").toBe(true);
}, 20_000);

test.skipIf(process.platform !== "darwin")("a bridge killed with SIGKILL, which runs no cleanup, leaves no gate directory and no waiting shell: the gate shell removes its own gate", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp");
  mkdirSync(tmp);
  const gates = () => readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"));
  // the bridge is held inside Bun.spawn's return for 3 s by the probe, so it is SIGKILLed with its gate shell started and its gate not yet opened
  const caller = [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
    `const argv = ${JSON.stringify(probed([process.execPath, "-e", "setInterval(() => {}, 1000)"]))}`,
    "const p = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })",
    "p.stdout.resume(); p.stderr.resume()",
    `writeFileSync(${JSON.stringify(join(cwd, "bridge.pid"))}, String(p.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp, PTY_PROBE_MODE: "spawn-delay", PTY_PROBE_DELAY_MS: "3000" } });
  let bridge = 0, shell: number[] = [];
  try {
    expect(await waitFor(() => existsSync(join(cwd, "bridge.pid")) && gates().length === 1 && descendants(Number(readFileSync(join(cwd, "bridge.pid"), "utf8"))).length >= 2, 8_000)).toBe(true);
    bridge = Number(readFileSync(join(cwd, "bridge.pid"), "utf8"));
    shell = descendants(bridge).filter(pid => pid !== bridge);
    expect(shell.length).toBeGreaterThanOrEqual(1);
    process.kill(bridge, "SIGKILL");
    callerProc.kill("SIGKILL");
    // the bridge's pty closed, which hangs the gate shell up: its trap removes the directory and it exits, with no bound of its own involved
    expect(await waitFor(() => !shell.some(alive) && gates().length === 0, 8_000), `left behind: processes ${shell.filter(alive).join(", ")}, gate directories ${gates().join(", ")}`).toBe(true);
  } finally {
    callerProc.kill("SIGKILL");
    for (const pid of [bridge, ...shell]) { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
  }
}, 20_000);

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) test.skipIf(process.platform !== "darwin")(`a gate shell that is sent ${signal} while it waits removes its own gate at once, before its bridge could`, async () => {
  {
    const cwd = temp(), tmp = join(cwd, "tmp"), pidFile = join(cwd, "bridge.pid");
    mkdirSync(tmp);
    const gates = () => readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"));
    // the probe holds the bridge for 4 s inside the spawn it just made, so the bridge's own cleanup cannot be what removes the directory in the next second
    const caller = [
      "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
      `const argv = ${JSON.stringify(probed([process.execPath, "-e", "setInterval(() => {}, 1000)"]))}`,
      "const p = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })",
      "p.stdout.resume(); p.stderr.resume()",
      `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
      "setInterval(() => {}, 1000)",
    ].join("; ");
    const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp, PTY_PROBE_MODE: "spawn-delay", PTY_PROBE_DELAY_MS: "4000" } });
    let bridge = 0, members: number[] = [];
    try {
      expect(await waitFor(() => existsSync(pidFile) && gates().length === 1 && descendants(Number(readFileSync(pidFile, "utf8"))).length >= 2, 8_000), signal).toBe(true);
      bridge = Number(readFileSync(pidFile, "utf8"));
      members = descendants(bridge);
      const shell = members.find(pid => pid !== bridge)!;
      process.kill(shell, signal);
      expect(await waitFor(() => gates().length === 0, 1_500), `${signal}: the gate directory outlived the shell that was signalled while its bridge was still blocked`).toBe(true);
    } finally {
      callerProc.kill("SIGKILL");
      for (const pid of [bridge, ...members]) { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
    }
  }
}, 20_000);

test("the bridge refuses a missing command with 125 and starts nothing", async () => {
  const cwd = temp();
  const result = await runPtyWith(() => [process.execPath, BRIDGE], ["x"], options(cwd));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(125);
  expect(result.cleaned).toBe(true);
});
