import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { definitionOf, type ProjectAdapterCatalog } from "../adapters/registry.ts";
import { hubGitSync } from "./git.ts";
import { realPath } from "./project.ts";
import { validateInstances, type InstancesConfig } from "./instances.ts";

const refuse = (reason: string): never => { throw new Error(`instance execution workspace refused: ${reason}`); };
const GIT_TIMEOUT_MS = 5000, GIT_OUTPUT_BYTES = 1024 * 1024;
function git(cwd: string, args: string[]): string {
  const result = hubGitSync(["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_BYTES });
  if (result.error || result.status !== 0) return refuse("Git workspace evidence unavailable");
  return result.stdout;
}
const commonDirectory = (cwd: string): string => realPath(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).replace(/\n$/, ""));

/** Point-in-time read only. No worktree is created, repaired or chosen implicitly. */
export function resolveInstanceExecutionCwd(projectRoot: string, id: string, declarations: InstancesConfig | undefined, roles: readonly string[], adapterCatalog?: ProjectAdapterCatalog): string {
  if ((adapterCatalog?.definitionOf ?? definitionOf)(id)) return projectRoot;
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
  if (commonDirectory(root) !== commonDirectory(cwd)) return refuse("worktree belongs to a different Git repository");
  const top = git(cwd, ["rev-parse", "--show-toplevel"]).replace(/\n$/, "");
  if (realPath(top) !== cwd) return refuse("directory is not the registered worktree root");
  if (implementer && !matches[0]!.some(field => field.startsWith("branch refs/heads/") && field.length > "branch refs/heads/".length)) return refuse("an implementer worktree requires an attached branch");
  // ponytail: this read cannot bind the branch to a task or make path swaps atomic; task/start authority must recheck before effects.
  return cwd;
}
