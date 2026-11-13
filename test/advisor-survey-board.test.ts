import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type SurveyApplyInput } from "../src/hub/board.ts";
import { parseSurveyFindings } from "../src/hub/advisor-survey.ts";
import type { ConsideredEntry } from "../src/hub/considered-findings.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const finding = parseSurveyFindings([{ id: "bounded-parser-finding", evidence: "src/parser.ts:12", paths: ["src/parser.ts"], impact: "Invalid data passes", effort: "S", risk: "Small behavior change", confidence: "high", fix_sketch: "Validate inputs" }])[0]!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-survey-board-")), file = join(root, "hub.db"), board = new Board(file);
  clean.push(() => { board.close(); rmSync(root, { recursive: true, force: true }); });
  const proposed = board.propose("user", { title: "Read-only survey", class: "plan" });
  const task = board.update(proposed.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const create = { task: task.id, taskCreated: task.created, repo: "internal-repo-identity", ref: "a".repeat(40), by: "user", at: 1 };
  const id = board.surveyCreate(create);
  const fence = () => ({ boardRevision: board.statusRevision(), taskCreated: task.created, taskFlowRevision: board.get(task.id)!.history.length, owner: "claude" });
  const apply = (change: Partial<SurveyApplyInput> = {}) => board.surveyApply(id, { findings: [], decisions: [], by: "claude", at: 2, ...change }, fence());
  const card = { id: finding.id, key: "Survey finding key: " + "b".repeat(64), title: "Investigate bounded parser", detail: "Survey finding key: " + "b".repeat(64) + "\nPrepared public plan", class: "plan" as const };
  const rejected: ConsideredEntry = { repo: create.repo, id: finding.id, pass: finding.pass, paths: finding.paths, reason: "Already handled", ref: create.ref, source: { task: task.id, created: task.created, kind: "survey" } };
  return { board, file, task, create, id, fence, apply, card, rejected };
}

test("survey private candidates never create a card before explicit vetting; exact replay has no write", () => {
  const f = fixture(), before = f.board.list().length;
  expect(f.board.surveyOfTask(f.task.id, f.task.created)?.id).toBe(f.id);
  expect(f.board.surveyCreate(f.create)).toBe(f.id);
  const first = f.apply({ findings: [finding] });
  expect(first.createdIDs).toEqual([]); expect(f.board.list()).toHaveLength(before);
  expect(f.board.surveyFindings(f.id)).toEqual([{ finding, foundBy: "claude", foundAt: 2 }]);
  const revision = f.board.statusRevision();
  expect(f.apply({ findings: [finding] }).already).toBe(true);
  expect(f.board.statusRevision()).toBe(revision);
  expect(() => f.apply({ cards: [f.card] })).toThrow();
  expect(f.board.list()).toHaveLength(before);
});

test("vetted prepared cards dedupe atomically by exact first marker and remain backlog drafts", () => {
  const f = fixture(), changes: number[] = []; f.board.onChange = task => { changes.push(task.id); };
  const change = { findings: [finding], decisions: [{ id: finding.id, verdict: "vetted" as const }], cards: [{ ...f.card, refs: { paths: finding.paths }, signals: ["survey-candidate"] }] };
  const captured = f.fence(), call = { ...change, by: "claude", at: 2 };
  const first = f.board.surveyApply(f.id, call, captured), child = f.board.get(first.createdIDs[0]!)!;
  expect(() => f.board.surveyApply(f.id, call, captured)).toThrow(); // Competing same-generation report loses atomically.
  expect(child.state).toBe("backlog"); expect(child.class).toBe("plan"); expect(child.history[0]?.by).toBe("hub");
  expect(child.detail?.split("\n")[0]).toBe(f.card.key);
  expect(child.refs.paths).toEqual(finding.paths); expect(child.signals).toContain("survey-candidate");
  expect(JSON.stringify(child)).not.toContain(f.create.repo);
  expect(changes).toEqual(first.createdIDs);
  const repeated = f.apply(change);
  expect(repeated.createdIDs).toEqual([]); expect(repeated.dedupedIDs).toEqual(first.createdIDs); expect(repeated.already).toBe(true);
  expect(f.board.surveyFindings(f.id)[0]?.decision?.verdict).toBe("vetted");
  expect(f.board.list().filter(task => task.detail?.split("\n")[0] === f.card.key)).toHaveLength(1);
});

test("changed candidates and stale authority roll back all survey, card and ledger effects", () => {
  const f = fixture(); f.apply({ findings: [finding] });
  const revision = f.board.statusRevision(), rows = f.board.list().length;
  expect(() => f.apply({ findings: [{ ...finding, risk: "Changed immutable report" }], decisions: [{ id: finding.id, verdict: "vetted" }], cards: [f.card] })).toThrow();
  expect(f.board.statusRevision()).toBe(revision); expect(f.board.list()).toHaveLength(rows);
  const base = f.fence(), change = { findings: [], decisions: [], by: "claude", at: 3 };
  for (const patch of [{ boardRevision: base.boardRevision - 1 }, { taskCreated: base.taskCreated + 1 }, { taskFlowRevision: base.taskFlowRevision + 1 }, { owner: "codex" }])
    expect(() => f.board.surveyApply(f.id, change, { ...base, ...patch })).toThrow();
  expect(() => f.apply({ decisions: [{ id: finding.id, verdict: "rejected", reason: f.rejected.reason }], rejections: [f.rejected], cards: [f.card] })).toThrow();
  expect(f.board.rejectedFindings(f.create.repo).rows).toEqual([]);
  expect(f.board.statusRevision()).toBe(revision);
  f.board.update(f.task.id, "user", "closed", { state: "approved" });
  expect(() => f.apply()).toThrow();
});

test("a vetted low-confidence finding creates only the prepared triage class", () => {
  const f = fixture(), low = { ...finding, confidence: "low" as const };
  expect(() => f.apply({ findings: [low], decisions: [{ id: low.id, verdict: "vetted" }], cards: [f.card] })).toThrow();
  expect(f.board.surveyFindings(f.id)).toEqual([]);
  const created = f.apply({ findings: [low], decisions: [{ id: low.id, verdict: "vetted" }], cards: [{ ...f.card, class: "triage" }] });
  expect(f.board.get(created.createdIDs[0]!)?.class).toBe("triage");
});

test("rejection and reasoned reconsideration append history without replacing historical rejection", () => {
  const f = fixture();
  f.apply({ findings: [finding], decisions: [{ id: finding.id, verdict: "rejected", reason: f.rejected.reason }], rejections: [f.rejected] });
  const rejected = f.board.rejectedFindings(f.create.repo).rows[0]!;
  expect(f.board.recordRejectedFinding(f.rejected)).toBe(rejected.id);
  expect(() => f.apply({ decisions: [{ id: finding.id, verdict: "vetted" }], cards: [f.card] })).toThrow();
  const reconsidered = { ...f.rejected, reason: "New evidence justifies explicit reconsideration" };
  const applied = f.apply({ decisions: [{ id: finding.id, verdict: "vetted", reason: reconsidered.reason }], reconsiderations: [reconsidered], cards: [f.card] });
  expect(applied.createdIDs).toHaveLength(1);
  const ledger = f.board.rejectedFindings(f.create.repo);
  expect(ledger.complete).toBe(true); expect(ledger.rows).toHaveLength(1);
  expect(ledger.rows[0]?.entry).toEqual(f.rejected); expect(ledger.rows[0]?.reconsideredBy).toHaveLength(1);
  expect(f.board.recordReconsideredFinding(reconsidered, [rejected.id])).toBe(ledger.rows[0]!.reconsideredBy[0]!);
  expect(f.board.surveyFindings(f.id)[0]?.decision?.reason).toBe(reconsidered.reason);
  f.board.recordRejectedFinding({ ...f.rejected, withheld: true });
  expect(f.board.rejectedFindings(f.create.repo).rows[0]?.entry.withheld).toBe(true);
  f.board.recordRejectedFinding(f.rejected);
  expect(f.board.rejectedFindings(f.create.repo).rows[0]?.entry.withheld).toBe(true);
});

test("bounded considered read is explicitly incomplete, never an empty successful history", () => {
  const f = fixture(); f.board.recordRejectedFinding(f.rejected);
  f.board.recordRejectedFinding({ ...f.rejected, id: "second-parser-finding" });
  expect(f.board.rejectedFindings(f.create.repo, 1)).toEqual({ rows: [], complete: false });
  expect(f.board.rejectedFindings("another-repo", 1)).toEqual({ rows: [], complete: true });
  expect(() => f.board.rejectedFindings(f.create.repo, 1001)).toThrow();
});

test("corrupt survey and considered bytes produce fixed errors without echoing stored text", () => {
  for (const table of ["advisor_surveys", "advisor_survey_findings", "considered_findings"] as const) {
    const f = fixture(); f.apply({ findings: [finding] }); f.board.recordRejectedFinding(f.rejected);
    const db = new Database(f.file), secret = "PRIVATE_CORRUPTION_CANARY";
    db.query(`UPDATE ${table} SET body=?`).run(secret); db.close();
    const read = () => table === "advisor_surveys" ? f.board.survey(f.id) : table === "advisor_survey_findings" ? f.board.surveyFindings(f.id) : f.board.rejectedFindings(f.create.repo);
    expect(read).toThrow("survey storage invalid");
    try { read(); } catch (error) { expect(String(error)).not.toContain(secret); }
  }
});
