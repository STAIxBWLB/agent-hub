import { buildIntentBrief, parseRecordLines, type CaptureRow, type IntentBriefOptions, type IntentBriefSource } from "@staix/agent-mem";
import { controlWriteSpan } from "../hub/control-write-trace.ts";
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
export interface NativeItem { id: string; line: string; kind?: string; about?: readonly string[]; tier?: string; peer?: string; machine?: string; at?: string; anchors?: readonly string[] }
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

export interface RecordPreferenceCounts { beforeBytes: number; afterBytes: number; replacedNotes: number; records: number }
export interface RecordBriefSnapshot {
  /** Relevant complete rows already authorized and screened by the host, from readBriefRecords. */
  rows: readonly CaptureRow[];
  /** Only known generated done/review notes. Anchors are explicit raw Record anchors, never inferred prose. */
  replaceable: readonly { id: string; anchors: readonly string[] }[];
  partial: boolean;
  /** Re-screen the same complete rows against current host policy; false/throw revokes this snapshot. */
  current?(): boolean;
}
export interface RecordBriefPort {
  allowed(task: BriefTask): boolean;
  policyVersion(task?: BriefTask): string;
  read(task: BriefTask): RecordBriefSnapshot | undefined | Promise<RecordBriefSnapshot | undefined>;
  observe?(peer: PeerId, task: number | undefined, counts: RecordPreferenceCounts): void;
  /** Legacy Record addition ceiling. Existing larger context is retained; additions cannot enlarge it. */
  maxBytes?: number | (() => number);
}
const RECORD_ROWS = 32, RECORD_BYTES = 2048;
const LEGACY_KNOWLEDGE_HEADER = "Knowledge brief (advice, not a block):";
const LEGACY_NATIVE_HEADER = "Memory brief (hub memory first, fails first: ahub memory show <mem id>; amem by mem:id):";
const LEGACY_CURATED_HEADER = "Memory brief (amem curated notes; fetch details by mem:id):";

/** Read-time display preference only; the package parser owns Record syntax and canonical anchors. */
export function preferRecordItems(items: readonly NativeItem[], snapshot: RecordBriefSnapshot, maximum: number,
  protectedIds: ReadonlySet<string> = new Set(), maximumLineBytes = 2048): { items: NativeItem[]; replacedNotes: number; records: number } {
  const original = () => ({ items: [...items], replacedNotes: 0, records: 0 });
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 0 || snapshot.rows.length > RECORD_ROWS || snapshot.replaceable.length > RECORD_ROWS) return original();
  const records: { item: NativeItem; anchors: readonly string[] }[] = [];
  for (const row of snapshot.rows) {
    if (row.event !== "Record" || row.subagent || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.excerpt !== "string"
      || row.excerpt.length > RECORD_BYTES || Buffer.byteLength(row.excerpt) > RECORD_BYTES || !Array.isArray(row.paths)) continue;
    const parsed = parseRecordLines(row.excerpt), record = parsed.records[0];
    if (parsed.incomplete || Object.keys(parsed.drops).length || parsed.records.length !== 1 || !record || record.line !== row.excerpt
      || record.anchors.length !== row.paths.length || !record.anchors.every((anchor, index) => anchor === row.paths[index])) continue;
    const id = `capture:Record:${row.id}`;
    if (records.some(value => value.item.id === id)) continue;
    records.push({ item: { id, line: `${id} ${record.line}`, kind: record.kind, anchors: record.anchors }, anchors: record.anchors });
  }
  const bytes = (rows: readonly NativeItem[]) => Buffer.byteLength(rows.map(item => item.line).join("\n"));
  // Preexisting priority/baseline context is never deleted merely to satisfy a new optional source cap.
  const ceiling = Math.max(maximumLineBytes, bytes(items));
  const selected = [...items]; let replacedNotes = 0;
  const partialMarker = "[partial Record window: older Records not read] ";
  const marked = (rows: NativeItem[]): NativeItem[] => {
    if (!snapshot.partial) return rows;
    let first = true;
    return rows.map(item => {
      if (!first || !records.some(record => record.item.id === item.id)) return item;
      first = false;
      return item.line.startsWith(partialMarker) ? item : { ...item, line: partialMarker + item.line };
    });
  };
  // A partial candidate window does not weaken explicit saved-id/anchor proof for its complete known rows.
  for (const note of items) {
    if (note.kind === "fail" || note.kind === "contract" || protectedIds.has(note.id)) continue;
    const permitted = snapshot.replaceable.filter(value => value.id === note.id);
    if (permitted.length !== 1 || !permitted[0]!.anchors.length) continue;
    const anchors = permitted[0]!.anchors;
    const covering = records.filter(record => record.anchors.some(anchor => anchors.includes(anchor)));
    if (!anchors.every(anchor => covering.some(record => record.anchors.includes(anchor)))) continue;
    const additions = covering.filter(record => !selected.some(item => item.id === record.item.id));
    if (selected.length - 1 + additions.length > maximum) continue;
    const position = selected.findIndex(item => item.id === note.id);
    if (position < 0) continue;
    const complete = additions.map(record => record.item);
    if (bytes(complete) > Buffer.byteLength(note.line)) continue;
    const candidate = marked([...selected.slice(0, position), ...complete, ...selected.slice(position + 1)]);
    if (bytes(candidate) > ceiling || bytes(candidate) > bytes(selected)) continue;
    selected.splice(0, selected.length, ...candidate); replacedNotes++;
  }
  // Host relevance is authoritative; spare room can carry Records without suppressing any original item.
  for (const record of records) {
    if (selected.length >= maximum || selected.some(item => item.id === record.item.id)) continue;
    const candidate = marked([...selected, record.item]);
    if (bytes(candidate) > ceiling) continue;
    selected.splice(0, selected.length, ...candidate);
  }
  return { items: selected, replacedNotes, records: selected.filter(item => records.some(record => record.item.id === item.id)).length };
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
    private readonly records?: RecordBriefPort,
  ) {}

  async forTask(peer: PeerId, task: BriefTask, priority: readonly NativeItem[] = []): Promise<string | undefined> {
    return controlWriteSpan("memory", () => this.forTaskBody(peer, task, priority));
  }

  private async forTaskBody(peer: PeerId, task: BriefTask, priority: readonly NativeItem[]): Promise<string | undefined> {
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
    const recordItems = async (items: readonly NativeItem[], lineBudget: number): Promise<{ items: NativeItem[]; replacedNotes: number; records: number; invalidated?: true; current?: () => boolean }> => {
      let version: string | undefined, snapshot: RecordBriefSnapshot | undefined;
      const recordCurrent = () => {
        try { return current() && this.records!.allowed(task) && this.records!.policyVersion(task) === version && (snapshot?.current === undefined || snapshot.current() === true); } catch { return false; }
      };
      const fallback = () => ({ items: [...items], replacedNotes: 0, records: 0, ...(version === undefined ? {} : { current: recordCurrent }) });
      if (!this.records || !current()) return fallback();
      try {
        if (!this.records.allowed(task)) return fallback();
        version = this.records.policyVersion(task);
        snapshot = await this.records.read(task);
        if (!recordCurrent()) return { ...fallback(), invalidated: true };
        if (!snapshot) return fallback();
        const available = { ...snapshot, rows: snapshot.rows.filter(row => !this.seen.get(peer)?.has(`capture:Record:${row.id}`)) };
        const result = preferRecordItems(items, available, maximum, new Set(priority.map(item => item.id)), lineBudget);
        return { ...result, current: recordCurrent };
      } catch {
        try { if (version !== undefined && !recordCurrent()) return { ...fallback(), invalidated: true }; }
        catch { return { ...fallback(), invalidated: true }; }
        return fallback();
      }
    };
    const observeRecords = (before: string, after: string, result: { replacedNotes: number; records: number }) => {
      try { this.records?.observe?.(peer, task.id, { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), replacedNotes: result.replacedNotes, records: result.records }); }
      catch { /* count-only telemetry cannot fail a brief */ }
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
          if (!selected.length && !this.records) return undefined;
          // Preserve complete library rows (including graph neighbours after a seen direct bridge).
          if (!current()) return undefined;
          const header = selected.some(item => item.kind === "note") ? "Knowledge brief (advice, not a block):" : lines[0] || "Live fail notes for this plan (advice, not a block):";
          const before = [header, ...selected.map(item => item.line)].join("\n");
          const preferred = this.records ? await recordItems(selected, Math.max(0, (context.options.maxBytes ?? 2048) - Buffer.byteLength(header) - 1)) : { items: [...selected], replacedNotes: 0, records: 0, invalidated: undefined, current: undefined };
          if (preferred.invalidated || preferred.current?.() === false || !current() || context.options.allowed?.() === false || context.options.policyVersion() !== revision) return undefined;
          context.options.assertCurrent?.();
          const representedIds = selected.filter(item => !preferred.items.some(row => row.id === item.id)).map(item => item.id);
          selected.splice(0, selected.length, ...preferred.items);
          if (!selected.length) return undefined;
          const text = [header, ...selected.map(item => item.line)].join("\n");
          if (preferred.current?.() === false || !current()) return undefined;
          const claimSeen = () => {
            this.seen.set(peer, seen);
            for (const item of selected) seen.add(item.id);
            for (const id of representedIds) seen.add(id);
          };
          if (!this.records) claimSeen();
          if (!current()) return undefined;
          if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: selected.filter(item => item.kind !== "note").length, fails: selected.filter(item => item.kind === "fail").length, claudeMem: 0 }); } catch { /* telemetry never fails a brief */ }
          if (preferred.current?.() === false) return undefined;
          observeRecords(before, text, preferred);
          if (preferred.current?.() === false) return undefined;
          if (this.records) claimSeen();
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
    const beforeOwn = [...own, ...corpusRows];
    let legacyBytes = 2048;
    try { legacyBytes = typeof this.records?.maxBytes === "function" ? this.records.maxBytes() : this.records?.maxBytes ?? legacyBytes; }
    catch { legacyBytes = NaN; } // An unreadable optional cap cannot grant additional bytes.
    const indexLines = items.map(item => `${item.id.toString().startsWith("mem:") ? item.id : `#${item.id}`} ${item.time} ${item.type} ${item.title}`);
    const overhead = Math.max(...[LEGACY_KNOWLEDGE_HEADER, LEGACY_NATIVE_HEADER, LEGACY_CURATED_HEADER].map(header => Buffer.byteLength(header))) + 1
      + (notice ? Buffer.byteLength(notice) + 1 : 0) + indexLines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    const preferred = this.records ? await recordItems(beforeOwn, Math.max(0, legacyBytes - overhead)) : { items: beforeOwn, replacedNotes: 0, records: 0, invalidated: undefined, current: undefined };
    if (preferred.invalidated || preferred.current?.() === false || !current()) return undefined;
    // A Record read is another yield point. Concurrent legacy reads share this same set, so
    // recheck every ordinary row after it before claiming any delivered id.
    items.splice(0, items.length, ...items.filter(item => !seen.has(`#${item.id}`) && !seen.has(String(item.id))));
    // The index/timeline bridge has no anchor metadata and is never removed by a Record preference.
    const room = Math.max(0, maximum - items.length);
    const preferredOwn = preferred.items.length <= room ? preferred : { items: beforeOwn, replacedNotes: 0, records: 0 };
    own.splice(0, own.length, ...preferredOwn.items.filter(item => priorityIds.has(item.id) || !seen.has(item.id))); corpusRows.length = 0;
    if (!own.length && !items.length && !notice) return undefined;
    if (preferred.current?.() === false || !current()) return undefined;
    const claimSeen = () => {
      for (const item of own) seen.add(item.id);
      for (const item of beforeOwn) if (!preferredOwn.items.some(row => row.id === item.id)) seen.add(item.id);
      for (const item of items) seen.add(`#${item.id}`);
      for (const item of corpusRows) seen.add(item.id);
    };
    if (!this.records) claimSeen();
    if (!current()) return undefined;
    if (task.id !== undefined) try { this.observe?.(peer, task.id, { native: own.filter(item => item.kind !== "note").length, fails: own.filter((i) => i.kind === "fail").length, claudeMem: items.length }); } catch { /* telemetry never fails a brief */ }
    if (!current()) return undefined;
    const render = (rows: readonly NativeItem[]) => {
      const native = rows.filter(item => item.kind !== "note"), notes = rows.filter(item => item.kind === "note");
      const header = notes.length ? LEGACY_KNOWLEDGE_HEADER : rows.length ? LEGACY_NATIVE_HEADER : LEGACY_CURATED_HEADER;
      return [header, ...(notice ? [notice] : []), ...(this.displayNative?.(native) ?? native.map(item => item.line)), ...items.map(item => `${item.id.toString().startsWith("mem:") ? item.id : `#${item.id}`} ${item.time} ${item.type} ${item.title}`), ...notes.map(item => item.line)].join("\n");
    };
    const text = render(own);
    if (preferred.current?.() === false || !current()) return undefined;
    if (this.records) observeRecords(render(beforeOwn), text, { ...preferredOwn,
      records: own.filter(item => item.id.startsWith("capture:Record:")).length });
    if (preferred.current?.() === false || !current()) return undefined;
    if (this.records) claimSeen();
    return text;
  }
}
