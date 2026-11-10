/** Compatibility path for existing consumers; implementation is authored in stage-only units. */
export { estimateInputTokens } from "./stage-input.ts";
export type { CodingAgentDimensions } from "./stage-evidence.ts";
export { DEFAULT_STAY_SWITCH } from "./stage-fallback.ts";
export type { StageTier as Tier, FallbackStageState as StageState, StaySwitchMode, StaySwitchPolicy, StageSwitchTrace as SwitchTrace } from "./stage-fallback.ts";
