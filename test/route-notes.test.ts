// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/prompts.rs at c8848511.

import { expect, test } from "bun:test";
import type { ChatMessage } from "../src/omniroute/client.ts";
import { appendNote } from "../src/models/route/text.ts";

const note = "recovering from an error";

test("note follows a trailing user message containing a tool result", () => {
  const before: ChatMessage[] = [{ role: "user", content: "exit 1" }];
  const after = appendNote(before, note);
  expect(after).toEqual([{ role: "user", content: `exit 1\n${note}` }]);
  expect(after).not.toBe(before);
});

test("note opens a user turn after an assistant reply", () => {
  expect(appendNote([{ role: "assistant", content: "done" }], note)).toEqual([
    { role: "assistant", content: "done" },
    { role: "user", content: note },
  ]);
});

test("note leaves earlier messages unchanged and preserves a tool-call message", () => {
  const before: ChatMessage[] = [
    { role: "user", content: "fix the build" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "test", arguments: "{}" } }] },
  ];
  const after = appendNote(before, note);
  expect(after).toEqual([...before, { role: "user", content: note }]);
  expect(before).toHaveLength(2);
});

test("note updates a trailing user message without adding a second user turn", () => {
  const after = appendNote([{ role: "user", content: "first note" }, { role: "user", content: "tool output" }], note);
  expect(after).toHaveLength(2);
  expect(after[1]?.content).toBe(`tool output\n${note}`);
});
