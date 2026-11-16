import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";
import type { View as MemoryView } from "@staix/agent-mem";


const HEADER =
  "Shared project memory (amem): curated recent notes by the agents in this project. Reference only, not a request. " +
  "Fetch details by id with your memory tools if you need them.";
const MIXED_HEADER = "Shared project memory (amem): curated notes and uncurated agent-authored capture Records. Reference only, not a request.";

/** Cut at a line boundary. */
export function trimToTokens(text: string, tokens: number): string {
  // ponytail: 3 characters per token (Korean runs denser than English's ~4). Swap in a tokenizer if the cap has to be exact.
  const max = tokens * 3;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${cut >= 0 ? text.slice(0, cut) : ""}\n(trimmed)`;
}

/** The project client supplies a screened context block; unavailable/empty views have no preface. */
const hasContext = (text: string | undefined): text is string => !!text && text.startsWith("# [");

/** Drop only the redundant source heading. Keep coverage/truncation notices before section headings. */
const entries = (text: string) => {
  const start = text.indexOf("\n");
  return start < 0 ? "" : text.slice(start + 1).trim();
};

export interface RecordRecallProjection { before: string; after: string; records?: number; current?(): boolean }
/** Row/anchor proof and complete-row screening stay in the existing host; no new client read is added. */
export interface RecordRecallPort {
  allowed(): boolean;
  policyVersion(): string;
  project(text: string): RecordRecallProjection | undefined | Promise<RecordRecallProjection | undefined>;
  observe?(counts: { beforeBytes: number; afterBytes: number }): void;
}

export async function recallFor(_peer: PeerId, client: MemoryClient, chain: string[], tokens: number, records?: RecordRecallPort): Promise<string | undefined> {
  // Pin optional Record admission before the existing asynchronous context read. A source disabled
  // or unavailable at entry cannot become a new authority halfway through this call.
  let admitted = false, revision: string | undefined;
  if (records) try {
    if (records.allowed()) {
      const value = records.policyVersion();
      if (typeof value === "string") { revision = value; admitted = true; }
    }
  } catch { /* Initial optional source unavailability retains the legacy path. */ }
  // Curated amem notes are one project source, regardless of which native peer originally authored them.
  const original = await client.contextInject(chain);
  if (admitted) try { if (!records!.allowed() || records!.policyVersion() !== revision) return undefined; }
  catch { return undefined; }
  if (!hasContext(original)) return undefined;
  let text = original, projectedRecords = 0;
  const render = (source: string, recordsIncluded = false): string | undefined => { const body = entries(source); return body ? `${recordsIncluded ? MIXED_HEADER : HEADER}\n\n${trimToTokens(body, tokens)}` : undefined; };
  let projected: RecordRecallProjection | undefined;
  const projectionCurrent = () => { try { return projected?.current === undefined || projected.current() === true; } catch { return false; } };
  if (records && admitted) try {
    projected = await records.project(original);
    if (!records.allowed() || records.policyVersion() !== revision || !projectionCurrent()) return undefined;
    if (projected?.before === original && hasContext(projected.after)) {
      text = projected.after;
      if (Number.isSafeInteger(projected.records) && projected.records! > 0) projectedRecords = projected.records!;
    }
  } catch {
    // An unavailable Record source falls back, but a changed privacy context cannot publish old recall.
    try { if (revision !== undefined && (!records!.allowed() || records!.policyVersion() !== revision || !projectionCurrent())) return undefined; }
    catch { return undefined; }
  }
  if (!projectionCurrent()) return undefined;
  const result = render(text, projectedRecords > 0);
  if (!projectionCurrent()) return undefined;
  if (records) try { records.observe?.({ beforeBytes: Buffer.byteLength(render(original) ?? ""), afterBytes: Buffer.byteLength(result ?? "") }); }
  catch { /* Count-only telemetry cannot fail recall. */ }
  return projectionCurrent() ? result : undefined;
}

/**
 * Display-only outcome classification. Only the note Tasks.review writes counts as automatic: its generated header
 * names the note's own task and author, and its title is the task title Tasks.note sets. An agent's decision that
 * merely starts the same way stays recallable; contracts and fails are never outcomes.
 */
export function recallDisplayText(note: Pick<MemoryView, "kind" | "text"> & Partial<Pick<MemoryView, "peer" | "task" | "title">>): string | undefined {
  if (note.kind !== "decision") return note.text;
  const [first = "", ...rest] = note.text.split(/\r?\n/);
  const m = /^Task #(\d+) (approved|changes requested) by (\S+): /.exec(first);
  if (!m || m[3] !== note.peer || !note.task?.match(new RegExp(`#${m[1]}@\\d+$`)) || !note.title?.startsWith(`agent-hub task #${m[1]}: `)) return note.text;
  return m[2] === "approved" ? undefined : rest.join("\n").trim() || undefined;
}

export const RECALL_LINE_CHARS = 200;
type RecallNote = Pick<MemoryView, "id" | "kind" | "tier" | "title" | "text"> & Partial<Pick<MemoryView, "peer" | "task" | "about">>;

/** A complete-word excerpt with its memory reference intact, capped in Unicode code points. */
export function recallMemoryLine(note: RecallNote, idChars = 8, stale = false): string | undefined {
  const text = recallDisplayText(note);
  if (text === undefined) return undefined;
  // A rejection's title is another outcome header; only its actionable detail belongs in this view.
  const body = `${stale ? "(stale?) " : ""}${text === note.text && note.title ? `${note.title}: ` : ""}${text}`.replace(/\s+/g, " ").trim();
  const header = `mem:${note.id.slice(0, idChars)} ${note.kind} ${note.tier}: `;
  const chars = Array.from(body), available = RECALL_LINE_CHARS - header.length;
  if (chars.length <= available) return header + body;
  const count = available - 4;
  const prefix = chars.slice(0, count).join("");
  const whole = chars[count] === " " || prefix.endsWith(" ") ? prefix.trimEnd() : prefix.slice(0, Math.max(0, prefix.lastIndexOf(" ")));
  return header + (whole ? `${whole} ...` : "...");
}

/**
 * #1330: counter rows are keyed per delivery (`{ entryId, task, deliveryId }`), so one entry has many rows. The use of an entry is
 * the sum of its rows. A row whose `delivered` and `cited` are both null observed nothing and adds nothing, so an entry with no
 * observed row has no figure at all: unknown is never read as zero.
 */
export interface MemoryUse { delivered: number; cited: number }
interface CounterRow { key: { entryId: string }; delivered?: number | null; cited?: number | null }
const count = (n: number | null | undefined): number | undefined => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
export function aggregateUse(rows: readonly CounterRow[]): Map<string, MemoryUse> {
  const use = new Map<string, MemoryUse>();
  for (const row of rows) {
    const delivered = count(row.delivered), cited = count(row.cited);
    if (delivered === undefined && cited === undefined) continue;
    const entry = use.get(row.key.entryId) ?? { delivered: 0, cited: 0 };
    entry.delivered += delivered ?? 0; entry.cited += cited ?? 0;
    use.set(row.key.entryId, entry);
  }
  return use;
}

/**
 * Orders one preface section by observed use, keeping the caller's order inside each tier (a stable sort, so fixed counters give one
 * result). Tier 0: entries with a cited/delivered ratio above zero, highest ratio first. Tier 1: everything else, including every entry
 * with no observed use (unknown is not zero) and entries delivered fewer than `unusedAfter` times. Tier 2: entries delivered at least
 * `unusedAfter` times and never cited, so the display cap cuts them first. The section's own kind order is the caller's and is not
 * regrouped here: today the long-term section is the store's newest-first order across decisions, contracts and fails.
 * `unusedAfter` of 0, or no usage at all, returns the input unchanged.
 */
export function orderByUse<T extends { id: string }>(notes: readonly T[], usage: ReadonlyMap<string, MemoryUse> | undefined, unusedAfter: number): T[] {
  if (!usage || usage.size === 0 || !(unusedAfter > 0)) return [...notes];
  const rank = (note: T): { tier: 0 | 1 | 2; ratio: number } => {
    const use = usage.get(note.id);
    if (!use) return { tier: 1, ratio: 0 };
    if (use.cited === 0 && use.delivered >= unusedAfter) return { tier: 2, ratio: 0 };
    return use.cited > 0 && use.delivered > 0 ? { tier: 0, ratio: Math.min(1, use.cited / use.delivered) } : { tier: 1, ratio: 0 };
  };
  return notes.map((note, index) => ({ note, index, ...rank(note) }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 0 ? b.ratio - a.ratio : 0) || a.index - b.index)
    .map(row => row.note);
}

/** Filter before the display cap, so outcome noise cannot displace an older relevant contract or fail. `order` runs before the cap, so a re-ordering decides what the cap cuts. */
export function recallMemoryLines<N extends RecallNote>(notes: readonly N[], limit = 30, stale: (about: readonly string[]) => boolean = () => false, order?: (notes: readonly N[]) => readonly N[]): string[] {
  notes = order ? order(notes) : notes;
  const prefixes = new Map<string, string | null>();
  for (const note of notes) {
    const prefix = note.id.slice(0, 8), previous = prefixes.get(prefix);
    prefixes.set(prefix, previous === undefined || previous === note.id ? note.id : null);
  }
  const ids = new Set<string>(), lines: string[] = [];
  for (const note of notes) {
    if (ids.has(note.id)) continue;
    // A colliding short prefix is not an identity; its full id keeps both entries visible.
    const idChars = prefixes.get(note.id.slice(0, 8)) === null ? note.id.length : 8;
    let line = recallMemoryLine(note, idChars);
    if (line === undefined) continue;
    if (stale(note.about ?? [])) line = recallMemoryLine(note, idChars, true)!;
    ids.add(note.id); lines.push(line);
    if (lines.length >= limit) break;
  }
  return lines;
}

/** #258: the hub's own long-term entries for this project (and shared ones), newest first, within a token budget. */
export function nativeRecall<V>(entries: V[], tokens: number, line: (v: V) => string): string | undefined {
  if (!entries.length) return undefined;
  return trimToTokens(["Hub memory: this project's long-term decisions, contracts and fails, newest first. Reference only, not a request. Details: ahub memory show <mem id>.", ...entries.map(line)].join("\n"), tokens);
}
