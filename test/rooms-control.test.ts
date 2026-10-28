import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { createJoin } from "../src/rooms/wire.ts";
import { decodeBase64url, encodeBase64url, generateHubIdentity } from "../src/rooms/crypto.ts";
import { RemotePeer } from "../src/rooms/remote-peer.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class HeldLocalPeer extends BasePeer {
  effects = 0;
  constructor() { super("codex"); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { this.effects++; }
}
async function mutation(client: ControlClient, action: string, input: Record<string, unknown>) {
  const preview = await client.request({ t: "room", op: "preview", action, input }, 5000);
  expect(preview.ok).toBe(true);
  return client.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member }, 5000);
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-control-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const overrides: Record<string, string | undefined> = {
    HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub-home"), AMEM_HOME: join(root, "amem-home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"), KIMI_CODE_HOME: join(root, "kimi"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    AGENTHUB_PEER_ID: undefined, AGENTHUB_PROJECT_DIR: undefined, AGENTHUB_STATE_DIR: undefined, AGENTHUB_INSTANCE_ID: undefined, AGENTHUB_LAUNCH_ID: undefined, AGENTHUB_DELIVERY_ONLY: undefined,
    CODEX_THREAD_ID: undefined, CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined,
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  cleanups.push(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME"]) mkdirSync(overrides[key]!, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  const roles = Object.fromEntries(Object.entries(DEFAULT_CONFIG.roles).map(([id, values]) => [id, id === "codex" ? ["implementer", "conductor"] : values.filter(role => role !== "conductor")]));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roles, rooms: { work: { expose: ["codex"] } } }));
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, agentDrift: false, shellDefaultBranchProbe: async () => "main",
    config: { ...DEFAULT_CONFIG, roles, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const local = new HeldLocalPeer(); daemon.bus.add(local); await local.start(); daemon.bus.pause(local.id);
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => person.close());
  expect((await mutation(person, "create", { name: "work", broker: "ws://127.0.0.1:1/", label: "owner" })).ok).toBe(true);
  const token = await mutation(person, "invite", { name: "work" }); expect(token.ok).toBe(true);
  const guest = await generateHubIdentity();
  const request = await createJoin({ invite: decodeBase64url(token.artifact), identity: guest, label: "guest", exposedPeers: ["claude", "codex"] });
  const enrolled = await mutation(person, "invite", { name: "work", request: encodeBase64url(request) }); expect(enrolled.ok).toBe(true);
  expect(daemon.bus.peers.get("codex@guest")).toBeInstanceOf(RemotePeer);
  expect(daemon.bus.peers.get("claude@guest")).toBeInstanceOf(RemotePeer);
  return { root, stateDir, daemon, local, person };
}

test("full control send refuses atomic two-remote fanout and keeps one-remote local fanout private in observers", async () => {
  const f = await fixture(), canary = "ROOM_CONTROL_PUBLIC_CANARY";
  const denied = await f.person.request({ t: "send", to: ["codex@guest", "claude@guest", "codex"], body: canary }, 5000);
  expect(denied.ok).toBe(false); expect(denied.error).toContain("codex@guest"); expect(denied.error).toContain("claude@guest"); expect(denied.error).toContain("separately");
  for (const peer of ["codex@guest", "claude@guest", "codex"]) expect(f.daemon.bus.queued(peer)).toBe(0);
  expect(f.local.effects).toBe(0);
  const accepted = await f.person.request({ t: "send", to: ["codex@guest", "codex"], body: canary }, 5000);
  expect(accepted).toMatchObject({ ok: true }); expect(accepted.targets).toEqual(["codex@guest", "codex"]);
  expect(f.daemon.bus.queued("codex@guest")).toBe(1); expect(f.daemon.bus.queued("codex")).toBe(1); expect(f.daemon.bus.queued("claude@guest")).toBe(0);
  expect(f.daemon.bus.pendingEnvelopes("codex")[0]?.body).toBe(canary); expect(f.local.effects).toBe(0);
  const status = (await f.person.request({ t: "status" }, 5000)).status;
  for (const peer of ["codex@guest", "claude@guest"]) { expect(status.roleInfo).not.toHaveProperty(peer); expect(status.peers).not.toHaveProperty(peer); }
  const snapshot = await f.person.request({ t: "ui_snapshot", after: 0 }, 5000);
  expect(Array.isArray(snapshot.events)).toBe(true); expect(JSON.stringify(snapshot.events)).not.toContain(canary);
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain(canary);
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanups.push(() => tools.close());
  const queued = f.daemon.bus.queueList("codex@guest")[0]!;
  const rejected = await tools.request({ t: "queue", op: "resolve", id: queued.id, revision: queued.revision, action: "discard", reason: "a remote disposition needs the person" }, 5000);
  expect(rejected.ok).toBe(false); expect(rejected.error).toContain("person-only");
  expect(f.daemon.bus.queueShow(queued.id)?.state).toBe("queued");
});

test("full daemon remote identities have no control or native lifecycle authority while local controls remain usable", async () => {
  const f = await fixture(), id = "codex@guest", remote = f.daemon.bus.peers.get(id) as RemotePeer;
  const started = await f.person.request({ t: "start", peer: id }, 5000);
  expect(started.ok).toBe(false); expect(started.error).toContain("remote peers have no local runtime or control authority"); expect(f.daemon.bus.peers.get(id)).toBe(remote);
  for (const role of ["tools", "peer", "console"] as const) await expect(ControlClient.connect(f.stateDir, { role, peer: id })).rejects.toMatchObject({ code: 4403 });
  expect(await f.person.request({ t: "room", op: "unknown" }, 5000)).toMatchObject({ ok: false });
  expect(await f.person.request({ t: "rooms-control-unknown-rid" }, 5000)).toMatchObject({ ok: false });
  const ownerTurnTasks = Tasks.prototype.ownerTurnTasks, called: string[] = [];
  Tasks.prototype.ownerTurnTasks = function(peer) { called.push(peer); return ownerTurnTasks.call(this, peer); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { untap(); reject(new Error("remote busy state barrier timed out")); }, 5000);
      const untap = f.daemon.bus.tap(event => { if (event.t === "state" && event.peer === id && event.state === "busy") { clearTimeout(timer); untap(); resolve(); } });
      try { remote.presence("busy", true); } catch (error) { clearTimeout(timer); untap(); reject(error); }
    });
  } finally { Tasks.prototype.ownerTurnTasks = ownerTurnTasks; }
  expect(called).not.toContain(id); expect(f.local.effects).toBe(0);
  const events = readFileSync(join(f.stateDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(events.some(row => row.type === "turn_start" && row.peer === id)).toBe(false);
  const status = await f.person.request({ t: "status" }, 5000); expect(status.status.roleInfo).not.toHaveProperty(id);
  expect(await f.person.request({ t: "room", op: "list" }, 5000)).toMatchObject({ ok: true });
});
