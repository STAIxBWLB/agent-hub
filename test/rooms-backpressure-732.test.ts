import { expect, test } from "bun:test";
import { RoomLink } from "../src/rooms/link.ts";
import type { RoomStore } from "../src/rooms/store.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, openFrame, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, sha256 } from "../src/rooms/crypto.ts";

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


async function receiptForIncoming(f: Awaited<ReturnType<typeof transport>>) {
  const application = crypto.randomUUID();
  const incoming = await sealFrame({ epoch: f.epoch, identity: f.guest, recipients: [f.owner.public.fingerprint],
    plaintext: canonicalBytes({ v: 1, type: "chat", envelope: { id: application, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "normal", body: "incoming chat", ts: 1 } }),
    sequence: { reserve: async () => "1", isCurrent: () => true } });
  const digest = encodeBase64url(await sha256(incoming));
  const receiptDigest = await f.link.publishApplication({ v: 1, type: "receipt", frame: digest, application, peer: "codex", outcome: "completed", reason: "admitted" }, f.guest.public.fingerprint);
  return { frame: decodeFrame(incoming), digest, receiptDigest };
}

test("an inbound chat transport ACK waits for its queued receipt to reach the wire", async () => {
  const f = await transport();
  try {
    const incoming = await receiptForIncoming(f);
    f.internal.retireFrame(f.session, incoming.frame, incoming.digest);
    expect(f.sent).toHaveLength(1); // The unrelated head is still waiting for broker storage.
    f.internal.storedFrame(f.session, f.digest);
    await Promise.resolve(); // The actual receipt send resolves its fence; ACK is scheduled outside serial receive.
    expect(f.sent).toHaveLength(3);
    expect(decodeFrame(f.sent[0]!).type).toBe("frame");
    expect(encodeBase64url(await sha256(f.sent[1]!))).toBe(incoming.receiptDigest);
    const receipt = await openFrame({ wire: f.sent[1]!, identity: f.guest, current: f.epoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    expect(receipt.status).toBe("accepted");
    if (receipt.status === "accepted") expect(JSON.parse(new TextDecoder().decode(receipt.plaintext))).toMatchObject({ type: "receipt", frame: incoming.digest });
    expect(JSON.parse(new TextDecoder().decode(f.sent[2]!))).toEqual({ v: 1, type: "received", digest: incoming.digest });
  } finally { f.link.stop(); }
});

test("a queued receipt fence cannot transport ACK through a stopped session", async () => {
  const f = await transport();
  try {
    const incoming = await receiptForIncoming(f);
    f.internal.retireFrame(f.session, incoming.frame, incoming.digest);
    f.internal.storedFrame(f.session, f.digest); // The receipt is physically sent, but its ACK callback has not run.
    f.link.stop();
    await Promise.resolve();
    expect(f.sent).toHaveLength(2);
    expect(encodeBase64url(await sha256(f.sent[1]!))).toBe(incoming.receiptDigest);
    expect(f.sent.some(wire => JSON.parse(new TextDecoder().decode(wire)).type === "received")).toBe(false);
  } finally { f.link.stop(); }
});


test("confirmed queue_full releases an inbound chat ACK while retaining its queued receipt", async () => {
  const f = await transport();
  try {
    const incoming = await receiptForIncoming(f);
    f.internal.retireFrame(f.session, incoming.frame, incoming.digest);
    expect(f.sent).toHaveLength(1);
    expect(f.session.outbound.map(frame => frame.digest)).toEqual([f.digest, incoming.receiptDigest]);
    f.internal.backoffFrame(f.session, f.digest); // A confirmed refusal of the head creates the T1 exception.
    expect(f.session.frameRetry).toBeDefined();
    expect(f.sent).toHaveLength(2);
    expect(JSON.parse(new TextDecoder().decode(f.sent[1]!))).toEqual({ v: 1, type: "received", digest: incoming.digest });
    expect(f.session.outbound.map(frame => frame.digest)).toEqual([f.digest, incoming.receiptDigest]);
    expect(encodeBase64url(await sha256(f.session.outbound[1]!.wire))).toBe(incoming.receiptDigest);
    f.internal.storedFrame(f.session, f.digest); // Capacity returns; the retained receipt now reaches the wire.
    await Promise.resolve();
    expect(f.sent).toHaveLength(3);
    expect(encodeBase64url(await sha256(f.sent[2]!))).toBe(incoming.receiptDigest);
    expect(f.sent.filter(wire => JSON.parse(new TextDecoder().decode(wire)).type === "received")).toHaveLength(1);
    expect(f.session.receiptSends.size).toBe(0);
  } finally { f.link.stop(); }
});

test("background receipt sends release deferred ACK slots without an incoming retirement", async () => {
  const f = await transport();
  try {
    f.internal.storedFrame(f.session, f.digest);
    for (let n = 0; n < 9; n++) {
      const frame = encodeBase64url(await sha256(new TextEncoder().encode(`background-${n}`)));
      const digest = await f.link.publishApplication({ v: 1, type: "receipt", frame,
        application: crypto.randomUUID(), peer: "codex", outcome: "completed", reason: "admitted" }, f.guest.public.fingerprint);
      expect(f.session.receiptSends.size).toBe(0);
      f.internal.storedFrame(f.session, digest);
    }
    expect(f.sent).toHaveLength(10);
  } finally { f.link.stop(); }
});
