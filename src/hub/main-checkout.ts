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

/** The one advisory sentence, or undefined while the checkout is on its default branch. */
export function mainCheckoutWarning(cwd: string): string | undefined {
  const found = mainCheckoutBranch(cwd);
  return found ? `the main checkout is on \`${found.branch}\`; move the work to a worktree under .worktrees/` : undefined;
}
