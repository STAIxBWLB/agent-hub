import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import type { RoomLink } from "../src/rooms/link.ts";
import type { RoomStore } from "../src/rooms/store.ts";

class LocalPeer extends BasePeer {
  readonly got: Envelope[] = [];
  constructor() { super("codex"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(envelopes: Envelope[]): Promise<void> { this.got.push(...envelopes); this.setState("busy"); this.setState("idle"); }
}

function signal() {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const wait = (check: () => boolean, label: string): Promise<void> => new Promise((resolve, reject) => {
    const inspect = () => { if (check()) { clearTimeout(timer); listeners.delete(inspect); resolve(); } };
    const timer = setTimeout(() => { listeners.delete(inspect); reject(new Error(`room liveness service barrier timed out: ${label}`)); }, 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}
type Signal = ReturnType<typeof signal>;
interface Side {
  label: string; cwd: string; bus: Bus; chat: RoomChat; commands: RoomCommands; peer: LocalPeer; journal: DeliveryJournal;
  store?: RoomStore; link?: RoomLink; setNow(value: number): void; now(): number; close(): Promise<void>;
}
async function side(root: string, label: string, events: Signal) {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { ack_timeout_s: 600, queue_ttl_h: 1, work: { expose: ["codex"] } } }));
  const stateDir = join(cwd, "state"), journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  const roster = new Set(["codex"]); let now = Date.now(), chat: RoomChat | undefined;
  const bus = new Bus({ journal, batchMs: 0, queueCap: 200, rostered: id => roster.has(id), remotePending: room => chat?.pendingIds(room) ?? [] });
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  chat = new RoomChat({ bus, cwd, now: () => now, refreshMs: 60_000, routing: () => routing, piiPaths: () => [],
    senderPrivate: () => false, taskPrivate: () => false, modelScreenOn: () => false,
    screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); events.notify(); }, changed: events.notify });
  const result: Side = { label, cwd, bus, chat, commands: undefined as unknown as RoomCommands, peer, journal, now: () => now, setNow(value) { now = value; },
    async close() { await this.commands.stop(); await this.peer.stop(); bus.closeJournal(); } };
  const bind = chat.bind.bind(chat);
  chat.bind = (store, name, link) => { if (name === "work") { result.store = store; result.link = link; } bind(store, name, link); };
  const commands = new RoomCommands({ cwd, stateDir, clock: () => now, refreshMs: 60_000, chat,
    presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  result.commands = commands;
  bus.onQueues = () => { chat!.queueChanged(); events.notify(); };
  return result;
}

type Fixture = { root: string; broker: BrokerRuntime; events: Signal; a: Side; b: Side; releaseBlocked(): void };
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    fixture.releaseBlocked(); await fixture.a.close(); await fixture.b.close(); await fixture.broker.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
async function roomCommand(from: Side, action: string, input: unknown) {
  return (await from.commands.preview(action, input, () => true)).commit();
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-liveness-service-736-")), events = signal();
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0 });
  const a = await side(root, "alpha", events), b = await side(root, "beta", events);
  let release!: () => void, blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const receive = b.chat.application.receive;
  b.chat.application.receive = async (context, input) => {
    if (input.message?.type === "chat") { blocked = true; events.notify(); await gate; }
    await receive(context, input);
  };
  const value: Fixture = { root, broker, events, a, b, releaseBlocked: release }; fixtures.push(value);
  await roomCommand(a, "create", { name: "work", broker: broker.publicUrl, label: "alpha" });
  await roomCommand(a, "expose", { name: "work", peers: ["codex"] });
  const invite = await roomCommand(a, "invite", { name: "work" });
  const request = await roomCommand(b, "join", { name: "work", token: invite.artifact, label: "beta" });
  const roster = await roomCommand(a, "invite", { name: "work", request: request.artifact });
  await roomCommand(b, "join", { name: "work", roster: roster.artifact });
  await events.wait(() => a.bus.stateOf("codex@beta") === "idle" && b.bus.stateOf("codex@alpha") === "idle", "room presence ready");
  return { value, blocked: () => blocked };
}

test("stale presence settlement does not re-reserve the discarded Store head", async () => {
  const { value, blocked } = await fixture();
  const f = value, env = newEnvelope("user", "stale presence settlement", { to: ["codex@beta"] });
  f.a.bus.publish(env);
  await f.events.wait(() => blocked() && f.a.store!.applicationOutbox("work").some(row => row.application === env.id && row.state === "accepted"), "accepted Store intent with held receiver receipt");
  const row = f.a.store!.applicationOutbox("work").find(item => item.application === env.id)!;

  f.a.setNow(row.createdAt + 180_001);
  f.a.chat.tick();
  expect(f.a.chat.peers("work").find(peer => peer.id === "codex@beta")?.presence).toBe("unknown");
  expect(f.a.bus.stateOf("codex@beta")).toBe("busy");

  f.a.setNow(row.expiresAt + 1);
  f.a.chat.tick();
  const held = f.a.store!.applicationOutbox("work").find(item => item.deliveryId === row.deliveryId)!;
  expect(held.state).toBe("needs_review");
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");

  const journal = f.a.journal.get(row.deliveryId)!;
  f.a.bus.resolveDelivery(row.deliveryId, journal.revision, "discard", "fixture person disposition");
  f.a.chat.tick();
  expect(f.a.store!.applicationOutbox("work").find(item => item.deliveryId === row.deliveryId)?.disposition).toBe("discard");
  expect(f.a.bus.stateOf("codex@beta")).toBe("idle");
  expect(f.a.chat.peers("work").find(peer => peer.id === "codex@beta")?.presence).toBe("unknown");
});

test("a graceful signed offline keeps work local until reconnect and delivers it once", async () => {
  const { value: f } = await fixture();
  f.releaseBlocked();
  await f.b.close();
  await f.events.wait(() => f.a.bus.stateOf("codex@beta") === "offline", "signed offline after graceful recipient stop");
  const env = newEnvelope("user", "queued locally while the recipient is gracefully offline", { to: ["codex@beta"] });
  expect(f.a.bus.publish(env)).toEqual(["codex@beta"]);
  expect(f.a.bus.queueIds("codex@beta")).toContain(env.id);
  expect(f.a.store!.applicationOutbox("work").some(row => row.application === env.id)).toBe(false);

  const restarted = await side(f.root, "beta", f.events);
  f.b = restarted;
  await restarted.commands.start();
  await f.events.wait(() => restarted.peer.got.some(row => row.id === env.id)
    && f.a.store!.applicationOutbox("work").some(row => row.application === env.id && row.state === "completed"), "reconnected recipient admits and settles the queued envelope");
  expect(restarted.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.bus.queueIds("codex@beta")).not.toContain(env.id);
  expect(f.a.store!.applicationOutbox("work").filter(row => row.application === env.id)).toHaveLength(1);
});
