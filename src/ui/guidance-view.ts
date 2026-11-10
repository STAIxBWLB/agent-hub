import type { GuidanceDiffResult, GuidancePageResult, GuidanceWriteReceipt } from "../hub/guidance-variants.ts";
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
