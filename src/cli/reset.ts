import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../hub/bus.ts";
import { DeliveryJournal } from "../hub/delivery-journal.ts";
import type { Project } from "../hub/registry.ts";

/** Agent session resume pointers. `pi-sessions/` holds Pi transcripts, history rather than pointers, and stays. */
export const SESSION_POINTERS = ["sessions.json", "claude-session.json", "claude-context.json"];

/** Ids and peer names only: a reset never prints task or message text (#214). */
export interface ResetPlan {
  queued: string[];
  needsReview: string[];
  /** Dispatching or accepted: the journal holds them as needs_review once the hub has stopped. */
  inFlight: string[];
  manualHolds: string[];
  budgetPauses: string[];
  conductorHolds: string[];
  sessionPointers: string[];
  entries: number;
}

/** What a reset would act on, read from the state directory without changing it (hub.db opened read-only). */
export function planReset(stateDir: string, projectId: string): ResetPlan {
  const plan: ResetPlan = { queued: [], needsReview: [], inFlight: [], manualHolds: [], budgetPauses: [], conductorHolds: [],
    sessionPointers: SESSION_POINTERS.filter((name) => existsSync(join(stateDir, name))), entries: existsSync(stateDir) ? readdirSync(stateDir).length : 0 };
  const file = join(stateDir, "hub.db");
  if (!existsSync(file)) return plan;
  const db = new Database(file, { readonly: true });
  try {
    const has = (table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const peers = (table: string) => has(table) ? (db.query(`SELECT peer FROM ${table} ORDER BY peer`).all() as { peer: string }[]).map((row) => row.peer) : [];
    plan.budgetPauses = peers("budget_pauses");
    plan.conductorHolds = peers("conductor_holds");
    if (!has("deliveries")) return plan;
    const rows = db.query("SELECT id, peer, state, originals FROM deliveries WHERE project_id = ? AND state IN ('queued', 'dispatching', 'accepted', 'needs_review') ORDER BY created_at, id").all(projectId) as { id: string; peer: string; state: string; originals: string }[];
    for (const row of rows) (row.state === "queued" ? plan.queued : row.state === "needs_review" ? plan.needsReview : plan.inFlight).push(row.id);
    const meta = db.query("SELECT bus_snapshot, manual_paused FROM delivery_meta WHERE project_id = ?").get(projectId) as { bus_snapshot: string; manual_paused: string } | null;
    const bus = JSON.parse(meta?.bus_snapshot || "{}") as { queues?: Record<string, { id: string }[]>; manualPaused?: string[] };
    plan.manualHolds = [...new Set([...JSON.parse(meta?.manual_paused || "[]") as string[], ...bus.manualPaused ?? []])].sort();
    // As Bus.queueList: a queued envelope that no open row stands for is listed as q:<peer>:<envelope id>.
    // ponytail: the rule is copied so the dry run never opens the journal for writing; the reset tests compare the
    // listed ids with the settled ones. Share one pure helper with queueList if that rule changes.
    const recorded = new Set(rows.flatMap((row) => (JSON.parse(row.originals) as { id: string }[]).map((env) => `${row.peer}:${env.id}`)));
    for (const [peer, queue] of Object.entries(bus.queues ?? {})) for (const env of queue) if (!recorded.has(`${peer}:${env.id}`)) plan.queued.push(`q:${peer}:${env.id}`);
  } finally { db.close(); }
  return plan;
}

const named = (label: string, items: string[]) => `${label} ${items.length}${items.length ? `: ${items.join(", ")}` : ""}`;
/** The runtime scope, ids and counts: the deliveries first, then the holds and pointers. */
export function resetLines(plan: ResetPlan): string[] {
  return [
    `deliveries: ${named("queued", plan.queued)}; ${named("needs_review", plan.needsReview)}; ${named("in flight", plan.inFlight)}`,
    named("manual holds", plan.manualHolds),
    named("budget pauses", plan.budgetPauses),
    named("conductor holds", plan.conductorHolds),
    named("session pointers", plan.sessionPointers),
  ];
}

/**
 * Runtime reset of a stopped hub: every queued and needs_review delivery is discarded with reason `reset` through
 * the journal (one resolution_history entry each), manual, budget and conductor holds are cleared and the session
 * pointers dropped. The board, logs, audit, recovery records and execution budgets stay.
 */
export function resetRuntime(stateDir: string, project: Project): { settled: string[]; plan: ResetPlan } {
  const file = join(stateDir, "hub.db");
  const plan = planReset(stateDir, project.id);
  const settled: string[] = [];
  if (existsSync(file)) {
    // Opening the journal as a new instance turns dispatching and accepted rows of the stopped run into needs_review.
    const journal = new DeliveryJournal({ file, projectRoot: project.root, projectId: project.id, instanceId: randomUUID() });
    const bus = new Bus({ journal });
    try {
      for (const { id } of bus.queueList().filter((row) => row.state === "queued" || row.state === "needs_review")) {
        // Read again each time: a queue entry's revision is the journal's, and every resolution moves it on.
        bus.resolveDelivery(id, bus.queueShow(id)!.revision, "discard", "reset");
        settled.push(id);
      }
      bus.setManualPaused([]);
    } finally { bus.closeJournal(); }
    const db = new Database(file);
    try {
      db.transaction(() => {
        for (const table of ["budget_pauses", "conductor_holds"]) {
          if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.run(`DELETE FROM ${table}`);
        }
      })();
    } finally { db.close(); }
  }
  for (const name of SESSION_POINTERS) rmSync(join(stateDir, name), { force: true });
  return { settled, plan };
}

/**
 * Full reset: the state directory moves to `.agenthub/archive/state-<UTC time>/` (0700) and a new one starts with only
 * `project.json`, so the project id and registration stay. Nothing is deleted; moving the archive back restores it.
 */
export function archiveState(root: string, stateDir: string, now = new Date()): string {
  const archive = join(root, ".agenthub", "archive");
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  // hub.db holds task text, PII included: keep the archive out of git whatever the project's .gitignore says.
  if (!existsSync(join(archive, ".gitignore"))) writeFileSync(join(archive, ".gitignore"), "*\n");
  const target = join(archive, `state-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
  if (existsSync(target)) throw new Error(`${target} already exists; nothing was moved`);
  renameSync(stateDir, target);
  chmodSync(target, 0o700);
  mkdirSync(stateDir, { mode: 0o700 });
  if (existsSync(join(target, "project.json"))) copyFileSync(join(target, "project.json"), join(stateDir, "project.json"));
  return target;
}
