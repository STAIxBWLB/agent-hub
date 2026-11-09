import type { ExecutionReferenceV1 } from "../hub/execution-reference.ts";
import type { LineageResult } from "../hub/execution-lineage.ts";

/**
 * The one lineage view, shared by `ahub lineage show` and the acon provider (#1220 T3), so both
 * surfaces show the same admitted page. Pure: no IO, clocks, probes or imports of a CLI module.
 * Every string rendered here comes from a result that passed `parseLineageResult` and
 * `parseExecutionReference`, which reject `\p{Cc}`; a terminal surface still strips at its own
 * boundary (`renderExecutionLineage` in src/cli/lineage.ts).
 */
export const executionLineageAddress = (ref: ExecutionReferenceV1): string =>
  `${ref.tool}:${ref.kind} ${ref.id} (project ${ref.projectKey}${ref.revision === undefined ? "" : `, revision ${ref.revision}`}${ref.sha256 === undefined ? "" : `, sha256 ${ref.sha256}`})`;

type Unavailable = Extract<LineageResult, { state: "unavailable" }>;
const REPAIR: Record<NonNullable<Unavailable["reason"]>, string> = {
  corrupt: "trusted source state could not be read; inspect ahub recovery status and the trusted source state before retrying ahub lineage show",
  cursor_invalid: "the cursor is stale or does not match this source snapshot; refresh the same root and bounds without --cursor",
  invalid: "the execution reference or page bounds are invalid; run ahub help lineage, correct the reference or bounds and retry",
  withheld: "source metadata is withheld by policy; ask an authorized person to check the policy and select a public task scope before retrying ahub lineage show",
  missing: "the root is not recorded in this admitted source; check the task or attempt identity and task scope, then retry ahub lineage show",
  unsupported: "this source cannot project the requested root or scope within its supported bounds; select a supported root or smaller task scope, or upgrade the source before retrying ahub lineage show",
};

export function executionLineageLines(result: LineageResult): string[] {
  if (result.state === "unavailable") {
    // An unavailable source is never an empty successful graph: the reason is shown only when the
    // source admitted diagnostics, and its absence keeps the unqualified refusal.
    if (result.reason === undefined) return ["Lineage unavailable; check the root reference and your source-read access, then retry ahub lineage show."];
    return [`Lineage unavailable (${result.reason}): ${REPAIR[result.reason]}.`];
  }
  return ["Execution lineage (metadata only)", ...result.nodes.map(node => `${executionLineageAddress(node.ref)}: ${node.state}, ${node.strength}`),
    ...result.edges.map(edge => `${executionLineageAddress(edge.from)} -> ${executionLineageAddress(edge.to)}: ${edge.relation}, ${edge.strength}`),
    ...(result.truncated ? [`Page truncated; retry the same root and bounds with --cursor ${result.cursor}.`] : ["Page complete."])];
}
