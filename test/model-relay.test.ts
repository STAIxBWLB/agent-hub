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
  // The handler waits until the relay's request is aborted: one that never settles makes `stop(true)` poll for it
  // (about 100 ms each time, past the 5 s test limit on a loaded macOS runner; issue #80). If the relay stopped aborting
  // the upstream request, the handler and the client's request would hang and the test would still fail.
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => { seen(); await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })); return new Response("never"); } });
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

test("#102 relay refuses exhausted admission before any upstream dispatch", async () => {
  let requests = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("should never arrive"); } });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "glm-5" }, token: "relay-token", admitRequest: async () => ({ allowed: false, reason: "execution budget exhausted" }) });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: "do not dispatch" }] }) });
  expect(response.status).toBe(502);
  expect(await response.text()).toContain("execution budget exhausted");
  expect(requests).toBe(0);
  expect(relay.status().backends[0]?.active).toBe(0);
});

test("#101 relay model provenance ignores gateway heartbeat model labels", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"keepalive","choices":[]}\n\ndata: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: "provenance" }] }) });
  await response.text();
  expect(relay.status().backends[0]?.actualModel).toBe("physical/model");
});

const dgxRelay = async (upstream: ReturnType<typeof Bun.serve>) => {
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token" });
  cleanup.push(relay.close);
  return relay;
};
const dgxRequest = (relay: { url: string }) => fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: "provenance" }] }) });

test("#137 a nonempty empty-delta heartbeat cannot set the served model", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\ndata: {"model":"real-model","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  expect(await response.text()).toContain("OK"); // generation data is forwarded, heartbeat included
  expect(relay.status().backends[0]?.actualModel).toBe("real-model");
});

test("#137 a heartbeat-only stream leaves the served model unknown", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\ndata: {"model":"keepalive","choices":[]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  await response.text();
  expect(relay.status().backends[0]?.actualModel).toBeUndefined();
});

test("#137 a role-only first chunk identifies the served model", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\ndata: {"model":"role-model","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"model":"role-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  await response.text();
  expect(relay.status().backends[0]?.actualModel).toBe("role-model");
});

test("#137 heartbeat classification survives SSE frames split across chunks", async () => {
  const frames = ['data: {"model":"keep', 'alive","choices":[{"index":0,"delta":{}}]}\n\nda', 'ta: {"model":"split-model","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    async start(controller) {
      for (const frame of frames) { controller.enqueue(new TextEncoder().encode(frame)); await new Promise((resolve) => setTimeout(resolve, 5)); }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  await response.text();
  expect(relay.status().backends[0]?.actualModel).toBe("split-model");
});

test("#137 a stream cancelled before identification leaves the served model unknown", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\n'));
      // never closes and never identifies: the client cancels first
    },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(relay.status().backends[0]?.actualModel).toBeUndefined();
});

const waitForRecords = async (relay: { requests: () => unknown[] }, count: number) => {
  for (let attempt = 0; attempt < 100 && relay.requests().length < count; attempt++) await Bun.sleep(10);
  return relay.requests();
};

test("#139 concurrent requests are fenced: a pre-identification cancellation does not contaminate a settled request", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as any;
    const prompt = body.messages[0].content as string;
    if (prompt.includes("cancel-me")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\n'));
          // never identifies and never closes: the client cancels first
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response('data: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  const relay = await dgxRelay(upstream);
  const ask = (prompt: string) => fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: prompt }] }) });
  const cancelled = await ask("cancel-me");
  const settled = await ask("settle");
  expect(await settled.text()).toContain("ok");
  await cancelled.body?.cancel();
  const records = (await waitForRecords(relay, 2)) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(records).toHaveLength(2);
  const cancelledRecord = records.find((record) => record.outcome === "cancelled")!;
  expect(cancelledRecord).toMatchObject({ alias: "dgx/coding", requestedModel: "coding", identified: false, identitySource: "none", role: "unknown" });
  expect(cancelledRecord.actualModel).toBeUndefined();
  const settledRecord = records.find((record) => record.outcome === "completed")!;
  expect(settledRecord).toMatchObject({ alias: "dgx/coding", requestedModel: "coding", actualModel: "physical/model", identitySource: "stream", identified: true, role: "unknown" });
  expect(settledRecord.mismatch).toBe(true); // observed "physical/model" differs from the configured "coding"
});

test("#139 a heartbeat-only stream completes unidentified with unknown model", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\ndata: {"model":"keepalive","choices":[]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  await response.text();
  const records = (await waitForRecords(relay, 1)) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ outcome: "completed", identified: false, identitySource: "none", role: "unknown" });
  expect(records[0]!.actualModel).toBeUndefined();
  expect(records[0]!.mismatch).toBeUndefined();
});

test("#139 provider headers stay unknown when absent while a stream model is still recorded", async () => {
  const withHeaders = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream", "x-omniroute-provider": "vllm", "x-model-router-selected-model": "coding" } }) });
  const relayWith = await dgxRelay(withHeaders);
  await (await dgxRequest(relayWith)).text();
  const headerRecord = (await waitForRecords(relayWith, 1))[0] as import("../src/models/relay.ts").RelayRequestRecord;
  expect(headerRecord).toMatchObject({ provider: "vllm", actualModel: "coding", identitySource: "header", identified: true, outcome: "completed" });
  expect(headerRecord.mismatch).toBeUndefined(); // observed matches the configured model

  const withoutHeaders = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relayWithout = await dgxRelay(withoutHeaders);
  await (await dgxRequest(relayWithout)).text();
  const streamRecord = (await waitForRecords(relayWithout, 1))[0] as import("../src/models/relay.ts").RelayRequestRecord;
  expect(streamRecord.provider).toBeUndefined();
  expect(streamRecord).toMatchObject({ actualModel: "physical/model", identitySource: "stream", identified: true, outcome: "completed" });
});

test("#139 an upstream error closes the record as failed", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("boom", { status: 500 }) });
  const relay = await dgxRelay(upstream);
  const response = await dgxRequest(relay);
  expect(response.status).toBe(502);
  const records = (await waitForRecords(relay, 1)) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ outcome: "failed", identified: false, identitySource: "none", alias: "dgx/coding" });
  expect(records[0]!.actualModel).toBeUndefined();
});

test("#139 request records carry no prompt, key or Access material", async () => {
  const marker = "xyzzy-distinctive-prompt-9f3";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    expect(request.headers.get("authorization")).toBe("Bearer dgx-key");
    expect(request.headers.get("cf-access-token")).toBe("cf-access-secret");
    return new Response('data: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const omniWithAccess = { base: async () => `http://127.0.0.1:${upstream.port}/v1`, apiKey: () => "dgx-key", accessHeaders: () => ({ "cf-access-token": "cf-access-secret" }) } as any;
  const relay = await startModelRelay({ omni: omniWithAccess, allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: marker }], tools: [{ name: marker }] }) });
  await response.text();
  const records = await waitForRecords(relay, 1);
  expect(records).toHaveLength(1);
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("dgx-key");
  expect(serialized).not.toContain("cf-access-secret");
  expect(serialized).not.toContain("relay-token");
  expect(Object.keys(records[0] as object).sort()).toEqual(["actualModel", "alias", "at", "durationMs", "id", "identified", "identitySource", "mismatch", "outcome", "requestedModel", "role"].sort());
});

test("#139 onRequest fires exactly once per record at its terminal close", async () => {
  const emitted: import("../src/models/relay.ts").RelayRequestRecord[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as any;
    if ((body.messages[0].content as string).includes("cancel-me")) {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response('data: {"model":"coding","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token", onRequest: (record) => emitted.push(record) });
  cleanup.push(relay.close);
  const ask = (prompt: string) => fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/coding", messages: [{ role: "user", content: prompt }] }) });
  const cancelled = await ask("cancel-me");
  await (await ask("settle")).text();
  await cancelled.body?.cancel();
  await waitForRecords(relay, 2);
  expect(emitted).toHaveLength(2);
  for (const record of emitted) {
    expect(["completed", "cancelled"]).toContain(record.outcome);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }
  // closing the relay afterwards emits nothing more for already-closed records
  await relay.close();
  expect(emitted).toHaveLength(2);
});

test("#139 a relay close cancels an in-flight unidentified request", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"model":"keepalive","choices":[{"index":0,"delta":{}}]}\n\n'));
    },
  }), { headers: { "content-type": "text/event-stream" } }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token" });
  const pending = dgxRequest(relay);
  const response = await pending;
  const drain = response.text().catch(() => ""); // consume the abort the close delivers to the stream
  await relay.close();
  await drain;
  expect(relay.requests()).toHaveLength(1);
  expect(relay.requests()[0]).toMatchObject({ outcome: "cancelled", identified: false, identitySource: "none" });
});

test("#139 the request journal keeps only the last 1000 records", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"coding","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  const relay = await dgxRelay(upstream);
  for (let index = 0; index < 1001; index++) await (await dgxRequest(relay)).text();
  const records = relay.requests();
  expect(records).toHaveLength(1000);
  expect(new Set(records.map((record) => record.id)).size).toBe(1000);
  expect(records.every((record) => record.outcome === "completed" && record.identified)).toBe(true);
});

test("#139 review: a throwing onRequest hook never breaks the proxied stream", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"coding","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token", onRequest: () => { throw new Error("persistence exploded"); } });
  cleanup.push(relay.close);
  const response = await dgxRequest(relay);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("ok");
  expect(relay.requests()).toHaveLength(1); // the journal itself is not the hook
  expect(relay.requests()[0]).toMatchObject({ outcome: "completed", identified: true });
});

test("#139 review: a failed upstream dispatch still records what the relay asked for", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("upstream broken", { status: 500 }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "glm-5" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await dgxRequest(relay);
  expect(response.status).toBe(502);
  expect(relay.requests()).toHaveLength(1);
  expect(relay.requests()[0]).toMatchObject({ outcome: "failed", identified: false, requestedModel: "glm-5", alias: "dgx/coding" });
});

test("#139 review: a rejecting async onRequest hook is not an unhandled rejection", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: {"model":"coding","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "coding" }, token: "relay-token", onRequest: (() => Promise.reject(new Error("async persistence exploded"))) as () => void });
  cleanup.push(relay.close);
  const response = await dgxRequest(relay);
  expect(await response.text()).toContain("ok");
  await Bun.sleep(20); // the rejection settles unobserved by the relay
  expect(relay.requests()).toHaveLength(1);
  expect(relay.requests()[0]).toMatchObject({ outcome: "completed", identified: true });
});

test("#139 explicit physical expectation separates a provider-prefixed route from the served model", async () => {
  let requested: unknown;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    requested = (await request.json() as { model?: unknown }).model;
    return new Response('data: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "provider/physical/model" }, expectedServedModels: { "dgx/coding": "physical/model" }, token: "relay-token" });
  cleanup.push(relay.close);
  await (await dgxRequest(relay)).text();
  const records = await waitForRecords(relay, 1) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(requested).toBe("provider/physical/model");
  expect(records[0]).toMatchObject({ requestedModel: "provider/physical/model", actualModel: "physical/model", identified: true, outcome: "completed" });
  expect(records[0]?.mismatch).toBeUndefined();
});

test("#139 explicit physical expectation still rejects an identified wrong model after cancellation", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"model":"other/model","choices":[{"delta":{"content":"wrong"}}]}\n\n'));
  } }), { headers: { "content-type": "text/event-stream" } }) });
  cleanup.push(() => upstream.stop(true));
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "provider/physical/model" }, expectedServedModels: { "dgx/coding": "physical/model" }, token: "relay-token" });
  cleanup.push(relay.close);
  const response = await dgxRequest(relay);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  const records = await waitForRecords(relay, 1) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(records[0]).toMatchObject({ actualModel: "other/model", identified: true, mismatch: true, outcome: "cancelled" });
});


test("#139 physical expectation is frozen per request while later requests see configuration changes", async () => {
  let announce!: () => void;
  let release!: () => void;
  const announced = new Promise<void>((resolve) => { announce = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    announce();
    await released;
    return new Response('data: {"model":"physical/model","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const expectedServedModels = { "dgx/coding": "physical/model" };
  const relay = await startModelRelay({ omni: omni(`http://127.0.0.1:${upstream.port}/v1`), allowedDGXmodels: { "dgx/coding": "provider/physical/model" }, expectedServedModels, token: "relay-token" });
  cleanup.push(relay.close);
  const first = dgxRequest(relay);
  await announced;
  expectedServedModels["dgx/coding"] = "replacement/model";
  release();
  await (await first).text();
  await (await dgxRequest(relay)).text();
  const records = await waitForRecords(relay, 2) as import("../src/models/relay.ts").RelayRequestRecord[];
  expect(records[0]?.mismatch).toBeUndefined();
  expect(records[1]?.mismatch).toBe(true);
});

test("#161 final streaming usage remains separate and request-bound after model identification", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as any;
    const prompt = body.messages[0].content;
    return new Response(
    'data: {"model":"coding","choices":[{"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[],"usage":' + (prompt === 'zero' ? '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}' : '{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}') + '}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ); } });
  const relay = await dgxRelay(upstream);
  await Promise.all(['zero', 'five'].map(async (p) => { const r = await fetch(`${relay.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer relay-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'dgx/coding', messages: [{ role: 'user', content: p }] }) }); await r.text(); }));
  const records = relay.requests();
  expect(records).toHaveLength(2);
  expect(records.map((r) => r.requestUsage?.totalTokens).sort()).toEqual([0, 5]);
  for (const r of records) expect(r).toMatchObject({ identified: true, providerSource: 'none', providerAvailability: 'missing', usageAvailability: 'known', requestUsage: { source: 'openai-stream-usage', completeness: 'complete' } });
});

test("#161 usage validation preserves measured zero and rejects invalid readings", async () => {
  const { normalizeRelayUsage } = await import('../src/models/relay.ts');
  expect(normalizeRelayUsage({ total_tokens: 0 })).toMatchObject({ totalTokens: 0, completeness: 'partial' });
  for (const value of [null, {}, { total_tokens: -1 }, { total_tokens: Infinity }, { total_tokens: '0' }]) expect(normalizeRelayUsage(value)).toBeUndefined();
});

test('#163 disabled local capability omits and rejects mlx/fast', async () => {
  const relay = await startModelRelay({ omni: omni('http://127.0.0.1:9/v1'), enableHubAuto: true, allowedDGXmodels: { 'dgx/fast': 'fast', 'dgx/coding': 'coding' }, token: 'relay-token' });
  cleanup.push(relay.close);
  expect(relay.models).toEqual(['hub/auto', 'dgx/fast', 'dgx/coding']);
  const response = await fetch(`${relay.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer relay-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mlx/fast', messages: [{ role: 'user', content: 'hello' }] }) });
  expect(response.status).toBe(400);
  expect(relay.requests()).toHaveLength(0);
});
