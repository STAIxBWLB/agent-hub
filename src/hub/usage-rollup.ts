import type { Database } from "./db-schema.ts";
import { openHubDatabase } from "./db-schema.ts";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * The usage roll-up (#683 U2): `events.jsonl` folded into `hub.db`, so a view never rescans the whole log.
 *
 * - `usage_rollup`: one row per day, peer, model, source and task, summing the provider-reported counters of the `usage` events.
 * - `token_rollup`: one row per day, peer and task for the hub's own `tokens` increments, which exist for every peer (Jcode and Kimi report no usage record).
 * - Issue, PR and release are never stored: they are joined from the board's current links at query time (`TaskLinks`), so a task linked later is
 *   grouped under its issue for the history it already spent.
 * - `limit_events`: every `budget_pause`, `budget_resume` and `quota_reset` event, in order.
 * - `rollup_state`: the byte offset up to which the log was folded, and the time of the first event.
 *
 * A pass reads at most `maxBytesPerPass` from the stored offset, keeps only whole lines, and commits the rows and the new offset in one
 * transaction, so a crash repeats a pass and never half-applies one. `rebuild()` folds the log from byte 0 and must give the same rows
 * (tested). Counters are never zero when unknown: each sum has a `_n` count of the records that carried it, and a view shows `unknown`
 * where that count is 0.
 *
 * ponytail: the day is the UTC day of the event time; one pass is capped at 8 MiB. Ceiling: a log far past the cap needs several polls to
 * catch up, which `poll()` reports through `done: false`, never as a failure.
 */

export type UsageGroup = "peer" | "task" | "issue" | "pr" | "release" | "day" | "model";
export const USAGE_GROUPS: readonly UsageGroup[] = ["peer", "task", "issue", "pr", "release", "day", "model"];
/** Where a number comes from (#285): the provider's own counter, a hub count, a person's entry, or nothing known. */
/** `partial`: a sum over several peers where at least one is unknown, so the value is a lower bound and never the whole. */
export type UsageSource = "native" | "count" | "manual" | "partial" | "unknown";
export interface Counter { value: number | null; source: UsageSource }

const KINDS = ["input", "output", "cache_read", "cache_write", "reasoning", "total"] as const;
type Kind = typeof KINDS[number];
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** No event line is this long; a longer one is corrupt and is skipped so it cannot stall the fold. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const NO_TASK = 0;

/** The board's current links of a task, supplied by the host at query time. 0 or undefined means none. */
export type TaskLinks = (task: number) => { issue?: number; pr?: number; release?: number } | undefined;

/** `task`: only the records of this task (a positive task id); with `by: "peer"` it is that task's tokens per peer. */
export interface UsageQuery { by: UsageGroup; since?: number; until?: number; task?: number }
export interface UsageRow {
  key: string;
  /** `[pii]` for a private task: its id and numbers only, never a title. */
  label?: string;
  pii?: true;
  records: number;
  /** The hub's own token increments for the same key (`tokens` events): the number `ahub report --by task` shows as a peer's tokens. Unknown for `model`. */
  counted: Counter;
  input: Counter; output: Counter; cacheRead: Counter; cacheWrite: Counter; reasoning: Counter; total: Counter;
  /** Total with the cache reads left out (`total` minus `cacheRead`, only when both are known). */
  totalWithoutCache: Counter;
}
/** `taskPii`: the filtered task is private, so the console shows `[pii]` for it (ids and numbers only). */
export interface UsageResult { by: UsageGroup; since?: number; until?: number; task?: number; taskPii?: true; rows: UsageRow[]; unattributed?: UsageRow; coverage: { records: number; withUsage: number; withoutUsage: number }; throughOffset: number }

export interface LimitRow { at: string; type: "budget_pause" | "budget_resume" | "quota_reset"; peer: string; window: string; detail: Record<string, string | number> }
export interface OpenPause { peer: string; window: string; since: string; resetsAt: number }
/** `history` is the newest `shown` of `total` events: `truncated` says so, and `omitted` is how many older ones are not in it. `open` is held by the hub now;
 *  `endedUnknown` is a pause the events never closed and the hub no longer holds (cleared by `ahub reset`, which keeps the log byte for byte). */
export interface LimitsResult { history: LimitRow[]; total: number; shown: number; truncated: boolean; omitted: number; limit: number; maxLimit: number; open: OpenPause[]; endedUnknown: OpenPause[] }
export const LIMITS_DEFAULT = 200, LIMITS_MAX = 5000;
export interface TotalRow { peer: string; tokens: Counter; withoutCache: Counter; cacheRead: Counter; records: number; firstAt: string | null }
/** `unknownPeers`: the peers whose figure is unknown, which the overall figure then leaves out (so it is `partial`, a lower bound, never a sum that treats them as 0). */
export interface TotalResult { since: string | null; peers: TotalRow[]; overall: { tokens: Counter; withoutCache: Counter; cacheRead: Counter }; unknownPeers: { tokens: string[]; withoutCache: string[]; cacheRead: string[] } }

/** `empty`: no record at all for that UTC day (a gap), shown as an empty column and never as a zero. */
export interface DailyRow { day: string; peers: Record<string, Counter>; total: Counter; empty?: true }
export interface DailyResult { days: DailyRow[]; peers: string[] }

const sum = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : a + b;
const counter = (value: number | null, n: number, source: UsageSource = "native"): Counter => n > 0 && value !== null ? { value, source } : { value: null, source: "unknown" };

export class UsageRollup {
  private readonly db: Database;
  private closed = false;

  constructor(dbPath: string, private readonly eventsFile: string, private readonly opts: { maxBytesPerPass?: number } = {}) {
    this.db = openHubDatabase(dbPath, { create: true });
    const counters = KINDS.map(kind => `${kind} INTEGER NOT NULL DEFAULT 0, ${kind}_n INTEGER NOT NULL DEFAULT 0`).join(", ");
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_rollup (day TEXT NOT NULL, peer TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, task INTEGER NOT NULL,
      pii INTEGER NOT NULL, records INTEGER NOT NULL DEFAULT 0, with_usage INTEGER NOT NULL DEFAULT 0, ${counters}, PRIMARY KEY (day, peer, model, source, task, pii))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS token_rollup (day TEXT NOT NULL, peer TEXT NOT NULL, task INTEGER NOT NULL, pii INTEGER NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0, increments INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, peer, task, pii))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS limit_events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, peer TEXT NOT NULL, window TEXT NOT NULL, detail TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS rollup_state (id INTEGER PRIMARY KEY CHECK (id = 1), byte_offset INTEGER NOT NULL, first_at TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS rollup_seen (key TEXT PRIMARY KEY)`);
    /** A task the log has marked private stays private for every later record, even one written before the mark. */
    this.db.run(`CREATE TABLE IF NOT EXISTS rollup_pii (task INTEGER PRIMARY KEY)`);
    this.db.run(`INSERT OR IGNORE INTO rollup_state (id, byte_offset) VALUES (1, 0)`);
  }

  private state(): { offset: number; firstAt: string | null } {
    const row = this.db.query("SELECT byte_offset, first_at FROM rollup_state WHERE id = 1").get() as { byte_offset: number; first_at: string | null };
    return { offset: row.byte_offset, firstAt: row.first_at };
  }

  /**
   * Fold the next slice of the log. Whole lines only: a trailing partial line (a crash, or a write in flight) waits for the next pass.
   * A log that is shorter than the stored offset was replaced or reset, so the roll-up starts over from byte 0.
   */
  poll(maxMs = 20): { bytes: number; done: boolean } {
    const deadline = performance.now() + Math.max(0, Math.min(20, maxMs));
    if (this.closed) return { bytes: 0, done: true };
    if (!existsSync(this.eventsFile)) return { bytes: 0, done: true };
    const fd = openSync(this.eventsFile, "r");
    try {
      const size = fstatSync(fd).size;
      let { offset } = this.state();
      if (size < offset) { this.reset(); offset = 0; }
      if (size === offset) return { bytes: 0, done: true };
      // The cap bounds a pass, but one line is never split: a line longer than the cap makes this pass read on, up to MAX_LINE_BYTES, until it
      // holds a whole line, so a single large event can never stall the roll-up. A line past that bound is skipped as corrupt.
      let want = Math.min(size - offset, this.opts.maxBytesPerPass ?? DEFAULT_MAX_BYTES), buffer: Buffer, got = 0, end = -1;
      for (;;) {
        buffer = Buffer.alloc(want); got = 0;
        while (got < want) { const n = readSync(fd, buffer, got, want - got, offset + got); if (!n) break; got += n; }
        end = buffer.subarray(0, got).lastIndexOf(0x0a);
        if (end >= 0 || offset + want >= size) break;                 // a whole line, or the end of the file (a line still being written)
        if (want >= MAX_LINE_BYTES) {                                  // an unbounded line: skip what was read up to the next newline
          const next = this.skipLongLine(fd, offset, size);
          if (next === undefined) return { bytes: 0, done: true };
          const moved = this.db.transaction(() => { if (this.state().offset !== offset) return false; this.db.query("UPDATE rollup_state SET byte_offset = ? WHERE id = 1").run(next); return true; }).immediate();
          return moved ? { bytes: next - offset, done: next >= size } : { bytes: 0, done: false };
        }
        want = Math.min(size - offset, want * 2);
      }
      if (end < 0) return { bytes: 0, done: true };                    // the last line is still being written: it waits for the next pass
      let consumed = 0;
      // The offset was read before the slice was; another roll-up on this hub.db (a restart that overlaps the old process) may have folded the same
      // bytes since. The transaction takes the write lock first and checks the stored offset again: a pass whose start is stale is abandoned whole,
      // so a byte range is folded exactly once however many writers there are (found by a forced interleave: the counts doubled).
      const applied = this.db.transaction(() => {
        if (this.state().offset !== offset) return false;
        // Commit only complete processed records with their offset. Yield between records;
        // ponytail: one whole record and the existing corrupt-line skip are indivisible;
        // a streaming parser would be needed to preempt within either operation.
        for (let start = 0; start <= end;) {
          const newline = buffer.indexOf(0x0a, start);
          if (newline < 0 || newline > end) break;
          this.fold(buffer.subarray(start, newline).toString("utf8"));
          consumed = newline + 1; start = consumed;
          if (performance.now() >= deadline) break;
        }
        this.db.query("UPDATE rollup_state SET byte_offset = ? WHERE id = 1").run(offset + consumed);
        return true;
      }).immediate();
      if (!applied) return { bytes: 0, done: false };                   // stale: the next pass starts from the stored offset
      return { bytes: consumed, done: offset + consumed >= size };
    } finally { closeSync(fd); }
  }

  /** The offset just past the next newline at or after `from + MAX_LINE_BYTES`, or undefined when there is none yet (the line is still being written). */
  private skipLongLine(fd: number, from: number, size: number): number | undefined {
    const chunk = Buffer.alloc(64 * 1024);
    for (let at = from + MAX_LINE_BYTES; at < size;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at); if (!n) return undefined;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) return at + nl + 1;
      at += n;
    }
    return undefined;
  }

  /**
   * Fold everything now, in passes, the way a poll loop would. With `maxMs` it stops after that long and returns false: the roll-up is then behind the
   * log, and a caller must say so rather than present the folded part as the whole (on this project's 47 MB log a first full fold takes about 180 ms).
   */
  catchUp(maxMs?: number): boolean {
    const until = maxMs === undefined ? Infinity : Date.now() + maxMs;
    for (let i = 0; i < 100_000; i++) { if (this.poll(Math.min(20, until - Date.now())).done) return true; if (Date.now() >= until) return false; }
    return true;
  }

  /** Forget the roll-up and fold the log again from byte 0: the result must equal the incremental one. */
  rebuild(): void { this.reset(); this.catchUp(); }

  private reset(): void {
    this.db.transaction(() => { for (const table of ["usage_rollup", "token_rollup", "limit_events", "rollup_seen", "rollup_pii"]) this.db.run(`DELETE FROM ${table}`); this.db.run("UPDATE rollup_state SET byte_offset = 0, first_at = NULL WHERE id = 1"); })();
  }

  private day(at: string): string | undefined { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined; }

  private fold(line: string): void {
    if (!line.trim()) return;
    let e: any;
    try { e = JSON.parse(line); } catch { return; } // a line a crash cut short
    if (!e || typeof e !== "object" || typeof e.type !== "string" || typeof e.at !== "string") return;
    if (this.state().firstAt === null && Number.isFinite(Date.parse(e.at))) this.db.query("UPDATE rollup_state SET first_at = ? WHERE id = 1").run(e.at);
    switch (e.type) {
      case "task": return this.foldTask(e);
      case "usage": return this.foldUsage(e);
      case "tokens": return this.foldTokens(e);
      case "budget_pause": case "budget_resume": case "quota_reset": return this.foldLimit(e);
    }
  }

  /** Only the private mark is kept from a `task` event; the title and every other field stay out of the roll-up. */
  private foldTask(e: any): void {
    if (Number.isSafeInteger(e.id) && e.id > 0 && e.pii === true) this.db.query("INSERT OR IGNORE INTO rollup_pii (task) VALUES (?)").run(e.id);
  }

  private link(e: any): { task: number; pii: number } {
    const task = e.attribution !== "unattributed" && Number.isSafeInteger(e.task) && e.task > 0 ? e.task : NO_TASK;
    return { task, pii: e.pii === true ? 1 : 0 };
  }

  private foldUsage(e: any): void {
    const measured = typeof e.measuredAt === "string" ? e.measuredAt : e.at, day = this.day(measured);
    if (!day || typeof e.peer !== "string" || typeof e.source !== "string" || typeof e.id !== "string") return;
    // The same record is counted once, as `ahub report` counts it: by peer, source and id.
    const key = `${e.peer}\0${e.source}\0${e.id}`;
    if (this.db.query("SELECT 1 FROM rollup_seen WHERE key = ?").get(key)) return;
    this.db.run("INSERT INTO rollup_seen (key) VALUES (?)", [key]);
    const model = typeof e.servedModel === "string" && e.servedModel ? e.servedModel : typeof e.requestedModel === "string" && e.requestedModel ? e.requestedModel : "unknown";
    const known = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    // Claude's transcript counters are separate categories with no explicit total, so its total is their sum, as the hub's own `claudeReportedTokens`
    // defines it. Codex and the gateway report input that already contains the cached part: adding it again would double count, so no total is derived there.
    const derived = !known(e.totalTokens) && e.source === "claude_transcript" && known(e.inputTokens) && known(e.outputTokens)
      ? e.inputTokens + e.outputTokens + (known(e.cacheReadTokens) ? e.cacheReadTokens : 0) + (known(e.cacheWriteTokens) ? e.cacheWriteTokens : 0) : undefined;
    const fields: Record<Kind, unknown> = { input: e.inputTokens, output: e.outputTokens, cache_read: e.cacheReadTokens, cache_write: e.cacheWriteTokens, reasoning: e.reasoningTokens, total: known(e.totalTokens) ? e.totalTokens : derived };
    const withUsage = [e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.totalTokens].some(known) ? 1 : 0;
    const l = this.link(e);
    const params: Record<string, number | string> = { $day: day, $peer: e.peer, $model: model, $source: e.source, $task: l.task, $pii: l.pii, $with: withUsage };
    this.db.query(`INSERT OR IGNORE INTO usage_rollup (day, peer, model, source, task, pii) VALUES ($day, $peer, $model, $source, $task, $pii)`).run(params as any);
    const sets = ["records = records + 1", "with_usage = with_usage + $with"];
    for (const kind of KINDS) { const v = fields[kind]; if (known(v)) { sets.push(`${kind} = ${kind} + $${kind}`, `${kind}_n = ${kind}_n + 1`); params[`$${kind}`] = v; } }
    this.db.query(`UPDATE usage_rollup SET ${sets.join(", ")} WHERE day = $day AND peer = $peer AND model = $model AND source = $source AND task = $task AND pii = $pii`).run(params as any);
  }

  private foldTokens(e: any): void {
    const day = this.day(e.at);
    if (!day || typeof e.peer !== "string" || !Number.isSafeInteger(e.n) || e.n < 0) return;
    const l = this.link(e);
    this.db.query(`INSERT OR IGNORE INTO token_rollup (day, peer, task, pii) VALUES (?, ?, ?, ?)`).run(day, e.peer, l.task, l.pii);
    this.db.query(`UPDATE token_rollup SET tokens = tokens + ?, increments = increments + 1 WHERE day = ? AND peer = ? AND task = ? AND pii = ?`).run(e.n, day, e.peer, l.task, l.pii);
  }

  private foldLimit(e: any): void {
    if (typeof e.peer !== "string") return;
    const { type, at, peer, window: win, ...rest } = e;
    const detail: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(rest)) if (k !== "v" && (typeof v === "number" || (typeof v === "string" && k !== "reason"))) detail[k] = v as string | number;
    this.db.query("INSERT INTO limit_events (at, type, peer, window, detail) VALUES (?, ?, ?, ?, ?)").run(at, type, peer, typeof win === "string" ? win : "unknown", JSON.stringify(detail));
  }

  // ---- views ---------------------------------------------------------------------------------------------------------------------------

  private bounds(q: { since?: number; until?: number; task?: number }): { clause: string; params: (string | number)[] } {
    const parts: string[] = [], params: (string | number)[] = [];
    if (q.task !== undefined) { parts.push("task = ?"); params.push(q.task); }
    if (q.since !== undefined) { parts.push("day >= ?"); params.push(new Date(q.since).toISOString().slice(0, 10)); }
    if (q.until !== undefined) { parts.push("day <= ?"); params.push(new Date(q.until).toISOString().slice(0, 10)); }
    return { clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }

  /**
   * Group the counters. `task`, `issue`, `pr` and `release` group the same per-task rows; the last three are joined through `links` from the
   * board's current fields, and a task with no link falls under `unattributed` like a record with no task. A private task shows `#id` and
   * `[pii]`, never a title. `counted` is the hub's own token increments for the same key (unknown for `model`, which they do not carry).
   */
  query(q: UsageQuery, links?: TaskLinks): UsageResult {
    const { clause, params } = this.bounds(q);
    const sums = KINDS.map(kind => `SUM(${kind}) AS ${kind}, SUM(${kind}_n) AS ${kind}_n`).join(", ");
    const byTask = q.by === "task" || q.by === "issue" || q.by === "pr" || q.by === "release";
    const column = byTask ? "task" : q.by;
    const raw = this.db.query(`SELECT ${column} AS k, MAX(pii) AS pii, SUM(records) AS records, SUM(with_usage) AS with_usage, ${sums} FROM usage_rollup ${clause} GROUP BY ${column}`).all(...params) as any[];
    const countedRows = q.by === "model" ? [] : this.db.query(`SELECT ${column} AS k, MAX(pii) AS pii, SUM(tokens) AS tokens, SUM(increments) AS increments FROM token_rollup ${clause} GROUP BY ${column}`).all(...params) as any[];
    const privateTasks = new Set((this.db.query("SELECT task FROM rollup_pii").all() as { task: number }[]).map(r => r.task));
    const map = (task: number): string => {
      if (q.by === "task") return String(task);
      if (task === NO_TASK) return "0";
      const l = links?.(task)?.[q.by as "issue" | "pr" | "release"];
      return l ? String(l) : "0";
    };
    type Acc = { pii: boolean; records: number; withUsage: number; sums: Record<string, number>; ns: Record<string, number>; counted: number; countedN: number };
    const groups = new Map<string, Acc>();
    const acc = (key: string): Acc => { let g = groups.get(key); if (!g) groups.set(key, g = { pii: false, records: 0, withUsage: 0, sums: {}, ns: {}, counted: 0, countedN: 0 }); return g; };
    for (const r of raw) {
      const g = acc(byTask ? map(Number(r.k)) : String(r.k));
      g.pii ||= r.pii === 1 || (q.by === "task" && privateTasks.has(Number(r.k)));
      g.records += r.records; g.withUsage += r.with_usage;
      for (const kind of KINDS) { g.sums[kind] = (g.sums[kind] ?? 0) + (r[kind] ?? 0); g.ns[kind] = (g.ns[kind] ?? 0) + (r[`${kind}_n`] ?? 0); }
    }
    for (const r of countedRows) {
      const g = acc(byTask ? map(Number(r.k)) : String(r.k));
      g.pii ||= r.pii === 1 || (q.by === "task" && privateTasks.has(Number(r.k)));
      g.counted += r.tokens; g.countedN += r.increments;
    }
    const order = (a: string, b: string) => q.by === "day" || q.by === "model" || q.by === "peer" ? a.localeCompare(b) : Number(a) - Number(b);
    const rows: UsageRow[] = []; let unattributed: UsageRow | undefined;
    for (const key of [...groups.keys()].sort(order)) {
      const g = groups.get(key)!, c = (kind: Kind) => counter(g.sums[kind] ?? 0, g.ns[kind] ?? 0);
      const cacheRead = c("cache_read"), total = c("total");
      const pii = q.by === "task" && g.pii;
      const row: UsageRow = { key: pii ? `#${key}` : key, ...(pii ? { label: "[pii]", pii: true as const } : {}), records: g.records,
        counted: q.by === "model" ? { value: null, source: "unknown" } : g.countedN > 0 ? { value: g.counted, source: "count" } : { value: null, source: "unknown" },
        input: c("input"), output: c("output"), cacheRead, cacheWrite: c("cache_write"), reasoning: c("reasoning"), total,
        totalWithoutCache: total.value !== null && cacheRead.value !== null ? { value: total.value - cacheRead.value, source: "native" } : total.value !== null && g.ns.cache_read === 0 ? { value: total.value, source: "native" } : { value: null, source: "unknown" } };
      if (byTask && key === "0") { row.key = "unattributed"; delete (row as { label?: string }).label; unattributed = row; } else rows.push(row);
    }
    const cover = raw.reduce((a, r) => ({ records: a.records + r.records, withUsage: a.withUsage + r.with_usage }), { records: 0, withUsage: 0 });
    const taskPii = q.task !== undefined && (privateTasks.has(q.task) || raw.some(r => r.pii === 1) || countedRows.some(r => r.pii === 1));
    return { by: q.by, ...(q.since !== undefined ? { since: q.since } : {}), ...(q.until !== undefined ? { until: q.until } : {}), ...(q.task !== undefined ? { task: q.task } : {}), ...(taskPii ? { taskPii: true as const } : {}), rows, ...(unattributed ? { unattributed } : {}),
      coverage: { ...cover, withoutUsage: cover.records - cover.withUsage }, throughOffset: this.state().offset };
  }

  /**
   * `live`: the peers whose pause the hub holds right now. An event-open pause for any other peer is not open: `ahub reset` clears the pause record
   * and leaves `events.jsonl` unchanged, so no `budget_resume` follows, and it is listed as `endedUnknown` instead of staying open forever.
   * Without `live` every event-open pause is open. History is the newest `limit` events (at most LIMITS_MAX) and says when it is cut.
   */
  limits(peer?: string, opts: { limit?: number; live?: ReadonlySet<string> } = {}): LimitsResult {
    const limit = opts.limit ?? LIMITS_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS_MAX) throw new Error(`limit is an integer from 1 to ${LIMITS_MAX}`);
    const where = peer ? "WHERE peer = ?" : "";
    const total = (this.db.query(`SELECT COUNT(*) AS n FROM limit_events ${where}`).get(...(peer ? [peer] : [])) as { n: number }).n;
    const rows = this.db.query(`SELECT at, type, peer, window, detail FROM limit_events ${where} ORDER BY seq DESC LIMIT ?`).all(...(peer ? [peer, limit] : [limit])) as any[];
    const history = rows.reverse().map(r => ({ at: r.at, type: r.type, peer: r.peer, window: r.window, detail: JSON.parse(r.detail) as Record<string, string | number> }));
    // A pause with no later resume for its peer is still open, unless a later pause of the same peer replaced it.
    const pending = new Map<string, OpenPause>();
    for (const r of this.db.query(`SELECT at, type, peer, window, detail FROM limit_events WHERE type IN ('budget_pause','budget_resume') ${peer ? "AND peer = ?" : ""} ORDER BY seq`).all(...(peer ? [peer] : [])) as any[]) {
      if (r.type === "budget_pause") pending.set(r.peer, { peer: r.peer, window: r.window, since: r.at, resetsAt: JSON.parse(r.detail).resetsAt ?? 0 });
      else pending.delete(r.peer);
    }
    const open: OpenPause[] = [], endedUnknown: OpenPause[] = [];
    for (const p of pending.values()) (opts.live && !opts.live.has(p.peer) ? endedUnknown : open).push(p);
    return { history, total, shown: history.length, truncated: total > history.length, omitted: total - history.length, limit, maxLimit: LIMITS_MAX, open, endedUnknown };
  }

  /**
   * Lifetime development tokens since the first event, per peer and overall. A peer's number is the provider's own `totalTokens` when it reported
   * any (`native`), otherwise the hub's own token increments (`count`: what the hub counted, never claimed as the provider's), otherwise unknown.
   * "Without cache reads" is known only where the cache reads are: a `count` number carries no breakdown, so it has no such figure.
   * The overall number is `native` only when every peer is; one `count` peer makes it `count`, since a sum is as weak as its weakest part; an unknown peer makes it
   * `partial` (a lower bound) with that peer listed, never a figure that counts it as 0.
   */
  total(): TotalResult {
    const peers = this.db.query(`SELECT peer, SUM(records) AS records, SUM(total) AS total, SUM(total_n) AS total_n, SUM(cache_read) AS cr, SUM(cache_read_n) AS cr_n FROM usage_rollup GROUP BY peer ORDER BY peer`).all() as any[];
    const tok = new Map((this.db.query(`SELECT peer, SUM(tokens) AS tokens FROM token_rollup GROUP BY peer`).all() as any[]).map(r => [r.peer as string, r.tokens as number]));
    const names = new Set<string>([...peers.map(p => p.peer as string), ...tok.keys()]);
    const unknown: Counter = { value: null, source: "unknown" };
    const out: TotalRow[] = [];
    for (const peer of [...names].sort()) {
      const p = peers.find(row => row.peer === peer);
      const native = p && p.total_n > 0 ? counter(p.total, p.total_n) : undefined, counted = tok.get(peer);
      const tokens: Counter = native ?? (counted !== undefined ? { value: counted, source: "count" } : unknown);
      const cacheRead = p ? counter(p.cr, p.cr_n) : unknown;
      const withoutCache: Counter = tokens.source === "native" && tokens.value !== null && cacheRead.value !== null ? { value: tokens.value - cacheRead.value, source: "native" }
        : tokens.source === "native" && tokens.value !== null && p && p.cr_n === 0 ? { value: tokens.value, source: "native" } : unknown;
      out.push({ peer, tokens, withoutCache, cacheRead, records: p?.records ?? 0, firstAt: this.state().firstAt });
    }
    const unknownPeers = (pick: (r: TotalRow) => Counter) => out.filter(r => pick(r).value === null).map(r => r.peer);
    // The overall figure never treats an unknown peer as 0: when any peer is unknown the sum is `partial` (a lower bound, the unknown peers listed in
    // `unknownPeers`); with nobody known it is unknown. A without-cache figure needs every peer's cache split, so one unknown peer makes it unknown.
    const fold = (pick: (r: TotalRow) => Counter, strict: boolean): Counter => {
      const known = out.map(pick).filter(c => c.value !== null);
      if (!known.length || (strict && known.length !== out.length)) return unknown;
      return { value: known.reduce((a, c) => a + c.value!, 0), source: known.length !== out.length ? "partial" : known.every(c => c.source === "native") ? "native" : "count" };
    };
    return { since: this.state().firstAt, peers: out, overall: { tokens: fold(r => r.tokens, false), withoutCache: fold(r => r.withoutCache, true), cacheRead: fold(r => r.cacheRead, false) },
      unknownPeers: { tokens: unknownPeers(r => r.tokens), withoutCache: unknownPeers(r => r.withoutCache), cacheRead: unknownPeers(r => r.cacheRead) } };
  }

  /**
   * Daily tokens per peer for the last `days` calendar UTC days up to `now`, stacked for the dashboard Usage view (#683 U4).
   * For each day and peer, tokens is native when reported, counted increments when available, otherwise unknown. A day inside
   * the window with no record is an `empty` row (a gap the chart shows), and the window never starts before the first record.
   */
  daily(days = 14, now: number = Date.now()): DailyResult {
    const raw = this.db.query(`SELECT day, peer, SUM(total) AS total, SUM(total_n) AS total_n FROM usage_rollup GROUP BY day, peer ORDER BY day ASC`).all() as any[];
    const counted = this.db.query(`SELECT day, peer, SUM(tokens) AS tokens, SUM(increments) AS increments FROM token_rollup GROUP BY day, peer ORDER BY day ASC`).all() as any[];
    const usageMap = new Map<string, { total: number; total_n: number }>();
    for (const r of raw) usageMap.set(`${r.day}\0${r.peer}`, { total: r.total, total_n: r.total_n });
    const countMap = new Map<string, { tokens: number; increments: number }>();
    for (const r of counted) countMap.set(`${r.day}\0${r.peer}`, { tokens: r.tokens, increments: r.increments });

    const allDays = [...new Set([...raw.map(r => r.day as string), ...counted.map(r => r.day as string)])].sort();
    const allPeers = [...new Set([...raw.map(r => r.peer as string), ...counted.map(r => r.peer as string)])].sort();
    // The last `days` calendar days ending today, clipped to the first day that has any record.
    const dayMs = 86_400_000, today = new Date(now).toISOString().slice(0, 10);
    const sliceDays: string[] = [];
    if (allDays.length) for (let i = Math.max(1, Math.min(days, 366)) - 1; i >= 0; i--) {
      const day = new Date(Date.parse(today + "T00:00:00Z") - i * dayMs).toISOString().slice(0, 10);
      if (day >= allDays[0]!) sliceDays.push(day);
    }

    const resultDays: DailyRow[] = [];
    for (const d of sliceDays) {
      const peerCounters: Record<string, Counter> = {};
      const knownCounters: Counter[] = [];
      for (const p of allPeers) {
        const u = usageMap.get(`${d}\0${p}`);
        const c = countMap.get(`${d}\0${p}`);
        let counterVal: Counter = { value: null, source: "unknown" };
        if (u && u.total_n > 0) {
          counterVal = counter(u.total, u.total_n);
        } else if (c && c.increments > 0) {
          counterVal = { value: c.tokens, source: "count" };
        }
        peerCounters[p] = counterVal;
        if (counterVal.value !== null) knownCounters.push(counterVal);
      }
      let dayTotal: Counter = { value: null, source: "unknown" };
      if (knownCounters.length > 0) {
        const sumVal = knownCounters.reduce((acc, cur) => acc + cur.value!, 0);
        const source: UsageSource = knownCounters.length !== allPeers.length
          ? "partial"
          : knownCounters.every(cur => cur.source === "native")
          ? "native"
          : "count";
        dayTotal = { value: sumVal, source };
      }
      resultDays.push({ day: d, peers: peerCounters, total: dayTotal, ...(!allDays.includes(d) ? { empty: true as const } : {}) });
    }
    return { days: resultDays, peers: allPeers };
  }

  /** Every roll-up row, in key order, for the rebuild-equals-incremental test. */
  dump(): unknown {
    const all = (table: string, order: string) => this.db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    return { usage: all("usage_rollup", "day, peer, model, source, task, pii"), tokens: all("token_rollup", "day, peer, task, pii"), pii: all("rollup_pii", "task"),
      limits: this.db.query("SELECT at, type, peer, window, detail FROM limit_events ORDER BY seq").all(), offset: this.state().offset };
  }

  close(): void { this.closed = true; try { this.db.close(); } catch { /* already closed */ } }
}
