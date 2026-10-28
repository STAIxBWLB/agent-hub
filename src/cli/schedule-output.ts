// Human output for `ahub schedule list|run|pause|resume` (#335). Pure: parsed hub JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// Titles and details are task text and never appear here: a schedule is named by its id, period, class and queue.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import { moment } from "./sdlc-output.ts";
import type { Span, Tone } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const TONE: Record<string, Tone | undefined> = { due: "attention", waiting: "attention", held: "attention", paused: "muted", scheduled: undefined };
const WHEN: Record<string, string> = { scheduled: "next", due: "due now", waiting: "due, waiting for its task to close", held: "due, held (the hub is stopping or recovering)", paused: "paused" };

/** The next run, as the person reads it: a paused schedule says so and what it would have been. */
export const nextText = (row: any, now: number): string =>
  row?.state === "paused" ? `paused (would be ${moment(row.next, now)})` : row?.state === "scheduled" ? moment(row.next, now) : WHEN[row?.state] ?? "unknown";

/** `ahub schedule list`: one row per configured schedule with its next run. */
export function renderScheduleList(rows: unknown, columns?: number, now = Date.now()): Span[][] {
  const schedules = list(rows);
  if (!schedules.length) return [[s("no schedules configured; add them under `schedules` in .agenthub/config.local.json", "muted")]];
  const out: Span[][] = [...heading(`Schedules (${schedules.length})`, columns)];
  out.push(...grid(["ID", "EVERY", "CLASS", "QUEUE", "STATE", "NEXT RUN", "LAST RUN", "TASK"], schedules.map((row: any) => [
    s(row.id, "issueRef"), s(row.every), s(row.class), s(row.queue), s(row.state, TONE[row.state]), s(nextText(row, now), TONE[row.state]),
    s(row.last ? moment(row.last, now) : "never", "muted"), s(row.task === undefined ? "-" : `#${row.task}`, "taskRef"),
  ]), columns));
  for (const row of schedules) {
    if (row.coalesced) out.push(blank, ...pair(row.id, `${row.coalesced} due tick${row.coalesced === 1 ? "" : "s"} skipped; one run follows when it can`, columns, 12, "muted"));
    if (row.error) out.push(blank, ...pair(row.id, `last run failed: ${row.error}`, columns, 12, "attention"));
  }
  return out;
}

const RESULT: Record<string, string> = { ran: "ran", held: "not run: the hub is held (stopping or recovering)", waiting: "not run: the task its last run made is still open", failed: "failed" };

/** `ahub schedule run <id>`: what the run did. */
export function renderScheduleRun(result: unknown, columns?: number): Span[][] {
  const r = result as any;
  const out: Span[][] = [...heading(`Schedule ${r?.id ?? "?"}: ${RESULT[r?.outcome] ?? "unknown outcome"}`, columns)];
  if (r?.task !== undefined) out.push(...pair("task", `#${r.task}`, columns, 8, "taskRef"));
  if (r?.reason) out.push(...pair("because", String(r.reason), columns, 8, "attention"));
  if (r?.outcome === "ran") out.push(...pair("next", "its period restarts now", columns, 8, "muted"));
  return out;
}

/** `ahub schedule pause|resume <id>`: the schedule as the hub now holds it. */
export function renderScheduleChange(op: "pause" | "resume", rows: unknown, columns?: number, now = Date.now()): Span[][] {
  const row = list(rows)[0];
  const out: Span[][] = [...heading(`Schedule ${row?.id ?? "?"} ${op === "pause" ? "paused" : "resumed"}`, columns)];
  if (row) out.push(...pair("state", row.state, columns, 8, TONE[row.state]), ...pair("next run", nextText(row, now), columns, 8));
  return out;
}
