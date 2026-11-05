import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomLink } from "../src/rooms/link.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { encodeRoomMessage } from "../src/rooms/application.ts";
import { canonicalBytes, createInvite, createJoin, createRoomEpoch, decodeFrame, openFrame, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, sha256 } from "../src/rooms/crypto.ts";

const roots: string[] = [], stores: RoomStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function transport() {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [
    { ...owner.public, label: "owner", exposedPeers: ["codex"] },
    { ...guest.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  let seq = 0, peers = [{ id: "codex", state: "idle" }];
  const sequence = { reserve: async () => String(++seq), isCurrent: () => true };
  const row = { current: created.epoch, broker: "ws://127.0.0.1:1/", left: false };
  const store = { get: () => row, identity: owner, sequence, ordinaryInboxAvailable: () => true } as unknown as RoomStore;
  const sent: Uint8Array[] = [];
  let second!: () => void;
  const secondSent = new Promise<void>(resolve => { second = resolve; });
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { sent.push(wire); if (sent.length === 2) second(); }, close() {} },
    generation: 1, room: created.epoch.room, broker: row.broker, phase: "ready", roster: { digest: created.epoch.digest },
    outbound: [] as { wire: Uint8Array; digest: string; requestReply: boolean }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, receiptSends: new Map<string, { digest: string; promise: Promise<void>; resolve: () => void; sent: boolean }>(),
    requestPresenceReply: true, queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  const link = new RoomLink({ store, name: "work", presence: () => peers });
  const internal = link as unknown as { running: boolean; generation: number; session: unknown; replyPresence: boolean;
    queueFrame(session: unknown, wire: Uint8Array, digest: string): void; storedFrame(session: unknown, digest: string): void;
    backoffFrame(session: unknown, digest: string): void; retireFrame(session: unknown, frame: ReturnType<typeof decodeFrame>, digest: string): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  const head = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "chat" }), sequence });
  const digest = encodeBase64url(await sha256(head)); internal.queueFrame(session, head, digest);
  return { link, internal, session, digest, sent, secondSent, owner, guest, epoch: created.epoch, hide: () => { peers = []; } };
}

test("a response cannot replace an unsent presence refresh request behind a blocked head", async () => {
  const f = await transport();
  try {
    await f.link.publishPresence();
    f.internal.replyPresence = true;
    await f.link.publishPresence();
    expect(f.session.outbound.map(frame => frame.requestReply)).toEqual([false, true, false]);
    expect(f.sent).toHaveLength(1);
    f.internal.storedFrame(f.session, f.digest);
    expect(f.sent).toHaveLength(2);
    const result = await openFrame({ wire: f.sent[1]!, identity: f.guest, current: f.epoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(JSON.parse(new TextDecoder().decode(result.plaintext)).requestReply).toBe(true);
  } finally { f.link.stop(); }
});

test("queued presence rechecks exposure at actual send and stop clears queue_full backoff", async () => {
  const f = await transport();
  try {
    await f.link.publishPresence(); f.hide();
    f.internal.storedFrame(f.session, f.digest);
    expect(f.sent).toHaveLength(1); // The sealed exposed-id snapshot was withheld.
    await f.link.publishPresence();
    await f.secondSent;
    expect(f.sent).toHaveLength(2);
    const pending = f.session.outbound[0]!;
    f.internal.backoffFrame(f.session, pending.digest);
    expect(f.session.frameRetry).toBeDefined();
    f.link.stop();
    expect(f.session.outbound).toHaveLength(0);
    expect(f.link.connectionState).toBe("offline");
  } finally { f.link.stop(); }
});


async function durableTransport() {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-receipt-")); roots.push(root);
  const owner = await RoomStore.open({ stateDir: join(root, "owner") }), guest = await RoomStore.open({ stateDir: join(root, "guest") });
  stores.push(owner, guest);
  const initial = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "work", broker: "ws://127.0.0.1:1/", wire: initial.wire, expectedDigest: null });
  const token = await createInvite({ epoch: initial.epoch, owner: owner.identity, broker: initial.broker, expiresAt: Date.now() + 600000 });
  await owner.saveInvite("work", token);
  const request = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: ["codex"] });
  guest.savePendingJoin("work", { invite: token, request });
  const roster = await owner.enroll("work", request);
  await guest.install({ name: "work", broker: roster.broker, wire: roster.wire, expectedDigest: null });

  const sent: Uint8Array[] = [];
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { sent.push(Uint8Array.from(wire)); }, close() {} },
    generation: 1, room: roster.current.room, broker: roster.broker, phase: "ready", roster: { digest: roster.current.digest },
    outbound: [] as { wire: Uint8Array; digest: string; requestReply: boolean }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, receiptSends: new Map(), requestPresenceReply: false,
    queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  const link = new RoomLink({ store: guest, name: "work" });
  const internal = link as unknown as { running: boolean; generation: number; session: unknown;
    queueFrame(session: unknown, wire: Uint8Array, digest: string): void; storedFrame(session: unknown, digest: string): void;
    retireFrame(session: unknown, frame: ReturnType<typeof decodeFrame>, digest: string): void; restoreReceipts(session: unknown): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  return { owner, guest, link, internal, session, sent, roster: roster.current };
}

async function admittedChat(f: Awaited<ReturnType<typeof durableTransport>>, body = "incoming chat") {
  const application = crypto.randomUUID();
  const wire = await sealFrame({ epoch: f.roster, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint],
    plaintext: encodeRoomMessage({ v: 1, type: "chat", envelope: { id: application, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body, ts: Date.now() } }),
    sequence: f.owner.sequence });
  const digest = encodeBase64url(await sha256(wire));
  const opened = await openFrame({ wire, identity: f.guest.identity, current: f.guest.get("work")!.current, replay: f.guest.replay });
  expect(opened.status).toBe("accepted");
  const incoming = await f.guest.applicationIncoming("work", digest);
  expect(incoming.primary).toBe(true);
  expect(f.guest.claimApplication("work", digest)).toBe(true);
  f.guest.finishApplication("work", digest, "completed", "admitted");
  return { wire, digest, frame: decodeFrame(wire), message: f.guest.applicationReceipt("work", digest)! };
}

async function queueDurableReceipt(f: Awaited<ReturnType<typeof durableTransport>>, incoming: Awaited<ReturnType<typeof admittedChat>>) {
  const digest = await f.link.publishApplication(incoming.message, f.owner.identity.public.fingerprint);
  return { digest, stored: f.guest.receiptStored("work", incoming.digest)! };
}

test("receipt commit is visible in the durable store before the chat transport ACK", async () => {
  const f = await durableTransport();
  try {
    const incoming = await admittedChat(f), receipt = await queueDurableReceipt(f, incoming);
    expect(receipt.stored).toMatchObject({ digest: receipt.digest, state: "dispatching", kind: "receipt", receiptFor: incoming.digest });
    expect(f.guest.outbox("work")).toContainEqual(expect.objectContaining({ digest: receipt.digest, kind: "receipt", wire: receipt.stored.wire }));
    f.internal.retireFrame(f.session, incoming.frame, incoming.digest);
    expect(JSON.parse(new TextDecoder().decode(f.sent.at(-1)!))).toEqual({ v: 1, type: "received", digest: incoming.digest });
    expect(f.guest.receiptStored("work", incoming.digest)?.wire).toEqual(receipt.stored.wire);
  } finally { f.link.stop(); }
});

test("a stopped session cannot ACK past its retained durable receipt", async () => {
  const f = await durableTransport();
  try {
    const incoming = await admittedChat(f), receipt = await queueDurableReceipt(f, incoming);
    f.link.stop();
    expect(() => f.internal.retireFrame(f.session, incoming.frame, incoming.digest)).toThrow();
    expect(f.sent.some(wire => JSON.parse(new TextDecoder().decode(wire)).type === "received")).toBe(false);
    expect(f.guest.receiptStored("work", incoming.digest)).toMatchObject({ digest: receipt.digest, state: "dispatching", wire: receipt.stored.wire });
    expect(f.guest.outbox("work")).toContainEqual(expect.objectContaining({ digest: receipt.digest, kind: "receipt" }));
  } finally { f.link.stop(); }
});

test("cap one ACKs after receipt commit and sends the unchanged sealed receipt when capacity returns", async () => {
  const f = await durableTransport();
  try {
    const head = await sealFrame({ epoch: f.roster, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint],
      plaintext: canonicalBytes({ v: 1, type: "chat" }), sequence: f.guest.sequence });
    await f.guest.enqueue("work", head);
    const headDigest = encodeBase64url(await sha256(head));
    f.internal.queueFrame(f.session, head, headDigest);
    expect(f.session.outbound).toHaveLength(1);
    const incoming = await admittedChat(f), receipt = await queueDurableReceipt(f, incoming);
    f.internal.retireFrame(f.session, incoming.frame, incoming.digest);
    expect(JSON.parse(new TextDecoder().decode(f.sent.at(-1)!))).toEqual({ v: 1, type: "received", digest: incoming.digest });
    expect(f.sent).toHaveLength(2); // The head frame and transport ACK; the receipt waits for capacity.
    expect(f.session.outbound.map(frame => frame.digest)).toEqual([headDigest]);
    f.guest.markStored("work", headDigest);
    f.internal.storedFrame(f.session, headDigest);
    f.internal.restoreReceipts(f.session);
    expect(f.sent).toHaveLength(3);
    expect(encodeBase64url(await sha256(f.sent[2]!))).toBe(receipt.digest);
    expect(f.sent[2]).toEqual(receipt.stored.wire);
    expect(f.guest.receiptStored("work", incoming.digest)?.wire).toEqual(receipt.stored.wire);
  } finally { f.link.stop(); }
});

test("more than eight sequential stored receipts do not leak transport slots", async () => {
  const f = await durableTransport();
  try {
    for (let n = 0; n < 9; n++) {
      const incoming = await admittedChat(f, `incoming chat ${n}`), receipt = await queueDurableReceipt(f, incoming);
      expect(f.sent).toHaveLength(n + 1);
      expect(encodeBase64url(await sha256(f.sent[n]!))).toBe(receipt.digest);
      f.guest.markStored("work", receipt.digest);
      f.internal.storedFrame(f.session, receipt.digest);
      expect(f.guest.acknowledgeReceipt("work", receipt.digest)).toBe(true);
      expect(f.session.outbound).toHaveLength(0);
      expect(f.guest.outbox("work")).toHaveLength(0);
    }
    expect(f.sent).toHaveLength(9);
  } finally { f.link.stop(); }
});
