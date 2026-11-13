import { types } from "node:util";
import type { PeerState } from "../hub/envelope.ts";
import { decodeBase64url, encodeBase64url } from "./crypto.ts";
import { parseRemotePeerId } from "./application.ts";
import { ROOM_HEALTH_CAUSES, roomHealthNextStep, type RoomHealthCause } from "./health.ts";

const ROOM_LIMIT = 64;
const REMOTE_PEER_LIMIT = 4096;
const REMOTE_PEER_TOTAL_LIMIT = 4096;
const MEMBER_LIMIT = 64;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const EPOCH = /^[1-9][0-9]{0,19}$/;
const LINK_STATES = new Set(["online", "connecting", "offline", "left"]);
const PEER_STATES = new Set<PeerState>(["idle", "busy", "paused", "offline"]);

export interface RoomStatusHealth {
  refused: { invalid_presence: number; wrong_epoch: number; trust_changed: number; stale: number; invalid_frame: number } | null;
  outboxDepth: number | null;
  oldestOutboxAgeMs: number | null;
  lastReceiptAgeMs: number | null;
}

export interface RoomStatusPeer {
  id: string;
  state: PeerState;
  presence?: PeerState | "unknown";
  liveness?: "untracked";
}

export interface RoomRelayStats {
  since: number;
  outbound: number | null;
  inbound: number | null;
  withheld: number | null;
}

export interface RoomStatusDiagnostics {
  health?: RoomStatusHealth | null;
  linkCause?: RoomHealthCause | null;
  linkNextStep?: string | null;
}
export interface RoomStatusUnavailable { code: RoomHealthCause | null; nextStep: string | null }

/** Allowlisted room metadata. Missing member counts and peer lists stay unknown. */
export interface RoomStatusView extends RoomStatusDiagnostics {
  name: string;
  room: string;
  owner: string;
  member: string;
  epoch: string;
  link: "online" | "connecting" | "offline" | "left" | null;
  memberCount: number | null;
  remotePeers: RoomStatusPeer[] | null;
  relays: RoomRelayStats | null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

function plainArray(value: unknown): value is unknown[] {
  return !!value && typeof value === "object" && !types.isProxy(value) && Array.isArray(value);
}

/** Read own data properties only; accessors and hostile proxies are never evaluated. */
function ownField(value: unknown, key: string): { present: boolean; value?: unknown } {
  if (!value || typeof value !== "object" || types.isProxy(value)) return { present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false };
    return Object.hasOwn(descriptor, "value") ? { present: true, value: descriptor.value } : { present: true };
  } catch { return { present: false }; }
}

function ownData(value: unknown, key: string): unknown {
  const field = ownField(value, key);
  return field.present ? field.value : undefined;
}

function arrayItem(value: unknown[], index: number): unknown {
  if (types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

function roomId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43) return false;
  try { return encodeBase64url(decodeBase64url(value, 32)) === value; } catch { return false; }
}

function validEpoch(value: unknown): value is string {
  if (typeof value !== "string" || !EPOCH.test(value)) return false;
  try { return BigInt(value) <= UINT64_MAX; } catch { return false; }
}

function memberCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MEMBER_LIMIT ? value : null;
}

/** Invalid or absent remote peer metadata stays unknown; no body, title, or arbitrary row is copied. */
function remotePeers(value: unknown, remaining: number): RoomStatusPeer[] | null {
  if (!plainArray(value) || value.length > REMOTE_PEER_LIMIT || value.length > remaining) return null;
  const result: RoomStatusPeer[] = [], ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = arrayItem(value, index);
    if (!plainRecord(item)) return null;
    const id = ownData(item, "id"), state = ownData(item, "state");
    if (typeof id !== "string" || !parseRemotePeerId(id) || typeof state !== "string" || !PEER_STATES.has(state as PeerState) || ids.has(id)) return null;
    const presenceField = ownField(item, "presence"), livenessField = ownField(item, "liveness");
    if (presenceField.present && !Object.hasOwn(presenceField, "value") || livenessField.present && !Object.hasOwn(livenessField, "value")) return null;
    const presence = presenceField.value, liveness = livenessField.value;
    if (presence !== undefined && presence !== "unknown" && (typeof presence !== "string" || !PEER_STATES.has(presence as PeerState))) return null;
    if (liveness !== undefined && liveness !== "untracked") return null;
    ids.add(id);
    result.push({ id, state: state as PeerState, ...(presence !== undefined ? { presence: presence as RoomStatusPeer["presence"] } : {}), ...(liveness === "untracked" ? { liveness } : {}) });
  }
  return result;
}

function relayCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Relay totals are daemon-boot scoped; absent, malformed or inconsistent values stay unknown. */
function relayStats(value: unknown): RoomRelayStats | null {
  if (!plainRecord(value)) return null;
  const since = ownData(value, "since");
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since <= 0 || since > DATE_MAX_MS) return null;
  const outbound = relayCount(ownData(value, "outbound")), inbound = relayCount(ownData(value, "inbound"));
  const rawWithheld = relayCount(ownData(value, "withheld"));
  const withheld = outbound !== null && rawWithheld !== null && rawWithheld <= outbound ? rawWithheld : null;
  return { since, outbound, inbound, withheld };
}

/** Counts and ages remain unknown when an older daemon cannot report them. */
export function projectRoomHealth(value: unknown): RoomStatusHealth | null {
  if (!plainRecord(value)) return null;
  const rawRefused = ownData(value, "refused");
  let refused: RoomStatusHealth["refused"] = null;
  if (plainRecord(rawRefused)) {
    const invalid_presence = relayCount(ownData(rawRefused, "invalid_presence")), wrong_epoch = relayCount(ownData(rawRefused, "wrong_epoch"));
    const trust_changed = relayCount(ownData(rawRefused, "trust_changed")), stale = relayCount(ownData(rawRefused, "stale")), invalid_frame = relayCount(ownData(rawRefused, "invalid_frame"));
    if (invalid_presence !== null && wrong_epoch !== null && trust_changed !== null && stale !== null && invalid_frame !== null)
      refused = { invalid_presence, wrong_epoch, trust_changed, stale, invalid_frame };
  }
  return { refused, outboxDepth: relayCount(ownData(value, "outboxDepth")),
    oldestOutboxAgeMs: relayCount(ownData(value, "oldestOutboxAgeMs")), lastReceiptAgeMs: relayCount(ownData(value, "lastReceiptAgeMs")) };
}

function healthCause(value: unknown): RoomHealthCause | null {
  return typeof value === "string" && ROOM_HEALTH_CAUSES.includes(value as RoomHealthCause) ? value as RoomHealthCause : null;
}

/** Regenerate guidance from closed causes; arbitrary daemon text is never copied. */
export function projectRoomDiagnostics(value: unknown): RoomStatusDiagnostics {
  if (!plainRecord(value)) return {};
  const cause = healthCause(ownData(value, "linkCause"));
  const result: RoomStatusDiagnostics = {};
  if (ownField(value, "health").present) result.health = projectRoomHealth(ownData(value, "health"));
  if (ownField(value, "linkCause").present) {
    result.linkCause = cause;
    result.linkNextStep = null;
    if (cause !== null) result.linkNextStep = roomHealthNextStep(cause);
  }
  return result;
}

/** Absent or malformed availability metadata stays unknown without evaluating getters. */
export function projectRoomUnavailable(value: unknown): RoomStatusUnavailable | null {
  if (!plainRecord(value)) return null;
  const code = healthCause(ownData(value, "code"));
  return { code, nextStep: code === null ? null : roomHealthNextStep(code) };
}

/** Project RoomCommands.rows-compatible data to body-free room status metadata. */
export function projectRoomStatus(value: unknown): RoomStatusView[] {
  try {
    if (!plainArray(value) || value.length > ROOM_LIMIT) return [];
    const views: RoomStatusView[] = [];
    let remainingRemotePeers = REMOTE_PEER_TOTAL_LIMIT;
    for (let index = 0; index < value.length; index++) {
      const item = arrayItem(value, index);
      if (!plainRecord(item)) continue;
      const name = ownData(item, "name"), room = ownData(item, "room"), owner = ownData(item, "owner");
      const member = ownData(item, "member"), epoch = ownData(item, "epoch");
      if (typeof name !== "string" || !NAME.test(name) || !roomId(room) || typeof owner !== "string" || !FINGERPRINT.test(owner)
        || typeof member !== "string" || !FINGERPRINT.test(member) || !validEpoch(epoch)) continue;
      const canonicalLink = ownField(item, "link"), rawLink = canonicalLink.present ? canonicalLink.value : ownData(item, "state");
      const canonicalMemberCount = ownField(item, "memberCount"), rawMemberCount = canonicalMemberCount.present ? canonicalMemberCount.value : ownData(item, "members");
      const peers = remotePeers(ownData(item, "remotePeers"), remainingRemotePeers);
      if (peers !== null) remainingRemotePeers -= peers.length;
      views.push({
        name, room, owner, member, epoch,
        link: typeof rawLink === "string" && LINK_STATES.has(rawLink) ? rawLink as RoomStatusView["link"] : null,
        memberCount: memberCount(rawMemberCount),
        remotePeers: peers,
        relays: relayStats(ownData(item, "relays")),
        ...projectRoomDiagnostics(item),
      });
    }
    return views;
  } catch { return []; }
}
