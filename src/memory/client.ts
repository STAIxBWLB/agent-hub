import packageJson from "../../package.json";
import { createHash } from "node:crypto";
import { CaptureStore, SearchIndex, looksSecret, memoryBase, readCaptureConfig, type CaptureOptions as StoreCaptureOptions, type MemoryStore, type CandidateStore, type View } from "@staix/agent-mem";

export interface CaptureEvent {
  project: string; at?: string; agent: string; event: string; tool?: string; paths?: string[]; status?: string; excerpt: string;
  cwd?: string; sourceId?: string; sessionId?: string; toolUseId?: string; input?: string; output?: string; platformSource?: string;
}
export interface MemoryClientOptions {
  project: string;
  store?: MemoryStore;
  candidates?: CandidateStore;
  check(): void;
  /** The host screens complete rows before selection or rendering. */
  screen(rows: View[]): View[];
  publicText(text: string): boolean;
  capture?: () => Omit<StoreCaptureOptions, "project">;
  log?: (line: string) => void;
}
const safeCell = (text: string) => text.replace(/[|\r\n]/g, " ");
const table = (rows: View[]) => "| ID | Time | T | Title |\n|---|---|---|---|\n" + rows.map(v => `| #mem:${v.id} | ${v.at} | ${v.kind} | ${safeCell(v.title || v.text)} |`).join("\n");

/** Policy sees literal field strings as well as JSON, before display/storage escaping can hide a private value. */
function policyText(value: unknown): string {
  const raw: string[] = [];
  const encoded = JSON.stringify(value, (key: string, item: unknown) => {
    if (key && item !== undefined) raw.push(key);
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("invalid memory scalar");
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      const text = String(item); raw.push(text); if (key) raw.push(`${key}: ${text}`);
    }
    return item;
  });
  return `${encoded ?? ""}\n${raw.join("\n")}`;
}
/** Only authoritative tool JSON is decoded, once; arbitrary embedded encodings are not interpreted. */
function toolJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

/** In-process amem host. No worker URL, HTTP, model, timer or resident helper. Errors are neutral and fail open. */
export class MemoryClient {
  private captureStore?: CaptureStore;
  private captureKey?: string;
  private closed = false;
  private viewStatus = { truncated: false, scanned: 0, limit: 4096 };
  constructor(private readonly options?: MemoryClientOptions) {}
  readStatus(): { truncated: boolean; scanned: number; limit: number } { return { ...this.viewStatus }; }
  readNotice(): string | undefined { return this.viewStatus.truncated ? `memory view truncated: newest ${this.viewStatus.limit} project candidates considered` : undefined; }
  private releaseCapture(): void {
    const store = this.captureStore; this.captureStore = undefined; this.captureKey = undefined;
    try { store?.close(); } catch { /* fail-open teardown */ }
  }
  close(): void { this.closed = true; this.releaseCapture(); }
  private run<T>(work: (o: MemoryClientOptions) => T): T | undefined {
    try { if (!this.options || this.closed) return undefined; this.options.check(); return work(this.options); }
    catch { this.releaseCapture(); this.options?.log?.("amem operation unavailable"); return undefined; }
  }
  private rows(o: MemoryClientOptions): View[] {
    const store = o.store;
    this.viewStatus = { truncated: false, scanned: 0, limit: 4096 };
    if (!store) return [];
    const rows: View[] = [];
    let after: { position: number; id: string } | undefined;
    // ponytail: at most 4096 exact-project candidate bodies, in published keyset pages. The core still folds relation metadata; upgrade to core tier/scope pages and incremental metadata snapshots.
    for (let page = 0; page < 16; page++) {
      const result = store.readPage({ project: o.project, limit: 256, ...(after ? { after } : {}) });
      this.viewStatus.scanned += result.rows.length;
      if (result.rows.length) rows.push(...o.screen(result.rows.filter(v => !looksSecret(`${v.title ?? ""}\n${v.text}`) && !v.title?.startsWith("ahub ask (model answer)"))));
      if (!result.next) return rows;
      after = result.next;
    }
    this.viewStatus.truncated = !!store.readPage({ project: o.project, limit: 1, ...(after ? { after } : {}) }).next;
    return rows;
  }
  async contextInject(_chain: string[], _platformSource?: string): Promise<string | undefined> {
    return this.run(o => {
      const rows = this.rows(o).filter(v => v.tier === "short").slice(0, 30);
      const notice = this.readNotice();
      return rows.length || notice ? `# [amem] recent curated context\n\n### Curated short-term notes\n${[...(notice ? [notice] : []), ...rows.map(v => `mem:${v.id} ${v.kind}: ${safeCell(v.title || v.text)}`)].join("\n")}` : undefined;
    });
  }
  async search(query: string, _project: string, limit = 10): Promise<string | undefined> {
    return this.run(o => {
      if (!o.publicText(query)) return undefined;
      const rows = this.rows(o), cap = Math.min(30, Math.max(0, limit));
      const index = new SearchIndex(":memory:");
      try {
        const notice = this.readNotice();
        const coverage = notice ? `${notice}\n` : "";
        if (!index.available) {
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          return coverage + "Search engine: substring\n" + table(rows.filter(v => terms.every(term => `${v.title ?? ""} ${v.text} ${v.about.join(" ")}`.toLowerCase().includes(term))).slice(0, cap));
        }
        index.resync(() => rows.map(v => ({ id: v.id, at: v.at, project: o.project, tier: v.tier, scope: v.scope, body: `${v.title ?? ""}\n${v.text}\n${v.about.join(" ")}` })));
        const byId = new Map(rows.map(v => [v.id, v]));
        return coverage + table(index.query(query, cap, o.project).flatMap(hit => { const v = byId.get(hit.ref); return v ? [v] : []; }));
      } finally { index.close(); }
    });
  }
  async timeline(anchor: number | string, _project: string, before = 3, after = 3): Promise<string | undefined> {
    return this.run(o => {
      const rows = this.rows(o), at = rows.findIndex(v => `mem:${v.id}` === anchor);
      return at < 0 ? this.readNotice() : `${this.readNotice() ? this.readNotice() + "\n" : ""}` + table(rows.slice(Math.max(0, at - Math.min(10, before)), at + Math.min(10, after) + 1));
    });
  }
  /** Auxiliary model/checkpoint writes are candidates, never curated evidence. Tasks' native note remains authoritative. */
  async save(note: { text: string; title?: string; project: string; metadata: Record<string, unknown> }): Promise<unknown> {
    return this.run(o => {
      if (!o.candidates) return undefined;
      const complete = policyText({ ...note, project: o.project });
      if (!o.publicText(complete) || looksSecret(complete)) return undefined;
      o.check();
      const text = `Submitted metadata: ${JSON.stringify(note.metadata)}\n\n${note.text}`;
      if (!o.publicText(text) || looksSecret(text)) return undefined;
      const noteKind = ["decision", "finding", "contract", "fail"].includes(String(note.metadata.kind)) ? note.metadata.kind as "decision" | "finding" | "contract" | "fail" : "finding";
      const id = o.candidates.put({ kind: "memory", project: o.project, text, noteKind, ...(note.title ? { title: note.title } : {}) }, "public");
      return { status: "candidate", id: `candidate:${id}` };
    });
  }
  async appendCapture(event: CaptureEvent): Promise<unknown> {
    return this.run(o => {
      // Inspect persisted/user data, not host locators such as cwd (the parent of every private path).
      const data = { project: o.project, agent: event.agent, event: event.event, tool: event.tool, paths: event.paths,
        status: event.status, excerpt: event.excerpt, input: event.input, output: event.output };
      const complete = policyText([data, toolJson(event.input), toolJson(event.output)]);
      if (!o.capture || !o.publicText(complete) || looksSecret(complete)) return undefined;
      o.check();
      const options = o.capture();
      const config = this.captureStore ? readCaptureConfig(this.captureStore.dir, options.memoryDir ?? memoryBase(options.home)) : undefined;
      const key = JSON.stringify([o.project, options.home, options.memoryDir, options.capMb ?? config?.capMb, options.retentionDays ?? config?.retentionDays]);
      if (this.captureKey !== key) {
        this.releaseCapture();
        this.captureStore = new CaptureStore({ ...options, project: o.project, screen: text => looksSecret(text) || !o.publicText(text) });
        const limits = this.captureStore.stats();
        this.captureKey = JSON.stringify([o.project, options.home, options.memoryDir, limits.capMb, limits.retentionDays]);
      }
      const store = this.captureStore!;
      {
        const at = event.at ?? new Date().toISOString();
        const receipt = createHash("sha256").update(JSON.stringify([o.project,event.sessionId,event.sourceId,event.toolUseId,event.event,at])).digest("hex");
        o.check();
        return store.append({ project: o.project, at, agent: event.agent, event: event.event, ...(event.tool ? { tool: event.tool } : {}), paths: event.paths ?? [], ...(event.status ? { status: event.status } : {}), excerpt: event.excerpt }, { receipt });
      }
    });
  }
  async health(): Promise<{ ok: boolean; version?: string }> {
    return this.run(() => ({ ok: true, version: packageJson.dependencies["@staix/agent-mem"] })) ?? { ok: false };
  }
}
