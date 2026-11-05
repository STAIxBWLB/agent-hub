/**
 * #1054 T6: the detail line of a result, built at DISPLAY and never stored. A completion row keeps envelope ids only (`completions-store.ts`), so the head of the
 * starting prompt is read from the envelope the bus still holds when the person looks, run through the hub's own screens, and thrown away after it is shown. Nothing here
 * writes, logs or emits an event.
 *
 * Pure: the daemon passes the facts (the envelope it could resolve, whether the run was private, whether the text passed the hub's screens) and this decides what shows.
 * A result with no readable envelope (the bus cache turned over, or the hub restarted) shows no detail: an honest absence, never a guess.
 */

/** The longest head of a prompt that is shown: one short line, enough to recognise the request. */
export const PROMPT_HEAD_MAX = 120;

/** What a detail line is, so a test and the page can tell a stub from a head from an absence. */
export type ResultDetail =
  | { kind: "head"; text: string }
  | { kind: "stub"; text: string }
  | { kind: "none" };

export const PRIVATE_DETAIL = "a private request";
export const WITHHELD_DETAIL = "request withheld by the privacy screen";

/**
 * The head of a prompt as one line: whitespace and control characters collapsed, cut by code point (half an emoji is invalid text), with an ellipsis when it was cut.
 * A hub header forged in the body is quoted by `sanitize` at the caller, not here: this only shapes text.
 */
export function promptHead(body: string, max: number = PROMPT_HEAD_MAX): string {
  const flat = body.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}\u2026` : flat;
}

export interface DetailInput {
  /** The run was private (a PII turn, or the peer held PII): its prompt is never shown. */
  private: boolean;
  /** The starting prompt's envelope body, when the bus could still resolve it. Absent: no detail. */
  body?: string;
  /** The hub's own screens (`boundedSafe`: secrets, PII patterns, private paths) cleared the head. Only asked for a non-private run with a body. */
  safe?: (text: string) => boolean;
}

/** private -> stub (the body is never read); no body -> none; a head the screens refuse -> withheld stub; else the head. */
export function resultDetail(input: DetailInput): ResultDetail {
  if (input.private) return { kind: "stub", text: PRIVATE_DETAIL };
  if (input.body === undefined) return { kind: "none" };
  const head = promptHead(input.body);
  if (!head) return { kind: "none" };
  // Screen the whole bounded head, not a prefix of it: a pattern cut in half by the bound must not slip through as two harmless halves.
  if (!input.safe || !input.safe(head) || !input.safe(input.body.slice(0, 4000))) return { kind: "stub", text: WITHHELD_DETAIL };
  return { kind: "head", text: head };
}
