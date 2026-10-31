import { expect, test } from "bun:test";
import { comparisonPlanHash, parseComparisonPlan, compareExperimentProtocols, comparisonProjection, protocolHash, evaluatorIdentityHash, protocolApprovalBindingMatches,
  type ComparisonPlanV1, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

const HASH = "a".repeat(64), SOURCE = "src:0123456789abcdef";
function protocol(): ExperimentProtocolContract {
  return { campaignId: "rc-0123456789ab", campaignRevision: 1, lineage: "fixture", claimIds: ["claim"], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: "b".repeat(40) }, environment: { descriptor: "Synthetic CPU fixture" }, method: "Compare synthetic observations", parameters: { size: 2 }, seeds: [1],
    evaluator: { id: "fixture", version: "v1", hash: HASH }, metrics: [{ name: "accuracy", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"],
    resourceLimits: [{ name: "elapsed", value: 10, unit: "seconds" }], sealed: false };
}
function plan(): ComparisonPlanV1 {
  const p = protocol();
  return { campaignId: p.campaignId, fixed: { inputs: p.inputs, splits: p.splits, evaluator: p.evaluator, metrics: p.metrics },
    varying: ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value: 0.01 } };
}

test("comparison plans return detached data and stable hashes across object-key order", () => {
  const input = plan(), parsed = parseComparisonPlan(input), digest = comparisonPlanHash(parsed);
  expect(parsed).toEqual(input); expect(parsed).not.toBe(input); expect(parsed.fixed.inputs).not.toBe(input.fixed.inputs);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(comparisonPlanHash(parseComparisonPlan(Object.fromEntries(Object.entries(input).reverse())))).toBe(digest);
  input.fixed.inputs[0]!.sha256 = "c".repeat(64); input.varying.reverse();
  expect(parsed.fixed.inputs[0]!.sha256).toBe(HASH); expect(comparisonPlanHash(input)).not.toBe(digest);
});

test("comparison plans are closed at every boundary and cannot supply approval, results or commands", () => {
  for (const key of ["hash", "approvedBy", "provenance", "winner", "execute", "campaignRevision"]) expect(() => parseComparisonPlan({ ...plan(), [key]: "caller" })).toThrow("unknown field");
  for (const fixed of [{ ...plan().fixed, parameters: {} }, { ...plan().fixed, inputs: [{ sourceId: SOURCE, sha256: HASH, text: "raw source" }] },
    { ...plan().fixed, evaluator: { ...plan().fixed.evaluator, approved: true } }, { ...plan().fixed, metrics: [{ ...plan().fixed.metrics[0], result: 1 }] }]) {
    expect(() => parseComparisonPlan({ ...plan(), fixed })).toThrow("unknown field");
  }
  for (const rule of [{ kind: "tolerance", value: 0.1, alpha: 0.05 }, { kind: "test", name: "bootstrap", alpha: 0.05, value: 1 }, { kind: "shell", command: "never run" }]) {
    expect(() => parseComparisonPlan({ ...plan(), rule })).toThrow();
  }
});

test("comparison inputs, split ids, evaluator and metric schemas retain protocol bounds", () => {
  for (const fixed of [{ ...plan().fixed, inputs: [{ sourceId: SOURCE, sha256: "invalid" }] }, { ...plan().fixed, inputs: [{ sourceId: `${SOURCE}\n`, sha256: HASH }] },
    { ...plan().fixed, inputs: Array.from({ length: 65 }, () => ({ sourceId: SOURCE, sha256: HASH })) },
    { ...plan().fixed, splits: ["test", "test"] }, { ...plan().fixed, splits: Array.from({ length: 17 }, (_, index) => `s${index}`) },
    { ...plan().fixed, evaluator: { id: "Uppercase", version: "v1" } }, { ...plan().fixed, evaluator: { id: "fixture", version: "x".repeat(513) } },
    { ...plan().fixed, metrics: [plan().fixed.metrics[0], plan().fixed.metrics[0]] },
    { ...plan().fixed, metrics: Array.from({ length: 33 }, (_, index) => ({ name: `m${index}`, unit: "fraction", direction: "higher" })) }]) {
    expect(() => parseComparisonPlan({ ...plan(), fixed })).toThrow();
  }
  const unicode = plan(); unicode.fixed.metrics[0]!.name = "가".repeat(170) + "ab";
  expect(parseComparisonPlan(unicode).fixed.metrics[0]!.name).toBe(unicode.fixed.metrics[0]!.name);
  unicode.fixed.metrics[0]!.name = "가".repeat(171);
  expect(() => parseComparisonPlan(unicode)).toThrow("metrics");
});

test("varying is a unique closed subset and may be empty", () => {
  expect(parseComparisonPlan({ ...plan(), varying: [] }).varying).toEqual([]);
  for (const varying of [["code", "code"], ["method"], ["evaluator"], ["variantOf"], ["code", "parameters", "seeds", "role", "extra"]]) {
    expect(() => parseComparisonPlan({ ...plan(), varying })).toThrow("varying");
  }
});

test("comparison rules describe finite tolerances or bounded test names and valid alpha without evaluation", () => {
  expect(parseComparisonPlan({ ...plan(), rule: { kind: "tolerance", value: 0 } }).rule).toEqual({ kind: "tolerance", value: 0 });
  expect(parseComparisonPlan({ ...plan(), rule: { kind: "test", name: "Declared permutation test", alpha: 0.05 } }).rule)
    .toEqual({ kind: "test", name: "Declared permutation test", alpha: 0.05 });
  for (const value of [-1, NaN, Infinity, "0.1"]) expect(() => parseComparisonPlan({ ...plan(), rule: { kind: "tolerance", value } })).toThrow("value");
  for (const alpha of [0, 1, -0.1, 2, NaN, Infinity, "0.05"]) expect(() => parseComparisonPlan({ ...plan(), rule: { kind: "test", name: "test", alpha } })).toThrow("alpha");
  expect(() => parseComparisonPlan({ ...plan(), rule: { kind: "test", name: "가".repeat(171), alpha: 0.05 } })).toThrow("name");
});

test("comparison parser refuses proxies, accessors and sparse lists without executing caller code", () => {
  let touched = 0;
  const proxy = new Proxy({}, { ownKeys() { touched++; throw new Error("trap"); }, getPrototypeOf() { touched++; throw new Error("trap"); } });
  expect(() => parseComparisonPlan(proxy)).toThrow("plain data object");
  expect(() => parseComparisonPlan({ ...plan(), fixed: proxy })).toThrow("plain data object");
  const accessor = plan(); Object.defineProperty(accessor.fixed, "inputs", { get() { touched++; return []; } });
  expect(() => parseComparisonPlan(accessor)).toThrow("accessors");
  expect(() => parseComparisonPlan({ ...plan(), varying: new Array(1) })).toThrow("dense data list");
  expect(touched).toBe(0);
});

test("approval identity never carries to changed protocol or evaluator hashes, including metadata-only changes", async () => {
  const { protocolHash, evaluatorIdentityHash, protocolApprovalBindingMatches } = await import("../src/hub/research-experiments.ts");
  const p=protocol(), binding={protocolHash:protocolHash(p),evaluatorHash:evaluatorIdentityHash(p)};
  expect(protocolApprovalBindingMatches(p,binding)).toBe(true);
  expect(protocolApprovalBindingMatches(p,undefined)).toBe(false);
  const changed=[{...p,code:{commit:"c".repeat(40)}},{...p,parameters:{size:3}},{...p,campaignRevision:2},{...p,lineage:"another-lineage"},{...p,supersedes:HASH},
    {...p,evaluator:{...p.evaluator,version:"v2"}}];
  for (const value of changed) expect(protocolApprovalBindingMatches(value,binding)).toBe(false);
  const evaluatorChanged={...p,evaluator:{...p.evaluator,version:"v2"}};
  expect(protocolApprovalBindingMatches(evaluatorChanged,{...binding,protocolHash:protocolHash(evaluatorChanged)})).toBe(false);
  let touched=0;
  const hostile={get protocolHash(){touched++;return binding.protocolHash;},evaluatorHash:binding.evaluatorHash};
  expect(protocolApprovalBindingMatches(p,hostile)).toBe(false);
  expect(touched).toBe(0);
});

test("comparison ignores only identity metadata while readback and fresh approval keep each full protocol identity", () => {
  const a = protocol(), fixed = { ...plan(), varying: [] }, approval = { protocolHash: protocolHash(a), evaluatorHash: evaluatorIdentityHash(a) };
  for (const b of [{ ...a, campaignRevision: 2 }, { ...a, lineage: "another-lineage" }, { ...a, supersedes: HASH },
    { ...a, campaignRevision: 3, lineage: "variant-lineage", supersedes: HASH }]) {
    expect(compareExperimentProtocols(fixed, a, b)).toEqual({ compatible: true });
    expect(protocolApprovalBindingMatches(b, approval)).toBe(false);
    const view = comparisonProjection(fixed, a, b);
    expect(view.baseline).toEqual({ protocolHash: protocolHash(a), campaignRevision: a.campaignRevision });
    expect(view.variant).toEqual({ protocolHash: protocolHash(b), campaignRevision: b.campaignRevision });
    expect(view.baseline.protocolHash).not.toBe(view.variant.protocolHash);
    expect(view.identityNote).toContain("excluded from compatibility only");
    expect(view.identityNote).toContain("approval binding remains separate");
  }
});

test("predeclared baseline code variants, parameters and seed replicas compare structurally without producing a winner", () => {
  const a = protocol(), b: ExperimentProtocolContract = { ...protocol(), role: "variant", variantOf: protocolHash(a), code: { commit: "c".repeat(40) }, parameters: { size: 3 }, seeds: [2] };
  expect(compareExperimentProtocols(plan(), a, b)).toEqual({ compatible: true });
  const artifact: ExperimentProtocolContract = { ...b, code: { deliverable: { id: "d-0123456789ab", sha256: HASH } } };
  expect(compareExperimentProtocols(plan(), a, artifact)).toEqual({ compatible: true });
  const sameRole = { ...plan(), varying: ["seeds" as const] };
  expect(compareExperimentProtocols(sameRole, a, { ...a, seeds: [2, 3] })).toEqual({ compatible: true });
  const view = comparisonProjection(plan(), a, b);
  expect(Object.keys(view).sort()).toEqual(["baseline", "compatibility", "identityNote", "planHash", "variant"]);
  expect(view.planHash).toBe(comparisonPlanHash(plan()));
  expect(protocolApprovalBindingMatches(b, { protocolHash: protocolHash(a), evaluatorHash: evaluatorIdentityHash(a) })).toBe(false);
});

test("every fixed invariant must exactly match the plan on both sides, even if both protocols agree with each other", () => {
  const mutations: { field: "inputs" | "splits" | "evaluator" | "metrics"; change: (p: ExperimentProtocolContract) => void }[] = [
    { field: "inputs", change: p => { p.inputs[0]!.sha256 = "c".repeat(64); } },
    { field: "splits", change: p => { p.splits = ["validation"]; } },
    { field: "evaluator", change: p => { p.evaluator.version = "v2"; } },
    { field: "metrics", change: p => { p.metrics[0]!.unit = "percent"; } },
    { field: "metrics", change: p => { p.metrics[0]!.direction = "lower"; } },
  ];
  for (const { field, change } of mutations) {
    const a = protocol(), b = protocol(); change(a);
    expect(compareExperimentProtocols(plan(), a, b)).toEqual({ compatible: false, field, side: "baseline" });
    expect(compareExperimentProtocols(plan(), b, a)).toEqual({ compatible: false, field, side: "variant" });
    expect(compareExperimentProtocols(plan(), a, a)).toEqual({ compatible: false, field, side: "baseline" });
  }
});

test("experimental fields outside the four allowed varying groups remain exact", () => {
  const mutations: { field: string; change: (p: ExperimentProtocolContract) => void }[] = [
    { field: "claimIds", change: p => { p.claimIds = ["other-claim"]; } },
    { field: "environment", change: p => { p.environment.descriptor = "Different declared CPU environment"; } },
    { field: "environment", change: p => { p.environment.hash = HASH; } },
    { field: "method", change: p => { p.method = "A changed experimental method"; } },
    { field: "resourceLimits", change: p => { p.resourceLimits[0]!.value = 20; } },
    { field: "sealed", change: p => { p.sealed = true; } },
  ];
  for (const { field, change } of mutations) {
    const b = protocol(); change(b);
    expect(compareExperimentProtocols(plan(), protocol(), b)).toEqual({ compatible: false, field, side: "pair" });
  }
});

test("undeclared code, parameter, seed and role-group variations are incompatible", () => {
  const fixed = { ...plan(), varying: [] };
  const mutations: { field: string; change: (p: ExperimentProtocolContract) => void }[] = [
    { field: "code", change: p => { p.code = { commit: "c".repeat(40) }; } },
    { field: "parameters", change: p => { p.parameters.size = 3; } },
    { field: "seeds", change: p => { p.seeds = [2]; } },
    { field: "role", change: p => { p.role = "variant"; p.variantOf = HASH; } },
  ];
  for (const { field, change } of mutations) {
    const b = protocol(); change(b);
    expect(compareExperimentProtocols(fixed, protocol(), b)).toEqual({ compatible: false, field, side: "pair" });
  }
  const a: ExperimentProtocolContract = { ...protocol(), role: "variant", variantOf: HASH }, b = { ...a, variantOf: "c".repeat(64) };
  expect(compareExperimentProtocols(fixed, a, b)).toEqual({ compatible: false, field: "role", side: "pair" });
  expect(compareExperimentProtocols({ ...fixed, varying: ["role"] }, a, b)).toEqual({ compatible: true });
});

test("same-campaign checks precede fixed-field checks and report the deterministic first differing field", () => {
  const a = protocol(), b = protocol(); a.campaignId = "rc-ffffffffffff"; b.inputs[0]!.sha256 = "c".repeat(64);
  expect(compareExperimentProtocols(plan(), a, b)).toEqual({ compatible: false, field: "campaignId", side: "baseline" });
  expect(compareExperimentProtocols(plan(), protocol(), a)).toEqual({ compatible: false, field: "campaignId", side: "variant" });
  const first = protocol(), second = protocol(); first.splits = ["validation"]; second.inputs[0]!.sha256 = "c".repeat(64);
  expect(compareExperimentProtocols(plan(), first, second)).toEqual({ compatible: false, field: "inputs", side: "variant" });
  const changed = protocol(); changed.claimIds = ["other"]; changed.method = "Other method"; changed.environment.hash = HASH;
  expect(compareExperimentProtocols(plan(), protocol(), changed)).toEqual({ compatible: false, field: "claimIds", side: "pair" });
});

test("fixed lists retain exact order while data-object property order is immaterial", () => {
  const a = protocol(); a.inputs.push({ sourceId: "src:fedcba9876543210", sha256: "c".repeat(64) }); a.parameters = { alpha: 1, beta: 2 };
  const p: ComparisonPlanV1 = { ...plan(), fixed: { inputs: a.inputs, splits: a.splits, evaluator: a.evaluator, metrics: a.metrics }, varying: [] };
  const reordered = { ...a, parameters: { beta: 2, alpha: 1 }, evaluator: { hash: HASH, version: a.evaluator.version, id: a.evaluator.id } };
  expect(compareExperimentProtocols(p, a, reordered)).toEqual({ compatible: true });
  const reversed = { ...a, inputs: [...a.inputs].reverse() };
  expect(compareExperimentProtocols(p, a, reversed)).toEqual({ compatible: false, field: "inputs", side: "variant" });
});

test("compatibility keeps input snapshots immutable and cannot execute a supplied rule, proxy or accessor", () => {
  const p = plan(), a = protocol(), b = protocol(), before = JSON.stringify([p, a, b]);
  expect(compareExperimentProtocols(p, a, b)).toEqual({ compatible: true });
  expect(JSON.stringify([p, a, b])).toBe(before);
  let touched = 0;
  const hostile = new Proxy(a, { getPrototypeOf() { touched++; throw new Error("trap"); } });
  expect(() => compareExperimentProtocols(p, hostile, b)).toThrow("plain data object");
  Object.defineProperty(b, "method", { get() { touched++; return "untrusted method"; } });
  expect(() => compareExperimentProtocols(p, a, b)).toThrow("accessors");
  expect(touched).toBe(0);
  const label = { ...p, rule: { kind: "test" as const, name: "never-execute-this-test-label", alpha: 0.05 } };
  expect(compareExperimentProtocols(label, a, protocol())).toEqual({ compatible: true });
});
