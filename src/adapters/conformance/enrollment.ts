import type { AdapterDefinition } from "../registry-types.ts";
import { isFixedBuiltinDefinition } from "../registry.ts";

/** Stable generic ACP legs; both actual test registration and enrollment validation consume this catalog. */
export const ACP_LEGS = Object.freeze(["native-approval-rpc", "native-mode-ack", "native-quota", "watchdog-generation"] as const);
export type AcpLeg = typeof ACP_LEGS[number];
/** Reserved until 2b supplies the restrictive ACP product members; not an executable ACP leg yet. */
export const ACP_PORTS_LEG = "restrictive-ports";
export const NATIVE_PROOF_PORTS_LEG = "native-proof-ports";
/** No unsupported key or non-generic ACP engine can silently escape an executable catalog leg. */
export function assertAcpLegEnrollment(definitions: readonly AdapterDefinition[], unsupportedLegs: Readonly<Record<string, string>> = {}): void {
  const acp = new Map(definitions.filter(definition => definition.transport === "acp").map(definition => [definition.kind, definition]));
  for (const [key, reason] of Object.entries(unsupportedLegs)) {
    const separator = key.lastIndexOf(":"), kind = key.slice(0, separator), leg = key.slice(separator + 1);
    if (typeof reason !== "string" || !reason.trim()) throw new Error(`${key}: unsupported ACP leg requires a concrete reason`);
    if (leg === NATIVE_PROOF_PORTS_LEG) {
      const row = definitionIdentities(definitions).find(row => row.id === kind);
      if (!row || !isFixedBuiltinDefinition(row.definition)) throw new Error(`${key}: only fixed builtin proof legs may be nonapplicable`);
      continue;
    }
    if (separator < 1 || !acp.has(kind) || !(ACP_LEGS as readonly string[]).includes(leg) && leg !== ACP_PORTS_LEG) throw new Error(`${key}: stale or unknown unsupported ACP leg`);
    if (leg === ACP_PORTS_LEG && reason !== "ports added in 2b") throw new Error(`${key}: reserved ACP ports leg requires reason ports added in 2b`);
  }
  for (const definition of acp.values()) if (definition.start.daemonPort !== "acp") {
    for (const leg of ACP_LEGS) {
      const key = `${definition.kind}:${leg}`;
      if (!Object.hasOwn(unsupportedLegs, key)) throw new Error(`${key}: non-generic ACP engine requires an explicit skipped-leg reason`);
    }
  }
}
export function definitionIdentities(definitions: readonly AdapterDefinition[]): { id: string; definition: AdapterDefinition }[] {
  return definitions.flatMap(definition => [{ id: definition.kind, definition },
    ...(definition.reviewerVariant ? [{ id: `${definition.kind}:reviewer`, definition: definition.reviewerVariant }] : []),
    ...(definition.headlessVariant ? [{ id: `${definition.kind}:implementer`, definition: definition.headlessVariant }] : [])]);
}
export function assertEnrollment(definitions: readonly AdapterDefinition[], enrolled: readonly string[], unsupported: Readonly<Record<string, string>>, unsupportedLegs: Readonly<Record<string, string>> = {}, coherence?: (definition: AdapterDefinition) => void): void {
  const rows = definitionIdentities(definitions), identities = new Set(rows.map(row => row.id));
  for (const { id, definition } of rows) {
    try { coherence?.(definition); }
    catch (error) { throw new Error(`${id}: ${(error as Error).message}`); }
  }
  assertAcpLegEnrollment(definitions, unsupportedLegs);
  if (identities.size !== rows.length) throw new Error("duplicate conformance definition identity");
  if (new Set(enrolled).size !== enrolled.length) throw new Error("duplicate conformance enrollment");
  for (const id of enrolled) if (!identities.has(id)) throw new Error(`${id}: enrolled fixture has no registry definition`);
  for (const [id, reason] of Object.entries(unsupported)) {
    if (!identities.has(id)) throw new Error(`${id}: unsupported reason has no registry definition`);
    if (!reason.trim()) throw new Error(`${id}: unsupported needs a concrete reason`);
    if (enrolled.includes(id)) throw new Error(`${id}: cannot be both enrolled and unsupported`);
  }
  for (const { id, definition } of rows) {
    if (isFixedBuiltinDefinition(definition) && !Object.hasOwn(unsupportedLegs, `${id}:${NATIVE_PROOF_PORTS_LEG}`)) throw new Error(`${id}: native proof ports need an explicit nonapplicable reason`);
    if (definition.transport === "acp" && !Object.hasOwn(unsupportedLegs, `${id}:${ACP_PORTS_LEG}`)) throw new Error(`${id}: ACP restrictive ports require the reserved 2b reason`);
    if (!enrolled.includes(id) && !Object.hasOwn(unsupported, id)) throw new Error(`${id}: no conformance fixture or unsupported reason`);
    if (definition.transport === "acp" && !enrolled.includes(id)) throw new Error(`${id}: every ACP definition must run the ACP legs`);
    if (id.endsWith(":reviewer") && !definition.reviewer) throw new Error(`${id}: reviewer variant lacks reviewer policy`);
  }
}
