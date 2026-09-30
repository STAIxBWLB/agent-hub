import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/hub/checks.ts";

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
  const finished = runCheck(`${escapee("esc.pid")} sleep 1; exit 3`, dir, 30_000, running);
  await Bun.sleep(1150); // exited at about 1000 ms (the escapee has left the group by then); its result is held until about 1500 ms
  expect(running.size).toBe(1);
  for (const stop of running) stop();
  expect(await finished).toMatchObject({ code: 3, timedOut: false });
  expect((await finished).interrupted).toBeUndefined();
});
