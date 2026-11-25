// Human output for `ahub schedule list|run|pause|resume` (#335). Pure: parsed hub JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// Titles and details are task text and never appear here: a schedule is named by its id, period, class and queue.
import { grid, moment, s } from "./sdlc-output.ts";
import { Report, plural, type Span, type Tone } from "./console-state.ts";
import { schedulePeriodText, scheduleWhen } from "../hub/schedules.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const TONE: Record<string, Tone | undefined> = { due: "attention", waiting: "attention", held: "attention", paused: "muted", scheduled: undefined };
const WHEN: Record<string, string> = { scheduled: "next", due: "due now", waiting: "due, waiting for its task to close", held: "due, held (the hub is stopping or recovering)", paused: "paused" };

/** The next run, as the person reads it: a paused schedule says so and what it would have been. */
export const nextText = (row: any, now: number): string => {
  // A calendar schedule reads its next run in its own zone, with the relative time after it; an `every` schedule keeps the UTC form.
  const at = (instant: unknown) => row?.zone && typeof instant === "number" && Number.isFinite(instant) ? `${scheduleWhen(row, instant)} (${moment(instant, now).replace(/^.*?\((.*)\)$/, "$1")})` : moment(instant, now);
  return row?.state === "paused" ? `paused (would be ${at(row.next)})` : row?.state === "scheduled" ? at(row.next) : WHEN[row?.state] ?? "unknown";
};

/** `ahub schedule list`: one row per configured schedule with its next run. */
export function renderScheduleList(rows: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const schedules = list(rows);
  if (!schedules.length) return [[s("no schedules configured; add them under `schedules` in .agenthub/config.local.json", "muted")]];
  const out = new Report(columns, ascii).titled("ahub", `Schedules (${schedules.length})`);
  out.section("Configured", String(schedules.length)).append(grid(["ID", "SCHEDULE", "CLASS", "QUEUE", "STATE", "NEXT RUN", "LAST RUN", "TASK"], schedules.map((row: any) => [
    s(row.id, "issueRef"), s(row.cron !== undefined ? schedulePeriodText(row) : String(row.every)), s(row.class), s(row.queue), s(row.state, TONE[row.state]), s(nextText(row, now), TONE[row.state]),
    s(row.last ? moment(row.last, now) : "never", "muted"), s(row.task === undefined ? "-" : `#${row.task}`, "taskRef"),
  ]), columns));
  for (const row of schedules) {
    if (row.coalesced) out.note(`${row.id}: ${plural(row.coalesced, "due tick")} skipped; one run follows when it can`);
    if (row.error) out.bullet("warn", `${row.id}: last run failed: ${row.error}`);
  }
  return out.lines();
}

const RESULT: Record<string, string> = { changed: "not run: it was paused or resumed meanwhile", ran: "ran", held: "not run: the hub is held (stopping or recovering)", waiting: "not run: the task its last run made is still open", failed: "failed" };

/** `ahub schedule run <id>`: what the run did. */
export function renderScheduleRun(result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const r = result as any;
  const out = new Report(columns, ascii).titled("ahub", `Schedule ${r?.id ?? "?"}: ${RESULT[r?.outcome] ?? "unknown outcome"}`);
  const rows: [string, unknown][] = [];
  if (r?.task !== undefined) rows.push(["task", `#${r.task}`]);
  if (r?.outcome === "ran") rows.push(["next", "its period restarts now"]);
  if (rows.length) out.section("Run").kv(rows);
  if (r?.reason) out.bullet("warn", `because: ${String(r.reason)}`);
  return out.lines();
}

/** `ahub schedule pause|resume <id>`: the schedule as the hub now holds it. */
export function renderScheduleChange(op: "pause" | "resume", rows: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const row = list(rows)[0];
  const out = new Report(columns, ascii).titled("ahub", `Schedule ${row?.id ?? "?"} ${op === "pause" ? "paused" : "resumed"}`);
  if (row) out.section("Schedule").kv([["state", row.state], ["next run", nextText(row, now)]]);
  return out.lines();
}
