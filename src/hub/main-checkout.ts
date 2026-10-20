import { childEnv } from "./child-process.ts";
import { hubGitSync } from "./git.ts";

/**
 * #572 AC3: the project root is the shared checkout every session reads. A task branch left checked out there changes
 * what each other session sees, so a finished task says so. Advisory only: it is a line of text, never a refusal.
 * Only git is read, bounded: HEAD's branch, and the default branch from `origin/HEAD`, falling back to `main`.
 * A detached head, a missing directory, a directory that is not a repository and any git failure say nothing.
 */
const git = (cwd: string, args: string[]) => hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env: childEnv(process.env), maxBuffer: 64 * 1024, timeout: 3000 });

export function mainCheckoutBranch(cwd: string): { branch: string; defaultBranch: string } | undefined {
  try {
    const head = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.status !== 0 || typeof head.stdout !== "string" || !head.stdout.trim()) return undefined;
    const branch = head.stdout.trim();
    const origin = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const named = origin.status === 0 && typeof origin.stdout === "string" ? origin.stdout.trim().replace(/^origin\//, "") : "";
    const defaultBranch = named || "main";
    return branch === defaultBranch ? undefined : { branch, defaultBranch };
  } catch { return undefined; }
}

/**
 * The one advisory sentence, or undefined while the checkout is on its default branch.
 * A branch name is text a person or an agent chose, so it is not safe because git printed it: `nameable` is the hub's
 * whole public-text screen (`Tasks.publicMetadataText`: the configured PII patterns, secret shapes and private paths). A name it refuses, or any text
 * that is not a plain ref name, is replaced by a generic sentence that carries no part of it (#572 review I2).
 */
export function mainCheckoutWarning(cwd: string, nameable: (text: string) => boolean = () => false, read: typeof mainCheckoutBranch = mainCheckoutBranch): string | undefined {
  const found = read(cwd);
  if (!found) return undefined;
  const plain = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(found.branch) && nameable(found.branch);
  return plain ? `the main checkout is on \`${found.branch}\`; move the work to a worktree under .worktrees/`
    : "the main checkout is on a branch other than its default (its name is withheld); move the work to a worktree under .worktrees/";
}
