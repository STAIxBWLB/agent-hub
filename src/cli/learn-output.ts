// Human output for `ahub learn` (#514b). Pure: parsed hub-tool JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// Ids, counts, the key parts and the one line the hub itself generates are all it shows: the card's own text is never echoed (a card is data to the parser, not to this printer).
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import type { Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);

/** `ahub learn list [--all]`: one row per candidate, and what each command would do. */
export function renderLearnList(result: unknown, columns?: number, all = false): Span[][] {
  const rows = list(result);
  const open = rows.filter(row => row.status === "open").length;
  const out: Span[][] = [...heading(all ? `Review checklist candidates: ${open} open, ${rows.length - open} decided` : `Review checklist candidates: ${open} open`, columns)];
  if (!rows.length) {
    out.push(blank, [s(all ? "no candidate has been filed" : "no open candidate; pass --all to include decided ones", "muted")]);
    return out;
  }
  out.push(...grid(["ID", "STATUS", "PROFILE/CLASS", "CRITERION", "TASKS", "LINE TO ADD"], rows.map((row: any) => [
    s(`#${row.id}`, "taskRef"), s(dash(row.status), row.status === "open" ? "attention" : "muted"), s(`${dash(row.profile)}/${dash(row.class)}`), s(dash(row.criterion)), s(String(list(row.tasks).length)), s(dash(row.line)),
  ]), columns));
  if (open) out.push(blank, [s("accept writes the line to .agenthub/config.local.json (ahub settings undo puts it back); reject closes the card. Nothing else changes.", "muted")]);
  return out;
}

/** `ahub learn accept|reject <id>`: what was decided, and for accept exactly what was written and where. */
export function renderLearnChange(op: "accept" | "reject", result: unknown, columns?: number): Span[][] {
  const r = (result ?? {}) as any;
  const card = op === "accept" ? r.card : r;
  const out: Span[][] = [...heading(op === "accept" ? `Candidate #${dash(card?.id)} accepted` : `Candidate #${dash(card?.id)} rejected and closed`, columns)];
  if (op === "reject") return [...out, ...pair("written", "nothing", columns, 8, "muted")];
  const a = r.accepted ?? {};
  out.push(...pair("profile", `${dash(a.profile)}/${dash(a.class)}`, columns, 8), ...pair("criterion", a.criterion, columns, 8), ...pair("line", a.line, columns, 8),
    ...pair("file", `${dash(a.file)} (this machine only; the shared config is untouched)`, columns, 8), ...pair("now", a.alreadyPresent ? `the checklist already had this line: nothing was written` : `${dash(a.lines)} lines in the checklist`, columns, 8),
    ...pair("applies", dash(a.applies), columns, 8, "attention"));
  if (a.undo) out.push(blank, [s(`put it back with ${a.undo}`, "muted")]);
  return out;
}
