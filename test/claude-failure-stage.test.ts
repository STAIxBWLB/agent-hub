import { expect, test } from "bun:test";
import { createClaudeFailureTrace, formatClaudeFailure } from "../src/hub/claude-failure-stage.ts";

const instanceId = "12345678-1234-4234-8234-123456789abc";
const metadata = { instanceId, nativeVersion: "2.1.312" };
const canary = "PRIVATE_COMMAND_CANARY /private/task/session token-secret";

test("failure formatter publishes only fixed stages and validated host metadata", () => {
  for (const stage of ["pre_permission", "invalid_permission_request", "wrapper_refused", "manual_queue_expired", "native_error"] as const) {
    expect(formatClaudeFailure({ stage, requestId: "ab12cd34", ...metadata, body: canary, sessionId: canary, ticket: canary }, false))
      .toBe(`Claude implementer turn failed (stage=${stage}; request=ab12cd34; instance=${instanceId}; native=2.1.312)`);
  }
  const text = formatClaudeFailure({ stage: canary, requestId: canary, instanceId: canary, nativeVersion: canary }, false);
  expect(text).toBe("Claude implementer turn failed (stage=native_error)");
  expect(text).not.toContain(canary);
});

test("private or unknown privacy emits only a constant stub without inspecting evidence", () => {
  const evidence = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(canary); } });
  for (const privacy of [true, undefined, null, "false", 0] as unknown[]) {
    expect(formatClaudeFailure(evidence, privacy as boolean)).toBe("Claude implementer turn failed (details withheld)");
  }
});

test("formatter ignores inherited fields, getters, invalid ids and unparsed native versions", () => {
  let reads = 0;
  const getters = Object.fromEntries(["stage", "requestId", "instanceId", "nativeVersion"].map(key => [key, { get() { reads++; throw new Error(canary); } }]));
  expect(formatClaudeFailure(Object.defineProperties({}, getters), false)).toBe("Claude implementer turn failed (stage=native_error)");
  expect(reads).toBe(0);
  expect(formatClaudeFailure(Object.create({ stage: "wrapper_refused", requestId: "ab12cd34", ...metadata }), false)).toBe("Claude implementer turn failed (stage=native_error)");
  for (const bad of ["", "ABCDEF12", "abcdef123", "a".repeat(64), "ab12cd34\n"]) {
    expect(formatClaudeFailure({ stage: "native_error", requestId: bad }, false)).toBe("Claude implementer turn failed (stage=native_error)");
  }
  for (const bad of ["2.1.312 (Claude Code)", "v2.1.312", "02.1.312", "2.1.312\n", "2.1.312 " + canary]) {
    expect(formatClaudeFailure({ nativeVersion: bad }, false)).toBe("Claude implementer turn failed (stage=native_error)");
  }
  for (const bad of [instanceId + "\n", instanceId.toUpperCase(), "fixture-instance", canary]) {
    expect(formatClaudeFailure({ instanceId: bad }, false)).toBe("Claude implementer turn failed (stage=native_error)");
  }
  expect(formatClaudeFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(canary); } }), false)).toBe("Claude implementer turn failed (stage=native_error)");
});

test("trace records absence only before permission and generic native failure after observed progress", () => {
  const absent = createClaudeFailureTrace({ ...metadata, current: () => true });
  expect(absent.take()).toBeUndefined(); absent.seal();
  expect(absent.take()).toEqual({ stage: "pre_permission", ...metadata });
  const progress = createClaudeFailureTrace({ ...metadata, current: () => true });
  expect(progress.permissionObserved("ab12cd34")).toBe(true); progress.seal();
  expect(progress.take()).toEqual({ stage: "native_error", requestId: "ab12cd34", ...metadata });
});

test("each specific observed failure is preserved, while a new permission attempt clears old failure and correlation", () => {
  for (const stage of ["invalid_permission_request", "wrapper_refused", "manual_queue_expired"] as const) {
    const trace = createClaudeFailureTrace({ ...metadata, current: () => true });
    expect(trace.record(stage, "ab12cd34")).toBe(true); trace.seal();
    expect(trace.take()).toEqual({ stage, requestId: "ab12cd34", ...metadata });
    const recovered = createClaudeFailureTrace({ current: () => true });
    recovered.record(stage, "ab12cd34"); recovered.permissionObserved(); recovered.seal();
    expect(recovered.take()).toEqual({ stage: "native_error" });
  }
  const trace = createClaudeFailureTrace({ current: () => true });
  trace.permissionObserved("ab12cd34"); trace.record("wrapper_refused"); trace.seal();
  expect(trace.take()).toEqual({ stage: "wrapper_refused" });
});

test("sealed evidence survives owner exit, takes once and ignores late expiry and replacement events", () => {
  let alive = true;
  const old = createClaudeFailureTrace({ ...metadata, current: () => alive });
  old.permissionObserved("ab12cd34"); old.record("wrapper_refused", "ab12cd34");
  alive = false; old.seal();
  expect(old.record("manual_queue_expired", "11223344")).toBe(false);
  expect(old.permissionObserved("11223344")).toBe(false);
  const next = createClaudeFailureTrace({ current: () => true }); next.seal();
  const evidence = old.take();
  expect(evidence).toEqual({ stage: "wrapper_refused", requestId: "ab12cd34", ...metadata });
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(old.take()).toBeUndefined();
  expect(next.take()).toEqual({ stage: "pre_permission" });
});

test("trace ignores stale, throwing and non-positive owner predicates without throwing", () => {
  for (const current of [() => false, () => { throw new Error(canary); }, () => undefined as unknown as boolean]) {
    const trace = createClaudeFailureTrace({ current });
    expect(trace.permissionObserved("ab12cd34")).toBe(false);
    expect(trace.record("wrapper_refused", "ab12cd34")).toBe(false);
    trace.seal(); expect(trace.take()).toEqual({ stage: "pre_permission" });
  }
});

test("a current predicate that seals the turn cannot admit a later write", () => {
  let close = () => {};
  const trace = createClaudeFailureTrace({ current: () => { close(); return true; } });
  close = () => trace.seal();
  expect(trace.record("wrapper_refused", "ab12cd34")).toBe(false);
  expect(trace.take()).toEqual({ stage: "pre_permission" });
});

test("trace snapshots metadata without getters and discards successful or cancelled turns permanently", () => {
  const options = { ...metadata, current: () => true };
  const trace = createClaudeFailureTrace(options);
  options.instanceId = canary; options.nativeVersion = canary;
  trace.record("manual_queue_expired", "ab12cd34"); trace.seal();
  expect(trace.take()).toEqual({ stage: "manual_queue_expired", requestId: "ab12cd34", ...metadata });
  for (const sealed of [false, true]) {
    const discarded = createClaudeFailureTrace({ current: () => true });
    discarded.record("wrapper_refused"); if (sealed) discarded.seal(); discarded.discard(); discarded.seal();
    expect(discarded.take()).toBeUndefined();
    expect(discarded.permissionObserved()).toBe(false);
  }
  let reads = 0;
  const hostile = Object.defineProperties({}, {
    instanceId: { get() { reads++; throw new Error(canary); } },
    nativeVersion: { get() { reads++; throw new Error(canary); } },
    current: { value: () => true },
  }) as { current: () => boolean };
  const safe = createClaudeFailureTrace(hostile);
  expect(safe.record(canary as "wrapper_refused", canary)).toBe(false);
  safe.permissionObserved(canary); safe.seal();
  expect(safe.take()).toEqual({ stage: "native_error" }); expect(reads).toBe(0);
});
