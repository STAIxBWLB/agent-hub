import { expect, test } from "bun:test";
import type { Task } from "../src/hub/board.ts";
import type { Release } from "../src/hub/planning.ts";
import { releaseMetrics, releaseTrainData, releaseTrainReadiness, type HotfixCause, type ReleaseTrainData } from "../src/hub/sdlc-release.ts";

const release = (id: number, patch: Partial<Release> = {}): Release => ({
  id, name: `train-${id}`, goal: "Deliver planned work", order: id, state: "active",
  plannedStart: null, cut: null, ship: null, activatedAt: 10, frozenAt: null, shippedAt: null,
  created: 1, updated: 10, revision: 0, ...patch,
});
const task = (id: number, releaseId: number, patch: Partial<Task> = {}): Task => ({
  id, release: releaseId, title: "fixture", detail: "", class: "implement", owner: "codex", reviewer: "claude",
  state: "approved", refs: {}, signals: [], rejections: 0, history: [{ at: 100, by: "claude", event: "approved" }],
  created: 1, updated: 100, ...patch,
});
const train = (scope: number[], history: ReleaseTrainData["history"] = []): ReleaseTrainData => ({ scope, history });

test("release train validation permits only enumerated hotfix causes and clones bounded metadata", () => {
  const causes: HotfixCause[] = ["loss", "security_privacy", "upgrade_start_blocked", "core_flow_no_workaround"];
  for (const cause of causes) expect(releaseTrainData({ hotfix: { cause, reason: "Cannot wait" }, history: [] }).hotfix).toEqual({ cause, reason: "Cannot wait" });
  const input = { scope: [2, 1], history: [{ at: 20, by: "claude", event: "cut", scope: [2, 1], ciRuns: 0, reviews: 1 }] };
  const parsed = releaseTrainData(input);
  expect(parsed.scope).toEqual([1, 2]);
  expect(parsed.history[0]?.scope).toEqual([1, 2]);
  parsed.scope!.push(3); parsed.history[0]!.scope!.push(3);
  expect(input.scope).toEqual([2, 1]); expect(input.history[0]!.scope).toEqual([2, 1]);
  for (const cause of ["urgent", "loss ", "", null, 1]) expect(() => releaseTrainData({ hotfix: { cause, reason: "Cannot wait" }, history: [] })).toThrow();
  for (const reason of ["", " ", "x".repeat(1001), "가".repeat(334)]) expect(() => releaseTrainData({ hotfix: { cause: "loss", reason }, history: [] })).toThrow();
});

test("release train validation refuses unknown fields, invalid identities, bounds, counters and history order", () => {
  const valid = { history: [{ at: 20, by: "claude", event: "cut" }] };
  for (const input of [null, [], { ...valid, unexpected: true }, { ...valid, scope: [1, 1] }, { ...valid, scope: [0] },
    { ...valid, scope: Array.from({ length: 1001 }, (_, i) => i + 1) },
    { history: Array.from({ length: 257 }, () => valid.history[0]) },
    ...[{ at: 0 }, { at: 8_640_000_000_000_001 }, { by: "bad peer" }, { event: "published" }, { ciRuns: -1 }, { reviews: 1.5 }, { reviews: 1_000_001 }, { arbitrary: "text" }].map(patch => ({ history: [{ ...valid.history[0], ...patch }] })),
    { history: [{ at: 20, by: "claude", event: "cut" }, { at: 19, by: "user", event: "shipped" }] }]) {
    expect(() => releaseTrainData(input)).toThrow();
  }
});

test("a planned date triggers cut consideration but never clears unfinished or cancelled scope", () => {
  const rows = [task(1, 1), task(2, 1, { state: "in_review" }), task(3, 1, { state: "cancelled" })];
  const result = releaseTrainReadiness(release(1, { cut: 200 }), rows, 201);
  expect(result.trigger).toBe("planned_date");
  expect(result.tasks).toEqual([{ id: 1, state: "approved", ready: true }, { id: 2, state: "in_review", ready: false }, { id: 3, state: "cancelled", ready: false }]);
  expect(result.blockers).toContain("task #2: not approved"); expect(result.blockers).toContain("task #3: not approved");
  expect(releaseTrainReadiness(release(1), [task(1, 1)], 201)).toMatchObject({ trigger: "tasks_approved", blockers: [] });
  expect(releaseTrainReadiness(release(1), [], 201).blockers).toContain("release scope empty");
});

test("frozen readiness detects removed, newly assigned and missing scope without naming task text", () => {
  const frozen = release(1, { state: "frozen", frozenAt: 200, train: train([1, 2]) });
  const result = releaseTrainReadiness(frozen, [task(1, 1), task(2, 2), task(3, 1)], 201);
  expect(result.blockers).toContain("frozen release scope changed");
  expect(result.blockers).toContain("task #2: release assignment changed");
  expect(releaseTrainReadiness(frozen, [task(1, 1)], 201).blockers).toContain("task #2: scope evidence unknown");
  expect(releaseTrainReadiness(release(1, { state: "frozen" }), [task(1, 1)], 201).blockers).toContain("release scope unknown");
  expect(JSON.stringify(result)).not.toContain("fixture");
});

test("release metrics use recorded ship timestamps, approved history and explicit per-event resource counts", () => {
  const first = release(1, { state: "shipped", shippedAt: 300, train: train([1], [
    { at: 200, by: "claude", event: "cut", scope: [1], ciRuns: 2, reviews: 1 },
    { at: 300, by: "user", event: "shipped", ciRuns: 0, reviews: 1 },
  ]) });
  const second = release(2, { state: "shipped", shippedAt: 900, train: { ...train([2], [
    { at: 700, by: "claude", event: "cut", scope: [2], ciRuns: 1, reviews: 1 },
    { at: 900, by: "user", event: "shipped", ciRuns: 0, reviews: 0 },
  ]), hotfix: { cause: "loss", reason: "Message loss cannot wait" } } });
  const result = releaseMetrics([second, first], [task(1, 1), task(2, 2, { history: [{ at: 500, by: "claude", event: "approved" }] })]);
  expect(result.intervals).toEqual([{ from: 1, to: 2, ms: 600 }]);
  expect(result.approvalToReleaseMs).toEqual([{ release: 2, task: 2, ms: 400 }, { release: 1, task: 1, ms: 200 }]);
  expect(result).toMatchObject({ hotfixCount: 1, hotfixRate: 0.5, ciRuns: 3, reviews: 3, unknown: [] });
});

test("legacy or incomplete release history remains unknown rather than a fabricated zero or interval", () => {
  const legacy = release(1, { state: "shipped", shippedAt: 300 });
  expect(releaseMetrics([legacy], [task(1, 1)])).toEqual({ intervals: [], approvalToReleaseMs: [], hotfixCount: null, hotfixRate: null, ciRuns: null, reviews: null, unknown: [1] });
  const incomplete = release(2, { state: "shipped", shippedAt: 900, train: train([2], [{ at: 900, by: "user", event: "shipped" }]) });
  expect(releaseMetrics([legacy, incomplete], []).approvalToReleaseMs).toEqual([{ release: 2, task: 2, ms: null }]);
  expect(releaseMetrics([legacy, incomplete], []).intervals).toEqual([]);
  expect(releaseMetrics([legacy, incomplete], []).unknown).toEqual([1, 2]);
});


test("release lead time starts at the final approval after rework, not an earlier approval", () => {
  const shipped = release(1, { state: "shipped", shippedAt: 900, train: train([1], [{ at: 800, by: "claude", event: "cut", scope: [1], ciRuns: 1, reviews: 2 }, { at: 900, by: "user", event: "shipped" }]) });
  const reworked = task(1, 1, { history: [{ at: 100, by: "claude", event: "approved" }, { at: 200, by: "claude", event: "changes_requested" }, { at: 500, by: "claude", event: "approved" }] });
  expect(releaseMetrics([shipped], [reworked]).approvalToReleaseMs).toEqual([{ release: 1, task: 1, ms: 400 }]);
});
