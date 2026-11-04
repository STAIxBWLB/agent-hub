import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { expandReviewCase, reviewAnchorProblems, reviewProblems, reviewThreadProblems } from "@staix/agent-console/conformance";
import type { ActionMeta, ReviewAnchor, ReviewDoc, ReviewSelector, ReviewThread } from "@staix/agent-console/contract";
import { reviewAnchorContractProblems, reviewThreadContractProblems, reviewThreadsContractProblems } from "../src/hub/review-anchor.ts";

type FixtureCase = { name: string; field?: string; value?: unknown; repeat?: { count: number; of: unknown; idPrefix: string } };
type SharedFixture = { version: number; anchors: { valid: FixtureCase[]; invalid: FixtureCase[] }; threads: { valid: FixtureCase[]; invalid: FixtureCase[]; lists: { invalid: FixtureCase[] } } };
const shared = JSON.parse(readFileSync(new URL("./fixtures/review/cases.json", import.meta.url), "utf8")) as SharedFixture;
const hubValue = (entry: FixtureCase): unknown => {
  const repeat = entry.repeat;
  return repeat ? Array.from({ length: repeat.count }, (_, index) => ({ ...expandReviewCase(repeat.of) as object, id: repeat.idPrefix + index })) : expandReviewCase(entry.value);
};

// These assignments make the compile-time dependency on the published, DOM-free contract explicit.
const contractTypes: [ReviewSelector | undefined, ReviewAnchor | undefined, ReviewThread | undefined, ReviewDoc | undefined, ActionMeta | undefined] = [undefined, undefined, undefined, undefined, undefined];

test("published acon contract exports the review shapes and its own shared conformance accepts/rejects the fixture", () => {
  expect(contractTypes).toHaveLength(5);
  expect(shared.version).toBe(1);
  for (const entry of shared.anchors.valid) {
    const value = hubValue(entry);
    expect(reviewAnchorProblems(value), entry.name).toEqual([]);
    expect(reviewAnchorContractProblems(value), entry.name).toEqual([]);
  }
  for (const entry of shared.anchors.invalid) {
    const value = hubValue(entry);
    expect(reviewAnchorProblems(value).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
    expect(reviewAnchorContractProblems(value).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
  }
  for (const entry of shared.threads.valid) {
    const value = hubValue(entry);
    expect(reviewThreadProblems(value), entry.name).toEqual([]);
    expect(reviewThreadContractProblems(value), entry.name).toEqual([]);
  }
  for (const entry of shared.threads.invalid) {
    const value = hubValue(entry);
    expect(reviewThreadProblems(value).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
    expect(reviewThreadContractProblems(value).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
  }
  for (const entry of shared.threads.lists.invalid) {
    expect(reviewProblems(hubValue(entry)).length).toBeGreaterThan(0);
    expect(reviewThreadsContractProblems(hubValue(entry)).length).toBeGreaterThan(0);
  }
  const validThreads = shared.threads.valid.map(hubValue);
  expect(reviewProblems(validThreads)).toEqual([]);
  expect(reviewThreadsContractProblems(validThreads)).toEqual([]);
});
