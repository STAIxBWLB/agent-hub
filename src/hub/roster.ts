import { definitionOf } from "../adapters/registry.ts";
import { defaultRosterEnabled } from "../adapters/registry.ts";

export type PeerRoster = Partial<Record<string, boolean>>;

export function peerRosterConfig(value: unknown): PeerRoster {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("roster must be an object of boolean peer values");
  const roster: PeerRoster = {};
  for (const [peer, on] of Object.entries(value)) {
    if (!definitionOf(peer)) throw new Error("roster contains an unsupported peer");
    if (typeof on !== "boolean") throw new Error(`roster.${peer} must be a boolean`);
    roster[peer] = on;
  }
  return roster;
}

/** External ids keep their existing admission rules; Pi's legacy switch is only its default. */
export function rosterAllows(roster: PeerRoster, peer: string, piEnabled: boolean): boolean {
  if (!definitionOf(peer)) return true;
  return roster[peer] ?? defaultRosterEnabled(peer, piEnabled);
}

/** A peer's membership from a `status` reply: undefined when the hub sends no roster (older than #484), never read as off. */
export function rosterInStatus(status: unknown, peer: string): boolean | undefined {
  const rows = (status as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((r: unknown) => !!r && typeof r === "object" && (r as { peer?: unknown }).peer === peer) as { on?: unknown } | undefined;
  return typeof row?.on === "boolean" ? row.on : undefined;
}
