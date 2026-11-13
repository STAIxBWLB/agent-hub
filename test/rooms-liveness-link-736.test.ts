import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, type BrokerPorts, type BrokerRuntime } from "../src/broker/server.ts";
import { RoomLink, type RoomPresencePeer, type RoomLinkApplication } from "../src/rooms/link.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { canonicalBytes, createInvite, createJoin, createRoomEpoch, decodeFrame, openFrame, sealFrame, verifyPublicFrame } from "../src/rooms/wire.ts";

import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";
import { FakeBrokerClient } from "./fakes/broker-client.ts";

const clients: FakeBrokerClient[] = [];
const roots: string[] = [], stores: RoomStore[] = [], links: RoomLink[] = [], brokers: BrokerRuntime[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop()));
  for (const client of clients.splice(0)) client.close();
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
async function fixture(third = false, ports?: BrokerPorts) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-liveness-")); roots.push(root);
  const opened = async (name: string) => { const store = await RoomStore.open({ stateDir: join(root, name) }); stores.push(store); return store; };
  const owner = await opened("owner"), guest = await opened("guest");
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0, owners: [owner.identity.public.fingerprint] }, ports); brokers.push(broker);
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
  const observer = third ? await opened("absent") : undefined;
  if (observer) { joined = await enroll(observer, "absent"); await observer.install({ name: "work", broker: broker.publicUrl, wire: joined.wire, expectedDigest: null }); }
  await guest.install({ name: "work", broker: broker.publicUrl, wire: joined.wire, expectedDigest: null });
  return { owner, guest, broker, observer };
}
function linked(store: RoomStore, extra: { presence?: () => readonly { id: string; state: string }[]; onPresence?: (value: { member: string; peers: readonly RoomPresencePeer[]; restored?: true }) => void; refreshMs?: number; now?: () => number; application?: RoomLinkApplication } = {}) {
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

test("idle request reaches connected C after A's crossed broadcast reply replaces its blocked request", async () => {
  let observe: ((wire: Uint8Array) => Promise<void>) | undefined;
  const f = await fixture(true, { verifyFrame: async input => {
    const proof = await verifyPublicFrame(input); await observe?.(input.wire); return proof;
  } });
  const cStore = f.observer!;
  const stored = new Set<string>(), storageWaiters = new Map<string, { resolve: () => void }>(), firstStored = signal(), converged = signal();
  const waitStored = (digest: string) => {
    if (stored.has(digest)) return Promise.resolve();
    const waiter = signal(); storageWaiters.set(digest, waiter); return bounded(waiter.promise);
  };
  const application: RoomLinkApplication = { members() {}, receive: async () => {}, online: async () => {}, stored(_context, input) {
    stored.add(input.digest); firstStored.resolve(); storageWaiters.get(input.digest)?.resolve();
  } };
  let clock = 0;
  const a = linked(f.owner, { refreshMs: 100, now: () => clock, application, presence: () => [{ id: "codex", state: "idle" }], onPresence: value => {
    if (value.member === cStore.identity.public.fingerprint) converged.resolve();
  } });
  const b = linked(f.guest, { refreshMs: 100, now: () => 0, presence: () => [{ id: "kimi", state: "idle" }] });
  await a.link.start(); await a.online(); await bounded(firstStored.promise);
  const c = await FakeBrokerClient.connect(f.broker.publicUrl, cStore.get("work")!.current.room, { "x-agent-hub-ephemeral": "1" }); clients.push(c);
  await c.authenticate(cStore.identity);
  const durable: string[] = [];
  for (let n = 0; n < 8; n++) {
    const digest = await a.link.publishApplication({ v: 1, type: "chat", envelope: {
      id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi", kind: "chat", priority: "status", body: `durable C backlog ${n}`, ts: Date.now(),
    } }, cStore.identity.public.fingerprint);
    await waitStored(digest); durable.push(digest);
  }
  // C is authenticated and already holds the first durable frame without ACK;
  // the other seven durable rows precede every later ephemeral observation.
  const blocked = await c.take("frame");
  const firstDurable = durable[0];
  if (!firstDurable) throw new Error("expected the first of eight durable C packets");
  expect(encodeBase64url(await sha256(blocked))).toBe(firstDurable);
  const requested = signal<string>(), replied = signal<string>();
  observe = async wire => {
    const frame = decodeFrame(wire);
    // The legacy recipient never receives codec advertisements. Observe the same
    // legacy reply as C while retaining the crossed-request assertions below.
    if (frame.codecFeatures || frame.sender !== f.owner.identity.public.fingerprint) return;
    const opened = await openFrame({ wire, identity: cStore.identity, current: cStore.get("work")!.current,
      replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    if (opened.status !== "accepted") throw new Error("expected authenticated A presence");
    const payload = JSON.parse(new TextDecoder().decode(opened.plaintext)) as { type: string; requestReply?: boolean };
    if (payload.type !== "presence") return;
    const digest = encodeBase64url(await sha256(wire));
    if (payload.requestReply === true) requested.resolve(digest); else replied.resolve(digest);
  };
  clock = 100;
  const requestDigest = await bounded(requested.promise); await waitStored(requestDigest);
  const internal = a.link as unknown as { session?: { pendingPresenceReplies: Set<string> } };
  expect(internal.session?.pendingPresenceReplies.has(cStore.identity.public.fingerprint)).toBe(true);
  await b.link.start(); await b.online();
  const replyDigest = await bounded(replied.promise); await waitStored(replyDigest);
  expect(replyDigest).not.toBe(requestDigest);
  expect(internal.session?.pendingPresenceReplies.has(cStore.identity.public.fingerprint)).toBe(true);
  for (let n = 0; n < durable.length; n++) {
    const wire = n === 0 ? blocked : await c.take("frame");
    const expectedDigest = durable[n];
    if (!expectedDigest) throw new Error("expected every durable C packet digest");
    expect(encodeBase64url(await sha256(wire))).toBe(expectedDigest);
    await c.ack(expectedDigest);
  }
  const readPresence = async () => {
    const wire = await c.take("frame"), frame = decodeFrame(wire);
    const opened = await openFrame({ wire, identity: cStore.identity, current: cStore.get("work")!.current,
      replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    if (opened.status !== "accepted") throw new Error("expected authenticated presence at C");
    return { wire, frame, payload: JSON.parse(new TextDecoder().decode(opened.plaintext)) as { type: string; requestReply?: boolean } };
  };
  let responses = 0;
  const replyToRequest = async (input: Awaited<ReturnType<typeof readPresence>>) => {
    if (input.payload.requestReply !== true) return;
    responses++;
    c.send(await sealFrame({ epoch: cStore.get("work")!.current, identity: cStore.identity, recipients: [input.frame.sender], ephemeral: true,
      plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state: "idle" }] }), sequence: cStore.sequence }));
    await c.take("stored");
  };
  let crossedReply: Awaited<ReturnType<typeof readPresence>> | undefined;
  for (let n = 0; n < 3; n++) {
    const incoming = await readPresence();
    if (incoming.frame.sender === f.owner.identity.public.fingerprint) { crossedReply = incoming; break; }
    await replyToRequest(incoming); await c.ack(encodeBase64url(await sha256(incoming.wire)));
  }
  expect(crossedReply).toBeDefined();
  expect(encodeBase64url(await sha256(crossedReply!.wire))).toBe(replyDigest);
  expect(crossedReply!.payload.requestReply).toBeUndefined();
  expect(internal.session?.pendingPresenceReplies.has(cStore.identity.public.fingerprint)).toBe(true);
  await c.ack(replyDigest);
  // No reconnect, C bootstrap, local peer change or explicit publish can recover
  // this request: only A's next idle timer is now allowed to advance.
  observe = undefined; clock = 200;
  for (let n = 0; n < 3; n++) {
    const incoming = await readPresence();
    if (incoming.frame.sender === f.owner.identity.public.fingerprint) {
      expect(incoming.payload.requestReply).toBe(true);
      await replyToRequest(incoming); await c.ack(encodeBase64url(await sha256(incoming.wire))); break;
    }
    await replyToRequest(incoming); await c.ack(encodeBase64url(await sha256(incoming.wire)));
  }
  await bounded(converged.promise);
  expect(internal.session?.pendingPresenceReplies.has(cStore.identity.public.fingerprint)).toBe(false);
  expect(responses).toBeLessThanOrEqual(2); // B request plus exactly one A refresh.
  expect(a.link.connectionState).toBe("online"); expect(b.link.connectionState).toBe("online");
  expect(f.owner.pendingInbox("work")).toEqual([]);
});

async function coalescedChatBarrier() {
  const f = await fixture(), sent: Uint8Array[] = [], firstEntered = signal(), secondEntered = signal(), releaseFirst = signal(), releaseSecond = signal();
  const row = f.owner.get("work")!;
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { sent.push(Uint8Array.from(wire)); }, close() {} },
    generation: 1, room: row.current.room, broker: row.broker, phase: "ready", roster: { digest: row.current.digest }, ephemeral: true,
    outbound: [] as { digest: string; wire: Uint8Array }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, requestPresenceReply: false,
    queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  let state = "idle", reservations = 0;
  const link = new RoomLink({ store: f.owner, name: "work", presence: () => [{ id: "codex", state }] }); links.push(link);
  const internal = link as unknown as { running: boolean; generation: number; session: unknown; republish?: ReturnType<typeof setTimeout>;
    storedFrame(session: unknown, digest: string): void; receive(session: unknown, data: ArrayBuffer): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  const reserve = f.owner.sequence.reserve;
  f.owner.sequence.reserve = async input => {
    const seq = await reserve(input); reservations++;
    if (reservations === 1) { firstEntered.resolve(); await releaseFirst.promise; }
    if (reservations === 2) { secondEntered.resolve(); await releaseSecond.promise; }
    return seq;
  };
  const first = link.publishPresence(); await bounded(firstEntered.promise);
  state = "busy"; await link.publishPresence(); releaseFirst.resolve(); await first;
  expect(internal.republish).toBeDefined();
  const id = crypto.randomUUID();
  const message = { v: 1 as const, type: "chat" as const, envelope: {
    id, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi", kind: "chat" as const, priority: "status" as const, body: "chat behind deferred presence", ts: Date.now(),
  } };
  const outgoing = { deliveryId: crypto.randomUUID(), application: id, remotePeer: "kimi@guest",
    recipient: f.guest.identity.public.fingerprint, peer: "kimi", ackTimeoutMs: 1000, ttlMs: 60000 };
  return { f, link, internal, session, sent, secondEntered, releaseSecond, message, outgoing,
    reservations: () => reservations, restore: () => { releaseFirst.resolve(); releaseSecond.resolve(); f.owner.sequence.reserve = reserve; } };
}

test("a chat reserves its deferred-presence barrier before a quiesce and rechecks admission afterwards", async () => {
  const f = await coalescedChatBarrier();
  const sending = f.link.publishApplication(f.message, f.outgoing.recipient, f.outgoing).then(
    () => { throw new Error("quiesced barrier chat unexpectedly queued"); }, error => error,
  );
  let release: (() => void) | undefined;
  try {
    await bounded(f.secondEntered.promise);
    let drained = false;
    const quiescing = f.link.quiesceApplications().then(value => { drained = true; return value; });
    expect(f.internal.republish).toBeUndefined();
    expect(drained).toBe(false); expect(f.reservations()).toBe(2);
    f.releaseSecond.resolve();
    expect(await bounded(sending)).toMatchObject({ code: "not_sent" });
    release = await bounded(quiescing);
    expect(f.f.owner.applicationOutbox("work")).toEqual([]);
    // Both observations stay ahead of the later admitted application.
    for (const queued of [...f.session.outbound]) f.internal.storedFrame(f.session, queued.digest);
    release(); release(); f.restore();
    const digest = await f.link.publishApplication(f.message, f.outgoing.recipient, f.outgoing);
    const sentChat = f.sent[f.sent.length - 1];
    if (!sentChat) throw new Error("expected the admitted chat frame");
    expect(encodeBase64url(await sha256(sentChat))).toBe(digest);
    expect(f.f.owner.applicationOutbox("work")).toHaveLength(1);
  } finally { f.restore(); release?.(); await sending; }
});

test("stop fences a chat waiting behind deferred presence before its final offline seal", async () => {
  const f = await coalescedChatBarrier();
  const sending = f.link.publishApplication(f.message, f.outgoing.recipient, f.outgoing).then(
    () => { throw new Error("stopped barrier chat unexpectedly queued"); }, error => error,
  );
  let stopping: Promise<void> | undefined;
  try {
    await bounded(f.secondEntered.promise);
    stopping = f.link.stop();
    const head = f.session.outbound[0];
    if (!head) throw new Error("expected an attempted presence head");
    f.releaseSecond.resolve();
    expect(await bounded(sending)).toMatchObject({ code: "not_sent" });
    // A genuine correlated storage control releases the attempted pre-stop head.
    f.internal.receive(f.session, Uint8Array.from(canonicalBytes({ v: 1, type: "stored", digest: head.digest, seq: decodeFrame(head.wire).seq, duplicate: false })).buffer);
    // Await the final seal through the same send tail; its storage wait is ended
    // by the bounded stop deadline, never by fabricating final storage evidence.
    await stopping;
    expect(f.f.owner.applicationOutbox("work")).toEqual([]);
    expect(f.reservations()).toBe(3); // First observation, withdrawn snapshot, offline.
    expect(f.sent).toHaveLength(2);
    const final = f.sent[1];
    if (!final) throw new Error("expected final offline presence after head storage");
    const opened = await openFrame({ wire: final, identity: f.f.guest.identity, current: f.f.guest.get("work")!.current,
      replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    if (opened.status !== "accepted") throw new Error("expected authenticated offline presence");
    expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toEqual({ v: 1, type: "presence", peers: [{ id: "codex", state: "offline" }] });
  } finally { f.restore(); await sending; await stopping; }
});

test("busy application traffic does not postpone an ephemeral periodic refresh", async () => {
  const refreshQueued = signal(), receivingChat = signal(), releaseChat = signal(), observed = signal();
  let inspect: ((wire: Uint8Array) => Promise<void>) | undefined;
  const f = await fixture(false, { verifyFrame: async input => {
    const proof = await verifyPublicFrame(input); await inspect?.(input.wire); return proof;
  } });
  let clock = 0;
  const a = linked(f.owner, { refreshMs: 50, now: () => clock, presence: () => [{ id: "codex", state: "busy" }] });
  const b = linked(f.guest, { refreshMs: 50, now: () => 0, presence: () => [{ id: "kimi", state: "busy" }],
    application: { members() {}, online: async () => {}, stored() {}, receive: async () => { receivingChat.resolve(); await releaseChat.promise; } },
    onPresence: value => { if (clock > 0 && value.member === f.owner.identity.public.fingerprint) observed.resolve(); } });
  await a.link.start(); await a.online(); await b.link.start(); await b.online();
  await a.link.publishApplication({ v: 1, type: "chat", envelope: {
    id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "kimi", kind: "chat", priority: "status", body: "in-progress raw application turn", ts: Date.now(),
  } }, f.guest.identity.public.fingerprint);
  try {
    await bounded(receivingChat.promise);
    inspect = async wire => {
      const frame = decodeFrame(wire);
      if (frame.sender !== f.owner.identity.public.fingerprint || !frame.ephemeral) return;
      const opened = await openFrame({ wire, identity: f.guest.identity, current: f.guest.get("work")!.current,
        replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
      if (opened.status !== "accepted") throw new Error("expected authenticated busy refresh");
      const payload = JSON.parse(new TextDecoder().decode(opened.plaintext)) as { requestReply?: boolean };
      if (payload.requestReply === true) refreshQueued.resolve();
    };
    clock = 50;
    await bounded(refreshQueued.promise); // B is still processing the raw chat.
    expect(a.link.connectionState).toBe("online"); expect(b.link.connectionState).toBe("online");
    releaseChat.resolve(); await bounded(observed.promise);
  } finally { releaseChat.resolve(); }
});
