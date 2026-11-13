import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecords, fillsMerge, labelTarget, latestTaskRecords, readStore, researchFile, researchReport, RESEARCH_SCHEMA, RESEARCH_SCHEMA_V1, taskRecords, type TaskRecord } from "../src/hub/research.ts";
import { cancelCauseOf, journalFigures, NO_EVIDENCE, readEvidence } from "../src/hub/research-record.ts";
import { boardWith, cleanDirs, familyOf, iso, minutes, PROJECT, scenarioBoard, scenarioDeliveries, scenarioEvents, taskEvent, tempDir } from "./helpers/research-fixture.ts";

// #1277 AC1, AC2, AC6: record v2 over a real hub.db, with every expected figure computed by hand from the fixture below.

const dirs: string[] = [];
afterEach(() => cleanDirs(dirs));
const writer = { version: "test", source: "backfill" as const };
function fixture() {
  const stateDir = tempDir(dirs, "state");
  boardWith(stateDir, scenarioBoard(), scenarioDeliveries());
  const db = new Database(join(stateDir, "hub.db"));
  db.run("INSERT INTO task_handoff_origin (task_id, project_id, peer, origin_task, at) VALUES (1, 'x', 'claude', 7, 0)");
  for (const n of [1, 2]) db.run("INSERT INTO task_handoff_outbound (remote_project, remote_task, origin_peer, local_task, title, last_state, updated_at) VALUES (?, ?, 'codex', 1, 't', 'open', 0)", [`r${n}`, n]);
  db.close();
  return { stateDir, evidence: { ...readEvidence(stateDir, PROJECT), familyOf } };
}
const byTask = (records: TaskRecord[], id: number) => records.find(r => r.task === id)!;

test("AC2: a v2 record's review, delivery, merge, specs, memory, stall, handoff and cohort blocks match the hand-computed values", () => {
  const { evidence } = fixture();
  const one = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 1);
  expect(one).toMatchObject({ schema: RESEARCH_SCHEMA, outcome: "approved", approvedAt: iso(minutes(20)), closedAt: iso(minutes(20)), wallMs: 17 * 60_000, reviewRounds: 2, changesRequested: 1, firstPass: false, declines: 1, escalations: 1, cohort: "silent", stalls: 2 });
  expect(one.review).toMatchObject({
    rounds: 2, firstPass: false, reviewerFamily: "claude", ownerFamily: "codex", scope: "code", evidenceOnly: 0, context: "fresh",
    findings: {
      bugs: { important: 1, nit: 0, open: 0, fixed: 1, falsePositive: 0, accepted: 0 },
      security: { important: 0, nit: 1, open: 1, fixed: 0, falsePositive: 0, accepted: 0 },
      compliance: { important: 0, nit: 1, open: 0, fixed: 0, falsePositive: 1, accepted: 0 },
    },
  });
  // Journal rows of the task: two completed (1 and 3 minutes), one needs_review, one failed. p50 and p95 of [60 s, 180 s] by nearest rank are 60 s and 180 s.
  expect(one.delivery).toEqual({ count: 3, firstDeliveryMs: { p50: 60_000, p95: 180_000 }, needsReview: 1, failed: 1, discarded: 0, dropped: { fyi: 1, hop: 0 } });
  // Last done 12, approved 20, merged 60.
  expect(one.merge).toEqual({ ciRuns: 3, ciReruns: 1, githubReviews: 2, doneToApprovedMs: 8 * 60_000, approvedToMergedMs: 40 * 60_000 });
  expect(one.specs).toEqual({ covering: 3, unchanged: 2, acked: 1, errors: 0 });
  expect(one.memory).toEqual({ briefs: 1, briefNotes: 3, fails: 1, rendered: null, delivered: null, cited: null, failsExposed: null, failsCited: null, failRetrySignal: null });
  expect(one.handoffs).toEqual({ in: 1, out: 2 });
  // The fixture's log has no attributed person event: nothing is known about any task, so the whole block is unknown, never 0.
  expect(one.person).toEqual({ permissions: null, questions: null, completions: null, cliRefusals: null, consoleConfirmations: null, latencyMs: null });
});

test("#778 nit: a task with no brief is a known 0 when briefs were being reported, and unknown when the log shows none at all", () => {
  const { evidence } = fixture();
  const two = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 2);
  expect(two.memory).toMatchObject({ briefs: 0, briefNotes: 0, fails: 0 });
  const silent = scenarioEvents().filter(e => e.type !== "memory_brief");
  expect(byTask(taskRecords(silent, PROJECT, writer, evidence), 1).memory).toMatchObject({ briefs: null, briefNotes: null, fails: null });
});

test("#778 nit: the live writer's scoped evidence read gives the same record as a full read, from one task's rows", () => {
  const { stateDir, evidence } = fixture();
  const scoped = { ...readEvidence(stateDir, PROJECT, 1), familyOf };
  expect([...scoped.tasks.keys()]).toEqual([1]);
  expect(scoped.journal!.rows.every(r => r.task === 1)).toBe(true);
  const full = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 1), narrow = byTask(taskRecords(scenarioEvents(), PROJECT, writer, scoped), 1);
  expect(narrow).toEqual(full);
});

test("AC1: with no board or journal every board-derived field is null and counted, never zero", () => {
  const one = byTask(taskRecords(scenarioEvents(), PROJECT, writer, NO_EVIDENCE), 1);
  expect(one.review).toMatchObject({ rounds: null, firstPass: null, findings: null, reviewerFamily: null, evidenceOnly: null, scope: "unknown", context: "unknown", staleHeadReReviews: null });
  expect(one.delivery).toEqual({ count: 3, firstDeliveryMs: { p50: null, p95: null }, needsReview: null, failed: null, discarded: null, dropped: { fyi: 1, hop: 0 } });
  expect(one.merge).toEqual({ ciRuns: null, ciReruns: null, githubReviews: null, doneToApprovedMs: 8 * 60_000, approvedToMergedMs: null });
  expect(one.specs).toEqual({ covering: null, unchanged: null, acked: null, errors: null });
  expect(one.stalls).toBeNull();
  expect(one.handoffs).toEqual({ in: null, out: null });
});

test("AC1: a journal that does not reach back to the task's proposal leaves the delivery figures null", () => {
  const { evidence } = fixture();
  const short = { ...evidence, journal: { ...evidence.journal!, coveredAfter: minutes(5) } };
  expect(byTask(taskRecords(scenarioEvents(), PROJECT, writer, short), 1).delivery).toMatchObject({ count: 3, firstDeliveryMs: { p50: null, p95: null }, needsReview: null, failed: null, discarded: null });
});

test("AC6: every task in a terminal board state has a record, and the cancel cause comes only from an explicit closed field", () => {
  const { evidence } = fixture();
  const records = taskRecords(scenarioEvents(), PROJECT, writer, evidence);
  expect(records.map(r => [r.task, r.outcome])).toEqual([[1, "approved"], [2, "cancelled"], [3, "cancelled"], [4, "cancelled"]]);
  const two = byTask(records, 2);
  expect(two).toMatchObject({ approvedAt: null, closedAt: iso(minutes(40)), cancelCause: "stale", firstPass: false, wallMs: 9 * 60_000 });
  expect(two.merge).toMatchObject({ approvedToMergedMs: null, doneToApprovedMs: null });
  // A decline and an escalation earlier in the history never become the cause; a value outside the vocabulary is unknown.
  expect(byTask(records, 3)).toMatchObject({ cancelCause: "unknown", declines: 1, escalations: 1, review: { ownerFamily: "codex" } });
  expect(byTask(records, 4).cancelCause).toBe("unknown");
  expect(byTask(records, 1)).not.toHaveProperty("cancelCause");
  expect(cancelCauseOf({ cause: "declined" })).toBe("declined");
  expect(cancelCauseOf({ cause: "unknown" })).toBeUndefined();
  expect(cancelCauseOf({ note: "cancelled: stale" })).toBeUndefined();
  // Without the board the cause is unknown too, never inferred.
  expect(byTask(taskRecords(scenarioEvents(), PROJECT, writer, NO_EVIDENCE), 2).cancelCause).toBe("unknown");
});

test("AC6: a task that was approved and later reopened keeps its approved record, and a task still open has none", () => {
  const open = [taskEvent(0, 9, "proposed", "proposed"), taskEvent(1, 9, "accepted", "in_progress", { owner: "codex" })];
  expect(taskRecords(open, PROJECT, writer)).toEqual([]);
  const reopened = [...open, taskEvent(2, 9, "approved", "approved"), taskEvent(3, 9, "reopened", "in_progress"), taskEvent(4, 9, "cancelled", "cancelled")];
  expect(taskRecords(reopened, PROJECT, writer).map(r => [r.task, r.outcome])).toEqual([[9, "approved"]]);
});

test("v1 compat: a held v1 row loads as approved, is replaced by the v2 row of its task, and statistics count the task once", () => {
  const home = tempDir(dirs, "home");
  const { evidence } = fixture();
  const v2 = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 1);
  const { outcome: _o, closedAt: _c, cancelCause: _cc, review: _r, delivery: _d, merge: _m, specs: _s, memory: _me, person: _p, stalls: _st, handoffs: _h, cohort: _co, declines: _de, escalations: _es, ...v1rest } = v2 as TaskRecord & { cancelCause?: string };
  const v1 = { ...v1rest, schema: RESEARCH_SCHEMA_V1 } as unknown as TaskRecord;
  expect(appendRecords(PROJECT, [v1], home)).toBe(1);
  expect(readStore(researchFile(PROJECT, home))[0]).toMatchObject({ schema: RESEARCH_SCHEMA_V1, outcome: "approved", task: 1 });
  expect(appendRecords(PROJECT, [v2], home)).toBe(1);
  expect(appendRecords(PROJECT, [v2], home)).toBe(0);
  const all = readStore(researchFile(PROJECT, home));
  expect(all).toHaveLength(2);
  expect(latestTaskRecords(all)).toHaveLength(1);
  expect((latestTaskRecords(all)[0] as TaskRecord).schema).toBe(RESEARCH_SCHEMA);
  expect(researchReport(all, 0).overall.tasks).toBe(1);
  // The v1 line on disk is untouched.
  expect(JSON.parse(readFileSync(researchFile(PROJECT, home), "utf8").split("\n")[0]!).outcome).toBeUndefined();
});

test("a cancelled record is stored but counted in no approved-task statistic", () => {
  const home = tempDir(dirs, "home");
  const { evidence } = fixture();
  const records = taskRecords(scenarioEvents(), PROJECT, writer, evidence);
  expect(appendRecords(PROJECT, records, home)).toBe(4);
  expect(researchReport(readStore(researchFile(PROJECT, home)), 0).overall.tasks).toBe(1);
});

test("a later pass fills the merge block of a held record, once", () => {
  const home = tempDir(dirs, "home");
  const { evidence } = fixture();
  const bare = byTask(taskRecords(scenarioEvents(), PROJECT, writer, { ...evidence, tasks: new Map([...evidence.tasks].map(([id, t]) => [id, { ...t, merge: undefined }])) }), 1);
  const full = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 1);
  expect(bare.merge).toMatchObject({ ciRuns: null, approvedToMergedMs: null });
  expect(fillsMerge(bare, full)).toBe(true);
  expect(fillsMerge(full, bare)).toBe(false);
  expect(fillsMerge(full, full)).toBe(false);
  expect(appendRecords(PROJECT, [bare], home)).toBe(1);
  expect(appendRecords(PROJECT, [full], home)).toBe(1);
  expect(appendRecords(PROJECT, [full], home)).toBe(0);
  expect((latestTaskRecords(readStore(researchFile(PROJECT, home)))[0] as TaskRecord).merge?.ciRuns).toBe(3);
});

test("readEvidence opens the board read-only and an unreadable store leaves its part unknown", () => {
  const { stateDir } = fixture();
  const before = readFileSync(join(stateDir, "hub.db"));
  readEvidence(stateDir, PROJECT);
  expect(readFileSync(join(stateDir, "hub.db")).equals(before)).toBe(true);
  const empty = tempDir(dirs, "empty");
  expect(readEvidence(empty, PROJECT)).toBe(NO_EVIDENCE);
  const broken = tempDir(dirs, "broken");
  writeFileSync(join(broken, "hub.db"), "not a database");
  expect(readEvidence(broken, PROJECT).board).toBe(false);
});

// #1290 review: the journal prunes terminal rows oldest-updated first beyond a cap and keeps protected ones, so the oldest surviving row is not a completeness watermark.
test("journal coverage is bounded by the oldest unprotected terminal row, never by an old protected row that survived pruning", async () => {
  const { DeliveryJournal } = await import("../src/hub/delivery-journal.ts");
  const { HUB, newEnvelope } = await import("../src/hub/envelope.ts");
  const dir = tempDir(dirs, "journal"), stateDir = dir;
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: PROJECT, instanceId: "i", terminalHistoryLimit: () => 1 });
  const make = (id: string, task: string, at: number, extra: Record<string, unknown> = {}) => {
    const env = newEnvelope(HUB, `body ${id}`, { to: ["codex"], ...("reviewPackage" in extra ? { kind: "review" as const } : {}), refs: { task, ...extra } });
    const row = journal.createDelivery({ id, peer: "codex", state: "queued", createdAt: at, originals: [env], out: [env] });
    journal.transition(id, "dispatching", undefined, row.revision);
    const sent = journal.get(id)!; journal.transition(id, "accepted", undefined, sent.revision);
    const done = journal.get(id)!; journal.transition(id, "completed", undefined, done.revision);
  };
  // An old review-package receipt is protected and survives. Three newer deliveries of task 1 follow; with a cap of one, the two oldest unprotected ones are pruned.
  make("old-protected", "1", minutes(1), { reviewPackage: "review-abc" });
  make("a", "1", minutes(10)); make("b", "1", minutes(20)); make("c", "1", minutes(30));
  journal.close();
  const ids = () => { const db = new Database(join(dir, "hub.db"), { readonly: true }); try { return (db.query("SELECT id FROM deliveries ORDER BY created_at").all() as { id: string }[]).map(r => r.id); } finally { db.close(); } };
  expect(ids()).toContain("old-protected");
  expect(ids()).not.toContain("a"); // pruned: the premise of the review thread holds on the real journal
  const evidence = readEvidence(stateDir, PROJECT);
  // The old watermark (the oldest surviving row, minute 1) would have called a task proposed at minute 5 covered. It is not: deliveries of minute 10 and 20 are gone.
  // The bound is exactly the oldest unprotected terminal row that survived (`c`), not the old protected row.
  const survivors = evidence.journal!.rows;
  expect(survivors).toHaveLength(2);
  expect(evidence.journal!.coveredAfter).toBe(Math.min(...survivors.filter(r => r.createdAt === minutes(30)).map(r => r.updatedAt)));
  const record = (createdMin: number, closedMin: number) => journalFigures(evidence, 1, minutes(createdMin), minutes(closedMin));
  expect(record(5, 40)).toEqual({ firstDeliveryMs: { p50: null, p95: null }, needsReview: null, failed: null, discarded: null });
  // A task created after every surviving unprotected row is covered.
  // A task proposed after the journal's last write (real time: `updated_at` is the journal's own clock) is covered, and no failure in its window is a known 0.
  const later = journalFigures(evidence, 1, Date.now() + 60_000, Date.now() + 120_000);
  expect(later).toMatchObject({ needsReview: 0, failed: 0, discarded: 0 });
});

test("journal coverage is unknown when the journal's own review-input coverage is incomplete, and not claimed for a missing table", () => {
  const { stateDir } = fixture();
  const db = new Database(join(stateDir, "hub.db"));
  db.run("CREATE TABLE IF NOT EXISTS delivery_meta (project_id TEXT PRIMARY KEY, review_input_coverage_complete INTEGER NOT NULL DEFAULT 0)");
  db.run("INSERT OR REPLACE INTO delivery_meta (project_id, review_input_coverage_complete) VALUES (?, 0)", [PROJECT]);
  db.close();
  expect(readEvidence(stateDir, PROJECT).journal!.coveredAfter).toBeNull();
});

test("#1290 review: a label resolves against the latest revision of a task, so a v1 row and its v2 row are one candidate after a reset", () => {
  const { evidence } = fixture();
  const v2 = byTask(taskRecords(scenarioEvents(), PROJECT, writer, evidence), 1);
  const { review: _r, delivery: _d, merge: _m, specs: _s, memory: _me, person: _p, stalls: _st, handoffs: _h, cohort: _co, declines: _de, escalations: _es, outcome: _o, closedAt: _c, ...rest } = v2 as TaskRecord & Record<string, unknown>;
  const v1 = { ...rest, schema: RESEARCH_SCHEMA_V1, outcome: "approved" } as unknown as TaskRecord;
  const bare = { ...v2, merge: { ...v2.merge!, ciRuns: null, ciReruns: null, githubReviews: null, approvedToMergedMs: null } };
  // After `ahub reset --all` the proposal event is gone from the log: the store alone resolves the task.
  expect(labelTarget([v1, v2], [], 1)).toBe(v2);
  expect(labelTarget([bare, v2], [], 1)).toBe(v2);
  expect(labelTarget([v1, v2], [], 1, v2.createdAt!)).toBe(v2);
});
