/** Native peers the hub knows; membership checks share this list. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
export type KnownPeer = typeof KNOWN_PEERS[number];

export const isKnownPeer = (value: unknown): value is KnownPeer =>
  typeof value === "string" && (KNOWN_PEERS as readonly string[]).includes(value);

// Policy metadata, not a membership list. Preserve DEFAULT_ROLES' existing key order.
const PEER_ROLES: Record<KnownPeer, readonly string[]> = {
  claude: ["planner", "reviewer"],
  codex: ["implementer"],
  kimi: ["implementer", "verifier"],
  local: ["implementer", "verifier"],
  pi: ["implementer", "verifier"],
};

/** Each caller owns its role arrays; changing a project's defaults cannot change another's. */
export function defaultPeerRoles(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(PEER_ROLES).map(([peer, roles]) => [peer, [...roles]]));
}
