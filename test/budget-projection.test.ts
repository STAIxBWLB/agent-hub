import { expect, test } from "bun:test";
import { projectExhaustion, windowLeft } from "../src/hub/budget-projection.ts";

// #1513 AC1: the projection is a pure function of the roll-up's points and the window. No daemon, no clock, no db.
const base = 1_760_000_000_000, min = 60_000, hour = 3_600_000;

test("a steady burn projects the time the window reaches its limit (#1513 AC1)", () => {
  // A 5 h window opened at base, burnt at a steady 100 tokens an hour: two and a half hours in it is half used, and the
  // last bucket holds only that half hour. 250 burnt over the 2.5 h that elapsed is 100/h, so 250 left is 2.5 more hours:
  // the limit lands exactly at the reset. Measured between the two stamps instead (250 over 2 h) it would read 125/h and
  // land half an hour early, which is what the buckets' start stamps must not do.
  const now = base + 2.5 * hour;
  const projection = projectExhaustion({
    used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 100 }, { at: base + hour, tokens: 100 }, { at: base + 2 * hour, tokens: 50 }],
  });
  expect(projection).toEqual({ state: "projected", at: base + 5 * hour, basis: "window" });
});

test("the two-point minimum does not double the rate (#1513 AC1)", () => {
  // Two points, the floor: 200 tokens over the 2 h that elapsed, not over the 1 h between the two stamps. Doubling it
  // would put the limit an hour early, at base+3h instead of base+4h.
  const now = base + 2 * hour;
  const projection = projectExhaustion({
    used: 0.5, windowStart: base, resetsAt: base + 6 * hour, now, lookbackMs: 6 * hour,
    points: [{ at: base, tokens: 100 }, { at: base + hour, tokens: 100 }],
  });
  expect(projection).toEqual({ state: "projected", at: base + 4 * hour, basis: "window" });
});

test("a stale reading is no usable reading, so it never claims a time (#1513 AC1)", () => {
  const input = {
    used: 0.5, windowStart: base, resetsAt: base + 5 * hour, now: base + 2.5 * hour, lookbackMs: 5 * hour,
    points: [{ at: base, tokens: 100 }, { at: base + hour, tokens: 100 }, { at: base + 2 * hour, tokens: 50 }],
  };
  expect(projectExhaustion({ ...input, stale: true })).toEqual({ state: "unknown", cause: "unknown_usage" });
  // The same numbers, fresh, do project: the cause above is the staleness, not the data.
  expect(projectExhaustion({ ...input, stale: false })).toMatchObject({ state: "projected" });
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
  // The pre-reset point is outside the window: only 200 tokens count, so capacity 400, and the 200 burnt in the hour
  // since the window opened leave one more hour.
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
