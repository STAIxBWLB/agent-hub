import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { processTable } from "../src/hub/child-process.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(10);
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
};

async function rig(autoStart = false) {
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
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: autoStart, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] },
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

test("an admitted peer stop fences starts, permission changes and recovery preparation until teardown finishes (#278)", async () => {
  const h = await rig(), local = await h.start("local");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stop = local.stop.bind(local);
  local.stop = async reason => { entered(); await gate; return stop(reason); };
  const pending = h.console_.request({ t: "peer_stop", peer: "local" });
  try {
    await started;
    for (const request of [
      { t: "start", peer: "local", args: { model: "m" } },
      { t: "permission", peer: "local", mode: "ask" },
      { t: "peer_stop", peer: "local" },
      { t: "recovery", op: "prepare", expectedInstanceId: h.instanceId, operationId: crypto.randomUUID() },
    ]) {
      const refused = await h.console_.request(request);
      expect(refused.ok).toBe(false); expect(refused.error).toContain("progress");
    }
  } finally { release(); }
  expect((await pending).ok).toBe(true);
  expect(local.state).toBe("offline");
  expect((await h.start("local")).state).toBe("idle");
}, 30_000);
