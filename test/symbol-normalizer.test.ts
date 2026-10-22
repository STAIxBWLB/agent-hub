import { test, expect } from "bun:test";
import { normalizePlanSymbol, symbolsOverlap } from "../src/hub/symbol-normalizer.ts";

test("normalizePlanSymbol strips parentheses and arguments", () => {
  expect(normalizePlanSymbol("offerReady()")).toBe("offerReady");
  expect(normalizePlanSymbol("offerReady(task: Task)")).toBe("offerReady");
  expect(normalizePlanSymbol("offerReady(a, b): void")).toBe("offerReady");
  expect(normalizePlanSymbol("Tasks.offerReady()")).toBe("Tasks.offerReady");
  expect(normalizePlanSymbol("Tasks.offerReady(task)")).toBe("Tasks.offerReady");
  expect(normalizePlanSymbol("Tasks.offerReady")).toBe("Tasks.offerReady");
  expect(normalizePlanSymbol("offerReady")).toBe("offerReady");
  expect(normalizePlanSymbol("  offerReady()  ")).toBe("offerReady");
});

test("normalizePlanSymbol preserves section and source keys", () => {
  expect(normalizePlanSymbol("section methods")).toBe("section methods");
  expect(normalizePlanSymbol("section report.md#methods")).toBe("section report.md#methods");
  expect(normalizePlanSymbol("source 10.1234/5678")).toBe("source 10.1234/5678");
  expect(normalizePlanSymbol("source https://example.com")).toBe("source https://example.com");
});

test("symbolsOverlap: Tasks.offerReady matches offerReady() (#682 phase 1b)", () => {
  expect(symbolsOverlap("Tasks.offerReady", "offerReady()")).toBe(true);
  expect(symbolsOverlap("offerReady()", "Tasks.offerReady")).toBe(true);
  expect(symbolsOverlap("Tasks.offerReady()", "offerReady")).toBe(true);
  expect(symbolsOverlap("Tasks.offerReady", "Tasks.offerReady()")).toBe(true);
  expect(symbolsOverlap("offerReady", "offerReady()")).toBe(true);
});

test("symbolsOverlap: A.run does not match B.run (#682 phase 1b)", () => {
  expect(symbolsOverlap("A.run", "B.run")).toBe(false);
  expect(symbolsOverlap("B.run", "A.run")).toBe(false);
  expect(symbolsOverlap("A.run()", "B.run()")).toBe(false);
  expect(symbolsOverlap("A.run", "A.run")).toBe(true);
  expect(symbolsOverlap("A.run", "A.run()")).toBe(true);
  expect(symbolsOverlap("A.run", "run")).toBe(true);
  expect(symbolsOverlap("run", "B.run")).toBe(true);
});

test("symbolsOverlap: multi-segment qualifiers and bare names", () => {
  expect(symbolsOverlap("A.B.run", "A.B.run")).toBe(true);
  expect(symbolsOverlap("A.B.run", "C.B.run")).toBe(false);
  expect(symbolsOverlap("A.B.run", "run")).toBe(true);
  expect(symbolsOverlap("A.B.run()", "run")).toBe(true);
});

test("symbolsOverlap: section and source keys match only exact keys", () => {
  expect(symbolsOverlap("section intro", "section intro")).toBe(true);
  expect(symbolsOverlap("section intro", "section outro")).toBe(false);
  expect(symbolsOverlap("section intro", "intro")).toBe(false);
  expect(symbolsOverlap("source data", "source data")).toBe(true);
  expect(symbolsOverlap("source data", "source logs")).toBe(false);
  expect(symbolsOverlap("source data", "data")).toBe(false);
});
