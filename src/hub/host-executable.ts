import type { ReadOnlyProgram } from "./read-only-shell.ts";
import { isAbsolute, relative } from "node:path";
import { lstatSync } from "node:fs";
import { realPath } from "./project.ts";

/** A repo-writable PATH shim is not a host-owned authenticated capability. No caller-selected binary. */
export function hostExecutable(name: "gh" | "bun" | "container" | "git" | "dot" | "ssh" | "tar" | ReadOnlyProgram, projectDir: string, path = process.env.PATH ?? ""): string {
  const found = Bun.which(name, { PATH: path });
  if (!found || !isAbsolute(found)) throw new Error(`${name} unavailable`);
  const target = realPath(found), inside = relative(realPath(projectDir), target);
  if (!inside || inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)) throw new Error(`${name} unavailable`);
  return target;
}

/** A privileged command's children must not discover a project-controlled PATH shim either. */
export function hostShellPath(projectDir: string, executionDir: string, value = process.env.PATH ?? "/usr/bin:/bin"): string | undefined {
  try {
    if (!value || value.length > 16384 || value.split(":").length > 128) return;
    const roots = [realPath(projectDir), realPath(executionDir)], directories = new Set<string>();
    const inside = (path: string) => roots.some(root => { const p = relative(root, path); return !p || p !== ".." && !p.startsWith("../") && !isAbsolute(p); });
    for (const entry of value.split(":")) {
      if (!isAbsolute(entry) || entry.split("/").includes("..")) return;
      if (inside(entry)) continue;
      try {
        const canonical = realPath(entry);
        if (!inside(canonical) && lstatSync(canonical).isDirectory()) directories.add(canonical);
      } catch { /* A missing PATH directory supplies no trusted program. */ }
    }
    return directories.size ? [...directories].join(":") : undefined;
  } catch { return undefined; }
}
