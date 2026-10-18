import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Budget, DEFAULT_BUDGET, type BudgetHooks, type PauseRecord } from "../src/hub/budget.ts";

const NOW = 1_800_000_000_000, MIN = 60_000;
const account = (peer: string) => peer === "codex-2" || peer === "codex-3" ? "codex" : peer === "local-2" ? "local" : peer;
function fixture(extra: Partial<BudgetHooks> = {}, grouped = true, path?: string) {
  const dir = path === undefined ? mkdtempSync(join(tmpdir(), "ahub-instance-budget-")) : undefined;
  const db = path ?? join(dir!, "hub.db"), clock = { now: NOW }, events: string[] = [], telemetry: { peer: string; at: number }[] = [], notices: PauseRecord[] = [];
  const hooks: BudgetHooks & { account?: (peer: string) => string } = {
    ...(grouped ? { account } : {}),
    pause: peer => { events.push(`pause ${peer}`); }, resume: peer => { events.push(`resume ${peer}`); },
    requestCheckpoint: async peer => { events.push(`checkpoint ${peer}`); return "checkpoint"; }, platformContext: async () => undefined,
    attached: () => true, canHandOff: () => false, handoff: async () => [],
    resumed: record => { notices.push(record); events.push(`notice ${record.peer}`); },
    reading: (peer, _windows, _hard, at) => { telemetry.push({ peer, at }); }, notify: () => {}, ...extra,
  };
  const budget = new Budget(db, DEFAULT_BUDGET, hooks, () => clock.now);
  return { budget, db, clock, events, telemetry, notices, hooks, close() { budget.close(); if (dir) rmSync(dir, { recursive: true, force: true }); } };
}
async function settled(budget: Budget) {
  for (let i = 0; i < 200 && !budget.recoverySettled; i++) await Promise.resolve();
  expect(budget.recoverySettled).toBe(true);
}
const window = (used: number, resetsAt = NOW + 5 * MIN) => [{ id: "5h" as const, used, resetsAt, source: "synthetic account" }];

test("instance quota reports replace one account window and share one pause, headroom and checkpoint record", async () => {
  const f = fixture();
  try {
    f.budget.report("codex-2", window(0.5), false, NOW - 200);
    f.budget.report("codex", window(0.7), false, NOW - 100);
    expect(Object.keys(f.budget.headroom())).toEqual(["codex"]);
    expect(f.budget.headroom().codex?.headroom).toBeCloseTo(0.3);
    expect(f.budget.status().codex?.windows).toHaveLength(1);
    expect(f.budget.status().codex?.windows[0]?.at).toBe(NOW - 100);
    expect(f.telemetry).toEqual([{ peer: "codex-2", at: NOW - 200 }, { peer: "codex", at: NOW - 100 }]);
    f.budget.report("codex-2", window(1), true); await settled(f.budget);
    expect(f.budget.record("codex-2")).toEqual(f.budget.record("codex"));
    expect(f.budget.record("codex-3")?.peer).toBe("codex");
    expect(Object.keys(f.budget.status())).toEqual(["codex"]);
    expect(f.events).toEqual(["pause codex"]);
    f.budget.checkpointed("codex-3", "shared checkpoint");
    expect(f.budget.record("codex")?.summary).toBe("shared checkpoint");
    const db = new Database(f.db, { readonly: true });
    try { expect(db.query("SELECT peer FROM budget_pauses").all()).toEqual([{ peer: "codex" }]); } finally { db.close(); }
  } finally { f.close(); }
});

test("instance console override is account-wide and sibling hard refusal ends it without losing pause ordering", async () => {
  const f = fixture();
  try {
    f.budget.report("codex-2", window(1), true); await settled(f.budget);
    expect(f.budget.override("codex")).toBe(true);
    expect(f.budget.record("codex-2")).toBeUndefined();
    expect(f.events).toEqual(["pause codex", "notice codex", "resume codex"]);
    f.budget.report("codex-3", window(1)); await settled(f.budget);
    expect(f.budget.record("codex-3")).toBeUndefined();
    f.budget.report("codex-2", window(1), true); await settled(f.budget);
    expect(f.budget.record("codex")?.peer).toBe("codex");
    expect(f.events).toEqual(["pause codex", "notice codex", "resume codex", "pause codex"]);
  } finally { f.close(); }
});

test("instance hard refusal supersedes a sibling soft checkpoint evaluation on the same account", async () => {
  let release = (_summary: string | undefined) => {};
  const checkpoint = new Promise<string | undefined>(resolve => { release = resolve; });
  const f = fixture({ requestCheckpoint: async peer => { f.events.push(`checkpoint ${peer}`); return checkpoint; } });
  try {
    f.budget.report("codex-2", window(0.95));
    expect(f.events).toEqual(["checkpoint codex"]); expect(f.budget.record("codex")).toBeUndefined();
    f.budget.report("codex-3", window(1), true); await Promise.resolve();
    release("obsolete checkpoint"); await settled(f.budget);
    expect(f.budget.record("codex-2")).toMatchObject({ peer: "codex", summary: null, reason: "5h window at 100% (synthetic account)" });
    expect(f.events).toEqual(["checkpoint codex", "pause codex"]);
  } finally { release(undefined); await settled(f.budget); f.close(); }
});

test("instance recovery defers one account evaluation and reset notice precedes account resume", async () => {
  const f = fixture();
  try {
    f.budget.setRecoveryHold(true);
    f.budget.report("codex-2", window(0.95), false, NOW - 1000);
    f.budget.report("codex-3", window(1), true, NOW - 500);
    expect(f.events).toEqual([]); expect(f.budget.record("codex")).toBeUndefined();
    f.budget.setRecoveryHold(false); await settled(f.budget);
    expect(f.events).toEqual(["pause codex"]);
    expect(f.budget.status().codex?.windows).toHaveLength(1);
    expect(f.budget.status().codex?.windows[0]?.at).toBe(NOW - 500);
    f.clock.now = NOW + 6 * MIN; f.budget.tick();
    expect(f.budget.record("codex-2")).toBeUndefined();
    expect(f.events).toEqual(["pause codex", "notice codex", "resume codex"]);
  } finally { f.close(); }
});

test("instance account admission preserves local quota exemption and the default ungrouped legacy behavior", async () => {
  const f = fixture(), legacy = fixture({}, false);
  try {
    f.budget.report("local-2", window(1), true); await settled(f.budget);
    expect(f.budget.record("local")).toBeUndefined(); expect(f.events).toEqual([]);
    legacy.budget.report("codex-2", window(1), true); await settled(legacy.budget);
    expect(legacy.budget.record("codex")).toBeUndefined(); expect(legacy.budget.record("codex-2")?.peer).toBe("codex-2");
    expect(legacy.events).toEqual(["pause codex-2"]);
  } finally { f.close(); legacy.close(); }
});

test("instance startup atomically merges pre-existing alias pauses conservatively without dropping history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-instance-budget-restore-")), file = join(dir, "hub.db");
  const seed = fixture({}, false, file); seed.close();
  const db = new Database(file);
  const owner = { id: 1, title: "owner work", role: "owner", to: "kimi" }, reviewer = { id: 2, title: "review work", role: "reviewer", to: "claude" };
  db.query("INSERT INTO budget_pauses VALUES (?, ?, ?, ?, ?, ?, ?)").run("codex", NOW - 200, NOW + MIN, "first pause", "first context", 1, JSON.stringify([owner]));
  db.query("INSERT INTO budget_pauses VALUES (?, ?, ?, ?, ?, ?, ?)").run("codex-2", NOW - 100, NOW + 5 * MIN, "second pause", "second context", 0, JSON.stringify([owner, reviewer]));
  db.close();
  const f = fixture({}, true, file);
  try {
    f.budget.restore();
    expect(f.events).toEqual(["pause codex"]);
    const merged = f.budget.record("codex-2")!;
    expect(merged).toMatchObject({ peer: "codex", since: NOW - 200, resetsAt: NOW + 5 * MIN, handedOff: false, moved: [owner, reviewer] });
    expect(merged.reason).toContain("first pause"); expect(merged.reason).toContain("second pause");
    expect(merged.summary).toContain("first context"); expect(merged.summary).toContain("second context");
    expect(f.budget.persistedPauseDigestRows()).toHaveLength(1);
    expect(f.budget.record("codex")).toEqual(merged);
    expect(f.budget.override("codex-3")).toBe(true); expect(f.budget.record("codex")).toBeUndefined();
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});
