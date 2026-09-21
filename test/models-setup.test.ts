import { afterEach, expect, test } from "bun:test";
import { setupOllamaModel } from "../src/cli/models-setup.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function fixture(existing = false) {
  const calls: { path: string; body: any }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.json() as { model?: string };
    calls.push({ path, body });
    if (path === "/api/show" && body.model === "qwen3.5:4b-mlx") return Response.json({});
    if (path === "/api/show") return existing ? Response.json({}) : Response.json({ error: "missing" }, { status: 404 });
    return Response.json({ status: "success" });
  } });
  servers.push(server);
  return { calls, options: { provider: "ollama" as const, port: server.port!, model: "agenthub-fast-mlx:4b-8k", contextWindow: 8192, maxInputTokens: 6000, maxTokens: 2048 } };
}
test("setup prepares a bounded derived model without loading a runner", async () => {
  const { calls, options } = fixture();
  await setupOllamaModel(options);
  expect(calls.map(x => x.path)).toEqual(["/api/pull", "/api/show", "/api/show", "/api/create"]);
  expect(calls[3]!.body).toMatchObject({ model: options.model, from: "qwen3.5:4b-mlx", parameters: { num_ctx: 8192, num_predict: 2048 } });
});
test("setup does not overwrite an existing user's model", async () => {
  const { calls, options } = fixture(true);
  await setupOllamaModel(options);
  expect(calls.some(x => x.path === "/api/create")).toBe(false);
});
test("setup rejects cloud sources and non-loopback endpoints before download", async () => {
  const { calls, options } = fixture();
  await expect(setupOllamaModel({ ...options, sourceModel: "qwen:cloud" })).rejects.toThrow();
  await expect(setupOllamaModel({ ...options, host: "gateway.example" })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("setup rejects a local-looking source alias with remote metadata before creation", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname; paths.push(path);
    return Response.json(path === "/api/show" ? { remote_host: "https://remote.example", remote_model: "hidden" } : { status: "success" });
  } });
  servers.push(server);
  await expect(setupOllamaModel({ provider: "ollama", port: server.port })).rejects.toThrow("remote/cloud");
  expect(paths).toEqual(["/api/pull", "/api/show"]);
});
