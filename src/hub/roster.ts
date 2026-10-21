import { definitionOf as builtinDefinitionOf, type ProjectAdapterCatalog, type KindMap } from "../adapters/registry.ts";
import { defaultRosterEnabled as builtinDefaultRosterEnabled, createProjectAdapterCatalog as builtinCatalog } from "../adapters/registry.ts";

export type PeerRoster = Partial<Record<string, boolean>>;

/**
 * A roster key of an instance that was declared, put on the roster and later undeclared (#225). It has the shape a declaration
 * could have had (`<builtin kind>-<name>`, the rule validateInstances applies to an id) and no definition now, so it grants and
 * refuses nothing: the config still loads and `ahub roster remove` can delete it. Anything else stays an unsupported peer.
 */
export function staleInstanceKey(peer: string, catalog: ProjectAdapterCatalog | undefined): boolean {
  const definitionOf = catalog?.definitionOf ?? builtinDefinitionOf;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(peer) || definitionOf(peer)) return false; // a reserved id (user, hub, digest) never starts with a kind and a dash
  return (catalog?.definitions ?? []).some(kind => peer.startsWith(`${kind.kind}-`) && /^[a-z0-9][a-z0-9-]*$/.test(peer.slice(kind.kind.length + 1)) && !catalog?.externalDefinitions.some(item => item.kind === kind.kind));
}

export function peerRosterConfig(value: unknown, instances?: KindMap, catalog?: ProjectAdapterCatalog, inertUnknown = false): PeerRoster {
  const definitionOf = catalog?.definitionOf ?? builtinDefinitionOf;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("roster must be an object of boolean peer values");
  const roster: PeerRoster = {};
  const requireKnownPeer = (peer: string) => {
    if (!definitionOf(peer, instances) && !staleInstanceKey(peer, catalog ?? builtinCatalog())) throw new Error("roster contains an unsupported peer");
  };
  for (const [peer, on] of Object.entries(value)) {
    if (!inertUnknown || !/^[a-z][a-z0-9-]{0,31}$/.test(peer)) requireKnownPeer(peer);
    if (typeof on !== "boolean") throw new Error(`roster.${peer} must be a boolean`);
    roster[peer] = on;
  }
  return roster;
}

/** External ids keep their existing admission rules; Pi's legacy switch is only its default. */
export function rosterAllows(roster: PeerRoster, peer: string, piEnabled: boolean, instances: KindMap | undefined, catalog: ProjectAdapterCatalog, inertUnknown = false): boolean {
  const definitionOf = catalog.definitionOf;
  const defaultRosterEnabled = (id: string, enabled: boolean) => !builtinDefinitionOf(id) ? catalog.definitionOf(id)?.defaultOnRoster ?? false : builtinDefaultRosterEnabled(id, enabled);
  const definition = definitionOf(peer, instances);
  if (!definition) return !inertUnknown || !Object.hasOwn(roster, peer); // Only a captured module scope makes unresolved rows inert; legacy external clients keep their admission rules.
  return roster[peer] ?? (definition.kind === peer ? defaultRosterEnabled(peer, piEnabled) : true);
}
