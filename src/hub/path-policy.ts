import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPath } from "./project.ts";
/** Project-relative exact paths/subtrees, never globs or executable configuration. */
export function policyPaths(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 64 || raw.some(p => typeof p !== "string" || !p || p.length > 200 || isAbsolute(p) || /[*?\[\]]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || p.split(/[\\/]/).includes(".."))) throw new Error(`${field} takes up to 64 bounded project-relative paths`);
  return [...new Set(raw.map(p => p.replace(/\/+/g, "/").replace(/\/$/, "") || "."))];
}
function existing(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
/** Resolve the deepest existing ancestor, retaining dangling links as failures. */
export function policyRealPath(path: string): string {
  let ancestor = path;
  while (!existing(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error("path cannot be resolved"); ancestor = parent; }
  return join(realPath(ancestor), relative(ancestor, path));
}
const beneath = (path: string, root: string) => { path = path.toLowerCase(); root = root.toLowerCase(); return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); };
export function policyTargets(cwd: string, paths: string[]): string[] {
  const root = realPath(cwd);
  return [...new Set(paths.flatMap(path => { const lexical = resolve(root, path); return [lexical, policyRealPath(lexical)]; }))];
}
/** Compare both declared spelling and real target. Unknown alias resolution conservatively matches an active policy. */
export function matchesPolicy(cwd: string, path: string, paths: string[], includeParents = false): boolean {
  if (!paths.length) return false;
  try {
    const root = realPath(cwd), lexical = resolve(root, path), actual = policyRealPath(lexical), targets = policyTargets(root, paths);
    return targets.some(target => beneath(lexical, target) || beneath(actual, target) || (includeParents && (beneath(target, lexical) || beneath(target, actual))));
  } catch { return true; }
}
