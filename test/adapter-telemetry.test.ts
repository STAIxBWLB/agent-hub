import { expect, test } from "bun:test";
import { definitionOf, type AdapterDefinition } from "../src/adapters/registry.ts";
import { readNativeQuota } from "../src/hub/budget.ts";
import { readNativeContext } from "../src/hub/context-window.ts";

test("native telemetry dispatch uses only the definition's declared readers", () => {
  const sample = { native: "fixture" }, calls: unknown[][] = [];
  const definition: AdapterDefinition = { ...definitionOf("qwen")!, budget: { account: "fixture", reader: {
    source: "fixture quota", read(value) { calls.push([value]); return [{ id: "5h", used: 0.4, source: "fixture quota" }]; },
  }, context: {
    source: "acp_usage_update", read(value, sessionId, measuredAt) {
      calls.push([value, sessionId, measuredAt]);
      return { source: "acp_usage_update", sessionId, measuredAt, tokens: 40, window: 100, used: 0.4 };
    },
  } } };
  expect(readNativeQuota(definition, sample)).toEqual([{ id: "5h", used: 0.4, source: "fixture quota" }]);
  expect(readNativeContext(definition, sample, "bound-session", 123)).toEqual({ source: "acp_usage_update", sessionId: "bound-session", measuredAt: 123, tokens: 40, window: 100, used: 0.4 });
  expect(calls).toEqual([[sample], [sample, "bound-session", 123]]);
});

test("a missing native quota or context reader stays unknown even for a familiar native payload", () => {
  for (const definition of [undefined, definitionOf("qwen"), definitionOf("agy")]) {
    expect(readNativeQuota(definition, { primary: { usedPercent: 100 } })).toBeUndefined();
    expect(readNativeContext(definition, { used: 100, size: 100 }, "bound-session", 123)).toBeUndefined();
  }
});

test("declared telemetry readers keep native normalization and malformed input semantics", () => {
  expect(readNativeQuota(definitionOf("codex"), { primary: { usedPercent: 25, windowDurationMins: 300 } })).toEqual([{ id: "5h", used: 0.25, windowMins: 300, source: "codex rateLimits" }]);
  expect(readNativeQuota(definitionOf("claude"), { five_hour: { used_percentage: 30 } })).toEqual([{ id: "5h", used: 0.3, windowMins: 300, source: "claude status line" }]);
  for (const id of ["claude", "codex", "kimi"]) {
    const definition = definitionOf(id)!;
    const reading = readNativeContext(definition, undefined, "bound-session", 123)!;
    expect(reading).toEqual({ source: definition.budget!.context!.source, sessionId: "bound-session", measuredAt: 123, tokens: null, window: null, used: null });
  }
});
