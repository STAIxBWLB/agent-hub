import { expect, test } from "bun:test";
import { claudeContext, codexContext, ContextWindows, DEFAULT_CONTEXT } from "../src/hub/context-window.ts";
import { contextLine } from "../src/cli/status-lines.ts";

test("native context counters distinguish occupancy from lifetime usage and unknown from zero", () => {
  const claude = claudeContext({ context_window_size: 200_000, used_percentage: 20, current_usage: { input_tokens: 10_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 90_000 }, total_input_tokens: 999_999 }, "s", 100);
  expect(claude.tokens).toBe(40_000); expect(claude.used).toBe(0.2);
  expect(claudeContext({ context_window_size: 200_000, used_percentage: 0, current_usage: null }, "s", 100).used).toBeNull();
  expect(claudeContext({ context_window_size: "200000", used_percentage: "90", current_usage: {} }, "s", 100).used).toBeNull();
  for (const current_usage of ["malformed", [], {}, { input_tokens: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }]) expect(claudeContext({ context_window_size: 200_000, used_percentage: 90, current_usage }, "s", 100).used).toBeNull();
  const codex = codexContext({ modelContextWindow: 100_000, total: { totalTokens: 5_000_000 }, last: { totalTokens: 40_000 } }, "th", 100);
  expect(codex.used).toBe(0.4);
  for (const window of [null, undefined, 0, "100000", NaN, Infinity]) expect(codexContext({ modelContextWindow: window, last: { totalTokens: 1 } }, "th", 100).used).toBeNull();
  expect(codexContext({ modelContextWindow: 100, last: { totalTokens: null } }, "th", 100).used).toBeNull();
  expect(codexContext({ modelContextWindow: 100, last: { totalTokens: 0 } }, "th", 100).used).toBe(0);
});

test("context pressure stays off by default and deduplicates crossings without rearming on invalid or stale readings", () => {
  let now = 120_000; const events: number[] = [];
  const reading = (used: number | null, at = now, session = "s") => ({ source: "codex_token_usage" as const, sessionId: session, measuredAt: at, tokens: used === null ? null : used * 100, window: 100, used });
  const disabled = new ContextWindows(DEFAULT_CONTEXT, () => events.push(0), () => now);
  disabled.report("codex", reading(0.99), "s"); expect(events).toHaveLength(0);
  const windows = new ContextWindows({ gate: 0.8, stale_min: 1 }, (_peer, r) => events.push(r.used!), () => now);
  windows.report("codex", reading(0.9), "s"); windows.report("codex", reading(0.95), "s");
  windows.report("codex", reading(null), "s"); windows.report("codex", reading(0.1, now - 70_000), "s"); windows.report("codex", reading(0.9), "s");
  expect(events).toEqual([0.9]);
  now += 70_000; expect(windows.view("codex", "s", true).used).toBeNull(); expect(windows.view("codex", "s", true).freshness).toBe("stale");
  expect(contextLine(windows.view("codex", "s", true))).toContain("context unknown (stale");
  windows.report("codex", reading(0.9), "s"); expect(events).toHaveLength(1);
  windows.report("codex", reading(0.7), "s"); windows.report("codex", reading(0.85), "s"); expect(events).toHaveLength(2);
  expect(windows.view("codex", "replacement", true).used).toBeNull(); expect(windows.view("codex", "s", false).used).toBeNull();
  windows.report("codex", reading(0.99, now, "old"), "replacement"); expect(events).toHaveLength(2);
  windows.report("codex", reading(0.9, now, "replacement"), "replacement"); expect(events).toHaveLength(3);
  windows.report("codex", reading(0.1, now + 1, "replacement"), "replacement"); expect(windows.view("codex", "replacement", true).used).toBeNull();
  windows.report("codex", reading(0.9, now + 2, "replacement"), "replacement"); expect(events).toHaveLength(3);
  expect(windows.view("pi", "p", true).used).toBeNull();
});


test.each(["pause", "recovery"])("context crossing held by %s retries once after release using only fresh session-bound telemetry", () => {
  let now = 120_000, held = true; const events: number[] = [];
  const windows = new ContextWindows({ gate: 0.8, stale_min: 1 }, (_peer, r) => { if (held) return false; events.push(r.used!); return true; }, () => now);
  const sample = (used: number | null, sessionId = "native") => ({ source: "codex_token_usage" as const, sessionId, measuredAt: now, tokens: used === null ? null : used * 100, window: 100, used });
  windows.report("codex", sample(0.9), "native"); windows.retry("codex", "native"); expect(events).toHaveLength(0);
  held = false; windows.retry("codex", "native"); windows.retry("codex", "native"); expect(events).toEqual([0.9]);
  windows.report("codex", sample(null), "native"); windows.retry("codex", "native"); windows.report("codex", sample(0.95), "native"); expect(events).toHaveLength(1);
  windows.report("codex", sample(0.1), "native"); held = true; windows.report("codex", sample(0.9), "native"); now += 70_000;
  held = false; windows.retry("codex", "native"); expect(events).toHaveLength(1);
  windows.report("codex", sample(0.9), "native"); expect(events).toHaveLength(2);
  held = true; windows.report("codex", sample(0.9, "replacement"), "replacement"); held = false;
  windows.retry("codex", "another-session"); expect(events).toHaveLength(2);
});
