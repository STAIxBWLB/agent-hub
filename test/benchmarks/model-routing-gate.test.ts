import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRouting } from "../../src/hub/routing.ts";
import { ADVISOR_REVIEWER_PROMPT, ESCALATION_PROMPT } from "../../src/models/route/prompts.ts";
import { changedModelKeys, compare, evaluate, freezeModelCorpus, isDeterministic, liveRequired, loadModelCorpus, modelCorpusHash, modelRoutingSha, modelRoutingSummary, runCase, validateModelCorpus, type JudgeCase, type ModelRoutingCorpus } from "../../scripts/benchmarks/model-routing-corpus.ts";
import { gatewayChat, main, runLive, type JudgeChat } from "../../scripts/benchmarks/model-routing-gate.ts";
import { LIVE_NOT_RUN, compareLive, liveProblem, parseModelReceipt, scoreLive, type LiveEvidence } from "../../scripts/benchmarks/model-routing-receipt.ts";

// agent-hub #637 part 2 (hub task #324): the frozen model-routing corpus, its deterministic gate and the --live contract. Spec: issue #637, "Model-routing promotion rule" in docs/agent-notes/benchmarks.md.
const ROOT = join(import.meta.dir, "../..");
const CORPUS = join(ROOT, "scripts/benchmarks/model-routing-corpus.json"); // names /scripts/benchmarks/model-routing-corpus.json" for scripts/changed-tests.mjs
const TEMPLATE_TEXT = readFileSync(join(ROOT, "templates/routing.toml"), "utf8");
const corpus = (): ModelRoutingCorpus => loadModelCorpus(CORPUS);
const raw = (): ModelRoutingCorpus => JSON.parse(readFileSync(CORPUS, "utf8"));
const edited = (from: string, to: string) => { expect(TEMPLATE_TEXT).toContain(from); return TEMPLATE_TEXT.replace(from, to); };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-model-routing-gate-")); dirs.push(dir); return dir; };
const refreeze = (c: ModelRoutingCorpus): ModelRoutingCorpus => ({ ...c, hash: modelCorpusHash(c) });
const base = () => parseRouting(TEMPLATE_TEXT);

test("the corpus has a split, a content hash, both guards on both splits, every case kind, and a note naming each rule", () => {
  const c = corpus();
  expect(c.surface).toBe("model-routing");
  expect(c.hash).toBe(modelCorpusHash(c));
  expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(c.cases.length).toBeGreaterThanOrEqual(40);
  for (const split of ["train", "test"] as const) {
    const rows = c.cases.filter(row => row.split === split);
    expect(rows.filter(isDeterministic).length, `${split} deterministic`).toBeGreaterThanOrEqual(15);
    expect(rows.some(row => row.guard === "pii" && isDeterministic(row)), `${split} pii guard`).toBe(true);
    expect(rows.some(row => row.guard === "hard_override" && isDeterministic(row)), `${split} hard-override guard`).toBe(true);
    expect(rows.some(row => row.kind === "judge"), `${split} judge case`).toBe(true);
  }
  expect(c.cases.some(row => row.split === "test" && row.guard === "injection" && row.kind === "judge")).toBe(true);
  expect(new Set(c.cases.map(row => row.id)).size).toBe(c.cases.length);
  expect(new Set(c.cases.map(row => row.kind))).toEqual(new Set(["route", "selection", "judge"]));
  // every route type the shipped policy has is exercised, and every route named is one the shipped template defines
  const routes = Object.keys(base().hub_routes ?? {});
  expect(new Set(c.cases.filter(row => row.kind !== "selection").map(row => (row as { route: string }).route))).toEqual(new Set(routes));
  for (const row of c.cases) expect(row.note.length, row.id).toBeGreaterThan(20);
});

test("the shipped default scores 100% on both splits: the corpus is written from the documented rules and the code agrees", async () => {
  for (const split of ["train", "test"] as const) {
    const rows = await evaluate(corpus(), base(), split);
    expect(rows.length).toBeGreaterThan(14);
    expect(rows.filter(row => !row.score.pass).map(row => `${row.id}: ${row.score.detail}`)).toEqual([]);
  }
});

test("the gate script prints the numbers with exit 0 and no model call, and judge cases are never scored in CI", async () => {
  const ok = Bun.spawnSync([process.execPath, join(ROOT, "scripts/benchmarks/model-routing-gate.ts")], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("deterministic case pass rate: 100.0%");
  expect(ok.stdout.toString()).toContain("judge, scored only by --live");
  const judge = corpus().cases.find(c => c.kind === "judge")!;
  expect(await runCase(judge, base())).toEqual({ error: "a judge case is scored only by the live receipt" });
  expect((await evaluate(corpus(), base(), "test")).some(row => row.kind === "judge")).toBe(false);
});

// ---- the corpus is a measuring stick: validation refuses what would make it measure nothing ----
const REFUSED: [string, (c: ModelRoutingCorpus) => void, RegExp][] = [
  ["a duplicate id", c => { c.cases[1]!.id = c.cases[0]!.id; }, /duplicate id/],
  ["a case without a note", c => { c.cases[0]!.note = " "; }, /note naming the rule/],
  ["a bad id", c => { c.cases[0]!.id = "Has Spaces"; }, /id is lower-case/],
  ["an unknown split", c => { (c.cases[0] as { split: string }).split = "dev"; }, /split is train or test/],
  ["an unknown kind", c => { (c.cases[0] as { kind: string }).kind = "vibe"; }, /kind is route, selection or judge/],
  ["a turn that states nothing", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { expect: object }[] }).turns[0]!.expect = {}; }, /states at least one field/],
  ["an expectation field nobody scores", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { expect: object }[] }).turns[0]!.expect = { vibes: 1 }; }, /unknown expect field vibes/],
  ["a tier that is not a tier", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { expect: object }[] }).turns[0]!.expect = { tier: "medium" }; }, /tier is efficient or capable/],
  ["a message with no role", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { messages: object[] }[] }).turns[0]!.messages = [{ content: "x" }]; }, /needs a role/],
  ["a tool message with no call id", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { messages: object[] }[] }).turns[0]!.messages = [{ role: "tool", content: "x" }]; }, /tool_call_id/],
  ["a tool call whose arguments are not a JSON string", c => { const r = c.cases.find(x => x.kind === "route")!; (r as { turns: { messages: object[] }[] }).turns[0]!.messages = [{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: { path: "x" } } }] }]; }, /arguments: <JSON string>/],
  ["a judge case whose expectation is no verdict class", c => { const j = c.cases.find(x => x.kind === "judge" && x.judge === "advisor")!; (j as { expect: object }).expect = { verdict: "maybe" }; }, /advisor case expects approve or redo/],
  ["an escalation judge case without a boolean", c => { const j = c.cases.find(x => x.kind === "judge" && x.judge === "escalation")!; (j as { expect: object }).expect = { escalate: "yes" }; }, /expects \{escalate: boolean\}/],
  ["a test split with no PII guard case", c => { c.cases = c.cases.filter(x => !(x.split === "test" && x.guard === "pii")); }, /test split needs at least one deterministic pii guard case/],
  ["a train split with no hard-override guard case", c => { c.cases = c.cases.filter(x => !(x.split === "train" && x.guard === "hard_override")); }, /train split needs at least one deterministic hard_override guard case/],
  ["a PII guard that only a judge case carries", c => { for (const x of c.cases) if (x.split === "test" && x.guard === "pii") x.guard = undefined as never; const j = c.cases.find(x => x.split === "test" && x.kind === "judge")!; j.guard = "pii"; }, /test split needs at least one deterministic pii guard case/],
  ["a test split without the injection judge case", c => { for (const x of c.cases) if (x.guard === "injection") x.guard = undefined as never; }, /injection/],
  ["a split with no judge case", c => { c.cases = c.cases.filter(x => !(x.split === "train" && x.kind === "judge")); }, /train split needs at least one judge case/],
];
for (const [name, mutate, message] of REFUSED) {
  test(`validation refuses ${name}`, () => {
    const c = raw();
    mutate(c);
    expect(() => validateModelCorpus(refreeze(c))).toThrow(message);
  });
}
test("a corpus edited without a refreeze fails its hash; --freeze rewrites it, and a corpus that no longer validates is not frozen", () => {
  const dir = temp(), file = join(dir, "c.json");
  const c = raw();
  c.cases[0]!.note = "A reworded note that changes the content hash of the corpus.";
  writeFileSync(file, JSON.stringify(c));
  expect(() => loadModelCorpus(file)).toThrow(/hash mismatch/);
  expect(freezeModelCorpus(file).stale).toBe(true);
  expect(loadModelCorpus(file).hash).toBe(modelCorpusHash(c));
  expect(freezeModelCorpus(file).stale).toBe(false);
  const broken = raw(); broken.cases[1]!.id = broken.cases[0]!.id;
  writeFileSync(file, JSON.stringify(broken));
  expect(() => freezeModelCorpus(file)).toThrow(/duplicate id/);
  expect(() => validateModelCorpus(null)).toThrow();
  expect(() => validateModelCorpus({ version: 2 })).toThrow(/version 1/);
});

// ---- the corpus discriminates: each default change a reviewer could plausibly make flips the case that documents the rule ----
const FLIPS: [string, string, string, string[], boolean][] = [
  ["a shorter capable hold", "hold_turns = 2", "hold_turns = 0", ["stage-hold-after-override"], false],
  ["a higher confidence threshold", "confidence_threshold = 0.5", "confidence_threshold = 0.99", ["stage-many-different-failures-capable-by-dimensions"], false],
  ["a lower confidence threshold", "confidence_threshold = 0.5", "confidence_threshold = 0.3", ["stage-spinning-below-threshold-stays-efficient"], false],
  ["stay_switch off", 'stay_switch = "shadow"', 'stay_switch = "off"', ["stage-records-shadow-plan"], false],
  ["stay_switch enforce", 'stay_switch = "shadow"', 'stay_switch = "enforce"', ["stage-records-shadow-plan"], false],
  ["another default local route", 'route = "hub/stage"             #', 'route = "hub/plan"             #', ["select-unlisted-class-takes-local-default"], false],
  ["a heavier alias for bulk_edit", 'fixed_model = "fast"', 'fixed_model = "coding"', ["select-bulk-edit-fixed-alias"], false],
  ["more advisor reviews", "max_reviews = 1", "max_reviews = 2", ["advisor-max-reviews-one"], false],
  ["an advisor that reviews before any tool ran", "gate_min_tool_results = 1", "gate_min_tool_results = 0", ["advisor-answer-before-any-tool-not-reviewed"], false],
  ["one escalation confirmation", "confirmations = 2", "confirmations = 1", ["escalation-two-fresh-confirmations-latch"], false],
  ["plan_execute turned into a stage route", 'type = "plan_execute"', 'type = "stage"', ["plan-read-only-plans-on-capable"], false],
  ["the stage route turned into an advisor", 'type = "stage"', 'type = "advisor"', ["stage-import-error-then-repeat-capable", "stage-critical-oom-capable"], true],
];
for (const [name, from, to, flips, guard] of FLIPS) {
  test(`${name} blocks, naming ${flips[0]}${guard ? " as a hard-override regression" : ""}`, async () => {
    const result = await compare(corpus(), base(), parseRouting(edited(from, to)), "test");
    expect(result.verdict).toBe("blocked");
    for (const id of flips) expect(result.regressions, id).toContain(id);
    expect(result.guardRegressions.length > 0).toBe(guard);
    if (guard) expect(result.reasons.join(" ")).toContain("PII or hard-override");
  });
}
test("a change the corpus cannot see passes: a comment, swapped aliases (the tiers are read against the route's own aliases), and the same policy", async () => {
  for (const candidate of [edited("# agent-hub routing:", "# agent-hub routing (reworded):"), edited('efficient = "fast"\ncapable = "coding"\nconfidence_threshold', 'efficient = "coding"\ncapable = "fast"\nconfidence_threshold'), TEMPLATE_TEXT]) {
    const result = await compare(corpus(), base(), parseRouting(candidate), "test");
    expect(result.verdict).toBe("pass");
    expect(result.regressions).toEqual([]);
    expect(result.reasons).toEqual([]);
  }
});
test("a policy that lacks a route the corpus asks about is an error case that fails, never a pass or an exception", async () => {
  const result = await compare(corpus(), base(), parseRouting(edited('[hub_routes."hub/plan"]', '[hub_routes."hub/plan2"]')), "test");
  expect(result.verdict).toBe("blocked");
  expect(JSON.stringify(result.cases.find(row => row.id === "plan-read-only-plans-on-capable")!.candidate)).toContain("the policy has no route hub/plan");
});
test("an improvement is reported and does not block: a candidate that fixes a case the default fails", async () => {
  const worse = parseRouting(edited("hold_turns = 2", "hold_turns = 0"));
  const result = await compare(corpus(), worse, base(), "test");
  expect(result.verdict).toBe("pass");
  expect(result.improvements).toContain("stage-hold-after-override");
});
test("the PII twin: a PII conversation's route event carries no prefill size, an ordinary one does, so the first is not passing on an empty trace", async () => {
  const rows = await evaluate(corpus(), base(), "test");
  const pii = rows.find(row => row.id === "stage-pii-trace-has-no-prefill")!, ordinary = (await evaluate(corpus(), base(), "train")).find(row => row.id === "stage-ordinary-trace-has-prefill")!;
  expect(pii.score.pass && ordinary.score.pass).toBe(true);
  expect((pii.result as { turns: { prefillRecorded: boolean }[] }).turns[0]!.prefillRecorded).toBe(false);
  expect((ordinary.result as { turns: { prefillRecorded: boolean }[] }).turns[0]!.prefillRecorded).toBe(true);
});
test("a PII conversation makes no judge call without a campus gateway, and an ordinary one does: the advisor and escalation guards", async () => {
  const rows = [...(await evaluate(corpus(), base(), "test")), ...(await evaluate(corpus(), base(), "train"))];
  const turn = (id: string) => (rows.find(row => row.id === id)!.result as { turns: { judgeCalls: number }[] }).turns[0]!.judgeCalls;
  expect(turn("advisor-pii-without-campus-no-judge")).toBe(0);
  expect(turn("escalation-pii-without-campus-no-judge")).toBe(0);
  expect(turn("advisor-pii-on-campus-reviewed")).toBe(1);
  expect(turn("advisor-held-answer-reviewed")).toBe(1);
});

// ---- the model-routing keys: what a change must be scoped by ----
test("the model-routing summary reads the keys that pick a model and ignores task-routing keys: peers, signals, constraints", () => {
  const summary = JSON.stringify(modelRoutingSummary(base()));
  for (const key of ["hub_routes", "hub/stage", "fixed_model", "stay_switch", "max_switch_prefill_tokens", "dgx_max_context_tokens"]) expect(summary).toContain(key);
  expect(summary).not.toContain("peers");
  const taskOnly = parseRouting(edited('peers = ["claude", "codex"]\nlocal_allowed = false\n\n[classes.implement]', 'peers = ["codex", "claude"]\nlocal_allowed = false\n\n[classes.implement]'));
  expect(modelRoutingSha(taskOnly)).toBe(modelRoutingSha(base()));
  expect(modelRoutingSha(parseRouting(edited("hold_turns = 2", "hold_turns = 3")))).not.toBe(modelRoutingSha(base()));
});
test("changed keys are dotted paths, and an alias or judge change needs the live half while a threshold change does not", () => {
  const a = modelRoutingSummary(base());
  const aliases = changedModelKeys(a, modelRoutingSummary(parseRouting(edited('type = "advisor"\nefficient = "fast"\ncapable = "coding"', 'type = "advisor"\nefficient = "fast"\ncapable = "fast"'))));
  expect(aliases).toEqual(["hub_routes.hub/advisor.capable"]);
  expect(liveRequired(aliases)).toBe(true);
  const hold = changedModelKeys(a, modelRoutingSummary(parseRouting(edited("hold_turns = 2", "hold_turns = 3"))));
  expect(hold).toEqual(["hub_routes.hub/stage.hold_turns"]);
  expect(liveRequired(hold)).toBe(false);
  expect(liveRequired(["hub_routes.hub/stage.judge"])).toBe(true);
  expect(liveRequired(["hub_routes.hub/advisor.transcript_max_chars"])).toBe(true);
  expect(changedModelKeys(a, a)).toEqual([]);
});

// ---- --live ----
const advisorId = "judge-advisor-injection-ignored";
function fakeChat(answer: (alias: string, system: string) => { content: string; servedModel?: string } | Error): { chat: JudgeChat; asked: { alias: string; system: string }[] } {
  const asked: { alias: string; system: string }[] = [];
  return { asked, chat: async (alias, messages) => { const system = messages[0]!.content as string; asked.push({ alias, system }); const r = answer(alias, system); if (r instanceof Error) throw r; return r; } };
}
const sound = (alias: string, system: string) => system.startsWith("You are a senior reviewer") ? { content: "REDO: show the test run", servedModel: `served/${alias}-v1` } : { content: JSON.stringify({ escalate: false, category: "none", new_evidence: false, reason: "ok" }), servedModel: `served/${alias}-v1` };

test("--live asks each policy's real judge alias with the real prompts and records the served ids from the response, never the alias", async () => {
  const { chat, asked } = fakeChat(sound);
  const candidate = parseRouting(edited('type = "advisor"\nefficient = "fast"\ncapable = "coding"', 'type = "advisor"\nefficient = "fast"\ncapable = "fast"'));
  const live = await runLive(corpus(), base(), candidate, chat, "test");
  const judges = corpus().cases.filter((c): c is JudgeCase => c.kind === "judge" && c.split === "test");
  expect(live.cases.map(c => c.id)).toEqual(judges.map(c => c.id));
  expect(asked.length).toBe(judges.length * 2);
  expect(asked.some(a => a.system === ADVISOR_REVIEWER_PROMPT) && asked.some(a => a.system === ESCALATION_PROMPT)).toBe(true);
  expect(live.served_models).toEqual({ coding: ["served/coding-v1"], fast: ["served/fast-v1"] });
  const injected = live.cases.find(c => c.id === advisorId)!;
  expect(injected.base).toEqual({ alias: "coding", verdict: "redo" });
  expect(injected.candidate).toEqual({ alias: "fast", verdict: "redo" });
  expect(liveProblem(corpus(), base(), candidate, live)).toBeUndefined();
  expect(compareLive(corpus(), live).verdict).toBe("pass");
});
test("--live refuses to treat an answer as evidence when the gateway names no served model or names the alias", async () => {
  for (const [name, answer, message] of [
    ["no served model", () => ({ content: "REDO: x" }), "no served model"],
    ["the alias as the served model", (alias: string) => ({ content: "REDO: x", servedModel: alias }), "reported the alias"],
    ["a failed call", () => new Error("HTTP 503"), "the call failed: HTTP 503"],
  ] as const) {
    const live = await runLive(corpus(), base(), base(), fakeChat(answer as never).chat, "test");
    expect(live.cases.every(c => "error" in c.base && c.base.error.includes(message)), name).toBe(true);
    expect(live.served_models, name).toEqual({});
    expect(liveProblem(corpus(), base(), base(), live), name).toContain("has no answer");
  }
});
test("a verdict that does not parse is recorded as unparsed and scores as a miss, never as the expected verdict", async () => {
  const live = await runLive(corpus(), base(), base(), fakeChat((alias, system) => ({ content: system.startsWith("You are a senior") ? "I think it is fine" : "escalate maybe", servedModel: `served/${alias}` })).chat, "test");
  expect(live.cases.find(c => c.id === advisorId)!.base).toMatchObject({ verdict: "unparsed" });
  const escalation = live.cases.find(c => c.id === "judge-escalation-single-failure-decline")!;
  expect(escalation.base).toMatchObject({ escalate: "unparsed" });
  const judges = corpus().cases.filter((c): c is JudgeCase => c.kind === "judge");
  expect(judges.every(c => !scoreLive(c, live.cases.find(row => row.id === c.id)?.base ?? { alias: "x", error: "none" }))).toBe(true);
});
test("the live scorer reads the expected class: a right verdict passes, a wrong one, a wrong kind and an error do not", () => {
  const advisor = corpus().cases.find((c): c is JudgeCase => c.kind === "judge" && c.id === advisorId)!;
  expect(scoreLive(advisor, { alias: "coding", verdict: "redo" })).toBe(true);
  expect(scoreLive(advisor, { alias: "coding", verdict: "approve" })).toBe(false);
  expect(scoreLive(advisor, { alias: "coding", escalate: true })).toBe(false);
  expect(scoreLive(advisor, { alias: "coding", error: "x" })).toBe(false);
  const escalation = corpus().cases.find((c): c is JudgeCase => c.kind === "judge" && c.id === "judge-escalation-single-failure-decline")!;
  expect(scoreLive(escalation, { alias: "coding", escalate: false })).toBe(true);
  expect(scoreLive(escalation, { alias: "coding", escalate: true })).toBe(false);
  expect(scoreLive(escalation, { alias: "coding", verdict: "redo" })).toBe(false);
});
test("the live comparison blocks a candidate judge that passes fewer cases, and any guard judge case the default passed that it fails", async () => {
  const good = await runLive(corpus(), base(), base(), fakeChat((alias, system) => ({ content: system.startsWith("You are a senior") ? "REDO: x" : JSON.stringify({ escalate: false, category: "none", new_evidence: false, reason: "r" }), servedModel: `served/${alias}` })).chat, "test");
  expect(compareLive(corpus(), good).verdict).toBe("pass");
  const approvesInjection: LiveEvidence = { ...good, cases: good.cases.map(c => (c.id === advisorId ? { ...c, candidate: { alias: "coding", verdict: "approve" as const } } : c)) };
  const blocked = compareLive(corpus(), approvesInjection);
  expect(blocked.verdict).toBe("blocked");
  expect(blocked.guardRegressions).toEqual([advisorId]);
  expect(blocked.reasons.join(" ")).toContain("regressed guard judge case");
});
test("a live block must name what the policy asks: wrong alias, missing or extra served ids, the alias as served id, a bad id, the wrong cases", async () => {
  const live = await runLive(corpus(), base(), base(), fakeChat(sound).chat, "test");
  const clone = (): LiveEvidence => JSON.parse(JSON.stringify(live));
  const problem = (l: unknown) => liveProblem(corpus(), base(), base(), l);
  expect(problem(live)).toBeUndefined();
  expect(problem(undefined)).toContain("missing");
  expect(problem({ cases: [] })).toContain("served_models is an object");
  expect(problem({ served_models: {} })).toContain("no cases");
  expect(problem({ ...live, cases: live.cases.slice(1) })).toContain("exactly the corpus's test judge cases");
  const wrongAlias = clone(); (wrongAlias.cases[0]!.base as { alias: string }).alias = "fast";
  expect(problem(wrongAlias)).toContain("must name the judge alias");
  const noServed = clone(); delete noServed.served_models.coding;
  expect(problem(noServed)).toContain("no served model id is recorded for alias coding");
  const selfServed = clone(); selfServed.served_models.coding = ["coding"];
  expect(problem(selfServed)).toContain("is the alias itself");
  const badId = clone(); badId.served_models.coding = ["has spaces; rm -rf"];
  expect(problem(badId)).toContain("is not a model id");
  const extra = clone(); extra.served_models.ghost = ["served/ghost"];
  expect(problem(extra)).toContain("no judge case asked: ghost");
  const wrongKind = clone(); wrongKind.cases[0]!.base = { alias: "coding", escalate: true } as never;
  expect(problem(wrongKind)).toContain("wrong kind");
  const both = clone(); (both.cases[0]!.base as Record<string, unknown>).error = "x";
  expect(problem(both)).toContain("one of a verdict, an escalate flag or an error");
  const badVerdict = clone(); (badVerdict.cases[0]!.base as Record<string, unknown>).verdict = "maybe";
  expect(problem(badVerdict)).toContain("approve, redo or unparsed");
});
test("--live without a gateway or key refuses before any request, in the factory and in the script", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { calls.push(String(url)); throw new Error("no network in this test"); }) as never;
  const saved = { url: process.env.AGENTHUB_OMNIROUTE_URL, key: process.env.OMNIROUTE_API_KEY };
  try {
    expect(() => gatewayChat({})).toThrow(/needs AGENTHUB_OMNIROUTE_URL and OMNIROUTE_API_KEY/);
    expect(() => gatewayChat({ AGENTHUB_OMNIROUTE_URL: "http://127.0.0.1:1/v1" })).toThrow(/no request was made/);
    expect(() => gatewayChat({ OMNIROUTE_API_KEY: "k" })).toThrow(/no request was made/);
    expect(() => gatewayChat({ AGENTHUB_OMNIROUTE_URL: " ", OMNIROUTE_API_KEY: " " })).toThrow(/needs/);
    delete process.env.AGENTHUB_OMNIROUTE_URL; delete process.env.OMNIROUTE_API_KEY;
    const dir = temp();
    expect(await main({ args: ["--receipt", "--live", "--out", join(dir, "r.md")] })).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.url !== undefined) process.env.AGENTHUB_OMNIROUTE_URL = saved.url;
    if (saved.key !== undefined) process.env.OMNIROUTE_API_KEY = saved.key;
  }
});

// ---- the gate on a real repository: a receipt is written from git, --live refuses to write one it cannot stand behind ----
function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = temp();
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "templates")); mkdirSync(join(dir, "scripts/benchmarks"), { recursive: true }); mkdirSync(join(dir, "docs/verification"), { recursive: true });
  writeFileSync(join(dir, "templates/routing.toml"), TEMPLATE_TEXT);
  writeFileSync(join(dir, "scripts/benchmarks/model-routing-corpus.json"), readFileSync(CORPUS, "utf8"));
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "pr");
  return { dir, git };
}
const quiet = async <T>(run: () => Promise<T>): Promise<T> => { const log = console.log, error = console.error; console.log = () => {}; console.error = () => {}; try { return await run(); } finally { console.log = log; console.error = error; } };

test("--receipt writes <date>-modelrouting-<sha8>.md from git, says live-not-run without --live, and refuses to overwrite without --force", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "templates/routing.toml"), edited("hold_turns = 2", "hold_turns = 3"));
  git("add", "-A"); git("commit", "-qm", "change");
  const out = join(dir, "docs/verification/r.md");
  const now = () => new Date("2026-10-29T12:00:00Z");
  expect(await quiet(() => main({ args: ["--receipt", "--base", "main", "--out", out], root: dir, now }))).toBe(0);
  const receipt = parseModelReceipt(readFileSync(out, "utf8"))!;
  expect(receipt.served_models).toBe(LIVE_NOT_RUN);
  expect(receipt.live_required).toBe(false);
  expect(receipt.changed_keys).toEqual(["hub_routes.hub/stage.hold_turns"]);
  expect(receipt.generated).toBe("2026-10-29");
  expect(await quiet(() => main({ args: ["--receipt", "--base", "main", "--out", out], root: dir, now }))).toBe(2);
  expect(await quiet(() => main({ args: ["--receipt", "--base", "main", "--out", out, "--force"], root: dir, now }))).toBe(0);
  const named = join(dir, "docs/verification", `2026-10-29-modelrouting-${receipt.candidate.sha256.slice(0, 8)}.md`);
  expect(await quiet(() => main({ args: ["--receipt", "--base", "main"], root: dir, now }))).toBe(0);
  expect(readFileSync(named, "utf8")).toBe(readFileSync(out, "utf8"));
  expect(await quiet(() => main({ args: ["--receipt", "--base", "no-such-ref", "--out", join(dir, "x.md")], root: dir }).catch(() => -1))).toBe(-1);
});
test("--receipt exits 1 and says why when the promotion rule blocks, and --live with a call that fails writes no receipt", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "templates/routing.toml"), edited("confirmations = 2", "confirmations = 1"));
  git("add", "-A"); git("commit", "-qm", "change");
  const out = join(dir, "blocked.md");
  expect(await quiet(() => main({ args: ["--receipt", "--base", "main", "--out", out], root: dir }))).toBe(1);
  expect(readFileSync(out, "utf8")).toContain("Verdict: **blocked**");
  const dead = join(dir, "dead.md");
  const failing = fakeChat(() => new Error("HTTP 503")).chat;
  expect(await quiet(() => main({ args: ["--receipt", "--live", "--base", "main", "--out", dead], root: dir, chat: failing }))).toBe(2);
  expect(() => readFileSync(dead, "utf8")).toThrow();
  const noServed = fakeChat(() => ({ content: "REDO: x" })).chat;
  expect(await quiet(() => main({ args: ["--receipt", "--live", "--base", "main", "--out", dead], root: dir, chat: noServed }))).toBe(2);
  expect(() => readFileSync(dead, "utf8")).toThrow();
});
test("a live receipt from a fake gateway is written with the served ids and a table of the judge cases", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "templates/routing.toml"), edited('type = "advisor"\nefficient = "fast"\ncapable = "coding"', 'type = "advisor"\nefficient = "fast"\ncapable = "fast"'));
  git("add", "-A"); git("commit", "-qm", "change");
  const out = join(dir, "live.md");
  const code = await quiet(() => main({ args: ["--receipt", "--live", "--base", "main", "--out", out], root: dir, chat: fakeChat((alias, system) => ({ content: system.startsWith("You are a senior") ? "REDO: x" : JSON.stringify({ escalate: false, category: "none", new_evidence: false, reason: "r" }), servedModel: `served/${alias}-v1` })).chat }));
  expect(code).toBe(0); // the fake judge answers REDO and escalate:false, which is the expected class of all four test-split judge cases (the approve case is on the train split)
  const text = readFileSync(out, "utf8");
  const receipt = parseModelReceipt(text)!;
  expect(receipt.live_required).toBe(true);
  expect(receipt.served_models).toEqual({ coding: ["served/coding-v1"], fast: ["served/fast-v1"] });
  expect(text).toContain("## Live judge cases");
  expect(text).toContain("coding -> served/coding-v1; fast -> served/fast-v1");
});
