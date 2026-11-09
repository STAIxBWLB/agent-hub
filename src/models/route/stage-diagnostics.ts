import type { StageResultInput } from "./stage-input.ts";
export type FaultClass = "none" | "reported" | "exception" | "critical";
export interface StageDiagnostic { fault: FaultClass; test: "none" | "pass" | "fail" | "unknown"; fingerprint?: string }
/** Diagnostics are local evidence, never instructions or public fragments. */
export function diagnoseStageResult(result: StageResultInput): StageDiagnostic {
  const value = result.text.toLowerCase();
  const failedTest = /\b(?:[1-9]\d*\s+(?:fail|failed)|tests?\s+failed|assertion(?:error| failed))\b/.test(value);
  const passedTest = !failedTest && /\b(?:\d+\s+(?:pass|passed)|all tests? pass(?:ed)?|tests? passed)\b/.test(value);
  // A zero-failure summary is successful evidence, not a generic occurrence of "failed".
  const diagnosticText = value.replace(/\b0\s+(?:fail|failed|failures)\b/g, "");
  const explicit = result.error || failedTest || (/\b(?:error|failed|failure|exception|fatal|panic|memoryerror)\b/.test(diagnosticText) || /\b\w*(?:exception|error):/.test(diagnosticText)) && result.family !== "read";
  if (!explicit) return { fault: "none", test: passedTest ? "pass" : "none" };
  const fault: FaultClass = /\b(?:fatal|panic|segmentation fault|out of memory|memoryerror)\b/.test(value) ? "critical"
    : !/\bassertionerror:/.test(value) && /\b\w*(?:exception|error):/.test(value) ? "exception" : "reported";
  // Bounded source capture makes this local comparison bounded too; no fingerprint enters StageEvidence.
  const fingerprint = value.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").trim();
  return { fault, test: failedTest ? "fail" : "none", fingerprint: `${failedTest ? "test" : "other"}:${fingerprint}` };
}
