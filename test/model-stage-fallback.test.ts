import { expect, test } from "bun:test";
import { captureStageInput } from "../src/models/route/stage-input.ts";
import { buildStageEvidence } from "../src/models/route/stage-evidence.ts";
import { selectFallbackStage, planStageSwitch, type StageTier, type FallbackStageResult } from "../src/models/route/stage-fallback.ts";
const packet = (contents: string[]) => buildStageEvidence(captureStageInput(contents.map(content => ({ role: "tool", content })))!);
const choice = (tier: StageTier, source: FallbackStageResult["source"] = "default"): FallbackStageResult => ({ tier, source, score: tier === "capable" ? 1 : 0, state: { recoveryHoldRemaining: 0 } });
const fits = { fits: () => true, inputTokens: 200 };
test("recovery precedes bounded residual hold; passing-test recovery does not erase unrelated faults", () => {
  const first = selectFallbackStage(packet(["fixture step failed"]));
  expect(first.tier).toBe("efficient");
  const retry = selectFallbackStage(packet(["fixture step failed", "fixture step failed"]), { holdTurns: 3 });
  expect(retry.source).toBe("override");
  const compacted = buildStageEvidence(captureStageInput([{ role: "user", content: "Continued after the previous conversation reached its context budget." }])!);
  expect(selectFallbackStage(compacted).source).toBe("override");
  expect(retry.state.recoveryHoldRemaining).toBe(3);
  const held = selectFallbackStage(packet(["ready"]), {}, retry.state);
  expect(held.source).toBe("hold");
  expect(held.state.recoveryHoldRemaining).toBe(2);
  const cleared = selectFallbackStage(packet(["2 failed", "9 passed, 0 failed"]), {}, held.state);
  expect(cleared.tier).toBe("efficient");
  expect(() => selectFallbackStage(packet([]), { holdTurns: Infinity })).toThrow();
});
test("off and shadow preserve fallback while enforce holds arbitrary tool-loop length until a user boundary", () => {
  expect(planStageSwitch({ stay_switch: "off", max_switch_prefill_tokens: 32_000 }, "capable", choice("efficient"), "tool_result", fits)).toEqual({ tier: "efficient", pin: undefined, trace: { turnType: "tool_result", prefillTokens: 200 } });
  const shadow = planStageSwitch(undefined, "capable", choice("efficient"), "tool_result", fits);
  expect(shadow.tier).toBe("efficient");
  expect(shadow.trace).toMatchObject({ staySwitch: "shadow", plan: "stay", reason: "tool_loop" });
  const policy = { stay_switch: "enforce" as const, max_switch_prefill_tokens: 32_000 };
  let pin: StageTier | undefined = "capable";
  for (let turn = 0; turn < 17; turn++) {
    const result = planStageSwitch(policy, pin, choice("efficient"), "tool_result", fits);
    expect(result.tier).toBe("capable"); pin = result.pin;
  }
  expect(planStageSwitch(policy, pin, choice("efficient"), "user", fits).tier).toBe("efficient");
  expect(planStageSwitch(policy, pin, choice("capable", "hold"), "user", fits).tier).toBe("capable");
});
test("host fit, prefill, compaction and recovery keep closed event reasons", () => {
  const policy = { stay_switch: "enforce" as const, max_switch_prefill_tokens: 100 };
  expect(planStageSwitch(policy, undefined, choice("efficient"), "user", fits).trace).toMatchObject({ reason: "new_pin", plan: "stay" });
  expect(planStageSwitch(undefined, undefined, choice("efficient"), "user", { fits: () => true }).trace).toEqual({ turnType: "user", staySwitch: "shadow", plan: "stay", reason: "new_pin" });
  expect(planStageSwitch(policy, "efficient", choice("capable", "override"), "tool_result", fits).trace.reason).toBe("override");
  expect(planStageSwitch(policy, "capable", choice("efficient"), "user", fits).trace.reason).toBe("prefill_bound");
  expect(planStageSwitch(policy, "capable", choice("efficient"), "user", { fits: () => true }).trace).not.toHaveProperty("prefillTokens");
  expect(planStageSwitch(policy, "efficient", choice("capable", "override"), "compaction", fits).trace.reason).toBe("compaction");
  expect(planStageSwitch(policy, "capable", choice("capable"), "user", { fits: tier => tier === "efficient" }).tier).toBe("efficient");
  expect(() => planStageSwitch(policy, "capable", choice("efficient"), "user", { fits: () => false })).toThrow("no stage backend fits");
  expect(planStageSwitch(policy, undefined, choice("efficient"), "other", fits).trace).not.toHaveProperty("turnType");
});

test("historical pass cannot reset a later compaction recovery hold", () => {
  const history = [
    { role: "tool", content: "16 passed, 0 failed" },
    { role: "user", content: "Continue using the conversation summary after compaction." },
  ];
  const compacted = buildStageEvidence(captureStageInput(history)!);
  const recovery = selectFallbackStage(compacted, { holdTurns: 4 });
  expect(recovery).toMatchObject({ tier: "capable", source: "override", state: { recoveryHoldRemaining: 4 } });
  const read = buildStageEvidence(captureStageInput([...history, { role: "tool", content: "fixture document ready" }])!);
  expect(read.signals.tests).toBe("none");
  const held = selectFallbackStage(read, { holdTurns: 4 }, recovery.state);
  expect(held).toMatchObject({ tier: "capable", source: "hold", state: { recoveryHoldRemaining: 3 } });
  const policy = { stay_switch: "enforce" as const, max_switch_prefill_tokens: 32_000 };
  const completedResidual = choice("efficient");
  expect(planStageSwitch(policy, "capable", completedResidual, "tool_result", fits).tier).toBe("capable");
  expect(planStageSwitch(policy, "capable", completedResidual, "user", fits).tier).toBe("efficient");
  expect(planStageSwitch(policy, "capable", held, "user", fits).tier).toBe("capable");
});

test("a clean current step consumes hold without rearming retained failure groups", () => {
  const failed = packet(["ModuleNotFoundError: own_fixture", "ModuleNotFoundError: own_fixture"]);
  const withHold = selectFallbackStage(failed, { holdTurns: 2 });
  const withoutHold = selectFallbackStage(failed, { holdTurns: 0 });
  const clean = packet(["ModuleNotFoundError: own_fixture", "ModuleNotFoundError: own_fixture", "fixture saved"]);
  expect(clean.signals).toMatchObject({ failures: 2, repeatedFailures: 2, fault: "exception" });
  expect(selectFallbackStage(clean, { holdTurns: 2 }, withHold.state)).toMatchObject({ tier: "capable", source: "hold", state: { recoveryHoldRemaining: 1 } });
  expect(selectFallbackStage(clean, { holdTurns: 0 }, withoutHold.state)).toMatchObject({ tier: "efficient", source: "default" });
  const passed = packet(["ModuleNotFoundError: own_fixture", "ModuleNotFoundError: own_fixture", "17 tests passed"]);
  expect(passed.signals.failures).toBe(2);
  expect(selectFallbackStage(passed, { holdTurns: 2 }, withHold.state)).toMatchObject({ tier: "efficient", state: { recoveryHoldRemaining: 0 } });
});

test("historical passes on user and assistant boundaries never release a new compaction hold", () => {
  const history = [{ role: "tool", content: "23 tests passed" }, { role: "user", content: "Continue after the conversation summary compaction." }];
  const recovery = selectFallbackStage(buildStageEvidence(captureStageInput(history)!), { holdTurns: 4 });
  for (const boundary of [{ role: "user", content: "Take the next synthetic step." }, { role: "assistant", content: "A synthetic assistant boundary." }]) {
    const input = captureStageInput([...history, boundary])!;
    const current = buildStageEvidence(input);
    expect(current.signals.tests).toBe("pass");
    expect(current.turn).not.toBe("tool_result");
    expect(selectFallbackStage(current, { holdTurns: 4 }, recovery.state)).toMatchObject({ tier: "capable", source: "hold", state: { recoveryHoldRemaining: 3 } });
  }
});

test("retained critical evidence does not rearm after a clean result, but a current critical failure still overrides", () => {
  const critical = packet(["MemoryError: synthetic allocation failed"]);
  const recovery = selectFallbackStage(critical);
  const clean = packet(["MemoryError: synthetic allocation failed", "fixture ready"]);
  expect(clean.signals.fault).toBe("critical");
  expect(selectFallbackStage(clean, {}, recovery.state).source).toBe("hold");
  expect(selectFallbackStage(critical).source).toBe("override");
});

test("the owned no-progress confidence distinguishes existing threshold choices", () => {
  const history = [{ role: "user", content: "Inspect a new synthetic execution sequence." }, ...Array.from({ length: 8 }, (_, index) => [
    { role: "assistant", tool_calls: [{ id: `own-threshold-${index}`, function: { name: "bash" } }] },
    { role: "tool", tool_call_id: `own-threshold-${index}`, content: "fixture execution completed" },
  ]).flat()];
  const current = buildStageEvidence(captureStageInput(history)!);
  expect(current.scores.capable).toBe(0.46);
  expect(selectFallbackStage(current, { confidenceThreshold: 0.5 }).tier).toBe("efficient");
  expect(selectFallbackStage(current, { confidenceThreshold: 0.3 })).toMatchObject({ tier: "capable", source: "dimensions" });
});

test("an unsupported latest tail cannot turn a historical pass into a new hold checkpoint", () => {
  const history = [{ role: "tool", content: "29 tests passed" }, { role: "user", content: "Resume after the context summary compaction." }];
  const recovery = selectFallbackStage(buildStageEvidence(captureStageInput(history)!), { holdTurns: 4 });
  for (const tail of [null, {}, { role: "unsupported", content: "synthetic boundary" }]) {
    const input = captureStageInput([...history, tail])!;
    const current = buildStageEvidence(input);
    expect(current.turn).toBe("other");
    expect(current.incomplete).toBe(true);
    expect(current.signals.tests).toBe("pass");
    expect(selectFallbackStage(current, { holdTurns: 4 }, recovery.state)).toMatchObject({ tier: "capable", source: "hold", state: { recoveryHoldRemaining: 3 } });
  }
});
