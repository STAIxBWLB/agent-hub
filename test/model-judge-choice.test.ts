import { expect, test } from "bun:test";
import { createRouteObservationCollector } from "../scripts/benchmarks/model-routing-corpus.ts";
import type { HubEvent, StampedEvent } from "../src/hub/events.ts";
import type { RouteEvent } from "../src/models/route/runtime.ts";
import { summarize, summarizeByTask } from "../src/hub/report.ts";
import { taskRecords } from "../src/hub/research.ts";
import { buildResearchQuality, type QualityReport } from "../src/hub/research-quality.ts";
import { parseHubRoutes } from "../src/models/route/config.ts";
import { hostChoicePacket, runHostJudge, startChoiceWindow, type ChoiceWindow } from "../src/models/route/judge-choice.ts";
import { buildStageEvidence } from "../src/models/route/stage-evidence.ts";
import { captureStageInput } from "../src/models/route/stage-input.ts";
import { DecisionPolicyChangedError } from "../src/models/route/decision.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const stamp = (seconds: number, event: HubEvent): StampedEvent => ({ v: 1, at: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(), ...event });
const executor = (): Extract<HubEvent, { type: "route" }> => ({ type: "route", peer: "local", route: "hub/fixture", tier: "fast", source: "default", score: 0, ms: 1 });
const judge = (): Extract<HubEvent, { type: "route" }> => ({ ...executor(), tier: "coding", decisionTarget: "judge", decisionMode: "shadow", chosenAlias: "coding", chosenEffort: "high", margin: 0.8 });

test("judge observations cannot change report time bounds, decisions, switches or task accounting", () => {
  const baseline = [stamp(10, executor()), stamp(20, executor())];
  const observed = [stamp(0, judge()), baseline[0]!, stamp(15, judge()), baseline[1]!, stamp(30, judge())];
  expect(summarize(observed)).toEqual(summarize(baseline));
  expect(summarizeByTask(observed)).toEqual(summarizeByTask(baseline));
  expect(summarize(observed).routes["local hub/fixture"]).toMatchObject({ decisions: 2, switches: 0 });
});

function researchEvents(): StampedEvent[] {
  const task = { type: "task" as const, id: 51, by: "local", owner: "local", reviewer: "claude", class: "implement", pii: false };
  return [stamp(1, { ...task, event: "proposed", state: "proposed" }),
    stamp(2, { ...task, event: "accepted", state: "in_progress" }),
    stamp(3, { ...executor(), task: 51 }),
    stamp(4, { ...task, event: "approved", state: "approved" })];
}

test("even a linked judge row cannot create research peer, model, privacy or cohort credit", () => {
  const events = researchEvents();
  // Defensive reader case: the approved producer omits this task/PII linkage.
  const linked = stamp(3.5, { ...judge(), task: 51, pii: true, peer: "metadata-only", route: "hub/observer-only" });
  const baseline = taskRecords(events, "fixture-project", { version: "0.0.0", source: "backfill" });
  const observed = taskRecords([...events.slice(0, 3), linked, ...events.slice(3)], "fixture-project", { version: "0.0.0", source: "backfill" });
  expect(baseline).toHaveLength(1);
  expect(observed).toEqual(baseline);
});

function businessQuality(value: QualityReport) {
  // Enumerate ALL non-census fields; a future field requires an explicit audit.
  expect(Object.keys(value).sort()).toEqual(["schema", "window", "records", "fields", "quota", "budget", "outcomes", "tokenAttribution", "events"].sort());
  return { schema: value.schema, window: value.window, records: value.records, fields: value.fields, quota: value.quota,
    budget: value.budget, outcomes: value.outcomes, tokenAttribution: value.tokenAttribution };
}

test("quality business fields stay byte-identical while raw route census truthfully includes judge rows", () => {
  const events = researchEvents(), records = taskRecords(events, "fixture-project", { version: "0.0.0", source: "backfill" });
  const observedEvents = [...events, stamp(5, judge()), stamp(6, judge())];
  const baseline = buildResearchQuality(records, events), observed = buildResearchQuality(records, observedEvents);
  expect(JSON.stringify(businessQuality(observed))).toBe(JSON.stringify(businessQuality(baseline)));
  expect(observed.events.absent).toEqual(baseline.events.absent);
  const otherTypes = (value: QualityReport) => Object.fromEntries(Object.entries(value.events.present).filter(([type]) => type !== "route"));
  expect(JSON.stringify(otherTypes(observed))).toBe(JSON.stringify(otherTypes(baseline)));
  expect(observed.events.present.route).toBe((baseline.events.present.route ?? 0) + 2);
});

test("the owned corpus callback retains the last executor observation, not judge metadata", () => {
  const kept: RouteEvent[] = [], observed: Readonly<RouteEvent>[] = [];
  const collect = createRouteObservationCollector(kept, event => { observed.push(event); });
  collect({ route: "hub/fixture", tier: "fast", source: "hold", score: 1, ms: 1, staySwitch: "shadow", prefillTokens: 100 });
  collect({ route: "hub/fixture", tier: "coding", source: "default", score: 0, ms: 1, decisionTarget: "judge" });
  expect(kept).toHaveLength(1);
  expect(kept.at(-1)).toMatchObject({ tier: "fast", source: "hold", staySwitch: "shadow", prefillTokens: 100 });
  expect(observed).toHaveLength(2);
  expect(observed.every(event => Object.isFrozen(event))).toBe(true);
});

for (const type of ["plan_execute", "advisor", "escalation"] as const) {
  test(`${type} optional policy binding shares validation and never admits enforce`, () => {
    const binding = { type, decision_backend: "adec", policy_id: "ahub.fixture", candidates: [{ alias: "coding", efforts: ["high"] }] };
    const parse = (value: unknown) => parseHubRoutes({ "hub/fixture": value })["hub/fixture"];
    expect(parse({ type })?.decision_mode).toBeUndefined();
    expect(parse(binding)?.decision_mode).toBe("off");
    expect(parse({ ...binding, decision_mode: "shadow" })?.decision_mode).toBe("shadow");
    expect(parse(binding)?.adec_endpoint).toBe("http://127.0.0.1:8740/v1/route");
    expect(() => parse({ ...binding, decision_mode: "enforce" })).toThrow("decision_mode enforce is not available yet");
    for (const invalid of [{ decision_backend: "other" }, { policy_id: "../outside" }, { candidates: [] },
      { adec_endpoint: "https://example.invalid/v1/route" }, { decision_timeout_ms: 0 }, { decision_timeout_ms: 30_001 }]) {
      expect(() => parse({ ...binding, ...invalid })).toThrow(/routing\.toml/);
    }
    expect(() => parse({ type, decision_mode: "shadow" })).toThrow(/routing\.toml/);
  });
}

test("host choice evidence is closed, bounded and sensitive dimensions only", () => {
  const evidence = buildStageEvidence(captureStageInput([{ role: "user", content: "INPUT-SENTINEL" }])!);
  const packet = hostChoicePacket(evidence, "plan_execute_model", "planning", false);
  expect(packet).toBeDefined();
  expect(Buffer.byteLength(packet!, "utf8")).toBeLessThanOrEqual(1024);
  expect(JSON.parse(packet!)).toMatchObject({ purpose: "plan_execute_model", phase: "planning", stage: { kind: "stage-route-evidence" } });
  expect(packet).not.toContain("INPUT-SENTINEL");
  const privatePacket = JSON.parse(hostChoicePacket(evidence, "advisor_judge_model", undefined, true)!);
  expect(Object.keys(privatePacket).sort()).toEqual(["schemaVersion", "kind", "dimensions"].sort());
  expect(hostChoicePacket(evidence, "advisor_judge_model", "planning", false)).toBeUndefined();
});

for (const outcome of ["resolve", "reject"] as const) test(`closed observer consumes late common ${outcome} without HTTP or effects`, async () => {
  const gate = deferred<number>(), entered = deferred<void>();
  let requests = 0, traces = 0, memos = 0, warnings = 0;
  const window = startChoiceWindow({ signal: new AbortController().signal,
    prepare: async () => { entered.resolve(undefined); return gate.promise; },
    request: async () => { requests++; traces++; memos++; warnings++; return "not authorized"; },
  });
  await entered.promise;
  const closing = window.close();
  expect(window.close()).toBe(closing);
  expect(await closing).toBeUndefined();
  if (outcome === "resolve") gate.resolve(1); else gate.reject(new Error("late owned host failure"));
  await window.commonSettled;
  expect(await window.result).toBeUndefined();
  expect({ requests, traces, memos, warnings }).toEqual({ requests: 0, traces: 0, memos: 0, warnings: 0 });
});

test("closing aborts and joins a started owned request before it resolves", async () => {
  const entered = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<string | undefined>();
  const window = startChoiceWindow({ signal: new AbortController().signal, prepare: async () => 1,
    request: async (_prepared, signal) => { signal.addEventListener("abort", () => aborted.resolve(undefined), { once: true }); entered.resolve(undefined); return cleanup.promise; },
  });
  await entered.promise;
  let finished = false;
  const closing = window.close().then(value => { finished = true; return value; });
  await aborted.promise;
  expect(finished).toBe(false);
  cleanup.resolve("late trace");
  expect(await closing).toBeUndefined();
  expect(finished).toBe(true);
  expect(await window.result).toBeUndefined();
});

test("observed authority refusal propagates before logical close", async () => {
  const failure = new DecisionPolicyChangedError();
  const window = startChoiceWindow({ signal: new AbortController().signal,
    prepare: async () => { throw failure; }, request: async () => "never", });
  let resultError: unknown, closeError: unknown;
  try { await window.result; } catch (error) { resultError = error; }
  try { await window.close(); } catch (error) { closeError = error; }
  expect(resultError).toBe(failure);
  expect(closeError).toBe(failure);
});

test("parent abort closes pending common work without starting HTTP", async () => {
  const parent = new AbortController(), gate = deferred<number>(), entered = deferred<void>();
  let requests = 0;
  const window = startChoiceWindow({ signal: parent.signal,
    prepare: async () => { entered.resolve(undefined); return gate.promise; }, request: async () => { requests++; return "never"; } });
  await entered.promise;
  parent.abort();
  expect(await window.result).toBeUndefined();
  gate.resolve(1); await window.commonSettled;
  expect(requests).toBe(0);
  await window.close();
});

test("actual fallback admission port runs first and normal observer close is not fallback failure", async () => {
  const answer = deferred<string>(), http = deferred<string>(), admitted = deferred<void>(), httpEntered = deferred<void>(), order: string[] = [];
  let observation: ChoiceWindow<string> | undefined;
  const running = runHostJudge({ parent: new AbortController().signal, timeoutMs: 1000, current: () => {}, common: async () => true,
    fallback: async () => { order.push("fallback-quota-admitted"); admitted.resolve(undefined); return answer.promise; },
    observe: signal => observation = startChoiceWindow({ signal,
      prepare: async () => { order.push("observer-service-admitted"); return 1; },
      request: async () => { order.push("owned-http-started"); httpEntered.resolve(undefined); return http.promise; },
    }),
  });
  await admitted.promise; await httpEntered.promise;
  expect(order).toEqual(["fallback-quota-admitted", "observer-service-admitted", "owned-http-started"]);
  http.resolve("checked trace");
  expect(await observation!.result).toBe("checked trace");
  answer.resolve("APPROVE");
  expect(await running).toEqual({ value: "APPROVE", observation: "checked trace" });
});


test("host judge aborts its fallback even when observer close rethrows an authority refusal", async () => {
  const failure = new DecisionPolicyChangedError();
  const fallback = deferred<string | undefined>();
  let signal: AbortSignal | undefined, aborted = 0, requests = 0;
  let observation: ChoiceWindow<string> | undefined;
  const running = runHostJudge<string, string>({
    parent: new AbortController().signal, timeoutMs: 1000, current: () => {}, common: async () => true,
    fallback: current => {
      signal = current;
      current.addEventListener("abort", () => { aborted++; fallback.resolve(undefined); }, { once: true });
      return fallback.promise;
    },
    observe: current => observation = startChoiceWindow({ signal: current,
      prepare: async () => { throw failure; }, request: async () => { requests++; return "not authorized"; },
    }),
  });
  try {
    await expect(running).rejects.toBe(failure);
    await observation!.commonSettled;
    expect(signal?.aborted).toBe(true);
    expect(aborted).toBe(1);
    expect(requests).toBe(0);
  } finally {
    fallback.resolve(undefined);
    await fallback.promise;
  }
});
