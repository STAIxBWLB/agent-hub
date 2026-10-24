import { isDenied } from "../local/deny.ts";
import { foldSegment } from "./permission-mode.ts";
import { matchesPolicyLexically } from "./path-policy.ts";
import { extractNodes } from "@staix/agent-mem";
import { normalizePlanSymbol } from "./symbol-normalizer.ts";
import type { CodeFactResult } from "./code-facts.ts";

export const MEMORY_SYMBOL_LIMIT = 16;
export const MEMORY_SYMBOL_START_BUDGET_MS = 2000;
export interface MemorySymbolContext {
  cwd: string; project: string; repo: string; deny?: string[];
  allowed: (text: string) => boolean;
}
export interface MemorySymbolNodes {
  state: "known" | "unknown";
  nodes: string[];
  unknown: number;
  truncated: boolean;
}

/** Preserve an explicit file suffix while normalizing a plan's function signature. */
export function normalizeMemorySymbolInput(value: string): string {
  if (typeof value !== "string") return "";
  const at = value.lastIndexOf("@");
  return at < 0 ? normalizePlanSymbol(value) : `${normalizePlanSymbol(value.slice(0, at))}@${value.slice(at + 1)}`;
}

/** Candidate identity only. Callers must obtain positive code facts before storing it as an about node. */
export function canonicalMemorySymbolNode(node: string, context: MemorySymbolContext): string | undefined {
  if (typeof node !== "string" || !node.startsWith("symbol:") || Buffer.byteLength(node) > 512 || /[\p{Cc}\p{Cf}]/u.test(node)) return;
  const at = node.lastIndexOf("@");
  if (at <= 7 || at === node.length - 1 || node.slice(at + 1).includes("\\")) return;
  const name = normalizePlanSymbol(node.slice(7, at)), path = node.slice(at + 1);
  if (!name || /\s|@|\(|\)/u.test(name) || name.startsWith("section ") || name.startsWith("source ")) return;
  // Use the package's path/deny normalization, without reading a working tree or following symlinks.
  const paths = extractNodes("", { ...context, paths: [path], checkExists: false }).filter(value => value.startsWith("path:"));
  if (paths.length !== 1) return;
  const file = paths[0]!.slice(5), deny = context.deny ?? [];
  // Core extraction covers literal denies; host read-time policy also covers folded names and declared globs.
  if (isDenied(foldSegment(file), deny.map(foldSegment)) || matchesPolicyLexically(context.cwd, file, deny)) return;
  const normalized = `symbol:${name}@${file}`;
  try { if ([node, name, path, normalized].every(context.allowed)) return normalized; } catch { /* Unknown policy withholds. */ }
}

/** A bounded optional check of host-observed identities, never plan guesses or source structure. */
export async function resolveMemorySymbolNodes(
  candidates: readonly string[], context: MemorySymbolContext,
  exists: (name: string) => Promise<CodeFactResult<{ exists: boolean; ambiguous: boolean }>>,
  now: () => number = performance.now.bind(performance),
): Promise<MemorySymbolNodes> {
  const result: MemorySymbolNodes = { state: "known", nodes: [], unknown: 0, truncated: candidates.length > MEMORY_SYMBOL_LIMIT };
  const deadline = now() + MEMORY_SYMBOL_START_BUDGET_MS, seen = new Set<string>();
  const lookups = new Map<string, Promise<CodeFactResult<{ exists: boolean; ambiguous: boolean }>>>();
  for (const candidate of candidates.slice(0, MEMORY_SYMBOL_LIMIT)) {
    const node = canonicalMemorySymbolNode(candidate, context);
    if (!node) { result.unknown++; continue; }
    if (seen.has(node)) continue;
    seen.add(node);
    if (now() >= deadline) { result.unknown++; result.truncated = true; continue; }
    try {
      const name = node.slice(7, node.lastIndexOf("@"));
      let lookup = lookups.get(name);
      if (!lookup) {
        lookup = Promise.resolve().then(() => exists(name)).catch(() => ({ state: "unknown" } as const));
        lookups.set(name, lookup);
      }
      const fact = await lookup;
      if (fact.state === "known" && fact.value.exists === true && fact.value.ambiguous === false) result.nodes.push(node);
      else result.unknown++;
    } catch { result.unknown++; }
  }
  if (result.unknown || result.truncated) result.state = "unknown";
  return result;
}
