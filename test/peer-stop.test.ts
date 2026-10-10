import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { endPlannedPeer } from "../src/cli/upgrade-runtime.ts";
import type { Inspection, PlannedProject, RecoveryPeer } from "../src/cli/upgrade.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { processTable } from "../src/hub/child-process.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { Capture } from "../src/memory/capture.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(10);
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
};

async function rig(autoStart = false, emptyPi = false) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-peer-stop-"))), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const keyFile = join(cwd, "gateway-key"); writeFileSync(keyFile, "fixture-key");
  const model = startFakeModelServer({ script: body => {
    const user = body.messages.findLast(message => message.role === "user");
    return String(user?.content).includes("pending-stop") ? { tool_calls: [toolCall("write", { path: "unapproved.txt", content: "not allowed" })] }
      : { content: "queued work answered" };
  } });
  cleanup.push(model.stop);
  const instanceId = crypto.randomUUID();
  const daemon = await startDaemon({ cwd, stateDir, projectId: "stop-fixture", instanceId, permissionTimeoutMs: 10_000,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")],
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: autoStart, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), ...(emptyPi ? ["--empty-session"] : [])] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
      omniroute: { urls: [model.url], access_hosts: [], api_key_file: keyFile },
    } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const asks: any[] = [], answers: Envelope[] = [];
  console_.onPush = message => { if (message.t === "permission") asks.push(message); };
  console_.send({ t: "tail" });
  daemon.bus.tap(event => { if (event.t === "envelope" && ["kimi", "pi", "local"].includes(event.env.from)) answers.push(event.env); });
  const start = async (peer: string, mode = "headless") => {
    expect((await console_.request({ t: "start", peer, args: peer === "local" ? { model: "m" } : peer === "pi" ? { mode } : {} })).ok).toBe(true);
    return daemon.bus.peers.get(peer)!;
  };
  const inspect = async () => (await console_.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId })).recovery;
  return { cwd, stateDir, daemon, console_, asks, answers, model, instanceId, start, inspect };
}

function ownedGroup(peer: unknown): { pid: number; pgid: number } {
  const pid = (peer as { proc?: { pid?: number } }).proc?.pid;
  expect(typeof pid).toBe("number"); expect(pid!).toBeGreaterThan(0);
  const table = processTable(); expect(table).toBeDefined();
  const row = table!.find(row => row.pid === pid); expect(row).toBeDefined();
  return { pid: pid!, pgid: row!.pgid };
}
function groupGone(owner: { pid: number; pgid: number }): void {
  const table = processTable(); expect(table).toBeDefined();
  expect(table!.some(row => row.pid === owner.pid || row.pgid === owner.pgid)).toBe(false);
}
function bridge(pi: PiPeer) {
  const launch = pi.tuiLaunch!;
  const post = (path: string, body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return post;
}

for (const id of ["kimi", "pi", "local"]) test(`peer_stop stops idle ${id}, keeps the daemon alive and permits manual restart (#278)`, async () => {
  const h = await rig(), peer = await h.start(id);
  expect(peer.state).toBe("idle");
  const owner = id === "local" ? undefined : ownedGroup(peer);
  expect(await h.console_.request({ t: "peer_stop", peer: id })).toMatchObject({ ok: true, state: "offline" });
  expect(peer.state).toBe("offline"); if (owner) groupGone(owner);
  expect((await h.console_.request({ t: "status" })).status.peers[id].state).toBe("offline");
  const again = await h.console_.request({ t: "peer_stop", peer: id });
  expect(again.ok).toBe(false); expect(again.error).toContain("offline"); expect(again.error).toContain(`ahub ${id}`);
  const replacement = await h.start(id); expect(replacement.state).toBe("idle");
  if (owner) expect(ownedGroup(replacement).pid).not.toBe(owner.pid);
}, 30_000);

for (const id of ["kimi", "pi", "local"]) test(`peer_stop withdraws ${id}'s pending approval, holds busy work and needs explicit resolution before queued work (#278)`, async () => {
  const h = await rig(), peer = await h.start(id);
  const owner = id === "local" ? undefined : ownedGroup(peer);
  const original = newEnvelope("user", id === "kimi" ? "PERMISSION SLOW pending-stop" : "pending-stop", { to: [id] });
  h.daemon.bus.publish(original);
  let pendingTool: Promise<unknown> | undefined;
  if (id === "pi") {
    await until(() => h.daemon.bus.queueList(id).some(row => row.state === "accepted"), "Pi delivery accepted");
    const pi = peer as PiPeer, post = bridge(pi);
    await post("/event", { type: "agent_start", generation: 1 });
    pendingTool = post("/tool", { name: "write", toolCallId: "pending-stop-write", sessionId: pi.recoveryMetadata().sessionId, generation: 1, args: { path: "unapproved.txt", content: "not allowed" } }).then(response => response.json()).catch(() => undefined);
  }
  await until(() => h.asks.length === 1, "actual approval registered");
  expect((await h.inspect()).pendingApprovals).toBe(1);
  expect(peer.state).toBe("busy");
  expect(await h.console_.request({ t: "peer_stop", peer: id })).toMatchObject({ ok: true, state: "offline" });
  await pendingTool;
  if (owner) groupGone(owner);
  expect((await h.inspect()).pendingApprovals).toBe(0);
  expect((await h.console_.request({ t: "permit", id: h.asks[0]!.id, option: "always", surface: "console" })).ok).toBe(false);
  const held = h.daemon.bus.queueList(id).filter(row => row.originals.some(env => env.id === original.id));
  expect(held).toHaveLength(1); expect(held[0]!.state).toBe("needs_review");
  expect(held[0]!.reason).toContain(`requested stop: ahub stop ${id}`);
  expect(h.answers).toHaveLength(0);
  expect(existsSync(join(h.cwd, "unapproved.txt"))).toBe(false);
  expect(readFileSync(join(h.stateDir, "hub.log"), "utf8")).not.toContain("not allowed");
  const queued = newEnvelope("user", "queued after requested stop", { to: [id] }); h.daemon.bus.publish(queued);
  const replacement = await h.start(id);
  expect(replacement.state).toBe("idle");
  expect(h.daemon.bus.queueSummary(id).heldBy).toBe(held[0]!.id);
  expect(h.daemon.bus.queueIds(id)).toContain(queued.id);
  expect(h.answers).toHaveLength(0);
  const current = h.daemon.bus.queueShow(held[0]!.id)!;
  expect((await h.console_.request({ t: "queue", op: "resolve", id: current.id, revision: current.revision, action: "completed", reason: "person inspected the stopped turn" })).ok).toBe(true);
  if (id === "pi") {
    await until(() => h.daemon.bus.queueList(id).some(row => row.state === "accepted" && row.originals.some(env => env.id === queued.id)), "restarted Pi accepts queued work");
    const post = bridge(replacement as PiPeer);
    await post("/event", { type: "agent_start", generation: 1 });
    await post("/event", { type: "agent_end", generation: 1, text: "queued work answered" });
    await post("/event", { type: "agent_settled", generation: 1 });
  }
  await until(() => h.answers.length === 1 && replacement.state === "idle", "queued work completed after explicit resolution");
  expect(h.answers[0]!.body).toContain(id === "kimi" ? "queued after requested stop" : "queued work answered");
  expect(h.daemon.bus.queueList(id).find(row => row.originals.some(env => env.id === queued.id))!.state).toBe("completed");
  await Bun.sleep(80); expect(h.answers).toHaveLength(1); expect(h.asks).toHaveLength(1);
}, 30_000);

test("peer_stop refuses native terminals, unknown peers and tools-role callers without stopping an owner (#278)", async () => {
  const h = await rig(), local = await h.start("local");
  for (const id of ["claude", "codex"]) {
    const reply = await h.console_.request({ t: "peer_stop", peer: id }); expect(reply.ok).toBe(false); expect(reply.error).toContain("terminal");
  }
  const missing = await h.console_.request({ t: "peer_stop", peer: "unknown-peer" }); expect(missing.ok).toBe(false); expect(missing.error).toContain("ahub status");
  const tui = await h.start("pi", "tui");
  const refused = await h.console_.request({ t: "peer_stop", peer: "pi" }); expect(refused.ok).toBe(false); expect(refused.error).toContain("TUI terminal");
  expect(h.daemon.bus.peers.get("pi")).toBe(tui);
  const tools = await ControlClient.connect(h.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => tools.close());
  const denied = await tools.request({ t: "peer_stop", peer: "local" }); expect(denied.ok).toBe(false); expect(denied.error).toContain("console");
  expect(local.state).toBe("idle");
}, 30_000);

test("a prepared recovery refuses peer_stop and aborting it restores the stop path (#278)", async () => {
  const h = await rig(), local = await h.start("local"), operationId = crypto.randomUUID();
  expect((await h.console_.request({ t: "recovery", op: "prepare", expectedInstanceId: h.instanceId, operationId })).ok).toBe(true);
  const denied = await h.console_.request({ t: "peer_stop", peer: "local" }); expect(denied.ok).toBe(false); expect(denied.error).toContain("finish the operation");
  expect(local.state).toBe("idle");
  expect((await h.console_.request({ t: "recovery", op: "abort", expectedInstanceId: h.instanceId, operationId })).ok).toBe(true);
  expect((await h.console_.request({ t: "peer_stop", peer: "local" })).ok).toBe(true);
}, 30_000);

test("Pi auto_start never restarts a requested idle stop; manual start takes queued work (#278)", async () => {
  const h = await rig(true);
  await until(() => h.daemon.bus.stateOf("pi") === "idle", "Pi automatic initial start");
  const pi = h.daemon.bus.peers.get("pi") as PiPeer, owner = ownedGroup(pi);
  expect((await h.console_.request({ t: "peer_stop", peer: "pi" })).ok).toBe(true); groupGone(owner);
  await Bun.sleep(250);
  expect(h.daemon.bus.peers.get("pi")).toBe(pi); expect(pi.state).toBe("offline");
  expect(readFileSync(join(h.stateDir, "hub.log"), "utf8")).toContain("requested stop");
  const queued = newEnvelope("user", "queued manual Pi restart", { to: ["pi"] }); h.daemon.bus.publish(queued);
  const replacement = await h.start("pi");
  await until(() => replacement.state === "busy", "manual Pi restart receives queued work");
  const post = bridge(replacement as PiPeer);
  await post("/event", { type: "agent_start", generation: 1 });
  await post("/event", { type: "agent_end", generation: 1, text: "manual restart answered" });
  await post("/event", { type: "agent_settled", generation: 1 });
  await until(() => h.answers.length === 1 && replacement.state === "idle", "manual restart completes queued work");
  expect(h.answers[0]!.body).toBe("manual restart answered");
  expect(h.daemon.bus.queueList("pi").find(row => row.originals.some(env => env.id === queued.id))!.state).toBe("completed");
}, 30_000);

for (const id of ["local", "kimi"]) test(`an admitted ${id} stop fences delivery, starts, permission and recovery until teardown finishes (#278)`, async () => {
  const h = await rig(), local = await h.start(id);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stop = local.stop.bind(local);
  local.stop = async reason => { entered(); await gate; return stop(reason); };
  const pending = h.console_.request({ t: "peer_stop", peer: id });
  try {
    await started;
    const queued = newEnvelope("user", "work arriving during teardown", { to: [id] });
    h.daemon.bus.publish(queued);
    expect((await h.console_.request({ t: "resume", peer: id })).ok).toBe(true);
    await Bun.sleep(30);
    expect(h.daemon.bus.queueList(id).find(row => row.originals.some(env => env.id === queued.id))?.state).toBe("queued");
    expect(h.answers).toHaveLength(0);
    for (const request of [
      { t: "start", peer: id, args: { model: "m" } },
      { t: "permission", peer: id, mode: "ask" },
      { t: "peer_stop", peer: id },
      { t: "recovery", op: "prepare", expectedInstanceId: h.instanceId, operationId: crypto.randomUUID() },
    ]) {
      const refused = await h.console_.request(request);
      expect(refused.ok).toBe(false); expect(refused.error).toContain("progress");
    }
  } finally { release(); }
  expect((await pending).ok).toBe(true);
  expect(local.state).toBe("offline");
  await h.start(id);
  await until(() => h.answers.length === 1, "retained work runs on manual restart");
  expect(h.daemon.bus.queueList(id).every(row => row.state !== "needs_review")).toBe(true);
}, 30_000);

test("a requested Pi stop holds its delivery before awaiting tools and ignores late native settlement (#278)", async () => {
  const h = await rig(), pi = await h.start("pi") as PiPeer, owner = ownedGroup(pi);
  const internals = pi as any;
  let entered!: () => void, release!: (result: string) => void;
  const enteredTool = new Promise<void>(resolve => { entered = resolve; });
  const toolGate = new Promise<string>(resolve => { release = resolve; });
  internals.opts.executeTool = async () => { entered(); return toolGate; }; // intentionally ignores cancellation until released
  const receipts: { state: string; reason?: string }[] = [];
  const record = pi.onDelivery;
  pi.onDelivery = receipt => { receipts.push(receipt); record?.(receipt); };
  const original = newEnvelope("user", "held managed tool", { to: ["pi"] });
  h.daemon.bus.publish(original);
  await until(() => h.daemon.bus.queueList("pi").some(row => row.state === "accepted"), "Pi delivery accepted");
  const post = bridge(pi);
  await post("/event", { type: "agent_start", generation: 1 });
  const toolRequest = post("/tool", { name: "write", toolCallId: "held-stop-tool", sessionId: pi.recoveryMetadata().sessionId, generation: 1, args: { path: "never-written.txt", content: "not run" } }).then(response => response.json()).catch(() => undefined);
  let stopRequest: Promise<any> | undefined;
  try {
    await enteredTool;
    stopRequest = h.console_.request({ t: "peer_stop", peer: "pi" });
    await until(() => internals.stopping === true, "requested Pi stop begins");
    const held = h.daemon.bus.queueList("pi").find(row => row.originals.some(env => env.id === original.id))!;
    expect(held.state).toBe("needs_review");
    expect(held.reason).toContain("requested stop: ahub stop pi");
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect((await post("/event", { type: "agent_end", generation: 1, text: "late native answer" })).status).toBe(200);
    expect((await post("/event", { type: "agent_settled", generation: 1 })).status).toBe(200);
    expect(h.answers).toHaveLength(0);
    expect(h.daemon.bus.queueShow(held.id)!.state).toBe("needs_review");
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    release("tool ended after cancellation");
    await toolRequest;
    expect(await stopRequest).toMatchObject({ ok: true, state: "offline" });
    groupGone(owner);
    // Buffered native callbacks can outlive the closed bridge; the adapter must ignore them too.
    internals.handleBridgeEvent({ type: "agent_start", generation: 2 });
    internals.handleBridgeEvent({ type: "agent_end", generation: 1, text: "after-stop answer" });
    internals.handleBridgeEvent({ type: "agent_settled", generation: 1 });
    expect(pi.state).toBe("offline"); expect(h.answers).toHaveLength(0);
    expect(h.daemon.bus.queueShow(held.id)!.state).toBe("needs_review");
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
  } finally {
    release("test cleanup after cancellation");
    await toolRequest;
    await stopRequest;
  }
}, 30_000);


test("upgrade endPlannedPeer ends a headless owner through the real daemon peer_stop contract (#278 AC4)", async () => {
  const h = await rig(), kimi = await h.start("kimi"), owner = ownedGroup(kimi);
  const project = { id: "stop-fixture", root: h.cwd, stateDir: h.stateDir, basePort: 0, instanceId: h.instanceId, pid: process.pid };
  // Scope inspection to this fixture's real control transport rather than the user's global registry.
  const inspect = async (): Promise<Inspection> => {
    const status = (await h.console_.request({ t: "status" })).status;
    const current = await h.inspect();
    expect(status.pid).toBe(process.pid); expect(status.instanceId).toBe(h.instanceId);
    return { state: "running", instanceId: status.instanceId, version: status.version, protocol: PROTOCOL,
      peers: Object.values(current.peers) as RecoveryPeer[], blockers: current.blockers };
  };
  const source = await inspect(), peer = source.peers.find(peer => peer.id === "kimi")!;
  expect(peer.state).toBe("idle");
  const planned: PlannedProject = { project, source, terminals: [], blockers: [] };
  expect(await endPlannedPeer(planned, peer, { inspect, lock: () => undefined })).toBe("stop-fixture/kimi: stopped");
  expect(kimi.state).toBe("offline"); groupGone(owner);
  expect((await inspect()).peers.find(peer => peer.id === "kimi")!.state).toBe("offline");
  const stillRunning = (await h.console_.request({ t: "status" })).status;
  expect(stillRunning.pid).toBe(process.pid);
}, 30_000);

test("a stopped ACP owner's buffered permission callback cannot recreate an approval hold (#278)", async () => {
  const h = await rig(), kimi = await h.start("kimi"), owner = ownedGroup(kimi);
  expect((await h.console_.request({ t: "peer_stop", peer: "kimi" })).ok).toBe(true);
  groupGone(owner);
  (kimi as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 8765, method: "session/request_permission", params: {
    sessionId: kimi.recoveryMetadata!().sessionId, toolCall: { toolCallId: "buffered-after-stop", title: "write after stop" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
  } }));
  expect((await h.inspect()).pendingApprovals).toBe(0);
  expect(h.asks).toHaveLength(0); expect(kimi.state).toBe("offline");
}, 30_000);


test("idle local stop retains work arriving while its actual memory teardown awaits (#278)", async () => {
  const h = await rig(), local = await h.start("local");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Exercise LocalPeer.stop's real generation increment and network-bound capture await.
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/sessions/session-end") { entered(); await gate; }
    return Response.json({ ok: true });
  } });
  cleanup.push(() => worker.stop(true));
  const capture = new Capture(new MemoryClient(`http://127.0.0.1:${worker.port}`, 2000), { project: "stop-fixture", cwd: h.cwd });
  capture.init("stop-fixture", "fixture native memory session");
  (local as any).opts.capture = capture;
  const stopping = h.console_.request({ t: "peer_stop", peer: "local" });
  const env = newEnvelope("user", "queued during memory teardown", { to: ["local"] });
  try {
    await started;
    expect(local.state).toBe("offline");
    h.daemon.bus.publish(env);
    expect((await h.console_.request({ t: "resume", peer: "local" })).ok).toBe(true);
    await Bun.sleep(30);
    expect(h.model.requests).toHaveLength(0);
    expect(h.answers).toHaveLength(0);
    const row = h.daemon.bus.queueList("local").find(row => row.originals.some(original => original.id === env.id));
    expect(row?.state).toBe("queued");
  } finally { release(); }
  expect(await stopping).toMatchObject({ ok: true, state: "offline" });
  expect(h.model.requests).toHaveLength(0);
  await h.start("local");
  await until(() => h.answers.length === 1, "manual restart delivers retained work once");
  expect(h.model.requests).toHaveLength(1);
  expect(h.daemon.bus.queueList("local").find(row => row.originals.some(original => original.id === env.id))?.state).toBe("completed");
}, 30_000);


test("requested stop of an empty idle Pi keeps live empty-session proof for manual restart (#278)", async () => {
  const h = await rig(false, true), pi = await h.start("pi") as PiPeer;
  const source = pi.recoveryMetadata();
  expect(typeof source.sessionId).toBe("string");
  expect(source.sessionFile === undefined || !existsSync(source.sessionFile as string)).toBe(true);
  expect(await h.console_.request({ t: "peer_stop", peer: "pi" })).toMatchObject({ ok: true, state: "offline" });
  const queued = newEnvelope("user", "first turn after requested stop", { to: ["pi"] });
  h.daemon.bus.publish(queued);
  const replacement = await h.start("pi") as PiPeer;
  expect(replacement.recoveryMetadata().sessionId).toBe(source.sessionId);
  expect(h.daemon.bus.queueList("pi").some(row => row.state === "needs_review")).toBe(false);
  await until(() => h.daemon.bus.queueList("pi").some(row => row.state === "accepted"), "empty session resumes queued turn");
  const post = bridge(replacement);
  await post("/event", { type: "agent_start", generation: 1 });
  await post("/event", { type: "agent_end", generation: 1, text: "resumed empty session" });
  await post("/event", { type: "agent_settled", generation: 1 });
  await until(() => h.answers.length === 1, "resumed Pi answers once");
}, 30_000);


test("a stopped Pi whose first accepted prompt is unpersisted refuses empty-session recreation (#278)", async () => {
  const h = await rig(false, true);
  await h.start("pi");
  const env = newEnvelope("user", "accepted before persistence", { to: ["pi"] });
  h.daemon.bus.publish(env);
  await until(() => h.daemon.bus.queueList("pi").some(row => row.state === "accepted"), "first prompt accepted");
  expect(await h.console_.request({ t: "peer_stop", peer: "pi" })).toMatchObject({ ok: true, state: "offline" });
  const start = await h.console_.request({ t: "start", peer: "pi", args: { mode: "headless" } });
  expect(start.ok).toBe(false);
  expect(start.error).toContain("no verified persisted resume state");
  expect(h.daemon.bus.queueList("pi").find(row => row.originals.some(original => original.id === env.id))).toMatchObject({ state: "needs_review", reason: "requested stop: ahub stop pi" });
  expect(h.answers).toHaveLength(0);
}, 30_000);
