// #711 / #380: the console's review guidance. Pure strings and decisions, no terminal code and no state import: console-state.ts renders them.
// Nothing here changes authority: the console runs `ahub review` as the person, and the hub decides.

export type Verdict = "approved" | "changes_requested";
/** The task a review choice was opened for, taken from the selected row or the open detail. */
export interface ReviewChoice { id: number; title: string; reviewerIsUser: boolean }

const MAX_TITLE = 40;
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
/** The title as the choice line shows it: quoted, one line, cut to the width; a private task is `[pii]`. */
export function choiceTitle(row: { title?: unknown; signals?: unknown }): string {
  const priv = (Array.isArray(row.signals) && row.signals.some(s => s === "pii" || s === "pii_path")) || row.title === "[pii]";
  if (priv) return "[pii]";
  const text = clean(String(row.title ?? ""));
  return JSON.stringify(text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 3)}...` : text);
}

/** The choice for a task row, or undefined when it is not one the person can review (not in review). */
export function reviewChoiceFor(row: any): ReviewChoice | undefined {
  if (!row || row.state !== "in_review" || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) return undefined;
  return { id: Number(row.id), title: choiceTitle(row), reviewerIsUser: row.reviewer === "user" };
}

/** The prompt line while the choice is open (#711 change 1). The title is already quoted. */
export const choicePrompt = (c: ReviewChoice): string => `review #${c.id} ${c.title}: a approve  c request changes  Esc cancel`;
/** What `a` and `c` prefill on the input line. The trailing space is where the note goes. */
export const verdictInput = (id: number, verdict: Verdict): string => `review ${id} ${verdict} `;
/** The guide line shown above the input after a choice (#711 change 1). */
export const verdictGuide = (id: number, verdict: Verdict): string =>
  verdict === "approved" ? `Enter approves #${id}. You can type a note first. Esc cancels.` : "Say what to fix, then Enter. Esc cancels.";

/** The footer hint for a task in review (#711 change 2): the verb, and whose review it is when it is the person's. */
export const reviewHint = (reviewer: unknown): string => reviewer === "user" ? "your review: r approve or request changes" : "r approve or request changes";

/**
 * A `review <id> <verdict> [note]` line the person typed, checked before it is sent: a changes request must say what to fix (#711 change 1). Returns the refusal,
 * or undefined when the line is fine or is not a review line at all (other commands are validated where they always were).
 */
export function reviewRefusal(args: readonly string[]): string | undefined {
  if (args[0] !== "review") return undefined;
  const verdict = args[2];
  if (verdict !== "changes_requested") return undefined;
  const note = args.slice(3).filter(word => !word.startsWith("--")).join(" ").trim();
  return note ? undefined : "say what to fix before requesting changes";
}

/** The notice after a review command finished: `#372 approved`, `#372 changes requested`, or the CLI's own refusal verbatim (#711 change 3). */
export function reviewResult(args: readonly string[], code: number, diagnostic: string): { text: string; tone: "success" | "failure" } | undefined {
  if (args[0] !== "review" || !/^\d+$/.test(args[1] ?? "")) return undefined;
  const verdict = args[2];
  if (verdict !== "approved" && verdict !== "changes_requested") return undefined;
  if (code) return { text: clean(diagnostic) || `command exited ${code}`, tone: "failure" };
  return { text: `#${args[1]} ${verdict === "approved" ? "approved" : "changes requested"}`, tone: "success" };
}
