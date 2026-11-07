import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecords, fillsMerge, latestTaskRecords, readStore, researchFile, researchReport, RESEARCH_SCHEMA, RESEARCH_SCHEMA_V1, taskRecords, type TaskRecord } from "../src/hub/research.ts";
import { cancelCauseOf, NO_EVIDENCE, readEvidence } from "../src/hub/research-record.ts";
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
  expect(one.memory).toEqual({ briefs: 1, briefNotes: 3, fails: 1, rendered: null, delivered: null, cited: null });
  expect(one.handoffs).toEqual({ in: 1, out: 2 });
  expect(one.person).toEqual({ permissions: null, questions: null, completions: null, cliRefusals: null, latencyMs: null });
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
  const short = { ...evidence, journal: { ...evidence.journal!, oldestAt: minutes(5) } };
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
