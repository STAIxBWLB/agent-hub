import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectAdapterCatalog } from "../adapters/registry.ts";
import { hubGitSync } from "./git.ts";
import { realPath } from "./project.ts";
import { validateInstances, type InstancesConfig } from "./instances.ts";

const refuse = (reason: string): never => { throw new Error(`instance execution workspace refused: ${reason}`); };
// #225: this runs synchronously on the daemon's event loop (an extra-instance start, turn_revert), and a resolution makes up to four git
// calls. One allowance covers all of them, so the loop is held for at most GIT_BUDGET_MS in git however many calls remain; a call that
// finds the allowance spent refuses without starting git. ponytail: the calls stay synchronous because the CLI and recovery callers are
// synchronous by contract; an async twin for the two daemon call sites is the upgrade if a typical resolution ever costs more than a few ms
// (measured about 15 ms for four calls on a warm local repository).
const GIT_BUDGET_MS = 5000, GIT_OUTPUT_BYTES = 1024 * 1024;
type Gitter = (cwd: string, args: string[]) => string;
function gitWithin(budgetMs: number, clock: () => number, run: typeof hubGitSync = hubGitSync): Gitter {
  const deadline = clock() + budgetMs;
  return (cwd, args) => {
    const left = Math.floor(deadline - clock());
    if (left <= 0) return refuse("Git workspace evidence unavailable");
    const result = run(["-C", cwd, ...args], { encoding: "utf8", timeout: left, maxBuffer: GIT_OUTPUT_BYTES });
    if (result.error || result.status !== 0) return refuse("Git workspace evidence unavailable");
    return result.stdout;
  };
}
const commonDirectory = (git: Gitter, cwd: string): string => realPath(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).replace(/\n$/, ""));

/** Point-in-time read only. No worktree is created, repaired or chosen implicitly. */
export function resolveInstanceExecutionCwd(projectRoot: string, id: string, declarations: InstancesConfig | undefined, roles: readonly string[], adapterCatalog: ProjectAdapterCatalog, budgetMs = GIT_BUDGET_MS, clock: () => number = () => performance.now(), run: typeof hubGitSync = hubGitSync): string {
  if (adapterCatalog.definitionOf(id)) return projectRoot;
  const git = gitWithin(budgetMs, clock, run);
  const declaration = validateInstances(declarations, adapterCatalog)[id];
  if (!declaration) return refuse("extra instance is not declared");
  const implementer = roles.includes("implementer");
  if (!declaration.worktree) {
    if (implementer) return refuse("an extra implementer requires an explicit managed worktree");
    return projectRoot;
  }
  let root: string, cwd: string;
  try {
    root = realPath(projectRoot);
    cwd = realPath(resolve(root, declaration.worktree));
    if (!lstatSync(root).isDirectory() || !lstatSync(cwd).isDirectory()) return refuse("workspace is not a directory");
  } catch { return refuse("workspace paths are unavailable"); }
  const expected = join(root, ".worktrees", id);
  // Compare a real path with the exact canonical project child, so a symlink cannot move this boundary elsewhere.
  if (cwd !== expected) return refuse("worktree must be the exact managed instance directory");
  const inventory = git(root, ["worktree", "list", "--porcelain", "-z"]);
  const records = inventory.split("\0\0").filter(Boolean).map(record => record.split("\0").filter(Boolean));
  const matches = records.filter(record => {
    const path = record.find(field => field.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) return false;
    try { return realPath(path) === cwd; } catch { return false; }
  });
  if (matches.length !== 1 || matches[0]!.some(field => field === "prunable" || field.startsWith("prunable "))) return refuse("directory is not an available registered project worktree");
  if (commonDirectory(git, root) !== commonDirectory(git, cwd)) return refuse("worktree belongs to a different Git repository");
  const top = git(cwd, ["rev-parse", "--show-toplevel"]).replace(/\n$/, "");
  if (realPath(top) !== cwd) return refuse("directory is not the registered worktree root");
  if (implementer && !matches[0]!.some(field => field.startsWith("branch refs/heads/") && field.length > "branch refs/heads/".length)) return refuse("an implementer worktree requires an attached branch");
  // ponytail: this read cannot bind the branch to a task or make path swaps atomic; task/start authority must recheck before effects.
  return cwd;
}
