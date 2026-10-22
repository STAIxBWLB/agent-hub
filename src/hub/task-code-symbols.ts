import type { ReviewBrief } from "./review-brief.ts";

export interface TaskCodeSymbol { id: string; path: string; name: string; kind: string }
export interface TaskCodeSymbols {
  head: string; mergeBase: string; repositoryKey: string;
  state: "known" | "unknown"; complete: boolean; countsFloor: true; symbols: TaskCodeSymbol[];
}
export const HOST_CODE_SYMBOLS = Symbol("host task code symbols");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
const path = (value: unknown): value is string => text(value) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024;

/** Stored observations are host-derived metadata, not code or caller-provided spans. */
export function parseTaskCodeSymbols(value: unknown): TaskCodeSymbols | undefined {
  try {
    if (!object(value) || !sha(value.head) || !sha(value.mergeBase) || !text(value.repositoryKey)
      || (value.state !== "known" && value.state !== "unknown") || typeof value.complete !== "boolean" || value.countsFloor !== true
      || !Array.isArray(value.symbols) || value.symbols.length > 500 || !bounded(value)) return;
    const symbols: TaskCodeSymbol[] = [], ids = new Set<string>();
    for (const item of value.symbols) {
      if (!object(item) || !text(item.id) || !path(item.path) || !text(item.name) || !text(item.kind)
        || !/^[a-z_]+$/.test(item.kind) || item.id !== `symbol:${item.name}@${item.path}` || ids.has(item.id)) return;
      ids.add(item.id); symbols.push({ id: item.id, path: item.path, name: item.name, kind: item.kind });
    }
    if (value.state === "unknown" && (value.complete || symbols.length)) return;
    return { head: value.head, mergeBase: value.mergeBase, repositoryKey: value.repositoryKey, state: value.state as "known" | "unknown", complete: value.complete, countsFloor: true, symbols };
  } catch { return; }
}

/** Caller must certify that the earlier preparation did not filter or truncate any symbols. */
export function buildTaskCodeSymbols(brief: ReviewBrief | undefined, repositoryKey: string, screen: (text: string) => boolean, privateTask = false): TaskCodeSymbols | undefined {
  if (privateTask || !brief || !sha(brief.head) || !sha(brief.mergeBase) || !text(repositoryKey)) return;
  const unknown: TaskCodeSymbols = { head: brief.head, mergeBase: brief.mergeBase, repositoryKey, state: "unknown", complete: false, countsFloor: true, symbols: [] };
  try {
    if (brief.symbols?.state !== "known") return unknown;
    if (!Array.isArray(brief.symbols.files) || brief.symbols.files.length > 500 || !Array.isArray(brief.reviewable) || brief.reviewable.length > 500) return unknown;
    const reviewable = new Set(brief.reviewable.map(file => file.path)), files = new Set<string>();
    if ([...reviewable].some(value => !path(value))) return unknown;
    let complete = brief.symbols.complete === true && brief.withheld === 0 && brief.unlisted.length === 0;
    const symbols: TaskCodeSymbol[] = [], ids = new Set<string>();
    let observed = 0;
    for (const file of brief.symbols.files) {
      if (!path(file.path) || !reviewable.has(file.path) || files.has(file.path) || !Array.isArray(file.symbols)) return unknown;
      files.add(file.path);
      for (const symbol of file.symbols) {
        if (++observed > 500) return unknown;
        const id = `symbol:${symbol.name}@${file.path}`;
        if (symbol.ambiguous || symbol.path !== file.path || !text(symbol.name) || !text(symbol.kind) || !/^[a-z_]+$/.test(symbol.kind)
          || !text(id) || !screen(file.path) || !screen(symbol.name) || !screen(symbol.kind) || !screen(id)) { complete = false; continue; }
        if (ids.has(id)) { complete = false; continue; }
        ids.add(id); symbols.push({ id, path: file.path, name: symbol.name, kind: symbol.kind });
      }
    }
    const result: TaskCodeSymbols = { ...unknown, state: "known", complete, symbols };
    return bounded(result) ? result : unknown;
  } catch { return unknown; }
}

/** Re-screen every public read; repository place keys are internal and never exported. */
export function publicTaskCodeSymbols(receipt: TaskCodeSymbols | undefined, head: string | undefined, repositoryKey: string, screen: (text: string) => boolean, privateTask = false): Omit<TaskCodeSymbols, "repositoryKey"> | undefined {
  const valid = parseTaskCodeSymbols(receipt);
  if (privateTask || !valid || !sha(head) || valid.head !== head || valid.repositoryKey !== repositoryKey) return;
  let complete = valid.complete;
  const symbols = valid.symbols.filter(symbol => {
    try { if ([symbol.id, symbol.path, symbol.name, symbol.kind].every(value => screen(value))) return true; } catch { /* failed policy is withheld */ }
    complete = false; return false;
  });
  const { repositoryKey: _repositoryKey, ...result } = valid;
  return { ...result, complete, symbols };
}

/** Advisory observed disjointness only. Floors/deleted-symbol limitations never justify a gate or lost notice. */
export function taskCodeSymbolsDisjoint(left: TaskCodeSymbols | undefined, right: TaskCodeSymbols | undefined, leftHead: string | undefined, rightHead: string | undefined, repositoryKey: string, sharedPaths: readonly string[], privateData = false, screen?: (text: string) => boolean): boolean {
  const current = (receipt: TaskCodeSymbols | undefined, head: string | undefined) => {
    if (!screen) return parseTaskCodeSymbols(receipt);
    const projected = publicTaskCodeSymbols(receipt, head, repositoryKey, screen, privateData);
    return projected ? { ...projected, repositoryKey } : undefined;
  };
  const a = current(left, leftHead), b = current(right, rightHead);
  if (privateData || !a || !b || !sha(leftHead) || !sha(rightHead) || a.head !== leftHead || b.head !== rightHead
    || a.repositoryKey !== repositoryKey || b.repositoryKey !== repositoryKey || a.state !== "known" || b.state !== "known" || !a.complete || !b.complete
    || !sharedPaths.length || sharedPaths.length > 500 || sharedPaths.some(value => !path(value))) return false;
  return sharedPaths.every(file => {
    const xs = a.symbols.filter(s => s.path === file), ys = b.symbols.filter(s => s.path === file);
    return xs.length > 0 && ys.length > 0 && !xs.some(x => ys.some(y => x.id === y.id || (!x.name.includes(".") && y.name.endsWith(`.${x.name}`)) || (!y.name.includes(".") && x.name.endsWith(`.${y.name}`))));
  });
}
