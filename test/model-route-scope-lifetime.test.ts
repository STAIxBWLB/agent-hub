import { expect, test } from "bun:test";
import { HubRouteRuntime } from "../src/models/route/runtime.ts";
import { ScopeStore } from "../src/models/route/turn-state.ts";
import { planningInstruction } from "../src/models/route/hub-prompts.ts";
import type { ChatMessage } from "../src/omniroute/client.ts";

function fixture() {
  let now = 0, judges = 0;
  const executed: { model: string; messages: ChatMessage[] }[] = [];
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async (model, messages, judge) => {
    if (judge) {
      judges++;
      return { message: { role: "assistant", content: JSON.stringify({ escalate: true, category: "capability_gap", new_evidence: true, reason: "fixture evidence" }) } };
    }
    executed.push({ model, messages });
    return { message: { role: "assistant", content: "fixture answer" } };
  } });
  // Instance-local fixture replacement reuses the owned ScopeStore clock seam; production clocks and APIs stay untouched.
  Object.defineProperty(runtime, "states", { value: new ScopeStore({ now: () => now }) });
  return { runtime, executed, judges: () => judges, minute: (value: number) => { now = value * 60_000; } };
}

test("active escalation scope preserves its established latch beyond one hour", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const config = { type: "escalation" as const, efficient: "efficient", capable: "capable", judge: "judge", confirmations: 1 };
  await f.runtime.call("scope/escalation", config, [{ role: "user", content: "work" }], "busy", false, signal);
  f.minute(30); await f.runtime.call("scope/escalation", config, [], "busy", false, signal);
  f.minute(61); await f.runtime.call("scope/escalation", config, [], "busy", false, signal);
  expect(f.executed.map(call => call.model)).toEqual(["efficient", "capable", "capable", "capable"]);
  expect(f.judges()).toBe(1);
});

test("active plan-execute scope keeps executing without a planning instruction past one hour", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const config = { type: "plan_execute" as const, efficient: "efficient", capable: "capable" };
  await f.runtime.call("scope/phase", config, [{ role: "user", content: "plan" }], "busy", false, signal);
  const mutation: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [{ id: "write", type: "function",
    function: { name: "write_file", arguments: JSON.stringify({ path: "fixture.ts", content: "fixture" }) } }] },
  { role: "tool", tool_call_id: "write", content: "write completed" }];
  f.minute(30); await f.runtime.call("scope/phase", config, mutation, "busy", false, signal);
  f.minute(61); await f.runtime.call("scope/phase", config, [{ role: "user", content: "continue" }], "busy", false, signal);
  expect(f.executed.map(call => call.model)).toEqual(["capable", "efficient", "efficient"]);
  expect(f.executed[0]?.messages[0]?.content).toBe(planningInstruction);
  expect(f.executed.at(-1)?.messages.some(message => message.content === planningInstruction)).toBe(false);
});

test("active advisor scope does not re-arm its completed review budget after one hour", async () => {
  let now = 0, calls = 0;
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async () => {
    calls++; return { message: { role: "assistant", content: "APPROVE" } };
  } });
  Object.defineProperty(runtime, "states", { value: new ScopeStore({ now: () => now }) });
  const config = { type: "advisor" as const, max_reviews: 1 }, messages: ChatMessage[] = [{ role: "assistant", content: "ready" }];
  await runtime.review("scope/advisor", config, messages, "busy", false, new AbortController().signal);
  now = 30 * 60_000; await runtime.review("scope/advisor", config, messages, "busy", false, new AbortController().signal);
  now = 61 * 60_000; await runtime.review("scope/advisor", config, messages, "busy", false, new AbortController().signal);
  expect(calls).toBe(1);
});

test("an authority fence after execution names the executor-reply step", async () => {
  const controller = new AbortController(); let calls = 0;
  const runtime = new HubRouteRuntime({ onCampus: async () => true, admitDecision: async () => false, execute: async () => {
    calls++; controller.abort(); return { message: { role: "assistant", content: "completed before abort" } };
  } });
  await expect(runtime.call("scope/ended", { type: "plan_execute", efficient: "fast", capable: "coding",
    decision_backend: "adec", decision_mode: "shadow", policy_id: "fixture", adec_endpoint: "http://127.0.0.1:1/v1/route",
    candidates: [{ alias: "fast", efforts: ["none"] }, { alias: "coding", efforts: ["none"] }] }, [], "busy", false, controller.signal)).rejects.toThrow("executor reply");
  expect(calls).toBe(1);
});

test("optional advisor-label failure does not discard semantic REDO feedback", async () => {
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async () => ({ message: {
    role: "assistant", content: "REDO: add the missing check" } }) });
  const labels = Object.getOwnPropertyDescriptor(runtime, "labels")!.value as { observeAdvisor(): void };
  labels.observeAdvisor = () => { throw new Error("fixture optional telemetry failed"); };
  const feedback = await runtime.review("scope/telemetry", { type: "advisor", max_reviews: 1 },
    [{ role: "assistant", content: "ready" }], "busy", false, new AbortController().signal);
  expect(feedback).toContain("add the missing check");
});
