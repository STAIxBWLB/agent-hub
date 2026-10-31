import { expect, test } from "bun:test";
import { campaignHash, parseResearchCampaign, type ResearchCampaignContract, type ResearchUnit } from "../src/hub/research-campaign.ts";

const SOURCE_ONE = "src:0000000000000001", SOURCE_TWO = "src:0000000000000002";
const unit = (id: string, patch: Partial<ResearchUnit> = {}): ResearchUnit => ({ id, round: 0, question: "What does the evidence show?", perspective: "Check the evidence", requiredOutput: "A bounded evidence table", sourceIds: [SOURCE_ONE], dependsOn: [], purpose: "discovery", ...patch });
function contract(): ResearchCampaignContract {
  return {
    question: "Which explanation has the strongest support?", scope: "Compare the registered sources.", exclusions: ["New source ingestion"],
    sourceIds: [SOURCE_ONE, SOURCE_TWO], units: [unit("collect"), unit("synthesize", { dependsOn: ["collect"], purpose: "synthesis" })],
    deliverableSections: [{ id: "conclusion", title: "Synthesis", ownerUnitId: "synthesize" }],
    stopPolicy: { maxUnits: 8, maxFollowUpRounds: 2, deadline: "2030-02-28T07:30:00+09:00" },
  };
}

test("a bounded campaign preserves literal text, source/dependency order and a detached data snapshot", () => {
  const input = contract(); input.question = "  근거를 비교한다.\n반증도 포함한다.  ";
  input.units[0]!.adoptTaskId = 42;
  const parsed = parseResearchCampaign(input);
  expect(parsed).toEqual(input);
  expect(parsed).not.toBe(input);
  expect(parsed.units).not.toBe(input.units);
  input.sourceIds.reverse(); input.units[1]!.dependsOn.push("unbound"); input.question = "changed";
  expect(parsed.question).toBe("  근거를 비교한다.\n반증도 포함한다.  ");
  expect(parsed.sourceIds).toEqual([SOURCE_ONE, SOURCE_TWO]);
  expect(parsed.units[1]!.dependsOn).toEqual(["collect"]);
});

test("generated record fields and unknown fields are refused at every closed object boundary", () => {
  for (const field of ["id", "parentTaskId", "revision", "status", "executionBudgetId", "extra"]) {
    expect(() => parseResearchCampaign({ ...contract(), [field]: "caller data" }), field).toThrow(`campaign.${field}`);
  }
  for (const field of ["taskId", "owner", "extra"]) {
    const input = contract(); Object.assign(input.units[0]!, { [field]: 42 });
    expect(() => parseResearchCampaign(input), field).toThrow(`units[0].${field}`);
  }
  const stop = contract(); Object.assign(stop.stopPolicy, { approvedAt: 1 });
  expect(() => parseResearchCampaign(stop)).toThrow("stopPolicy.approvedAt");
  const section = contract(); Object.assign(section.deliverableSections[0]!, { owner: "synthesize" });
  expect(() => parseResearchCampaign(section)).toThrow("deliverableSections[0].owner");
  const budget = contract(); Object.assign(budget, { budget: { id: "cap", hardCap: [], exclusive: true } });
  expect(() => parseResearchCampaign(budget)).toThrow("budget.exclusive");
});

test("UTF-8 byte ceilings apply to question and short text, rather than UTF-16 character counts", () => {
  const input = contract(); input.question = "가".repeat(1365);
  input.deliverableSections[0]!.title = "가".repeat(170) + "ab";
  expect(parseResearchCampaign(input).question).toBe(input.question);
  input.question += "가";
  expect(() => parseResearchCampaign(input)).toThrow("campaign.question");
  input.question = "valid"; input.deliverableSections[0]!.title = "가".repeat(171);
  expect(() => parseResearchCampaign(input)).toThrow("deliverableSections[0].title");
  const scope = contract(); scope.scope = "x".repeat(4097);
  expect(() => parseResearchCampaign(scope)).toThrow("campaign.scope");
});

test("a structurally bounded field set cannot exceed the whole stored-body ceiling", () => {
  const input = contract(); input.stopPolicy.maxUnits = 32;
  input.units = Array.from({ length: 32 }, (_, index) => unit(`u${index}`, { question: "x".repeat(3000), purpose: index === 31 ? "synthesis" : "discovery" }));
  input.deliverableSections[0]!.ownerUnitId = "u31";
  expect(() => parseResearchCampaign(input)).toThrow("stored body exceeds 64 KiB");
});

test("source ids are exact, distinct and units may reference only the campaign source set", () => {
  for (const invalid of ["src:000000000000000", "src:000000000000000A", `${SOURCE_ONE}\n`, "../source"]) {
    const input = contract(); input.sourceIds = [invalid];
    expect(() => parseResearchCampaign(input), invalid).toThrow("campaign.sourceIds");
  }
  const outside = contract(); outside.units[0]!.sourceIds = ["src:0000000000000003"];
  expect(() => parseResearchCampaign(outside)).toThrow("must be a subset");
  const repeated = contract(); repeated.sourceIds.push(SOURCE_ONE);
  expect(() => parseResearchCampaign(repeated)).toThrow("duplicate");
  const unitRepeated = contract(); unitRepeated.units[0]!.sourceIds.push(SOURCE_ONE);
  expect(() => parseResearchCampaign(unitRepeated)).toThrow("duplicate");
});

test("unit and section identities are unique and match the strict id grammar", () => {
  for (const invalid of ["", "Uppercase", "../unit", "unit\n", "a".repeat(65)]) {
    const input = contract(); input.units[0]!.id = invalid;
    expect(() => parseResearchCampaign(input), invalid).toThrow("units[0].id");
  }
  const repeated = contract(); repeated.units[1]!.id = "collect";
  expect(() => parseResearchCampaign(repeated)).toThrow("campaign.units.id");
  const sections = contract(); sections.deliverableSections.push({ ...sections.deliverableSections[0]! });
  expect(() => parseResearchCampaign(sections)).toThrow("deliverableSections.id");
});

test("unknown, repeated, cyclic and later-round dependencies are refused with the dependency field", () => {
  const unknown = contract(); unknown.units[0]!.dependsOn = ["missing"];
  expect(() => parseResearchCampaign(unknown)).toThrow("unknown unit");
  const duplicate = contract(); duplicate.units[1]!.dependsOn = ["collect", "collect"];
  expect(() => parseResearchCampaign(duplicate)).toThrow("units[1].dependsOn");
  const cycle = contract(); cycle.units[0]!.dependsOn = ["synthesize"];
  expect(() => parseResearchCampaign(cycle)).toThrow("dependency cycle");
  const self = contract(); self.units[0]!.dependsOn = ["collect"];
  expect(() => parseResearchCampaign(self)).toThrow("dependency cycle");
  const future = contract(); future.units[0]!.dependsOn = ["synthesize"]; future.units[1]!.dependsOn = []; future.units[1]!.round = 1;
  expect(() => parseResearchCampaign(future)).toThrow("later round");
  const valid = contract(); valid.units[1]!.round = 1;
  expect(parseResearchCampaign(valid).units[1]!.dependsOn).toEqual(["collect"]);
});

test("each section has exactly one existing synthesis owner", () => {
  for (const ownerUnitId of ["missing", "collect"]) {
    const input = contract(); input.deliverableSections[0]!.ownerUnitId = ownerUnitId;
    expect(() => parseResearchCampaign(input), ownerUnitId).toThrow("existing synthesis unit");
  }
  const several = contract(); Object.assign(several.deliverableSections[0]!, { ownerUnitId: ["collect", "synthesize"] });
  expect(() => parseResearchCampaign(several)).toThrow("ownerUnitId");
});

test("adoption accepts one positive safe task id per unit, but never a caller-assigned task mapping", () => {
  const valid = contract(); valid.units[0]!.adoptTaskId = 123;
  expect(parseResearchCampaign(valid).units[0]!.adoptTaskId).toBe(123);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", null]) {
    const input = contract(); Object.assign(input.units[0]!, { adoptTaskId: invalid });
    expect(() => parseResearchCampaign(input), String(invalid)).toThrow("adoptTaskId");
  }
  const duplicate = contract(); duplicate.units[0]!.adoptTaskId = 123; duplicate.units[1]!.adoptTaskId = 123;
  expect(() => parseResearchCampaign(duplicate)).toThrow("campaign.units.adoptTaskId");
});

test("list counts and stop policy limits are structural, while approval-time checks remain outside this parser", () => {
  const exclusions = contract(); exclusions.exclusions = Array.from({ length: 33 }, () => "outside scope");
  expect(() => parseResearchCampaign(exclusions)).toThrow("campaign.exclusions");
  const sources = contract(); sources.sourceIds = Array.from({ length: 65 }, (_, index) => `src:${index.toString(16).padStart(16, "0")}`);
  expect(() => parseResearchCampaign(sources)).toThrow("campaign.sourceIds");
  const count = contract(); count.stopPolicy.maxUnits = 1;
  expect(() => parseResearchCampaign(count)).toThrow("exceeds stopPolicy.maxUnits");
  for (const round of [-1, 3, 6, 1.5]) {
    const input = contract(); input.units[0]!.round = round;
    expect(() => parseResearchCampaign(input)).toThrow("units[0].round");
  }
  for (const invalid of ["tomorrow", "2030-02-30T00:00:00Z", "2030-01-01T00:00:00", "2030-01-01", "2030-01-01T25:00:00Z", "2030-01-01T00:00:00Z\n"]) {
    const input = contract(); input.stopPolicy.deadline = invalid;
    expect(() => parseResearchCampaign(input), invalid).toThrow("stopPolicy.deadline");
  }
  const past = contract(); past.stopPolicy.deadline = "2000-02-29T00:00:00Z";
  expect(parseResearchCampaign(past).stopPolicy.deadline).toBe(past.stopPolicy.deadline);
});

test("budget references retain ledger ids and structural resource requests without claiming runtime enforcement", () => {
  const input = contract(); input.budget = { id: "Existing Budget/공동 한도", hardCap: ["model_calls", "tokens"] };
  expect(parseResearchCampaign(input).budget).toEqual(input.budget);
  input.budget = { id: "가".repeat(200), hardCap: [] };
  expect(parseResearchCampaign(input).budget).toEqual(input.budget);
  for (const budget of [{ id: "", hardCap: [] }, { id: "a".repeat(201), hardCap: [] }, { id: "cap", hardCap: ["model_calls", "model_calls"] }, { id: "cap", hardCap: ["gpu_ms"] }]) {
    expect(() => parseResearchCampaign({ ...contract(), budget })).toThrow("campaign.budget");
  }
});

test("unit, section, per-unit list and stop-policy count boundaries refuse whole", () => {
  for (const count of [0, 33]) {
    const input = contract(); input.stopPolicy.maxUnits = 32;
    input.units = Array.from({ length: count }, (_, index) => unit(`u${index}`));
    expect(() => parseResearchCampaign(input)).toThrow("campaign.units");
  }
  const sections = contract(); sections.deliverableSections = Array.from({ length: 33 }, (_, index) => ({ id: `s${index}`, title: "Section", ownerUnitId: "synthesize" }));
  expect(() => parseResearchCampaign(sections)).toThrow("campaign.deliverableSections");
  const sources = contract(); sources.sourceIds = Array.from({ length: 17 }, (_, index) => `src:${index.toString(16).padStart(16, "0")}`); sources.units[0]!.sourceIds = [...sources.sourceIds];
  expect(() => parseResearchCampaign(sources)).toThrow("campaign.units[0].sourceIds");
  const deps = contract(); deps.stopPolicy.maxUnits = 32;
  deps.units = Array.from({ length: 18 }, (_, index) => unit(`u${index}`, { dependsOn: index === 0 ? Array.from({ length: 17 }, (_, n) => `u${n + 1}`) : [] }));
  expect(() => parseResearchCampaign(deps)).toThrow("campaign.units[0].dependsOn");
  for (const maxUnits of [0, 33]) expect(() => parseResearchCampaign({ ...contract(), stopPolicy: { ...contract().stopPolicy, maxUnits } })).toThrow("campaign.stopPolicy.maxUnits");
  expect(() => parseResearchCampaign({ ...contract(), stopPolicy: { ...contract().stopPolicy, maxFollowUpRounds: 6 } })).toThrow("campaign.stopPolicy.maxFollowUpRounds");
});

test("campaign hashes bind literal fields and list order while ignoring object insertion order", () => {
  const input = contract(), parsed = parseResearchCampaign(input), digest = campaignHash(parsed);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(campaignHash(parseResearchCampaign(reordered))).toBe(digest);
  const changed = contract(); changed.units[0]!.question += " Check another hypothesis.";
  expect(campaignHash(changed)).not.toBe(digest);
  const orderedSources = contract(); orderedSources.sourceIds.reverse();
  expect(campaignHash(orderedSources)).not.toBe(digest);
});

test("accessors, custom objects and sparse lists are refused without invoking caller code", () => {
  let invoked = false;
  const input = contract(); Object.defineProperty(input, "question", { enumerable: true, get: () => { invoked = true; return "getter"; } });
  expect(() => parseResearchCampaign(input)).toThrow("plain data object"); expect(invoked).toBe(false);
  expect(() => parseResearchCampaign(new Date())).toThrow("plain data object");
  const sparse = contract(); sparse.sourceIds = new Array(1);
  expect(() => parseResearchCampaign(sparse)).toThrow("dense data list");
});
