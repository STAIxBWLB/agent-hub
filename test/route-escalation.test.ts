// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Golden cases ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/escalation.rs at commit c8848511, modified.

import { describe, expect, test } from "bun:test";
import { EscalationState, parseEscalationVerdict, summarizeForEscalation } from "../src/models/route/escalation.ts";
import { normalizeConversation } from "../src/models/route/normalize.ts";

describe("escalation route", () => {
  test("parses a closed structured verdict and rejects unknown categories", () => {
    expect(parseEscalationVerdict('```json\n{"escalate":true,"category":"repetition","new_evidence":true,"reason":"same error"}\n```')).toEqual({ escalate: true, category: "repetition", newEvidence: true, reason: "same error" });
    expect(parseEscalationVerdict('{"escalate":true,"category":"unknown","new_evidence":true,"reason":"x"}')).toBeUndefined();
    expect(parseEscalationVerdict('{"escalate":false,"category":"drift","new_evidence":false,"reason":"routine"}')?.category).toBe("none");
  });
  test("summary pins task framing and recent tail within window", () => {
    const raw = [{ role: "system", content: "system prompt" }, { role: "user", content: "task statement" }, ...Array.from({ length: 10 }, (_, i) => ({ role: "assistant", content: `step ${i}` }))];
    const summary = summarizeForEscalation(normalizeConversation(raw), 11, { recentTurnWindow: 3 });
    expect(summary).toContain("[system] system prompt");
    expect(summary).toContain("[user (task)] task statement");
    expect(summary).toContain("Conversation turn 11; showing the last 3 of 11 messages");
    expect(summary).toContain("step 9");
    expect(summary).not.toContain("step 6");
  });
  test("all user messages before first reply remain task anchors", () => {
    const conversation = normalizeConversation([{ role: "user", content: "environment" }, { role: "user", content: "the task" }, { role: "assistant", content: "started" }, { role: "user", content: "later" }]);
    const summary = summarizeForEscalation(conversation, 1);
    expect(summary).toContain("[user (task)] environment");
    expect(summary).toContain("[user (task)] the task");
    expect(summary).toContain("[user] later");
  });
  test("summary is bounded even when messages are oversized", () => {
    const conversation = normalizeConversation([{ role: "user", content: "task" }, ...Array.from({ length: 20 }, (_, i) => ({ role: "assistant", content: `${i} ${"x".repeat(2000)}` }))]);
    const summary = summarizeForEscalation(conversation, 21, { windowMessageChars: 2000 });
    expect(Array.from(summary).length).toBeLessThanOrEqual(18_000);
    expect(summary).toContain("[user (task)] task");
    expect(summary).toContain("19 xxx");
  });
  test("same fresh category confirms; changed, stale, or declined verdict resets", () => {
    const state = new EscalationState();
    const verdict = { escalate: true, category: "repetition" as const, newEvidence: true, reason: "stuck" };
    expect(state.apply(verdict, 2).latched).toBe(false);
    expect(state.apply(undefined, 2).streak).toBe(1);
    expect(state.apply({ ...verdict, category: "drift" }, 2).streak).toBe(1);
    expect(state.apply(verdict, 2).streak).toBe(1);
    expect(state.apply(verdict, 2).latched).toBe(true);
    expect(state.apply({ escalate: false, category: "none", newEvidence: false, reason: "done" }, 2).latched).toBe(true);
  });
});
