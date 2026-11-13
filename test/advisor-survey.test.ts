import { expect, test } from "bun:test";
import { parseSurveyFindings, parseSurveyVetDecisions, publicSurveyCard, publicSurveyFinding, surveyBrief, surveyCards, surveyFindingKey, surveyInputProblem } from "../src/hub/advisor-survey.ts";

const finding = { id: "bounded-survey-parser", evidence: "src/hub/parser.ts:12", paths: ["src/hub/parser.ts"], impact: "Incorrect data accepted", effort: "S", risk: "Small behavioral change", confidence: "high", fix_sketch: "Validate the boundary" };

test("survey findings normalize the pass and require explicit vetting before confidence selects a card class", () => {
  expect(parseSurveyFindings([finding])[0]?.pass).toBe("bugs");
  expect(surveyCards("owner/repo", [finding], [])).toEqual([]);
  const high = surveyCards("owner/repo", [finding], [{ id: finding.id, verdict: "vetted" }]);
  expect(high[0]?.class).toBe("plan"); expect(high[0]?.readOnly).toBe(true);
  expect(high[0]?.key).toBe(`Survey finding key: 65e817eec8cd71edae741f73b5aa07d98e8f79c623a5f05014f1a88f89fb089c:bugs:${finding.id}`);
  for (const confidence of ["medium", "low"]) {
    const cards = surveyCards("owner/repo", [{ ...finding, confidence }], [{ id: finding.id, verdict: "vetted" }]);
    expect(cards[0]?.class).toBe(confidence === "low" ? "triage" : "plan");
  }
  expect(surveyCards("owner/repo", [finding], [{ id: finding.id, verdict: "rejected", reason: "Already covered" }])).toEqual([]);
  expect(() => parseSurveyVetDecisions([{ id: finding.id, verdict: "rejected" }])).toThrow();
  expect(() => parseSurveyVetDecisions([{ id: finding.id, verdict: "rejected", reason: "line one\nline two" }])).toThrow();
  expect(() => surveyCards("owner/repo", [finding], [{ id: "another-semantic-finding", verdict: "vetted" }])).toThrow();
});

test("cross-task identity rejects positional ids and scopes semantic ids by host repo and pass", () => {
  for (const id of ["N1", "F5", "3", "bugs:1", "nit-1"]) expect(() => parseSurveyFindings([{ ...finding, id }])).toThrow();
  expect(surveyFindingKey("repo-a", "bugs", finding.id)).not.toBe(surveyFindingKey("repo-b", "bugs", finding.id));
  expect(surveyFindingKey("repo-a", "bugs", finding.id)).not.toBe(surveyFindingKey("repo-a", "security", finding.id));
});

test("security public findings, cards and briefs withhold all finding text and paths", () => {
  const secret = "SECRET_VALUE_CANARY", raw = { ...finding, pass: "security", paths: [secret], evidence: `${secret}:1`, impact: secret, risk: secret, fix_sketch: secret };
  const parsed = parseSurveyFindings([raw])[0]!;
  expect(publicSurveyFinding(parsed)).toEqual({ id: finding.id, pass: "security", withheld: true });
  const card = surveyCards("repo", [parsed], [{ id: finding.id, verdict: "vetted" }])[0]!;
  expect(JSON.stringify(publicSurveyCard(card))).not.toContain(secret);
  expect(surveyBrief({ pass: "security", focus: "bugs" })).not.toContain(secret);
  expect(surveyBrief({ focus: "tests" })).toContain("Read-only");
  expect(() => surveyBrief({ focus: secret as "bugs" })).toThrow();
  expect(surveyFindingKey(secret, "bugs", finding.id)).not.toContain(secret);
});

test("closed survey parser refuses executable shapes without invoking getters, proxies or subclass methods", () => {
  let effects = 0;
  const getter = { ...finding }; Object.defineProperty(getter, "impact", { enumerable: true, get() { effects++; return "executed"; } });
  const proxy = new Proxy(finding, { ownKeys() { effects++; return []; } });
  const custom = [finding]; Object.setPrototypeOf(custom, Object.create(Array.prototype, { map: { get() { effects++; return Array.prototype.map; } } }));
  class ExecutableArray extends Array { static get [Symbol.species]() { effects++; return Array; } }
  const subclass = new ExecutableArray(); subclass.push(finding);
  const sparse = new Array(1), symbol = { ...finding, [Symbol("hidden")]: true };
  for (const input of [[getter], [proxy], custom, subclass, sparse, [symbol], [{ ...finding, toJSON() { effects++; return {}; } }]])
    expect(() => parseSurveyFindings(input)).toThrow();
  expect(effects).toBe(0);
});

test("survey bounds and literal evidence path membership cannot be bypassed", () => {
  for (const paths of [["../escape"], ["/absolute"], ["src//a"], ["src/./a"], ["src/../a"], ["C:\\absolute"], ["other.ts"], ["src/hub/parser.ts", "src/hub/parser.ts"]])
    expect(() => parseSurveyFindings([{ ...finding, paths }])).toThrow();
  for (const evidence of ["src/hub/parser.ts:0", "src/hub/parser.ts:-1", "src/hub/parser.ts:9007199254740992", "src/hub/parser.ts", "src/hub/parser.ts:1\nsecret"])
    expect(() => parseSurveyFindings([{ ...finding, evidence }])).toThrow();
  expect(() => parseSurveyFindings([{ ...finding, impact: "x".repeat(2049) }])).toThrow();
  expect(() => parseSurveyFindings(Array.from({ length: 65 }, (_, i) => ({ ...finding, id: `semantic-finding-${i}` })))).toThrow();
  expect(() => parseSurveyFindings(Array.from({ length: 32 }, (_, i) => ({ ...finding, id: `semantic-finding-${i}`, impact: "x".repeat(2048) })))).toThrow();
  expect(() => parseSurveyFindings([finding, finding])).toThrow();
  expect(() => parseSurveyFindings([{ ...finding, repo: "caller-selected-repo" }])).toThrow();
  expect(parseSurveyFindings([{ ...finding, evidence: "src/literal*.ts:1", paths: ["src/literal*.ts"] }])[0]?.paths).toEqual(["src/literal*.ts"]);
});


test("survey parser attaches fixed field/rule metadata without changing its generic storage errors", () => {
  const cases: [unknown, string][] = [
    [[finding, finding], "findings[].id"], [[{ ...finding, id: "N1" }], "findings[].id"],
    [[{ ...finding, evidence: "src/hub/parser.ts:0" }], "findings[].evidence"], [[{ ...finding, paths: ["src/other.ts"] }], "findings[].paths"],
    [[{ ...finding, effort: "PRIVATE_ENUM_CANARY" }], "findings[].effort"], [[{ ...finding, confidence: "PRIVATE_ENUM_CANARY" }], "findings[].confidence"],
    [[{ ...finding, pass: "PRIVATE_ENUM_CANARY" }], "findings[].pass"], [[{ ...finding, impact: "x".repeat(2049) }], "findings[].impact"],
    [Array.from({ length: 65 }, (_, i) => ({ ...finding, id: `semantic-${i}` })), "findings"],
    [Array.from({ length: 32 }, (_, i) => ({ ...finding, id: `semantic-${i}`, impact: "x".repeat(2048) })), "findings"],
    [[{ ...finding, PRIVATE_UNKNOWN_KEY_CANARY: true }], "findings[]"],
  ];
  for (const [input, field] of cases) {
    let error: unknown; try { parseSurveyFindings(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); const problem = surveyInputProblem(error)!; expect(problem.field).toBe(field);
    expect(problem.rule.length).toBeGreaterThan(0); expect(JSON.stringify(problem)).not.toMatch(/PRIVATE_ENUM_CANARY|PRIVATE_UNKNOWN_KEY_CANARY/);
  }
  expect(() => parseSurveyFindings([{ ...finding, effort: "bad" }])).toThrow("invalid bounded survey data");
});
