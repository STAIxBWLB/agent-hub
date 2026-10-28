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
export async function related(client: MemoryClient, project: string, query: string, around = 3, current?: () => boolean): Promise<BriefItem[]> {
  const search = await client.search(query.slice(0, 300), project, 10);
  if (current && !current()) throw new Error("brief context changed");
  const hits = parseRows(search);
  if (!hits.length) return [];
  const timeline = await client.timeline(hits[0]!.id, project, around, around);
  if (current && !current()) throw new Error("brief context changed");
  const near = parseRows(timeline);
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
export interface BriefTask { id?: number; created?: number; updated?: number; owner?: string | null; history?: readonly unknown[]; title: string; refs: { paths?: string[] }; plan?: { paths?: string[]; symbols?: string[] } }

/** Host-authorized corpus reads. The port screens and sanitizes its returned public note lines. */
export interface CorpusBriefPort {
  allowed(task: BriefTask): boolean;
  policyVersion(): string;
  read(task: BriefTask): NativeItem[] | Promise<NativeItem[]>;
}

/**
 * Production task briefs use the library's intent retrieval and rendering with host policy and bindings.
 * The hub applies its per-peer delivery dedupe and item cap to complete library rows, reserving the front
 * for host-screened plan fails even when the library's byte cap omitted them. Injected clients without
 * the library port retain the legacy index/timeline bridge; intent mode retires its related/readNotice path.
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
    private readonly corpus?: CorpusBriefPort,
  ) {}

  async forTask(peer: PeerId, task: BriefTask, priority: readonly NativeItem[] = []): Promise<string | undefined> {
    // A brief snapshots its configured cap once, before either optional source is selected.
    const maximum = typeof this.maxItems === "function" ? this.maxItems() : this.maxItems;
    let corpusRevision: string | undefined;
    const allowed = (): boolean => {
      if (!this.corpus) return true;
      try { return this.corpus.allowed(task); } catch { return false; }
    };
    const current = (): boolean => {
      if (!this.corpus) return true;
      try { return allowed() && this.corpus.policyVersion() === corpusRevision; } catch { return false; }
    };
    if (this.corpus) {
      if (!allowed()) return undefined;
      try { corpusRevision = this.corpus.policyVersion(); } catch { return undefined; }
      if (!current()) return undefined;
    }
    const corpusItems = async (room: number): Promise<NativeItem[] | undefined> => {
      if (!this.corpus || room < 1) return [];
      if (!current()) return undefined;
      try {
        const items = await this.corpus.read(task);
        if (!current()) return undefined;
        return items;
      } catch { return current() ? [] : undefined; }
    };
    if (this.intent) {
      // Serialize only this peer's library reads, so awaited policy cannot duplicate a delivered note.
      const previous = this.libraryRuns.get(peer);
      const run = (async () => {
        await previous?.catch(() => undefined);
        if (!current()) return undefined;
        if (maximum < 1) return undefined;
        try {
          const context = await this.intent!(task);
          if (!current()) return undefined;
          const seen = this.seen.get(peer) ?? new Set<string>();
          const revision = context.options.policyVersion();
          const result = await buildIntentBrief(context.source, context.options);
          if (!current()) return undefined;
          if (result.state === "unknown" || context.options.allowed?.() === false || context.options.policyVersion() !== revision) return undefined;
          context.options.assertCurrent?.();
          const lines = result.text.split("\n");
          const rendered = new Map(result.items.map((item, index) => [`mem:${item.id}`, lines[index + 1]!]));
          const selected: NativeItem[] = [];
          // Priority is already screened and sanitized by the host's plan guard. Its advice must survive
          // the standalone library's byte cap or narrower retrieval policy, and recur with the next task.
          for (const item of priority) if (selected.length < maximum && !selected.some(row => row.id === item.id)) selected.push({ ...item, line: rendered.get(item.id) ?? item.line });
          for (const item of result.items) {
            const id = `mem:${item.id}`;
            if (selected.length < maximum && !seen.has(id) && !selected.some(row => row.id === id)) selected.push({ id, line: rendered.get(id)!, kind: item.kind });
          }
          const corpus = await corpusItems(maximum - selected.length);
          if (corpus === undefined || !current()) return undefined;
          for (const item of corpus) if (selected.length < maximum && !seen.has(item.id) && !selected.some(row => row.id === item.id)) selected.push(item);
          if (!selected.length) return undefined;
          // Preserve complete library rows (including graph neighbours after a seen direct bridge).
          if (!current()) return undefined;
          const header = selected.some(item => item.kind === "note") ? "Knowledge brief (advice, not a block):" : lines[0] || "Live fail notes for this plan (advice, not a block):";
          const text = [header, ...selected.map(item => item.line)].join("\n");
          if (!current()) return undefined;
          this.seen.set(peer, seen);
          for (const item of selected) seen.add(item.id);
          if (!current()) return undefined;
          if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: selected.filter(item => item.kind !== "note").length, fails: selected.filter(item => item.kind === "fail").length, claudeMem: 0 }); } catch { /* telemetry never fails a brief */ }
          return text;
        } catch { return undefined; }
      })();
      this.libraryRuns.set(peer, run);
      try { return await run; } finally { if (this.libraryRuns.get(peer) === run) this.libraryRuns.delete(peer); }
    }
    if (!current()) return undefined;
    const seen = this.seen.get(peer) ?? new Set<string>();
    // Publish an empty peer set before the first await so concurrent briefs share dedupe state.
    // No ids enter it until the final policy guard, so an invalidated read cannot poison delivery.
    this.seen.set(peer, seen);
    let native: NativeItem[] = [];
    try {
      if (!current()) return undefined;
      native = await (this.native?.(task) ?? []);
      if (!current()) return undefined;
    } catch { if (!current()) return undefined; /* fail-open: the store and derived code context are optional */ }
    const own: NativeItem[] = [];
    // A plan fail is task-specific guidance even when a previous task already carried it.
    const priorityIds = new Set(priority.map(item => item.id));
    for (const item of priority) if (own.length < maximum && !own.some(existing => existing.id === item.id)) own.push(item);
    // Native order is host-supplied (linked fails, then nearer/newer); preserve it for synchronous callers too.
    try { for (const item of native) if (!seen.has(item.id) && !own.some(existing => existing.id === item.id) && own.length < maximum) own.push(item); } catch { /* optional native iteration stays fail-open */ }
    let found: BriefItem[] = [];
    if (this.client && own.length < maximum) {
      if (!current()) return undefined;
      try { found = await related(this.client, this.project, [task.title, ...(task.refs.paths ?? [])].join(" "), 3, current); }
      catch { if (!current()) return undefined; }
      if (!current()) return undefined;
    }
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
    const corpus = await corpusItems(maximum - own.length - items.length);
    if (corpus === undefined || !current()) return undefined;
    const corpusRows: NativeItem[] = [];
    for (const item of corpus) {
      if (own.length + items.length + corpusRows.length >= maximum) break;
      if (seen.has(item.id) || own.some(row => row.id === item.id) || corpusRows.some(row => row.id === item.id)) continue;
      corpusRows.push(item);
    }
    if (!current()) return undefined;
    const notice = this.client?.readNotice();
    if (!own.length && !items.length && !corpusRows.length && !notice) return undefined;
    if (!current()) return undefined;
    for (const item of own) seen.add(item.id);
    for (const item of items) seen.add(`#${item.id}`);
    for (const item of corpusRows) seen.add(item.id);
    if (!current()) return undefined;
    if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: own.filter(item => item.kind !== "note").length, fails: own.filter((i) => i.kind === "fail").length, claudeMem: items.length }); } catch { /* telemetry never fails a brief */ }
    if (!current()) return undefined;
    const nativeRows = own.filter(item => item.kind !== "note"), noteRows = [...own.filter(item => item.kind === "note"), ...corpusRows];
    const header = noteRows.length ? "Knowledge brief (advice, not a block):" : own.length ? "Memory brief (hub memory first, fails first: ahub memory show <mem id>; amem by mem:id):" : "Memory brief (amem curated notes; fetch details by mem:id):";
    return [header, ...(notice ? [notice] : []), ...(this.displayNative?.(nativeRows) ?? nativeRows.map((i) => i.line)), ...items.map((i) => `${i.id.toString().startsWith("mem:") ? i.id : `#${i.id}`} ${i.time} ${i.type} ${i.title}`), ...noteRows.map(item => item.line)].join("\n");
  }
}
