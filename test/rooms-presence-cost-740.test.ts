import { expect, test } from "bun:test";
import { RoomLink } from "../src/rooms/link.ts";
import type { RoomStore } from "../src/rooms/store.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, openFrame, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, sha256 } from "../src/rooms/crypto.ts";
import type { RoomChatEnvelope } from "../src/rooms/application.ts";

test("a blocked presence burst reserves only its latest snapshot before the following chat", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [
    { ...owner.public, label: "owner", exposedPeers: ["codex"] },
    { ...guest.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  let reserved = 0, state = "busy";
  const sequence = { reserve: async () => String(++reserved), isCurrent: () => true };
  const row = { current: created.epoch, broker: "ws://127.0.0.1:1/", left: false };
  const store = { get: () => row, identity: owner, sequence, ordinaryInboxAvailable: () => true } as unknown as RoomStore;
  const sent: Uint8Array[] = [];
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => sent.push(wire), close() {} },
    generation: 1, room: created.epoch.room, broker: row.broker, phase: "ready", roster: { digest: created.epoch.digest },
    outbound: [] as { wire: Uint8Array; digest: string; requestReply: boolean }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, receiptSends: new Map(),
    requestPresenceReply: true, queue: [], queuedBytes: 0, handshake: undefined, frameRetry: undefined };
  const link = new RoomLink({ store, name: "work", presence: () => [{ id: "codex", state }] });
  const internal = link as unknown as { running: boolean; generation: number; session: unknown;
    queueFrame(session: unknown, wire: Uint8Array, digest: string): void; storedFrame(session: unknown, digest: string): void };
  internal.running = true; internal.generation = 1; internal.session = session;
  const head = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "chat" }), sequence });
  const headDigest = encodeBase64url(await sha256(head)); internal.queueFrame(session, head, headDigest);
  try {
    await link.publishPresence();
    const before = reserved;
    for (let n = 0; n < 1000; n++) { state = n % 2 === 0 ? "busy" : "idle"; await link.publishPresence(); }
    expect(reserved).toBe(before);
    expect(session.outbound).toHaveLength(2);
    const env: RoomChatEnvelope = { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", body: "after latest presence", kind: "chat", priority: "status", ts: Date.now() };
    await link.publishApplication({ v: 1, type: "chat", envelope: env }, guest.public.fingerprint);
    expect(reserved).toBe(before + 2);
    expect(session.outbound).toHaveLength(3);
    const presence = session.outbound[1]!, chat = session.outbound[2]!;
    expect(BigInt(decodeFrame(presence.wire).seq)).toBeLessThan(BigInt(decodeFrame(chat.wire).seq));
    const opened = await openFrame({ wire: presence.wire, identity: guest, current: created.epoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
    expect(opened.status).toBe("accepted");
    if (opened.status === "accepted") expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toEqual({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], requestReply: true });
    internal.storedFrame(session, headDigest);
    expect(sent[1]).toEqual(presence.wire);
    internal.storedFrame(session, presence.digest);
    expect(sent[2]).toEqual(chat.wire);
  } finally { link.stop(); }
});
