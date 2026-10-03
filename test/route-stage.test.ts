import { expect, test } from "bun:test";
import { extractToolSignalsFromObservations, type ToolSignals } from "../src/models/route/signals.ts";
import { dimensionsFromSignal, handoffNoteFor, pickTier, scoreSignal, selectStage } from "../src/models/route/stage.ts";

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
