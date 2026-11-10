import { diagnoseStageResult, type FaultClass } from "./stage-diagnostics.ts";
import type { StageInput, StageTurn } from "./stage-input.ts";
export interface CodingAgentDimensions { severity: number; spinning: number; exploring: number; productionIntensity: number }
export interface StageEvidence {
  schemaVersion: 1; kind: "stage-route-evidence"; turn: StageTurn; incomplete: boolean;
  signals: { results: number; failures: number; repeatedFailures: number; reads: number; mutations: number; assistantTurns: number; tests: "none" | "pass" | "fail" | "unknown"; fault: FaultClass };
  dimensions: CodingAgentDimensions;
  scores: { efficient: number; capable: number };
}
// Published by the owned #637 no-progress corpus rule. These are fallback calibration, not transport bounds.
const EXECUTION_STREAK = 8, EXECUTION_AMBIGUITY = 0.46;
const SEVERITY = { none: 0, reported: 0.3, exception: 0.7, critical: 1 } as const;
/** Numeric/categorical projection only. Generic routing-decision-evidence v1 is a different contract. */
export function buildStageEvidence(input: StageInput): StageEvidence {
  const failures: { fault: FaultClass; test: boolean; fingerprint: string }[] = [];
  let reads = 0, mutations = 0, tests: StageEvidence["signals"]["tests"] = "none";
  let latestFault: FaultClass = "none", successfulExecutions = 0;
  const executionFrames = new Set<number>();
  for (const result of input.results) {
    if (result.family === "read") reads++;
    if (result.family === "mutation") mutations++;
    const diagnostic = diagnoseStageResult(result);
    tests = diagnostic.test;
    latestFault = diagnostic.fault;
    if (result.family === "execution" && result.associated && result.assistantTurn !== undefined && diagnostic.fault === "none" && diagnostic.test !== "pass") {
      successfulExecutions++;
      executionFrames.add(result.assistantTurn);
    } else {
      successfulExecutions = 0;
      executionFrames.clear();
    }
    if (diagnostic.test === "pass") {
      for (let index = failures.length - 1; index >= 0; index--) if (failures[index]!.test) failures.splice(index, 1);
    }
    if (diagnostic.fault !== "none") failures.push({ fault: diagnostic.fault, test: diagnostic.test === "fail", fingerprint: diagnostic.fingerprint! });
  }
  const fault = failures.reduce<FaultClass>((prior, failure) => SEVERITY[failure.fault] > SEVERITY[prior] ? failure.fault : prior, "none");
  const groups = new Map<string, number>();
  for (const failure of failures) groups.set(failure.fingerprint, (groups.get(failure.fingerprint) ?? 0) + 1);
  const repeatedFailures = Math.max(0, ...groups.values());
  const currentCompletion = input.turn === "tool_result";
  const currentFailure = currentCompletion && latestFault !== "none";
  const noProgress = currentCompletion && successfulExecutions >= EXECUTION_STREAK && executionFrames.size >= EXECUTION_STREAK && input.assistantTurns >= EXECUTION_STREAK;
  const dimensions = { severity: currentCompletion ? SEVERITY[latestFault] : 0,
    spinning: currentFailure && repeatedFailures >= 2 ? Math.min(1, repeatedFailures / Math.max(1, failures.length)) : noProgress ? EXECUTION_AMBIGUITY : 0,
    exploring: reads / Math.max(1, input.results.length), productionIntensity: mutations / Math.max(1, input.results.length) };
  const risk = Math.max(dimensions.severity, dimensions.spinning);
  return { schemaVersion: 1, kind: "stage-route-evidence", turn: input.turn, incomplete: input.incomplete,
    signals: { results: input.results.length, failures: failures.length, repeatedFailures, reads, mutations, assistantTurns: input.assistantTurns, tests, fault },
    dimensions, scores: { efficient: 1 - risk, capable: risk } };
}
/** A sensitive future service projection must not expose history shape. No transport is introduced here. */
export function sensitiveStageEvidence(evidence: StageEvidence): Pick<StageEvidence, "schemaVersion" | "kind" | "dimensions"> {
  return { schemaVersion: evidence.schemaVersion, kind: evidence.kind, dimensions: { ...evidence.dimensions } };
}
