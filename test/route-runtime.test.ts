import { expect, test } from "bun:test";
import { HubRouteRuntime } from "../src/models/route/runtime.ts";
import type { ChatMessage } from "../src/omniroute/client.ts";

const messages: ChatMessage[] = [{ role: "user", content: "finish" }, { role: "assistant", content: "held answer" }];
test("optional judges have one deadline and back off instead of delaying every answer", async () => {
  let n = 0, cancelled = false;
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async (_model, _messages, _judge, signal) => { n++; return new Promise(resolve => signal.addEventListener("abort", () => { cancelled = true; resolve({ message: { role: "assistant", content: "APPROVE" } }); }, { once: true })); } }, 15);
  const start = performance.now();
  expect(await runtime.review("hub/review", { type: "advisor" }, messages, "s", false, new AbortController().signal)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(300);
  expect(cancelled).toBe(true);
  expect(await runtime.review("hub/review", { type: "advisor" }, messages, "s", false, new AbortController().signal)).toBeUndefined();
  expect(n).toBe(1);
});

test("PII optional judges skip transport when campus confirmation is absent", async () => {
  let n = 0;
  const runtime = new HubRouteRuntime({ onCampus: async () => false, execute: async () => { n++; return { message: { role: "assistant", content: "REDO leak" } }; } });
  expect(await runtime.review("hub/review", { type: "advisor" }, messages, "private", true, new AbortController().signal)).toBeUndefined();
  expect(n).toBe(0);
});

test("escalation confirms fresh same-category verdicts and then replaces the efficient answer", async () => {
  const models: string[] = [];
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async (model, _messages, judge, _signal, maxTokens) => { if (judge) expect(maxTokens).toBe(256); models.push(`${model}:${judge}`); return { message: { role: "assistant", content: judge ? JSON.stringify({ escalate: true, category: "repetition", new_evidence: true, reason: "same failure" }) : model } }; } });
  const route = { type: "escalation" as const };
  const signal = new AbortController().signal;
  expect((await runtime.call("hub/esc", route, messages, "s", false, signal)).message.content).toBe("fast");
  expect((await runtime.call("hub/esc", route, messages, "s", false, signal)).message.content).toBe("coding");
  expect((await runtime.call("hub/esc", route, messages, "s", false, signal)).message.content).toBe("coding");
  expect(models).toEqual(["fast:false", "coding:true", "fast:false", "coding:true", "coding:false", "coding:false"]);
});
