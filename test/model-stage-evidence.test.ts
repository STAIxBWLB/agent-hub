import { expect, test } from "bun:test";
import { captureStageInput } from "../src/models/route/stage-input.ts";
import { buildStageEvidence, sensitiveStageEvidence } from "../src/models/route/stage-evidence.ts";
import { selectFallbackStage } from "../src/models/route/stage-fallback.ts";
const evidence = (contents: string[]) => buildStageEvidence(captureStageInput(contents.map(content => ({ role: "tool", content })))!);
for (const text of ["Segmentation fault (core dumped)", "out of memory"]) for (const flagged of [false, true]) {
  test(`critical execution evidence without losing is_error=${flagged}: ${text}`, () => {
    const input = captureStageInput([
      { role: "assistant", tool_calls: [{ id: "critical-exec", function: { name: "exec_command" } }] },
      { role: "tool", tool_call_id: "critical-exec", content: text, ...(flagged ? { is_error: true } : {}) },
    ])!;
    expect(input.results[0]!.error).toBe(flagged);
    const packet = buildStageEvidence(input);
    expect(packet.signals.fault).toBe("critical");
    expect(packet.dimensions.severity).toBe(1);
    expect(packet.scores.capable).toBe(1);
    expect(selectFallbackStage(packet)).toMatchObject({ tier: "capable", source: "override" });
  });
}
test("closed packet has bounded finite dimensions and no source fragments or tool metadata", () => {
  const packet = evidence(["sensitive fixture failed on /private/fixture", "sensitive fixture failed on /private/fixture"]);
  expect(packet.signals.repeatedFailures).toBe(2);
  expect(packet.scores.capable).toBe(1);
  expect(Object.values(packet.dimensions).every(n => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(true);
  const encoded = JSON.stringify(packet);
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1024);
  expect(encoded).not.toContain("sensitive fixture");
  expect(encoded).not.toContain("/private");
  expect(Object.keys(sensitiveStageEvidence(packet))).toEqual(["schemaVersion", "kind", "dimensions"]);
});
test("one failed result is one observation; passing tests clear test failures only", () => {
  expect(evidence(["2 failed\n2 failed\n2 failed"]).signals.repeatedFailures).toBe(1);
  const cleared = evidence(["3 failed", "21 passed, 0 failed"]);
  expect(cleared.signals.failures).toBe(0);
  expect(cleared.signals.fault).toBe("none");
  const mixed = evidence(["copy failed on fixture", "3 failed", "21 passed, 0 failed"]);
  expect(mixed.signals.failures).toBe(1);
  expect(mixed.signals.fault).toBe("reported");
});
test("empty evidence has finite zero ratios and the declared efficient complement", () => {
  const packet = evidence([]);
  expect(packet.dimensions).toEqual({ severity: 0, spinning: 0, exploring: 0, productionIntensity: 0 });
  expect(packet.scores).toEqual({ efficient: 1, capable: 0 });
});

test("retained failure groups survive unrelated success and a different failure", () => {
  const repeated = ["fixture cache failed", "fixture cache failed"];
  expect(evidence([...repeated, "ready"]).signals.repeatedFailures).toBe(2);
  expect(evidence([...repeated, "fixture export failed"]).signals.repeatedFailures).toBe(2);
  const recoveredTests = evidence(["2 failed", "2 failed", "18 passed, 0 failed", "18 passed, 0 failed"]);
  expect(recoveredTests.signals).toMatchObject({ failures: 0, repeatedFailures: 0, tests: "pass", fault: "none" });
  const unrelated = evidence([...repeated, "2 failed", "18 passed, 0 failed"]);
  expect(unrelated.signals).toMatchObject({ failures: 2, repeatedFailures: 2, tests: "pass", fault: "reported" });
});

test("test outcome belongs to the latest inspected completed result", () => {
  const packet = evidence(["2 failed", "18 passed, 0 failed", "fixture read ready"]);
  expect(packet.signals).toMatchObject({ failures: 0, repeatedFailures: 0, tests: "none", fault: "none" });
});

test("an empty test run never clears retained failed tests", () => {
  const retained = evidence(["4 tests failed", "4 tests failed", "0 passed, 0 failed"]);
  expect(retained.signals).toMatchObject({ failures: 2, repeatedFailures: 2, tests: "unknown", fault: "reported" });
  const recovered = evidence(["4 tests failed", "4 tests failed", "0 tests failed; 18 passed"]);
  expect(recovered.signals).toMatchObject({ failures: 0, repeatedFailures: 0, tests: "pass", fault: "none" });
});

test("negated and embedded uncounted success cannot clear failed test history", () => {
  for (const summary of ["No tests passed", "not all tests passed", "summary: all tests passed"]) {
    const retained = evidence(["5 tests failed", "5 tests failed", summary]);
    expect(retained.signals.failures).toBe(2);
    expect(retained.signals.repeatedFailures).toBe(2);
    expect(retained.signals.tests).not.toBe("pass");
  }
});

test("retained diagnostics stay visible while clean current activity has no failure risk", () => {
  const clean = evidence(["synthetic transfer failed", "synthetic transfer failed", "fixture ready"]);
  expect(clean.signals).toMatchObject({ failures: 2, repeatedFailures: 2, fault: "reported" });
  expect(clean.dimensions.severity).toBe(0);
  expect(clean.dimensions.spinning).toBe(0);
  expect(clean.scores.capable).toBe(0);
  const active = evidence(["synthetic transfer failed", "synthetic transfer failed", "different synthetic operation failed"]);
  expect(active.signals.repeatedFailures).toBe(2);
  expect(active.dimensions.severity).toBe(0.3);
  expect(active.dimensions.spinning).toBeCloseTo(2 / 3);
});

function ownExecutionRounds(count: number): unknown[] {
  return [{ role: "user", content: "Work through the synthetic execution fixtures." }, ...Array.from({ length: count }, (_, index) => [
    { role: "assistant", tool_calls: [{ id: `own-round-${index}`, function: { name: "exec_command" } }] },
    { role: "tool", tool_call_id: `own-round-${index}`, content: `completed fixture ${index}` },
  ]).flat()];
}

test("eight distinct successful execution frames retain the owned ambiguous confidence", () => {
  const seven = buildStageEvidence(captureStageInput(ownExecutionRounds(7))!);
  const eight = buildStageEvidence(captureStageInput(ownExecutionRounds(8))!);
  expect(seven.dimensions.spinning).toBe(0);
  expect(eight.signals.assistantTurns).toBe(8);
  expect(eight.dimensions.spinning).toBe(0.46);
  expect(eight.scores.capable).toBe(0.46);
  expect(Object.keys(eight.signals)).toEqual(["results", "failures", "repeatedFailures", "reads", "mutations", "assistantTurns", "tests", "fault"]);
});

test("parallel results plus unrelated old assistants cannot manufacture eight execution turns", () => {
  const calls = Array.from({ length: 8 }, (_, index) => ({ id: `own-parallel-${index}`, function: { name: "exec_command" } }));
  const input = captureStageInput([
    { role: "user", content: "Inspect a synthetic parallel batch." },
    ...Array.from({ length: 7 }, () => ({ role: "assistant", content: "Older fixture frame." })),
    { role: "assistant", tool_calls: calls },
    ...calls.map(call => ({ role: "tool", tool_call_id: call.id, content: "completed parallel fixture" })),
  ])!;
  expect(input.assistantTurns).toBe(8);
  expect(new Set(input.results.map(row => row.assistantTurn)).size).toBe(1);
  expect(buildStageEvidence(input).dimensions.spinning).toBe(0);
});

test("a genuine pass, failure, read, mutation or unknown family breaks the execution streak", () => {
  const boundaries = [
    { name: "exec_command", text: "11 tests passed", error: false },
    { name: "exec_command", text: "synthetic execution failed", error: true },
    { name: "read_file", text: "fixture contents", error: false },
    { name: "write_file", text: "fixture saved", error: false },
    { name: "unknown_operation", text: "fixture ready", error: false },
  ];
  for (const boundary of boundaries) {
    const history = [...ownExecutionRounds(7),
      { role: "assistant", tool_calls: [{ id: "own-boundary", function: { name: boundary.name } }] },
      { role: "tool", tool_call_id: "own-boundary", content: boundary.text, is_error: boundary.error },
    ];
    expect(buildStageEvidence(captureStageInput(history)!).dimensions.spinning).toBe(0);
  }
});
