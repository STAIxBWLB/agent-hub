// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Golden cases ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/llm_judge.rs at commit c8848511, modified.

import { expect, test } from "bun:test";
import { advisorJudgeRequest, decodeAdvisorReply, escalationJudgeRequest, decodeEscalationReply } from "../src/models/route/judge.ts";
import { normalizeConversation } from "../src/models/route/normalize.ts";

test("advisor judge request preserves host boundary and source prompt contract", () => {
  const conversation = normalizeConversation([{ role: "user", content: "fix it" }]);
  const request = advisorJudgeRequest(conversation, "I finished", 100, 128);
  expect(request.systemPrompt).toContain("APPROVE");
  expect(request.systemPrompt).toContain("REDO");
  expect(request.messages[0]?.content).toContain("I finished");
  expect(request.maxOutputTokens).toBe(128);
  expect(decodeAdvisorReply("APPROVE")).toEqual({ kind: "approve" });
});

test("escalation judge request produces structured trajectory input", () => {
  const conversation = normalizeConversation([{ role: "user", content: "fix it" }, { role: "assistant", content: "still failing" }]);
  const request = escalationJudgeRequest(conversation, 1, { phase: "efficient" });
  expect(request.systemPrompt).toContain("new_evidence");
  expect(request.messages[0]?.content).toContain("EFFICIENT_EVALUATION");
  expect(decodeEscalationReply('{"escalate":false,"category":"none","new_evidence":false,"reason":"routine"}')?.escalate).toBe(false);
});
