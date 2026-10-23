import { symbolsOverlap } from "./symbol-normalizer.ts";

// #684 2c: the dashboard task sheet's "Code" group, classified on the hub so the page never matches names itself. Pure data in, ids and
// names out. The observation (`codeSymbols`) is the receipt `Tasks.publicView` already re-screened; the plan names are `plan.symbols`, the same
// list the review brief reads as `planned`. Advisory only: ripwire does not report deleted symbols, so neither list proves a plan was followed.

export interface CodeGroupSymbol { id: string; name: string; path: string; kind: string; mark: "matching" | "unplanned" }
export interface CodeGroup {
  state: "known" | "unknown";
  complete: boolean;
  head?: string;
  symbols: CodeGroupSymbol[];
  /** Plan names nothing changed under. */
  untouched: string[];
  /** How many more changed symbols exist than are listed, so a cap is never read as the whole. */
  more: number;
}

export const CODE_GROUP_MAX = 40;
interface Receipt { state?: unknown; complete?: unknown; head?: unknown; symbols?: unknown }
const word = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

/**
 * `receipt` is the public `codeSymbols` (never the stored one, which carries `repositoryKey`); `plan` the task's `plan.symbols`; `screen`
 * the hub's `publicMetadataText`. Returns undefined for a private task: the sheet then shows no Code group at all.
 */
export function codeGroup(task: { id: number }, receipt: unknown, plan: unknown, screen: (text: string) => boolean, privateTask: boolean): CodeGroup | undefined {
  if (privateTask) return undefined;
  const r = (receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : undefined) as Receipt | undefined;
  if (!r || r.state !== "known" || !Array.isArray(r.symbols) || Object.hasOwn(r, "repositoryKey")) return { state: "unknown", complete: false, symbols: [], untouched: [], more: 0 };
  const planned = (Array.isArray(plan) ? plan : []).filter((name): name is string => word(name, 200)).filter(name => { try { return screen(name); } catch { return false; } }).slice(0, 64);
  const changed: CodeGroupSymbol[] = [];
  for (const item of r.symbols as Record<string, unknown>[]) {
    if (!item || !word(item.id, 512) || !word(item.name, 512) || !word(item.path, 512) || !word(item.kind, 64) || item.id !== `symbol:${item.name}@${item.path}`) continue;
    changed.push({ id: item.id, name: item.name, path: item.path, kind: item.kind, mark: planned.some(name => symbolsOverlap(name, item.name as string)) ? "matching" : "unplanned" });
  }
  const untouched = planned.filter(name => !changed.some(symbol => symbolsOverlap(name, symbol.name)));
  const shown = changed.slice(0, CODE_GROUP_MAX);
  return { state: "known", complete: r.complete === true && changed.length === r.symbols.length, ...(typeof r.head === "string" && /^[a-f0-9]{40}$/.test(r.head) ? { head: r.head.slice(0, 8) } : {}),
    symbols: shown, untouched: untouched.slice(0, CODE_GROUP_MAX), more: Math.max(0, changed.length - shown.length) + Math.max(0, untouched.length - CODE_GROUP_MAX) };
}
