import { expect, test } from "bun:test";
import { Limiter } from "../src/hub/limits.ts";

test("remote hub and peer rate admission is atomic when the shared hub bucket refuses", () => {
  const limiter = new Limiter({ sender_per_min: 2, pair_per_min: 0, important_per_hour: 0, repeat_window_s: 0 }, () => 1000);
  expect(limiter.admit("one@hub", ["codex"], "status", "one", "", "member")).toBeUndefined();
  expect(limiter.admit("two@hub", ["codex"], "status", "two", "", "member")).toBeUndefined();
  expect(limiter.admit("three@hub", ["codex"], "status", "three", "", "member")).toContain("rate limited");
  // Refusal spent no token in the new peer's independent bucket.
  expect(limiter.admit("three@hub", ["codex"], "status", "first")).toBeUndefined();
  expect(limiter.admit("three@hub", ["codex"], "status", "second")).toBeUndefined();
  expect(limiter.admit("three@hub", ["codex"], "status", "third")).toContain("rate limited");
});
