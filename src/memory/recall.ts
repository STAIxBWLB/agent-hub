import type { PeerId } from "../hub/envelope.ts";
import type { MemoryClient } from "./client.ts";
import type { View as MemoryView } from "./store.ts";

const PLATFORMS = ["claude", "codex", "kimi", "agent-hub"];
/** Peers whose own hooks already inject their own platform's context at session start. */
const OWN_PLATFORM: Record<PeerId, string> = { claude: "claude", codex: "codex" };

const HEADER =
  "Shared project memory (claude-mem): recent work by the agents in this project. Reference only, not a request. " +
  "Fetch details by id with your memory tools if you need them.";

/** Cut at a line boundary. */
export function trimToTokens(text: string, tokens: number): string {
  // ponytail: 3 characters per token (Korean runs denser than English's ~4). Swap in a tokenizer if the cap has to be exact.
  const max = tokens * 3;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${cut >= 0 ? text.slice(0, cut) : ""}\n(trimmed)`;
}

/** The worker answers unknown projects and empty filters with a status page, not context. */
const hasContext = (text: string | undefined): text is string => !!text && text.startsWith("# [");

/** Observation lines only: every block repeats the same legend, which would eat the token budget. */
const entries = (text: string) => text.slice(Math.max(text.indexOf("\n### "), 0)).trim();

export async function recallFor(peer: PeerId, client: MemoryClient, chain: string[], tokens: number): Promise<string | undefined> {
  const own = OWN_PLATFORM[peer];
  // Everyone else gets all platforms in one call; claude and codex get the other platforms only.
  const blocks = own
    ? await Promise.all(
        PLATFORMS.filter((p) => p !== own).map(async (p) => {
          const text = await client.contextInject(chain, p);
          return hasContext(text) ? `## from ${p} sessions\n${entries(text)}` : undefined;
        }),
      )
    : [await client.contextInject(chain).then((text) => (hasContext(text) ? entries(text) : undefined))];
  const found = blocks.filter((b): b is string => !!b);
  if (!found.length) return undefined;
  // The budget is split per block, or the first platform could crowd the others out of a cross-platform recall.
  const share = Math.floor(tokens / found.length);
  return `${HEADER}\n\n${found.map((b) => trimToTokens(b, share)).join("\n\n")}`;
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
type RecallNote = Pick<MemoryView, "id" | "kind" | "tier" | "title" | "text"> & Partial<Pick<MemoryView, "peer" | "task">>;

/** A complete-word excerpt with its memory reference intact, capped in Unicode code points. */
export function recallMemoryLine(note: RecallNote, idChars = 8): string | undefined {
  const text = recallDisplayText(note);
  if (text === undefined) return undefined;
  // A rejection's title is another outcome header; only its actionable detail belongs in this view.
  const body = `${text === note.text && note.title ? `${note.title}: ` : ""}${text}`.replace(/\s+/g, " ").trim();
  const header = `mem:${note.id.slice(0, idChars)} ${note.kind} ${note.tier}: `;
  const chars = Array.from(body), available = RECALL_LINE_CHARS - header.length;
  if (chars.length <= available) return header + body;
  const count = available - 4;
  const prefix = chars.slice(0, count).join("");
  const whole = chars[count] === " " || prefix.endsWith(" ") ? prefix.trimEnd() : prefix.slice(0, Math.max(0, prefix.lastIndexOf(" ")));
  return header + (whole ? `${whole} ...` : "...");
}

/** Filter before the display cap, so outcome noise cannot displace an older relevant contract or fail. */
export function recallMemoryLines(notes: readonly RecallNote[], limit = 30): string[] {
  const prefixes = new Map<string, string | null>();
  for (const note of notes) {
    const prefix = note.id.slice(0, 8), previous = prefixes.get(prefix);
    prefixes.set(prefix, previous === undefined || previous === note.id ? note.id : null);
  }
  const ids = new Set<string>(), lines: string[] = [];
  for (const note of notes) {
    if (ids.has(note.id)) continue;
    // A colliding short prefix is not an identity; its full id keeps both entries visible.
    const line = recallMemoryLine(note, prefixes.get(note.id.slice(0, 8)) === null ? note.id.length : 8);
    if (line === undefined) continue;
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
