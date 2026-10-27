/** Broker v1 control protocol. The broker verifies public signatures and never opens room ciphertext. */
import {
  decodeBase64url, encodeBase64url, signBytes, verifyBytes,
  type HubIdentity,
} from "../rooms/crypto.ts";
import {
  brokerUrl, canonicalBytes, decodeRoster, publicRosterWire, verifyPublicRoster,
  type OwnerPin, type VerifiedPublicRoster,
} from "../rooms/wire.ts";

export const BROKER_CONTROL_LIMITS = Object.freeze({ control: 1_048_576, challenge: 8192, nonceBytes: 32 });
export type BrokerProtocolCode = "invalid_wire" | "limit" | "untrusted" | "expired" | "authentication_failed";
export class BrokerProtocolError extends Error {
  constructor(readonly code: BrokerProtocolCode) { super(`Broker protocol: ${code}`); this.name = "BrokerProtocolError"; }
}
function fail(code: BrokerProtocolCode = "invalid_wire"): never { throw new BrokerProtocolError(code); }
const decoder = new TextDecoder("utf-8", { fatal: true });
const FP = /^[0-9a-f]{64}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface BrokerChallenge {
  v: 1;
  type: "challenge";
  room: string;
  broker: string;
  nonce: string;
  expiresAt: number;
  rosterDigest: string | null;
}
export interface BrokerAuth {
  v: 1;
  type: "auth";
  member: string;
  roster: string | null;
  signature: string;
}
export interface BrokerRosterReady { v: 1; type: "roster_ready"; digest: string }
export interface BrokerReceived { v: 1; type: "received"; digest: string }
export type BrokerControl = BrokerAuth | BrokerRosterReady | BrokerReceived;

function record(x: unknown, keys: string[]): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x) || Object.getPrototypeOf(x) !== Object.prototype) fail();
  const value = x as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}
function canonicalDecode<T>(input: Uint8Array, max: number, parse: (value: unknown) => T): T {
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > max) fail("limit");
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(input)); } catch { fail(); }
  const value = parse(raw), bytes = canonicalBytes(value);
  if (bytes.length !== input.length || bytes.some((byte, i) => input[i] !== byte)) fail();
  return value;
}
function exactText(x: unknown, pattern: RegExp): string {
  if (typeof x !== "string" || !pattern.test(x)) fail();
  return x;
}
function roomId(x: unknown): string {
  if (typeof x !== "string" || x.length !== 43 || !B64URL.test(x)) fail();
  try { decodeBase64url(x, 32); } catch { fail(); }
  return x;
}
function digestText(x: unknown): string {
  const value = exactText(x, DIGEST);
  try { decodeBase64url(value, 32); } catch { fail(); }
  return value;
}
function timestamp(x: unknown): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) fail();
  return x;
}
function nullableDigest(x: unknown): string | null { return x === null ? null : digestText(x); }
function brokerAudience(value: unknown): string {
  try {
    const normalized = brokerUrl(value), url = new URL(normalized);
    if (url.pathname !== "/" || url.search) fail();
    return normalized;
  } catch { return fail(); }
}
function parseChallenge(x: unknown): BrokerChallenge {
  const o = record(x, ["v", "type", "room", "broker", "nonce", "expiresAt", "rosterDigest"]);
  if (o.v !== 1 || o.type !== "challenge") fail();
  const nonce = exactText(o.nonce, B64URL);
  try { decodeBase64url(nonce, BROKER_CONTROL_LIMITS.nonceBytes); } catch { fail(); }
  return { v: 1, type: "challenge", room: roomId(o.room), broker: brokerAudience(o.broker), nonce,
    expiresAt: timestamp(o.expiresAt), rosterDigest: nullableDigest(o.rosterDigest) };
}
function parseAuth(x: unknown): BrokerAuth {
  const o = record(x, ["v", "type", "member", "roster", "signature"]);
  if (o.v !== 1 || o.type !== "auth") fail();
  let roster: string | null = null;
  if (o.roster !== null) {
    roster = exactText(o.roster, B64URL);
    if (roster.length > Math.ceil(524288 * 4 / 3)) fail("limit");
    let wire: Uint8Array;
    try { wire = decodeBase64url(roster); } catch { fail(); }
    decodeRoster(wire);
  }
  const signature = exactText(o.signature, B64URL);
  try { decodeBase64url(signature, 64); } catch { fail(); }
  return { v: 1, type: "auth", member: exactText(o.member, FP), roster, signature };
}
function parseControl(x: unknown): BrokerControl {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail();
  const type = (x as Record<string, unknown>).type;
  if (type === "auth") return parseAuth(x);
  if (type === "roster_ready" || type === "received") {
    const o = record(x, ["v", "type", "digest"]);
    if (o.v !== 1 || o.type !== type) fail();
    return { v: 1, type: type as "roster_ready" | "received", digest: digestText(o.digest) };
  }
  fail();
}
function challengeBytes(challenge: BrokerChallenge, member: string, initialRosterDigest: string | null): Uint8Array {
  return canonicalBytes(["agent-hub.rooms.broker.v1", "auth", challenge, member, initialRosterDigest]);
}
function validateChallenge(challenge: BrokerChallenge): BrokerChallenge {
  return parseChallenge(challenge);
}

export function decodeBrokerChallenge(input: Uint8Array): BrokerChallenge {
  return canonicalDecode(input, BROKER_CONTROL_LIMITS.challenge, parseChallenge);
}
export function encodeBrokerChallenge(challenge: BrokerChallenge): Uint8Array {
  return canonicalBytes(validateChallenge(challenge));
}
export function decodeBrokerControl(input: Uint8Array): BrokerControl {
  return canonicalDecode(input, BROKER_CONTROL_LIMITS.control, parseControl);
}
export function encodeBrokerControl(control: BrokerControl): Uint8Array {
  return canonicalBytes(parseControl(control));
}

export async function createBrokerAuth(input: {
  challenge: BrokerChallenge;
  identity: HubIdentity;
  broker: string;
  room: string;
  initialRoster?: Uint8Array;
}): Promise<Uint8Array> {
  const challenge = validateChallenge(input.challenge);
  if (brokerAudience(input.broker) !== challenge.broker || roomId(input.room) !== challenge.room) fail("untrusted");
  const member = input.identity.public.fingerprint;
  if (!FP.test(member)) fail("untrusted");
  let rosterWire: string | null = null;
  let rosterDigest: string | null = null;
  if (input.initialRoster !== undefined) {
    if (challenge.rosterDigest !== null) fail("untrusted");
    if (!(input.initialRoster instanceof Uint8Array)) fail();
    const initialRoster = Uint8Array.from(input.initialRoster);
    const decoded = decodeRoster(initialRoster);
    const pin: OwnerPin = { room: decoded.room, owner: decoded.owner, minEpoch: "0" };
    const proof = await verifyPublicRoster({ wire: initialRoster, pin });
    if (proof.room !== challenge.room || proof.owner !== member || !proof.members.some(m => m.fingerprint === member)) fail("untrusted");
    rosterWire = encodeBase64url(initialRoster);
    rosterDigest = proof.digest;
  } else {
    if (challenge.rosterDigest === null) fail("untrusted");
    rosterDigest = null;
  }
  const body = { v: 1 as const, type: "auth" as const, member, roster: rosterWire };
  const auth = { ...body, signature: encodeBase64url(await signBytes(input.identity, challengeBytes(challenge, member, rosterDigest))) };
  const wire = canonicalBytes(auth);
  parseAuth(auth);
  return wire;
}

/** Verify the challenge signature and resolve the public roster used for membership. */
export async function verifyBrokerAuth(input: {
  wire: Uint8Array;
  challenge: BrokerChallenge;
  roster?: VerifiedPublicRoster;
}): Promise<{ member: string; roster: VerifiedPublicRoster; initial: boolean }> {
  const challenge = validateChallenge(input.challenge);
  const auth = canonicalDecode(input.wire, BROKER_CONTROL_LIMITS.control, parseAuth);
  let roster: VerifiedPublicRoster;
  let signedRosterDigest: string | null;
  let initial: boolean;
  if (challenge.rosterDigest === null) {
    if (auth.roster === null || input.roster !== undefined) fail("untrusted");
    let rosterWire: Uint8Array;
    try { rosterWire = decodeBase64url(auth.roster); } catch { fail(); }
    const decoded = decodeRoster(rosterWire);
    roster = await verifyPublicRoster({ wire: rosterWire, pin: { room: decoded.room, owner: decoded.owner, minEpoch: "0" } });
    if (roster.room !== challenge.room || roster.owner !== auth.member) fail("untrusted");
    signedRosterDigest = roster.digest;
    initial = true;
  } else {
    if (auth.roster !== null || !input.roster) fail("untrusted");
    roster = input.roster;
    publicRosterWire(roster);
    if (roster.room !== challenge.room || roster.digest !== challenge.rosterDigest) fail("untrusted");
    signedRosterDigest = null;
    initial = false;
  }
  const member = roster.members.find(candidate => candidate.fingerprint === auth.member);
  if (!member) fail("untrusted");
  const signature = decodeBase64url(auth.signature, 64);
  if (!await verifyBytes(member, challengeBytes(challenge, auth.member, signedRosterDigest), signature)) fail("authentication_failed");
  return { member: auth.member, roster, initial };
}
