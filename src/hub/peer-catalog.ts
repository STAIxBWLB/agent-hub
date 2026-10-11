/** Native peers the hub knows; membership checks share this list. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
/** Optional production peers are added explicitly; legacy defaults remain stable. */
export const OPTIONAL_PEERS = ["qwen", "jcode"] as const;
export const SUPPORTED_PEERS = [...KNOWN_PEERS, ...OPTIONAL_PEERS] as const;
export type KnownPeer = typeof SUPPORTED_PEERS[number];

export const isKnownPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && (KNOWN_PEERS as readonly string[]).includes(value);

export const isSupportedPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && (SUPPORTED_PEERS as readonly string[]).includes(value);

// Policy metadata, not a membership list. Preserve DEFAULT_ROLES' existing key order.
const PEER_ROLES: Record<KnownPeer, readonly string[]> = {
  claude: ["planner", "reviewer"],
  codex: ["implementer"],
  kimi: ["implementer", "verifier"],
  local: ["implementer", "verifier"],
  pi: ["implementer", "verifier"],
  qwen: ["implementer", "verifier"],
  jcode: ["implementer", "verifier"],
};

/** Each caller owns its role arrays; changing a project's defaults cannot change another's. */
export function defaultPeerRoles(includeOptional = false): Record<string, string[]> {
  return Object.fromEntries(Object.entries(PEER_ROLES).filter(([peer]) => includeOptional || !(OPTIONAL_PEERS as readonly string[]).includes(peer)).map(([peer, roles]) => [peer, [...roles]]));
}
