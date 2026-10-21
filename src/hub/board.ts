import type { ReviewerPoolReason } from "./reviewer-pool.ts";
import type { GitHubSource } from "./github-import.ts";
import { Database } from "bun:sqlite";
import { planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import { HUB, type PeerId } from "./envelope.ts";
import type { SweepRecord } from "./task-sweep.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import type { SdlcReceipt } from "./sdlc.ts";
import type { CostPlan, ReviewCost } from "./cost-governance.ts";

export const CLASSES = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"] as const;
export type TaskClass = (typeof CLASSES)[number];
export type TaskState = "backlog" | "proposed" | "in_progress" | "in_review" | "approved" | "changes_requested" | "cancelled";

export const isClosedTaskState = (state: string): boolean => state === "approved" || state === "cancelled";
export interface TaskOffer { envelopeId: string; owner: PeerId; assignmentFlowRevision: number; pullOnly?: boolean }
export interface TaskCancellation { reason: string; supersededBy?: string; flowRevision: number; withheld?: true }
export const TASK_STALL_CODES = ["tests", "spec", "roster", "pull-only", "not-attached", "excluded", "owner-admission", "offline", "paused", "failing", "pii", "policy", "cancelled", "unavailable", "no-writes"] as const;
export type TaskStallCode = (typeof TASK_STALL_CODES)[number];
export interface TaskStall { task: number; signature: string; replanRevision: number; cause: { kind: "reservation" | "no-eligible-peer" | "cancelled-dependency" | "no-writes"; peer?: string; dependency?: number; code: TaskStallCode; turns?: number; acceptance?: number; refusals?: { peer: string; code: TaskStallCode }[] }; at: number }

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
export type TaskPlan = Partial<Record<(typeof ALL_PLAN_KEYS)[number], string[]>> & CostPlan;
/** Task outcomes older than this are pruned: demotion (issue #36) reads one week, seven half-lives. */
export const OUTCOMES_KEPT_MS = 7 * 24 * 3_600_000;

export const TASK_MOVE_REASONS = ["manual", "budget", "offline", "idle", "rejections", "declined", "inference_failed", "delivery_failed"] as const;
export type TaskMoveReason = (typeof TASK_MOVE_REASONS)[number];
export interface HistoryEntry {
  at: number;
  by: PeerId;
  event: string; // proposed | assigned | accepted | declined | done | approved | changes_requested | escalated | reassigned
  note?: string;
  supersededBy?: string;
  /** The owner an event that set it left the task with (#67); absent in rows written before 0.11. */
  owner?: PeerId | null;
  /** On a decline or an escalation: the owner it was declined for or taken from (#207); later reroutes leave it out. */
  from?: PeerId;
  /** On a decline: the owner had no capacity right now (#531). Absent on older rows and on a plain refusal, which read as lasting. */
  capacity?: true;
  /** On a hand-over: the new owner's split profile then (#109); absent when it was unknown. */
  profile?: string;
  /** Structured cause recorded at the operation source, never inferred from note text. */
  reason?: TaskMoveReason;
  /** Persisted task-idle ladder; never counted as fresh task activity (#186). */
  sweep?: SweepRecord;
  /** The PII screen did not clear this entry's note (#198): only the console reads it. */
  withheld?: true;
  /** Host evidence at done, never inferred from the owner's summary. */
  noWrites?: true;
  /** Host-recorded expected cost and exact review head, never narrative. */
  reviewCost?: ReviewCost;
  /** #223 R4: on a verdict, whether the reviewer's context was new for it; set by the hub, never by the reviewer. */
  reviewContext?: "fresh" | "continuing";
  reviewerFamily?: string;
  reviewerReason?: ReviewerPoolReason;
  reviewBlocked?: true;
  reviewerFailure?: { peer: string; head?: string; cause: "start_failed" | "quota" | "no_verdict" };
  planning?: { revision: number; fields: (keyof PlanningFields)[]; previous: PlanningFields; pull?: true; split?: { children: { id: number; revision: number; history: number }[] } };
}
export type ReviewerHistory = Pick<HistoryEntry, "reviewerFamily" | "reviewerReason" | "reviewBlocked" | "reviewerFailure">;
function reviewerHistory(extra: ReviewerHistory): ReviewerHistory {
  const id = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  if (extra.reviewerFamily !== undefined && !id(extra.reviewerFamily) || extra.reviewerReason !== undefined && !["rotation", "implementer skip", "unavailable skip", "same-family fallback"].includes(extra.reviewerReason) || extra.reviewBlocked !== undefined && extra.reviewBlocked !== true) throw new Error("invalid reviewer metadata");
  const failure = extra.reviewerFailure;
  if (failure && (!id(failure.peer) || !["start_failed", "quota", "no_verdict"].includes(failure.cause) || failure.head !== undefined && (typeof failure.head !== "string" || !failure.head.trim() || failure.head.length > 300 || Buffer.byteLength(failure.head) > 1200 || /\p{Cc}/u.test(failure.head)))) throw new Error("invalid reviewer failure metadata");
  return { ...(extra.reviewerFamily ? { reviewerFamily: extra.reviewerFamily } : {}), ...(extra.reviewerReason ? { reviewerReason: extra.reviewerReason } : {}), ...(extra.reviewBlocked ? { reviewBlocked: true } : {}), ...(failure ? { reviewerFailure: { peer: failure.peer, cause: failure.cause, ...(failure.head ? { head: failure.head } : {}) } } : {}) };
}
export interface Task extends PlanningFields {
  offer?: TaskOffer;
  cancelled?: TaskCancellation;
  external?: GitHubSource;
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
/** S9 return eligibility never erases the historical acceptance used by cancellation and undo. */
export function taskHasWorkEvidence(task: Pick<Task, "history" | "refs" | "sdlc">): boolean {
  return !!(task.refs.branch || task.refs.commit || task.sdlc?.localHead || task.sdlc?.localResult || task.sdlc?.reviewedHead || task.sdlc?.pr)
    || task.history.some(entry => entry.event === "done" || entry.event.startsWith("done (") || entry.event.startsWith("check ")
      || ["changes_requested", "approved", "reopened", "integration requested", "integration unresolved", "integrated"].includes(entry.event));
}
/** A successful untouched return permits replanning, without changing historical start evidence. */
export function taskCanPlan(task: Pick<Task, "history" | "refs" | "sdlc">): boolean {
  if (!taskHasStarted(task)) return true;
  const returned = task.history.findLastIndex(entry => entry.event === "backlog returned untouched");
  const accepted = task.history.findLastIndex(entry => entry.event === "accepted");
  return returned > accepted && !taskHasWorkEvidence(task);
}
/** First offer boundary; staged work has none until it is pulled. */
export function taskProposalAt(task: Pick<Task, "history">): number | undefined {
  return task.history.find(entry => entry.event === "proposed" || entry.event === "backlog pulled")?.at;
}
/** Readiness carries out a pending pull; ownership or other later changes still fence undo. */
export function planningUndoEntry(task: Pick<Task, "history">): HistoryEntry | undefined {
  return task.history.findLast(item => item.event !== "memory reference started" && (item.by !== HUB || item.event !== "ready"));
}

/** The moves the state machine allows. `accept` and `done` are transitions, not states: they carried no behaviour of their own. */
const MOVES: Record<TaskState, TaskState[]> = {
  backlog: ["proposed", "cancelled"],
  proposed: ["in_progress", "backlog", "cancelled"],
  in_progress: ["in_review", "approved", "proposed", "cancelled"], // approved: class without a reviewer; proposed: owner declined or was taken off
  in_review: ["approved", "changes_requested", "cancelled"],
  changes_requested: ["in_progress", "proposed", "cancelled"], // proposed: declined redo waits for reassignment
  approved: [],
  cancelled: [],
};

const JSON_COLS = ["refs", "plan", "deps", "signals", "history", "sdlc"] as const;

/** Task board in `.agenthub/state/hub.db`. It outlives the hub process: `ahub kill` leaves the file. */
export class Board {
  private readonly db: Database;
  private pendingChanges: { task: Task; entry: HistoryEntry }[] | undefined;
  /** Every recorded change, as it lands (telemetry, issue #40). */
  onChange?: (task: Task, entry: HistoryEntry) => void;
  private changed(task: Task, entry: HistoryEntry): void {
    if (this.pendingChanges) { this.pendingChanges.push({ task, entry }); return; }
    try { this.onChange?.(task, entry); } catch { /* never throw after a board write */ }
  }
  /** Multi-row changes become observable only once their transaction commits. */
  private atomic<T>(write: () => T): T {
    if (this.pendingChanges) throw new Error("nested board transaction is not supported");
    const changes: { task: Task; entry: HistoryEntry }[] = [];
    this.pendingChanges = changes;
    let result: T;
    try { result = this.db.transaction(write)(); }
    finally { this.pendingChanges = undefined; }
    for (const change of changes) this.changed(change.task, change.entry);
    return result;
  }

  /** Keep the generation and business write atomic without changing Bun's reported row count. */
  private taskWrite<T extends { changes: number }>(write: () => T): T {
    return this.db.transaction(() => {
      const result = { ...write() };
      if (result.changes) this.db.run("UPDATE board_status_revision SET revision=revision+1 WHERE id=1");
      return result;
    })();
  }

  statusRevision(): number {
    return (this.db.query("SELECT revision FROM board_status_revision WHERE id=1").get() as { revision: number }).revision;
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
    for (const col of ["offer", "cancelled"]) if (!have.has(col)) this.db.run(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
    this.db.run("CREATE TABLE IF NOT EXISTS task_stalls (task INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    // Derived status-cache generation: only Board task/stall writes advance it, never journal writes.
    this.db.run("CREATE TABLE IF NOT EXISTS board_status_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)");
    this.db.run("INSERT OR IGNORE INTO board_status_revision VALUES (1,0)");
    if (!have.has("reserved")) this.db.run("ALTER TABLE tasks ADD COLUMN reserved TEXT");
    if (!have.has("external_repo")) this.db.run("ALTER TABLE tasks ADD COLUMN external_repo TEXT");
    if (!have.has("external_issue")) this.db.run("ALTER TABLE tasks ADD COLUMN external_issue INTEGER");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_issue ON tasks(external_repo,external_issue) WHERE external_repo IS NOT NULL AND external_issue IS NOT NULL");
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
    if (!(this.db.query("PRAGMA table_info(releases)").all() as { name: string }[]).some(row => row.name === "train")) this.db.run("ALTER TABLE releases ADD COLUMN train TEXT");

  }

  propose(by: PeerId, t: { title: string; detail?: string; class: TaskClass; profile?: import("./profiles.ts").ProfileName; profileClass?: string; customProfile?: true; role?: string; refs?: TaskRefs; plan?: TaskPlan; deps?: number[]; reserved?: PeerId; signals?: string[]; backlog?: boolean; external?: GitHubSource }): Task {
    const now = Date.now();
    const history: HistoryEntry[] = [{ at: now, by, event: t.backlog ? "backlogged" : "proposed" }];
    const { lastInsertRowid } = this.taskWrite(() => this.db
      .query("INSERT INTO tasks (title, detail, class, state, refs, plan, deps, reserved, signals, history, created, updated, project_profile, task_role, external_repo, external_issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.title, t.detail ?? "", t.class, t.backlog ? "backlog" : "proposed", JSON.stringify(t.refs ?? {}), JSON.stringify(t.plan ?? {}), JSON.stringify(t.deps ?? []), t.reserved ?? null, JSON.stringify(t.signals ?? []), JSON.stringify(history), now, now, t.profile && (t.profile !== "dev" || t.customProfile || t.profileClass !== undefined && t.profileClass !== t.class) ? JSON.stringify({ profile: t.profile, profileClass: t.profileClass ?? t.class }) : null, t.role ?? null, t.external?.repo.toLowerCase() ?? null, t.external?.issue ?? null));
    const task = this.get(Number(lastInsertRowid))!;
    this.changed(task, history[0]!);
    return task;
  }

  imported(repo: string, issue: number): Task | undefined {
    const row = this.db.query("SELECT * FROM tasks WHERE external_repo=? AND external_issue=?").get(repo.toLowerCase(), issue) as Record<string, unknown> | null;
    return row ? parse(row) : undefined;
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
    return this.db.query("SELECT id, state, owner, reviewer FROM tasks WHERE state NOT IN ('approved','cancelled') ORDER BY id").all() as Pick<Task, "id" | "state" | "owner" | "reviewer">[];
  }
  statusReservations(): string[] {
    return (this.db.query("SELECT DISTINCT reserved FROM tasks WHERE state NOT IN ('approved', 'cancelled', 'backlog') AND reserved IS NOT NULL ORDER BY reserved").all() as { reserved: string }[]).map(row => row.reserved);
  }
  plannerWip(peer: string, except?: number): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE state NOT IN ('approved', 'cancelled', 'backlog') AND (? IS NULL OR id != ?) AND
      (owner = ? OR (owner IS NULL AND state = 'proposed' AND reserved = ? AND
        json_extract((SELECT value FROM json_each(tasks.history) WHERE json_extract(value, '$.event') IN ('backlog pulled', 'backlog returned') ORDER BY CAST(key AS INTEGER) DESC LIMIT 1), '$.planning.pull') = 1))`).get(except ?? null, except ?? null, peer, peer) as { n: number };
    return row.n;
  }

  recordTaskOffer(id: number, offer: TaskOffer, expectedFlowRevision: number): void {
    const task = this.get(id);
    if (!task || task.owner !== offer.owner || isClosedTaskState(task.state) || task.history.length !== expectedFlowRevision || offer.assignmentFlowRevision !== expectedFlowRevision) throw new Error("task offer changed");
    const changed = this.taskWrite(() => this.db.query("UPDATE tasks SET offer=? WHERE id=? AND owner=? AND history=?").run(JSON.stringify(offer), id, offer.owner, JSON.stringify(task.history)));
    if (!changed.changes) throw new Error("task offer changed");
  }
  recordStall(stall: TaskStall): boolean {
    const old = this.stalls().find(row => row.task === stall.task);
    if (old?.signature === stall.signature && old.replanRevision === stall.replanRevision) return false;
    this.taskWrite(() => this.db.query("INSERT INTO task_stalls(task,payload) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET payload=excluded.payload").run(stall.task, JSON.stringify(stall)));
    return true;
  }
  clearStall(task: number): void { this.taskWrite(() => this.db.query("DELETE FROM task_stalls WHERE task=?").run(task)); }
  stalls(): TaskStall[] {
    return (this.db.query("SELECT payload FROM task_stalls ORDER BY task").all() as { payload: string }[]).flatMap(row => {
      try {
        const value = JSON.parse(row.payload) as TaskStall, cause = value.cause;
        const peer = (id: unknown) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(id);
        if (Object.keys(value).some(key => !["task", "signature", "replanRevision", "cause", "at"].includes(key)) || !Number.isSafeInteger(value.task) || value.task < 1 || !Number.isSafeInteger(value.replanRevision) || value.replanRevision < 0 || !Number.isFinite(value.at)
          || !cause || !["reservation", "no-eligible-peer", "cancelled-dependency", "no-writes"].includes(cause.kind) || !TASK_STALL_CODES.includes(cause.code)
          || cause.kind === "no-writes" && (cause.code !== "no-writes" || !peer(cause.peer) || !Number.isSafeInteger(cause.turns) || cause.turns! < 1 || !Number.isSafeInteger(cause.acceptance) || cause.acceptance! < 0)
          || cause.peer !== undefined && !peer(cause.peer) || cause.dependency !== undefined && (!Number.isSafeInteger(cause.dependency) || cause.dependency < 1)
          || cause.refusals !== undefined && (!Array.isArray(cause.refusals) || cause.refusals.length > 64 || cause.refusals.some(row => Object.keys(row).some(key => !["peer", "code"].includes(key)) || !peer(row.peer) || !TASK_STALL_CODES.includes(row.code)))
          || Object.keys(cause).some(key => !["kind", "peer", "dependency", "code", "refusals", ...(cause.kind === "no-writes" ? ["turns", "acceptance"] : [])].includes(key)) || value.signature !== JSON.stringify(cause)) return [];
        return [value];
      } catch { return []; }
    });
  }

  /** Tasks per state, without parsing a single row: `status.json` is rewritten on every bus event and the board only grows. */
  counts(): Record<string, number> {
    const rows = this.db.query("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** The only way a task changes. Validates the move, records who did what, returns the new row. */
  /** A `plan` in the patch replaces the old one whole: a new plan is the owner's current intent, not an addition. */
  update(id: number, by: PeerId, event: string, patch: Partial<Pick<Task, "state" | "owner" | "reviewer" | "reserved" | "refs" | "plan" | "rejections" | "signals" | "sdlc" | "role" | "cancelled">>, note?: string, extra: Pick<HistoryEntry, "profile" | "sweep" | "reason" | "from" | "capacity" | "withheld" | "noWrites" | "reviewCost" | "reviewContext" | keyof ReviewerHistory> = {}, expectedFlowRevision?: number): Task {
    const task = this.get(id);
    if (!task) throw new Error(`no task #${id}`);
    if (expectedFlowRevision !== undefined && (!Number.isSafeInteger(expectedFlowRevision) || expectedFlowRevision < 0 || task.history.length !== expectedFlowRevision)) throw new Error("task flow revision changed");
    const untouchedReturn = event === "backlog returned untouched" && patch.state === "backlog" && patch.owner === null && patch.reviewer === null
      && ["proposed", "in_progress"].includes(task.state) && expectedFlowRevision !== undefined && !!note?.trim() && !taskHasWorkEvidence(task);
    if (patch.state && patch.state !== task.state && !MOVES[task.state].includes(patch.state) && !untouchedReturn) {
      throw new Error(`task #${id} is ${task.state}: cannot move to ${patch.state}`);
    }
    const next = { ...task, ...patch, refs: { ...task.refs, ...patch.refs } };
    if (next.state === "backlog" && (next.owner || next.reviewer)) throw new Error(`task #${id}: backlog cannot have an owner or reviewer`);
    if (!untouchedReturn) {
      if (patch.state === "backlog" && task.owner) throw new Error(`task #${id}: owned work cannot return to backlog`);
    }
    if (patch.state === "backlog" && taskHasStarted(task) && !untouchedReturn) throw new Error(`task #${id}: started work cannot return to backlog`);
    const reviewMetadata = reviewerHistory(extra);
    const history = [...task.history, { at: Date.now(), by, event, ...reviewMetadata, ...(note ? { note } : {}), ...(patch.cancelled?.supersededBy ? { supersededBy: patch.cancelled.supersededBy } : {}), ...("owner" in patch ? { owner: next.owner } : {}), ...(extra.profile ? { profile: extra.profile } : {}), ...(extra.sweep ? { sweep: extra.sweep } : {}), ...(extra.reason && TASK_MOVE_REASONS.includes(extra.reason) ? { reason: extra.reason } : {}), ...(extra.from ? { from: extra.from } : {}), ...(extra.capacity === true ? { capacity: true as const } : {}), ...(extra.withheld && note ? { withheld: true as const } : {}), ...(extra.reviewContext === "fresh" || extra.reviewContext === "continuing" ? { reviewContext: extra.reviewContext } : {}), ...(extra.reviewCost ? { reviewCost: extra.reviewCost } : {}), ...(event === "done" && extra.noWrites === true ? { noWrites: true as const } : {}) }];
    this.taskWrite(() => this.db
      .query("UPDATE tasks SET state = ?, owner = ?, reviewer = ?, reserved = ?, refs = ?, plan = ?, rejections = ?, signals = ?, history = ?, sdlc = ?, task_role = ?, cancelled = ?, updated = ? WHERE id = ?")
      .run(next.state, next.owner, next.reviewer, next.reserved ?? null, JSON.stringify(next.refs), JSON.stringify(next.plan ?? {}), next.rejections, JSON.stringify(next.signals), JSON.stringify(history), next.sdlc ? JSON.stringify(next.sdlc) : null, next.role ?? null, next.cancelled ? JSON.stringify(next.cancelled) : null, Date.now(), id));
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
    const result = this.taskWrite(() => this.db.query(`UPDATE tasks SET rank=?, priority=?, "release"=?, planned_start=?, due=?, pinned=?, deps=?, reserved=?, planning_revision=planning_revision+1, history=?, updated=? WHERE id=? AND planning_revision=?`)
      .run(next.rank ?? null, next.priority ?? null, next.release ?? null, next.plannedStart ?? null, next.due ?? null, next.pinned ? 1 : 0, JSON.stringify(next.deps ?? []), next.reserved ?? null, JSON.stringify([...task.history, entry]), now, id, revision));
    if (result.changes !== 1) throw new Error("planning revision changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  /** A planner reserves a routing slot without claiming or dispatching the work. */
  pullPlanned(id: number, by: PeerId, reserved: PeerId, revision: number, note: string, withheld = false): Task {
    const task = this.get(id);
    if (!task || (task.planningRevision ?? 0) !== revision || task.state !== "backlog" || task.owner || !taskCanPlan(task)) throw new Error("planner pull changed or already started");
    const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "backlog pulled", planning: { revision: revision + 1, fields: ["reserved"], previous: { reserved: task.reserved ?? null }, pull: true }, note, ...(withheld ? { withheld: true as const } : {}) };
    const result = this.taskWrite(() => this.db.query("UPDATE tasks SET state='proposed',owner=NULL,reviewer=NULL,reserved=?,planning_revision=planning_revision+1,history=?,updated=? WHERE id=? AND planning_revision=? AND state='backlog' AND owner IS NULL")
      .run(reserved, JSON.stringify([...task.history, entry]), now, id, revision));
    if (result.changes !== 1) throw new Error("planner pull changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  /** No owner or execution evidence may be taken back by planning undo. */
  undoPlannedPull(id: number, by: PeerId, revision: number): Task {
    const task = this.get(id), pull = task ? planningUndoEntry(task)?.planning : undefined;
    if (!task || task.state !== "proposed" || task.owner || taskHasStarted(task) || (task.planningRevision ?? 0) !== revision || !pull?.pull || pull.revision !== revision) throw new Error("planner pull undo changed or already offered");
    const now = Date.now(), entry: HistoryEntry = { at: now, by, event: "backlog returned", note: `undo planner pull revision ${revision}` };
    const result = this.taskWrite(() => this.db.query("UPDATE tasks SET state='backlog',owner=NULL,reviewer=NULL,reserved=?,planning_revision=planning_revision+1,history=?,updated=? WHERE id=? AND planning_revision=? AND state='proposed' AND owner IS NULL")
      .run(pull.previous.reserved ?? null, JSON.stringify([...task.history, entry]), now, id, revision));
    if (result.changes !== 1) throw new Error("planner pull undo changed");
    const updated = this.get(id)!; this.changed(updated, entry); return updated;
  }

  splitBacklog(id: number, by: PeerId, revision: number, parts: (Parameters<Board["propose"]>[1] & { fields?: PlanningFields; afterParts?: number[]; screeningNote?: string })[], note: string, withheld = false): { parent: Task; children: Task[] } {
    return this.atomic(() => {
      const parent = this.get(id);
      if (!parent || parent.state !== "backlog" || parent.owner || taskHasStarted(parent) || (parent.planningRevision ?? 0) !== revision || parts.length < 2 || parts.length > 8) throw new Error("split changed or invalid");
      const children: Task[] = [];
      for (const part of parts) {
        const inherited = part.afterParts?.length ? (part.deps ?? []).filter(dep => !parent.deps?.includes(dep)) : part.deps ?? [];
        const deps = [...new Set([...inherited, ...(part.afterParts ?? []).map(index => { const child = children[index]; if (!child) throw new Error("split dependencies must name an earlier part"); return child.id; })])];
        let child = this.propose(by, { ...part, deps, backlog: true });
        if (part.screeningNote !== undefined) child = this.update(child.id, HUB, "screened", {}, part.screeningNote);
        if (part.fields && Object.keys(part.fields).length) child = this.plan(child.id, by, part.fields, 0, note, withheld);
        children.push(child);
      }
      const deps = children.map(child => child.id);
      const updated = this.plan(id, by, { deps }, revision, note, withheld);
      const entry = updated.history.at(-1)!;
      entry.planning!.split = { children: children.map(child => ({ id: child.id, revision: child.planningRevision ?? 0, history: child.history.length })) };
      this.taskWrite(() => this.db.query("UPDATE tasks SET history=? WHERE id=?").run(JSON.stringify(updated.history), id));
      const notification = this.pendingChanges?.findLast(change => change.task.id === id && change.entry.planning?.revision === revision + 1);
      if (notification) { notification.task = updated; notification.entry = entry; }
      return { parent: this.get(id)!, children };
    });
  }

  undoBacklogSplit(id: number, by: PeerId, revision: number): Task {
    return this.atomic(() => {
      const parent = this.get(id), entry = parent ? planningUndoEntry(parent) : undefined, split = entry?.planning?.split;
      if (!parent || parent.state !== "backlog" || parent.owner || taskHasStarted(parent) || (parent.planningRevision ?? 0) !== revision || !split || entry?.planning?.revision !== revision) throw new Error("split undo changed");
      const ids = new Set(split.children.map(child => child.id));
      for (const saved of split.children) {
        const child = this.get(saved.id);
        if (!child || child.state !== "backlog" || child.owner || taskHasStarted(child) || (child.planningRevision ?? 0) !== saved.revision || child.history.length !== saved.history) throw new Error("split child changed or started");
      }
      if (this.list().some(task => task.id !== id && !ids.has(task.id) && (task.deps?.some(dep => ids.has(dep)) || task.sdlc?.phase?.tasks.some(ref => ids.has(ref.id) || ref.after.some(dep => ids.has(dep)))))) throw new Error("split children are referenced by other work");
      const restored = this.plan(id, by, { deps: entry!.planning!.previous.deps ?? [] }, revision, `undo split revision ${revision}`);
      for (const child of ids) this.taskWrite(() => this.db.query("DELETE FROM tasks WHERE id=?").run(child));
      return restored;
    });
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
  updateRelease(id: number, patch: Partial<Pick<Release, "state" | "plannedStart" | "cut" | "ship" | "train">>, revision: number): Release {
    const release = this.release(id);
    if (!release || release.revision !== revision) throw new Error("release revision changed");
    const next = { ...release, ...patch }, now = Date.now();
    const moves: Record<ReleaseState, ReleaseState[]> = { planning: ["active", "dropped"], active: ["frozen", "dropped"], frozen: ["shipped", "dropped"], shipped: [], dropped: [] };
    if (next.state !== release.state && !moves[release.state].includes(next.state)) throw new Error("invalid release transition");
    if (patch.train && next.state !== release.state && ["frozen", "shipped"].includes(next.state)) {
      const event = next.train?.history.at(-1);
      if (event?.event === (next.state === "frozen" ? "cut" : "shipped")) event.at = now;
    }
    const dates = [next.plannedStart, next.cut, next.ship].filter((date): date is number => date !== null);
    if (dates.some(date => !Number.isSafeInteger(date) || date <= 0 || date > 8_640_000_000_000_000) || dates.some((date, i) => i > 0 && dates[i-1]! > date)) throw new Error("invalid release planned dates");
    const result = this.db.query("UPDATE releases SET state=?,planned_start=?,cut=?,ship=?,activated_at=?,frozen_at=?,shipped_at=?,updated=?,train=?,revision=revision+1 WHERE id=? AND revision=?")
      .run(next.state, next.plannedStart, next.cut, next.ship, release.activatedAt ?? (next.state === "active" ? now : null), release.frozenAt ?? (next.state === "frozen" ? now : null), release.shippedAt ?? (next.state === "shipped" ? now : null), now, next.train === undefined ? null : JSON.stringify(next.train), id, revision);
    if (result.changes !== 1) throw new Error("release revision changed");
    return this.release(id)!;
  }

  /** Cross-connection scope changes cannot race the final freeze write. */
  freezeRelease(id: number, revision: number, scope: Task[], train: NonNullable<Release["train"]>): Release {
    return this.db.transaction(() => {
      const release = this.release(id);
      if (!release || release.revision !== revision || release.state !== "active" || this.releases().some(row => row.id !== id && ["active", "frozen"].includes(row.state)) || JSON.stringify(this.list().filter(task => task.release === id)) !== JSON.stringify(scope)) throw new Error("release scope changed before freeze");
      return this.updateRelease(id, { state: "frozen", train }, revision);
    })();
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
  for (const key of ["offer", "cancelled"]) if (row[key] == null) delete out[key]; else out[key] = JSON.parse(String(row[key]));
  for (const col of JSON_COLS) {
    if (col === "sdlc" && row[col] == null) delete out[col];
    else out[col] = JSON.parse(String(row[col]));
  }
  if (out.project_profile != null) Object.assign(out, JSON.parse(String(out.project_profile)));
  delete out.project_profile;
  if (out.external_repo != null && out.external_issue != null) out.external = { provider: "github", repo: String(out.external_repo), issue: Number(out.external_issue), url: `https://github.com/${out.external_repo}/issues/${out.external_issue}` };
  delete out.external_repo; delete out.external_issue;
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
  return { ...(row.train == null ? {} : { train: JSON.parse(String(row.train)) }), id: Number(row.id), name: String(row.name), goal: String(row.goal), order: Number(row.release_order), state: row.state as ReleaseState,
    plannedStart: row.planned_start as number | null, cut: row.cut as number | null, ship: row.ship as number | null,
    activatedAt: row.activated_at as number | null, frozenAt: row.frozen_at as number | null, shippedAt: row.shipped_at as number | null,
    created: Number(row.created), updated: Number(row.updated), revision: Number(row.revision) };
}
