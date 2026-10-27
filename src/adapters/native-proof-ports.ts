import type { PeerAdapter } from "../hub/peers.ts";
import { isFixedBuiltinDefinition, type AdapterDefinition } from "./registry.ts";

/** Presence is forbidden on a foreign runtime, including a member whose value is undefined. */
export function assertNativeProofPorts(definition: AdapterDefinition | undefined, product: PeerAdapter): void {
  if (isFixedBuiltinDefinition(definition)) return;
  for (const port of ["frontendProxy", "statusNotice", "revertTurn"] as const) {
    if (port in product) throw new Error(`${definition?.kind ?? product.id}: ${port} is restricted to fixed builtin adapter products`);
  }
}
