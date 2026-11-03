import { statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { childEnv } from "./child-process.ts";
import { hubGitEnv, hubGitSync } from "./git.ts";
import { HUB } from "./envelope.ts";
import { realPath } from "./project.ts";
import type { Task } from "./board.ts";

/**
 * #1057 worktree shelf. Which worktrees are finished is DERIVED at read time from facts and two person overrides, never stored as a flag.
 * This module reads facts and computes the partition. It never deletes a worktree or a local branch: removal exists only in the person's
 * CLI process (`worktree-tidy.ts`, a later change), and `test/worktree-shelf.test.ts` greps the daemon-reachable modules for any removal argv.
 */

export type PrState = "open" | "merged" | "closed" | "unknown";
export type SettledReason = "merged" | "closed" | "quiet" | "parked";
export type OverrideValue = "settled" | "active";
export interface WorktreeOverride { path: string; value: OverrideValue; at: number }

export interface WorktreeFact {
  /** Absolute, host-only. A row shown to a person is displayed through `displayPath`. */
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
  prunable: boolean;
  /** The project's main checkout: never shelved. */
  main: boolean;
  /** A configured instance worktree (`.worktrees/<instance>`): never shelved. */
  instance: boolean;
  /** Max of the HEAD commit time, the worktree index mtime and the latest time someone other than the hub wrote to the bound task. 0 when none could be read. */
  lastActiveAt: number;
  task?: { id: number; state: string; pr?: number };
  pr: { state: PrState; changedAt?: number };
}
export interface ShelfRow { path: string; branch: string | null; reason?: SettledReason; task?: number; pr?: number; lastActiveAt: number }
export interface Partition { live: ShelfRow[]; settled: ShelfRow[] }

const DAY_MS = 86_400_000;
const row = (fact: WorktreeFact, reason?: SettledReason): ShelfRow => ({
  path: fact.path, branch: fact.branch, lastActiveAt: fact.lastActiveAt,
  ...(reason ? { reason } : {}), ...(fact.task ? { task: fact.task.id } : {}), ...(fact.task?.pr !== undefined ? { pr: fact.task.pr } : {}),
});

/** An override counts only while no newer activity exists: `lastActiveAt <= at` (D2). Newer activity makes it inert. */
export const overrideInForce = (override: WorktreeOverride | undefined, lastActiveAt: number): override is WorktreeOverride =>
  !!override && lastActiveAt <= override.at;

/**
 * D3, pure. Rules in order: (1) the main checkout and instance worktrees are never shelved; (2) an effective override wins; (3) a merged or
 * closed PR with `lastActiveAt <= changedAt` is settled; (4) `quietDays > 0` and a quiet span of at least that long is settled; (5) live.
 * `now`, the facts and the overrides are arguments: no clock, no I/O.
 */
export function partition(facts: readonly WorktreeFact[], overrides: readonly WorktreeOverride[], now: number, quietDays: number): Partition {
  const byPath = new Map(overrides.map(o => [o.path, o]));
  const out: Partition = { live: [], settled: [] };
  for (const fact of facts) {
    if (fact.main || fact.instance) { out.live.push(row(fact)); continue; }
    const override = byPath.get(fact.path);
    if (overrideInForce(override, fact.lastActiveAt)) {
      if (override.value === "settled") out.settled.push(row(fact, "parked")); else out.live.push(row(fact));
      continue;
    }
    if ((fact.pr.state === "merged" || fact.pr.state === "closed") && fact.pr.changedAt !== undefined && fact.lastActiveAt <= fact.pr.changedAt) {
      out.settled.push(row(fact, fact.pr.state)); continue;
    }
    if (quietDays > 0 && fact.lastActiveAt > 0 && now - fact.lastActiveAt >= quietDays * DAY_MS) { out.settled.push(row(fact, "quiet")); continue; }
    out.live.push(row(fact));
  }
  return out;
}

/** Project-relative inside the root (the root itself is `.`), otherwise the basename only: paths stay host-only, as in `snapshots.ts`. */
export function displayPath(root: string, path: string): string {
  if (path === root) return ".";
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== path ? rel : basename(path);
}

/**
 * The latest time anyone but the hub wrote to a task: its work, not its bookkeeping. The hub's own entries (the merge result, the owner notice,
 * sweeps) follow the event they record, so counting them would put `lastActiveAt` after a merge's `changedAt` and a merged task could never settle (#1057 D1/D3).
 */
export const taskWorkAt = (task: Pick<Task, "history" | "created">): number =>
  Math.max(task.created, ...task.history.filter(h => h.by !== HUB && Number.isFinite(h.at)).map(h => h.at));

/** The task a worktree branch belongs to: the open task, else the most recently updated one, whose `refs.branch` equals the branch. */
export function boundTask(tasks: readonly Pick<Task, "id" | "state" | "refs" | "sdlc" | "updated" | "created" | "history">[], branch: string | null): WorktreeFact["task"] & { workAt: number } | undefined {
  if (!branch) return undefined;
  const matching = tasks.filter(t => t.refs.branch === branch);
  if (!matching.length) return undefined;
  const closed = (state: string) => state === "approved" || state === "cancelled";
  const pick = [...matching].sort((a, b) => Number(closed(a.state)) - Number(closed(b.state)) || b.updated - a.updated)[0]!;
  const pr = pick.sdlc?.pr;
  return { id: pick.id, state: pick.state, ...(typeof pr === "number" ? { pr } : {}), workAt: taskWorkAt(pick) };
}

/**
 * PR state from evidence already on the board (D1): the guarded merge's record is `merged`, a cancelled task with a PR is `closed`; anything
 * else is `unknown`, never a GitHub read. The explicit refresh action (`readSdlcPr`) is a later change.
 */
export function prFromTask(task: Pick<Task, "state" | "sdlc" | "history"> | undefined): WorktreeFact["pr"] {
  const merge = task?.sdlc?.merge;
  if (merge && merge.state === "merged" && Number.isFinite(merge.at)) return { state: "merged", changedAt: merge.at };
  if (task?.state === "cancelled" && task.sdlc?.pr !== undefined) {
    const at = [...(task.history ?? [])].reverse().find(h => h.event === "cancelled")?.at;
    return at !== undefined ? { state: "closed", changedAt: at } : { state: "unknown" };
  }
  return { state: "unknown" };
}

export interface RawWorktree { path: string; branch: string | null; head: string; locked: boolean; prunable: boolean }
/** `git worktree list --porcelain -z`: one NUL-separated field per attribute, an empty field ends a record. Bounded. */
export function parseWorktreeList(stdout: string, limit = 256): { rows: RawWorktree[]; complete: boolean } {
  const rows: RawWorktree[] = [];
  let current: Partial<RawWorktree> | undefined;
  const flush = () => { if (current?.path) rows.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? "", locked: !!current.locked, prunable: !!current.prunable }); current = undefined; };
  for (const field of stdout.split("\0")) {
    if (field === "") { flush(); continue; }
    if (field.startsWith("worktree ")) { flush(); current = { path: field.slice(9) }; continue; }
    if (!current) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field.startsWith("branch refs/heads/")) current.branch = field.slice("branch refs/heads/".length);
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
  }
  flush();
  return { rows: rows.slice(0, limit), complete: rows.length <= limit };
}

export interface ShelfGitPort {
  /** Read-only git, bounded. `undefined` is a failed or timed-out read, never an empty answer. */
  run(cwd: string, args: string[]): { status: number | null; stdout: string } | undefined;
}
const READ_TIMEOUT_MS = 5_000;
export const realShelfGit: ShelfGitPort = {
  run(cwd, args) {
    if (!shelfReadAllowed(args)) throw new Error("the worktree shelf runs read-only git commands only");
    const result = hubGitSync(["-C", cwd, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
      encoding: "utf8", timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: hubGitEnv(childEnv(), { repositoryIsolation: true }),
    });
    return result.error ? undefined : { status: result.status, stdout: String(result.stdout ?? "") };
  },
};
/**
 * The only git argv shapes the shelf runs, all reads. `realShelfGit.run` refuses anything else before spawning, so no removal, branch, ref or
 * prune argv can reach git from the daemon (AC4); the boundary test also greps the module text for them.
 */
export const SHELF_GIT_READS: readonly (readonly string[])[] = [
  ["worktree", "list", "--porcelain", "-z"],
  ["log", "-1", "--format=%ct", "HEAD"],
  ["rev-parse", "--absolute-git-dir"],
];
export const shelfReadAllowed = (args: readonly string[]): boolean => SHELF_GIT_READS.some(shape => shape.length === args.length && shape.every((word, i) => word === args[i]));

export interface ShelfInput {
  root: string;
  tasks: readonly Pick<Task, "id" | "state" | "refs" | "sdlc" | "updated" | "created" | "history">[];
  /** Resolved instance worktree paths (`.worktrees/<instance>`): never shelved. */
  instancePaths: readonly string[];
  git?: ShelfGitPort;
  mtime?: (path: string) => number | undefined;
}
export interface ShelfFacts { facts: WorktreeFact[]; complete: boolean; available: boolean }

const indexMtime = (git: ShelfGitPort, path: string): number | undefined => {
  const dir = git.run(path, ["rev-parse", "--absolute-git-dir"]);
  if (!dir || dir.status !== 0) return undefined;
  try { const info = statSync(join(dir.stdout.trim(), "index")); return info.isFile() ? info.mtimeMs : undefined; } catch { return undefined; }
};

/** D1: facts per worktree. Read on demand with a bounded number of git calls (one list plus one commit-time read per worktree). Never writes. */
export function readWorktreeFacts(input: ShelfInput): ShelfFacts {
  const git = input.git ?? realShelfGit;
  let root: string;
  try { root = realPath(input.root); } catch { return { facts: [], complete: false, available: false }; }
  const listed = git.run(root, ["worktree", "list", "--porcelain", "-z"]);
  if (!listed || listed.status !== 0) return { facts: [], complete: false, available: false };
  const parsed = parseWorktreeList(listed.stdout);
  const instances = new Set(input.instancePaths);
  const facts: WorktreeFact[] = [];
  for (const raw of parsed.rows) {
    let path = raw.path;
    try { path = realPath(raw.path); } catch { /* a prunable worktree's directory is gone: keep the registered path */ }
    const task = boundTask(input.tasks, raw.branch);
    const stamp = git.run(path, ["log", "-1", "--format=%ct", "HEAD"]);
    const commitAt = stamp && stamp.status === 0 && /^\d{1,12}$/.test(stamp.stdout.trim()) ? Number(stamp.stdout.trim()) * 1000 : 0;
    const touched = (input.mtime ?? ((p: string) => indexMtime(git, p)))(path) ?? 0;
    const bound = task ? input.tasks.find(t => t.id === task.id) : undefined;
    facts.push({
      path, branch: raw.branch, head: raw.head, locked: raw.locked, prunable: raw.prunable,
      main: path === root, instance: instances.has(path),
      lastActiveAt: Math.max(commitAt, touched, task?.workAt ?? 0),
      ...(task ? { task: { id: task.id, state: task.state, ...(task.pr !== undefined ? { pr: task.pr } : {}) } } : {}),
      pr: prFromTask(bound),
    });
  }
  return { facts, complete: parsed.complete, available: true };
}
