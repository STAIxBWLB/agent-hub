import { definitionOf } from "../adapters/registry.ts";

// ponytail: older staged coordinators read these literal declarations to probe target support.
// A2 replaces that source probe with a published capability before deleting the compatibility exports.
/** Native peers the hub knows; membership checks share the registry. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
/** Optional production peers are added explicitly; legacy defaults remain stable. */
export const OPTIONAL_PEERS = ["qwen", "jcode"] as const;
export const SUPPORTED_PEERS = [...KNOWN_PEERS, ...OPTIONAL_PEERS] as const;
export type KnownPeer = typeof SUPPORTED_PEERS[number];

export const isKnownPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && !!definitionOf(value) && !definitionOf(value)!.optional;

export const isSupportedPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && !!definitionOf(value);

// Policy metadata, not a membership list. Preserve DEFAULT_ROLES' existing key order.
const ROLE_ORDER: readonly KnownPeer[] = ["claude", "codex", "kimi", "local", "pi", "qwen", "jcode"];

/** Each caller owns its role arrays; changing a project's defaults cannot change another's. */
export function defaultPeerRoles(includeOptional = false): Record<string, string[]> {
  return Object.fromEntries(ROLE_ORDER.filter(peer => includeOptional || !definitionOf(peer)!.optional)
    .map(peer => [peer, [...definitionOf(peer)!.roles]]));
}

/** #455: who may hold the planner role, in the order automatic assignment tries them; the hub-sandboxed pi and local never plan. */
export const PLANNER_PEERS = ["claude", "codex", "kimi", "qwen", "jcode"] as const;
