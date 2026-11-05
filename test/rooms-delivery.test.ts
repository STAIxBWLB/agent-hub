import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, type BrokerEvent, type BrokerRuntime } from "../src/broker/server.ts";
import type { Database } from "bun:sqlite";
import { Bus, type PublishResult } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { verifyPublicFrame, sealFrame, openFrame } from "../src/rooms/wire.ts";
import { RoomNotSentError, type RoomLink, type RoomLinkApplication } from "../src/rooms/link.ts";
import { RoomStore, RoomStoreError, RoomApplicationLimitError, ROOM_APPLICATION_RETENTION } from "../src/rooms/store.ts";
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
  modelScreen?: boolean;
  screenLabel?: "pii" | "clear";
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
  chat = new RoomChat({ bus, cwd, now: () => control.now, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false, modelScreenOn: () => control.modelScreen === true,
    screen: async () => ({ label: control.screenLabel ?? "clear", ms: 0 }), policyVersion: () => control.policyVersion ?? 1,
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
  root: string; broker: BrokerRuntime; event: Signal; control: Control; frames: { sender: string; digest: string; phase: string; ephemeral: boolean }[];
  brokerEvents: { event: BrokerEvent; member?: string; code?: string }[]; a: Hub; b: Hub; owner: string; guest: string;
  restart(which: "a" | "b"): Promise<Hub>; close(): Promise<void>;
}
function fillApplicationIdentityCap(receiver: Hub, remoteSender: string, now: number): void {
  const store = receiver.store!;
  const db = (store as unknown as { db: Database }).db;
  const room = store.get("work")!.current.room;
  const application = db.query("INSERT INTO applications(room,sender,application,content_hash,primary_digest,peer,trace,hop,state,created_at) VALUES(?,?,?,?,?,?,?,0,'needs_review',?)");
  const frame = db.query("INSERT INTO application_frames(room,digest,sender,application) VALUES(?,?,?,?)");
  db.transaction(() => {
    for (let n = 1; n < ROOM_APPLICATION_RETENTION.identitiesPerRoom; n++) {
      const id = crypto.randomUUID(), bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setUint32(28, n);
      const digest = encodeBase64url(bytes);
      application.run(room, remoteSender, id, digest, digest, "codex", crypto.randomUUID(), now);
      frame.run(room, digest, remoteSender, id);
    }
  })();
}
const meshes: Mesh[] = [];
afterEach(async () => { for (const mesh of meshes.splice(0).reverse()) await mesh.close(); });
async function mesh(ackSeconds = 600, brokerQueueCap?: number, legacyFrames = false): Promise<Mesh> {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-delivery-")), event = signals();
  const control: Control = { now: Date.now(), phase: "setup", hold: false, entered: false, gate: deferred() }, frames: Mesh["frames"] = [], brokerEvents: Mesh["brokerEvents"] = [];
  const brokerRoot = join(root, "broker");
  const broker = await startBroker({ stateDir: brokerRoot, port: 0, ...(brokerQueueCap ? { limits: { queuedPerRoom: brokerQueueCap } } : {}) }, {
    log: (kind, ids) => { brokerEvents.push({ event: kind, ...(ids.member ? { member: ids.member } : {}), ...(ids.code ? { code: ids.code } : {}) }); event.notify(); },
    verifyFrame: async input => {
      if (legacyFrames) {
        const frame = JSON.parse(new TextDecoder().decode(input.wire)) as Record<string, unknown>;
        const oldKeys = ["v", "type", "room", "epoch", "sender", "recipients", "seq", "nonce", "ciphertext", "signature"];
        if (Object.keys(frame).sort().join(",") !== oldKeys.sort().join(",")) throw new Error("old broker closed frame grammar refused an added field");
      }
      const proof = await verifyPublicFrame(input); frames.push({ sender: proof.sender, digest: proof.digest, phase: control.phase, ephemeral: proof.ephemeral === true });
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

for (const state of ["dispatching", "accepted"] as const) test(`sender ${state} resumes the same application after restart`, async () => {
  const f = await mesh(), env = newEnvelope("codex", `uncertain ${state}`, { to: ["codex@beta"] });
  if (state === "dispatching") { f.control.holdSender = f.owner; f.control.hold = true; }
  else f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) throw new Error("fixture interrupted after durable local publication"); };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === state && (state !== "dispatching" || f.control.entered), `outbound ${state} persisted`);
  const disconnectAt = f.brokerEvents.length;
  await f.a.close();
  await f.event.wait(() => f.brokerEvents.slice(disconnectAt).some(row => row.event === "disconnected" && row.member === f.owner), "old sender socket fenced");
  f.control.hold = false; f.control.gate.release(); f.control.afterPublication = undefined; f.control.phase = "after";
  await f.restart("a");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)" && f.a.bus.stateOf("codex@beta") === "idle", "sender resumed active intent");
  const before = new Set(f.frames.filter(row => row.sender === f.owner && row.phase === "before").map(row => row.digest));
  expect(f.frames.some(row => row.sender === f.owner && row.phase === "after" && !before.has(row.digest))).toBe(true);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(original => original.id === env.id))).toBe(false);
});

test("a receiver offline for fifteen minutes gets every queued message exactly once", async () => {
  const f = await mesh(600), disconnectAt = f.brokerEvents.length;
  await f.b.close();
  await f.event.wait(() => f.brokerEvents.slice(disconnectAt).some(row => row.event === "disconnected" && row.member === f.guest), "receiver transport offline");
  const messages = ["offline message one", "offline message two", "offline message three"].map(body => newEnvelope("user", body, { to: ["codex@beta"] }));
  for (const env of messages) expect(f.a.bus.publish(env)).toEqual(["codex@beta"]);
  await f.event.wait(async () => (await outbound(f.a, messages[0]!.id))?.state === "accepted", "first ciphertext retained at broker");
  f.control.now += 15 * 60_000;
  f.a.chat.tick();
  expect((await outbound(f.a, messages[0]!.id))?.state).not.toBe("needs_review");
  await f.restart("b");
  await f.event.wait(async () => (await Promise.all(messages.map(env => outbound(f.a, env.id)))).every(row => row?.state === "completed (admitted)"), "all offline messages admitted after receiver returns");
  for (const env of messages) expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.journal.unresolved("codex@beta").some(row => messages.some(env => row.originals.some(original => original.id === env.id)))).toBe(false);
});

test("a proven pre-durable not-sent result requeues until the room is online", async () => {
  const f = await mesh(), env = newEnvelope("user", "not sent before durable queue", { to: ["codex@beta"] });
  const link = f.a.link!, publishApplication = link.publishApplication.bind(link); let refused = false;
  link.publishApplication = async (message, recipient, outgoing, current) => {
    if (!refused) { refused = true; throw new RoomNotSentError(); }
    return publishApplication(message, recipient, outgoing, current);
  };
  expect(f.a.bus.publish(env)).toEqual(["codex@beta"]);
  await f.event.wait(() => refused && f.a.bus.pendingEnvelopes("codex@beta").some(row => row.id === env.id), "not-sent envelope requeued");
  expect((await outbound(f.a, env.id))).toBeUndefined();
  expect(f.a.journal.list("codex@beta").find(row => row.originals.some(original => original.id === env.id))?.state).toBe("queued");
  await f.restart("a");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "online wake retries requeued envelope");
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
});

test("an atomic outbox capacity refusal requeues the original Bus envelope and retries after online", async () => {
  const f = await mesh(), env = newEnvelope("user", "store capacity refusal before commit", { to: ["codex@beta"] });
  const store = f.a.store!, queueApplication = store.queueApplication.bind(store); let refused = false;
  store.queueApplication = async (name, wire, input, current) => {
    if (!refused) { refused = true; throw new RoomStoreError("limit"); }
    return queueApplication(name, wire, input, current);
  };
  f.a.bus.publish(env);
  await f.event.wait(() => refused && f.a.bus.pendingEnvelopes("codex@beta").some(row => row.id === env.id), "atomic limit refusal safely requeued");
  expect((await outbound(f.a, env.id))).toBeUndefined();
  expect(f.a.journal.list("codex@beta").find(row => row.originals.some(original => original.id === env.id))?.state).toBe("queued");
  await f.restart("a");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "requeued envelope sends after online");
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
});

test("an unclassified queue failure without a durable outbox row does not stay dispatching", async () => {
  const f = await mesh(), env = newEnvelope("user", "unknown queue failure", { to: ["codex@beta"] });
  const store = f.a.store!, queueApplication = store.queueApplication.bind(store); let failed = false;
  store.queueApplication = async (name, wire, input, current) => {
    if (!failed) { failed = true; throw new Error("unknown durable queue failure"); }
    return queueApplication(name, wire, input, current);
  };
  f.a.bus.publish(env);
  await f.event.wait(() => f.a.journal.list("codex@beta").some(row => row.state === "needs_review" && row.originals.some(original => original.id === env.id)), "unknown no-row failure is held for review");
  const row = f.a.journal.list("codex@beta").find(item => item.originals.some(original => original.id === env.id))!;
  expect(row.state).toBe("needs_review");
  expect(f.a.store!.applicationOutbox("work").some(item => item.deliveryId === row.id)).toBe(false);
  const later = newEnvelope("user", "later delivery passes failed queue head", { to: ["codex@beta"] });
  f.a.bus.publish(later);
  await f.event.wait(async () => (await outbound(f.a, later.id))?.state === "completed (admitted)", "unclassified failure does not block the remote FIFO");
  expect(f.b.peer.got.filter(item => item.id === later.id)).toHaveLength(1);
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

test("a locally stored signed receipt replays after receiver restart before broker storage", async () => {
  const f = await mesh(), env = newEnvelope("user", "receipt survives receiver restart", { to: ["codex@beta"] });
  const oldReceiver = f.b.peer; let inboundDigest: string | undefined;
  f.control.holdSender = f.guest; f.control.hold = true;
  f.control.afterReceive = (label, input) => { if (label === "beta" && input.message?.type === "chat" && input.message.envelope.id === env.id) inboundDigest = input.digest; };
  f.a.bus.publish(env);
  await f.event.wait(() => !!inboundDigest && f.control.entered && f.b.store?.receiptStored("work", inboundDigest) !== undefined, "signed receipt durably stored before broker ACK");
  expect(oldReceiver.got.filter(row => row.id === env.id)).toHaveLength(1);
  await f.restart("b");
  await f.event.wait(() => f.b.store?.receiptStored("work", inboundDigest!) !== undefined, "restarted receiver binds the durable receipt outbox");
  expect(f.b.store!.receiptStored("work", inboundDigest!)).toBeDefined();
  f.control.hold = false; f.control.gate.release(); f.b.link!.refresh(); f.event.notify();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "replayed receipt settles sender delivery");
  await f.event.wait(() => f.b.store?.receiptStored("work", inboundDigest!) === undefined, "broker queue ACK retires the receiver receipt proof");
  const receiverInstances = new Set([oldReceiver, f.b.peer]);
  expect([...receiverInstances].reduce((count, peer) => count + peer.got.filter(row => row.id === env.id).length, 0)).toBe(1);
  expect(f.b.store!.receiptStored("work", inboundDigest!)).toBeUndefined();
});

test("a signed TTL receipt reconciles when its store commit beats the Bus CAS and sender restart", async () => {
  const f = await mesh(1), env = newEnvelope("user", "late receipt wins the TTL boundary race", { to: ["codex@beta"] });
  const oldReceiver = f.b.peer; let inboundDigest: string | undefined;
  f.control.holdSender = f.guest; f.control.hold = true;
  f.control.afterReceive = (label, input) => { if (label === "beta" && input.message?.type === "chat" && input.message.envelope.id === env.id) inboundDigest = input.digest; };
  f.a.bus.publish(env);
  await f.event.wait(() => !!inboundDigest && f.control.entered && f.b.store?.receiptStored("work", inboundDigest) !== undefined, "signed receipt held after local commit");
  const saved = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
  const settle = f.a.bus.settleRemoteReceipt.bind(f.a.bus); let failOnce = true;
  f.a.bus.settleRemoteReceipt = (source, id, outcome, reason, current) => {
    if (failOnce) { failOnce = false; return false; }
    return settle(source, id, outcome, reason, current);
  };
  f.control.now = saved.expiresAt + 1; // Receipt arrival races TTL before the timer has moved Bus to needs_review.
  f.control.hold = false; f.control.gate.release();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "room store commits the late signed outcome");
  const deliveryId = String((await outbound(f.a, env.id))?.id);
  expect(f.a.journal.get(deliveryId)?.state).toBe("accepted");
  await f.restart("a");
  await f.event.wait(() => f.a.journal.get(deliveryId)?.state === "completed", "online reconciliation settles the saved signed outcome");
  const receiverInstances = new Set([oldReceiver, f.b.peer]);
  expect([...receiverInstances].reduce((count, peer) => count + peer.got.filter(row => row.id === env.id).length, 0)).toBe(1);
  expect(f.b.store!.receiptStored("work", inboundDigest!)).toBeUndefined();
});

test("a late signed admission receipt settles needs_review once", async () => {
  const f = await mesh(1), env = newEnvelope("codex", "late receipt evidence", { to: ["codex@beta"] });
  const settled: string[] = [];
  f.a.bus.tap(event => { if (event.t === "remote_delivery_settled") settled.push(event.deliveryId); });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "accepted" && f.control.entered, "recipient receipt held after broker storage");
  const saved = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
  f.control.now = saved.expiresAt + 1; f.a.chat.tick(); f.event.notify();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "local room TTL reached");
  const later = newEnvelope("user", "later delivery passes needs_review", { to: ["codex@beta"] });
  f.a.bus.publish(later);
  await f.event.wait(() => f.b.peer.got.some(row => row.id === later.id), "later remote delivery does not wait for person disposition");
  expect((await outbound(f.a, env.id))?.state).toBe("needs_review");
  f.control.hold = false; f.control.gate.release();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.lateReceipt === "completed (admitted)", "late signed evidence displayed");
  await f.event.wait(async () => (await outbound(f.a, later.id))?.state === "completed (admitted)", "later delivery receipt settles");
  const settledRow = await outbound(f.a, env.id);
  expect(settledRow).toMatchObject({ state: "completed (admitted)", lateReceipt: "completed (admitted)" });
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(original => original.id === env.id))).toBe(false);
  expect(settled.filter(id => id === String(settledRow?.id))).toHaveLength(1);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
});

test("a changed privacy proof cannot alter the body under a retained application id", async () => {
  const f = await mesh(1), env = newEnvelope("user", "clear body before privacy policy changes", { to: ["codex@beta"] });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "accepted" && f.control.entered, "original application and held receipt stored");
  const initialFrames = f.frames.filter(row => row.sender === f.owner).length;
  f.control.modelScreen = true; f.control.screenLabel = "pii";
  await acknowledgementDeadline(f, f.a, env.id);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "changed privacy proof quarantines the immutable application");
  expect(f.frames.filter(row => row.sender === f.owner)).toHaveLength(initialFrames);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  const saved = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
  expect(saved).toMatchObject({ state: "needs_review", reason: "boundary_refused" });
  expect(f.a.journal.get(saved.deliveryId)?.state).toBe("needs_review");
  expect(f.a.store!.outbox("work").some(row => row.digest === saved.digest)).toBe(false);
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
  await f.event.wait(async () => (await outbound(f.b, reply.id))?.state === "completed (inbox)", "later matching signed inbox receipt processed");
  expect(f.a.store!.listPersonInbox("work")).toHaveLength(1);
  expect(f.a.peer.got.some(row => row.id === reply.id)).toBe(false);
  expect(receiver.pendingInbox("work")).toHaveLength(1);
  const attempts = f.control.blockedAttempts;
  await rows(f.b); await rows(f.b); expect(f.control.blockedAttempts).toBe(attempts); // Room status is a pure read.
  f.control.blockIncoming = false;
  await command(f.b, "resolve", { name: "work", frame: holdDigest, action: "discard" });
  await f.event.wait(async () => (await outbound(f.a, blocked.id))?.state === "completed (admitted)", "person disposition retries retained plaintext");
  expect(f.b.peer.got.filter(row => row.id === blocked.id)).toHaveLength(1); expect(receiver.pendingInbox("work")).toEqual([]);
});

test("a deferred inbound chat is ACKed after durable inbox storage and later sends its committed receipt", async () => {
  const f = await mesh(), env = newEnvelope("user", "inbox commit precedes broker ACK", { to: ["codex@beta"] });
  let receiptCommits = 0, receiptSent = 0;
  f.control.blockIncoming = true; f.control.blockedApplication = env.id;
  f.control.afterSend = async (label, message) => { if (label === "beta" && message.type === "receipt" && message.application === env.id) receiptSent++; };
  f.a.bus.publish(env);
  await f.event.wait(() => (f.control.blockedAttempts ?? 0) > 0 && f.b.store!.pendingInbox("work").some(row => row.plaintext !== undefined)
    && f.broker.stats().queuedFrames === 0, "broker ACK follows durable inbox commit while admission is deferred");
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(0);
  expect((await outbound(f.a, env.id))?.state).toBe("accepted");
  f.control.blockIncoming = false;
  const store = f.b.store!, queueReceipt = store.queueReceipt.bind(store); let receiptCommitted = false;
  store.queueReceipt = async (name, inboundDigest, wire, options, current) => {
    const row = await queueReceipt(name, inboundDigest, wire, options, current);
    receiptCommitted = true;
    return row;
  };
  await f.b.chat.retryPending("work");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "deferred admission sends a signed receipt");
  expect(receiptCommitted).toBe(true); expect(receiptSent).toBe(1);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.b.store!.pendingInbox("work")).toEqual([]);
});

test("discarding a person inbox entry frees shared application capacity and retries retained native work once", async () => {
  const f = await mesh(); let personReceiptSends = 0, nativeReceives = 0;
  const person = newEnvelope("codex", "person inbox capacity release", { to: ["user@beta"], priority: "status" });
  f.control.afterSend = async (label, message) => {
    if (label === "beta" && message.type === "receipt" && message.application === person.id) personReceiptSends++;
  };
  expect(f.a.bus.publish(person)).toEqual(["user@beta"]);
  await f.event.wait(async () => (await outbound(f.a, person.id))?.state === "completed (inbox)" && personReceiptSends === 1, "person inbox admission receipt");
  const inbox = f.b.store!.listPersonInbox("work")[0]!;
  expect(inbox.state).toBe("unread");

  fillApplicationIdentityCap(f.b, f.owner, f.control.now);
  const native = newEnvelope("user", "native work waits for person disposition", { to: ["codex@beta"] });
  f.control.afterReceive = (label, input) => {
    if (label === "beta" && input.message?.type === "chat" && input.message.envelope.id === native.id) nativeReceives++;
  };
  expect(f.a.bus.publish(native)).toEqual(["codex@beta"]);
  await f.event.wait(() => f.b.notices.some(row => row.code === "application_capacity"), "shared application identity cap reached");
  expect(nativeReceives).toBe(1);
  expect(f.b.store!.pendingInbox("work")).toHaveLength(1);
  expect(f.b.peer.got.some(row => row.id === native.id)).toBe(false);

  const disposed = await f.b.commands.inboxDispose(inbox.id, "discard", () => true);
  expect(disposed?.state).toBe("discarded");
  f.b.commands.retryInboxPending(); // The daemon does this only after its successful disposition reply.
  await f.event.wait(() => nativeReceives === 2 && f.b.peer.got.some(row => row.id === native.id)
    && f.b.store!.pendingInbox("work").length === 0, "discard retries the retained native chat once");
  await f.event.wait(async () => (await outbound(f.a, native.id))?.state === "completed (admitted)", "native admission receipt returned");
  expect(f.b.peer.got.filter(row => row.id === native.id)).toHaveLength(1);
  expect((await outbound(f.a, person.id))?.state).toBe("completed (inbox)");
  expect(personReceiptSends).toBe(1); // Disposition never issues a second person application receipt.
  expect(f.b.notices.filter(row => row.code === "application_capacity")).toHaveLength(1);
});

test("only an actual inbox TTL purge retries blocked work, and its late receipt settles the sender row", async () => {
  const f = await mesh(); let personReceiptSends = 0, nativeReceives = 0;
  const person = newEnvelope("codex", "person inbox TTL capacity release", { to: ["user@beta"], priority: "status" });
  f.control.afterSend = async (label, message) => {
    if (label === "beta" && message.type === "receipt" && message.application === person.id) personReceiptSends++;
  };
  expect(f.a.bus.publish(person)).toEqual(["user@beta"]);
  await f.event.wait(async () => (await outbound(f.a, person.id))?.state === "completed (inbox)" && personReceiptSends === 1, "person inbox admission receipt");
  const inbox = f.b.store!.listPersonInbox("work")[0]!;
  fillApplicationIdentityCap(f.b, f.owner, f.control.now);
  const native = newEnvelope("user", "native work waits for inbox expiry", { to: ["codex@beta"] });
  f.control.afterReceive = (label, input) => {
    if (label === "beta" && input.message?.type === "chat" && input.message.envelope.id === native.id) nativeReceives++;
  };
  expect(f.a.bus.publish(native)).toEqual(["codex@beta"]);
  await f.event.wait(() => f.b.notices.some(row => row.code === "application_capacity"), "shared application identity cap reached");
  expect(nativeReceives).toBe(1);
  expect(f.b.store!.pendingInbox("work")).toHaveLength(1);

  const noticeCount = f.b.notices.filter(row => row.code === "application_capacity").length;
  f.b.commands.expireInbox(); // Unchanged expiry state must not trigger a plaintext retry.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(nativeReceives).toBe(1);
  expect(f.b.notices.filter(row => row.code === "application_capacity")).toHaveLength(noticeCount);
  expect(f.b.store!.pendingInbox("work")).toHaveLength(1);

  const nativeOutbox = f.a.store!.applicationOutbox("work").find(row => row.application === native.id)!;
  f.control.now = nativeOutbox.ackDeadline! + 1;
  f.a.chat.tick(); // The ACK deadline triggers another attempt without a person disposition.
  expect((await outbound(f.a, native.id))?.state).not.toBe("needs_review");
  f.control.now = inbox.expiresAt + 1; f.a.chat.tick();
  const expiredItem = await f.b.commands.inboxShow(inbox.id, () => true);
  expect(expiredItem).toMatchObject({ state: "expired" }); expect(expiredItem).not.toHaveProperty("body");
  f.b.commands.expireInbox(); // Consume the committed purge signal left by show, even though no rows remain due.
  f.b.commands.expireInbox(); // An already consumed signal cannot schedule a second retry.
  await f.event.wait(() => nativeReceives === 2 && f.b.peer.got.some(row => row.id === native.id)
    && f.b.store!.pendingInbox("work").length === 0, "actual TTL purge retries the retained native chat once");
  expect(f.b.peer.got.filter(row => row.id === native.id)).toHaveLength(1);
  await f.event.wait(async () => (await outbound(f.a, native.id))?.state === "completed (admitted)", "late native admission proof settles the sender row");
  expect(await outbound(f.a, native.id)).toMatchObject({ state: "completed (admitted)", lateReceipt: "completed (admitted)" });
  expect((await outbound(f.a, person.id))?.state).toBe("completed (inbox)");
  expect(personReceiptSends).toBe(1); // TTL purge drops local body without a new signed person outcome.
  expect(f.b.notices.filter(row => row.code === "application_capacity")).toHaveLength(noticeCount);
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

test("ACK timeout retries, and only the room TTL moves a frame held before broker storage to needs_review", async () => {
  const f = await mesh(1), env = newEnvelope("user", "not yet stored", { to: ["codex@beta"] });
  f.control.holdSender = f.owner; f.control.hold = true;
  try {
    f.a.bus.publish(env);
    await f.event.wait(() => f.control.entered, "wire verification held before stored reply");
    await acknowledgementDeadline(f, f.a, env.id);
    expect((await outbound(f.a, env.id))?.state).not.toBe("needs_review");
    const saved = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
    f.control.now = saved.expiresAt + 1; f.a.chat.tick(); f.event.notify();
    await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "original room TTL reached");
    expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
    expect(f.a.journal.unresolved("codex@beta").some(row => row.state === "needs_review" && row.originals.some(item => item.id === env.id))).toBe(true);
  } finally { f.control.hold = false; f.control.gate.release(); }
});

test("queue_full keeps the durable frame and retries its digest after broker capacity returns", async () => {
  const f = await mesh(600, 1);
  await f.event.wait(() => f.broker.stats().queuedFrames === 0, "initial ciphertext queues drained");
  const at = f.brokerEvents.length; await f.b.close();
  await f.event.wait(() => f.brokerEvents.slice(at).some(row => row.event === "disconnected" && row.member === f.guest), "recipient link offline");
  // Presence is ephemeral now; use durable ciphertext to occupy the unchanged cap.
  const blocker: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "durable broker capacity blocker", ts: f.control.now } };
  await f.a.link!.publishApplication(blocker, f.guest);
  await f.event.wait(() => f.broker.stats().queuedFrames === 1, "durable chat fills offline broker queue");
  const env = newEnvelope("user", "queue full before stored", { to: ["codex@beta"] });
  const refusalAt = f.brokerEvents.length; f.a.bus.publish(env);
  await f.event.wait(() => {
    const target = f.a.store!.applicationOutbox("work").find(row => row.application === env.id);
    return target !== undefined
      && f.frames.some(frame => frame.sender === f.owner && frame.digest === target.digest)
      && f.brokerEvents.slice(refusalAt).some(row => row.event === "refused" && row.member === f.owner && row.code === "queue_full");
  }, "fresh wire queue_full after this application reached broker verification");
  const target = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
  expect(f.broker.stats().queuedFrames).toBe(1);
  expect(target.state).toBe("dispatching");
  expect(f.a.store!.outbox("work").some(row => row.digest === target.digest)).toBe(true);
  expect(f.b.peer.got.some(row => row.id === env.id)).toBe(false);
  await f.restart("b");
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "backoff retries after offline broker capacity drains");
  expect(f.frames.filter(frame => frame.sender === f.owner && frame.digest === target.digest).length).toBeGreaterThanOrEqual(2);
  expect(f.a.store!.applicationOutbox("work").filter(row => row.application === env.id).map(row => row.digest)).toEqual([target.digest]);
  expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
  expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(item => item.id === env.id))).toBe(false);
  expect((await f.a.commands.rows("work"))[0]?.state).toBe("online");
});

test("a receipt behind rejected reconnect presence lets a cap-one broker release the admitted chat", async () => {
  const f = await mesh(600, 1);
  await f.event.wait(() => f.broker.stats().queuedFrames === 0, "initial ciphertext queues drained");
  const at = f.brokerEvents.length; await f.b.close();
  await f.event.wait(() => f.brokerEvents.slice(at).some(row => row.event === "disconnected" && row.member === f.guest), "recipient link offline");
  const env = newEnvelope("user", "admit once through cap-one reconnect", { to: ["codex@beta"] });
  f.a.bus.publish(env);
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "accepted" && f.broker.stats().queuedFrames === 1, "actual application occupies the only broker slot");
  const eventsBefore = f.brokerEvents.length, framesBefore = f.frames.length;
  // Hold verification of beta's initial presence while its application is admitted.
  // The chat cannot be ACKed through the ordinary receipt-send path while that
  // presence owns beta's transport head, forcing the known-queue_full exception.
  f.control.holdSender = f.guest; f.control.hold = true;
  try {
    await f.restart("b");
    await f.event.wait(() => f.control.entered && f.b.peer.got.some(row => row.id === env.id), "reconnect presence is in flight while beta has admitted the original chat");
    expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    expect(f.frames.slice(framesBefore).some(frame => frame.sender === f.guest && frame.ephemeral)).toBe(true);
    f.control.hold = false; f.control.gate.release();
    await f.event.wait(async () => f.brokerEvents.slice(eventsBefore).some(row => row.event === "refused" && row.member === f.guest && row.code === "queue_full")
      && f.frames.slice(framesBefore).some(frame => frame.sender === f.guest && !frame.ephemeral)
      && (await outbound(f.a, env.id))?.state === "completed (admitted)", "rejected presence frees the input ACK path and the retained signed receipt follows after capacity returns");
    expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    expect(f.a.store!.applicationOutbox("work").filter(row => row.application === env.id)).toHaveLength(1);
    expect(f.a.journal.unresolved("codex@beta").some(row => row.originals.some(item => item.id === env.id))).toBe(false);
  } finally { f.control.hold = false; f.control.gate.release(); }
});

test("a discarded queue_full application is never retried when broker capacity returns", async () => {
  const f = await mesh(600, 1);
  await f.event.wait(() => f.broker.stats().queuedFrames === 0, "initial ciphertext queues drained");
  const at = f.brokerEvents.length; await f.b.close();
  await f.event.wait(() => f.brokerEvents.slice(at).some(row => row.event === "disconnected" && row.member === f.guest), "recipient link offline");
  const blocker: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "durable blocker before discard", ts: f.control.now } };
  await f.a.link!.publishApplication(blocker, f.guest);
  await f.event.wait(() => f.broker.stats().queuedFrames === 1, "durable chat occupies broker cap");
  const env = newEnvelope("user", "discard this rejected application", { to: ["codex@beta"] });
  const refusalAt = f.brokerEvents.length; f.a.bus.publish(env);
  await f.event.wait(() => {
    const target = f.a.store!.applicationOutbox("work").find(row => row.application === env.id);
    return target !== undefined
      && f.frames.filter(frame => frame.sender === f.owner && frame.digest === target.digest).length >= 2
      && f.brokerEvents.slice(refusalAt).filter(row => row.event === "refused" && row.member === f.owner && row.code === "queue_full").length >= 2;
  }, "queue_full backoff actually retries the retained application before disposition");
  const target = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
  expect(target.state).toBe("dispatching");
  expect(f.a.store!.outbox("work").some(row => row.digest === target.digest)).toBe(true);
  const attemptsBeforeDiscard = f.frames.filter(frame => frame.sender === f.owner && frame.digest === target.digest).length;
  expect(attemptsBeforeDiscard).toBeGreaterThanOrEqual(2);
  f.control.now = target.expiresAt + 1; f.a.chat.tick(); f.event.notify();
  await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "needs_review", "refused application original TTL reached");
  const row = (await outbound(f.a, env.id))!, id = String(row.id), before = f.a.journal.get(id)!;
  f.a.bus.resolveDelivery(id, before.revision, "discard", "person discards rejected room application");
  f.a.chat.tick();
  expect(f.a.store!.applicationOutbox("work").find(item => item.deliveryId === id)?.disposition).toBe("discard");
  expect(f.a.store!.outbox("work").some(item => item.digest === target.digest)).toBe(false);
  await f.restart("b");
  await f.event.wait(() => f.broker.stats().queuedFrames === 0 && f.a.bus.stateOf("codex@beta") === "idle", "receiver drains capacity after discarded application");
  const probe = newEnvelope("user", "fresh chat after discarded retry", { to: ["codex@beta"] });
  f.a.bus.publish(probe);
  // A new send behind the old in-memory retry head is the non-vacuous fence:
  // the probe cannot complete until that head has been retired or sent.
  await f.event.wait(async () => (await outbound(f.a, probe.id))?.state === "completed (admitted)", "fresh probe passes the retired retry head");
  expect(f.b.peer.got.filter(item => item.id === probe.id)).toHaveLength(1);
  expect(f.b.peer.got.some(item => item.id === env.id)).toBe(false);
  expect(f.frames.filter(frame => frame.sender === f.owner && frame.digest === target.digest)).toHaveLength(attemptsBeforeDiscard);
});

test("a replaced presence snapshot keeps its pending reply request until the recipient answers", async () => {
  const f = await mesh(), gate = deferred();
  const blocker: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "hold recipient before queued presence", ts: f.control.now } };
  const online = f.a.chat.application.online, receive = f.b.chat.application.receive;
  const alphaAccept = f.a.store!.replay.accept, betaAccept = f.b.store!.replay.accept;
  const observations: { recipient: "alpha" | "beta"; requestReply: boolean; state: unknown }[] = [];
  let entered = false, prime = true;
  const observe = (recipient: "alpha" | "beta", input: Parameters<typeof alphaAccept>[0]) => {
    const packet = JSON.parse(new TextDecoder().decode(input.plaintext)) as { type: string; requestReply?: boolean; peers?: { id: string; state: string }[] };
    if (packet.type === "presence") {
      observations.push({ recipient, requestReply: packet.requestReply === true, state: packet.peers?.find(peer => peer.id === "codex")?.state });
      f.event.notify();
    }
  };
  // Observe only plaintext already signature-checked by the real receiving link;
  // production replay admission still runs, and the broker remains ciphertext-only.
  f.a.store!.replay.accept = async input => { observe("alpha", input); return alphaAccept(input); };
  f.b.store!.replay.accept = async input => { observe("beta", input); return betaAccept(input); };
  f.b.chat.application.receive = async (context, input) => {
    if (input.message?.type === "chat" && input.message.envelope.id === blocker.envelope.id) {
      entered = true; f.event.notify(); await gate.promise;
    }
    return receive(context, input);
  };
  f.a.chat.application.online = async context => {
    await online(context);
    if (prime) { prime = false; await context.link.publishApplication(blocker, f.guest); }
  };
  try {
    f.control.phase = "pending-presence-request"; f.a.link!.refresh();
    await f.event.wait(() => entered && f.frames.some(frame => frame.sender === f.owner && frame.ephemeral && frame.phase === "pending-presence-request"), "request presence queued behind the recipient's unacknowledged durable packet");
    const beforeReplacement = observations.length, betaBeforeReplacement = observations.filter(row => row.recipient === "beta").length;
    const freshObservations = () => observations.slice(beforeReplacement);
    f.control.phase = "replacement-presence";
    f.a.bus.pause("codex"); await f.a.link!.publishPresence();
    await f.event.wait(() => f.frames.some(frame => frame.sender === f.owner && frame.ephemeral && frame.phase === "replacement-presence") && f.broker.stats().queuedFrames === 2, "normal state update replaces the pending broker presence");
    expect(observations.filter(row => row.recipient === "beta")).toHaveLength(betaBeforeReplacement);
    gate.release();
    await f.event.wait(() => freshObservations().some(row => row.recipient === "beta" && row.state === "paused" && row.requestReply) && freshObservations().some(row => row.recipient === "alpha"), "recipient answers the request carried by the replacement snapshot");
    expect(freshObservations().filter(row => row.recipient === "alpha").every(row => !row.requestReply)).toBe(true);
    // Forward chat barriers flush both transports without changing alpha's native
    // paused state. Reply snapshots must not request another reply or echo forever.
    for (let n = 0; n < 3; n++) {
      const env = newEnvelope("user", `presence reply-loop barrier ${n}`, { to: ["codex@beta"] });
      f.a.bus.publish(env);
      await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "forward transport barrier after presence reply");
      expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    }
    expect(freshObservations().filter(row => row.recipient === "alpha").every(row => !row.requestReply)).toBe(true);
    expect(observations.length - beforeReplacement).toBeLessThanOrEqual(8);
    expect(f.b.bus.stateOf("codex@alpha")).toBe("paused");
  } finally {
    gate.release(); f.a.chat.application.online = online; f.b.chat.application.receive = receive;
    f.a.store!.replay.accept = alphaAccept; f.b.store!.replay.accept = betaAccept;
  }
}, 20000);

test("new links retain the closed legacy frame shape when a broker does not advertise ephemeral", async () => {
  const NativeWebSocket = globalThis.WebSocket, readyKeys: string[][] = [];
  let dials = 0, f: Mesh | undefined;
  // Exercise the old broker branch over real authenticated sockets. The only
  // interception is removing the new request header, which old brokers ignore.
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, options?: Bun.WebSocketOptions | string | string[]) {
      if (options && typeof options === "object" && !Array.isArray(options)) {
        const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "x-agent-hub-ephemeral"));
        super(url, { ...options, headers });
      } else super(url, options);
      dials++;
      this.addEventListener("message", event => {
        try {
          const packet = JSON.parse(new TextDecoder().decode(event.data)) as Record<string, unknown>;
          if (packet.type === "ready") readyKeys.push(Object.keys(packet).sort());
        } catch { /* Other transport messages are checked by the real RoomLink. */ }
      });
    }
  };
  try {
    f = await mesh(600, undefined, true);
    const dialsBefore = dials, eventsBefore = f.brokerEvents.length;
    f.a.bus.pause("codex"); await f.a.link!.publishPresence();
    await f.event.wait(() => f!.b.bus.stateOf("codex@alpha") === "paused", "legacy presence state delivered");
    f.a.bus.resume("codex"); await f.a.link!.publishPresence();
    await f.event.wait(() => f!.b.bus.stateOf("codex@alpha") === "idle", "legacy presence state restored");
    const env = newEnvelope("user", "chat over old broker frame contract", { to: ["codex@beta"] });
    f.a.bus.publish(env);
    await f.event.wait(async () => (await outbound(f!.a, env.id))?.state === "completed (admitted)", "legacy broker chat admitted");
    expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    expect(readyKeys.length).toBeGreaterThan(0);
    for (const keys of readyKeys) expect(keys).toEqual(["digest", "epoch", "member", "room", "type", "v"]);
    expect(f.frames.length).toBeGreaterThan(0);
    expect(f.frames.every(frame => !frame.ephemeral)).toBe(true);
    expect(dials).toBe(dialsBefore);
    expect(f.brokerEvents.slice(eventsBefore).some(row => row.event === "refused" || row.event === "disconnected")).toBe(false);
  } finally { await f?.close(); globalThis.WebSocket = NativeWebSocket; }
}, 20000);

test("1000 presence flips with an offline member leave online chat usable and identical presence dedupes", async () => {
  const f = await mesh();
  const c = await hub(f.root, "gamma", f.event, f.control, 600);
  try {
    const invitation = await command(f.a, "invite", { name: "work" });
    const request = await command(c, "join", { name: "work", token: invitation.artifact, label: "gamma" });
    const roster = await command(f.a, "invite", { name: "work", request: request.artifact });
    await command(c, "join", { name: "work", roster: roster.artifact });
    await f.event.wait(() => f.a.bus.stateOf("codex@gamma") === "idle" && f.b.bus.stateOf("codex@gamma") === "idle", "third member roster/presence reaches both online hubs");
    const at = f.brokerEvents.length; await c.close();
    await f.event.wait(() => f.brokerEvents.slice(at).some(row => row.event === "disconnected" && row.member === request.member), "third member offline");
    f.control.phase = "presence-flips";
    let flips = 0;
    for (; flips < 1000; flips++) {
      if (flips % 2 === 0) f.a.bus.pause("codex"); else f.a.bus.resume("codex");
      await f.a.link!.publishPresence();
    }
    expect(flips).toBe(1000);
    // Coalescing is part of the presence contract. A forward chat fences the
    // actual sends without forcing 1,000 crypto/receiver-storage round trips.
    const env = newEnvelope("user", "online chat after presence flood", { to: ["codex@beta"] });
    f.a.bus.publish(env);
    await f.event.wait(async () => (await outbound(f.a, env.id))?.state === "completed (admitted)", "online chat admits after 1000 offline-member presence flips");
    expect(f.b.peer.got.filter(row => row.id === env.id)).toHaveLength(1);
    expect(f.b.bus.stateOf("codex@alpha")).toBe("idle");
    expect(f.frames.filter(frame => frame.sender === f.owner && frame.ephemeral && frame.phase === "presence-flips").length).toBeGreaterThan(0);
    await f.event.wait(() => f.broker.stats().queuedFrames === 0, "online presence drains despite offline member");
    const before = f.frames.filter(frame => frame.sender === f.owner && frame.ephemeral).length;
    for (let n = 0; n < 20; n++) await f.a.link!.publishPresence();
    const barrier = newEnvelope("user", "unchanged presence transport barrier", { to: ["codex@beta"] });
    f.a.bus.publish(barrier);
    await f.event.wait(async () => (await outbound(f.a, barrier.id))?.state === "completed (admitted)", "unchanged presence calls precede the forward transport barrier");
    expect(f.frames.filter(frame => frame.sender === f.owner && frame.ephemeral).length).toBe(before);
    expect(f.brokerEvents.some(row => row.event === "refused" && row.code === "queue_full")).toBe(false);
  } finally { await c.close(); }
}, 20000);

test("room status never reconciles person dispositions, while the explicit tick does", async () => {
  const f = await mesh(1), env = newEnvelope("user", "disposition read purity", { to: ["codex@beta"] });
  f.control.afterPublication = (label, incoming) => { if (label === "beta" && incoming.id === env.id) { f.control.holdSender = f.guest; f.control.hold = true; } };
  try {
    f.a.bus.publish(env);
    await f.event.wait(() => f.control.entered, "recipient signed receipt held before clock advance");
    const saved = f.a.store!.applicationOutbox("work").find(row => row.application === env.id)!;
    f.control.now = saved.expiresAt + 1; f.a.chat.tick(); f.event.notify();
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
