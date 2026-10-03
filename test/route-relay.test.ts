import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModelRelay, type RelayRequest } from "../src/models/relay.ts";

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
