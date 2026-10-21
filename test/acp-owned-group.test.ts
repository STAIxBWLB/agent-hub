import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { AcpOwnedGroup, type AcpOwnedGroupPorts } from "../src/adapters/acp-owned-group.ts";
import type { ProcRow } from "../src/hub/child-process.ts";

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
  for (const mutation of ["unknown", "signature", "started", "command", "pgid", "exited", "leader-gone"] as const) {
    const f = fixture(), proof = await AcpOwnedGroup.capture(f.proc, f.ports);
    if (mutation === "unknown") f.rows(undefined);
    if (mutation === "signature") f.signature("reused-signature");
    if (mutation === "started") f.rows([{ ...f.leader, started: "start-2" }]);
    if (mutation === "command") f.rows([{ ...f.leader, command: "other foreground" }]);
    if (mutation === "pgid") f.rows([{ ...f.leader, pgid: 67890 }]);
    if (mutation === "exited") f.child.exitCode = 0;
    if (mutation === "leader-gone") f.rows([{ ...f.leader, pid: 12346, ppid: 1 }]);
    await expect(proof.stop()).rejects.toThrow("ownership");
    expect(f.signals).toEqual([]);
  }
});

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
