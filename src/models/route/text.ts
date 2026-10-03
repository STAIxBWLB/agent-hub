// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/advisor_gate/transcript.rs and algorithms/util/{escalation,prompts,llm_judge}.rs at commit c8848511, modified.

import type { ChatMessage } from "../../omniroute/client.ts";

/** Unicode code-point aware middle truncation used by Switchyard's advisor. */
export function middleDrop(text: string, cap: number): string {
  const chars = Array.from(text);
  if (chars.length <= cap) return text;
  const headCount = Math.max(0, Math.floor(cap / 4));
  const tailCount = Math.max(0, cap - headCount);
  return `${chars.slice(0, headCount).join("")}\n...<middle of the conversation truncated>...\n${chars.slice(-tailCount || chars.length).join("")}`;
}

/** Bounded head/tail truncation for escalation summaries, measured in code points. */
export function truncateCodepoints(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const marker = " ...[trimmed] ";
  const keep = Math.min(chars.length, Math.max(20, limit - Array.from(marker).length));
  const head = Math.floor(keep * 2 / 3);
  const tail = keep - head;
  return `${chars.slice(0, head).join("")}${marker}${chars.slice(-tail).join("")}`;
}

const verdictPattern = /^[\s*_#>"'(\[`]*(?:(?:final\s+)?verdict\s*:\s*[\s*_#>"'(\[`]*)?(APPROVE|REDO)(?![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}])/iu;

export type AdvisorVerdict = { kind: "approve" } | { kind: "redo"; plan: string };

/** Only an anchored first-word verdict is trusted. */
export function parseAdvisorVerdict(reply: string): AdvisorVerdict | undefined {
  const trimmed = reply.trim();
  const match = verdictPattern.exec(trimmed);
  if (!match) return undefined;
  if (match[1]?.toUpperCase() === "APPROVE") return { kind: "approve" };
  const tail = trimmed.slice(match[0].length).trimStart().replace(/^[ *_:\n-]+/u, "").trim();
  return { kind: "redo", plan: tail || trimmed };
}

/** Removes only the JSON fences supported by Switchyard's typed judge parser. */
export function stripJsonFence(text: string): string {
  let value = text.trim();
  if (!value.startsWith("```")) return value;
  value = value.slice(3);
  if (value.startsWith("json")) value = value.slice(4);
  value = value.replace(/^[\n\r]+/u, "");
  return value.endsWith("```") ? value.slice(0, -3).trim() : value;
}

/** Add a routing note without creating consecutive user turns. */
export function appendNote(messages: readonly ChatMessage[], note: string): ChatMessage[] {
  const output = messages.map(message => ({ ...message }));
  const last = output.at(-1);
  if (last?.role === "user") {
    last.content = last.content ? `${last.content}\n${note}` : note;
  } else {
    output.push({ role: "user", content: note });
  }
  return output;
}
