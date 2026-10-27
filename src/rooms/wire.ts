/** Rooms wire v1. Persistence, publication, transport and envelope policy belong to X3/X4. */
import {
  assertRoomCryptoReady, decodeBase64url, encodeBase64url, randomBytes,
  encryptEpoch, decryptEpoch, importEpochKey, generateEpochKey, sha256,
  signBytes, verifyBytes, hmac, verifyHmac, wrapEpochKey, unwrapEpochKey,
  type HubIdentity, type PublicHubIdentity, type EpochKey, type WrappedEpochKey,
} from "./crypto.ts";

export const ROOM_WIRE_LIMITS = Object.freeze({
  plaintext: 65536, frame: 131072, roster: 524288, enrollment: 16384,
  members: 64, recipients: 64, exposedPeers: 64,
});
export type RoomWireCode = "invalid_wire" | "limit" | "untrusted" | "wrong_epoch" |
  "authentication_failed" | "state_unavailable" | "state_changed" | "expired";
export class RoomWireError extends Error {
  constructor(readonly code: RoomWireCode) { super(`Room wire: ${code}`); this.name = "RoomWireError"; }
}
function fail(code: RoomWireCode = "invalid_wire"): never { throw new RoomWireError(code); }
const enc = new TextEncoder();
const U64_MAX = 18446744073709551615n;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const FP = /^[0-9a-f]{64}$/;
export interface RoomMember extends PublicHubIdentity { label: string; exposedPeers: string[] }
export interface FrameWire {
  v: 1; type: "frame"; room: string; epoch: string; sender: string;
  recipients: string[]; seq: string; nonce: string; ciphertext: string; signature: string;
}
export interface RosterWire {
  v: 1; type: "roster"; room: string; epoch: string; owner: string;
  members: PublicHubIdentity[]; wraps: WrappedEpochKey[];
  privateNonce: string; privateCiphertext: string; signature: string;
}
export interface InviteWire {
  v: 1; type: "invite"; room: string; owner: string; broker: string;
  inviteId: string; expiresAt: number; secret: string;
}
export interface JoinWire {
  v: 1; type: "join"; room: string; owner: string; inviteId: string;
  member: PublicHubIdentity; nonce: string; privateNonce: string;
  privateCiphertext: string; signature: string; mac: string;
}

/** Lexicographic ASCII object keys, preserved array order, no optional/unknown values. */
export function canonicalBytes(value: unknown): Uint8Array {
  function visit(x: unknown, depth: number): unknown {
    if (depth > 12) fail("limit");
    if (x === null || typeof x === "boolean" || typeof x === "string") return x;
    if (typeof x === "number" && Number.isSafeInteger(x) && !Object.is(x, -0)) return x;
    if (Array.isArray(x)) return x.map(item => visit(item, depth + 1));
    if (typeof x !== "object" || x === null || Object.getPrototypeOf(x) !== Object.prototype) fail();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(x).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") fail();
      out[key] = visit((x as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return enc.encode(JSON.stringify(visit(value, 0)));
}
function object(x: unknown, keys: string[]): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail();
  const o = x as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(key => !Object.hasOwn(o, key))) fail();
  return o;
}
function text(x: unknown): string { if (typeof x !== "string") fail(); return x; }
function fingerprint(x: unknown): string { const s = text(x); if (!FP.test(s)) fail(); return s; }
function id(x: unknown): string { const s = text(x); if (!ID.test(s)) fail(); return s; }
function b64(x: unknown, length?: number, max: number = ROOM_WIRE_LIMITS.roster): string {
  const s = text(x);
  if (s.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(s)) fail("limit");
  try { decodeBase64url(s, length); } catch { fail(); }
  return s;
}
export function positiveU64(x: unknown): string {
  const s = text(x);
  if (!/^[1-9][0-9]{0,19}$/.test(s) || BigInt(s) > U64_MAX) fail();
  return s;
}
function sorted<T>(values: T[], key: (x: T) => string): T[] {
  for (let i = 1; i < values.length; i++) if (key(values[i - 1]!) >= key(values[i]!)) fail();
  return values;
}
function array<T>(x: unknown, max: number, parse: (x: unknown) => T, nonempty = false): T[] {
  if (!Array.isArray(x) || x.length > max || (nonempty && x.length === 0)) fail("limit");
  return x.map(parse);
}
function publicIdentity(x: unknown): PublicHubIdentity {
  const o = object(x, ["fingerprint", "signingKey", "agreementKey"]);
  return { fingerprint: fingerprint(o.fingerprint), signingKey: b64(o.signingKey, 32), agreementKey: b64(o.agreementKey, 32) };
}
function exposed(x: unknown): string[] { return sorted(array(x, 64, id), x => x); }
function privateMember(x: unknown): RoomMember {
  const o = object(x, ["fingerprint", "signingKey", "agreementKey", "label", "exposedPeers"]);
  return { ...publicIdentity({ fingerprint: o.fingerprint, signingKey: o.signingKey, agreementKey: o.agreementKey }), label: id(o.label), exposedPeers: exposed(o.exposedPeers) };
}
function base(o: Record<string, unknown>, type: string): void { if (o.v !== 1 || o.type !== type) fail(); }
function ciphertext(x: unknown, max: number, exact?: number): string {
  const s = b64(x, exact, max);
  const n = decodeBase64url(s).length;
  if (n < 16 || n > max) fail("limit");
  return s;
}
function wrap(x: unknown): WrappedEpochKey {
  const o = object(x, ["v", "owner", "recipient", "ephemeralKey", "salt", "nonce", "ciphertext", "signature"]);
  if (o.v !== 1) fail();
  return { v: 1, owner: fingerprint(o.owner), recipient: fingerprint(o.recipient), ephemeralKey: b64(o.ephemeralKey, 32), salt: b64(o.salt, 32), nonce: b64(o.nonce, 12), ciphertext: ciphertext(o.ciphertext, 48, 48), signature: b64(o.signature, 64) };
}
function parseFrame(x: unknown): FrameWire {
  const o = object(x, ["v", "type", "room", "epoch", "sender", "recipients", "seq", "nonce", "ciphertext", "signature"]); base(o, "frame");
  return { v: 1, type: "frame", room: b64(o.room, 32), epoch: positiveU64(o.epoch), sender: fingerprint(o.sender), recipients: sorted(array(o.recipients, 64, fingerprint, true), x => x), seq: positiveU64(o.seq), nonce: b64(o.nonce, 12), ciphertext: ciphertext(o.ciphertext, 65552), signature: b64(o.signature, 64) };
}
function parseRoster(x: unknown): RosterWire {
  const o = object(x, ["v", "type", "room", "epoch", "owner", "members", "wraps", "privateNonce", "privateCiphertext", "signature"]); base(o, "roster");
  const members = sorted(array(o.members, 64, publicIdentity, true), x => x.fingerprint);
  const wraps = sorted(array(o.wraps, 64, wrap, true), x => x.recipient);
  const owner = fingerprint(o.owner);
  if (!members.some(m => m.fingerprint === owner) || wraps.length !== members.length || wraps.some((w, i) => w.owner !== owner || w.recipient !== members[i]!.fingerprint)) fail();
  return { v: 1, type: "roster", room: b64(o.room, 32), epoch: positiveU64(o.epoch), owner, members, wraps, privateNonce: b64(o.privateNonce, 12), privateCiphertext: ciphertext(o.privateCiphertext, 524288), signature: b64(o.signature, 64) };
}
function brokerUrl(x: unknown): string {
  const s = text(x); if (s.length > 2048 || !/^[\x21-\x7e]+$/.test(s)) fail();
  let u: URL; try { u = new URL(s); } catch { fail(); }
  if (u.username || u.password || u.hash || !u.hostname || (u.protocol !== "wss:" && !(u.protocol === "ws:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]")))) fail();
  if (u.href !== s) fail(); return s;
}
function timestamp(x: unknown): number { if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) fail(); return x; }
function parseInvite(x: unknown): InviteWire {
  const o = object(x, ["v", "type", "room", "owner", "broker", "inviteId", "expiresAt", "secret"]); base(o, "invite");
  return { v: 1, type: "invite", room: b64(o.room, 32), owner: fingerprint(o.owner), broker: brokerUrl(o.broker), inviteId: b64(o.inviteId, 32), expiresAt: timestamp(o.expiresAt), secret: b64(o.secret, 32) };
}
function parseJoin(x: unknown): JoinWire {
  const o = object(x, ["v", "type", "room", "owner", "inviteId", "member", "nonce", "privateNonce", "privateCiphertext", "signature", "mac"]); base(o, "join");
  return { v: 1, type: "join", room: b64(o.room, 32), owner: fingerprint(o.owner), inviteId: b64(o.inviteId, 32), member: publicIdentity(o.member), nonce: b64(o.nonce, 32), privateNonce: b64(o.privateNonce, 12), privateCiphertext: ciphertext(o.privateCiphertext, 4096), signature: b64(o.signature, 64), mac: b64(o.mac, 32) };
}
function decode<T>(input: Uint8Array, max: number, parse: (x: unknown) => T): T {
  if (!(input instanceof Uint8Array) || input.length > max) fail("limit");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); } catch { fail(); }
  const result = parse(raw), bytes = canonicalBytes(result);
  if (bytes.length !== input.length || bytes.some((b, i) => input[i] !== b)) fail();
  return result;
}
export const decodeFrame = (input: Uint8Array): FrameWire => decode(input, ROOM_WIRE_LIMITS.frame, parseFrame);
export const decodeRoster = (input: Uint8Array): RosterWire => decode(input, ROOM_WIRE_LIMITS.roster, parseRoster);
export const decodeInvite = (input: Uint8Array): InviteWire => decode(input, ROOM_WIRE_LIMITS.enrollment, parseInvite);
export const decodeJoin = (input: Uint8Array): JoinWire => decode(input, ROOM_WIRE_LIMITS.enrollment, parseJoin);
function unsigned<T extends { signature: string }>(x: T): Omit<T, "signature"> { const { signature: _, ...rest } = x; return rest; }
const domain = (purpose: string, value: unknown): Uint8Array => canonicalBytes(["agent-hub.rooms.v1", purpose, value]);
const digest = async (bytes: Uint8Array): Promise<string> => encodeBase64url(await sha256(bytes));
async function authenticateIdentity(identity: PublicHubIdentity): Promise<void> {
  const hash = await sha256(decodeBase64url(identity.signingKey, 32));
  if (Array.from(hash, b => b.toString(16).padStart(2, "0")).join("") !== identity.fingerprint) fail("untrusted");
}

/** Only instances minted by verification carry an epoch key. */
export interface VerifiedEpoch { readonly room: string; readonly epoch: string; readonly digest: string }
interface EpochState { roster: RosterWire; members: RoomMember[]; key: EpochKey }
const epochs = new WeakMap<VerifiedEpoch, EpochState>();
function state(epoch: VerifiedEpoch): EpochState { const s = epochs.get(epoch); if (!s) fail("untrusted"); return s; }
function verified(roster: RosterWire, members: RoomMember[], key: EpochKey, hash: string): VerifiedEpoch {
  const result = Object.freeze({ room: roster.room, epoch: roster.epoch, digest: hash });
  epochs.set(result, { roster, members, key }); return result;
}
export function roomMembers(epoch: VerifiedEpoch): RoomMember[] { return structuredClone(state(epoch).members); }
function rosterContext(roster: Pick<RosterWire, "room" | "epoch" | "owner" | "members">): Uint8Array {
  return domain("epoch", { room: roster.room, epoch: roster.epoch, owner: roster.owner, members: roster.members });
}
export interface OwnerPin { room: string; owner: string; minEpoch: string; digest?: string }
export async function acceptRoomEpoch(input: { wire: Uint8Array; identity: HubIdentity; pin: OwnerPin }): Promise<VerifiedEpoch> {
  await assertRoomCryptoReady();
  const roster = decodeRoster(input.wire), pin = input.pin;
  if (roster.room !== pin.room || roster.owner !== pin.owner) fail("untrusted");
  const min = positiveU64(pin.minEpoch);
  const rosterDigest = await digest(canonicalBytes(roster));
  if (BigInt(roster.epoch) < BigInt(min)) fail("wrong_epoch");
  if (roster.epoch === min && pin.digest !== undefined && rosterDigest !== pin.digest) fail("untrusted");
  for (const member of roster.members) await authenticateIdentity(member);
  const owner = roster.members.find(m => m.fingerprint === roster.owner)!;
  if (!await verifyBytes(owner, domain("roster-signature", unsigned(roster)), decodeBase64url(roster.signature, 64))) fail("authentication_failed");
  const own = roster.members.find(m => m.fingerprint === input.identity.public.fingerprint);
  if (!own || own.signingKey !== input.identity.public.signingKey || own.agreementKey !== input.identity.public.agreementKey) fail("untrusted");
  const context = rosterContext(roster);
  const key = await unwrapEpochKey({ recipient: input.identity, owner, context, wrapped: roster.wraps.find(w => w.recipient === own.fingerprint)! });
  const plain = await decryptEpoch({ key, purpose: "roster", context, nonce: decodeBase64url(roster.privateNonce, 12), ciphertext: decodeBase64url(roster.privateCiphertext) });
  const privateRoster = decode(plain, ROOM_WIRE_LIMITS.roster, x => {
    const o = object(x, ["room", "epoch", "members"]);
    return { room: b64(o.room, 32), epoch: positiveU64(o.epoch), members: sorted(array(o.members, 64, privateMember, true), m => m.fingerprint) };
  });
  if (privateRoster.room !== roster.room || privateRoster.epoch !== roster.epoch || privateRoster.members.length !== roster.members.length || privateRoster.members.some((m, i) => canonicalBytes({ fingerprint: m.fingerprint, signingKey: m.signingKey, agreementKey: m.agreementKey }).toString() !== canonicalBytes(roster.members[i]).toString()) || new Set(privateRoster.members.map(m => m.label)).size !== privateRoster.members.length) fail("untrusted");
  return verified(roster, privateRoster.members, key, rosterDigest);
}
export async function createRoomEpoch(input: { owner: HubIdentity; members: RoomMember[]; previous?: VerifiedEpoch }): Promise<{ wire: Uint8Array; epoch: VerifiedEpoch }> {
  await assertRoomCryptoReady();
  const members = sorted(input.members.map(privateMember).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), m => m.fingerprint);
  if (!members.length || members.length > 64 || new Set(members.map(m => m.label)).size !== members.length) fail();
  const owner = input.owner.public.fingerprint;
  const own = members.find(m => m.fingerprint === owner);
  if (!own || own.signingKey !== input.owner.public.signingKey || own.agreementKey !== input.owner.public.agreementKey) fail("untrusted");
  if (input.previous && state(input.previous).roster.owner !== owner) fail("untrusted");
  for (const member of members) await authenticateIdentity(member);
  const room = input.previous?.room ?? encodeBase64url(randomBytes(32));
  const epoch = positiveU64(input.previous ? String(BigInt(input.previous.epoch) + 1n) : "1");
  const publicMembers = members.map(({ label: _, exposedPeers: __, ...member }) => member);
  const header = { room, epoch, owner, members: publicMembers }, context = rosterContext(header);
  const key = await generateEpochKey(), wraps: WrappedEpochKey[] = [];
  for (const recipient of publicMembers) wraps.push(await wrapEpochKey({ owner: input.owner, recipient, context, key }));
  const nonce = randomBytes(12);
  const encrypted = await encryptEpoch({ key, purpose: "roster", context, nonce, plaintext: canonicalBytes({ room, epoch, members }) });
  const body = { v: 1 as const, type: "roster" as const, ...header, wraps, privateNonce: encodeBase64url(nonce), privateCiphertext: encodeBase64url(encrypted) };
  const roster = { ...body, signature: encodeBase64url(await signBytes(input.owner, domain("roster-signature", body))) };
  const wire = canonicalBytes(roster); decodeRoster(wire);
  return { wire, epoch: verified(roster, members, key, await digest(wire)) };
}

export interface SequencePort {
  /** Atomically persist a strictly increasing room/sender counter, never reset on epoch changes.
   * Refuse unless expectedCurrentDigest is still the installed current roster. */
  reserve(input: SequenceBinding): Promise<string>;
  /** Synchronous final fence after encryption/signing. X3 must additionally fence outbox publication. */
  isCurrent(input: SequenceBinding): boolean;
}
export interface SequenceBinding { room: string; sender: string; epoch: string; rosterDigest: string }
export interface ReplayCommit {
  room: string; sender: string; recipient: string; seq: string; frameDigest: string;
  frameEpoch: string; expectedCurrentEpoch: string; expectedCurrentDigest: string;
  selectedRosterDigest: string;
  previousExpiresAt: number | null;
  plaintext: Uint8Array;
}
export interface ReplayPort {
  /** One durable transaction: recheck installed current roster and persisted grace deadline,
   * reject revoked sender/recipient, compare+advance high-water, and record accepted digest.
   * Duplicate means a previously accepted identical digest, never an unseen lower seq.
   * The transaction uses its own local clock, not a remote timestamp or caller's nowMs.
   * X3 also commits inbox delivery here before any success receipt is created. */
  accept(input: ReplayCommit): Promise<
    { status: "accepted"; gap: string } | { status: "duplicate" | "stale" | "conflict" | "trust_changed" }
  >;
}
async function portCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch { fail("state_unavailable"); }
}
function sequenceNonce(seq: string): Uint8Array {
  const result = new Uint8Array(12);
  new DataView(result.buffer).setBigUint64(4, BigInt(positiveU64(seq)), false);
  return result;
}
function frameContext(epoch: VerifiedEpoch, sender: string): Uint8Array {
  return domain("sender-key", { room: epoch.room, epoch: epoch.epoch, sender, rosterDigest: epoch.digest });
}
function frameAad(frame: Pick<FrameWire, "room" | "epoch" | "sender" | "seq">): Uint8Array {
  return enc.encode(`${frame.room}|${frame.epoch}|${frame.sender}|${frame.seq}`);
}
export async function sealFrame(input: {
  epoch: VerifiedEpoch; identity: HubIdentity; recipients: string[]; plaintext: Uint8Array; sequence: SequencePort;
}): Promise<Uint8Array> {
  await assertRoomCryptoReady();
  const epoch = input.epoch, identity = input.identity, sequence = input.sequence;
  const current = state(epoch), sender = identity.public.fingerprint;
  const member = current.roster.members.find(m => m.fingerprint === sender);
  if (!member || member.signingKey !== input.identity.public.signingKey || member.agreementKey !== input.identity.public.agreementKey) fail("untrusted");
  if (!(input.plaintext instanceof Uint8Array) || input.plaintext.length > ROOM_WIRE_LIMITS.plaintext) fail("limit");
  const recipients = sorted(array(input.recipients, 64, fingerprint, true), x => x);
  if (recipients.some(fp => !current.roster.members.some(m => m.fingerprint === fp))) fail("untrusted");
  const plaintext = input.plaintext.slice();
  if (!sequence || typeof sequence.reserve !== "function" || typeof sequence.isCurrent !== "function") fail("state_unavailable");
  const binding = { room: epoch.room, sender, epoch: epoch.epoch, rosterDigest: epoch.digest };
  const seq = positiveU64(await portCall(() => sequence.reserve({ ...binding })));
  const header = { v: 1 as const, type: "frame" as const, room: epoch.room, epoch: epoch.epoch, sender, recipients, seq };
  const nonce = sequenceNonce(seq);
  const encrypted = await encryptEpoch({ key: current.key, purpose: "frame", context: frameContext(epoch, sender), aad: frameAad(header), nonce, plaintext });
  const body = { ...header, nonce: encodeBase64url(nonce), ciphertext: encodeBase64url(encrypted) };
  const wire = canonicalBytes({ ...body, signature: encodeBase64url(await signBytes(identity, domain("frame-signature", body))) });
  decodeFrame(wire);
  let fresh: boolean; try { fresh = sequence.isCurrent({ ...binding }); } catch { fail("state_unavailable"); }
  if (fresh !== true) fail("state_changed");
  return wire;
}
export type FrameOpenResult = { status: "accepted"; plaintext: Uint8Array; gap: string } | { status: "duplicate" | "stale" };
export async function openFrame(input: {
  wire: Uint8Array; identity: HubIdentity; current: VerifiedEpoch;
  previous?: { epoch: VerifiedEpoch; expiresAt: number }; replay: ReplayPort; nowMs?: number;
}): Promise<FrameOpenResult> {
  await assertRoomCryptoReady();
  const currentEpoch = input.current, identity = input.identity, replay = input.replay;
  const frame = decodeFrame(input.wire), current = state(currentEpoch), recipient = identity.public.fingerprint;
  if (frame.room !== currentEpoch.room || !frame.recipients.includes(recipient)) fail("untrusted");
  const receiver = current.roster.members.find(m => m.fingerprint === recipient);
  const sender = current.roster.members.find(m => m.fingerprint === frame.sender);
  if (!sender || !receiver || receiver.agreementKey !== input.identity.public.agreementKey || receiver.signingKey !== input.identity.public.signingKey) fail("untrusted");
  let selected = currentEpoch;
  let previousExpiresAt: number | null = null;
  if (frame.epoch !== currentEpoch.epoch) {
    const previous = input.previous;
    if (!previous || !Number.isSafeInteger(previous.expiresAt) || (input.nowMs ?? Date.now()) >= previous.expiresAt || previous.epoch.room !== frame.room || previous.epoch.epoch !== frame.epoch || BigInt(previous.epoch.epoch) + 1n !== BigInt(currentEpoch.epoch)) fail("wrong_epoch");
    const prior = state(previous.epoch);
    const priorSender = prior.roster.members.find(m => m.fingerprint === frame.sender);
    const priorReceiver = prior.roster.members.find(m => m.fingerprint === recipient);
    if (!priorSender || !priorReceiver || priorSender.signingKey !== sender.signingKey || priorSender.agreementKey !== sender.agreementKey || priorReceiver.signingKey !== receiver.signingKey || priorReceiver.agreementKey !== receiver.agreementKey || prior.roster.owner !== current.roster.owner) fail("untrusted");
    selected = previous.epoch; previousExpiresAt = previous.expiresAt;
  }
  const selectedState = state(selected);
  if (frame.recipients.some(fp => !selectedState.roster.members.some(m => m.fingerprint === fp))) fail("untrusted");
  if (!await verifyBytes(sender, domain("frame-signature", unsigned(frame)), decodeBase64url(frame.signature, 64))) fail("authentication_failed");
  const nonce = sequenceNonce(frame.seq);
  if (encodeBase64url(nonce) !== frame.nonce) fail("authentication_failed");
  const plaintext = await decryptEpoch({ key: selectedState.key, purpose: "frame", context: frameContext(selected, frame.sender), aad: frameAad(frame), nonce, ciphertext: decodeBase64url(frame.ciphertext) });
  if (plaintext.length > ROOM_WIRE_LIMITS.plaintext) fail("limit");
  if (!replay || typeof replay.accept !== "function") fail("state_unavailable");
  const frameDigest = await digest(canonicalBytes(frame));
  const result = await portCall(() => replay.accept({ room: frame.room, sender: frame.sender, recipient, seq: frame.seq, frameDigest, frameEpoch: frame.epoch, expectedCurrentEpoch: currentEpoch.epoch, expectedCurrentDigest: currentEpoch.digest, selectedRosterDigest: selected.digest, previousExpiresAt, plaintext: plaintext.slice() }));
  if (!result || typeof result !== "object") fail("state_unavailable");
  if (result.status === "accepted") {
    if (typeof result.gap !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(result.gap) || BigInt(result.gap) > U64_MAX) fail("state_unavailable");
    return { status: "accepted", plaintext, gap: result.gap };
  }
  if (result.status === "duplicate" || result.status === "stale") return { status: result.status };
  fail("state_changed");
}

function inviteClaims(invite: InviteWire): Omit<InviteWire, "secret"> { const { secret: _, ...claims } = invite; return claims; }
export async function createInvite(input: {
  epoch: VerifiedEpoch; owner: HubIdentity; broker: string; expiresAt: number; nowMs?: number;
}): Promise<Uint8Array> {
  await assertRoomCryptoReady();
  const s = state(input.epoch);
  if (s.roster.owner !== input.owner.public.fingerprint) fail("untrusted");
  const expiresAt = timestamp(input.expiresAt);
  if (expiresAt <= (input.nowMs ?? Date.now())) fail("expired");
  const token: InviteWire = { v: 1, type: "invite", room: input.epoch.room, owner: s.roster.owner, broker: brokerUrl(input.broker), inviteId: encodeBase64url(randomBytes(32)), expiresAt, secret: encodeBase64url(randomBytes(32)) };
  const wire = canonicalBytes(token); decodeInvite(wire); return wire;
}
function joinCore(join: JoinWire): Omit<JoinWire, "signature" | "mac"> { const { signature: _, mac: __, ...core } = join; return core; }
function joinContext(invite: InviteWire, member: PublicHubIdentity, nonce: string): Uint8Array {
  return domain("join-private", { invite: inviteClaims(invite), member, nonce });
}
export async function createJoin(input: {
  invite: Uint8Array; identity: HubIdentity; label: string; exposedPeers: string[]; nowMs?: number;
}): Promise<Uint8Array> {
  await assertRoomCryptoReady();
  const invite = decodeInvite(input.invite);
  // Joiner preflight tolerates a 10 minute remote-clock difference. Owner expiry is exact.
  if ((input.nowMs ?? Date.now()) > invite.expiresAt + 600000) fail("expired");
  const privateData = { label: id(input.label), exposedPeers: exposed(input.exposedPeers) };
  const member = publicIdentity(input.identity.public), nonce = encodeBase64url(randomBytes(32));
  await authenticateIdentity(member);
  const privateNonce = randomBytes(12), secret = decodeBase64url(invite.secret, 32);
  const key = await importEpochKey(secret);
  const encrypted = await encryptEpoch({ key, purpose: "invite", context: joinContext(invite, member, nonce), nonce: privateNonce, plaintext: canonicalBytes(privateData) });
  const core = { v: 1 as const, type: "join" as const, room: invite.room, owner: invite.owner, inviteId: invite.inviteId, member, nonce, privateNonce: encodeBase64url(privateNonce), privateCiphertext: encodeBase64url(encrypted) };
  const signature = encodeBase64url(await signBytes(input.identity, domain("join-signature", { invite: inviteClaims(invite), request: core })));
  const body = { ...core, signature };
  const wire = canonicalBytes({ ...body, mac: encodeBase64url(await hmac(secret, domain("join-mac", { invite: inviteClaims(invite), request: body }))) });
  decodeJoin(wire); return wire;
}
export interface EnrollmentPort {
  /** Transactionally compare original stored invite digest/expiry against the owner clock,
   * consume its one-time secret, bind admitted identity + request digest, and persist outcome.
   * Only the exact same request digest may return duplicate; changed context refuses.
   * X3 must bind membership publication to this durable enrollment outcome. */
  consume(input: {
    room: string; owner: string; inviteId: string; inviteDigest: string; requestDigest: string;
    expiresAt: number; member: RoomMember;
  }): Promise<"accepted" | "duplicate" | "refused">;
}
export async function acceptJoin(input: {
  issuedInvite: Uint8Array; wire: Uint8Array; owner: HubIdentity; enrollment: EnrollmentPort; nowMs?: number;
}): Promise<{ status: "accepted"; member: RoomMember } | { status: "duplicate" }> {
  await assertRoomCryptoReady();
  const invite = decodeInvite(input.issuedInvite), join = decodeJoin(input.wire);
  if (invite.owner !== input.owner.public.fingerprint || join.room !== invite.room || join.owner !== invite.owner || join.inviteId !== invite.inviteId) fail("untrusted");
  if ((input.nowMs ?? Date.now()) >= invite.expiresAt) fail("expired");
  const secret = decodeBase64url(invite.secret, 32), core = joinCore(join);
  if (!await verifyHmac(secret, domain("join-mac", { invite: inviteClaims(invite), request: { ...core, signature: join.signature } }), decodeBase64url(join.mac, 32))) fail("authentication_failed");
  await authenticateIdentity(join.member);
  if (!await verifyBytes(join.member, domain("join-signature", { invite: inviteClaims(invite), request: core }), decodeBase64url(join.signature, 64))) fail("authentication_failed");
  const key = await importEpochKey(secret);
  const plain = await decryptEpoch({ key, purpose: "invite", context: joinContext(invite, join.member, join.nonce), nonce: decodeBase64url(join.privateNonce, 12), ciphertext: decodeBase64url(join.privateCiphertext) });
  const privateData = decode(plain, 4096, x => { const o = object(x, ["label", "exposedPeers"]); return { label: id(o.label), exposedPeers: exposed(o.exposedPeers) }; });
  if (!input.enrollment || typeof input.enrollment.consume !== "function") fail("state_unavailable");
  const inviteDigest = await digest(canonicalBytes(invite)), requestDigest = await digest(canonicalBytes(join));
  const member = { ...join.member, ...privateData };
  const result = await portCall(() => input.enrollment.consume({ room: invite.room, owner: invite.owner, inviteId: invite.inviteId, inviteDigest, requestDigest, expiresAt: invite.expiresAt, member: structuredClone(member) }));
  if (result === "accepted") return { status: "accepted", member };
  if (result === "duplicate") return { status: "duplicate" };
  fail("state_changed");
}
