import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, isClosedTaskState, type Task, type TaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

/** Every startup read the hub makes, and how many rows it returned (#1445). */
class CountingBoard extends Board {
  readonly reads: { call: string; rows: number }[] = [];
  list(state?: TaskState): Task[] {
    const rows = super.list(state);
    this.reads.push({ call: state ? `list(${state})` : "list", rows: rows.length });
    return rows;
  }
  listOpen(): Task[] {
    const rows = super.listOpen();
    this.reads.push({ call: "listOpen", rows: rows.length });
    return rows;
  }
}

/** The pre-#1445 derivation: the same answer computed from every row on the board. */
class FullBoard extends Board {
  listOpen(): Task[] { return this.list().filter(task => !isClosedTaskState(task.state)); }
}

const SETTLED = 1_000;
/** The open work the bounded read must still cover, one task per open state plus the recovery case. */
const OPEN_STATES: TaskState[] = ["proposed", "in_progress", "in_review", "changes_requested", "backlog"];

const proposed = (board: Board, title: string, backlog = false) => board.propose("user", {
  title, detail: "fixture detail", class: "implement", backlog,
  refs: { paths: ["src/hub/daemon.ts"] }, plan: { paths: ["test/fixture.test.ts"], symbols: ["Fixture.run"] },
});

/** A settled row of the shape a real closed task has: history, refs and a plan, nothing open about it. */
function settle(board: Board, index: number): void {
  const task = board.propose("user", {
    title: `settled fixture ${index} ${"x".repeat(60)}`, detail: "d".repeat(400), class: "implement",
    refs: { paths: ["src/hub/daemon.ts", `src/hub/settled-${index % 20}.ts`] },
    plan: { paths: [`test/settled-${index % 20}.test.ts`], symbols: [`Settled${index % 20}.run`] },
  });
  board.update(task.id, "user", "accepted", { state: "in_progress" });
  const cancelled = index % 5 === 0;
  board.update(task.id, "user", cancelled ? "cancelled" : "approved", { state: cancelled ? "cancelled" : "approved" });
}

/** 1,000 settled + 20 open tasks, with two open tasks overlapping and one owing an integration recovery. */
function seedBoard(path: string): { open: number[]; overlapping: [number, number]; integrating: number } {
  const board = new Board(path);
  try {
    for (let index = 0; index < SETTLED; index++) settle(board, index);
    const open = Array.from({ length: 20 }, (_, index) => {
      const state = OPEN_STATES[index % OPEN_STATES.length]!;
      const task = proposed(board, `open fixture ${index}`, state === "backlog");
      if (state === "proposed" || state === "backlog") return task.id;
      const owner = index % 2 === 0 ? "kimi" : "codex";
      board.update(task.id, owner, "accepted", { state: "in_progress", owner });
      if (state === "in_progress") return task.id;
      board.update(task.id, owner, "done", { state: "in_review" });
      if (state === "changes_requested") board.update(task.id, "claude", "changes_requested", { state: "changes_requested" });
      return task.id;
    });
    const overlapping: [number, number] = [open[1]!, open[6]!];
    // A task whose last hand-over mark is an integration request: the restart recovery rewrites exactly this one.
    const integrating = open[3]!;
    board.update(integrating, "kimi", "integration requested", {});
    return { open, overlapping, integrating };
  } finally { board.close(); }
}

function fixture(kind: "counting" | "full") {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-1445-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.db");
  const seeded = seedBoard(path);
  const board = kind === "counting" ? new CountingBoard(path) : new FullBoard(path);
  cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  const peer = new Peer("kimi");
  bus.add(peer);
  const notices: string[] = [];
  const routing = loadRouting(dir);
  const tasks = new Tasks({
    board, bus, cwd: dir, project: "fixture", repository: "example/hub", routing: () => routing, wipLimit: () => 16,
    intake: { sourceKnown: () => false, split: async () => undefined, partsSchema: () => ({}) },
    coordination: () => true, capable: () => true, notify: line => notices.push(line),
  });
  return { dir, board, tasks, notices, seeded, reads: board instanceof CountingBoard ? board.reads : [] };
}

/** What the startup derivation is judged on: the board as written, event names only. */
const dump = (board: Board) => board.list().map(task => ({ id: task.id, state: task.state, events: task.history.map(entry => entry.event) }));

test("the open read is exactly the board's open subset, closed rows included in neither (#1445)", () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-1445-read-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.db");
  const seeded = seedBoard(path);
  const board = new Board(path);
  cleanup.push(() => board.close());
  expect(board.list()).toHaveLength(SETTLED + 20);
  expect(board.listOpen().map(task => task.id)).toEqual(board.list().filter(task => !isClosedTaskState(task.state)).map(task => task.id));
  expect(new Set(board.listOpen().map(task => task.state))).toEqual(new Set(OPEN_STATES));
  expect(board.listOpen().map(task => task.id).sort((a, b) => a - b)).toEqual([...seeded.open].sort((a, b) => a - b));
});

test("a startup read never hydrates the settled tail, and derives the state a full read derives (#1445)", () => {
  const bounded = fixture("counting");
  const afterConstruction = bounded.reads.length;
  // The constructor is the sub-phase that scaled: warmRepository and the coordination modes read only open rows.
  const startup = bounded.reads.slice(0, afterConstruction);
  expect(startup.filter(read => read.call === "list")).toEqual([]);
  expect(startup.filter(read => read.call === "listOpen").map(read => read.rows)).toEqual([20, 20]);
  expect(startup.map(read => read.call)).toContain("list(backlog)");
  bounded.tasks.recoverIntegrations();
  // recoverIntegrations is the third startup read, and it too only sees open work.
  const recovery = bounded.reads.slice(afterConstruction);
  expect(recovery.map(read => read.call)).toEqual(["listOpen"]);
  // The same derivation from every row on the board: the bounded read loses nothing.
  const full = fixture("full");
  full.tasks.recoverIntegrations();
  expect(dump(bounded.board)).toEqual(dump(full.board));
  expect(bounded.notices).toEqual(full.notices);
  expect(bounded.notices).toHaveLength(1);
  expect(bounded.board.get(bounded.seeded.integrating)?.history.at(-1)?.event).toBe("integration unresolved");
  // And the settled tail is untouched by either derivation.
  for (const task of bounded.board.list().filter(row => isClosedTaskState(row.state))) {
    expect(task.history.at(-1)?.event).toBe(task.state === "cancelled" ? "cancelled" : "approved");
  }
});

test("the coordination and overlap derivation matches the full-board read with a settled tail present (#1445)", () => {
  const bounded = fixture("counting");
  const full = fixture("full");
  const [mine, theirs] = bounded.seeded.overlapping;
  for (const fixtureRun of [bounded, full]) {
    const task = fixtureRun.board.get(mine!)!;
    expect(fixtureRun.tasks.overlaps(task)).toContain(`#${theirs} (owner kimi)`);
  }
  expect(bounded.tasks.overlaps(bounded.board.get(mine!)!)).toBe(full.tasks.overlaps(full.board.get(mine!)!));
  expect(bounded.tasks.cohorts.list()).toEqual(full.tasks.cohorts.list());
});
