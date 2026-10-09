import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../hub/bus.ts";
import { DeliveryJournal } from "../hub/delivery-journal.ts";
import type { Project } from "../hub/registry.ts";

/** Agent session resume pointers. `pi-sessions/` holds Pi transcripts, history rather than pointers, and stays. */
export const SESSION_POINTERS = ["sessions.json", "claude-session.json", "claude-context.json"];
/** What a running daemon publishes; a daemon that did not stop cleanly (crash, SIGKILL, forced exit) leaves it. */
export const MANIFEST = ["status.json", "control-token", "hub.pid"];

/** A state the reset cannot read the same way twice: rerunning fails alike, while `--all` archives it as it is. */
export function damagedState(error: unknown): boolean {
  return error instanceof SyntaxError || /invalid delivery journal|not a database|malformed|corrupt/i.test((error as Error)?.message ?? "");
}

/**
 * What may be printed about a failure: a parser's message can quote the data it choked on (envelope bodies, task text),
 * so JSON and SQLite errors are named by class and code only. Every other message is written by the hub or the system.
 */
export function failureText(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (e instanceof SyntaxError || e?.name === "SQLiteError") return `${[e.name, e.code].filter(Boolean).join(" ")} reading hub.db`;
  return e?.message ?? String(error);
}

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

const isList = (value: unknown, item: (v: unknown) => boolean) => Array.isArray(value) && value.every(item);
const isText = (v: unknown) => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEnvelope = (v: unknown) => isObject(v) && typeof v.id === "string";
/** Valid JSON of the wrong shape is damage as well: the journal refuses it on every open, so the message says so. */
const shaped = (ok: boolean, what: string) => { if (!ok) throw new Error(`invalid delivery journal: ${what} has the wrong shape`); };

/** What a reset would act on, read from the state directory without changing it (hub.db opened read-only). */
export function planReset(stateDir: string, projectId: string): ResetPlan {
  const plan: ResetPlan = { queued: [], needsReview: [], inFlight: [], manualHolds: [], budgetPauses: [], conductorHolds: [],
    sessionPointers: SESSION_POINTERS.filter((name) => existsSync(join(stateDir, name))), entries: existsSync(stateDir) ? readdirSync(stateDir).length : 0 };
  const file = join(stateDir, "hub.db");
  if (!existsSync(file)) return plan;
  // A read-only open of a WAL database creates hub.db-wal and -shm when the last writer's close removed them (Linux),
  // and fails without them on macOS. Without them no writer is mid-transaction, so `immutable` reads hub.db alone and
  // writes nothing. ponytail: a -wal left without its -shm (deleted by hand) is ignored then, and commits still in
  // it go unlisted; open plainly in that corner if it ever matters.
  const quiet = !existsSync(`${file}-wal`) || !existsSync(`${file}-shm`);
  const db = quiet ? new Database(`file:${file.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}?immutable=1`, { readonly: true }) : new Database(file, { readonly: true });
  try {
    const has = (table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const peers = (table: string) => has(table) ? (db.query(`SELECT peer FROM ${table} ORDER BY peer`).all() as { peer: string }[]).map((row) => row.peer) : [];
    plan.budgetPauses = peers("budget_pauses");
    plan.conductorHolds = peers("conductor_holds");
    if (!has("deliveries")) return plan;
    const rows = db.query("SELECT id, peer, state, originals FROM deliveries WHERE project_id = ? AND state IN ('queued', 'dispatching', 'accepted', 'needs_review') ORDER BY created_at, id").all(projectId) as { id: string; peer: string; state: string; originals: string }[];
    for (const row of rows) (row.state === "queued" ? plan.queued : row.state === "needs_review" ? plan.needsReview : plan.inFlight).push(row.id);
    const meta = db.query("SELECT bus_snapshot, manual_paused FROM delivery_meta WHERE project_id = ?").get(projectId) as { bus_snapshot: string; manual_paused: string } | null;
    const bus: unknown = JSON.parse(meta?.bus_snapshot || "{}"), manual: unknown = JSON.parse(meta?.manual_paused || "[]");
    shaped(isList(manual, isText), "manual_paused");
    shaped(isObject(bus) && (bus.manualPaused === undefined || isList(bus.manualPaused, isText)) && (bus.queues === undefined || (isObject(bus.queues) && Object.values(bus.queues).every((queue) => isList(queue, isEnvelope)))), "bus_snapshot");
    const { queues = {}, manualPaused = [] } = bus as { queues?: Record<string, { id: string }[]>; manualPaused?: string[] };
    plan.manualHolds = [...new Set([...manual as string[], ...manualPaused])].sort();
    // As Bus.queueList: a queued envelope that no open row stands for is listed as q:<peer>:<envelope id>.
    // ponytail: the rule is copied so the dry run never opens the journal for writing; the reset tests compare the
    // listed ids with the settled ones. Share one pure helper with queueList if that rule changes.
    const recorded = new Set(rows.flatMap((row) => {
      const originals: unknown = JSON.parse(row.originals);
      shaped(isList(originals, isEnvelope), `delivery ${row.id} originals`);
      return (originals as { id: string }[]).map((env) => `${row.peer}:${env.id}`);
    }));
    for (const [peer, queue] of Object.entries(queues)) for (const env of queue) if (!recorded.has(`${peer}:${env.id}`)) plan.queued.push(`q:${peer}:${env.id}`);
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
 * pointers dropped, with a crashed run's manifest. The board, logs, audit, recovery records and execution budgets stay.
 */
export function resetRuntime(stateDir: string, project: Project): { settled: string[]; plan: ResetPlan; stale: string[] } {
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
  // The caller has checked that no daemon behind these is alive or uncertain: they are a crashed run's leftovers.
  const stale = MANIFEST.filter((name) => existsSync(join(stateDir, name)));
  for (const name of stale) rmSync(join(stateDir, name), { force: true });
  return { settled, plan, stale };
}

/**
 * Why `--all` must not move this state directory into `<root>/.agenthub/archive`, or undefined. An agent with write
 * access to the project, or a repository that commits `.agenthub/`, could otherwise turn the archive into a symlink and
 * have hub.db (PII) moved out of the project, or the `.gitignore` into one that truncates any file it names.
 */
export function archiveProblem(root: string, stateDir: string): string | undefined {
  const uid = process.getuid?.();
  const own = (path: string) => { const st = lstatSync(path); return st.isDirectory() && (uid === undefined || st.uid === uid); };
  for (const dir of [join(root, ".agenthub"), stateDir]) if (!own(dir)) return `${dir} is not a directory of this user`;
  const archive = join(root, ".agenthub", "archive");
  if (lstatSync(archive, { throwIfNoEntry: false }) && !own(archive)) return `${archive} is not a directory of this user (a symlink, or another owner's)`;
  const ignore = lstatSync(join(archive, ".gitignore"), { throwIfNoEntry: false });
  if (ignore && !ignore.isFile()) return `${join(archive, ".gitignore")} is not a regular file`;
  return undefined;
}

/**
 * Full reset, first step: the state directory moves to `.agenthub/archive/state-<UTC time>/` (0700). Nothing is
 * deleted; moving the archive back restores it. Only the default `<root>/.agenthub/state` qualifies (the caller checks).
 * The rename is the last step: when this throws, nothing was moved.
 */
export function archiveState(root: string, stateDir: string, now = new Date()): string {
  const problem = archiveProblem(root, stateDir);
  if (problem) throw new Error(problem);
  const archive = join(root, ".agenthub", "archive");
  if (!lstatSync(archive, { throwIfNoEntry: false })) mkdirSync(archive, { mode: 0o700 });
  // hub.db holds task text, PII included: keep the archive out of git whatever the project's .gitignore says.
  // The local worker's denylist (src/local/deny.ts) keeps it out of its tools, sandbox and memory capture.
  // Verified, not only created: an edited, emptied or hard-linked one is replaced by a rename, never written through.
  // Turn snapshots exclude the archive as well.
  const ignore = join(archive, ".gitignore");
  const current = lstatSync(ignore, { throwIfNoEntry: false });
  if (!current || current.nlink > 1 || readFileSync(ignore, "utf8") !== "*\n") {
    const temporary = join(archive, `.gitignore.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, "*\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, ignore); }
    finally { rmSync(temporary, { force: true }); }
  }
  const target = join(archive, `state-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error(`${target} already exists`);
  chmodSync(stateDir, 0o700);
  // ponytail: checked, then renamed by path; a symlink swapped in for .agenthub/archive in the microseconds between
  // still wins. Rename relative to a held directory descriptor (renameat) if Bun ever exposes one.
  renameSync(stateDir, target);
  return target;
}

/**
 * Full reset, second step: a new state directory with only the archive's `project.json`, so the project id and
 * registration stay. Something else may have created the directory meanwhile (the status line tee, 0755).
 */
export function startState(stateDir: string, archived: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(stateDir);
  if (!st.isDirectory() || st.uid !== (process.getuid?.() ?? st.uid)) throw new Error(`${stateDir} was re-created as something other than a directory of this user`);
  chmodSync(stateDir, 0o700);
  if (existsSync(join(archived, "project.json"))) copyFileSync(join(archived, "project.json"), join(stateDir, "project.json"));
}
