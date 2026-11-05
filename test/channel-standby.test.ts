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

test("a retained standby stays fenced until a person hands it over; the selected socket then owns the peer", async () => {
  const f = await fixture();
  const owner = await f.connect({ retainStandby: true, clientPid: 101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true, clientPid: 202 });
  const welcome = standby.messages.find(row => row.t === "welcome");
  expect(welcome?.standby).toBe(true);
  expect(typeof welcome?.standbyId).toBe("string");
  expect(owner.closed()).toBeUndefined();
  const status = await f.console_.request({ t: "status" });
  expect(status.status.peers.claude.standbySessions).toEqual([
    { id: welcome.standbyId, pid: 202, since: expect.any(Number) },
  ]);
  const blocked = await standby.request({ t: "task", op: "hub_task_list", args: {} });
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toContain("standing by");
  const agentAttempt = await owner.request({ t: "peer_takeover", peer: "claude", standbyId: welcome.standbyId });
  expect(agentAttempt.ok).toBe(false);
  expect(agentAttempt.error).toContain("person-only");

  const wrong = await f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: "not-the-live-id" });
  expect(wrong.ok).toBe(false);
  expect(owner.closed()).toBeUndefined();
  const requested = await f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: welcome.standbyId });
  expect(requested).toMatchObject({ ok: true, outcome: "requested", standbyId: welcome.standbyId });
  await until(() => owner.closed() !== undefined, "old owner detached");
  expect(owner.closed()).toBe(4405);
  await until(() => standby.messages.some(row => row.t === "peer_attached"), "selected standby attached");
  const admitted = await standby.request({ t: "task", op: "hub_task_list", args: {} });
  expect(admitted.ok).toBe(true);
  expect(f.daemon.bus.stateOf("claude")).toBe("idle");
});

test("takeover keeps an accepted old-owner delivery uncertain and never replays it to the standby", async () => {
  const f = await fixture();
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true });
  const standbyId = standby.messages.find(row => row.t === "welcome")?.standbyId;
  const body = "accepted work stays uncertain across owner takeover";
  expect((await f.console_.request({ t: "send", body, to: ["claude"] })).ok).toBe(true);
  await until(() => owner.messages.some(row => row.t === "deliver" && row.envs?.some((env: any) => env.body === body)), "delivery reached old owner");
  const delivery = owner.messages.find(row => row.t === "deliver" && row.envs?.some((env: any) => env.body === body));
  const oldGeneration = delivery.generation;
  expect((await owner.request({ t: "delivery_receipt", deliveryId: delivery.deliveryId, generation: oldGeneration, state: "accepted" })).ok).toBe(true);
  expect(f.daemon.bus.queueShow(delivery.deliveryId)?.state).toBe("accepted");

  expect((await f.console_.request({ t: "peer_takeover", peer: "claude", standbyId })).ok).toBe(true);
  await until(() => standby.messages.some(row => row.t === "peer_attached"), "standby attached");
  const held = f.daemon.bus.queueShow(delivery.deliveryId);
  expect(held).toMatchObject({ state: "needs_review", reason: "peer disconnected before delivery settlement" });
  expect(held?.state).not.toBe("completed");
  expect(standby.messages.some(row => row.t === "deliver" && row.envs?.some((env: any) => env.body === body))).toBe(false);

  const lateReceipt = await standby.request({ t: "delivery_receipt", deliveryId: delivery.deliveryId, generation: oldGeneration, state: "accepted" });
  const lateCompletion = await standby.request({ t: "delivery_complete", deliveryId: delivery.deliveryId, generation: oldGeneration });
  expect(lateReceipt.ok).toBe(false);
  expect(lateCompletion.ok).toBe(false);
  expect(f.daemon.bus.queueShow(delivery.deliveryId)?.state).toBe("needs_review");
  expect(f.daemon.bus.queueList("claude", true).some(row => row.id === delivery.deliveryId && row.state === "completed")).toBe(false);
});

test("a naturally departing owner promotes the oldest live retained standby", async () => {
  const f = await fixture();
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const first = await f.connect({ retainStandby: true, clientPid: 301 });
  const second = await f.connect({ retainStandby: true, clientPid: 302 });
  const firstId = first.messages.find(row => row.t === "welcome")?.standbyId;
  const secondId = second.messages.find(row => row.t === "welcome")?.standbyId;
  expect(typeof firstId).toBe("string");
  expect(typeof secondId).toBe("string");
  owner.socket.close();
  await until(() => first.messages.some(row => row.t === "peer_attached"), "oldest standby auto-attached");
  expect(second.messages.some(row => row.t === "peer_attached")).toBe(false);
  const status = await f.console_.request({ t: "status" });
  expect(status.status.peers.claude.standbySessions.map((row: { id: string }) => row.id)).toEqual([secondId]);
});

test("a disconnected standby is removed and an exact stale id cannot detach its owner", async () => {
  const f = await fixture();
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true });
  const id = standby.messages.find(row => row.t === "welcome")?.standbyId;
  standby.socket.close();
  await until(() => standby.closed() !== undefined, "standby disconnected");
  const status = await f.console_.request({ t: "status" });
  expect(status.status.peers.claude.standbySessions).toBeUndefined();
  const result = await f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: id });
  expect(result.ok).toBe(false);
  expect(owner.closed()).toBeUndefined();
  expect(f.daemon.bus.stateOf("claude")).toBe("idle");
});

test("a standby whose managed Claude launch became stale cannot take over the current owner", async () => {
  const f = await fixture();
  writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: f.instanceId, launchId: "recorded-launch" }));
  const owner = await f.connect({ retainStandby: true, launchId: "recorded-launch" });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true, launchId: "recorded-launch" });
  const id = standby.messages.find(row => row.t === "welcome")?.standbyId;
  writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: f.instanceId, launchId: "new-launch" }));
  const result = await f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: id });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("standby");
  expect(owner.closed()).toBeUndefined();
  expect(standby.closed()).toBeUndefined();
  expect(f.daemon.bus.stateOf("claude")).toBe("idle");
});

test("takeover skips the oldest stale launch and promotes the next eligible live standby", async () => {
  const f = await fixture();
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const stale = await f.connect({ retainStandby: true, launchId: "stale-launch" });
  const eligible = await f.connect({ retainStandby: true, launchId: "current-launch" });
  const staleId = stale.messages.find(row => row.t === "welcome")?.standbyId;
  const eligibleId = eligible.messages.find(row => row.t === "welcome")?.standbyId;
  writeFileSync(join(f.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: f.instanceId, launchId: "current-launch" }));

  const result = await f.console_.request({ t: "peer_takeover", peer: "claude" });
  expect(result).toMatchObject({ ok: true, outcome: "requested", standbyId: eligibleId });
  await until(() => eligible.messages.some(row => row.t === "peer_attached"), "eligible standby attached");
  expect(owner.closed()).toBe(4405);
  expect(stale.messages.some(row => row.t === "peer_attached")).toBe(false);
  const status = await f.console_.request({ t: "status" });
  expect(status.status.peers.claude.standbySessions.map((row: { id: string }) => row.id)).toEqual([staleId]);
});

test("a selected standby that disconnects during its preface cannot attach later", async () => {
  let block = false, releaseCurrent!: () => void, markEntered!: () => void;
  let gate = Promise.resolve(), entered = Promise.resolve();
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
    if (new URL(req.url).pathname === "/api/context/inject" && block) { markEntered(); await gate; }
    return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
  } }); cleanup.push(() => memory.stop(true));
  const f = await fixture(`http://127.0.0.1:${memory.port}`);
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true });
  const id = standby.messages.find(row => row.t === "welcome")?.standbyId;
  gate = new Promise<void>(resolve => { releaseCurrent = resolve; });
  entered = new Promise<void>(resolve => { markEntered = resolve; });
  block = true;
  const handover = f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: id });
  await entered;
  standby.socket.close();
  await until(() => standby.closed() !== undefined, "selected standby disconnected");
  releaseCurrent();
  await handover;
  await until(() => f.daemon.bus.stateOf("claude") === "offline", "no stale standby attached");
  expect(standby.messages.some(row => row.t === "peer_attached")).toBe(false);
  expect(f.daemon.bus.peers.get("claude")?.ownsSocket?.(standby.socket)).toBe(false);
  expect(owner.closed()).toBe(4405);
});

test("a newer claim fences a selected standby's asynchronous preface", async () => {
  let block = false, releaseCurrent!: () => void, markEntered!: () => void;
  let gate = Promise.resolve(), entered = Promise.resolve();
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
    if (new URL(req.url).pathname === "/api/context/inject" && block) { markEntered(); await gate; }
    return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
  } }); cleanup.push(() => memory.stop(true));
  const f = await fixture(`http://127.0.0.1:${memory.port}`);
  const owner = await f.connect({ retainStandby: true });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true });
  const id = standby.messages.find(row => row.t === "welcome")?.standbyId;
  gate = new Promise<void>(resolve => { releaseCurrent = resolve; });
  entered = new Promise<void>(resolve => { markEntered = resolve; });
  block = true;
  const handover = f.console_.request({ t: "peer_takeover", peer: "claude", standbyId: id });
  await entered;
  const newer = await f.connect();
  await until(() => (f.daemon.bus.peers.get("claude") as any).claiming, "newer claim recorded");
  releaseCurrent();
  await handover;
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "newer claim attached");
  expect(standby.messages.some(row => row.t === "peer_attached")).toBe(false);
  expect(standby.closed()).toBe(4000);
  expect(newer.closed()).toBeUndefined();
  expect(f.daemon.bus.peers.get("claude")?.ownsSocket?.(standby.socket)).toBe(false);
  await settle(f, newer, "newer claim kept after stale preface");
  expect(owner.closed()).toBe(4405);
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
