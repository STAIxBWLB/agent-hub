import { types } from "node:util";
import type { PeerState } from "../hub/envelope.ts";
import { decodeBase64url, encodeBase64url } from "./crypto.ts";
import { parseRemotePeerId } from "./application.ts";

const ROOM_LIMIT = 64;
const REMOTE_PEER_LIMIT = 4096;
const MEMBER_LIMIT = 64;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const EPOCH = /^[1-9][0-9]{0,19}$/;
const LINK_STATES = new Set(["online", "connecting", "offline", "left"]);
const PEER_STATES = new Set<PeerState>(["idle", "busy", "paused", "offline"]);

export interface RoomStatusPeer {
  id: string;
  state: PeerState;
}

/** Allowlisted room metadata. Missing member counts and peer lists stay unknown. */
export interface RoomStatusView {
  name: string;
  room: string;
  owner: string;
  member: string;
  epoch: string;
  link: "online" | "connecting" | "offline" | "left" | null;
  memberCount: number | null;
  remotePeers: RoomStatusPeer[] | null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

function plainArray(value: unknown): value is unknown[] {
  return !!value && typeof value === "object" && !types.isProxy(value) && Array.isArray(value);
}

/** Read own data properties only; accessors and hostile proxies are never evaluated. */
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
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
function remotePeers(value: unknown): RoomStatusPeer[] | null {
  if (!plainArray(value) || value.length > REMOTE_PEER_LIMIT) return null;
  const result: RoomStatusPeer[] = [], ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = arrayItem(value, index);
    if (!plainRecord(item)) return null;
    const id = ownData(item, "id"), state = ownData(item, "state");
    if (typeof id !== "string" || !parseRemotePeerId(id) || typeof state !== "string" || !PEER_STATES.has(state as PeerState) || ids.has(id)) return null;
    ids.add(id);
    result.push({ id, state: state as PeerState });
  }
  return result;
}

/** Project RoomCommands.rows-compatible data to body-free room status metadata. */
export function projectRoomStatus(value: unknown): RoomStatusView[] {
  try {
    if (!plainArray(value) || value.length > ROOM_LIMIT) return [];
    const views: RoomStatusView[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = arrayItem(value, index);
      if (!plainRecord(item)) continue;
      const name = ownData(item, "name"), room = ownData(item, "room"), owner = ownData(item, "owner");
      const member = ownData(item, "member"), epoch = ownData(item, "epoch");
      if (typeof name !== "string" || !NAME.test(name) || !roomId(room) || typeof owner !== "string" || !FINGERPRINT.test(owner)
        || typeof member !== "string" || !FINGERPRINT.test(member) || !validEpoch(epoch)) continue;
      const rawLink = ownData(item, "state");
      views.push({
        name, room, owner, member, epoch,
        link: typeof rawLink === "string" && LINK_STATES.has(rawLink) ? rawLink as RoomStatusView["link"] : null,
        memberCount: memberCount(ownData(item, "members")),
        remotePeers: remotePeers(ownData(item, "remotePeers")),
      });
    }
    return views;
  } catch { return []; }
}
