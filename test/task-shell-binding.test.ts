import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-task-shell-binding-")), first = join(cwd, ".worktrees", "first"), second = join(cwd, ".worktrees", "second");
  mkdirSync(first, { recursive: true }); mkdirSync(second);
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const state = { root: first as string | undefined, private: false };
  const makeTasks = () => new Tasks({ cwd, board, bus, project: "fixture", routing: () => loadRouting(cwd), notify: () => {},
    executionRoot: () => state.root, privateTurn: () => state.private });
  const make = (branch?: string, repo?: string) => {
    const task = board.propose(USER, { title: "fixture", class: "implement", refs: { ...(branch ? { branch } : {}), ...(repo ? { repo } : {}) } });
    return board.update(task.id, "worker", "accepted", { owner: "worker", state: "in_progress" });
  };
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const scope = { branch: "feature/task", defaultBranch: "main", worktree: first };
  return { cwd, first, second, state, board, tasks: makeTasks(), makeTasks, make, scope };
}

test("first task-shell request persists branch and an opaque worktree binding; restart is idempotent", () => {
  const f = fixture(), task = f.make();
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(true);
  const saved = f.board.get(task.id)!;
  expect(saved.refs.branch).toBe("feature/task");
  const history = saved.history.at(-1)!;
  expect(history).toMatchObject({ by: "hub", event: "shell branch bound" });
  expect(JSON.parse(history.note!)).toMatchObject({ branch: "feature/task", worktree: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(history.note).not.toContain(f.first);
  expect(f.makeTasks().bindShellBranch("worker", task.id, f.scope, () => true)).toBe(true);
  expect(f.board.get(task.id)!.history).toHaveLength(saved.history.length);
});

test("another open task's branch refuses; a different repository does not collide", () => {
  const f = fixture(), task = f.make(), other = f.make("feature/task");
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(false);
  expect(f.board.get(task.id)!.refs.branch).toBeUndefined();
  f.board.update(other.id, USER, "cancelled", { state: "cancelled" });
  f.make("feature/task", "example/another-repository");
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(true);
});

test("existing branch authority and persisted branch/worktree mismatches never rebind", () => {
  const f = fixture(), task = f.make("feature/task");
  expect(f.tasks.bindShellBranch("worker", task.id, { ...f.scope, branch: "feature/other" }, () => true)).toBe(false);
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(true);
  expect(f.makeTasks().bindShellBranch("worker", task.id, { ...f.scope, branch: "feature/other" }, () => true)).toBe(false);
  f.state.root = f.second;
  expect(f.makeTasks().bindShellBranch("worker", task.id, { ...f.scope, worktree: f.second }, () => true)).toBe(false);
  expect(f.board.get(task.id)!.refs.branch).toBe("feature/task");
});

test("default, unknown, private, stale and primary-checkout bindings write nothing", () => {
  const f = fixture(), task = f.make(), before = f.board.get(task.id);
  for (const branch of ["main", "master", "HEAD", "", "--force"]) expect(f.tasks.bindShellBranch("worker", task.id, { ...f.scope, branch }, () => true)).toBe(false);
  expect(f.tasks.bindShellBranch("other", task.id, f.scope, () => true)).toBe(false);
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => false)).toBe(false);
  f.state.private = true;
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(false);
  f.state.private = false; f.state.root = f.cwd;
  expect(f.tasks.bindShellBranch("worker", task.id, { ...f.scope, worktree: f.cwd }, () => true)).toBe(false);
  f.state.root = undefined;
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(false);
  expect(f.board.get(task.id)).toEqual(before);
});

test("PII or settled work cannot acquire an unattended task branch", () => {
  const f = fixture(), task = f.make();
  f.board.update(task.id, USER, "fixture private", { signals: ["pii"] });
  expect(f.tasks.bindShellBranch("worker", task.id, f.scope, () => true)).toBe(false);
  const completed = f.make(); f.board.update(completed.id, USER, "done", { state: "approved" });
  expect(f.tasks.bindShellBranch("worker", completed.id, f.scope, () => true)).toBe(false);
});
