import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, DEFAULT_BUDGET, type BudgetHooks, type UsageWindow } from "../src/hub/budget.ts";
import { windowKind } from "../src/hub/window-kind.ts";
import { budgetNote, budgetNotes, compactTokens, kimiSourceRow, type BudgetNoteInput } from "../src/hub/budget-notes.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { publicPeerBudget } from "../src/hub/conductor.ts";

// #285 phase 4 (AC6, AC8): every number names its kind, and a person's or the provider's number outranks the hub's count at the gate.
function setup() {
  const clock = { now: 1_800_000_000_000 };
  const log: string[] = [];
  const hooks: BudgetHooks = {
    pause: p => log.push(`pause ${p}`), resume: p => log.push(`resume ${p}`),
    requestCheckpoint: async () => "checkpoint", platformContext: async () => "context", canHandOff: () => true, attached: () => true,
    handoff: async () => [], resumed: () => {}, notify: l => log.push(`! ${l}`),
  };
  const budget = new Budget(join(mkdtempSync(join(tmpdir(), "ahub-budget-kinds-")), "hub.db"), DEFAULT_BUDGET, hooks, () => clock.now);
  const settle = () => new Promise(r => setTimeout(r, 15));
  return { budget, clock, log, settle };
}
const MIN = 60_000;
const count = (used: number): UsageWindow => ({ id: "tokens", kind: "count", used, resetsAt: 1_800_000_000_000 + 60 * MIN, source: "hub count, kimi wire log, of kimi_tokens_5h 800000" });
const manual = (used: number, id: "5h" | "week" = "5h"): UsageWindow => ({ id, kind: "manual", used, resetsAt: 1_800_000_000_000 + 60 * MIN, source: "ahub budget set" });
const native = (used: number, id: "5h" | "week" = "5h"): UsageWindow => ({ id, used, resetsAt: 1_800_000_000_000 + 60 * MIN, windowMins: 300, source: "codex rateLimits" });

test("windowKind: a named kind wins; an untagged window is classified by its id and source, so an older reader keeps working", () => {
  expect(windowKind({ id: "5h", source: "codex rateLimits" })).toBe("native");
  expect(windowKind({ id: "tokens", source: "anything" })).toBe("count");
  expect(windowKind({ id: "5h", source: "ahub budget set" })).toBe("manual");
  expect(windowKind({ id: "5h", source: "ahub budget set", kind: "native" })).toBe("native");
  expect(windowKind({ id: "tokens", source: "x", kind: "manual" })).toBe("manual");
});

test("status carries each window's kind, and the projection copies it with the superseded flag; an older shape without one is classified", () => {
  const { budget } = setup();
  budget.report("kimi", [count(0.2)]); budget.report("kimi", [manual(0.4)]);
  const windows = budget.status().kimi!.windows;
  expect(windows.map(w => `${w.id}:${w.kind}`).sort()).toEqual(["5h:manual", "tokens:count"]);
  const projected = publicPeerBudget(budget.status(), () => true).kimi as any;
  expect(projected.windows.map((w: any) => `${w.id}:${w.kind}`).sort()).toEqual(["5h:manual", "tokens:count"]);
  const old = publicPeerBudget({ codex: { windows: [{ id: "5h", used: 0.1, at: 1, stale: false, source: "codex rateLimits" }] } }, () => true).codex as any;
  expect(old.windows[0].kind).toBe("native");
});

test("status lists the reading the gate acts on first, so a lookup by window id (an older client) finds the effective number", () => {
  const { budget, clock } = setup();
  budget.report("codex", [native(0.5)]); budget.report("codex", [manual(0.37)]);
  expect(budget.status().codex!.windows.find(w => w.id === "5h")).toMatchObject({ kind: "manual", used: 0.37, superseded: false });
  expect(budget.status().codex!.windows.map(w => [w.kind, w.superseded])).toEqual([["manual", false], ["native", true]]);
  budget.report("kimi", [count(0.9)]); budget.report("kimi", [native(0.2)]);
  expect(budget.status().kimi!.windows.map(w => w.kind)).toEqual(["native", "count"]); // the measurement leads the estimate it outranks
  clock.now += (DEFAULT_BUDGET.stale_min + 1) * MIN; // everything is stale: nothing is information-only, none gates
  expect(budget.status().codex!.windows.every(w => w.stale && !w.superseded)).toBe(true);
});

test("a manual value and a native value for one window are kept apart, never one overwriting the other", () => {
  const { budget } = setup();
  budget.report("codex", [native(0.3)]); budget.report("codex", [manual(0.5)]);
  const windows = budget.status().codex!.windows.filter(w => w.id === "5h");
  expect(windows.map(w => [w.kind, w.used]).sort()).toEqual([["manual", 0.5], ["native", 0.3]]);
  budget.report("codex", [native(0.31)]); // the provider reports again: the person's number stays
  expect(budget.status().codex!.windows.find(w => w.kind === "manual")!.used).toBe(0.5);
});

test("AC8: a manual value over the gate pauses even while the native reading is low, and a manual value under the gate keeps a high native one from pausing", async () => {
  const high = setup();
  high.budget.report("codex", [native(0.3)]); high.budget.report("codex", [manual(0.95)]); await high.settle();
  expect(high.budget.record("codex")?.reason).toContain("5h window at 95%");
  const low = setup();
  low.budget.report("codex", [manual(0.2)]); low.budget.report("codex", [native(0.97)]); await low.settle();
  expect(low.budget.record("codex")).toBeUndefined(); // the person's number for that window replaces the provider's at the gate
  expect(low.budget.headroom().codex!.headroom).toBeCloseTo(0.8, 5);
  // the other order: the provider's number paused first, then a person says the window is fine; the next reading lifts the pause
  const later = setup();
  later.budget.report("codex", [native(0.97)]); await later.settle();
  expect(later.budget.record("codex")).toBeDefined();
  later.clock.now += MIN; later.budget.report("codex", [manual(0.2)]); await later.settle();
  expect(later.budget.record("codex")).toBeUndefined();
});

test("AC8: the hub count never gates while a native or manual reading is fresh, and gates again when nothing else is", async () => {
  const a = setup();
  a.budget.report("kimi", [manual(0.1)]); a.budget.report("kimi", [count(0.99)]); await a.settle();
  expect(a.budget.record("kimi")).toBeUndefined();
  const status = a.budget.status().kimi!.windows;
  expect(status.find(w => w.kind === "count")!.superseded).toBe(true);
  expect(status.find(w => w.kind === "manual")!.superseded).toBe(false);
  expect(a.budget.headroom().kimi!.headroom).toBeCloseTo(0.9, 5); // routing sees the measurement, not the estimate
  const b = setup();
  b.budget.report("kimi", [count(0.99)]); await b.settle();
  expect(b.budget.record("kimi")?.reason).toContain("tokens window at 99%"); // a count alone still gates, as before
  expect(b.budget.status().kimi!.windows[0]!.superseded).toBe(false);
});

test("the count gates again once the manual reading is stale", async () => {
  const { budget, clock, settle } = setup();
  budget.report("kimi", [manual(0.1)]); budget.report("kimi", [count(0.99)]); await settle();
  expect(budget.record("kimi")).toBeUndefined();
  clock.now += (DEFAULT_BUDGET.stale_min + 1) * MIN; // the person's number is old; the count is refreshed
  budget.report("kimi", [{ ...count(0.99), resetsAt: clock.now + 60 * MIN }]); await settle();
  expect(budget.record("kimi")).toBeDefined();
});

test("a provider refusal clears the person's number for the window it names, so a hard pause is not outvoted", async () => {
  const { budget, settle } = setup();
  budget.report("kimi", [manual(0.1)]);
  budget.report("kimi", [{ id: "5h", used: 1, windowMins: 300, source: "kimi ACP usage-limit refusal", kind: "native" }], true); await settle();
  expect(budget.record("kimi")).toBeDefined();
  expect(budget.status().kimi!.windows.some(w => w.kind === "manual")).toBe(false);
});

test("forget drops only the named source's reading: the count's forget leaves a person's number", () => {
  const { budget } = setup();
  budget.report("kimi", [count(0.3)]); budget.report("kimi", [manual(0.4)]);
  budget.forget("kimi", "tokens", "count");
  expect(budget.status().kimi!.windows.map(w => w.kind)).toEqual(["manual"]);
  budget.report("kimi", [count(0.3)]); budget.forget("kimi", "tokens");
  expect(budget.status().kimi!.windows.map(w => w.kind)).toEqual(["manual"]);
});

test("quota_reset baselines are per kind: a person's number dropping is not read as the provider's window resetting", () => {
  const entries: any[] = [];
  const clock = { now: 1_800_000_000_000 };
  const hooks: BudgetHooks = { pause: () => {}, resume: () => {}, requestCheckpoint: async () => "c", platformContext: async () => "c", canHandOff: () => true, attached: () => true, handoff: async () => [], resumed: () => {}, notify: () => {}, ledger: e => entries.push(e) };
  const budget = new Budget(join(mkdtempSync(join(tmpdir(), "ahub-budget-kinds-")), "hub.db"), DEFAULT_BUDGET, hooks, () => clock.now);
  budget.report("codex", [{ ...native(0.6), resetsAt: undefined }]);
  budget.report("codex", [{ ...manual(0.1), resetsAt: undefined }]); // lower, but another source: no reset
  expect(entries.filter(e => e.type === "quota_reset")).toEqual([]);
  budget.report("codex", [{ ...native(0.1), resetsAt: undefined }]); // the provider's own number fell: a reset
  expect(entries.filter(e => e.type === "quota_reset")).toHaveLength(1);
});

// ---- notes: why a peer shows no number ----
const input = (over: Partial<BudgetNoteInput> = {}): BudgetNoteInput => ({ peers: [], windows: () => 0, definition: definitionOf, softTokens: () => undefined, hubTokens5h: () => undefined, ...over });

test("AC6: Pi and local say no quota, with the hub's own count when there is one", () => {
  expect(budgetNote("pi", input({ hubTokens5h: () => 1_200_000 }))).toEqual({ peer: "pi", kind: "no-quota", note: "no quota: on-prem backends have no provider quota; 1.2M tokens in 5h (hub count)" });
  expect(budgetNote("local", input())?.note).toBe("no quota: on-prem gateway has no provider quota");
  expect(budgetNote("pi", input({ windows: () => 1 }))?.kind).toBe("no-quota"); // a window never turns it into a meter
});

test("AC6: a peer without readings says why, per source: Kimi by its count state, Codex and Claude by their reader, an unknown peer says nothing", () => {
  expect(budgetNote("kimi", input({ softTokens: () => ({ state: "off" }) }))?.note).toBe("no reading: kimi reports context occupancy only; set budget.kimi_tokens_5h to count tokens, or ahub budget set kimi <0..1>");
  expect(budgetNote("kimi", input({ softTokens: () => ({ state: "unreadable", reason: "unknown_shape" }) }))?.note).toContain("wire log unreadable (unknown_shape)");
  expect(budgetNote("kimi", input({ softTokens: () => ({ state: "waiting" }) }))?.note).toBe("no reading yet: waiting for a Kimi session to count");
  expect(budgetNote("kimi", input({ softTokens: () => ({ state: "counting" }) }))?.note).toContain("starts with the next Kimi turn");
  expect(budgetNote("kimi", input({ softTokens: () => ({ state: "counting" }), windows: () => 1 }))).toBeUndefined();
  expect(budgetNote("codex", input())?.note).toBe("no reading yet: codex rateLimits has not reported");
  expect(budgetNote("claude", input())?.note).toBe("no reading yet: claude status line has not reported");
  expect(budgetNote("codex", input({ windows: () => 2 }))).toBeUndefined();
  expect(budgetNote("not-a-peer", input())).toBeUndefined();
  expect(budgetNotes(input({ peers: ["pi", "codex", "ghost"], windows: peer => (peer === "codex" ? 1 : 0) })).map(n => n.peer)).toEqual(["pi"]);
});

test("compactTokens reads at a glance, and the doctor row distinguishes off, unreadable and counting", () => {
  expect([812, 1_000, 1_250, 10_400, 340_000, 1_200_000, 12_000_000].map(compactTokens)).toEqual(["812", "1k", "1.3k", "10k", "340k", "1.2M", "12M"]);
  expect(kimiSourceRow(undefined)).toBeUndefined();
  expect(kimiSourceRow({ state: "off" })).toMatchObject({ ok: undefined });
  expect(kimiSourceRow({ state: "unreadable", reason: "log_rotated" })).toMatchObject({ ok: false, detail: expect.stringContaining("log_rotated") });
  expect(kimiSourceRow({ state: "counting" })).toMatchObject({ ok: true, detail: expect.stringContaining("never the provider's quota") });
  expect(kimiSourceRow({ state: "waiting" })).toMatchObject({ ok: true, detail: expect.stringContaining("no Kimi session is bound yet") });
});

// ---- the Pi/local 5 h counter seeded from a long event log ----
import { TokenWindow } from "../src/hub/token-window.ts";
const HOUR = 3_600_000;

test("TokenWindow.seed skips rows already out of the window and keeps the rest in order, so a long log costs the window and not the log", () => {
  const now = 1_800_000_000_000, window = new TokenWindow(5 * HOUR);
  const rows = [{ at: now - 9 * HOUR, n: 9_000 }, { at: now - 60_000, n: 10 }, { at: now - 6 * HOUR, n: 6_000 }, { at: now - 2 * HOUR, n: 20 }, { at: now - 5 * HOUR - 1, n: 5_000 }, { at: now - 5 * HOUR, n: 30 }, { at: NaN, n: 1 }, { at: now - 1000, n: 0 }];
  window.seed(rows, now);
  expect((window as unknown as { rows: unknown[] }).rows).toHaveLength(3); // held before any read prunes: the expired and the invalid were never inserted
  expect(window.sum(now)).toBe(60);
  expect(window.oldest(now)).toBe(now - 5 * HOUR);
  window.add(now - 3 * HOUR, 7); // a later read fills in between, in time order
  expect(window.sum(now)).toBe(67);
  expect(window.oldest(now + 1)).toBe(now - 3 * HOUR); // the row at exactly 5 h ages out one tick later
});

test("seeding a hundred thousand old rows and a few live ones is one pass: it holds only the live rows and stays fast", () => {
  const now = 1_800_000_000_000, window = new TokenWindow(5 * HOUR);
  const rows: { at: number; n: number }[] = [];
  for (let i = 0; i < 100_000; i++) rows.push({ at: now - 6 * HOUR - i * 1000, n: 5 }); // all expired
  for (let i = 0; i < 20; i++) rows.push({ at: now - i * 60_000, n: 3 });
  const started = performance.now();
  window.seed(rows, now);
  expect(performance.now() - started).toBeLessThan(500);
  expect(window.sum(now)).toBe(60);
  expect((window as unknown as { rows: unknown[] }).rows).toHaveLength(20); // nothing expired was kept
  // the in-order append path of add() does no search either: 50 000 rows in time order
  const live = new TokenWindow(5 * HOUR), t0 = performance.now();
  for (let i = 0; i < 50_000; i++) live.add(now - 4 * HOUR + i, 1);
  expect(performance.now() - t0).toBeLessThan(500);
  expect(live.sum(now)).toBe(50_000);
});
