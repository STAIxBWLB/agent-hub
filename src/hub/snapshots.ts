import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./child-process.ts";
import type { Touch } from "./conflicts.ts";

/**
 * Per-turn workspace snapshots (issue #33): git tree objects written through a copy of the index, so the user's index
 * and HEAD never change. They hold tracked and unignored files as `git add -A` sees them, shell-made changes included.
 * ponytail: snapshots run synchronously on the turn boundary (before the agent sees its prompt); a very large tree
 * costs that much latency per turn, `snapshots.enabled` is the switch and `turn_end.snapshotMs` the measurement.
 * ponytail: the trees are unreferenced, so `git gc` may prune them after gc.pruneExpire (two weeks by default); undo
 * of an older turn says so. Refs under refs/agenthub/ would keep them, at the cost of showing up in the user's repo.
 */
const git = (top: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", ["-C", top, ...args], {
    encoding: "utf8",
    env: { ...childEnv(process.env), ...env },
    // These run inside the bus's state change: a hung git (a huge new directory, a stuck filter) must not freeze the hub.
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
const SNAPSHOT_TIMEOUT_MS = 10_000;

/** A repository and where the project sits in it: `prefix` is "" at the top level, else "sub/dir/". */
export interface Repo {
  top: string;
  dir: string;
  prefix: string;
}

/** The repository holding `root`, or undefined when it is not inside a work tree. */
export function repoOf(root: string): Repo | undefined {
  const r = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"]);
  if (r.status !== 0) return undefined;
  const [top, dir, prefix = ""] = r.stdout.replace(/\n$/, "").split("\n");
  return top && dir ? { top, dir, prefix } : undefined;
}

/**
 * A path as a pathspec that means only itself: `app/[slug]/page.tsx` must not match `app/s/page.tsx`. Per-path
 * `:(literal)` rather than --literal-pathspecs, which would also switch off the state exclude's glob.
 */
const literal = (path: string) => `:(literal)${path}`;
/** Only the project's own files: a hub in a subdirectory of a larger repository snapshots that subdirectory. */
const scope = (repo: Repo) => (repo.prefix ? literal(repo.prefix) : ".");

/** A tree id for the project's files as they are now, leaving out the hub's own state. */
export function snapshot(repo: Repo): string | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "ahub-snap-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const index = join(repo.dir, "index");
    if (existsSync(index)) {
      copyFileSync(index, env.GIT_INDEX_FILE);
      // git trusts an entry's stat only when the entry is older than the index file. A copy written now makes an edit
      // in the second the index was written look clean (same size, and whole-second times); keep the original's time.
      const { atime, mtime } = statSync(index);
      utimesSync(env.GIT_INDEX_FILE, atime, mtime);
    }
    if (git(repo.top, ["add", "-A", "--", scope(repo), ":(exclude,glob)**/.agenthub/state/**"], env).status !== 0) return undefined;
    // The copy starts from the user's index: hub state somebody tracked or staged is still in it, and the exclude above
    // only keeps `add` from touching it. Take it out explicitly; -f because staged state the hub has rewritten since
    // matches neither HEAD nor the file, which `rm --cached` otherwise refuses. Only the copy changes.
    if (git(repo.top, ["rm", "-r", "-f", "--cached", "--quiet", "--ignore-unmatch", "--", ":(glob)**/.agenthub/state/**"], env).status !== 0) return undefined;
    const r = git(repo.top, ["write-tree"], env);
    return r.status === 0 ? r.stdout.trim() : undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Project paths (relative to the top level) that differ between two trees. */
export function changedPaths(repo: Repo, from: string, to: string): string[] {
  const r = git(repo.top, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to, "--", scope(repo)]);
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

const inTree = (top: string, tree: string, path: string) => git(top, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]).status === 0;

/** Whether a snapshot's tree is still in the object store (`git gc` prunes unreferenced ones eventually). */
export const hasTree = (top: string, tree: string): boolean => git(top, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;

export interface UndoPlan {
  restore: string[];
  /** Changed again after the turn ended (by anyone): restoring them would destroy that work. */
  changedSince: string[];
  /** Also changed by another peer's turn that overlapped this one: the change may be theirs. */
  concurrent: string[];
  /** Every path the turn changed is already as it was when the turn started. */
  undone: boolean;
}

/**
 * What undoing a turn would do. The current state is read the way the snapshots are (one more snapshot), so modes,
 * symlinks, directories and filters compare like for like. A path is refused when anything at or under it differs
 * from what the turn left, or when an overlapping turn of another peer changed it too.
 */
export function planUndo(repo: Repo, turn: { start_tree: string; end_tree: string; changed: string[] }, overlapping: string[] = []): UndoPlan {
  const now = snapshot(repo);
  if (!now) throw new Error("could not read the work tree (see git's output above, or try again)");
  const hit = (paths: string[], p: string) => paths.some((d) => d === p || d.startsWith(`${p}/`));
  const sinceEnd = changedPaths(repo, turn.end_tree, now);
  const sinceStart = changedPaths(repo, turn.start_tree, now);
  const plan: UndoPlan = { restore: [], changedSince: [], concurrent: [], undone: turn.changed.length > 0 && turn.changed.every((p) => !hit(sinceStart, p)) };
  for (const p of turn.changed) {
    if (hit(sinceEnd, p)) plan.changedSince.push(p);
    else if (hit(overlapping, p)) plan.concurrent.push(p);
    else plan.restore.push(p);
  }
  return plan;
}

/**
 * Puts each path back as it was when the turn started; a file the turn created is removed (never a directory: the
 * plan refuses a path with anything under it). The index is untouched.
 */
export function restore(repo: Repo, startTree: string, paths: string[]): void {
  // Removals first: after a case-only rename on a case-insensitive disk, `Foo.ts` and `foo.ts` are one file, and
  // removing the created spelling after restoring the old one would delete it.
  const back = paths.filter((p) => inTree(repo.top, startTree, p));
  for (const path of paths.filter((p) => !back.includes(p))) rmSync(join(repo.top, path), { force: true });
  for (const path of back) {
    if (git(repo.top, ["restore", `--source=${startTree}`, "--worktree", "--", literal(path)]).status !== 0) throw new Error(`could not restore ${path}`);
  }
}

export interface TurnRecord {
  id: string;
  peer: string;
  started: number;
  ended: number | null;
  start_tree: string | null;
  end_tree: string | null;
  changed: string[];
  native: string | null;
}

/** Turn records in hub.db: the daemon writes them, `ahub turns` and `ahub undo` read them. */
export class Turns {
  private readonly db: Database;
  constructor(path: string, readonly?: boolean) {
    this.db = new Database(path, readonly ? { readonly: true } : { create: true });
    if (readonly) return;
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, peer TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER,
      start_tree TEXT, end_tree TEXT, changed TEXT NOT NULL DEFAULT '[]', native TEXT)`);
    // Opened by a starting hub: a turn still open was cut short when the last run stopped. It has no end snapshot, and
    // it may have run until now, so its window ends now (other turns that overlapped it stay unknowable).
    this.db.query("UPDATE turns SET ended = ? WHERE ended IS NULL").run(Date.now());
    // ponytail: rows of finished tasks stay (a few per file per task); prune by task state if hub.db ever grows.
    this.db.run("CREATE TABLE IF NOT EXISTS touches (task INTEGER NOT NULL, peer TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task, peer, path))");
    this.db.run("CREATE INDEX IF NOT EXISTS touches_path ON touches (path)"); // the PreToolUse hook looks up one path
  }
  begin(id: string, peer: string, startTree: string | undefined): void {
    this.db.query("INSERT OR REPLACE INTO turns (id, peer, started, start_tree) VALUES (?, ?, ?, ?)").run(id, peer, Date.now(), startTree ?? null);
  }
  /** The first native turn of a hub turn: reverting the conversation drops it and every later one. */
  native(id: string, native: string): void {
    this.db.query("UPDATE turns SET native = ? WHERE id = ? AND native IS NULL").run(native, id);
  }
  end(id: string, endTree: string | undefined, changed: string[], keep: number): void {
    this.db.query("UPDATE turns SET ended = ?, end_tree = ?, changed = ? WHERE id = ?").run(Date.now(), endTree ?? null, JSON.stringify(changed), id);
    const peer = (this.db.query("SELECT peer FROM turns WHERE id = ?").get(id) as { peer: string } | null)?.peer;
    if (peer) this.db.query("DELETE FROM turns WHERE peer = ? AND id NOT IN (SELECT id FROM turns WHERE peer = ? ORDER BY started DESC, rowid DESC LIMIT ?)").run(peer, peer, keep);
  }
  list(peer?: string, limit = 20): TurnRecord[] {
    const rows = (peer
      ? this.db.query("SELECT * FROM turns WHERE peer = ? ORDER BY started DESC, rowid DESC LIMIT ?").all(peer, limit)
      : this.db.query("SELECT * FROM turns ORDER BY started DESC, rowid DESC LIMIT ?").all(limit)) as (Omit<TurnRecord, "changed"> & { changed: string })[];
    return rows.map((r) => ({ ...r, changed: JSON.parse(r.changed) as string[] }));
  }
  get(id: string): TurnRecord | undefined {
    const r = this.db.query("SELECT * FROM turns WHERE id = ?").get(id) as (Omit<TurnRecord, "changed"> & { changed: string }) | null;
    return r ? { ...r, changed: JSON.parse(r.changed) as string[] } : undefined;
  }
  /**
   * Other peers' turns that overlapped this one in time: their changes are in this turn's diff too. `unknown` lists
   * those whose changes cannot be known (still running, cut short by a stop, a failed snapshot, a PII turn), and a
   * peer whose `keep` records all start after this turn: its turns from then may have been pruned.
   */
  // ponytail: pruning is inferred from `keep` as the CLI reads it now; a `keep` raised while the hub runs (which prunes
  // with the value it started with) can hide a pruned overlap until the hub restarts. Record a per-peer "pruned
  // before" time in Turns.end if that ever matters.
  overlapping(turn: TurnRecord, keep: number): { paths: string[]; unknown: string[] } {
    const rows = this.db.query("SELECT id, changed, ended, start_tree, end_tree FROM turns WHERE id != ? AND peer != ? AND started < ? AND (ended IS NULL OR ended > ?)").all(turn.id, turn.peer, turn.ended ?? Date.now(), turn.started) as { id: string; changed: string; ended: number | null; start_tree: string | null; end_tree: string | null }[];
    const known = rows.filter((r) => r.ended !== null && r.start_tree !== null && r.end_tree !== null);
    const pruned = (this.db.query("SELECT peer, MIN(started) AS oldest FROM turns WHERE peer != ? GROUP BY peer HAVING COUNT(*) >= ?").all(turn.peer, keep) as { peer: string; oldest: number }[])
      .filter((p) => p.oldest > turn.started)
      .map((p) => `${p.peer} (its turns from then were pruned)`);
    return { paths: [...new Set(known.flatMap((r) => JSON.parse(r.changed) as string[]))], unknown: [...rows.filter((r) => !known.includes(r)).map((r) => r.id), ...pruned] };
  }

  /** Files a peer's turn changed while it owned `task` in progress (issue #32). */
  touch(task: number, peer: string, paths: string[]): void {
    const at = Date.now();
    const q = this.db.query("INSERT OR REPLACE INTO touches (task, peer, path, at) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => { for (const p of paths) q.run(task, peer, p, at); })();
  }
  touchesFor(tasks: number[]): Touch[] {
    if (!tasks.length) return [];
    return this.db.query(`SELECT * FROM touches WHERE task IN (${tasks.map(() => "?").join(",")})`).all(...tasks) as Touch[];
  }
  /** Other peers with a turn that was open at some point since `since`: their changes may be in this turn's diff. */
  busySince(peer: string, since: number): string[] {
    return (this.db.query("SELECT DISTINCT peer FROM turns WHERE peer != ? AND (ended IS NULL OR ended >= ?) ORDER BY peer").all(peer, since) as { peer: string }[]).map((r) => r.peer);
  }

  /** The latest turn of a peer: a conversation can only be reverted from its latest turn. */
  latest(peer: string): TurnRecord | undefined {
    return this.list(peer, 1)[0];
  }
  close(): void {
    this.db.close();
  }
}
