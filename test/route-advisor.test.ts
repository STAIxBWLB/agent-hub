// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Golden cases ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/advisor_gate/{tests.rs,budget.rs,trigger.rs} at commit c8848511, modified.

import { describe, expect, test } from "bun:test";
import { AdvisorGate, advisorTranscript, redoFeedback } from "../src/models/route/advisor.ts";
import { normalizeConversation } from "../src/models/route/normalize.ts";
import { parseAdvisorVerdict } from "../src/models/route/text.ts";

describe("advisor route", () => {
  test("12 source verdict cases", () => {
    const approve = ["APPROVE", "approve", "  **APPROVE**", "> approve", "Final verdict: APPROVE", "verdict: APPROVE"];
    const redo: Array<[string, string]> = [
      ["REDO: run the tests", "run the tests"],
      ["REDO\n- fix x", "fix x"],
      ["**Verdict:** REDO fix y", "fix y"],
      ["REDO", "REDO"],
      ["REDO: inspect failure", "inspect failure"],
      ["redo - continue with evidence", "continue with evidence"],
    ];
    for (const value of approve) expect(parseAdvisorVerdict(value)).toEqual({ kind: "approve" });
    for (const [value, plan] of redo) expect(parseAdvisorVerdict(value)).toEqual({ kind: "redo", plan });
    expect(parseAdvisorVerdict("REDOING the work")).toBeUndefined();
    expect(parseAdvisorVerdict("I cannot approve this — REDO: run tests")).toBeUndefined();
    expect(parseAdvisorVerdict("")).toBeUndefined();
  });
  test("tool-less terminal trigger honors minimum tool-result count", () => {
    const gate = new AdvisorGate({ gateMinToolResults: 2 });
    const few = normalizeConversation([{ role: "user", content: "task" }, { role: "tool", content: "one" }]);
    expect(gate.shouldReview(few, { hasToolUse: false })).toBe(false);
    const enough = normalizeConversation([{ role: "user", content: "task" }, { role: "tool", content: "one" }, { role: "tool", content: "two" }]);
    expect(gate.shouldReview(enough, { hasToolUse: false })).toBe(true);
    expect(gate.shouldReview(enough, { hasToolUse: true })).toBe(false);
  });
  test("pattern trigger reads terminal visible text", () => {
    const gate = new AdvisorGate({ trigger: "pattern", pattern: "task_complete" });
    const conversation = normalizeConversation([{ role: "user", content: "task" }]);
    expect(gate.shouldReview(conversation, { hasToolUse: true, visibleText: "task_complete: true" })).toBe(true);
    expect(gate.shouldReview(conversation, { hasToolUse: false, visibleText: "still working" })).toBe(false);
  });
  test("stall checkpoint fires once at threshold", () => {
    const gate = new AdvisorGate({ gateStallTurns: 2, maxReviews: 3 });
    const conversation = normalizeConversation([{ role: "user", content: "task" }, { role: "assistant", content: "one" }, { role: "assistant", content: "two" }]);
    expect(gate.shouldReview(conversation, { hasToolUse: true })).toBe(true);
    expect(gate.shouldReview(conversation, { hasToolUse: true })).toBe(false);
  });
  test("review budget reserves, refunds failures, and stops after three failures", () => {
    const gate = new AdvisorGate({ maxReviews: 2 });
    expect(gate.reserve("s")).toBe(true); gate.settle("s", "success");
    expect(gate.reserve("s")).toBe(true); gate.settle("s", "failure");
    expect(gate.reserve("s")).toBe(true); gate.settle("s", "failure");
    expect(gate.reserve("s")).toBe(true); gate.settle("s", "failure");
    expect(gate.reserve("s")).toBe(false);
  });
  test("review budgets are independent by scope and successful reservations remain spent", () => {
    const gate = new AdvisorGate({ maxReviews: 1 });
    expect(gate.reserve("a")).toBe(true); gate.settle("a", "success");
    expect(gate.reserve("a")).toBe(false);
    expect(gate.reserve("b")).toBe(true);
  });
  test("evicting a session clears its review history but preserves instance scope", () => {
    const gate = new AdvisorGate({ maxReviews: 1 });
    expect(gate.reserve("instance")).toBe(true); gate.settle("instance", "success");
    expect(gate.reserve("session")).toBe(true); gate.settle("session", "success");
    gate.evict("session");
    expect(gate.reserve("session")).toBe(true);
    expect(gate.reserve("instance")).toBe(false);
  });
  test("transcript applies exact head and tail budget and appends the uncapped terminal turn", () => {
    const conversation = normalizeConversation([{ role: "user", content: "task" }]);
    const result = advisorTranscript(conversation, "latest result", 12);
    expect(result).toContain("...<middle of the conversation truncated>...");
    expect(result.endsWith("latest result")).toBe(true);
  });
  test("REDO echoes the discarded turn and returns the advisor plan as user feedback", () => {
    expect(redoFeedback({ kind: "redo", plan: "run tests" }, "I am done")).toEqual({ assistant: "I am done", user: expect.stringContaining("run tests") });
  });
});
