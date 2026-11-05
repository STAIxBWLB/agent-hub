// Human output for `ahub task handoff` and `ahub board --handoffs` (#604, agent-hub#1030). Pure: the hub's parsed JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// Only ids, states and counts are shown: the title of a handed-off task is the caller's own and was bounded and sanitized by the hub.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import type { Span, Tone } from "./console-state.ts";

const STATE_TONE: Record<string, Tone | undefined> = { approved: undefined, cancelled: "muted", declined: "attention", proposed: "attention" };
const num = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "-";

/** The receipt of one handoff: where the task now lives and what to run to follow it. */
export function renderHandoffReceipt(receipt: unknown, columns?: number): Span[][] {
  const r = receipt as any;
  return [...heading(`Handed off to project ${r?.project ?? "?"}`, columns),
    ...pair("task", `#${num(r?.task)} (${r?.state ?? "proposed"})`, columns, 8, "taskRef"),
    blank, [s("it is on that project's board as an ownerless proposal; its own roles plan, implement and review it, and you are told when it changes state", "muted")],
    [s("ahub board --handoffs shows the last state it reported", "muted")]];
}

/** What this project handed to others, with the last state each target reported. */
export function renderHandoffs(data: unknown, columns?: number): Span[][] {
  const rows: any[] = Array.isArray((data as any)?.handoffs) ? (data as any).handoffs : [];
  if (!rows.length) return [[s("no handoffs: hand work that belongs to another project with `ahub task handoff --project <root|id> <title...>`", "muted")]];
  // #734: a row from a hub that has no age or reach (an older daemon) shows "-" for both, never a guess.
  const reach = (row: any): Span => {
    const word = row.reach === "reachable" || row.reach === "unreachable" || row.reach === "moved" ? row.reach : undefined;
    if (word === undefined) return s("-", "muted");
    return s(word === "reachable" ? "reachable" : word === "moved" ? "moved" : "unreachable", word === "reachable" ? "success" : "attention");
  };
  const down = rows.filter(row => row.reach === "unreachable" || row.reach === "moved" ? typeof row.cause === "string" : false);
  return [...heading(`Handoffs (${rows.length})`, columns), ...grid(["PROJECT", "TASK", "STATE", "AGE", "REACH", "PR", "BY", "TITLE"], rows.map(row => [
    s(String(row.remoteProject ?? "?").slice(0, 24), "issueRef"), s(`#${num(row.remoteTask)}`, "taskRef"), s(String(row.state ?? "?"), STATE_TONE[row.state]),
    s(typeof row.age === "string" ? row.age : "-", "muted"), reach(row),
    s(typeof row.pr === "number" ? `#${row.pr}` : "-"), s(String(row.originPeer ?? "?")), s(String(row.title ?? ""))]), columns),
    // The cause of each unreachable or moved target, once per target and with its next step, so the column stays narrow and the person still learns what to run.
    ...[...new Map(down.map(row => [String(row.remoteProject), String(row.cause)])).entries()].map(([project, cause]) => [s(`${String(project).slice(0, 24)}: ${cause.slice(0, 200)}`, "attention")]),
    // A sync that did not finish in time: the pass keeps running, so the list above is the state so far and the person is told what to run to read the rest.
    ...(typeof (data as any)?.cause === "string" && (data as any)?.synced === false ? [[s(String((data as any).cause).slice(0, 200), "attention")]] : []),
    ...((data as any)?.syncing === true ? [[s(`catch-up still running for ${num((data as any).pending)} target${(data as any).pending === 1 ? "" : "s"}: run \`ahub task handoff --list\` in a minute`, "attention")]] : [])];
}
