import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function rig(mode: "off" | "advise" | "enforce" = "enforce") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-wip-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: () => {}, wipLimit: () => 1, sdlc: { config: () => sdlcConfig({ mode }) } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks };
}
test("accept refuses at planner WIP capacity before any write and names the owner, limit and open task (#481 S9)", () => {
  const { board, tasks } = rig();
  const first = board.propose("user", { title: "active", class: "implement" });
  board.update(first.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const queued = board.propose("user", { title: "queue only", class: "implement" });
  board.update(queued.id, "user", "assigned", { owner: "codex" });
  const before = JSON.stringify(board.get(queued.id));
  let failure: unknown;
  try { tasks.accept("codex", queued.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("codex");
  expect((failure as Error).message).toContain("limit 1");
  expect((failure as Error).message).toContain(`#${first.id}`);
  expect(JSON.stringify(board.get(queued.id))).toBe(before);
});

import * as boardModule from "../src/hub/board.ts";
test("untouched-return evidence is separate from historical acceptance and fails closed on work artifacts (#481 S9)", () => {
  const { board } = rig();
  const task = board.propose("user", { title: "accepted but untouched", class: "implement" });
  const accepted = board.update(task.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const evidence = (boardModule as unknown as { taskHasWorkEvidence: (task: typeof accepted) => boolean }).taskHasWorkEvidence;
  expect(typeof evidence).toBe("function");
  expect(boardModule.taskHasStarted(accepted)).toBe(true);
  expect(evidence(accepted)).toBe(false);
  for (const event of ["done", "done (checking)", "check passed", "check failed", "check interrupted", "changes_requested", "approved", "integration requested", "integrated"]) {
    expect(evidence({ ...accepted, history: [...accepted.history, { at: Date.now(), by: "codex", event }] })).toBe(true);
  }
  expect(evidence({ ...accepted, refs: { branch: "feat/work" } })).toBe(true);
  expect(evidence({ ...accepted, refs: { commit: "a".repeat(40) } })).toBe(true);
  expect(evidence({ ...accepted, sdlc: { stage: "build", localHead: "a".repeat(40) } })).toBe(true);
});

test("a planner returns accepted untouched work with a reason, retaining history and planning for the next review (#481 S9)", async () => {
  const { board, tasks } = rig();
  const row = board.propose("user", { title: "queued too early", class: "implement", backlog: true });
  board.plan(row.id, "user", { priority: 2, rank: 3 }, 0, "person queue order");
  board.update(row.id, "user", "backlog pulled", { state: "proposed" });
  const accepted = board.update(row.id, "user", "accepted", { owner: "codex", state: "in_progress", plan: { paths: ["src/example.ts"] } });
  const saved = await tasks.returnUntouchedToBacklog("claude", { id: row.id, revision: 1, reason: "finish the active task before this one" });
  expect(saved).toMatchObject({ state: "backlog", owner: null, reviewer: null, priority: 2, rank: 3, plan: accepted.plan });
  expect(saved.history.slice(0, accepted.history.length)).toEqual(accepted.history);
  expect(saved.history.at(-1)?.note).toBe("finish the active task before this one");
  const planned = await tasks.planBacklog("claude", { id: row.id, revision: 1, fields: { priority: 1 }, reason: "new queue priority" });
  expect(planned.priority).toBe(1);
  expect(boardModule.taskHasStarted(planned)).toBe(true);
});

test("a full owner cannot self-claim another task before proposal writes (#481 S9)", async () => {
  const { board, tasks } = rig();
  const first = board.propose("user", { title: "active", class: "implement" });
  board.update(first.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const before = JSON.stringify(board.list());
  await expect(tasks.propose("codex", { title: "keep a place in the queue", class: "implement", owner: "codex" })).rejects.toThrow("limit 1");
  expect(JSON.stringify(board.list())).toBe(before);
});

for (const mode of ["off", "advise", "enforce"] as const) test(`WIP governance is independent of lifecycle mode: ${mode} (#481 S9 ruling)`, () => {
  const { board, tasks } = rig(mode);
  const first = board.propose("user", { title: "active", class: "implement" });
  board.update(first.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const queued = board.propose("user", { title: "future", class: "implement" });
  board.update(queued.id, "user", "assigned", { owner: "codex" });
  const before = JSON.stringify(board.get(queued.id));
  expect(() => tasks.accept("user", queued.id)).toThrow("for codex: limit 1");
  expect(JSON.stringify(board.get(queued.id))).toBe(before);
});

test("a person cannot accept reserved work past the reserved owner's WIP limit (#481 S9)", () => {
  const { board, tasks } = rig("off");
  const first = board.propose("user", { title: "active", class: "implement" });
  board.update(first.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const queued = board.propose("user", { title: "reserved", class: "implement" });
  board.update(queued.id, "user", "reserved", { reserved: "codex" });
  const before = JSON.stringify(board.get(queued.id));
  expect(() => tasks.accept("user", queued.id)).toThrow("for codex: limit 1");
  expect(JSON.stringify(board.get(queued.id))).toBe(before);
});

test("untouched return refuses any work evidence without changing roles or history (#481 S9)", async () => {
  for (const evidence of ["done", "check failed", "integration requested", "branch", "commit"] as const) {
    const { board, tasks } = rig("off");
    const task = board.propose("user", { title: "work with evidence", class: "implement" });
    board.update(task.id, "user", "accepted", { owner: "codex", state: "in_progress" });
    board.update(task.id, "user", evidence, evidence === "branch" ? { refs: { branch: "feat/working" } } : evidence === "commit" ? { refs: { commit: "a".repeat(40) } } : {});
    const before = JSON.stringify(board.get(task.id));
    await expect(tasks.returnUntouchedToBacklog("claude", { id: task.id, revision: 0, reason: "queue it" })).rejects.toThrow("execution evidence");
    expect(JSON.stringify(board.get(task.id))).toBe(before);
  }
});

test("a former owner's accepted state cannot exempt the new owner from WIP admission (#481 S9)", () => {
  const { board, tasks } = rig("off");
  const active = board.propose("user", { title: "already active", class: "implement" });
  board.update(active.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const handed = board.propose("user", { title: "handed over", class: "implement" });
  board.update(handed.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const reassigned = board.update(handed.id, "user", "reassigned", { owner: "codex" });
  expect(() => tasks.accept("codex", handed.id)).toThrow("limit 1");
  expect(board.get(handed.id)?.history).toEqual(reassigned.history);
});

test("reassigning the same owner does not turn its existing acceptance into a new WIP slot (#481 S9)", () => {
  const { board, tasks } = rig("off");
  const active = board.propose("user", { title: "active plan", class: "implement" });
  board.update(active.id, "user", "assigned", { owner: "codex" });
  board.update(active.id, "codex", "accepted", { state: "in_progress" });
  const queued = board.propose("user", { title: "queued", class: "implement" });
  board.update(queued.id, "user", "assigned", { owner: "codex" });
  board.update(active.id, "user", "reassigned", { owner: "codex" });
  expect(tasks.accept("codex", active.id).state).toBe("in_progress");
  expect(() => tasks.accept("codex", queued.id)).toThrow("limit 1");
});
