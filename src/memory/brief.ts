import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";

export interface BriefItem {
  id: number | string;
  time: string;
  type: string;
  title: string;
}

/** Amem entry tables (plus legacy numeric fixture compatibility): `| #65499 | 12:30 PM | ◆ | Title | ~372 |`. A row that does not match is skipped, never an error. */
export function parseRows(markdown: string | undefined): BriefItem[] {
  const out: BriefItem[] = [];
  for (const m of (markdown ?? "").matchAll(/^\|\s*#(mem:[a-f0-9]{32}|\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|/gm)) {
    out.push({ id: m[1]!.startsWith("mem:") ? m[1]! : Number(m[1]), time: m[2]!, type: m[3]!, title: m[4]!.replace(/\s*<-\s*\*\*ANCHOR\*\*/, "") });
  }
  return out;
}

/** Index first, then the neighbourhood of the top hit: the retrieval both task briefs and `ahub ask` use. Deduplicated, in order. */
export async function related(client: MemoryClient, project: string, query: string, around = 3): Promise<BriefItem[]> {
  const hits = parseRows(await client.search(query.slice(0, 300), project, 10));
  if (!hits.length) return [];
  const near = parseRows(await client.timeline(hits[0]!.id, project, around, around));
  const out: BriefItem[] = [];
  for (const item of [...hits, ...near]) if (!out.some((o) => o.id === item.id)) out.push(item);
  return out;
}

/** A native memory line for a brief (#258): `mem:<id8> <kind> <tier>: <title or text>`, fails first. */
export interface NativeItem { id: string; line: string; kind?: string; about?: readonly string[] }
export type NativeBrief = (task: BriefTask) => NativeItem[];
export interface BriefTask { id?: number; created?: number; title: string; refs: { paths?: string[] }; plan?: { paths?: string[]; symbols?: string[] } }

/**
 * Task briefs: what memory already knows about a piece of work, handed over with it. The hub's own store first (#258:
 * entries one or two hops from the task's paths, symbols, issue and task, a linked fail first, superseded entries
 * dropped), then amem: index first (search), then the neighbourhood of the top hit (timeline); details stay in
 * the store for the receiver to fetch by id. `brief_items` caps both together. A peer is never shown the same entry
 * twice in one hub run, except a directly matching plan fail that must accompany a new task.
 */
export class Briefs {
  private readonly seen = new Map<PeerId, Set<string>>();

  constructor(
    private readonly client: MemoryClient | undefined,
    private readonly project: string,
    private readonly maxItems: number | (() => number) = 8,
    private readonly native?: NativeBrief,
    /** Counts of what a brief carried, for the research records (#258 AC11); never its text. */
    private readonly observe?: (peer: PeerId, task: number, counts: { native: number; fails: number; claudeMem: number }) => void,
    private readonly displayNative?: (items: readonly NativeItem[]) => string[],
  ) {}

  async forTask(peer: PeerId, task: BriefTask, priority: readonly NativeItem[] = []): Promise<string | undefined> {
    const maximum = typeof this.maxItems === "function" ? this.maxItems() : this.maxItems;
    const seen = this.seen.get(peer) ?? new Set<string>();
    this.seen.set(peer, seen);
    const own: NativeItem[] = [];
    // A plan fail is task-specific guidance even when a previous task already carried it.
    for (const item of priority) if (own.length < maximum && !own.some(existing => existing.id === item.id)) own.push(item);
    try { for (const item of this.native?.(task) ?? []) if (!seen.has(item.id) && !own.some(existing => existing.id === item.id) && own.length < maximum) own.push(item); } catch { /* fail-open: the store is optional */ }
    const found = this.client && own.length < maximum ? await related(this.client, this.project, [task.title, ...(task.refs.paths ?? [])].join(" ")) : [];
    const items: BriefItem[] = [];
    for (const item of found) {
      if (seen.has(`#${item.id}`) || seen.has(String(item.id)) || own.some(v => v.id === item.id)) continue;
      items.push(item);
      if (own.length + items.length === maximum) break;
    }
    const notice = this.client?.readNotice();
    if (!own.length && !items.length && !notice) return undefined;
    for (const item of own) seen.add(item.id);
    for (const item of items) seen.add(`#${item.id}`);
    if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: own.length, fails: own.filter((i) => i.kind === "fail").length, claudeMem: items.length }); } catch { /* telemetry never fails a brief */ }
    const header = own.length ? "Memory brief (hub memory first, fails first: ahub memory show <mem id>; amem by mem:id):" : "Memory brief (amem curated notes; fetch details by mem:id):";
    return [header, ...(notice ? [notice] : []), ...(this.displayNative?.(own) ?? own.map((i) => i.line)), ...items.map((i) => `${i.id.toString().startsWith("mem:") ? i.id : `#${i.id}`} ${i.time} ${i.type} ${i.title}`)].join("\n");
  }
}
