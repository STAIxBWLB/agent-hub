import { definitionOf, type KindMap } from "../adapters/registry.ts";
import { defaultRosterEnabled } from "../adapters/registry.ts";

export type PeerRoster = Partial<Record<string, boolean>>;

export function peerRosterConfig(value: unknown, instances?: KindMap): PeerRoster {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("roster must be an object of boolean peer values");
  const roster: PeerRoster = {};
  for (const [peer, on] of Object.entries(value)) {
    if (!definitionOf(peer, instances)) throw new Error("roster contains an unsupported peer");
    if (typeof on !== "boolean") throw new Error(`roster.${peer} must be a boolean`);
    roster[peer] = on;
  }
  return roster;
}

/** External ids keep their existing admission rules; Pi's legacy switch is only its default. */
export function rosterAllows(roster: PeerRoster, peer: string, piEnabled: boolean, instances?: KindMap): boolean {
  const definition = definitionOf(peer, instances);
  if (!definition) return !instances || Object.keys(instances).length === 0;
  return roster[peer] ?? (definition.kind === peer ? defaultRosterEnabled(peer, piEnabled) : true);
}
