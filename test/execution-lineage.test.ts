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
test("caller root and limit errors are invalid, while privacy still hides diagnostic reasons", () => {
  const queries = [
    { root: { ...ref("task"), v: 2 } as unknown as ExecutionReferenceV1 },
    { root: ref("task"), nodes: 0 }, { root: ref("task"), edges: LINEAGE_LIMITS.edges + 1 },
    { root: ref("task"), bytes: LINEAGE_LIMITS.minimumBytes - 1 },
  ];
  for (const query of queries) {
    expect(readExecutionLineage({ ...fixture(), diagnostics: true }, query)).toEqual({ state: "unavailable", reason: "invalid" });
    expect(readExecutionLineage(fixture(), query)).toEqual({ state: "unavailable" });
    expect(readExecutionLineage({ ...fixture(), diagnostics: true }, { ...query, cursor: "bad" })).toEqual({ state: "unavailable", reason: "invalid" });
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

const external = (tool: "ares" | "amem" | "vmem", projectKey = "foreign-project"): ExecutionReferenceV1 => ({ v: 1, tool, projectKey, kind: "record", id: `${tool}-target`, revision: "saved-revision", sha256: "a".repeat(64) });
function admittedFixture(targets: readonly ExecutionReferenceV1[] = [external("ares")]): ExecutionLineageSource {
  return { ...fixture(), admittedExternalTargets: targets,
    nodes: [node("task", "approved"), ...targets.map(ref => ({ ref, state: "declared", strength: "declared" as const }))],
    edges: targets.map(to => ({ from: ref("task"), to, relation: "declared-external" as const, strength: "declared" as const })) };
}

test("host-admitted foreign producer references remain opaque declared target nodes", () => {
  const targets = [external("ares"), external("amem"), { ...external("vmem"), id: "https://opaque.invalid/not-a-fetch?value=stored-reference" }];
  const source = admittedFixture(targets);
  const result = readExecutionLineage(source, { root: ref("task") });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw Error("host-admitted fixture unavailable");
  expect(result.nodes.map(value => value.ref)).toEqual([ref("task"), ...targets]);
  expect(result.nodes.slice(1).every(value => value.strength === "declared")).toBe(true);
  expect(result.edges).toEqual(source.edges);
  expect(result.edges.every(value => value.relation === "declared-external" && value.strength === "declared")).toBe(true);
});

test("a producer edge is never its own admission and exact revision/hash identity is required", () => {
  const target = external("ares"), admitted = admittedFixture([target]);
  for (const source of [
    { ...admitted, admittedExternalTargets: undefined },
    { ...admitted, admittedExternalTargets: [] },
    { ...admitted, admittedExternalTargets: [{ ...target, revision: "different" }] },
    { ...admitted, admittedExternalTargets: [{ ...target, sha256: "b".repeat(64) }] },
    { ...admitted, admittedExternalTargets: [{ ...target, projectKey: "different" }] },
  ]) expect(readExecutionLineage(source, { root: ref("task") })).toEqual({ state: "unavailable" });
});

test("foreign roots/outgoing edges and nondeclared foreign node/edge strengths fail closed", () => {
  const target = external("amem"), source = admittedFixture([target]);
  expect(readExecutionLineage(source, { root: target })).toEqual({ state: "unavailable" });
  const sameProject = external("vmem", source.projectKey);
  expect(readExecutionLineage(admittedFixture([sameProject]), { root: sameProject })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, edges: [] }, { root: ref("task") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, edges: [...source.edges, { from: target, to: ref("task"), relation: "declared-external", strength: "declared" }] }, { root: ref("task") })).toEqual({ state: "unavailable" });
  for (const strength of ["host-observed", "runner-attested", "unknown"] as const) {
    expect(readExecutionLineage({ ...source, nodes: source.nodes.map(value => value.ref.tool === "ahub" ? value : { ...value, strength }) }, { root: ref("task") })).toEqual({ state: "unavailable" });
    expect(readExecutionLineage({ ...source, edges: source.edges.map(value => ({ ...value, strength })) }, { root: ref("task") })).toEqual({ state: "unavailable" });
  }
  expect(readExecutionLineage({ ...source, edges: source.edges.map(value => ({ ...value, relation: "produced" as const })) }, { root: ref("task") })).toEqual({ state: "unavailable" });
});

test("ahub references always retain the source project boundary", () => {
  const other = { ...ref("task"), projectKey: "project-b" };
  expect(readExecutionLineage(fixture(), { root: other })).toEqual({ state: "unavailable" });
  const source = { ...fixture(), nodes: [...fixture().nodes, { ref: other, state: "declared", strength: "declared" as const }],
    edges: [...fixture().edges, { from: ref("task"), to: other, relation: "declared-external" as const, strength: "declared" as const }] };
  expect(readExecutionLineage(source, { root: ref("task") })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, admittedExternalTargets: [other] }, { root: ref("task") })).toEqual({ state: "unavailable" });
});

test("host external admission is bounded, validated and cursor-bound independently of graph edges", () => {
  const a = external("ares"), b = external("amem"), source = admittedFixture([a, b]);
  const query = { root: ref("task"), nodes: 1, edges: 1 };
  const first = readExecutionLineage(source, query);
  expect(first.state === "available" && first.truncated).toBe(true);
  if (first.state !== "available" || !first.cursor) throw Error("expected paginated fixture");
  // Same visible graph, a different exact host-admission list/order: the continuation must not transfer.
  expect(readExecutionLineage({ ...source, admittedExternalTargets: [b, a] }, { ...query, cursor: first.cursor })).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, admittedExternalTargets: [a, a] }, query)).toEqual({ state: "unavailable" });
  expect(readExecutionLineage({ ...source, admittedExternalTargets: Array.from({ length: LINEAGE_LIMITS.sourceNodes + 1 }, () => a) }, query)).toEqual({ state: "unavailable" });
  const denied = { ...source, authorized: false, get admittedExternalTargets(): never { throw Error("admission must not be read before authority"); } };
  expect(readExecutionLineage(denied, query)).toEqual({ state: "unavailable" });
});

test("source byte ceiling includes the complete explicit external-admission metadata", () => {
  const targets: ExecutionReferenceV1[] = Array.from({ length: 1800 }, (_, index) => ({ v: 1, tool: "ares", projectKey: "foreign-" + "p".repeat(240),
    kind: "r".repeat(64), id: `${index}-` + "i".repeat(240), revision: "v".repeat(128), sha256: "a".repeat(64) }));
  const source = admittedFixture(targets);
  const projectedBytes = [...source.nodes, ...source.edges].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  expect(projectedBytes).toBeLessThan(LINEAGE_LIMITS.sourceBytes);
  expect(projectedBytes + Buffer.byteLength(JSON.stringify(targets))).toBeGreaterThan(LINEAGE_LIMITS.sourceBytes);
  expect(readExecutionLineage({ ...source, diagnostics: true }, { root: ref("task") })).toEqual({ state: "unavailable", reason: "unsupported" });
});
