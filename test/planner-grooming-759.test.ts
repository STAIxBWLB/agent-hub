import { expect, test } from "bun:test";
import type { Task } from "../src/hub/board.ts";
import { plannerGrooming } from "../src/hub/task-sweep.ts";

function task(id: number, deps: number[] = [], patch: Partial<Task> = {}): Task {
  return { id, title: "phase", detail: "", class: "implement", state: "backlog", owner: null, reviewer: null,
    refs: { repo: "owner/repo", paths: ["src/shared.ts"] }, plan: {}, deps, signals: [], rejections: 0,
    history: [{ at: 1, by: "user", event: "backlogged" }], created: 1, updated: 1,
    sdlc: { stage: "intent", repo: "owner/repo", issue: 759 }, ...patch };
}
const options = { repository: "owner/repo", limits: {}, wip: {}, states: {} };
const duplicates = (rows: readonly Task[], extra = {}) => plannerGrooming(rows, { ...options, ...extra }).items
  .filter(item => item.kind === "duplicate").map(item => [item.task, ...item.related ?? []]);

test("#759 direct and transitive ordered phases suppress duplicates in either input order, retaining unrelated work and overlap", () => {
  const rows = [task(1, [2]), task(2, [3]), task(3), task(4)];
  const before = JSON.stringify(rows);
  expect(duplicates(rows)).toEqual([[1, 4], [2, 4], [3, 4]]);
  expect(duplicates([...rows].reverse())).toEqual([[1, 4], [2, 4], [3, 4]]);
  expect(plannerGrooming(rows, options).items).toContainEqual({ kind: "overlap", task: 1, related: [3] });
  expect(JSON.stringify(rows)).toBe(before);
});

test("#759 bounded dependency context can prove a path through an approved intermediate", () => {
  const rows = [task(1, [2]), task(3)];
  expect(duplicates(rows, { dependencies: new Map([[2, [3]]]) })).toEqual([]);
  expect(duplicates([task(1, [2]), task(2, [3], { state: "approved" }), task(3)])).toEqual([]);
});

test("#759 sibling prerequisites, titles, notes and supersededBy do not invent a directed follow-up path", () => {
  expect(duplicates([task(1, [3]), task(2, [3]), task(3, [], { state: "approved" })])).toEqual([[1, 2]]);
  expect(duplicates([task(1), task(2, [], { title: "follow-up to #1", detail: "after #1", history: [{ at: 1, by: "user", event: "planned", note: "follow-up #1", supersededBy: "#1" }] })])).toEqual([[1, 2]]);
});

test("#759 dependency cycles terminate and do not hide unrelated same-issue tasks", () => {
  expect(duplicates([task(1, [2]), task(2, [1]), task(3)])).toEqual([[1, 3], [2, 3]]);
});
