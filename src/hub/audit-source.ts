import { hubGitEnv, hubGitSync } from "./git.ts";
import { childEnv } from "./child-process.ts";

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
}

const SHA = /^[a-f0-9]{40}$/;
// ponytail: a repository with more than this many changed paths between two audits reads as unreadable, so nothing is carried over from it. Upgrade: page the name list.
const MAX_CHANGED_PATHS = 20_000;

export function gitAuditSource(cwd: string): AuditSource {
  const run = (args: string[]) => hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env: hubGitEnv(childEnv(process.env), { repositoryIsolation: true }), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  const commit = (ref: string): string | undefined => {
    if (!ref || ref.startsWith("-") || /[\p{Cc}\s]/u.test(ref)) return undefined;
    const r = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    const out = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    return SHA.test(out) ? out : undefined;
  };
  return {
    head: () => commit("HEAD"),
    resolve: commit,
    changed: (from, to) => {
      if (!SHA.test(from) || !SHA.test(to)) return undefined;
      if (from === to) return [];
      const r = run(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", `${from}..${to}`, "--"]);
      if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
      const paths = r.stdout.split("\0").filter(Boolean);
      return paths.length > MAX_CHANGED_PATHS ? undefined : paths;
    },
  };
}
