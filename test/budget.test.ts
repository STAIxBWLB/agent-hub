import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, claudeWindows, codexWindows, DEFAULT_BUDGET, type BudgetHooks, type Moved, type PauseRecord } from "../src/hub/budget.ts";

function setup(over: Partial<BudgetHooks> = {}, db = join(mkdtempSync(join(tmpdir(), "agenthub-budget-")), "hub.db")) {
  const clock = { now: 1_800_000_000_000 };
  const log: string[] = [];
  const resumed: PauseRecord[] = [];
  const hooks: BudgetHooks = {
    pause: (p) => log.push(`pause ${p}`),
    resume: (p) => log.push(`resume ${p}`),
    requestCheckpoint: async (p) => (log.push(`checkpoint? ${p}`), "was halfway through the parser"),
    platformContext: async (p) => (log.push(`memory? ${p}`), "recent codex sessions ..."),
    canHandOff: () => true,
    attached: () => true,
    handoff: async (p, ctx) => (log.push(`handoff ${p}: ${ctx}`), [{ id: 1, title: "#1 parser", to: "local", role: "owner" }] as Moved[]),
    resumed: (r) => resumed.push(r),
    notify: (l) => log.push(`! ${l}`),
    ...over,
  };
  const budget = new Budget(db, DEFAULT_BUDGET, hooks, () => clock.now);
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { budget, clock, log, resumed, settle, db, hooks };
}
const MIN = 60_000;

test("over the gate: checkpoint first, pause second, hand over with the summary; repeating the reading does nothing", async () => {
  const { budget, clock, log, settle } = setup();
  budget.report("codex", [{ id: "5h", used: 0.85, source: "t" }]);
  await settle();
  expect(log).toEqual([]);
  budget.report("codex", [{ id: "5h", used: 0.95, resetsAt: clock.now + 40 * MIN, source: "t" }]);
  budget.report("codex", [{ id: "5h", used: 0.96, resetsAt: clock.now + 40 * MIN, source: "t" }]); // while the first is still checkpointing
  await settle();
  expect(log.filter((l) => !l.startsWith("!"))).toEqual(["checkpoint? codex", "pause codex", "handoff codex: was halfway through the parser"]);
  budget.report("codex", [{ id: "5h", used: 0.97, resetsAt: clock.now + 40 * MIN, source: "t" }]);
  await settle();
  expect(log.filter((l) => l.startsWith("pause"))).toHaveLength(1);
  expect(budget.record("codex")).toMatchObject({ summary: "was halfway through the parser", handedOff: true, moved: [{ id: 1, to: "local" }] });
  expect(budget.status().codex!.paused!.reason).toContain("5h window at 95%");
});

test("a hard limit skips the checkpoint and falls back to memory; no memory means no context; local is never paused", async () => {
  const hard = setup();
  hard.budget.report("codex", [{ id: "5h", used: 1, source: "codex usageLimitExceeded" }], true);
  await hard.settle();
  expect(hard.log.filter((l) => !l.startsWith("!"))).toEqual(["pause codex", "memory? codex", "handoff codex: recent codex sessions ..."]);
  expect(hard.budget.record("codex")!.resetsAt).toBe(hard.clock.now + 300 * MIN); // no resetsAt: the window length

  const bare = setup({ platformContext: async () => undefined, requestCheckpoint: async () => undefined });
  bare.budget.report("kimi", [{ id: "tokens", used: 0.99, source: "t" }]);
  await bare.settle();
  expect(bare.log).toContain("handoff kimi: undefined");

  bare.budget.report("local", [{ id: "5h", used: 1, source: "t" }]);
  await bare.settle();
  expect(bare.budget.record("local")).toBeUndefined();
});

test("resume: at the reset time, or on a fresh reading under gate - 0.1; a dip just under the gate or a stale reading does not", async () => {
  const { budget, clock, log, resumed, settle } = setup();
  budget.report("claude", [{ id: "5h", used: 0.93, resetsAt: clock.now + 30 * MIN, source: "t" }]);
  await settle();
  clock.now += MIN;
  budget.report("claude", [{ id: "5h", used: 0.88, source: "t" }]); // under the gate, inside the hysteresis
  await settle();
  expect(budget.record("claude")).toBeDefined();
  budget.tick();
  expect(budget.record("claude")).toBeDefined(); // not yet
  clock.now += 31 * MIN;
  budget.tick();
  expect(budget.record("claude")).toBeUndefined();
  expect(log).toContain("resume claude");
  expect(resumed[0]).toMatchObject({ peer: "claude", moved: [{ id: 1 }] });

  budget.report("claude", [{ id: "week", used: 0.95, resetsAt: clock.now + 600 * MIN, source: "t" }]);
  await settle();
  clock.now += MIN;
  budget.report("claude", [{ id: "week", used: 0.7, source: "t" }]);
  await settle();
  expect(budget.record("claude")).toBeUndefined(); // well under: resumed early
  expect(resumed).toHaveLength(2);

  // stale readings neither pause nor show as fresh
  budget.report("kimi", [{ id: "5h", used: 0.5, source: "t" }]);
  clock.now += 45 * MIN;
  expect(budget.status().kimi!.windows[0]!.stale).toBe(true);
});

test("a leftover reading is not fresh: old timestamps and windows that have reset since are ignored; a window that reset while the hub was down is lifted", async () => {
  const { budget, clock, log, settle, db } = setup();
  budget.report("claude", [{ id: "5h", used: 0.95, resetsAt: clock.now + 10 * MIN, source: "file" }], false, clock.now - 20 * 60 * MIN); // yesterday's file
  budget.report("claude", [{ id: "5h", used: 0.95, resetsAt: clock.now - MIN, source: "file" }]); // fresh numbers about a window that is over
  await settle();
  expect(log).toEqual([]);

  budget.report("codex", [{ id: "5h", used: 0.95, resetsAt: clock.now + 5 * MIN, source: "t" }]);
  await settle();
  budget.close();
  let here = false;
  const later = setup({ attached: () => here }, db);
  later.clock.now = clock.now + 30 * MIN;
  later.budget.restore();
  later.budget.tick();
  expect(later.log.some((l) => l.startsWith("pause"))).toBe(false); // not paused again
  expect(later.resumed).toHaveLength(0); // and not told yet: nobody is there to receive the notice
  here = true;
  later.budget.tick();
  expect(later.resumed[0]).toMatchObject({ peer: "codex" }); // the one envelope listing what moved, once the peer is back
  expect(later.budget.record("codex")).toBeUndefined();
});

test("override: ahub budget resume lifts the pause and the same window cannot pause the peer again; the resume notice is queued before the peer is released", async () => {
  const order: string[] = [];
  const { budget, clock, settle } = setup({ resume: () => order.push("resume"), resumed: () => order.push("notice") });
  budget.report("claude", [{ id: "5h", used: 0.95, resetsAt: clock.now + 60 * MIN, source: "status line" }]);
  await settle();
  expect(budget.override("claude")).toBe(true);
  expect(order).toEqual(["notice", "resume"]);
  budget.report("claude", [{ id: "5h", used: 0.96, resetsAt: clock.now + 60 * MIN, source: "status line" }]); // the tee keeps reporting
  await settle();
  expect(budget.record("claude")).toBeUndefined();
  clock.now += 61 * MIN;
  budget.report("claude", [{ id: "5h", used: 0.95, resetsAt: clock.now + 300 * MIN, source: "status line" }]); // a new window
  await settle();
  expect(budget.record("claude")).toBeDefined();
  expect(budget.override("kimi")).toBe(false);
});

test("closing the coordinator during a checkpoint wait records nothing and throws nothing", async () => {
  let release = (_: string | undefined) => {};
  const { budget, log, settle } = setup({ requestCheckpoint: () => new Promise((r) => (release = r)) });
  budget.report("codex", [{ id: "5h", used: 0.95, source: "t" }]);
  await settle();
  budget.close();
  release(undefined);
  budget.checkpointed("codex", "a hub_checkpoint that lands during shutdown"); // must not touch the closed database
  await settle();
  expect(log.filter((l) => l.startsWith("pause"))).toEqual([]);
});

test("a later reading supplies the reset time the first one lacked", async () => {
  const { budget, clock, settle } = setup();
  budget.report("codex", [{ id: "5h", used: 1, source: "t" }], true);
  await settle();
  budget.report("codex", [{ id: "5h", used: 1, resetsAt: clock.now + 12 * MIN, source: "t" }]);
  await settle();
  expect(budget.record("codex")!.resetsAt).toBe(clock.now + 12 * MIN);
});

test("the pause survives a hub restart, and a handoff that was cut short is finished", async () => {
  const first = setup({ handoff: async () => { throw new Error("hub died here"); } });
  first.budget.report("codex", [{ id: "5h", used: 0.95, resetsAt: first.clock.now + 20 * MIN, source: "t" }]);
  await first.settle();
  first.budget.close();

  let attached = false;
  const second = setup({ canHandOff: () => attached }, first.db);
  second.budget.restore();
  second.budget.tick();
  await second.settle();
  // nobody is attached right after a restart: handing over now would only strip the tasks of their owner
  expect(second.log.filter((l) => !l.startsWith("!"))).toEqual(["pause codex"]);
  expect(second.budget.record("codex")).toMatchObject({ handedOff: false });
  attached = true;
  second.budget.tick();
  second.budget.tick(); // a second tick while the first handoff runs must not start another
  await second.settle();
  expect(second.log.filter((l) => l.startsWith("handoff"))).toEqual(["handoff codex: was halfway through the parser"]);
  expect(second.budget.record("codex")).toMatchObject({ handedOff: true });
  second.clock.now += 22 * MIN;
  second.budget.tick();
  expect(second.log).toContain("resume codex");
});

test("window parsers: Codex rateLimits and Claude status line", () => {
  expect(codexWindows({ primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 40, windowDurationMins: 10_080 } })).toEqual([
    { id: "5h", used: 0.91, resetsAt: 1_800_000_000_000, windowMins: 300, source: "codex rateLimits" },
    { id: "week", used: 0.4, windowMins: 10_080, source: "codex rateLimits" },
  ]);
  expect(codexWindows({ primary: null, secondary: null, rateLimitReachedType: "usageLimitExceeded" })).toEqual([{ id: "5h", used: 1, source: "codex usageLimitExceeded" }]);
  expect(codexWindows(undefined)).toEqual([]);
  // no durations: the slots decide, and a hot short window is never overwritten by a cool long one
  expect(codexWindows({ primary: { usedPercent: 97 }, secondary: { usedPercent: 12 } }).map((w) => `${w.id}:${w.used}`)).toEqual(["5h:0.97", "week:0.12"]);
  expect(codexWindows({ primary: { usedPercent: 97, windowDurationMins: 300 }, secondary: { usedPercent: 12, windowDurationMins: 300 } }).map((w) => `${w.id}:${w.used}`)).toEqual(["5h:0.97"]);
  expect(claudeWindows({ five_hour: { used_percentage: 42, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 7 } })).toEqual([
    { id: "5h", used: 0.42, resetsAt: 1_800_000_000_000, windowMins: 300, source: "claude status line" },
    { id: "week", used: 0.07, windowMins: 10_080, source: "claude status line" },
  ]);
});
