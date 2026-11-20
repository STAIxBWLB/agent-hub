import { constants, closeSync, fchmodSync, fstatSync, linkSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { guardPath } from "../local/tools.ts";
import { matchesPolicy } from "../hub/path-policy.ts";
import { realPath } from "../hub/project.ts";
import { hubGitSync } from "../hub/git.ts";

/** Bind the caller's working tree to the selected hub repository, never to an unrelated checkout. */
export function roadmapWorktree(project: string, caller: string): string {
  const rootResult = hubGitSync(["-C", caller, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootResult.status !== 0 || typeof rootResult.stdout !== "string" || !rootResult.stdout.trim()) throw new Error("roadmap export needs a Git worktree");
  const root = realPath(rootResult.stdout.trim());
  const common = (dir: string) => {
    const result = hubGitSync(["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) throw new Error("roadmap export repository identity is unavailable");
    return realPath(resolve(dir, result.stdout.trim()));
  };
  if (common(root) !== common(project)) throw new Error("roadmap export caller is in a different repository");
  return root;
}

const same = (a: Stats | undefined, b: Stats | undefined) => a === undefined ? b === undefined : !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** Only the two fixed generated files are written. A changed or linked target refuses; partial completion is reported. */
export function writeRoadmap(root: string, files: { json: string; markdown: string }, policy: { deny: string[]; readOnly: string[]; pii: string[] }): void {
  if (typeof files.json !== "string" || typeof files.markdown !== "string") throw new Error("roadmap export is malformed");
  const base = realPath(root), directory = resolve(base, "docs"), folder = lstatSync(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("roadmap docs directory is not a plain directory");
  const items = [["docs/roadmap.md", files.markdown], ["docs/roadmap.json", files.json]] as const;
  const targets = items.map(([name, text]) => {
    if (matchesPolicy(base, name, policy.pii, true)) throw new Error("roadmap export path is private");
    const path = guardPath({ cwd: base, deny: policy.deny, readOnly: policy.readOnly }, name, "write");
    if (path !== resolve(base, name)) throw new Error("roadmap export path is linked");
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error("roadmap export target is not a plain file");
    return { name, text, path, before };
  });
  let written = 0;
  try {
    for (const target of targets) {
      const temp = resolve(directory, `.roadmap-${randomUUID()}.tmp`); let fd: number | undefined;
      try {
        fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, target.text); fchmodSync(fd, target.before ? target.before.mode & 0o777 : 0o644); const created = fstatSync(fd);
        if (!created.isFile() || created.nlink !== 1) throw new Error("temporary export is not a plain file");
        closeSync(fd); fd = undefined;
        if (guardPath({ cwd: base, deny: policy.deny, readOnly: policy.readOnly }, target.name, "write") !== target.path || !same(target.before, lstatSync(target.path, { throwIfNoEntry: false }))) throw new Error("roadmap export target changed");
        // ponytail: no portable conditional rename for an existing inode; a tiny compare-to-rename race remains. Use a kernel conditional replacement if one becomes available.
        if (target.before) renameSync(temp, target.path); else { linkSync(temp, target.path); unlinkSync(temp); }
        written++;
      } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
    }
  } catch { throw new Error(written ? "roadmap export partially written; inspect both files before retrying" : "roadmap export was not written; inspect the paths before retrying"); }
}
