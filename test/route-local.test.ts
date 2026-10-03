import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import type { RouteEvent } from "../src/models/route/runtime.ts";
import type { RouteLabelEvent } from "../src/models/route/labels.ts";
import type { HubRoute } from "../src/models/route/config.ts";
import { parseHubRoutes } from "../src/models/route/config.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { switchyardToml } from "../src/switchyard/config.ts";
import { startFakeModelServer, toolCall, type Script } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
const savedKey = process.env.OMNIROUTE_API_KEY;
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); if (savedKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = savedKey; });
async function fixture(route: HubRoute, script: Script, extra: Partial<LocalOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-route-local-"));
  writeFileSync(join(cwd, "a.txt"), "Traceback (most recent call last):\nImportError: missing module");
  const model = startFakeModelServer({ key: "fake-route-key", script });
  process.env.OMNIROUTE_API_KEY = "fake-route-key";
  const omni = new OmniRoute({ urls: [model.url], access_hosts: [] });
  const routes: string[] = [], answers: string[] = [];
  const routeEvents: RouteEvent[] = [], outcomes: RouteLabelEvent[] = [];
  const peer = new LocalPeer("local", { cwd, omni, fixedModel: "fixed", route: "hub/test", hubRoutes: () => ({ "hub/test": route }), tools: { deny: [], permit: async () => true }, maxSteps: 8, ...extra, onRoute: e => { routes.push(e.tier); routeEvents.push(e); extra.onRoute?.(e); }, onRouteOutcome: e => { outcomes.push(e); extra.onRouteOutcome?.(e); } });
  peer.onMessage = text => { answers.push(text); };
  await peer.start(); cleanup.push(model.stop, () => peer.stop());
  const run = async () => {
    await peer.deliver([newEnvelope("user", "Complete the task", { to: ["local"], priority: "important" })]);
    for (let i = 0; i < 400 && peer.state === "busy"; i++) await Bun.sleep(10);
    expect(peer.state).toBe("idle");
  };
  return { peer, model, routes, routeEvents, outcomes, answers, run };
}

test("local stage routes repeated failures to capable and preserves whole completed tool batches", async () => {
  const f = await fixture({ type: "stage" }, body => {
    const n = body.messages.filter(m => m.role === "tool").length;
    return n < 2 ? { tool_calls: [toolCall("bash", { command: "printf 'ImportError: missing module\n'; exit 1" })] } : { content: "completed" };
  });
  await f.run();
  expect(f.routes[0]).toBe("fast");
  expect(f.routes.at(-1)).toBe("coding");
  expect(f.answers).toEqual(["completed"]);
  expect(f.model.requests.at(-1)!.body.messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
});

test("local plan/execute changes tier after the first mutation", async () => {
  const f = await fixture({ type: "plan_execute" }, body => body.messages.some(m => m.role === "tool") ? { content: "done" } : { tool_calls: [toolCall("write", { path: "out.txt", content: "ok" })] });
  await f.run();
  expect(f.routes).toEqual(["coding", "fast"]);
});

test("advisor REDO re-enters the same turn and retains feedback for the next turn", async () => {
  let reviewed = 0;
  const f = await fixture({ type: "advisor", max_reviews: 1 }, body => {
    if (body.model === "coding") { reviewed++; return { content: "REDO: verify the result" }; }
    return { content: body.messages.some(m => m.role === "user" && m.content?.includes("senior reviewer")) ? "verified" : "draft" };
  });
  await f.run(); expect(f.answers).toEqual(["verified"]); expect(reviewed).toBe(1);
  await f.run(); expect(reviewed).toBe(1);
  expect(JSON.stringify(f.model.requests.at(-1)!.body.messages)).toContain("verify the result");
});

test("advisor APPROVE and malformed/unavailable judges pass the held answer through", async () => {
  for (const verdict of ["APPROVE", "unexpected words", "failure"]) {
    const f = await fixture({ type: "advisor" }, body => {
      if (body.model === "coding") { if (verdict === "failure") throw new Error("judge down"); return { content: verdict }; }
      return { content: "answer" };
    });
    await f.run(); expect(f.answers).toEqual(["answer"]);
  }
});

test("failed optional executor falls back to fixed_model without failing the turn", async () => {
  const f = await fixture({ type: "stage" }, body => { if (body.model === "fast") throw new Error("route down"); return { content: "fallback worked" }; });
  await f.run(); expect(f.answers).toEqual(["fallback worked"]);
  expect(f.model.requests.map(r => r.body.model)).toEqual(["fast", "fixed"]);
});

test("PII turn is refused before any executor or advisor when campus is unconfirmed", async () => {
  const f = await fixture({ type: "advisor" }, () => ({ content: "should never run" }), { turnPolicy: () => ({ pii: true, task: "1" }) });
  f.peer["opts"].omni.onCampus = async () => false;
  await f.run(); expect(f.model.requests).toHaveLength(0); expect(f.answers[0]).toContain("PII");
});

test("hub route parser is closed and sidecar serialization excludes its tables", () => {
  expect(() => parseHubRoutes({ "sy/wrong": { type: "stage" } })).toThrow();
  expect(() => parseHubRoutes({ "hub/wrong": { type: "arbitrary" } })).toThrow();
  expect(() => parseHubRoutes({ "hub/wrong": { type: "stage", confidence_threshold: NaN } })).toThrow();
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "ahub-route-config-")));
  expect(routing.hub_routes?.["hub/stage"]?.type).toBe("stage");
  expect(switchyardToml(routing, { baseUrl: "http://localhost/v1", extraHeaders: {} })).not.toContain("hub_routes");
});

test("local failed edits and exit-only shell failures carry route metadata but never unsupported wire fields", async () => {
  for (const name of ["edit", "bash"]) {
    const f = await fixture({ type: "stage" }, body => {
      const n = body.messages.filter(m => m.role === "tool").length;
      return n < 2 ? { tool_calls: [toolCall(name, name === "edit" ? { path: "a.txt", old: "no such fragment", new: "replacement" } : { command: "exit 1" })] } : { content: "reported the failure" };
    });
    await f.run();
    expect(f.routes.at(-1)).toBe("coding");
    expect(f.answers).toEqual(["reported the failure"]);
    for (const request of f.model.requests) for (const message of request.body.messages) expect(message).not.toHaveProperty("is_error");
  }
});

test("REDO feedback remains in completed history even when the current turn has no execution steps left", async () => {
  const f = await fixture({ type: "advisor" }, body => ({ content: body.model === "coding" ? "REDO: verify before finishing" : "draft" }), { maxSteps: 1 });
  await f.run(); expect(f.answers[0]).toContain("review requested changes; step limit reached");
  await f.run();
  expect(JSON.stringify(f.model.requests.at(-1)!.body.messages)).toContain("verify before finishing");
  expect(f.model.requests.filter(request => request.body.model === "coding")).toHaveLength(1);
});

test("a route configuration callback failure falls back without failing the completed answer", async () => {
  const f = await fixture({ type: "stage" }, () => ({ content: "fixed answer" }), { hubRoutes: () => { throw new Error("policy unavailable"); } });
  await f.run(); expect(f.answers).toEqual(["fixed answer"]);
  expect(f.model.requests.map(request => request.body.model)).toEqual(["fixed"]);
});


function expectJoinedLabels(f: Awaited<ReturnType<typeof fixture>>, status: "completed" | "failed") {
  expect(f.routeEvents.length).toBeGreaterThan(0);
  expect(f.outcomes).toHaveLength(f.routeEvents.length);
  expect(new Set(f.outcomes.map(e => e.decision)).size).toBe(f.routeEvents.length);
  for (const route of f.routeEvents) {
    expect(typeof route.decision).toBe("string"); expect(typeof route.turn).toBe("string");
    const outcome = f.outcomes.find(e => e.decision === route.decision)!;
    expect(outcome).toMatchObject({ turnId: route.turn, turn: status, pii: route.pii });
    for (const field of ["severity", "spinning", "exploring", "production"] as const) expect(Number.isFinite(route[field])).toBe(true);
  }
}

test("scripted efficient failure and capable test pass produce one outcome each joined to their decision and daemon turn", async () => {
  let toolResult = 0;
  const f = await fixture({ type: "stage" }, body => {
    const n = body.messages.filter(m => m.role === "tool").length;
    if (n === 0) return { tool_calls: [toolCall("hub_task_list", {})] };
    if (n === 1) return { tool_calls: [toolCall("hub_task_list", {})] };
    return { content: "finished" };
  }, { turnId: () => "local#label-test.1", turnPolicy: () => ({ pii: false, task: "17" }), taskTool: async () => ++toolResult === 1 ? "MemoryError: 1 tests failed" : "1 passed, 0 failed" });
  await f.run(); expectJoinedLabels(f, "completed");
  expect(f.routeEvents[0]).toMatchObject({ tier: "fast", task: 17, turn: "local#label-test.1", pii: false });
  expect(f.routeEvents[1]?.tier).toBe("coding");
  expect(f.outcomes[0]?.next).toMatchObject({ tests: "fail", severity: 1 });
  expect(f.outcomes[1]?.next).toEqual({ tests: "pass", severity: 0, repeat: false });
  expect(f.outcomes.at(-1)).not.toHaveProperty("next");
  expect(JSON.stringify(f.outcomes)).not.toContain("MemoryError");
});

test("scripted advisor REDO is attached only to the reviewed decision", async () => {
  const f = await fixture({ type: "advisor" }, body => ({ content: body.model === "coding" ? "REDO: verify hidden detail" : "answer" }));
  await f.run(); expectJoinedLabels(f, "completed");
  expect(f.outcomes[0]?.advisor).toBe("redo");
  expect(f.outcomes[1]).not.toHaveProperty("advisor");
  expect(JSON.stringify(f.outcomes)).not.toContain("hidden detail");
});

test("failed scripted turn settles all route decisions without waiting for a next turn", async () => {
  const f = await fixture({ type: "stage" }, () => { throw new Error("executor unavailable"); });
  await f.run(); expectJoinedLabels(f, "failed"); expect(f.answers).toEqual([]);
  expect(f.outcomes[0]).not.toHaveProperty("next");
});

test("PII and throwing sinks retain label shape and never change the answer", async () => {
  const f = await fixture({ type: "stage" }, () => ({ content: "private answer" }), {
    turnPolicy: () => ({ pii: true, task: "22" }),
    onRoute: () => { throw new Error("route sink down"); }, onRouteOutcome: () => { throw new Error("outcome sink down"); },
  });
  await f.run(); expectJoinedLabels(f, "completed");
  expect(f.answers).toEqual(["private answer"]);
  expect(f.routeEvents[0]).toMatchObject({ pii: true, task: 22 });
  expect(f.outcomes[0]).toMatchObject({ pii: true, task: 22 });
  expect(JSON.stringify(f.outcomes)).not.toContain("private answer");
});

test("stop closes an in-flight decision exactly once and its late response cannot relabel the next turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ type: "stage" }, async () => { await gate; return { content: "late answer" }; });
  await f.peer.deliver([newEnvelope("user", "wait", { to: ["local"] })]);
  for (let i = 0; i < 100 && !f.routeEvents.length; i++) await Bun.sleep(1);
  await f.peer.stop(); expectJoinedLabels(f, "failed");
  release(); await Bun.sleep(20);
  expect(f.outcomes).toHaveLength(1); expect(f.answers).toHaveLength(0);
});

test("escalation labels all earlier choices with a later latch in the same turn", async () => {
  const f = await fixture({ type: "escalation", confirmations: 1 }, body => ({ content: body.model === "coding" && !body.tools ? JSON.stringify({ escalate: true, category: "repetition", new_evidence: true, reason: "fresh evidence" }) : "done" }));
  await f.run(); expectJoinedLabels(f, "completed");
  expect(f.routeEvents.map(e => e.tier)).toEqual(["fast", "coding"]);
  expect(f.outcomes.every(e => e.latched)).toBe(true);
});

test("watchdog cancellation settles in-flight labels once before a late response returns", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ type: "stage" }, async () => { await gate; return { content: "late watchdog answer" }; }, { watchdogMs: 60 });
  await f.run(); expectJoinedLabels(f, "failed");
  release(); await Bun.sleep(20);
  expect(f.outcomes).toHaveLength(1);
  expect(f.answers).not.toContain("late watchdog answer");
});

test("a marked private envelope keeps PII labels and suppresses progress even without a task policy", async () => {
  let observations = 0;
  const f = await fixture({ type: "stage" }, () => ({ content: "private result" }), { onTool: () => { observations++; } });
  await f.peer.deliver([newEnvelope("user", "private request", { to: ["local"], private: true })]);
  for (let i = 0; i < 100 && f.peer.state === "busy"; i++) await Bun.sleep(10);
  expectJoinedLabels(f, "completed");
  expect(f.routeEvents[0]?.pii).toBe(true);
  expect(f.outcomes[0]?.pii).toBe(true);
  expect(observations).toBe(0);
});
