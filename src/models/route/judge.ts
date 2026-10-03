// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/llm_judge.rs at commit c8848511, modified.

import type { Conversation } from "./normalize.ts";
import { buildAdvisorJudgeRequest, type AdvisorJudgeRequest } from "./advisor.ts";
import { buildEscalationJudgeRequest, type EscalationOptions } from "./escalation.ts";
import { parseAdvisorVerdict, type AdvisorVerdict } from "./text.ts";
import { parseEscalationVerdict, type EscalationVerdict } from "./escalation.ts";

/** Host-neutral structured judge payload; callers own model execution and failure policy. */
export interface JudgeRequest { systemPrompt: string; messages: Array<{ role: "user"; content: string }>; maxOutputTokens: number }
export function advisorJudgeRequest(conversation: Conversation, latestTurn?: string, transcriptMaxChars?: number, maxOutputTokens = 2048): JudgeRequest {
  return buildAdvisorJudgeRequest(conversation, latestTurn, transcriptMaxChars, maxOutputTokens);
}
export function escalationJudgeRequest(conversation: Conversation, turn: number, options?: EscalationOptions, maxOutputTokens = 256): JudgeRequest {
  return buildEscalationJudgeRequest(conversation, turn, options, maxOutputTokens);
}
export function decodeAdvisorReply(reply: string): AdvisorVerdict | undefined { return parseAdvisorVerdict(reply); }
export function decodeEscalationReply(reply: string): EscalationVerdict | undefined { return parseEscalationVerdict(reply); }

// Keep the lower-level public request type available to callers during migration.
export type { AdvisorJudgeRequest };
