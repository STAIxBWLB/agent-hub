import { expect, test } from "bun:test";
import type { RunnerReceiptRecord, Task } from "../src/hub/board.ts";
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
  const task: Task = { id: 7, created: 10, updated: 10, title: "PRIVATE_TASK_TITLE", detail: "PRIVATE_TASK_BODY", class: "implement", owner: "codex", reviewer: "claude", state: "in_progress", refs: { commit: head }, signals: [], history: [], rejections: 0 };
  const attempt: ExperimentAttemptRecord = { attemptId: "ra-0123456789ab", project: "fixture", attempt: { taskId: task.id, protocolHash: hash, phase: "final", idempotencyKey: "fixture" }, bodyHash: hash, by: "codex", at: 10, private: false };
  const output: ExperimentEventRecord = { attemptId: attempt.attemptId, idempotencyKey: "output", bodyHash: hash, by: "codex", private: false,
    event: { kind: "output", body: { id: "d-0123456789ab", sha256: hash }, seq: 1, at: 10, provenance: "declared" }, observations: [] };
  const offer = newEnvelope("hub", "PRIVATE_ENVELOPE_BODY", { kind: "task", refs: { task: String(task.id) } });
  task.offer = { envelopeId: offer.id, owner: "codex", assignmentFlowRevision: 0 };
  const delivery: JournalDelivery = { id: "dispatch-1", peer: "codex", state: "completed", revision: 1, createdAt: 10, updatedAt: 10, originals: [offer], out: [offer] };
  const links: ExecutionLinkRecord[] = [];
  const ports: ExecutionLineageOwnerPorts = { project: "fixture", projectKey, cursorKey: "fixture-private-cursor-key-0000001", scope: "fixture-user", diagnostics: true, eventProjectionSupported: true,
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

for (const kind of ["protocol", "runner-receipt"] as const) test(`saved ${kind} origins retain both declarations in either link order`, () => {
  const f = fixture();
  const receipt: RunnerReceiptRecord = { receipt: { receiptId: "receipt-1", runner: "fixture", projectId: "fixture", attemptId: f.attempt.attemptId, protocolHash: hash },
    signature: "fixture-signature", publicKey: "fixture-public-key", keyHash: hash, bodyHash: hash, seq: 2, by: "codex", at: 10, private: false };
  f.ports.receipts = () => [receipt];
  const origin = kind === "protocol" ? ref(kind, hash) : ref(kind, receipt.receipt.receiptId, { sha256: hash });
  const attempt = ref("attempt", f.attempt.attemptId), target = ref("claim", "linked-claim", { tool: "ares", projectKey: "foreign-project" });
  const row = (id: string, from: ExecutionReferenceV1, reference: ExecutionReferenceV1): ExecutionLinkRecord => ({ id, projectKey, taskId: 7, taskCreated: 10, from, reference, strength: "declared", recordedBy: "codex", recordedAt: 10 });
  const ownerLink = row("later-owner", f.taskRef, attempt), dependentLink = row("first-dependent", origin, target);
  let previous: { nodes: string[]; edges: string[] } | undefined;
  for (const links of [[dependentLink, ownerLink], [ownerLink, dependentLink]]) {
    f.ports.links = () => links;
    const page = readOwnerExecutionLineage(f.ports, { taskId: 7 });
    if (page.state !== "available") throw new Error("fixture unavailable");
    expect(page.truncated).toBe(false);
    expect(page.edges).toContainEqual({ from: f.taskRef, to: attempt, relation: "declared-external", strength: "declared" });
    expect(page.edges).toContainEqual({ from: origin, to: target, relation: "declared-external", strength: "declared" });
    expect(page.nodes.find(node => node.ref.tool === "ares")?.strength).toBe("declared");
    const graph = { nodes: page.nodes.map(node => JSON.stringify(node)).sort(), edges: page.edges.map(edge => JSON.stringify(edge)).sort() };
    if (previous) expect(graph).toEqual(previous);
    previous = graph;
  }
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


test("exact hidden deliverable, output and dispatch roots project withheld only to person diagnostics", () => {
  const cases = ["private-deliverable", "private-path", "withheld-entry", "private-output", "private-attempt-output", "private-dispatch"] as const;
  for (const kind of cases) {
    const f = fixture(); let root: ExecutionReferenceV1;
    if (kind === "private-output" || kind === "private-attempt-output") { f.output.private = true; f.attempt.private = kind === "private-attempt-output"; root = ref("output", `${f.attempt.attemptId}:1`, { sha256: hash }); }
    else if (kind === "private-dispatch") { f.delivery.originals[0]!.private = true; root = ref("dispatch", f.delivery.id); }
    else {
      const output = { id: "d-0123456789ab", path: kind === "private-path" ? "private/hidden" : "public.txt", format: "txt", sha256: hash, bytes: 1, ...(kind === "private-deliverable" ? { private: true as const } : {}) };
      f.task.history.push({ at: 10, by: "codex", event: "done", deliverables: [output], ...(kind === "withheld-entry" ? { withheld: true as const } : {}) });
      root = ref("deliverable", output.id, { sha256: hash });
    }
    const query = { root, task: { id: 7, created: 10 } };
    expect(readOwnerExecutionLineage(f.ports, query)).toEqual({ state: "unavailable", reason: "withheld" });
    expect(readOwnerExecutionLineage({ ...f.ports, diagnostics: false }, query)).toEqual({ state: "unavailable" });
    const snapshot = executionOwnerSnapshot(f.ports, query);
    expect(snapshot.source.nodes).toEqual([]); expect(snapshot.source.edges).toEqual([]);
    if (root.sha256) expect(readOwnerExecutionLineage(f.ports, { ...query, root: { ...root, sha256: "c".repeat(64) } })).toEqual({ state: "unavailable", reason: "missing" });
    expect(readOwnerExecutionLineage(f.ports, { ...query, root: { ...root, id: "absent" } })).toEqual({ state: "unavailable", reason: "missing" });
  }
});

test("task visibility is checked before inspecting a requested private dispatch or output", () => {
  const f = fixture(); let reads = 0;
  const ports = { ...f.ports, visible: () => false, delivery: () => { reads++; throw new Error("must not inspect hidden task records"); }, events: () => { reads++; throw new Error("must not inspect hidden task records"); } };
  for (const root of [ref("dispatch", f.delivery.id), ref("output", `${f.attempt.attemptId}:1`, { sha256: hash })]) {
    expect(readOwnerExecutionLineage(ports, { root, task: { id: 7, created: 10 } })).toEqual({ state: "unavailable", reason: "withheld" });
  }
  expect(reads).toBe(0);
});


test("owner-unrecognized explicit attempt ids never invoke a source lookup or classify healthy storage as corrupt", () => {
  const f = fixture(); let lookups = 0;
  const ports = { ...f.ports, attempt: () => { lookups++; throw new Error("invalid caller id must not reach Board.experimentAttempt"); } };
  const root = ref("attempt", "not-an-attempt");
  expect(readOwnerExecutionLineage(ports, { root })).toEqual({ state: "unavailable", reason: "unsupported" });
  expect(readOwnerExecutionLineage({ ...ports, diagnostics: false }, { root })).toEqual({ state: "unavailable" });
  f.links.push({ id: "malformed-attempt-target", projectKey, taskId: 7, taskCreated: 10, from: f.taskRef, reference: root, strength: "declared", recordedBy: "codex", recordedAt: 10 });
  const page = readOwnerExecutionLineage(ports, { taskId: 7 });
  expect(page.state).toBe("available");
  if (page.state !== "available") throw new Error("fixture unavailable");
  expect(page.nodes.map(node => node.ref)).toEqual([f.taskRef]);
  expect(lookups).toBe(0);
});

test("private and withheld history appends preserve public pages, source revision and usable cursors", () => {
  const f = fixture(), output = { id: "d-0123456789ab", path: "public.txt", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: [output] }, { at: 11, by: "claude", event: "approved", reviewedHead: head, deliverables: [output] }];
  const query = { taskId: 7, nodes: 1, edges: 1 }, before = readOwnerExecutionLineage(f.ports, query);
  if (before.state !== "available" || !before.cursor) throw new Error("fixture must paginate");
  const revision = executionOwnerSnapshot(f.ports, query).source.revision;
  const continuation = { ...query, cursor: before.cursor }, next = readOwnerExecutionLineage(f.ports, continuation);
  f.task.history.push({ at: 12, by: "codex", event: "done", deliverables: [{ ...output, id: "d-fedcba987654", private: true }] },
    { at: 13, by: "codex", event: "done", deliverables: [{ ...output, id: "d-fedcba987653", path: "private/hidden" }] },
    { at: 14, by: "claude", event: "approved", reviewedHead: "c".repeat(40), deliverables: [output], withheld: true });
  expect(executionOwnerSnapshot(f.ports, query).source.revision).toBe(revision);
  expect(readOwnerExecutionLineage(f.ports, query)).toEqual(before);
  expect(readOwnerExecutionLineage(f.ports, continuation)).toEqual(next);
  f.task.history.push({ at: 15, by: "codex", event: "done", deliverables: [{ ...output, id: "d-fedcba987652" }] });
  expect(readOwnerExecutionLineage(f.ports, continuation)).toEqual({ state: "unavailable", reason: "cursor_invalid" });
});

test("unprojected task head fields never invalidate a public cursor", () => {
  const f = fixture(), output = { id: "d-0123456789ab", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: [output] }];
  const query = { taskId: 7, nodes: 1, edges: 1 }, before = readOwnerExecutionLineage(f.ports, query);
  if (before.state !== "available" || !before.cursor) throw new Error("fixture must paginate");
  const next = readOwnerExecutionLineage(f.ports, { ...query, cursor: before.cursor });
  f.task.refs.commit = "c".repeat(40); // no review/head node projects this field
  expect(readOwnerExecutionLineage(f.ports, query)).toEqual(before);
  expect(readOwnerExecutionLineage(f.ports, { ...query, cursor: before.cursor })).toEqual(next);
});

test("review currency compares the entire current public submission set without depending on its order", () => {
  for (const change of ["replacement", "addition", "removal", "reorder"] as const) {
    const f = fixture(), d1 = { id: "d-0123456789ab", format: "txt", sha256: hash, bytes: 1 }, d2 = { ...d1, id: "d-fedcba987654", sha256: "c".repeat(64) };
    const initial = change === "removal" || change === "reorder" ? [d1, d2] : [d1];
    const submitted = change === "replacement" ? [d2] : change === "addition" ? [d1, d2] : change === "removal" ? [d1] : [d2, d1];
    f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: initial }, { at: 11, by: "claude", event: "approved", reviewedHead: head, deliverables: initial },
      { at: 12, by: "codex", event: "done", deliverables: submitted }];
    const page = readOwnerExecutionLineage(f.ports, { taskId: 7 });
    if (page.state !== "available") throw new Error("fixture unavailable");
    expect(page.nodes.find(node => node.ref.kind === "review")?.state).toBe(change === "reorder" ? "approved" : "approved_stale");
    for (const record of initial) expect(page.nodes).toContainEqual({ ref: ref("deliverable", record.id, { sha256: record.sha256 }), state: submitted.some(now => now.id === record.id && now.sha256 === record.sha256) ? "recorded" : "stale", strength: "host-observed" });
    expect(page.nodes.find(node => node.ref.kind === "review")?.ref.revision).toBe(head);
  }
});

test("review copies cannot restore an older submission after a public replacement", () => {
  const f = fixture(), d1 = { id: "d-0123456789ab", format: "txt", sha256: hash, bytes: 1 }, d2 = { ...d1, id: "d-fedcba987654" };
  f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: [d1] }, { at: 11, by: "claude", event: "approved", reviewedHead: head, deliverables: [d1] },
    { at: 12, by: "codex", event: "done", deliverables: [d2] }, { at: 13, by: "claude", event: "changes_requested", reviewedHead: head, deliverables: [d1] }];
  const page = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  if (page.state !== "available") throw new Error("fixture unavailable");
  expect(page.nodes.filter(node => node.ref.kind === "review").map(node => node.state)).toEqual(["approved_stale", "changes_requested_stale"]);
  expect(page.nodes.find(node => node.ref.kind === "deliverable" && node.ref.id === d1.id)?.state).toBe("stale");
  expect(page.nodes.find(node => node.ref.kind === "deliverable" && node.ref.id === d2.id)?.state).toBe("recorded");
});


test("a withheld current head has the same public graph and pages as an absent current head", () => {
  const f = fixture(), output = { id: "d-0123456789ab", format: "txt", sha256: hash, bytes: 1 };
  f.task.history = [{ at: 10, by: "codex", event: "done", deliverables: [output] }, { at: 11, by: "claude", event: "approved", reviewedHead: head, deliverables: [output] }];
  const hidden = "c".repeat(40), metadata = f.ports.metadata;
  f.ports.metadata = text => !text.includes(hidden) && metadata(text);
  f.task.refs.commit = hidden;
  const query = { taskId: 7, nodes: 1, edges: 1 };
  const denied = readOwnerExecutionLineage(f.ports, { taskId: 7 });
  const page = readOwnerExecutionLineage(f.ports, query);
  if (denied.state !== "available" || page.state !== "available" || !page.cursor) throw new Error("fixture must paginate");
  expect(denied.nodes.find(node => node.ref.kind === "review")?.state).toBe("approved_unknown");
  expect(denied.nodes).toContainEqual({ ref: ref("head", head), state: "submitted", strength: "declared" });
  expect(JSON.stringify(denied)).not.toContain(hidden);
  const continuation = readOwnerExecutionLineage(f.ports, { ...query, cursor: page.cursor });
  delete f.task.refs.commit;
  expect(readOwnerExecutionLineage(f.ports, { taskId: 7 })).toEqual(denied);
  expect(readOwnerExecutionLineage(f.ports, query)).toEqual(page);
  expect(readOwnerExecutionLineage(f.ports, { ...query, cursor: page.cursor })).toEqual(continuation);
});


test("unsupported current event policy is independent of filtered event counts and never pages events", () => {
  for (const filtered of [0, 51]) {
    const f = fixture(); let reads = 0;
    const ports: ExecutionLineageOwnerPorts = { ...f.ports, eventProjectionSupported: false, events: () => { reads++; return { rows: Array.from({ length: filtered }, () => ({ ...f.output, private: true })), afterSeq: filtered, done: filtered === 0 }; } };
    for (const root of [ref("attempt", f.attempt.attemptId), ref("output", `${f.attempt.attemptId}:1`, { sha256: hash })]) {
      const query = { root, task: { id: 7, created: 10 } };
      expect(readOwnerExecutionLineage(ports, query)).toEqual({ state: "unavailable", reason: "unsupported" });
      expect(readOwnerExecutionLineage({ ...ports, diagnostics: false }, query)).toEqual({ state: "unavailable" });
      expect(readOwnerExecutionLineage({ ...ports, diagnostics: false, visible: () => false }, query)).toEqual({ state: "unavailable" });
    }
    expect(readOwnerExecutionLineage({ ...ports, diagnostics: false }, { root: ref("attempt", "ra-fedcba987654"), task: { id: 7, created: 10 } })).toEqual({ state: "unavailable" });
    const foreign = ref("claim", "public-claim", { tool: "ares", projectKey: "foreign-project" });
    f.links.push({ id: "foreign-only", projectKey, taskId: 7, taskCreated: 10, from: f.taskRef, reference: foreign, strength: "declared", recordedBy: "codex", recordedAt: 10 });
    const metadata = readOwnerExecutionLineage(ports, { taskId: 7 });
    expect(metadata.state === "available" && metadata.nodes.some(node => node.ref.tool === "ares")).toBe(true);
    f.links.push({ id: "requires-attempt", projectKey, taskId: 7, taskCreated: 10, from: f.taskRef, reference: ref("attempt", f.attempt.attemptId), strength: "declared", recordedBy: "codex", recordedAt: 10 });
    expect(readOwnerExecutionLineage(ports, { taskId: 7 })).toEqual({ state: "unavailable", reason: "unsupported" });
    expect(reads).toBe(0);
  }
});
