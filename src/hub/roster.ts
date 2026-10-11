import { isKnownPeer, type KnownPeer } from "./peer-catalog.ts";

export type PeerRoster = Partial<Record<KnownPeer, boolean>>;
// Default participation policy, not another catalog. New catalog members default off.
const DEFAULT_ON: Partial<Record<KnownPeer, boolean>> = { claude: true, codex: true, kimi: true, local: true };

export function peerRosterConfig(value: unknown): PeerRoster {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("roster must be an object of boolean peer values");
  const roster: PeerRoster = {};
  for (const [peer, on] of Object.entries(value)) {
    if (!isKnownPeer(peer)) throw new Error("roster contains an unsupported peer");
    if (typeof on !== "boolean") throw new Error(`roster.${peer} must be a boolean`);
    roster[peer] = on;
  }
  return roster;
}

/** External ids keep their existing admission rules; Pi's legacy switch is only its default. */
export function rosterAllows(roster: PeerRoster, peer: string, piEnabled: boolean): boolean {
  if (!isKnownPeer(peer)) return true;
  return roster[peer] ?? (peer === "pi" ? piEnabled : DEFAULT_ON[peer] ?? false);
}
