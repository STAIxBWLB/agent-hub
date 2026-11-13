/**
 * #1054 T6: the acon inbox side of a result: a run a person started that settled and has not been seen. Pure: it builds the inbox item from the row the hub reports and checks the
 * person evidence a receipt needs; `plugin.ts` owns the transport. No text here is logged.
 *
 * Publication: an item is published only to a console that advertises BOTH `inbox.result` (it renders the group) and `action.meta` (a receipt then has person evidence). One alone,
 * or neither, and results stay in the ahub panel, `ahub console`, `ahub status` and `ahub results`: nothing is published that the console could not render or that the person
 * could not mark read with evidence.
 *
 * Authority: `result_seen`, `results_read_all` and `results_unread_last` are accepted only when the console advertises `action.meta` and `action()` received the console's own
 * `meta` (`via: "console"`, a verified `identity`), which the page cannot set (agent-console `action(input, meta?)`). They never go through the dashboard's forwarding list. The
 * acon "seeing" rule (a focused, visible window, the result's end in view for a second, the latest edge) is agent-console#27 and is not decided here: this only accepts the receipt.
 * Mark unread is NOT an inbox verb: a read item leaves the inbox, so mark-unread lives in the ahub panel (this plugin's dashboard) and in `ahub results --unread-last`.
 */

import type { ActionMeta } from "@staix/agent-console/contract";

export type { ActionMeta };
export type ResultOutcome = "done" | "failed" | "limit" | "interrupted";
/** The detail the hub built at display (`completion-detail.ts`): a head of the request, a stub, or nothing. */
export type ResultDetailView = { kind: "head" | "stub"; text: string } | { kind: "none" };
/** One row of the hub's `results` snapshot field. */
export interface ResultRowView {
  id: string; peer: string; outcome: ResultOutcome; settledAt: number; ms?: number; private?: boolean; title?: string; detail?: ResultDetailView;
}
export interface ResultItem {
  id: string; group: "result"; kind: "result"; title: string; detail?: string; actor: string; project: string; at: string; chip: { text: string; tone: "ok" | "warn" | "err" | "neutral" };
  verbs: { id: string; label: string; primary?: boolean }[];
  link: { panel: string; params: Record<string, string> };
  seen: { action: "result_seen" };
}

/**
 * The receipt actions this plugin advertises (so acon lets the page and the inbox send them), and answers itself with the console's person meta: never in the dashboard's forwarding
 * list. `result_seen` and `results_read_all` come from the inbox (acon's seeing rule and its "Mark all read") and from the panel; `results_unread_last` only from the panel, because a
 * read item has left the inbox: there is no inbox verb for it. All three are the person's writes, so all three need the same evidence.
 */
export const RESULT_ACTIONS = ["result_seen", "results_read_all", "results_unread_last"] as const;
export type ResultAction = (typeof RESULT_ACTIONS)[number];

/** Both features are needed. One alone is not enough: no group to render, or no person evidence for the receipt. */
export const canPublishResults = (features: readonly string[] | undefined): boolean => !!features?.includes("inbox.result") && features.includes("action.meta");

export const resultItemId = (project: string, id: string) => `result:${project}:${id}`;
export const RESULT_ITEM = /^result:([^:]+):(cmp-[a-f0-9]{12})$/;
const OUTCOME_WORD: Record<ResultOutcome, string> = { done: "finished", failed: "failed", limit: "stopped at a limit", interrupted: "interrupted" };
const CHIP: Record<ResultOutcome, { text: string; tone: "ok" | "warn" | "err" | "neutral" }> = {
  done: { text: "done", tone: "ok" }, failed: { text: "failed", tone: "err" }, limit: { text: "limit", tone: "warn" }, interrupted: { text: "interrupted", tone: "warn" },
};
const flat = (text: string, max: number) => Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim()).slice(0, max).join("");

/**
 * The inbox item. The title is `<peer>: <outcome word>`, computed here from the row's peer and outcome and never taken from the row's own title text; a private result is a stub
 * (`<peer>: a private result`) with no detail. The detail is whatever the hub built at display, or none: this never reads a prompt itself. `at` is the settle time, stable
 * across snapshots, which is what acon's snooze and oldest-first order key on.
 */
export function resultItem(row: ResultRowView, project: { id: string; name: string }): ResultItem {
  const outcome: ResultOutcome = row.outcome in OUTCOME_WORD ? row.outcome : "interrupted";
  const title = (row.private ? `${row.peer}: a private result` : `${row.peer}: ${OUTCOME_WORD[outcome]}`).slice(0, 200);
  const detail = !row.private && row.detail && row.detail.kind !== "none" && typeof row.detail.text === "string" ? flat(row.detail.text, 200) : row.private ? "a private request" : "";
  return {
    id: resultItemId(project.id, row.id), group: "result", kind: "result", title, ...(detail ? { detail } : {}), actor: row.peer, project: project.name,
    at: new Date(row.settledAt).toISOString(), chip: CHIP[outcome], verbs: [{ id: "open", label: "Open Agents", primary: true }],
    link: { panel: "agents", params: { project: project.id } }, seen: { action: "result_seen" },
  };
}

const REFUSAL = "Marking a result read needs a console with verified person identity; update acon and reopen this panel, or use ahub results.";
/**
 * The console's evidence, or the refusal that tells the person how to get it. Page-supplied fields that would stand in for the person (`author`, `meta`, `identity`, `surface`) or
 * name a completion by another key are refused too. `projectId` is allowed: the panel names the project it is showing, as every dashboard action does, and it only picks WHICH running
 * project's receipt this is; the daemon instance is never taken from the page (`receiptVerb` resolves it from the running listing), and the person evidence is the console's alone.
 */
export function receiptEvidence(features: readonly string[] | undefined, meta: ActionMeta | undefined, input: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (!features?.includes("action.meta") || !meta || typeof meta !== "object") return { ok: false, error: REFUSAL };
  const value = meta as unknown as Record<string, unknown>;
  if (value.via !== "console" || typeof value.identity !== "string" || !value.identity.trim() || typeof value.node !== "string" || !value.node.trim()) return { ok: false, error: REFUSAL };
  // `seenAt` and `explicit` are acon's own (the shell sends them with the seeing rule): the hub stamps its own time, so they are accepted and ignored, never trusted.
  if (["author", "meta", "personMeta", "person", "identity", "surface", "completion", "completionId", "seen"].some(key => Object.hasOwn(input, key)))
    return { ok: false, error: "The person's identity and the target come from the console; remove those fields and retry." };
  return { ok: true };
}
