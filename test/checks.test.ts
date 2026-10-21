import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, type CheckSpawn } from "../src/hub/checks.ts";

// issue #7: the completion check runner. Which config may choose the command: test/config-trust.test.ts.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-check-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/**
 * The process state `ps` reports once it settles: "" when it exited, "Z..." for a zombie nobody reaped yet (a killed
 * grandchild is reparented, and on Linux CI it can linger as one), anything else while it still runs.
 */
const stateOf = async (pid: number) => {
  let stat = "";
  for (let i = 0; i < 40; i++) {
    stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
    if (!stat || stat.startsWith("Z")) break;
    await Bun.sleep(50);
  }
  return stat;
};
const DEAD = /^(Z.*)?$/;
/** Our own child, once Bun has collected it (after which its exit handler has fired or is about to). */
const reaped = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
/** A process that leaves the check's process group and keeps its stdout; its pid lands in `pidFile`. */
const escapee = (pidFile: string) => `python3 -c 'import os, time; os.setsid(); time.sleep(20)' & echo $! > ${pidFile};`;

test("a check reports its exit code and the tail of its output", async () => {
  const dir = tempDir();
  expect(await runCheck("printf 'a\\nb\\n'; exit 0", dir, 5000)).toEqual({ code: 0, timedOut: false, tail: "a\nb" });
  const failed = await runCheck("echo boom >&2; exit 3", dir, 5000);
  expect(failed).toMatchObject({ code: 3, timedOut: false });
  expect(failed.tail).toContain("boom");
  const long = await runCheck("i=0; while [ $i -lt 100 ]; do echo line$i; i=$((i+1)); done", dir, 5000);
  expect(long.tail.split("\n")).toHaveLength(40);
  expect(long.tail.endsWith("line99")).toBe(true);
});

test("a check past its timeout is stopped with everything it started", async () => {
  const dir = tempDir();
  const result = await runCheck("sleep 30 & echo $! > bg.pid; sleep 30", dir, 300);
  expect(result).toMatchObject({ code: null, timedOut: true });
  expect(await stateOf(Number(readFileSync(join(dir, "bg.pid"), "utf8")))).toMatch(DEAD);
  // A command that finishes in time still takes what it left in its group with it; its own exit code stands.
  expect(await runCheck("sleep 30 & echo $! > left.pid; exit 0", dir, 5000)).toMatchObject({ code: 0, timedOut: false });
  expect(await stateOf(Number(readFileSync(join(dir, "left.pid"), "utf8")))).toMatch(DEAD);
});

test("a descendant that left the process group cannot hold a check open", async () => {
  const dir = tempDir();
  cleanup.unshift(() => {
    for (const f of ["a.pid", "b.pid"]) {
      try {
        process.kill(Number(readFileSync(join(dir, f), "utf8")), "SIGKILL");
      } catch {
        // not started or already gone
      }
    }
  });
  for (const [command, expected] of [
    [`${escapee("a.pid")} exit 0`, { code: 0, timedOut: false }],
    [`${escapee("b.pid")} sleep 30`, { code: null, timedOut: true }],
  ] as const) {
    const started = Date.now();
    const result = await runCheck(command, dir, 300);
    expect(result).toMatchObject(expected);
    expect(Date.now() - started).toBeLessThan(3000);
  }
});

test("a check stopped by the hub is interrupted, not failed", async () => {
  const running = new Set<() => void>();
  const pending = runCheck("sleep 30", tempDir(), 30_000, running);
  await Bun.sleep(50);
  for (const stop of running) stop();
  expect(await pending).toEqual({ code: null, timedOut: false, interrupted: true, tail: "" });
  // A stop that arrives after the command exited, while an escapee keeps its output open, does not overrule its result.
  const dir = tempDir();
  cleanup.unshift(() => {
    try {
      process.kill(Number(readFileSync(join(dir, "esc.pid"), "utf8")), "SIGKILL");
    } catch {
      // not started or already gone
    }
  });
  // Sequenced, not timed (a slow runner starts python late): the escapee writes its pid only after leaving the group,
  // the command exits only once that pid is there, and the stop comes only once the command has been reaped.
  const leftGroup = `python3 -c 'import os, time; os.setsid(); open("esc.pid", "w").write(str(os.getpid())); time.sleep(20)' &`;
  const waitForIt = "n=0; while [ ! -s esc.pid ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done; [ -s esc.pid ] || exit 1"; // 5 s at most
  const finished = runCheck(`${leftGroup} ${waitForIt}; echo $$ > leader.pid; exit 3`, dir, 30_000, running);
  const leader = join(dir, "leader.pid");
  for (let i = 0; i < 200 && !(existsSync(leader) && readFileSync(leader, "utf8").endsWith("\n") && reaped(Number(readFileSync(leader, "utf8")))); i++) await Bun.sleep(20);
  await Bun.sleep(50); // the exit handler runs; the result is then held for the 500 ms drain (bounds: under bun's 5 s)
  expect(running.size).toBe(1);
  for (const stop of running) stop();
  expect(await finished).toMatchObject({ code: 3, timedOut: false });
  expect((await finished).interrupted).toBeUndefined();
});

// issue #558: on hosted macOS a check once hung past bun's 20 s test timeout; neither its exit nor its close event came.
/** A real child whose exit and pipes never report to runCheck: only the kill grace can settle it. */
const silentSpawn: CheckSpawn = (argv, options) => {
  const real = Bun.spawn(argv, { cwd: options.cwd, env: options.env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  return { pid: real.pid, exited: new Promise<number>(() => {}), signalCode: null, stdout: new ReadableStream<Uint8Array>({}), stderr: new ReadableStream<Uint8Array>({}) };
};

test("a killed check settles within its kill grace when the child's exit and close events never arrive", async () => {
  const started = Date.now();
  expect(await runCheck("sleep 30", tempDir(), 300, undefined, silentSpawn)).toMatchObject({ code: null, timedOut: true });
  expect(Date.now() - started).toBeLessThan(3000);
  const running = new Set<() => void>();
  const pending = runCheck("sleep 30", tempDir(), 30_000, running, silentSpawn);
  await Bun.sleep(50);
  const stopped = Date.now();
  for (const stop of running) stop();
  expect(await pending).toMatchObject({ code: null, timedOut: false, interrupted: true });
  expect(Date.now() - stopped).toBeLessThan(3000);
});

test("a late exit event or a retained stop after the kill grace settled the check never signals the old process group", async () => {
  const exits: ((code: number) => void)[] = [];
  const recording: CheckSpawn = (argv, options) => {
    const real = Bun.spawn(argv, { cwd: options.cwd, env: options.env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    const exited = new Promise<number>((resolve) => exits.push(resolve)); // the exit report, delivered by hand after the grace
    return { pid: real.pid, exited, signalCode: null, stdout: new ReadableStream<Uint8Array>({}), stderr: new ReadableStream<Uint8Array>({}) };
  };
  const running = new Set<() => void>();
  const pending = runCheck("sleep 30", tempDir(), 300, running, recording);
  const [stop] = running;
  expect(await pending).toMatchObject({ code: null, timedOut: true });
  const kills: number[] = [];
  const kill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => (kills.push(pid), kill.call(process, pid, signal))) as typeof process.kill;
  try {
    for (const exit of exits) exit(137);
    stop?.();
  } finally {
    process.kill = kill;
  }
  expect(kills).toEqual([]);
});

// issue #558 (D1): on a loaded hosted macOS runner under `bun test`, node:child_process could reap a quick child inside
// spawn() and emit its exit and close (output unread) before runCheck had a listener (oven-sh/bun#45483); the check then
// reported a timeout with an empty tail after its limit plus the kill grace (~6 s). runCheck now reads values a child
// that already ended still holds, so it does not depend on when an event fires.
const text = (value: string) => new ReadableStream<Uint8Array>({ start(controller) { if (value) controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
const ended = (code: number, stdout: string, stderr = "", signalCode: string | null = null): CheckSpawn => () => ({ pid: 0, exited: Promise.resolve(code), signalCode, stdout: text(stdout), stderr: text(stderr) });

test("a child that already ended when runCheck got it still reports its exit code and output (#558 D1)", async () => {
  const started = Date.now();
  expect(await runCheck("ignored", tempDir(), 5000, undefined, ended(0, "a\nb\n"))).toEqual({ code: 0, timedOut: false, tail: "a\nb" });
  const failed = await runCheck("ignored", tempDir(), 5000, undefined, ended(3, "", "boom\n"));
  expect(failed).toMatchObject({ code: 3, timedOut: false });
  expect(failed.tail).toContain("boom");
  expect(Date.now() - started).toBeLessThan(2000); // nothing waited for the limit, the kill grace or the drain
});

test("a signalled child is no verdict on the work, and a spawn that throws reports why (#558 D1)", async () => {
  expect(await runCheck("ignored", tempDir(), 5000, undefined, ended(137, "", "", "SIGKILL"))).toMatchObject({ code: null, timedOut: false });
  const refusing: CheckSpawn = () => { throw new Error("ENOENT: no such file or directory, posix_spawn 'sh'"); };
  const result = await runCheck("ignored", tempDir(), 5000, undefined, refusing);
  expect(result).toMatchObject({ code: null, timedOut: false });
  expect(result.tail).toContain("ENOENT");
});

test("a real quick child is read whole even when its exit is reported before its pipes are drained (#558 D1)", async () => {
  for (let i = 0; i < 20; i++) expect(await runCheck("printf 'a\\nb\\n'; exit 0", tempDir(), 5000)).toEqual({ code: 0, timedOut: false, tail: "a\nb" });
});
