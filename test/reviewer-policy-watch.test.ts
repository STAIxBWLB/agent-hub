import { expect, test } from "bun:test";
import { createReviewerPolicyWatch, type ReviewerPolicyWatchClock } from "../src/adapters/reviewer-policy-watch.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
// Drain only promise continuations; cadence is controlled entirely by the injected clock.
async function settle(): Promise<void> { for (let n = 0; n < 8; n++) await Promise.resolve(); }
interface Job { due: number; delay: number; run: () => void; cancelled: boolean; fired: boolean }
class Clock implements ReviewerPolicyWatchClock {
  at = 0;
  jobs: Job[] = [];
  events: string[] = [];
  nowError = false;
  scheduleError = false;
  now = (): number => { if (this.nowError) throw Error("synthetic clock failure"); return this.at; };
  schedule = (delay: number, run: () => void): (() => void) => {
    if (this.scheduleError) throw Error("synthetic scheduler failure");
    const job = { due: this.at + delay, delay, run, cancelled: false, fired: false };
    this.jobs.push(job);
    return () => { job.cancelled = true; this.events.push("cancel"); };
  };
  get pending(): Job[] { return this.jobs.filter(job => !job.cancelled && !job.fired).sort((a, b) => a.due - b.due); }
  fire(at: number): boolean {
    this.at = at;
    const job = this.pending.find(job => job.due <= at);
    if (!job) return false;
    job.fired = true; job.run(); return true;
  }
}

test("ownership attaches before start, and absolute cadence coalesces held checks without overlapping", async () => {
  const clock = new Clock(), held = deferred<boolean>(), checks: number[] = [];
  let attached = false, active = 0, maximum = 0, changes = 0, stops = 0;
  const watch = createReviewerPolicyWatch({
    async check() {
      expect(attached).toBe(true); checks.push(clock.at); active++; maximum = Math.max(maximum, active);
      try { return checks.length === 1 ? await held.promise : true; } finally { active--; }
    },
    async stop() { stops++; },
  }, () => { changes++; }, clock);
  expect(clock.pending).toEqual([]); expect(checks).toEqual([]);
  attached = true; watch.start(); watch.start();
  expect(clock.pending.map(job => job.due)).toEqual([100]); expect(clock.jobs).toHaveLength(1);
  expect(clock.fire(99)).toBe(false); expect(clock.fire(100)).toBe(true); await settle();
  expect(checks).toEqual([100]); expect(active).toBe(1); expect(clock.pending).toEqual([]);
  clock.at = 350; held.resolve(true); await settle();
  expect(clock.pending.map(job => [job.due, job.delay])).toEqual([[350, 0]]);
  expect(clock.fire(350)).toBe(true); await settle();
  expect(checks).toEqual([100, 350]); expect(clock.pending.map(job => [job.due, job.delay])).toEqual([[400, 50]]);
  expect(clock.fire(399)).toBe(false); expect(clock.fire(400)).toBe(true); await settle();
  expect(checks).toEqual([100, 350, 400]); expect(maximum).toBe(1); expect(changes).toBe(0);
  await watch.stop(); expect(stops).toBe(1); expect(clock.pending).toEqual([]);
});

for (const outcome of ["false", "error"] as const) test(`a ${outcome} policy check fails closed and retains the owned stop join`, async () => {
  const clock = new Clock(), stopped = deferred<void>(); let changes = 0, stops = 0, checks = 0, joined = false;
  const watch = createReviewerPolicyWatch({
    async check() { checks++; if (outcome === "error") throw Error("synthetic check failure"); return false; },
    async stop() { stops++; await stopped.promise; },
  }, () => { changes++; }, clock);
  watch.start(); clock.fire(100); await settle();
  expect(checks).toBe(1); expect(changes).toBe(1); expect(stops).toBe(1); expect(clock.pending).toEqual([]);
  const join = watch.stop(); void join.then(() => { joined = true; }); await settle(); expect(joined).toBe(false);
  stopped.resolve(undefined); await join; expect(joined).toBe(true);
  watch.start(); expect(clock.fire(1000)).toBe(false); expect(checks).toBe(1); expect(changes).toBe(1); expect(stops).toBe(1);
});

test("stop terminates a blocked check before joining it and never rearms after that check settles", async () => {
  const clock = new Clock(), blocked = deferred<boolean>(), stopJoin = deferred<void>(), order: string[] = [];
  let checks = 0, changes = 0, joined = false;
  const watch = createReviewerPolicyWatch({
    async check() { checks++; order.push("check-start"); const result = await blocked.promise; order.push("check-settled"); return result; },
    async stop() { order.push("probe-stop"); blocked.resolve(true); await stopJoin.promise; order.push("probe-joined"); },
  }, () => { changes++; }, clock);
  watch.start(); clock.fire(100); await settle();
  const join = watch.stop(); void join.then(() => { joined = true; }); await settle();
  expect(order).toEqual(["check-start", "probe-stop", "check-settled"]); expect(joined).toBe(false); expect(clock.pending).toEqual([]);
  stopJoin.resolve(undefined); await join;
  expect(order).toEqual(["check-start", "probe-stop", "check-settled", "probe-joined"]); expect(joined).toBe(true);
  expect(checks).toBe(1); expect(changes).toBe(0); expect(clock.pending).toEqual([]);
});

test("stop cancels first and an already dequeued late timer callback cannot run a check", async () => {
  const clock = new Clock(); let checks = 0, changes = 0;
  const watch = createReviewerPolicyWatch({ async check() { checks++; return true; }, async stop() { clock.events.push("probe-stop"); } }, () => { changes++; }, clock);
  watch.start(); const stale = clock.pending[0]!;
  const join = watch.stop(); expect(clock.events).toEqual(["cancel"]);
  stale.run(); await join; stale.run(); await settle();
  expect(clock.events).toEqual(["cancel", "probe-stop"]); expect(checks).toBe(0); expect(changes).toBe(0); expect(clock.pending).toEqual([]);
});

test("a failed probe join is cached until the owner explicitly retries stop(true)", async () => {
  const clock = new Clock(), retryJoin = deferred<void>(), failure = Error("synthetic stop failure"); let stops = 0, checks = 0;
  const watch = createReviewerPolicyWatch({
    async check() { checks++; return true; },
    async stop() { stops++; if (stops === 1) throw failure; await retryJoin.promise; },
  }, () => {}, clock);
  watch.start(); const first = watch.stop(); await expect(first).rejects.toBe(failure); await settle();
  const repeated = watch.stop(); expect(repeated).toBe(first); await expect(repeated).rejects.toBe(failure); expect(stops).toBe(1);
  const retry = watch.stop(true); expect(retry).not.toBe(first); expect(watch.stop()).toBe(retry); await settle(); expect(stops).toBe(2);
  retryJoin.resolve(undefined); await retry;
  expect(watch.stop()).toBe(retry); expect(stops).toBe(2); expect(checks).toBe(0); expect(clock.pending).toEqual([]);
});

test("stop before start joins the probe without scheduling or checking", async () => {
  const clock = new Clock(); let checks = 0, stops = 0, changes = 0;
  const watch = createReviewerPolicyWatch({ async check() { checks++; return true; }, async stop() { stops++; } }, () => { changes++; }, clock);
  await watch.stop(); watch.start(); await watch.stop();
  expect(checks).toBe(0); expect(stops).toBe(1); expect(changes).toBe(0); expect(clock.jobs).toEqual([]);
});

for (const fault of ["start-clock", "nonfinite-clock", "schedule", "tick-clock", "rearm-clock", "rearm-schedule"] as const) test(`${fault} failure closes the watch and joins the probe`, async () => {
  const clock = new Clock(), held = deferred<boolean>(); let checks = 0, stops = 0, changes = 0;
  const watch = createReviewerPolicyWatch({ async check() { checks++; return await held.promise; }, async stop() { stops++; held.resolve(true); } }, () => { changes++; }, clock);
  if (fault === "start-clock") clock.nowError = true;
  if (fault === "nonfinite-clock") clock.at = NaN;
  if (fault === "schedule") clock.scheduleError = true;
  watch.start();
  if (fault === "tick-clock") { clock.nowError = true; clock.fire(100); }
  if (fault === "rearm-clock") { clock.fire(100); clock.nowError = true; held.resolve(true); }
  if (fault === "rearm-schedule") { clock.fire(100); clock.scheduleError = true; held.resolve(true); }
  await settle(); expect(changes).toBe(1); expect(stops).toBe(1); expect(clock.pending).toEqual([]);
  await watch.stop(); expect(stops).toBe(1); expect(checks).toBe(fault === "rearm-clock" || fault === "rearm-schedule" ? 1 : 0);
});

test("a throwing changed notification cannot undo fail-closed stop", async () => {
  const clock = new Clock(); let checks = 0, stops = 0, changes = 0;
  const watch = createReviewerPolicyWatch({ async check() { checks++; return false; }, async stop() { stops++; } }, () => { changes++; throw Error("synthetic notification failure"); }, clock);
  watch.start(); clock.fire(100); await settle(); await watch.stop();
  expect(checks).toBe(1); expect(stops).toBe(1); expect(changes).toBe(1); expect(clock.pending).toEqual([]);
});
