import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, TASK_REASONS } from "../src/hub/board.ts";
import { ROLE_TEXT } from "../src/hub/hub-tools.ts";
import { compactRow } from "../src/hub/task-list-page.ts";
import { sdlcMetrics, type MetricTask } from "../src/hub/sdlc-metrics.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Bus } from "../src/hub/bus.ts";

// #1647: the reason a planner split work off. These tests drive the real Tasks and Board; nothing is mocked.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "reason-"));
  const board = new Board(join(dir, "hub.db"));
  const bus = new Bus({ batchMs: 0, rostered: peer => ["claude", "codex"].includes(peer) });
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "reason-test", notify: () => {} });
  return { dir, board, tasks, done: () => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const refused = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };

test("AC1: a reason is stored and shown, an unknown one is refused naming the allowed values, and none stays legal", async () => {
  const { tasks, board, done } = rig();
  try {
    const task = await tasks.propose("claude", { title: "split a", class: "implement", reason: "explore", refs: { paths: ["src/a.ts"] }, backlog: true });
    expect(board.get(task.id)?.reason).toBe("explore");
    expect(tasks.publicView(board.get(task.id)!).reason).toBe("explore");
    expect(compactRow(tasks.publicView(board.get(task.id)!)).reason).toBe("explore");
    const message = await refused(() => tasks.propose("claude", { title: "split b", class: "implement", reason: "size", backlog: true }));
    for (const reason of TASK_REASONS) expect(message).toContain(reason);
    expect(board.list().length).toBe(1);
    const plain = await tasks.propose("claude", { title: "no reason", class: "implement", backlog: true });
    expect(board.get(plain.id)?.reason).toBeUndefined();
    expect("reason" in compactRow(tasks.publicView(board.get(plain.id)!))).toBe(false);
  } finally { done(); }
});

test("AC2: parallel siblings with overlapping paths are refused before the task exists, naming both tasks and the paths", async () => {
  const { tasks, board, done } = rig();
  try {
    const first = await tasks.propose("claude", { title: "unit one", class: "implement", reason: "parallel", refs: { paths: ["src/hub/a.ts", "docs"] }, backlog: true });
    await tasks.propose("claude", { title: "unit two", class: "implement", reason: "parallel", refs: { paths: ["src/hub/b.ts"] }, backlog: true });
    const message = await refused(() => tasks.propose("claude", { title: "unit three", class: "implement", reason: "parallel", refs: { paths: ["docs/roles.md"] }, backlog: true }));
    expect(message).toContain(`#${first.id}`);
    expect(message).toContain("docs/roles.md");
    expect(board.list().length).toBe(2);
    await tasks.propose("claude", { title: "not parallel", class: "implement", reason: "explore", refs: { paths: ["docs/roles.md"] }, backlog: true });
    await tasks.propose("codex", { title: "another planner", class: "implement", reason: "parallel", refs: { paths: ["docs/roles.md"] }, backlog: true });
    expect(board.list().length).toBe(4);
  } finally { done(); }
});

test("AC3: the planner role text grows by at most 400 characters", () => {
  const before = "planner: break work into tasks with hub_task_propose (one outcome each, the right class, paths in refs, and after: [ids] for work that must wait for other tasks) instead of doing everything yourself.";
  const grown = ROLE_TEXT.planner!.length - before.length;
  expect(ROLE_TEXT.planner!.startsWith(before)).toBe(true);
  expect(grown).toBeGreaterThan(0);
  expect(grown).toBeLessThanOrEqual(400);
});

test("AC4: metrics group task count, review rounds and tokens by reason, with unset as its own group", () => {
  const done = (n: number) => Array.from({ length: n }, (_, at) => ({ at, event: "done" }));
  const tasks: MetricTask[] = [
    { id: 1, reason: "parallel", history: done(2) }, { id: 2, reason: "parallel", history: done(1) },
    { id: 3, history: done(1) }, { id: 4, reason: "explore", history: [] }, { id: 5, private: true, reason: "person", history: done(1) },
  ];
  const groups = sdlcMetrics(tasks, { tokens: { 1: 100, 2: 50, 3: null } }).byReason;
  expect(groups.parallel).toEqual({ tasks: 2, reviewRounds: 3, tokens: 150 });
  expect(groups.unset).toEqual({ tasks: 1, reviewRounds: 1, tokens: null });
  expect(groups.explore).toEqual({ tasks: 1, reviewRounds: 0, tokens: null });
  expect(groups.person).toBeUndefined();   // a private task is never grouped
});

test("AC5: a board created before the column existed loads and behaves as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "reason-old-"));
  try {
    const first = new Board(join(dir, "hub.db"));
    first.propose("user", { title: "old", class: "implement" });
    (first as any).db.run("ALTER TABLE tasks DROP COLUMN task_reason");
    first.close();
    const again = new Board(join(dir, "hub.db"));
    expect(again.get(1)?.reason).toBeUndefined();
    expect(again.propose("user", { title: "new", class: "implement", reason: "context" }).reason).toBe("context");
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
