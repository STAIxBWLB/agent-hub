import { expect, test } from "bun:test";
import { runCase, type RouteCase } from "../scripts/benchmarks/model-routing-corpus.ts";
import type { Routing } from "../src/hub/routing.ts";
import type { RouteEvent } from "../src/models/route/runtime.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const FALLBACK_JUDGE = "fixture-judge";
const CHOSEN_JUDGE = "fixture-advisor-reviewer";
const ROUTE_ID = "hub/route-event-parity";
const ADVISOR_CASE: RouteCase = {
  id: "normalized-event-parity-controlled-advisor",
  split: "test",
  note: "An optional advisor judge choice observes a valid pair without changing executor behavior.",
  kind: "route",
  route: ROUTE_ID,
  turns: [
    { op: "call", messages: [{ role: "user", content: "Synthetic executor request one." }], expect: { tier: "efficient" } },
    { op: "call", messages: [{ role: "user", content: "Synthetic executor request two." }], expect: { tier: "efficient" } },
    { op: "review", messages: [
      { role: "user", content: "Synthetic executor request." },
      { role: "assistant", content: "Synthetic completed answer." },
    ], judge: ["APPROVE"], expect: { judgeCalls: 1, outcome: "approve" } },
  ],
};
const NEGATIVE_ESCALATION_REPLY = JSON.stringify({ escalate: false, category: "none", new_evidence: false, reason: "synthetic negative escalation" });
const ESCALATION_CASE: RouteCase = {
  id: "normalized-event-parity-controlled-escalation",
  split: "test",
  note: "A negative host escalation judge reply keeps repeated executor calls below the escalation latch.",
  kind: "route",
  route: ROUTE_ID,
  turns: [
    { op: "call", messages: [{ role: "user", content: "Synthetic escalation input one." }], judge: [NEGATIVE_ESCALATION_REPLY], expect: { judgeCalls: 1 } },
    { op: "call", messages: [{ role: "user", content: "Synthetic escalation input two." }], judge: [NEGATIVE_ESCALATION_REPLY], expect: { judgeCalls: 1 } },
  ],
};
const PLAN_EXECUTE_CASE: RouteCase = {
  id: "normalized-event-parity-controlled-plan-execute",
  split: "test",
  note: "The optional phase model choice records planning and execution evidence without applying its alternate pair.",
  kind: "route",
  route: ROUTE_ID,
  turns: [
    { op: "call", messages: [{ role: "user", content: "Synthetic planning input." }], expect: { tier: "capable", planned: true } },
    { op: "call", messages: [
      { role: "user", content: "Synthetic planning input." },
      { role: "assistant", content: null, tool_calls: [{ id: "synthetic-write", type: "function", function: { name: "write_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "synthetic-write", content: "Synthetic write completed.", is_error: false },
    ], expect: { tier: "efficient", planned: false } },
  ],
};

function fixtureRouting(mode: "off" | "shadow", endpoint: string, type: "advisor" | "escalation" | "plan_execute"): Routing {
  return {
    hub_routes: {
      [ROUTE_ID]: {
        type,
        efficient: "fixture-executor-fast",
        capable: "fixture-executor-capable",
        judge: FALLBACK_JUDGE,
        trigger: "no_tool_call",
        decision_backend: "adec",
        decision_mode: mode,
        policy_id: "ahub.event-parity",
        adec_endpoint: endpoint,
        decision_timeout_ms: 10_000,
        confirmations: 2,
        candidates: [
          { alias: FALLBACK_JUDGE, efforts: ["none"] },
          { alias: CHOSEN_JUDGE, efforts: ["high"] },
        ],
      },
    },
  } as unknown as Routing;
}

interface Observation {
  result: Awaited<ReturnType<typeof runCase>>;
  routeEvents: RouteEvent[];
  executeJson: string[];
  choicePreparedCalls: number;
  fallbackReplyGates: number;
}

async function observe(routeCase: RouteCase, type: "advisor" | "escalation" | "plan_execute", mode: "off" | "shadow", endpoint: string, expectedJudgeReplies: number, expectedChoices = expectedJudgeReplies): Promise<Observation> {
  const choiceSeen = Array.from({ length: expectedChoices }, () => deferred<void>());
  const choiceSettled = Array.from({ length: expectedChoices }, () => deferred<void>());
  for (const gate of choiceSettled) void gate.promise.catch(() => {});
  const routeEvents: RouteEvent[] = [], executeJson: string[] = [];
  let choicePreparedCalls = 0, fallbackReplyGates = 0;
  const replyWork: Promise<void>[] = [];
  let result!: Awaited<ReturnType<typeof runCase>>;
  try { result = await runCase(routeCase, fixtureRouting(mode, endpoint, type), {
    turnContext: { turn: "fixture-route-event-parity-turn", pii: false },
    observeRoute: event => { routeEvents.push(structuredClone(event)); },
    observeExecute: call => { executeJson.push(JSON.stringify(call)); },
    choicePrepared: ready => {
      const index = choicePreparedCalls++;
      if (!choiceSeen[index] || !choiceSettled[index]) throw new Error("unexpected extra judge-choice readiness");
      choiceSeen[index]!.resolve(undefined);
      void ready.then(() => choiceSettled[index]!.resolve(undefined), error => choiceSettled[index]!.reject(error));
    },
    beforeJudgeReply: () => {
      const index = fallbackReplyGates++;
      const work = (async () => {
        if (mode === "shadow") {
          if (index >= expectedJudgeReplies || !choiceSeen[index] || !choiceSettled[index]) throw new Error("judge reply has no expected choice readiness");
          await choiceSeen[index]!.promise;
          await choiceSettled[index]!.promise;
        }
      })();
      replyWork.push(work);
      void work.catch(() => {});
      return work;
    },
  }); } finally {
    for (const gate of choiceSeen) gate.resolve(undefined);
    for (const gate of choiceSettled) gate.resolve(undefined);
    await Promise.allSettled(replyWork);
  }
  return { result, routeEvents, executeJson, choicePreparedCalls, fallbackReplyGates };
}

function executorEvents(events: readonly RouteEvent[]): RouteEvent[] {
  return events.filter(event => event.decisionTarget !== "judge");
}

function normalizedExecutorJson(off: readonly RouteEvent[], shadow: readonly RouteEvent[]): [string, string] {
  expect(off).toHaveLength(2);
  expect(shadow).toHaveLength(off.length);
  const leftIds: string[] = [], rightIds: string[] = [];
  for (let i = 0; i < off.length; i++) {
    const a = off[i]!, b = shadow[i]!;
    expect(Object.hasOwn(a, "ms")).toBe(Object.hasOwn(b, "ms"));
    expect(typeof a.ms).toBe("number");
    expect(typeof b.ms).toBe("number");
    expect(Number.isFinite(a.ms)).toBe(true);
    expect(Number.isFinite(b.ms)).toBe(true);
    expect(Object.hasOwn(a, "decision")).toBe(Object.hasOwn(b, "decision"));
    expect(typeof a.decision).toBe("string");
    expect(typeof b.decision).toBe("string");
    expect(a.decision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(b.decision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    leftIds.push(a.decision!); rightIds.push(b.decision!);
  }
  expect(new Set(leftIds).size).toBe(leftIds.length);
  expect(new Set(rightIds).size).toBe(rightIds.length);
  const mapping = new Map(leftIds.map((id, i) => [id, rightIds[i]!]));
  expect(mapping.size).toBe(leftIds.length);
  expect(new Set(mapping.values()).size).toBe(rightIds.length);
  const leftCanonical = new Map(leftIds.map((id, i) => [id, `mapped-decision-${i}`]));
  const rightCanonical = new Map([...mapping].map(([left, right]) => [right, leftCanonical.get(left)!]));
  const normalized = (events: readonly RouteEvent[], ids: ReadonlyMap<string, string>) => events.map(event => {
    const copy = structuredClone(event) as RouteEvent;
    copy.ms = 0;
    const canonical = ids.get(event.decision!);
    expect(canonical).toBeDefined();
    copy.decision = canonical!;
    return copy;
  });
  return [JSON.stringify(normalized(off, leftCanonical)), JSON.stringify(normalized(shadow, rightCanonical))];
}

test("normalized event parity for advisor/escalation and plan-execute fallback choices", async () => {
  let serviceRequests = 0;
  const evidencePackets: { purpose?: string; phase?: string }[] = [];
  const adec = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async request => {
      serviceRequests++;
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/route") return new Response("unexpected fixture path", { status: 404 });
      const body = await request.json() as { evidence: string };
      const packet = JSON.parse(body.evidence) as { purpose?: string; phase?: string };
      evidencePackets.push({ purpose: packet.purpose, ...(packet.phase === undefined ? {} : { phase: packet.phase }) });
      return Response.json({
        id: "0123456789abcdef0123456789abcdef",
        policyId: "ahub.event-parity",
        alias: CHOSEN_JUDGE,
        effort: "high",
        margin: 0.75,
        abstain: false,
        reason: "ok",
        fallbackApplied: false,
        pinned: false,
        rules: [],
        decider: null,
      });
    },
  });
  const endpoint = `http://127.0.0.1:${adec.port}/v1/route`;
  try {
    const offAdvisor = await observe(ADVISOR_CASE, "advisor", "off", endpoint, 1);
    expect(serviceRequests).toBe(0);
    const shadowAdvisor = await observe(ADVISOR_CASE, "advisor", "shadow", endpoint, 1);
    expect(serviceRequests).toBe(1);

    const offEscalation = await observe(ESCALATION_CASE, "escalation", "off", endpoint, 2);
    expect(serviceRequests).toBe(1);
    const shadowEscalation = await observe(ESCALATION_CASE, "escalation", "shadow", endpoint, 2);
    expect(serviceRequests).toBe(3);

    assertParity(offAdvisor, shadowAdvisor, {
      executorEvents: 2, judgeRows: 1, executeCalls: 3,
      judgeMaxTokens: 2048, judgeCallsByTurn: [0, 0, 1], tiers: ["efficient", "efficient", "none"], outcomes: ["none", "none", "approve"],
    });
    assertParity(offEscalation, shadowEscalation, {
      executorEvents: 2, judgeRows: 2, executeCalls: 4,
      judgeMaxTokens: 256, judgeCallsByTurn: [1, 1], tiers: ["efficient", "efficient"], outcomes: ["none", "none"],
    });

    const evidenceStart = evidencePackets.length;
    const offPlan = await observe(PLAN_EXECUTE_CASE, "plan_execute", "off", endpoint, 0);
    expect(serviceRequests).toBe(3);
    const shadowPlan = await observe(PLAN_EXECUTE_CASE, "plan_execute", "shadow", endpoint, 0);
    expect(serviceRequests).toBe(5);
    expect(evidencePackets.slice(evidenceStart)).toEqual([
      { purpose: "plan_execute_model", phase: "planning" },
      { purpose: "plan_execute_model", phase: "executing" },
    ]);
    expect(offPlan.choicePreparedCalls).toBe(0);
    expect(shadowPlan.choicePreparedCalls).toBe(0);
    expect(executorEvents(offPlan.routeEvents)).toHaveLength(2);
    expect(executorEvents(shadowPlan.routeEvents)).toHaveLength(2);
    expect(offPlan.routeEvents.filter(event => event.decisionTarget === "judge")).toHaveLength(0);
    expect(shadowPlan.routeEvents.filter(event => event.decisionTarget === "judge")).toHaveLength(0);
    for (const event of executorEvents(shadowPlan.routeEvents)) {
      expect(event).toMatchObject({ decisionMode: "shadow", chosenAlias: CHOSEN_JUDGE, chosenEffort: "high" });
      expect(Object.hasOwn(event, "phase")).toBe(false);
      expect(Object.hasOwn(event, "purpose")).toBe(false);
    }
    expect(offPlan.executeJson).toHaveLength(2);
    expect(shadowPlan.executeJson).toHaveLength(2);
    expect(JSON.stringify(shadowPlan.executeJson)).toBe(JSON.stringify(offPlan.executeJson));
    const executed = shadowPlan.executeJson.map(row => JSON.parse(row) as { model: string; judge: boolean });
    expect(executed.map(call => call.model)).toEqual(["fixture-executor-capable", "fixture-executor-fast"]);
    expect(executed.map(call => call.judge)).toEqual([false, false]);
    expect(executed.some(call => call.model === CHOSEN_JUDGE)).toBe(false);
    if (!("turns" in offPlan.result) || !("turns" in shadowPlan.result)) throw new Error("plan/execute case did not return turn observations");
    const offPlanTurns = offPlan.result.turns, shadowPlanTurns = shadowPlan.result.turns;
    const fallbackOutcomes = (turns: typeof offPlanTurns) => turns.map(({ tier, planned, judgeCalls, outcome }) => ({ tier, planned, judgeCalls, outcome }));
    expect(fallbackOutcomes(offPlanTurns)).toEqual([
      { tier: "capable", planned: true, judgeCalls: 0, outcome: "none" },
      { tier: "efficient", planned: false, judgeCalls: 0, outcome: "none" },
    ]);
    expect(fallbackOutcomes(shadowPlanTurns)).toEqual(fallbackOutcomes(offPlanTurns));
  } finally {
    await adec.stop(true);
  }
});

function assertParity(off: Observation, shadow: Observation, expected: {
  executorEvents: number; judgeRows: number; executeCalls: number;
  judgeMaxTokens: number; judgeCallsByTurn: number[]; tiers: string[]; outcomes: string[];
}): void {
  expect(off.choicePreparedCalls).toBe(0);
  expect(shadow.choicePreparedCalls).toBe(expected.judgeRows);
  expect(off.fallbackReplyGates).toBe(expected.judgeRows);
  expect(shadow.fallbackReplyGates).toBe(expected.judgeRows);

  const offJudge = off.routeEvents.filter(event => event.decisionTarget === "judge");
  const shadowJudge = shadow.routeEvents.filter(event => event.decisionTarget === "judge");
  expect(offJudge).toHaveLength(0);
  expect(shadowJudge).toHaveLength(expected.judgeRows);
  for (const event of shadowJudge) {
    expect(event).toMatchObject({ decisionMode: "shadow", chosenAlias: CHOSEN_JUDGE, chosenEffort: "high" });
    expect(event.chosenAlias).not.toBe(FALLBACK_JUDGE);
    expect({ alias: event.chosenAlias, effort: event.chosenEffort }).not.toEqual({ alias: FALLBACK_JUDGE, effort: "none" });
  }

  const offExecutorEvents = executorEvents(off.routeEvents), shadowExecutorEvents = executorEvents(shadow.routeEvents);
  expect(offExecutorEvents).toHaveLength(expected.executorEvents);
  expect(shadowExecutorEvents).toHaveLength(expected.executorEvents);
  const [normalizedOffEvents, normalizedShadowEvents] = normalizedExecutorJson(offExecutorEvents, shadowExecutorEvents);
  expect(normalizedShadowEvents).toBe(normalizedOffEvents);

  // These are actual model/messages/judge/maxTokens call arguments before the fake replies; the API has no effort argument.
  expect(off.executeJson).toHaveLength(expected.executeCalls);
  expect(shadow.executeJson).toHaveLength(expected.executeCalls);
  expect(JSON.stringify(shadow.executeJson)).toBe(JSON.stringify(off.executeJson));
  const shadowExecutions = shadow.executeJson.map(row => JSON.parse(row) as { model: string; judge: boolean; maxTokens?: number });
  expect(shadowExecutions.filter(call => call.judge)).toHaveLength(expected.judgeRows);
  expect(shadowExecutions.filter(call => call.judge).every(call => call.model === FALLBACK_JUDGE && call.maxTokens === expected.judgeMaxTokens)).toBe(true);
  expect(shadowExecutions.some(call => call.model === CHOSEN_JUDGE)).toBe(false);

  expect("error" in off.result).toBe(false);
  expect("error" in shadow.result).toBe(false);
  if (!("turns" in off.result) || !("turns" in shadow.result)) throw new Error("route case did not return turn observations");
  expect(off.result.turns.map(turn => turn.judgeCalls)).toEqual(expected.judgeCallsByTurn);
  expect(shadow.result.turns.map(turn => turn.judgeCalls)).toEqual(expected.judgeCallsByTurn);
  expect(off.result.turns.map(turn => turn.tier)).toEqual(expected.tiers);
  expect(shadow.result.turns.map(turn => turn.tier)).toEqual(expected.tiers);
  expect(off.result.turns.map(turn => turn.outcome)).toEqual(expected.outcomes);
  expect(shadow.result.turns.map(turn => turn.outcome)).toEqual(expected.outcomes);
  expect(JSON.stringify(shadow.result)).toBe(JSON.stringify(off.result));
}
