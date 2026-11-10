import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/model-stage-sizing-v1.json";
import { captureStageInput, estimateInputTokens, estimateStageInputTokens, StageSizingUnavailableError } from "../src/models/route/stage-input.ts";

describe("own whole-wire input sizing contract", () => {
  test("new fixtures preserve observed public scalar floors with explicit Unicode conservatism", () => {
    for (const row of fixture.cases) {
      const tokens = estimateStageInputTokens(row.messages, "tools" in row ? row.tools : undefined);
      expect(tokens).toBe(row.expectedTokens);
      expect(tokens!).toBeGreaterThanOrEqual(row.observedBaselineTokens);
    }
    const unicode = fixture.cases.find(row => row.id === "unicode-text")!;
    expect(unicode.expectedTokens).toBe(39);
    expect(unicode.observedBaselineTokens).toBe(27);
  });
  test("undefined tools are omitted, empty schemas remain present", () => {
    expect(estimateInputTokens([])).toBe(4);
    expect(estimateInputTokens([], undefined)).toBe(4);
    expect(estimateInputTokens([], [])).toBe(7);
    expect(estimateStageInputTokens([{ role: "user", content: "a".repeat(70_000) }])).toBeGreaterThan(16_000);
  });
  test("never executes serialization hooks and never substitutes a partial size", () => {
    let invoked = 0;
    const getter = Object.defineProperty({}, "content", { enumerable: true, get() { invoked++; return "hidden"; } });
    const custom = Object.defineProperty({}, "toJSON", { value() { invoked++; return {}; } });
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    const hugeKey = Object.defineProperty({ ["k".repeat(2_000_001)]: "synthetic" }, "toJSON", { value() { invoked++; return {}; } });
    const hugePlainKey = { ["k".repeat(2_000_001)]: "synthetic" };
    for (const value of [getter, custom, hugeKey, hugePlainKey, cyclic, { n: Infinity }, { content: "a".repeat(2_000_001) }]) {
      expect(estimateStageInputTokens([value])).toBeUndefined();
      expect(() => estimateInputTokens([value])).toThrow(StageSizingUnavailableError);
    }
    expect(invoked).toBe(0);
    const shared = { role: "user", content: null };
    expect(estimateStageInputTokens([shared, shared])).toBeDefined();
  });
});

describe("bounded stage input, separate from wire sizing", () => {
  test("never inspects tool arguments or calls beyond the approved positions", () => {
    let touched = 0;
    const calls = Array.from({ length: 40 }, (_, i) => ({ id: `fresh-${i}`, function: { name: "read_file" } }));
    for (const call of calls) Object.defineProperty(call.function, "arguments", { get() { touched++; throw new Error("opaque arguments"); } });
    Object.defineProperty(calls, 0, { get() { touched++; throw new Error("outside call window"); } });
    const capture = captureStageInput([{ role: "assistant", tool_calls: calls }, { role: "tool", tool_call_id: "fresh-39", content: "ready" }])!;
    expect(capture.results[0]?.associated).toBe(true);
    expect(capture.incomplete).toBe(true);
    expect(touched).toBe(0);
  });
  test("bounded history/results/text and duplicate ids remain honest", () => {
    const messages = Array.from({ length: 80 }, () => ({ role: "tool", content: "x" }));
    Object.defineProperty(messages, 0, { get() { throw new Error("old history must not be read"); } });
    const input = captureStageInput(messages)!;
    expect(input.results).toHaveLength(16);
    expect(input.incomplete).toBe(true);
    const duplicate = captureStageInput([{ role: "assistant", tool_calls: [{ id: "d", function: { name: "write_file" } }, { id: "d", function: { name: "read_file" } }] }, { role: "tool", tool_call_id: "d", content: "x" }])!;
    expect(duplicate.results[0]?.associated).toBe(false);
    expect(captureStageInput([{ role: "tool", content: "z".repeat(65_537) }])?.incomplete).toBe(true);
    expect(captureStageInput({ messages: false })).toBeUndefined();
  });
  test("system content and executable accessors do not enter the local view", () => {
    let touched = 0;
    const system = Object.defineProperty({ role: "system" }, "content", { get() { touched++; return "secret"; } });
    const input = captureStageInput([system, { role: "user", content: "ordinary request" }])!;
    expect(input.turn).toBe("user");
    expect(touched).toBe(0);
    expect(JSON.stringify(input)).not.toContain("ordinary request");
  });
});

test("execution classification uses exact bounded names and local associated assistant frames only", () => {
  let argumentReads = 0;
  const fn = Object.defineProperty({ name: "exec_command" }, "arguments", { get() { argumentReads++; throw new Error("opaque execution arguments"); } });
  const input = captureStageInput([
    { role: "user", content: "Inspect the synthetic fixture." },
    { role: "assistant", tool_calls: [{ id: "own-execution", function: fn }, { id: "own-lookalike", function: { name: "bash_extra" } }] },
    { role: "tool", tool_call_id: "own-execution", content: "completed fixture" },
    { role: "tool", tool_call_id: "own-lookalike", content: "completed other fixture" },
  ])!;
  expect(input.results[0]?.family).toBe("execution");
  expect(input.results[0]?.assistantTurn).toBe(1);
  expect(input.results[1]?.family).toBe("other");
  expect(argumentReads).toBe(0);
});

test("an assistant tail cannot reuse an earlier tool or compaction boundary", () => {
  const input = captureStageInput([
    { role: "user", content: "Continue from the conversation summary after compaction." },
    { role: "tool", content: "7 tests passed" },
    { role: "assistant", content: "Synthetic final answer." },
  ])!;
  expect(input.turn).toBe("other");
});

test("an invalid non-instruction tail locks other instead of reviving historical pass", () => {
  const history = [{ role: "tool", content: "13 tests passed" }];
  for (const tail of [null, {}, { role: "unsupported", content: "synthetic unsupported tail" }]) {
    const input = captureStageInput([...history, tail])!;
    expect(input.turn).toBe("other");
    expect(input.incomplete).toBe(true);
  }
});
