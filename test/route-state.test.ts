// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Golden cases ported from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/escalation.rs at commit c8848511, modified.

import { expect, test } from "bun:test";
import { EscalationState, SessionState } from "../src/models/route/state.ts";

test("session state expires idle sessions and refreshes access time", () => {
  const state = new SessionState<number>(5, 10);
  state.set("a", 1, 0);
  expect(state.get("a", 8)).toBe(1);
  expect(state.get("a", 17)).toBe(1);
  expect(state.get("a", 26)).toBe(1);
  expect(state.get("a", 37)).toBeUndefined();
});

test("session state evicts oldest entries at its bound", () => {
  const state = new SessionState<number>(2, 100);
  state.set("a", 1, 0); state.set("b", 2, 1); state.set("c", 3, 2);
  expect(state.get("a", 2)).toBeUndefined();
  expect(state.get("b", 2)).toBe(2);
});

test("escalation latch stays set until explicitly reset", () => {
  const state = new EscalationState();
  const verdict = { escalate: true, category: "repetition" as const, newEvidence: true, reason: "loop" };
  state.apply(verdict); state.apply(verdict);
  expect(state.snapshot().latched).toBe(true);
  state.reset();
  expect(state.snapshot()).toEqual({ latched: false, streak: 0 });
});
