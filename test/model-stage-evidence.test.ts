import { expect, test } from "bun:test";
import { captureStageInput } from "../src/models/route/stage-input.ts";
import { buildStageEvidence, sensitiveStageEvidence } from "../src/models/route/stage-evidence.ts";
const evidence = (contents: string[]) => buildStageEvidence(captureStageInput(contents.map(content => ({ role: "tool", content })))!);
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
