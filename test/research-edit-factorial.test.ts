import { expect, test } from "bun:test";
import { editFactorial, editRates, groupEditRates, EDIT_EXPERIMENT_ARMS } from "../src/hub/research-experiments.ts";
import type { EditGovernanceBlock } from "../src/hub/research-record.ts";
import type { TaskRecord } from "../src/hub/research.ts";

function block(arm: EditGovernanceBlock["policyArm"], e: number, eb: number, s: number, sb: number): EditGovernanceBlock {
  return { observability: "hook_and_tree", policyArm: arm,
    editTool: { total: e, verifiedFullRead: e - eb, partialReadOnly: 0, blindOrStale: eb, occRejected: 0 },
    shellRoute: { total: s, verifiedFullRead: s - sb, partialReadOnly: 0, blindOrStale: sb, blockedByGuard: 0 },
    unattributedTreeWrites: 0, postEdit: { editsWhileCheckFailing: 0, revertedWrites: 0 } };
}

test("the 2x2 fixture reproduces the unverified rate and sensitivities", () => {
  const baseline = editRates([block("baseline", 80, 16, 20, 10)]);
  expect(baseline.p).toBeCloseTo(0.2); expect(baseline.bE).toBeCloseTo(0.2); expect(baseline.bS).toBeCloseTo(0.5);
  expect(baseline.B).toBeCloseTo(0.26); expect(baseline.dBdp).toBeCloseTo(0.3); expect(baseline.dBdbS).toBeCloseTo(0.2);
  const route = editRates([block("route_guard", 90, 9, 10, 4)]), occ = editRates([block("occ_guard", 80, 8, 20, 4)]), both = editRates([block("combined_guard", 90, 9, 10, 1)]);
  expect(editFactorial(baseline, route, occ, both)).toMatchObject({ subAdditive: true });
  expect(editFactorial(baseline, route, occ, both).combinedReduction).toBeCloseTo(0.16);
  const stronger = editRates([block("combined_guard", 90, 0, 10, 0)]);
  const weakerRoute = editRates([block("route_guard", 80, 12, 20, 8)]);
  const weakerOcc = editRates([block("occ_guard", 80, 12, 20, 8)]);
  expect(editFactorial(baseline, weakerRoute, weakerOcc, stronger).subAdditive).toBe(false);
  expect(editFactorial(baseline, occ, route, both).subAdditive).toBeNull();
  expect(editRates([block("baseline", 8, 2, 2, 1), block("route_guard", 8, 2, 2, 1)]).arm).toBeNull();
  expect(EDIT_EXPERIMENT_ARMS).toEqual(["baseline", "soft_guidance", "route_guard", "occ_guard", "combined_guard"]);
});

test("unknown counts, missing routes, unattributed writes and zero denominators are never zero-filled", () => {
  const known = block("baseline", 8, 2, 2, 1);
  expect(editRates([known, undefined]).B).toBeNull();
  expect(editRates([{ ...known, shellRoute: null }]).p).toBeNull();
  expect(editRates([{ ...known, editTool: { ...known.editTool!, blindOrStale: null } }]).bE).toBeNull();
  expect(editRates([{ ...known, unattributedTreeWrites: null }]).B).toBeNull();
  expect(editRates([{ ...known, unattributedTreeWrites: 1 }])).toMatchObject({ p: null, bE: null, bS: null, B: null });
  expect(editRates([block("baseline", 0, 0, 0, 0)]).p).toBeNull();
  expect(editRates([block("baseline", 2, 3, 2, 1)]).bE).toBeNull();
  expect(editRates([block("baseline", 2, 3, 2, 1), block("baseline", 100, 0, 2, 1)]).bE).toBeNull();
  expect(editRates([{ ...known, editTool: { ...known.editTool!, partialReadOnly: null } }]).bE).toBeNull();
  expect(editFactorial(editRates([]), editRates([known]), editRates([known]), editRates([known])).subAdditive).toBeNull();
});

test("grouping keeps only unambiguous owner-model-family rows and never exposes private records", () => {
  const row = { kind: "task", project: "p", task: 1, createdAt: "2026-01-01", pii: false, owners: ["peer"], class: "implement", ownerModels: [{ model: "m", evidence: "served" }], edits: block("baseline", 8, 2, 2, 1) } as TaskRecord;
  const result = groupEditRates([row, { ...row, task: 2, pii: true }, { ...row, task: 3, owners: ["peer", "other"] }, { ...row, task: 4, ownerModels: [] }, { ...row, task: 5, edits: { ...row.edits!, policyArm: "unknown" } }], peer => peer === "peer" ? "family" : undefined);
  expect(result.withheld).toBe(1); expect(result.unknown).toBe(3); expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({ family: "family", ownerModel: "m", taskClass: "implement", arm: "baseline", armEvidence: "last_observed", modelEvidence: ["served"], tasks: 1 });
  expect(groupEditRates([{ ...row, ownerModels: [{ model: "unknown", evidence: "configured" }] }], () => "family").unknown).toBe(1);
  expect(groupEditRates([{ ...row, ownerModels: [{ model: "bad model", evidence: "served" }] }], () => "family").unknown).toBe(1);
  expect(groupEditRates([{ ...row, ownerModels: [{ model: "m", evidence: "forged" as never }] }], () => "family").unknown).toBe(1);
  expect(groupEditRates([{ ...row, pii: undefined as never }], () => "family").withheld).toBe(1);
  expect(groupEditRates([row, { ...row, edits: block("baseline", 4, 1, 1, 1) }], () => "family").groups[0]?.tasks).toBe(1);
});

test("verified-success cost requires four evidenced components with identical task scope and units", async () => {
  const { editSuccessCost } = await import("../src/hub/research-experiments.ts");
  const component = (amount: number) => ({ amount, unit: "minutes", tasks: ["a", "b", "c"], evidence: "receipt" });
  const costs = { execution: component(12), verification: component(6), rework: component(3), human: component(3) };
  const success = { tasks: ["a", "b"], evidence: "verified outcomes" };
  expect(editSuccessCost(costs, success)).toEqual({ unit: "minutes", verifiedSuccesses: 2, execution: 6, verification: 3, rework: 1.5, human: 1.5, total: 12 });
  expect(editSuccessCost({ ...costs, human: undefined }, success)).toBeNull();
  expect(editSuccessCost({ ...costs, human: { ...costs.human, evidence: "" } }, success)).toBeNull();
  expect(editSuccessCost({ ...costs, human: { ...costs.human, unit: "tokens" } }, success)).toBeNull();
  expect(editSuccessCost({ ...costs, human: { ...costs.human, tasks: ["a", "b"] } }, success)).toBeNull();
  expect(editSuccessCost(costs, { tasks: [], evidence: "verified" })).toBeNull();
  expect(editSuccessCost(costs, { tasks: ["outside"], evidence: "verified" })).toBeNull();
  expect(editSuccessCost({ ...costs, rework: { ...costs.rework, amount: NaN } }, success)).toBeNull();
});

test("marginal benefit uses supplied costs and never chooses an arm", async () => {
  const { editMarginalBenefit } = await import("../src/hub/research-experiments.ts");
  const rates = editRates([block("baseline", 80, 16, 20, 10)]);
  const input = { reworkCost: 10, deltaP: 0.1, deltaBE: 0.05, deltaBS: 0.2, routePenalty: 0.1, occPenalty: 0.2 };
  const result = editMarginalBenefit(rates, input);
  expect(result.route).toBeCloseTo(0.2); expect(result.occ).toBeCloseTo(0.6);
  expect(editMarginalBenefit(rates, { ...input, reworkCost: null })).toEqual({ route: null, occ: null });
  expect(editMarginalBenefit(rates, { ...input, deltaBS: null }).occ).toBeNull();
});


test("dataset quality reports unavailable aggregate cost as unknown", async () => {
  const { buildResearchQuality } = await import("../src/hub/research-quality.ts");
  expect(buildResearchQuality([], []).fields["edits.costPerVerifiedSuccess"]).toEqual({ n: 0, unknown: 0, value: null });
  const { buildDataset } = await import("../src/hub/research-dataset.ts");
  const dataset = buildDataset({ project: { id: "p", root: "/tmp/p", stateDir: "/tmp/p" }, records: [], events: [] }, { now: () => 0 });
  expect(JSON.parse(JSON.stringify(dataset.quality)).fields["edits.costPerVerifiedSuccess"].value).toBeNull();
  const { taskRecords } = await import("../src/hub/research.ts");
  const { scenarioEvents, PROJECT } = await import("./helpers/research-fixture.ts");
  const rows = taskRecords(scenarioEvents(), PROJECT, { version: "test", source: "backfill" });
  const coverage = buildResearchQuality(rows, []).fields["edits.costPerVerifiedSuccess"]!;
  expect(coverage.n).toBeGreaterThan(0); expect(coverage.unknown).toBe(coverage.n); expect(coverage.value).toBeNull();
});

test("factorial groups never compare different family, owner model or class", async () => {
  const { editFactorialGroup } = await import("../src/hub/research-experiments.ts");
  const make = (arm: EditGovernanceBlock["policyArm"], task: number) => ({ kind: "task", project: "p", task, createdAt: "2026-01-01", pii: false, owners: ["peer"], class: "implement", ownerModels: [{ model: "m", evidence: "served" }], edits: block(arm, 8, 2, 2, 1) }) as TaskRecord;
  const groups = groupEditRates([make("baseline", 1), make("route_guard", 2), make("occ_guard", 3), make("combined_guard", 4)], () => "family").groups;
  const find = (arm: string) => groups.find(group => group.arm === arm)!;
  const baseline = find("baseline"), route = find("route_guard"), occ = find("occ_guard"), combined = find("combined_guard");
  expect(editFactorialGroup(baseline, route, occ, combined).subAdditive).toBe(false);
  expect(editFactorialGroup(baseline, { ...route, ownerModel: "different" }, occ, combined).subAdditive).toBeNull();
  expect(editFactorialGroup(baseline, { ...route, family: "different" }, occ, combined).subAdditive).toBeNull();
  expect(editFactorialGroup(baseline, { ...route, taskClass: "different" }, occ, combined).subAdditive).toBeNull();
});
