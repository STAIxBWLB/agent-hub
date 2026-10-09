// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/stage.rs at c8848511, modified.

import type { ToolSignals, TurnKind } from './signals.ts';

export type Tier = 'capable' | 'efficient';
export type PickerMode = 'capable_first' | 'efficient_first';
export type DecisionSource = 'override' | 'capable_hold' | 'dimensions' | 'ambiguous' | 'llm-classifier' | 'fall_open';
export interface CodingAgentDimensions { severity:number; spinning:number; exploring:number; productionIntensity:number }
export interface ScoreResult { score:number; confidence:number }
export type PickOutcome =
  | {kind:'resolved';tier:Tier;source:DecisionSource;probability:number;confidence:number|null}
  | {kind:'consult_classifier';probability:number;confidence:number;defaultTier:Tier};
export interface StageState { capableHoldTurnsRemaining:number }
export interface HandoffNoteConfig {
  escalationNote: string;
  deescalationNote?: string;
  onlyOnWrongSignalEscalation?: boolean;
}
export interface StageOptions { mode?:PickerMode; confidenceThreshold?:number; capableHoldTurns?:number; handoffNotes?:HandoffNoteConfig }
export interface StageDecision { tier:Tier|undefined; defaultTier:Tier; source:DecisionSource; probability:number; confidence:number; score:number; dimensions:CodingAgentDimensions; note?:string; state:StageState }

const STALL_MIN_TURN_DEPTH=8;
const SCORE_GAIN=5;
const HARD_SEVERITY=0.7;
const SIGNAL_UNIT=0.1;
const SEVERITY_CRITICAL=1;

export function dimensionsFromSignal(signal:ToolSignals):CodingAgentDimensions {
  const recentOps=signal.recentWriteCount+signal.recentEditCount+signal.recentReadCount+signal.recentTodowriteCount;
  const deep=signal.turnDepth>=STALL_MIN_TURN_DEPTH;
  const noProduction=signal.recentWriteCount===0&&signal.recentEditCount===0;
  const investigating=signal.recentReadCount>=1||signal.recentTodowriteCount>=1;
  const newActivity=signal.recentNewCount>=1;
  const spinning=deep&&noProduction&&!investigating&&!newActivity;
  const exploring=deep&&noProduction&&investigating&&!newActivity;
  const production=recentOps===0?0:(signal.recentWriteCount+signal.recentEditCount)/recentOps;
  return {severity:signal.severity,spinning:spinning?1:0,exploring:exploring?1:0,productionIntensity:production};
}

export function scoreSignal(signal:ToolSignals):ScoreResult {
  const d=dimensionsFromSignal(signal);
  const raw=SIGNAL_UNIT*(d.severity/HARD_SEVERITY+d.spinning+d.exploring-d.productionIntensity);
  const score=Math.tanh(SCORE_GAIN*raw);
  return {score,confidence:Math.abs(score)};
}

export function pickTier(signal:ToolSignals, mode:PickerMode='efficient_first', confidenceThreshold=0.5):PickOutcome {
  const defaultTier:Tier=mode==='capable_first'?'capable':'efficient';
  if(signal.compacted||signal.severity>=SEVERITY_CRITICAL||signal.repeatedFailure)
    return {kind:'resolved',tier:'capable',source:'override',probability:0.5,confidence:1};
  const scored=scoreSignal(signal); const probability=(scored.score+1)/2; const half=confidenceThreshold/2;
  if(probability>0.5+half||probability<0.5-half)
    return {kind:'resolved',tier:probability>0.5?'capable':'efficient',source:'dimensions',probability,confidence:scored.confidence};
  return {kind:'consult_classifier',probability,confidence:scored.confidence,defaultTier};
}

export function handoffNoteFor(tier:Tier, source:DecisionSource, config:HandoffNoteConfig):string|undefined {
  if(tier==='capable') {
    const signalDriven=source==='override'||source==='dimensions';
    return (config.onlyOnWrongSignalEscalation??true)&&!signalDriven ? undefined : config.escalationNote;
  }
  return config.deescalationNote;
}

/** Apply stage hard rules, dimension scoring, and the capable recovery hold. */
export function selectStage(signal:ToolSignals, options:StageOptions={}, state:StageState={capableHoldTurnsRemaining:0}):StageDecision {
  const mode=options.mode??'efficient_first'; const defaultTier:Tier=mode==='capable_first'?'capable':'efficient';
  const holdTurns=Math.max(0,Math.trunc(options.capableHoldTurns??2));
  let remaining=Math.max(0,Math.trunc(state.capableHoldTurnsRemaining));
  const cleanTestPass=signal.testsPassed&&signal.noErrorStreak>0;
  if(cleanTestPass)remaining=0;
  let outcome:PickOutcome;
  if(!cleanTestPass&&remaining>0){remaining--;outcome={kind:'resolved',tier:'capable',source:'capable_hold',probability:0.5,confidence:1};}
  else outcome=pickTier(signal,mode,options.confidenceThreshold??0.5);
  if(outcome.kind==='resolved'&&outcome.tier==='capable'&&(outcome.source==='override'||outcome.source==='dimensions'))remaining=holdTurns;
  const dimensions=dimensionsFromSignal(signal); const score=scoreSignal(signal).score;
  const note = outcome.kind === 'resolved' && options.handoffNotes
    ? handoffNoteFor(outcome.tier, outcome.source, options.handoffNotes)
    : undefined;
  return {
    tier: outcome.kind === 'resolved' ? outcome.tier : undefined,
    defaultTier,
    source: outcome.kind === 'consult_classifier' ? 'ambiguous' : outcome.source,
    probability: outcome.probability,
    confidence: outcome.confidence ?? 0,
    score,
    dimensions,
    ...(note === undefined ? {} : { note }),
    state: { capableHoldTurnsRemaining: remaining },
  };
}

// Session-aware stay/switch (#197): not ported from Switchyard; the rules follow Weave Router's planner, without its
// history summary on a switch.
export type StaySwitchMode = 'off' | 'shadow' | 'enforce';
/** The routing.toml keys the planner reads. */
export interface StaySwitchPolicy { stay_switch: StaySwitchMode; max_switch_prefill_tokens: number }
// ponytail: an unmeasured prefill bound; #197 AC6 measures prefill before enforce becomes the default.
export const DEFAULT_STAY_SWITCH: StaySwitchPolicy = { stay_switch: 'shadow', max_switch_prefill_tokens: 32_000 };
export type SwitchReason = 'new_pin' | 'compaction' | 'context_fit' | 'same_tier' | 'override' | 'tool_loop' | 'prefill_bound' | 'user_turn';
export interface SwitchCost { inputTokens: number; maxSwitchPrefillTokens: number; fits: (tier: Tier) => boolean }
/** Input tokens a backend would prefill for a conversation, 4 characters each; the relay and local routes share it. */
export function estimateInputTokens(messages: unknown, tools?: unknown[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
}
export interface SwitchPlan { plan: 'stay' | 'switch'; tier: Tier; reason: SwitchReason }
/** What a route event records about the planner; never prompt text. */
export interface SwitchTrace { turnType: TurnKind; prefillTokens: number; staySwitch?: 'shadow' | 'enforce'; plan?: 'stay' | 'switch'; reason?: SwitchReason }

/**
 * Stay on the session's pinned tier or switch to this call's stage decision. A new session or a compaction starts a fresh
 * pin, a hard override escalates on any turn, a tool loop keeps its tier, and other changes wait for a user turn; a
 * de-escalation that makes the efficient backend prefill more than the bound stays. A tier whose backend cannot hold the
 * conversation is never chosen: nothing here summarizes or trims the history to make a switch fit.
 */
export function planSwitch(pin: Tier | undefined, fresh: Pick<StageDecision, 'tier' | 'defaultTier' | 'source'>, turn: TurnKind, cost: SwitchCost): SwitchPlan {
  const wanted = fresh.tier ?? fresh.defaultTier, other: Tier = wanted === 'capable' ? 'efficient' : 'capable';
  const want = cost.fits(wanted) || !cost.fits(other) ? wanted : other;
  const plan = (tier: Tier, reason: SwitchReason): SwitchPlan => ({ plan: pin === undefined || pin === tier ? 'stay' : 'switch', tier, reason });
  if (pin === undefined) return plan(want, 'new_pin');
  if (turn === 'compaction') return plan(want, 'compaction');
  if (want !== wanted || !cost.fits(pin)) return plan(want, 'context_fit');
  if (want === pin) return plan(pin, 'same_tier');
  if (fresh.source === 'override') return plan(want, 'override');
  if (turn === 'tool_result') return plan(pin, 'tool_loop');
  if (want === 'efficient' && cost.inputTokens > cost.maxSwitchPrefillTokens) return plan(pin, 'prefill_bound');
  return plan(want, 'user_turn');
}

/** The one place hub/auto and local stage routes apply the mode, so both record the same trace. `shadow` and `off` keep the stage tier. */
export function stayOrSwitch(policy: StaySwitchPolicy | undefined, pin: Tier | undefined, fresh: StageDecision, turn: TurnKind, cost: Omit<SwitchCost, 'maxSwitchPrefillTokens'>): { tier: Tier; pin?: Tier; trace: SwitchTrace } {
  const { stay_switch: mode, max_switch_prefill_tokens: maxSwitchPrefillTokens } = policy ?? DEFAULT_STAY_SWITCH;
  const tier = fresh.tier ?? fresh.defaultTier, trace: SwitchTrace = { turnType: turn, prefillTokens: cost.inputTokens };
  if (mode === 'off') return { tier, trace };
  const planned = planSwitch(pin, fresh, turn, { ...cost, maxSwitchPrefillTokens });
  return { tier: mode === 'enforce' ? planned.tier : tier, pin: planned.tier, trace: { ...trace, staySwitch: mode, plan: planned.plan, reason: planned.reason } };
}
