import { expect, test } from "bun:test";
import { RoomCodecPendingError, RoomCodecUnsupportedError, RoomLink, type RoomLinkApplication } from "../src/rooms/link.ts";
import { ROOM_CODEC_FEATURES, ROOM_CODEC_FEATURE_LIMIT, roomCodecFeatures, type RoomMessage } from "../src/rooms/application.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, openFrame, roomMembers, sealFrame } from "../src/rooms/wire.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    ephemeral: true, codecFeatures: true, codecSession: "A".repeat(43), codecPeers: new Map([[recipient.public.fingerprint, { session: "B".repeat(43), supported: true }]]),
    features: new Map(features ? [[recipient.public.fingerprint, { session: "B".repeat(43), features }]] : []),
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

test("known unsupported signed features refuse before sequence, socket or storage effects", async () => {
  for (const features of [[], ["chat_v1"], ["future_feature_v9"]]) {
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


function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function durableTransport() {
  const root = mkdtempSync(join(tmpdir(), "ahub-codec-race-"));
  let now = Date.now();
  const store = await RoomStore.open({ stateDir: root, clock: () => now }), recipient = await generateHubIdentity();
  const { epoch, wire } = await createRoomEpoch({ owner: store.identity, members: [
    { ...store.identity.public, label: "owner", exposedPeers: ["codex"] },
    { ...recipient.public, label: "guest", exposedPeers: ["codex"] },
  ] });
  await store.install({ name: "work", broker: "ws://127.0.0.1:1/", wire, expectedDigest: null });
  const sent: Uint8Array[] = [];
  const session = { ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (bytes: Uint8Array) => sent.push(Uint8Array.from(bytes)), close() {} },
    generation: 1, room: epoch.room, broker: "ws://127.0.0.1:1/", phase: "ready", roster: { digest: epoch.digest },
    ephemeral: true, codecFeatures: true, codecSession: "A".repeat(43), codecPeers: new Map([[recipient.public.fingerprint, { session: "B".repeat(43), supported: true }]]),
    features: new Map([[recipient.public.fingerprint, { session: "B".repeat(43), features: ROOM_CODEC_FEATURES as readonly string[] }]]),
    outbound: [] as { wire: Uint8Array; digest: string }[], outboundBytes: 0, frameSent: false, retryAttempt: 0,
    pendingPresenceReplies: new Set<string>(), presenceAsked: false, requestPresenceReply: false, queue: [], queuedBytes: 0 };
  const callbacks: RoomLinkApplication = { members() {}, receive: async () => {}, online: async () => {}, stored() {} };
  const subject = new RoomLink({ store, name: "work", now: () => now, application: callbacks });
  Object.assign(subject, { running: true, generation: 1, session });
  const metadata = (message: Extract<RoomMessage, { type: "chat" }>) => ({ deliveryId: crypto.randomUUID(), application: message.envelope.id,
    remotePeer: "user@guest", recipient: recipient.public.fingerprint, peer: "user", ackTimeoutMs: 1000, ttlMs: 60000 });
  const internal = subject as unknown as { storedFrame(session: unknown, digest: string): void; observationTime(): number | undefined; receiveFrame(session: unknown, bytes: Uint8Array, local: ReturnType<RoomStore["get"]>): Promise<void> };
  return { store, subject, internal, session, sent, recipient, metadata, callbacks, epoch, now: () => now, time: (value: number) => { now = value; },
    close: async () => { Object.assign(subject, { session: undefined }); await subject.stop(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("codec loss while a durable sequence seal is held refuses before application commit", async () => {
  const f = await durableTransport(), entered = gate(), release = gate();
  const reserve = f.store.sequence.reserve;
  f.store.sequence.reserve = async binding => { entered.resolve(); await release.promise; return reserve(binding); };
  try {
    const message = chat(); if (message.type !== "chat") throw new Error("expected chat");
    const pending = f.subject.publishApplication(message, f.recipient.public.fingerprint, f.metadata(message));
    void pending.catch(() => {});
    await entered.promise; f.session.features.clear(); release.resolve();
    await expect(pending).rejects.toBeInstanceOf(RoomCodecPendingError);
    expect(f.store.applicationOutbox("work")).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

test("codec loss during outbox proof validation rolls back admission with the typed upgrade refusal", async () => {
  const f = await durableTransport(), entered = gate(), release = gate();
  const queue = f.store.queueApplication.bind(f.store);
  f.store.queueApplication = async (name, wire, input, current) => { entered.resolve(); await release.promise; return queue(name, wire, input, current); };
  try {
    const message = chat(); if (message.type !== "chat") throw new Error("expected chat");
    const pending = f.subject.publishApplication(message, f.recipient.public.fingerprint, f.metadata(message));
    void pending.catch(() => {});
    await entered.promise; f.session.codecPeers.set(f.recipient.public.fingerprint, { session: "C".repeat(43), supported: false }); f.session.features.clear(); release.resolve();
    await expect(pending).rejects.toThrow("upgrade both hubs and the broker");
    expect(f.store.applicationOutbox("work")).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

test("actual socket publication withdraws an unsupported sealed attempt but preserves its durable application for a fresh-ad retry", async () => {
  const f = await durableTransport();
  try {
    await f.subject.publishApplication(chat("codex"), f.recipient.public.fingerprint); // One attempted FIFO head delays the feature-required frame.
    const head = f.session.outbound[0]!.digest;
    const message = chat(); if (message.type !== "chat") throw new Error("expected chat");
    const metadata = f.metadata(message);
    const withdrawn = await f.subject.publishApplication(message, f.recipient.public.fingerprint, metadata);
    expect(f.sent).toHaveLength(1);
    f.session.features.clear(); f.internal.storedFrame(f.session, head);
    expect(f.sent).toHaveLength(1);
    expect(f.subject.connectionCause).toBe("codec_pending");
    const retained = f.store.applicationOutbox("work");
    expect(retained).toHaveLength(1); expect(retained[0]?.state).toBe("dispatching"); expect(retained[0]?.disposition).toBeUndefined();
    expect(f.session.outbound).toEqual([]);
    let retry: Promise<string> | undefined;
    f.callbacks.codecsChanged = () => { retry = f.subject.publishApplication(message, f.recipient.public.fingerprint, metadata); };
    const featureWire = await sealFrame({ epoch: f.epoch, identity: f.recipient, recipients: [f.store.identity.public.fingerprint],
      plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], features: ROOM_CODEC_FEATURES, codecSession: "B".repeat(43) }),
      ephemeral: true, codecFeatures: true, sequence: { reserve: async () => "1", isCurrent: () => true } });
    await f.internal.receiveFrame(f.session, featureWire, f.store.get("work"));
    expect(retry).toBeDefined();
    const resumed = await retry;
    const sentFrames = f.sent.filter(wire => JSON.parse(new TextDecoder().decode(wire)).type === "frame");
    expect(resumed).not.toBe(withdrawn); expect(sentFrames).toHaveLength(2);
    expect(BigInt(decodeFrame(sentFrames[1]!).seq)).toBeGreaterThan(BigInt(decodeFrame(sentFrames[0]!).seq));
    expect(f.store.applicationOutbox("work")).toHaveLength(1);
    expect(f.store.applicationOutbox("work")[0]?.deliveryId).toBe(metadata.deliveryId);
    expect(f.subject.connectionCause).toBeUndefined();
  } finally { await f.close(); }
});

test("a clock rollback cause clears only after corrected observation and a real durable presence reservation", async () => {
  const f = await durableTransport();
  try {
    expect(f.internal.observationTime()).toBe(f.now());
    const highWater = f.now(); f.time(highWater - 1);
    expect(f.internal.observationTime()).toBeUndefined(); expect(f.subject.connectionCause).toBe("clock_rollback");
    f.time(highWater);
    expect(f.internal.observationTime()).toBe(highWater); expect(f.subject.connectionCause).toBe("clock_rollback");
    await f.subject.publishPresence();
    expect(f.subject.connectionCause).toBeUndefined(); expect(f.sent.length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("a fresh-session codec observation is pending, while a known legacy member is unsupported", async () => {
  const f = await transport();
  try {
    expect(f.subject.codecState(f.recipient.public.fingerprint, "person_inbox_v1")).toBe("pending");
    await expect(f.subject.publishApplication(chat(), f.recipient.public.fingerprint)).rejects.toBeInstanceOf(RoomCodecPendingError);
    expect(f.effects()).toBe(0);
    f.session.codecPeers.set(f.recipient.public.fingerprint, { session: "C".repeat(43), supported: false });
    expect(f.subject.codecState(f.recipient.public.fingerprint, "person_inbox_v1")).toBe("unsupported");
    await expect(f.subject.publishApplication(chat(), f.recipient.public.fingerprint)).rejects.toThrow("upgrade both hubs and the broker");
    expect(f.effects()).toBe(0);
  } finally { Object.assign(f.subject, { session: undefined }); await f.subject.stop(); }
});

test("codec support follows current broker session and roster evidence, never a legacy observation or stale signed advertisement", async () => {
  const f = await durableTransport(), member = f.recipient.public.fingerprint;
  const handle = (f.subject as unknown as { handle(session: unknown, bytes: Uint8Array): Promise<void> }).handle.bind(f.subject);
  const inventory = (session: string | null, supported: boolean, digest = f.epoch.digest) => handle(f.session,
    canonicalBytes({ v: 1, type: "codec_peers", digest, peers: [{ member, session, supported }] }));
  let seq = 0;
  const observation = async (token?: string) => {
    const wire = await sealFrame({ epoch: f.epoch, identity: f.recipient, recipients: [f.store.identity.public.fingerprint],
      plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], ...(token ? { features: ROOM_CODEC_FEATURES, codecSession: token } : {}) }),
      ephemeral: true, ...(token ? { codecFeatures: true as const } : {}), sequence: { reserve: async () => String(++seq), isCurrent: () => true } });
    await f.internal.receiveFrame(f.session, wire, f.store.get("work"));
  };
  try {
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("supported");
    await observation();
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("supported");
    await inventory("C".repeat(43), true);
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("pending");
    await observation("B".repeat(43));
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("pending");
    await observation("C".repeat(43));
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("supported");
    await inventory(null, false, "Z".repeat(43)); // Previous-roster controls cannot revoke current proof.
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("supported");
    await inventory(null, false);
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("pending");
    await observation("C".repeat(43));
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("pending");
    await inventory("D".repeat(43), false);
    expect(f.subject.codecState(member, "person_inbox_v1")).toBe("unsupported");
  } finally { await f.close(); }
});


test("a grace-epoch feature advertisement cannot establish support for the current roster", async () => {
  const f = await durableTransport();
  try {
    const before = f.store.get("work")!;
    const rotated = await f.store.rotate("work", roomMembers(before.current), before.current.digest);
    f.session.roster = { digest: rotated.current.digest }; f.session.features.clear();
    const old = await sealFrame({ epoch: before.current, identity: f.recipient, recipients: [f.store.identity.public.fingerprint],
      plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], features: ROOM_CODEC_FEATURES, codecSession: "B".repeat(43) }),
      ephemeral: true, codecFeatures: true, sequence: { reserve: async () => "1", isCurrent: () => true } });
    await f.internal.receiveFrame(f.session, old, f.store.get("work"));
    expect(f.subject.codecState(f.recipient.public.fingerprint, "person_inbox_v1")).toBe("pending");
    const fresh = await sealFrame({ epoch: rotated.current, identity: f.recipient, recipients: [f.store.identity.public.fingerprint],
      plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], features: ROOM_CODEC_FEATURES, codecSession: "B".repeat(43) }),
      ephemeral: true, codecFeatures: true, sequence: { reserve: async () => "2", isCurrent: () => true } });
    await f.internal.receiveFrame(f.session, fresh, f.store.get("work"));
    expect(f.subject.codecState(f.recipient.public.fingerprint, "person_inbox_v1")).toBe("supported");
  } finally { await f.close(); }
});
