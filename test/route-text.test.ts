// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Golden cases ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/advisor_gate/transcript.rs, algorithms/util/escalation.rs, and algorithms/util/llm_judge.rs at commit c8848511, modified.

import { describe, expect, test } from "bun:test";
import { middleDrop, parseAdvisorVerdict, stripJsonFence, truncateCodepoints } from "../src/models/route/text.ts";

describe("route text", () => {
  test("middle-drop keeps one quarter at the head and three quarters at the tail", () => {
    expect(middleDrop("0123456789", 8)).toBe("01\n...<middle of the conversation truncated>...\n456789");
  });
  test("middle-drop counts Unicode code points", () => {
    expect(middleDrop("🙂🙂🙂🙂🙂🙂🙂🙂", 4)).toContain("🙂\n...<middle of the conversation truncated>...\n🙂🙂🙂");
  });
  test("escalation truncation keeps its source head and tail", () => {
    expect(truncateCodepoints("abcdefghijklmnopqrstuvwxyz", 22)).toBe("abcdefghijklm ...[trimmed] tuvwxyz");
  });
  test("JSON fence removal follows the Switchyard parser forms exactly", () => {
    expect(stripJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripJsonFence('```\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripJsonFence('{"ok":true}')).toBe('{"ok":true}');
    expect(stripJsonFence('```JSON\n{"ok":true}\n```')).toBe('JSON\n{"ok":true}');
    expect(stripJsonFence('before ```json\n{"ok":true}\n```')).toBe('before ```json\n{"ok":true}\n```');
  });
  test.each([
    ["APPROVE", { kind: "approve" }],
    ["**APPROVE**", { kind: "approve" }],
    ["Final verdict: REDO: run the tests", { kind: "redo", plan: "run the tests" }],
    ["redo - fix the bug", { kind: "redo", plan: "fix the bug" }],
    ["REDO", { kind: "redo", plan: "REDO" }],
  ] as const)("parses anchored verdict %s", (input, expected) => expect(parseAdvisorVerdict(input)).toEqual(expected));
  test.each(["I approve this. REDO: no", "cannot APPROVE", "uncertain"]) ("rejects unanchored verdict %s", input => expect(parseAdvisorVerdict(input)).toBeUndefined());
});

test("advisor verdicts respect Rust Unicode word boundaries", () => {
  expect(parseAdvisorVerdict("APPROVE가 아니라 REDO")).toBeUndefined();
  expect(parseAdvisorVerdict("REDO수정")).toBeUndefined();
  expect(parseAdvisorVerdict("APPROVE. 확인 완료")).toEqual({ kind: "approve" });
});
