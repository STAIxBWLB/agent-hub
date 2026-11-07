import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForStartupReadiness, type StartupOwner, type StartupReadinessPorts } from "../src/hub/startup-readiness.ts";

type Status = { projectId: string; instanceId: string; version: string };
const STATUS: Status = { projectId: "fixture-project", instanceId: "fixture-instance", version: "fixture-version" };
function fixture(readyAt: number) {
  let now = 0, cancelled = false, owner: StartupOwner = { state: "live", pid: 123 };
  const confirmations: Status[] = [], notices: number[] = [], inspections: { timeoutMs: number; remaining: number }[] = [];
  const ports: StartupReadinessPorts<Status> = {
    now: () => now,
    sleep: async ms => { now += ms; },
    current: () => { if (cancelled) throw new Error("fixture authority cancelled"); },
    owner: () => owner,
    inspect: async timeoutMs => {
      inspections.push({ timeoutMs, remaining: 120_000 - now });
      return now >= readyAt ? { state: "running", status: STATUS } : { state: "starting" };
    },
    confirm: status => { confirmations.push(status); },
    starting: pid => { notices.push(pid); },
  };
  return { ports, confirmations, notices, inspections, now: () => now, advance: (ms: number) => { now += ms; },
    cancel: () => { cancelled = true; }, owner: (value: StartupOwner) => { owner = value; } };
}

test("readiness before 12 seconds returns the unchanged status and confirms exactly once", async () => {
  const f = fixture(100);
  expect(await waitForStartupReadiness(f.ports)).toBe(STATUS);
  expect(f.confirmations).toEqual([STATUS]);
  expect(f.notices).toEqual([]);
});

test("bound live startup reports once at 12 seconds and remains pending until late readiness confirms once", async () => {
  const f = fixture(16_000);
  let atNotice = 0;
  f.ports.starting = pid => { atNotice = f.now(); f.notices.push(pid); expect(f.confirmations).toHaveLength(0); };
  expect(await waitForStartupReadiness(f.ports)).toBe(STATUS);
  expect(atNotice).toBe(12_000);
  expect(f.notices).toEqual([123]);
  expect(f.confirmations).toEqual([STATUS]);
  expect(f.now()).toBe(16_000);
});

test("a missing full owner identity never produces a PID-only still-starting claim", async () => {
  const f = fixture(13_000); f.owner({ state: "unknown" });
  expect(await waitForStartupReadiness(f.ports)).toBe(STATUS);
  expect(f.notices).toEqual([]);
  expect(f.confirmations).toEqual([STATUS]);
});

test("joining a competing starter preserves its readiness status without claiming that child", async () => {
  const f = fixture(13_000); f.owner(undefined);
  expect(await waitForStartupReadiness(f.ports)).toBe(STATUS);
  expect(f.notices).toEqual([]);
  expect(f.confirmations).toEqual([STATUS]);
});

test("an exited owned child fails before another readiness attempt and never confirms", async () => {
  const f = fixture(Number.POSITIVE_INFINITY); f.owner({ state: "gone" });
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("daemon exited before readiness");
  expect(f.inspections).toHaveLength(1);
  expect(f.confirmations).toHaveLength(0);
  expect(f.notices).toHaveLength(0);
});

test("an observed shutdown is never relabelled as still starting", async () => {
  const f = fixture(Number.POSITIVE_INFINITY);
  f.ports.inspect = async () => { f.advance(12_000); return { state: "stopping" }; };
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("hub shutdown is pending");
  expect(f.notices).toHaveLength(0);
  expect(f.confirmations).toHaveLength(0);
});

test("current authority is rechecked after inspection before progress or confirmation", async () => {
  const f = fixture(0);
  f.ports.inspect = async () => { f.cancel(); return { state: "running", status: STATUS }; };
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("fixture authority cancelled");
  expect(f.confirmations).toHaveLength(0);
  expect(f.notices).toHaveLength(0);
});

test("authority cancellation after a still-starting notice retains the pending runtime without confirming", async () => {
  const f = fixture(16_000);
  f.ports.starting = pid => { f.notices.push(pid); f.cancel(); };
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("fixture authority cancelled");
  expect(f.notices).toEqual([123]);
  expect(f.confirmations).toHaveLength(0);
});

test("the 120 second outer bound leaves an alive startup unconfirmed without any stop operation", async () => {
  const f = fixture(Number.POSITIVE_INFINITY);
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("readiness remains unconfirmed after 120 s");
  expect(f.now()).toBe(120_000);
  expect(f.notices).toEqual([123]);
  expect(f.confirmations).toHaveLength(0);
  expect(f.inspections.every(row => row.timeoutMs > 0 && row.timeoutMs <= 3000 && row.timeoutMs * 2 <= row.remaining)).toBe(true);
});

test("a status returned after the outer deadline cannot confirm and each connect/status pair gets half the remaining budget", async () => {
  const f = fixture(Number.POSITIVE_INFINITY);
  f.ports.inspect = async timeoutMs => {
    f.inspections.push({ timeoutMs, remaining: 120_000 - f.now() });
    if (f.inspections.length === 1) { f.advance(119_500); return { state: "starting" }; }
    f.advance(2 * timeoutMs + 1);
    return { state: "running", status: STATUS };
  };
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("readiness remains unconfirmed");
  expect(f.inspections.map(row => row.timeoutMs)).toEqual([3000, 200]);
  expect(f.confirmations).toHaveLength(0);
});

test("less than two milliseconds remaining never sends a zero-timeout inspection", async () => {
  const f = fixture(Number.POSITIVE_INFINITY);
  f.ports.current = () => { if (f.now() === 0) f.advance(119_999.5); };
  await expect(waitForStartupReadiness(f.ports)).rejects.toThrow("readiness remains unconfirmed");
  expect(f.inspections).toHaveLength(0);
  expect(f.confirmations).toHaveLength(0);
});

test("progress observer failure changes neither late confirmation nor the returned status", async () => {
  const f = fixture(13_000);
  f.ports.starting = () => { throw new Error("fixture progress output failed"); };
  expect(await waitForStartupReadiness(f.ports)).toBe(STATUS);
  expect(f.confirmations).toEqual([STATUS]);
});

test("the actual up body prints pending progress only to stderr and preserves its eventual stdout", async () => {
  const source = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");
  const start = source.indexOf("  up: async () => {"), end = source.indexOf("\n  },\n\n  ...Object.fromEntries", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const body = source.slice(start + "  up: async () => {".length, end);
  const stdout: string[] = [], stderr: string[] = [];
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function invoke(ports) { const { startProject,registeredProject,unattendedEnv,args,liveTest,recoveryLauncherCurrent,console,stateDir,process,UNATTENDED_WARNING,personEnv,continuationId,continuationPeer,caller,identity,effectiveStartAgents,cwd,loadConfig,hubHome,startProjectAgents,terminalText,runConsole,connect } = ports; ${body} }`);
  const invoke = new Function(`${compiled}; return invoke;`)() as (ports: Record<string, unknown>) => Promise<void>;
  const unexpected = () => { throw new Error("fixture refuses an unrelated native or config operation"); };
  await invoke({ startProject: async (_project: unknown, options: { starting(pid: number): void }) => {
    options.starting(123); expect(stdout).toHaveLength(0); return { controlPort: 0 };
  }, registeredProject: () => ({ id: "fixture" }), unattendedEnv: false, args: ["--no-agents", "--no-console"], liveTest: true,
    recoveryLauncherCurrent: undefined, console: { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) }, stateDir: "fixture-state",
    process: { stdin: { isTTY: false }, stdout: { isTTY: false }, env: {} }, UNATTENDED_WARNING: "unused", personEnv: unexpected,
    continuationId: undefined, continuationPeer: undefined, caller: { role: "console" }, identity: { role: "console" }, effectiveStartAgents: unexpected,
    cwd: "fixture-project", loadConfig: unexpected, hubHome: unexpected, startProjectAgents: unexpected, terminalText: unexpected, runConsole: unexpected, connect: unexpected });
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toContain("hub is still starting, pid 123");
  expect(stderr[0]).toContain("run ahub status");
  expect(stdout).toEqual(["ahub up (ws://127.0.0.1:0), state in fixture-state"]);
});
