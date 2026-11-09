import type { StageEvidence } from "./stage-evidence.ts";
import type { StageTurn } from "./stage-input.ts";
export type StageTier = "efficient" | "capable";
export interface FallbackStagePolicy { confidenceThreshold?: number; holdTurns?: number }
export interface FallbackStageState { recoveryHoldRemaining: number }
export interface FallbackStageResult { tier: StageTier; source: "default" | "dimensions" | "override" | "hold"; score: number; state: FallbackStageState }
export function selectFallbackStage(evidence: StageEvidence, policy: FallbackStagePolicy = {}, prior?: FallbackStageState): FallbackStageResult {
  const threshold = policy.confidenceThreshold ?? 0.5, hold = policy.holdTurns ?? 2;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || !Number.isSafeInteger(hold) || hold < 0 || hold > 200_000) throw new Error("invalid stage fallback policy");
  const score = evidence.scores.capable;
  const recovery = evidence.turn === "compaction" || evidence.signals.fault === "critical" || evidence.signals.repeatedFailures >= 2;
  const remaining = evidence.signals.tests === "pass" && evidence.signals.failures === 0 ? 0 : prior?.recoveryHoldRemaining ?? 0;
  if (recovery) return { tier: "capable", source: "override", score, state: { recoveryHoldRemaining: hold } };
  if (remaining > 0) return { tier: "capable", source: "hold", score, state: { recoveryHoldRemaining: remaining - 1 } };
  return { tier: score > threshold ? "capable" : "efficient", source: score > threshold ? "dimensions" : "default", score, state: { recoveryHoldRemaining: 0 } };
}
export type StaySwitchMode = "off" | "shadow" | "enforce";
export interface StaySwitchPolicy { stay_switch: StaySwitchMode; max_switch_prefill_tokens: number }
export const DEFAULT_STAY_SWITCH: StaySwitchPolicy = { stay_switch: "shadow", max_switch_prefill_tokens: 32_000 };
export type StageSwitchReason = "new_pin" | "compaction" | "context_fit" | "same_tier" | "override" | "tool_loop" | "prefill_bound" | "user_turn";
export interface StageSwitchTrace { turnType?: Exclude<StageTurn, "other">; prefillTokens?: number; staySwitch?: "shadow" | "enforce"; plan?: "stay" | "switch"; reason?: StageSwitchReason }
export interface StageSwitchResult { tier: StageTier; pin: StageTier | undefined; trace: StageSwitchTrace }
/** A switch proposal cannot bypass host fit or authorize a model call. */
export function planStageSwitch(policy: StaySwitchPolicy | undefined, pin: StageTier | undefined, fallback: FallbackStageResult, turn: StageTurn,
  host: { inputTokens?: number; fits: (tier: StageTier) => boolean }): StageSwitchResult {
  const actual = policy ?? DEFAULT_STAY_SWITCH;
  const trace: StageSwitchTrace = { ...(turn === "other" ? {} : { turnType: turn }), ...(host.inputTokens === undefined ? {} : { prefillTokens: host.inputTokens }) };
  if (turn === "other") return { tier: fallback.tier, pin, trace };
  if (actual.stay_switch === "off") return { tier: fallback.tier, pin: undefined, trace };
  let proposal = fallback.tier, reason: StageSwitchReason;
  if (!pin) reason = "new_pin";
  else if (!host.fits(pin)) reason = "context_fit";
  else if (turn === "compaction") reason = "compaction";
  else if (pin === fallback.tier) reason = "same_tier";
  else if (fallback.source === "override") reason = "override";
  else if (turn === "tool_result") { proposal = pin; reason = "tool_loop"; }
  else if (fallback.tier === "efficient" && host.inputTokens !== undefined && host.inputTokens > actual.max_switch_prefill_tokens) { proposal = pin; reason = "prefill_bound"; }
  else reason = "user_turn";
  if (!host.fits(proposal)) {
    const other = proposal === "capable" ? "efficient" : "capable";
    if (!host.fits(other)) throw new Error("no stage backend fits the model input");
    proposal = other; reason = "context_fit";
  }
  trace.staySwitch = actual.stay_switch; trace.plan = !pin || pin === proposal ? "stay" : "switch"; trace.reason = reason;
  const tier = actual.stay_switch === "enforce" ? proposal : fallback.tier;
  return { tier, pin: tier, trace };
}
