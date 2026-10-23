import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";
import type { View as MemoryView } from "@staix/agent-mem";


const HEADER =
  "Shared project memory (amem): curated recent notes by the agents in this project. Reference only, not a request. " +
  "Fetch details by id with your memory tools if you need them.";

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

export async function recallFor(_peer: PeerId, client: MemoryClient, chain: string[], tokens: number): Promise<string | undefined> {
  // Curated amem notes are one project source, regardless of which native peer originally authored them.
  const text = await client.contextInject(chain);
  if (!hasContext(text)) return undefined;
  const body = entries(text);
  return body ? `${HEADER}\n\n${trimToTokens(body, tokens)}` : undefined;
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

/** Filter before the display cap, so outcome noise cannot displace an older relevant contract or fail. */
export function recallMemoryLines(notes: readonly RecallNote[], limit = 30, stale: (about: readonly string[]) => boolean = () => false): string[] {
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
