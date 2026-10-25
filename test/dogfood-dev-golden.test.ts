import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dogfoodScorecard, formatDogfood, type DogfoodInput } from "../src/hub/dogfood.ts";

// Captured from unmodified main 170199d6 before the #799 implementation.
test("dev dogfood JSON and readable output retain their pre-profile bytes", () => {
  const fixture = (name: string) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
  const report = dogfoodScorecard(JSON.parse(fixture("dogfood-dev-input.json")) as DogfoodInput);
  expect(JSON.stringify(report, null, 2) + "\n").toBe(fixture("dogfood-dev-scorecard.json"));
  expect(formatDogfood(report).join("\n") + "\n").toBe(fixture("dogfood-dev-scorecard.txt"));
});
