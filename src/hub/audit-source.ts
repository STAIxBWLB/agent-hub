import { hubGitEnv, hubGitSync } from "./git.ts";
import { childEnv } from "./child-process.ts";
import { realPath } from "./project.ts";

/**
 * #1403 A4: what an audit reads from the checkout, behind one injectable port so `Tasks` stays testable and the daemon wires the real thing. Read-only git, hardened like the review brief's
 * reads. An answer that cannot be read is `undefined`: unknown never counts as unchanged, so nothing is carried over from it.
 */
export interface AuditSource {
  /** The full commit the audit reads: `HEAD` of the project checkout. */
  head(): string | undefined;
  /** Whether `ref` names a commit in this checkout (a `--since` that does not resolve is refused). */
  resolve(ref: string): string | undefined;
  /** Repository-relative paths that differ between `from` and `to`, or undefined when they cannot be listed completely. */
  changed(from: string, to: string): string[] | undefined;
  /**
   * #1646: among `paths`, those the checkout's worktree holds differently from `reviewed`, and those it holds as
   * untracked files. Undefined when either read is incomplete: an unread checkout is unknown, never clean.
   */
  readsAt?(reviewed: string, paths: readonly string[]): { differing: string[]; untracked: string[] } | undefined;
  /** Local origin/HEAD remote-tracking commit, never a checkout HEAD or guessed branch. */
  defaultTip?(): string | undefined;
  /** Unique local common ancestor; shallow, missing, unrelated or ambiguous history is unknown. */
  mergeBase?(from: string, to: string): string | undefined;
}

const SHA = /^[a-f0-9]{40}$/;
// ponytail: a repository with more than this many changed paths between two audits reads as unreadable, so nothing is carried over from it. Upgrade: page the name list.
const MAX_CHANGED_PATHS = 20_000;

export function gitAuditSource(cwd: string): AuditSource {
  const run = (args: string[]) => hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env: hubGitEnv(childEnv(process.env), { repositoryIsolation: true, readOnlyDiagnostic: true }), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  const commit = (ref: string): string | undefined => {
    if (!ref || ref.startsWith("-") || /[\p{Cc}\s]/u.test(ref)) return undefined;
    const r = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    const out = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    return SHA.test(out) ? out : undefined;
  };
  const completeHistory = (): boolean => {
    const result = run(["rev-parse", "--is-shallow-repository"]);
    return result.status === 0 && result.stdout.trim() === "false";
  };
  const defaultTarget = (): string | undefined => {
    const result = run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const ref = result.status === 0 ? result.stdout.trim() : "";
    return ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD" && ref.length > "refs/remotes/origin/".length
      && !/[\p{Cc}\s]/u.test(ref) ? ref : undefined;
  };
  return {
    head: () => commit("HEAD"),
    resolve: commit,
    defaultTip: () => {
      if (!completeHistory()) return;
      const target = defaultTarget(), tip = target && commit(target);
      return tip && defaultTarget() === target && commit(target!) === tip ? tip : undefined;
    },
    mergeBase: (from, to) => {
      if (!SHA.test(from) || !SHA.test(to) || !completeHistory() || commit(from) !== from || commit(to) !== to) return;
      const result = run(["merge-base", "--all", from, to]);
      const rows = result.status === 0 ? result.stdout.trim().split(/\s+/) : [];
      return rows.length === 1 && SHA.test(rows[0]!) ? rows[0] : undefined;
    },
    changed: (from, to) => {
      if (!SHA.test(from) || !SHA.test(to)) return undefined;
      if (from === to) return [];
      const r = run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", `${from}..${to}`, "--"]);
      if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
      const paths = r.stdout.split("\0").filter(Boolean);
      return paths.length > MAX_CHANGED_PATHS ? undefined : paths;
    },
    readsAt: (reviewed, paths) => {
      if (!SHA.test(reviewed) || commit(reviewed) !== reviewed) return undefined;
      // Only the caller's own list, and only names git accepts as pathspecs: never a flag, never a control character.
      const scoped = [...new Set(paths.filter(path => typeof path === "string" && path && !path.startsWith("-") && !/[\p{Cc}]/u.test(path)))];
      if (!scoped.length) return { differing: [], untracked: [] };
      // The reviewed commit against the worktree (index and unstaged alike), then the files git does not track yet.
      const diff = run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", reviewed, "--", ...scoped]);
      if (diff.status !== 0 || typeof diff.stdout !== "string") return undefined;
      const others = run(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scoped]);
      if (others.status !== 0 || typeof others.stdout !== "string") return undefined;
      // A reviewed path the checkout does not track is reported once, as untracked: git also diffs such a file by path
      // when it happens to exist, and one state per path keeps the evidence readable.
      const untracked = others.stdout.split("\0").filter(Boolean), loose = new Set(untracked);
      const differing = diff.stdout.split("\0").filter(path => path && !loose.has(path));
      return differing.length > MAX_CHANGED_PATHS || untracked.length > MAX_CHANGED_PATHS ? undefined : { differing, untracked };
    },
  };
}

/** The common Git directory of `dir` as it is on disk, or undefined when `dir` is no checkout of a readable repository. */
const commonDirectory = (dir: string): string | undefined => {
  const result = hubGitSync(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env: hubGitEnv(childEnv(process.env), { repositoryIsolation: true, readOnlyDiagnostic: true }), maxBuffer: 4096, timeout: 5_000 });
  const out = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!out) return undefined;
  try { return realPath(out); } catch { return undefined; }
};

/**
 * #1646 T2: a read-only reader for a checkout other than the project's own, such as the checkout a reviewing session reports for
 * itself. It answers only when `root` is a worktree of `anchor`'s repository on disk, compared by canonical path and common Git
 * directory, never by the names a caller typed; the project checkout itself is refused so a caller records it as the project's
 * rather than as a peer's. A root that is not a checkout of this repository is unknown, never read.
 */
export function checkoutAuditSource(anchor: string, root: string): AuditSource | undefined {
  try {
    const here = realPath(anchor), there = realPath(root);
    if (here === there) return undefined;
    const common = commonDirectory(here), other = commonDirectory(there);
    return common && common === other ? gitAuditSource(there) : undefined;
  } catch { return undefined; }
}
