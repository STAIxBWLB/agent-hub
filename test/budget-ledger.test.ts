import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, DEFAULT_BUDGET, type BudgetHooks, type BudgetLedgerEntry, type UsageWindow } from "../src/hub/budget.ts";

// #683 U1: the limit ledger. Pauses, resumes and derived resets reach `hooks.ledger`, ids and numbers only.
const MIN = 60_000;
const T0 = 1_800_000_000_000;
function setup(db = join(mkdtempSync(join(tmpdir(), "ahub-ledger-")), "hub.db")) {
  const clock = { now: T0 };
  const ledger: BudgetLedgerEntry[] = [];
  const hooks: BudgetHooks = {
    pause: () => {}, resume: () => {}, requestCheckpoint: async () => "checkpoint text that must never reach the ledger", platformContext: async () => undefined,
    canHandOff: () => true, attached: () => true, handoff: async () => [{ id: 7, title: "a private task title", to: "local", role: "owner" }], resumed: () => {}, notify: () => {},
    ledger: entry => ledger.push(entry),
  };
  const budget = new Budget(db, DEFAULT_BUDGET, hooks, () => clock.now);
  const settle = () => new Promise(resolve => setTimeout(resolve, 15));
  const reading = (id: UsageWindow["id"], used: number, resetsAt?: number): UsageWindow[] => [{ id, used, source: "codex rateLimits", ...(resetsAt !== undefined ? { resetsAt } : {}) }];
  return { budget, clock, ledger, settle, reading, db };
}
const types = (ledger: BudgetLedgerEntry[]) => ledger.map(entry => entry.type);

test("a pause followed by a resume records both, with the window, the reset and who ended it (#683 U1)", async () => {
  const { budget, clock, ledger, settle, reading } = setup();
  budget.report("codex", reading("5h", 0.95, T0 + 60 * MIN)); await settle();
  expect(ledger.filter(entry => entry.type !== "quota_reset")).toEqual([{ type: "budget_pause", peer: "codex", reason: "5h window at 95% (codex rateLimits)", window: "5h", resetsAt: T0 + 60 * MIN, by: "hub" }]);
  clock.now = T0 + 61 * MIN + 1; budget.tick();
  const rest = ledger.filter(entry => entry.type !== "quota_reset");
  expect(rest.map(entry => entry.type)).toEqual(["budget_pause", "budget_resume"]);
  expect(rest[1]).toEqual({ type: "budget_resume", peer: "codex", reason: "the window has reset", window: "5h", resetsAt: T0 + 60 * MIN, by: "hub" });
  budget.close();
});

test("a person's override is a resume by `person`, and the ledger carries no checkpoint text, task title or summary (#683 U1)", async () => {
  const { budget, ledger, settle, reading } = setup();
  budget.report("codex", reading("5h", 0.95, T0 + 60 * MIN)); await settle();
  expect(budget.override("codex")).toBe(true);
  const resume = ledger.find(entry => entry.type === "budget_resume")!;
  expect(resume).toMatchObject({ type: "budget_resume", peer: "codex", by: "person", window: "5h", reason: "overridden by the console user" });
  const text = JSON.stringify(ledger);
  expect(text).not.toContain("checkpoint text"); expect(text).not.toContain("private task title");
  budget.close();
});

test("a duplicate reading adds no reset, and a forward resetsAt adds exactly one (#683 U1)", () => {
  const { budget, ledger, reading } = setup();
  budget.report("codex", reading("5h", 0.4, T0 + 60 * MIN));            // first reading: a baseline, never a reset
  budget.report("codex", reading("5h", 0.4, T0 + 60 * MIN));            // the same reading again
  budget.report("codex", reading("5h", 0.42, T0 + 60 * MIN));           // more use in the same window
  expect(types(ledger)).toEqual([]);
  budget.report("codex", reading("5h", 0.05, T0 + 360 * MIN));          // the window rolled: resetsAt moved forward
  expect(ledger).toEqual([{ type: "quota_reset", peer: "codex", window: "5h", cause: "resets_at_moved", resetsAt: T0 + 360 * MIN, previousResetsAt: T0 + 60 * MIN, used: 0.05, previousUsed: 0.42 }]);
  budget.report("codex", reading("5h", 0.05, T0 + 360 * MIN));          // a duplicate of the new window
  budget.report("codex", reading("5h", 0.06, T0 + 360 * MIN));
  expect(ledger).toHaveLength(1);
  budget.close();
});

test("used falling by 0.5 or more inside one window id is a reset; a smaller fall is not (#683 U1)", () => {
  const { budget, ledger, reading } = setup();
  budget.report("claude", reading("week", 0.8));                        // no resetsAt known
  budget.report("claude", reading("week", 0.35));                       // a fall of 0.45: not a reset
  expect(ledger).toEqual([]);
  budget.report("claude", reading("week", 0.8));
  budget.report("claude", reading("week", 0.1));                        // a fall of 0.7
  expect(ledger).toEqual([{ type: "quota_reset", peer: "claude", window: "week", cause: "used_dropped", used: 0.1, previousUsed: 0.8 }]);
  budget.report("claude", reading("week", 0.8)); budget.report("claude", reading("week", 0.1));
  expect(ledger).toHaveLength(1); // the same window id with no resetsAt is one reset key: a second fall is not recorded twice
  budget.close();
});

test("windows are tracked apart, and an older file reading never counts as a reset (#683 U1)", () => {
  const { budget, ledger, reading, clock } = setup();
  budget.report("codex", [...reading("5h", 0.9, T0 + 60 * MIN), ...reading("week", 0.3, T0 + 6000 * MIN)], false, T0);
  budget.report("codex", reading("5h", 0.9, T0 + 60 * MIN), false, T0 + MIN);
  expect(ledger).toEqual([]);                                           // 5h unchanged, week untouched by a 5h reading
  clock.now = T0 + 2 * MIN;
  budget.report("codex", reading("5h", 0.1, T0 + 360 * MIN), false, T0 - 10 * MIN); // stale: measured before the baseline
  expect(ledger).toEqual([]);
  budget.close();
});

test("a resume clears the old readings but the baseline survives, so the reset that ended a pause is seen once (#683 U1)", async () => {
  const { budget, clock, ledger, settle, reading } = setup();
  budget.report("codex", reading("5h", 0.95, T0 + 60 * MIN)); await settle();
  clock.now = T0 + 61 * MIN + 1; budget.tick();
  budget.report("codex", reading("5h", 0.02, T0 + 360 * MIN));
  expect(ledger.filter(entry => entry.type === "quota_reset")).toEqual([{ type: "quota_reset", peer: "codex", window: "5h", cause: "resets_at_moved", resetsAt: T0 + 360 * MIN, previousResetsAt: T0 + 60 * MIN, used: 0.02, previousUsed: 0.95 }]);
  budget.close();
});

test("a reset already in the log from an earlier hub run is not written again after a restart (#683 U1)", () => {
  const first = setup();
  first.budget.report("codex", first.reading("5h", 0.5, T0 + 60 * MIN));
  first.budget.report("codex", first.reading("5h", 0.05, T0 + 360 * MIN));
  const written = first.ledger.filter(entry => entry.type === "quota_reset") as Extract<BudgetLedgerEntry, { type: "quota_reset" }>[];
  expect(written).toHaveLength(1);
  first.budget.close();
  // The next run: the daemon seeds the budget with the resets the log already holds, then the same readings arrive again.
  const second = setup(first.db);
  second.budget.seedResets(written.map(entry => ({ peer: entry.peer, window: entry.window, ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}) })));
  second.budget.report("codex", second.reading("5h", 0.5, T0 + 60 * MIN));
  second.budget.report("codex", second.reading("5h", 0.05, T0 + 360 * MIN));
  expect(second.ledger).toEqual([]);
  second.budget.close();
});

test("a ledger hook that throws never costs the pause or the reading (#683 U1)", async () => {
  const { budget, settle, reading, ledger } = setup();
  (budget as unknown as { hooks: BudgetHooks }).hooks.ledger = () => { throw new Error("ledger down"); };
  budget.report("codex", reading("5h", 0.96, T0 + 60 * MIN)); await settle();
  expect(budget.record("codex")?.reason).toContain("5h window at 96%");
  expect(ledger).toEqual([]);
  budget.close();
});

test("the first reading after a restart is only a baseline, so a reset while the hub was down is not invented (#683 U1)", () => {
  const first = setup();
  first.budget.report("codex", first.reading("5h", 0.9, T0 + 60 * MIN));
  first.budget.close();
  const second = setup(first.db);
  second.budget.report("codex", second.reading("5h", 0.05, T0 + 360 * MIN)); // the window rolled while the hub was down
  expect(second.ledger).toEqual([]);
  second.budget.report("codex", second.reading("5h", 0.06, T0 + 360 * MIN));
  expect(second.ledger).toEqual([]);
  second.budget.close();
});

// Found by replaying the hub's real quota log (177k readings): a provider's resetsAt wobbles by seconds inside one window while `used` is
// unchanged, and a real reset moves it by hours. The first cut recorded the wobble as a reset (25 of 85 entries).
test("a resetsAt that wobbles by seconds inside one window is not a reset, and a move of hours is (#683 U1)", () => {
  const { budget, ledger, reading } = setup();
  budget.report("codex", reading("week", 0.92, T0 + 5_000 * MIN));
  for (const wobble of [1, 2, 3, 9]) budget.report("codex", reading("week", 0.92, T0 + 5_000 * MIN + wobble * 1000)); // seconds forward
  budget.report("codex", reading("week", 0.92, T0 + 5_000 * MIN + 10 * MIN));                                       // ten minutes: still the same window
  expect(ledger).toEqual([]);
  budget.report("codex", reading("week", 0.03, T0 + 5_000 * MIN + 15 * 60 * MIN));                                  // fifteen hours: a new window
  expect(ledger.map(e => e.type)).toEqual(["quota_reset"]);
  expect(ledger[0]).toMatchObject({ cause: "resets_at_moved", used: 0.03 });
  budget.close();
});

test("a window the provider reset early (resetsAt moved only 39 minutes, used 0.99 to 0) is recorded once (#683 U1)", () => {
  // Real log, 2026-10-19: codex week 0.99 -> 0 while resetsAt moved 39 minutes. That is past the jitter tolerance, so its cause is the move.
  const { budget, ledger, reading } = setup();
  budget.report("codex", reading("week", 0.99, T0 + 5_000 * MIN));
  budget.report("codex", reading("week", 0, T0 + 5_000 * MIN + 39 * MIN));
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ type: "quota_reset", cause: "resets_at_moved", used: 0, previousUsed: 0.99 });
  budget.close();
});

test("the same window with no resetsAt change and used falling by 0.5 or more is a reset by the used drop (#683 U1)", () => {
  const { budget, ledger, reading } = setup();
  budget.report("codex", reading("week", 0.8, T0 + 5_000 * MIN));
  budget.report("codex", reading("week", 0.1, T0 + 5_000 * MIN + 5_000)); // 5 s of jitter, used fell by 0.7
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ type: "quota_reset", cause: "used_dropped", previousUsed: 0.8, used: 0.1 });
  budget.close();
});
