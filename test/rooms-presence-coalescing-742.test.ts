import { expect, test } from "bun:test";
import { RoomLink } from "../src/rooms/link.ts";
import { RoomStore, type RoomOutgoingInput } from "../src/rooms/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoomMessage } from "../src/rooms/application.ts";
import { createRoomEpoch, openFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, sha256 } from "../src/rooms/crypto.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Keep crypto/sequence admission real; only the already-ready socket and bounded
// store are fakes. No broker, native account, filesystem or wall-clock benchmark.
async function transport() {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const { epoch } = await createRoomEpoch({ owner, members: [
    { ...owner.public, label: "owner", exposedPeers: ["codex"] },
    { ...guest.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  const entered = gate(), release = gate();
  let reserves = 0, unavailable = false, peers = [{ id: "codex", state: "idle" }];
  const sequence = { reserve: async () => {
    const value = ++reserves;
    if (value === 1) { entered.resolve(); await release.promise; }
    return String(value);
  }, isCurrent: () => true };
  const row = { current: epoch, broker: "ws://127.0.0.1:1/", left: false };
  const receipts: { digest: string; wire: Uint8Array; state: "dispatching" }[] = [];
  const store = { get: () => row, identity: owner, sequence, ordinaryInboxAvailable: () => true,
    receiptStored: () => undefined,
    queueReceipt: async (_name: string, _frame: string, wire: Uint8Array, _options: unknown, current: () => boolean) => {
      expect(current()).toBe(true);
      const receipt = { digest: encodeBase64url(await sha256(wire)), wire: Uint8Array.from(wire), state: "dispatching" as const };
      receipts.push(receipt); return receipt;
    }, receiptSendable: (_name: string, digest: string) => receipts.some(row => row.digest === digest),
  } as unknown as RoomStore;
  const sent: Uint8Array[] = [];
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { sent.push(Uint8Array.from(wire)); }, close() {} },
    generation: 1, room: epoch.room, broker: row.broker, phase: "ready", roster: { digest: epoch.digest },
    outbound: [] as { wire: Uint8Array; digest: string; requestReply: boolean; presence: boolean }[], outboundBytes: 0,
    frameSent: false, retryAttempt: 0, pendingPresenceReplies: new Set<string>(), presenceAsked: false,
    receiptSends: new Map(), requestPresenceReply: false, queue: [], queuedBytes: 0, handshake: undefined,
    frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  const link = new RoomLink({ store, name: "work", presence: () => {
    if (unavailable) throw new Error("fixture observation unavailable");
    return peers;
  } });
  const internal = link as unknown as { running: boolean; generation: number; session: unknown;
    republish?: ReturnType<typeof setTimeout>; replyPresence: boolean; retiredPresenceBytes: number;
    storedFrame(session: unknown, digest: string): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  async function open(wire: Uint8Array) {
    const result = await openFrame({ wire, identity: guest, current: epoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("expected authenticated room frame");
    return JSON.parse(new TextDecoder().decode(result.plaintext));
  }
  async function pending() {
    const first = link.publishPresence();
    await entered.promise;
    peers = [{ id: "codex", state: "busy" }];
    await link.publishPresence(); // Dirty while the first durable counter is held.
    release.resolve(); await first;
    expect(reserves).toBe(1);
    expect(internal.republish).toBeDefined();
    return internal.republish;
  }
  return { link, internal, session, sent, receipts, guest, open, pending,
    reserves: () => reserves, state: (state: string) => { peers = [{ id: "codex", state }]; }, hide: () => { peers = []; }, failPresence: () => { unavailable = true; } };
}
function chat(): RoomMessage {
  return { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0,
    from: "codex", to: "codex", kind: "chat", priority: "status", body: "presence barrier", ts: Date.now() } };
}

test("1000 awaited state flips retain one deferred presence intent without reserving 1000 counters", async () => {
  const f = await transport();
  try {
    const timer = await f.pending();
    for (let n = 0; n < 1000; n++) {
      f.state(n % 2 ? "idle" : "busy");
      await f.link.publishPresence();
    }
    expect(f.reserves()).toBe(1);
    expect(f.internal.republish).toBe(timer);
    expect(f.session.outbound).toHaveLength(1);
  } finally { f.link.stop(); }
});

test("awaited chat flushes the latest deferred presence ciphertext before its FIFO chat", async () => {
  const f = await transport();
  try {
    await f.pending(); f.state("busy");
    const digest = await f.link.publishApplication(chat(), f.guest.public.fingerprint);
    expect(f.reserves()).toBe(3);
    expect(f.session.outbound).toHaveLength(3);
    expect(f.session.outbound[2]!.digest).toBe(digest);
    expect(await f.open(f.session.outbound[1]!.wire)).toEqual({ v: 1, type: "presence", peers: [{ id: "codex", state: "busy" }] });
    expect((await f.open(f.session.outbound[2]!.wire)).type).toBe("chat");
    expect(f.sent).toHaveLength(1); // Attempted head cannot be replaced or overtaken.
    f.internal.storedFrame(f.session, f.session.outbound[0]!.digest);
    expect(f.sent[1]).toEqual(f.session.outbound[0]!.wire);
    f.internal.storedFrame(f.session, f.session.outbound[0]!.digest);
    expect(f.sent[2]).toEqual(f.session.outbound[0]!.wire);
    expect(f.session.outbound[0]!.digest).toBe(digest);
  } finally { f.link.stop(); }
});

for (const intent of ["response", "capacity request"] as const) {
  test(`deferred ordinary presence cannot starve a ${intent}`, async () => {
    const f = await transport();
    try {
      await f.pending();
      if (intent === "response") {
        f.internal.replyPresence = true;
        await f.link.publishPresence();
      } else {
        f.internal.retiredPresenceBytes = 1;
        await f.link.refreshPresenceIfCapacityFree();
      }
      expect(f.reserves()).toBe(2);
      expect(await f.open(f.session.outbound[1]!.wire)).toEqual({ v: 1, type: "presence", peers: [{ id: "codex", state: "busy" }],
        ...(intent === "capacity request" ? { requestReply: true } : {}) });
      expect(f.session.outbound[1]!.requestReply).toBe(intent === "capacity request");
    } finally { f.link.stop(); }
  });
}

test("concurrent chats reserve FIFO positions before waiting for the presence barrier", async () => {
  const f = await transport();
  try {
    await f.pending(); f.state("busy");
    const first = chat(), second = chat();
    if (first.type !== "chat" || second.type !== "chat") throw new Error("expected chat fixture");
    first.envelope.body = "first chat"; second.envelope.body = "second chat";
    const one = f.link.publishApplication(first, f.guest.public.fingerprint);
    const two = f.link.publishApplication(second, f.guest.public.fingerprint);
    const [firstDigest, secondDigest] = await Promise.all([one, two]);
    expect(f.session.outbound.map(frame => frame.digest).slice(2)).toEqual([firstDigest, secondDigest]);
    expect((await f.open(f.session.outbound[2]!.wire)).envelope.body).toBe("first chat");
    expect((await f.open(f.session.outbound[3]!.wire)).envelope.body).toBe("second chat");
  } finally { f.link.stop(); }
});

test("concurrent chat presence barriers preserve real durable outbox insertion order", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-presence-fifo-742-")), store = await RoomStore.open({ stateDir: join(root, "state") });
  const guest = await generateHubIdentity(), entered = gate(), release = gate();
  const created = await createRoomEpoch({ owner: store.identity, members: [
    { ...store.identity.public, label: "owner", exposedPeers: ["codex"] },
    { ...guest.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  await store.install({ name: "work", broker: "ws://127.0.0.1:1/", wire: created.wire, expectedDigest: null });
  let peers = [{ id: "codex", state: "idle" }], firstReserve = true;
  const reserve = store.sequence.reserve.bind(store.sequence);
  store.sequence.reserve = async binding => {
    if (firstReserve) { firstReserve = false; entered.resolve(); await release.promise; }
    return reserve(binding);
  };
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {}, close() {} }, generation: 1,
    room: created.epoch.room, broker: "ws://127.0.0.1:1/", phase: "ready", roster: { digest: created.epoch.digest },
    outbound: [] as { wire: Uint8Array; digest: string }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, requestPresenceReply: false, queue: [], queuedBytes: 0 };
  const link = new RoomLink({ store, name: "work", presence: () => peers });
  Object.assign(link, { running: true, generation: 1, session });
  try {
    const publishing = link.publishPresence(); await entered.promise;
    peers = [{ id: "codex", state: "busy" }]; await link.publishPresence(); release.resolve(); await publishing;
    const first = chat(), second = chat();
    if (first.type !== "chat" || second.type !== "chat") throw new Error("expected chat fixture");
    const input = (application: string): RoomOutgoingInput => ({ application, deliveryId: crypto.randomUUID(), remotePeer: "codex@guest",
      peer: "codex", recipient: guest.public.fingerprint, ackTimeoutMs: 1000, ttlMs: 86400000 });
    const one = input(first.envelope.id), two = input(second.envelope.id);
    const firstWire = link.publishApplication(first, guest.public.fingerprint, one);
    const secondWire = link.publishApplication(second, guest.public.fingerprint, two);
    await Promise.all([firstWire, secondWire]);
    expect(store.applicationOutbox("work").map(row => row.deliveryId)).toEqual([one.deliveryId, two.deliveryId]);
    expect(store.applicationOutbox("work").map(row => row.application)).toEqual([first.envelope.id, second.envelope.id]);
  } finally { release.resolve(); link.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed deferred observation still rejects its chat rather than becoming an empty send", async () => {
  const f = await transport();
  try {
    await f.pending(); f.failPresence();
    await expect(f.link.publishApplication(chat(), f.guest.public.fingerprint)).rejects.toThrow("fixture observation unavailable");
    expect(f.reserves()).toBe(1);
  } finally { f.link.stop(); }
});

test("a receipt commits its sealed FIFO frame without flushing deferred ordinary presence", async () => {
  const f = await transport();
  try {
    await f.pending();
    const message: RoomMessage = { v: 1, type: "receipt", frame: encodeBase64url(new Uint8Array(32)), application: crypto.randomUUID(),
      peer: "codex", outcome: "completed", reason: "admitted" };
    const digest = await f.link.publishApplication(message, f.guest.public.fingerprint);
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]!.digest).toBe(digest);
    expect(f.session.outbound[1]!.digest).toBe(digest);
    expect(f.session.outbound[1]!.wire).toEqual(f.receipts[0]!.wire);
    expect(await f.open(f.receipts[0]!.wire)).toEqual(message);
    expect(f.sent).toHaveLength(1);
    f.internal.storedFrame(f.session, f.session.outbound[0]!.digest);
    expect(f.sent[1]).toEqual(f.receipts[0]!.wire);
  } finally { f.link.stop(); }
});

test("a chat-flushed presence still checks exposure and application currency at actual send", async () => {
  const f = await transport();
  try {
    await f.pending();
    let current = true;
    await f.link.publishApplication(chat(), f.guest.public.fingerprint, undefined, () => current);
    f.hide(); current = false;
    // The queued presence loses its exposed peer; the queued chat loses its
    // caller fence. Neither may follow the already-attempted first frame.
    expect(() => f.internal.storedFrame(f.session, f.session.outbound[0]!.digest)).toThrow();
    expect(f.sent).toHaveLength(1);
  } finally { f.link.stop(); }
});
