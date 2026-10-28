import { Database } from "bun:sqlite";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { corpusPathProblem } from "./corpus-config.ts";

// agent-hub #512 (hub task #330): machine-local schedules. Spec: "Schedules and folder triggers (#512)".

export const MIN_EVERY_MS = 15 * 60_000;
export const MAX_EVERY_MS = 365 * 86_400_000;
export const MAX_SCHEDULES = 64;
export const MAX_SCHEDULE_SOURCES = 16;
/** Under the board's 8000-character detail cap with the fixed lines and 16 source lines around it, so the marker line is never cut off. */
export const MAX_SCHEDULE_DETAIL = 7000;
/** The first line of a scheduled task's detail: how the board finds the task a schedule made, whatever hub.db remembers. */
export const SCHEDULE_MARKER = "Schedule key: ";

export interface ScheduleEntry {
  id: string;
  every: string;
  class: string;
  title: string;
  detail?: string;
  sources?: string[];
  owner?: string;
  queue: "backlog" | "ready";
}

/** The source id form of `src/hub/sources.ts` (`validSourceId`), repeated here because that module reaches the file system and the converters and this one is bundled into the Claude channel server through the config schema; `test/schedules.test.ts` pins that the two agree. */
export const SOURCE_ID = /^src:[0-9a-f]{16}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/, PEER = /^[a-z][a-z0-9-]{0,31}$/, CLASS = /^[a-z][a-z0-9_]{0,47}$/, KEYS = new Set(["id", "every", "cron", "class", "title", "detail", "sources", "owner", "queue"]);
const control = /[\x00-\x1f\x7f]/;

/** `<n>m|h|d` to milliseconds; a thrown reason otherwise. The 15-minute floor keeps a typo from flooding the board. */
export function parseEvery(value: unknown): number {
  const match = typeof value === "string" ? /^([1-9][0-9]{0,5})([mhd])$/.exec(value) : null;
  if (!match) throw new Error("every must be <n>m, <n>h or <n>d, such as 90m, 6h or 1d");
  const ms = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  if (ms < MIN_EVERY_MS) throw new Error("every must be at least 15m");
  if (ms > MAX_EVERY_MS) throw new Error("every must be at most 365d");
  return ms;
}

/** The checked `schedules` list. Every refusal names the entry; nothing here reads the board, a clock or a file. */
export function schedulesConfig(input: unknown): ScheduleEntry[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("schedules must be a list");
  if (input.length > MAX_SCHEDULES) throw new Error(`schedules holds at most ${MAX_SCHEDULES} entries`);
  const seen = new Set<string>(), out: ScheduleEntry[] = [];
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`schedules[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const name = typeof row.id === "string" && ID.test(row.id) ? `schedules.${row.id}` : `schedules[${index}]`;
    const bad = (reason: string): never => { throw new Error(`${name}: ${reason}`); };
    for (const key of Object.keys(row)) if (!KEYS.has(key)) bad(`unknown key ${key}`);
    if (typeof row.id !== "string" || !ID.test(row.id)) bad("id is 1 to 48 lower-case letters, digits, - or _");
    if (seen.has(row.id as string)) bad("duplicate id");
    seen.add(row.id as string);
    if (row.cron !== undefined) bad("cron not supported yet; use every");
    try { parseEvery(row.every); } catch (error) { bad((error as Error).message); }
    if (typeof row.class !== "string" || !CLASS.test(row.class)) bad("class is required");
    if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 || control.test(row.title)) bad("title is 1 to 300 printable characters on one line");
    if (row.detail !== undefined && (typeof row.detail !== "string" || row.detail.length > MAX_SCHEDULE_DETAIL || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.detail))) bad(`detail is text of at most ${MAX_SCHEDULE_DETAIL} characters`);
    if (row.owner !== undefined && (typeof row.owner !== "string" || !PEER.test(row.owner))) bad("owner is a peer id");
    if (row.queue !== undefined && row.queue !== "backlog" && row.queue !== "ready") bad('queue is "backlog" or "ready"');
    if (row.sources !== undefined) {
      if (!Array.isArray(row.sources) || row.sources.length > MAX_SCHEDULE_SOURCES || !row.sources.every(id => typeof id === "string" && SOURCE_ID.test(id))) bad(`sources is a list of at most ${MAX_SCHEDULE_SOURCES} source ids (src:<16 hex>)`);
    }
    out.push({
      id: row.id as string, every: row.every as string, class: row.class as string, title: (row.title as string).replace(/\s+/g, " ").trim(),
      ...(row.detail !== undefined ? { detail: row.detail as string } : {}), ...(row.sources !== undefined ? { sources: [...(row.sources as string[])] } : {}),
      ...(row.owner !== undefined ? { owner: row.owner as string } : {}), queue: (row.queue as "backlog" | "ready" | undefined) ?? "backlog",
    });
  });
  return out;
}

// agent-hub #512c (hub task #336): machine-local folder triggers. The pure config only; the scan, the store and the registration are in `folder-trigger.ts`, which reaches the disk.
export const MAX_FOLDER_TRIGGERS = 16;
export const MAX_FOLDER_GLOB = 100;
/** The first line of a folder-triggered task's detail: which trigger made it. A task per file, so unlike a schedule's marker it blocks nothing. */
export const FOLDER_MARKER = "Folder trigger: ";

export interface FolderEntry {
  id: string;
  folder: string;
  glob?: string;
  class: string;
  title: string;
  detail?: string;
  owner?: string;
  queue: "backlog" | "ready";
}
const FOLDER_KEYS = new Set(["id", "folder", "glob", "class", "title", "detail", "owner", "queue"]);

/** A file-name pattern: letters, digits, `.`, `_`, `-`, space, `*` and `?`. Never a path, so it cannot reach outside the folder. */
export const folderGlobProblem = (value: unknown): string | undefined =>
  typeof value !== "string" || !value || value.length > MAX_FOLDER_GLOB || !/^[A-Za-z0-9._ *?-]+$/.test(value) || value === "." || value === ".."
    ? `glob is a file-name pattern of at most ${MAX_FOLDER_GLOB} characters (letters, digits, . _ - space, * and ?), never a path` : undefined;

/** Whether a file name matches a trigger's glob. Dot files never match: a hidden file is not something a person dropped in. */
export function folderGlobMatches(glob: string | undefined, name: string): boolean {
  if (name.startsWith(".")) return false;
  if (glob === undefined) return true;
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(name);
}

/** The checked `folder_triggers` list. Every refusal names the entry; nothing here reads the disk (the folder check does, at each poll). */
export function foldersConfig(input: unknown): FolderEntry[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("folder_triggers must be a list");
  if (input.length > MAX_FOLDER_TRIGGERS) throw new Error(`folder_triggers holds at most ${MAX_FOLDER_TRIGGERS} entries`);
  const seen = new Set<string>(), out: FolderEntry[] = [];
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`folder_triggers[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const name = typeof row.id === "string" && ID.test(row.id) ? `folder_triggers.${row.id}` : `folder_triggers[${index}]`;
    const bad = (reason: string): never => { throw new Error(`${name}: ${reason}`); };
    for (const key of Object.keys(row)) if (!FOLDER_KEYS.has(key)) bad(`unknown key ${key}`);
    if (typeof row.id !== "string" || !ID.test(row.id)) bad("id is 1 to 48 lower-case letters, digits, - or _");
    if (seen.has(row.id as string)) bad("duplicate id");
    seen.add(row.id as string);
    const folderProblem = corpusPathProblem(row.folder);
    if (folderProblem) bad(folderProblem.replace("a corpus path", "folder"));
    if (row.glob !== undefined) { const problem = folderGlobProblem(row.glob); if (problem) bad(problem); }
    if (typeof row.class !== "string" || !CLASS.test(row.class)) bad("class is required");
    if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 || control.test(row.title)) bad("title is 1 to 300 printable characters on one line");
    if (row.detail !== undefined && (typeof row.detail !== "string" || row.detail.length > MAX_SCHEDULE_DETAIL || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.detail))) bad(`detail is text of at most ${MAX_SCHEDULE_DETAIL} characters`);
    if (row.owner !== undefined && (typeof row.owner !== "string" || !PEER.test(row.owner))) bad("owner is a peer id");
    if (row.queue !== undefined && row.queue !== "backlog" && row.queue !== "ready") bad('queue is "backlog" or "ready"');
    out.push({
      id: row.id as string, folder: row.folder as string, ...(row.glob !== undefined ? { glob: row.glob as string } : {}), class: row.class as string,
      title: (row.title as string).replace(/\s+/g, " ").trim(), ...(row.detail !== undefined ? { detail: row.detail as string } : {}),
      ...(row.owner !== undefined ? { owner: row.owner as string } : {}), queue: (row.queue as "backlog" | "ready" | undefined) ?? "backlog",
    });
  });
  return out;
}

/** What one poll of a trigger did: `baseline` (first poll, recorded only), `ran`, `none`, `held`, `refused` (the folder may not be read, with the reason) or `failed`. */
export interface FolderRunResult { id: string; outcome: "baseline" | "ran" | "none" | "held" | "refused" | "failed"; tasks: number[]; files: number; reason?: string }
/** One file a poll read: its real path, name, size, mtime, SHA-256 and bytes. */
export interface ScannedFile { real: string; name: string; size: number; mtime: number; sha256: string; bytes: Buffer }
/** What a read of a trigger's folder gave. `refused` is the reason the folder may not be read. */
export interface FolderScan { folder?: string; files: ScannedFile[]; skipped: { name: string; reason: string }[]; refused?: string; truncated: boolean }
/** The part of the folder state `Tasks` needs. The scan, the disk and the table are in `folder-trigger.ts`, which the Claude channel bundle must not reach. */
export interface FolderStorePort {
  started(trigger: string): number | undefined;
  begin(trigger: string, now: number): void;
  polled(trigger: string, now: number, error?: string): void;
  isNew(trigger: string, sha256: string): boolean;
  record(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, task: number | null, now: number): void;
  prune(keep: readonly string[]): void;
}
/** New files one poll registers per trigger: a drop of a whole archive becomes a handful of tasks per tick, never a burst. */
export const MAX_NEW_PER_POLL = 20;

/** The detail of a folder-triggered task: the marker first, then the person's text, then the one source it names. Never the file's name or path: both can be private. */
export function folderDetail(entry: FolderEntry, source: string): string {
  return [`${FOLDER_MARKER}${entry.id}`, `Made by the machine-local folder trigger "${entry.id}" for a new file, registered as the source below.`, ...(entry.detail ? ["", entry.detail] : []), "", `Source: ${source}`].join("\n");
}

export interface ScheduleRow {
  id: string;
  /** The start of the current period: the first time the schedule was seen, then the last run. The next run is this plus `every`. */
  anchor: number;
  last_run: number | null;
  last_task: number | null;
  /** Ticks that were due and skipped (held, or the previous task still open) since the last run: coalesced into the one run that follows. */
  coalesced: number;
  last_error: string | null;
  /** #335: 1 while a person has paused it. */
  paused?: number;
}

/** `schedule_runs` in hub.db: when each schedule last ran and what it made. The board stays the record of the tasks themselves. */
export class ScheduleStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.db.run("CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, anchor INTEGER NOT NULL, last_run INTEGER, last_task INTEGER, coalesced INTEGER NOT NULL DEFAULT 0, last_error TEXT)");
    // #335: a person's pause. A column on the existing table, so an older database gains it and every older row reads as not paused.
    if (!(this.db.query("PRAGMA table_info(schedule_runs)").all() as { name: string }[]).some(column => column.name === "paused")) this.db.run("ALTER TABLE schedule_runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
  }
  get(id: string): ScheduleRow | undefined { return (this.db.query("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRow | null) ?? undefined; }
  rows(): ScheduleRow[] { return this.db.query("SELECT * FROM schedule_runs ORDER BY id").all() as ScheduleRow[]; }
  /** A schedule seen for the first time starts its period now: it never runs at once, and a restart never replays a missed one. */
  ensure(id: string, now: number): ScheduleRow {
    this.db.query("INSERT OR IGNORE INTO schedule_runs(id, anchor) VALUES(?, ?)").run(id, now);
    return this.get(id)!;
  }
  /**
   * A schedule's pause generation, in memory: `setPaused` bumps it. A run captures it when it is admitted and its write fence asks again, so a pause or a resume that
   * lands while the run awaits its PII screen cancels that run instead of being overtaken by it. A restart ends every run in flight, so memory is enough.
   */
  private readonly epochs = new Map<string, number>();
  epoch(id: string): number { return this.epochs.get(id) ?? 0; }
  /**
   * #335: pause or resume one schedule. A pause stops the timer from proposing it and counts no skipped tick. Resuming starts a fresh period at `now`, so a long
   * pause is never replayed as a run the moment it ends, as a restart is never replayed either.
   */
  setPaused(id: string, paused: boolean, now: number): void {
    this.epochs.set(id, this.epoch(id) + 1);
    this.db.query("INSERT OR IGNORE INTO schedule_runs(id, anchor) VALUES(?, ?)").run(id, now);
    if (paused) this.db.query("UPDATE schedule_runs SET paused = 1 WHERE id = ?").run(id);
    else this.db.query("UPDATE schedule_runs SET paused = 0, anchor = ?, coalesced = 0 WHERE id = ?").run(now, id);
  }
  skipped(id: string): void { this.db.query("UPDATE schedule_runs SET coalesced = coalesced + 1 WHERE id = ?").run(id); }
  ran(id: string, now: number, task: number): void {
    // The anchor never moves back: a resume that landed after the task was written already started a later period, and an older pass timestamp must not shorten it.
    this.db.query("UPDATE schedule_runs SET anchor = MAX(anchor, ?), last_run = ?, last_task = ?, coalesced = 0, last_error = NULL WHERE id = ?").run(now, now, task, id);
  }
  failed(id: string, reason: string): void { this.db.query("UPDATE schedule_runs SET last_error = ? WHERE id = ?").run(reason.slice(0, 200), id); }
  /** A schedule removed from the config keeps no row. */
  prune(keep: readonly string[]): void {
    for (const row of this.rows()) if (!keep.includes(row.id)) this.db.query("DELETE FROM schedule_runs WHERE id = ?").run(row.id);
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}

/** What one run of a schedule did. `changed`: the person paused or resumed it after the run was admitted, so it wrote nothing (#335). */
export type ScheduleOutcome = "ran" | "held" | "waiting" | "failed" | "changed";
export interface ScheduleRunResult { id: string; outcome: ScheduleOutcome; task?: number }

export type ScheduleState = "scheduled" | "due" | "waiting" | "held" | "paused";
export interface ScheduleView {
  id: string;
  every: string;
  class: string;
  queue: "backlog" | "ready";
  next: number;
  last?: number;
  task?: number;
  state: ScheduleState;
  coalesced?: number;
  error?: string;
}

/**
 * What status shows for each schedule. `open` maps a schedule id to the open task it made. A due schedule that is held or whose task is open says so;
 * one that is simply due (before its next tick) reads `due`. Titles and details are never shown: they are task text.
 */
export function scheduleViews(entries: readonly ScheduleEntry[], rows: readonly ScheduleRow[], now: number, open: ReadonlyMap<string, number>, held: boolean): ScheduleView[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return entries.map(entry => {
    const row = byId.get(entry.id), anchor = row?.anchor ?? now, next = anchor + parseEvery(entry.every), openTask = open.get(entry.id);
    const state: ScheduleState = row?.paused ? "paused" : now < next ? "scheduled" : held ? "held" : openTask !== undefined ? "waiting" : "due";
    return {
      id: entry.id, every: entry.every, class: entry.class, queue: entry.queue, next, state,
      ...(row?.last_run != null ? { last: row.last_run } : {}), ...(openTask !== undefined ? { task: openTask } : row?.last_task != null ? { task: row.last_task } : {}),
      ...(row?.coalesced ? { coalesced: row.coalesced } : {}), ...(row?.last_error ? { error: row.last_error } : {}),
    };
  });
}

/** The detail of a scheduled task: the marker line first, then the person's text and the sources it names, all fixed words around config text. */
export function scheduledDetail(entry: ScheduleEntry): string {
  return [`${SCHEDULE_MARKER}${entry.id}`, `Scheduled every ${entry.every} by the machine-local schedule "${entry.id}".`, ...(entry.detail ? ["", entry.detail] : []),
    ...(entry.sources?.length ? ["", ...entry.sources.map(id => `Source: ${id}`)] : [])].join("\n");
}

export const scheduleKeyOf = (detail: string | undefined): string | undefined => detail?.startsWith(SCHEDULE_MARKER) ? detail.slice(SCHEDULE_MARKER.length).split("\n")[0] : undefined;
