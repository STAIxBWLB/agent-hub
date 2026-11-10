import { afterEach, expect, test } from "bun:test";
import { AMBIGUOUS_BAND_DEFAULT, AMBIGUOUS_BAND_MAX, ambiguousStage, selectFallbackStage, type FallbackStageResult } from "../src/models/route/stage-fallback.ts";
import { buildStageEvidence } from "../src/models/route/stage-evidence.ts";
import { captureStageInput } from "../src/models/route/stage-input.ts";
import { HubRouteRuntime, type RouteEvent, type RouteHost } from "../src/models/route/runtime.ts";
import { DecisionPolicyChangedError, DecisionRouteController } from "../src/models/route/decision.ts";
import { RouteLabelTracker } from "../src/models/route/labels.ts";
import { parseHubRoutes, type HubRoute } from "../src/models/route/config.ts";
import type { ChatMessage } from "../src/omniroute/client.ts";

const close: (() => void)[] = [];
afterEach(() => { for (const stop of close.splice(0)) stop(); });
const signal = () => new AbortController().signal;

test("a stage route without a classifier cannot hide service binding or enforce fields", () => {
  for (const fields of [{ decision_mode: "enforce" }, { decision_mode: "off" }, { decision_mode: "shadow" },
    { policy_id: "unused" }, { adec_endpoint: "http://127.0.0.1:8740/v1/route" }]) {
    expect(() => parseHubRoutes({ "hub/stage": { type: "stage", efficient: "fast", capable: "coding", ...fields } })).toThrow("classifier");
  }
});
const at = (score: number, tier: "efficient" | "capable" = "efficient"): FallbackStageResult => ({ tier, source: "dimensions", score, state: { recoveryHoldRemaining: 0 } });

const step = (id: string, name: string, content: string, error = false) => [
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content, ...(error ? { is_error: true } : {}) },
];
const session = (...parts: (ChatMessage | object[])[]) => parts.flat() as ChatMessage[];
const scoreOf = (messages: ChatMessage[]) => buildStageEvidence(captureStageInput(messages)!).scores.capable;

const PASS = session([{ role: "user", content: "run the suite" }], step("p1", "bash", "3 pass\n0 fail"));
const FAILED = session([{ role: "user", content: "run the suite" }], step("r1", "bash", "AssertionError: expected 1 to equal 2", true));
const CRITICAL = session([{ role: "user", content: "run the suite" }], step("c1", "bash", "segmentation fault", true));
// The owned #637 corpus case: eight successful executions across eight assistant turns, no read or mutation.
const SPINNING = session([{ role: "user", content: "KEEP-GOING-SENTINEL" }], ...Array.from({ length: 8 }, (_, index) => step(`s${index}`, "bash", "done")));

function service(answer?: (body: any) => unknown) {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/route"); expect(req.method).toBe("POST");
    const body = await req.json(); requests.push(body);
    return Response.json(answer?.(body) ?? { id: "0123456789abcdef0123456789abcdef", policyId: "ahub.stage", alias: "coding", effort: "none", margin: 0.2,
      abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], decider: { provider: "local", model: "fixed-decider-v1", latencyMs: 9 } });
  } });
  close.push(() => server.stop(true));
  const config: HubRoute = { type: "stage", classifier: "decision", decision_backend: "adec", policy_id: "ahub.stage",
    adec_endpoint: `http://127.0.0.1:${server.port}/v1/route`, decision_mode: "shadow", efficient: "fast", capable: "coding", ambiguous_band: AMBIGUOUS_BAND_DEFAULT };
  return { requests, config };
}
function host(extra: Partial<RouteHost> = {}) {
  const calls: { model: string }[] = [], events: RouteEvent[] = [];
  const runtime = new HubRouteRuntime({ onCampus: async () => true, publicDecisionText: () => true,
    execute: async (model) => { calls.push({ model }); return { message: { role: "assistant", content: "fixed answer" } }; },
    onRoute: event => events.push(event), ...extra });
  return { runtime, calls, events };
}

test("the band is a question trigger only: the owned 0.46 reading is inside it and clean or severe readings are outside", () => {
  expect(AMBIGUOUS_BAND_DEFAULT).toBe(0.05);
  expect(ambiguousStage(at(0.46))).toBe(true);
  expect(ambiguousStage(at(0.54))).toBe(true);
  expect(ambiguousStage(at(0.5))).toBe(true);
  for (const score of [0, 0.3, 0.7, 1]) expect(ambiguousStage(at(score))).toBe(false);
  expect(ambiguousStage(at(0.46), { ambiguousBand: 0 })).toBe(false);
  // Zero is the off switch, so even an exact tie with the threshold asks nothing.
  expect(ambiguousStage(at(0.5), { ambiguousBand: 0 })).toBe(false);
  expect(ambiguousStage(at(0.5), { ambiguousBand: 0.001 })).toBe(true);
  expect(ambiguousStage(at(0.46), { ambiguousBand: AMBIGUOUS_BAND_MAX })).toBe(true);
  expect(ambiguousStage(at(0.46), { confidenceThreshold: 0.9 })).toBe(false); // it is always relative to the threshold in force
  for (const band of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, AMBIGUOUS_BAND_MAX + 0.01]) expect(ambiguousStage(at(0.46), { ambiguousBand: band })).toBe(false);
});

test("stage classifier configuration is validated at load, defaults off, and leaves an ordinary stage route untouched", () => {
  const s = service();
  const parse = (patch: Record<string, unknown> = {}) => parseHubRoutes({ "hub/stage": { ...s.config, decision_mode: undefined, ...patch } })["hub/stage"];
  expect(parse()?.decision_mode).toBe("off");
  expect(parse()?.ambiguous_band).toBe(AMBIGUOUS_BAND_DEFAULT);
  expect(parse({ ambiguous_band: 0.2 })?.ambiguous_band).toBe(0.2);
  expect(parse({ ambiguous_band: 0 })?.ambiguous_band).toBe(0);
  expect(parse({ ambiguous_band: AMBIGUOUS_BAND_MAX })?.ambiguous_band).toBe(AMBIGUOUS_BAND_MAX);
  const plain = parse({ classifier: undefined, ambiguous_band: undefined, decision_backend: undefined, policy_id: undefined, adec_endpoint: undefined, decision_mode: undefined });
  expect(plain).toMatchObject({ type: "stage" }); expect(plain?.decision_mode).toBeUndefined(); expect(plain?.ambiguous_band).toBeUndefined();
  expect(() => parse({ ambiguous_band: 0.1, classifier: undefined })).toThrow('set classifier = "decision" first');
  expect(() => parse({ decision_mode: "enforce" })).toThrow("decision_mode enforce is not available yet; use shadow; tracked in #554");
  for (const patch of [{ classifier: "classifier" }, { decision_backend: "systemone" }, { decision_mode: "yes" },
    { policy_id: "../private" }, { adec_endpoint: "https://example.com/v1/route" }, { adec_endpoint: "http://user:secret@127.0.0.1:8740/v1/route" },
    { decision_timeout_ms: 0 }, { decision_timeout_ms: 30_001 }, { efficient: undefined }, { capable: "" },
    { ambiguous_band: -0.01 }, { ambiguous_band: AMBIGUOUS_BAND_MAX + 0.01 }, { ambiguous_band: Number.NaN }, { ambiguous_band: "0.1" }]) {
    expect(() => parse(patch)).toThrow(/routing\.toml/);
  }
});

test("decision_mode off never asks adec, and enforce is still refused", async () => {
  const s = service(), h = host();
  h.runtime.beginTurn({ turn: "off", pii: false });
  await h.runtime.call("hub/test", { ...s.config, decision_mode: "off" }, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(0); expect(h.calls[0]?.model).toBe("fast"); expect(h.events[0]?.decisionMode).toBeUndefined();
  expect(() => parseHubRoutes({ "hub/stage": { ...s.config, decision_mode: "enforce" } })).toThrow("decision_mode enforce is not available yet; use shadow; tracked in #554");
});

test("adec is asked for the owned ambiguous reading and for nothing else, with the tiers as its only options", async () => {
  const s = service(), h = host();
  for (const [name, fixture] of [["pass", PASS], ["failure", FAILED], ["critical", CRITICAL]] as const) {
    expect(Math.abs(scoreOf(fixture) - 0.5)).toBeGreaterThan(AMBIGUOUS_BAND_DEFAULT);
    h.runtime.beginTurn({ turn: `quiet-${name}`, pii: false });
    await h.runtime.call(`hub/quiet-${name}`, s.config, fixture, "scope", false, signal());
    h.runtime.endTurn(`quiet-${name}`, "completed");
  }
  expect(s.requests).toHaveLength(0);
  expect(scoreOf(SPINNING)).toBe(0.46);
  h.runtime.beginTurn({ turn: "spinning", pii: false });
  await h.runtime.call("hub/spinning", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0].candidates).toEqual(["fast", "coding"]);
  expect(s.requests[0].constraints).toMatchObject({ pii: false, private: false });
  expect(s.requests[0].constraints.current).toEqual({ alias: "fast", effort: "none" });
  const packet = JSON.parse(s.requests[0].evidence);
  // R1's own packet: numeric signals, dimensions and scores, never the generic v1 conversation projection.
  expect(packet).toMatchObject({ kind: "stage-route-evidence", schemaVersion: 1, turn: "tool_result", incomplete: false,
    signals: { results: 8, failures: 0, tests: "none" }, dimensions: { severity: 0, spinning: 0.46 } });
  expect(packet.scores.capable).toBeCloseTo(0.46); expect(packet.scores.efficient).toBeCloseTo(0.54);
  expect(Buffer.byteLength(s.requests[0].evidence)).toBeLessThanOrEqual(1024);
  for (const field of ["interpretation", "latestUser", "lastAssistantTail", "lastToolTail", "toolNames"]) expect(packet[field]).toBeUndefined();
  // The turn's text is screened in as public and still must not travel: the sentinel appears only in the user message.
  expect(JSON.stringify(s.requests[0])).not.toContain("KEEP-GOING-SENTINEL");
  expect(JSON.stringify(s.requests[0])).not.toContain("tool_call_id");
  expect(h.events.at(-1)).toMatchObject({ tier: "fast", source: "default", decisionMode: "shadow", chosenAlias: "coding", chosenEffort: "none", margin: 0.2 });
});

test("an oversized UTF-8 numeric stage packet is unavailable and sends no HTTP request", async () => {
  const s = service(), labels = new RouteLabelTracker();
  labels.beginTurn({ turn: "oversized-packet", pii: false });
  const turn = labels.captureTurn();
  // A malformed extension with a numeric value proves byte admission, not a new wire field.
  const evidence = { ...buildStageEvidence(captureStageInput(SPINNING)!), ["한".repeat(256)]: 0 };
  const packet = JSON.stringify(evidence);
  expect(packet.length).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(packet, "utf8")).toBeGreaterThan(1024);
  const controller = new DecisionRouteController({ onCampus: async () => true }, 1000);
  const trace = await controller.shadowClassify(s.config, {
    route: "hub/test", scope: "scope", turn, current: () => labels.captureTurn() === turn,
    messages: SPINNING, evidence, pii: false, signal: signal(), tier: "efficient",
  });
  expect(trace.decisionReason).toBe("unavailable");
  expect(s.requests).toHaveLength(0);
});

test("an abstaining service and a failed transport keep the heuristic tier and record the reason", async () => {
  const abstain = service(() => ({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.stage", alias: null, effort: null, margin: 0,
    abstain: true, reason: "no_candidate", fallbackApplied: false, pinned: false, rules: [], decider: null }));
  const quiet = host(); quiet.runtime.beginTurn({ turn: "abstain", pii: false });
  await quiet.runtime.call("hub/test", abstain.config, SPINNING, "scope", false, signal());
  expect(quiet.calls[0]?.model).toBe("fast");
  expect(quiet.events[0]).toMatchObject({ tier: "fast", decisionMode: "shadow", chosenAlias: null, chosenEffort: null, decisionReason: "no_candidate" });

  const failed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "SERVER_SECRET_CANARY" }, { status: 503 }) });
  close.push(() => failed.stop(true));
  const broken = host(); broken.runtime.beginTurn({ turn: "failure", pii: false });
  await broken.runtime.call("hub/test", { ...abstain.config, adec_endpoint: `http://127.0.0.1:${failed.port}/v1/route` }, SPINNING, "scope", false, signal());
  expect(broken.calls[0]?.model).toBe("fast");
  expect(broken.events[0]).toMatchObject({ tier: "fast", decisionReason: "http" });
  expect(JSON.stringify(broken.events)).not.toContain("SERVER_SECRET_CANARY");
});

test("an off-campus decider never sees a PII or private turn, and on-campus sensitive evidence is dimensions only", async () => {
  const s = service();
  const offCampus = host({ onCampus: async () => false, decisionContext: () => ({ private: true, excluded: false }) });
  offCampus.runtime.beginTurn({ turn: "sensitive", pii: true });
  await offCampus.runtime.call("hub/test", s.config, SPINNING, "scope", true, signal());
  expect(s.requests).toHaveLength(0);
  expect(offCampus.events[0]).toMatchObject({ tier: "fast", decisionReason: "off_campus" });

  const onCampus = service();
  const campus = host({ decisionContext: () => ({ private: true, excluded: false }) });
  campus.runtime.beginTurn({ turn: "campus-sensitive", pii: true });
  await campus.runtime.call("hub/test", onCampus.config, SPINNING, "scope", true, signal());
  expect(onCampus.requests[0].constraints).toMatchObject({ pii: true, private: true, contextTokens: 0 });
  const evidence = JSON.parse(onCampus.requests[0].evidence);
  // The sensitive projection is R1's dimensions-only view: no signal shape, no scores, no fragments.
  expect(Object.keys(evidence).sort()).toEqual(["dimensions", "kind", "schemaVersion"]);
  expect(evidence.kind).toBe("stage-route-evidence");
  expect(evidence.dimensions).toEqual({ severity: 0, spinning: 0.46, exploring: 0, productionIntensity: 0 });
  expect(JSON.stringify(onCampus.requests)).not.toContain("KEEP-GOING-SENTINEL");
});

test("shadow records the answer and leaves every stage tier and source exactly as the heuristic chose them", async () => {
  const s = service(), baseline = host(), shadow = host();
  for (const [index, fixture] of [PASS, SPINNING, FAILED, CRITICAL].entries()) {
    for (const h of [baseline, shadow]) h.runtime.beginTurn({ turn: `turn-${index}`, pii: false });
    await baseline.runtime.call("hub/test", { type: "stage", efficient: "fast", capable: "coding" }, fixture, "scope", false, signal());
    await shadow.runtime.call("hub/test", s.config, fixture, "scope", false, signal());
    for (const h of [baseline, shadow]) h.runtime.endTurn(`turn-${index}`, "completed");
  }
  expect(shadow.calls.map(call => call.model)).toEqual(baseline.calls.map(call => call.model));
  expect(shadow.events.map(event => [event.tier, event.source])).toEqual(baseline.events.map(event => [event.tier, event.source]));
  expect(s.requests).toHaveLength(1);
  expect(shadow.events[1]).toMatchObject({ decisionMode: "shadow", chosenAlias: "coding", decisionReason: "ok" });
  expect(baseline.events[1]?.decisionMode).toBeUndefined();
});

test("one question per user turn, kept through the tool loop", async () => {
  const s = service(), h = host();
  h.runtime.beginTurn({ turn: "loop", pii: false });
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(1);
  expect(h.events.map(event => [event.decisionMode, event.chosenAlias])).toEqual([["shadow", "coding"], ["shadow", "coding"]]);
  h.runtime.endTurn("loop", "completed"); h.runtime.beginTurn({ turn: "next", pii: false });
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(2);
});

test("a held answer is not republished once the turn's privacy or observer facts change", async () => {
  const s = service();
  let privateNow = false, excludedNow = false;
  const h = host({ decisionContext: () => ({ private: privateNow, excluded: excludedNow }) });
  h.runtime.beginTurn({ turn: "privacy-change", pii: false });
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(1);
  expect(h.events[0]).toMatchObject({ decisionMode: "shadow", chosenAlias: "coding" });
  // The turn continues, but the board context became private: the held answer was approved under public facts.
  privateNow = true;
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(1);
  expect(h.events[1]?.decisionMode).toBeUndefined();
  expect(h.calls[1]?.model).toBe("fast");
  h.runtime.endTurn("privacy-change", "completed");
  // A fresh public turn is asked again, and an excluded observer drops the held answer the same way.
  privateNow = false;
  h.runtime.beginTurn({ turn: "observer-excluded", pii: false });
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(2);
  expect(h.events[2]).toMatchObject({ decisionMode: "shadow", chosenAlias: "coding" });
  excludedNow = true;
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(2);
  expect(h.events[3]?.decisionMode).toBeUndefined();
  h.runtime.endTurn("observer-excluded", "completed");
});

test("unreadable authority during a held turn refuses it instead of publishing the cached answer", async () => {
  const s = service();
  let unavailable = false;
  const h = host({ decisionContext: () => { if (unavailable) throw new Error("BOARD-UNAVAILABLE-SENTINEL"); return { private: false, excluded: false }; } });
  h.runtime.beginTurn({ turn: "authority-lost", pii: false });
  await h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  expect(s.requests).toHaveLength(1);
  unavailable = true;
  const pending = h.runtime.call("hub/test", s.config, SPINNING, "scope", false, signal());
  const outcome = await pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  // The cached answer is not a substitute for current authority: the stale turn is refused and nothing executes.
  expect(outcome.error).toBeInstanceOf(DecisionPolicyChangedError);
  expect(h.calls).toHaveLength(1);
  expect(h.events).toHaveLength(1);
  expect(JSON.stringify(h.events)).not.toContain("BOARD-UNAVAILABLE-SENTINEL");
});

test("a turn that ends while the question is held applies no answer", async () => {
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  close.push(release);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    arrived(); await gate;
    return Response.json({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.stage", alias: "coding", effort: "none", margin: 0.2,
      abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], decider: null });
  } });
  close.push(() => server.stop(true));
  const s = service(), h = host(), controller = new AbortController();
  h.runtime.beginTurn({ turn: "cancelled", pii: false });
  const pending = h.runtime.call("hub/test", { ...s.config, adec_endpoint: `http://127.0.0.1:${server.port}/v1/route` }, SPINNING, "scope", false, controller.signal);
  const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await entered; controller.abort(); h.runtime.endTurn("cancelled", "failed"); release();
  const outcome = await settled;
  // The optional question never refuses the turn: the heuristic tier executes and a closed turn emits no late route.
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBeDefined();
  expect(h.calls[0]?.model).toBe("fast");
  expect(h.events).toHaveLength(0);
});

test("authority that changes while the question waits refuses the stale turn instead of executing the heuristic", async () => {
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  close.push(release);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    arrived(); await gate;
    return Response.json({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.stage", alias: "coding", effort: "none", margin: 0.2,
      abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], decider: null });
  } });
  close.push(() => server.stop(true));
  const s = service();
  let privateNow = false;
  const h = host({ decisionContext: () => ({ private: privateNow, excluded: false }) });
  h.runtime.beginTurn({ turn: "authority-change", pii: false });
  const pending = h.runtime.call("hub/test", { ...s.config, adec_endpoint: `http://127.0.0.1:${server.port}/v1/route` }, SPINNING, "scope", false, signal());
  const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await entered; privateNow = true; release();
  const outcome = await settled;
  // Not a service failure: the stale turn is refused, so no model runs and no route event reaches execution.
  expect(outcome.error).toBeInstanceOf(DecisionPolicyChangedError);
  expect(outcome.value).toBeUndefined();
  expect(h.calls).toHaveLength(0);
  expect(h.events).toHaveLength(0);
});
