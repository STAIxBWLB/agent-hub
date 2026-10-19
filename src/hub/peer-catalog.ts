import { definitionOf, SUPPORTED_PEERS } from "../adapters/registry.ts";
export { SUPPORTED_PEERS } from "../adapters/registry.ts";

// ponytail: older staged coordinators read these literal declarations to probe target support.
// A2 replaces that source probe with a published capability before deleting the compatibility exports.
/** Native peers the hub knows; membership checks share the registry. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
/** Optional production peers are added explicitly; legacy defaults remain stable. */
export const OPTIONAL_PEERS = ["qwen", "jcode", "agy"] as const;
export type KnownPeer = typeof SUPPORTED_PEERS[number];

export const isKnownPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && !!definitionOf(value) && !definitionOf(value)!.optional;

export { isSupportedPeer } from "../adapters/registry.ts";

// Policy and historical projection order belong to the registry; public compatibility exports remain intact.
export { defaultPeerRoles, PLANNER_PEERS } from "../adapters/registry.ts";
