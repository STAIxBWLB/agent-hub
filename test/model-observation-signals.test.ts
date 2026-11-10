import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { failureFingerprint, priorFailureDigests, priorFailureContext, projectOutcomeBatch, projectOutcomeWithContext, repeatedObservationFailure,
  type ToolObservation } from "../src/models/route/observation-signals.ts";

interface Row { name?: string; command?: string; output: string; error?: boolean }
function batch(rows: Row[]) {
  const assistant = { role: "assistant", content: null, tool_calls: rows.map((row, index) => ({ id: `owned-${index}`, type: "function",
    function: { name: row.name ?? "bash", arguments: JSON.stringify({ command: row.command ?? "git status" }) } })) };
  const tools = rows.map((row, index) => ({ role: "tool", tool_call_id: `owned-${index}`, content: row.output,
    ...(row.error === undefined ? {} : { is_error: row.error }) }));
  return { assistant, tools, messages: [assistant, ...tools] };
}
function outcome(rows: Row[]) {
  const value = batch(rows);
  return projectOutcomeBatch(value.assistant, value.tools);
}

function commandless(operation: string, result: string) {
  const assistant = { role: "assistant", content: null, tool_calls: [{ id: "owned-operation", type: "function",
    function: { name: operation, arguments: "{}" } }] };
  const tools = [{ role: "tool", tool_call_id: "owned-operation", content: result }];
  return { assistant, tools, messages: [assistant, ...tools] };
}

test("a commandless closed pass inherits only the same operation's retained qualified failure", () => {
  const failed = commandless("fixture_operation", "MemoryError: 1 tests failed"), passed = commandless("fixture_operation", "1 passed, 0 failed");
  const context = priorFailureContext(failed.messages)!;
  expect(context).toHaveLength(1);
  expect(context[0]?.operation).toBe("fixture_operation");
  expect(context[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(context)).not.toContain("MemoryError");
  const projected = projectOutcomeWithContext(passed.assistant, passed.tools, context);
  expect(projected?.outcome).toEqual({ severity: 0, tests: "pass", failureDigests: [] });
  expect(projected?.retained).toEqual([]);
  expect(priorFailureContext([...failed.messages, ...passed.messages])).toEqual([]);
  expect(projectOutcomeBatch(passed.assistant, passed.tools)?.tests).toBe("none");
});

test("cross-operation, missing-context and explicitly non-test passes cannot borrow a qualified failure", () => {
  const failed = commandless("fixture_operation", "2 tests failed"), context = priorFailureContext(failed.messages)!;
  for (const value of [commandless("other_operation", "9 passed, 0 failed"),
    batch([{ name: "fixture_operation", command: "migrate records", output: "9 passed, 0 failed" }]),
    commandless("fixture_operation", "0 passed, 0 failed"), commandless("fixture_operation", "1 failed, 9 passed")]) {
    const projected = projectOutcomeWithContext(value.assistant, value.tools, context);
    expect(projected?.outcome.tests).toBe("none");
    expect(projected?.retained).toEqual(context);
  }
  const same = commandless("fixture_operation", "9 passed, 0 failed");
  expect(projectOutcomeWithContext(same.assistant, same.tools, [])?.outcome.tests).toBe("none");
  const otherFailure = priorFailureContext(commandless("other_operation", "3 tests failed").messages)!;
  expect(projectOutcomeWithContext(same.assistant, same.tools, [...context, ...otherFailure])?.retained).toEqual(otherFailure);
  const longName = "x".repeat(257), unbounded = priorFailureContext(commandless(longName, "1 tests failed").messages)!;
  expect(unbounded[0]?.operation).toBeNull();
  const longPass = commandless(longName, "1 passed, 0 failed");
  expect(projectOutcomeWithContext(longPass.assistant, longPass.tools, unbounded)?.outcome.tests).toBe("none");
});

test("full batch retains an early qualified assertion failure beyond sixteen results", () => {
  const result = outcome([{ command: "bun test", output: "AssertionError: private early fixture" },
    ...Array.from({ length: 20 }, (_, index) => ({ name: index % 2 ? "read_file" : "bash", output: "ok" }))]);
  expect(result?.severity).toBe(0.7);
  expect(result?.tests).toBe("fail");
  expect(result?.failureDigests).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private early fixture");
});

test("full result diagnostics are not the R1 sixty-four-KiB text projection", () => {
  const result = outcome([{ command: "npm test", output: "fixture log\n".repeat(7000) + "AssertionError: final fixture" }]);
  expect(result?.severity).toBe(0.7);
  expect(result?.tests).toBe("fail");
});

test("a genuine pass clears test failures while unrelated execution failures remain", () => {
  const result = outcome([{ command: "copy fixture", output: "copy failed on fixture" },
    { command: "bun test", output: "3 tests failed" }, { command: "bun test", output: "18 tests passed, 0 failed" }]);
  expect(result?.severity).toBe(0.3);
  expect(result?.tests).toBe("pass");
  const retained = failureFingerprint("copy failed on fixture", false);
  if (retained === undefined) throw new Error("missing unrelated execution failure digest");
  expect(result?.failureDigests).toEqual([retained]);
});

test("quoted successful reads and editor views neither seed failures nor clear retained tests", () => {
  const quoted = outcome([{ name: "read_file", output: "MemoryError: 9 tests failed" },
    { name: "text_editor", command: "view", output: "AssertionError: example in a fixture" }]);
  expect(quoted).toEqual({ severity: 0, tests: "none", failureDigests: [] });
  const retained = outcome([{ command: "bun test", output: "3 tests failed" },
    { name: "read_file", output: "99 tests passed" }, { output: "ok" }]);
  expect(retained?.tests).toBe("fail");
  expect(retained?.failureDigests).toHaveLength(1);
});

test("a failed unrelated command and a quoted test failure read do not invent test context", () => {
  const result = outcome([{ output: "command failed: exit code 1", error: true },
    { name: "read", output: "2 tests failed" }, { name: "text_editor", command: "view", output: "AssertionError: quoted" }]);
  expect(result?.severity).toBe(0.7);
  expect(result?.tests).toBe("none");
  expect(result?.failureDigests).toHaveLength(1);
});

test("local severity follows critical, native/assertion/exception, reported and qualified test-only precedence", () => {
  const cases = [
    { output: "MemoryError: fixture allocation failed", severity: 1 },
    { output: "fixture stopped", error: true, severity: 0.7 },
    { output: "AssertionError: fixture", severity: 0.7 },
    { output: "ReferenceError: fixture", severity: 0.7 },
    { output: "fixture export failed", severity: 0.3 },
    { command: "./wrapper.sh bun test", output: "2 failed, 8 passed (exit code 0)", severity: 0 },
  ] as const;
  for (const row of cases) expect(outcome([row])?.severity).toBe(row.severity);
  expect(outcome([cases[5]!])?.tests).toBe("fail");
});

test("numeric migration summaries alone are neither test failure nor test pass", () => {
  const failed = outcome([{ command: "migrate records", output: "2 failed, 8 passed (exit code 0)" }]);
  expect(failed?.severity).toBe(0.3);
  expect(failed?.tests).toBe("none");
  expect(outcome([{ command: "migrate records", output: "9 passed, 0 failed" }])?.tests).toBe("none");
});

test("owned test invocation names qualify numeric outcomes with empty arguments", () => {
  for (const name of ["jest", "vitest", "spec", "specs", "tests"]) {
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "named-test", type: "function",
      function: { name, arguments: "{}" } }] };
    const result = projectOutcomeBatch(assistant, [{ role: "tool", tool_call_id: "named-test", content: "2 failed, 8 passed" }]);
    expect(result?.tests).toBe("fail");
    expect(result?.severity).toBe(0);
    expect(result?.failureDigests).toHaveLength(1);
  }
});

test("failed counts beat simultaneous passing counts and zero-zero never clears tests", () => {
  const retained = outcome([{ command: "npm test", output: "3 failed, 8 passed" },
    { command: "npm test", output: "0 passed, 0 failed" }, { output: "ok" }]);
  expect(retained?.tests).toBe("fail");
  expect(retained?.severity).toBe(0);
  expect(outcome([{ command: "bun test", output: "0 passed, 0 failed" }])?.tests).toBe("none");
});

test("a test report cannot hide an unrelated reported failure in the same result", () => {
  const result = outcome([{ command: "bun test", output: "2 tests failed; copy failed" },
    { command: "bun test", output: "4 tests passed" }]);
  expect(result?.tests).toBe("pass");
  expect(result?.severity).toBe(0.3);
  expect(result?.failureDigests).toHaveLength(1);
});

test("missing, orphaned, duplicate or partial call/result association is unavailable", () => {
  const value = batch([{ output: "ok" }, { output: "ok" }]);
  expect(projectOutcomeBatch(value.assistant, value.tools.slice(0, 1))).toBeUndefined();
  expect(projectOutcomeBatch(value.assistant, [value.tools[0], value.tools[0]])).toBeUndefined();
  expect(projectOutcomeBatch(value.assistant, [{ ...value.tools[0], tool_call_id: "orphan" }, value.tools[1]])).toBeUndefined();
  expect(projectOutcomeBatch({ ...value.assistant, tool_calls: [value.assistant.tool_calls[0], value.assistant.tool_calls[0]] }, value.tools)).toBeUndefined();
  expect(projectOutcomeBatch({ role: "assistant", content: null }, value.tools)).toBeUndefined();
});

test("malformed flags, hostile records and partial source data are unavailable without invoking code", () => {
  let touched = 0;
  const value = batch([{ output: "ok" }]);
  const getter = { ...value.tools[0], get content() { touched++; return "ok"; } };
  expect(projectOutcomeBatch(value.assistant, [getter])).toBeUndefined();
  const proxy = new Proxy(value.assistant, { get() { touched++; return undefined; }, getOwnPropertyDescriptor() { touched++; return undefined; } });
  expect(projectOutcomeBatch(proxy, value.tools)).toBeUndefined();
  expect(projectOutcomeBatch(value.assistant, [{ ...value.tools[0], is_error: "false" }])).toBeUndefined();
  expect(projectOutcomeBatch(value.assistant, [{ ...value.tools[0], content: null }])).toBeUndefined();
  expect(touched).toBe(0);
});

test("whole-wire overflow is unavailable instead of an all-clear partial batch", () => {
  const value = batch([{ output: "x".repeat(2_000_001) }]);
  expect(projectOutcomeBatch(value.assistant, value.tools)).toBeUndefined();
  expect(priorFailureDigests(value.messages)).toBeUndefined();
});

test("prior batches retain only owned diagnostic SHA-256 digests and ignore successful retrieval", () => {
  const view = batch([{ name: "text_editor", command: "view", output: "AssertionError: private fixture" }]);
  expect(priorFailureDigests(view.messages)).toEqual([]);
  const prior = batch([{ command: "npm test", output: "AssertionError: private fixture" }]);
  const hashes = priorFailureDigests(prior.messages)!;
  const expected = createHash("sha256").update("test:assertionerror: private fixture").digest("hex");
  expect(hashes).toEqual([expected]);
  expect(hashes.every(hash => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  expect(JSON.stringify(hashes)).not.toContain("private fixture");
  expect(failureFingerprint("build failed at attempt 12", false)).toBe(failureFingerprint("build failed at attempt 13", false));
});

test("a genuine later batch pass clears only prior qualified test fingerprints", () => {
  const failed = batch([{ command: "bun test", output: "2 tests failed" }]);
  const read = batch([{ name: "read_file", output: "200 tests passed" }]);
  const passed = batch([{ command: "bun test", output: "3 tests passed" }]);
  expect(priorFailureDigests([...failed.messages, ...read.messages])).toHaveLength(1);
  expect(priorFailureDigests([...failed.messages, ...passed.messages])).toEqual([]);
});

test("native observation repetition does not treat one mixed diagnostic as two attempts", () => {
  const mixed: ToolObservation = { name: "bash", command: "bun test", resultText: "2 tests failed; copy failed" };
  expect(repeatedObservationFailure([mixed])).toBe(false);
  expect(repeatedObservationFailure([mixed, mixed])).toBe(true);
  expect(repeatedObservationFailure([{ name: "read", resultText: "AssertionError: fixture" },
    { name: "text_editor", command: "view", resultText: "AssertionError: fixture" }])).toBe(false);
});

test("native repetition preserves outcome clearing and refuses malformed or over-bound observations", () => {
  const failure = { name: "bash", command: "bun test", resultText: "2 tests failed" };
  expect(repeatedObservationFailure([failure, failure, { name: "bash", command: "bun test", resultText: "3 tests passed" }])).toBe(false);
  expect(repeatedObservationFailure([{ name: "bash", isError: "false" } as unknown as ToolObservation])).toBeUndefined();
  expect(repeatedObservationFailure([{ name: "bash", resultText: "x".repeat(2_000_001) }])).toBeUndefined();
});

test("combined overflow rejects shared individually bounded result strings", () => {
  const shared = "fixture failure ".repeat(70_000);
  expect(Buffer.byteLength(shared)).toBeLessThan(2_000_000);
  const observations = Array.from({ length: 28 }, () => ({ name: "bash", resultText: shared }));
  expect(repeatedObservationFailure(observations)).toBeUndefined();
  // This result assertion does not measure CPU order. Source admission has two
  // phases: lower-bound copy + exact wire admission, then diagnostics/folding.
});
