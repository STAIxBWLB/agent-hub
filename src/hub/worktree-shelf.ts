import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { childEnv } from "./child-process.ts";
import { hubGitArgv, hubGitEnv } from "./git.ts";
import { HUB } from "./envelope.ts";
import { realPath } from "./project.ts";
import type { Task } from "./board.ts";

/**
 * #1057 worktree shelf. Which worktrees are finished is DERIVED at read time from facts and two person overrides, never stored as a flag.
 * This module reads facts and computes the partition. It never deletes a worktree or a local branch: removal exists only in the person's
 * CLI process (`worktree-tidy.ts`, a later change), and `test/worktree-shelf.test.ts` greps the daemon-reachable modules for any removal argv.
 */

export type PrState = "open" | "merged" | "closed" | "unknown";
/** `settled` is what a PII-bound row says in a reply for a merged or closed PR: the reason is real on the host, but a reply carries no PR state of a private task. */
export type SettledReason = "merged" | "closed" | "quiet" | "parked" | "settled";
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
  /** False when the commit time or the index could not be read (a failed git call or a spent budget): such a row is never settled by a PR or by quiet time, because 'no newer work' is unknown. */
  activityKnown?: boolean;
  /** `private`: the bound task is a PII task. The binding still drives the partition and tidy's refusals on the host, but `row()` never puts its id, PR or state in a reply. */
  task?: { id: number; state: string; pr?: number; repo?: string; private?: true };
  pr: { state: PrState; changedAt?: number };
}
/** A row built for a reply. A PII-bound row carries `private: true` and `taskState: "private"` and no task id or PR. This is the one place a reply row is made, so redaction happens here (AGENTS.md), never at a call site. */
export interface ShelfRow { path: string; branch: string | null; reason?: SettledReason; task?: number; taskState?: string; pr?: number; private?: true; lastActiveAt: number }
export interface Partition { live: ShelfRow[]; settled: ShelfRow[] }

const DAY_MS = 86_400_000;
const row = (fact: WorktreeFact, reason?: SettledReason): ShelfRow => ({
  path: fact.path, branch: fact.branch, lastActiveAt: fact.lastActiveAt,
  ...(reason ? { reason: fact.task?.private && (reason === "merged" || reason === "closed") ? "settled" as const : reason } : {}),
  ...(fact.task?.private ? { private: true as const, taskState: "private" }
    : { ...(fact.task ? { task: fact.task.id, taskState: fact.task.state } : {}), ...(fact.task?.pr !== undefined ? { pr: fact.task.pr } : {}) }),
});

/** An override counts only while no newer activity exists: `lastActiveAt <= at` (D2). Newer activity makes it inert. */
export const overrideInForce = (override: WorktreeOverride | undefined, lastActiveAt: number): override is WorktreeOverride =>
  !!override && lastActiveAt <= override.at;

/**
 * D3, pure. A row whose activity is unknown (`activityKnown === false`) is live: every settling rule compares with `lastActiveAt`, which is then not a fact.
 * Rules in order: (1) the main checkout and instance worktrees are never shelved; (2) an effective override wins; (3) a merged or
 * closed PR with `lastActiveAt <= changedAt` is settled; (4) `quietDays > 0` and a quiet span of at least that long is settled; (5) live.
 * `now`, the facts and the overrides are arguments: no clock, no I/O.
 */
export function partition(facts: readonly WorktreeFact[], overrides: readonly WorktreeOverride[], now: number, quietDays: number): Partition {
  const byPath = new Map(overrides.map(o => [o.path, o]));
  const out: Partition = { live: [], settled: [] };
  for (const fact of facts) {
    if (fact.main || fact.instance || fact.activityKnown === false) { out.live.push(row(fact)); continue; }
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

/** Whether a path is the root or below it, so a row can be resolved against the project root and one outside it cannot. */
export const shelfInsideRoot = (root: string, path: string): boolean => path === root || (!relative(root, path).startsWith("..") && !relative(root, path).startsWith(sep) && relative(root, path) !== path);

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
  const pr = pick.sdlc?.pr, repo = pick.sdlc?.repo;
  return { id: pick.id, state: pick.state, ...(typeof pr === "number" ? { pr } : {}), ...(typeof repo === "string" && typeof pr === "number" ? { repo } : {}), workAt: taskWorkAt(pick) };
}

/**
 * PR state from evidence already on the board (D1): only the guarded merge's own record says `merged`. A cancelled task says nothing about its PR (`Tasks.cancel`
 * touches only the board, so the PR can still be open on GitHub), and a task with no record says nothing either: both are `unknown`. Only the explicit refresh
 * action, which reads GitHub, may learn `closed` or `open` (a later change).
 */
export function prFromTask(task: Pick<Task, "state" | "sdlc" | "history"> | undefined, observed?: PrObserver): WorktreeFact["pr"] {
  const merge = task?.sdlc?.merge;
  if (merge && merge.state === "merged" && Number.isFinite(merge.at)) return { state: "merged", changedAt: merge.at };
  // A PR state the person asked the hub to read (the explicit refresh action) is a stored fact, never fetched here: this module has no GitHub access (AC5).
  const repo = task?.sdlc?.repo, pr = task?.sdlc?.pr;
  const seen = typeof repo === "string" && typeof pr === "number" ? observed?.(repo, pr) : undefined;
  if (seen) return { state: seen.state, ...(seen.changedAt !== undefined && seen.state !== "open" ? { changedAt: seen.changedAt } : {}) };
  return { state: "unknown" };
}
/** The stored result of an explicit PR refresh for one repository and PR number, or undefined when none was read. */
export type PrObserver = (repo: string, pr: number) => { state: "open" | "merged" | "closed"; changedAt?: number } | undefined;

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
  /** Read-only git, bounded by `timeoutMs`, never blocking the event loop. `undefined` is a failed or timed-out read, never an empty answer. */
  run(cwd: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string } | undefined>;
}
/** One git call's ceiling, and the whole read's: a slow repository answers `complete: false` after this, never a stalled hub (D1's snapshot-budget pattern). */
export const READ_TIMEOUT_MS = 5_000, TOTAL_BUDGET_MS = 3_000, READ_CONCURRENCY = 4;
export const realShelfGit: ShelfGitPort = {
  async run(cwd, args, timeoutMs) {
    if (!shelfReadAllowed(args)) throw new Error("the worktree shelf runs read-only git commands only");
    const argv = hubGitArgv(["-C", cwd, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args]);
    return await new Promise(resolve => {
      execFile(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: Math.max(1, Math.min(READ_TIMEOUT_MS, timeoutMs)), killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: hubGitEnv(childEnv(), { repositoryIsolation: true }) }, (error, stdout) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        // a non-zero exit is an answer (status), a spawn failure, timeout or overflow is not
        resolve(error && typeof code !== "number" ? undefined : { status: typeof code === "number" ? code : 0, stdout: String(stdout ?? "") });
      });
    });
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
  /** Called AFTER the git reads, so the board is read once and fresh, never held across an await. */
  tasks: () => readonly Pick<Task, "id" | "state" | "refs" | "sdlc" | "updated" | "created" | "history">[];
  /** Whether a task is a PII task (`Tasks.isPii`). Its binding is kept for the partition and the refusals and redacted in the reply row. A host that does not pass it treats no task as private. */
  isPrivate?: (taskId: number) => boolean;
  /** Resolved instance worktree paths (`.worktrees/<instance>`): never shelved. */
  instancePaths: readonly string[];
  /** Stored PR observations (D1); called after the git reads, in the same synchronous segment as `tasks`. */
  observed?: PrObserver;
  git?: ShelfGitPort;
  now?: () => number;
  budgetMs?: number;
}
export interface ShelfFacts { facts: WorktreeFact[]; complete: boolean; available: boolean }

/** The worktree's own index mtime (D1: it covers uncommitted editing). `undefined` is unknown; a missing index file is a known 0. */
async function indexMtime(git: ShelfGitPort, path: string, timeoutMs: number): Promise<number | undefined> {
  const dir = await git.run(path, ["rev-parse", "--absolute-git-dir"], timeoutMs);
  if (!dir || dir.status !== 0) return undefined;
  try { const info = await stat(join(dir.stdout.trim(), "index")); return info.isFile() ? info.mtimeMs : 0; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined; }
}

interface Probe { commitAt: number; touched: number; known: boolean }

/**
 * D1: facts per worktree. One `worktree list`, then a commit-time read and an index read per worktree, at most `READ_CONCURRENCY` at a time and all under one
 * total budget. Asynchronous throughout: the daemon's event loop is never held. When the budget is spent, the rows not yet read are still listed, with unknown
 * activity (live, never settled), and the result says `complete: false`. Never writes.
 */
export async function readWorktreeFacts(input: ShelfInput): Promise<ShelfFacts> {
  const git = input.git ?? realShelfGit, now = input.now ?? Date.now, deadline = now() + (input.budgetMs ?? TOTAL_BUDGET_MS);
  const left = () => Math.max(0, deadline - now());
  let root: string;
  try { root = realPath(input.root); } catch { return { facts: [], complete: false, available: false }; }
  const listed = await git.run(root, ["worktree", "list", "--porcelain", "-z"], left());
  if (!listed || listed.status !== 0) return { facts: [], complete: false, available: false };
  const parsed = parseWorktreeList(listed.stdout);
  const paths = parsed.rows.map(raw => { try { return realPath(raw.path); } catch { return raw.path; } }); // a prunable worktree's directory is gone: keep the registered path
  const probes: (Probe | undefined)[] = parsed.rows.map(() => undefined);
  let next = 0, cut = false;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      if (left() <= 0) { cut = true; return; }
      const stamp = await git.run(paths[i]!, ["log", "-1", "--format=%ct", "HEAD"], left());
      const text = stamp && stamp.status === 0 ? stamp.stdout.trim() : "";
      const touched = left() > 0 ? await indexMtime(git, paths[i]!, left()) : undefined;
      if (!/^\d{1,12}$/.test(text) || touched === undefined) { probes[i] = { commitAt: 0, touched: 0, known: false }; cut = cut || left() <= 0; continue; }
      probes[i] = { commitAt: Number(text) * 1000, touched, known: true };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  // From here to the return nothing is awaited: the board is read once, synchronously, so it is current for every row.
  const tasks = input.tasks(), instances = new Set(input.instancePaths), facts: WorktreeFact[] = [];
  let unread = false;
  parsed.rows.forEach((raw, i) => {
    const path = paths[i]!, probe = probes[i], task = boundTask(tasks, raw.branch), bound = task ? tasks.find(t => t.id === task.id) : undefined;
    if (!probe?.known) unread = true;
    facts.push({
      path, branch: raw.branch, head: raw.head, locked: raw.locked, prunable: raw.prunable,
      main: path === root, instance: instances.has(path),
      lastActiveAt: Math.max(probe?.commitAt ?? 0, probe?.touched ?? 0, task?.workAt ?? 0), activityKnown: probe?.known === true,
      ...(task ? { task: { id: task.id, state: task.state, ...(task.pr !== undefined ? { pr: task.pr } : {}), ...(task.repo !== undefined ? { repo: task.repo } : {}), ...(input.isPrivate?.(task.id) ? { private: true as const } : {}) } } : {}),
      pr: prFromTask(bound, input.observed),
    });
  });
  return { facts, complete: parsed.complete && !cut && !unread, available: true };
}
