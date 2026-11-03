import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * #1057 D5: `ahub worktrees tidy`. This module is the ONLY place a worktree or a local branch is removed, and it runs in the person's own CLI
 * process: the daemon never imports it (a test greps for that). A preview reads facts and runs read-only git; `--confirm <fingerprint>` re-reads
 * everything, refuses the whole run if the row set changed, and otherwise runs exactly two argv shapes per row:
 *
 *   git -C <root> worktree remove <path>        (no --force: git itself refuses a dirty or locked tree)
 *   git -C <root> branch -d <branch>            (never -D: git itself refuses an unmerged branch)
 *
 * No other removal argv exists here, `--force` and `-D` appear in no argv, and `assertRemovalArgv` checks the shape right before each call.
 */

/** One settled row from the hub's `worktrees` reply, resolved against the project root by `rowFromReply`; `head` and `locked` come from git here, never from the daemon. */
export interface TidyRow { path: string; shown: string; branch: string | null; head: string; locked: boolean; reason: string; instance: boolean; taskState?: string }
export type RefusalReason = "main checkout" | "instance worktree" | "dirty" | "locked" | "no branch" | "unpushed commits" | "no upstream" | "branch not merged into the default branch" | "task not approved or cancelled" | "path missing" | "outside the project" | "git could not tell";
export interface TidyEntry { path: string; shown: string; branch: string | null; reason: string; refused: RefusalReason[] }
export interface TidyPlan { entries: TidyEntry[]; removable: TidyEntry[]; fingerprint: string }

/** Read-only and removal git, bounded. `undefined` is a failed or timed-out call, never an empty answer. */
export interface TidyGit { run(cwd: string, args: string[]): { status: number | null; stdout: string } | undefined }

/** The only two removal argv shapes. A word outside them, a flag, or a path that starts with `-` refuses before git runs. */
export function removalArgv(root: string, path: string, branch: string): [string[], string[]] {
  return [["-C", root, "worktree", "remove", path], ["-C", root, "branch", "-d", branch]];
}
export function assertRemovalArgv(argv: readonly string[]): void {
  const [, , verb, action, target] = argv;
  const worktree = argv.length === 5 && argv[0] === "-C" && verb === "worktree" && action === "remove";
  const branch = argv.length === 5 && argv[0] === "-C" && verb === "branch" && action === "-d";
  if (!(worktree || branch) || !target || target.startsWith("-") || argv.some(word => word === "--force" || word === "-f" || word === "-D" || word === "--delete")) throw new Error("refused: not one of the two tidy removal commands");
  if (!argv[1] || argv[1].startsWith("-")) throw new Error("refused: the project root is not a path");
}

const branchOk = (branch: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
const out = (r: { status: number | null; stdout: string } | undefined): string | undefined => r && r.status === 0 ? r.stdout.trim() : undefined;
const raw = (r: { status: number | null; stdout: string } | undefined): string | undefined => r && r.status === 0 ? r.stdout : undefined;

/**
 * The refusal reasons for one settled row, from read-only git. Every check that cannot be answered refuses ("git could not tell"): unknown is never safe.
 * Rows the daemon already shelved as `parked` still pass through these checks: parking is the person's wish to hide a row, not proof it is safe to delete.
 */
export function refusals(row: TidyRow, root: string, git: TidyGit, defaultBranch: string | undefined, exists: (path: string) => boolean = p => { try { return statSync(p).isDirectory(); } catch { return false; } }): RefusalReason[] {
  const why: RefusalReason[] = [];
  if (row.path === root) return ["main checkout"];
  if (row.instance) return ["instance worktree"];
  if (!row.path.startsWith(root + "/")) why.push("outside the project");
  if (row.locked) why.push("locked");
  if (!row.branch || !branchOk(row.branch)) why.push("no branch");
  if (row.taskState !== undefined && row.taskState !== "approved" && row.taskState !== "cancelled") why.push("task not approved or cancelled");
  if (!exists(row.path)) { why.push("path missing"); return why; }
  const status = git.run(row.path, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status || status.status !== 0) why.push("git could not tell"); else if (status.stdout.trim() !== "") why.push("dirty");
  if (row.branch && branchOk(row.branch)) {
    const upstream = git.run(row.path, ["rev-parse", "--abbrev-ref", `${row.branch}@{upstream}`]);
    if (!upstream) why.push("git could not tell");
    else if (upstream.status !== 0) why.push("no upstream");
    else {
      const ahead = out(git.run(row.path, ["rev-list", "--count", `${upstream.stdout.trim()}..${row.branch}`]));
      if (ahead === undefined) why.push("git could not tell"); else if (ahead !== "0") why.push("unpushed commits");
    }
    if (!defaultBranch) why.push("git could not tell");
    else {
      const merged = git.run(row.path, ["merge-base", "--is-ancestor", row.branch, defaultBranch]);
      if (!merged) why.push("git could not tell"); else if (merged.status === 1) why.push("branch not merged into the default branch"); else if (merged.status !== 0) why.push("git could not tell");
    }
  }
  return [...new Set(why)];
}

/** The repository's default branch from its origin HEAD, else `main` or `master` when exactly one exists locally. Read-only. */
export function defaultBranchOf(root: string, git: TidyGit): string | undefined {
  const head = out(git.run(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]));
  if (head && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(head)) return head;
  const local = ["main", "master"].filter(name => git.run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])?.status === 0);
  return local.length === 1 ? local[0] : undefined;
}

/** The fingerprint covers every row's path, branch, HEAD and refusals, in path order: any change to the set or to a row changes it. */
export function fingerprintOf(entries: readonly { path: string; branch: string | null; head: string; refused: readonly string[] }[]): string {
  const hash = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) hash.update(JSON.stringify([e.path, e.branch, e.head, [...e.refused].sort()])).update("\n");
  return hash.digest("hex").slice(0, 16);
}

/**
 * The daemon shows project-relative paths and never an absolute one outside the project. A settled row whose path is outside the project (`outside: true`)
 * or that names `..` cannot be resolved safely, so it becomes a refused row with no path to operate on.
 */
export function rowsFromReply(settled: readonly { path?: unknown; branch?: unknown; reason?: unknown; outside?: unknown; taskState?: unknown }[], root: string, git: TidyGit): TidyRow[] {
  const inventory = raw(git.run(root, ["worktree", "list", "--porcelain", "-z"]));
  const listed = new Map<string, { head: string; locked: boolean }>();
  let current: { path: string; head: string; locked: boolean } | undefined;
  for (const field of (inventory ?? "").split("\0")) {
    if (field === "") { if (current) listed.set(current.path, current); current = undefined; continue; }
    if (field.startsWith("worktree ")) { if (current) listed.set(current.path, current); current = { path: field.slice(9), head: "", locked: false }; }
    else if (current && field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (current && (field === "locked" || field.startsWith("locked "))) current.locked = true;
  }
  if (current) listed.set(current.path, current);
  return settled.flatMap(row => {
    if (typeof row.path !== "string" || row.outside === true || row.path.includes("\0") || row.path.split("/").includes("..")) return [];
    const absolute = row.path === "." ? root : resolve(join(root, row.path));
    const fact = listed.get(absolute);
    // Only a path git itself lists is operated on: the daemon's word alone never names a directory to remove.
    if (!fact) return [];
    return [{ path: absolute, shown: row.path, branch: typeof row.branch === "string" ? row.branch : null, head: fact.head, locked: fact.locked, reason: String(row.reason ?? ""), instance: false, ...(typeof row.taskState === "string" ? { taskState: row.taskState } : {}) }];
  });
}

export function planTidy(rows: readonly TidyRow[], root: string, git: TidyGit): TidyPlan {
  const defaultBranch = defaultBranchOf(root, git);
  const detailed = rows.map(row => ({ row, refused: refusals(row, root, git, defaultBranch) }));
  const entries: TidyEntry[] = detailed.map(({ row, refused }) => ({ path: row.path, shown: row.shown, branch: row.branch, reason: row.reason, refused }));
  return { entries, removable: entries.filter(e => e.refused.length === 0), fingerprint: fingerprintOf(detailed.map(({ row, refused }) => ({ path: row.path, branch: row.branch, head: row.head, refused }))) };
}

export interface TidyOutcome { path: string; shown: string; branch: string; worktreeRemoved: boolean; branchDeleted: boolean; note?: string }
/**
 * Re-read, compare, then remove. `fresh` is a second `planTidy` the caller took AFTER the person typed the fingerprint, so a worktree that
 * changed in between refuses the whole run before anything is removed. Each removal is read back; a failed `worktree remove` skips its branch.
 */
export function confirmTidy(fresh: TidyPlan, fingerprint: string, root: string, git: TidyGit): { ok: false; error: string } | { ok: true; outcomes: TidyOutcome[] } {
  if (!/^[0-9a-f]{16}$/.test(fingerprint)) return { ok: false, error: "the fingerprint is 16 hex digits, from the preview line `fingerprint`" };
  if (fresh.fingerprint !== fingerprint) return { ok: false, error: "the worktrees changed since the preview, so nothing was removed; run ahub worktrees tidy again and confirm the new fingerprint" };
  if (!fresh.removable.length) return { ok: false, error: "nothing is safe to remove; see the refusals in the preview" };
  const outcomes: TidyOutcome[] = [];
  for (const entry of fresh.removable) {
    const branch = entry.branch!;
    const [removeWorktree, deleteBranch] = removalArgv(root, entry.path, branch);
    assertRemovalArgv(removeWorktree); assertRemovalArgv(deleteBranch);
    const removed = git.run(root, removeWorktree.slice(2));
    const gone = removed?.status === 0 && git.run(root, ["worktree", "list", "--porcelain", "-z"])?.stdout.split("\0").every(field => field !== `worktree ${entry.path}`) === true;
    if (!gone) { outcomes.push({ path: entry.path, shown: entry.shown, branch, worktreeRemoved: false, branchDeleted: false, note: "git refused or did not confirm removing the worktree; it and its branch were kept" }); continue; }
    const deleted = git.run(root, deleteBranch.slice(2));
    const branchGone = deleted?.status === 0 && git.run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])?.status === 1;
    outcomes.push({ path: entry.path, shown: entry.shown, branch, worktreeRemoved: true, branchDeleted: branchGone, ...(branchGone ? {} : { note: "the worktree was removed; git kept the branch (not fully merged), which is safe" }) });
  }
  return { ok: true, outcomes };
}

/** Real git, bounded, run in this CLI process. Only the removal argv of `removalArgv` and the read shapes the checks above use reach it. */
export const realTidyGit = (spawn: (argv: string[], cwd: string) => { status: number | null; stdout: string } | undefined): TidyGit => ({
  run(cwd, args) {
    const write = args[0] === "worktree" && args[1] === "remove" || args[0] === "branch" && args[1] === "-d";
    if (write) assertRemovalArgv(["-C", cwd, ...args]); // a removal always runs in the project root, with the worktree path or branch as its operand
    return spawn(["-C", cwd, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], cwd);
  },
});
