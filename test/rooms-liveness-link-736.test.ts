import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { RoomLink, type RoomPresencePeer } from "../src/rooms/link.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { createInvite, createJoin, createRoomEpoch } from "../src/rooms/wire.ts";

const roots: string[] = [], stores: RoomStore[] = [], links: RoomLink[] = [], brokers: BrokerRuntime[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop()));
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room liveness barrier timed out")), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function fixture(third = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-liveness-")); roots.push(root);
  const opened = async (name: string) => { const store = await RoomStore.open({ stateDir: join(root, name) }); stores.push(store); return store; };
  const owner = await opened("owner"), guest = await opened("guest");
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0, owners: [owner.identity.public.fingerprint] }); brokers.push(broker);
  const created = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "work", broker: broker.publicUrl, wire: created.wire, expectedDigest: null });
  const enroll = async (store: RoomStore, label: string) => {
    const invite = await createInvite({ epoch: owner.get("work")!.current, owner: owner.identity, broker: broker.publicUrl, expiresAt: Date.now() + 60000 });
    await owner.saveInvite("work", invite);
    const request = await createJoin({ invite, identity: store.identity, label, exposedPeers: ["kimi"] });
    store.savePendingJoin("work", { invite, request });
    return owner.enroll("work", request);
  };
  let joined = await enroll(guest, "guest");
  if (third) joined = await enroll(await opened("absent"), "absent");
  await guest.install({ name: "work", broker: broker.publicUrl, wire: joined.wire, expectedDigest: null });
  return { owner, guest, broker };
}
function linked(store: RoomStore, extra: { presence?: () => readonly { id: string; state: string }[]; onPresence?: (value: { member: string; peers: readonly RoomPresencePeer[]; restored?: true }) => void; refreshMs?: number; now?: () => number } = {}) {
  const online = signal();
  const link = new RoomLink({ store, name: "work", ...extra, onState: state => { if (state === "online") online.resolve(); } }); links.push(link);
  return { link, online: () => bounded(online.promise) };
}

test("clean room stop sends signed offline presence to the other hub within five seconds", async () => {
  const f = await fixture(), idle = signal(), offline = signal();
  const owner = linked(f.owner, { presence: () => [{ id: "codex", state: "idle" }] });
  const guest = linked(f.guest, { onPresence: value => {
    if (value.member !== f.owner.identity.public.fingerprint) return;
    if (value.peers.some(peer => peer.id === "codex" && peer.state === "idle")) idle.resolve();
    if (value.peers.some(peer => peer.id === "codex" && peer.state === "offline")) offline.resolve();
  } });
  expect(owner.link.livenessTracked).toBeUndefined();
  await owner.link.start(); await owner.online();
  expect(owner.link.livenessTracked).toBe(true);
  await guest.link.start(); await guest.online(); await bounded(idle.promise);
  const began = Date.now(), stopped = owner.link.stop();
  expect(owner.link.connectionState).toBe("offline");
  expect(owner.link.stop()).toBe(stopped);
  owner.link.refresh();
  await stopped; await bounded(offline.promise);
  expect(Date.now() - began).toBeLessThan(5000);
  expect(f.owner.get("work")!.left).toBe(false);
  expect(f.broker.stats().authenticated).toBe(1);
});

test("idle refresh converges after crossed requests while an absent member remains pending", async () => {
  const f = await fixture(true), initial = signal(), refreshed = signal(); let state = "idle";
  const owner = linked(f.owner, { refreshMs: 100, presence: () => [{ id: "codex", state }] });
  const guest = linked(f.guest, { refreshMs: 100, presence: () => [{ id: "kimi", state: "idle" }], onPresence: value => {
    if (value.member !== f.owner.identity.public.fingerprint) return;
    if (value.peers.some(peer => peer.id === "codex" && peer.state === "idle")) initial.resolve();
    if (value.peers.some(peer => peer.id === "codex" && peer.state === "busy")) refreshed.resolve();
  } });
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online(); await bounded(initial.promise);
  // A is still awaiting absent C when B asks A. A's response must not consume
  // the next periodic request, even though neither hub changes local bus state.
  state = "busy";
  await bounded(refreshed.promise);
  expect(owner.link.connectionState).toBe("online"); expect(guest.link.connectionState).toBe("online");
});

test("signed presence replies do not create a request reply loop", async () => {
  const f = await fixture(), seen = signal(); let observations = 0;
  // A frozen host clock suppresses periodic refresh while real socket traffic
  // completes. Every additional observation would therefore be a reply loop.
  const owner = linked(f.owner, { refreshMs: 50, now: () => 1, presence: () => [{ id: "codex", state: "idle" }] });
  const guest = linked(f.guest, { refreshMs: 50, now: () => 1, onPresence: () => { observations++; seen.resolve(); } });
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online(); await bounded(seen.promise);
  // Two refresh opportunities with a frozen clock add no signed requests.
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(observations).toBeLessThanOrEqual(2);
  expect(f.owner.pendingInbox("work")).toEqual([]); expect(f.guest.pendingInbox("work")).toEqual([]);
});


test("a pending graceful offline attempt fences all new application and presence publication", async () => {
  const f = await fixture(), idle = signal(), offline = signal(), entered = signal(), release = signal();
  const owner = linked(f.owner, { presence: () => [{ id: "codex", state: "idle" }] });
  const guest = linked(f.guest, { onPresence: value => {
    if (value.member !== f.owner.identity.public.fingerprint) return;
    if (value.peers.some(peer => peer.state === "idle")) idle.resolve();
    if (value.peers.some(peer => peer.state === "offline")) offline.resolve();
  } });
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online(); await bounded(idle.promise);
  const reserve = f.owner.sequence.reserve; let reservations = 0;
  f.owner.sequence.reserve = async input => {
    const sequence = await reserve(input); reservations++; entered.resolve(); await release.promise; return sequence;
  };
  const stopped = owner.link.stop();
  try {
    await bounded(entered.promise);
    const internal = owner.link as unknown as { session?: { outbound: { digest: string }[] } };
    const queued = internal.session?.outbound.map(frame => frame.digest);
    await owner.link.publishPresence();
    await expect(owner.link.publishApplication({ v: 1, type: "chat", envelope: {
      id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi",
      kind: "chat", priority: "status", body: "must stay fenced after stop", ts: Date.now(),
    } }, f.guest.identity.public.fingerprint)).rejects.toMatchObject({ code: "unavailable" });
    expect(internal.session?.outbound.map(frame => frame.digest)).toEqual(queued);
    expect(reservations).toBe(1); // Only the authorized final offline frame can seal.
    release.resolve();
    await stopped; await bounded(offline.promise);
    expect(reservations).toBe(1);
  } finally {
    release.resolve(); await stopped; f.owner.sequence.reserve = reserve;
  }
});

test("application quiescence drains an in-flight seal without durable enqueue and releases once", async () => {
  const f = await fixture(), owner = linked(f.owner), entered = signal(), finishSeal = signal();
  await owner.link.start(); await owner.online();
  const reserve = f.owner.sequence.reserve;
  f.owner.sequence.reserve = async input => {
    const sequence = await reserve(input); entered.resolve(); await finishSeal.promise; return sequence;
  };
  const message = { v: 1 as const, type: "chat" as const, envelope: {
    id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi",
    kind: "chat" as const, priority: "status" as const, body: "rotation admission fence", ts: Date.now(),
  } };
  const outgoing = { deliveryId: crypto.randomUUID(), application: message.envelope.id, remotePeer: "kimi@guest",
    recipient: f.guest.identity.public.fingerprint, peer: "kimi", ackTimeoutMs: 1000, ttlMs: 60000 };
  // Attach rejection handling before the host pause cuts this in-flight seal.
  const sending = owner.link.publishApplication(message, f.guest.identity.public.fingerprint, outgoing).then(
    () => { throw new Error("paused seal unexpectedly queued"); }, error => error,
  );
  let release: (() => void) | undefined;
  try {
    await bounded(entered.promise);
    let drained = false;
    const pausing = owner.link.quiesceApplications().then(value => { drained = true; return value; });
    await expect(owner.link.publishApplication(message, f.guest.identity.public.fingerprint, outgoing)).rejects.toMatchObject({ code: "not_sent" });
    expect(drained).toBe(false);
    expect(f.owner.applicationOutbox("work")).toEqual([]);
    finishSeal.resolve();
    expect(await bounded(sending)).toMatchObject({ code: "not_sent" });
    release = await bounded(pausing);
    expect(f.owner.applicationOutbox("work")).toEqual([]);
    await expect(owner.link.publishApplication(message, f.guest.identity.public.fingerprint, outgoing)).rejects.toMatchObject({ code: "not_sent" });
    f.owner.sequence.reserve = reserve;
    release(); release();
    await owner.link.publishApplication(message, f.guest.identity.public.fingerprint, outgoing);
    expect(f.owner.applicationOutbox("work")).toHaveLength(1);
  } finally {
    finishSeal.resolve(); release?.(); f.owner.sequence.reserve = reserve;
    await sending;
  }
});

test("stop preserves an attempted presence when its queue_full timer expires during the final seal", async () => {
  const f = await fixture(), sent: Uint8Array[] = [], entered = signal(), releaseSeal = signal(), finalQueued = signal();
  const row = f.owner.get("work")!;
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { sent.push(Uint8Array.from(wire)); }, close() {} },
    generation: 1, room: row.current.room, broker: row.broker, phase: "ready", roster: { digest: row.current.digest }, ephemeral: true,
    outbound: [] as { digest: string; wire: Uint8Array }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, requestPresenceReply: true,
    queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  const link = new RoomLink({ store: f.owner, name: "work", presence: () => [{ id: "codex", state: "idle" }] }); links.push(link);
  const internal = link as unknown as { running: boolean; generation: number; session: unknown;
    storedFrame(session: unknown, digest: string): void; backoffFrame(session: unknown, digest: string): void;
    queueFrame(session: unknown, wire: Uint8Array, digest: string, ...args: unknown[]): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  const id = crypto.randomUUID();
  const app = await link.publishApplication({ v: 1, type: "chat", envelope: {
    id, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi", kind: "chat", priority: "status", body: "durable during shutdown", ts: Date.now(),
  } }, f.guest.identity.public.fingerprint, { deliveryId: crypto.randomUUID(), application: id, remotePeer: "kimi@guest",
    recipient: f.guest.identity.public.fingerprint, peer: "kimi", ackTimeoutMs: 1000, ttlMs: 60000 });
  internal.storedFrame(session, app);
  await link.publishPresence();
  const attempted = session.outbound[0]!;
  internal.backoffFrame(session, attempted.digest);
  const sentBeforeStop = sent.length, reserve = f.owner.sequence.reserve;
  f.owner.sequence.reserve = async input => { const sequence = await reserve(input); entered.resolve(); await releaseSeal.promise; return sequence; };
  const queueFrame = internal.queueFrame.bind(link);
  internal.queueFrame = (...args) => { queueFrame(...args); finalQueued.resolve(); };
  const stopped = link.stop();
  try {
    await bounded(entered.promise);
    // The existing first queue_full backoff is 250ms. Its timer was registered
    // first, so this later barrier observes its callback even on a loaded host.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(session.frameRetry).toBeUndefined();
    expect(session.outbound[0]).toBe(attempted);
    releaseSeal.resolve(); await bounded(finalQueued.promise);
    expect(session.outbound[0]).toBe(attempted);
    expect(session.outbound).toHaveLength(2);
    expect(sent).toHaveLength(sentBeforeStop); // No retransmit and no offline overtaking.
    await stopped;
    expect(sent).toHaveLength(sentBeforeStop);
    expect(session.outbound).toEqual([]);
    expect(f.owner.applicationOutbox("work")).toHaveLength(1);
    expect(f.owner.applicationOutbox("work")[0]!.application).toBe(id);
  } finally {
    releaseSeal.resolve(); await stopped; f.owner.sequence.reserve = reserve;
  }
});
