import { expect, test } from "bun:test";
import { surveyInputProblem } from "../src/hub/advisor-survey.ts";
import { parseSpecReadbackReport } from "../src/hub/spec-readback.ts";

const report = { task: 42, proposes: "Publish the summary.", existing: "A reviewer reads the spec." };

test("accepts a bounded paraphrase or an explicit section the reader could not paraphrase", () => {
  const input = { ...report, proposes: "é".repeat(512), refs: ["src/hub/tasks.ts"] };
  expect(parseSpecReadbackReport(input)).toEqual(input);
  expect(parseSpecReadbackReport({ task: 42, cannot_paraphrase: "Storage" })).toEqual({ task: 42, cannot_paraphrase: "Storage" });
});

test("reports the field and limit without truncating excessive input", () => {
  const excessive = [
    [{ ...report, proposes: "é".repeat(513) }, "proposes", "1024"],
    [{ ...report, undefined: Array(17).fill({ term: "receipt", where: "Storage" }) }, "undefined", "16"],
    [{ ...report, open_decisions: Array(17).fill({ decision: "Who writes?", where: "Design" }) }, "open_decisions", "16"],
    [{ ...report, refs: Array(65).fill("src/hub/tasks.ts") }, "refs", "64"],
  ] as const;
  for (const [input, field, limit] of excessive) {
    expect(() => parseSpecReadbackReport(input)).toThrow();
    try {
      parseSpecReadbackReport(input);
    } catch (error) {
      const problem = surveyInputProblem(error);
      expect(problem?.field).toBe(field);
      expect(problem?.rule).toContain(limit);
    }
  }
});

test("rejects verdicts, mixed report forms and paths outside the repository", () => {
  expect(() => parseSpecReadbackReport({ ...report, verdict: "approved" })).toThrow();
  expect(() => parseSpecReadbackReport({ ...report, cannot_paraphrase: "Storage" })).toThrow();
  expect(() => parseSpecReadbackReport({ ...report, refs: ["../elsewhere"] })).toThrow();
});
