import { planSymbolMatches } from "../hub/review-brief.ts";

// #684 2b: the "changed symbols" block of the console's task detail. Pure data to fields, no terminal code. The hub's own observation of the changed
// symbols (`codeSymbols`, PR #708) is read as it is; nothing is parsed from code here and nothing is asked of the hub beyond `task_show`.
// Advisory only: ripwire does not report deleted symbols, so these lists never establish that a plan was or was not followed. The plan names are `plan.symbols`,
// the same list `withCodeSymbols` reads as `planned` in the review brief (daemon.ts passes `task.plan?.symbols`), not a second source.

export interface ChangedSymbol { id: string; path: string; name: string; kind: string }
export interface SymbolBlock { state: "known" | "unknown"; complete: boolean; head?: string; matching: ChangedSymbol[]; unplanned: ChangedSymbol[]; untouched: string[] }

const MAX_LINES = 40;
const isPrivate = (task: any): boolean =>
  !task || (Array.isArray(task.signals) && task.signals.some((s: unknown) => s === "pii" || s === "pii_path")) || task.title === "[pii]";
const symbolsOf = (task: any): ChangedSymbol[] | undefined => {
  const received = task?.codeSymbols;
  if (!received || received.state !== "known" || !Array.isArray(received.symbols)) return undefined;
  // Only the public receipt (`publicTaskCodeSymbols`, re-screened on every read) is shown. A stored receipt still carries `repositoryKey` and was never screened for
  // the current policy: a task handed over in that shape reads as unknown, whatever feeds this renderer today (the renderer holds the rule itself).
  if (Object.hasOwn(received, "repositoryKey")) return undefined;
  const out: ChangedSymbol[] = [];
  for (const s of received.symbols) if (s && typeof s.id === "string" && typeof s.path === "string" && typeof s.name === "string" && typeof s.kind === "string") out.push({ id: s.id, path: s.path, name: s.name, kind: s.kind });
  return out;
};

/** Each changed symbol as matching the plan or unplanned, and each planned name nothing changed under as untouched. Unknown without code facts. */
export function classifySymbols(task: any): SymbolBlock {
  const changed = symbolsOf(task);
  if (!changed) return { state: "unknown", complete: false, matching: [], unplanned: [], untouched: [] };
  const plan: string[] = Array.isArray(task?.plan?.symbols) ? task.plan.symbols.filter((v: unknown): v is string => typeof v === "string") : [];
  const matching = changed.filter(s => plan.some(p => planSymbolMatches(p, s.name)));
  const unplanned = changed.filter(s => !plan.some(p => planSymbolMatches(p, s.name)));
  const untouched = plan.filter(p => !changed.some(s => planSymbolMatches(p, s.name)));
  return { state: "known", complete: task.codeSymbols.complete === true, ...(typeof task.codeSymbols.head === "string" ? { head: task.codeSymbols.head.slice(0, 8) } : {}), matching, unplanned, untouched };
}

/**
 * The detail fields for a task (`symbols` and `symbols note`), or none for a private one. Values are objects of single words (`{ matching: name, in: path }`) so the console's field
 * renderer quotes every agent-written string: a symbol name cannot pass for a hub label. Capped, with the count of what is left out.
 */
export function symbolFields(task: any): [string, unknown][] {
  // Only a task as `task_show` shapes it (a numeric id and a state): any other detail an agent or a test hands the Tasks panel keeps its own layout.
  if (!task || typeof task.id !== "number" || typeof task.state !== "string" || isPrivate(task)) return [];
  const block = classifySymbols(task);
  if (block.state === "unknown") return [["symbols", "changed symbols: unknown (no code facts)"]];
  const items: Record<string, string>[] = [
    ...block.matching.map(s => ({ matching: s.name, in: s.path })), ...block.unplanned.map(s => ({ unplanned: s.name, in: s.path })), ...block.untouched.map(name => ({ untouched: name })),
  ];
  const shown = items.slice(0, MAX_LINES);
  const note = [`changed symbols: ${block.matching.length} matching, ${block.unplanned.length} unplanned, ${block.untouched.length} untouched${block.head ? ` at ${block.head}` : ""}`,
    block.complete ? "" : "incomplete: some changed symbols were not listed, so an untouched one may have changed",
    "advisory: deleted symbols are not reported"].filter(Boolean).join("; ");
  return [["symbols", shown.length ? shown : "none observed"], ["symbols note", items.length > shown.length ? `${note}; ${items.length - shown.length} more not shown` : note]];
}


/** Render the hub's read-only pair verdicts; never derive disjointness from a local receipt or plan. */
export function overlapFields(task: any): [string, unknown][] {
  if (!task || typeof task.id !== "number" || typeof task.state !== "string" || isPrivate(task) || !Array.isArray(task.symbolOverlaps)) return [];
  if (!task.symbolOverlaps.length) return [["overlaps", "none"]];
  const items: Record<string, unknown>[] = [];
  let invalid = 0;
  for (const row of task.symbolOverlaps) {
    if (!row || !Number.isSafeInteger(row.task) || row.task < 1 || !Array.isArray(row.files)
      || !row.files.every((file: unknown) => typeof file === "string") || typeof row.sameFileDifferentSymbols !== "boolean") { invalid++; continue; }
    items.push({ task: row.task, files: row.files.slice(0, MAX_LINES),
      overlap: row.sameFileDifferentSymbols ? "same file, different symbols" : "overlap",
      ...(row.files.length > MAX_LINES ? { omitted: `${row.files.length - MAX_LINES} files not shown` } : {}) });
  }
  if (!items.length) return [["overlaps", "unknown (invalid overlap data)"]];
  const note = ["observed names only, deleted definitions may be missing",
    items.length > MAX_LINES ? `${items.length - MAX_LINES} more not shown` : "",
    invalid ? `${invalid} invalid rows withheld` : ""].filter(Boolean).join("; ");
  return [["overlaps", items.slice(0, MAX_LINES)], ["overlap note", note]];
}
