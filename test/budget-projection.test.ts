import { expect, test } from "bun:test";
import { projectExhaustion, windowLeft } from "../src/hub/budget-projection.ts";

// #1513 AC1: the projection is a pure function of the roll-up's points and the window. No daemon, no clock, no db.
const base = 1_760_000_000_000, min = 60_000, hour = 3_600_000;

test("a steady burn projects the time the window reaches its limit (#1513 AC1)", () => {
  // 5 h window, half used at the halfway point, 100 tokens burnt each hour since it opened.
  const now = base + 2.5 * hour;
  const projection = projectExhaustion({
    used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 100 }, { at: base + hour, tokens: 100 }, { at: base + 2 * hour, tokens: 100 }],
  });
  // capacity 600, 300 left, 100/hour: two more hours from now.
  expect(projection).toEqual({ state: "projected", at: base + 4.5 * hour, basis: "window" });
});

test("a full lookback is named as the basis when the window is older than it (#1513 AC1)", () => {
  const now = base + 30 * hour;
  const projection = projectExhaustion({
    used: 0.5, windowStart: base, resetsAt: base + 168 * hour, now, lookbackMs: 24 * hour,
    points: [{ at: now - 4 * hour, tokens: 400 }, { at: now - 2 * hour, tokens: 400 }],
  });
  expect(projection.state).toBe("projected");
  expect(projection).toMatchObject({ basis: "lookback" });
});

test("a reset inside the lookback measures from the window start and says so (#1513 AC1)", () => {
  // The window opened two hours ago, so a 5 h lookback would reach into the previous window.
  const now = base + 3 * hour;
  const projection = projectExhaustion({
    used: 0.5, windowStart: base + 2 * hour, resetsAt: base + 7 * hour, now, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 9_000 }, { at: base + 2 * hour, tokens: 100 }, { at: base + 3 * hour, tokens: 100 }],
  });
  // The pre-reset point is outside the window: only 200 tokens count, so capacity 400 and 100/hour means one hour.
  expect(projection).toEqual({ state: "projected", at: base + 4 * hour, basis: "window" });
});

test("too few points read unknown, never a time (#1513 AC1)", () => {
  expect(projectExhaustion({ used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now: base + hour, lookbackMs: hour, points: [{ at: base, tokens: 10 }] }))
    .toEqual({ state: "unknown", cause: "few_points" });
  expect(projectExhaustion({ used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now: base + hour, lookbackMs: hour, points: [] }))
    .toEqual({ state: "unknown", cause: "few_points" });
});

test("no burn at all is not a zero rate and never a time (#1513 AC1)", () => {
  expect(projectExhaustion({
    used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now: base + 2 * hour, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 0 }, { at: base + hour, tokens: 0 }],
  })).toEqual({ state: "unknown", cause: "no_burn" });
});

test("a projection past the window's own reset says the reset comes first (#1513 AC1)", () => {
  expect(projectExhaustion({
    used: 0.1, windowStart: base, resetsAt: base + 5 * hour, now: base + hour, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 1 }, { at: base + hour, tokens: 1 }],
  })).toEqual({ state: "unknown", cause: "reset_first" });
});

test("an unusable reading is unknown usage, and an already-exhausted window projects now (#1513 AC1)", () => {
  expect(projectExhaustion({ used: 1.5, windowStart: base, resetsAt: base + hour, now: base + min, lookbackMs: hour, points: [] }))
    .toEqual({ state: "unknown", cause: "unknown_usage" });
  expect(projectExhaustion({ used: 0.2, windowStart: base, resetsAt: base, now: base + min, lookbackMs: hour, points: [] }))
    .toEqual({ state: "unknown", cause: "unknown_usage" });
  expect(projectExhaustion({ used: null, windowStart: base, resetsAt: base + hour, now: base + min, lookbackMs: hour, points: [] }))
    .toEqual({ state: "unknown", cause: "unknown_usage" });
  expect(projectExhaustion({ used: 1, windowStart: base, resetsAt: base + hour, now: base + min, lookbackMs: hour, points: [] }))
    .toEqual({ state: "projected", at: base + min, basis: "window" });
});

test("left is the window's remainder, and an unusable reading has none (#1513 AC2)", () => {
  expect(windowLeft(0.25)).toBe(0.75);
  expect(windowLeft(1)).toBe(0);
  expect(windowLeft(0)).toBe(1);
  expect(windowLeft(null)).toBeNull();
  expect(windowLeft(1.5)).toBeNull();
  expect(windowLeft(Number.NaN)).toBeNull();
});
