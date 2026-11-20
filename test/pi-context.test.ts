import { expect, test } from "bun:test";
import { piContext } from "../src/adapters/definitions/native-context.ts";
import { contextHeadroom, ContextWindows } from "../src/hub/context-window.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { rosterPiFixture } from "./fakes/pi-roster-tui.ts";

test("Pi occupancy is the current prompt plus cache, and missing components stay unknown", () => {
  const value = piContext({ input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 }, "session", 10);
  expect(value).toEqual({ source: "pi_usage", sessionId: "session", measuredAt: 10, tokens: 50, window: 100, used: 0.5 });
  for (const bad of [{ input: 0, cacheRead: 0, contextWindow: 100 }, { input: -1, cacheRead: 0, cacheWrite: 0, contextWindow: 100 }, { input: 1, cacheRead: 0, cacheWrite: 0, contextWindow: 0 }]) expect(piContext(bad, "session", 10).used).toBeNull();
  const windows = new ContextWindows({ gate: 0, stale_min: 30 }, () => {}, () => 10);
  windows.report("pi", value, "session");
  expect(windows.view("pi", "session", true)).toMatchObject({ used: 0.5, freshness: "fresh" });
  expect(contextHeadroom({ max_used: 0.4, stale_min: 30 }, windows.admission("pi", "session", true), 10)?.blocked).toBe(true);
  expect(windows.view("pi", "other", true).used).toBeNull();
});

test("verified Pi TUI reports session model, fenced occupancy and Record prompt", async () => {
  const f = await rosterPiFixture();
  const readings: unknown[] = [];
  (f.peer as any).opts.onContext = (value: unknown, session: string) => readings.push({ value, session });
  (f.peer as any).opts.selectModel = async () => "mlx/fast";
  f.peer.recordInstruction = () => "Record instruction";
  try {
    await f.post("/event", { type: "pi_model", sessionId: f.sessionId, model: { id: "mlx/fast" } });
    expect(readings).toEqual([{ session: f.sessionId, value: undefined }]); readings.length = 0;
    const pending = f.peer.deliver([newEnvelope("user", "work", { to: ["pi"] })]);
    const select = await f.next(); expect(select.type).toBe("set_model"); await f.ack(select);
    const prompt = await f.next(); expect(prompt.type).toBe("prompt"); expect(prompt.message).toContain("Record instruction");
    await f.ack(prompt); await pending;
    expect(f.peer.observedModel()).toEqual({ model: "mlx/fast", evidence: "session" });
    await f.post("/event", { type: "agent_start", sessionId: f.sessionId, generation: 1 });
    await f.post("/event", { type: "pi_usage", sessionId: "other", generation: 1, context: { input: 99 } });
    await f.post("/event", { type: "pi_usage", sessionId: f.sessionId, generation: 0, context: { input: 99 } });
    await f.post("/event", { type: "pi_usage", sessionId: f.sessionId, generation: 1, context: { input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 } });
    expect(readings).toEqual([{ session: f.sessionId, value: { input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 } }]);
    await f.post("/event", { type: "agent_end", sessionId: f.sessionId, generation: 1 });
    await f.post("/event", { type: "agent_settled", sessionId: f.sessionId, generation: 1 });
    await f.post("/event", { type: "pi_usage", sessionId: f.sessionId, generation: 1, context: { input: 99 } });
    expect(readings).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 10_000);

test("the actual extension emits prompt occupancy and the current model in its snapshot", async () => {
  const posts: any[] = []; let queued: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/commands") { if (queued) { const command = queued; queued = undefined; return Response.json({ command }); } await Bun.sleep(10); return Response.json({ command: null }); }
    posts.push(await req.json()); return Response.json({ ok: true });
  } });
  const oldUrl = process.env.AGENTHUB_PI_BRIDGE_URL, oldToken = process.env.AGENTHUB_PI_BRIDGE_TOKEN;
  process.env.AGENTHUB_PI_BRIDGE_URL = `http://127.0.0.1:${server.port}`; process.env.AGENTHUB_PI_BRIDGE_TOKEN = "fixture";
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
  try {
    const { default: extension } = await import("../src/pi/extension.ts" + "?pi-context-fixture");
    extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerProvider: () => {}, registerTool: () => {} });
    const message = { role: "assistant", model: "mlx/fast", usage: { input: 20, cacheRead: 25, cacheWrite: 5, output: 10 } };
    const ctx = { model: { id: "mlx/fast", contextWindow: 100 }, modelRegistry: {}, shutdown: () => {}, isIdle: () => true,
      sessionManager: { getHeader: () => ({ id: "s" }), getSessionFile: () => "/tmp/s", getEntries: () => [{ type: "message", message }] } };
    await handlers.get("session_start")!({}, ctx);
    await handlers.get("agent_start")!({});
    await handlers.get("message_end")!({ message }, ctx);
    expect(posts.find(p => p.type === "pi_usage")).toMatchObject({ sessionId: "s", generation: 1, context: { input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 } });
    queued = { id: "snapshot", type: "get_session_state" };
    for (let i = 0; i < 100 && !posts.some(p => p.id === "snapshot"); i++) await Bun.sleep(10);
    expect(posts.find(p => p.id === "snapshot")?.result).toMatchObject({ sessionId: "s", model: { id: "mlx/fast" }, context: { input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 } });
    await handlers.get("model_select")!({}, { ...ctx, model: { id: "dgx/coding", contextWindow: 200 } });
    queued = { id: "snapshot-after-switch", type: "get_session_state" };
    for (let i = 0; i < 100 && !posts.some(p => p.id === "snapshot-after-switch"); i++) await Bun.sleep(10);
    expect(posts.find(p => p.id === "snapshot-after-switch")?.result.context).toEqual({ contextWindow: 200 });
  } finally {
    try { await handlers.get("session_shutdown")?.({}); } catch {}
    server.stop(true);
    if (oldUrl === undefined) delete process.env.AGENTHUB_PI_BRIDGE_URL; else process.env.AGENTHUB_PI_BRIDGE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.AGENTHUB_PI_BRIDGE_TOKEN; else process.env.AGENTHUB_PI_BRIDGE_TOKEN = oldToken;
  }
}, 10_000);

test("Pi TUI occupancy reaches daemon status and rejects stale-session observations", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startDaemon, DEFAULT_CONFIG } = await import("../src/hub/daemon.ts");
  const { ControlClient } = await import("../src/hub/control-client.ts");
  const { processSignature } = await import("../src/pi/process-signature.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-context-daemon-"));
  const config = { ...DEFAULT_CONFIG, roster: { pi: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
    pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] } };
  const daemon = await startDaemon({ cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const console_ = await ControlClient.connect(root, { role: "console" });
  const owner = Bun.spawn(["sleep", "60"]);
  try {
    const started = await console_.request({ t: "start", peer: "pi", args: { mode: "tui", backend: "dgx" } });
    expect(started.ok).toBe(true);
    const launch = started.launch, url = launch.env.AGENTHUB_PI_BRIDGE_URL;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const post = (body: unknown) => fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: processSignature(owner.pid), sessionId: "s", sessionFile: join(root, "s.jsonl") })).ok).toBe(true);
    const peer = daemon.bus.peers.get("pi") as any;
    expect(typeof peer.recordInstruction).toBe("function"); expect(peer.verifiedRecordSession).toBe("s");
    await post({ type: "agent_start", sessionId: "s", generation: 1 });
    await post({ type: "pi_usage", sessionId: "s", generation: 1, context: { input: 20, cacheRead: 25, cacheWrite: 5, contextWindow: 100 } });
    const status = await console_.request({ t: "status" });
    expect(status.status.peers.pi.context).toMatchObject({ source: "pi_usage", used: 0.5, freshness: "fresh" });
    await post({ type: "pi_usage", sessionId: "old", generation: 1, context: { input: 90, cacheRead: 0, cacheWrite: 0, contextWindow: 100 } });
    expect((await console_.request({ t: "status" })).status.peers.pi.context.used).toBe(0.5);
    await post({ type: "pi_usage", sessionId: "s", generation: 1, context: {} });
    expect((await console_.request({ t: "status" })).status.peers.pi.context.used).toBeNull();
  } finally { owner.kill(); await owner.exited; console_.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("Pi headless prompt occupancy reaches daemon status", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startDaemon, DEFAULT_CONFIG } = await import("../src/hub/daemon.ts");
  const { ControlClient } = await import("../src/hub/control-client.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-context-headless-"));
  const config = { ...DEFAULT_CONFIG, roster: { pi: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
    pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] } };
  const daemon = await startDaemon({ cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const console_ = await ControlClient.connect(root, { role: "console" });
  try {
    expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } })).ok).toBe(true);
    const peer = daemon.bus.peers.get("pi") as any, launch = peer.tuiLaunch, session = peer.nativeSession;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const post = (body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify(body) });
    await post({ type: "agent_start", sessionId: session, generation: 1 });
    await post({ type: "pi_usage", sessionId: session, generation: 1, context: { input: 30, cacheRead: 10, cacheWrite: 10, contextWindow: 100 } });
    expect((await console_.request({ t: "status" })).status.peers.pi.context).toMatchObject({ source: "pi_usage", used: 0.5, freshness: "fresh" });
  } finally { console_.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
