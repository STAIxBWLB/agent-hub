import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { buildEntryDiagnostic } from "../src/hub/build-entry.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const date = "2026-11-09T00:00:00Z";
function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-entry-")), board = new Board(join(cwd, "board.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles = { codex: ["implementer"], claude: ["planner"] };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: text => notices.push(text),
    sdlc: { config: () => sdlcConfig({ mode: "enforce", required_checks: ["gate"] }), gh: async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 7, state: "OPEN", createdAt: date, updatedAt: date, lastEditedAt: null } } } }) }) } });
  bus.add({ id: "codex", state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {} });
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const task = board.propose("user", { title: "build", class: "implement" });
  board.update(task.id, "user", "assigned", { owner: "codex" });
  return { cwd, board, bus, tasks, task, notices, current: () => board.get(task.id)! };
}

test("issue identity is the first entry diagnostic and actual acceptance gate (#1328)", async () => {
  const r = rig();
  expect(buildEntryDiagnostic(r.current())).toBe("spec issue not recorded (owner/planner: hub_sdlc_record)");
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow("spec issue not recorded (owner/planner: hub_sdlc_record)");
  expect(r.current().state).toBe("proposed");
});
test("person spec acceptance is the next gate before a missing plan review (#1328)", async () => {
  const r = rig();
  r.board.update(r.task.id, "user", "lifecycle", { sdlc: { stage: "build", repo: "owner/repo", issue: 7 } });
  const text = `spec not accepted (person: ahub sdlc accept ${r.task.id} --issue 7)`;
  expect(buildEntryDiagnostic(r.current())).toBe(text);
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow(text);
});
test("a current spec reaches the existing planner-review gate with its actor and command (#1328)", async () => {
  const r = rig();
  r.tasks.acceptSpec("user", r.task.id, { repo: "owner/repo", issue: 7, edit: { lastEditedAt: null, updatedAt: date } });
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow("plan not reviewed (planner: hub_plan_review)");
});
test("proposal holds on existing plan gate without inventing peer ineligibility; explain gets the same guidance (#1328)", async () => {
  const r = rig();
  const task = await r.tasks.propose("user", { title: "unrecorded build", class: "implement", owner: "codex" });
  const expected = "spec issue not recorded (owner/planner: hub_sdlc_record)";
  expect(r.tasks.namedOwnerNote(task, "codex", "user")).toContain(expected);
  expect(r.tasks.explain(task.id)).toContain(`build entry: ${expected}`);
  expect(r.board.stalls().some(stall => stall.task === task.id)).toBe(false);
  expect(r.notices.join("\n")).not.toContain("no-eligible-peer");
  const states = { codex: "idle" as const }, policy = loadRouting(r.cwd);
  const before = assign(task, states, policy), after = assign(task, states, policy, { entryDiagnostic: expected });
  expect(after.owner).toBe(before.owner);
  expect(after.trace).toContain(`build entry: ${expected}`);
});
test("a reviewed plan still permits its existing owner offer before spec acceptance (#1328)", async () => {
  const r = rig(), task = r.task;
  r.board.update(task.id, "user", "lifecycle", { owner: null, sdlc: { stage: "build", repo: "owner/repo", issue: 7, planReview: { planner: "claude", planningRevision: 0, recordedAt: 1, issue: { repo: "owner/repo", issue: 7, state: "OPEN", editedAt: date, lastEditedAt: null } } } });
  const assigned = await r.tasks.assignTo(task.id, "codex", "user", true);
  expect(assigned.owner).toBe("codex");
  expect(r.tasks.namedOwnerNote(assigned, "codex", "user")).toContain("spec not accepted");
  await expect(r.tasks.acceptReviewed("codex", task.id)).rejects.toThrow("spec not accepted");
});
test("ordinary peer eligibility and private projections stay separate from entry guidance (#1328)", () => {
  const r = rig();
  const ordinary = r.board.propose("user", { title: "ordinary", class: "summarize" });
  expect(r.tasks.explain(ordinary.id).some(line => line.startsWith("build entry:"))).toBe(false);
  const secret = r.board.propose("user", { title: "PRIVATE-CANARY", class: "implement", signals: ["pii"] });
  expect(r.tasks.explain(secret.id).join("\n")).not.toContain("PRIVATE-CANARY");
  expect(r.tasks.explain(secret.id).some(line => line.startsWith("build entry:"))).toBe(false);
});
