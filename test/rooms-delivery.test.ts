import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { verifyPublicFrame, sealFrame, openFrame } from "../src/rooms/wire.ts";
import type { RoomLink, RoomLinkApplication } from "../src/rooms/link.ts";
import { RoomStore, RoomApplicationLimitError, ROOM_APPLICATION_RETENTION } from "../src/rooms/store.ts";
import { encodeRoomMessage, decodeRoomMessage, type RoomMessage } from "../src/rooms/application.ts";
import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";

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
      void (async () => { do { again = false; if (await check()) return finish(); } while (again && !done); })().catch(finish).finally(() => { checking = false; if (again && !done) inspect(); });
    };
    const timer = setTimeout(() => finish(new Error(`room delivery barrier timed out: ${label}`)), 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}
type Signal = ReturnType<typeof signals>;
test("delivery signals retain a notification arriving after an async check returns", async () => {
  const signal = signals(); let ready = false, checks = 0, release!: (value: boolean) => void;
  const first = new Promise<boolean>(resolve => { release = resolve; });
  const pending = signal.wait(() => ++checks === 1 ? first : ready, "re-entrant notification"); void pending.catch(() => {});
  release(false);
  queueMicrotask(() => { ready = true; signal.notify(); });
  await new Promise<void>(resolve => setImmediate(resolve)); // Flush the queued check/notification reactions, without wall-clock delay.
  try { expect(checks).toBe(2); }
  finally { signal.notify(); await pending; }
});
interface Control {
  now: number; phase: string; holdSender?: string; hold: boolean; entered: boolean; gate: ReturnType<typeof deferred>;
  afterPublication?: (label: string, env: Envelope, result: PublishResult) => void;
  afterReceive?: (label: string, input: Parameters<RoomLinkApplication["receive"]>[1]) => void;
  afterSend?: (label: string, message: RoomMessage) => Promise<void>;
  policyVersion?: number;
  blockIncoming?: boolean; blockedApplication?: string; blockedAttempts?: number; hush?: string; holdNative?: string;
}
interface Hub {
  label: string; cwd: string; stateDir: string; journal: DeliveryJournal; bus: Bus; peer: LocalPeer; commands: RoomCommands; chat: RoomChat;
  readonly store?: RoomStore; readonly link?: RoomLink; readonly nativeStates: number; readonly notices: readonly Record<string, unknown>[];
  close(): Promise<void>;
}
async function hub(root: string, label: string, event: Signal, control: Control, ackSeconds: number): Promise<Hub> {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  if (!existsSync(join(cwd, ".agenthub/config.local.json"))) writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { ack_timeout_s: ackSeconds, work: { expose: ["codex"] } } }));
  const stateDir = join(cwd, "state"), journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  const roster = new Set(["codex"]), notices: Record<string, unknown>[] = []; let chat: RoomChat | undefined;
  const bus = new Bus({ journal, batchMs: 0, retryMs: 10, queueCap: 300, rostered: id => roster.has(id), deliveryHeld: id => control.holdNative === label && id === "codex", remotePending: room => chat?.pendingIds(room) ?? [], remotePrivate: () => false, silence: (_env, peer) => control.hush === label && peer === "codex" ? "fixture silent cohort" : undefined });
  const publish = bus.publishResult.bind(bus);
  bus.publishResult = env => { const result = publish(env); if (env.from.includes("@")) { control.afterPublication?.(label, env, result); event.notify(); } return result; };
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  chat = new RoomChat({ bus, cwd, now: () => control.now, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false, modelScreenOn: () => false,
    screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => control.policyVersion ?? 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); event.notify(); }, changed: event.notify, notice: value => { notices.push({ ...value }); event.notify(); } });
  let ownedStore: RoomStore | undefined, ownedLink: RoomLink | undefined;
  const wrapped = new WeakSet<RoomStore>(), wrappedLinks = new WeakSet<RoomLink>(), members = chat.application.members;
  chat.application.members = context => {
    ownedStore = context.store; ownedLink = context.link;
    if (!wrapped.has(context.store)) {
      wrapped.add(context.store);
      const incoming = context.store.applicationIncoming.bind(context.store);
      context.store.applicationIncoming = async (name, digest, current) => {
        const entry = context.store.pendingInbox(name).find(row => row.digest === digest);
        const message = entry && decodeRoomMessage(entry.plaintext);
        if (label === "beta" && control.blockIncoming && message?.type === "chat" && (!control.blockedApplication || control.blockedApplication === message.envelope.id)) {
          control.blockedAttempts = (control.blockedAttempts ?? 0) + 1; event.notify();
          throw new RoomApplicationLimitError(context.store.get(name)!.current.room, ROOM_APPLICATION_RETENTION.identitiesPerRoom);
        }
        return incoming(name, digest, current);
      };
    }
    if (!wrappedLinks.has(context.link)) {
      wrappedLinks.add(context.link); const publish = context.link.publishApplication.bind(context.link);
      context.link.publishApplication = async (message, recipient, outgoing, current) => { const digest = await publish(message, recipient, outgoing, current); event.notify(); await control.afterSend?.(label, message); return digest; };
    }
    members(context);
  };
  chat.application.transportAck = () => event.notify();
  const stored = chat.application.stored;
  chat.application.stored = (context, input) => { try { stored(context, input); } finally { event.notify(); } };
  const receive = chat.application.receive;
  chat.application.receive = async (context, input) => { try { await receive(context, input); } finally { control.afterReceive?.(label, input); event.notify(); } };
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const commands = new RoomCommands({ cwd, stateDir, clock: () => control.now, chat, presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  bus.onQueues = () => { chat!.queueChanged(); event.notify(); };
  let nativeStates = 0;
  bus.tap(eventRow => { if (eventRow.t === "state" && !eventRow.peer.includes("@")) { nativeStates++; commands.changed(); } event.notify(); });
  let closed = false;
  return { label, cwd, stateDir, journal, bus, peer, commands, chat, get store() { return ownedStore; }, get link() { return ownedLink; }, get nativeStates() { return nativeStates; }, notices, close: async () => { if (closed) return; closed = true; commands.stop(); await peer.stop(); bus.closeJournal(); } };
}
async function command(side: Hub, action: string, input: unknown) { return (await side.commands.preview(action, input, () => true)).commit(); }
async function rows(side: Hub): Promise<Record<string, unknown>[]> { return ((await side.commands.rows("work"))[0]?.deliveries ?? []) as Record<string, unknown>[]; }
async function outbound(side: Hub, application: string) { return (await rows(side)).find(row => row.direction === "outbound" && row.application === application); }
interface Mesh {
  root: string; broker: BrokerRuntime; event: Signal; control: Control; frames: { sender: string; digest: string; phase: string }[];
  brokerEvents: { event: BrokerEvent; member?: string; code?: string }[]; a: Hub; b: Hub; owner: string; guest: string;
  restart(which: "a" | "b"): Promise<Hub>; close(): Promise<void>;
}
const meshes: Mesh[] = [];
afterEach(async () => { for (const mesh of meshes.splice(0).reverse()) await mesh.close(); });
async function mesh(ackSeconds = 600, brokerQueueCap?: number): Promise<Mesh> {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-delivery-")), event = signals();
  const control: Control = { now: Date.now(), phase: "setup", hold: false, entered: false, gate: deferred() }, frames: Mesh["frames"] = [], brokerEvents: Mesh["brokerEvents"] = [];
  const brokerRoot = join(root, "broker");
  const broker = await startBroker({ stateDir: brokerRoot, port: 0, ...(brokerQueueCap ? { limits: { queuedPerRoom: brokerQueueCap } } : {}) }, {
    log: (kind, ids) => { brokerEvents.push({ event: kind, ...(ids.member ? { member: ids.member } : {}), ...(ids.code ? { code: ids.code } : {}) }); event.notify(); },
    verifyFrame: async input => {
      const proof = await verifyPublicFrame(input); frames.push({ sender: proof.sender, digest: proof.digest, phase: control.phase });
      if (control.hold && control.holdSender === proof.sender) { control.entered = true; event.notify(); await control.gate.promise; }
      event.notify(); return proof;
    },
  });
  const { a, b } = await (async () => {
    const a = await hub(root, "alpha", event, control, ackSeconds);
    try { return { a, b: await hub(root, "beta", event, control, ackSeconds) }; }
    catch (error) { await a.close(); throw error; }
  })().catch(async error => { control.gate.release(); await broker.stop(); rmSync(root, { recursive: true, force: true }); throw error; });
  const handles = [a, b]; let owner = "", guest = "";
  const result: Mesh = { root, broker, event, control, frames, brokerEvents, a, b, owner, guest,
    restart: async which => {
      await result[which].close();
      const next = await hub(root, which === "a" ? "alpha" : "beta", event, control, ackSeconds); handles.push(next); result[which] = next;
      await next.commands.start(); return next;
    },
    close: async () => {
      for (const handle of handles.slice().reverse()) await handle.close();
      control.hold = false; control.gate.release(); await broker.stop(); rmSync(root, { recursive: true, force: true });
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
async function acknowledgementDeadline(f: Mesh, side: Hub, application: string): Promise<void> {
  await f.event.wait(() => side.store?.applicationOutbox("work").some(row => row.application === application && row.ackDeadline !== undefined) === true, "host acknowledgement deadline persisted");
  const row = side.store!.applicationOutbox("work").find(row => row.application === application)!;
  expect(row.ackDeadline).toBeDefined();
  f.control.now = Math.max(f.control.now, row.ackDeadline! + 1);
  side.chat.tick(); f.event.notify();
}
async function reconnectGuest(f: Mesh, after: number): Promise<void> {
  await f.event.wait(() => f.brokerEvents.slice(after).some(row => row.event === "disconnected" && row.member === f.guest), "interrupted guest transport disconnected");
  f.b.link!.refresh(); // Drive the existing host reconnect, not randomized backoff.
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
  const disconnectAt = f.brokerEvents.length;
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "signed receipt admitted");
  await reconnectGuest(f, disconnectAt);
  await f.event.wait(() => duplicateReceives > 0 && f.broker.stats().queuedFrames === 0 && f.b.bus.stateOf("codex@alpha") === "idle", "redelivery transport ACK completed");
  expect(interrupted).toBe(true); expect(duplicateReceives).toBeGreaterThan(0); expect(publications).toBe(1); expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.journal.list("codex@beta").filter(row => row.originals.some(original => original.id === env.id) && row.state === "completed")).toHaveLength(1);
});

test("a late signed admission receipt is visible evidence and never auto-completes needs_review", async () => {
  const f = await mesh(1), env = newEnvelope("codex", "late receipt evidence", { to: ["codex@beta"] });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "accepted" && f.control.entered, "recipient receipt held after broker storage");
  await acknowledgementDeadline(f, f.a, env.id);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "local ACK deadline reached");
  f.control.hold = false; f.control.gate.release();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.lateReceipt === "completed (admitted)", "late signed evidence displayed");
  expect(await outbound(f.a, env.id)).toMatchObject({ state: "needs_review", lateReceipt: "completed (admitted)" });
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(original => original.id === env.id) && row.state === "needs_review")).toBe(true);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
});


for (const reconnect of ["blip", "restart"] as const) test(`an unchanged idle remote is rediscovered after ${reconnect} and a never-handed queue drains once`, async () => {
  const f = await mesh(); f.control.holdNative = "beta";
  const nativeBefore = f.b.nativeStates;
  if (reconnect === "blip") f.a.link!.refresh();
  else await f.restart("a");
  const env = newEnvelope("user", `queued across ${reconnect}`, { to: ["codex@beta"] });
  expect(f.a.bus.publish(env)).toEqual(["codex@beta"]);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "reconnected unchanged remote admitted");
  expect(f.b.bus.queueIds("codex").filter(id => id === env.id)).toHaveLength(1);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(0);
  expect(f.b.nativeStates).toBe(nativeBefore); // No remote-state echo can manufacture a fresh native presence.
  expect(f.a.journal.list("codex@beta").filter(row => row.originals.some(item => item.id === env.id) && row.state === "completed")).toHaveLength(1);
});

test("a pre-claim capacity block retains plaintext while a later signed receipt still settles", async () => {
  const f = await mesh(), owner = f.a.store!, receiver = f.b.store!, current = owner.get("work")!;
  const held: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "held capacity identity", ts: Date.now() } };
  const holdWire = await sealFrame({ epoch: current.current, identity: owner.identity, recipients: [receiver.identity.public.fingerprint], sequence: owner.sequence, plaintext: encodeRoomMessage(held) });
  expect((await openFrame({ wire: holdWire, identity: receiver.identity, current: receiver.get("work")!.current, replay: receiver.replay })).status).toBe("accepted");
  const holdDigest = encodeBase64url(await sha256(holdWire)); await receiver.applicationIncoming("work", holdDigest);
  expect(receiver.claimApplication("work", holdDigest)).toBe(true); receiver.quarantineApplication("work", holdDigest);
  const blocked = newEnvelope("user", "must stay pending until person disposition", { to: ["codex@beta"] });
  f.control.blockIncoming = true; f.control.blockedApplication = blocked.id;
  f.a.bus.publish(blocked);
  await f.event.wait(() => (f.control.blockedAttempts ?? 0) > 0, "application cap reported before claim");
  expect(receiver.pendingInbox("work")).toHaveLength(1); expect(f.b.peer.got.some(row => row.id === blocked.id)).toBe(false);
  const reply = newEnvelope("codex", "unrelated control receipt remains live", { to: ["user@alpha"] }); f.b.bus.publish(reply);
  await f.event.wait(async () => (await outbound(f.b, reply.id))?.state === "failed_safe", "later matching signed receipt processed");
  expect(receiver.pendingInbox("work")).toHaveLength(1);
  const attempts = f.control.blockedAttempts;
  await rows(f.b); await rows(f.b); expect(f.control.blockedAttempts).toBe(attempts); // Room status is a pure read.
  f.control.blockIncoming = false;
  await command(f.b, "resolve", { name: "work", frame: holdDigest, action: "discard" });
  await f.event.wait(async () => (await outbound(f.a, blocked.id))?.state === "completed (admitted)", "person disposition retries retained plaintext");
  expect(f.b.peer.got.filter(row => row.id === blocked.id)).toHaveLength(1); expect(receiver.pendingInbox("work")).toEqual([]);
});

test("a silent local recipient returns a signed safe refusal before any local publication", async () => {
  const f = await mesh(); f.control.hush = "beta";
  const env = newEnvelope("user", "silenced local target", { to: ["codex@beta"] }); f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "failed_safe", "signed silent-cohort refusal");
  const row = await outbound(f.a, env.id); expect(row?.refusalReason).toBe("boundary_refused");
  expect(f.b.peer.got.some(item => item.id === env.id)).toBe(false);
  expect(f.b.store!.applicationStatus("work").needsReview).toBe(0); expect(f.a.bus.queueShow(String(row!.id))?.state).toBe("failed");
});

test("post-send policy divergence quarantines the outbox before a late receipt can settle it", async () => {
  const f = await mesh(), sent = deferred(); let entered = false;
  const roster = encodeBase64url(f.a.store!.get("work")!.wire);
  await command(f.a, "leave", { name: "work" }); await command(f.a, "join", { name: "work", roster });
  await f.event.wait(() => f.a.bus.stateOf("codex@beta") === "idle", "current binding restored after explicit rejoin");
  const env = newEnvelope("user", "published before proof diverged", { to: ["codex@beta"] });
  f.control.afterSend = async (label, message) => { if (label === "alpha" && message.type === "chat" && message.envelope.id === env.id) { entered = true; f.event.notify(); await sent.promise; } };
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  try {
    f.a.bus.publish(env);
    await f.event.wait(() => entered && f.control.entered, "send returned while signed receipt is still held");
    f.control.policyVersion = 2; sent.release();
    await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "divergence persisted before receipt");
    f.control.hold = false; f.control.gate.release();
    await f.event.wait(async () => (await outbound(f.a, env.id))?.lateReceipt === "completed (admitted)", "late admitted evidence retained");
    expect(await outbound(f.a, env.id)).toMatchObject({ state: "needs_review", lateReceipt: "completed (admitted)" });
    expect(f.a.journal.unresolved("codex@beta").some(row => row.state === "needs_review" && row.originals.some(item => item.id === env.id))).toBe(true);
  } finally { sent.release(); f.control.hold = false; f.control.gate.release(); }
});

test("a frame held before broker storage reaches the local acknowledgement deadline", async () => {
  const f = await mesh(1), env = newEnvelope("user", "not yet stored", { to: ["codex@beta"] });
  f.control.holdSender = f.owner; f.control.hold = true;
  try {
    f.a.bus.publish(env);
    await f.event.wait(() => f.control.entered, "wire verification held before stored reply");
    await acknowledgementDeadline(f, f.a, env.id);
    await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "pre-stored acknowledgement deadline reached");
    expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
    expect(f.a.journal.unresolved("codex@beta").some(row => row.state === "needs_review" && row.originals.some(item => item.id === env.id))).toBe(true);
  } finally { f.control.hold = false; f.control.gate.release(); }
});

test("a real broker queue_full refusal is nonterminal and an un-stored application still times out", async () => {
  const f = await mesh(1, 1);
  await f.event.wait(() => f.broker.stats().queuedFrames === 0, "initial ciphertext queues drained");
  const at = f.brokerEvents.length; await f.b.close();
  await f.event.wait(() => f.brokerEvents.slice(at).some(row => row.event === "disconnected" && row.member === f.guest), "recipient link offline");
  f.a.bus.pause("codex");
  await f.event.wait(() => f.broker.stats().queuedFrames === 1, "signed presence fills offline broker queue");
  const env = newEnvelope("user", "queue full before stored", { to: ["codex@beta"] });
  const refusalAt = f.brokerEvents.length; f.a.bus.publish(env);
  await f.event.wait(() => {
    const target = f.a.store!.applicationOutbox("work").find(row => row.application === env.id);
    return target !== undefined
      && f.frames.some(frame => frame.sender === f.owner && frame.digest === target.digest)
      && f.brokerEvents.slice(refusalAt).some(row => row.event === "refused" && row.member === f.owner && row.code === "queue_full");
  }, "fresh wire queue_full after this application reached broker verification");
  expect(f.broker.stats().queuedFrames).toBe(1);
  expect(f.a.store!.applicationOutbox("work").find(row => row.application === env.id)?.state).toBe("dispatching");
  await acknowledgementDeadline(f, f.a, env.id);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "queue-refused application acknowledgement deadline");
  expect((await f.a.commands.rows("work"))[0]?.state).toBe("online");
  expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
});

test("room status never reconciles person dispositions, while the explicit tick does", async () => {
  const f = await mesh(1), env = newEnvelope("user", "disposition read purity", { to: ["codex@beta"] });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  try {
    f.a.bus.publish(env);
    await f.event.wait(() => f.control.entered, "recipient signed receipt held before clock advance");
    await acknowledgementDeadline(f, f.a, env.id);
    await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "known uncertainty awaiting person");
    const row = (await outbound(f.a, env.id))!, id = String(row.id), before = f.a.journal.get(id)!;
    f.a.bus.resolveDelivery(id, before.revision, "discard", "person discards known uncertainty");
    await rows(f.a); await rows(f.a);
    expect(f.a.store!.applicationOutbox("work").find(item => item.deliveryId === id)?.disposition).toBeUndefined();
    f.a.chat.tick();
    expect(f.a.store!.applicationOutbox("work").find(item => item.deliveryId === id)?.disposition).toBe("discard");
  } finally { f.control.hold = false; f.control.gate.release(); }
});


test("a temporarily unavailable local journal retains plaintext and retries only after repair", async () => {
  const f = await mesh(); f.b.bus.storageError = "fixture journal unavailable";
  const env = newEnvelope("user", "pending while local journal is unavailable", { to: ["codex@beta"] });
  f.a.bus.publish(env);
  await f.event.wait(() => f.b.store!.pendingApplications("work").length === 1, "business claim deferred while journal unavailable");
  expect(f.b.store!.pendingInbox("work")).toHaveLength(1); expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
  expect((await f.b.commands.rows("work"))[0]?.state).toBe("online");
  f.b.bus.storageError = undefined; await f.b.chat.retryPending("work");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "retained plaintext admitted after journal repair");
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1); expect(f.b.store!.pendingInbox("work")).toEqual([]);
});

test("a verified stale classification resends the retained signed receipt without another local admission", async () => {
  const f = await mesh(), env = newEnvelope("user", "retained receipt after stale classification", { to: ["codex@beta"] });
  let originalDigest: string | undefined, interrupted = false, stale = 0;
  const accept = f.b.store!.replay.accept;
  f.control.afterReceive = (label, input) => {
    if (label !== "beta") return;
    if (input.digest === originalDigest && input.message === undefined) stale++;
    if (!interrupted && input.message?.type === "chat" && input.message.envelope.id === env.id) {
      originalDigest = input.digest; interrupted = true;
      // Only classification is controlled. X1 still verifies this exact frame's
      // current membership, signature, nonce, decryption and request body first.
      f.b.store!.replay.accept = input => input.frameDigest === originalDigest ? Promise.resolve({ status: "stale" }) : accept(input);
      throw new Error("fixture disconnect after saved signed application receipt");
    }
  };
  try {
    const disconnectAt = f.brokerEvents.length;
    f.a.bus.publish(env);
    await reconnectGuest(f, disconnectAt);
    await f.event.wait(() => stale > 0 && f.broker.stats().queuedFrames === 0, "stale frame retired after signed receipt resend");
    expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    expect(f.b.store!.refused("work")).toContainEqual(expect.objectContaining({ digest: originalDigest, reason: "stale" }));
    expect(await outbound(f.a, env.id)).toMatchObject({ state: "completed (admitted)" });
  } finally { f.b.store!.replay.accept = accept; }
});

test("a durable sequence reservation gap is reported as fixed metadata without waiting for missing frames", async () => {
  const f = await mesh(), state = f.a.store!.get("work")!, binding = { room: state.current.room, sender: f.owner, epoch: state.current.epoch, rosterDigest: state.current.digest };
  await f.a.store!.sequence.reserve(binding); await f.a.store!.sequence.reserve(binding);
  const env = newEnvelope("user", "chat after deliberately consumed sequence numbers", { to: ["codex@beta"] }); f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "gap does not hold later chat");
  expect(f.b.notices.some(row => row.code === "sequence_gap" && row.room === binding.room && row.sender === f.owner && BigInt(String(row.count)) >= 2n)).toBe(true);
  expect(JSON.stringify(f.b.notices)).not.toContain(env.body);
});
