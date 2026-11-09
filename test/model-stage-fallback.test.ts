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
