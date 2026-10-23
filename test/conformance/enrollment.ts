import { assertDefinitionCoherence, type AdapterDefinition } from "../../src/adapters/registry.ts";
import { assertEnrollment as publicEnrollment, assertAcpLegEnrollment as publicAcpEnrollment } from "../../src/adapters/conformance/enrollment.ts";
export { ACP_LEGS, definitionIdentities, type AcpLeg } from "../../src/adapters/conformance/enrollment.ts";
/** Unsupported generic legs are explicit receipts, never skipped readiness claims. */
export const UNSUPPORTED: Record<string, string> = {
  agy: "Pull-only native surface has no driven headless factory, managed permission acknowledgements, quota or resume; real channel/native-hook coverage: test/agy-peer.test.ts",
  "claude:implementer": "Per-task sessions and current-child prompt approvals use owned print children, not generic text-prompt legs; dedicated coverage: test/claude-implementer.test.ts and test/headless-claude-permission-client.test.ts",
  "claude:reviewer": "Fresh review children require an isolation receipt and task-bound verdict envelope, not a generic text prompt; dedicated coverage: test/reviewer-print.test.ts",
  "codex:reviewer": "Fresh review children require verified native isolation and task-bound verdict authority; dedicated coverage: test/reviewer-print.test.ts and test/codex-review-isolation.test.ts",
  "kimi:reviewer": "Fresh review children require native preparation and task-MCP authority; dedicated coverage: test/kimi-review.test.ts, test/kimi-review-daemon.test.ts and test/kimi-review-stop.test.ts",
  "agy:reviewer": "agy is an implementer peer (#485); metadata-only reviewer remains unavailable, with no factory or backend; dedicated coverage: test/agy-peer.test.ts",
};
export const UNSUPPORTED_LEGS: Readonly<Record<string, string>> = {
  "jcode:native-mode-ack": "Jcode has no verified native permission-mode mapping; the real owned factory must refuse setPermissionMode (test/conformance/builtins.test.ts).",
  "jcode:native-approval-rpc": "The pinned Jcode native contract exposes no verified permission-request mapping; do not substitute the Kimi fake mode contract.",
  "jcode:watchdog-generation": "The generic ACP watchdog barrier requires a native mode acknowledgement that Jcode does not offer; actual owned-ACP late-result and successor coverage runs in test/conformance/jcode.test.ts.",
  "jcode:native-quota": "No pinned Jcode native quota refusal classifier exists; ordinary failures remain uncertain.",
  "qwen:native-quota": "No pinned Qwen native quota refusal classifier exists; ordinary failures remain uncertain.",
};

export function assertAcpLegEnrollment(definitions: readonly AdapterDefinition[], reasons: Readonly<Record<string, string>> = UNSUPPORTED_LEGS): void {
  publicAcpEnrollment(definitions, reasons);
}
export function assertEnrollment(definitions: readonly AdapterDefinition[], enrolled: readonly string[], unsupported: Readonly<Record<string, string>>, reasons: Readonly<Record<string, string>> = UNSUPPORTED_LEGS): void {
  publicEnrollment(definitions, enrolled, unsupported, reasons, assertDefinitionCoherence);
}
