// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/plan_execute.rs at c8848511, modified.

import type { ToolSignals } from './signals.ts';
import type { Tier } from './stage.ts';

export const DEFAULT_PLANNING_PROMPT = 'You are in the planning phase. Inspect the task and relevant code, then form a concrete implementation plan before modifying any files. Use read-only tools as needed. Do not edit until the plan is complete. Your first edit hands execution to another model.';
export const MAX_EXECUTING_SESSIONS = 4096;

export type PlanExecutePhase = 'plan' | 'handoff' | 'execute';
export interface PlanExecuteState { executingSessions: string[] }
export interface PlanExecuteOptions {
  planningPrompt?: string;
  handoffPrompt?: string;
  sessionFinal?: boolean;
  maxSessions?: number;
}
export interface PlanExecuteDecision {
  phase: PlanExecutePhase;
  tier: Tier;
  planningPrompt?: string;
  handoffPrompt?: string;
  state: PlanExecuteState;
}

/** Pure session-aware plan/execute transition. The host persists the returned state. */
export function planExecutePhase(
  signal: ToolSignals,
  sessionKey: string | undefined,
  state: PlanExecuteState = { executingSessions: [] },
  options: PlanExecuteOptions = {},
): PlanExecuteDecision {
  let sessions = [...state.executingSessions];
  const mutationSeen = signal.editCount > 0 || signal.writeCount > 0;
  let phase: PlanExecutePhase;
  if (!sessionKey) phase = mutationSeen ? 'handoff' : 'plan';
  else if (sessions.includes(sessionKey)) phase = 'execute';
  else if (mutationSeen) {
    if (sessions.length >= (options.maxSessions ?? MAX_EXECUTING_SESSIONS)) sessions = sessions.slice(1);
    sessions.push(sessionKey);
    phase = 'handoff';
  } else phase = 'plan';
  if (sessionKey && options.sessionFinal) sessions = sessions.filter((key) => key !== sessionKey);
  return {
    phase,
    tier: phase === 'plan' ? 'capable' : 'efficient',
    ...(phase === 'plan' ? { planningPrompt: options.planningPrompt ?? DEFAULT_PLANNING_PROMPT } : {}),
    ...(phase === 'handoff' && options.handoffPrompt !== undefined ? { handoffPrompt: options.handoffPrompt } : {}),
    state: { executingSessions: sessions },
  };
}
