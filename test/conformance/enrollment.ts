import { assertDefinitionCoherence, type AdapterDefinition } from "../../src/adapters/registry.ts";

/** Unsupported generic legs are explicit receipts, never skipped readiness claims. */
export const UNSUPPORTED: Record<string, string> = {
  agy: "Pull-only native surface has no driven headless factory, managed permission acknowledgements, quota or resume; real channel/native-hook coverage: test/agy-peer.test.ts",
  "claude:reviewer": "Fresh review children require an isolation receipt and task-bound verdict envelope, not a generic text prompt; dedicated coverage: test/reviewer-print.test.ts",
  "codex:reviewer": "Fresh review children require verified native isolation and task-bound verdict authority; dedicated coverage: test/reviewer-print.test.ts and test/codex-review-isolation.test.ts",
  "kimi:reviewer": "Fresh review children require native preparation and task-MCP authority; dedicated coverage: test/kimi-review.test.ts, test/kimi-review-daemon.test.ts and test/kimi-review-stop.test.ts",
  "agy:reviewer": "agy is an implementer peer (#485); metadata-only reviewer remains unavailable, with no factory or backend; dedicated coverage: test/agy-peer.test.ts",
};
/** Stable generic ACP legs; both actual test registration and enrollment validation consume this catalog. */
export const ACP_LEGS = Object.freeze(["native-approval-rpc", "native-mode-ack", "native-quota", "watchdog-generation"] as const);
export type AcpLeg = typeof ACP_LEGS[number];
export const UNSUPPORTED_LEGS: Readonly<Record<string, string>> = {
  "jcode:native-mode-ack": "Jcode has no verified native permission-mode mapping; the real owned factory must refuse setPermissionMode (test/conformance/builtins.test.ts).",
  "jcode:native-approval-rpc": "The pinned Jcode native contract exposes no verified permission-request mapping; do not substitute the Kimi fake mode contract.",
  "jcode:watchdog-generation": "The generic ACP watchdog barrier requires a native mode acknowledgement that Jcode does not offer; actual owned-ACP late-result and successor coverage runs in test/conformance/jcode.test.ts.",
  "jcode:native-quota": "No pinned Jcode native quota refusal classifier exists; ordinary failures remain uncertain.",
  "qwen:native-quota": "No pinned Qwen native quota refusal classifier exists; ordinary failures remain uncertain.",
};
/** No unsupported key or non-generic ACP engine can silently escape an executable catalog leg. */
export function assertAcpLegEnrollment(definitions: readonly AdapterDefinition[], unsupportedLegs: Readonly<Record<string, string>> = UNSUPPORTED_LEGS): void {
  const acp = new Map(definitions.filter(definition => definition.transport === "acp").map(definition => [definition.kind, definition]));
  for (const [key, reason] of Object.entries(unsupportedLegs)) {
    const separator = key.lastIndexOf(":"), kind = key.slice(0, separator), leg = key.slice(separator + 1);
    if (separator < 1 || !acp.has(kind) || !(ACP_LEGS as readonly string[]).includes(leg)) throw new Error(`${key}: stale or unknown unsupported ACP leg`);
    if (typeof reason !== "string" || !reason.trim()) throw new Error(`${key}: unsupported ACP leg requires a concrete reason`);
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
    ...(definition.reviewerVariant ? [{ id: `${definition.kind}:reviewer`, definition: definition.reviewerVariant }] : [])]);
}
export function assertEnrollment(definitions: readonly AdapterDefinition[], enrolled: readonly string[], unsupported: Readonly<Record<string, string>>, unsupportedLegs: Readonly<Record<string, string>> = UNSUPPORTED_LEGS): void {
  assertAcpLegEnrollment(definitions, unsupportedLegs);
  const rows = definitionIdentities(definitions), identities = new Set(rows.map(row => row.id));
  if (identities.size !== rows.length) throw new Error("duplicate conformance definition identity");
  if (new Set(enrolled).size !== enrolled.length) throw new Error("duplicate conformance enrollment");
  for (const id of enrolled) if (!identities.has(id)) throw new Error(`${id}: enrolled fixture has no registry definition`);
  for (const [id, reason] of Object.entries(unsupported)) {
    if (!identities.has(id)) throw new Error(`${id}: unsupported reason has no registry definition`);
    if (!reason.trim()) throw new Error(`${id}: unsupported needs a concrete reason`);
    if (enrolled.includes(id)) throw new Error(`${id}: cannot be both enrolled and unsupported`);
  }
  for (const { id, definition } of rows) {
    try { assertDefinitionCoherence(definition); }
    catch (error) { throw new Error(`${id}: ${(error as Error).message}`); }
    if (!enrolled.includes(id) && !Object.hasOwn(unsupported, id)) throw new Error(`${id}: no conformance fixture or unsupported reason`);
    if (definition.transport === "acp" && !enrolled.includes(id)) throw new Error(`${id}: every ACP definition must run the ACP legs`);
    if (id.endsWith(":reviewer") && !definition.reviewer) throw new Error(`${id}: reviewer variant lacks reviewer policy`);
  }
}
