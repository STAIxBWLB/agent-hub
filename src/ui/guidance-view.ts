import type { GuidanceDiffResult, GuidancePageResult, GuidanceWriteReceipt } from "../hub/guidance-variants.ts";
import type { ProbeReceiptExport } from "../hub/guidance-probes.ts";
import { sanitize } from "../hub/envelope.ts";

/** Shared public projection only. These lines neither reconstruct private role bytes nor attest to a handoff. */
export function guidanceLines(value: GuidancePageResult | GuidanceDiffResult): string[] {
  const text = (raw: string): string => sanitize(raw).replace(/[\p{Cc}\p{Cf}]/gu, character => character === "\n" ? character : "");
  const field = (label: string, raw: string): string[] => [label + " (untrusted advisory text):", ...text(raw).split("\n").map(line => `> ${line}`)];
  if (value.state !== "available") return ["Guidance unavailable. Refresh the selected task scope or check access and guidance_views support."];
  const current = value.current;
  const lines = ["Guidance declarations (advisory)", `Current task #${current.taskId}; epoch ${current.taskCreated}; flow ${current.flowRevision}.`,
    "Source evidence is declared or unavailable. Actual handoff, testing and model consumption are unknown."];
  const records = "record" in value ? [value.record] : value.records;
  if (!records.length) lines.push("No guidance declarations in this page.");
  for (const record of records) {
    lines.push(`Variant ${record.id}`, `Task #${record.taskId}; epoch ${record.taskCreated}; declaration flow ${record.flowRevision}.`,
      `Status: ${record.status}; currently applicable: ${record.applicable ? "yes" : "no"}.`,
      `Role: ${record.roleId} (${record.layer}); author: ${record.author}.`,
      `Baseline SHA-256: ${record.baselineSha256}`, `Candidate SHA-256: ${record.candidateSha256}`,
      `Bytes: baseline ${record.bytes.baseline}; candidate ${record.bytes.candidate}; record ${record.bytes.record}.`,
      `Changed sections: ${record.changedSections.join(", ") || "none"}.`,
      ...field("Experiment label", record.experimentId),
      ...field("Problem hypothesis", record.rationale.problemHypothesis),
      ...field("Expected observable difference", record.rationale.expectedObservableDifference));
    for (const evidence of record.evidence) lines.push(`Evidence digest ${evidence.key}: ${evidence.status} (declaration only).`);
    if (!record.evidence.length) lines.push("No source evidence declarations.");
  }
  if ("sections" in value) {
    for (const section of value.sections) lines.push(`${section.section} diff`, ...field("Before", section.before), ...field("After", section.after));
    lines.push(`Protected sections unchanged by construction: ${value.protectedSections.join(", ")}.`,
      "Diff text is a screened public presentation, not the exact private bytes for a new record.");
  } else {
    lines.push(value.truncated ? "More declarations are available. Request the next page explicitly." : "Page complete.");
  }
  return lines;
}

/** A receipt confirms only its recorded declaration status, never execution or model use. */
export function guidanceReceiptLines(receipt: GuidanceWriteReceipt): string[] {
  const experiment = sanitize(receipt.experimentId).replace(/[\p{Cc}\p{Cf}]/gu, "");
  return [`Guidance ${receipt.status}${receipt.already ? " (already recorded)" : ""}.`, `Variant ${receipt.id}; task #${receipt.taskId}.`,
    "Experiment label (untrusted advisory text):", `> ${experiment}`,
    "Actual handoff, testing and model consumption are unknown."];
}

/** Wire text is advisory and untrusted: no control or format character survives, and a model-written name is never shown raw. */
const plain = (raw: string): string => sanitize(raw).replace(/[\p{Cc}\p{Cf}]/gu, "");
const known = (value: number | null): string => value === null ? "unknown" : String(value);
/**
 * T4 (#1226): the producer's probe status, one text for the plugin panel and the CLI. It states what the host observed and nothing more: a fixture run says
 * `fixture`, a missing measurement says `unknown` and never zero, and every state that is not a success stays visible, so a failed, cancelled or unavailable
 * arm cannot disappear from the denominator. A live trial is never claimed here: no production runner exists, and evidence is at most `fixture`.
 */
export function guidanceProbeStatusLines(exported: ProbeReceiptExport): string[] {
  const status = exported.status, counts = exported.counts;
  const lines = [`Guidance probe ${status.id}`, `Task #${status.taskId}; revision ${status.revision}; state ${status.state}; evidence ${status.evidence}.`,
    `Experiment label (untrusted advisory text): ${plain(status.experimentId)}`,
    `Comparable: ${exported.comparable ? "yes" : "no"}${exported.reasons.length ? ` (${exported.reasons.join(", ")})` : ""}.`,
    `Outcomes (every reserved slot counts): ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.timed_out} timed out, ${counts.unavailable} unavailable, ${counts.unknown} unknown; not started ${counts.planned}; not needed ${counts.not_needed}.`,
    `Attempts: ${status.counters.workerAttempts} worker, ${status.counters.editorAttempts} editor; model calls ${status.counters.modelCalls}; tool calls ${status.counters.toolCalls}.`,
    `Token usage: ${status.counters.usageUnknown || status.counters.modelCalls === 0 ? "unknown" : status.counters.tokensObservedKnown}.`,
    `Cancel requested: ${status.cancelRequested ? "yes" : "no"}.`,
    "Fixture evidence only: no live model or worker trial, sampling control, provider behaviour or model quality is claimed."];
  for (const slot of exported.slots) {
    const receipt = slot.receipt;
    lines.push(`Slot ${plain(slot.slotId)}: ${slot.stage}/${slot.role}/${slot.arm}; session ${slot.state}; retained output ${slot.retention}.`);
    if (receipt) {
      lines.push(`  Receipt ${receipt.state}; requested ${plain(receipt.requestedModel)}; served ${receipt.servedModel === null ? "unobserved" : plain(receipt.servedModel)}.`,
        `  Elapsed ${receipt.elapsedMs} ms; model calls ${receipt.usage.modelCalls} (${receipt.usage.modelUsageKnown} with known usage); tool calls ${receipt.usage.toolCalls}; tokens ${known(receipt.usage.tokensObserved)}.`,
        `  Output: ${receipt.output.entries.length} file${receipt.output.entries.length === 1 ? "" : "s"}, ${receipt.output.totalBytes} bytes; ${receipt.output.excluded.length} excluded.`,
        `  Limits: ${receipt.limits.join(", ") || "none"}.`, `  Receipt digest ${receipt.digest}`);
    } else if (slot.withheld) lines.push(`  Receipt withheld by the privacy screen; digest ${slot.receiptDigest}.`);
    else lines.push("  No receipt: this slot has no sealed observation, so its outcome is unknown or not started.");
  }
  return lines;
}
