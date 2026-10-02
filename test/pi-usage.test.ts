import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { assistantTokens } from "../src/pi/usage.ts";
import { formatReport, summarize } from "../src/hub/report.ts";

test("#94 Pi usage uses its reported total, includes cache components when no total is provided, and refuses guesses", () => {
  expect(assistantTokens({ role: "assistant", usage: { totalTokens: 57, input: 20, output: 7, cacheRead: 25, cacheWrite: 5 } })).toBe(57);
  expect(assistantTokens({ role: "assistant", usage: { input: 20, output: 7, cacheRead: 25, cacheWrite: 5 } })).toBe(57);
  for (const message of [null, { role: "user", usage: { totalTokens: 7 } }, { role: "assistant" }, { role: "assistant", usage: { input: "20", output: 7 } }, { role: "assistant", usage: { input: 20, output: -7 } }]) expect(assistantTokens(message)).toBeUndefined();
  const r = summarize([{ v: 1, at: new Date().toISOString(), type: "turn_end", peer: "pi", turn: "p", ms: 10 }]);
  expect(formatReport(r).join("\n")).toContain("tokens not reported");
});

test("#94 the Pi bridge records usage once per message before releasing the turn", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-usage-test-")); const added: number[] = []; const order: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", onTokens: (n) => { added.push(n); order.push(`tokens:${n}`); } });
  peer.onState = (state) => { if (state === "idle") order.push("idle"); };
  try {
    await peer.start(); await peer.deliver([newEnvelope("user", "count usage", { to: ["pi"] })]); order.length = 0;
    const launch = peer.tuiLaunch!; const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const post = (body: unknown) => fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify(body) });
    await post({ type: "tokens", id: "message1", tokens: 57 }); await post({ type: "tokens", id: "message1", tokens: 57 });
    await post({ type: "tokens", id: "message2", tokens: 11 }); await post({ type: "tokens", id: "bad", tokens: "999" }); await post({ type: "tokens", id: "negative", tokens: -1 });
    await post({ type: "agent_end", text: "done", tokens: 68 }); await post({ type: "agent_settled" });
    expect(added).toEqual([57, 11]); expect(order).toEqual(["tokens:57", "tokens:11", "idle"]);
    const r = summarize([{ v: 1, at: new Date().toISOString(), type: "tokens", peer: "pi", n: added.reduce((a, b) => a + b, 0) }]);
    expect(formatReport(r).join("\n")).toContain("68 tokens");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("#94 the actual extension forwards assistant message usage and does not recount it at agent_end", async () => {
  const posts: any[] = [];
  let budgetOffline = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.json() as any; posts.push(body); if (new URL(req.url).pathname === "/budget" && budgetOffline) return Response.json({ error: "stale Pi budget request" }, { status: 409 }); return Response.json({ ok: true }); } });
  const previousUrl = process.env.AGENTHUB_PI_BRIDGE_URL; const previousToken = process.env.AGENTHUB_PI_BRIDGE_TOKEN;
  process.env.AGENTHUB_PI_BRIDGE_URL = `http://127.0.0.1:${server.port}`; process.env.AGENTHUB_PI_BRIDGE_TOKEN = "test-token";
  try {
    const { default: extension } = await import("../src/pi/extension.ts");
    const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
    extension({ on: (name: string, handler: (event: any, ctx?: any) => Promise<unknown>) => handlers.set(name, handler), registerProvider: () => {}, registerTool: () => {} });
    const message = { role: "assistant", content: [{ type: "text", text: "done" }], usage: { totalTokens: 57 } };
    await handlers.get("message_end")!({ message }); await handlers.get("agent_end")!({ messages: [message] });
    expect(posts.filter((p) => p.type === "tokens")).toMatchObject([{ id: "usage-1", tokens: 57 }]);
    expect(posts.find((p) => p.type === "agent_end")).not.toHaveProperty("tokens");
    budgetOffline = true;
    await handlers.get("agent_start")!({});
    let aborted = false;
    await handlers.get("before_provider_request")!({}, { model: { provider: "agent-hub-local" }, abort: () => { aborted = true; } });
    expect(aborted).toBe(true);
    expect(posts.some((p) => p.type === "agent_end" && String(p.error).includes("admission unavailable"))).toBe(true);
  } finally {
    server.stop(true);
    if (previousUrl === undefined) delete process.env.AGENTHUB_PI_BRIDGE_URL; else process.env.AGENTHUB_PI_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.AGENTHUB_PI_BRIDGE_TOKEN; else process.env.AGENTHUB_PI_BRIDGE_TOKEN = previousToken;
  }
});
