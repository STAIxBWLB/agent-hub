import { expect, test } from "bun:test";
import type { Task } from "../src/hub/board.ts";
import type { JournalDelivery } from "../src/hub/delivery-journal.ts";
import type { ExperimentAttemptRecord, ExperimentEventRecord } from "../src/hub/research-experiments.ts";
import { taskExecutionReference, type ExecutionLinkRecord } from "../src/hub/execution-links.ts";
import { executionOwnerSnapshot, parseOwnerLineageQuery, readOwnerExecutionLineage, type ExecutionLineageOwnerPorts } from "../src/hub/execution-lineage-owner.ts";
import type { ExecutionReferenceV1 } from "../src/hub/execution-reference.ts";
import { LINEAGE_LIMITS } from "../src/hub/execution-lineage.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const projectKey = "ahub-fixture", hash = "a".repeat(64), head = "b".repeat(40);
const ref = (kind: string, id: string, extra: Partial<ExecutionReferenceV1> = {}): ExecutionReferenceV1 => ({ v: 1, tool: "ahub", projectKey, kind, id, ...extra });
function fixture() {
  const task: Task = { id: 7, created: 10, updated: 10, title: "PRIVATE_TASK_TITLE", detail: "PRIVATE_TASK_BODY", class: "implement", owner: "codex", reviewer: "claude", state: "in_progress", refs: { commit: head }, signals: [], history: [] };
  const attempt: ExperimentAttemptRecord = { attemptId: "ra-0123456789ab", project: "fixture", attempt: { taskId: task.id, protocolHash: hash, phase: "final", idempotencyKey: "fixture" }, bodyHash: hash, by: "codex", at: 10, private: false };
  const output: ExperimentEventRecord = { attemptId: attempt.attemptId, idempotencyKey: "output", bodyHash: hash, by: "codex", private: false,
    event: { kind: "output", body: { id: "d-0123456789ab", sha256: hash }, seq: 1, at: 10, provenance: "declared" }, observations: [] };
  const offer = newEnvelope("hub", "PRIVATE_ENVELOPE_BODY", { kind: "task", refs: { task: String(task.id) } });
  task.offer = { envelopeId: offer.id, owner: "codex", assignmentFlowRevision: 0 };
  const delivery: JournalDelivery = { id: "dispatch-1", peer: "codex", state: "completed", revision: 1, createdAt: 10, updatedAt: 10, originals: [offer], out: [offer] };
  const links: ExecutionLinkRecord[] = [];
  const ports: ExecutionLineageOwnerPorts = { project: "fixture", projectKey, cursorKey: "fixture-private-cursor-key-0000001", scope: "fixture-user", diagnostics: true,
    task: id => id === task.id ? task : undefined, visible: row => !row.signals.includes("pii"), metadata: text => !text.includes("private/"), links: () => links,
    delivery: id => id === delivery.id ? delivery : undefined, attempt: id => id === attempt.attemptId ? attempt : undefined,
    events: () => ({ rows: [output], afterSeq: 1, done: true }), receipts: () => [], attemptStatus: () => "failed" };
  return { task, attempt, output, delivery, links, ports, taskRef: taskExecutionReference(projectKey, task.id, task.created) };
}

test("owner selectors are closed and an opaque address is never a resolver instruction", () => {
  expect(parseOwnerLineageQuery({ taskId: 7 })).toEqual({ taskId: 7 });
  for (const query of [{ taskId: 7, attemptId: "ra-0123456789ab" }, { taskId: 7, task: { id: 7, created: 10 } }, { root: ref("dispatch", "https://example.test/no-fetch") }, { taskId: 7, title: "PRIVATE" }]) {
    if ("root" in query) expect(parseOwnerLineageQuery(query).root?.id).toBe("https://example.test/no-fetch");
    else expect(() => parseOwnerLineageQuery(query)).toThrow();
  }
});

test("one task row does not reverse discover a journal dispatch or research attempt", () => {
  const f = fixture(), result = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("fixture unavailable");
  expect(result.nodes.map(node => node.ref.kind)).toEqual(["task"]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
});

test("explicit dispatch, deliverable and output roots require matching owning-task identity", () => {
  const f = fixture();
  for (const root of [ref("dispatch", f.delivery.id), ref("deliverable", "d-0123456789ab", { sha256: hash }), ref("output", `${f.attempt.attemptId}:1`, { sha256: hash })])
    expect(readOwnerExecutionLineage(f.ports, { root })).toEqual({ state: "unavailable", reason: "unsupported" });
  const scope = { id: 7, created: 10 };
  expect(readOwnerExecutionLineage(f.ports, { root: ref("dispatch", f.delivery.id), task: scope }).state).toBe("available");
  expect(readOwnerExecutionLineage(f.ports, { root: ref("output", `${f.attempt.attemptId}:1`, { sha256: hash }), task: scope }).state).toBe("available");
  expect(readOwnerExecutionLineage(f.ports, { root: ref("dispatch", f.delivery.id), task: { ...scope, created: 11 } }).state).toBe("unavailable");
  f.attempt.attempt.taskId = 8;
  expect(readOwnerExecutionLineage(f.ports, { root: ref("output", `${f.attempt.attemptId}:1`, { sha256: hash }), task: scope }).state).toBe("unavailable");
});

test("forged source revisions and hashes never become host-observed attempt or dispatch evidence", () => {
  const f = fixture();
  for (const root of [ref("dispatch", f.delivery.id), ref("attempt", f.attempt.attemptId)]) for (const patch of [{ revision: "invented" }, { sha256: hash }]) {
    const result = readOwnerExecutionLineage(f.ports, { root: { ...root, ...patch }, task: { id: 7, created: 10 } });
    expect(result.state).toBe("unavailable");
  }
});

test("admitted declarations connect exact sources without upgrading failed attempts or external targets", () => {
  const f = fixture(), foreign = ref("claim", "opaque", { tool: "ares", projectKey: "foreign-project", revision: "r1", sha256: hash });
  const row = (id: string, from: ExecutionReferenceV1, reference: ExecutionReferenceV1): ExecutionLinkRecord => ({ id, projectKey, taskId: 7, taskCreated: 10, from, reference, strength: "declared", recordedBy: "codex", recordedAt: 10 });
  f.links.push(row("one", ref("dispatch", f.delivery.id), ref("attempt", f.attempt.attemptId)), row("two", f.taskRef, foreign), row("three", ref("attempt", f.attempt.attemptId), foreign));
  const result = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("fixture unavailable");
  expect(result.nodes.find(node => node.ref.kind === "attempt")?.state).toBe("failed");
  expect(result.nodes.find(node => node.ref.tool === "ares")?.strength).toBe("declared");
  expect(result.edges.filter(edge => edge.relation === "declared-external").every(edge => edge.strength === "declared")).toBe(true);
  expect(executionOwnerSnapshot(f.ports, { taskId: 7 }).source.admittedExternalTargets).toEqual([foreign]);
});

test("private task/output/review records are excluded before counts and historical head/hash changes mark reviews stale", () => {
  const f = fixture();
  const output = { id: "d-0123456789ab", path: "public.txt", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: [output] }, { at: 11, by: "claude", event: "approved", reviewedHead: head, deliverables: [output] },
    { at: 12, by: "codex", event: "done", deliverables: [{ ...output, sha256: "c".repeat(64) }, { ...output, id: "d-fedcba987654", path: "private/hidden", private: true }] },
    { at: 13, by: "claude", event: "approved", withheld: true, deliverables: [output] }];
  const page = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  if (page.state !== "available") throw new Error("fixture unavailable");
  expect(page.nodes.filter(node => node.ref.kind === "review").map(node => node.state)).toEqual(["approved_stale"]);
  expect(JSON.stringify(page)).not.toContain("d-fedcba987654"); expect(JSON.stringify(page)).not.toContain("public.txt");
  f.task.signals.push("pii");
  expect(readOwnerExecutionLineage({ ...f.ports, diagnostics: false }, { taskId: 7 })).toEqual({ state: "unavailable" });
});

test("a hidden latest record cannot change public review currency and unrecorded head freshness is unknown", () => {
  const f = fixture(), output = { id: "d-0123456789ab", path: "public.txt", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "claude", event: "approved", reviewedHead: head, deliverables: [output] }];
  const before = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  f.task.history.push({ at: 11, by: "codex", event: "done", deliverables: [{ ...output, path: "private/hidden", sha256: "d".repeat(64) }] });
  const after = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  expect(after).toEqual(before);
  delete f.task.refs.commit;
  const unknown = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  expect(unknown.state === "available" && unknown.nodes.find(node => node.ref.kind === "review")?.state).toBe("approved_unknown");
});

test("an incomplete owner event page or oversized public neighborhood is unsupported, never complete empty", () => {
  const f = fixture();
  expect(readOwnerExecutionLineage({ ...f.ports, events: () => ({ rows: [], afterSeq: 0, done: false }) }, { attemptId: f.attempt.attemptId })).toEqual({ state: "unavailable", reason: "unsupported" });
  f.task.history = Array.from({ length: LINEAGE_LIMITS.sourceNodes + 1 }, (_, index) => ({ at: index, by: "codex", event: "done", deliverables: [{ id: `d-${index.toString(16).padStart(12, "0")}`, sha256: hash, format: "txt", bytes: 1 }] }));
  expect(readOwnerExecutionLineage(f.ports, { taskId: 7 })).toEqual({ state: "unavailable", reason: "unsupported" });
});


test("historical verdict and exact hash/head binding survive recorded head changes", () => {
  const f = fixture(), output = { id: "d-0123456789ab", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "claude", event: "changes_requested", reviewedHead: head, deliverables: [output] }];
  f.task.refs.commit = "c".repeat(40);
  const result = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  if (result.state !== "available") throw new Error("fixture unavailable");
  expect(result.nodes.find(node => node.ref.kind === "review")).toEqual({ ref: ref("review", "7:10:0", { revision: head }), state: "changes_requested_stale", strength: "host-observed" });
  expect(result.nodes.find(node => node.ref.kind === "deliverable")?.ref.sha256).toBe(hash);
});


test("saved output-origin declarations resolve independently of preceding link order", () => {
  const f = fixture(), output = ref("output", `${f.attempt.attemptId}:1`, { sha256: hash });
  const foreign = ref("claim", "opaque", { tool: "ares", projectKey: "foreign-project" });
  const row = (id: string, from: ExecutionReferenceV1, reference: ExecutionReferenceV1): ExecutionLinkRecord => ({ id, projectKey, taskId: 7, taskCreated: 10, from, reference, strength: "declared", recordedBy: "codex", recordedAt: 10 });
  f.links.push(row("first-output", output, foreign), row("later-attempt", ref("dispatch", f.delivery.id), ref("attempt", f.attempt.attemptId)));
  const forward = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  f.links.reverse();
  const reverse = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  if (forward.state !== "available" || reverse.state !== "available") throw new Error("fixture unavailable");
  expect(forward.edges).toContainEqual({ from: output, to: foreign, relation: "declared-external", strength: "declared" });
  expect(reverse.edges).toContainEqual({ from: output, to: foreign, relation: "declared-external", strength: "declared" });
  expect(forward.nodes.map(node => JSON.stringify(node)).sort()).toEqual(reverse.nodes.map(node => JSON.stringify(node)).sort());
  expect(forward.edges.map(edge => JSON.stringify(edge)).sort()).toEqual(reverse.edges.map(edge => JSON.stringify(edge)).sort());
});


test("head-only reviews retain old submitted heads and verdict currency after the recorded task head changes", () => {
  const f = fixture();
  f.task.history = [{ at: 10, by: "claude", event: "approved", reviewedHead: head }];
  f.task.refs.commit = "c".repeat(40);
  const page = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  if (page.state !== "available") throw new Error("fixture unavailable");
  const submitted = ref("head", head), review = ref("review", "7:10:0", { revision: head });
  expect(page.nodes).toContainEqual({ ref: submitted, state: "submitted", strength: "declared" });
  expect(page.nodes).toContainEqual({ ref: review, state: "approved_stale", strength: "host-observed" });
  expect(page.edges).toContainEqual({ from: f.taskRef, to: submitted, relation: "produced", strength: "declared" });
  expect(page.edges).toContainEqual({ from: submitted, to: review, relation: "reviewed", strength: "declared" });
  expect(page.nodes.some(node => node.ref.kind === "deliverable")).toBe(false);
});
