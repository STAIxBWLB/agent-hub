import { expect, test } from "bun:test";
import { RoomLink } from "../src/rooms/link.ts";
import type { RoomStore } from "../src/rooms/store.ts";
import { canonicalBytes, createRoomEpoch, openFrame, sealFrame } from "../src/rooms/wire.ts";
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
    requestPresenceReply: true, queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined as ReturnType<typeof setTimeout> | undefined };
  const link = new RoomLink({ store, name: "work", presence: () => peers });
  const internal = link as unknown as { running: boolean; generation: number; session: unknown; replyPresence: boolean;
    queueFrame(session: unknown, wire: Uint8Array, digest: string): void; storedFrame(session: unknown, digest: string): void;
    backoffFrame(session: unknown, digest: string): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  const head = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "chat" }), sequence });
  const digest = encodeBase64url(await sha256(head)); internal.queueFrame(session, head, digest);
  return { link, internal, session, digest, sent, secondSent, guest, epoch: created.epoch, hide: () => { peers = []; } };
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
