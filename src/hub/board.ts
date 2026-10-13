import { Database } from "bun:sqlite";
import { planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import type { PeerId } from "./envelope.ts";
import type { SweepRecord } from "./task-sweep.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import type { SdlcReceipt } from "./sdlc.ts";

export const CLASSES = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] as const;
export type TaskClass = (typeof CLASSES)[number];
export type TaskState = "backlog" | "proposed" | "in_progress" | "in_review" | "approved" | "changes_requested";

export interface TaskRefs {
  repo?: string;
  branch?: string;
  commit?: string;
  paths?: string[];
}
/** What an owner says it will change, before it starts (issue #31). Each list holds short free-text items. */
export const PLAN_KEYS = ["paths", "symbols", "signatures", "insertion_points"] as const;
export const DOCUMENT_PLAN_KEYS = ["paths", "sections", "sources", "claims"] as const;
export const ALL_PLAN_KEYS = [...PLAN_KEYS, "sections", "sources", "claims"] as const;
export type TaskPlan = Partial<Record<(typeof ALL_PLAN_KEYS)[number], string[]>>;
/** Task outcomes older than this are pruned: demotion (issue #36) reads one week, seven half-lives. */
export const OUTCOMES_KEPT_MS = 7 * 24 * 3_600_000;

export const TASK_MOVE_REASONS = ["manual", "budget", "offline", "idle", "rejections", "declined", "inference_failed", "delivery_failed"] as const;
export type TaskMoveReason = (typeof TASK_MOVE_REASONS)[number];
export interface HistoryEntry {
  at: number;
  by: PeerId;
  event: string; // proposed | assigned | accepted | declined | done | approved | changes_requested | escalated | reassigned
  note?: string;
  /** The owner an event that set it left the task with (#67); absent in rows written before 0.11. */
  owner?: PeerId | null;
  /** On a decline or an escalation: the owner it was declined for or taken from (#207); later reroutes leave it out. */
  from?: PeerId;
  /** On a hand-over: the new owner's split profile then (#109); absent when it was unknown. */
  profile?: string;
  /** Structured cause recorded at the operation source, never inferred from note text. */
  reason?: TaskMoveReason;
  /** Persisted task-idle ladder; never counted as fresh task activity (#186). */
  sweep?: SweepRecord;
  /** The PII screen did not clear this entry's note (#198): only the console reads it. */
  withheld?: true;
  planning?: { revision: number; fields: (keyof PlanningFields)[]; previous: PlanningFields };
}
export interface Task extends PlanningFields {
  planningRevision?: number;
  id: number;
  title: string;
  detail: string;
  class: TaskClass;
  profile?: import("./profiles.ts").ProfileName;
  profileClass?: string;
  /** Catalog guidance id only, never an authority role (#295). */
  role?: string;
  owner: PeerId | null;
  reviewer: PeerId | null;
  state: TaskState;
  refs: TaskRefs;
  /** Absent only on tasks built outside the board (tests); the board always returns one, `{}` when none was given. */
  plan?: TaskPlan;
  /** Artifact identities and bounded evidence, owned by Tasks (#257). */
  sdlc?: SdlcReceipt;
  /** Tasks that must be approved before this one is offered; planning edits are limited to unstarted backlog. */
  deps?: number[];
  /** Who routing offers the task first once nothing is left to wait for (issue #207); null when nobody was named. */
  reserved?: PeerId | null;
  signals: string[];
  /** consecutive changes_requested verdicts */
  rejections: number;
  history: HistoryEntry[];
  created: number;
  updated: number;
}

/** Structured execution evidence, including legacy rows whose owner was later cleared. */
export function taskHasStarted(task: Pick<Task, "history">): boolean {
  return task.history.some(entry => ["accepted", "done", "done (checking)", "check passed", "check failed", "changes_requested", "approved", "reopened", "integration requested", "integrated"].includes(entry.event));
}
/** First offer boundary; staged work has none until it is pulled. */
export function taskProposalAt(task: Pick<Task, "history">): number | undefined {
  return task.history.find(entry => entry.event === "proposed" || entry.event === "backlog pulled")?.at;
}

/** The moves the state machine allows. `accept` and `done` are transitions, not states: they carried no behaviour of their own. */
const MOVES: Record<TaskState, TaskState[]> = {
  backlog: ["proposed"],
  proposed: ["in_progress", "backlog"],
  in_progress: ["in_review", "approved", "proposed"], // approved: class without a reviewer; proposed: owner declined or was taken off
  in_review: ["approved", "changes_requested"],
  changes_requested: ["in_progress"],
  approved: [],
};

const JSON_COLS = ["refs", "plan", "deps", "signals", "history", "sdlc"] as const;

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
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', class TEXT NOT NULL,
      owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]',
      rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    // Who did well or badly at which class, for demotion (issue #36). Only peers, classes and times: no task text.
    this.db.run("CREATE TABLE IF NOT EXISTS outcomes (peer TEXT NOT NULL, class TEXT NOT NULL, ok INTEGER NOT NULL, at INTEGER NOT NULL)");
    this.db.run("CREATE INDEX IF NOT EXISTS outcomes_class_at ON outcomes (class, at)");
    // How reviews turned out, per (implementer, reviewer, class) (issue #35): approved, contradicted later, caught, escalated.
    this.db.run("CREATE TABLE IF NOT EXISTS reviews (implementer TEXT NOT NULL, reviewer TEXT NOT NULL, class TEXT NOT NULL, kind TEXT NOT NULL, task INTEGER NOT NULL, at INTEGER NOT NULL)");
    // ponytail: kept for good (a record is the whole history); prune by age if it ever grows large.
    this.db.run("CREATE INDEX IF NOT EXISTS reviews_class ON reviews (class)");
    this.db.run("CREATE INDEX IF NOT EXISTS reviews_task ON reviews (task)");
    // Boards from before issues #31 and #34 lack these columns; existing rows get the defaults.
    const have = new Set((this.db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, empty] of [["plan", "{}"], ["deps", "[]"]] as const) {
      if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${empty}'`);
    }
    // And from before issue #207: existing rows reserve nobody.
    if (!have.has("reserved")) this.db.run("ALTER TABLE tasks ADD COLUMN reserved TEXT");
    if (!have.has("sdlc")) this.db.run("ALTER TABLE tasks ADD COLUMN sdlc TEXT");
    if (!have.has("task_role")) this.db.run("ALTER TABLE tasks ADD COLUMN task_role TEXT");
    if (!have.has("project_profile")) this.db.run("ALTER TABLE tasks ADD COLUMN project_profile TEXT");
    for (const col of ["rank", "priority", "release", "planned_start", "due"]) {
      if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN "${col}" INTEGER`);
    }
    if (!have.has("pinned")) this.db.run("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    if (!have.has("planning_revision")) this.db.run("ALTER TABLE tasks ADD COLUMN planning_revision INTEGER NOT NULL DEFAULT 0");
    this.db.run(`CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
      release_order INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'planning', planned_start INTEGER, cut INTEGER, ship INTEGER,
      activated_at INTEGER, frozen_at INTEGER, shipped_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0)`);

  }

  propose(by: PeerId, t: { title: string; detail?: string; class: TaskClass; profile?: import("./profiles.ts").ProfileName; profileClass?: string; customProfile?: true; role?: string; refs?: TaskRefs; plan?: TaskPlan; deps?: number[]; reserved?: PeerId; signals?: string[]; backlog?: boolean }): Task {
    const now = Date.now();
    const history: HistoryEntry[] = [{ at: now, by, event: t.backlog ? "backlogged" : "proposed" }];
    const { lastInsertRowid } = this.db
      .query("INSERT INTO tasks (title, detail, class, state, refs, plan, deps, reserved, signals, history, created, updated, project_profile, task_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.title, t.detail ?? "", t.class, t.backlog ? "backlog" : "proposed", JSON.stringify(t.refs ?? {}), JSON.stringify(t.plan ?? {}), JSON.stringify(t.deps ?? []), t.reserved ?? null, JSON.stringify(t.signals ?? []), JSON.stringify(history), now, now, t.profile && (t.profile !== "dev" || t.customProfile || t.profileClass !== undefined && t.profileClass !== t.class) ? JSON.stringify({ profile: t.profile, profileClass: t.profileClass ?? t.class }) : null, t.role ?? null);
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

  /** Structural status facts only; avoid decoding text, plans and growing history on each status write. */
  statusTasks(): Pick<Task, "id" | "state" | "owner" | "reviewer">[] {
    return this.db.query("SELECT id, state, owner, reviewer FROM tasks WHERE state != 'approved' ORDER BY id").all() as Pick<Task, "id" | "state" | "owner" | "reviewer">[];
  }

  /** Tasks per state, without parsing a single row: `status.json` is rewritten on every bus event and the board only grows. */
  counts(): Record<string, number> {
    const rows = this.db.query("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** The only way a task changes. Validates the move, records who did what, returns the new row. */
  /** A `plan` in the patch replaces the old one whole: a new plan is the owner's current intent, not an addition. */
  update(id: number, by: PeerId, event: string, patch: Partial<Pick<Task, "state" | "owner" | "reviewer" | "reserved" | "refs" | "plan" | "rejections" | "signals" | "sdlc" | "role">>, note?: string, extra: Pick<HistoryEntry, "profile" | "sweep" | "reason" | "from" | "withheld"> = {}): Task {
    const task = this.get(id);
    if (!task) throw new Error(`no task #${id}`);
    if (patch.state && patch.state !== task.state && !MOVES[task.state].includes(patch.state)) {
      throw new Error(`task #${id} is ${task.state}: cannot move to ${patch.state}`);
    }
    const next = { ...task, ...patch, refs: { ...task.refs, ...patch.refs } };
    if (next.state === "backlog" && (next.owner || next.reviewer)) throw new Error(`task #${id}: backlog cannot have an owner or reviewer`);
    if (patch.state === "backlog" && task.owner) throw new Error(`task #${id}: owned work cannot return to backlog`);
    if (patch.state === "backlog" && taskHasStarted(task)) throw new Error(`task #${id}: started work cannot return to backlog`);
    const history = [...task.history, { at: Date.now(), by, event, ...(note ? { note } : {}), ...("owner" in patch ? { owner: next.owner } : {}), ...(extra.profile ? { profile: extra.profile } : {}), ...(extra.sweep ? { sweep: extra.sweep } : {}), ...(extra.reason && TASK_MOVE_REASONS.includes(extra.reason) ? { reason: extra.reason } : {}), ...(extra.from ? { from: extra.from } : {}), ...(extra.withheld && note ? { withheld: true as const } : {}) }];
    this.db
      .query("UPDATE tasks SET state = ?, owner = ?, reviewer = ?, reserved = ?, refs = ?, plan = ?, rejections = ?, signals = ?, history = ?, sdlc = ?, task_role = ?, updated = ? WHERE id = ?")
      .run(next.state, next.owner, next.reviewer, next.reserved ?? null, JSON.stringify(next.refs), JSON.stringify(next.plan ?? {}), next.rejections, JSON.stringify(next.signals), JSON.stringify(history), next.sdlc ? JSON.stringify(next.sdlc) : null, next.role ?? null, Date.now(), id);
    const updated = this.get(id)!;
    this.changed(updated, history.at(-1)!);
    return updated;
  }

  /** Internal persistence; caller authority and frozen scope are owned by Tasks. */
  plan(id: number, by: PeerId, input: PlanningFields, revision: number, note?: string, withheld = false): Task {
    const patch = planningPatch(input);
    const task = this.get(id);
    if (!task || (task.planningRevision ?? 0) !== revision) throw new Error("planning revision changed");
    const next = { ...task, ...patch };
    if (next.plannedStart != null && next.due != null && next.plannedStart > next.due) throw new Error("planned start must not follow due");
    if (next.release != null && !this.release(next.release)) throw new Error("no such release");
    const fields = Object.keys(patch) as (keyof PlanningFields)[], previous = Object.fromEntries(fields.map(key => [key, task[key] ?? (key === "pinned" ? false : key === "deps" ? [] : null)])) as PlanningFields;
    const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "planned", planning: { revision: revision + 1, fields, previous }, ...(note ? { note } : {}), ...(withheld && note ? { withheld: true as const } : {}) };
    const result = this.db.query(`UPDATE tasks SET rank=?, priority=?, "release"=?, planned_start=?, due=?, pinned=?, deps=?, reserved=?, planning_revision=planning_revision+1, history=?, updated=? WHERE id=? AND planning_revision=?`)
      .run(next.rank ?? null, next.priority ?? null, next.release ?? null, next.plannedStart ?? null, next.due ?? null, next.pinned ? 1 : 0, JSON.stringify(next.deps ?? []), next.reserved ?? null, JSON.stringify([...task.history, entry]), now, id, revision);
    if (result.changes !== 1) throw new Error("planning revision changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  newRelease(name: string, goal: string, order: number): Release {
    const now = Date.now();
    const result = this.db.query("INSERT INTO releases(name,goal,release_order,created,updated) VALUES(?,?,?,?,?)").run(name, goal, order, now, now);
    return this.release(Number(result.lastInsertRowid))!;
  }
  release(id: number): Release | undefined {
    const row = this.db.query("SELECT * FROM releases WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? parseRelease(row) : undefined;
  }
  releases(): Release[] {
    return (this.db.query("SELECT * FROM releases ORDER BY release_order,id").all() as Record<string, unknown>[]).map(parseRelease);
  }
  updateRelease(id: number, patch: Partial<Pick<Release, "state" | "plannedStart" | "cut" | "ship">>, revision: number): Release {
    const release = this.release(id);
    if (!release || release.revision !== revision) throw new Error("release revision changed");
    const next = { ...release, ...patch }, now = Date.now();
    const moves: Record<ReleaseState, ReleaseState[]> = { planning: ["active", "dropped"], active: ["frozen", "dropped"], frozen: ["shipped", "dropped"], shipped: [], dropped: [] };
    if (next.state !== release.state && !moves[release.state].includes(next.state)) throw new Error("invalid release transition");
    const dates = [next.plannedStart, next.cut, next.ship].filter((date): date is number => date !== null);
    if (dates.some(date => !Number.isSafeInteger(date) || date <= 0 || date > 8_640_000_000_000_000) || dates.some((date, i) => i > 0 && dates[i-1]! > date)) throw new Error("invalid release planned dates");
    const result = this.db.query("UPDATE releases SET state=?,planned_start=?,cut=?,ship=?,activated_at=?,frozen_at=?,shipped_at=?,updated=?,revision=revision+1 WHERE id=? AND revision=?")
      .run(next.state, next.plannedStart, next.cut, next.ship, release.activatedAt ?? (next.state === "active" ? now : null), release.frozenAt ?? (next.state === "frozen" ? now : null), release.shippedAt ?? (next.state === "shipped" ? now : null), now, id, revision);
    if (result.changes !== 1) throw new Error("release revision changed");
    return this.release(id)!;
  }

  recordOutcome(peer: PeerId, cls: TaskClass, ok: boolean, at = Date.now()): void {
    this.db.query("INSERT INTO outcomes (peer, class, ok, at) VALUES (?, ?, ?, ?)").run(peer, cls, ok ? 1 : 0, at);
    this.db.query("DELETE FROM outcomes WHERE at < ?").run(at - OUTCOMES_KEPT_MS); // nothing older is read
  }

  outcomes(cls: TaskClass, since: number): { peer: PeerId; ok: number; at: number }[] {
    return this.db.query("SELECT peer, ok, at FROM outcomes WHERE class = ? AND at >= ?").all(cls, since) as { peer: PeerId; ok: number; at: number }[];
  }

  recordReview(r: Omit<ReviewOutcome, "at">, at = Date.now()): void {
    this.db.query("INSERT INTO reviews (implementer, reviewer, class, kind, task, at) VALUES (?, ?, ?, ?, ?, ?)").run(r.implementer, r.reviewer, r.class, r.kind, r.task, at);
  }

  /** One task's review outcomes, or a class's (for reviewer choice). */
  reviews(where: { task: number } | { class: TaskClass }): ReviewOutcome[] {
    return ("task" in where
      ? this.db.query("SELECT * FROM reviews WHERE task = ? ORDER BY at").all(where.task)
      : this.db.query("SELECT * FROM reviews WHERE class = ? ORDER BY at").all(where.class)) as ReviewOutcome[];
  }

  close(): void {
    this.db.close();
  }
}

export interface ReviewOutcome {
  implementer: PeerId;
  reviewer: PeerId;
  class: TaskClass;
  /** approved; contradicted (a later check failure or changes requested on the same places); caught (changes requested, then the redo passed); escalated */
  kind: "approved" | "contradicted" | "caught" | "escalated";
  task: number;
  at: number;
}

function parse(row: Record<string, unknown>): Task {
  const out = { ...row } as Record<string, unknown>;
  for (const col of JSON_COLS) {
    if (col === "sdlc" && row[col] == null) delete out[col];
    else out[col] = JSON.parse(String(row[col]));
  }
  if (out.project_profile != null) Object.assign(out, JSON.parse(String(out.project_profile)));
  delete out.project_profile;
  if (out.task_role != null) out.role = out.task_role;
  delete out.task_role;
  if (out.planned_start != null) out.plannedStart = out.planned_start;
  delete out.planned_start;
  if (out.planning_revision) out.planningRevision = out.planning_revision;
  delete out.planning_revision;
  if (out.pinned) out.pinned = true; else delete out.pinned;
  for (const key of ["rank", "priority", "release", "due"]) if (out[key] == null) delete out[key];
  return out as unknown as Task;
}

function parseRelease(row: Record<string, unknown>): Release {
  return { id: Number(row.id), name: String(row.name), goal: String(row.goal), order: Number(row.release_order), state: row.state as ReleaseState,
    plannedStart: row.planned_start as number | null, cut: row.cut as number | null, ship: row.ship as number | null,
    activatedAt: row.activated_at as number | null, frozenAt: row.frozen_at as number | null, shippedAt: row.shipped_at as number | null,
    created: Number(row.created), updated: Number(row.updated), revision: Number(row.revision) };
}
