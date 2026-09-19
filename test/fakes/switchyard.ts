#!/usr/bin/env bun
// Stand-in for `switchyard-server` v0.2.0: same flags, /health, forwards /v1/chat/completions to the gateway in its
// config with the key from `api_key_env`, maps route id -> target id, answers with x-model-router-selected-model.
// Set FAKE_SWITCHYARD=reject-config | die-after-start | fail-calls to exercise the hub's fallbacks.
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const cfg = Bun.TOML.parse(await Bun.file(arg("--config")!).text()) as any;
const mode = process.env.FAKE_SWITCHYARD ?? "";
if (cfg.schema_version !== 1 || !cfg.llm_clients?.gateway || mode === "reject-config") {
  console.error("config error: invalid switchyard config");
  process.exit(2);
}
const gateway = cfg.llm_clients.gateway;
if (!process.env[gateway.api_key_env]) {
  console.error(`missing env ${gateway.api_key_env}`);
  process.exit(2);
}
if (process.argv.includes("--dry-run")) process.exit(0);
if (arg("--host") !== "127.0.0.1") {
  console.error("refusing: the hub must bind loopback");
  process.exit(3);
}
const routes = Object.values(cfg.routes ?? {}) as any[];
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(arg("--port")),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (mode === "fail-calls") return new Response("upstream exploded", { status: 502 });
    const body = (await req.json()) as any;
    const route = routes.find((r) => r.id === body.model);
    if (!route) return new Response(`unknown route ${body.model}`, { status: 404 });
    const target = cfg.targets[route.target ?? route.efficient_target ?? route.weak_target];
    const res = await fetch(`${gateway.base_url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env[gateway.api_key_env]}`, ...(gateway.extra_headers ?? {}) },
      body: JSON.stringify({ ...body, model: target.id }),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "x-model-router-selected-model": target.id } });
  },
});
if (mode === "die-after-start") setTimeout(() => process.exit(1), 300);
export {};
