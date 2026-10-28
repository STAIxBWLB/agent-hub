import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDenied } from "../local/deny.ts";
import { checkCorpusRoot } from "./corpus.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { realPath } from "./project.ts";
import { folderGlobMatches, MAX_NEW_PER_POLL, type FolderEntry, type FolderRunResult, type FolderScan, type ScannedFile } from "./schedules.ts";
import { MAX_SOURCE_BYTES, screenRegistration, type SourceRegistry } from "./sources.ts";
import { matchesPolicy } from "./path-policy.ts";

// agent-hub #512c (hub task #336): the polled folder trigger. Spec: "Schedules and folder triggers (#512)". The hub polls a folder on the schedules timer and never
// watches it. A file it has not recorded is a new file; the caller registers it as a source and proposes one task. Nothing in this file writes the board or the
// registry: it reads the disk and keeps its own table in hub.db.

/** Entries a folder may hold before it is refused: a listing is names only, but a folder this size is not an inbox. */
export const MAX_FOLDER_ENTRIES = 100_000;
/** Files one poll reads and hashes, and the bytes it reads doing so. Files already recorded at their path, size and mtime cost an `lstat` only. */
export const MAX_HASH_FILES = 200;
export const MAX_HASH_BYTES = 256 * 1024 * 1024;
const CHUNK = 64 * 1024;
export { MAX_NEW_PER_POLL };
export type { FolderRunResult, FolderScan, ScannedFile };

export interface FolderPolicy {
  cwd: string;
  /** `data.readonly`: declared data folders a trigger may lie inside, besides the project. Project-relative or absolute, as the config holds them. */
  dataPaths: readonly string[];
  /** `pii.paths`: a trigger folder under one is refused here. A file that is not under one but whose text matches a PII pattern registers as private: the caller screens it. */
  piiPaths: readonly string[];
  /** `local.deny`: substrings, on top of the built-in secrets denylist. */
  deny: readonly string[];
}


const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const beneath = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const printable = (name: string): string => name.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 80);

/**
 * Where a trigger folder may lie: inside the project, or inside a declared data folder. Both sides are `realPath`s, so a link out of either is judged by where it
 * lands, and a folder that is a vault, on the denylist, or under `pii.paths` is refused by the same check the corpus uses. A reason string, never a throw.
 */
export function checkTriggerFolder(entry: FolderEntry, policy: FolderPolicy): { ok: true; real: string } | { ok: false; reason: string } {
  const checked = checkCorpusRoot(entry.folder, { cwd: policy.cwd, paths: [entry.folder], piiPaths: policy.piiPaths, deny: policy.deny });
  if (!checked.ok) return { ok: false, reason: checked.reason.replace("a corpus", "a folder trigger").replace("corpus", "folder trigger") };
  let project: string;
  const allowed: string[] = [];
  try {
    project = realPath(policy.cwd);
    allowed.push(project);
    for (const data of policy.dataPaths) { try { allowed.push(realPath(resolve(project, data))); } catch { /* a data folder that is not there allows nothing */ } }
  } catch { return { ok: false, reason: `${entry.folder} cannot be checked against the project` }; }
  if (!allowed.some(root => beneath(checked.real, root))) return { ok: false, reason: `${entry.folder} lies outside the project and every declared data.readonly folder` };
  return { ok: true, real: checked.real };
}

/**
 * Read one folder, once, and keep no file's bytes. Regular files directly inside it only (no recursion: a subfolder is not a drop). A name that matches the glob and is
 * not a dot file is `lstat`ed: a symlink is never read (one that stays inside the folder is skipped as a link, one that leaves as leaving). A file `known` already, by
 * its real path, size and mtime, returns its recorded hash without being opened. Any other file is opened with O_NOFOLLOW, checked against its `lstat` (size and
 * inode) and hashed in 64 KiB chunks from that descriptor, so memory stays one chunk wide. At most MAX_HASH_FILES files and MAX_HASH_BYTES bytes are hashed per scan;
 * the rest are left for the next poll (`truncated`), and the listing is never cut, so a file late in name order is still reached once earlier ones are recorded.
 * ponytail: a file whose bytes change without its size or mtime changing is not noticed; the upgrade is to hash every poll, which the budget would then have to bound.
 */
export function scanFolder(entry: FolderEntry, policy: FolderPolicy, known: (real: string, size: number, mtime: number) => string | undefined = () => undefined, limits: { entries?: number } = {}): FolderScan {
  const checked = checkTriggerFolder(entry, policy);
  if (!checked.ok) return { files: [], skipped: [], refused: checked.reason, truncated: false };
  const folder = checked.real, files: ScannedFile[] = [], skipped: { name: string; reason: string }[] = [];
  let names: string[];
  try { names = readdirSync(folder); } catch (error) { return { files: [], skipped: [], refused: `${entry.folder} cannot be listed (${errno(error) ?? "unreadable"})`, truncated: false }; }
  const maxEntries = limits.entries ?? MAX_FOLDER_ENTRIES; // a parameter so a test can reach the refusal without a hundred thousand files
  if (names.length > maxEntries) return { files: [], skipped: [], refused: `${entry.folder} holds more than ${maxEntries} entries, which is not an inbox`, truncated: false };
  names.sort();
  let truncated = false, hashedFiles = 0, hashedBytes = 0;
  for (const name of names) {
    if (!folderGlobMatches(entry.glob, name)) continue;
    const path = join(folder, name);
    let stat;
    try { stat = lstatSync(path); } catch { skipped.push({ name: printable(name), reason: "unreadable" }); continue; }
    if (stat.isSymbolicLink()) {
      let target: string | undefined;
      try { target = realpathSync(path); } catch { /* dangling */ }
      skipped.push({ name: printable(name), reason: target !== undefined && beneath(target, folder) ? "symlink" : "symlink leaving the folder" });
      continue;
    }
    if (!stat.isFile()) { skipped.push({ name: printable(name), reason: "not a regular file" }); continue; }
    if (isDenied(path, [...policy.deny])) { skipped.push({ name: printable(name), reason: "on the denylist" }); continue; }
    if (stat.size > MAX_SOURCE_BYTES) { skipped.push({ name: printable(name), reason: `over the ${MAX_SOURCE_BYTES} byte source cap` }); continue; }
    const mtime = Math.floor(stat.mtimeMs);
    const recorded = known(path, stat.size, mtime);
    if (recorded !== undefined) { files.push({ real: path, name, size: stat.size, mtime, sha256: recorded, seen: true }); continue; }
    if (hashedFiles >= MAX_HASH_FILES || hashedFiles > 0 && hashedBytes + stat.size > MAX_HASH_BYTES) { truncated = true; continue; }
    const sha256 = hashFile(path, stat.size, stat.ino);
    if (sha256 === undefined) { skipped.push({ name: printable(name), reason: "changed while it was read" }); continue; }
    hashedFiles++; hashedBytes += stat.size;
    files.push({ real: path, name, size: stat.size, mtime, sha256 });
  }
  return { folder, files, skipped, truncated };
}

/** The SHA-256 of a regular file, read in chunks from a descriptor opened without following a link; undefined when it changed under the read or cannot be read. */
function hashFile(path: string, size: number, ino: number): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const open = fstatSync(fd);
    if (!open.isFile() || open.size !== size || open.ino !== ino) return undefined;
    const hash = createHash("sha256"), chunk = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    let total = 0;
    for (;;) { const n = readSync(fd, chunk, 0, chunk.length, total); if (!n) break; hash.update(chunk.subarray(0, n)); total += n; }
    return total === size ? hash.digest("hex") : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

/**
 * The bytes of a scanned file, for the one file being registered now: read again from a descriptor opened without following a link, and returned only when they still
 * hash to what the scan recorded. A file that changed since is undefined, so it is tried again on the next poll under its new content. At most one file is in memory.
 */
export function readScanned(file: Pick<ScannedFile, "real" | "size" | "sha256">): Buffer | undefined {
  let fd: number;
  try { fd = openSync(file.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const open = fstatSync(fd);
    if (!open.isFile() || open.size !== file.size || open.size > MAX_SOURCE_BYTES) return undefined;
    const bytes = Buffer.alloc(open.size);
    let got = 0;
    while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
    return got === open.size && createHash("sha256").update(bytes).digest("hex") === file.sha256 ? bytes : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

/** What registering a scanned file needs from the host: the registry, the PII policy, the routing's patterns and the text projection. */
export interface FolderRegistration {
  registry: Pick<SourceRegistry, "add">;
  cwd: string;
  piiPaths: readonly string[];
  /** Read at each call: the routing can be reloaded between polls. */
  piiPatterns: () => readonly string[];
  /** The projected text of a file's bytes by its extension, or undefined when no converter handles it. */
  project?: (extension: string, bytes: Buffer) => string | undefined;
}

/**
 * Register one scanned file as a source, the same two steps `ahub source add` takes: one decision about privacy, then the registry. The scan kept no bytes, so the file is
 * read again here and refused (a throw, so the file is tried again on the next poll as what it has become) when it no longer hashes to what the scan saw. A file under
 * `pii.paths`, or whose text matches a PII pattern, is a private source. This is the function the daemon calls; the tests call it too.
 */
export function registerScanned(file: ScannedFile, host: FolderRegistration): { id: string; private: boolean } {
  const bytes = readScanned(file);
  if (!bytes) throw new Error("the file changed or became unreadable before it was registered");
  const extension = /\.[A-Za-z0-9]{1,16}$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
  const verdict = screenRegistration({ bytes, kind: "file", path: file.real }, {
    piiPaths: [...host.piiPaths], piiPatterns: [...host.piiPatterns()], cwd: host.cwd, matchesPolicy,
    ...(host.project ? { project: data => extension ? host.project!(extension, data) : undefined } : {}),
  });
  const added = host.registry.add({ bytes, kind: "file", origin: file.real, private: verdict.private, ...(verdict.text !== undefined ? { text: verdict.text } : {}) });
  return { id: added.id, private: added.private };
}

export interface FolderSeenRow { trigger: string; real_path: string; size: number; mtime: number; sha256: string; task: number | null; at: number }

/**
 * `folder_seen` in hub.db: what each trigger has already acted on, by real path, size, mtime and SHA-256. A file is NEW to a trigger when its content hash was not
 * recorded for it. A rename keeps the hash and a touch keeps the hash too, so neither proposes again; the same bytes under another name are the same file to the
 * trigger (the source registry holds one record per hash as well). A path whose content changed has a new hash, so it is a new file: different bytes.
 */
export class FolderStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.db.run("CREATE TABLE IF NOT EXISTS folder_seen (trigger TEXT NOT NULL, real_path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, sha256 TEXT NOT NULL, task INTEGER, at INTEGER NOT NULL, PRIMARY KEY (trigger, real_path, sha256))");
    this.db.run("CREATE INDEX IF NOT EXISTS folder_seen_hash ON folder_seen (trigger, sha256)");
    this.db.run("CREATE TABLE IF NOT EXISTS folder_poll (trigger TEXT PRIMARY KEY, started INTEGER NOT NULL, baselined INTEGER NOT NULL DEFAULT 0, last_poll INTEGER, last_error TEXT)");
  }
  /**
   * A trigger's baseline is the files already in its folder when it starts: they are recorded and propose nothing, so adding a trigger to a full inbox does not flood the
   * board. A big folder takes several polls to hash, so the baseline is complete only when a poll finished the whole folder (`markBaselined`); until then every file a poll
   * reads is recorded and none proposes.
   */
  baselined(trigger: string): boolean {
    const row = this.db.query("SELECT baselined FROM folder_poll WHERE trigger = ?").get(trigger) as { baselined: number } | null;
    return row?.baselined === 1;
  }
  begin(trigger: string, now: number): void { this.db.query("INSERT OR IGNORE INTO folder_poll(trigger, started) VALUES(?, ?)").run(trigger, now); }
  markBaselined(trigger: string, now: number): void { this.db.query("UPDATE folder_poll SET baselined = 1, last_poll = ? WHERE trigger = ?").run(now, trigger); }
  /** The recorded hash of a file at this exact path, size and mtime, or undefined. Such a file need not be read again. */
  known(trigger: string, real: string, size: number, mtime: number): string | undefined {
    const row = this.db.query("SELECT sha256 FROM folder_seen WHERE trigger = ? AND real_path = ? AND size = ? AND mtime = ? ORDER BY at DESC LIMIT 1").get(trigger, real, size, mtime) as { sha256: string } | null;
    return row?.sha256;
  }
  /** The last poll's time and error. A trigger that has not begun (its folder was refused every time so far) has no row, and none is made: refusing is not beginning. */
  polled(trigger: string, now: number, error?: string): void { this.db.query("UPDATE folder_poll SET last_poll = ?, last_error = ? WHERE trigger = ?").run(now, error?.slice(0, 200) ?? null, trigger); }
  isNew(trigger: string, sha256: string): boolean {
    return !this.db.query("SELECT 1 FROM folder_seen WHERE trigger = ? AND sha256 = ? LIMIT 1").get(trigger, sha256);
  }
  record(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, task: number | null, now: number): void {
    this.db.query("INSERT OR REPLACE INTO folder_seen(trigger, real_path, size, mtime, sha256, task, at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(trigger, file.real, file.size, file.mtime, file.sha256, task, now);
  }
  /**
   * Record where a file whose content the trigger already knows (a rename, a touch, a copy of earlier bytes) is NOW, by path, size and mtime, so the next scan finds it with
   * `known` and does not hash it again. It keeps the task the content already has and proposes nothing. Without this a pile of such files would be hashed on every poll and
   * spend the whole hash budget ahead of a genuinely new file, which would then wait forever.
   */
  observe(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, now: number): void {
    const prior = this.db.query("SELECT task FROM folder_seen WHERE trigger = ? AND sha256 = ? AND task IS NOT NULL ORDER BY at LIMIT 1").get(trigger, file.sha256) as { task: number } | null;
    this.record(trigger, file, prior?.task ?? null, now);
  }
  rows(trigger?: string): FolderSeenRow[] {
    return (trigger === undefined ? this.db.query("SELECT * FROM folder_seen ORDER BY trigger, at, real_path").all() : this.db.query("SELECT * FROM folder_seen WHERE trigger = ? ORDER BY at, real_path").all(trigger)) as FolderSeenRow[];
  }
  /** A trigger removed from the config keeps no rows. */
  prune(keep: readonly string[]): void {
    for (const row of this.db.query("SELECT DISTINCT trigger FROM folder_seen UNION SELECT trigger FROM folder_poll").all() as { trigger: string }[]) {
      if (keep.includes(row.trigger)) continue;
      this.db.query("DELETE FROM folder_seen WHERE trigger = ?").run(row.trigger);
      this.db.query("DELETE FROM folder_poll WHERE trigger = ?").run(row.trigger);
    }
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
