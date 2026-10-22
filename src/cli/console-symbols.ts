import { planSymbolMatches } from "../hub/review-brief.ts";

// #684 2b: the "changed symbols" block of the console's task detail. Pure data to fields, no terminal code. The hub's own observation of the changed
// symbols (`codeSymbols`, PR #708) is read as it is; nothing is parsed from code here and nothing is asked of the hub beyond `task_show`.
// Advisory only: ripwire does not report deleted symbols, so these lists never establish that a plan was or was not followed.

export interface ChangedSymbol { id: string; path: string; name: string; kind: string }
export interface SymbolBlock { state: "known" | "unknown"; complete: boolean; head?: string; matching: ChangedSymbol[]; unplanned: ChangedSymbol[]; untouched: string[] }

const MAX_LINES = 40;
const isPrivate = (task: any): boolean =>
  !task || (Array.isArray(task.signals) && task.signals.some((s: unknown) => s === "pii" || s === "pii_path")) || task.title === "[pii]";
const symbolsOf = (task: any): ChangedSymbol[] | undefined => {
  const received = task?.codeSymbols;
  if (!received || received.state !== "known" || !Array.isArray(received.symbols)) return undefined;
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
    block.complete ? "" : "partial: some changed symbols were not listed, so an untouched one may have changed",
    "advisory: deleted symbols are not reported"].filter(Boolean).join("; ");
  return [["symbols", shown.length ? shown : "none observed"], ["symbols note", items.length > shown.length ? `${note}; ${items.length - shown.length} more not shown` : note]];
}
