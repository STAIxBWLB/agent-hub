import { accessSync, constants, lstatSync, opendirSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPath } from "./project.ts";
import { foldSegment } from "./permission-mode.ts";
/** Bounded project-relative exact paths/subtrees or *, ? and whole-segment ** globs. */
export function policyPaths(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 64 || raw.some(p => typeof p !== "string" || !p || p.length > 200 || isAbsolute(p) || /[\[\]{}!]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || p.split(/[\\/]/).includes("..") ||
    (/[?*]/.test(p) && (p.includes("\\") || (p.match(/[?*]/g)?.length ?? 0) > 16 || p.split("/").some(s => s.includes("**") && s !== "**"))))) throw new Error(`${field} takes up to 64 bounded project-relative paths or *, ? and whole-segment ** globs`);
  return [...new Set(raw.map(p => p.replace(/\/+/g, "/").replace(/\/$/, "") || "."))];
}
function existing(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
/** Resolve the deepest existing ancestor, retaining dangling links as failures. */
export function policyRealPath(path: string): string {
  let ancestor = path;
  while (!existing(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error("path cannot be resolved"); ancestor = parent; }
  return join(realPath(ancestor), relative(ancestor, path));
}
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
// Either spelling protects, as for globs: lowercase as before, or folded like a case-insensitive disk opens names (NFD/NFC,
// compatibility forms, long s, ignorable code points). Folding is not a function of the lowercase form for every name.
const beneath = (path: string, root: string) => within(path.toLowerCase(), root.toLowerCase()) || within(foldSegment(path), foldSegment(root));
const lowerBeneath = (path: string, root: string) => within(path.toLowerCase(), root.toLowerCase());
export function policyTargets(cwd: string, paths: string[]): string[] {
  const root = realPath(cwd);
  return [...new Set(paths.flatMap(path => { const lexical = resolve(root, path); return [lexical, policyRealPath(lexical)]; }))];
}
type DiscoveryBudget = { entries: number };
/** A dangling direct child names a future lexical target; an ELOOP child opens no file. */
function directAliasTarget(path: string): string | undefined {
  let target = path;
  // Include the final target resolution after the last bounded redirect.
  for (let hops = 0; hops <= 40; hops++) {
    try { return policyRealPath(target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return undefined;
      if (code !== "ENOENT") throw error;
    }
    let ancestor = target;
    while (!existing(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    if (!lstatSync(ancestor).isSymbolicLink()) return undefined;
    target = resolve(dirname(ancestor), readlinkSync(ancestor), relative(ancestor, target));
  }
  return undefined;
}
/** Only a completed bounded scan contributes aliases; a truncated root contributes none. */
function aliasScope(dir: string, lexical: string, actual: string, includeParents: boolean, budget: DiscoveryBudget): boolean {
  // Readability must not depend on reaching readSync after an exhausted-budget return.
  accessSync(dir, constants.R_OK);
  const handle = opendirSync(dir);
  let matched = false;
  try {
    if (budget.entries >= 4096) return false;
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (budget.entries >= 4096) return false;
      budget.entries++;
      if (!entry.isSymbolicLink()) continue;
      const target = directAliasTarget(join(dir, entry.name));
      if (target !== undefined && (beneath(lexical, target) || beneath(actual, target) || includeParents && (beneath(target, lexical) || beneath(target, actual)))) matched = true;
    }
  } finally { handle.closeSync(); }
  return matched;
}
/**
 * Either spelling protects: the lowercase comparison keeps `?` matching one code point whose fold expands (ß, ﬁ), and
 * the folded one catches NFD/NFC, compatibility and long-s aliases. Adding a match only ever adds protection.
 */
function segmentMatches(pattern: string, name: string): boolean {
  return wildcard(pattern.toLowerCase(), name.toLowerCase()) || wildcard(foldSegment(pattern), foldSegment(name));
}
/** Linear-space wildcard DP, avoiding regex backtracking on untrusted paths. */
function wildcard(pattern: string, name: string): boolean {
  const chars = [...name];
  let previous = new Array<boolean>(chars.length + 1).fill(false); previous[0] = true;
  for (const char of pattern) {
    const next = new Array<boolean>(chars.length + 1).fill(false);
    next[0] = char === "*" && previous[0]!;
    for (let i = 1; i <= chars.length; i++) next[i] = char === "*" ? previous[i]! || next[i - 1]! : previous[i - 1]! && (char === "?" || char === chars[i - 1]);
    previous = next;
  }
  return previous[chars.length]!;
}
function closure(pattern: string[], states: Set<number>): Set<number> {
  const out = new Set(states);
  for (const i of out) if (pattern[i] === "**") out.add(i + 1);
  return out;
}
function advance(pattern: string[], states: Set<number>, name: string): Set<number> {
  const next = new Set<number>();
  for (const i of closure(pattern, states)) {
    if (pattern[i] === "**") next.add(i);
    else if (pattern[i] !== undefined && segmentMatches(pattern[i]!, name)) next.add(i + 1);
  }
  return closure(pattern, next);
}
function patternScope(pattern: string[], states: Set<number>, path: string, includeParents: boolean): boolean {
  if (isAbsolute(path) || path === ".." || path.startsWith("../")) return false;
  states = closure(pattern, states);
  if (states.has(pattern.length)) return true;
  for (const name of path.split("/").filter(p => p && p !== ".")) {
    states = advance(pattern, states, name);
    if (states.has(pattern.length)) return true; // a matched directory protects its entire subtree
    if (!states.size) return false;
  }
  return includeParents && states.size > 0; // this scope can contain a future protected descendant
}
/** Resolve wildcard directory aliases without trusting a cached expansion. Bound all filesystem discovery. */
function globScope(root: string, lexical: string, actual: string, path: string, includeParents: boolean, budget: DiscoveryBudget, roots: Set<string>, aliasDiscovery = false): boolean {
  const pattern = path.split("/").filter(p => p && p !== ".");
  const start = closure(pattern, new Set([0]));
  if (patternScope(pattern, start, relative(root, lexical), includeParents) || patternScope(pattern, start, relative(root, actual), includeParents)) return true;
  const visit = (dir: string, states: Set<number>, depth: number, ancestors: Set<string>): boolean => {
    const real = policyRealPath(dir);
    if (states.has(pattern.length)) {
      if (beneath(lexical, real) || beneath(actual, real) || includeParents && (beneath(real, lexical) || beneath(real, actual))) return true;
      // Defer new child aliases until every pre-existing policy match has had its discovery budget.
      if (pattern.at(-1) === "**" && existing(real) && statSync(real).isDirectory()) roots.add(real);
      // An earlier `**` can still match deeper: an alias below this match (`ss/ß -> other` for `**/ß`) is searched too.
      // A trailing `**` only re-matches everything below, so it never walks the subtree (as before, for paths outside it).
      states = new Set([...states].filter(i => i !== pattern.length && !(i === pattern.length - 1 && pattern[i] === "**")));
      if (!states.size) return false;
    }
    if (patternScope(pattern, states, relative(real, actual), includeParents)) return true;
    if (!existing(dir)) return false;
    // Unfolded: a sibling whose folded spelling looks like the project is outside it, and discovery there fails closed.
    if (!lowerBeneath(real, root)) throw new Error("policy glob discovery outside project");
    const info = statSync(dir);
    if (!info.isDirectory()) return false;
    if (aliasDiscovery && budget.entries >= 4096) return false;
    if (depth > 32 || ancestors.has(real) || budget.entries > 4096) throw new Error("policy glob discovery unavailable");
    const chain = new Set(ancestors); chain.add(real);
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (aliasDiscovery && budget.entries >= 4096) return false;
        if (++budget.entries > 4096) throw new Error("policy glob discovery unavailable");
        const next = advance(pattern, states, entry.name);
        if (next.size && visit(join(dir, entry.name), next, depth + 1, chain)) return true;
      }
    } finally { handle.closeSync(); }
    return false;
  };
  return visit(root, start, 0, new Set());
}
/** Policy preflight without filesystem access. Callers must reject symlink traversal separately. */
export function matchesPolicyLexically(cwd: string, path: string, paths: string[]): boolean {
  const root = resolve(cwd), lexical = resolve(root, path);
  return paths.some(entry => /[?*]/.test(entry)
    ? patternScope(entry.split("/").filter(p => p && p !== "."), new Set([0]), relative(root, lexical), false)
    : beneath(lexical, resolve(root, entry)));
}

/** Compare declared spelling, real targets and bounded aliases; legacy discovery errors fail closed. */
export function matchesPolicy(cwd: string, path: string, paths: string[], includeParents = false): boolean {
  if (!paths.length) return false;
  try {
    if (path.length > 4096) return true;
    const root = realPath(cwd), lexical = resolve(root, path), actual = policyRealPath(lexical);
    includeParents &&= !existing(lexical) || statSync(lexical).isDirectory();
    const budget = { entries: 0 }, roots = new Set<string>(), exact: string[] = [];
    if (paths.some(entry => {
      if (/[?*]/.test(entry)) return globScope(root, lexical, actual, entry, includeParents, budget, roots);
      const targets = policyTargets(root, [entry]);
      if (targets.some(target => beneath(lexical, target) || beneath(actual, target) || includeParents && (beneath(target, lexical) || beneath(target, actual)))) return true;
      const real = targets.at(-1)!;
      if (existing(real) && statSync(real).isDirectory()) roots.add(real);
      exact.push(entry);
      return false;
    })) return true;
    // New exact-root discovery cannot consume the budget before legacy wildcard matches are checked.
    for (const entry of exact) {
      if (globScope(root, lexical, actual, `${entry}/**`, includeParents, budget, roots, true)) return true;
    }
    for (const dir of roots) if (aliasScope(dir, lexical, actual, includeParents, budget)) return true;
    return false;
  } catch { return true; }
}
