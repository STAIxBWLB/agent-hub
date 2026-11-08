import { afterEach, expect, test } from "bun:test";
import { HubRouteRuntime, type RouteEvent, type RouteHost } from "../src/models/route/runtime.ts";
import { parseHubRoutes, type HubRoute } from "../src/models/route/config.ts";
import type { ChatMessage } from "../src/omniroute/client.ts";

const close: (() => void)[] = [];
afterEach(() => { for (const stop of close.splice(0)) stop(); });
const messages: ChatMessage[] = [{ role: "user", content: "Implement the ordinary task" }];
const candidates = [{ alias: "fast", efforts: ["low"] }, { alias: "coding", efforts: ["high"] }];
function service(answer?: (body: any) => unknown) {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/route"); expect(req.method).toBe("POST");
    const body = await req.json(); requests.push(body);
    return Response.json(answer?.(body) ?? { id: "0123456789abcdef0123456789abcdef", policyId: "ahub.test", alias: "coding", effort: "high", margin: 0.4, abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], decider: { provider: "local", model: "fixed-decider-v1", latencyMs: 12 } });
  } });
  close.push(() => server.stop(true));
  const config: HubRoute = { type: "decision", decision_backend: "adec", policy_id: "ahub.test", adec_endpoint: `http://127.0.0.1:${server.port}/v1/route`, candidates, decision_mode: "shadow" };
  return { requests, config };
}
function host(extra: Partial<RouteHost> = {}) {
  const calls: { model: string; messages: ChatMessage[]; effort?: string }[] = [], events: RouteEvent[] = [];
  const runtime = new HubRouteRuntime({ onCampus: async () => true, publicDecisionText: () => true,
    execute: async (model, sent, _judge, _signal, _max, effort) => { calls.push({ model, messages: sent, ...(effort ? { effort } : {}) }); return { message: { role: "assistant", content: "fixed answer" } }; },
    onRoute: event => events.push(event), ...extra });
  return { runtime, calls, events };
}
const signal = () => new AbortController().signal;

test("decision configuration defaults off and refuses unsafe or incomplete service contracts", () => {
  const s = service();
  const parse = (patch: Record<string, unknown>) => parseHubRoutes({ "hub/decision": { ...s.config, decision_mode: undefined, ...patch } });
  expect(parse({})["hub/decision"]?.decision_mode).toBe("off");
  for (const patch of [
    { decision_backend: "systemone" }, { decision_mode: "yes" }, { policy_id: "../private" },
    { adec_endpoint: "https://example.com/v1/route" }, { adec_endpoint: "http://user:secret@127.0.0.1:8740/v1/route" },
    { decision_timeout_ms: 0 }, { decision_timeout_ms: Infinity }, { candidates: [] },
    { candidates: [{ alias: "fast", efforts: ["low", "low"] }] },
    { candidates: [{ alias: "fast", efforts: ["low"] }, { alias: "fast", efforts: ["high"] }] },
    { candidates: [{ alias: "fast", efforts: ["high"], onPrem: true }] },
    { candidates: Array.from({ length: 27 }, (_, i) => ({ alias: `a${i}`, efforts: ["low"] })) },
  ]) expect(() => parse(patch)).toThrow("routing.toml: invalid");
});

test("decision off never builds evidence or calls adec", async () => {
  const s = service(), h = host({ publicDecisionText: () => { throw new Error("must not screen"); } });
  h.runtime.beginTurn({ turn: "off-turn", pii: false });
  await h.runtime.call("hub/test", { ...s.config, decision_mode: "off" }, messages, "scope", false, signal());
  expect(s.requests).toHaveLength(0); expect(h.calls[0]?.model).toBe("fast"); expect(h.calls[0]?.effort).toBeUndefined();
  expect(h.events[0]?.source).not.toBe("decision");
});

test("shadow preserves the recorded stage model, effort and whole conversation through the tool loop", async () => {
  const s = service(), baseline = host(), shadow = host();
  for (const h of [baseline, shadow]) h.runtime.beginTurn({ turn: "same-user-turn", pii: false });
  const turns: ChatMessage[][] = [messages, [...messages, { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read", arguments: '{"path":"a.ts","secret":"ARGUMENT_CANARY"}' } }] }, { role: "tool", tool_call_id: "x", content: "ImportError: failed" }]];
  for (const transcript of turns) {
    await baseline.runtime.call("hub/test", { type: "stage" }, transcript, "scope", false, signal());
    await shadow.runtime.call("hub/test", s.config, transcript, "scope", false, signal());
  }
  expect(shadow.calls).toEqual(baseline.calls);
  expect(s.requests).toHaveLength(2); expect(s.requests[0].turnId).toBe(s.requests[1].turnId);
  expect(s.requests[0].candidates).toEqual(["fast", "coding"]);
  expect(JSON.stringify(s.requests)).not.toContain("ARGUMENT_CANARY");
  for (const e of shadow.events) {
    expect(e.source).toBe("decision"); expect(e.decisionMode).toBe("shadow");
    expect(e.chosenAlias).toBe("coding"); expect(e.chosenEffort).toBe("high"); expect(e.margin).toBe(0.4);
    expect(e.decider).toEqual({ provider: "local", model: "fixed-decider-v1", latencyMs: 12 });
    expect(typeof e.decision).toBe("string"); expect(e.turn).toBe("same-user-turn");
  }
});

test("enforce applies only validated picks, passes effort, and lets adec own turn pins and hard-rule rechecks", async () => {
  const pins = new Map<string, string>();
  const s = service(body => {
    const pinned = pins.has(body.turnId), alias = pins.get(body.turnId) ?? (pins.size ? "fast" : "coding");
    pins.set(body.turnId, alias);
    return { id: "0123456789abcdef0123456789abcdef", policyId: "ahub.test", alias, effort: alias === "coding" ? "high" : "low", margin: 0.6, abstain: false, reason: pinned ? "pinned" : "ok", fallbackApplied: false, pinned, rules: [], decider: null };
  });
  const h = host(), config = { ...s.config, decision_mode: "enforce" as const };
  h.runtime.beginTurn({ turn: "first", pii: false });
  await h.runtime.call("hub/test", config, messages, "scope", false, signal());
  await h.runtime.call("hub/test", config, [...messages, { role: "tool", content: "fresh tool evidence" }], "scope", false, signal());
  h.runtime.endTurn("first", "completed"); h.runtime.beginTurn({ turn: "second", pii: false });
  await h.runtime.call("hub/test", config, messages, "scope", false, signal());
  expect(h.calls.map(call => [call.model, call.effort])).toEqual([["coding", "high"], ["coding", "high"], ["fast", "low"]]);
  expect(s.requests[0].turnId).toBe(s.requests[1].turnId); expect(s.requests[2].turnId).not.toBe(s.requests[0].turnId);
  expect(s.requests[1].constraints.current).toEqual({ alias: "coding", effort: "high" });
  expect(s.requests[1].evidence).toContain("fresh tool evidence"); // server rechecks get current bounded state, not a cached decision
});

test("adec fallback is authoritative, while no_candidate keeps the hub heuristic", async () => {
  for (const noCandidate of [false, true]) {
    const s = service(() => ({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.test", alias: noCandidate ? null : "coding", effort: noCandidate ? null : "high", margin: 0, abstain: true, reason: noCandidate ? "no_candidate" : "low_margin", fallbackApplied: !noCandidate, pinned: false, rules: [], decider: null }));
    const h = host(); h.runtime.beginTurn({ turn: "fallback", pii: false });
    await h.runtime.call("hub/test", { ...s.config, decision_mode: "enforce" }, messages, "scope", false, signal());
    expect(h.calls[0]?.model).toBe(noCandidate ? "fast" : "coding");
    expect(h.calls[0]?.effort).toBe(noCandidate ? undefined : "high");
    expect(h.events[0]?.decisionReason).toBe(noCandidate ? "no_candidate" : "low_margin");
  }
});

test("off-campus private or PII requests never build evidence; on-campus sensitive state is metadata only", async () => {
  for (const privateTurn of [false, true]) {
    const s = service(); let screens = 0;
    const h = host({ onCampus: async () => false, decisionContext: () => ({ private: privateTurn, excluded: false }), publicDecisionText: () => { screens++; return true; } });
    h.runtime.beginTurn({ turn: "sensitive", pii: !privateTurn });
    await h.runtime.call("hub/test", s.config, [{ role: "user", content: "PRIVATE_SENTINEL" }], "scope", !privateTurn, signal());
    expect(s.requests).toHaveLength(0); expect(screens).toBe(0); expect(h.events[0]?.decisionReason).toBe("off_campus");
  }
  const s = service(); let screens = 0;
  const h = host({ decisionContext: () => ({ private: true, excluded: false }), publicDecisionText: () => { screens++; return true; } });
  h.runtime.beginTurn({ turn: "campus-sensitive", pii: true });
  await h.runtime.call("hub/test", s.config, [{ role: "user", content: "PRIVATE_SENTINEL" }], "scope", true, signal());
  expect(s.requests[0].constraints).toMatchObject({ pii: true, private: true, contextTokens: 0 });
  expect(JSON.stringify(s.requests)).not.toContain("PRIVATE_SENTINEL"); expect(screens).toBe(0);
});

test("observer exclusion and missing turn identity skip adec, and host faults cannot change shadow routing", async () => {
  for (const extra of [{ decisionContext: () => ({ private: false, excluded: true }) }, { onCampus: async () => { throw new Error("private network diagnostic"); } }]) {
    const s = service(), h = host(extra); h.runtime.beginTurn({ turn: "held", pii: true });
    await h.runtime.call("hub/test", s.config, messages, "scope", true, signal());
    expect(s.requests).toHaveLength(0); expect(h.calls[0]?.model).toBe("fast"); expect(JSON.stringify(h.events)).not.toContain("private network diagnostic");
  }
  const s = service(), h = host(); await h.runtime.call("hub/test", s.config, messages, "scope", false, signal());
  expect(s.requests).toHaveLength(0); expect(h.events[0]?.decisionReason).toBe("turn_unavailable");
});

test("budget refusal before decision is not converted into an optional fallback call", async () => {
  const s = service(), h = host({ admitDecision: async () => { throw Object.assign(new Error("budget denied"), { budgetStop: true }); } });
  h.runtime.beginTurn({ turn: "budget", pii: false });
  await expect(h.runtime.call("hub/test", s.config, messages, "scope", false, signal())).rejects.toThrow("budget denied");
  expect(s.requests).toHaveLength(0); expect(h.calls).toHaveLength(0);
});

test("a closed turn or cancellation during a held decision cannot execute or emit a late route", async () => {
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { arrived = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { arrived(); await gate; return Response.json({}); } });
  close.push(() => { release(); server.stop(true); });
  const s = service(), h = host(), controller = new AbortController();
  h.runtime.beginTurn({ turn: "cancelled", pii: false });
  const pending = h.runtime.call("hub/test", { ...s.config, adec_endpoint: `http://127.0.0.1:${server.port}/v1/route` }, messages, "scope", false, controller.signal);
  const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await entered; controller.abort(); h.runtime.endTurn("cancelled", "failed"); release();
  const outcome = await settled; expect(outcome.error).toBeInstanceOf(Error); expect(outcome.error.message).toContain("turn ended");
  expect(h.calls).toHaveLength(0); expect(h.events).toHaveLength(0);
});
