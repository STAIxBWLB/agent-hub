import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACON_REVIEW_TYPES, generateAconReviewTypes, installedAconReviewTypes } from "../scripts/acon-review-types.ts";

test("DOM-free review bridge exactly regenerates from the installed canonical acon declarations", () => {
  const generated = installedAconReviewTypes();
  expect(readFileSync(ACON_REVIEW_TYPES, "utf8")).toBe(generated);
  expect(generated).not.toContain('reference lib="dom"');
  for (const name of ["ReviewSelector", "ReviewAnchor", "ReviewThread", "ReviewDoc", "ActionMeta"]) expect(generated).toContain("export " + (name === "ReviewSelector" || name === "ReviewDoc" ? "type " : "interface ") + name);
});

test("bridge generation refuses missing, duplicate or external type dependencies instead of creating any types", () => {
  const source = readFileSync(new URL("../node_modules/@staix/agent-console/src/contract.ts", import.meta.url), "utf8");
  expect(() => generateAconReviewTypes(source.replace("export interface ReviewAnchor", "export interface RemovedAnchor"), "0.1.0")).toThrow();
  expect(() => generateAconReviewTypes(source + "\nexport interface ReviewAnchor {}", "0.1.0")).toThrow();
  expect(() => generateAconReviewTypes(source.replace("selectors: ReviewSelector[]", "selectors: HTMLElement[]"), "0.1.0")).toThrow("external type dependency");
});
