import { FakeMemoryClient } from "./fakes/mem-worker.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(ready: () => boolean, label: string) {
  for (let n = 0; n < 400 && !ready(); n++) await Bun.sleep(5);
  expect(ready(), label).toBe(true);
}
async function fixture(memoryUrl?: string) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-standby-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const daemon = await startDaemon({ ...(memoryUrl ? { memoryClient: new FakeMemoryClient(memoryUrl) } : {}), cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: !!memoryUrl, ...(memoryUrl ? { worker_url: memoryUrl } : {}) }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
  const instanceId = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId;
  const connect = async (hello: Record<string, unknown> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}`), messages: any[] = [];
    cleanup.push(() => socket.close());
    let closeCode: number | undefined, rid = 1;
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    socket.onclose = event => { closeCode = event.code; };
    await new Promise<void>((resolve, reject) => { socket.onerror = () => reject(new Error("fixture websocket failed")); socket.onopen = () => { socket.send(JSON.stringify({ t: "hello", v: PROTOCOL, token, role: "peer", peer: "claude", channel: true, rid, ...hello })); resolve(); }; });
    await until(() => closeCode !== undefined || messages.some(row => row.t === "welcome"), "hello result");
    return { socket, messages, closed: () => closeCode, request: async (body: Record<string, unknown>) => {
      const id = ++rid; socket.send(JSON.stringify({ ...body, rid: id }));
      await until(() => messages.some(row => row.rid === id), `reply ${String(body.t)}`);
      return messages.find(row => row.rid === id);
    } };
  };
  return { root, stateDir, daemon, console_, instanceId, connect };
}
async function settle(f: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>>, body: string) {
  expect((await f.console_.request({ t: "send", body, to: ["claude"] })).ok).toBe(true);
  await until(() => owner.messages.some(row => row.t === "deliver" && row.envs?.some((env: any) => env.body === body)), "delivery to current owner");
  const delivery = owner.messages.find(row => row.t === "deliver" && row.envs?.some((env: any) => env.body === body));
  expect((await owner.request({ t: "delivery_receipt", deliveryId: delivery.deliveryId, generation: delivery.generation, state: "accepted" })).ok).toBe(true);
  expect((await owner.request({ t: "delivery_complete", deliveryId: delivery.deliveryId, generation: delivery.generation })).ok).toBe(true);
  // Settlement alone leaves the native peer busy; this fixture explicitly ends that turn.
  expect((f.daemon.bus.peers.get("claude") as any).nativeStopped("fixture-session")).toBe(true);
  expect(f.daemon.bus.queueList("claude").filter(row => ["dispatching", "accepted", "needs_review"].includes(row.state))).toEqual([]);
}

test("#551 stale launch is terminal before replacement and preserves the current generation's accepted delivery", async () => {
  const f = await fixture();
  writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: f.instanceId, launchId: "current-launch" }));
  const current = await f.connect({ launchId: "current-launch" });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "current attached");
  await f.console_.request({ t: "send", body: "in-flight current delivery", to: ["claude"] });
  await until(() => current.messages.some(row => row.t === "deliver"), "current push");
  const delivery = current.messages.find(row => row.t === "deliver");
  expect((await current.request({ t: "delivery_receipt", deliveryId: delivery.deliveryId, generation: delivery.generation, state: "accepted" })).ok).toBe(true);
  const stale = await f.connect({ launchId: "ended-launch" });
  await until(() => stale.closed() !== undefined, "stale launch refused");
  expect(stale.closed()).toBe(4430); expect(current.closed()).toBeUndefined();
  expect(stale.messages.some(row => row.t === "welcome")).toBe(false);
  expect((await current.request({ t: "delivery_complete", deliveryId: delivery.deliveryId, generation: delivery.generation })).ok).toBe(true);
  expect(f.daemon.bus.queueList("claude").some(row => row.state === "needs_review")).toBe(false);
});

for (const compatibility of ["no hello launch", "no launch record", "different daemon record"] as const) test(`#551 compatibility: ${compatibility} retains newest-hello ownership`, async () => {
  const f = await fixture();
  if (compatibility !== "no launch record") writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: compatibility === "different daemon record" ? "previous-daemon" : f.instanceId, launchId: "recorded-launch" }));
  const first = await f.connect(); await until(() => f.daemon.bus.stateOf("claude") === "idle", "first attached");
  const next = await f.connect(compatibility === "no hello launch" ? {} : { launchId: "unrecorded-launch" });
  await until(() => first.closed() !== undefined, "initial newest hello replaces old owner");
  expect(first.closed()).toBe(4000); expect(next.closed()).toBeUndefined();
  await settle(f, next, compatibility);
});

test("#551 two valid sessions: standby retries across 61 seconds of logical backoff never displace a busy owner", async () => {
  const f = await fixture();
  writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: f.instanceId, launchId: "valid-launch" }));
  const older = await f.connect({ launchId: "valid-launch" }); await until(() => f.daemon.bus.stateOf("claude") === "idle", "older attached");
  const newer = await f.connect({ launchId: "valid-launch" });
  await until(() => older.closed() === 4000, "newer session replaces older");
  await f.console_.request({ t: "send", body: "delivery survives standby retries", to: ["claude"] });
  await until(() => newer.messages.some(row => row.t === "deliver"), "newer delivery");
  const delivery = newer.messages.find(row => row.t === "deliver");
  expect((await newer.request({ t: "delivery_receipt", deliveryId: delivery.deliveryId, generation: delivery.generation, state: "accepted" })).ok).toBe(true);
  // Drive the production backoff's due attempts explicitly; no wall-clock sleep or daemon clock mutation.
  // Every attempt deliberately models a missing/stale status.json observation, forcing authoritative admission.
  let elapsedMs = 0;
  for (const delayMs of [1000, 2000, 4000, 8000, 16000, 30000]) {
    elapsedMs += delayMs;
    const retry = await f.connect({ launchId: "valid-launch", standby: true });
    await until(() => retry.closed() !== undefined, `standby refused at logical ${elapsedMs}ms`);
    expect(retry.closed()).toBe(4000); expect(newer.closed()).toBeUndefined();
    expect(f.daemon.bus.queueList("claude").some(row => row.state === "needs_review")).toBe(false);
  }
  expect(elapsedMs).toBeGreaterThanOrEqual(60_000);
  expect((await newer.request({ t: "delivery_complete", deliveryId: delivery.deliveryId, generation: delivery.generation })).ok).toBe(true);
  expect((f.daemon.bus.peers.get("claude") as any).nativeStopped("fixture-session")).toBe(true);
  await settle(f, newer, "still delivered to newer owner");
  newer.socket.close(); await until(() => f.daemon.bus.stateOf("claude") === "offline", "holder leaves");
  const reclaimed = await f.connect({ launchId: "valid-launch", standby: true });
  await settle(f, reclaimed, "standby may claim a genuinely vacant peer");
});

test("#551 standby push retains #205 precedence over a pull-only holder", async () => {
  const f = await fixture(); const plain = await f.connect({ channel: false });
  await until(() => (f.daemon.bus.peers.get("claude") as any)?.pullOnly === true, "pull-only attached");
  const push = await f.connect({ standby: true });
  await until(() => plain.closed() === 4000, "push displaces pull-only");
  await settle(f, push, "push takes priority");
});

test("#551 standby cannot steal a channel during its offline claiming/preface window", async () => {
  let release!: () => void, injecting = false;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
    if (new URL(req.url).pathname === "/api/context/inject") { injecting = true; await gate; }
    return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
  } }); cleanup.push(() => memory.stop(true));
  const f = await fixture(`http://127.0.0.1:${memory.port}`);
  const arriving = await f.connect(); await until(() => injecting, "preface blocked");
  expect(f.daemon.bus.stateOf("claude")).toBe("offline");
  expect((f.daemon.bus.peers.get("claude") as any).claiming).toBe(true);
  const retry = await f.connect({ standby: true }); await until(() => retry.closed() !== undefined, "standby rejected during claim");
  expect(retry.closed()).toBe(4000); expect(arriving.closed()).toBeUndefined();
  release(); await until(() => f.daemon.bus.stateOf("claude") === "idle", "preface completes");
  await settle(f, arriving, "claiming owner retained");
});
