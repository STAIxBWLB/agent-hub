import type { Database } from "./db-schema.ts";
import { openHubDatabase } from "./db-schema.ts";
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
  /** Exactly one of `every` and `cron` (#1017). */
  every?: string;
  /** The five cron fields, single-spaced (`parseCron` checked them). */
  cron?: string;
  /** An IANA zone for `cron`; without it the machine's own zone (`scheduleZone`). */
  tz?: string;
  class: string;
  title: string;
  detail?: string;
  sources?: string[];
  owner?: string;
  queue: "backlog" | "ready";
}

/** The source id form of `src/hub/sources.ts` (`validSourceId`), repeated here because that module reaches the file system and the converters and this one is bundled into the Claude channel server through the config schema; `test/schedules.test.ts` pins that the two agree. */
export const SOURCE_ID = /^src:[0-9a-f]{16}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/, PEER = /^[a-z][a-z0-9-]{0,31}$/, CLASS = /^[a-z][a-z0-9_]{0,47}$/, KEYS = new Set(["id", "every", "cron", "tz", "class", "title", "detail", "sources", "owner", "queue"]);
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

// agent-hub #1017: calendar-anchored schedules. Spec: "Calendar-anchored schedules (#1017)". Pure: a cron expression and a zone in, instants out, on `Intl` and `Date` only (zero runtime
// dependencies). Every function takes the time it works from, so a test pins a fixed clock.

/** The five fields, each as the sorted values it allows. `domStar` and `dowStar`: the field began with `*`, which the day rule below reads. */
export interface CronSpec { minutes: number[]; hours: number[]; doms: number[]; months: number[]; dows: number[]; domStar: boolean; dowStar: boolean }
const CRON_FIELDS = [{ name: "minute", min: 0, max: 59 }, { name: "hour", min: 0, max: 23 }, { name: "day of month", min: 1, max: 31 }, { name: "month", min: 1, max: 12 }, { name: "day of week", min: 0, max: 7 }] as const;
export const MAX_CRON_LENGTH = 100;
/**
 * One Gregorian cycle: the calendar, and so every day-of-month, month and weekday pattern, repeats exactly every 146097 days (400 years, a whole number of weeks). Scanning that far makes
 * both questions complete: an expression that never fires has no matching day in it, and one that fires at all fires inside it from any start (a Feb 29 that is a Sunday recurs
 * 28 to 40 years apart). The cost is only paid by a sparse expression: a common one stops at its first match.
 */
const CRON_HORIZON_DAYS = 146_097;
const DAY_MS = 86_400_000, MIN_MS = 60_000;

function cronField(text: string, name: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match || (match[2] !== undefined && match[3] === undefined && match[4] !== undefined)) throw new Error(`cron ${name} must be numbers, ranges (a-b), lists (a,b) and steps (*/n or a-b/n)`);
    const from = match[1] ? min : Number(match[2]), to = match[1] ? max : match[3] !== undefined ? Number(match[3]) : from, step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < min || to > max || from > to) throw new Error(`cron ${name} is ${min} to ${max}, and a range runs upward`);
    if (step < 1) throw new Error(`cron ${name} step must be at least 1`);
    for (let value = from; value <= to; value += step) values.add(name === "day of week" && value === 7 ? 0 : value);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * The standard five fields (minute, hour, day of month, month, day of week): numbers, lists, ranges and steps; day of week 0 and 7 are Sunday. No seconds, no year, no `@` macro, no names.
 * A day matches when both day fields are restricted and EITHER matches, or when one of them begins with `*` and BOTH match (the classic cron rule); month always has to match.
 */
export function parseCron(expression: unknown): CronSpec {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("cron is five fields: minute hour day-of-month month day-of-week");
  if (expression.length > MAX_CRON_LENGTH || /[^\x20-\x7e]/.test(expression)) throw new Error(`cron is at most ${MAX_CRON_LENGTH} printable characters`);
  if (expression.trim().startsWith("@")) throw new Error("cron takes the five fields, not an @ macro");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron is exactly five fields (minute hour day-of-month month day-of-week), not ${fields.length}; seconds and a year are not supported`);
  const [minutes, hours, doms, months, dows] = CRON_FIELDS.map((field, index) => cronField(fields[index]!, field.name, field.min, field.max)) as [number[], number[], number[], number[], number[]];
  return { minutes, hours, doms, months, dows, domStar: fields[2]!.startsWith("*"), dowStar: fields[4]!.startsWith("*") };
}
/** The expression as stored: the same five fields, single-spaced. */
export const cronText = (expression: string): string => expression.trim().split(/\s+/).join(" ");

function dayMatches(spec: CronSpec, dayMs: number): boolean {
  const date = new Date(dayMs);
  if (!spec.months.includes(date.getUTCMonth() + 1)) return false;
  const dom = spec.doms.includes(date.getUTCDate()), dow = spec.dows.includes(date.getUTCDay());
  return spec.domStar || spec.dowStar ? dom && dow : dom || dow;
}

/**
 * The smallest gap, in minutes, between two fires of the expression on the calendar itself (a wall clock with no zone), or undefined when no day of a full 400-year Gregorian cycle matches (`0 0 31 2 *`).
 * Daylight saving can still move two fires closer on its one change day (a skipped time runs at the first valid minute); a schedule proposes at most one task per pass and none while its
 * previous task is open, so that costs no flood.
 */
export function cronMinGapMinutes(spec: CronSpec): number | undefined {
  const times = spec.hours.flatMap(hour => spec.minutes.map(minute => hour * 60 + minute));
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i]! - times[i - 1]!);
  const start = Date.UTC(2024, 0, 1);
  let any = false, consecutive = false, before = false;
  for (let day = 0; day < CRON_HORIZON_DAYS; day++) {
    const now = dayMatches(spec, start + day * DAY_MS);
    any ||= now;
    if (now && before) consecutive = true;
    before = now;
  }
  if (!any) return undefined;
  return Math.min(gap, consecutive ? 1440 - times[times.length - 1]! + times[0]! : Infinity);
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(zone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    if (zoneFormats.size >= 64) zoneFormats.clear();
    zoneFormats.set(zone, format);
  }
  return format;
}
/** An IANA zone name the runtime knows, as it spells it (`utc` is `UTC`), or a thrown reason. */
export function checkZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) throw new Error("tz is an IANA zone name such as Asia/Seoul or America/New_York");
  try { return zoneFormat(value).resolvedOptions().timeZone; } catch { throw new Error("tz is not a zone this machine knows; use an IANA name such as Asia/Seoul or America/New_York"); }
}
/** The zone a schedule's `cron` is read in: its `tz`, else this machine's own. */
export function scheduleZone(entry: Pick<ScheduleEntry, "tz">): string {
  if (entry.tz) return entry.tz;
  try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The wall clock of an instant in a zone, as milliseconds on a zone-less calendar (the calendar read as UTC). */
function wallOf(zone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of zoneFormat(zone).formatToParts(instant)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
}
/**
 * The instant a wall-clock minute happens in a zone. A time that happens twice (the clock went back) is its first occurrence, so a repeated time runs once; a time that never happens
 * (the clock jumped forward) is the first minute that does, so a skipped time still runs.
 */
function instantOf(zone: string, wall: number): number {
  const offset = (instant: number) => wallOf(zone, instant) - Math.floor(instant / 1000) * 1000;
  const tried = new Set<number>(), found: number[] = [];
  for (const guess of [offset(wall - DAY_MS), offset(wall + DAY_MS), offset(wall)]) {
    if (tried.has(guess)) continue;
    tried.add(guess);
    if (wallOf(zone, wall - guess) === wall) found.push(wall - guess);
  }
  if (found.length) return Math.min(...found);
  // A gap: the first minute whose wall clock has reached the skipped time. No zone's offset moves by 30 hours, so this window holds the one change.
  let low = Math.floor((wall - 30 * 3_600_000) / MIN_MS), high = Math.ceil((wall + 30 * 3_600_000) / MIN_MS);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (wallOf(zone, middle * MIN_MS) >= wall) high = middle; else low = middle;
  }
  return high * MIN_MS;
}

/** The first wall-clock minute strictly after `wall` that the expression allows, or undefined when no day of a full cycle matches. */
function nextWall(spec: CronSpec, wall: number): number | undefined {
  const from = wall - (wall % MIN_MS) + MIN_MS, firstDay = from - (from % DAY_MS), floor = (from - firstDay) / MIN_MS;
  for (let day = 0; day < CRON_HORIZON_DAYS; day++) {
    const dayMs = firstDay + day * DAY_MS;
    if (!dayMatches(spec, dayMs)) continue;
    for (const hour of spec.hours) for (const minute of spec.minutes) if (hour * 60 + minute >= (day === 0 ? floor : 0)) return dayMs + (hour * 60 + minute) * MIN_MS;
  }
  return undefined;
}

/**
 * The next fire strictly after `after` (epoch ms), or undefined when none exists (no day of a full 400-year cycle matches). Fires are found on the zone's wall clock and then placed on the timeline by
 * `instantOf`: a repeated wall time fires once, and a fire the clock skipped fires at the first valid minute.
 */
export function cronNext(spec: CronSpec, zone: string, after: number): number | undefined {
  let wall = wallOf(zone, after);
  wall -= wall % MIN_MS;
  for (let guard = 0; guard < 2000; guard++) {
    const next = nextWall(spec, wall);
    if (next === undefined) return undefined;
    const instant = instantOf(zone, next);
    if (instant > after) return instant;
    wall = next;
  }
  return undefined;
}

/** `YYYY-MM-DD HH:mm` in a zone: how a person reads the next run of a calendar schedule. */
export function formatInZone(instant: number, zone: string): string {
  const iso = new Date(wallOf(zone, instant)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** How a view's period reads: `every 6h`, or `cron 30 7 * * 1-5 (Asia/Seoul)`. */
export const schedulePeriodText = (view: { every?: string; cron?: string; zone?: string }): string => view.cron !== undefined ? `cron ${view.cron}${view.zone ? ` (${view.zone})` : ""}` : `every ${view.every ?? "?"}`;
/** An instant as a person reads a schedule's next run: in the zone of a `cron` (`2026-11-02 07:30 Asia/Seoul`), else UTC like every other time in the CLI. */
export function scheduleWhen(view: { zone?: string }, instant: number): string {
  if (view.zone) { try { return `${formatInZone(instant, view.zone)} ${view.zone}`; } catch { /* an unknown zone falls through to UTC */ } }
  return `${new Date(instant).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

const parsedCrons = new Map<string, CronSpec>();
function cronSpec(expression: string): CronSpec {
  let spec = parsedCrons.get(expression);
  if (!spec) {
    spec = parseCron(expression);
    if (parsedCrons.size >= 256) parsedCrons.clear();
    parsedCrons.set(expression, spec);
  }
  return spec;
}
/** The next time a schedule is due, given the start of its period: `every` after the anchor, or the next calendar fire of its `cron` after it. Far in the future when a cron has none. */
export function scheduleNext(entry: Pick<ScheduleEntry, "every" | "cron" | "tz">, anchor: number): number {
  if (entry.cron !== undefined) return cronNext(cronSpec(entry.cron), scheduleZone(entry), anchor) ?? Number.MAX_SAFE_INTEGER;
  return anchor + parseEvery(entry.every);
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
    if (row.every !== undefined && row.cron !== undefined) bad("give every or cron, not both");
    if (row.every === undefined && row.cron === undefined) bad("every must be <n>m, <n>h or <n>d, or give cron (five fields)");
    if (row.tz !== undefined && row.cron === undefined) bad("tz applies to cron only");
    let cron: string | undefined, tz: string | undefined;
    if (row.cron !== undefined) {
      try {
        const spec = parseCron(row.cron), gap = cronMinGapMinutes(spec);
        if (gap === undefined) bad("cron never fires: no calendar day matches it");
        if (gap! < MIN_EVERY_MS / MIN_MS) bad(`cron can fire every ${gap} minute${gap === 1 ? "" : "s"}; the minimum is ${MIN_EVERY_MS / MIN_MS} minutes`);
        cron = cronText(row.cron as string);
        if (row.tz !== undefined) tz = checkZone(row.tz);
      } catch (error) { bad((error as Error).message.replace(/^schedules[.[][^:]*: /, "")); }
    } else {
      try { parseEvery(row.every); } catch (error) { bad((error as Error).message); }
    }
    if (typeof row.class !== "string" || !CLASS.test(row.class)) bad("class is required");
    if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 || control.test(row.title)) bad("title is 1 to 300 printable characters on one line");
    if (row.detail !== undefined && (typeof row.detail !== "string" || row.detail.length > MAX_SCHEDULE_DETAIL || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.detail))) bad(`detail is text of at most ${MAX_SCHEDULE_DETAIL} characters`);
    if (row.owner !== undefined && (typeof row.owner !== "string" || !PEER.test(row.owner))) bad("owner is a peer id");
    if (row.queue !== undefined && row.queue !== "backlog" && row.queue !== "ready") bad('queue is "backlog" or "ready"');
    if (row.sources !== undefined) {
      if (!Array.isArray(row.sources) || row.sources.length > MAX_SCHEDULE_SOURCES || !row.sources.every(id => typeof id === "string" && SOURCE_ID.test(id))) bad(`sources is a list of at most ${MAX_SCHEDULE_SOURCES} source ids (src:<16 hex>)`);
    }
    out.push({
      id: row.id as string, ...(cron !== undefined ? { cron, ...(tz !== undefined ? { tz } : {}) } : { every: row.every as string }), class: row.class as string, title: (row.title as string).replace(/\s+/g, " ").trim(),
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
export interface FolderRunResult { id: string; outcome: "baseline" | "ran" | "none" | "held" | "refused" | "failed"; tasks: number[]; files: number; reason?: string; more?: true }
/**
 * One file a poll found: its real path, name, size, mtime and SHA-256, and never its bytes (a scan of a big inbox would hold them all). `seen` marks a file the trigger
 * already recorded at this path, size and mtime: its hash is the recorded one and the file was not read again.
 */
export interface ScannedFile { real: string; name: string; size: number; mtime: number; sha256: string; seen?: true }
/** What a read of a trigger's folder gave. `refused` is the reason the folder may not be read; `truncated` says the hash budget ran out and some files wait for the next poll. */
export interface FolderScan { folder?: string; files: ScannedFile[]; skipped: { name: string; reason: string }[]; refused?: string; truncated: boolean }
/** The part of the folder state `Tasks` needs. The scan, the disk and the table are in `folder-trigger.ts`, which the Claude channel bundle must not reach. */
export interface FolderStorePort {
  baselined(trigger: string): boolean;
  begin(trigger: string, now: number): void;
  markBaselined(trigger: string, now: number): void;
  polled(trigger: string, now: number, error?: string): void;
  isNew(trigger: string, sha256: string): boolean;
  record(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, task: number | null, now: number): void;
  observe(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, now: number): void;
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
    this.db = openHubDatabase(dbPath, { create: true });
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
  /** `every` or `cron`, never both; `zone` is the zone a `cron` is read in (its `tz`, else the machine's), so a person reads the next run with it (#1017). */
  every?: string;
  cron?: string;
  zone?: string;
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
    const row = byId.get(entry.id), anchor = row?.anchor ?? now, next = scheduleNext(entry, anchor), openTask = open.get(entry.id);
    const state: ScheduleState = row?.paused ? "paused" : now < next ? "scheduled" : held ? "held" : openTask !== undefined ? "waiting" : "due";
    return {
      id: entry.id, ...(entry.cron !== undefined ? { cron: entry.cron, zone: scheduleZone(entry) } : { every: entry.every }), class: entry.class, queue: entry.queue, next, state,
      ...(row?.last_run != null ? { last: row.last_run } : {}), ...(openTask !== undefined ? { task: openTask } : row?.last_task != null ? { task: row.last_task } : {}),
      ...(row?.coalesced ? { coalesced: row.coalesced } : {}), ...(row?.last_error ? { error: row.last_error } : {}),
    };
  });
}

/** The detail of a scheduled task: the marker line first, then the person's text and the sources it names, all fixed words around config text. */
export function scheduledDetail(entry: ScheduleEntry): string {
  const when = entry.cron !== undefined ? `on the calendar "${entry.cron}" (${scheduleZone(entry)})` : `every ${entry.every}`;
  return [`${SCHEDULE_MARKER}${entry.id}`, `Scheduled ${when} by the machine-local schedule "${entry.id}".`, ...(entry.detail ? ["", entry.detail] : []),
    ...(entry.sources?.length ? ["", ...entry.sources.map(id => `Source: ${id}`)] : [])].join("\n");
}

export const scheduleKeyOf = (detail: string | undefined): string | undefined => detail?.startsWith(SCHEDULE_MARKER) ? detail.slice(SCHEDULE_MARKER.length).split("\n")[0] : undefined;
