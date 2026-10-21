import { ADAPTERS } from "../../src/adapters/registry.ts";
import type { DaemonPorts } from "../../src/adapters/registry-types.ts";
import type { PeerAdapter } from "../../src/hub/peers.ts";
import { createFromDefinition } from "../../src/adapters/conformance/factories.ts";
export { createFromDefinition, expire } from "../../src/adapters/conformance/factories.ts";
/** Fixed-builtin enrollment is a repository test concern, not public transport policy. */
export function createRegisteredPeer<T extends PeerAdapter>(kind: string, daemon: DaemonPorts): T {
  const definition = ADAPTERS.find(candidate => candidate.kind === kind);
  if (!definition) throw new Error(kind + ": conformance peer must have a registry definition");
  return createFromDefinition<T>(definition, daemon);
}
