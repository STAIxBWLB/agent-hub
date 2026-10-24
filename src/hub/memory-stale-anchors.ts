import { ASK_NOTE_TITLE } from "./ask.ts";
import { looksSecret, taskKey, type MemoryStore, type View } from "@staix/agent-mem";
import type { CodeFactResult } from "./code-facts.ts";
import { canonicalMemorySymbolNode, MEMORY_SYMBOL_LIMIT, MEMORY_SYMBOL_START_BUDGET_MS, type MemorySymbolContext } from "./memory-symbols.ts";

export const MEMORY_STALE_SCAN_LIMIT = 256;
const PAGE = 64, NODE_SCAN_LIMIT = 256;
const SHA = /^[a-f0-9]{40}$/, ID = /^[a-f0-9]{32}$/;
export type MemoryTaskPrivacy = "public" | "private" | "unknown";
export type MemoryStaleReason = "absent" | "withheld" | "provenance" | "task-private" | "task-privacy-unknown" | "unavailable" | "ambiguous" | "present-path-unverified" | "budget" | "head-changed";
export interface MemoryStaleAnchorRow { id?: string; anchor?: string; state: "stale" | "unknown"; reason: MemoryStaleReason }
export interface MemoryStaleAnchorReport {
  state: "known" | "unknown";
  head?: string;
  rows: MemoryStaleAnchorRow[];
  scanned: number;
  queried: number;
  stale: number;
  /** Null means the source inventory itself was unavailable, not zero unresolved anchors. */
  unknown: number | null;
  truncated: boolean;
  limit: number;
  scanLimit: number;
}
export interface MemoryStaleAnchorOptions {
  cwd: string;
  project: string;
  store: Pick<MemoryStore, "readPage" | "withDeferredPromotions">;
  context(): MemorySymbolContext;
  publicMetadataText(text: string): boolean;
  head(): string | undefined;
  assertCurrent?(): void;
  taskPrivacy?(key: string): MemoryTaskPrivacy;
  exists(repo: string, head: string, name: string): Promise<CodeFactResult<{ exists: boolean; ambiguous: boolean }>>;
  now?: () => number;
  /** Owned query teardown finishes before the final policy/HEAD projection. */
  finishQueries?(): Promise<void>;
}
export function unavailableMemoryStaleAnchors(): MemoryStaleAnchorReport {
  return { state: "unknown", rows: [], scanned: 0, queried: 0, stale: 0, unknown: null, truncated: false, limit: MEMORY_SYMBOL_LIMIT, scanLimit: MEMORY_STALE_SCAN_LIMIT };
}
/** Parse only the package's exact reset-safe identity; legacy ids never establish current task privacy. */
export function memoryAnchorTaskIdentity(key: string, project: string): { id: number; created: number; legacy: string } | undefined {
  if (!key.startsWith(`${project}#`)) return;
  const match = /^([1-9][0-9]*)@([1-9][0-9]*)$/.exec(key.slice(project.length + 1));
  if (!match) return;
  const id = Number(match[1]), created = Number(match[2]);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(created) || taskKey(project, { id, created }) !== key) return;
  return { id, created, legacy: `${project}#${id}` };
}
// Structural task ids/timestamps are host metadata; arbitrary text and symbol/path digits stay screened unchanged.
const taskNamespace = (key: string): string => key.replace(/#[0-9]+(?:@[0-9]+)?$/, "");
const literalNote = (note: View): string => [note.title ?? "", note.text, taskNamespace(note.task ?? ""), note.project,
  ...note.about.map(node => node.startsWith("task:") ? taskNamespace(node) : node)].join("\n");
function privacy(note: View, options: MemoryStaleAnchorOptions): MemoryStaleReason | undefined {
  try {
    options.assertCurrent?.();
    if (note.about.length > NODE_SCAN_LIMIT) return "unavailable";
    if (note.project !== options.project || !ID.test(note.id) || note.title?.startsWith(ASK_NOTE_TITLE)) return "provenance";
    const raw = literalNote(note);
    if (looksSecret(raw) || !options.publicMetadataText(raw)) return "withheld";
    let ownLegacy: string | undefined;
    if (note.task) {
      const identity = memoryAnchorTaskIdentity(note.task, options.project);
      if (!identity) return "task-privacy-unknown";
      const state = options.taskPrivacy?.(note.task) ?? "unknown";
      if (state !== "public") return state === "private" ? "task-private" : "task-privacy-unknown";
      ownLegacy = identity.legacy;
    }
    for (const task of new Set(note.about.filter(node => node.startsWith("task:")).map(node => node.slice(5)))) {
      if (task === note.task || task === ownLegacy) continue;
      if (!memoryAnchorTaskIdentity(task, options.project)) return "task-privacy-unknown";
      const state = options.taskPrivacy?.(task) ?? "unknown";
      if (state !== "public") return state === "private" ? "task-private" : "task-privacy-unknown";
    }
  } catch { return "unavailable"; }
}

/** A read-only derived report. The deadline bounds query starts; the existing core refresh/CodeFacts preparation bounds still apply. */
export async function memoryStaleAnchors(options: MemoryStaleAnchorOptions): Promise<MemoryStaleAnchorReport> {
  const report = unavailableMemoryStaleAnchors(), now = options.now ?? performance.now.bind(performance), deadline = now() + MEMORY_SYMBOL_START_BUDGET_MS;
  const candidates: Array<{ note: View; raw: string }> = [];
  const identities = new Map<MemoryStaleAnchorRow, string>();
  let after: { position: number; id: string } | undefined;
  try {
    options.assertCurrent?.();
    const head = options.head(); if (head && SHA.test(head)) report.head = head;
    for (let page = 0; page < MEMORY_STALE_SCAN_LIMIT / PAGE; page++) {
      if (now() >= deadline) { report.truncated = true; break; }
      options.assertCurrent?.();
      const result = options.store.withDeferredPromotions(() => options.store.readPage({ project: options.project, limit: PAGE, ...(after ? { after } : {}) }));
      report.scanned += result.rows.length;
      for (const note of result.rows) {
        if (note.about.length > NODE_SCAN_LIMIT) report.truncated = true;
        for (const raw of note.about.slice(0, NODE_SCAN_LIMIT)) {
          if (!raw.startsWith("symbol:") || candidates.some(candidate => candidate.note.id === note.id && candidate.raw === raw)) continue;
          if (candidates.length >= MEMORY_SYMBOL_LIMIT) { report.truncated = true; break; }
          candidates.push({ note, raw });
        }
      }
      if (!result.next) { after = undefined; break; }
      after = result.next;
      if (page === MEMORY_STALE_SCAN_LIMIT / PAGE - 1) {
        const more = options.store.withDeferredPromotions(() => options.store.readPage({ project: options.project, limit: 1, after }));
        report.truncated ||= more.rows.length > 0 || more.next !== undefined;
      }
    }
    report.unknown = 0;
    for (const candidate of candidates) {
      if (now() >= deadline) { report.rows.push({ state: "unknown", reason: "budget" }); report.truncated = true; continue; }
      const hidden = privacy(candidate.note, options);
      if (hidden) { report.rows.push({ state: "unknown", reason: hidden }); continue; }
      const context = options.context();
      const anchor = context.project === options.project && context.cwd === options.cwd ? canonicalMemorySymbolNode(candidate.raw, context) : undefined;
      if (!anchor) { report.rows.push({ state: "unknown", reason: "withheld" }); continue; }
      const row: MemoryStaleAnchorRow = { id: candidate.note.id, anchor, state: "unknown", reason: "unavailable" };
      report.rows.push(row); identities.set(row, context.repo);
      if (!report.head) continue;
      if (now() >= deadline) { row.reason = "budget"; report.truncated = true; continue; }
      if (options.head() !== report.head) { row.reason = "head-changed"; continue; }
      try {
        options.assertCurrent?.(); report.queried++;
        const answer = await options.exists(options.cwd, report.head, anchor.slice(7, anchor.lastIndexOf("@")));
        const withheld = privacy(candidate.note, options);
        const current = options.context();
        if (withheld || current.project !== options.project || current.cwd !== options.cwd || current.repo !== context.repo || canonicalMemorySymbolNode(candidate.raw, current) !== anchor) { delete row.id; delete row.anchor; row.reason = withheld ?? "withheld"; continue; }
        if (options.head() !== report.head) { row.reason = "head-changed"; continue; }
        if (answer.state !== "known") continue;
        if (answer.value.ambiguous === true) row.reason = "ambiguous";
        else if (answer.value.exists === false && answer.value.ambiguous === false) { row.state = "stale"; row.reason = "absent"; }
        else if (answer.value.exists === true && answer.value.ambiguous === false) row.reason = "present-path-unverified"; // exists() does not attest the defining file, so this anchor is not proven present.
      } catch { row.reason = "unavailable"; }
    }
    await options.finishQueries?.();
    options.assertCurrent?.();
    if (report.head && options.head() !== report.head) for (const row of report.rows) { row.state = "unknown"; row.reason = "head-changed"; }
    // Policy and current-task privacy may change during another anchor's awaited query.
    for (let index = 0; index < candidates.length; index++) {
      const row = report.rows[index], candidate = candidates[index]; if (!row || !candidate) continue;
      const hidden = privacy(candidate.note, options), current = options.context();
      const changed = row.anchor !== undefined && (current.project !== options.project || current.cwd !== options.cwd || current.repo !== identities.get(row) || canonicalMemorySymbolNode(candidate.raw, current) !== row.anchor);
      if (hidden || changed) { delete row.id; delete row.anchor; row.state = "unknown"; row.reason = hidden ?? "withheld"; }
    }
    report.stale = report.rows.filter(row => row.state === "stale").length;
    report.unknown = report.rows.length - report.stale;
    report.state = report.unknown || report.truncated || !report.head ? "unknown" : "known";
    return report;
  } catch { return { ...unavailableMemoryStaleAnchors(), scanned: report.scanned, queried: report.queried, truncated: report.truncated }; }
}

export function formatMemoryStaleAnchors(report: MemoryStaleAnchorReport): string {
  return [`stale anchors: ${report.stale}; unknown: ${report.unknown ?? "unknown"}; coverage: ${report.state}${report.truncated ? " (truncated)" : ""}`,
    `scope: ${report.head ?? "HEAD unavailable"}; scanned ${report.scanned}/${report.scanLimit}; queried ${report.queried}/${report.limit}`,
    ...report.rows.map(row => `${row.id ? `mem:${row.id} ` : ""}${row.anchor ? `${row.anchor} ` : ""}${row.state} (${row.reason})`),
    "review only; no memory entries or candidate records changed"].join("\n");
}
