import packageJson from "../../package.json";
import { createHash } from "node:crypto";
import { CaptureStore, SearchIndex, looksSecret, type CaptureOptions as StoreCaptureOptions, type MemoryStore, type CandidateStore, type View } from "@staix/agent-mem";

export interface CaptureEvent {
  project: string; at?: string; agent: string; event: string; tool?: string; paths?: string[]; status?: string; excerpt: string;
  cwd?: string; sessionId?: string; toolUseId?: string; input?: string; output?: string; platformSource?: string;
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

/** In-process amem host. No worker URL, HTTP, model, timer or resident helper. Errors are neutral and fail open. */
export class MemoryClient {
  constructor(private readonly options?: MemoryClientOptions) {}
  private run<T>(work: (o: MemoryClientOptions) => T): T | undefined {
    try { if (!this.options) return undefined; this.options.check(); return work(this.options); }
    catch { this.options?.log?.("amem operation unavailable"); return undefined; }
  }
  private rows(o: MemoryClientOptions): View[] {
    // ponytail: refuse a view above 4096 rows rather than load unbounded history. Upgrade to policy-aware paged reads; the core still owns its index refresh.
    const rows = o.store?.list({ project: o.project, limit: 4097 }) ?? [];
    if (rows.length > 4096) throw new Error("memory read bound");
    return o.screen(rows.filter(v => !looksSecret(`${v.title ?? ""}\n${v.text}`) && !v.title?.startsWith("ahub ask (model answer)")));
  }
  async contextInject(_chain: string[], platformSource?: string): Promise<string | undefined> {
    return this.run(o => {
      const rows = this.rows(o).filter(v => v.tier === "short" && (!platformSource || v.peer === platformSource)).slice(0, 30);
      return rows.length ? `# [amem] recent curated context\n\n### Curated short-term notes\n${rows.map(v => `mem:${v.id} ${v.kind}: ${safeCell(v.title || v.text)}`).join("\n")}` : undefined;
    });
  }
  async search(query: string, _project: string, limit = 10): Promise<string | undefined> {
    return this.run(o => {
      if (!o.publicText(query)) return undefined;
      const rows = this.rows(o), cap = Math.min(30, Math.max(0, limit));
      const index = new SearchIndex(":memory:");
      try {
        if (!index.available) return "Search engine: substring\n" + table(rows.filter(v => `${v.title ?? ""} ${v.text} ${v.about.join(" ")}`.toLowerCase().includes(query.toLowerCase())).slice(0, cap));
        index.resync(() => rows.map(v => ({ id: v.id, at: v.at, project: o.project, tier: v.tier, scope: v.scope, body: `${v.title ?? ""}\n${v.text}\n${v.about.join(" ")}` })));
        const byId = new Map(rows.map(v => [v.id, v]));
        return table(index.query(query, cap, o.project).flatMap(hit => { const v = byId.get(hit.ref); return v ? [v] : []; }));
      } finally { index.close(); }
    });
  }
  async timeline(anchor: number | string, _project: string, before = 3, after = 3): Promise<string | undefined> {
    return this.run(o => {
      const rows = this.rows(o), at = rows.findIndex(v => `mem:${v.id}` === anchor);
      return at < 0 ? undefined : table(rows.slice(Math.max(0, at - Math.min(10, before)), at + Math.min(10, after) + 1));
    });
  }
  /** Auxiliary model/checkpoint writes are candidates, never curated evidence. Tasks' native note remains authoritative. */
  async save(note: { text: string; title?: string; project: string; metadata: Record<string, unknown> }): Promise<unknown> {
    return this.run(o => {
      if (!o.candidates || !o.publicText(JSON.stringify(note)) || looksSecret(JSON.stringify(note))) return undefined;
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
      const complete = JSON.stringify(event);
      if (!o.capture || !o.publicText(complete) || looksSecret(complete)) return undefined;
      o.check();
      const store = new CaptureStore({ ...o.capture(), project: o.project, screen: text => looksSecret(text) || !o.publicText(text) });
      try {
        const at = event.at ?? new Date().toISOString();
        const receipt = createHash("sha256").update(JSON.stringify([o.project,event.sessionId,event.toolUseId,event.event,at])).digest("hex");
        o.check();
        return store.append({ project: o.project, at, agent: event.agent, event: event.event, ...(event.tool ? { tool: event.tool } : {}), paths: event.paths ?? [], ...(event.status ? { status: event.status } : {}), excerpt: event.excerpt }, { receipt });
      } finally { store.close(); }
    });
  }
  async health(): Promise<{ ok: boolean; version?: string }> {
    return this.run(() => ({ ok: true, version: packageJson.dependencies["@staix/agent-mem"] })) ?? { ok: false };
  }
}
