import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { realPath } from "./project.ts";

/** Runtime root is captured by the daemon once; unknown project or sandbox roots refuse. */
export function instructedRuntimeAllowed(runtimeRoot: string, projectRoots: readonly string[]): boolean {
  if (!isAbsolute(runtimeRoot)) return false;
  try {
    for (const root of projectRoots) {
      const rel = relative(realPath(root), runtimeRoot);
      if (!rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return false;
    }
    for (let current = runtimeRoot; ; current = dirname(current)) {
      try { lstatSync(join(current, ".git")); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      if (dirname(current) === current) return true;
    }
  } catch { return false; }
}
