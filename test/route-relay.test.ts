import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGeneration } from "../src/models/mlx.ts";
import { BackendCooldowns, startModelRelay, type RelayCooldownEvent, type RelayRequest } from "../src/models/relay.ts";
import { HubRouteRuntime, type RouteEvent } from "../src/models/route/runtime.ts";
import type { StaySwitchPolicy } from "../src/models/route/stage.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function gateway(onRequest: (body: Record<string, unknown>) => void = () => {}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      onRequest(await request.json() as Record<string, unknown>);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/v1`;
}

function omni(base: string) {
  return { base: async () => base, apiKey: () => "test-key", accessHeaders: () => ({}) } as any;
}

async function route(relay: Awaited<ReturnType<typeof startModelRelay>>, body: RelayRequest): Promise<void> {
  const response = await fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.text();
}

test("hub/auto is opt-in and routes an efficient turn to DGX fast", async () => {
  const base = gateway();
  const hidden = await startModelRelay({ omni: omni(base), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, token: "t" });
  cleanup.push(hidden.close);
  expect(hidden.models).not.toContain("hub/auto");

  const events: unknown[] = [];
  const relay = await startModelRelay({ omni: omni(base), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "t", onRoute: (event) => events.push(event) });
  cleanup.push(relay.close);
  expect(relay.models).toContain("hub/auto");
  await route(relay, { model: "hub/auto", messages: [{ role: "user", content: "Summarize this short note." }] });
  expect(relay.status().backends.map((row) => row.alias)).toContain("dgx/fast");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ route: "hub/auto", tier: "dgx/fast", source: "default" });
  expect(Number.isFinite((events[0] as { score?: number }).score)).toBe(true);
  expect(Number.isFinite((events[0] as { ms?: number }).ms)).toBe(true);
});

test("hub/auto selects capable for repeated tool failures and holds it only for that session", async () => {
  const base = gateway();
  const relay = await startModelRelay({
    omni: omni(base), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" },
    enableHubAuto: true, token: "t", routeSessionKey: (request) => typeof request.session_key === "string" ? request.session_key : undefined,
  });
  cleanup.push(relay.close);
  const failing: RelayRequest = { model: "hub/auto", messages: [
    { role: "user", content: "Fix the bug." },
    { role: "assistant", content: "First test run.", tool_calls: [
      { id: "call-1", type: "function", function: { name: "bash", arguments: "{\"command\":\"bun test\"}" } },
    ] },
    { role: "tool", tool_call_id: "call-1", content: "AssertionError: expected 1 to equal 2", is_error: true },
    { role: "assistant", content: "Retrying the failed test.", tool_calls: [
      { id: "call-2", type: "function", function: { name: "bash", arguments: "{\"command\":\"bun test\"}" } },
    ] },
    { role: "tool", tool_call_id: "call-2", content: "AssertionError: expected 1 to equal 2", is_error: true },
  ] } as RelayRequest;
  failing.session_key = "session-a";
  await route(relay, failing);
  expect(relay.status().backends.map((row) => row.alias)).toContain("dgx/coding");

  const held: RelayRequest = { model: "hub/auto", messages: [{ role: "user", content: "Continue." }] };
  held.session_key = "session-a";
  await route(relay, held);
  expect(relay.status().backends.filter((row) => row.alias === "dgx/coding")).toHaveLength(1);

  const unrelated: RelayRequest = { model: "hub/auto", messages: [{ role: "user", content: "A new task." }] };
  unrelated.session_key = "session-b";
  await route(relay, unrelated);
  expect(relay.status().backends.map((row) => row.alias)).toContain("dgx/fast");
});

test("hub/auto preserves the configured default when stage routing cannot resolve its alias", async () => {
  const relay = await startModelRelay({
    omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast" },
    defaultBackend: { kind: "dgx", alias: "dgx/fast" }, enableHubAuto: true, token: "t",
  });
  cleanup.push(relay.close);
  await route(relay, { model: "hub/auto", messages: [{ role: "user", content: "short" }] });
  expect(relay.status().backends.map((row) => row.alias)).toContain("dgx/fast");
});

test("selectBackend can override hub/auto and a failed override leaves stage routing active", async () => {
  const base = gateway();
  const events: unknown[] = [];
  const relay = await startModelRelay({
    omni: omni(base), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" },
    enableHubAuto: true, token: "t", selectBackend: () => ({ kind: "dgx", alias: "dgx/coding" }), onRoute: (event) => events.push(event),
  });
  cleanup.push(relay.close);
  await route(relay, { model: "hub/auto", messages: [{ role: "user", content: "short" }] });
  expect(relay.status().backends.map((row) => row.alias)).toContain("dgx/coding");
  expect(events[0]).toMatchObject({ source: "override", tier: "dgx/coding" });

  const fallbackEvents: unknown[] = [];
  const failing = await startModelRelay({
    omni: omni(base), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" },
    enableHubAuto: true, token: "t2", selectBackend: () => { throw new Error("selector unavailable"); }, onRoute: (event) => fallbackEvents.push(event),
  });
  cleanup.push(failing.close);
  await route(failing, { model: "hub/auto", messages: [{ role: "user", content: "short" }] });
  expect(fallbackEvents[0]).toMatchObject({ source: "default", tier: "dgx/fast" });
});

test("hub/auto admits MLX only within its bounded input and output budget and falls back to DGX", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-route-ollama-"));
  const model = "agenthub-fast-mlx:4b-8k";
  let mlxRequests = 0;
  const mlxServer = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
      if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\nnum_predict 2048\n" });
      if (path === "/api/ps") return Response.json({ models: [] });
      if (path === "/v1/chat/completions") {
        const body = await request.json() as { messages: { content?: string }[]; max_tokens?: number };
        mlxRequests++;
        if (body.messages[0]?.content === "force fallback") return new Response("generation failed", { status: 503 });
        expect(Number.isInteger(body.max_tokens)).toBe(true);
        expect(body.max_tokens).toBe(512);
        return new Response('data: {"model":"agenthub-fast-mlx:4b-8k","choices":[{"delta":{"content":"mlx"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => mlxServer.stop(true));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let dgxRequests = 0;
  const dgxBase = gateway((body) => {
    dgxRequests++;
    expect(body.model).toBe("dgx-fast");
  });
  const relay = await startModelRelay({
    omni: omni(dgxBase), allowedDGXmodels: { "dgx/fast": "dgx-fast", "dgx/coding": "dgx-coding" },
    enableHubAuto: true, token: "mlx-route",
    mlx: { provider: "ollama", host: "127.0.0.1", port: mlxServer.port, model, runtimeDir, contextWindow: 8192, maxInputTokens: 6000, maxTokens: 2048, maxConcurrency: 1 },
    fallbackDGXAlias: "dgx/fast",
  });
  cleanup.push(relay.close);

  await route(relay, { model: "hub/auto", max_tokens: 512, messages: [{ role: "user", content: "short" }] });
  expect(mlxRequests).toBe(1);
  expect(dgxRequests).toBe(0);

  await route(relay, { model: "hub/auto", max_tokens: 512, messages: [{ role: "user", content: "x".repeat(40_000) }] });
  expect(mlxRequests).toBe(1);
  expect(dgxRequests).toBe(1);

  await route(relay, { model: "hub/auto", max_tokens: 4096, messages: [{ role: "user", content: "small input, invalid for MLX output cap" }] });
  expect(mlxRequests).toBe(1);
  expect(dgxRequests).toBe(2);

  await route(relay, { model: "hub/auto", max_tokens: 512, messages: [{ role: "user", content: "force fallback" }] });
  expect(mlxRequests).toBe(2);
  expect(dgxRequests).toBe(3);
});

test("hub auto excludes MLX at its input cap even when the full context would fit", async () => {
  let calls = 0;
  const base = gateway(body => { calls++; expect(body.model).toBe("fast"); });
  const relay = await startModelRelay({ omni: omni(base), token: "input-cap", enableHubAuto: true,
    allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" },
    mlx: { provider: "ollama", maxInputTokens: 6000, contextWindow: 8192, maxTokens: 2048 },
  });
  cleanup.push(relay.close);
  await route(relay, { model: "hub/auto", max_tokens: 512, messages: [{ role: "user", content: "x".repeat(24400) }] });
  expect(calls).toBe(1);
  expect(relay.status().backends.map(row => row.alias)).toEqual(["dgx/fast"]);
});

// #197: a Pi-style session with a repeated failure, a passing test inside the tool loop, user turns and a compaction.
const toolStep = (id: string, name: string, args: unknown, content: string, error = false) => [
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
  { role: "tool", tool_call_id: id, content, ...(error ? { is_error: true } : {}) },
];
const failure = "AssertionError: expected 1 to equal 2";
const session = [
  [{ role: "user", content: "Fix the failing test in parser.ts." }],
  toolStep("c1", "bash", { command: "bun test" }, failure, true),
  toolStep("c2", "bash", { command: "bun test" }, failure, true),
  toolStep("c3", "read", { path: "parser.ts" }, "export function parse() {}"),
  toolStep("c4", "edit", { path: "parser.ts", old: "a", new: "b" }, "edited"),
  toolStep("c5", "bash", { command: "bun test" }, "3 pass\n0 fail"),
  [{ role: "assistant", content: "Fixed." }, { role: "user", content: "Thanks. Now update the README." }],
  toolStep("c6", "write", { path: "README.md", content: "x" }, "written"),
  toolStep("c7", "bash", { command: "ls" }, "README.md parser.ts"),
  [{ role: "assistant", content: "Done." }, { role: "user", content: "Summarize what you changed." }],
  [{ role: "assistant", content: "Summary." }, { role: "user", content: "This session is being continued from a previous conversation that ran out of context." }],
  toolStep("c8", "read", { path: "parser.ts" }, "export function parse() {}"),
].map((_, i, all) => all.slice(0, i + 1).flat()) as RelayRequest["messages"][];
// Recorded from hub/auto and the local stage route at 15888e5, before the planner existed.
const RECORDED = ["fast", "fast", "coding", "coding", "coding", "fast", "fast", "fast", "fast", "fast", "coding", "coding"];

async function replayRelay(policy?: StaySwitchPolicy) {
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "t",
    routeSessionKey: (request) => typeof request.session_key === "string" ? request.session_key : undefined, staySwitch: () => policy, onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  for (const messages of session) await route(relay, { model: "hub/auto", messages, session_key: "pi-session" } as RelayRequest);
  return events;
}

async function replayLocal(policy?: StaySwitchPolicy, pii = false) {
  const events: RouteEvent[] = [];
  const runtime = new HubRouteRuntime({ onCampus: async () => true, execute: async () => ({ message: { role: "assistant", content: "ok" } }), staySwitch: () => policy, onRoute: (event) => events.push(event) });
  for (const messages of session) await runtime.call("hub/test", { type: "stage" }, messages as any, "local-session", pii, new AbortController().signal);
  return events;
}

const tiers = (events: RouteEvent[]) => events.map((e) => e.tier.replace(/^dgx\//, ""));
const planner = (events: RouteEvent[]) => events.map((e) => [e.turnType, e.plan, e.reason]);

test("#197 shadow and off leave every hub/auto and local stage decision as recorded, and both routes record the same trace", async () => {
  const off = { stay_switch: "off", max_switch_prefill_tokens: 32_000 } as const;
  const relayOff = await replayRelay(off), relayShadow = await replayRelay(undefined);
  const localOff = await replayLocal(off), localShadow = await replayLocal(undefined);
  for (const events of [relayOff, relayShadow, localOff, localShadow]) expect(tiers(events)).toEqual(RECORDED);
  expect(relayOff.every((e) => e.plan === undefined && e.turnType !== undefined)).toBe(true);
  expect(relayShadow.every((e) => e.staySwitch === "shadow")).toBe(true);
  expect(planner(relayShadow)).toEqual(planner(localShadow));
  expect(relayShadow.map((e) => e.prefillTokens)).toEqual(localShadow.map((e) => e.prefillTokens)); // one estimate for both
  // The planner would have kept the capable tier through the passing test inside the tool loop.
  expect(relayShadow[5]).toMatchObject({ turnType: "tool_result", plan: "stay", reason: "tool_loop", tier: "dgx/fast" });
  const text = JSON.stringify([relayShadow, localShadow]);
  for (const prompt of ["parser.ts", "AssertionError", "README", "Summarize"]) expect(text).not.toContain(prompt);
  expect(relayShadow.every((e) => Number.isInteger(e.prefillTokens) && e.prefillTokens! > 0)).toBe(true);
});

test("#197 enforce keeps a tool loop on its tier, de-escalates at the next user turn, and honours the prefill bound", async () => {
  const enforce = { stay_switch: "enforce", max_switch_prefill_tokens: 32_000 } as const;
  const expected = RECORDED.map((tier, i) => i === 5 ? "coding" : tier);
  const relay = await replayRelay(enforce), local = await replayLocal(enforce);
  expect(tiers(relay)).toEqual(expected);
  expect(tiers(local)).toEqual(expected);
  expect(planner(relay)).toEqual(planner(local));
  expect(relay[2]).toMatchObject({ turnType: "tool_result", plan: "switch", reason: "override" });
  expect(relay[5]).toMatchObject({ turnType: "tool_result", plan: "stay", reason: "tool_loop" });
  expect(relay[6]).toMatchObject({ turnType: "user", plan: "switch", reason: "user_turn" });
  expect(relay[10]).toMatchObject({ turnType: "compaction", plan: "switch", reason: "compaction" });
  const bounded = await replayRelay({ stay_switch: "enforce", max_switch_prefill_tokens: 1 });
  expect(tiers(bounded)).toEqual(RECORDED.map((tier, i) => i < 2 ? tier : "coding"));
  expect(bounded[6]).toMatchObject({ plan: "stay", reason: "prefill_bound" });
});

test("#197 a PII local route records the planner without the conversation size, and its size never decides a plan", async () => {
  const events = await replayLocal(undefined, true);
  expect(tiers(events)).toEqual(RECORDED);
  expect(events[0]).toMatchObject({ turnType: "user", plan: "stay", reason: "new_pin" });
  expect(events.some((e) => "prefillTokens" in e)).toBe(false);
  const bounded = { stay_switch: "enforce", max_switch_prefill_tokens: 1 } as const;
  expect((await replayLocal(bounded, false)).some((e) => e.reason === "prefill_bound")).toBe(true);
  const pii = await replayLocal(bounded, true);
  expect(pii.some((e) => e.reason === "prefill_bound")).toBe(false);
  expect(tiers(pii)).toEqual(tiers(await replayLocal({ stay_switch: "enforce", max_switch_prefill_tokens: 32_000 }, false)));
});

// #199: load-aware efficient tier and backend cooldowns.
test("#199 cooldowns start after three transport or startup failures, double up to a cap, and end on expiry or one success", () => {
  let clock = 0;
  const events: RelayCooldownEvent[] = [];
  const cooldowns = new BackendCooldowns(() => clock, (event) => events.push(event));
  cooldowns.failed("mlx/fast"); cooldowns.failed("mlx/fast");
  expect(cooldowns.cooling("mlx/fast")).toBeUndefined();
  cooldowns.failed("mlx/fast");
  expect(cooldowns.cooling("mlx/fast")).toEqual({ until: 30_000, failures: 3 });
  clock = 30_000;
  expect(cooldowns.cooling("mlx/fast")).toBeUndefined();
  cooldowns.failed("mlx/fast"); // the first try after a cooldown fails again: twice as long
  expect(cooldowns.cooling("mlx/fast")?.until).toBe(90_000);
  for (let i = 0; i < 6; i++) { clock = cooldowns.cooling("mlx/fast")!.until; cooldowns.failed("mlx/fast"); }
  expect(cooldowns.cooling("mlx/fast")!.until - clock).toBe(300_000);
  cooldowns.failed("mlx/fast"); // in flight during the cooldown: neither counted nor extended
  expect(cooldowns.cooling("mlx/fast")!.until - clock).toBe(300_000);
  cooldowns.answered("mlx/fast", true);
  expect(cooldowns.cooling("mlx/fast")).toBeUndefined();
  cooldowns.failed("mlx/fast");
  expect(cooldowns.cooling("mlx/fast")).toBeUndefined(); // the success reset the count
  expect(events.slice(0, 3)).toEqual([{ alias: "mlx/fast", event: "start", failures: 3, ms: 30_000 }, { alias: "mlx/fast", event: "end", failures: 3 }, { alias: "mlx/fast", event: "start", failures: 4, ms: 60_000 }]);
  expect(events.at(-1)).toEqual({ alias: "mlx/fast", event: "end", failures: 10 });
});

/** Releases a held slot after `ms`; the test's cleanup waits for it, before its runtime dir goes away. */
const later = (release: () => void, ms: number) => { const released = Bun.sleep(ms).then(release); cleanup.push(() => released); };

/** Sends a request while the test holds the MLX slot, and frees it once the request's route event shows its ordering. */
async function routeBusy(relay: Awaited<ReturnType<typeof startModelRelay>>, runtimeDir: string, events: unknown[], body: RelayRequest) {
  const held = await acquireGeneration(runtimeDir, 1);
  const seen = events.length;
  const done = route(relay, body);
  try { for (let i = 0; i < 1000 && events.length === seen; i++) await Bun.sleep(2); } finally { held(); }
  await done;
}

/** A fake Ollama MLX endpoint: `ready` false fails its startup check, `status` answers chat with that HTTP status. */
function ollama(state: { ready: boolean; status?: number }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-route-load-"));
  const model = "agenthub-fast-mlx:4b-8k", counts = { tags: 0, chat: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/tags") { counts.tags++; return state.ready ? Response.json({ models: [{ name: model }] }) : new Response("down", { status: 503 }); }
    if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\nnum_predict 2048\n" });
    if (path === "/api/ps") return Response.json({ models: [] });
    counts.chat++;
    if (state.status) return new Response("refused", { status: state.status });
    return new Response(`data: {"model":"${model}","choices":[{"delta":{"content":"mlx"}}]}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => server.stop(true), () => rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, counts, mlx: { provider: "ollama" as const, host: "127.0.0.1", port: server.port, model, runtimeDir, contextWindow: 8192, maxInputTokens: 6000, maxTokens: 2048, maxConcurrency: 1 } };
}

const short = (session_key = "s", messages: RelayRequest["messages"] = [{ role: "user", content: "short" }]) => ({ model: "hub/auto", max_tokens: 512, messages, session_key }) as RelayRequest;

test("#199 a busy MLX slot past efficient_wait_ms moves hub/auto to dgx/fast, a free slot keeps MLX, and one efficient backend waits as before", async () => {
  const local = ollama({ ready: true });
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "load",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  await route(relay, short());
  const held = await acquireGeneration(local.runtimeDir, 1);
  await route(relay, short());
  held();
  await route(relay, short());
  expect(events.map((e) => `${e.tier} ${e.source}`)).toEqual(["mlx/fast default", "dgx/fast load", "mlx/fast default"]);
  expect(local.counts.chat).toBe(2);
  expect(relay.requests().map((r) => r.alias)).toEqual(["mlx/fast", "dgx/fast", "mlx/fast"]); // a load move journals no MLX attempt

  const only = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/coding": "coding" }, enableHubAuto: true, token: "only", mlx: local.mlx, efficientWaitMs: 20 });
  cleanup.push(only.close);
  await route(only, short());
  const busy = await acquireGeneration(local.runtimeDir, 1);
  later(busy, 150);
  await route(only, short());
  expect(local.counts.chat).toBe(4);
});

test("#199 enforced, a tool loop neither moves for load nor leaves the backend a load move pinned", async () => {
  const local = ollama({ ready: true });
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "pin",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, routeSessionKey: (request) => request.session_key as string, staySwitch: () => ({ stay_switch: "enforce", max_switch_prefill_tokens: 32_000 }),
    onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  const user = [{ role: "user", content: "List the files." }] as RelayRequest["messages"];
  const loop = [...user, ...toolStep("l1", "bash", { command: "ls" }, "a.ts b.ts")] as RelayRequest["messages"];
  await route(relay, short("warm"));
  const held = await acquireGeneration(local.runtimeDir, 1);
  await route(relay, short("pi", user));
  held();
  await route(relay, short("pi", loop)); // the slot is free again, but the loop stays where it started
  const busy = await acquireGeneration(local.runtimeDir, 1);
  await route(relay, short("other", user));
  later(busy, 150);
  await route(relay, short("other", [...loop.slice(0, 1), ...toolStep("l2", "bash", { command: "ls" }, "a.ts")] as RelayRequest["messages"]));
  expect(events.map((e) => `${e.tier} ${e.source} ${e.turnType}`)).toEqual(["mlx/fast default user", "dgx/fast load user", "dgx/fast default tool_result", "dgx/fast load user", "dgx/fast default tool_result"]);

  const waiting = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "wait",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, routeSessionKey: (request) => request.session_key as string, staySwitch: () => ({ stay_switch: "enforce", max_switch_prefill_tokens: 32_000 }) });
  cleanup.push(waiting.close);
  await route(waiting, short("w", user));
  const chats = local.counts.chat;
  const slot = await acquireGeneration(local.runtimeDir, 1);
  later(slot, 150);
  await route(waiting, short("w", loop)); // pinned to MLX inside the loop: it waits for the slot instead of moving
  expect(local.counts.chat).toBe(chats + 1);
});

test("#199 three MLX startup failures skip MLX until the cooldown passes, a success ends it, and 4xx answers never start one", async () => {
  const state: { ready: boolean; status?: number } = { ready: false };
  const local = ollama(state);
  let clock = 1_000_000;
  const events: RouteEvent[] = [], cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "cool",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", now: () => clock, onRoute: (event) => events.push(event as RouteEvent), onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  for (let i = 0; i < 3; i++) await route(relay, short());
  expect(cooldowns).toEqual([{ alias: "mlx/fast", event: "start", failures: 3, ms: 30_000 }]);
  const tags = local.counts.tags;
  await route(relay, short());
  expect(local.counts.tags).toBe(tags); // skipped, not tried
  expect(events.at(-1)).toMatchObject({ tier: "dgx/fast", source: "cooldown" });
  expect(relay.status().backends.find((b) => b.alias === "mlx/fast")).toMatchObject({ coolingUntil: new Date(clock + 30_000).toISOString(), failures: 3 });
  state.ready = true;
  clock += 30_000;
  await route(relay, short());
  expect(events.at(-1)).toMatchObject({ tier: "mlx/fast", source: "default" });
  expect(cooldowns.at(-1)).toEqual({ alias: "mlx/fast", event: "end", failures: 3 });
  expect(relay.status().backends.find((b) => b.alias === "mlx/fast")).not.toHaveProperty("coolingUntil");
  expect(JSON.stringify([events, cooldowns])).not.toContain("short");

  state.status = 400;
  for (let i = 0; i < 4; i++) await route(relay, short());
  expect(cooldowns).toHaveLength(2);
  expect(relay.status().backends.find((b) => b.alias === "mlx/fast")).not.toHaveProperty("coolingUntil");
});

const post = (relay: Awaited<ReturnType<typeof startModelRelay>>, model: string) => fetch(`${relay.url}/chat/completions`, {
  method: "POST", headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "short" }] }),
}).then(async (response) => { await response.text(); return response.status; });

test("#199 a load move whose gateway is down falls back to MLX, the next busy slot waits instead, and a gateway-less alias shows its cooldown", async () => {
  const local = ollama({ ready: true });
  let probes = 0;
  const down = { base: async () => { probes++; return undefined; }, apiKey: () => "k", accessHeaders: () => ({}) } as any;
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: down, allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "down",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  await route(relay, short());
  await routeBusy(relay, local.runtimeDir, events, short()); // moved, the gateway is down: MLX serves it once the slot frees
  const busy = await acquireGeneration(local.runtimeDir, 1);
  later(busy, 150);
  await route(relay, short()); // dgx/fast just failed: no move, it waits for MLX
  expect(events.map((e) => `${e.tier} ${e.source}`)).toEqual(["mlx/fast default", "dgx/fast load", "mlx/fast default"]);
  expect(local.counts.chat).toBe(3);
  expect(probes).toBe(1);
  expect(relay.requests().map((r) => `${r.alias} ${r.outcome}${r.fallbackOfId ? " fallback" : ""}`)).toEqual(["mlx/fast completed", "dgx/fast failed", "mlx/fast completed fallback", "mlx/fast completed"]);

  for (let i = 0; i < 3; i++) expect(await post(relay, "dgx/coding")).toBe(502);
  expect(relay.status().backends.find((b) => b.alias === "dgx/coding")).toMatchObject({ state: "error", lastError: "DGX gateway is unavailable", failures: 3 });
  expect(relay.status().backends.find((b) => b.alias === "dgx/coding")?.coolingUntil).toBeString();
});

test("#199 timeouts cut short by the execution budget never start a cooldown; refused connections do", async () => {
  const hang = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  cleanup.push(() => hang.stop(true));
  const cooldowns: RelayCooldownEvent[] = [];
  const budgeted = await startModelRelay({ omni: omni(`http://127.0.0.1:${hang.port}/v1`), allowedDGXmodels: { "dgx/fast": "fast" }, token: "budget",
    admitRequest: async () => ({ allowed: true, remainingMs: 30 }), onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(budgeted.close);
  for (let i = 0; i < 3; i++) expect(await post(budgeted, "dgx/fast")).toBe(502);
  expect(budgeted.requests().map((r) => r.failureClass)).toEqual(["transport", "transport", "transport"]);
  expect(cooldowns).toEqual([]);

  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port;
  closed.stop(true);
  const refused = await startModelRelay({ omni: omni(`http://127.0.0.1:${port}/v1`), allowedDGXmodels: { "dgx/fast": "fast" }, token: "refused", onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(refused.close);
  for (let i = 0; i < 3; i++) expect(await post(refused, "dgx/fast")).toBe(502);
  expect(cooldowns).toEqual([{ alias: "dgx/fast", event: "start", failures: 3, ms: 30_000 }]);
});

test("#199 three transport failures of a DGX alias start its cooldown, a 4xx does not, and a success ends it", async () => {
  let answer = 400;
  const live = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => answer === 200
    ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    : new Response("bad request", { status: answer }) });
  cleanup.push(() => live.stop(true));
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const refusedUrl = `http://127.0.0.1:${closed.port}/v1`;
  closed.stop(true);
  let base = `http://127.0.0.1:${live.port}/v1`;
  const cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: { base: async () => base, apiKey: () => "k", accessHeaders: () => ({}) } as any, allowedDGXmodels: { "dgx/fast": "fast" }, token: "dgx-transport", onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  const row = () => relay.status().backends.find((b) => b.alias === "dgx/fast");
  for (let i = 0; i < 4; i++) expect(await post(relay, "dgx/fast")).toBe(502);
  expect(relay.requests().map((r) => r.failureClass)).toEqual(["http", "http", "http", "http"]);
  expect(cooldowns).toEqual([]);
  expect(row()).not.toHaveProperty("coolingUntil");

  base = refusedUrl;
  for (let i = 0; i < 3; i++) expect(await post(relay, "dgx/fast")).toBe(502);
  expect(relay.requests().slice(-3).map((r) => r.failureClass)).toEqual(["transport", "transport", "transport"]);
  expect(cooldowns).toEqual([{ alias: "dgx/fast", event: "start", failures: 3, ms: 30_000 }]);
  expect(row()).toMatchObject({ failures: 3 });
  expect(row()?.coolingUntil).toBeString();

  base = `http://127.0.0.1:${live.port}/v1`;
  answer = 200;
  expect(await post(relay, "dgx/fast")).toBe(200); // a cooling DGX alias with no same-tier alternative is still tried
  expect(cooldowns.at(-1)).toEqual({ alias: "dgx/fast", event: "end", failures: 3 });
  expect(row()).not.toHaveProperty("coolingUntil");
});

test("#199 review: failures during a cooldown do not count, so the first failure after it doubles once instead of jumping to the cap", () => {
  let clock = 0;
  const cooldowns = new BackendCooldowns(() => clock);
  for (let i = 0; i < 3; i++) cooldowns.failed("dgx/fast");
  for (let i = 0; i < 5; i++) cooldowns.failed("dgx/fast"); // requests already in flight when it started
  expect(cooldowns.cooling("dgx/fast")).toEqual({ until: 30_000, failures: 3 });
  clock = 30_000;
  cooldowns.failed("dgx/fast");
  expect(cooldowns.cooling("dgx/fast")).toEqual({ until: 90_000, failures: 4 });
});

/** An OmniRoute stand-in whose gateway can go away; `probes` counts lookups. */
function switchable(url: string) {
  const g = { url: url as string | undefined, probes: 0 };
  return { g, omni: { base: async () => { g.probes++; return g.url; }, apiKey: () => "k", accessHeaders: () => ({}) } as any };
}

test("#199 review: a busy MLX slot is load, never a failure: dispatch slot timeouts fall back without cooling MLX", async () => {
  const local = ollama({ ready: true });
  const cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway()), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "busy",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, slotWaitMs: 30, routeSessionKey: (request) => request.session_key as string,
    staySwitch: () => ({ stay_switch: "enforce", max_switch_prefill_tokens: 32_000 }), onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  const user = [{ role: "user", content: "List the files." }] as RelayRequest["messages"];
  await route(relay, short("pi", user)); // MLX starts and becomes the pin
  const held = await acquireGeneration(local.runtimeDir, 1);
  for (let i = 0; i < 2; i++) expect(await post(relay, "mlx/fast")).toBe(200); // explicit mlx/fast: waits, then its fallback
  await route(relay, short("pi", [...user, ...toolStep(`b${0}`, "bash", { command: "ls" }, "a.ts")] as RelayRequest["messages"])); // enforced loop: no move, same wait
  held();
  expect(cooldowns).toEqual([]);
  expect(relay.status().backends.find((b) => b.alias === "mlx/fast")).not.toHaveProperty("coolingUntil");
  expect(relay.requests().map((r) => `${r.alias} ${r.outcome}`)).toEqual(["mlx/fast completed", "mlx/fast failed", "dgx/fast completed", "mlx/fast failed", "dgx/fast completed", "mlx/fast failed", "dgx/fast completed"]);
});

test("#199 review: a cooling MLX goes behind a healthy fallback and still serves when the gateway dies, and stays first while the fallback fails", async () => {
  const state: { ready: boolean; status?: number } = { ready: false };
  const local = ollama(state);
  const { g, omni: gatewayOmni } = switchable(gateway());
  const events: RouteEvent[] = [], cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: gatewayOmni, allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "cool-down",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", onRoute: (event) => events.push(event as RouteEvent), onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  for (let i = 0; i < 3; i++) await route(relay, short()); // MLX fails to start; dgx/fast serves
  expect(cooldowns.map((e) => `${e.alias} ${e.event}`)).toEqual(["mlx/fast start"]);
  g.url = undefined;
  state.ready = true;
  await route(relay, short()); // dgx/fast first, the gateway is gone, MLX serves
  expect(events.at(-1)).toMatchObject({ tier: "dgx/fast", source: "cooldown" });
  expect(cooldowns.map((e) => `${e.alias} ${e.event}`)).toEqual(["mlx/fast start", "mlx/fast end"]);

  state.ready = false;
  for (let i = 0; i < 3; i++) expect(await post(relay, "hub/auto")).toBe(502); // both down: as before
  expect(relay.status().backends.find((b) => b.alias === "mlx/fast")?.coolingUntil).toBeString();
  const probes = g.probes;
  state.ready = true;
  await route(relay, short()); // MLX cools, but dgx/fast's last dispatch failed: MLX stays first
  expect(events.at(-1)).toMatchObject({ tier: "mlx/fast", source: "default" });
  expect(g.probes).toBe(probes);
});

test("#199 review: an enforced loop pinned to dgx/fast by a load move falls back to MLX when the gateway dies, then stops preferring it", async () => {
  const local = ollama({ ready: true });
  const { g, omni: gatewayOmni } = switchable(gateway());
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: gatewayOmni, allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "pin-down",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, routeSessionKey: (request) => request.session_key as string,
    staySwitch: () => ({ stay_switch: "enforce", max_switch_prefill_tokens: 32_000 }), onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  const user = [{ role: "user", content: "List the files." }] as RelayRequest["messages"];
  const loop = (n: number) => [...user, ...Array.from({ length: n }, (_, i) => toolStep(`p${i}`, "bash", { command: "ls" }, `a${i}.ts`)).flat()] as RelayRequest["messages"];
  await route(relay, short("warm"));
  const held = await acquireGeneration(local.runtimeDir, 1);
  await route(relay, short("pi", user)); // load move, pinned to dgx/fast
  held();
  g.url = undefined;
  const chats = local.counts.chat;
  await route(relay, short("pi", loop(1))); // the pin is tried first, fails, MLX serves
  const probes = g.probes;
  await route(relay, short("pi", loop(2))); // dgx/fast just failed: no longer preferred
  expect(events.map((e) => `${e.tier} ${e.source} ${e.turnType}`)).toEqual(["mlx/fast default user", "dgx/fast load user", "dgx/fast default tool_result", "mlx/fast default tool_result"]);
  expect(local.counts.chat).toBe(chats + 2);
  expect(g.probes).toBe(probes);
});

test("#199 review: any HTTP answer resets the failure streak and ends a cooldown, since the transport works", async () => {
  let answer = 503;
  const live = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy", { status: answer }) });
  cleanup.push(() => live.stop(true));
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const refusedUrl = `http://127.0.0.1:${closed.port}/v1`, liveUrl = `http://127.0.0.1:${live.port}/v1`;
  closed.stop(true);
  const { g, omni: gatewayOmni } = switchable(refusedUrl);
  const cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: gatewayOmni, allowedDGXmodels: { "dgx/fast": "fast" }, token: "answer", onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  const send = async (url: string) => { g.url = url; expect(await post(relay, "dgx/fast")).toBe(502); };
  for (const url of [refusedUrl, liveUrl, refusedUrl, refusedUrl]) await send(url); // transport, 503, transport, transport
  expect(relay.requests().map((r) => r.failureClass)).toEqual(["transport", "http", "transport", "transport"]);
  expect(cooldowns).toEqual([]);
  await send(refusedUrl); // the third in a row
  expect(cooldowns).toEqual([{ alias: "dgx/fast", event: "start", failures: 3, ms: 30_000 }]);
  answer = 400;
  await send(liveUrl); // a cooling DGX alias is still tried; its answer ends the cooldown
  expect(cooldowns.at(-1)).toEqual({ alias: "dgx/fast", event: "end", failures: 3 });
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")).not.toHaveProperty("coolingUntil");
});

test("#199 review: a fallback that answered an error gets no load move until it succeeds or 30 s pass, and status shows it", async () => {
  const local = ollama({ ready: true });
  let answer = 503, hits = 0;
  const dgx = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return answer === 200
    ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    : new Response("gateway error", { status: answer }); } });
  cleanup.push(() => dgx.stop(true));
  let clock = 1_000_000;
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${dgx.port}/v1`), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "5xx",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, now: () => clock, onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  const busy = () => routeBusy(relay, local.runtimeDir, events, short());
  await route(relay, short());
  await busy(); // moved; dgx/fast answers 503; MLX serves
  await busy(); // dgx/fast's last dispatch failed: the request waits for MLX
  expect(hits).toBe(1);
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")).toMatchObject({ failingUntil: new Date(clock + 30_000).toISOString() });
  clock += 30_000;
  answer = 200;
  await busy(); // the mark decayed: it moves again, and dgx/fast serves
  expect(hits).toBe(2);
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")).not.toHaveProperty("failingUntil");
  expect(events.map((e) => `${e.tier} ${e.source}`)).toEqual(["mlx/fast default", "dgx/fast load", "mlx/fast default", "dgx/fast load"]);
});

test("#199 review: a load move waits for MLX unless the elapsed budget holds the bounded move", async () => {
  const local = ollama({ ready: true });
  let hits = 0, remainingMs: number | undefined = 20_000; // under 20 ms wait + 8 s probe + 15 s first byte
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: omni(gateway(() => { hits++; })), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "budget-move",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, admitRequest: async () => ({ allowed: true, ...(remainingMs === undefined ? {} : { remainingMs }) }),
    onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  const busy = () => routeBusy(relay, local.runtimeDir, events, short());
  await route(relay, short()); // admitted with 20 s left
  await busy(); // a move could leave MLX too little: it waits instead
  remainingMs = 30_000;
  await route(relay, short());
  await busy(); // the bounded move fits
  expect(events.map((e) => `${e.tier} ${e.source}`)).toEqual(["mlx/fast default", "mlx/fast default", "mlx/fast default", "dgx/fast load"]);
  expect(hits).toBe(1);
});

test("#199 review: a moved attempt gets a short first-byte deadline, then MLX serves within the budget it left", async () => {
  const local = ollama({ ready: true });
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  cleanup.push(() => stalled.stop(true));
  let clock = 1_000_000;
  const events: RouteEvent[] = [], cooldowns: RelayCooldownEvent[] = [];
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${stalled.port}/v1`), allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "first-byte",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, moveFirstByteMs: 50, now: () => clock, admitRequest: async () => ({ allowed: true, remainingMs: 200_000 }),
    onRoute: (event) => events.push(event as RouteEvent), onCooldown: (event) => cooldowns.push(event) });
  cleanup.push(relay.close);
  await route(relay, short());
  const started = performance.now();
  for (let i = 0; i < 3; i++) { // moved to a gateway that never answers: abandoned, MLX serves; 30 s later it moves again
    await routeBusy(relay, local.runtimeDir, events, short());
    clock += 30_000;
  }
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(events.map((e) => `${e.tier} ${e.source}`)).toEqual(["mlx/fast default", "dgx/fast load", "dgx/fast load", "dgx/fast load"]);
  expect(relay.requests().slice(0, 3).map((r) => `${r.alias} ${r.outcome}${r.failureClass ? ` ${r.failureClass}` : ""}${r.fallbackOfId ? " fallback" : ""}`)).toEqual(["mlx/fast completed", "dgx/fast failed transport", "mlx/fast completed fallback"]);
  expect(cooldowns).toEqual([]); // three abandoned moves: slow is not unreachable
  clock -= 30_000;
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")?.failingUntil).toBeString();
});

test("#199 review: no move to a fallback that is cooling down, even once its failing mark has lapsed", async () => {
  const local = ollama({ ready: true });
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const refusedUrl = `http://127.0.0.1:${closed.port}/v1`;
  closed.stop(true);
  const { g, omni: gatewayOmni } = switchable(refusedUrl);
  let clock = 1_000_000;
  const events: RouteEvent[] = [];
  const relay = await startModelRelay({ omni: gatewayOmni, allowedDGXmodels: { "dgx/fast": "fast", "dgx/coding": "coding" }, enableHubAuto: true, token: "cooling-fallback",
    mlx: local.mlx, fallbackDGXAlias: "dgx/fast", efficientWaitMs: 20, now: () => clock, onRoute: (event) => events.push(event as RouteEvent) });
  cleanup.push(relay.close);
  await route(relay, short());
  for (let i = 0; i < 3; i++) expect(await post(relay, "dgx/fast")).toBe(502); // a 30 s cooldown
  clock += 30_000;
  expect(await post(relay, "dgx/fast")).toBe(502); // the first try after it fails: 60 s
  clock += 31_000; // failing for 30 s has lapsed, the cooldown has not
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")).not.toHaveProperty("failingUntil");
  expect(relay.status().backends.find((b) => b.alias === "dgx/fast")?.coolingUntil).toBeString();
  const probes = g.probes;
  await routeBusy(relay, local.runtimeDir, events, short());
  expect(events.at(-1)).toMatchObject({ tier: "mlx/fast", source: "default" });
  expect(g.probes).toBe(probes);
});
