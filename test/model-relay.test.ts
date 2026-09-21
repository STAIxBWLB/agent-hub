import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModelRelay } from "../src/models/relay.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function omni(base: string, key = "dgx-key") {
  return {
    base: async () => base,
    apiKey: () => key,
    accessHeaders: () => ({}),
  } as any;
}

test("relay authenticates, whitelists aliases, and streams SSE from DGX", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer dgx-key");
      const body = await request.json() as any;
      expect(body.model).toBe("glm-5");
      expect(body.stream).toBe(true);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream", "x-omniroute-provider": "vllm", "x-model-router-selected-model": "glm-5" } });
    },
  });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "glm-5" }, token: "relay-token" });
  cleanup.push(relay.close);

  const unauthorized = await fetch(`${relay.url}/chat/completions`, { method: "POST", body: "{}" });
  expect(unauthorized.status).toBe(401);
  const response = await fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer relay-token", "content-type": "application/json", "x-forwarded-for": "spoofed" },
    body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain("[DONE]");
  expect(relay.status().backends[0]).toMatchObject({ alias: "dgx/coding", actualModel: "glm-5", provider: "vllm", active: 0 });
});

test("relay refuses arbitrary models and never proxies a request URL", async () => {
  const relay = await startModelRelay({ omni: omni("http://127.0.0.1:9/v1"), allowedDGXmodels: { "dgx/fast": "deepseek" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "https://attacker.invalid/v1", messages: [{ role: "user", content: "x" }] }),
  });
  expect(response.status).toBe(400);
});

test("relay learns a physical DGX model from split SSE JSON without changing the bytes", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"model":"deepseek-ai/DeepSeek-'));
        controller.enqueue(new TextEncoder().encode('V4-Flash-0731","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/fast": "deepseek" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: "x" }] }) });
  const text = await response.text();
  expect(text).toContain("deepseek-ai/DeepSeek-V4-Flash-0731");
  expect(relay.status().backends[0]?.actualModel).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
});

test("relay enforces loopback, origin, body and backend-specific context limits", async () => {
  await expect(startModelRelay({ host: "0.0.0.0", omni: omni("http://127.0.0.1:9/v1"), allowedDGXmodels: {} })).rejects.toThrow("loopback");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }) });
  cleanup.push(() => upstream.stop(true));
  const dgx = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/fast": "deepseek" }, token: "relay-token" });
  cleanup.push(dgx.close);
  const giant = "x".repeat(70_000);
  const dgxResponse = await fetch(`${dgx.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: giant }] }) });
  expect(dgxResponse.status).toBe(200);
  const originResponse = await fetch(`${dgx.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", origin: "https://evil.invalid", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: "x" }] }) });
  expect(originResponse.status).toBe(403);
  const tooLarge = await fetch(`${dgx.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: "x".repeat(2_000_001) });
  expect(tooLarge.status).toBe(413);
  const mlx = await startModelRelay({ omni: {} as any, mlx: {}, allowedDGXmodels: {}, token: "mlx-token" });
  cleanup.push(mlx.close);
  const mlxResponse = await fetch(`${mlx.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer mlx-token", "content-type": "application/json" }, body: JSON.stringify({ model: "mlx/fast", messages: [{ role: "user", content: giant }] }) });
  expect(mlxResponse.status).toBe(400);
});

test("relay close aborts an active upstream request", async () => {
  let seen!: () => void;
  const requestSeen = new Promise<void>((resolve) => { seen = resolve; });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { seen(); await new Promise<void>(() => {}); return new Response("never"); } });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/fast": "deepseek" }, token: "relay-token" });
  const pending = fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: "wait" }] }) });
  await requestSeen;
  await relay.close();
  expect((await pending).status).toBe(502);
});

test("relay aborts queued MLX acquisition and close does not wait for the 120 second lock deadline", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-relay-queue-"));
  let seen!: () => void;
  const requestSeen = new Promise<void>((resolve) => { seen = resolve; });
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let requests = 0;
  const child = { pid: 2_000_000_010, kill: () => true, unref: () => {} } as any;
  const processInfo = (pid: number) => pid === child.pid
    ? { command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "child-start" }
    : pid === process.pid ? { command: "bun test", start: "self-start" } : undefined;
  const spawn = ((_bin: string, args: string[]) => {
    const port = Number(args[args.indexOf("--port") + 1]);
    upstream = Bun.serve({ hostname: "127.0.0.1", port, fetch: async () => {
      requests++;
      seen();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"wait"}}]}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    } });
    return child;
  }) as any;
  const relay = await startModelRelay({
    omni: {} as any,
    mlx: { runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", maxConcurrency: 1, spawn, processInfo, health: async () => true },
    allowedDGXmodels: {}, token: "mlx-token",
  });
  cleanup.push(async () => { await relay.close(); upstream?.stop(true); rmSync(runtimeDir, { recursive: true, force: true }); });
  const body = JSON.stringify({ model: "mlx/fast", messages: [{ role: "user", content: "wait" }] });
  const first = fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer mlx-token", "content-type": "application/json" }, body });
  await requestSeen;
  expect((await first).status).toBe(200);
  expect(requests).toBe(1);

  const aborter = new AbortController();
  const queuedAbort = fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer mlx-token", "content-type": "application/json" }, body, signal: aborter.signal });
  await Bun.sleep(30);
  const started = performance.now();
  aborter.abort();
  await expect(queuedAbort).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(requests).toBe(1);

  const queuedClose = fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer mlx-token", "content-type": "application/json" }, body });
  await Bun.sleep(30);
  const closeStarted = performance.now();
  await relay.close();
  const closeResponse = await queuedClose;
  expect(closeResponse.status).toBe(502);
  expect(performance.now() - closeStarted).toBeLessThan(1_000);
});

test("relay uses explicit Ollama MLX mode, clamps default output, and enforces total context", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-relay-ollama-"));
  const model = "agenthub-fast-mlx:4b-8k";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
      if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\nnum_predict 2048\n" });
      if (path === "/api/ps") return Response.json({ models: [] });
      if (path === "/v1/chat/completions") {
        const body = await request.json() as Record<string, unknown>;
        expect(body.model).toBe(model);
        expect(body.max_tokens).toBe(2048);
        expect(body.reasoning_effort).toBe("none");
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"model":"agenthub-fast-mlx:4b-8k","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => upstream.stop(true));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const relay = await startModelRelay({
    omni: {} as any,
    mlx: { provider: "ollama", host: "127.0.0.1", port: upstream.port, model, runtimeDir, contextWindow: 8192, maxInputTokens: 6000, maxTokens: 2048, maxConcurrency: 1 },
    allowedDGXmodels: {},
    token: "ollama-token",
  });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer ollama-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "mlx/fast", messages: [{ role: "user", content: "hello" }] }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("ok");
  const tooMuch = await fetch(`${relay.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer ollama-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "mlx/fast", max_tokens: 2048, messages: [{ role: "user", content: "x".repeat(25_000) }] }),
  });
  expect(tooMuch.status).toBe(400);
});
