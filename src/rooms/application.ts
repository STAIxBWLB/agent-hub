/** Encrypted X4 application payloads. Transport signatures/epochs remain in wire.ts. */
import { MAX_HOP, type Priority } from "../hub/envelope.ts";
import { decodeBase64url } from "./crypto.ts";
import { canonicalBytes, ROOM_WIRE_LIMITS } from "./wire.ts";

export const ROOM_APPLICATION_MAX_BYTES = ROOM_WIRE_LIMITS.plaintext;
export interface RoomChatEnvelope {
  id: string; trace: string; hop: number; from: string; to: string;
  kind: "chat" | "status" | "invocation" | "invocation_result"; priority: Priority; body: string; ts: number;
}
export type RoomReceiptReason = "admitted" | "inbox_admitted" | "inbox_full" | "inbox_oversize" | "inbox_expired" | "inbox_age_unavailable" | "not_exposed" | "boundary_refused" | "invalid_message" | "rate_limited" | "hop" | "person_inbox_unsupported";
export type RoomMessage =
  | { v: 1; type: "chat"; envelope: RoomChatEnvelope }
  | { v: 1; type: "receipt"; frame: string; application: string; peer: string; outcome: "completed" | "failed_safe"; reason: RoomReceiptReason };
export class RoomApplicationError extends Error {
  constructor(readonly code: "invalid_message" | "limit") { super(`Room application: ${code}`); this.name = "RoomApplicationError"; }
}
function fail(code: "invalid_message" | "limit" = "invalid_message"): never { throw new RoomApplicationError(code); }
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const REMOTE_ID = /^([a-z][a-z0-9-]{0,31})@([a-z][a-z0-9-]{0,31})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_TEXT: Readonly<Record<RoomReceiptReason, string>> = Object.freeze({
  admitted: "admitted", inbox_admitted: "admitted to person inbox", inbox_full: "person inbox full",
  inbox_oversize: "person inbox message too large", inbox_expired: "person inbox message expired",
  inbox_age_unavailable: "person inbox admission age unavailable", not_exposed: "peer not exposed", boundary_refused: "room boundary refused",
  invalid_message: "invalid room message", rate_limited: "room rate limit", hop: "hop limit",
  person_inbox_unsupported: "person inbox not supported yet (X5)",
});
const REASONS: readonly RoomReceiptReason[] = ["admitted", "inbox_admitted", "inbox_full", "inbox_oversize", "inbox_expired", "inbox_age_unavailable", "not_exposed", "boundary_refused", "invalid_message", "rate_limited", "hop", "person_inbox_unsupported"];
/** Fixed operator text only; a diagnostic or remote field can never become a rendered reason. */
export function roomReceiptReasonText(reason: RoomReceiptReason): string {
  return Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason] : "room receipt unavailable";
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function isRoomLocalPeerId(value: unknown): value is string {
  return typeof value === "string" && LOCAL_ID.exec(value)?.[0] === value && value !== "hub" && value !== "digest";
}
/** Remote humans are user@label, never local console authority. Labels come from the signed private roster. */
export function parseRemotePeerId(value: unknown): { peer: string; label: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = REMOTE_ID.exec(value);
  if (!match || match[0] !== value || !isRoomLocalPeerId(match[1])) return undefined;
  return { peer: match[1], label: match[2]! };
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) fail();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) fail();
  return value;
}
function localPeer(value: unknown): string { if (!isRoomLocalPeerId(value)) fail(); return value; }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail();
  if (encoder.encode(value).length > ROOM_APPLICATION_MAX_BYTES) fail("limit");
  return value;
}
export type RoomInvocationKind = "invocation" | "invocation_result";
export interface RoomReadInvocationRequest {
  invocation: string; capability: string; digest: string; class: "read"; depth: 1;
  args: Record<string, string | number | boolean>;
}
export interface RoomReadInvocationResult {
  invocation: string; capability: string; digest: string; class: "read";
  outcome: "completed" | "refused" | "failed" | "expired" | "timeout" | "needs_review" | "withheld";
  body: string;
}
export type RoomInvocationPayload = RoomReadInvocationRequest | RoomReadInvocationResult;
/** Wire contract bounds; the target still validates the capability's actual schema. */
const INVOCATION_ARGS_MAX = 4096, INVOCATION_STRING_MAX = 2000, INVOCATION_RESULT_MAX = 8192;
const CAPABILITY_ID = /^(command|skill|mcp_tool):[A-Za-z0-9_.:-]{1,64}$/;
const CAPABILITY_DIGEST = /^sha256:[0-9a-f]{64}$/;
export function roomInvocationArgs(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.length > 16) fail("limit");
  const raw = object(value, keys), args = Object.create(null) as Record<string, string | number | boolean>;
  for (const key of keys) {
    if (/^[A-Za-z0-9_.:-]{1,64}$/.exec(key)?.[0] !== key) fail();
    const arg = raw[key];
    if (typeof arg === "string") { if (!arg.isWellFormed() || arg.length > INVOCATION_STRING_MAX) fail("limit"); }
    else if (typeof arg !== "boolean" && (typeof arg !== "number" || !Number.isFinite(arg))) fail();
    Object.defineProperty(args, key, { value: arg, enumerable: true });
  }
  if (JSON.stringify(args).length > INVOCATION_ARGS_MAX) fail("limit");
  return Object.fromEntries(Object.entries(args));
}
function invocationPayload(kind: RoomInvocationKind, value: unknown): RoomInvocationPayload {
  const row = object(value, kind === "invocation" ? ["invocation", "capability", "digest", "class", "depth", "args"] : ["invocation", "capability", "digest", "class", "outcome", "body"]);
  if (row.class !== "read" || typeof row.capability !== "string" || CAPABILITY_ID.exec(row.capability)?.[0] !== row.capability
    || typeof row.digest !== "string" || CAPABILITY_DIGEST.exec(row.digest)?.[0] !== row.digest) fail();
  const common = { invocation: uuid(row.invocation), capability: row.capability, digest: row.digest, class: "read" as const };
  if (kind === "invocation") {
    if (row.depth !== 1) fail();
    return { ...common, depth: 1, args: roomInvocationArgs(row.args) };
  }
  if (typeof row.outcome !== "string" || !["completed", "refused", "failed", "expired", "timeout", "needs_review", "withheld"].includes(row.outcome)) fail();
  const body = text(row.body);
  if (encoder.encode(body).length > INVOCATION_RESULT_MAX) fail("limit");
  if (row.outcome === "withheld" && body !== "") fail();
  return { ...common, outcome: row.outcome as RoomReadInvocationResult["outcome"], body };
}
/** Closed canonical JSON inside the encrypted envelope: no refs, approvals or extra authority fields. */
export function encodeRoomInvocationBody(kind: RoomInvocationKind, value: RoomInvocationPayload): string {
  try { return decoder.decode(canonicalBytes(invocationPayload(kind, value))); }
  catch (error) { return applicationError(error); }
}
export function decodeRoomInvocationBody(kind: "invocation", body: string): RoomReadInvocationRequest;
export function decodeRoomInvocationBody(kind: "invocation_result", body: string): RoomReadInvocationResult;
export function decodeRoomInvocationBody(kind: RoomInvocationKind, body: string): RoomInvocationPayload;
export function decodeRoomInvocationBody(kind: RoomInvocationKind, body: string): RoomInvocationPayload {
  try {
    const parsed = invocationPayload(kind, JSON.parse(text(body)));
    if (decoder.decode(canonicalBytes(parsed)) !== body) fail();
    return parsed;
  } catch (error) { return applicationError(error); }
}

function parseEnvelope(value: unknown): RoomChatEnvelope {
  const row = object(value, ["id", "trace", "hop", "from", "to", "kind", "priority", "body", "ts"]);
  if (row.kind !== "chat" && row.kind !== "status" && row.kind !== "invocation" && row.kind !== "invocation_result") fail();
  if (row.priority !== "important" && row.priority !== "status" && row.priority !== "fyi") fail();
  if (row.kind === "invocation" || row.kind === "invocation_result") {
    const payload = decodeRoomInvocationBody(row.kind, text(row.body));
    if (row.from === "user" || row.to === "user" || row.priority !== "status" || row.kind === "invocation" && payload.invocation !== row.id) fail();
  }
  return { id: uuid(row.id), trace: uuid(row.trace), hop: integer(row.hop, 0, MAX_HOP), from: localPeer(row.from), to: localPeer(row.to), kind: row.kind, priority: row.priority, body: text(row.body), ts: integer(row.ts, 0) };
}
function frameDigest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 43) fail();
  try { decodeBase64url(value, 32); } catch { fail(); }
  return value;
}
function parseMessage(value: unknown): RoomMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const type = (value as Record<string, unknown>).type;
  if (type === "chat") {
    const row = object(value, ["v", "type", "envelope"]);
    if (row.v !== 1) fail();
    return { v: 1, type, envelope: parseEnvelope(row.envelope) };
  }
  if (type === "receipt") {
    const row = object(value, ["v", "type", "frame", "application", "peer", "outcome", "reason"]);
    if (row.v !== 1 || row.outcome !== "completed" && row.outcome !== "failed_safe" || !REASONS.includes(row.reason as RoomReceiptReason)
      || row.outcome === "completed" && row.reason !== "admitted" && row.reason !== "inbox_admitted"
      || row.outcome === "failed_safe" && (row.reason === "admitted" || row.reason === "inbox_admitted")) fail();
    return { v: 1, type, frame: frameDigest(row.frame), application: uuid(row.application), peer: localPeer(row.peer), outcome: row.outcome, reason: row.reason as RoomReceiptReason };
  }
  return fail();
}
function applicationError(error: unknown): never {
  if (error instanceof RoomApplicationError) throw error;
  return fail();
}
export function encodeRoomMessage(message: RoomMessage): Uint8Array {
  try {
    const wire = canonicalBytes(parseMessage(message));
    if (wire.length > ROOM_APPLICATION_MAX_BYTES) fail("limit");
    return wire;
  } catch (error) { return applicationError(error); }
}
export function decodeRoomMessage(wire: Uint8Array): RoomMessage {
  try {
    if (!(wire instanceof Uint8Array) || wire.length === 0) fail();
    if (wire.length > ROOM_APPLICATION_MAX_BYTES) fail("limit");
    const bytes = Uint8Array.from(wire), message = parseMessage(JSON.parse(decoder.decode(bytes))), canonical = canonicalBytes(message);
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) fail();
    return message;
  } catch (error) { return applicationError(error); }
}
