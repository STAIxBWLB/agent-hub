import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMlx, inspectMlx, stopMlx } from "../src/models/mlx.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fakeOllama(model = "agenthub-fast-mlx:4b-8k", context = 8192) {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
      if (path === "/api/show") return Response.json({ parameters: `num_ctx ${context}\nnum_predict 2048\n` });
      if (path === "/api/ps") return Response.json({ models: [{ name: model, expires_at: expiresAt }] });
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  return server;
}

test("Ollama status distinguishes catalog availability and residency without a PID", async () => {
  const server = fakeOllama();
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-ollama-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const status = await inspectMlx({ provider: "ollama", host: "127.0.0.1", port: server.port, model: "agenthub-fast-mlx:4b-8k", runtimeDir });
  expect(status).toMatchObject({ state: "ready", provider: "ollama", modelAvailable: true, modelResident: true, contextWindow: 8192, maxTokens: 2048 });
  expect(Date.parse(status.expiresAt!)).toBeGreaterThan(Date.now());
  expect(status.pid).toBeUndefined();
});

test("Ollama requires the configured context and refuses stop ownership", async () => {
  const server = fakeOllama("agenthub-fast-mlx:4b-8k", 4096);
  await expect(inspectMlx({ provider: "ollama", host: "127.0.0.1", port: server.port, model: "agenthub-fast-mlx:4b-8k", contextWindow: 8192 })).resolves.toMatchObject({ state: "error", modelAvailable: false });
  await expect(stopMlx({ provider: "ollama", host: "127.0.0.1", port: server.port, model: "agenthub-fast-mlx:4b-8k" })).rejects.toThrow(/externally managed/);
});

test("Ollama rejects non-loopback endpoints and cloud model names", async () => {
  await expect(inspectMlx({ provider: "ollama", host: "192.168.1.2" })).rejects.toThrow(/loopback/);
  await expect(inspectMlx({ provider: "ollama", model: "qwen3.5:cloud" })).rejects.toThrow(/local model/);
});

test("Ollama ensure acquires a cross-process generation slot and close is non-destructive", async () => {
  const server = fakeOllama();
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-ollama-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const handle = await ensureMlx({ provider: "ollama", host: "127.0.0.1", port: server.port, model: "agenthub-fast-mlx:4b-8k", runtimeDir });
  const release = await handle.acquire();
  expect(handle.status().active).toBe(1);
  release();
  await handle.close();
  expect(handle.status().active).toBe(0);
});

test("Ollama rejects remote metadata, failed residency status, redirects, and indefinite residency", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-ollama-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const model = "agenthub-fast-mlx:4b-8k";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
      if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\n", remote_host: "cloud.ollama.ai" });
      if (path === "/api/ps") return new Response("down", { status: 503 });
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  await expect(inspectMlx({ provider: "ollama", host: "127.0.0.1", port: server.port, model, runtimeDir })).resolves.toMatchObject({ state: "error", modelAvailable: false });

  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "https://example.invalid/api/tags" } }) });
  cleanup.push(() => redirect.stop(true));
  await expect(inspectMlx({ provider: "ollama", host: "127.0.0.1", port: redirect.port, model, runtimeDir })).resolves.toMatchObject({ state: "error" });

  const indefinite = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
      if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\n" });
      if (path === "/api/ps") return Response.json({ models: [{ name: model }] });
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => indefinite.stop(true));
  await expect(inspectMlx({ provider: "ollama", host: "127.0.0.1", port: indefinite.port, model, runtimeDir })).resolves.toMatchObject({ state: "error", modelAvailable: true, modelResident: true });
});

test("independent Ollama handles share the generation slot and queued acquisition cancels", async () => {
  const server = fakeOllama();
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-ollama-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const options = { provider: "ollama" as const, host: "127.0.0.1", port: server.port, model: "agenthub-fast-mlx:4b-8k", runtimeDir };
  const first = await ensureMlx(options);
  const second = await ensureMlx(options);
  const release = await first.acquire();
  const aborter = new AbortController();
  const queued = second.acquire(aborter.signal);
  await Bun.sleep(30);
  aborter.abort();
  await expect(queued).rejects.toThrow(/cancelled/);
  release();
});
