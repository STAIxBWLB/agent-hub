import { Database } from "bun:sqlite";
import type { PeerId } from "./envelope.ts";

export const CLASSES = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] as const;
export type TaskClass = (typeof CLASSES)[number];
export type TaskState = "proposed" | "in_progress" | "in_review" | "approved" | "changes_requested";

export interface TaskRefs {
  repo?: string;
  branch?: string;
  commit?: string;
  paths?: string[];
}
/** What an owner says it will change, before it starts (issue #31). Each list holds short free-text items. */
export const PLAN_KEYS = ["paths", "symbols", "signatures", "insertion_points"] as const;
export type TaskPlan = Partial<Record<(typeof PLAN_KEYS)[number], string[]>>;

export interface HistoryEntry {
  at: number;
  by: PeerId;
  event: string; // proposed | assigned | accepted | declined | done | approved | changes_requested | escalated | reassigned
  note?: string;
}
export interface Task {
  id: number;
  title: string;
  detail: string;
  class: TaskClass;
  owner: PeerId | null;
  reviewer: PeerId | null;
  state: TaskState;
  refs: TaskRefs;
  /** Absent only on tasks built outside the board (tests); the board always returns one, `{}` when none was given. */
  plan?: TaskPlan;
  /** Tasks that must be approved before this one is offered (issue #34); fixed when it is proposed. */
  deps?: number[];
  signals: string[];
  /** consecutive changes_requested verdicts */
  rejections: number;
  history: HistoryEntry[];
  created: number;
  updated: number;
}

/** The moves the state machine allows. `accept` and `done` are transitions, not states: they carried no behaviour of their own. */
const MOVES: Record<TaskState, TaskState[]> = {
  proposed: ["in_progress"],
  in_progress: ["in_review", "approved", "proposed"], // approved: class without a reviewer; proposed: owner declined or was taken off
  in_review: ["approved", "changes_requested"],
  changes_requested: ["in_progress"],
  approved: [],
};

const JSON_COLS = ["refs", "plan", "deps", "signals", "history"] as const;

/** Task board in `.agenthub/state/hub.db`. It outlives the hub process: `ahub kill` leaves the file. */
export class Board {
  private readonly db: Database;
  /** Every recorded change, as it lands (telemetry, issue #40). */
  onChange?: (task: Task, entry: HistoryEntry) => void;
  private changed(task: Task, entry: HistoryEntry): void {
    try { this.onChange?.(task, entry); } catch { /* never throw after a board write */ }
  }

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', class TEXT NOT NULL,
      owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]',
      rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    // Boards from before issues #31 and #34 lack these columns; existing rows get the defaults.
    const have = new Set((this.db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, empty] of [["plan", "{}"], ["deps", "[]"]] as const) {
      if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${empty}'`);
    }
  }

  propose(by: PeerId, t: { title: string; detail?: string; class: TaskClass; refs?: TaskRefs; plan?: TaskPlan; deps?: number[]; signals?: string[] }): Task {
    const now = Date.now();
    const history: HistoryEntry[] = [{ at: now, by, event: "proposed" }];
    const { lastInsertRowid } = this.db
      .query("INSERT INTO tasks (title, detail, class, state, refs, plan, deps, signals, history, created, updated) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)")
      .run(t.title, t.detail ?? "", t.class, JSON.stringify(t.refs ?? {}), JSON.stringify(t.plan ?? {}), JSON.stringify(t.deps ?? []), JSON.stringify(t.signals ?? []), JSON.stringify(history), now, now);
    const task = this.get(Number(lastInsertRowid))!;
    this.changed(task, history[0]!);
    return task;
  }

  get(id: number): Task | undefined {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? parse(row) : undefined;
  }

  list(state?: TaskState): Task[] {
    const rows = state ? this.db.query("SELECT * FROM tasks WHERE state = ? ORDER BY id").all(state) : this.db.query("SELECT * FROM tasks ORDER BY id").all();
    return (rows as Record<string, unknown>[]).map(parse);
  }

  /** Tasks per state, without parsing a single row: `status.json` is rewritten on every bus event and the board only grows. */
  counts(): Record<string, number> {
    const rows = this.db.query("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** The only way a task changes. Validates the move, records who did what, returns the new row. */
  /** A `plan` in the patch replaces the old one whole: a new plan is the owner's current intent, not an addition. */
  update(id: number, by: PeerId, event: string, patch: Partial<Pick<Task, "state" | "owner" | "reviewer" | "refs" | "plan" | "rejections">>, note?: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`no task #${id}`);
    if (patch.state && patch.state !== task.state && !MOVES[task.state].includes(patch.state)) {
      throw new Error(`task #${id} is ${task.state}: cannot move to ${patch.state}`);
    }
    const next = { ...task, ...patch, refs: { ...task.refs, ...patch.refs } };
    const history = [...task.history, { at: Date.now(), by, event, ...(note ? { note } : {}) }];
    this.db
      .query("UPDATE tasks SET state = ?, owner = ?, reviewer = ?, refs = ?, plan = ?, rejections = ?, history = ?, updated = ? WHERE id = ?")
      .run(next.state, next.owner, next.reviewer, JSON.stringify(next.refs), JSON.stringify(next.plan ?? {}), next.rejections, JSON.stringify(history), Date.now(), id);
    const updated = this.get(id)!;
    this.changed(updated, history.at(-1)!);
    return updated;
  }

  close(): void {
    this.db.close();
  }
}

function parse(row: Record<string, unknown>): Task {
  const out = { ...row } as Record<string, unknown>;
  for (const col of JSON_COLS) out[col] = JSON.parse(String(row[col]));
  return out as unknown as Task;
}
