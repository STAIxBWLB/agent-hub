import { expect, test } from "bun:test";
import { LINEAGE_LIMITS, readExecutionLineage, type ExecutionLineageSource, type LineageEdge, type LineageNode } from "../src/hub/execution-lineage.ts";
import { type ExecutionReferenceV1 } from "../src/hub/execution-reference.ts";

const ref = (kind: string, id = kind): ExecutionReferenceV1 => ({ v: 1, tool: "ahub", projectKey: "project-a", kind, id });
const node = (kind: string, state: string, strength: LineageNode["strength"] = "host-observed") => ({ ref: ref(kind), state, strength });
const edge = (from: string, to: string, relation: LineageEdge["relation"], strength: LineageEdge["strength"] = "host-observed") => ({ from: ref(from), to: ref(to), relation, strength });
function fixture(): ExecutionLineageSource {
  return { id: "fixture", revision: "1", scope: "public-reader", projectKey: "project-a", cursorKey: "fixture-only-not-a-credential-0001", authorized: true, diagnostics: false, health: "ready",
    nodes: [node("task", "approved"), node("dispatch", "completed"), node("attempt", "failed", "declared"), node("output", "recorded"), node("review", "approved")],
    edges: [edge("task", "dispatch", "dispatched"), edge("dispatch", "attempt", "declared-external", "declared"),
      edge("attempt", "output", "produced", "declared"), edge("output", "review", "reviewed")] };
}
test("AC1 explicit fixture traverses the chain without upgrading distinct states or declared evidence", () => {
  const source = fixture();
  const page = readExecutionLineage(source, { root: ref("task") });
  expect(page.state).toBe("available");
  if (page.state !== "available") throw new Error("fixture unavailable");
  expect(page.nodes.map(n => [n.ref.kind, n.state])).toEqual([["task", "approved"], ["dispatch", "completed"], ["attempt", "failed"], ["output", "recorded"], ["review", "approved"]]);
  expect(page.edges).toEqual([...source.edges]);
  expect(page.edges[1]!.strength).toBe("declared");
  expect(page.truncated).toBe(false);
  expect(page.cursor).toBeUndefined();
});
test("missing dispatch-to-attempt recording stays missing, with no time/title/path inference", () => {
  const source = fixture(); source.edges = source.edges.filter(e => e.relation !== "declared-external");
  const page = readExecutionLineage(source, { root: ref("task") });
  expect(page.state === "available" && page.nodes.map(n => n.ref.kind)).toEqual(["task", "dispatch"]);
});
test("external declarations cannot acquire runner or host attestation through a link", () => {
  for (const strength of ["host-observed", "runner-attested"] as const) {
    const source = fixture(); source.edges = source.edges.map(e => e.relation === "declared-external" ? { ...e, strength } : e);
    expect(readExecutionLineage(source, { root: ref("task") })).toEqual({ state: "unavailable" });
  }
});
test("AC3 authorization precedes existence, health and identifiers", () => {
  const denied = { ...fixture(), authorized: false };
  const absent = { ...denied, nodes: [], health: "missing" as const };
  expect(readExecutionLineage(denied, { root: ref("task") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage(absent, { root: ref("task") })).toEqual({ state: "unavailable" });
  const unread = { ...denied, get nodes(): never { throw new Error("must not read"); } };
  expect(readExecutionLineage(unread, { root: ref("task") })).toEqual({ state: "unavailable" });
});
test("authorized diagnostics are closed causes, never source prose", () => {
  for (const health of ["missing", "corrupt", "unsupported", "withheld"] as const) {
    expect(readExecutionLineage({ ...fixture(), diagnostics: true, health }, { root: ref("task") })).toEqual({ state: "unavailable", reason: health });
    expect(readExecutionLineage({ ...fixture(), health }, { root: ref("task") })).toEqual({ state: "unavailable" });
  }
});
test("privacy precedes identifiers, edges, counts and pagination", () => {
  // Model the source-owner read boundary: its privacy index never hands hidden rows to the reader.
  const owner = (hiddenCount: number, root = "task"): ExecutionLineageSource => {
    const raw = [...fixture().nodes.map(value => ({ value, readable: true })),
      ...Array.from({ length: hiddenCount }, () => ({ value: node("secret", "recorded"), readable: false }))];
    return { ...fixture(), health: root === "secret" ? "withheld" : "ready", nodes: raw.filter(n => n.readable).map(n => n.value) };
  };
  const source = owner(LINEAGE_LIMITS.sourceNodes + 1), clean = owner(0);
  const query = { root: ref("task"), nodes: 1, edges: 1 };
  expect(readExecutionLineage(source, query)).toEqual(readExecutionLineage(clean, query));
  expect(readExecutionLineage(owner(1, "secret"), { root: ref("secret") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...owner(1, "secret"), diagnostics: true }, { root: ref("secret") })).toEqual({ state: "unavailable", reason: "withheld" });
  expect(JSON.stringify(readExecutionLineage(source, { root: ref("task") }))).not.toContain("secret");
  const dangling = fixture(); dangling.nodes = dangling.nodes.filter(n => n.ref.kind !== "output");
  expect(readExecutionLineage(dangling, { root: ref("task") })).toEqual({ state: "unavailable" });
});
test("bounded pages reconstruct the visible graph and cursor invalidates on source, scope, root or bytes changes", () => {
  const source = fixture(), query = { root: ref("task"), nodes: 2, edges: 1 };
  const allNodes: LineageNode[] = [], allEdges: LineageEdge[] = [];
  let cursor: string | undefined, first: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = readExecutionLineage(source, { ...query, ...(cursor ? { cursor } : {}) });
    expect(page.state).toBe("available"); if (page.state !== "available") break;
    expect(page.nodes.length).toBeLessThanOrEqual(2); expect(page.edges.length).toBeLessThanOrEqual(1);
    allNodes.push(...page.nodes); allEdges.push(...page.edges); cursor = page.cursor; first ??= cursor;
    if (!page.truncated) break;
  }
  expect(cursor).toBeUndefined(); expect(allNodes).toHaveLength(5); expect(allEdges).toHaveLength(4);
  for (const changed of [{ ...source, revision: "2" }, { ...source, id: "other" }, { ...source, scope: "other" }])
    expect(readExecutionLineage(changed, { ...query, cursor: first! })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage(source, { ...query, root: ref("review"), cursor: first! })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage(source, { ...query, bytes: 4096, cursor: first! })).toEqual({ state: "unavailable" });
  const forged = JSON.parse(Buffer.from(first!, "base64url").toString("utf8")); forged[1] = source.nodes.length; forged[2] = source.edges.length;
  expect(readExecutionLineage(source, { ...query, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, cursorKey: "fixture-only-replacement-key-0001" }, { ...query, cursor: first! })).toEqual({ state: "unavailable" });
});
test("source caps fail closed, duplicate identities are corrupt, malformed cursors never become complete", () => {
  const source = fixture();
  expect(readExecutionLineage({ ...source, nodes: Array.from({ length: LINEAGE_LIMITS.sourceNodes + 1 }, () => source.nodes[0]!) }, { root: ref("task") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, nodes: [...source.nodes, source.nodes[0]!] }, { root: ref("task") })).toEqual({ state: "unavailable" });
  for (const cursor of ["bad", "!", "a".repeat(513)]) expect(readExecutionLineage(source, { root: ref("task"), cursor })).toEqual({ state: "unavailable" });
});
test("response byte ceiling includes cursor and metadata; no ids or prose outside the closed projection", () => {
  const source = fixture();
  source.nodes = Array.from({ length: 300 }, (_, i) => ({ ...node("output", "recorded"), ref: ref("output", `${i}-${"x".repeat(245)}`) }));
  source.edges = source.nodes.slice(1).map(n => ({ from: source.nodes[0]!.ref, to: n.ref, relation: "produced", strength: "declared" }));
  const page = readExecutionLineage(source, { root: source.nodes[0]!.ref, bytes: 4096 });
  expect(page.state).toBe("available"); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
  expect(page.state === "available" && page.truncated).toBe(true);
  expect(page.state === "available" && page.nodes.length).toBeLessThanOrEqual(100);
  expect(page.state === "available" && page.edges.length).toBeLessThanOrEqual(200);
});
