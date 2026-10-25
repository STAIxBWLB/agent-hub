import { buildIntentBrief, type IntentBriefOptions, type IntentBriefSource } from "@staix/agent-mem";
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
export interface NativeItem { id: string; line: string; kind?: string; about?: readonly string[]; tier?: string; peer?: string; machine?: string; at?: string }
export type NativeBrief = (task: BriefTask) => NativeItem[] | Promise<NativeItem[]>;
export interface IntentBriefContext { source: IntentBriefSource; options: IntentBriefOptions }
/** Host-owned policy and store binding; the library owns relevance, ordering and text. */
export type IntentBriefHost = (task: BriefTask) => IntentBriefContext | Promise<IntentBriefContext>;
export interface BriefTask { id?: number; created?: number; title: string; refs: { paths?: string[] }; plan?: { paths?: string[]; symbols?: string[] } }

/**
 * Production task briefs use the library's intent retrieval and rendering with host policy and bindings.
 * The hub applies its per-peer delivery dedupe and item cap to complete library rows. Injected clients without
 * the library port retain the legacy index/timeline bridge. Matching plan fails may recur with a new task.
 */
export class Briefs {
  private readonly seen = new Map<PeerId, Set<string>>();
  private readonly libraryRuns = new Map<PeerId, Promise<unknown>>();

  constructor(
    private readonly client: MemoryClient | undefined,
    private readonly project: string,
    private readonly maxItems: number | (() => number) = 8,
    private readonly native?: NativeBrief,
    /** Counts of what a brief carried, for the research records (#258 AC11); never its text. */
    private readonly observe?: (peer: PeerId, task: number, counts: { native: number; fails: number; claudeMem: number }) => void,
    private readonly displayNative?: (items: readonly NativeItem[]) => string[],
    private readonly intent?: IntentBriefHost,
  ) {}

  async forTask(peer: PeerId, task: BriefTask, priority: readonly NativeItem[] = []): Promise<string | undefined> {
    // A brief snapshots its configured cap once, before either optional source is selected.
    const maximum = typeof this.maxItems === "function" ? this.maxItems() : this.maxItems;
    if (this.intent) {
      // Serialize only this peer's library reads, so awaited policy cannot duplicate a delivered note.
      const previous = this.libraryRuns.get(peer);
      const run = (async () => {
        await previous?.catch(() => undefined);
        if (maximum < 1) return undefined;
        try {
          const context = await this.intent!(task);
          const seen = this.seen.get(peer) ?? new Set<string>();
          this.seen.set(peer, seen);
          const result = await buildIntentBrief(context.source, context.options);
          const priorityIds = new Set(priority.map(item => item.id));
          const eligible = result.items.filter(item => priorityIds.has(`mem:${item.id}`) || !seen.has(`mem:${item.id}`));
          const selectedIds = new Set([...eligible.filter(item => priorityIds.has(`mem:${item.id}`)), ...eligible.filter(item => !priorityIds.has(`mem:${item.id}`))].slice(0, maximum).map(item => item.id));
          const selected = eligible.filter(item => selectedIds.has(item.id));
          if (!result.text || !selected.length) return undefined;
          // Delivery policy removes complete library-rendered rows only. Never rank, clip or format them again:
          // a neighbour can remain relevant even when its original direct bridge was already delivered.
          const lines = result.text.split("\n");
          const text = [lines[0]!, ...selected.map(item => lines[result.items.indexOf(item) + 1]!)].join("\n");
          for (const item of selected) seen.add(`mem:${item.id}`);
          if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: selected.length, fails: selected.filter(item => item.kind === "fail").length, claudeMem: 0 }); } catch { /* telemetry never fails a brief */ }
          return text;
        } catch { return undefined; }
      })();
      this.libraryRuns.set(peer, run);
      try { return await run; } finally { if (this.libraryRuns.get(peer) === run) this.libraryRuns.delete(peer); }
    }
    const seen = this.seen.get(peer) ?? new Set<string>();
    this.seen.set(peer, seen);
    let native: NativeItem[] = [];
    try { native = await (this.native?.(task) ?? []); } catch { /* fail-open: the store and derived code context are optional */ }
    const own: NativeItem[] = [];
    // A plan fail is task-specific guidance even when a previous task already carried it.
    const priorityIds = new Set(priority.map(item => item.id));
    for (const item of priority) if (own.length < maximum && !own.some(existing => existing.id === item.id)) own.push(item);
    // Native order is host-supplied (linked fails, then nearer/newer); preserve it for synchronous callers too.
    try { for (const item of native) if (!seen.has(item.id) && !own.some(existing => existing.id === item.id) && own.length < maximum) own.push(item); } catch { /* optional native iteration stays fail-open */ }
    const found = this.client && own.length < maximum ? await related(this.client, this.project, [task.title, ...(task.refs.paths ?? [])].join(" ")) : [];
    // Another brief for this peer may finish while either optional source is awaited.
    const currentOwn = own.filter(item => priorityIds.has(item.id) || !seen.has(item.id)).slice(0, maximum);
    own.splice(0, own.length, ...currentOwn);
    const items: BriefItem[] = [];
    for (const item of found) {
      if (own.length + items.length >= maximum) break;
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
