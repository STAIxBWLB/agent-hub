import { expect, test } from "bun:test";
import { RoomCodecUnsupportedError, RoomLink } from "../src/rooms/link.ts";
import { ROOM_CODEC_FEATURES, ROOM_CODEC_FEATURE_LIMIT, roomCodecFeatures, type RoomMessage } from "../src/rooms/application.ts";
import type { RoomStore } from "../src/rooms/store.ts";
import { createRoomEpoch, openFrame } from "../src/rooms/wire.ts";
import { generateHubIdentity } from "../src/rooms/crypto.ts";

async function transport(features?: readonly string[]) {
  const owner = await generateHubIdentity(), recipient = await generateHubIdentity();
  const { epoch } = await createRoomEpoch({ owner, members: [
    { ...owner.public, label: "owner", exposedPeers: ["codex"] },
    { ...recipient.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  let effects = 0;
  const row = { current: epoch, broker: "ws://127.0.0.1:1/", left: false };
  const store = { get: () => row, identity: owner, sequence: { reserve: async () => String(++effects), isCurrent: () => true },
    ordinaryInboxAvailable: () => true, queueApplication: async () => { effects++; throw new Error("unexpected durable enqueue"); } } as unknown as RoomStore;
  const sent: Uint8Array[] = [];
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (wire: Uint8Array) => { effects++; sent.push(Uint8Array.from(wire)); }, close() {} },
    generation: 1, room: epoch.room, broker: row.broker, phase: "ready", roster: { digest: epoch.digest },
    ephemeral: true, codecFeatures: true, features: new Map(features ? [[recipient.public.fingerprint, features]] : []),
    outbound: [] as { wire: Uint8Array; digest: string }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, requestPresenceReply: false, queue: [], queuedBytes: 0 };
  const subject = new RoomLink({ store, name: "work" });
  Object.assign(subject, { running: true, generation: 1, session });
  return { subject, session, sent, effects: () => effects, recipient, epoch };
}
function chat(to = "user"): RoomMessage {
  return { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to,
    kind: "chat", priority: "status", body: "codec refusal body canary", ts: Date.now() } };
}

test("absent and unsupported signed features refuse before sequence, socket or storage effects", async () => {
  for (const features of [undefined, [], ["chat_v1"], ["future_feature_v9"]]) {
    const f = await transport(features);
    try {
      const pending = f.subject.publishApplication(chat(), f.recipient.public.fingerprint);
      await expect(pending).rejects.toBeInstanceOf(RoomCodecUnsupportedError);
      await expect(pending).rejects.toThrow("upgrade both hubs and the broker");
      expect(f.effects()).toBe(0); expect(f.session.outbound).toHaveLength(0);
    } finally { Object.assign(f.subject, { session: undefined }); await f.subject.stop(); }
  }
});

test("a verified advertised feature enables only its existing codec, while legacy ordinary chat stays usable", async () => {
  for (const [features, peer] of [[ROOM_CODEC_FEATURES, "user"], [undefined, "codex"]] as const) {
    const f = await transport(features);
    try {
      const message = chat(peer);
      await f.subject.publishApplication(message, f.recipient.public.fingerprint);
      expect(f.sent).toHaveLength(1);
      const opened = await openFrame({ wire: f.sent[0]!, identity: f.recipient, current: f.epoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
      expect(opened.status).toBe("accepted");
      if (opened.status === "accepted") expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toEqual(message);
    } finally { Object.assign(f.subject, { session: undefined }); await f.subject.stop(); }
  }
});

test("codec advertisements have a bounded canonical vocabulary without inferring unknown support", () => {
  expect(roomCodecFeatures([...ROOM_CODEC_FEATURES])).toEqual(ROOM_CODEC_FEATURES);
  expect(roomCodecFeatures(["future_codec"])).toEqual(["future_codec"]);
  for (const value of [null, "chat_v1", ["chat_v1", "chat_v1"], ["z", "a"], ["private body"], ["a".repeat(65)],
    Array.from({ length: ROOM_CODEC_FEATURE_LIMIT + 1 }, (_, n) => `feature_${n}`)]) {
    expect(() => roomCodecFeatures(value)).toThrow();
  }
});
