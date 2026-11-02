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
    task(6, { sdlc: { stage: "intent", repo: "owner/repo", issue: 11 } }),
  ];
  const opts = { ...options(), blockers: [{ task: 1, code: "tests" }], issues: new Map([
    ["owner/repo#11", { repo: "owner/repo", issue: 11, state: "OPEN", editedAt: "2026-10-18T01:00:00Z" }],
    ["owner/repo#12", { repo: "owner/repo", issue: 12, state: "CLOSED", editedAt: "2026-10-18T01:00:00Z" }],
  ]), reviewedIssues: new Map([[1, { editedAt: "2026-10-17T01:00:00Z" }]]) };
  const before = JSON.stringify(tasks), result = groom(tasks, opts);
  expect(result.items).toContainEqual({ kind: "text-dependency", task: 1, related: [3] });
  expect(result.items).toContainEqual({ kind: "overlap", task: 1, related: [2] });
  expect(result.items).not.toContainEqual({ kind: "duplicate", task: 1, related: [2] });
  expect(result.items).toContainEqual({ kind: "duplicate", task: 1, related: [6] });
  expect(result.items).toContainEqual(expect.objectContaining({ kind: "over-wip", task: 1 }));
  expect(result.items).toContainEqual({ kind: "stale", task: 1 });
  expect(result.items).toContainEqual({ kind: "superseded", task: 3, related: [2] });
  expect(result.items).toContainEqual({ kind: "closed-issue", task: 4 });
  expect(result.items).toContainEqual({ kind: "blocked", task: 1, code: "tests" });
  expect(result.items.some(item => item.task === 5 || item.related?.includes(5))).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/private fixture|sharedSymbol|same.ts|owner\/repo/i);
  expect(JSON.stringify(tasks)).toBe(before); expect(result.truncated).toBe(false);
});

for (const scenario of [
  { name: "before", offset: -1, scheduled: true },
  { name: "at the boundary", offset: 0, scheduled: false },
  { name: "after", offset: 1, scheduled: false },
] as const) test(`planner grooming marks a planned backlog card scheduled only ${scenario.name}`, () => {
  const plannedStart = 1_800_000_000_000;
  const result = groom([task(1, { plannedStart })], { ...options(), now: plannedStart + scenario.offset });
  expect(result.items).toEqual(scenario.scheduled ? [{ kind: "scheduled", task: 1 }] : []);
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

test("planner grooming reads real cancelled supersession rows without treating closed work as an overlap candidate", () => {
  const rows = [task(1, { state: "cancelled", refs: { repo: "owner/repo", paths: ["src/shared.ts"] },
    cancelled: { reason: "superseded scope", supersededBy: "#2", flowRevision: 2 },
    history: [{ at: 1, by: "user", event: "backlogged" }, { at: 2, by: "user", event: "cancelled", supersededBy: "#2" }] }),
    task(2, { refs: { repo: "OWNER/REPO", paths: ["src/shared.ts"] } }),
    task(3, { state: "cancelled", refs: { repo: "other/repo", paths: ["src/shared.ts"] }, history: [{ at: 2, by: "user", event: "cancelled", supersededBy: "#2" }] }),
    task(4, { state: "approved", refs: { paths: ["src/shared.ts"] } })];
  const before = JSON.stringify(rows), result = groom(rows);
  expect(result.items).toEqual([{ kind: "superseded", task: 1, related: [2] }]);
  expect(result.unknown).toContain(3);
  expect(JSON.stringify(rows)).toBe(before);
});

test("planner grooming detects stale spec acceptance without a plan receipt and despite a fresh plan review", () => {
  const rows = [task(1, { sdlc: { stage: "spec", repo: "owner/repo", issue: 11 } }), task(2, { sdlc: { stage: "spec", repo: "owner/repo", issue: 12 } }), task(3, { sdlc: { stage: "spec", repo: "owner/repo", issue: 13 } })];
  const current = "2026-10-18T02:00:00Z", old = "2026-10-18T01:00:00Z";
  const result = groom(rows, { ...options(), acceptedIssues: new Map([
    [1, { repo: "owner/repo", issue: 11, lastEditedAt: old }],
    [2, { repo: "OWNER/REPO", issue: 12, lastEditedAt: null }],
    [3, { repo: "owner/repo", issue: 13, lastEditedAt: null }],
  ]), issues: new Map([
    ["owner/repo#11", { repo: "owner/repo", issue: 11, state: "OPEN", editedAt: current, lastEditedAt: current }],
    ["owner/repo#12", { repo: "owner/repo", issue: 12, state: "OPEN", editedAt: current, lastEditedAt: current }],
    ["owner/repo#13", { repo: "owner/repo", issue: 13, state: "OPEN", editedAt: old, lastEditedAt: null }],
  ]), reviewedIssues: new Map([[2, { editedAt: current }]]) });
  expect(result.items.filter(item => item.kind === "stale")).toEqual([{ kind: "stale", task: 1 }, { kind: "stale", task: 2 }]);
  expect(result.unknown).not.toContain(1); expect(result.unknown).not.toContain(2); expect(result.unknown).not.toContain(3);
  const unavailable = groom([rows[0]!], { ...options(), acceptedIssues: new Map([[1, { repo: "owner/repo", issue: 11, lastEditedAt: old }]]) });
  expect(unavailable.items).not.toContainEqual({ kind: "stale", task: 1 }); expect(unavailable.unknown).toContain(1);
});

test("planner grooming keeps old metadata compatibility without inventing an acceptance body timestamp", () => {
  const rows = [task(1, { sdlc: { stage: "spec", repo: "owner/repo", issue: 11 } })];
  const result = groom(rows, { ...options(), acceptedIssues: new Map([[1, { repo: "owner/repo", issue: 11, lastEditedAt: null }]]),
    issues: new Map([["owner/repo#11", { repo: "owner/repo", issue: 11, state: "OPEN", editedAt: "2026-10-18T02:00:00Z" }]]),
    reviewedIssues: new Map([[1, { editedAt: "2026-10-18T01:00:00Z" }]]) });
  expect(result.items).toContainEqual({ kind: "stale", task: 1 }); expect(result.unknown).toContain(1);
});

test("planner grooming reports reserved peer runtime blockers and directory or repository-root overlap", () => {
  const rows = [task(1, { reserved: "worker", refs: { paths: ["src"] } }), task(2, { refs: { paths: ["src/a.ts"] } }),
    task(3, { refs: { paths: ["src-other/a.ts"] } }), task(4, { refs: { paths: ["."] } }),
    task(5, { refs: { repo: "other/repo", paths: ["."] } })];
  const result = groom(rows, { ...options(), states: { worker: "offline" } });
  expect(result.items).toContainEqual({ kind: "blocked", task: 1, code: "offline" });
  expect(result.items).toContainEqual({ kind: "overlap", task: 1, related: [2] });
  expect(result.items).not.toContainEqual({ kind: "overlap", task: 1, related: [3] });
  for (const id of [1, 2, 3]) expect(result.items).toContainEqual({ kind: "overlap", task: id, related: [4] });
  expect(result.items.some(item => item.task === 5 || item.related?.includes(5))).toBe(false);
});

test("planner grooming detects normalized symbol overlap (#682 phase 1b)", () => {
  const rows = [
    task(1, { refs: { repo: "owner/repo", paths: ["src/a.ts"] }, plan: { symbols: ["Tasks.offerReady"] } }),
    task(2, { refs: { repo: "owner/repo", paths: ["src/b.ts"] }, plan: { symbols: ["offerReady()"] } }),
    task(3, { refs: { repo: "owner/repo", paths: ["src/c.ts"] }, plan: { symbols: ["A.run"] } }),
    task(4, { refs: { repo: "owner/repo", paths: ["src/d.ts"] }, plan: { symbols: ["B.run"] } }),
  ];
  const result = groom(rows);
  // task 1 and 2 overlap on Tasks.offerReady vs offerReady():
  expect(result.items).toContainEqual({ kind: "overlap", task: 1, related: [2] });
  // task 3 and 4 do NOT overlap on A.run vs B.run:
  expect(result.items.some(item => item.task === 3 && item.related?.includes(4))).toBe(false);
});
