// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/advisor_gate.rs and advisor_gate/{budget,transcript,trigger,turn}.rs at commit c8848511, modified.

import type { Conversation } from "./normalize.ts";
import { ADVISOR_REDO_PREFIX, ADVISOR_REVIEWER_PROMPT } from "./prompts.ts";
import { middleDrop, type AdvisorVerdict } from "./text.ts";

export interface AdvisorConfig {
  trigger?: "no_tool_call" | "pattern";
  pattern?: string;
  maxReviews?: number;
  gateStallTurns?: number;
  gateMinToolResults?: number;
  transcriptMaxChars?: number;
  failOpen?: boolean;
}

export interface AdvisorTurn { hasToolUse: boolean; visibleText?: string }
export interface AdvisorJudgeRequest { systemPrompt: string; messages: Array<{ role: "user"; content: string }>; maxOutputTokens: number }

const DEFAULTS = { maxReviews: 1, gateStallTurns: 0, gateMinToolResults: 0, transcriptMaxChars: 200_000 };
export const truncationMarker = "\n...<middle of the conversation truncated>...\n";

export function advisorTranscript(conversation: Conversation, latestTurn?: string, cap = DEFAULTS.transcriptMaxChars): string {
  const messages = [...conversation.messages];
  const finalMessage = messages.at(-1);
  if (latestTurn !== undefined && finalMessage?.role === "assistant" && finalMessage.content === latestTurn) messages.pop();
  const transcriptMessages = [
    ...conversation.instructions.map((content, index) => ({ role: conversation.instructionRoles[index] ?? "system", content })),
    ...messages.map(({ role, content, toolCalls, toolResults }) => ({ role, content, toolCalls, toolResults })),
  ];
  const json = middleDrop(JSON.stringify(transcriptMessages), cap);
  return `Conversation so far (JSON):\n\n${json}\n\nThe executor's latest turn (a plan, or its claim the task is done):\n${latestTurn ?? "(no text)"}`;
}

export function buildAdvisorJudgeRequest(conversation: Conversation, latestTurn?: string, cap?: number, maxOutputTokens = 2048): AdvisorJudgeRequest {
  return { systemPrompt: ADVISOR_REVIEWER_PROMPT, messages: [{ role: "user", content: advisorTranscript(conversation, latestTurn, cap) }], maxOutputTokens };
}

export function redoFeedback(verdict: Extract<AdvisorVerdict, { kind: "redo" }>, discardedTurn = ""): { assistant: string; user: string } {
  return { assistant: discardedTurn, user: `${ADVISOR_REDO_PREFIX}\n${verdict.plan}` };
}

type BudgetEntry = { reviews: number; failures: number };
/** Pure policy plus a bounded in-memory review ledger; no model calls or transport. */
export class AdvisorGate {
  private readonly entries = new Map<string, BudgetEntry>();
  private readonly stalled = new Set<string>();
  constructor(readonly config: AdvisorConfig = {}) {
    if ((config.maxReviews ?? DEFAULTS.maxReviews) < 1) throw new Error("max_reviews must be at least 1");
    if ((config.transcriptMaxChars ?? DEFAULTS.transcriptMaxChars) < 256) throw new Error("transcript_max_chars must be at least 256");
    if (config.trigger === "pattern") {
      if (!config.pattern) throw new Error("gate_trigger 'pattern' requires a non-empty pattern");
      try { new RegExp(config.pattern, "u"); } catch { throw new Error("gate_trigger_pattern is not a valid regex"); }
    }
  }
  shouldReview(conversation: Conversation, turn: AdvisorTurn, scope = "instance"): boolean {
    const entry = this.entries.get(scope);
    if ((entry?.reviews ?? 0) >= (this.config.maxReviews ?? DEFAULTS.maxReviews) || (entry?.failures ?? 0) >= 3) return false;
    const results = conversation.messages.reduce((n, m) => n + m.toolResults.length, 0);
    const fired = this.config.trigger === "pattern"
      ? new RegExp(this.config.pattern!, "u").test(turn.visibleText ?? "")
      : !turn.hasToolUse && results >= (this.config.gateMinToolResults ?? DEFAULTS.gateMinToolResults);
    const turns = conversation.messages.filter(m => m.role === "assistant").length;
    const stallAt = this.config.gateStallTurns ?? DEFAULTS.gateStallTurns;
    const stalled = stallAt > 0 && turns >= stallAt && !this.stalled.has(scope);
    if (!fired && stalled) this.markStall(scope);
    return fired || stalled;
  }
  reserve(scope = "instance"): boolean {
    const entry = this.entries.get(scope) ?? { reviews: 0, failures: 0 };
    if (entry.reviews >= (this.config.maxReviews ?? DEFAULTS.maxReviews) || entry.failures >= 3) {
      this.clearStall(scope);
      return false;
    }
    this.bound(); this.entries.set(scope, { ...entry, reviews: entry.reviews + 1 }); return true;
  }
  settle(scope = "instance", result: "success" | "failure"): void {
    const entry = this.entries.get(scope) ?? { reviews: 0, failures: 0 };
    if (result === "failure") {
      this.entries.set(scope, { reviews: Math.max(0, entry.reviews - 1), failures: entry.failures + 1 });
      this.clearStall(scope);
    }
  }
  markStall(scope = "instance"): boolean { if (this.stalled.has(scope)) return false; this.bound(); this.stalled.add(scope); return true; }
  clearStall(scope = "instance"): void { this.stalled.delete(scope); }
  evict(scope: string): void { if (scope !== "instance") this.entries.delete(scope); this.stalled.delete(scope); }
  transcript(conversation: Conversation, latestTurn?: string): string { return advisorTranscript(conversation, latestTurn, this.config.transcriptMaxChars ?? DEFAULTS.transcriptMaxChars); }
  private bound(): void {
    while (this.entries.size >= 1024) {
      const key = [...this.entries.keys()].find(candidate => candidate !== "instance");
      if (key === undefined) break;
      this.entries.delete(key);
    }
    while (this.stalled.size >= 1024) {
      const key = this.stalled.values().next().value;
      if (key === undefined) break;
      this.stalled.delete(key);
    }
  }
}
