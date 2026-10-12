import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { planningPatch, actualTaskDates } from "../src/hub/planning.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planning-")), file = join(dir, "hub.db");
  const board = new Board(file), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "planning", roles: { claude: ["planner"], codex: ["implementer"] }, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { file, board, tasks };
}

test("planning validates the whole patch and persists revision dates priority and release (#263)", async () => {
  const { board, tasks, file } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  const release = await tasks.newRelease(USER, { name: "next", goal: "Finish the board", order: 0 });
  expect(task.planningRevision).toBeUndefined();
  expect(task.plannedStart).toBeUndefined();
  await expect(tasks.planBacklog("codex", { id: task.id, revision: 0, fields: { priority: 1 }, reason: "needed" })).rejects.toThrow("planner role");
  for (const fields of [{ priority: 4 }, { due: "2026-10-12" }, { actualStart: 1 }, { pinned: 1 }, { release: 999 }, { plannedStart: 200, due: 100 }]) {
    await expect(tasks.planBacklog(USER, { id: task.id, revision: 0, fields, reason: "needed" })).rejects.toThrow();
    expect(board.get(task.id)?.planningRevision).toBeUndefined();
  }
  const planned = await tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { rank: 10, priority: 1, release: release.id, plannedStart: 100, due: 200 }, reason: "Finish before ship" });
  expect(planned).toMatchObject({ planningRevision: 1, rank: 10, priority: 1, release: release.id, plannedStart: 100, due: 200 });
  const reopened = new Board(file);
  try { expect(reopened.get(task.id)).toEqual(planned); expect(reopened.release(release.id)).toEqual(release); } finally { reopened.close(); }
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { priority: 0 }, reason: "stale" })).rejects.toThrow("revision");
});

test("planner cannot override pins person order or frozen scope and undo respects later edits (#263)", async () => {
  const { tasks, board } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  await tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { rank: 1 }, reason: "person order" });
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 1, fields: { rank: 0, priority: 0 }, reason: "urgent" })).rejects.toThrow("person's");
  await tasks.planBacklog("claude", { id: task.id, revision: 1, fields: { priority: 1 }, reason: "needed" });
  await tasks.planBacklog(USER, { id: task.id, revision: 2, fields: { pinned: true }, reason: "hold" });
  await expect(tasks.undoPlanning("claude", task.id, 2)).rejects.toThrow("stale");
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 3, fields: { priority: 0 }, reason: "urgent" })).rejects.toThrow("unpinned");
  await tasks.undoPlanning(USER, task.id, 3);
  expect(board.get(task.id)?.pinned).toBeUndefined();
  const release = await tasks.newRelease(USER, { name: "frozen", goal: "Deliver", order: 0 });
  await tasks.planBacklog(USER, { id: task.id, revision: 4, fields: { release: release.id }, reason: "scope" });
  tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" });
  expect(() => tasks.changeRelease("claude", { id: release.id, revision: 1, state: "frozen" })).toThrow("person");
  tasks.changeRelease(USER, { id: release.id, revision: 1, state: "frozen" });
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 5, fields: { release: null }, reason: "next release" })).rejects.toThrow("frozen");
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 2, state: "shipped" })).toThrow("approved");
  await tasks.planBacklog(USER, { id: task.id, revision: 5, fields: { release: null }, reason: "move out" });
  const shipped = tasks.changeRelease(USER, { id: release.id, revision: 2, state: "shipped" });
  expect(shipped.activatedAt).not.toBeNull(); expect(shipped.frozenAt).not.toBeNull(); expect(shipped.shippedAt).not.toBeNull();
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 3, state: "shipped" })).toThrow("final");
});

test("actual task dates use execution review and approval evidence rather than typed plans or notes (#263)", () => {
  const history = [{ at: 1, by: USER, event: "planned", note: "started at 0" }, { at: 10, by: "codex", event: "accepted" }, { at: 11, by: "codex", event: "done (checking)" }, { at: 20, by: "codex", event: "done" }, { at: 30, by: "claude", event: "changes_requested" }, { at: 40, by: "codex", event: "accepted" }, { at: 50, by: "codex", event: "done" }, { at: 60, by: "claude", event: "approved" }];
  expect(actualTaskDates({ history, state: "approved", reviewer: "claude" })).toEqual({ startedAt: 10, reviewAt: 20, doneAt: 60 });
  expect(actualTaskDates({ history: history.slice(0, 4), state: "in_review", reviewer: "claude" }).doneAt).toBeNull();
  expect(actualTaskDates({ history: history.slice(0, 4), state: "approved", reviewer: null })).toEqual({ startedAt: 10, reviewAt: null, doneAt: 20 });
  expect(actualTaskDates({ history: [], state: "backlog", reviewer: null })).toEqual({ startedAt: null, reviewAt: null, doneAt: null });
  expect(() => planningPatch({ startedAt: 1 })).toThrow("unknown");
});


test("planning dates refuse values outside UTC Date range before persistence (#263)", async () => {
  const { board, tasks } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  await expect(tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { due: 8_640_000_000_000_001 }, reason: "bad date" })).rejects.toThrow("invalid planning field");
  expect(board.get(task.id)?.planningRevision).toBeUndefined();
  const release = await tasks.newRelease(USER, { name: "next", goal: "Deliver", order: 0 });
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 0, ship: 8_640_000_000_000_001 })).toThrow("invalid release planned dates");
  expect(board.release(release.id)?.revision).toBe(0);
});
