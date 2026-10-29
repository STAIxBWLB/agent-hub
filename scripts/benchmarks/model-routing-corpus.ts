import { readFileSync, writeFileSync } from "node:fs";
import type { ChatMessage } from "../../src/omniroute/client.ts";
import type { HubRoute } from "../../src/models/route/config.ts";
import { DEFAULT_PLANNING_PROMPT } from "../../src/models/route/plan-execute.ts";
import { HubRouteRuntime, type RouteEvent, type RouteHost } from "../../src/models/route/runtime.ts";
import { parseAdvisorVerdict } from "../../src/models/route/text.ts";
import { effectiveLocalRoute, type Routing } from "../../src/hub/routing.ts";
import { canonicalJson, sha256 } from "./routing-corpus.ts";

// agent-hub #637 part 2 (hub task #324): the frozen model-routing corpus, its deterministic evaluation, and the promotion comparison. Spec: issue #637 and the "Model-routing promotion rule" in
// docs/agent-notes/benchmarks.md. Nothing here reads the network: a `route` case drives the REAL HubRouteRuntime with a scripted host (the model is a fake that records which alias was asked and
// answers with the case's scripted judge replies), so what is scored is the routing code and the routing keys, never a model. The cases a model must answer (`judge`) are scored only by
// the hand-produced live receipt (model-routing-receipt.ts).

export const SURFACE = "model-routing" as const;
export type Split = "train" | "test";
export type Guard = "pii" | "hard_override" | "injection";
export type Tier = "efficient" | "capable";

/** What a turn must show. A field that is not stated is not scored. */
export interface TurnExpect {
  /** The tier of the model the caller finally got (the alias asked last, read against the route's efficient and capable aliases). */
  tier?: Tier;
  /** Why the stage route chose it: the RouteEvent source (`override`, `dimensions`, `hold`, `classifier`, `default`). */
  source?: string;
  /** The stay/switch mode the planner recorded (`shadow`, `enforce`); absent from the event when the mode is `off`. */
  staySwitch?: string;
  /** How many judge calls the route made on this turn. */
  judgeCalls?: number;
  /** Advisor outcome: `approve` (a judge said stop), `redo` (a judge sent the executor back), `failed` (a judge answered but not with a verdict) or `none` (no review happened). */
  outcome?: "approve" | "redo" | "failed" | "none";
  /** Whether the planning prompt was put in front of the conversation (plan_execute's plan phase). */
  planned?: boolean;
  /** Whether the routing event carries the conversation's prefill size. A PII conversation's size says something about its text, so its event never does. */
  prefillRecorded?: boolean;
}
export interface RouteTurn {
  /** `call` (default) is a model request through the route; `review` is the advisor's review of a held answer. */
  op?: "call" | "review";
  scope?: string;
  messages: ChatMessage[];
  /** Replies the scripted judge gives on this turn, in order. */
  judge?: string[];
  expect: TurnExpect;
}
interface CaseBase { id: string; split: Split; /** One sentence: the rule this case pins, so a reader can judge the expectation without running anything. */ note: string; guard?: Guard }
export interface RouteCase extends CaseBase {
  kind: "route";
  route: string;
  /** A PII conversation. */
  pii?: boolean;
  /** Whether a campus gateway is confirmed (default true). */
  onCampus?: boolean;
  turns: RouteTurn[];
}
export interface SelectionCase extends CaseBase {
  kind: "selection";
  /** A task class: the route and the fixed alias a task of that class gets on the local worker. */
  class: string;
  expect: { route: string | null; model: string };
}
export interface JudgeCase extends CaseBase {
  kind: "judge";
  judge: "advisor" | "escalation";
  route: string;
  messages: ChatMessage[];
  /** Advisor: the executor's latest turn. */
  latest?: string;
  /** Escalation: the turn number shown to the judge. */
  turn?: number;
  /** The verdict class a sound judge returns, written from the judge prompt's own rules. */
  expect: { verdict: "approve" | "redo" } | { escalate: boolean; category?: string };
}
export type ModelRoutingCase = RouteCase | SelectionCase | JudgeCase;
export interface ModelRoutingCorpus { version: 1; surface: typeof SURFACE; hash: string; cases: ModelRoutingCase[] }
export const isDeterministic = (c: ModelRoutingCase): c is RouteCase | SelectionCase => c.kind !== "judge";

export function modelCorpusHash(corpus: Omit<ModelRoutingCorpus, "hash"> | ModelRoutingCorpus): string {
  const { hash: _ignored, ...rest } = corpus as ModelRoutingCorpus;
  return sha256(canonicalJson(rest));
}

const fail = (message: string): never => { throw new Error(`model-routing corpus: ${message}`); };
const ROLES = ["system", "user", "assistant", "tool"];
const TIERS = ["efficient", "capable"], SOURCES = ["override", "dimensions", "hold", "classifier", "default"], OUTCOMES = ["approve", "redo", "failed", "none"];
const KNOWN_TURN_EXPECT = ["tier", "source", "staySwitch", "judgeCalls", "outcome", "planned", "prefillRecorded"];
function checkMessages(where: string, messages: unknown): void {
  if (!Array.isArray(messages) || !messages.length || messages.length > 60) fail(`${where}: messages is a list of 1 to 60`);
  for (const m of messages as ChatMessage[]) {
    if (!m || !ROLES.includes(m.role) || !(typeof m.content === "string" || m.content === null)) fail(`${where}: a message needs a role (${ROLES.join(", ")}) and string or null content`);
    for (const call of m.tool_calls ?? []) if (call?.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string") fail(`${where}: a tool call is {id, type: function, function: {name, arguments: <JSON string>}}`);
    if (m.role === "tool" && typeof m.tool_call_id !== "string") fail(`${where}: a tool message names its tool_call_id`);
  }
}
/** Checks a parsed corpus. `allowStale` is for `--freeze` only: it accepts a hash that no longer matches. */
export function validateModelCorpus(raw: unknown, allowStale = false): ModelRoutingCorpus {
  if (!raw || typeof raw !== "object") return fail("not an object");
  const corpus = raw as ModelRoutingCorpus;
  if (corpus.version !== 1 || corpus.surface !== SURFACE) fail(`version 1 and surface ${SURFACE} are required`);
  if (typeof corpus.hash !== "string" || !Array.isArray(corpus.cases) || !corpus.cases.length) fail("hash and a nonempty cases list are required");
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    const where = `case ${JSON.stringify(c?.id)}`;
    if (typeof c?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) fail(`${where}: id is lower-case letters, digits and hyphens`);
    if (ids.has(c.id)) fail(`${where}: duplicate id`);
    ids.add(c.id);
    if (c.split !== "train" && c.split !== "test") fail(`${where}: split is train or test`);
    if (typeof c.note !== "string" || !c.note.trim()) fail(`${where}: a note naming the rule is required`);
    if (c.guard !== undefined && !["pii", "hard_override", "injection"].includes(c.guard)) fail(`${where}: guard is pii, hard_override or injection`);
    if (c.kind === "selection") {
      if (typeof c.class !== "string" || !c.class) fail(`${where}: class is required`);
      if (!c.expect || (c.expect.route !== null && typeof c.expect.route !== "string") || typeof c.expect.model !== "string") fail(`${where}: expect is {route: string or null, model: string}`);
    } else if (c.kind === "route") {
      if (typeof c.route !== "string" || !c.route.startsWith("hub/")) fail(`${where}: route is a hub/ id`);
      if (!Array.isArray(c.turns) || !c.turns.length || c.turns.length > 8) fail(`${where}: turns is a list of 1 to 8`);
      c.turns.forEach((turn, index) => {
        const here = `${where} turn ${index + 1}`;
        if (turn.op !== undefined && turn.op !== "call" && turn.op !== "review") fail(`${here}: op is call or review`);
        checkMessages(here, turn.messages);
        if (turn.judge !== undefined && (!Array.isArray(turn.judge) || turn.judge.some(reply => typeof reply !== "string"))) fail(`${here}: judge is a list of reply strings`);
        const expect = turn.expect;
        if (!expect || typeof expect !== "object" || !Object.keys(expect).length) fail(`${here}: expect states at least one field`);
        for (const key of Object.keys(expect)) if (!KNOWN_TURN_EXPECT.includes(key)) fail(`${here}: unknown expect field ${key}`);
        if (expect.tier !== undefined && !TIERS.includes(expect.tier)) fail(`${here}: tier is efficient or capable`);
        if (expect.source !== undefined && !SOURCES.includes(expect.source)) fail(`${here}: unknown source ${expect.source}`);
        if (expect.outcome !== undefined && !OUTCOMES.includes(expect.outcome)) fail(`${here}: outcome is approve, redo, failed or none`);
        if (expect.judgeCalls !== undefined && !(Number.isInteger(expect.judgeCalls) && expect.judgeCalls >= 0)) fail(`${here}: judgeCalls is a count`);
      });
    } else if (c.kind === "judge") {
      if (c.judge !== "advisor" && c.judge !== "escalation") fail(`${where}: judge is advisor or escalation`);
      if (typeof c.route !== "string" || !c.route.startsWith("hub/")) fail(`${where}: route is a hub/ id`);
      checkMessages(where, c.messages);
      const expect = c.expect as { verdict?: string; escalate?: unknown };
      if (c.judge === "advisor" && expect?.verdict !== "approve" && expect?.verdict !== "redo") fail(`${where}: an advisor case expects approve or redo`);
      if (c.judge === "escalation" && typeof expect?.escalate !== "boolean") fail(`${where}: an escalation case expects {escalate: boolean}`);
    } else fail(`${where}: kind is route, selection or judge`);
  }
  // The promotion rule reads the guard cases of the split it is checked on: a split without them could not block a regression.
  for (const split of ["train", "test"] as const) for (const guard of ["pii", "hard_override"] as const) {
    if (!corpus.cases.some(c => c.split === split && c.guard === guard && isDeterministic(c))) fail(`the ${split} split needs at least one deterministic ${guard} guard case, or the promotion rule cannot be checked`);
  }
  if (!corpus.cases.some(c => c.split === "test" && c.kind === "judge" && c.guard === "injection")) fail("the test split needs a judge case that guards against instructions inside the transcript (injection)");
  for (const split of ["train", "test"] as const) if (!corpus.cases.some(c => c.split === split && c.kind === "judge")) fail(`the ${split} split needs at least one judge case`);
  if (!allowStale) {
    const actual = modelCorpusHash(corpus);
    if (actual !== corpus.hash) fail(`hash mismatch: the file says ${corpus.hash}, its content is ${actual}. After an intended change run model-routing-gate.ts --freeze; every receipt for the old hash is then void`);
  }
  return corpus;
}
export function loadModelCorpus(path: string, allowStale = false): ModelRoutingCorpus { return validateModelCorpus(JSON.parse(readFileSync(path, "utf8")), allowStale); }
export function freezeModelCorpus(path: string): { hash: string; stale: boolean } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ModelRoutingCorpus;
  validateModelCorpus(raw, true);
  const hash = modelCorpusHash(raw), stale = raw.hash !== hash;
  if (stale) writeFileSync(path, JSON.stringify({ ...raw, hash }, null, 2) + "\n");
  return { hash, stale };
}

// ---- the configuration under test: the model-routing keys of a routing.toml, nothing else ----

/**
 * What a reviewer reads as the model-routing "default": the keys that choose a model route or a model alias, as the loader parsed them. Task-routing keys (peers, signals, constraints, escalate_to)
 * are not here, so a change to them needs no model-routing receipt (it needs part 1's), and the other way round.
 */
export function modelRoutingSummary(routing: Routing): Record<string, unknown> {
  const classes: Record<string, unknown> = {};
  for (const [name, policy] of Object.entries(routing.classes)) classes[name] = { ...(policy?.route === undefined ? {} : { route: policy.route }), ...(policy?.fixed_model === undefined ? {} : { fixed_model: policy.fixed_model }), ...(policy?.pi_backend === undefined ? {} : { pi_backend: policy.pi_backend }) };
  return JSON.parse(canonicalJson({ local: routing.local, hub_routes: routing.hub_routes ?? {}, stay_switch: routing.stay_switch, max_switch_prefill_tokens: routing.max_switch_prefill_tokens, classes, pi: routing.pi }));
}
export const modelRoutingSha = (routing: Routing): string => sha256(canonicalJson(modelRoutingSummary(routing)));
/** Dotted paths whose value differs between two summaries. */
export function changedModelKeys(a: unknown, b: unknown, prefix = ""): string[] {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (object(a) && object(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => changedModelKeys(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  return canonicalJson(a) === canonicalJson(b) ? [] : [prefix];
}
/** Keys whose change moves only a deterministic decision. Any other changed key (an alias, a route type, a judge prompt parameter) changes what a model is asked or which one, so its receipt needs the live half. */
const DETERMINISTIC_KEYS = new Set(["confidence_threshold", "hold_turns", "confirmations", "max_reviews", "gate_min_tool_results", "gate_stall_turns", "stay_switch", "max_switch_prefill_tokens", "route", "pi_backend", "dgx_max_context_tokens", "mlx_max_context_tokens", "efficient_wait_ms"]);
export function liveRequired(changed: readonly string[]): boolean { return changed.some(path => !DETERMINISTIC_KEYS.has(path.split(".").at(-1) ?? "")); }

// ---- evaluation ----

export interface TurnResult { tier: Tier | "same" | "none"; model: string | null; source: string | null; staySwitch: string | null; judgeCalls: number; outcome: "approve" | "redo" | "failed" | "none"; planned: boolean; prefillRecorded: boolean }
export type CaseResult = { error: string } | { turns: TurnResult[] } | { route: string | null; model: string };
export interface Score { pass: boolean; detail?: string }

async function runRouteCase(c: RouteCase, routing: Routing): Promise<CaseResult> {
  const config = routing.hub_routes?.[c.route] as HubRoute | undefined;
  if (!config) return { error: `the policy has no route ${c.route}` };
  const calls: { model: string; judge: boolean; planned: boolean }[] = [], events: RouteEvent[] = [];
  let replies: string[] = [];
  const host: RouteHost = {
    onCampus: async () => c.onCampus ?? true,
    staySwitch: () => ({ stay_switch: routing.stay_switch, max_switch_prefill_tokens: routing.max_switch_prefill_tokens }),
    onRoute: event => { events.push(event); },
    execute: async (model, messages, judge) => {
      calls.push({ model, judge, planned: !judge && messages[0]?.role === "system" && messages[0].content === DEFAULT_PLANNING_PROMPT });
      return { message: { role: "assistant", content: judge ? replies.shift() ?? "" : "ok" } };
    },
  };
  const runtime = new HubRouteRuntime(host);
  const efficient = config.efficient ?? "fast", capable = config.capable ?? "coding";
  const turns: TurnResult[] = [];
  for (const turn of c.turns) {
    replies = [...(turn.judge ?? [])];
    const from = calls.length, eventFrom = events.length, signal = new AbortController().signal, scope = turn.scope ?? "s";
    let feedback: string | undefined;
    if (turn.op === "review") feedback = await runtime.review(c.route, config, turn.messages, scope, c.pii ?? false, signal);
    else await runtime.call(c.route, config, turn.messages, scope, c.pii ?? false, signal);
    const made = calls.slice(from), main = made.filter(call => !call.judge), judged = made.filter(call => call.judge).length, event = events.slice(eventFrom).at(-1);
    const model = main.at(-1)?.model ?? null;
    const tier: TurnResult["tier"] = model === null ? "none" : efficient === capable ? "same" : model === capable ? "capable" : model === efficient ? "efficient" : "none";
    let outcome: TurnResult["outcome"] = "none";
    if (turn.op === "review" && judged > 0) outcome = feedback !== undefined ? "redo" : parseAdvisorVerdict(turn.judge?.[0] ?? "")?.kind === "approve" ? "approve" : "failed";
    turns.push({ tier, model, source: event?.source ?? null, staySwitch: event?.staySwitch ?? null, judgeCalls: judged, outcome, planned: main.some(call => call.planned), prefillRecorded: event?.prefillTokens !== undefined });
  }
  return { turns };
}
export async function runCase(c: ModelRoutingCase, routing: Routing): Promise<CaseResult> {
  if (c.kind === "judge") return { error: "a judge case is scored only by the live receipt" };
  if (c.kind === "selection") {
    const policy = routing.classes[c.class as keyof Routing["classes"]];
    return { route: effectiveLocalRoute(routing.local.route, policy?.route, policy?.fixed_model) ?? null, model: policy?.fixed_model ?? routing.local.fixed_model };
  }
  try { return await runRouteCase(c, routing); } catch (error) { return { error: `the route threw: ${(error as Error).message}` }; }
}
export function scoreCase(c: RouteCase | SelectionCase, result: CaseResult): Score {
  if ("error" in result) return { pass: false, detail: result.error };
  if (c.kind === "selection") {
    const r = result as { route: string | null; model: string };
    const bad = [r.route !== c.expect.route ? `route ${r.route} (expected ${c.expect.route})` : "", r.model !== c.expect.model ? `model ${r.model} (expected ${c.expect.model})` : ""].filter(Boolean);
    return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true };
  }
  const turns = (result as { turns: TurnResult[] }).turns;
  for (const [index, turn] of c.turns.entries()) {
    const got = turns[index]!, expect = turn.expect;
    const wrong = (Object.keys(expect) as (keyof TurnExpect)[]).filter(key => got[key] !== expect[key]).map(key => `${key} ${JSON.stringify(got[key])} (expected ${JSON.stringify(expect[key])})`);
    if (wrong.length) return { pass: false, detail: `turn ${index + 1}: ${wrong.join("; ")}` };
  }
  return { pass: true };
}
export interface Evaluated { id: string; kind: ModelRoutingCase["kind"]; guard?: Guard; result: CaseResult; score: Score }
export async function evaluate(corpus: ModelRoutingCorpus, routing: Routing, split: Split): Promise<Evaluated[]> {
  const rows: Evaluated[] = [];
  for (const c of corpus.cases.filter(item => item.split === split && isDeterministic(item))) {
    const result = await runCase(c, routing);
    rows.push({ id: c.id, kind: c.kind, ...(c.guard ? { guard: c.guard } : {}), result, score: scoreCase(c as RouteCase | SelectionCase, result) });
  }
  return rows;
}

const rate = (correct: number, n: number): number => (n ? Math.round((correct / n) * 10000) / 10000 : 0);
export interface Comparison {
  split: Split;
  n: number;
  /** The primary metric: the share of deterministic cases that pass. */
  primary: { metric: string; base: number; candidate: number; baseCorrect: number; candidateCorrect: number };
  secondary: { kinds: Record<string, { n: number; base: number; candidate: number }> };
  regressions: string[];
  guardRegressions: string[];
  improvements: string[];
  verdict: "pass" | "blocked";
  reasons: string[];
  cases: { id: string; kind: string; guard?: Guard; base: CaseResult; candidate: CaseResult; basePass: boolean; candidatePass: boolean }[];
}
/** The promotion rule: the candidate is not worse on the primary metric and regresses no guard case. Judge cases are not in this comparison: they are the live receipt's. */
export async function compare(corpus: ModelRoutingCorpus, base: Routing, candidate: Routing, split: Split = "test"): Promise<Comparison> {
  const a = await evaluate(corpus, base, split), b = await evaluate(corpus, candidate, split);
  const n = a.length, baseCorrect = a.filter(row => row.score.pass).length, candidateCorrect = b.filter(row => row.score.pass).length;
  const regressions = a.flatMap((row, i) => (row.score.pass && !b[i]!.score.pass ? [row.id] : []));
  const improvements = a.flatMap((row, i) => (!row.score.pass && b[i]!.score.pass ? [row.id] : []));
  const guardRegressions = regressions.filter(id => a.find(row => row.id === id)!.guard !== undefined);
  const reasons: string[] = [];
  if (candidateCorrect < baseCorrect) reasons.push(`deterministic case pass rate fell from ${baseCorrect}/${n} to ${candidateCorrect}/${n}`);
  if (guardRegressions.length) reasons.push(`regressed PII or hard-override case(s): ${guardRegressions.join(", ")}`);
  const kinds: Comparison["secondary"]["kinds"] = {};
  for (const kind of ["route", "selection"]) {
    const rows = a.map((row, i) => ({ base: row, candidate: b[i]! })).filter(row => row.base.kind === kind);
    if (rows.length) kinds[kind] = { n: rows.length, base: rate(rows.filter(r => r.base.score.pass).length, rows.length), candidate: rate(rows.filter(r => r.candidate.score.pass).length, rows.length) };
  }
  return {
    split, n, primary: { metric: "deterministic case pass rate", base: rate(baseCorrect, n), candidate: rate(candidateCorrect, n), baseCorrect, candidateCorrect },
    secondary: { kinds }, regressions, guardRegressions, improvements, verdict: reasons.length ? "blocked" : "pass", reasons,
    cases: a.map((row, i) => ({ id: row.id, kind: row.kind, ...(row.guard ? { guard: row.guard } : {}), base: row.result, candidate: b[i]!.result, basePass: row.score.pass, candidatePass: b[i]!.score.pass })),
  };
}
