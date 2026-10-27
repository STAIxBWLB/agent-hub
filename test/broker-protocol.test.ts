import { expect, test } from "bun:test";
import { encodeBase64url, generateHubIdentity, signBytes, type HubIdentity } from "../src/rooms/crypto.ts";
import {
  canonicalBytes, createRoomEpoch, decodeFrame, decodeRoster, publicFrameWire, publicRosterWire,
  sealFrame, verifyPublicFrame, verifyPublicRoster, RoomWireError,
  type OwnerPin, type RoomMember,
} from "../src/rooms/wire.ts";
import {
  BrokerProtocolError, createBrokerAuth, decodeBrokerChallenge, decodeBrokerControl,
  encodeBrokerChallenge, encodeBrokerControl, verifyBrokerAuth,
  type BrokerChallenge,
} from "../src/broker/protocol.ts";

const bytes = new TextEncoder();
const string = (wire: Uint8Array) => new TextDecoder().decode(wire);
const member = (identity: HubIdentity, label: string): RoomMember => ({ ...identity.public, label, exposedPeers: ["codex"] });
function challenge(room: string, rosterDigest: string | null, broker = "wss://broker.example/"): BrokerChallenge {
  return { v: 1, type: "challenge", room, broker, nonce: encodeBase64url(new Uint8Array(32).fill(9)), expiresAt: 1_900_000_000_000, rosterDigest };
}
const pinFor = (roster: ReturnType<typeof decodeRoster>, digest?: string): OwnerPin => ({
  room: roster.room, owner: roster.owner, minEpoch: "0", ...(digest ? { digest } : {}),
});

test("public roster and frame proofs expose only immutable metadata and defensive wire copies", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "private-owner-label"), member(guest, "private-guest-label")] });
  const rosterWire = created.wire;
  const roster = await verifyPublicRoster({ wire: rosterWire, pin: pinFor(decodeRoster(rosterWire)) });
  expect(Object.isFrozen(roster)).toBe(true);
  expect(Object.isFrozen(roster.members)).toBe(true);
  expect(roster.members.every(Object.isFrozen)).toBe(true);
  expect("key" in roster).toBe(false);
  expect("wraps" in roster).toBe(false);
  expect(string(publicRosterWire(roster))).not.toContain("private-owner-label");
  const copiedRoster = publicRosterWire(roster); copiedRoster.fill(0);
  expect(publicRosterWire(roster)).toEqual(rosterWire);

  const frameWire = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: bytes.encode("ciphertext only canary"),
    sequence: { reserve: async () => "1", isCurrent: () => true } });
  const frame = await verifyPublicFrame({ wire: frameWire, roster });
  expect(frame.sender).toBe(owner.public.fingerprint);
  expect(frame.recipients).toEqual([guest.public.fingerprint]);
  expect(Object.isFrozen(frame)).toBe(true);
  expect(Object.isFrozen(frame.recipients)).toBe(true);
  expect("plaintext" in frame).toBe(false);
  expect("key" in frame).toBe(false);
  const copiedFrame = publicFrameWire(frame); copiedFrame.fill(0);
  expect(publicFrameWire(frame)).toEqual(frameWire);
});

test("public roster and frame proofs reject changed pins, signatures, selection and forged products", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity(), outsider = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] });
  const parsedRoster = decodeRoster(created.wire);
  const proof = await verifyPublicRoster({ wire: created.wire, pin: pinFor(parsedRoster) });
  await expect(verifyPublicRoster({ wire: created.wire, pin: { ...pinFor(parsedRoster), owner: guest.public.fingerprint } })).rejects.toBeInstanceOf(RoomWireError);
  await expect(verifyPublicRoster({ wire: created.wire, pin: { ...pinFor(parsedRoster), room: encodeBase64url(new Uint8Array(32)) } })).rejects.toBeInstanceOf(RoomWireError);
  await expect(verifyPublicRoster({ wire: created.wire, pin: { ...pinFor(parsedRoster), minEpoch: "2" } })).rejects.toMatchObject({ code: "wrong_epoch" });
  await expect(verifyPublicRoster({ wire: canonicalBytes({ ...parsedRoster, signature: encodeBase64url(new Uint8Array(64)) }), pin: pinFor(parsedRoster) })).rejects.toMatchObject({ code: "authentication_failed" });
  const frameWire = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: new Uint8Array(),
    sequence: { reserve: async () => "1", isCurrent: () => true } });
  const parsedFrame = decodeFrame(frameWire);
  await expect(verifyPublicFrame({ wire: canonicalBytes({ ...parsedFrame, seq: "2" }), roster: proof })).rejects.toMatchObject({ code: "authentication_failed" });
  await expect(verifyPublicFrame({ wire: frameWire, roster: { ...proof } })).rejects.toMatchObject({ code: "untrusted" });
  const other = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(outsider, "outsider")] });
  const otherProof = await verifyPublicRoster({ wire: other.wire, pin: pinFor(decodeRoster(other.wire)) });
  await expect(verifyPublicFrame({ wire: frameWire, roster: otherProof })).rejects.toMatchObject({ code: "wrong_epoch" });
  const unsigned = { ...parsedFrame, recipients: [outsider.public.fingerprint] };
  const invalidRecipientWire = canonicalBytes({ ...unsigned, signature: encodeBase64url(await signBytes(owner,
    canonicalBytes(["agent-hub.rooms.v1", "frame-signature", unsigned]))) });
  await expect(verifyPublicFrame({ wire: invalidRecipientWire, roster: proof })).rejects.toMatchObject({ code: "untrusted" });
});

test("broker auth binds the room, broker, nonce and roster context", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] });
  const parsed = decodeRoster(created.wire);
  const roster = await verifyPublicRoster({ wire: created.wire, pin: pinFor(parsed) });
  const existing = challenge(roster.room, roster.digest);
  const guestAuth = await createBrokerAuth({ challenge: existing, identity: guest, broker: existing.broker, room: existing.room });
  await expect(verifyBrokerAuth({ wire: guestAuth, challenge: existing, roster })).resolves.toMatchObject({ member: guest.public.fingerprint, initial: false });
  await expect(createBrokerAuth({ challenge: existing, identity: guest, broker: "wss://wrong.example/", room: existing.room })).rejects.toBeInstanceOf(BrokerProtocolError);
  await expect(createBrokerAuth({ challenge: existing, identity: guest, broker: existing.broker, room: encodeBase64url(new Uint8Array(32)) })).rejects.toBeInstanceOf(BrokerProtocolError);
  const wrongNonce = { ...existing, nonce: encodeBase64url(new Uint8Array(32).fill(8)) };
  await expect(verifyBrokerAuth({ wire: guestAuth, challenge: wrongNonce, roster })).rejects.toMatchObject({ code: "authentication_failed" });
  const wrongDigest = { ...existing, rosterDigest: encodeBase64url(new Uint8Array(32).fill(2)) };
  await expect(verifyBrokerAuth({ wire: guestAuth, challenge: wrongDigest, roster })).rejects.toMatchObject({ code: "untrusted" });
  const wrongMemberKey = { ...guest.public, signingKey: owner.public.signingKey };
  await expect(verifyBrokerAuth({ wire: await createBrokerAuth({ challenge: existing, identity: guest, broker: existing.broker, room: existing.room }), challenge: existing,
    roster: { ...roster, members: [wrongMemberKey] } })).rejects.toMatchObject({ code: "untrusted" });
});

test("initial broker auth carries and verifies only the owner signed public roster", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "private-owner-label"), member(guest, "private-guest-label")] });
  const parsed = decodeRoster(created.wire), initial = challenge(parsed.room, null);
  const auth = await createBrokerAuth({ challenge: initial, identity: owner, broker: initial.broker, room: initial.room, initialRoster: created.wire });
  const verified = await verifyBrokerAuth({ wire: auth, challenge: initial });
  expect(verified).toMatchObject({ member: owner.public.fingerprint, initial: true });
  expect(string(auth)).not.toContain("private-owner-label");
  expect(string(auth)).not.toContain("private-guest-label");
  await expect(createBrokerAuth({ challenge: initial, identity: guest, broker: initial.broker, room: initial.room, initialRoster: created.wire })).rejects.toMatchObject({ code: "untrusted" });
  await expect(verifyBrokerAuth({ wire: auth, challenge: { ...initial, room: encodeBase64url(new Uint8Array(32).fill(3)) } })).rejects.toMatchObject({ code: "untrusted" });
});

test("broker protocol rejects noncanonical, unknown, malformed and oversized controls", () => {
  const room = encodeBase64url(new Uint8Array(32).fill(4)), sample = challenge(room, null);
  const wire = encodeBrokerChallenge(sample);
  expect(decodeBrokerChallenge(wire)).toEqual(sample);
  const control = encodeBrokerControl({ v: 1, type: "received", digest: encodeBase64url(new Uint8Array(32).fill(1)) });
  expect(decodeBrokerControl(control)).toEqual({ v: 1, type: "received", digest: encodeBase64url(new Uint8Array(32).fill(1)) });
  for (const bad of [
    bytes.encode(` ${string(wire)}`),
    bytes.encode(string(wire).replace('"room":', '"unknown":1,"room":')),
    bytes.encode(JSON.stringify({ ...sample, extra: true })),
    new Uint8Array([255]),
  ]) expect(() => decodeBrokerChallenge(bad)).toThrow(BrokerProtocolError);
  expect(() => decodeBrokerChallenge(new Uint8Array(8193))).toThrow(BrokerProtocolError);
  expect(() => decodeBrokerControl(bytes.encode('{"v":1,"type":"error","code":"failed"}'))).toThrow(BrokerProtocolError);
  expect(() => decodeBrokerControl(new Uint8Array(1_048_577))).toThrow(BrokerProtocolError);
  expect(() => decodeBrokerChallenge(encodeBrokerChallenge({ ...sample, broker: "wss://broker.example/?token=x" }))).toThrow(BrokerProtocolError);
  expect(() => decodeBrokerChallenge(encodeBrokerChallenge({ ...sample, broker: "ws://localhost/" }))).toThrow(BrokerProtocolError);
});


test("Buffer-backed public proofs retain verified bytes across input and output mutation", async () => {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const f = { owner, guest, ...await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] }) };
  const rosterInput = Buffer.from(f.wire);
  const proof = await verifyPublicRoster({ wire: rosterInput, pin: { room: f.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "0" } });
  const originalRoster = Uint8Array.from(f.wire);
  rosterInput.fill(0);
  expect(publicRosterWire(proof)).toEqual(originalRoster);
  const rosterOutput = publicRosterWire(proof); rosterOutput.fill(0);
  expect(publicRosterWire(proof)).toEqual(originalRoster);
  const frameInput = Buffer.from(await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: bytes.encode("buffer copy"), sequence: { reserve: async () => "1", isCurrent: () => true } }));
  const frame = await verifyPublicFrame({ wire: frameInput, roster: proof });
  const originalFrame = Uint8Array.from(frameInput);
  frameInput.fill(0);
  expect(publicFrameWire(frame)).toEqual(originalFrame);
  const frameOutput = publicFrameWire(frame); frameOutput.fill(0);
  expect(publicFrameWire(frame)).toEqual(originalFrame);
});
