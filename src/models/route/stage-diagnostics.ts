import type { StageResultInput } from "./stage-input.ts";
export type FaultClass = "none" | "reported" | "exception" | "critical";
export interface StageDiagnostic { fault: FaultClass; test: "none" | "pass" | "fail" | "unknown"; fingerprint?: string }
/** Diagnostics are local evidence, never instructions or public fragments. */
export function diagnoseStageResult(result: StageResultInput): StageDiagnostic {
  const value = result.text.toLowerCase();
  // Remove counted zero-failure summaries before matching uncounted "tests failed" wording.
  const diagnosticText = value.replace(/\b0\s+(?:tests?\s+)?(?:fail|failed|failures)\b/g, "");
  const failedTest = /\b(?:[1-9]\d*\s+(?:tests?\s+)?(?:fail|failed)|tests?\s+failed|assertion(?:error| failed))\b/.test(diagnosticText);
  const positivePass = /\b[1-9]\d*\s+(?:tests?\s+)?(?:pass|passed)\b/.test(value);
  const zeroPass = /\b0\s+(?:tests?\s+)?(?:pass|passed)\b/.test(value);
  const affirmativePass = /^[ \t]*(?:all[ \t]+tests?[ \t]+pass(?:ed)?|tests?[ \t]+passed)[.!]?[ \t\r]*$/m.test(value);
  const passedTest = !failedTest && (positivePass || !zeroPass && affirmativePass);
  const critical = /\b(?:fatal|panic|segmentation fault|out of memory|memoryerror)\b/.test(value);
  const explicit = result.error || failedTest || (critical || /\b(?:error|failed|failure|exception|fatal|panic|memoryerror)\b/.test(diagnosticText) || /\b\w*(?:exception|error):/.test(diagnosticText)) && result.family !== "read";
  if (!explicit) return { fault: "none", test: passedTest ? "pass" : zeroPass ? "unknown" : "none" };
  const fault: FaultClass = critical ? "critical"
    : !/\bassertionerror:/.test(value) && /\b\w*(?:exception|error):/.test(value) ? "exception" : "reported";
  // Bounded source capture makes this local comparison bounded too; no fingerprint enters StageEvidence.
  const fingerprint = value.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").trim();
  return { fault, test: failedTest ? "fail" : "none", fingerprint: `${failedTest ? "test" : "other"}:${fingerprint}` };
}
