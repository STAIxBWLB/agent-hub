import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyInputProblem } from "../src/hub/advisor-survey.ts";
import { Board } from "../src/hub/board.ts";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-readback-")), board = new Board(join(root, "hub.db"));
  const close = () => { board.close(); rmSync(root, { recursive: true, force: true }); };
  const proposed = board.propose("user", { title: "Spec read-back", class: "implement" });
  const task = board.update(proposed.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const request = { task: task.id, taskCreated: task.created, repo: "STAIxBWLB/agent-hub", issue: 1658, lastEditedAt: "2026-11-23T00:36:36Z",
    updatedAt: "2026-11-23T00:36:36Z", reader: "kimi", by: "user", at: 5 };
  return { board, close, task, request };
}

test("keeps one request per task, issue and body edit time and reports the newest one", () => {
  const f = fixture();
  try {
    const id = f.board.readbackCreate(f.request);
    expect(f.board.readbackCreate(f.request)).toBe(id);
    expect(f.board.readbackOfTask(f.task.id, f.task.created, 1658, f.request.lastEditedAt)?.id).toBe(id);
    const edited = f.board.readbackCreate({ ...f.request, lastEditedAt: "2026-11-24T09:00:00Z", updatedAt: "2026-11-24T09:00:00Z" });
    expect(edited).not.toBe(id);
    expect(f.board.readbackLatest(f.task.id, f.task.created)?.id).toBe(edited);
    expect(f.board.readbackOfTask(f.task.id, f.task.created, 1658, f.request.lastEditedAt)?.id).toBe(id);
  } finally { f.close(); }
});

test("stores the report once and refuses a changed report or a path outside the repository", () => {
  const f = fixture();
  try {
    const id = f.board.readbackCreate(f.request), sent = { ...report, task: f.task.id };
    expect(f.board.readbackReport(id, sent, ["src/hub/tasks.ts"]).report).toEqual(sent);
    expect(f.board.readback(id)?.report).toEqual(sent);
    expect(f.board.readback(id)?.missingRefs).toEqual(["src/hub/tasks.ts"]);
    expect(f.board.readbackReport(id, sent, ["src/hub/tasks.ts"]).report).toEqual(sent);
    expect(() => f.board.readbackReport(id, { ...sent, proposes: "Something else." }, [])).toThrow();
    expect(() => f.board.readbackReport(id, sent, ["../elsewhere"])).toThrow();
    expect(f.board.readback(id)?.report).toEqual(sent);
  } finally { f.close(); }
});

