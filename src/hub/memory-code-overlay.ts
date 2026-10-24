import type { NativeItem } from "../memory/brief.ts";
import { unindexedSymbolSyntax, type CodeFactResult, type CodeSymbol } from "./code-facts.ts";
import { canonicalMemorySymbolNode, MEMORY_SYMBOL_START_BUDGET_MS, type MemorySymbolContext } from "./memory-symbols.ts";

export const MEMORY_CODE_SEEDS = 4, MEMORY_CODE_NEIGHBOURS = 32, MEMORY_CODE_EDGES = 64;
const NOTE_LIMIT = 16, NOTE_SCAN_LIMIT = 128, SHA = /^[a-f0-9]{40}$/;
export interface MemoryCodeNode { id: string; type: "symbol"; label: string; derived: true; head: string }
export interface MemoryCodeEdge { from: string; to: string; rel: "calls"; derived: true; head: string }
export interface MemoryCodeOverlay {
  state: "known" | "unknown";
  head?: string;
  nodes: MemoryCodeNode[];
  edges: MemoryCodeEdge[];
  notes: NativeItem[];
  queried: number;
  unknown: number;
  truncated: boolean;
  countsFloor: boolean;
}
export interface CodeNeighbourhood { callers: CodeSymbol[]; callees: CodeSymbol[]; hiddenAmbiguous: number; countsFloor: boolean }
export interface MemoryCodeOverlayOptions {
  context(): Omit<MemorySymbolContext, "allowed">;
  head(): string | undefined;
  /** Current binding, invocation, repository and task provenance, checked across every await. */
  valid(): boolean;
  private?(): boolean;
  publicMetadataText(text: string): boolean;
  neighbours(repo: string, head: string, selector: string, depth: 1): Promise<CodeFactResult<CodeNeighbourhood>>;
  /** Fully screened current notes only; no authoritative memory/candidate writes. */
  related?(nodes: readonly string[], limit: number): readonly NativeItem[];
  now?: () => number;
}
export function unavailableMemoryCodeOverlay(): MemoryCodeOverlay {
  return { state: "unknown", nodes: [], edges: [], notes: [], queried: 0, unknown: 0, truncated: false, countsFloor: false };
}

/** One read-time call hop, distinct from the stored memory graph. Never persists nodes, edges or notes. */
export async function deriveMemoryCodeOverlay(starts: readonly string[], options: MemoryCodeOverlayOptions): Promise<MemoryCodeOverlay> {
  const out = unavailableMemoryCodeOverlay(), now = options.now ?? performance.now.bind(performance);
  const deadline = now() + MEMORY_SYMBOL_START_BUDGET_MS;
  try {
    const initial = options.context(), head = options.head();
    const valid = () => {
      const current = options.context();
      return !options.private?.() && options.valid() && options.head() === head
        && current.cwd === initial.cwd && current.project === initial.project && current.repo === initial.repo;
    };
    if (!head || !SHA.test(head) || !valid()) return out;
    out.head = head; out.state = "known"; out.truncated = starts.length > MEMORY_CODE_SEEDS;
    const canonical = (raw: string) => canonicalMemorySymbolNode(raw, { ...options.context(), allowed: options.publicMetadataText });
    const nodes = new Map<string, MemoryCodeNode>(), edges = new Map<string, MemoryCodeEdge>(), neighbours = new Set<string>(), seen = new Set<string>();
    const node = (id: string): MemoryCodeNode => ({ id, type: "symbol", label: id.slice(7), derived: true, head });
    for (const raw of starts.slice(0, MEMORY_CODE_SEEDS)) {
      if (!valid()) return { ...unavailableMemoryCodeOverlay(), queried: out.queried, truncated: out.truncated };
      const seed = canonical(raw);
      if (!seed) { out.unknown++; continue; }
      const at = seed.lastIndexOf("@"), name = seed.slice(7, at), path = seed.slice(at + 1);
      // The CLI's file:name selector cannot certify a colon-bearing file or unsupported host name syntax.
      if (path.includes(":") || unindexedSymbolSyntax(name)) { out.unknown++; continue; }
      if (seen.has(seed)) continue;
      seen.add(seed);
      if (now() >= deadline) { out.unknown++; out.truncated = true; continue; }
      try {
        out.queried++;
        const answer = await options.neighbours(initial.cwd, head, `${path}:${name}`, 1);
        if (!valid()) return { ...unavailableMemoryCodeOverlay(), queried: out.queried, truncated: out.truncated };
        if (canonical(raw) !== seed) { out.unknown++; continue; }
        if (answer.state !== "known") { out.unknown++; continue; }
        const facts = answer.value;
        if (!Array.isArray(facts.callers) || !Array.isArray(facts.callees) || !Number.isSafeInteger(facts.hiddenAmbiguous) || facts.hiddenAmbiguous < 0 || typeof facts.countsFloor !== "boolean") { out.unknown++; continue; }
        nodes.set(seed, node(seed)); out.countsFloor ||= facts.countsFloor;
        if (facts.hiddenAmbiguous) out.unknown++;
        for (const [items, incoming] of [[facts.callers, true], [facts.callees, false]] as const) {
          if (items.length > 256) out.truncated = true;
          for (const item of items.slice(0, 256)) {
            if (item.ambiguous !== false) { out.unknown++; continue; }
            const id = canonical(`symbol:${item.name}@${item.path}`);
            if (!id) { out.unknown++; continue; }
            if (id === seed) continue;
            const from = incoming ? id : seed, to = incoming ? seed : id, key = JSON.stringify([from, to]);
            if (edges.has(key)) continue;
            if (edges.size >= MEMORY_CODE_EDGES || (!neighbours.has(id) && neighbours.size >= MEMORY_CODE_NEIGHBOURS)) { out.truncated = true; continue; }
            neighbours.add(id); nodes.set(id, node(id)); edges.set(key, { from, to, rel: "calls", derived: true, head });
          }
        }
      } catch { out.unknown++; }
    }
    if (!valid()) return { ...unavailableMemoryCodeOverlay(), queried: out.queried, truncated: out.truncated };
    // Later queries can tighten policy for an earlier result. Reproject everything synchronously under current policy.
    const kept = new Set([...nodes.keys()].filter(id => canonical(id) === id));
    if (kept.size !== nodes.size) out.unknown++;
    out.edges = [...edges.values()].filter(edge => kept.has(edge.from) && kept.has(edge.to));
    const connected = new Set(out.edges.flatMap(edge => [edge.from, edge.to]));
    out.nodes = [...nodes.values()].filter(value => kept.has(value.id) && (connected.has(value.id) || seen.has(value.id)));
    const neighbourIds = [...neighbours].filter(id => kept.has(id) && connected.has(id));
    if (options.related && neighbourIds.length) {
      try {
        const rows = options.related(neighbourIds, NOTE_SCAN_LIMIT);
        if (rows.length > NOTE_SCAN_LIMIT) out.truncated = true;
        const safe = rows.slice(0, NOTE_SCAN_LIMIT).filter(item => /^mem:[a-f0-9]{32}$/.test(item.id) && Buffer.byteLength(item.line) <= 1024
          && item.about && item.about.length <= 64 && item.about.some(id => neighbourIds.includes(id))
          && [item.id, item.line, item.kind ?? "", ...item.about].every(options.publicMetadataText));
        const ordered = [...new Map(safe.map(item => [item.id, item])).values()].sort((a, b) => Number(b.kind === "fail") - Number(a.kind === "fail") || a.id.localeCompare(b.id));
        out.truncated ||= ordered.length > NOTE_LIMIT;
        out.notes = ordered.slice(0, NOTE_LIMIT).map(item => ({ ...item, about: [...item.about!] }));
      } catch { out.unknown++; }
    }
    if (!valid()) return { ...unavailableMemoryCodeOverlay(), queried: out.queried, truncated: out.truncated };
    const finalIds = new Set(out.nodes.filter(value => canonical(value.id) === value.id).map(value => value.id));
    if (finalIds.size !== out.nodes.length) out.unknown++;
    out.edges = out.edges.filter(edge => finalIds.has(edge.from) && finalIds.has(edge.to));
    const finalConnected = new Set(out.edges.flatMap(edge => [edge.from, edge.to]));
    out.nodes = out.nodes.filter(value => finalIds.has(value.id) && (seen.has(value.id) || finalConnected.has(value.id)));
    out.notes = out.notes.filter(item => item.about?.some(id => neighbours.has(id) && finalIds.has(id) && finalConnected.has(id))
      && [item.id, item.line, item.kind ?? "", ...(item.about ?? [])].every(options.publicMetadataText));
    if (out.unknown || out.truncated) out.state = "unknown";
    return out;
  } catch { return { ...unavailableMemoryCodeOverlay(), queried: out.queried, truncated: out.truncated }; }
}
