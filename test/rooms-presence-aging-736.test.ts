import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import type { RoomLink } from "../src/rooms/link.ts";
import type { RoomStore } from "../src/rooms/store.ts";
import { verifyPublicFrame } from "../src/rooms/wire.ts";

class LocalPeer extends BasePeer {
  constructor() { super("codex"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(): Promise<void> { this.setState("busy"); this.setState("idle"); }
}

function signals() {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const wait = (check: () => boolean, label: string): Promise<void> => new Promise((resolve, reject) => {
    const inspect = () => { if (check()) { clearTimeout(timer); listeners.delete(inspect); resolve(); } };
    const timer = setTimeout(() => { listeners.delete(inspect); reject(new Error(`room liveness barrier timed out: ${label}`)); }, 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}

type Signal = ReturnType<typeof signals>;
interface Side {
  cwd: string; bus: Bus; commands: RoomCommands; chat: RoomChat; peer: LocalPeer;
  store?: RoomStore; link?: RoomLink; setNow(value: number): void;
  close(): Promise<void>;
}
async function side(root: string, label: string, signal: Signal) {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: ["codex"] } } }));
  const stateDir = join(cwd, "state"), journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  const roster = new Set(["codex"]);
  let now = 1_000_000, chat: RoomChat | undefined;
  const bus = new Bus({ journal, batchMs: 0, queueCap: 200, rostered: id => roster.has(id), remotePending: room => chat?.pendingIds(room) ?? [] });
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  chat = new RoomChat({ bus, cwd, now: () => now, refreshMs: 10, routing: () => routing, piiPaths: () => [],
    senderPrivate: () => false, taskPrivate: () => false, modelScreenOn: () => false,
    screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); signal.notify(); },
    changed: signal.notify });
  const result: Side = { cwd, bus, chat, peer,
    setNow(value) { now = value; },
    commands: undefined as unknown as RoomCommands,
    async close() { await this.commands.stop(); await this.peer.stop(); bus.closeJournal(); },
  };
  const bind = chat.bind.bind(chat);
  chat.bind = (store, name, link) => { if (name === "work") { result.store = store; result.link = link; } bind(store, name, link); };
  const commands = new RoomCommands({ cwd, stateDir, chat, presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  result.commands = commands;
  bus.onQueues = () => { chat!.queueChanged(); signal.notify(); };
  return result;
}

type Mesh = { root: string; broker: BrokerRuntime; a: Side; b: Side; signal: Signal; brokerEvents: { event: string; member?: string }[]; verifiedSenders: string[]; readyKeys: string[][] };
const meshes: Mesh[] = [];
afterEach(async () => {
  for (const fixture of meshes.splice(0).reverse()) {
    await fixture.a.close(); await fixture.b.close(); await fixture.broker.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
async function roomCommand(side: Side, action: string, input: unknown) {
  return (await side.commands.preview(action, input, () => true)).commit();
}
async function mesh(options: { legacy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-presence-aging-736-")), signal = signals();
  const brokerEvents: Mesh["brokerEvents"] = [], verifiedSenders: string[] = [], readyKeys: string[][] = [];
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0 }, {
    log: (event, ids) => { brokerEvents.push({ event, ...(ids.member ? { member: ids.member } : {}) }); signal.notify(); },
    verifyFrame: async input => { const proof = await verifyPublicFrame(input); verifiedSenders.push(proof.sender); signal.notify(); return proof; },
  });
  const NativeWebSocket = globalThis.WebSocket;
  if (options.legacy) globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, socketOptions?: Bun.WebSocketOptions | string | string[]) {
      if (socketOptions && typeof socketOptions === "object" && !Array.isArray(socketOptions)) {
        const headers = Object.fromEntries(Object.entries(socketOptions.headers ?? {}).filter(([name]) => name.toLowerCase() !== "x-agent-hub-ephemeral"));
        super(url, { ...socketOptions, headers });
      } else super(url, socketOptions);
      this.addEventListener("message", event => {
        try {
          const message = JSON.parse(new TextDecoder().decode(event.data)) as Record<string, unknown>;
          if (message.type === "ready") readyKeys.push(Object.keys(message).sort());
        } catch { /* RoomLink handles non-ready transport messages. */ }
      });
    }
  };
  try {
    const a = await side(root, "alpha", signal), b = await side(root, "beta", signal);
    const fixture = { root, broker, a, b, signal, brokerEvents, verifiedSenders, readyKeys }; meshes.push(fixture);
    await roomCommand(a, "create", { name: "work", broker: broker.publicUrl, label: "alpha" });
    await roomCommand(a, "expose", { name: "work", peers: ["codex"] });
    const invite = await roomCommand(a, "invite", { name: "work" });
    const request = await roomCommand(b, "join", { name: "work", token: invite.artifact, label: "beta" });
    const roster = await roomCommand(a, "invite", { name: "work", request: request.artifact });
    await roomCommand(b, "join", { name: "work", roster: roster.artifact });
    await signal.wait(() => a.bus.stateOf("codex@beta") === "idle" && b.bus.stateOf("codex@alpha") === "idle", "signed presence from both members");
    return fixture;
  } finally { if (options.legacy) globalThis.WebSocket = NativeWebSocket; }
}

test("member presence ages to advisory unknown without blocking durable transport", async () => {
  const f = await mesh();
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  expect(f.a.bus.stateOf("user@beta")).toBe("idle");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("idle");

  const betaMember = f.b.store!.identity.public.fingerprint;
  const disconnectAt = f.brokerEvents.length;
  const crashed = f.b.link as unknown as { running: boolean; session?: { ws: WebSocket } };
  crashed.running = false; crashed.session?.ws.close(1000, "presence liveness crash fixture");
  await f.signal.wait(() => f.brokerEvents.slice(disconnectAt).some(row => row.event === "disconnected" && row.member === betaMember), "beta disconnected without an offline presence frame");
  const betaFramesAtCrash = f.verifiedSenders.filter(sender => sender === betaMember).length;

  f.a.setNow(1_000_029);
  f.a.chat.tick();
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");

  f.a.setNow(1_000_030);
  f.a.chat.tick();
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  expect(f.a.bus.stateOf("user@beta")).toBe("idle");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  expect(f.verifiedSenders.filter(sender => sender === betaMember)).toHaveLength(betaFramesAtCrash);
  const env = newEnvelope("codex", "durable transport is independent of advisory aging", { to: ["codex@beta"] });
  f.a.bus.publish(env);
  await f.signal.wait(() => f.a.store!.applicationOutbox("work").some(row => row.application === env.id && row.state === "accepted"), "broker stores chat for the non-live member after its liveness ages");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
});

test("a legacy broker without ephemeral support preserves signed presence and reports liveness as untracked", async () => {
  const f = await mesh({ legacy: true });
  expect(f.a.link!.livenessTracked).toBe(false);
  expect(f.b.link!.livenessTracked).toBe(false);
  expect(f.readyKeys.length).toBeGreaterThan(0);
  for (const keys of f.readyKeys) expect(keys).toEqual(["digest", "epoch", "member", "room", "type", "v"]);
  f.a.setNow(1_010_000);
  f.a.chat.tick();

  const peer = f.a.chat.peers("work").find(row => row.id === "codex@beta");
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  expect(f.a.bus.stateOf("user@beta")).toBe("idle");
  expect(peer).toMatchObject({ presence: "idle", liveness: "untracked" });
});

test("restored presence and clock rollback cannot renew advisory freshness or change transport admission", async () => {
  const f = await mesh(), betaMember = f.b.store!.identity.public.fingerprint;
  const currentPresence = { member: betaMember, peers: [{ id: "codex", state: "idle" as const }] };
  f.a.setNow(1_000_000);
  f.a.chat.presence(f.a.store!, "work", f.a.link!, currentPresence);
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  f.a.chat.presence(f.a.store!, "work", f.a.link!, { member: betaMember, peers: [{ id: "codex", state: "offline" }] });
  f.a.chat.presence(f.a.store!, "work", f.a.link!, { ...currentPresence, restored: true });
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("offline");
  expect(f.a.bus.stateOf("codex@beta")).toBe("offline");
  f.a.chat.presence(f.a.store!, "work", f.a.link!, currentPresence);

  f.a.setNow(1_000_001);
  f.a.chat.presence(f.a.store!, "work", f.a.link!, { ...currentPresence, restored: true });
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  f.a.setNow(1_000_029);
  f.a.chat.tick();
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("idle");

  f.a.setNow(999_999);
  const beforeRead = f.a.bus.stateOf("codex@beta");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  expect(f.a.chat.peersForStatus("work")?.find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  expect(f.a.bus.stateOf("codex@beta")).toBe(beforeRead);
  expect(beforeRead).toBe("idle");
  f.a.chat.tick();
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  f.a.setNow(1_000_029);
  f.a.chat.tick();
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");

  f.a.chat.presence(f.a.store!, "work", f.a.link!, currentPresence);
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  f.a.chat.presence(f.a.store!, "work", f.a.link!, { member: betaMember, peers: [{ id: "codex", state: "offline" }] });
  f.a.setNow(1_000_059);
  f.a.chat.tick();
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  expect(f.a.bus.stateOf("codex@beta")).toBe("offline");
  f.a.chat.presence(f.a.store!, "work", f.a.link!, { ...currentPresence, restored: true });
  expect(f.a.bus.stateOf("codex@beta")).toBe("offline");
  expect(f.a.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
});

test("a restarted host treats saved peer state as unknown until the member sends fresh presence", async () => {
  const f = await mesh();
  await f.a.close();
  const restarted = await side(f.root, "alpha", f.signal);
  f.a = restarted;
  await restarted.commands.start();

  expect(restarted.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("unknown");
  expect(restarted.bus.stateOf("user@beta")).toBe("offline");
  await f.signal.wait(() => restarted.bus.stateOf("codex@beta") === "idle", "fresh presence after restart");
  expect(restarted.chat.peers("work").find(row => row.id === "codex@beta")?.presence).toBe("idle");
});
