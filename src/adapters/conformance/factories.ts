import type { AdapterDefinition, CreateContext, DaemonPorts } from "../registry-types.ts";
import type { PeerAdapter } from "../../hub/peers.ts";
import { join } from "node:path";

/** The supplied definition creates its actual adapter, with only this fixture's transport options. */
export function createFromDefinition<T extends PeerAdapter>(definition: AdapterDefinition, daemon: DaemonPorts): T {
  if (!definition.start.create) throw new Error(`${definition.kind}: no driven native factory; use its external-hello fixture`);
  const options = Object.values(daemon)[0] as { cwd: string; stateDir?: string; mcpServers?: CreateContext["mcpServers"] };
  return definition.start.create({ instance: definition.kind, projectRoot: options.cwd, stateDir: options.stateDir ?? join(options.cwd, "state"),
    kindConfig: {}, permission: "ask", mcpServers: options.mcpServers ?? [], daemon }) as T;
}
/** Explicit watchdog seam on the factory-created implementation, replacing direct test subclasses. */
export function expire(peer: PeerAdapter): void {
  const watched = peer as PeerAdapter & { onWatchdog(): void };
  if (typeof watched.onWatchdog !== "function") throw new Error(`${peer.id}: no watchdog seam`);
  watched.onWatchdog();
}
