import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EXECUTION_REFERENCE_LIMITS, executionReferenceKey, executionText, parseExecutionReference, type ExecutionReferenceV1 } from "./execution-reference.ts";

/** Snapshot admission is host-owned; never accept these authority flags from a caller or producer. */
export const LINEAGE_LIMITS = Object.freeze({ nodes: 100, edges: 200, bytes: 256 * 1024, sourceNodes: 2048, sourceEdges: 4096, sourceBytes: 4 * 1024 * 1024, token: 128, state: 64, cursor: 512, minimumBytes: 4096 });
export type LineageStrength = "declared" | "host-observed" | "runner-attested" | "unknown";
export type LineageRelation = "dispatched" | "attempted" | "produced" | "reviewed" | "declared-external";
export interface LineageNode { ref: ExecutionReferenceV1; state: string; strength: LineageStrength }
export interface LineageEdge { from: ExecutionReferenceV1; to: ExecutionReferenceV1; relation: LineageRelation; strength: LineageStrength }
export interface ExecutionLineageSource {
  id: string; revision: string; projectKey: string; scope: string;
  /** Host-owned ephemeral signing key, never supplied by a query or persisted by this reader. */
  cursorKey: string;
  authorized: boolean; diagnostics: boolean;
  health: "ready" | "missing" | "corrupt" | "unsupported" | "withheld";
  /** Owner-authorized PUBLIC root neighborhood, complete at this revision. Apply privacy in the
   * owner's indexed read before these arrays or their bounds exist; never pass hidden rows here. */
  nodes: readonly LineageNode[];
  edges: readonly LineageEdge[];
  /** Explicit host admission from saved declared references, privacy-projected independently of producer edges. */
  admittedExternalTargets?: readonly ExecutionReferenceV1[];
}
export interface LineageQuery { root: ExecutionReferenceV1; cursor?: string; nodes?: number; edges?: number; bytes?: number }
export type LineageResult = { state: "unavailable"; reason?: "missing" | "corrupt" | "unsupported" | "withheld" | "cursor_invalid" | "invalid" }
  | { state: "available"; nodes: LineageNode[]; edges: LineageEdge[]; truncated: boolean; cursor?: string };
const STRENGTHS: readonly string[] = ["declared", "host-observed", "runner-attested", "unknown"];
const RELATIONS: readonly string[] = ["dispatched", "attempted", "produced", "reviewed", "declared-external"];
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limit = (value: number | undefined, cap: number, min = 1): number => {
  if (value === undefined) return cap;
  if (!Number.isSafeInteger(value) || value < min || value > cap) throw new Error("invalid limit");
  return value;
};

/** Pure bounded projection. No IO, clocks, probes, model calls, persistence or inference. */
export function readExecutionLineage(source: ExecutionLineageSource, query: LineageQuery): LineageResult {
  const unavailable = (reason: NonNullable<Extract<LineageResult, { state: "unavailable" }>["reason"]>): LineageResult =>
    ({ state: "unavailable", ...(source.authorized && source.diagnostics ? { reason } : {}) });
  // Authority precedes even a source-health or root read: absent and denied are indistinguishable.
  if (!source.authorized) return { state: "unavailable" };
  if (source.health !== "ready") return unavailable(source.health);
  let root: ExecutionReferenceV1, nodeLimit: number, edgeLimit: number, byteLimit: number;
  try {
    root = parseExecutionReference(query.root);
    nodeLimit = limit(query.nodes, LINEAGE_LIMITS.nodes); edgeLimit = limit(query.edges, LINEAGE_LIMITS.edges);
    byteLimit = limit(query.bytes, LINEAGE_LIMITS.bytes, LINEAGE_LIMITS.minimumBytes);
  } catch { return unavailable("invalid"); }
  try {
    const rootKey = executionReferenceKey(root);
    if (![source.id, source.revision, source.scope].every(value => executionText(value, LINEAGE_LIMITS.token)) ||
        !executionText(source.cursorKey, LINEAGE_LIMITS.token) || Buffer.byteLength(source.cursorKey) < 32 ||
        !executionText(source.projectKey, EXECUTION_REFERENCE_LIMITS.projectKey) || root.tool !== "ahub" || root.projectKey !== source.projectKey) return unavailable("invalid");
    // ponytail: oversized neighborhoods need source-owner indexed paging, never a larger inbox scan.
    if (source.nodes.length > LINEAGE_LIMITS.sourceNodes || source.edges.length > LINEAGE_LIMITS.sourceEdges ||
        source.admittedExternalTargets !== undefined && (!Array.isArray(source.admittedExternalTargets) || source.admittedExternalTargets.length > LINEAGE_LIMITS.sourceNodes)) return unavailable("unsupported");
    const admittedTargets: ExecutionReferenceV1[] = [], admittedKeys = new Set<string>();
    for (const raw of source.admittedExternalTargets ?? []) {
      const ref = parseExecutionReference(raw), key = executionReferenceKey(ref);
      if (ref.tool === "ahub" || admittedKeys.has(key)) return unavailable("corrupt");
      admittedTargets.push(ref); admittedKeys.add(key);
    }
    const nodes = new Map<string, LineageNode>(), externalKeys = new Set<string>();
    let size = source.admittedExternalTargets === undefined ? 0 : bytes(admittedTargets);
    for (const raw of source.nodes) {
      const ref = parseExecutionReference(raw.ref), key = executionReferenceKey(ref);
      if ((ref.tool === "ahub" ? ref.projectKey !== source.projectKey : !admittedKeys.has(key) || raw.strength !== "declared") || !executionText(raw.state, LINEAGE_LIMITS.state) ||
          !/^[a-z][a-z0-9_-]*$/.test(raw.state) || !STRENGTHS.includes(raw.strength) || nodes.has(key)) return unavailable("corrupt");
      const node = { ref, state: raw.state, strength: raw.strength };
      nodes.set(key, node); size += bytes(node);
      if (ref.tool !== "ahub") externalKeys.add(key);
    }
    if (!nodes.has(rootKey)) return unavailable("missing");
    const edges: LineageEdge[] = [], edgeKeys = new Set<string>();
    const adjacent = new Map<string, string[]>(), targetedExternal = new Set<string>();
    for (const raw of source.edges) {
      const from = parseExecutionReference(raw.from), to = parseExecutionReference(raw.to);
      const fromKey = executionReferenceKey(from), toKey = executionReferenceKey(to);
      if (!nodes.has(fromKey) || !nodes.has(toKey) || from.tool !== "ahub" || from.projectKey !== source.projectKey) return unavailable("corrupt");
      if (to.tool !== "ahub") {
        if (!admittedKeys.has(toKey) || raw.relation !== "declared-external" || raw.strength !== "declared") return unavailable("corrupt");
        targetedExternal.add(toKey);
      }
      if (!RELATIONS.includes(raw.relation) || !STRENGTHS.includes(raw.strength) ||
          (raw.relation === "declared-external" && raw.strength !== "declared")) return unavailable("corrupt");
      const edge = { from, to, relation: raw.relation, strength: raw.strength }, key = JSON.stringify(edge);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key); edges.push(edge); size += bytes(edge);
      for (const [a, b] of [[fromKey, toKey], [toKey, fromKey]] as const) {
        const neighbors = adjacent.get(a) ?? []; neighbors.push(b); adjacent.set(a, neighbors);
      }
    }
    if ([...externalKeys].some(key => !targetedExternal.has(key))) return unavailable("corrupt");
    if (size > LINEAGE_LIMITS.sourceBytes) return unavailable("unsupported");
    const seen = new Set([rootKey]), queue = [rootKey];
    for (let i = 0; i < queue.length; i++) for (const key of adjacent.get(queue[i]!) ?? []) {
      if (!seen.has(key)) { seen.add(key); queue.push(key); }
    }
    const visibleNodes = queue.map(key => nodes.get(key)!);
    const visibleEdges = edges.filter(edge => seen.has(executionReferenceKey(edge.from)) && seen.has(executionReferenceKey(edge.to)));
    const binding = hash([source.id, source.revision, source.scope, root, nodeLimit, edgeLimit, byteLimit, admittedTargets, visibleNodes, visibleEdges]);
    const sign = (n: number, e: number): string => createHmac("sha256", source.cursorKey).update(JSON.stringify([binding, n, e])).digest("hex");
    let n = 0, e = 0;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== "string" || query.cursor.length > LINEAGE_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) return unavailable("cursor_invalid");
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); }
      catch { return unavailable("cursor_invalid"); }
      if (!Array.isArray(cursor) || cursor.length !== 4) return unavailable("cursor_invalid");
      const [cursorBinding, nextN, nextE, signature] = cursor;
      if (cursorBinding !== binding || !Number.isSafeInteger(nextN) || !Number.isSafeInteger(nextE) || nextN < 0 || nextE < 0 ||
          nextN > visibleNodes.length || nextE > visibleEdges.length || typeof signature !== "string" ||
          !/^[0-9a-f]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(nextN, nextE), "hex"))) return unavailable("cursor_invalid");
      n = nextN; e = nextE;
    }
    const pageNodes: LineageNode[] = [], pageEdges: LineageEdge[] = [];
    const page = (nextN: number, nextE: number): Extract<LineageResult, { state: "available" }> => {
      const truncated = nextN < visibleNodes.length || nextE < visibleEdges.length;
      return { state: "available", nodes: pageNodes, edges: pageEdges, truncated,
        ...(truncated ? { cursor: Buffer.from(JSON.stringify([binding, nextN, nextE, sign(nextN, nextE)])).toString("base64url") } : {}) };
    };
    while (n < visibleNodes.length && pageNodes.length < nodeLimit) {
      pageNodes.push(visibleNodes[n]!);
      if (bytes(page(n + 1, e)) > byteLimit) { pageNodes.pop(); break; }
      n++;
    }
    while (e < visibleEdges.length && pageEdges.length < edgeLimit) {
      pageEdges.push(visibleEdges[e]!);
      if (bytes(page(n, e + 1)) > byteLimit) { pageEdges.pop(); break; }
      e++;
    }
    if (!pageNodes.length && !pageEdges.length && (n < visibleNodes.length || e < visibleEdges.length)) return unavailable("unsupported");
    return page(n, e);
  } catch { return unavailable("corrupt"); }
}

/** Refuse unsupported reply shapes instead of presenting an incomplete page as a successful graph. */
export function parseLineageResult(value: unknown): LineageResult {
  const bad = (): never => { throw new Error("lineage reply has an unsupported shape; upgrade and restart the hub, then retry"); };
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "state") || Buffer.byteLength(JSON.stringify(value)) > LINEAGE_LIMITS.bytes) return bad();
    const row = value as Record<string, any>;
    if (row.state === "unavailable") {
      if (Object.keys(row).some(key => !["state", "reason"].includes(key)) || row.reason !== undefined && !["missing", "corrupt", "unsupported", "withheld", "cursor_invalid", "invalid"].includes(row.reason)) return bad();
      return value as LineageResult;
    }
    if (row.state !== "available" || !["nodes", "edges", "truncated"].every(key => Object.hasOwn(row, key)) || Object.keys(row).some(key => !["state", "nodes", "edges", "truncated", "cursor"].includes(key)) ||
        !Array.isArray(row.nodes) || row.nodes.length > LINEAGE_LIMITS.nodes || !Array.isArray(row.edges) || row.edges.length > LINEAGE_LIMITS.edges || typeof row.truncated !== "boolean" ||
        row.cursor !== undefined && (typeof row.cursor !== "string" || row.cursor.length > LINEAGE_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(row.cursor)) || row.truncated && row.cursor === undefined || !row.truncated && Object.hasOwn(row, "cursor")) return bad();
    for (const node of row.nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node) || !["ref", "state", "strength"].every(key => Object.hasOwn(node, key)) || Object.keys(node).some(key => !["ref", "state", "strength"].includes(key)) ||
          typeof node.state !== "string" || node.state.length > LINEAGE_LIMITS.state || !/^[a-z][a-z0-9_-]*$/.test(node.state) || !STRENGTHS.includes(node.strength)) return bad();
      parseExecutionReference(node.ref);
      if (node.ref.tool !== "ahub" && node.strength !== "declared") return bad();
    }
    for (const edge of row.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge) || !["from", "to", "relation", "strength"].every(key => Object.hasOwn(edge, key)) || Object.keys(edge).some(key => !["from", "to", "relation", "strength"].includes(key)) ||
          !RELATIONS.includes(edge.relation) || !STRENGTHS.includes(edge.strength) || edge.relation === "declared-external" && edge.strength !== "declared") return bad();
      parseExecutionReference(edge.from); parseExecutionReference(edge.to);
      if (edge.from.tool !== "ahub" || edge.to.tool !== "ahub" && (edge.relation !== "declared-external" || edge.strength !== "declared")) return bad();
    }
    return value as LineageResult;
  } catch { return bad(); }
}
