import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDenied } from "../local/deny.ts";
import { checkCorpusRoot } from "./corpus.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { realPath } from "./project.ts";
import { folderGlobMatches, MAX_NEW_PER_POLL, type FolderEntry, type FolderRunResult, type FolderScan, type ScannedFile } from "./schedules.ts";
import { MAX_SOURCE_BYTES } from "./sources.ts";

// agent-hub #512c (hub task #336): the polled folder trigger. Spec: "Schedules and folder triggers (#512)". The hub polls a folder on the schedules timer and never
// watches it. A file it has not recorded is a new file; the caller registers it as a source and proposes one task. Nothing in this file writes the board or the
// registry: it reads the disk and keeps its own table in hub.db.

/** Files one poll looks at. A folder with more is read in name order, so a later poll continues where this one stopped. */
export const MAX_FOLDER_FILES = 2000;
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
 * Read one folder, once. Regular files directly inside it only (no recursion: a subfolder is not a drop). A name that matches the glob and is not a dot file is
 * opened with O_NOFOLLOW after an `lstat`, so a symlink is never read: one that stays inside the folder is skipped as a link (the file it names is read under its own
 * name if it is there), one that leaves is skipped as leaving. The bytes are read from the descriptor that was checked, capped at the source size cap, and hashed.
 */
export function scanFolder(entry: FolderEntry, policy: FolderPolicy): FolderScan {
  const checked = checkTriggerFolder(entry, policy);
  if (!checked.ok) return { files: [], skipped: [], refused: checked.reason, truncated: false };
  const folder = checked.real, files: ScannedFile[] = [], skipped: { name: string; reason: string }[] = [];
  let names: string[];
  try { names = readdirSync(folder).sort(); } catch (error) { return { files: [], skipped: [], refused: `${entry.folder} cannot be listed (${errno(error) ?? "unreadable"})`, truncated: false }; }
  let truncated = false;
  if (names.length > MAX_FOLDER_FILES) { names = names.slice(0, MAX_FOLDER_FILES); truncated = true; }
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
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { skipped.push({ name: printable(name), reason: "unreadable" }); continue; }
    try {
      const open = fstatSync(fd);
      if (!open.isFile() || open.size !== stat.size || open.ino !== stat.ino) { skipped.push({ name: printable(name), reason: "changed while it was read" }); continue; }
      const bytes = Buffer.alloc(open.size);
      let got = 0;
      while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
      if (got !== open.size) { skipped.push({ name: printable(name), reason: "changed while it was read" }); continue; }
      files.push({ real: join(folder, name), name, size: open.size, mtime: Math.floor(open.mtimeMs), sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    } finally { closeSync(fd); }
  }
  return { folder, files, skipped, truncated };
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
    this.db.run("CREATE TABLE IF NOT EXISTS folder_poll (trigger TEXT PRIMARY KEY, started INTEGER NOT NULL, last_poll INTEGER, last_error TEXT)");
  }
  /** A trigger's first poll records what is already there and proposes nothing: only a file that arrives later is new. */
  started(trigger: string): number | undefined {
    const row = this.db.query("SELECT started FROM folder_poll WHERE trigger = ?").get(trigger) as { started: number } | null;
    return row?.started;
  }
  begin(trigger: string, now: number): void { this.db.query("INSERT OR IGNORE INTO folder_poll(trigger, started) VALUES(?, ?)").run(trigger, now); }
  /** The last poll's time and error. A trigger that has not started (its folder was refused every time so far) has no row, and none is made: refusing is not starting. */
  polled(trigger: string, now: number, error?: string): void { this.db.query("UPDATE folder_poll SET last_poll = ?, last_error = ? WHERE trigger = ?").run(now, error?.slice(0, 200) ?? null, trigger); }
  isNew(trigger: string, sha256: string): boolean {
    return !this.db.query("SELECT 1 FROM folder_seen WHERE trigger = ? AND sha256 = ? LIMIT 1").get(trigger, sha256);
  }
  record(trigger: string, file: Pick<ScannedFile, "real" | "size" | "mtime" | "sha256">, task: number | null, now: number): void {
    this.db.query("INSERT OR REPLACE INTO folder_seen(trigger, real_path, size, mtime, sha256, task, at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(trigger, file.real, file.size, file.mtime, file.sha256, task, now);
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
