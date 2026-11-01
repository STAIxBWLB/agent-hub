import type { Database } from "./db-schema.ts";
import { openHubDatabase } from "./db-schema.ts";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./child-process.ts";
import type { Touch } from "./conflicts.ts";
import { hubGitSync } from "./git.ts";
import { realPath } from "./project.ts";

/**
 * Per-turn workspace snapshots (issue #33): git tree objects written through a copy of the index, so the user's index
 * and HEAD never change. They hold tracked and unignored files as `git add -A` sees them, shell-made changes included.
 * ponytail: snapshots run synchronously on the turn boundary (before the agent sees its prompt); a very large tree
 * costs that much latency per turn for unbudgeted CLI calls. The daemon shares a bounded burst deadline;
 * exhausted boundaries are unknown. `snapshots.enabled` is the switch and `turn_end.snapshotMs` the measurement.
 * ponytail: the deadline caps Git child waits, not synchronous metadata/index-copy syscalls. If those become
 * measured blockers, move capture to an isolated worker with native-boundary admission fencing.
 * ponytail: the trees are unreferenced, so `git gc` may prune them after gc.pruneExpire (two weeks by default); undo
 * of an older turn says so. Refs under refs/agenthub/ would keep them, at the cost of showing up in the user's repo.
 */
/** `now` is a host-only clock (#661): a test holds it fixed so the budget never runs out whatever the runner's speed. Production leaves it unset (performance.now). */
export interface SnapshotBudget { deadline: number; now?: () => number; }
export const budgetNow = (budget: SnapshotBudget): number => budget.now ? budget.now() : performance.now();
export class SnapshotBudgetExceeded extends Error {
  constructor() { super("snapshot burst budget exhausted; boundary evidence is unknown"); }
}
const SNAPSHOT_TIMEOUT_MS = 10_000;
/**
 * The wall-clock timeout of one git child. Production (no `budget.now`): the remaining budget, between 1 ms and the 10 s ceiling, so a child is killed at the budget.
 * ponytail: a host-held clock (`budget.now`, only the host-only snapshotClock seam sets it) holds the deadline, so the child's timeout is the 10 s ceiling, not the remaining budget:
 * with the clock fixed the remaining budget never shrinks, and 250 ms of real time per child timed a slow git out under load (#554). Production never sets `now`, so its child is still killed
 * at the budget. A child past the 10 s ceiling still reports ETIMEDOUT and the evidence stays unknown. Upgrade path: a fake spawn seam, if a held clock ever needs to model a slow child.
 */
export const childTimeoutMs = (budget?: SnapshotBudget): number =>
  budget?.now ? SNAPSHOT_TIMEOUT_MS : Math.max(1, Math.min(SNAPSHOT_TIMEOUT_MS, Math.floor(budget ? budget.deadline - budgetNow(budget) : SNAPSHOT_TIMEOUT_MS)));
const git = (top: string | Repo, args: string[], env: Record<string, string> = {}, budget?: SnapshotBudget, maxBuffer?: number, input?: string | Buffer) => {
  const argv = repoGitArgs(top, args);
  const remaining = budget ? budget.deadline - budgetNow(budget) : SNAPSHOT_TIMEOUT_MS;
  if (remaining <= 0) throw new SnapshotBudgetExceeded();
  const result = hubGitSync(argv, {
    encoding: "utf8", env: { ...repoGitEnv(top), ...env }, ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(input === undefined ? {} : { input }),
    timeout: childTimeoutMs(budget),
  });
  if (budget && (budgetNow(budget) >= budget.deadline || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")) throw new SnapshotBudgetExceeded();
  return result;
};

/** A repository and where the project sits in it: `prefix` is "" at the top level, else "sub/dir/". */
export interface Repo {
  top: string;
  dir: string;
  prefix: string;
  shadow?: true;
}

/** Refuse links throughout metadata, including loose-object fan-outs and packed-object files. */
function shadowStorageSafe(dir: string): boolean {
  let entries = 0;
  const visit = (path: string, depth: number): boolean => {
    if (++entries > 20000 || depth > 32) return false;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) return st.nlink === 1;
    if (!st.isDirectory()) return false;
    return readdirSync(path).every(name => visit(join(path, name), depth + 1));
  };
  try {
    if (lstatSync(join(dir, "commondir"), { throwIfNoEntry: false }) || lstatSync(join(dir, "objects/info/alternates"), { throwIfNoEntry: false })) return false;
    return visit(dir, 0);
  } catch { return false; }
}
/** Explicit flags keep the shadow work tree at its verified project root. */
export function repoGitArgs(repo: string | Repo, args: string[]): string[] {
  const top = typeof repo === "string" ? repo : repo.top;
  if (typeof repo !== "string" && repo.shadow) {
    const parent = lstatSync(join(repo.top, ".agenthub"), { throwIfNoEntry: false });
    const ignore = parent?.isDirectory() && !parent.isSymbolicLink() ? lstatSync(join(repo.top, ".agenthub/ignore"), { throwIfNoEntry: false }) : undefined;
    if (!parent?.isDirectory() || parent.isSymbolicLink() || ignore && (!ignore.isFile() || ignore.isSymbolicLink() || ignore.nlink !== 1) || repo.dir !== join(repo.top, ".agenthub/shadow.git") || !shadowStorageSafe(repo.dir)) throw new Error("shadow repository metadata is invalid or linked; operation refused");
  }
  return ["-C", top, ...(typeof repo !== "string" && repo.shadow ? ["--git-dir=" + repo.dir, "--work-tree=" + repo.top, "-c", "core.excludesFile=" + join(repo.top, ".agenthub", "ignore")] : []), ...args];
}
export function repoGitEnv(repo: string | Repo, env = process.env): NodeJS.ProcessEnv {
  return { ...childEnv(env), ...(typeof repo !== "string" && repo.shadow ? { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1" } : {}) };
}

/** The repository holding `root`, or undefined when it is not inside a work tree. */
export function repoOf(root: string, budget?: SnapshotBudget): Repo | undefined {
  const r = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"], {}, budget);
  if (r.status === 0) {
    const [top, dir, prefix = ""] = r.stdout.replace(/\n$/, "").split("\n");
    if (top && dir) return { top, dir, prefix };
  }
  const top = realPath(root), hub = join(top, ".agenthub"), dir = join(hub, "shadow.git");
  const parent = lstatSync(hub, { throwIfNoEntry: false });
  if (!parent?.isDirectory() || parent.isSymbolicLink()) return undefined;
  const own = lstatSync(dir, { throwIfNoEntry: false });
  if (!own?.isDirectory() || own.isSymbolicLink()) return undefined;
  for (const name of ["objects", "refs", "hooks", "info"]) { const st = lstatSync(join(dir, name), { throwIfNoEntry: false }); if (!st?.isDirectory() || st.isSymbolicLink()) return undefined; }
  for (const file of ["config", "HEAD"]) { const st = lstatSync(join(dir, file), { throwIfNoEntry: false }); if (!st?.isFile() || st.isSymbolicLink() || st.nlink !== 1) return undefined; }
  if (existsSync(join(dir, "commondir")) || existsSync(join(dir, "objects/info/alternates"))) return undefined;
  const ignore = lstatSync(join(hub, "ignore"), { throwIfNoEntry: false });
  if (ignore && (!ignore.isFile() || ignore.isSymbolicLink() || ignore.nlink !== 1)) return undefined;
  if (!shadowStorageSafe(dir)) return undefined;
  const repo: Repo = { top, dir: realPath(dir), prefix: "", shadow: true };
  const probe = git(repo, ["rev-parse", "--absolute-git-dir"], {}, budget);
  return probe.status === 0 && realPath(probe.stdout.trim()) === repo.dir ? repo : undefined;
}
/** Opt-in creation only; a real repository is never replaced or modified. */
export function initShadow(root: string): boolean {
  const top = realPath(root), hub = join(top, ".agenthub"), dir = join(hub, "shadow.git"), existing = repoOf(top);
  if (existing) { if (!existing.shadow) throw new Error("project already has a Git work tree; shadow mode is for non-git folders"); return false; }
  const parent = lstatSync(hub, { throwIfNoEntry: false });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error(".agenthub must be a project directory, not a link");
  if (lstatSync(dir, { throwIfNoEntry: false })) throw new Error("existing shadow metadata is invalid; nothing was replaced");
  mkdirSync(hub, { recursive: true });
  const result = hubGitSync(["init", "--bare", "--quiet", dir], { cwd: top, encoding: "utf8", timeout: SNAPSHOT_TIMEOUT_MS, env: { ...childEnv(process.env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (result.status !== 0) throw new Error("could not initialize shadow repository");
  writeFileSync(join(dir, "info/exclude"), ".agenthub/shadow.git/\n.agenthub/state/\n.agenthub/archive/\n.agenthub/config.local.json\n.agenthub/routing.local.toml\n", { mode: 0o600 });
  return true;
}

/**
 * A path as a pathspec that means only itself: `app/[slug]/page.tsx` must not match `app/s/page.tsx`. Per-path
 * `:(literal)` rather than --literal-pathspecs, which would also switch off the state exclude's glob.
 */
const literal = (path: string) => `:(literal)${path}`;
/** Only the project's own files: a hub in a subdirectory of a larger repository snapshots that subdirectory. */
const scope = (repo: Repo) => (repo.prefix ? literal(repo.prefix) : ".");

/** Committed HEAD tree, null for an unborn HEAD, undefined when evidence cannot be read. */
export function headTree(repo: Repo, budget?: SnapshotBudget): string | null | undefined {
  const result = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], {}, budget);
  return result.status === 0 ? result.stdout.trim() : result.status === 1 ? null : undefined;
}

/** One probe binds the committed HEAD id and tree; an unborn HEAD needs positive missing-ref proof. */
export function headState(repo: Repo, budget?: SnapshotBudget): { head: string | null; tree: string | null } | undefined {
  const result = git(repo, ["rev-parse", "--quiet", "HEAD", "HEAD^{tree}"], {}, budget);
  const values = result.status === 0 ? result.stdout.trim().split("\n") : [];
  if (values.length === 2 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(values[0]!) &&
      /^[0-9a-f]+$/.test(values[1]!) && values[0]!.length === values[1]!.length) return { head: values[0]!, tree: values[1]! };
  if (result.status === 0) return undefined;
  const symbolic = git(repo, ["symbolic-ref", "--quiet", "HEAD"], {}, budget);
  const ref = symbolic.status === 0 ? symbolic.stdout.trim() : "";
  if (!ref.startsWith("refs/heads/")) return undefined;
  const missing = git(repo, ["show-ref", "--verify", "--quiet", ref], {}, budget);
  if (missing.status !== 1) return undefined;
  const current = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], {}, budget);
  return current.status === 1 ? { head: null, tree: null } : undefined;
}

/** One bounded probe covers shared local/remote branch refs, including commit and push progress. Names never escape. */
export function branchHeads(repo: Repo, budget?: SnapshotBudget): string | undefined {
  const result = git(repo, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)", "refs/heads/", "refs/remotes/"], {}, budget, 1024 * 1024);
  if (result.status !== 0 || result.error) return undefined;
  const digest = createHash("sha256").update(result.stdout).digest("hex");
  if (budget && budgetNow(budget) >= budget.deadline) throw new SnapshotBudgetExceeded();
  return digest;
}

/** Negative canonical evidence needs exclusive scope, including detached linked worktrees. Paths stay host-only. */
export function soleWorktree(repo: Repo, budget?: SnapshotBudget): boolean | undefined {
  const result = git(repo, ["worktree", "list", "--porcelain", "-z"], {}, budget, 1024 * 1024);
  if (result.status !== 0 || result.error) return undefined;
  // A project-bound shadow registers its private bare Git directory, not its explicit --work-tree root.
  const registeredRoot = repo.shadow ? repo.dir : repo.top;
  let count = 0;
  for (const field of result.stdout.split("\0")) {
    if (budget && budgetNow(budget) >= budget.deadline) throw new SnapshotBudgetExceeded();
    if (!field.startsWith("worktree ")) continue;
    if (field.slice(9) !== registeredRoot || ++count > 1) return false;
  }
  return count === 1 ? true : undefined;
}

/** A bounded append cursor; raw reflog identities and messages never leave the reader. */
export interface HeadMoveCursor {
  readonly head: string | null;
  readonly tree: string | null;
  readonly unbornRefHash?: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly anchorOffset: number;
  readonly anchor: string;
}
const HEAD_LOG_TAIL_BYTES = 4096;
const HEAD_LOG_MAX_APPEND_BYTES = 128 * 1024;
const HEAD_LOG_MAX_MOVES = 64;
const checkSnapshotBudget = (budget?: SnapshotBudget) => { if (budget && budgetNow(budget) >= budget.deadline) throw new SnapshotBudgetExceeded(); };
const sameLogFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function readHeadLog<T>(repo: Repo, budget: SnapshotBudget | undefined, read: (fd: number, stat: Stats) => T | undefined): T | undefined {
  let fd: number | undefined;
  try {
    checkSnapshotBudget(budget);
    const logs = join(repo.dir, "logs"), file = join(logs, "HEAD");
    const directory = lstatSync(logs);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
    const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameLogFile(named, before) || before.size !== named.size) return undefined;
    const result = read(fd, before);
    const after = fstatSync(fd), current = lstatSync(file), parent = lstatSync(logs);
    checkSnapshotBudget(budget);
    if (!sameLogFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameLogFile(after, current) || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs ||
        !parent.isDirectory() || parent.isSymbolicLink() || !sameLogFile(directory, parent)) return undefined;
    return result;
  } catch (error) { if (error instanceof SnapshotBudgetExceeded) throw error; return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function headLogBytes(fd: number, offset: number, length: number, budget?: SnapshotBudget): Buffer | undefined {
  const data = Buffer.alloc(length);
  let used = 0;
  while (used < length) {
    checkSnapshotBudget(budget);
    const count = readSync(fd, data, used, length - used, offset + used);
    if (!count) return undefined;
    used += count;
  }
  return data;
}
const headLogHash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function headLogRow(line: string): { old: string; next: string; action: string } | undefined {
  const row = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [^\r\n\t]+ [0-9]+ [+-][0-9]{4}\t([^\r\n]*)$/.exec(line);
  return row && row[1]!.length === row[2]!.length ? { old: row[1]!, next: row[2]!, action: row[3]! } : undefined;
}
function missingHeadLog(repo: Repo): boolean {
  try {
    const parent = lstatSync(join(repo.dir, "logs"));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  try { lstatSync(join(repo.dir, "logs", "HEAD")); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
/** Read only a bounded, stable symbolic HEAD when the caller already proved it unborn. */
function symbolicHeadRef(repo: Repo, budget?: SnapshotBudget): string | undefined {
  let fd: number | undefined;
  try {
    checkSnapshotBudget(budget);
    const file = join(repo.dir, "HEAD"), named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 4096) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameLogFile(named, before) || named.size !== before.size) return undefined;
    const bytes = headLogBytes(fd, 0, before.size, budget);
    const after = fstatSync(fd), current = lstatSync(file);
    checkSnapshotBudget(budget);
    if (!bytes || !sameLogFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameLogFile(after, current) || after.size !== current.size ||
        after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) return undefined;
    return /^ref: (refs\/heads\/[^\r\n]+)\n?$/.exec(bytes.toString("utf8"))?.[1];
  } catch (error) { if (error instanceof SnapshotBudgetExceeded) throw error; return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** provenHead is host-only, paired with expectedTree from the very same headState probe. */
export function headMoveCursor(repo: Repo, expectedTree: string | null, budget?: SnapshotBudget, provenHead?: string | null): HeadMoveCursor | undefined {
  if (provenHead !== undefined && (provenHead === null) !== (expectedTree === null)) return undefined;
  if (expectedTree === null) {
    let ref: string | undefined;
    if (provenHead === null) ref = symbolicHeadRef(repo, budget);
    else {
      const symbolic = git(repo, ["symbolic-ref", "--quiet", "HEAD"], {}, budget);
      ref = symbolic.status === 0 ? symbolic.stdout.trim() : undefined;
      if (!ref?.startsWith("refs/heads/")) return undefined;
      const missing = git(repo, ["show-ref", "--verify", "--quiet", ref], {}, budget);
      if (missing.status !== 1) return undefined;
      const current = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], {}, budget);
      if (current.status !== 1) return undefined;
    }
    if (!ref || !missingHeadLog(repo)) return undefined;
    checkSnapshotBudget(budget);
    return { head: null, tree: null, unbornRefHash: createHash("sha256").update(ref).digest("hex"), dev: 0, ino: 0, size: 0, anchorOffset: 0, anchor: headLogHash(Buffer.alloc(0)) };
  }
  const cursor = readHeadLog(repo, budget, (fd, stat): HeadMoveCursor | undefined => {
    if (stat.size <= 0 || !Number.isSafeInteger(stat.size)) return undefined;
    const anchorOffset = Math.max(0, stat.size - HEAD_LOG_TAIL_BYTES);
    const tail = headLogBytes(fd, anchorOffset, stat.size - anchorOffset, budget);
    if (!tail || tail[tail.length - 1] !== 10) return undefined;
    const text = tail.toString("utf8"), start = text.lastIndexOf("\n", text.length - 2) + 1;
    if (anchorOffset > 0 && start === 0) return undefined;
    const last = headLogRow(text.slice(start, -1));
    if (!last) return undefined;
    return { head: last.next, tree: expectedTree, dev: stat.dev, ino: stat.ino, size: stat.size, anchorOffset, anchor: headLogHash(tail) };
  });
  if (!cursor) return undefined;
  if (provenHead !== undefined) return cursor.head === provenHead ? cursor : undefined;
  // Bind the observed log tip and its immutable tree to current HEAD in one bounded probe.
  const current = git(repo, ["rev-parse", "--quiet", "HEAD", `${cursor.head}^{tree}`], {}, budget);
  const values = current.status === 0 ? current.stdout.trim().split("\n") : [];
  return values.length === 2 && values[0] === cursor.head && values[1] === expectedTree ? cursor : undefined;
}
export function incomingHeadPaths(repo: Repo, start: HeadMoveCursor, end: HeadMoveCursor, budget?: SnapshotBudget): string[] | undefined {
  const validCursor = (cursor: HeadMoveCursor) => Number.isSafeInteger(cursor.size) && cursor.size >= 0 &&
    (cursor.size > 0 ? !!cursor.head && !!cursor.tree : cursor.head === null && cursor.tree === null && /^[0-9a-f]{64}$/.test(cursor.unbornRefHash ?? "")) &&
    cursor.anchorOffset === Math.max(0, cursor.size - HEAD_LOG_TAIL_BYTES) && /^[0-9a-f]{64}$/.test(cursor.anchor);
  if (!validCursor(start) || !validCursor(end) || (start.size > 0 && (start.dev !== end.dev || start.ino !== end.ino)) ||
      end.size < start.size || end.size - start.size > HEAD_LOG_MAX_APPEND_BYTES) return undefined;
  if (!end.size) {
    checkSnapshotBudget(budget);
    const unchanged = start.unbornRefHash === end.unbornRefHash && missingHeadLog(repo);
    checkSnapshotBudget(budget);
    return unchanged ? [] : undefined;
  }
  const appended = readHeadLog(repo, budget, (fd, stat) => {
    if (stat.dev !== end.dev || stat.ino !== end.ino || stat.size < end.size) return undefined;
    for (const cursor of [start, end]) {
      const anchor = headLogBytes(fd, cursor.anchorOffset, cursor.size - cursor.anchorOffset, budget);
      if (!anchor || headLogHash(anchor) !== cursor.anchor) return undefined;
    }
    return headLogBytes(fd, start.size, end.size - start.size, budget);
  });
  if (!appended) return undefined;
  if (!appended.length) return start.head === end.head && start.tree === end.tree ? [] : undefined;
  if (appended[appended.length - 1] !== 10) return undefined;
  const lines = appended.toString("utf8").slice(0, -1).split("\n");
  if (lines.length > HEAD_LOG_MAX_MOVES) return undefined;

  const diffCache = new Map<string, string[] | undefined>();
  const ancestorCache = new Map<string, boolean>();
  const diffOf = (from: string, to: string): string[] | undefined => {
    if (from === to) return [];
    const key = `${from}..${to}`;
    if (diffCache.has(key)) return diffCache.get(key);
    const res = knownChangedPaths(repo, from, to, budget);
    diffCache.set(key, res);
    return res;
  };
  const isAncestor = (oldCommit: string, nextCommit: string): boolean => {
    if (oldCommit === nextCommit) return true;
    const key = `${oldCommit}..${nextCommit}`;
    if (ancestorCache.has(key)) return ancestorCache.get(key)!;
    const ancestor = git(repo, ["merge-base", "--is-ancestor", oldCommit, nextCommit], {}, budget);
    const ok = ancestor.status === 0;
    ancestorCache.set(key, ok);
    return ok;
  };

  const parsedRows: Array<ReturnType<typeof headLogRow>> = [];
  const batchCandidates = new Set<string>();
  for (const line of lines) {
    const row = headLogRow(line);
    parsedRows.push(row);
    if (!row) continue;
    const separator = row.action.indexOf(": ");
    const action = separator < 0 ? "" : row.action.slice(0, separator);
    // #612: diff-tree --stdin compares a commit to its first parent. In git sequencer, only pick
    // and initial/regular commits have row.old as the parent of row.next. Sequencer squash, fixup,
    // reword and edit amend the commit, so row.next's parent is row.old's parent. Only batch rows
    // where row.old is the parent (pick and commit); other rows are diffed individually.
    const isPickOrCommit = /^.+ \(pick\)$/.test(action) || action === "commit";
    if (isPickOrCommit && row.old !== row.next && !/^0+$/.test(row.old)) {
      batchCandidates.add(row.next);
    }
  }

  // Batch single-parent pick/commit diffs across the boundary to stay within burst budget (#612).
  if (batchCandidates.size > 1) {
    const commitList = [...batchCandidates];
    const stdinInput = commitList.join("\n") + "\n";
    const batchRes = git(repo, ["diff-tree", "--stdin", "--always", "-r", "--no-renames", "--raw", "-z", "--", scope(repo)], {}, budget, undefined, stdinInput);
    if (batchRes.status === 0) {
      const parts = batchRes.stdout.split("\0");
      if (parts.length && parts[parts.length - 1] === "") parts.pop();
      let i = 0;
      while (i < parts.length) {
        const commit = parts[i++];
        if (!commit) continue;
        const paths: string[] = [];
        while (i < parts.length && parts[i]?.startsWith(":")) {
          i++; // skip raw metadata: :oldmode newmode oldsha newsha status
          if (i < parts.length && parts[i]) {
            paths.push(parts[i++]!);
          }
        }
        for (const r of parsedRows) {
          if (r && r.next === commit && r.old !== r.next) {
            const sep = r.action.indexOf(": ");
            const act = sep < 0 ? "" : r.action.slice(0, sep);
            if (/^.+ \(pick\)$/.test(act) || act === "commit") {
              diffCache.set(`${r.old}..${r.next}`, [...paths]);
            }
          }
        }
      }
    }
  }

  const own = new Set<string>(), incoming = new Set<string>();
  let previous = start.head;
  for (const row of parsedRows) {
    checkSnapshotBudget(budget);
    if (!row || (previous === null ? !/^0+$/.test(row.old) : row.old !== previous)) return undefined;
    // Git preserves the invoking command in sequencer actions (for example pull -q --rebase (pick)).
    // Classify the native phase before considering ordinary command-shaped incoming actions.
    const separator = row.action.indexOf(": ");
    const action = separator < 0 ? "" : row.action.slice(0, separator);
    const detail = separator < 0 ? "" : row.action.slice(separator + 2);
    const sequencerOwn = /^.+ \((?:pick|reword|edit|squash|fixup|continue|finish)\)$/.test(action);
    const ownMove = sequencerOwn || /^(?:commit(?: \(amend\)| \(initial\))?|cherry-pick)$/.test(action);
    const incomingStart = /^(?:rebase|pull(?: [^(]*)?) \(start\)$/.test(action) && /^checkout .+/.test(detail);
    const incomingCommand = !action.includes("(") && /^(?:merge|pull)(?: [^:]+)?$/.test(action) && !!detail;
    let incomingMove = !ownMove && (incomingStart || incomingCommand || action === "checkout" && /^moving from .+ to .+$/.test(detail));
    if (action === "reset" && /^moving to .+/.test(detail)) {
      // Policy: a positively fast-forward reset stays incoming, even when its target contains the peer's own
      // descendant commit made in another worktree during the turn. Reflog ancestry alone cannot distinguish
      // local worktree coordination from external branch fast-forwards; classifying it as incoming safely
      // excludes external commits from local turn attribution and undo. Rewinds/unknown resets refuse.
      if (!isAncestor(row.old, row.next)) return undefined;
      incomingMove = true;
    }
    if (!ownMove && !incomingMove) return undefined;
    let paths: string[] | undefined;
    if (/^0+$/.test(row.old)) {
      const root = git(repo, ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "--name-only", "-z", row.next, "--", scope(repo)], {}, budget);
      paths = root.status === 0 ? root.stdout.split("\0").filter(Boolean) : undefined;
    } else if (incomingStart) {
      // #612: take incoming start paths as merge-base(old, upstream)..upstream instead of old..upstream,
      // so the peer's replayed own commits do not overlap and only true upstream paths are excluded.
      // Any remaining ambiguity (no merge base, criss-cross multiple merge bases) stays unknown.
      const mb = git(repo, ["merge-base", "--all", row.old, row.next], {}, budget);
      if (mb.status !== 0) return undefined;
      const bases = mb.stdout.trim().split("\n").map(s => s.trim()).filter(Boolean);
      const base = bases[0];
      if (bases.length !== 1 || !base || !/^[0-9a-f]{40,64}$/.test(base)) return undefined;
      paths = base === row.next ? [] : diffOf(base, row.next);
    } else {
      paths = diffOf(row.old, row.next);
    }
    if (!paths) return undefined;
    for (const path of paths) { checkSnapshotBudget(budget); (ownMove ? own : incoming).add(path); }
    previous = row.next;
  }
  if (previous !== end.head) return undefined;
  // A path touched by both kinds cannot be separated at file-level undo granularity.
  const hasAncestor = (paths: Set<string>, path: string) => {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      checkSnapshotBudget(budget);
      if (paths.has(path.slice(0, at))) return true;
    }
    return false;
  };
  for (const path of own) {
    checkSnapshotBudget(budget);
    if (incoming.has(path) || hasAncestor(incoming, path)) return undefined;
  }
  for (const path of incoming) {
    checkSnapshotBudget(budget);
    if (hasAncestor(own, path)) return undefined;
  }
  checkSnapshotBudget(budget);
  return [...incoming];
}

/** A tree id for the project's files as they are now, leaving out the hub's own state. */
export function snapshot(repo: Repo, budget?: SnapshotBudget): string | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "ahub-snap-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const index = join(repo.dir, "index");
    if (existsSync(index)) {
      // git trusts an entry's stat only when the entry is older than the index file, and compares in whole seconds. A
      // copy written now makes a same-size edit in the second the index was written look clean: keep the original's
      // time. Taken before the copy, so an index replaced in between gives the copy an earlier time (safe), not later.
      const { atime, mtime } = statSync(index);
      copyFileSync(index, env.GIT_INDEX_FILE);
      utimesSync(env.GIT_INDEX_FILE, atime, mtime);
    }
    // `ahub reset --all` archives hub.db (task text, PII included) under .agenthub/archive: never copy it either.
    if (git(repo, ["add", "-A", "--", scope(repo), ":(exclude,glob)**/.agenthub/state/**", ":(exclude,glob)**/.agenthub/archive/**", ...(repo.shadow ? [":(exclude,glob)**/.agenthub/shadow.git/**"] : [])], env, budget).status !== 0) return undefined;
    // The copy starts from the user's index: hub state somebody tracked or staged is still in it, and the exclude above
    // only keeps `add` from touching it. Take it out explicitly; -f because staged state the hub has rewritten since
    // matches neither HEAD nor the file, which `rm --cached` otherwise refuses. Only the copy changes.
    if (git(repo, ["rm", "-r", "-f", "--cached", "--quiet", "--ignore-unmatch", "--", ":(glob)**/.agenthub/state/**", ":(glob)**/.agenthub/archive/**", ...(repo.shadow ? [":(glob)**/.agenthub/shadow.git/**"] : [])], env, budget).status !== 0) return undefined;
    const r = git(repo, ["write-tree"], env, budget);
    return r.status === 0 ? r.stdout.trim() : undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Project paths (relative to the top level) that differ between two trees. */
export function knownChangedPaths(repo: Repo, from: string, to: string, budget?: SnapshotBudget): string[] | undefined {
  if (from === to) return [];
  const r = git(repo, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to, "--", scope(repo)], {}, budget);
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : undefined;
}
export function changedPaths(repo: Repo, from: string, to: string): string[] {
  return knownChangedPaths(repo, from, to) ?? [];
}

const inTree = (top: string | Repo, tree: string, path: string) => git(top, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]).status === 0;

/** Whether a snapshot's tree is still in the object store (`git gc` prunes unreferenced ones eventually). */
export const hasTree = (top: string | Repo, tree: string): boolean => git(top, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;

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
  const back = paths.filter((p) => inTree(repo, startTree, p));
  for (const path of paths.filter((p) => !back.includes(p))) rmSync(join(repo.top, path), { force: true });
  for (const path of back) {
    if (git(repo, ["restore", `--source=${startTree}`, "--worktree", "--", literal(path)]).status !== 0) throw new Error(`could not restore ${path}`);
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
  /** Dirty submodules at the turn's end, whose contents nothing here observes (#798 D2). Absent: not recorded (an older turn, or git could not answer), which is unknown, never none. */
  unobserved?: string[];
  native: string | null;
}

/**
 * Parse `git status --porcelain=v2 -z` output into the paths of dirty submodules (#798 D2). A submodule's
 * uncommitted edits never move the superproject's gitlink, so a diff of two snapshot trees cannot see them.
 * Submodule entries are the only ones whose mode field starts with `S`; `N` (normal) entries never qualify.
 */
export function parseDirtySubmodules(z: string): string[] {
  const entries = z.split("\0");
  const found = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry === "") continue;
    const kind = entry[0];
    if (kind === "1") {
      // `1 XY SUB mH mI mW hH hI PATH`: the rest carries 7 spaces, so the path starts after the last one.
      const rest = entry.slice(2);
      const cut = nthSpace(rest, 6);
      const path = cut < 0 ? "" : rest.slice(cut + 1);
      if (path && submoduleField(rest.slice(0, cut))) found.add(path);
    } else if (kind === "2") {
      // `2 XY SUB mH mI mW hH hI Xscore PATH`, then the next entry is the original path: skip it.
      const rest = entry.slice(2);
      const cut = nthSpace(rest, 7);
      const path = cut < 0 ? "" : rest.slice(cut + 1);
      if (path && submoduleField(rest.slice(0, cut))) found.add(path);
      i++;
    } else if (kind === "u") {
      // `u XY SUB m1 m2 m3 mW h1 h2 h3 PATH`: nine spaces in the rest, then the path.
      const rest = entry.slice(2);
      const cut = nthSpace(rest, 8);
      const path = cut < 0 ? "" : rest.slice(cut + 1);
      if (path && submoduleField(rest.slice(0, cut))) found.add(path);
    }
    // `?`, `!` and `#` entries carry no mode field: ignore them.
  }
  return [...found].sort();
}

/** porcelain-v2 fields are `XY SUB ...`: the submodule marker is the first character of the second field. */
const submoduleField = (fields: string): boolean => fields.slice(3, 4) === "S";
/** Index of the nth space (0-based) after the leading kind character, or -1 when the entry is malformed. */
function nthSpace(rest: string, n: number): number {
  let at = -1;
  for (let seen = 0; seen <= n; seen++) {
    at = rest.indexOf(" ", at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/**
 * Dirty submodules of a repository: modified, untracked or new commits inside a submodule worktree are invisible
 * to snapshot tree diffs (#798 D2). Returns undefined when git cannot answer. A project without `.gitmodules`
 * pays no git call at all (D4).
 */
export function dirtySubmodules(repo: Repo, budget?: SnapshotBudget): string[] | undefined {
  if (repo.shadow || !existsSync(join(repo.top, ".gitmodules"))) return [];
  const result = git(repo, ["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--", scope(repo)], { GIT_OPTIONAL_LOCKS: "0" }, budget, 1024 * 1024);
  return result.status === 0 ? parseDirtySubmodules(result.stdout) : undefined;
}

/**
 * One git-config value as git reads it: an unquoted `#` or `;` starts a comment, a quoted run keeps them, quotes are dropped, and `\"` and `\\` are unescaped inside a quoted
 * run. ponytail: other escapes (`\t`, octal) are kept as the character after the backslash; use `git config -f .gitmodules --get-regexp path` if a name needs them.
 */
function configValue(raw: string): string {
  let out = "", keep = 0, quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted && c === "\\" && i + 1 < raw.length) { out += raw[++i]; keep = out.length; continue; }
    if (c === '"') { quoted = !quoted; keep = out.length; continue; }
    if (!quoted && (c === "#" || c === ";")) break;
    if (!quoted && out.length === 0 && /\s/.test(c)) continue; // leading blanks
    out += c;
    if (quoted || !/\s/.test(c)) keep = out.length;       // trailing blanks outside quotes are not part of the value
  }
  return out.slice(0, keep);
}

/**
 * The submodule paths a project declares, relative to the project (#798 D1), read from `.gitmodules` with no git call. Empty without the file, and for a shadow
 * repository. A path outside the project's own directory in a larger repository is not the project's. A path git quotes (`"a\tb"`) is taken as written, never
 * unescaped beyond `\"` and `\\`: see `configValue`.
 */
export function submodulePaths(repo: Repo): string[] {
  if (repo.shadow) return [];
  let text: string;
  try { text = readFileSync(join(repo.top, ".gitmodules"), "utf8"); } catch { return []; }
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*path\s*=(.*)$/.exec(line);
    let path = match ? configValue(match[1]!) : "";
    path = path.replace(/\/+$/, "");
    if (path && !path.startsWith("/") && !path.split("/").includes("..") && path.startsWith(repo.prefix)) found.add(path.slice(repo.prefix.length));
  }
  return [...found].sort();
}

/** Turn records in hub.db: the daemon writes them, `ahub turns` and `ahub undo` read them. */
export class Turns {
  private readonly db: Database;
  constructor(path: string, readonly?: boolean) {
    this.db = openHubDatabase(path, readonly ? { readonly: true } : { create: true });
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
    this.db.run("CREATE TABLE IF NOT EXISTS turn_workspaces (turn TEXT PRIMARY KEY, root TEXT NOT NULL, start_tree TEXT, end_tree TEXT, changed TEXT NOT NULL DEFAULT '[]')");
    this.db.run("CREATE TABLE IF NOT EXISTS turn_unobserved (turn TEXT PRIMARY KEY, paths TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS task_snapshots (task INTEGER NOT NULL, proposed_at INTEGER NOT NULL, start_tree TEXT, PRIMARY KEY (task, proposed_at))");
  }
  /** A proposal's original project snapshot; task ids may be reused after reset. Never repair a missing baseline later. */
  rememberTaskStart(task: number, proposedAt: number, tree: string | undefined): void {
    this.db.query("INSERT OR IGNORE INTO task_snapshots (task, proposed_at, start_tree) VALUES (?, ?, ?)").run(task, proposedAt, tree ?? null);
  }
  taskStart(task: number, proposedAt: number): string | undefined {
    try {
      const row = this.db.query("SELECT start_tree FROM task_snapshots WHERE task = ? AND proposed_at = ?").get(task, proposedAt) as { start_tree: string | null } | null;
      return row?.start_tree ?? undefined;
    } catch (error) {
      if (/no such table/.test((error as Error).message)) return undefined;
      throw error;
    }
  }
  begin(id: string, peer: string, startTree: string | undefined, workspace?: string): void {
    this.db.transaction(() => {
      this.db.query("INSERT OR REPLACE INTO turns (id, peer, started, start_tree) VALUES (?, ?, ?, ?)").run(id, peer, Date.now(), workspace === undefined ? startTree ?? null : null);
      this.db.query("DELETE FROM turn_workspaces WHERE turn = ?").run(id);
      if (workspace !== undefined) this.db.query("INSERT INTO turn_workspaces (turn, root, start_tree) VALUES (?, ?, ?)").run(id, workspace, startTree ?? null);
    })();
  }
  /** Only new extra-instance turns carry this evidence; absence preserves legacy external-peer workspace semantics. */
  workspace(id: string): string | undefined {
    try {
      const row = this.db.query("SELECT root FROM turn_workspaces WHERE turn = ?").get(id) as { root: string } | null;
      if (row && (typeof row.root !== "string" || !row.root)) throw new Error("invalid turn workspace evidence");
      return row?.root;
    } catch (error) {
      if (/no such table/.test((error as Error).message)) return undefined;
      throw error;
    }
  }
  private snapshotFields<T extends { id: string; start_tree: string | null; end_tree: string | null; changed: string }>(row: T): T {
    if (this.workspace(row.id) === undefined) return row;
    const fields = this.db.query("SELECT start_tree, end_tree, changed FROM turn_workspaces WHERE turn = ?").get(row.id) as { start_tree: string | null; end_tree: string | null; changed: string };
    return { ...row, ...fields };
  }
  /** The first native turn of a hub turn: reverting the conversation drops it and every later one. */
  native(id: string, native: string): void {
    this.db.query("UPDATE turns SET native = ? WHERE id = ? AND native IS NULL").run(native, id);
  }
  end(id: string, endTree: string | undefined, changed: string[], keep: number, unobserved?: string[]): void {
    this.db.transaction(() => {
      if (unobserved !== undefined) this.db.query("INSERT OR REPLACE INTO turn_unobserved (turn, paths) VALUES (?, ?)").run(id, JSON.stringify(unobserved));
      const scoped = this.workspace(id) !== undefined;
      // Older CLIs do not know workspace receipts. Leave their canonical-checkout snapshot view unknown.
      this.db.query("UPDATE turns SET ended = ?, end_tree = ?, changed = ? WHERE id = ?").run(Date.now(), scoped ? null : endTree ?? null, scoped ? "[]" : JSON.stringify(changed), id);
      if (scoped) this.db.query("UPDATE turn_workspaces SET end_tree = ?, changed = ? WHERE turn = ?").run(endTree ?? null, JSON.stringify(changed), id);
    })();
    const peer = (this.db.query("SELECT peer FROM turns WHERE id = ?").get(id) as { peer: string } | null)?.peer;
    if (peer) this.db.query("DELETE FROM turns WHERE peer = ? AND id NOT IN (SELECT id FROM turns WHERE peer = ? ORDER BY started DESC, rowid DESC LIMIT ?)").run(peer, peer, keep);
    this.db.run("DELETE FROM turn_workspaces WHERE turn NOT IN (SELECT id FROM turns)");
    this.db.run("DELETE FROM turn_unobserved WHERE turn NOT IN (SELECT id FROM turns)");
  }
  /** The dirty submodules recorded when the turn ended; undefined when none were recorded (unknown, not "none"). */
  unobserved(id: string): string[] | undefined {
    try {
      const row = this.db.query("SELECT paths FROM turn_unobserved WHERE turn = ?").get(id) as { paths: string } | null;
      if (!row) return undefined;
      const paths = JSON.parse(row.paths);
      return Array.isArray(paths) && paths.every(path => typeof path === "string") ? paths : undefined;
    } catch (error) {
      if (/no such table/.test((error as Error).message)) return undefined;
      throw error;
    }
  }
  private withUnobserved<T extends { id: string }>(record: T): T & { unobserved?: string[] } {
    const unobserved = this.unobserved(record.id);
    return unobserved === undefined ? record : { ...record, unobserved };
  }
  list(peer?: string, limit = 20): TurnRecord[] {
    const rows = (peer
      ? this.db.query("SELECT * FROM turns WHERE peer = ? ORDER BY started DESC, rowid DESC LIMIT ?").all(peer, limit)
      : this.db.query("SELECT * FROM turns ORDER BY started DESC, rowid DESC LIMIT ?").all(limit)) as (Omit<TurnRecord, "changed"> & { changed: string })[];
    return rows.map(row => this.snapshotFields(row)).map((r) => this.withUnobserved({ ...r, changed: JSON.parse(r.changed) as string[] }));
  }
  get(id: string): TurnRecord | undefined {
    const r = this.db.query("SELECT * FROM turns WHERE id = ?").get(id) as (Omit<TurnRecord, "changed"> & { changed: string }) | null;
    if (!r) return undefined;
    const record = this.snapshotFields(r);
    return this.withUnobserved({ ...record, changed: JSON.parse(record.changed) as string[] });
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
    const scopedRows = rows.map(row => this.snapshotFields(row));
    const known = scopedRows.filter((r) => r.ended !== null && r.start_tree !== null && r.end_tree !== null);
    const pruned = (this.db.query("SELECT peer, MIN(started) AS oldest FROM turns WHERE peer != ? GROUP BY peer HAVING COUNT(*) >= ?").all(turn.peer, keep) as { peer: string; oldest: number }[])
      .filter((p) => p.oldest > turn.started)
      .map((p) => `${p.peer} (its turns from then were pruned)`);
    return { paths: [...new Set(known.flatMap((r) => JSON.parse(r.changed) as string[]))], unknown: [...scopedRows.filter((r) => !known.includes(r)).map((r) => r.id), ...pruned] };
  }

  /** Other peers' completed, snapshotted turns that overlapped this turn and changed at least one of the same files. */
  concurrentWith(turn: TurnRecord): TurnRecord[] {
    if (turn.ended === null || turn.start_tree === null || turn.end_tree === null || !turn.changed.length) return [];
    const rows = this.db.query(`SELECT * FROM turns WHERE id != ? AND peer != ? AND started < ? AND ended > ?
      ORDER BY started, rowid`)
      .all(turn.id, turn.peer, turn.ended, turn.started) as (Omit<TurnRecord, "changed"> & { changed: string })[];
    const changed = new Set(turn.changed);
    return rows.map(row => this.snapshotFields(row)).filter(row => row.start_tree !== null && row.end_tree !== null)
      .map((r) => ({ ...r, changed: JSON.parse(r.changed) as string[] }))
      .filter((other) => other.changed.some((path) => changed.has(path)));
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
