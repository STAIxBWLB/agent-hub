import { expect, test } from "bun:test";
import type { Task } from "../src/hub/board.ts";
import * as sweep from "../src/hub/task-sweep.ts";

function task(id: number, patch: Partial<Task> = {}): Task {
  return { id, title: "private fixture title", detail: "", class: "implement", state: "backlog", owner: null, reviewer: null,
    refs: {}, plan: {}, signals: [], rejections: 0, history: [{ at: 1, by: "user", event: "backlogged" }], created: 1, updated: 1, ...patch };
}
const options = () => ({ repository: "Owner/Repo", limits: { worker: 1 }, wip: { worker: 2 }, states: { worker: "idle" } });
function groom(tasks: readonly Task[], opts: Record<string, unknown> = options()): { items: { kind: string; task: number; related?: number[]; code?: string; personCommand?: string }[]; unknown: number[]; truncated: boolean } {
  const fn = (sweep as Record<string, unknown>).plannerGrooming;
  expect(typeof fn).toBe("function");
  return (fn as Function)(tasks, opts);
}

test("planner grooming derives all candidate kinds without leaking task text or mutating input", () => {
  const tasks = [
    task(1, { detail: "after #2\nwaits for #3", deps: [2], refs: { repo: "owner/repo", paths: ["src/./same.ts"] }, plan: { symbols: ["sharedSymbol"] }, owner: "worker", state: "in_progress", external: { provider: "github", repo: "OWNER/REPO", issue: 11, url: "https://github.com/OWNER/REPO/issues/11" } }),
    task(2, { refs: { paths: ["src/same.ts"] }, plan: { symbols: ["sharedSymbol"] }, owner: "worker", state: "proposed", sdlc: { stage: "intent", repo: "owner/repo", issue: 11 } }),
    task(3, { history: [{ at: 2, by: "user", event: "superseded", supersededBy: "#2" }] }),
    task(4, { external: { provider: "github", repo: "owner/repo", issue: 12, url: "https://github.com/owner/repo/issues/12" } }),
    task(5, { state: "approved", refs: { paths: ["src/same.ts"] } }),
  ];
  const opts = { ...options(), blockers: [{ task: 1, code: "tests" }], issues: new Map([
    ["owner/repo#11", { repo: "owner/repo", issue: 11, state: "OPEN", editedAt: "2026-10-18T01:00:00Z" }],
    ["owner/repo#12", { repo: "owner/repo", issue: 12, state: "CLOSED", editedAt: "2026-10-18T01:00:00Z" }],
  ]), reviewedIssues: new Map([[1, { editedAt: "2026-10-17T01:00:00Z" }]]) };
  const before = JSON.stringify(tasks), result = groom(tasks, opts);
  expect(result.items).toContainEqual({ kind: "text-dependency", task: 1, related: [3] });
  expect(result.items).toContainEqual({ kind: "overlap", task: 1, related: [2] });
  expect(result.items).toContainEqual({ kind: "duplicate", task: 1, related: [2] });
  expect(result.items).toContainEqual(expect.objectContaining({ kind: "over-wip", task: 1 }));
  expect(result.items).toContainEqual({ kind: "stale", task: 1 });
  expect(result.items).toContainEqual({ kind: "superseded", task: 3, related: [2] });
  expect(result.items).toContainEqual({ kind: "closed-issue", task: 4 });
  expect(result.items).toContainEqual({ kind: "blocked", task: 1, code: "tests" });
  expect(result.items.some(item => item.task === 5 || item.related?.includes(5))).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/private fixture|sharedSymbol|same.ts|owner\/repo/i);
  expect(JSON.stringify(tasks)).toBe(before); expect(result.truncated).toBe(false);
});

test("planner grooming separates repository counterparts and preserves contradictory and unavailable evidence as unknown", () => {
  const tasks = [task(1, { title: "#11", refs: { paths: ["src/a.ts"] } }),
    task(2, { title: "#11", refs: { repo: "other/repo", paths: ["src/a.ts"] } }),
    task(3, { refs: { repo: "owner/repo", paths: ["src/a.ts"] }, sdlc: { stage: "intent", repo: "other/repo", issue: 11 } }),
    task(4, { title: "#12", refs: { paths: ["src/a.ts"] } }),
    task(5, { refs: { repo: "malformed" } })];
  const result = groom(tasks);
  expect(result.items).not.toContainEqual(expect.objectContaining({ kind: "duplicate" }));
  expect(result.items).toContainEqual({ kind: "overlap", task: 1, related: [4] });
  expect(result.items.some(item => [2, 3, 5].includes(item.task) || item.related?.some(id => [2, 3, 5].includes(id)))).toBe(false);
  expect(result.unknown).toEqual([1, 2, 3, 4, 5]);
});

test("planner grooming recognizes anchored dependency prose only and emits closed blocker codes", () => {
  const result = groom([task(1, { detail: "Example: after #2\nnot waits for #3\nAfter #4\nwaits for #5", owner: "offline-worker", state: "proposed" }), task(4), task(5)], {
    ...options(), states: { "offline-worker": "offline" }, blockers: [{ task: 1, code: "secret unsafe free text" }, { task: 4, code: "paused" }],
  });
  expect(result.items).toContainEqual({ kind: "text-dependency", task: 1, related: [4, 5] });
  expect(result.items).toContainEqual({ kind: "blocked", task: 1, code: "offline" });
  expect(result.items).toContainEqual({ kind: "blocked", task: 4, code: "paused" });
  expect(JSON.stringify(result)).not.toContain("secret unsafe");
  expect(result.unknown).toContain(1);
});

test("planner grooming bounds task and item coverage explicitly", () => {
  const tasks = Array.from({ length: 501 }, (_, index) => task(index + 1, { refs: { paths: ["shared.ts"] } }));
  const result = groom(tasks);
  expect(result.items.length).toBeLessThanOrEqual(256); expect(result.truncated).toBe(true);
  const empty = groom([]); expect(empty).toEqual({ items: [], unknown: [], truncated: false });
});

test("planner grooming compares qualified foreign pairs only within their own repository and reads their metadata", () => {
  const tasks = [task(1, { sdlc: { stage: "intent", repo: "owner/repo", issue: 11 }, refs: { paths: ["src/a.ts"] } }),
    task(2, { external: { provider: "github", repo: "Other/Repo", issue: 11, url: "https://github.com/Other/Repo/issues/11" }, refs: { paths: ["src/a.ts"] } }),
    task(3, { sdlc: { stage: "intent", repo: "other/repo", issue: 11 }, refs: { paths: ["src/./a.ts"] } }),
    task(4, { refs: { paths: ["/outside/project/src/a.ts"] } })];
  const result = groom(tasks, { ...options(), issues: new Map([
    ["owner/repo#11", { repo: "owner/repo", issue: 11, state: "OPEN", editedAt: "2026-10-18T01:00:00Z" }],
    ["other/repo#11", { repo: "other/repo", issue: 11, state: "CLOSED", editedAt: "2026-10-18T01:00:00Z" }],
  ]), reviewedIssues: new Map([[2, { editedAt: "2026-10-17T01:00:00Z" }], [3, { editedAt: "2026-10-18T01:00:00Z" }]]) });
  expect(result.items.filter(item => item.kind === "duplicate" || item.kind === "overlap")).toEqual([
    { kind: "overlap", task: 2, related: [3] }, { kind: "duplicate", task: 2, related: [3] },
  ]);
  expect(result.items).toContainEqual({ kind: "closed-issue", task: 2 });
  expect(result.items).toContainEqual({ kind: "closed-issue", task: 3 });
  expect(result.items).toContainEqual({ kind: "stale", task: 2 });
  expect(result.items).not.toContainEqual({ kind: "stale", task: 3 });
  expect(result.unknown).toContain(4);
  expect(result.items.some(item => item.task === 4 || item.related?.includes(4))).toBe(false);
});
