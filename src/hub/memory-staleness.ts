import { lstatSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { nodePath } from "@staix/agent-mem";
import { isDenied } from "../local/deny.ts";
import { foldSegment } from "./permission-mode.ts";
import { matchesPolicyLexically } from "./path-policy.ts";

export const STALENESS_MAX_PROBES = 32;
export interface StalenessOptions {
  cwd: string;
  privatePaths?: string[];
  deny?: string[];
  /** A metadata-only seam for privacy and budget regressions. */
  probe?: (path: string) => Pick<Stats, "isSymbolicLink" | "isDirectory">;
}

/** One call-scoped budget/cache, shared by every displayed note. Unknown never produces a marker. */
export function createStalenessProbe(options: StalenessOptions): (about: readonly string[]) => boolean {
  const root = resolve(options.cwd), cache = new Map<string, boolean>();
  let remaining = STALENESS_MAX_PROBES;
  const allowed = (path: string) => {
    const name = relative(root, resolve(root, path));
    return !isDenied(name, options.deny) && !isDenied(foldSegment(name), options.deny?.map(foldSegment))
      && !matchesPolicyLexically(root, name, [...(options.privatePaths ?? []), ...(options.deny ?? [])]);
  };
  const missing = (path: string): boolean => {
    if (cache.has(path)) return cache.get(path)!;
    cache.set(path, false);
    if (!path || path.length > 4096 || isAbsolute(path) || /[\0\r\n]/.test(path) || path.split("/").includes("..") || !allowed(path)) return false;
    const target = resolve(root, path), rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
    let current = root;
    // ponytail: private/deny exclusion assumes a tree not modified during this call. A concurrent ancestor swap
    // by a process running as you can expose one existence bit and is outside docs/security.md's threat model.
    // Descriptor-anchored no-follow traversal is needed before supporting adversarial concurrent tree mutation.
    for (const component of rel.split("/")) {
      current = join(current, component);
      if (!remaining || !allowed(current)) return false;
      remaining--;
      try {
        const stat = (options.probe ?? lstatSync)(current);
        // Never follow even a publicly named alias: its target could be private.
        if (stat.isSymbolicLink()) return false;
        if (current !== target && !stat.isDirectory()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.set(path, true); return true; }
        return false;
      }
    }
    return false;
  };
  // ponytail: file-level only, so a symbol removed from an existing file is unknown. Add a policy-gated symbol
  // resolver with its own C3 privacy/budget tests before inspecting source contents.
  return about => about.some(node => { const path = nodePath(node); return path !== undefined && missing(path); });
}
