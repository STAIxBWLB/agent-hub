import { expect, test } from "bun:test";
import { taskProgress } from "../src/ui/task-progress.ts";
import type { PublicProgressTask } from "../src/ui/task-progress.ts";

export const progressFixture: PublicProgressTask[] = [
  { id: 1, state: "approved" }, { id: 2, state: "proposed", deps: [1] },
  { id: 3, state: "proposed", deps: [4] }, { id: 4, state: "in_progress" },
  { id: 5, state: "in_review" }, { id: 6, state: "changes_requested" }, { id: 7, state: "approved" },
];
test("public whole-board progress partitions waiting tasks, counts approval and tracks four stages", () => {
  const p = taskProgress(progressFixture);
  expect(p.total).toBe(7);
  expect(p.counts).toEqual({ proposed: 1, waiting: 1, in_progress: 1, in_review: 1, changes_requested: 1, approved: 2 });
  expect(p.stages.map(s => s.stage)).toEqual([4, 1, 1, 2, 3, 2, 4]);
  expect(p.stages[5]?.label).toBe("changes requested (back in progress)");
  expect(taskProgress([{ id: 1, state: "proposed", deps: [99] }]).counts.waiting).toBe(1);
});
test("empty progress is finite and PII stubs count without reading any task text", () => {
  const empty = taskProgress([]); expect(empty.total).toBe(0);
  expect(Object.values(empty.counts).every(n => n === 0)).toBe(true);
  const pii = { id: 1, state: "approved" as const, get title() { throw new Error("text must not be read"); } };
  expect(taskProgress([pii]).counts.approved).toBe(1);
});

test("unknown and prototype-like states remain finite and count as explicit unknown stages", () => {
  const p = taskProgress([{ id: 1, state: "future" }, { id: 2, state: "__proto__" }, { id: 3, state: "constructor" }, { id: 4, state: "approved" }]);
  expect(p.total).toBe(4); expect(p.counts.unknown).toBe(3); expect(p.counts.approved).toBe(1);
  expect(Object.values(p.counts).every(Number.isFinite)).toBe(true);
  expect(Object.values(p.counts).reduce((sum, value) => sum + value, 0)).toBe(4);
  expect(p.stages.slice(0, 3).map(stage => stage.stage)).toEqual([0, 0, 0]);
  expect(Object.hasOwn(p, "approvedFraction")).toBe(false);
});
