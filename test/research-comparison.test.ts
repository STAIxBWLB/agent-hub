import { expect, test } from "bun:test";
import { comparisonPlanHash, parseComparisonPlan, type ComparisonPlanV1, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

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
