import { expect, test } from "bun:test";
import { normalizeConversation } from "../src/models/route/normalize.ts";
import { extractToolSignalsFromObservations, turnKind, type ToolSignals } from "../src/models/route/signals.ts";
import { dimensionsFromSignal, handoffNoteFor, pickTier, planSwitch, scoreSignal, selectStage, type Tier } from "../src/models/route/stage.ts";

const neutral = (): ToolSignals => extractToolSignalsFromObservations([]);

test("stage dimensions partition deep unproductive turns into spinning and exploring", () => {
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 8 })).toMatchObject({ spinning: 1, exploring: 0, productionIntensity: 0 });
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 7 })).toMatchObject({ spinning: 0, exploring: 0 });
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 8, recentReadCount: 1 })).toMatchObject({ spinning: 0, exploring: 1 });
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 8, recentTodowriteCount: 1 })).toMatchObject({ spinning: 0, exploring: 1 });
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 8, recentNewCount: 1 })).toMatchObject({ spinning: 0, exploring: 0 });
  expect(dimensionsFromSignal({ ...neutral(), turnDepth: 8, recentReadCount: 1, recentWriteCount: 1 })).toMatchObject({ spinning: 0, exploring: 0, productionIntensity: 0.5 });
});

test("stage score uses Switchyard's weighted tanh formula", () => {
  const signal = { ...neutral(), severity: 0.7 };
  expect(scoreSignal(signal).score).toBeCloseTo(Math.tanh(0.5), 12);
  const production = { ...neutral(), recentWriteCount: 1 };
  expect(scoreSignal(production).score).toBeCloseTo(Math.tanh(-0.5), 12);
  expect(scoreSignal(neutral()).confidence).toBe(0);
});

test("stage hard overrides dominate scoring and use the fixed capable result", () => {
  for (const signal of [{ ...neutral(), severity: 1 }, { ...neutral(), repeatedFailure: true }, { ...neutral(), compacted: true }]) {
    expect(pickTier(signal, "efficient_first", 0.9)).toEqual({ kind: "resolved", tier: "capable", source: "override", probability: 0.5, confidence: 1 });
  }
});

test("stage dimensions route outside the threshold and abstain inside it", () => {
  expect(pickTier({ ...neutral(), severity: 0.7 }, "efficient_first", 0.4)).toMatchObject({ kind: "resolved", tier: "capable", source: "dimensions" });
  expect(pickTier({ ...neutral(), recentWriteCount: 1 }, "capable_first", 0.4)).toMatchObject({ kind: "resolved", tier: "efficient", source: "dimensions" });
  expect(pickTier({ ...neutral(), recentWriteCount: 1 }, "capable_first", 0.5)).toMatchObject({ kind: "consult_classifier", defaultTier: "capable" });
  expect(pickTier(neutral(), "efficient_first", 0.5)).toMatchObject({ kind: "consult_classifier", defaultTier: "efficient" });
  expect(pickTier(neutral(), "capable_first", 0.5)).toMatchObject({ kind: "consult_classifier", defaultTier: "capable" });
  expect(pickTier({ ...neutral(), severity: 0.7 }, "efficient_first", 1)).toMatchObject({ kind: "consult_classifier" });
});

test("capable hold starts after escalation, decrements, and clears on clean passing tests", () => {
  const first = selectStage({ ...neutral(), severity: 0.7 }, { confidenceThreshold: 0.4 }, { capableHoldTurnsRemaining: 0 });
  expect(first).toMatchObject({ tier: "capable", source: "dimensions", state: { capableHoldTurnsRemaining: 2 } });
  const held = selectStage(neutral(), {}, first.state);
  expect(held).toMatchObject({ tier: "capable", source: "capable_hold", state: { capableHoldTurnsRemaining: 1 } });
  const cleared = selectStage({ ...neutral(), testsPassed: true, noErrorStreak: 1 }, {}, held.state);
  expect(cleared).toMatchObject({ tier: undefined, source: "ambiguous", state: { capableHoldTurnsRemaining: 0 } });
});

test("capable hold can be disabled or explicitly sized", () => {
  const disabled = selectStage({ ...neutral(), severity: 1 }, { capableHoldTurns: 0 });
  expect(disabled.state.capableHoldTurnsRemaining).toBe(0);
  const sized = selectStage({ ...neutral(), severity: 1 }, { capableHoldTurns: 4 });
  expect(sized.state.capableHoldTurnsRemaining).toBe(4);
});

test("stage default mode and exact threshold are represented without an implicit choice", () => {
  const ambiguous = selectStage(neutral(), { mode: "capable_first" });
  expect(ambiguous).toMatchObject({ tier: undefined, defaultTier: "capable", source: "ambiguous" });
  expect(selectStage({ ...neutral(), recentWriteCount: 1 }, { confidenceThreshold: 0.4 }).tier).toBe("efficient");
});

test("handoff-note policy matches the upstream source and tier gates", () => {
  const note = { escalationNote: "recovering from an error", deescalationNote: "settled — carry on", onlyOnWrongSignalEscalation: true };
  expect(handoffNoteFor("capable", "override", note)).toBe("recovering from an error");
  expect(handoffNoteFor("capable", "dimensions", note)).toBe("recovering from an error");
  expect(handoffNoteFor("capable", "ambiguous", note)).toBeUndefined();
  expect(handoffNoteFor("capable", "ambiguous", { ...note, onlyOnWrongSignalEscalation: false })).toBe("recovering from an error");
  expect(handoffNoteFor("efficient", "dimensions", note)).toBe("settled — carry on");
  expect(handoffNoteFor("efficient", "dimensions", { escalationNote: note.escalationNote })).toBeUndefined();
  expect(handoffNoteFor("capable", "capable_hold", note)).toBeUndefined();
});

test("resolved stage choices attach notes once, while held, passing, and ambiguous turns stay quiet", () => {
  const handoffNotes = { escalationNote: "recovering from an error", deescalationNote: "settled — carry on" };
  const first = selectStage({ ...neutral(), severity: 1 }, { handoffNotes });
  expect(first.note).toBe(handoffNotes.escalationNote);
  const held = selectStage(neutral(), { handoffNotes }, first.state);
  expect(held).toMatchObject({ tier: "capable", source: "capable_hold" });
  expect(held.note).toBeUndefined();
  const heldAgain = selectStage(neutral(), { handoffNotes }, held.state);
  expect(heldAgain.note).toBeUndefined();

  const passing = selectStage({ ...neutral(), testsPassed: true, noErrorStreak: 1, recentWriteCount: 1 }, { handoffNotes }, heldAgain.state);
  expect(passing.note).toBeUndefined();
  expect(selectStage(neutral(), { mode: "capable_first", handoffNotes }).note).toBeUndefined();
  expect(selectStage({ ...neutral(), severity: 1 }).note).toBeUndefined();
});

// #197: session-aware stay/switch.
const cost = (inputTokens = 1000, fits: (tier: Tier) => boolean = () => true) => ({ inputTokens, maxSwitchPrefillTokens: 32_000, fits });
const efficient = { tier: undefined, defaultTier: "efficient", source: "ambiguous" } as const;
const dimensionsCapable = { tier: "capable", defaultTier: "efficient", source: "dimensions" } as const;

test("planSwitch keeps the pinned tier through a tool loop and switches at a user turn", () => {
  expect(planSwitch("capable", efficient, "tool_result", cost())).toEqual({ plan: "stay", tier: "capable", reason: "tool_loop" });
  expect(planSwitch("efficient", dimensionsCapable, "tool_result", cost())).toEqual({ plan: "stay", tier: "efficient", reason: "tool_loop" });
  expect(planSwitch("capable", efficient, "user", cost())).toEqual({ plan: "switch", tier: "efficient", reason: "user_turn" });
  expect(planSwitch("efficient", dimensionsCapable, "user", cost())).toEqual({ plan: "switch", tier: "capable", reason: "user_turn" });
  expect(planSwitch("efficient", efficient, "tool_result", cost())).toEqual({ plan: "stay", tier: "efficient", reason: "same_tier" });
  expect(planSwitch(undefined, efficient, "tool_result", cost())).toEqual({ plan: "stay", tier: "efficient", reason: "new_pin" });
});

test("planSwitch escalates a hard override on a tool-result turn and lets a compaction start a fresh pin", () => {
  const override = { tier: "capable", defaultTier: "efficient", source: "override" } as const;
  expect(planSwitch("efficient", override, "tool_result", cost())).toEqual({ plan: "switch", tier: "capable", reason: "override" });
  expect(planSwitch("efficient", override, "compaction", cost())).toEqual({ plan: "switch", tier: "capable", reason: "compaction" });
  expect(planSwitch("capable", override, "compaction", cost())).toEqual({ plan: "stay", tier: "capable", reason: "compaction" });
});

test("planSwitch stays when a de-escalation would prefill more than the bound, and never picks a tier that cannot fit", () => {
  expect(planSwitch("capable", efficient, "user", cost(32_001))).toEqual({ plan: "stay", tier: "capable", reason: "prefill_bound" });
  expect(planSwitch("capable", efficient, "user", cost(32_000)).plan).toBe("switch");
  const onlyCapable = (tier: Tier) => tier === "capable";
  expect(planSwitch("capable", efficient, "user", cost(1000, onlyCapable))).toEqual({ plan: "stay", tier: "capable", reason: "context_fit" });
  expect(planSwitch(undefined, efficient, "user", cost(1000, onlyCapable))).toEqual({ plan: "stay", tier: "capable", reason: "new_pin" });
  expect(planSwitch("efficient", efficient, "tool_result", cost(1000, onlyCapable))).toEqual({ plan: "switch", tier: "capable", reason: "context_fit" });
});

test("turnKind reads what a call answers from its last message", () => {
  const kind = (messages: unknown[]) => turnKind(normalizeConversation(messages));
  expect(kind([{ role: "user", content: "fix it" }])).toBe("user");
  expect(kind([{ role: "user", content: "fix it" }, { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: "ok" }])).toBe("tool_result");
  expect(kind([{ role: "user", content: "This session is being continued from a previous conversation." }])).toBe("compaction");
});

test("#197 review: a hard override during a stage hold still plans an immediate escalation", () => {
  const dims = { ...neutral(), severity: 0.7 };
  const escalated = selectStage(dims, { confidenceThreshold: 0.4 });
  expect(escalated).toMatchObject({ tier: "capable", source: "dimensions", hardOverride: false });
  // Enforced, the dimension escalation waits inside the tool loop: the pin stays efficient while the hold runs.
  expect(planSwitch("efficient", escalated, "tool_result", cost())).toMatchObject({ plan: "stay", reason: "tool_loop" });
  const repeated = selectStage({ ...neutral(), repeatedFailure: true }, { confidenceThreshold: 0.4 }, escalated.state);
  expect(repeated).toMatchObject({ tier: "capable", source: "capable_hold", hardOverride: true });
  expect(planSwitch("efficient", repeated, "tool_result", cost())).toEqual({ plan: "switch", tier: "capable", reason: "override" });
  const held = selectStage(neutral(), { confidenceThreshold: 0.4 }, escalated.state);
  expect(planSwitch("efficient", held, "tool_result", cost())).toMatchObject({ plan: "stay", reason: "tool_loop" });
});
