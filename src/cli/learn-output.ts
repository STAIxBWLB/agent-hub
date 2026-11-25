// Human output for `ahub learn` (#514b). Pure: parsed hub-tool JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// Ids, counts, the key parts and the one line the hub itself generates are all it shows: the card's own text is never echoed (a card is data to the parser, not to this printer).
import { grid, s } from "./sdlc-output.ts";
import { Report, type Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);

/** `ahub learn list [--all]`: one row per candidate, and what each command would do. `--accepted` (#1642 T2) shows the followed lines instead. */
export function renderLearnList(result: unknown, columns?: number, all = false, accepted = false, ascii = false): Span[][] {
  if (accepted || (result as any)?.view === "accepted") return renderLearnAccepted(result, columns, ascii);
  const rows = list(result);
  const open = rows.filter(row => row.status === "open").length;
  const out = new Report(columns, ascii).titled("ahub", all ? `Review checklist candidates: ${open} open, ${rows.length - open} decided` : `Review checklist candidates: ${open} open`);
  if (!rows.length) return out.note(all ? "no candidate has been filed" : "no open candidate; pass --all to include decided ones").lines();
  out.section("Candidates", String(rows.length)).append(grid(["ID", "STATUS", "PROFILE/CLASS", "CRITERION", "TASKS", "LINE TO ADD"], rows.map((row: any) => [
    s(`#${row.id}`, "taskRef"), s(dash(row.status), row.status === "open" ? "attention" : "muted"), s(`${dash(row.profile)}/${dash(row.class)}`), s(dash(row.criterion)), s(String(list(row.tasks).length)), s(dash(row.line)),
  ]), columns));
  if (open) out.note("accept writes the line to .agenthub/config.local.json (ahub settings undo puts it back); reject closes the card. Nothing else changes.");
  return out.lines();
}

/** `ahub learn list --accepted` (#1642 T2): what each accepted line did, its sample size, and the checklist's own size. */
function renderLearnAccepted(result: unknown, columns?: number, ascii = false): Span[][] {
  const r = (result ?? {}) as any, rows = list(r.followed), size = (r.checklist ?? {}) as any;
  const shown = `${dash(size.lines)}/${dash(size.max)} lines, ${dash(size.characters)} characters`;
  const out = new Report(columns, ascii).titled("ahub", `Followed checklist lines: ${rows.length} (checklist ${shown})`);
  if (!rows.length) return out.note("no accepted line is followed: ahub learn accept on a candidate starts one").lines();
  out.section("Followed", String(rows.length)).append(grid(["STATUS", "PROFILE/CLASS", "CRITERION", "SINCE", "BEFORE", "REMOVAL"], rows.map((row: any) => [
    s(dash(row.status), row.status === "worse" || row.status === "no-change" ? "attention" : "muted"), s(`${dash(row.profile)}/${dash(row.class)}`), s(dash(row.criterion)),
    s(`${dash(row.since?.unmet)}/${dash(row.since?.reviewed)}`), s(`${dash(row.before?.unmet)}/${dash(row.before?.reviewed)}`), s(row.removal ? `#${row.removal.id}` : "-", row.removal ? "taskRef" : "muted"),
  ]), columns));
  out.note(`insufficient until ${dash(r.minReviewed)} reviewed tasks since acceptance; a no-change or worse line with that many asks for one removal card. ${dash(r.untracked)} checklist line(s) were not added by ahub learn accept (untracked, never followed).`);
  return out.lines();
}

/** `ahub learn accept|reject <id>`: what was decided, and for accept exactly what was written and where. */
export function renderLearnChange(op: "accept" | "reject", result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const r = (result ?? {}) as any;
  const card = op === "accept" ? r.card : r;
  if (op === "reject") return new Report(columns, ascii).titled("ahub", `Candidate #${dash(card?.id)} rejected and closed`).section("Result").kv([["written", "nothing"]]).lines();
  const a = r.accepted ?? {};
  if (a.alreadyAccepted) return new Report(columns, ascii).titled("ahub", `Candidate #${dash(card?.id)} was already accepted`).section("Candidate").kv([["profile", `${dash(a.profile)}/${dash(a.class)}`], ["criterion", a.criterion], ["written", "nothing: it was accepted before (ahub settings undo still puts back that write if it is the latest)"]]).lines();
  const out = new Report(columns, ascii).titled("ahub", `Candidate #${dash(card?.id)} accepted`);
  const rows: [string, unknown][] = [["profile", `${dash(a.profile)}/${dash(a.class)}`], ["criterion", a.criterion]];
  if (a.kind === "removal") {
    // #1642 T3: a removal card takes one line out; the undo restores the file the settings writer kept.
    rows.push(["removed", "1 checklist line"], ["file", `${dash(a.file)} (this machine only; the shared config is untouched)`], ["now", `${dash(a.lines)} lines in the checklist`], ["applies", dash(a.applies)]);
  } else {
    rows.push(["line", a.line], ["file", `${dash(a.file)} (this machine only; the shared config is untouched)`], ["now", a.alreadyPresent ? `the checklist already had this line: nothing was written` : `${dash(a.lines)} lines in the checklist`],
      ["before", `${dash(a.before?.unmet)}/${dash(a.before?.reviewed)} tasks named it unmet in the window before acceptance`], ["applies", dash(a.applies)]);
  }
  out.section("Accepted").kv(rows);
  if (a.alreadyPresent) out.note("nothing was written");
  if (a.undo) out.note(`put it back with ${a.undo}`);
  return out.lines();
}
