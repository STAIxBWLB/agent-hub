// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/escalation.rs at commit c8848511, modified.

import type { Conversation, NormalizedMessage } from "./normalize.ts";
import { ESCALATION_DEESCALATION_PROMPT, ESCALATION_PROMPT } from "./prompts.ts";
import { stripJsonFence, truncateCodepoints } from "./text.ts";
export { EscalationState } from "./state.ts";

export type EscalationCategory = "none" | "repetition" | "false_progress" | "drift" | "desperation" | "capability_gap";
export interface EscalationVerdict { escalate: boolean; category: EscalationCategory; newEvidence: boolean; reason: string }
export interface EscalationOptions { recentTurnWindow?: number; windowMessageChars?: number; maxRequestChars?: number; phase?: "efficient" | "strong" }

export function parseEscalationVerdict(value: string): EscalationVerdict | undefined {
  const raw = stripJsonFence(value);
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const categories: EscalationCategory[] = ["none", "repetition", "false_progress", "drift", "desperation", "capability_gap"];
    if (typeof v.escalate !== "boolean" || typeof v.category !== "string" || !categories.includes(v.category as EscalationCategory) || typeof v.new_evidence !== "boolean" || typeof v.reason !== "string") return undefined;
    return { escalate: v.escalate, category: v.escalate ? v.category as EscalationCategory : "none", newEvidence: v.new_evidence, reason: v.reason };
  } catch { return undefined; }
}

const truncationSuffix = "...<truncated>";

function messageText(message: NormalizedMessage): string {
  const parts = [message.content];
  for (const call of message.toolCalls) parts.push(`tool_call ${call.name}(${JSON.stringify(call.arguments)})`);
  for (const result of message.toolResults) parts.push(result.content);
  return parts.filter(Boolean).join(" ");
}
const roleLabel = (role: NormalizedMessage["role"]): string => role;

/** Compact, bounded trajectory transcript used as the judge's sole user message. */
export function summarizeForEscalation(conversation: Conversation, turn: number, options: EscalationOptions = {}): string {
  const windowSize = options.recentTurnWindow ?? 28, messageCap = options.windowMessageChars ?? 500, requestCap = options.maxRequestChars ?? 18_000;
  const instructionLines = conversation.instructions.map((text, index) => `[${conversation.instructionRoles[index] ?? "system"}] ${truncateCodepoints(text, 1_000)}`);
  const anchors: string[] = [], window: string[] = [];
  let assistantSeen = false;
  for (const message of conversation.messages) {
    const text = messageText(message);
    if (message.role === "system" || message.role === "developer") instructionLines.push(`[${roleLabel(message.role)}] ${truncateCodepoints(text, 1_000)}`);
    else if (message.role === "user" && !assistantSeen) anchors.push(`[user (task)] ${truncateCodepoints(text, 4_000)}`);
    else {
      if (message.role === "assistant") assistantSeen = true;
      window.push(`[${roleLabel(message.role)}] ${truncateCodepoints(text, messageCap)}`);
    }
  }
  if (window.length > windowSize) window.splice(0, window.length - windowSize);
  const phase = options.phase === "efficient" ? "Routing phase: EFFICIENT_EVALUATION" : options.phase === "strong" ? "Routing phase: STRONG_EVALUATION" : undefined;
  const assemble = (instructions: string, lines: string[]) => [phase, `Conversation turn ${turn}; showing the last ${lines.length} of ${conversation.messages.length} messages after the task framing.`, instructions, ...anchors, ...lines].filter(Boolean).join("\n");
  const reserve = Array.from(assemble("", window.slice(-1))).length;
  const instructionBudget = Math.max(0, requestCap - reserve - 1);
  const instructionText = truncateCodepoints(instructionLines.join("\n"), instructionBudget);
  let summary = assemble(Array.from(instructionText).slice(0, instructionBudget).join(""), window);
  while (Array.from(summary).length > requestCap && window.length) { window.shift(); summary = assemble(Array.from(instructionText).slice(0, instructionBudget).join(""), window); }
  if (Array.from(summary).length > requestCap) summary = Array.from(summary).slice(0, Math.max(0, requestCap - Array.from(truncationSuffix).length - 1)).join("") + truncationSuffix;
  return summary;
}

export function buildEscalationJudgeRequest(conversation: Conversation, turn: number, options: EscalationOptions = {}, maxOutputTokens = 256) {
  const systemPrompt = options.phase ? `${ESCALATION_PROMPT.trimEnd()}\n\n${ESCALATION_DEESCALATION_PROMPT.trim()}` : ESCALATION_PROMPT;
  return { systemPrompt, messages: [{ role: "user" as const, content: summarizeForEscalation(conversation, turn, options) }], maxOutputTokens };
}
