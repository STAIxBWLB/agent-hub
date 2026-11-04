import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunTracker, outcomeOf, settleVerdict, type SettleFacts } from "../src/hub/completions.ts";
import { CompletionStore } from "../src/hub/completions-store.ts";
import { ADAPTERS, definitionOf } from "../src/adapters/registry.ts";
import { SETTLE_SIGNALS } from "../src/adapters/registry-types.ts";

// #1054 T2: the settle rule, the run tracker and the completions store. Daemon-backed legs (AC1-AC5 with fake adapters) are in completions-daemon.test.ts.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const quiet: SettleFacts = { signal: true, queuedContinuations: 0, openPermissions: 0, openQuestions: 0, ownedChildren: 0, runningChecks: 0, heldDeliveries: 0 };

test("a run settles only when the adapter signalled and nothing else is pending", () => {
  expect(settleVerdict(quiet)).toBe("settled");
  expect(settleVerdict({ ...quiet, signal: false })).toBe("working");
  for (const key of ["queuedContinuations", "ownedChildren", "runningChecks", "heldDeliveries"] as const) expect(settleVerdict({ ...quiet, [key]: 1 }), key).toBe("working");
});

test("an open permission or question is needs-input and wins over every other fact", () => {
  expect(settleVerdict({ ...quiet, openPermissions: 1 })).toBe("needs-input");
  expect(settleVerdict({ ...quiet, openQuestions: 2 })).toBe("needs-input");
  expect(settleVerdict({ ...quiet, signal: false, queuedContinuations: 3, openQuestions: 1 })).toBe("needs-input");
});

test("the outcome is limit before failed before done", () => {
  expect(outcomeOf({})).toBe("done");
  expect(outcomeOf({ failed: true })).toBe("failed");
  expect(outcomeOf({ limit: true })).toBe("limit");
  expect(outcomeOf({ failed: true, limit: true })).toBe("limit");
});

test("only a person-originated turn starts a run; a later turn of an open run is a continuation that clears the signal", () => {
  const tracker = new RunTracker();
  expect(tracker.turnStarted({ peer: "codex", turn: "codex#a.1", at: 1, personOriginated: false, private: false })).toBeUndefined();
  expect(tracker.open()).toEqual([]);
  const run = tracker.turnStarted({ peer: "codex", turn: "codex#a.2", at: 2, personOriginated: true, promptEnvelope: "env-1", private: false })!;
  expect(run).toMatchObject({ runTurn: "codex#a.2", lastTurn: "codex#a.2", promptEnvelope: "env-1", signalled: false });
  tracker.signalled("codex", "env-9");
  expect(tracker.get("codex")).toMatchObject({ signalled: true, replyEnvelope: "env-9" });
  // an agent-to-agent delivery starts the next turn: it is part of the run, and the signal must fire again
  tracker.turnStarted({ peer: "codex", turn: "codex#a.3", at: 3, personOriginated: false, private: true });
  expect(tracker.get("codex")).toMatchObject({ runTurn: "codex#a.2", lastTurn: "codex#a.3", signalled: false, private: true });
  expect(tracker.state("codex", { queuedContinuations: 0, openPermissions: 0, openQuestions: 0, ownedChildren: 0, runningChecks: 0, heldDeliveries: 0 })).toBe("working");
});

test("a quiet stop ends the run and a peer with no run reads as no state", () => {
  const tracker = new RunTracker();
  tracker.turnStarted({ peer: "pi", turn: "pi#a.1", at: 1, personOriginated: true, private: false });
  expect(tracker.quietStop("pi")).toBe(true);
  expect(tracker.quietStop("pi")).toBe(false);
  expect(tracker.state("pi", { queuedContinuations: 0, openPermissions: 0, openQuestions: 0, ownedChildren: 0, runningChecks: 0, heldDeliveries: 0 })).toBeUndefined();
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-completions-"));
  const db = join(dir, "hub.db"), s = new CompletionStore(db);
  cleanup.push(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, db };
}
const run = (turn: string, peer = "codex") => ({ peer, runTurn: turn, lastTurn: turn, startedAt: 10, promptEnvelope: "env-p", private: false });

test("settling writes one completion per run and removes the open row, however many times it is replayed", () => {
  const { s } = store();
  s.openRun({ ...run("codex#a.1"), evidence: {}, signalled: false });
  expect(s.openRuns()).toHaveLength(1);
  const first = s.settle({ ...run("codex#a.1"), replyEnvelope: "env-r" }, "done", 100, "c-1");
  expect(first).toMatchObject({ id: "c-1", peer: "codex", outcome: "done", runTurn: "codex#a.1", promptEnvelope: "env-p", replyEnvelope: "env-r", settledAt: 100 });
  expect(s.openRuns()).toEqual([]);
  expect(s.settle(run("codex#a.1"), "interrupted", 200, "c-2")).toBeUndefined();   // a replay, a second restart or a race creates nothing
  expect(s.list()).toHaveLength(1);
  expect(s.byRun("codex#a.1")!.id).toBe("c-1");
});

test("the store holds ids and outcomes only: no column can carry prompt or reply text", () => {
  const { s, db } = store();
  s.openRun({ ...run("codex#a.1"), evidence: {}, signalled: false });
  s.settle(run("codex#a.1"), "failed", 5, "c-1");
  s.close();
  const raw = new Database(db);
  const columns = (table: string) => (raw.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  expect(columns("completions")).toEqual(["id", "run_turn", "peer", "last_turn", "outcome", "settled_at", "started_at", "prompt_envelope", "reply_envelope", "private"]);
  expect(columns("completion_runs")).toEqual(["run_turn", "peer", "last_turn", "started_at", "prompt_envelope", "private"]);
  expect(columns("completion_receipts")).toEqual(["completion_id", "seen_at", "surface"]);
  expect(() => raw.query("INSERT INTO completions(id, run_turn, peer, last_turn, outcome, settled_at, started_at, private) VALUES('x','t','p','t','bogus',1,1,0)").run()).toThrow();
  raw.close();
});

test("one open run per peer, a touch moves its latest turn, and a quiet drop leaves nothing to restart", () => {
  const { s } = store();
  s.openRun({ ...run("codex#a.1"), evidence: {}, signalled: false });
  s.openRun({ ...run("codex#a.9"), evidence: {}, signalled: false });                   // the first run is still the run
  expect(s.openRuns().map(row => row.runTurn)).toEqual(["codex#a.1"]);
  s.touchRun({ ...run("codex#a.1"), lastTurn: "codex#a.4", private: true, evidence: {}, signalled: false });
  expect(s.openRuns()[0]).toMatchObject({ lastTurn: "codex#a.4", private: true });
  s.dropRun("codex#a.1");
  expect(s.openRuns()).toEqual([]);
  expect(s.list()).toEqual([]);
});

test("pending covers an open run and an unread completion, and nothing else", () => {
  const { s } = store();
  expect(s.hasPending()).toBe(false);
  s.openRun({ ...run("codex#a.1"), evidence: {}, signalled: false });
  expect(s.hasPending()).toBe(true);
  s.settle(run("codex#a.1"), "done", 5, "c-1");
  expect(s.hasPending()).toBe(true);                                                    // unread: no receipt yet
  expect(s.unread().map(c => c.id)).toEqual(["c-1"]);
});

test("reconstruction after any number of restarts yields one interrupted completion per run", () => {
  const { s, db } = store();
  s.openRun({ ...run("codex#a.1"), evidence: {}, signalled: false });
  s.openRun({ ...run("pi#a.2", "pi"), evidence: {}, signalled: false });
  // restart 1: every open row settles interrupted
  for (const open of s.openRuns()) s.settle(open, "interrupted", 50, `int-${open.runTurn}`);
  expect(s.list().map(c => [c.peer, c.outcome]).sort()).toEqual([["codex", "interrupted"], ["pi", "interrupted"]]);
  // restart 2 and 3: the rows are gone, and even a stale caller replaying the same runs creates nothing
  for (let restart = 0; restart < 2; restart++) {
    s.close();
    const again = new CompletionStore(db);
    cleanup.push(() => again.close());
    for (const open of again.openRuns()) again.settle(open, "interrupted", 60, `int2-${open.runTurn}`);
    expect(again.settle(run("codex#a.1"), "interrupted", 70, "late"), "a replayed run").toBeUndefined();
    expect(again.list()).toHaveLength(2);
  }
});

test("owner decision 2026-11-04: exactly the adapters with a code-verified settle signal declare one, and every other definition declares none", () => {
  const declared = Object.fromEntries(ADAPTERS.filter(definition => definition.settle).map(definition => [definition.kind, definition.settle!.signal]));
  expect(declared).toEqual({ claude: "native-stop", codex: "turn-completed", kimi: "prompt-response", pi: "agent-settled", local: "route-outcome", jcode: "prompt-response", qwen: "message-stop" });
  for (const signal of Object.values(declared)) expect(SETTLE_SIGNALS).toContain(signal);
  // agy declares a native-hook turn end that is not verified end to end: no completions until a live receipt says otherwise
  expect(definitionOf("agy")!.settle).toBeUndefined();
  // the review-only variants are never a person's run
  for (const definition of ADAPTERS.filter(candidate => candidate.routing?.reviewOnly === true)) expect(definition.settle, definition.kind).toBeUndefined();
});
