import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, type BrokerEvent, type BrokerRuntime } from "../src/broker/server.ts";
import { Bus, type PublishResult } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { verifyPublicFrame } from "../src/rooms/wire.ts";
import type { RoomLinkApplication } from "../src/rooms/link.ts";

class LocalPeer extends BasePeer {
  got: Envelope[] = [];
  constructor() { super("codex"); }
  async deliver(envs: Envelope[], id?: string): Promise<void> {
    this.got.push(...envs); this.setState("busy");
    if (id) this.delivery({ id, state: "accepted" });
    await Promise.resolve();
    if (id) this.delivery({ id, state: "completed" });
    this.setState("idle");
  }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { await Promise.resolve(); this.setState("offline"); }
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function signals() {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const wait = (check: () => boolean | Promise<boolean>, label: string): Promise<void> => new Promise((resolve, reject) => {
    let checking = false, again = false, done = false;
    const finish = (error?: unknown) => { if (done) return; done = true; clearTimeout(timer); listeners.delete(inspect); error ? reject(error) : resolve(); };
    const inspect = () => {
      if (done) return;
      if (checking) { again = true; return; }
      checking = true;
      void (async () => { do { again = false; if (await check()) return finish(); } while (again && !done); })().catch(finish).finally(() => { checking = false; });
    };
    const timer = setTimeout(() => finish(new Error(`room delivery barrier timed out: ${label}`)), 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}
type Signal = ReturnType<typeof signals>;
interface Control {
  phase: string; holdSender?: string; hold: boolean; entered: boolean; gate: ReturnType<typeof deferred>;
  afterPublication?: (label: string, env: Envelope, result: PublishResult) => void;
  afterReceive?: (label: string, input: Parameters<RoomLinkApplication["receive"]>[1]) => void;
}
interface Hub {
  label: string; cwd: string; stateDir: string; journal: DeliveryJournal; bus: Bus; peer: LocalPeer; commands: RoomCommands; chat: RoomChat;
  close(): Promise<void>;
}
async function hub(root: string, label: string, event: Signal, control: Control, ackSeconds: number): Promise<Hub> {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  if (!existsSync(join(cwd, ".agenthub/config.local.json"))) writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { ack_timeout_s: ackSeconds, work: { expose: ["codex"] } } }));
  const stateDir = join(cwd, "state"), journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  const roster = new Set(["codex"]); let chat: RoomChat | undefined;
  const bus = new Bus({ journal, batchMs: 0, retryMs: 10, queueCap: 300, rostered: id => roster.has(id), remotePending: room => chat?.pendingIds(room) ?? [], remotePrivate: () => false });
  const publish = bus.publishResult.bind(bus);
  bus.publishResult = env => { const result = publish(env); if (env.from.includes("@")) { control.afterPublication?.(label, env, result); event.notify(); } return result; };
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  chat = new RoomChat({ bus, cwd, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false, modelScreenOn: () => false,
    screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); event.notify(); }, changed: event.notify });
  const receive = chat.application.receive;
  chat.application.receive = async (context, input) => { await receive(context, input); control.afterReceive?.(label, input); event.notify(); };
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const commands = new RoomCommands({ cwd, stateDir, chat, presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  bus.onQueues = () => { chat!.queueChanged(); event.notify(); };
  bus.tap(() => { commands.changed(); event.notify(); });
  let closed = false;
  return { label, cwd, stateDir, journal, bus, peer, commands, chat, close: async () => { if (closed) return; closed = true; commands.stop(); await peer.stop(); bus.closeJournal(); } };
}
async function command(side: Hub, action: string, input: unknown) { return (await side.commands.preview(action, input, () => true)).commit(); }
async function rows(side: Hub): Promise<Record<string, unknown>[]> { return ((await side.commands.rows("work"))[0]?.deliveries ?? []) as Record<string, unknown>[]; }
async function outbound(side: Hub, application: string) { return (await rows(side)).find(row => row.direction === "outbound" && row.application === application); }
interface Mesh {
  root: string; broker: BrokerRuntime; event: Signal; control: Control; frames: { sender: string; digest: string; phase: string }[];
  brokerEvents: { event: BrokerEvent; member?: string }[]; a: Hub; b: Hub; owner: string; guest: string;
  restart(which: "a" | "b"): Promise<Hub>; close(): Promise<void>;
}
const meshes: Mesh[] = [];
afterEach(async () => { for (const mesh of meshes.splice(0).reverse()) await mesh.close(); });
async function mesh(ackSeconds = 600): Promise<Mesh> {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-delivery-")), event = signals();
  const control: Control = { phase: "setup", hold: false, entered: false, gate: deferred() }, frames: Mesh["frames"] = [], brokerEvents: Mesh["brokerEvents"] = [];
  const brokerRoot = join(root, "broker");
  const broker = await startBroker({ stateDir: brokerRoot, port: 0 }, {
    log: (kind, ids) => { brokerEvents.push({ event: kind, ...(ids.member ? { member: ids.member } : {}) }); event.notify(); },
    verifyFrame: async input => {
      const proof = await verifyPublicFrame(input); frames.push({ sender: proof.sender, digest: proof.digest, phase: control.phase });
      if (control.hold && control.holdSender === proof.sender) { control.entered = true; event.notify(); await control.gate.promise; }
      event.notify(); return proof;
    },
  });
  // SQLite's directory events are a durable queue-ACK barrier, not a timer/poll of the broker.
  const changes = watch(brokerRoot, event.notify); changes.unref();
  const { a, b } = await (async () => {
    const a = await hub(root, "alpha", event, control, ackSeconds);
    try { return { a, b: await hub(root, "beta", event, control, ackSeconds) }; }
    catch (error) { await a.close(); throw error; }
  })().catch(async error => { control.gate.release(); changes.close(); await broker.stop(); rmSync(root, { recursive: true, force: true }); throw error; });
  const handles = [a, b]; let owner = "", guest = "";
  const result: Mesh = { root, broker, event, control, frames, brokerEvents, a, b, owner, guest,
    restart: async which => {
      await result[which].close();
      const next = await hub(root, which === "a" ? "alpha" : "beta", event, control, ackSeconds); handles.push(next); result[which] = next;
      await next.commands.start(); return next;
    },
    close: async () => {
      for (const handle of handles.slice().reverse()) await handle.close();
      control.hold = false; control.gate.release(); changes.close(); await broker.stop(); rmSync(root, { recursive: true, force: true });
    },
  };
  meshes.push(result);
  const created = await command(a, "create", { name: "work", broker: broker.publicUrl, label: "alpha" }); owner = created.owner!;
  await command(a, "expose", { name: "work", peers: ["codex"] });
  const invitation = await command(a, "invite", { name: "work" }), request = await command(b, "join", { name: "work", token: invitation.artifact, label: "beta" }); guest = request.member!;
  const roster = await command(a, "invite", { name: "work", request: request.artifact }); await command(b, "join", { name: "work", roster: roster.artifact });
  result.owner = owner; result.guest = guest;
  await event.wait(() => result.a.bus.stateOf("codex@beta") === "idle" && result.b.bus.stateOf("codex@alpha") === "idle", "both room peers online");
  control.phase = "before"; return result;
}
async function reverseBarrier(f: Mesh, body: string): Promise<void> {
  const barrier = newEnvelope("codex", body, { to: ["codex@alpha"] }); f.b.bus.publish(barrier);
  await f.event.wait(async () => (await outbound(f.b, barrier.id))?.state === "completed (admitted)", "reverse signed application barrier");
  expect(f.a.peer.got.some(row => row.id === barrier.id)).toBe(true);
}

for (const state of ["dispatching", "accepted"] as const) test(`sender ${state} becomes needs_review on restart without retransmitting its sealed application`, async () => {
  const f = await mesh(), env = newEnvelope("codex", `uncertain ${state}`, { to: ["codex@beta"] });
  if (state === "dispatching") { f.control.holdSender = f.owner; f.control.hold = true; }
  else f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) throw new Error("fixture interrupted after durable local publication"); };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === state && (state !== "dispatching" || f.control.entered), `outbound ${state} persisted`);
  const disconnectAt = f.brokerEvents.length;
  await f.a.close();
  await f.event.wait(() => f.brokerEvents.slice(disconnectAt).some(row => row.event === "disconnected" && row.member === f.owner), "old sender socket fenced");
  f.control.hold = false; f.control.gate.release(); f.control.phase = "after";
  await f.restart("a");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review" && f.a.bus.stateOf("codex@beta") === "idle", "sender restored uncertain");
  await reverseBarrier(f, "restart transport barrier");
  const before = new Set(f.frames.filter(row => row.sender === f.owner && row.phase === "before").map(row => row.digest));
  expect(f.frames.filter(row => row.sender === f.owner && row.phase === "after" && before.has(row.digest))).toEqual([]);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(state === "dispatching" ? 0 : 1);
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(original => original.id === env.id) && row.state === "needs_review")).toBe(true);
});

test("cross-database publication failure is quarantined and receiver restart never republishes it", async () => {
  const f = await mesh(), env = newEnvelope("codex", "cross database uncertainty", { to: ["codex@beta"] });
  let publications = 0;
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { publications++; throw new Error("fixture crash after local journal publication"); } };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await rows(f.b)).some(row => row.direction === "inbound" && row.application === env.id && row.state === "needs_review"), "uncertain cross-database admission recorded");
  expect(publications).toBe(1);
  await f.restart("b");
  await f.event.wait(() => f.b.bus.stateOf("codex@alpha") === "idle", "receiver reconnected");
  await reverseBarrier(f, "after receiver restart");
  await f.event.wait(() => f.broker.stats().queuedFrames === 0, "duplicate frame transport ACK retired");
  expect(publications).toBe(1); expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
  expect((await rows(f.b)).some(row => row.direction === "inbound" && row.application === env.id && row.state === "needs_review")).toBe(true);
  expect(f.b.journal.list("codex").filter(row => row.originals.some(original => original.id === env.id))).toHaveLength(1);
});

test("an exact sequence redelivery resends its signed receipt without a second local publication", async () => {
  const f = await mesh(), env = newEnvelope("codex", "once despite lost transport ack", { to: ["codex@beta"] });
  let publications = 0, interrupted = false, duplicateReceives = 0, originalDigest: string | undefined;
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) publications++; };
  f.control.afterReceive = (label, input) => {
    if (label !== "beta") return;
    if (input.digest === originalDigest && input.message === undefined) duplicateReceives++;
    if (!interrupted && input.message?.type === "chat" && input.message.envelope.id === env.id) { originalDigest = input.digest; interrupted = true; throw new Error("fixture interrupted after signed application receipt"); }
  };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "signed receipt admitted");
  await f.event.wait(() => duplicateReceives > 0 && f.broker.stats().queuedFrames === 0 && f.b.bus.stateOf("codex@alpha") === "idle", "redelivery transport ACK completed");
  expect(interrupted).toBe(true); expect(duplicateReceives).toBeGreaterThan(0); expect(publications).toBe(1); expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.journal.list("codex@beta").filter(row => row.originals.some(original => original.id === env.id) && row.state === "completed")).toHaveLength(1);
});

test("a late signed admission receipt is visible evidence and never auto-completes needs_review", async () => {
  const f = await mesh(1), env = newEnvelope("codex", "late receipt evidence", { to: ["codex@beta"] });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "accepted" && f.control.entered, "recipient receipt held after broker storage");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "local ACK deadline reached");
  f.control.hold = false; f.control.gate.release();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.lateReceipt === "completed (admitted)", "late signed evidence displayed");
  expect(await outbound(f.a, env.id)).toMatchObject({ state: "needs_review", lateReceipt: "completed (admitted)" });
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(original => original.id === env.id) && row.state === "needs_review")).toBe(true);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
});
