import { accessSync, constants, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sbplString } from "../local/deny.ts";
import { hostExecutable } from "./host-executable.ts";
import { hubGitArgv, hubGitEnv } from "./git.ts";
import { realPath } from "./project.ts";
import { taskShellBindingValid } from "./task-shell-command.ts";

export interface TaskShellSandboxOptions { projectRoot: string; env: Record<string, string> }
const inside = (root: string, file: string) => { const rel = relative(root, file); return !rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
const literal = (file: string) => `(literal ${sbplString(file)})`;
const subpath = (file: string) => `(subpath ${sbplString(file)})`;

/** Deny-only refinement of the worker profile, never an execution grant or a replacement sandbox.
 * Unknown layouts (including a non-linked checkout or missing ref/reflog parents) ask instead of creating metadata directories.
 * ponytail: synchronous Git evidence shares a 1.5 second burst; an async host proof is the upgrade path. */
export function taskShellSandboxRestrictions(root: string, branch: string, options: TaskShellSandboxOptions): string | undefined {
  try {
    if (!taskShellBindingValid({ branch, defaultBranch: "main" }) || !options.env.PATH || options.env.PATH.length > 16384
      || options.env.PATH.split(":").some(dir => !isAbsolute(dir) || dir.split("/").includes(".."))) return;
    root = realPath(root);
    const project = realPath(options.projectRoot), executable = hostExecutable("git", root, options.env.PATH);
    if (inside(project, executable) || !lstatSync(executable).isFile()) return;
    accessSync(executable, constants.X_OK);
    const deadline = performance.now() + 1500;
    const git = (...args: string[]) => {
      const timeout = Math.floor(deadline - performance.now()); if (timeout <= 0) throw new Error("unavailable");
      const result = spawnSync(executable, hubGitArgv(["-C", root, ...args]).slice(1), {
        cwd: root, env: hubGitEnv(options.env, { repositoryIsolation: true }), encoding: "utf8", timeout, maxBuffer: 16384,
      });
      if (result.error || result.status !== 0 || !/^[^\r\n]+\n$/.test(result.stdout)) throw new Error("unavailable");
      return result.stdout.slice(0, -1);
    };
    if (git("symbolic-ref", "--quiet", "--short", "HEAD") !== branch || realPath(git("rev-parse", "--show-toplevel")) !== root) return;
    const gitDir = realPath(git("rev-parse", "--absolute-git-dir"));
    const commonDir = realPath(resolve(root, git("rev-parse", "--git-common-dir")));
    // Only the current registered linked-worktree directory is writable. A canonical checkout would overlap the denied common HEAD/index.
    const worktreePart = relative(commonDir, gitDir).split("/");
    if (worktreePart.length !== 2 || worktreePart[0] !== "worktrees" || !worktreePart[1] || gitDir === commonDir) return;
    const entries = new Set<string>();
    const directory = (file: string) => {
      if (!lstatSync(file).isDirectory() || realPath(file) !== file || Buffer.byteLength(file) > 900 || /[\p{Cc}\p{Cf}]/u.test(file)) throw new Error("unavailable");
      entries.add(file);
    };
    for (const metadata of [commonDir, gitDir]) directory(metadata);
    const objects = join(commonDir, "objects"); directory(objects);
    const files = [
      join(commonDir, "refs", "heads", branch), join(commonDir, "logs", "refs", "heads", branch),
      ...["HEAD", "index", "COMMIT_EDITMSG", "logs/HEAD"].map(name => join(gitDir, name)),
    ];
    for (const file of files) {
      if (Buffer.byteLength(`${file}.lock`) > 900) return;
      for (let parent = dirname(file); inside(commonDir, parent); parent = dirname(parent)) {
        directory(parent); if (parent === commonDir) break;
      }
      for (const candidate of [file, `${file}.lock`]) {
        const stat = lstatSync(candidate, { throwIfNoEntry: false });
        if (stat && (!stat.isFile() || stat.nlink !== 1 || realPath(candidate) !== candidate)) return;
      }
    }
    // Protect metadata ancestors too when the metadata sits beneath the writable execution root.
    for (const metadata of [commonDir, gitDir]) for (let parent = dirname(metadata); inside(root, parent); parent = dirname(parent)) {
      directory(parent); if (parent === root) break;
    }
    const allowed = [subpath(objects), ...files.flatMap(file => [literal(file), literal(`${file}.lock`)])];
    return [
      `(deny file-write* (require-all ${subpath(commonDir)} (require-not (require-any ${allowed.join(" ")}))))`,
      // Exact directory entries cannot be renamed or replaced; permitting a file never permits its parent directory as general data.
      `(deny file-write* ${[...entries].sort().map(literal).join(" ")})`,
      // Normal add/commit write hashed objects, never info selectors such as alternates that redirect privileged Git reads.
      `(deny file-write* ${subpath(join(objects, "info"))})`,
    ].join("\n");
  } catch { return undefined; }
}
