import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./child-process.ts";

/**
 * Per-turn workspace snapshots (issue #33): git tree objects written through a copy of the index, so the user's index
 * and HEAD never change. They hold tracked and unignored files as `git add -A` sees them, shell-made changes included.
 * ponytail: snapshots run synchronously on the turn boundary (before the agent sees its prompt); a very large tree
 * costs that much latency per turn, `snapshots.enabled` is the switch and `turn_end.snapshotMs` the measurement.
 * ponytail: the trees are unreferenced, so `git gc` may prune them after gc.pruneExpire (two weeks by default); undo
 * of an older turn says so. Refs under refs/agenthub/ would keep them, at the cost of showing up in the user's repo.
 */
const git = (top: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", ["-C", top, ...args], { encoding: "utf8", env: { ...childEnv(process.env), ...env } });

/** The repository's top level and git dir, or undefined when `root` is not inside a work tree. */
export function repoOf(root: string): { top: string; dir: string } | undefined {
  const r = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (r.status !== 0) return undefined;
  const [top, dir] = r.stdout.trim().split("\n");
  return top && dir ? { top, dir } : undefined;
}

/** A tree id for the current working tree, leaving out the hub's own state. */
export function snapshot(repo: { top: string; dir: string }): string | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "ahub-snap-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (existsSync(join(repo.dir, "index"))) copyFileSync(join(repo.dir, "index"), env.GIT_INDEX_FILE);
    if (git(repo.top, ["add", "-A", "--", ".", ":(exclude,glob)**/.agenthub/state/**"], env).status !== 0) return undefined;
    const r = git(repo.top, ["write-tree"], env);
    return r.status === 0 ? r.stdout.trim() : undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Paths (relative to the top level) that differ between two trees. */
export function changedPaths(top: string, from: string, to: string): string[] {
  const r = git(top, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to]);
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

const blobAt = (top: string, tree: string, path: string): string | undefined => {
  const r = git(top, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const blobNow = (top: string, path: string): string | undefined => {
  if (!existsSync(join(top, path))) return undefined;
  const r = git(top, ["hash-object", "--", path]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** Whether a snapshot's tree is still in the object store (`git gc` prunes unreferenced ones eventually). */
export const hasTree = (top: string, tree: string): boolean => git(top, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;

export interface UndoPlan {
  restore: string[];
  /** Paths changed again after the turn ended: undoing them would destroy somebody else's work. */
  conflicts: string[];
}

/** What undoing a turn would do: every path it changed, unless that path no longer holds what the turn left. */
export function planUndo(top: string, turn: { start_tree: string; end_tree: string; changed: string[] }): UndoPlan {
  const plan: UndoPlan = { restore: [], conflicts: [] };
  for (const path of turn.changed) (blobNow(top, path) === blobAt(top, turn.end_tree, path) ? plan.restore : plan.conflicts).push(path);
  return plan;
}

/** Puts each path back as it was when the turn started; a file the turn created is removed. The index is untouched. */
export function restore(top: string, startTree: string, paths: string[]): void {
  for (const path of paths) {
    if (blobAt(top, startTree, path)) {
      if (git(top, ["restore", `--source=${startTree}`, "--worktree", "--", path]).status !== 0) throw new Error(`could not restore ${path}`);
    } else if (existsSync(join(top, path))) unlinkSync(join(top, path));
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
  /** The latest turn of a peer: a conversation can only be reverted from its latest turn. */
  latest(peer: string): TurnRecord | undefined {
    return this.list(peer, 1)[0];
  }
  close(): void {
    this.db.close();
  }
}
