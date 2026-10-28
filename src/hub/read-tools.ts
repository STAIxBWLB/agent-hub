import type { MemoryCodeOverlay } from "./memory-code-overlay.ts";
import type { MemoryStore, View, Graph } from "@staix/agent-mem";
import { looksSecret } from "@staix/agent-mem";
import { PreEffectToolRefusal } from "./tool-refusal.ts";

export const MEMORY_READ_TOOLS = new Set(["hub_memory_search", "hub_memory_show", "hub_memory_graph"]);
const REFUSAL = "memory read unavailable";
const bytes = (v: string) => Buffer.byteLength(v, "utf8");
const excerpt = (text: string, max = 200): string => {
  if (bytes(text) <= max) return text;
  const points = Array.from(text), marker = " [incomplete]";
  let length = 0, out = "";
  for (const point of points) { if (length + bytes(point) + bytes(marker) > max) break; out += point; length += bytes(point); }
  return out + marker;
};
function reject(): never { throw new PreEffectToolRefusal(REFUSAL); }
export type MemoryScreen = <T extends { title: string | null; text: string }>(rows: T[]) => T[];

/** Validate before capability logging, storage, or privacy work. Schemas alone do not enforce tool input. */
export function validateMemoryRead(op: string, a: Record<string, unknown>): void {
  if (!a || typeof a !== "object" || Array.isArray(a)) reject();
  const string = (v: unknown, min: number, max: number): v is string => typeof v === "string" && bytes(v) >= min && bytes(v) <= max;
  const array = (v: unknown, min: number, max: number): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every(s => string(s, min, max));
  const limit = (max: number) => a.limit === undefined || (Number.isInteger(a.limit) && Number(a.limit) >= 1 && Number(a.limit) <= max);
  const keys = op === "hub_memory_search" ? ["query", "limit"] : op === "hub_memory_show" ? ["ids"] : ["starts", "hops", "limit"];
  if (Object.keys(a).some(k => !keys.includes(k))) reject();
  if (op === "hub_memory_search" ? !string(a.query, 0, 200) || !limit(20)
    : op === "hub_memory_show" ? !array(a.ids, 6, 64)
    : !array(a.starts, 1, 200) || (a.hops !== undefined && a.hops !== 1 && a.hops !== 2) || !limit(120)) reject();
}

/** Read-only model projection. Counts and caps are computed only after screening whole records and metadata. */
export function memoryRead(store: MemoryStore | undefined, project: string, screen: MemoryScreen, op: string, a: Record<string, unknown>, stale: (about: readonly string[]) => boolean = () => false, code?: MemoryCodeOverlay): string {
  validateMemoryRead(op, a);
  const safe = (v: unknown): boolean => {
    try {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return !looksSecret(text) && screen([{ title: null, text }]).length === 1;
    } catch { return false; }
  };
  if (!safe(a)) reject();
  if (!store) return JSON.stringify({ error: REFUSAL });
  try {
    const all = screen(store.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true })).filter(safe);
    const resolve = (input: string): View => {
      const id = input.replace(/^mem:/, "");
      const aliases = [...new Set(all.flatMap(v => [v.id, ...(v.promotedFrom ? [v.promotedFrom] : [])]))];
      const matched = aliases.includes(id) ? [id] : aliases.filter(v => v.startsWith(id));
      if (id.length < 6) reject();
      if (!matched.length) {
        // Older promotion chains are resolved by the store, but only a fully screened visible terminal is exposed.
        const redirected = store.get(id, project);
        const visible = redirected && all.find(v => v.id === redirected.id);
        if (visible) return visible;
        reject();
      }
      if (matched.length !== 1) reject();
      const found = all.find(v => v.id === matched[0]) ?? all.find(v => v.promotedFrom === matched[0]);
      if (!found) reject();
      return found;
    };
    const finish = (v: unknown) => { if (!safe(v)) reject(); return JSON.stringify(v); };
    const order = (x: View, y: View) => Number(y.kind === "fail") - Number(x.kind === "fail") || y.at.localeCompare(x.at) || x.id.localeCompare(y.id);
    if (op !== "hub_memory_graph") {
      const show = op === "hub_memory_show", cap = show ? 8192 : 4096;
      const query = String(a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rows = show ? [...new Map((a.ids as string[]).map(id => { const v = resolve(id); return [v.id, v]; })).values()]
        : all.filter(v => !v.supersededBy && query.every(q => `${v.title ?? ""} ${v.text} ${v.about.join(" ")}`.toLowerCase().includes(q))).sort(order);
      const lines: string[] = [];
      const render = () => ({ lines, truncated: rows.length - lines.length });
      for (const v of rows) {
        if (lines.length >= (show ? 8 : Number(a.limit ?? 8))) break;
        const header = `mem:${v.id} ${v.kind} ${v.tier} source:${v.source} peer:${v.peer} project:${v.project} at:${v.at}: `.replace(/\s+/g, " ");
        const body = `${show && stale(v.about) ? "(stale?) " : ""}${v.title ? `${v.title}: ` : ""}${v.text}`.replace(/\s+/g, " ").trim();
        lines.push(header + body);
        if (bytes(JSON.stringify(render())) > cap) {
          const points = Array.from(body);
          let low = 0, high = points.length;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            lines[lines.length - 1] = header + points.slice(0, mid).join("") + " [incomplete]";
            if (bytes(JSON.stringify(render())) <= cap) low = mid; else high = mid - 1;
          }
          lines[lines.length - 1] = header + points.slice(0, low).join("") + " [incomplete]";
          if (bytes(JSON.stringify(render())) > cap) lines.pop();
        }
      }
      return finish(render());
    }
    const visible = new Map(all.map(v => [`mem:${v.id}`, v]));
    const goals = new Map(store.goals(project).filter(safe).map(v => [`goal:${v.id}`, v]));
    const starts = (a.starts as string[]).map(n => {
      if (n.startsWith("mem:")) return `mem:${resolve(n).id}`;
      if (n.startsWith("goal:") && !goals.has(n)) reject();
      return n;
    });
    type Node = Graph["nodes"][number] & { derived?: true; head?: string; codeNeighbour?: true };
    type Edge = Omit<Graph["edges"][number], "rel"> & { rel: string; derived?: true; head?: string };
    const nodes = new Map<string, Node>(), edges = new Map<string, Edge>();
    for (const start of starts) {
      const graph = store.graph(project, start, Number(a.hops ?? 1), Number.MAX_SAFE_INTEGER);
      for (const n of graph.nodes) {
        if ((n.id.startsWith("mem:") && !visible.has(n.id)) || (n.id.startsWith("goal:") && !goals.has(n.id))) continue;
        const memory = visible.get(n.id), goal = goals.get(n.id);
        // The dashboard graph already slices labels; model excerpts must retain a visible incompleteness marker.
        const shown = { ...n, label: excerpt(memory ? memory.title ?? memory.text : goal ? goal.title : n.label) };
        if (safe(shown)) nodes.set(n.id, shown);
      }
      for (const e of graph.edges) if (safe(e)) edges.set(JSON.stringify(e), e);
    }
    const overlay = code && /^[a-f0-9]{40}$/.test(code.head ?? "") && starts.some(id => id.startsWith("symbol:")) ? code : undefined;
    if (overlay) {
      for (const node of overlay.nodes) if (!nodes.has(node.id) && node.head === overlay.head && node.derived && safe(node)) nodes.set(node.id, node);
      for (const edge of overlay.edges) if (edge.head === overlay.head && edge.derived && edge.rel === "calls" && safe(edge)) edges.set(JSON.stringify(edge), edge);
      for (const note of overlay.notes) {
        const value = visible.get(note.id);
        if (!value || !safe(note)) continue;
        nodes.set(note.id, { id: note.id, type: "memory", label: excerpt(value.title ?? value.text), kind: value.kind, codeNeighbour: true });
        for (const about of value.about) if (overlay.nodes.some(node => node.id === about)) {
          const edge = { from: note.id, to: about, rel: value.kind === "fail" ? "rules_out" : "about" };
          edges.set(JSON.stringify(edge), edge);
        }
      }
    }
    const screenedEdges = [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to));
    const connected = new Set(screenedEdges.flatMap(e => [e.from, e.to]));
    const rank = (n: Graph["nodes"][number]) => n.kind === "fail" ? 0 : starts.includes(n.id) ? 1 : n.type !== "memory" ? 2 : 3;
    const eligibleNodes = [...nodes.values()].filter(n => connected.has(n.id) || starts.includes(n.id)).sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
    const eligibleEdges = screenedEdges.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const out: { nodes: Node[]; edges: Edge[]; truncated: number; code?: { state: "known" | "unknown"; head?: string; truncated: boolean; countsFloor: boolean } } = { nodes: [], edges: [], truncated: eligibleNodes.length + eligibleEdges.length,
      ...(code ? { code: { state: overlay?.state ?? "unknown", ...(overlay?.head ? { head: overlay.head } : {}), truncated: code.truncated, countsFloor: code.countsFloor } } : {}) };
    for (const n of eligibleNodes) {
      if (out.nodes.length >= Number(a.limit ?? 60)) break;
      out.nodes.push(n); out.truncated--;
      if (bytes(JSON.stringify(out)) > (eligibleEdges.length ? 5120 : 6144)) { out.nodes.pop(); out.truncated++; }
    }
    const kept = new Set(out.nodes.map(n => n.id));
    for (const e of eligibleEdges) {
      if (!kept.has(e.from) || !kept.has(e.to) || out.edges.length >= 240) continue;
      out.edges.push(e); out.truncated--;
      if (bytes(JSON.stringify(out)) > 6144) { out.edges.pop(); out.truncated++; }
    }
    return finish(out);
  } catch { return JSON.stringify({ error: REFUSAL }); }
}

export { sourceRead, validateSourceRead } from "./source-read.ts";
