import { expect, test } from "bun:test";
import { Tasks } from "../src/hub/tasks.ts";
import { Bus } from "../src/hub/bus.ts";
import type { Board, Task } from "../src/hub/board.ts";
import type { Routing } from "../src/hub/routing.ts";

function fixture() {
  const task: Task = { id: 71, title: "public fixture", detail: "", class: "implement", owner: "builder", rejections: 0, created: 1, updated: 1, state: "in_review", reviewer: "kimi-review", signals: [], refs: { commit: "fixture-branch" },
    history: ["proposed", "assigned", "accepted", "done"].map(event => ({ event, by: "builder", at: 1 })) };
  // A read-only board view. Changes below simulate fresh snapshots, not a task mutation API.
  const board = { list: () => [], get: (id: number) => id === task.id ? task : undefined } as unknown as Board;
  const routing = { constraints: { pii: "local_only" } } as Routing;
  const tasks = new Tasks({ board, bus: new Bus({ batchMs: 0 }), routing: () => routing, cwd: "/unused-fixture", project: "fixture", notify: () => {} });
  return { task, tasks };
}

test("review binding tolerates bookkeeping but fences a replacement request and free-text head", () => {
  const { task, tasks } = fixture(), binding = { head: "fixture-branch", flowRevision: 4 };
  expect(tasks.reviewBindingCurrent("kimi-review", 71, binding)).toBe(true);
  task.history.push({ event: "idle sweep", by: "hub", at: 2 });
  expect(tasks.reviewBindingCurrent("kimi-review", 71, binding)).toBe(true);
  expect(tasks.reviewBindingCurrent("kimi-review", 71, { ...binding, head: "other-branch" })).toBe(false);
  task.history.push({ event: "reviewer changed", by: "hub", at: 3 });
  expect(tasks.reviewBindingCurrent("kimi-review", 71, binding)).toBe(false);
});

test("review binding refuses privacy, role, state and missing-task drift", () => {
  const { task, tasks } = fixture(), binding = { head: "fixture-branch", flowRevision: 4 };
  expect(tasks.reviewBindingCurrent("other-reviewer", 71, binding)).toBe(false);
  expect(tasks.reviewBindingCurrent("kimi-review", 72, binding)).toBe(false);
  task.signals = ["pii_path"];
  expect(tasks.reviewBindingCurrent("kimi-review", 71, binding)).toBe(false);
  task.signals = []; task.state = "approved";
  expect(tasks.reviewBindingCurrent("kimi-review", 71, binding)).toBe(false);
});
