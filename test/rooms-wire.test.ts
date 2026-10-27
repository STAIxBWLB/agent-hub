import { expect, test } from "bun:test";
import { generateHubIdentity, encodeBase64url, decodeBase64url, encryptEpoch, importEpochKey, signBytes, hmac, type HubIdentity } from "../src/rooms/crypto.ts";
import {
  ROOM_WIRE_LIMITS, RoomWireError, canonicalBytes, positiveU64,
  decodeFrame, decodeRoster, decodeInvite, decodeJoin, createRoomEpoch, acceptRoomEpoch,
  roomMembers, sealFrame, openFrame, createInvite, createJoin, acceptJoin,
  type VerifiedEpoch, type SequencePort, type ReplayPort, type ReplayCommit,
  type EnrollmentPort, type RoomMember, type FrameWire,
} from "../src/rooms/wire.ts";

const text = new TextEncoder();
const string = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const raw = (n: number) => encodeBase64url(new Uint8Array(n));
const member = (identity: HubIdentity, label: string): RoomMember => ({ ...identity.public, label, exposedPeers: ["codex"] });
async function fixture() {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] });
  const guestEpoch = await acceptRoomEpoch({ wire: created.wire, identity: guest, pin: { room: created.epoch.room, owner: owner.public.fingerprint, minEpoch: "0" } });
  return { owner, guest, ...created, guestEpoch };
}
function sequence(): SequencePort {
  let seq = 0n;
  return { reserve: async () => String(++seq), isCurrent: () => true };
}
function inbox(epoch: VerifiedEpoch, initial = 0n): { port: ReplayPort; commits: ReplayCommit[] } {
  let highest = initial;
  const accepted = new Map<string, string>(), commits: ReplayCommit[] = [];
  return { commits, port: { accept: async input => {
    commits.push(input);
    if (input.expectedCurrentEpoch !== epoch.epoch || input.expectedCurrentDigest !== epoch.digest) return { status: "trust_changed" };
    const seq = BigInt(input.seq);
    if (seq <= highest) {
      const old = accepted.get(input.seq);
      return { status: old === input.frameDigest ? "duplicate" : old ? "conflict" : "stale" };
    }
    const gap = String(seq - highest - 1n); highest = seq; accepted.set(input.seq, input.frameDigest);
    return { status: "accepted", gap };
  } } };
}

test("room wire rejects alternate JSON encodings, duplicate/unknown fields and malformed UTF-8", () => {
  const frame: FrameWire = { v: 1, type: "frame", room: raw(32), epoch: "1", sender: "a".repeat(64), recipients: ["b".repeat(64)], seq: "1", nonce: raw(12), ciphertext: raw(16), signature: raw(64) };
  const bytes = canonicalBytes(frame), encoded = string(bytes);
  expect(decodeFrame(bytes)).toEqual(frame);
  for (const bad of [
    ` ${encoded}`, `${encoded}\n`, encoded.replace('"epoch":"1"', '"epoch":"1","epoch":"1"'),
    string(canonicalBytes({ ...frame, unknown: true })), JSON.stringify(frame),
    encoded.replace('"epoch":"1"', '"epoch":"01"'),
    encoded.replace('"epoch":"1"', '"epoch":1'),
    encoded.replace(raw(32), `${raw(32)}=`),
  ]) expect(() => decodeFrame(text.encode(bad))).toThrow(RoomWireError);
  expect(() => decodeFrame(new Uint8Array([255]))).toThrow(RoomWireError);
  expect(() => decodeFrame(new Uint8Array(ROOM_WIRE_LIMITS.frame + 1))).toThrow(RoomWireError);
});

test("room wire uint64 and collection ceilings are strict", () => {
  expect(positiveU64("18446744073709551615")).toBe("18446744073709551615");
  for (const value of ["0", "-1", "01", "1.0", "1e2", "18446744073709551616", 1]) expect(() => positiveU64(value)).toThrow();
  const frame = { v: 1, type: "frame", room: raw(32), epoch: "1", sender: "a".repeat(64), recipients: ["b".repeat(64)], seq: "1", nonce: raw(12), ciphertext: raw(16), signature: raw(64) };
  for (const recipients of [[], ["b".repeat(64), "b".repeat(64)], ["c".repeat(64), "b".repeat(64)], Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0"))]) {
    expect(() => decodeFrame(canonicalBytes({ ...frame, recipients }))).toThrow();
  }
  expect(() => decodeFrame(canonicalBytes({ ...frame, signature: "" }))).toThrow();
  expect(() => canonicalBytes({ hidden: undefined })).toThrow();
  expect(() => canonicalBytes({ bad: NaN })).toThrow();
});

test("owner-signed roster hides labels and exposures and pins owner/room/epoch/digest", async () => {
  const f = await fixture(), roster = decodeRoster(f.wire);
  expect(string(f.wire)).not.toContain('"label"');
  expect(string(f.wire)).not.toContain("codex");
  expect(roomMembers(f.guestEpoch).map(m => m.label).sort()).toEqual(["guest", "owner"]);
  const readback = roomMembers(f.guestEpoch); readback[0]!.label = "mutated";
  expect(roomMembers(f.guestEpoch).some(m => m.label === "mutated")).toBe(false);
  const pin = { room: f.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "1", digest: f.epoch.digest };
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin })).resolves.toEqual(f.guestEpoch);
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin: { ...pin, owner: f.guest.public.fingerprint } })).rejects.toThrow();
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin: { ...pin, room: raw(32) } })).rejects.toThrow();
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin: { ...pin, minEpoch: "2" } })).rejects.toMatchObject({ code: "wrong_epoch" });
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin: { ...pin, digest: raw(32) } })).rejects.toThrow();
  await expect(acceptRoomEpoch({ wire: canonicalBytes({ ...roster, signature: raw(64) }), identity: f.guest, pin: { room: pin.room, owner: pin.owner, minEpoch: "0" } })).rejects.toMatchObject({ code: "authentication_failed" });
  const changed = canonicalBytes({ ...roster, privateNonce: raw(12) });
  await expect(acceptRoomEpoch({ wire: changed, identity: f.guest, pin })).rejects.toThrow();
  const outsider = await generateHubIdentity();
  await expect(acceptRoomEpoch({ wire: f.wire, identity: outsider, pin })).rejects.toThrow();
});

test("roster requires one owner, unique labels and sorted bounded exposure IDs", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  await expect(createRoomEpoch({ owner, members: [member(owner, "same"), member(guest, "same")] })).rejects.toThrow();
  await expect(createRoomEpoch({ owner, members: [member(guest, "guest")] })).rejects.toThrow();
  await expect(createRoomEpoch({ owner, members: [{ ...member(owner, "owner"), exposedPeers: ["user@other"] }] })).rejects.toThrow();
  await expect(createRoomEpoch({ owner, members: [{ ...member(owner, "owner"), exposedPeers: ["z", "a"] }] })).rejects.toThrow();
  await expect(createRoomEpoch({ owner, members: [{ ...member(owner, "owner"), exposedPeers: Array.from({ length: 65 }, (_, i) => `p${i}`) }] })).rejects.toThrow();
});

test("frame open authenticates all header/ciphertext fields before durable acceptance", async () => {
  const f = await fixture(), replay = inbox(f.guestEpoch), seq = sequence();
  const wire = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("private canary"), sequence: seq });
  const frame = decodeFrame(wire);
  expect(string(wire)).not.toContain("private canary");
  for (const change of [{ nonce: raw(12) }, { ciphertext: raw(16) }, { seq: "2" }, { recipients: [f.owner.public.fingerprint] }, { sender: f.guest.public.fingerprint }, { signature: raw(64) }]) {
    await expect(openFrame({ wire: canonicalBytes({ ...frame, ...change }), identity: f.guest, current: f.guestEpoch, replay: replay.port })).rejects.toThrow();
  }
  expect(replay.commits).toHaveLength(0);
  const result = await openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: replay.port });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") expect(string(result.plaintext)).toBe("private canary");
  expect(replay.commits[0]!.frameDigest).not.toBe("");
  expect(replay.commits[0]!.selectedRosterDigest).toBe(f.epoch.digest);
});

test("concurrent replay exposes plaintext once; unknown lower sequences stay stale", async () => {
  const f = await fixture(), replay = inbox(f.guestEpoch);
  const wire = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("once"), sequence: sequence() });
  const results = await Promise.all(Array.from({ length: 4 }, () => openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: replay.port })));
  expect(results.filter(r => r.status === "accepted")).toHaveLength(1);
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(3);
  for (const result of results.filter(r => r.status !== "accepted")) expect("plaintext" in result).toBe(false);
  const stale = await openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: inbox(f.guestEpoch, 10n).port });
  expect(stale).toEqual({ status: "stale" });
});

test("required durable ports fence trust changes and failed sequence storage", async () => {
  const f = await fixture();
  const args = { epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: new Uint8Array() };
  await expect(sealFrame({ ...args, sequence: { reserve: async () => "1", isCurrent: () => false } })).rejects.toMatchObject({ code: "state_changed" });
  await expect(sealFrame({ ...args, sequence: { reserve: async () => { throw new Error("storage canary"); }, isCurrent: () => true } })).rejects.toMatchObject({ code: "state_unavailable", message: "Room wire: state_unavailable" });
  const wire = await sealFrame({ ...args, sequence: sequence() });
  await expect(openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: { accept: async () => ({ status: "trust_changed" }) } })).rejects.toMatchObject({ code: "state_changed" });
  await expect(sealFrame({ ...args, plaintext: new Uint8Array(65537), sequence: sequence() })).rejects.toMatchObject({ code: "limit" });
  await expect(sealFrame({ ...args, epoch: { ...f.epoch }, sequence: sequence() })).rejects.toMatchObject({ code: "untrusted" });
});

test("epoch rotation keeps sender sequence scope, permits grace only for current members", async () => {
  const f = await fixture(), seq = sequence();
  const first = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("before"), sequence: seq });
  const next = await createRoomEpoch({ owner: f.owner, members: roomMembers(f.epoch), previous: f.epoch });
  const guestNext = await acceptRoomEpoch({ wire: next.wire, identity: f.guest, pin: { room: f.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "1", digest: f.epoch.digest } });
  expect(next.epoch.epoch).toBe("2");
  const second = await sealFrame({ epoch: next.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("after"), sequence: seq });
  expect(decodeFrame(second).seq).toBe("2");
  await expect(openFrame({ wire: first, identity: f.guest, current: guestNext, replay: inbox(guestNext).port })).rejects.toMatchObject({ code: "wrong_epoch" });
  const previous = { epoch: f.guestEpoch, expiresAt: 60000 };
  const result = await openFrame({ wire: first, identity: f.guest, current: guestNext, previous, replay: inbox(guestNext).port, nowMs: 59999 });
  expect(result.status).toBe("accepted");
  await expect(openFrame({ wire: first, identity: f.guest, current: guestNext, previous, replay: inbox(guestNext).port, nowMs: 60000 })).rejects.toMatchObject({ code: "wrong_epoch" });
  const revoked = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner")], previous: next.epoch });
  await expect(acceptRoomEpoch({ wire: revoked.wire, identity: f.guest, pin: { room: f.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "2", digest: next.epoch.digest } })).rejects.toMatchObject({ code: "untrusted" });
  const oldGuest = await sealFrame({ epoch: guestNext, identity: f.guest, recipients: [f.owner.public.fingerprint], plaintext: text.encode("revoked sender"), sequence: sequence() });
  await expect(openFrame({ wire: oldGuest, identity: f.owner, current: revoked.epoch, previous: { epoch: next.epoch, expiresAt: 60000 }, replay: inbox(revoked.epoch).port, nowMs: 1 })).rejects.toMatchObject({ code: "untrusted" });
});

test("invite and join authenticate original context, hide private metadata and consume once atomically", async () => {
  const f = await fixture(), newcomer = await generateHubIdentity();
  const invite = await createInvite({ epoch: f.epoch, owner: f.owner, broker: "wss://broker.example/", expiresAt: 1000000, nowMs: 1 });
  const token = decodeInvite(invite);
  const wire = await createJoin({ invite, identity: newcomer, label: "private-label", exposedPeers: ["private-peer"], nowMs: 2 });
  const packet = decodeJoin(wire);
  expect(string(wire)).not.toContain("private-label");
  expect(string(wire)).not.toContain("private-peer");
  expect(string(wire)).not.toContain(token.secret);
  let consumed: string | undefined;
  let calls = 0;
  const enrollment: EnrollmentPort = { consume: async input => {
    calls++;
    if (consumed) return consumed === input.requestDigest ? "duplicate" : "refused";
    consumed = input.requestDigest; return "accepted";
  } };
  const options = { issuedInvite: invite, owner: f.owner, enrollment, nowMs: 3 };
  await expect(acceptJoin({ ...options, wire: canonicalBytes({ ...packet, mac: raw(32) }) })).rejects.toThrow();
  await expect(acceptJoin({ ...options, wire: canonicalBytes({ ...packet, member: f.guest.public }) })).rejects.toThrow();
  await expect(acceptJoin({ ...options, issuedInvite: canonicalBytes({ ...token, broker: "wss://elsewhere.example/" }), wire })).rejects.toThrow();
  expect(calls).toBe(0);
  const results = await Promise.all([acceptJoin({ ...options, wire }), acceptJoin({ ...options, wire })]);
  expect(results.filter(r => r.status === "accepted")).toHaveLength(1);
  expect(results.filter(r => r.status === "duplicate")).toHaveLength(1);
  const accepted = results.find(r => r.status === "accepted");
  if (accepted?.status === "accepted") expect(accepted.member.label).toBe("private-label");
  const second = await createJoin({ invite, identity: newcomer, label: "private-label", exposedPeers: ["private-peer"], nowMs: 2 });
  await expect(acceptJoin({ ...options, wire: second })).rejects.toMatchObject({ code: "state_changed" });
});

test("owner invite expiry is exact and ws brokers must be literal loopback", async () => {
  const f = await fixture(), newcomer = await generateHubIdentity();
  for (const broker of ["ws://broker.example/", "https://broker.example/", "wss://user:pass@broker.example/", "wss://broker.example/#secret", "ws://127.0.0.2/"]) {
    await expect(createInvite({ epoch: f.epoch, owner: f.owner, broker, expiresAt: 1000, nowMs: 1 })).rejects.toThrow();
  }
  const invite = await createInvite({ epoch: f.epoch, owner: f.owner, broker: "ws://127.0.0.1/", expiresAt: 1000, nowMs: 1 });
  const wire = await createJoin({ invite, identity: newcomer, label: "new", exposedPeers: [], nowMs: 1001 });
  let called = false;
  await expect(acceptJoin({ issuedInvite: invite, wire, owner: f.owner, nowMs: 1000, enrollment: { consume: async () => { called = true; return "accepted"; } } })).rejects.toMatchObject({ code: "expired" });
  expect(called).toBe(false);
  await expect(createJoin({ invite, identity: newcomer, label: "new", exposedPeers: [], nowMs: 601001 })).rejects.toMatchObject({ code: "expired" });
});

test("frame settlement fences a roster change during crypto without releasing plaintext", async () => {
  const f = await fixture();
  const wire = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("held"), sequence: sequence() });
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let installed = f.guestEpoch.digest;
  const pending = openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: { accept: async input => {
    reached(); await held;
    return installed === input.expectedCurrentDigest ? { status: "accepted", gap: "0" } : { status: "trust_changed" };
  } } });
  // Attach rejection handling immediately, but assert only after releasing the
  // barrier: Bun's expect().rejects matcher may drain the pending promise eagerly.
  pending.catch(() => {});
  await entered;
  installed = "new-current-roster"; release();
  await expect(pending).rejects.toMatchObject({ code: "state_changed" });
});

test("outgoing reservation is consumed before crypto and a changed publication fence refuses", async () => {
  const f = await fixture();
  let count = 0;
  const epochsSeen: string[] = [];
  const port: SequencePort = { reserve: async binding => { epochsSeen.push(binding.rosterDigest); return String(++count); }, isCurrent: () => false };
  await expect(sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: new Uint8Array(), sequence: port })).rejects.toMatchObject({ code: "state_changed" });
  expect(count).toBe(1);
  expect(epochsSeen).toEqual([f.epoch.digest]);
  port.isCurrent = () => true;
  const wire = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: new Uint8Array(), sequence: port });
  expect(decodeFrame(wire).seq).toBe("2");
});

test("replay storage errors and malformed outcomes are fixed refusals", async () => {
  const f = await fixture();
  const wire = await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("private"), sequence: sequence() });
  const ports: ReplayPort[] = [
    { accept: async () => { throw new Error("private storage detail"); } },
    { accept: async () => null } as unknown as ReplayPort,
    { accept: async () => ({ status: "accepted", gap: -1 }) } as unknown as ReplayPort,
  ];
  for (const replay of ports) await expect(openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay })).rejects.toMatchObject({ code: "state_unavailable", message: "Room wire: state_unavailable" });
});


test("a rolled-back sender sequence still uses fresh random frame nonces", async () => {
  const f = await fixture();
  const rolledBack: SequencePort = { reserve: async () => "1", isCurrent: () => true };
  const args = { epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], sequence: rolledBack };
  const first = await sealFrame({ ...args, plaintext: text.encode("first plaintext") });
  const second = await sealFrame({ ...args, plaintext: text.encode("other plaintext") });
  expect(decodeFrame(first).seq).toBe(decodeFrame(second).seq);
  expect(decodeFrame(first).nonce).not.toBe(decodeFrame(second).nonce);
  for (const wire of [first, second]) {
    const result = await openFrame({ wire, identity: f.guest, current: f.guestEpoch, replay: inbox(f.guestEpoch).port });
    expect(result.status).toBe("accepted");
  }
  const replay = inbox(f.guestEpoch).port;
  await openFrame({ wire: first, identity: f.guest, current: f.guestEpoch, replay });
  await expect(openFrame({ wire: second, identity: f.guest, current: f.guestEpoch, replay })).rejects.toMatchObject({ code: "state_changed" });
});

test("an installed epoch requires its exact digest even for owner-signed retries", async () => {
  const f = await fixture();
  const pin = { room: f.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "1" };
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin })).rejects.toMatchObject({ code: "untrusted" });
  await expect(acceptRoomEpoch({ wire: f.wire, identity: f.guest, pin: { ...pin, digest: f.epoch.digest } })).resolves.toEqual(f.guestEpoch);
  const next = await createRoomEpoch({ owner: f.owner, members: roomMembers(f.epoch), previous: f.epoch });
  const retry = await createRoomEpoch({ owner: f.owner, members: roomMembers(f.epoch), previous: f.epoch });
  expect(next.epoch.epoch).toBe(retry.epoch.epoch);
  const installed = { ...pin, minEpoch: next.epoch.epoch, digest: next.epoch.digest };
  await expect(acceptRoomEpoch({ wire: retry.wire, identity: f.guest, pin: installed })).rejects.toMatchObject({ code: "untrusted" });
  await expect(acceptRoomEpoch({ wire: retry.wire, identity: f.guest, pin: { ...installed, digest: undefined } })).rejects.toMatchObject({ code: "untrusted" });
});

test("enrollment refuses a correctly authenticated low-order agreement key before consuming the invite", async () => {
  const f = await fixture(), newcomer = await generateHubIdentity();
  const inviteBytes = await createInvite({ epoch: f.epoch, owner: f.owner, broker: "wss://broker.example/", expiresAt: 1000, nowMs: 1 });
  const invite = decodeInvite(inviteBytes);
  const { secret: _, ...claims } = invite;
  const secret = decodeBase64url(invite.secret, 32);
  const member = { ...newcomer.public, agreementKey: raw(32) };
  const nonce = raw(32), privateNonce = new Uint8Array(12);
  const domain = (purpose: string, value: unknown) => canonicalBytes(["agent-hub.rooms.v1", purpose, value]);
  const privateCiphertext = await encryptEpoch({ key: await importEpochKey(secret), purpose: "invite", context: domain("join-private", { invite: claims, member, nonce }), nonce: privateNonce, plaintext: canonicalBytes({ label: "new", exposedPeers: [] }) });
  const core = { v: 1, type: "join", room: invite.room, owner: invite.owner, inviteId: invite.inviteId, member, nonce, privateNonce: encodeBase64url(privateNonce), privateCiphertext: encodeBase64url(privateCiphertext) };
  const signature = encodeBase64url(await signBytes(newcomer, domain("join-signature", { invite: claims, request: core })));
  const body = { ...core, signature };
  const wire = canonicalBytes({ ...body, mac: encodeBase64url(await hmac(secret, domain("join-mac", { invite: claims, request: body }))) });
  let consumed = false;
  await expect(acceptJoin({ issuedInvite: inviteBytes, wire, owner: f.owner, nowMs: 2, enrollment: { consume: async () => { consumed = true; return "accepted"; } } })).rejects.toMatchObject({ code: "invalid_key" });
  expect(consumed).toBe(false);
});
