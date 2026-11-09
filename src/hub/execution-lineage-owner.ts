import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Board, Task } from "./board.ts";
import type { JournalDelivery } from "./delivery-journal.ts";
import { latestDeliverables } from "./deliverables.ts";
import { isReviewObserverExcluded } from "./memory-policy.ts";
import { remoteEnvelope } from "./envelope.ts";
import { EXECUTION_LINK_LIMITS, taskExecutionReference, type ExecutionLinkRecord } from "./execution-links.ts";
import { executionReferenceKey, parseExecutionReference, type ExecutionReferenceV1 } from "./execution-reference.ts";
import { LINEAGE_LIMITS, readExecutionLineage, type ExecutionLineageSource, type LineageEdge, type LineageNode, type LineageQuery, type LineageResult } from "./execution-lineage.ts";

export interface OwnerLineageQuery {
  taskId?: number; attemptId?: string; root?: ExecutionReferenceV1; task?: { id: number; created: number };
  cursor?: string; nodes?: number; edges?: number; bytes?: number;
}
export interface ExecutionLineageOwnerPorts {
  project: string; projectKey: string; cursorKey: string; scope: string; diagnostics: boolean;
  /** Host capability only: raw event paging cannot prove a complete public projection under dynamic field policy. */
  eventProjectionSupported: boolean;
  task(id: number): Task | undefined;
  visible(task: Task): boolean;
  metadata(text: string): boolean;
  links(task: Task): readonly ExecutionLinkRecord[];
  delivery?(id: string): JournalDelivery | undefined;
  attempt: Board["experimentAttempt"];
  events: Board["experimentEvents"];
  receipts: Board["runnerReceipts"];
  attemptStatus: Board["experimentAttemptStatus"];
}
const unavailableRoot = (projectKey: string): ExecutionReferenceV1 => ({ v: 1, tool: "ahub", projectKey, kind: "task", id: "unavailable" });
const integer = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/** Closed selectors never treat an opaque id as a path, URL or project resolver. */
export function parseOwnerLineageQuery(input: unknown): OwnerLineageQuery {
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new Error("invalid lineage query");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.entries(fields).some(([key, field]) => !keys.includes(key) || !("value" in field))) throw new Error("invalid lineage query");
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  };
  const raw = object(input, ["taskId", "attemptId", "root", "task", "cursor", "nodes", "edges", "bytes"]);
  if ([raw.taskId, raw.attemptId, raw.root].filter(value => value !== undefined).length !== 1) throw new Error("choose one lineage root");
  if (raw.taskId !== undefined && !integer(raw.taskId, 1) || raw.attemptId !== undefined && (typeof raw.attemptId !== "string" || !/^ra-[a-f0-9]{12}$/.test(raw.attemptId))) throw new Error("invalid lineage root");
  const root = raw.root === undefined ? undefined : parseExecutionReference(raw.root);
  if (root?.tool === "ahub" && (root.kind === "task" && !/^[1-9][0-9]*:[0-9]+$/.test(root.id) || root.kind === "attempt" && !/^ra-[a-f0-9]{12}$/.test(root.id))) throw new Error("invalid lineage root");
  for (const [key, maximum, minimum] of [["nodes", LINEAGE_LIMITS.nodes, 1], ["edges", LINEAGE_LIMITS.edges, 1], ["bytes", LINEAGE_LIMITS.bytes, LINEAGE_LIMITS.minimumBytes]] as const) {
    const value = raw[key];
    if (value !== undefined && (!integer(value, minimum) || value > maximum)) throw new Error("invalid lineage bound");
  }
  let task: OwnerLineageQuery["task"];
  if (raw.task !== undefined) {
    const scope = object(raw.task, ["id", "created"]);
    if (!root || !integer(scope.id, 1) || !integer(scope.created, 0)) throw new Error("invalid lineage task scope");
    task = { id: scope.id, created: scope.created };
  }
  return { ...raw, ...(root ? { root } : {}), ...(task ? { task } : {}) } as OwnerLineageQuery;
}

/** One existing task row and explicit owner lookups only; no Board scan, reverse index or backfill. */
export function executionOwnerSnapshot(ports: ExecutionLineageOwnerPorts, input: OwnerLineageQuery): { source: ExecutionLineageSource; query: LineageQuery; task?: Task } {
  const source: ExecutionLineageSource = { id: "ahub-owner", revision: "unavailable", projectKey: ports.projectKey, scope: ports.scope, cursorKey: ports.cursorKey,
    authorized: true, diagnostics: ports.diagnostics, health: "missing", nodes: [], edges: [] };
  let root = input.root ?? unavailableRoot(ports.projectKey);
  const query = () => ({ root, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.nodes === undefined ? {} : { nodes: input.nodes }), ...(input.edges === undefined ? {} : { edges: input.edges }), ...(input.bytes === undefined ? {} : { bytes: input.bytes }) });
  const fail = (health: ExecutionLineageSource["health"]) => { source.health = health; return { source, query: query() }; };
  try {
    let taskId = input.taskId ?? input.task?.id, attemptRoot = input.attemptId;
    if (input.root) {
      if (root.tool !== "ahub" || root.projectKey !== ports.projectKey) return fail("unsupported");
      if (root.kind === "task") {
        const identity = /^([1-9][0-9]*):([0-9]+)$/.exec(root.id);
        if (!identity || !integer(Number(identity[1]), 1) || !integer(Number(identity[2]), 0)) return fail("unsupported");
        if (taskId !== undefined && taskId !== Number(identity[1])) return fail("missing");
        taskId = Number(identity[1]);
      } else if (root.kind === "attempt") attemptRoot = root.id;
      else if (!input.task) return fail("unsupported");
    }
    if (attemptRoot !== undefined && !/^ra-[a-f0-9]{12}$/.test(attemptRoot)) return fail("unsupported");
    const firstAttempt = attemptRoot ? ports.attempt(attemptRoot) : undefined;
    if (attemptRoot && (!firstAttempt || firstAttempt.project !== ports.project)) return fail("missing");
    if (firstAttempt) {
      if (taskId !== undefined && taskId !== firstAttempt.attempt.taskId) return fail("missing");
      taskId = firstAttempt.attempt.taskId;
    }
    if (taskId === undefined) return fail("unsupported");
    const task = ports.task(taskId);
    if (!task) return fail("missing");
    if (!ports.visible(task)) return fail("withheld");
    if (input.task && input.task.created !== task.created) return fail("missing");
    if ((attemptRoot !== undefined || root.kind === "output") && !ports.eventProjectionSupported) return fail("unsupported");
    if (firstAttempt?.private) return fail("withheld");
    const taskRef = taskExecutionReference(ports.projectKey, task.id, task.created);
    if (input.taskId !== undefined) root = taskRef;
    if (input.attemptId !== undefined) root = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "attempt", id: input.attemptId };
    if (root.kind === "task" && executionReferenceKey(root) !== executionReferenceKey(taskRef)) return fail("missing");
    const nodes = new Map<string, LineageNode>(), edges: LineageEdge[] = [], external = new Map<string, ExecutionReferenceV1>();
    const rootKey = executionReferenceKey(root);
    let rootWithheld = false;
    const withheld = (ref: ExecutionReferenceV1) => { if (executionReferenceKey(ref) === rootKey) rootWithheld = true; };
    let projectedBytes = 0;
    const account = (value: unknown) => {
      projectedBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
      if (projectedBytes > LINEAGE_LIMITS.sourceBytes) { source.health = "unsupported"; throw new Error("lineage source bound"); }
    };
    const add = (ref: ExecutionReferenceV1, state: string, strength: LineageNode["strength"]): boolean => {
      if (!ports.metadata(JSON.stringify(ref))) { withheld(ref); return false; }
      const key = executionReferenceKey(ref);
      if (!nodes.has(key)) { const node = { ref, state, strength }; account(node); nodes.set(key, node); }
      if (nodes.size > LINEAGE_LIMITS.sourceNodes) { source.health = "unsupported"; throw new Error("lineage source bound"); }
      return true;
    };
    const edge = (from: ExecutionReferenceV1, to: ExecutionReferenceV1, relation: LineageEdge["relation"], strength: LineageEdge["strength"]) => {
      if (!nodes.has(executionReferenceKey(from)) || !nodes.has(executionReferenceKey(to))) return;
      const value = { from, to, relation, strength }; account(value); edges.push(value);
      if (edges.length > LINEAGE_LIMITS.sourceEdges) { source.health = "unsupported"; throw new Error("lineage source bound"); }
    };
    if (!add(taskRef, task.state, "host-observed")) return fail("withheld");
    const deliverableRef = (record: NonNullable<Task["history"][number]["deliverables"]>[number]): ExecutionReferenceV1 => ({ v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "deliverable", id: record.id, sha256: record.sha256 });
    const publicOutput = (record: NonNullable<Task["history"][number]["deliverables"]>[number]) => {
      const visible = !record.private && (!record.path || ports.metadata(record.path));
      if (!visible) withheld(deliverableRef(record));
      return visible;
    };
    const current = new Map<string, string>();
    let publicSubmission = false;
    for (const entry of task.history) {
      if (entry.withheld) { for (const output of entry.deliverables ?? []) withheld(deliverableRef(output)); continue; }
      const outputs = (entry.deliverables ?? []).filter(publicOutput);
      // Review copies bind a verdict, not a new submission. Wholly hidden updates do not replace
      // the current public submission or reveal their presence through review currency.
      if (entry.event === "approved" || entry.event === "changes_requested" || !outputs.length) continue;
      const submitted = latestDeliverables([{ event: entry.event, deliverables: outputs }]);
      if (!submitted) continue;
      current.clear(); publicSubmission = true;
      for (const output of submitted) {
        account([output.id, output.sha256]); current.set(output.id, output.sha256);
        if (current.size > LINEAGE_LIMITS.sourceNodes) { source.health = "unsupported"; throw new Error("lineage source bound"); }
      }
    }
    const currentHead = task.refs.commit ?? task.sdlc?.head;
    const head = currentHead && ports.metadata(JSON.stringify({ v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "head", id: currentHead })) ? currentHead : undefined;
    for (const [index, entry] of task.history.entries()) {
      if (entry.withheld) continue;
      const reviewed = entry.event === "approved" || entry.event === "changes_requested", reviewedHead = entry.reviewedHead ?? entry.reviewFindings?.head;
      const outputs = (entry.deliverables ?? []).filter(publicOutput);
      if (reviewed && entry.deliverables?.length && !outputs.length) continue;
      const sameSubmission = outputs.length === current.size && outputs.every(record => current.get(record.id) === record.sha256);
      const currency = !reviewedHead || !head ? `${entry.event}_unknown`
        : reviewedHead !== head || publicSubmission && !sameSubmission ? `${entry.event}_stale`
        : outputs.length && !publicSubmission ? `${entry.event}_unknown` : entry.event;
      const review: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "review", id: `${task.id}:${task.created}:${index}`, ...(reviewedHead ? { revision: reviewedHead } : {}) };
      if (reviewed && (outputs.length || reviewedHead)) {
        add(review, currency, "host-observed");
        if (reviewedHead) {
          const submitted: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "head", id: reviewedHead };
          if (add(submitted, "submitted", "declared")) {
            edge(taskRef, submitted, "produced", "declared");
            edge(submitted, review, "reviewed", "declared");
          }
        }
      }
      for (const output of outputs) {
        const ref: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "deliverable", id: output.id, sha256: output.sha256 };
        if (add(ref, !publicSubmission ? "historical" : current.get(output.id) === output.sha256 ? "recorded" : "stale", "host-observed")) {
          edge(taskRef, ref, "produced", "host-observed");
          if (reviewed) edge(ref, review, "reviewed", "host-observed");
        }
      }
    }
    const links = ports.links(task);
    if (links.length >= EXECUTION_LINK_LIMITS.read) return fail("unsupported");
    const local = (ref: ExecutionReferenceV1, saved = false): boolean => {
      if (ref.tool !== "ahub" || ref.projectKey !== ports.projectKey) return false;
      if (nodes.has(executionReferenceKey(ref))) return true;
      if (ref.kind === "output") {
        if (!ports.eventProjectionSupported) { source.health = "unsupported"; return false; }
        const address = /^(ra-[a-f0-9]{12}):([1-9][0-9]*)$/.exec(ref.id);
        if (!address || ref.revision !== undefined) return false;
        const owner: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "attempt", id: address[1]! };
        return local(owner, saved) && nodes.has(executionReferenceKey(ref));
      }
      if (ref.kind === "dispatch") {
        if (ref.revision !== undefined || ref.sha256 !== undefined) return false;
        const delivery = ports.delivery?.(ref.id);
        if (!delivery) return false;
        const matches = delivery.originals.some(env => env.refs?.task === String(task.id) && (saved || env.id === task.offer?.envelopeId));
        if (!matches) return false;
        if (delivery.originals.some(env => env.private || remoteEnvelope(env) || isReviewObserverExcluded(env))) { withheld(ref); return false; }
        return add(ref, delivery.state, "host-observed") && (edge(taskRef, ref, "dispatched", "host-observed"), true);
      }
      if (ref.kind !== "attempt" || !/^ra-[a-f0-9]{12}$/.test(ref.id) || ref.revision !== undefined || ref.sha256 !== undefined) return false;
      if (!ports.eventProjectionSupported) { source.health = "unsupported"; return false; }
      const attempt = ports.attempt(ref.id);
      if (!attempt || attempt.project !== ports.project || attempt.attempt.taskId !== task.id) return false;
      if (attempt.private) {
        withheld(ref);
        const address = root.kind === "output" && root.revision === undefined ? /^(ra-[a-f0-9]{12}):([1-9][0-9]*)$/.exec(root.id) : null;
        const seq = Number(address?.[2]);
        if (ports.diagnostics && address?.[1] === ref.id && Number.isSafeInteger(seq)) {
          // The task is authorized. Inspect only this indexed event's reference fields for the
          // diagnostic boolean; private event text, identifiers and counts never enter a page.
          const row = ports.events(ref.id, seq - 1, 1).rows.find(item => item.event.seq === seq);
          if (row?.event.kind === "output") {
            const body = row.event.body;
            const sha256 = "id" in body ? body.sha256 : row.observations.find(item => item.eventSeq === seq && item.observation.source === "deliverable")?.observation.values.sha256;
            if (sha256 === undefined || typeof sha256 === "string") withheld({ v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "output", id: `${ref.id}:${seq}`, ...(sha256 ? { sha256 } : {}) });
          }
        }
        return false;
      }
      if (!add(ref, ports.attemptStatus(ref.id), "declared")) return false;
      edge(taskRef, ref, "attempted", "host-observed");
      const protocol: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "protocol", id: attempt.attempt.protocolHash };
      if (add(protocol, "recorded", "declared")) edge(protocol, ref, "attempted", "declared");
      const events = ports.events(ref.id, 0, 50);
      if (!events.done) { source.health = "unsupported"; return false; }
      const receipts = ports.receipts(ref.id).filter(row => !row.private && row.receipt.projectId === ports.project && row.receipt.attemptId === ref.id && row.receipt.protocolHash === attempt.attempt.protocolHash);
      for (const receipt of receipts) {
        const address: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "runner-receipt", id: receipt.receipt.receiptId, sha256: receipt.bodyHash };
        if (add(address, "recorded", "runner-attested")) edge(ref, address, "produced", "runner-attested");
      }
      for (const row of events.rows) {
        if (row.event.kind !== "output") continue;
        const body = row.event.body;
        const observation = row.observations.find(item => item.eventSeq === row.event.seq && item.observation.source === "deliverable" && typeof item.observation.values.deliverableId === "string" && typeof item.observation.values.sha256 === "string");
        const id = "id" in body ? body.id : observation?.observation.values.deliverableId;
        const sha256 = "id" in body ? body.sha256 : observation?.observation.values.sha256;
        if (typeof id !== "string" || sha256 !== undefined && typeof sha256 !== "string") continue;
        const output: ExecutionReferenceV1 = { v: 1, tool: "ahub", projectKey: ports.projectKey, kind: "output", id: `${ref.id}:${row.event.seq}`, ...(sha256 ? { sha256 } : {}) };
        if (row.private || !ports.metadata(JSON.stringify(body))) { withheld(output); continue; }
        const measured = typeof sha256 === "string" && observation?.observation.values.deliverableId === id && observation.observation.values.sha256 === sha256;
        const signed = receipts.some(receipt => receipt.receipt.outputs?.some(item => item.name === id && item.sha256 === sha256));
        const strength = signed ? "runner-attested" : measured ? "host-observed" : "declared";
        if (add(output, "recorded", strength)) edge(ref, output, "produced", strength);
      }
      return true;
    };
    // ponytail: task offers name envelope ids, not journal delivery ids; there is no indexed reverse lookup.
    // Only an explicit scoped dispatch or saved declaration can name a journal row; never scan the journal.
    if (root.kind === "attempt" || root.kind === "dispatch" || root.kind === "output") local(root);
    const admitted = links.filter(link => link.projectKey === ports.projectKey && link.taskId === task.id && link.taskCreated === task.created && ports.metadata(JSON.stringify([link.from, link.reference])));
    // Expand the bounded declared neighborhoods before emitting edges. A protocol/receipt origin
    // can depend on a later attempt declaration; each productive pass adds nodes, never scans owners.
    let beforeExpansion: number;
    do {
      beforeExpansion = nodes.size;
      for (const link of admitted) if (local(link.from, true) && link.reference.tool === "ahub") local(link.reference, true);
    } while (nodes.size > beforeExpansion);
    for (const link of admitted) {
      if (!local(link.from, true)) continue;
      const target = link.reference;
      if (target.tool === "ahub") { if (!local(target, true)) continue; }
      else {
        if (!add(target, "declared", "declared")) continue;
        const key = executionReferenceKey(target);
        if (!external.has(key)) { account(target); external.set(key, target); }
      }
      edge(link.from, target, "declared-external", "declared");
    }
    if (source.health === "unsupported") return fail("unsupported");
    if (!nodes.has(rootKey)) return fail(rootWithheld ? "withheld" : "missing");
    source.nodes = [...nodes.values()]; source.edges = [...new Map(edges.map(edge => [JSON.stringify(edge), edge])).values()]; source.admittedExternalTargets = [...external.values()];
    // The core also binds the visible graph. Hidden history and unprojected task fields are
    // never a source revision: otherwise a private append would invalidate a public cursor.
    source.revision = createHash("sha256").update(JSON.stringify([source.nodes, source.edges, source.admittedExternalTargets])).digest("hex");
    source.health = "ready";
    return { source, query: query(), task };
  } catch { return fail(source.health === "unsupported" ? "unsupported" : "corrupt"); }
}
export function readOwnerExecutionLineage(ports: ExecutionLineageOwnerPorts, input: OwnerLineageQuery): LineageResult {
  const { source, query } = executionOwnerSnapshot(ports, input);
  return readExecutionLineage(source, query);
}
