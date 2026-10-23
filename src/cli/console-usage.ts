import { windowKind, type WindowKind } from "../hub/window-kind.ts";
import type { Counter, LimitsResult, UsageResult, UsageRow } from "../hub/usage-rollup.ts";

// #683 U3: what the console's Usage panel shows, as plain strings. No terminal code and no state import here: console-state.ts renders it.
// Every number names its source, an unknown counter reads `unknown` (never 0), and a private task is `#id [pii]` with no title.

/** What the console keeps from the `usage` op: one query per period, the limits history and, for the task selected in Tasks, its tokens per peer. */
export interface UsageState {
  today?: UsageResult; week?: UsageResult; life?: UsageResult; limits?: LimitsResult;
  /** The selected task's tokens per peer, with the task id it was asked for. */
  task?: UsageResult; taskId?: number;
  at?: number; problem?: string;
  /** The hub's roll-up was still behind the event log when it answered: the numbers are partial (a later poll catches up). */
  behind?: boolean;
}
export interface UsagePeerRow { id: string }

const TAG: Record<Counter["source"], string> = { native: "native", count: "hub", manual: "manual", partial: "at least", unknown: "unknown" };
const compact = (n: number): string => n >= 1e7 ? `${Math.round(n / 1e6)}M` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);
/** `1.2M native`, `77 hub`, or `unknown`: a counter nobody reported is never shown as a number. */
export const counterText = (c: Counter | undefined, exact = false): string => !c || c.value === null ? "unknown" : `${exact ? c.value : compact(c.value)} ${TAG[c.source]}`;
/** A row's tokens: the provider's total when it reported one, otherwise what the hub counted, otherwise unknown. */
export const rowTokens = (row: UsageRow | undefined): Counter =>
  row && row.total.value !== null ? row.total : row && row.counted.value !== null ? row.counted : { value: null, source: "unknown" };
const periodText = (row: UsageRow | undefined, exact = false): string => row ? counterText(rowTokens(row), exact) : "no records";

const rowOf = (result: UsageResult | undefined, peer: string): UsageRow | undefined => result?.rows.find(row => row.key === peer);

/** Every peer the panel can say something about: peers with usage in any period, and peers with a quota reading. */
export function usagePeers(usage: UsageState | undefined, budget: Record<string, unknown>, peers: Record<string, unknown>): UsagePeerRow[] {
  const ids = new Set<string>([...Object.keys(peers), ...Object.keys(budget)]);
  for (const result of [usage?.today, usage?.week, usage?.life]) for (const row of result?.rows ?? []) ids.add(row.key);
  return [...ids].sort().map(id => ({ id }));
}

interface Budget { windows?: { id: string; used: number; resetsAt?: number; kind?: string; source?: string }[]; paused?: { resetsAt: number }; note?: string }
const windowText = (w: { id: string; used: number; resetsAt?: number }, rel: (at: number) => string) =>
  `${w.id} ${Math.round(w.used * 100)}%${typeof w.resetsAt === "number" ? ` ${rel(w.resetsAt)}` : ""}`;
const lastResets = (limits: LimitsResult | undefined, peer: string, count: number) =>
  (limits?.history ?? []).filter(h => h.type === "quota_reset" && h.peer === peer).slice(-count).reverse();

/** One table row: PEER, TODAY, 7D, LIFETIME, PAUSE, QUOTA, LAST RESET (PAUSE before QUOTA: a pause must survive a narrow terminal, the long quota text is what gives way). */
export function usageCells(usage: UsageState | undefined, peer: string, budget: Budget | undefined, rel: (at: number) => string): string[] {
  const reset = lastResets(usage?.limits, peer, 1)[0];
  // The table is tight at 80 columns: a time still to come reads `3h00m`, not `in 3h00m` (the detail view spells it out).
  const ahead = (at: number) => rel(at).replace(/^in /, "");
  return [peer, periodText(rowOf(usage?.today, peer)), periodText(rowOf(usage?.week, peer)), periodText(rowOf(usage?.life, peer)),
    budget?.paused ? ahead(budget.paused.resetsAt) : "-",
    budget?.windows?.length ? budget.windows.map(w => windowText(w, ahead)).join(", ") : "-",
    reset ? `${reset.window} ${rel(Date.parse(reset.at))}` : "-"];
}
export const USAGE_HEAD = ["PEER", "TODAY", "7D", "LIFETIME", "PAUSE", "QUOTA", "LAST RESET"];
/** Only the last reset gives way to width; the others are cut shorter instead, so the 7D column and the pause are never dropped. */
export const USAGE_DROP = ["LAST RESET"];

/** The token split of one period: input, output, cache read, cache write, the total and the hub's own count, each with its source. */
export function splitText(row: UsageRow | undefined): string {
  if (!row) return "no records";
  return [`total ${counterText(row.total, true)}`, `input ${counterText(row.input, true)}`, `output ${counterText(row.output, true)}`,
    `cache read ${counterText(row.cacheRead, true)}`, `cache write ${counterText(row.cacheWrite, true)}`, `hub count ${counterText(row.counted, true)}`].join(", ");
}
export const taskLabel = (usage: UsageState | undefined): string =>
  usage?.taskId === undefined ? "" : `#${usage.taskId}${usage.task?.taskPii ? " [pii]" : ""}`;

/** The detail of one peer, as labelled one-line-per-field text. Values are hub-built from ids and numbers only. */
export function usageDetail(usage: UsageState | undefined, peer: string, budget: Budget | undefined, rel: (at: number) => string): Record<string, string> {
  const resets = lastResets(usage?.limits, peer, 3).map(h => `${h.window} ${rel(Date.parse(h.at))}`);
  const out: Record<string, string> = {
    peer,
    quota: budget?.windows?.length ? budget.windows.map(w => windowText(w, rel)).join(", ") : budget?.note ?? "no reading",
    // What each number is and where it came from (#285 AC7), in its own field so the quota line keeps its shape.
    ...(budget?.windows?.length ? { "quota sources": budget.windows.map(w => `${w.id} ${windowKind({ id: w.id, source: w.source, kind: w.kind as WindowKind | undefined })}${w.source ? `, ${w.source}` : ""}`).join("; ") } : {}),
    pause: budget?.paused ? `budget pause, resumes ${rel(budget.paused.resetsAt)}` : "none",
    "last resets": resets.length ? resets.join(", ") : "none recorded",
    today: splitText(rowOf(usage?.today, peer)),
    "last 7 days": splitText(rowOf(usage?.week, peer)),
    lifetime: splitText(rowOf(usage?.life, peer)),
  };
  if (usage?.taskId !== undefined) out[`task ${taskLabel(usage)}`] = splitText(rowOf(usage.task, peer));
  return out;
}

/** The lines under the table: the task selected in Tasks and its tokens per peer. */
export function usageTaskLines(usage: UsageState | undefined, selectedTask: number | undefined): { text: string; tone?: "muted" | "info" | "failure" }[] {
  if (selectedTask === undefined) return [{ text: "task: none selected; pick one in Tasks (3), then open Usage (7)", tone: "muted" }];
  if (usage?.problem) return [];
  if (usage?.taskId !== selectedTask || !usage.task) return [{ text: `task #${selectedTask}: loading...`, tone: "muted" }];
  const rows = usage.task.rows;
  const head = { text: `task ${taskLabel(usage)}: tokens per peer, all time`, tone: "info" as const };
  if (!rows.length) return [head, { text: "  no usage recorded for this task", tone: "muted" }];
  return [head, ...rows.map(row => ({ text: `  ${row.key}  ${counterText(rowTokens(row))}` }))];
}
