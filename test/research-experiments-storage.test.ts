import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Board, type ResearchCampaignRecord } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";
import { canonicalJson } from "../src/hub/packs.ts";
import { campaignHash, type ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import { protocolHash, type ExperimentAttemptInput, type ExperimentAttemptRecord, type ExperimentProtocolContract, type ExperimentProtocolRecord, type ExperimentWriteFence } from "../src/hub/research-experiments.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef", RUN = "01234567-0123-0123-0123-0123456789ab";
const hash = (input: unknown) => createHash("sha256").update(canonicalJson(input)).digest("hex");
function protocol(campaignId: string): ExperimentProtocolContract {
  return { campaignId, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: SOURCE, sha256: "a".repeat(64) }], code: { commit: "b".repeat(40) },
    environment: { descriptor: "Bun 1.4.2 on Linux" }, method: "Measure the synthetic fixture", parameters: {}, seeds: [42], evaluator: { id: "count", version: "1" },
    metrics: [{ name: "count", unit: "items", direction: "higher" }], role: "baseline", splits: [], resourceLimits: [], sealed: false };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-experiments-storage-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); let board = new Board(file); clean.push(() => board.close());
  const parent = board.propose(USER, { title: "Synthetic parent", class: "implement" });
  const contract: ResearchCampaignContract = { question: "Synthetic fixture", scope: "No command execution", exclusions: [], sourceIds: [SOURCE],
    units: ["baseline", "variant"].map(id => ({ id, round: 0, question: id, perspective: "measurement", requiredOutput: "A receipt", sourceIds: [SOURCE], dependsOn: [], purpose: "discovery" as const })),
    deliverableSections: [], stopPolicy: { maxUnits: 2, maxFollowUpRounds: 0, deadline: new Date(NOW + 86400000).toISOString() } };
  const campaign: ResearchCampaignRecord = { id: "rc-0123456789ab", project: "fixture-project", parentTaskId: parent.id, revision: 1, status: "draft", contract,
    hash: campaignHash(contract), private: false, createdBy: USER, createdAt: NOW };
  board.saveResearchCampaignDraft(campaign, undefined, parent.history.length);
  const activated = board.activateCampaign(campaign.id, 1, campaign.project, USER, NOW, contract.units.map(unit => ({ unitId: unit.id,
    create: { title: unit.question, class: "implement" as const, signals: [] } })), board.get(parent.id)!.history.length, false, {});
  for (const binding of activated.bindings) {
    const child = board.update(binding.taskId, USER, "backlog pulled", { state: "proposed", owner: "local" });
    board.update(child.id, "local", "accepted", { state: "in_progress" });
  }
  const taskId = activated.bindings.find(unit => unit.unitId === "baseline")!.taskId, variantId = activated.bindings.find(unit => unit.unitId === "variant")!.taskId;
  const fence = (id = taskId): ExperimentWriteFence => ({ project: campaign.project, taskId: id, taskFlowRevision: board.get(id)!.history.length, owner: "local",
    campaignId: campaign.id, campaignRevision: 1, campaignHash: campaign.hash });
  const record = (body = protocol(campaign.id), id = taskId): ExperimentProtocolRecord => ({ hash: protocolHash(body), project: campaign.project, recordedForTaskId: id, protocol: body, by: "local", at: NOW, private: false });
  const save = (body = protocol(campaign.id), id = taskId) => board.saveExperimentProtocol(record(body, id), fence(id));
  const attempt = (key: string, suffix: string, protocolHash: string, id = taskId): ExperimentAttemptRecord => {
    const body: ExperimentAttemptInput = { protocolHash, taskId: id, phase: "development", idempotencyKey: key };
    return { attemptId: `ra-${suffix.padStart(12, "0")}`, project: campaign.project, attempt: body, bodyHash: hash(body), by: "local", at: NOW, private: false };
  };
  return { file, campaign, parent, taskId, variantId, fence, record, save, attempt, get board() { return board; }, restart() { board.close(); board = new Board(file); } };
}

test("protocols and attempts persist without execution; duplicate keys preserve identity and restart readback", () => {
  const f = fixture(), before = f.board.list(), stored = f.save();
  expect(f.board.experimentProtocol(stored.hash)).toEqual(stored);
  expect(f.board.saveExperimentProtocol({ ...stored, at: NOW + 50 }, f.fence()).at).toBe(NOW);
  const first = f.board.createExperimentAttempt(f.attempt("first", "1", stored.hash), f.fence());
  const replay = f.board.createExperimentAttempt(f.attempt("first", "2", stored.hash), f.fence());
  expect(replay.attemptId).toBe(first.attemptId);
  expect(() => f.board.createExperimentAttempt({ ...f.attempt("first", "2", stored.hash), attempt: { ...first.attempt, phase: "final" }, bodyHash: hash({ ...first.attempt, phase: "final" }) }, f.fence())).toThrow("idempotency");
  expect(f.board.list()).toEqual(before);
  const integrity = f.board.researchExperimentsIntegrity(); f.restart();
  expect(f.board.researchExperimentsIntegrity()).toEqual(integrity);
  expect(f.board.experimentAttempt(first.attemptId)).toEqual(first);
  expect(f.board.experimentAttempts(f.campaign.project, f.campaign.id)).toMatchObject({ rows: [first], done: true });
  expect(f.board.hasResearchExperimentState()).toBe(true); expect(f.board.hasResearchState()).toBe(true);
});

test("protocol storage enforces campaign source association, exact task binding, owner and current revision fences before effects", () => {
  const f = fixture(), original = f.record(), before = f.board.researchExperimentsIntegrity();
  const foreign = { ...original.protocol, inputs: [{ sourceId: "src:fedcba9876543210", sha256: "c".repeat(64) }] };
  expect(() => f.save(foreign)).toThrow();
  expect(() => f.board.saveExperimentProtocol(original, { ...f.fence(), owner: "codex" })).toThrow();
  expect(() => f.board.saveExperimentProtocol(original, { ...f.fence(), taskFlowRevision: 0 })).toThrow();
  expect(() => f.board.saveExperimentProtocol(original, { ...f.fence(), campaignRevision: 2 })).toThrow();
  expect(() => f.board.saveExperimentProtocol(original, { ...f.fence(), project: "foreign-project" })).toThrow();
  expect(f.board.researchExperimentsIntegrity()).toEqual(before);
  const baseline = f.save(), variant = { ...protocol(f.campaign.id), role: "variant" as const, variantOf: baseline.hash };
  expect(f.save(variant, f.variantId).protocol.variantOf).toBe(baseline.hash);
  const shared = f.attempt("another-unit", "1", baseline.hash, f.variantId);
  expect(f.board.createExperimentAttempt(shared, f.fence(f.variantId))).toMatchObject({ attempt: { taskId: f.variantId, protocolHash: baseline.hash } });
  const foreignAttempt = f.attempt("foreign-project", "2", baseline.hash, f.variantId);
  expect(() => f.board.createExperimentAttempt(foreignAttempt, { ...f.fence(f.variantId), project: "foreign-project" })).toThrow();
  expect(() => f.save(original.protocol, f.variantId)).toThrow();
  const revised = f.save({ ...protocol(f.campaign.id), supersedes: baseline.hash, method: "A revised declared method" });
  expect(revised.protocol.supersedes).toBe(baseline.hash);
  expect(() => f.save({ ...protocol(f.campaign.id), supersedes: baseline.hash, lineage: "foreign-lineage" })).toThrow();
});

test("events are append-only, seq-CAS fenced and idempotent across restart with one terminal event", () => {
  const f = fixture(), stored = f.save(), attempt = f.board.createExperimentAttempt(f.attempt("first", "1", stored.hash), f.fence());
  const first = f.board.appendExperimentEvent(attempt.attemptId, "start-key", { kind: "start", body: {} }, [], "local", NOW, false, 0, f.fence());
  expect(first.event).toMatchObject({ seq: 1, provenance: "declared" });
  const before = f.board.researchExperimentsIntegrity();
  expect(() => f.board.appendExperimentEvent(attempt.attemptId, "metric-key", { kind: "metric", body: { name: "count", value: 1 } }, [], "local", NOW, false, 0, f.fence())).toThrow("sequence changed");
  expect(() => f.board.appendExperimentEvent(attempt.attemptId, "start-key", { kind: "note", body: { text: "Changed" } }, [], "local", NOW, false, 1, f.fence())).toThrow("idempotency");
  expect(f.board.researchExperimentsIntegrity()).toEqual(before);
  const end = f.board.appendExperimentEvent(attempt.attemptId, "end-key", { kind: "end", body: { status: "failed" } }, [], "local", NOW + 1, false, 1, f.fence());
  expect(() => f.board.appendExperimentEvent(attempt.attemptId, "second-end", { kind: "end", body: { status: "succeeded" } }, [], "local", NOW + 2, false, 2, f.fence())).toThrow("one end");
  f.restart();
  expect(f.board.appendExperimentEvent(attempt.attemptId, "end-key", { kind: "end", body: { status: "failed" } }, [], "local", NOW + 10, false, 0, f.fence())).toEqual(end);
  expect(f.board.experimentLastSeq(attempt.attemptId)).toBe(2);
  const page = f.board.experimentEvents(attempt.attemptId, 0, 1); expect(page).toMatchObject({ afterSeq: 1, done: false });
  expect(f.board.experimentEvents(attempt.attemptId, page.afterSeq, 1)).toMatchObject({ rows: [end], afterSeq: 2, done: true });
  expect(() => f.board.experimentEvents(attempt.attemptId, 0, 51)).toThrow();
});

test("host observations remain separate immutable evidence, cannot rewrite declared values or create a second end", () => {
  const f = fixture(), stored = f.save(), attempt = f.board.createExperimentAttempt(f.attempt("first", "1", stored.hash), f.fence());
  const observation = { source: "check" as const, evidence: RUN, values: { exitStatus: 7, timedOut: false, cancelled: false, durationMs: 10, queueTime: 4 } };
  const end = f.board.appendExperimentEvent(attempt.attemptId, "end-key", { kind: "end", body: { status: "succeeded", exitStatus: 0, run: RUN } }, [observation], "local", NOW, false, 0, f.fence());
  expect(end.event).toMatchObject({ provenance: "declared", body: { status: "succeeded", exitStatus: 0 } });
  expect(end.observations).toEqual([{ eventSeq: 1, observation }]);
  const replay = f.board.appendExperimentEvent(attempt.attemptId, "end-key", { kind: "end", body: { status: "succeeded", exitStatus: 0, run: RUN } }, [{ ...observation, values: { ...observation.values, exitStatus: 0 } }], "local", NOW + 1, false, 1, f.fence());
  expect(replay).toEqual(end);
  const other = f.board.createExperimentAttempt(f.attempt("other", "2", stored.hash), f.fence());
  expect(() => f.board.appendExperimentEvent(other.attemptId, "bad-link", { kind: "note", body: { text: "No run" } }, [observation], "local", NOW, false, 0, f.fence())).toThrow();
  expect(f.board.experimentLastSeq(other.attemptId)).toBe(0);
  expect(() => f.board.appendExperimentEvent(other.attemptId, "end-key", { kind: "end", body: { status: "succeeded", run: RUN } }, [], "local", NOW, false, 0, f.fence())).toThrow("idempotency");
});

test("all-attempt denominator includes failed, cancelled, missing-end unknown and declared attempts", () => {
  const f = fixture(), stored = f.save();
  const attempts = ["1", "2", "3", "4"].map(suffix => f.board.createExperimentAttempt(f.attempt(`attempt-${suffix}`, suffix, stored.hash), f.fence()));
  f.board.appendExperimentEvent(attempts[0]!.attemptId, "failed", { kind: "end", body: { status: "failed" } }, [], "local", NOW, false, 0, f.fence());
  f.board.appendExperimentEvent(attempts[1]!.attemptId, "cancelled", { kind: "end", body: { status: "cancelled" } }, [], "local", NOW, false, 0, f.fence());
  expect(f.board.experimentSummary(f.campaign.project, f.campaign.id)).toEqual({ total: 4, statuses: { declared: 2, running: 0, succeeded: 0, failed: 1, cancelled: 1, unknown: 0 } });
  f.board.update(f.taskId, USER, "approved", { state: "approved" });
  expect(f.board.experimentSummary(f.campaign.project, f.campaign.id)).toEqual({ total: 4, statuses: { declared: 0, running: 0, succeeded: 0, failed: 1, cancelled: 1, unknown: 2 } });
});

test("stored hashes are revalidated on read and integrity, privacy upgrades never rewrite attempt bodies", () => {
  const f = fixture(), stored = f.save(), original = f.attempt("first", "1", stored.hash);
  const attempt = f.board.createExperimentAttempt(original, f.fence());
  expect(f.board.createExperimentAttempt({ ...f.attempt("first", "2", stored.hash), private: true }, f.fence())).toMatchObject({ attemptId: attempt.attemptId, private: true, at: NOW });
  const db = new Database(f.file); db.query("UPDATE research_attempts SET body=? WHERE attempt_id=?").run(JSON.stringify({ ...original.attempt, phase: "final" }), attempt.attemptId); db.close();
  expect(() => f.board.experimentAttempt(attempt.attemptId)).toThrow();
  expect(() => f.board.researchExperimentsIntegrity()).toThrow();
});


test("a task dropped from the current campaign cannot create an experiment attempt", () => {
  const f = fixture(), stored = f.save();
  const contract = { ...f.campaign.contract, units: f.campaign.contract.units.filter(unit => unit.id === "variant") };
  const next = { ...f.campaign, revision: 2, contract, hash: campaignHash(contract), createdAt: NOW + 1 };
  f.board.saveResearchCampaignDraft(next, 1, f.board.get(f.parent.id)!.history.length);
  f.board.activateCampaign(next.id, 2, next.project, USER, NOW + 2, [{ unitId: "variant", reuse: { taskId: f.variantId, flowRevision: f.board.get(f.variantId)!.history.length } }], f.board.get(f.parent.id)!.history.length, false, {});
  const before = f.board.researchExperimentsIntegrity();
  expect(() => f.board.createExperimentAttempt(f.attempt("dropped-unit", "1", stored.hash), f.fence())).toThrow();
  expect(f.board.researchExperimentsIntegrity()).toEqual(before);
});


test("private event evidence upgrades its attempt and remains private on pages that omit that event", () => {
  const f = fixture(), stored = f.save(), attempt = f.board.createExperimentAttempt(f.attempt("first", "1", stored.hash), f.fence());
  f.board.appendExperimentEvent(attempt.attemptId, "private-note", { kind: "note", body: { text: "Private fixture evidence" } }, [], "local", NOW, true, 0, f.fence());
  f.board.appendExperimentEvent(attempt.attemptId, "later-note", { kind: "note", body: { text: "Later fixture event" } }, [], "local", NOW + 1, false, 1, f.fence());
  expect(f.board.experimentAttempt(attempt.attemptId)!.private).toBe(true);
  const db = new Database(f.file);
  expect(db.query("SELECT private FROM research_attempts WHERE attempt_id=?").get(attempt.attemptId)).toEqual({ private: 1 });
  // An older writer may have missed the durable upgrade; any private event still controls every page.
  db.query("UPDATE research_attempts SET private=0 WHERE attempt_id=?").run(attempt.attemptId);
  db.query("UPDATE research_attempt_events SET private=0 WHERE attempt_id=? AND seq=2").run(attempt.attemptId); db.close();
  const page = f.board.experimentEvents(attempt.attemptId, 1, 1);
  expect(page.rows).toHaveLength(1); expect(page.rows[0]!.event.seq).toBe(2); expect(page.rows[0]!.private).toBe(true);
  expect(f.board.experimentAttempt(attempt.attemptId)!.private).toBe(true);
});
