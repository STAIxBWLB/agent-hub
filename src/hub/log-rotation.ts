import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * #1546: size-based rotation for `events.jsonl` and `hub.log`.
 *
 * A rotated segment is named `<file>.<start>`, where `start` is the byte offset, in the one stream the segments and the live file make together, of the segment's first byte. The live file is always
 * the newest bytes, so its start is the end of the newest segment. Reading the segments oldest first and then the live file gives exactly the lines the unrotated file would have held, and a byte
 * offset in that stream keeps its meaning when the live file is rotated away or the oldest segment is dropped: a reader that persisted an offset (the usage roll-up, the research tail) needs no
 * translation. A segment of the event log always ends in a newline (a crash-cut last line is terminated before the move), so no line spans two files.
 *
 * Operational limits: an event segment is 64 MiB and three are kept, hub.log keeps two of 16 MiB. ponytail: constants, not settings; the upgrade path is config keys once a project needs other bounds.
 */
export const EVENTS_SEGMENT_BYTES = 64 * 1024 * 1024;
export const EVENTS_SEGMENTS_KEPT = 3;
export const HUB_LOG_SEGMENT_BYTES = 16 * 1024 * 1024;
export const HUB_LOG_SEGMENTS_KEPT = 2;

export interface Segment { path: string; start: number; size: number; live: boolean }

/** Every segment of `file`, oldest first, the live file last when it exists. */
export function segmentsOf(file: string): Segment[] {
  const dir = dirname(file), prefix = `${basename(file)}.`;
  let names: string[];
  try { names = readdirSync(dir); } catch { names = []; }
  const rotated: Segment[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const digits = /^(0|[1-9][0-9]{0,15})$/.exec(name.slice(prefix.length));
    if (!digits) continue;
    const path = join(dir, name);
    try { const stat = statSync(path); if (stat.isFile()) rotated.push({ path, start: Number(digits[1]), size: stat.size, live: false }); } catch { /* removed while listing */ }
  }
  rotated.sort((a, b) => a.start - b.start);
  const last = rotated[rotated.length - 1];
  const start = last ? last.start + last.size : 0;
  try { const stat = statSync(file); if (stat.isFile()) rotated.push({ path: file, start, size: stat.size, live: true }); } catch { /* no live file yet */ }
  return rotated;
}

/** The offset just past the last byte of the stream: where the next appended byte lands. */
export const streamEnd = (segments: readonly Segment[]): number => { const last = segments[segments.length - 1]; return last ? last.start + last.size : 0; };

/** Whether the file's last byte is something other than a newline. */
function endsMidLine(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally { closeSync(fd); }
}

export interface RotateOptions {
  /** Rotated segments kept besides the live file (at least 1). */
  keep: number;
  /** `rename` moves the live file (nothing else holds it open); `copytruncate` copies it and truncates it in place, for a file a child process also holds open for append. */
  mode: "rename" | "copytruncate";
  /** Why the oldest segment must stay (it holds something still needed), or undefined when it may go. Asked only when the oldest segment would be dropped. */
  keepOldest?: (oldest: Segment) => string | undefined;
  /** Called right after a segment's file is removed, so a holder of state derived from it (the reviewer-accounting journal) can drop it too even when a later step throws. */
  onDrop?: (segment: Segment) => void;
}
export interface RotateResult { rotated: boolean; dropped: Segment[]; kept?: { segment: Segment; reason: string } }

/**
 * Move the live file to `<file>.<start>`, and drop the oldest segment when `keep` segments already exist and `keepOldest` allows it. A segment that is kept makes the log grow past `keep` until its reason
 * ends: nothing an open task needs is ever dropped. Not safe against a second rotator on one file: the daemon is the only one.
 */
export function rotateSegments(file: string, options: RotateOptions): RotateResult {
  if (!Number.isSafeInteger(options.keep) || options.keep < 1) throw new Error("rotation must keep at least one segment; pass keep >= 1");
  const all = segmentsOf(file), live = all[all.length - 1];
  if (!live?.live || live.size === 0) return { rotated: false, dropped: [] };
  const rotated = all.filter(segment => !segment.live);
  const result: RotateResult = { rotated: false, dropped: [] };
  if (options.mode === "rename" && endsMidLine(file)) { appendFileSync(file, "\n"); live.size += 1; }
  const target = `${file}.${live.start}`;
  if (existsSync(target)) throw new Error(`rotation target ${basename(target)} already exists; remove or rename it, then rotate again`);
  // Drop the oldest segments the hold allows until the bound holds again, and stop at the first one that must stay: after a hold ends, one rotation brings the count back to `keep`.
  while (rotated.length >= options.keep) {
    const oldest = rotated[0]!, reason = options.keepOldest?.(oldest);
    if (reason !== undefined) { result.kept = { segment: oldest, reason }; break; }
    rmSync(oldest.path, { force: true }); result.dropped.push(oldest); rotated.shift(); options.onDrop?.(oldest);
  }
  if (options.mode === "rename") renameSync(file, target);
  else { copyFileSync(file, target); truncateSync(file, 0); }
  result.rotated = true;
  return result;
}

/** The event log: rotate when the live file reached `maxBytes`. */
export function rotateEventsIfLarge(file: string, options: { maxBytes?: number; keep?: number; keepOldest?: RotateOptions["keepOldest"]; onDrop?: RotateOptions["onDrop"] } = {}): RotateResult {
  // A stuck rotation (an existing target name, EACCES) throws to the caller, which logs it: the size bound must never stop holding silently.
  if (!existsSync(file) || statSync(file).size < (options.maxBytes ?? EVENTS_SEGMENT_BYTES)) return { rotated: false, dropped: [] };
  return rotateSegments(file, { keep: options.keep ?? EVENTS_SEGMENTS_KEPT, mode: "rename", ...(options.keepOldest ? { keepOldest: options.keepOldest } : {}), ...(options.onDrop ? { onDrop: options.onDrop } : {}) });
}

/** The hub.log writer's size check: one `stat` every `every` calls. The daemon's own stderr also appends to the file, so a running count alone would drift. */
export function textLogRotator(file: string, maxBytes = HUB_LOG_SEGMENT_BYTES, keep = HUB_LOG_SEGMENTS_KEPT, every = 256): () => RotateResult | undefined {
  let calls = 0;
  return () => {
    if (++calls % every !== 0) return undefined;
    if (statSync(file).size < maxBytes) return undefined;
    return rotateSegments(file, { keep, mode: "copytruncate" });
  };
}

/** Before a daemon starts, an oversized hub.log is moved away: no process holds it open yet. A failure throws to the caller, which reports it. */
export function rotateTextLogAtStart(file: string, maxBytes = HUB_LOG_SEGMENT_BYTES, keep = HUB_LOG_SEGMENTS_KEPT): boolean {
  if (!existsSync(file) || statSync(file).size < maxBytes) return false;
  return rotateSegments(file, { keep, mode: "rename" }).rotated;
}

/** The `at` of the last parseable line of `path`, read from its tail; undefined when none can be read (the caller keeps the segment then). */
export function lastEventTime(path: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd), len = Math.min(size, 256 * 1024), buffer = Buffer.alloc(len);
    readSync(fd, buffer, 0, len, size - len);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= (size > len ? 1 : 0); i--) {
      try { const at = Date.parse((JSON.parse(lines[i]!) as { at?: string }).at ?? ""); if (Number.isFinite(at)) return at; } catch { /* a cut line */ }
    }
    return undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
