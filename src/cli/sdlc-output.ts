// Human output for the `ahub sdlc` read commands (#814 T1). Pure: data in, spans out, no I/O and no clock but `now`.
// Layout follows #284: aligned columns from the shared `table`, long text wrapped under its label (never cut),
// semantic tones, readable times (`2026-10-25 14:20 UTC (3h05m ago)`, never a raw ISO string). `--json` is the caller's
// branch and prints the hub's reply untouched, so nothing here may be the only copy of a field.
import { duration, plural, relative, table, terminalText, wrap, Report as LayoutReport, type Span, type Tone } from "./console-state.ts";
import { readbackSummary, type ReadbackView } from "../hub/spec-readback.ts";

type Line = Span[];
/** Configuration remains restart-bound; the claim is caller provenance, not inferred release consent. */
export function renderSdlcConfiguration(value: unknown, columns?: number): Span[][] {
  const row = value as any;
  const out = heading(list(row?.restartPending).length ? "SDLC configuration saved; restart pending" : "SDLC configuration saved", columns);
  out.push(...pair("actor", row?.by ?? "unknown", columns, 12));
  out.push(...pair("instruction", "person's explicit instruction claimed for this session", columns, 12));
  for (const line of list(row?.lines)) out.push(...para(String(line), columns));
  if (row?.backup) out.push(...pair("backup", row.backup, columns, 12));
  return out;
}
/** Survey fields already passed the host's task and security disclosure policy. */
export function renderSdlcSurvey(value: unknown, columns?: number): Span[][] {
  const row = value as any;
  if (!row) return [[s("no advisor survey", "muted")]];
  const out: Span[][] = [...heading(`Advisor survey, task ${row.task ?? "unknown"}`, columns)];
  for (const field of ["survey", "ref", "focus"]) if (row[field] !== undefined) out.push(...pair(field, row[field], columns, 12));
  if (row.withheld || row.status === "private") return [...out, [s("report withheld by current privacy", "attention")]];
  for (const item of list(row.items)) {
    const finding = item.finding ?? item;
    out.push(...pair("finding", finding.id, columns, 12));
    if (finding.withheld || item.withheld) { out.push(...pair("details", "withheld", columns, 12)); continue; }
    for (const field of ["evidence", "impact", "effort", "risk", "confidence", "fix_sketch"]) if (finding[field] !== undefined) out.push(...pair(field, finding[field], columns, 12));
    if (item.decision) out.push(...pair("decision", item.decision.verdict, columns, 12));
    else if (item.verdict) out.push(...pair("decision", item.verdict, columns, 12));
    if (item.rejectedBefore?.rejectedBefore || item.rejectedBefore === true) out.push(...pair("history", "rejected before", columns, 12, "attention"));
    for (const rejected of list(item.rejected)) {
      out.push(...pair("rejected before", rejected.id, columns, 16));
      if (rejected.change === "unknown") out.push(...pair("change", "unknown (suppression retained)", columns, 16, "attention"));
      if (!rejected.withheld && rejected.reason) out.push(...pair("reason", rejected.reason, columns, 16));
    }
  }
  for (const rejected of list(row.rejected)) {
    out.push(...pair("rejected before", rejected.id, columns, 16));
    if (rejected.status === "unknown" || rejected.change === "unknown") out.push(...pair("change", "unknown (suppression retained)", columns, 16, "attention"));
    if (!rejected.withheld && rejected.reason) out.push(...pair("reason", rejected.reason, columns, 16));
  }
  return out;
}
export const s = (value: unknown, tone?: Tone): Span => ({ text: terminalText(value).replace(/[\n\t]/g, " "), ...(tone ? { tone } : {}) });
const room = (columns?: number) => columns ?? Infinity;
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const yes = (value: unknown) => value === true ? "yes" : value === false ? "no" : "unknown";
const short = (sha: unknown) => typeof sha === "string" && sha ? sha.slice(0, 8) : "-";
const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : "unknown";
const percent = (rate: unknown) => typeof rate === "number" && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : "unknown";
/** `2026-10-25 14:20 UTC (3h05m ago)`: an absolute minute and how long ago, never the raw ISO string. */
export function moment(at: unknown, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at)) return "unknown";
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC (${relative(at, now)})`;
}
const span = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms) ? duration(ms) : "unknown";

/** Text wrapped to the width, continuation lines hanging under `indent`. */
function para(text: string, columns: number | undefined, tone?: Tone, indent = "", hang = 2): Line[] {
  return wrap(indent + text, room(columns), hang).map(line => [s(line, tone)]);
}
/**
 * `label  value`, the value wrapped beside its own label so narrow terminals never separate them. When the longest word of
 * the value does not fit in the room left of the label column, the value moves under the label instead, so a path or id
 * is broken only when it is wider than the whole terminal.
 */
export function pair(label: string, value: unknown, columns: number | undefined, labelWidth: number, tone?: Tone, indent = ""): Line[] {
  const text = terminalText(value).replace(/[\n\t]/g, " ");
  const head = indent + label.padEnd(labelWidth) + "  ";
  const longest = Math.max(0, ...text.split(/\s+/).map(textWidth));
  if (columns !== undefined && head.length + longest > columns && text) {
    const under = indent.length + 1 + longest <= columns ? indent + " " : "";
    return [[s(indent + label, "muted")], ...wrap(under + text, columns, under.length).map((line): Line => [s(line, tone)])];
  }
  const lines = wrap(head + text, room(columns), head.length);
  return lines.map((line, i) => i === 0 ? [s(line.slice(0, head.length), "muted"), s(line.slice(head.length), tone)] : [s(line, tone)]);
}
/** Items under a label, one per line, wrapped under the dash. */
function bullets(label: string, items: readonly unknown[], columns: number | undefined, tone?: Tone, indent = ""): Line[] {
  if (!items.length) return [];
  return [[s(indent + label, "muted")], ...items.flatMap(item => para(`- ${terminalText(item)}`, columns, tone, indent + (columns !== undefined && indent.length + 2 + 2 + Math.max(0, ...terminalText(item).split(/\s+/).map(textWidth)) > columns ? "" : "  "), 2))];
}
const GAP = 2;
const textWidth = (text: string) => Bun.stringWidth(text);
/**
 * A table that fits the terminal and never cuts a character. At its natural widths when they fit; otherwise the
 * widest cells wrap inside their column (a PR linked to thirty tasks wraps its TASKS cell, it does not push the
 * table to 134 columns); and when even each column's longest unbreakable word cannot fit, one labelled block per row.
 */
export function grid(head: string[], data: Span[][], columns: number | undefined): Line[] {
  const natural = head.map((name, i) => Math.max(textWidth(name), ...data.map(row => textWidth(row[i]?.text ?? ""))));
  const gaps = GAP * (head.length - 1);
  if (columns === undefined || natural.reduce((sum, n) => sum + n, 0) + gaps <= columns) return table(head, data, room(columns), natural);
  const floor = head.map((name, i) => Math.max(textWidth(name), ...data.flatMap(row => (row[i]?.text ?? "").split(/\s+/).map(textWidth))));
  if (floor.reduce((sum, n) => sum + n, 0) + gaps > columns) return blocks(head, data, columns);
  // Hand the spare width to the column that is cut most, one cell at a time, so the wide list cell wraps and the short ones do not.
  const widths = [...floor];
  for (let spare = columns - widths.reduce((sum, n) => sum + n, 0) - gaps; spare > 0; spare--) {
    let at = -1;
    for (let i = 0; i < widths.length; i++) if (widths[i]! < natural[i]! && (at < 0 || natural[i]! - widths[i]! > natural[at]! - widths[at]!)) at = i;
    if (at < 0) break;
    widths[at]!++;
  }
  const physical = data.flatMap(row => {
    const cells = row.map((cell, i) => wrap(cell.text, widths[i]!, 0));
    return Array.from({ length: Math.max(1, ...cells.map(lines => lines.length)) }, (_, n) => head.map((_, i): Span => ({ ...(row[i] ?? s("")), text: cells[i]?.[n] ?? "" })));
  });
  return table(head, physical, columns, widths);
}
/** Narrow terminal: each row becomes its own block, the first column as its heading and every other column beside its label. */
function blocks(head: string[], data: Span[][], columns: number): Line[] {
  const label = Math.max(...head.slice(1).map(textWidth));
  return data.flatMap((row, n) => [...(n ? [blank] : []), ...wrap(row[0]?.text ?? "", columns, 2).map((line): Line => [{ ...(row[0] ?? s("")), text: line }]),
    ...head.slice(1).flatMap((name, i) => pair(name.toLowerCase(), row[i + 1]?.text ?? "", columns, label, row[i + 1]?.tone, "  "))]);
}
/** A heading wraps to the width like any paragraph; a long repository name never pushes it past the terminal. */
export const heading = (text: string, columns?: number): Line[] => wrap(text, room(columns), 2).map(line => [s(line, "strong")]);
export const blank: Line = [s("")];
const readyTone = (ready: unknown): Tone => ready === true ? "success" : "attention";

// ---- sdlc status / explain ----------------------------------------------------------------------------------------

function receiptLine(receipt: any): string {
  const parts = [receipt?.repo && receipt?.issue ? `${receipt.repo}#${receipt.issue}` : receipt?.issue ? `issue #${receipt.issue}` : undefined,
    receipt?.pr ? `PR #${receipt.pr}` : undefined, receipt?.head ? `head ${short(receipt.head)}` : undefined].filter(Boolean);
  return parts.length ? parts.join(", ") : "no issue or PR recorded";
}
function taskBlock(row: any, columns: number | undefined, detail: boolean, readback = true): Line[] {
  const id = `#${row.id}`;
  const out: Line[] = para(`${id}  ${row.title ?? ""}`, columns, undefined, "", 6)
    .map((line, i) => i === 0 ? [s(id, "taskRef"), s(line[0]!.text.slice(id.length), "strong")] : line);
  out.push(...pair("lifecycle", `stage ${row.stage ?? "unknown"}, mode ${row.mode ?? "unknown"}, ready ${yes(row.ready)}, actor ${row.actor ?? "unknown"}`, columns, 11, readyTone(row.ready), "  "));
  out.push(...pair("next", row.next ?? "unknown", columns, 11, undefined, "  "));
  out.push(...pair("receipt", receiptLine(row.receipt), columns, 11, undefined, "  "));
  out.push(...bullets("blockers", list(row.blockers), columns, "attention", "  "));
  if (readback && row.readback) {
    const view = row.readback as ReadbackView;
    out.push(...pair("read-back", readbackSummary(view), columns, 11, view.state === "stale" || view.state === "unavailable" ? "attention" : undefined, "  "));
  }
  if (!detail) return out;
  if (row.spec) out.push(...pair("spec", `issue #${row.spec.issue}, ${row.spec.state}`, columns, 11, undefined, "  "));
  if (row.playbook) out.push(...pair("playbook", row.playbook, columns, 11, undefined, "  "));
  if (row.definition?.name || row.definition?.id) out.push(...pair("stage", row.definition.name ?? row.definition.id, columns, 11, undefined, "  "));
  out.push(...bullets("entry", list(row.entry), columns, undefined, "  "), ...bullets("exit", list(row.exit), columns, undefined, "  "));
  const f = row.findings;
  if (f) out.push(...pair("findings", `${plural(f.important ?? 0, "important")} (${f.openImportant ?? 0} open), ${plural(f.nit ?? 0, "nit")} (${f.openNit ?? 0} open), ${f.fixed ?? 0} fixed, ${f.falsePositive ?? 0} false positive, ${f.accepted ?? 0} accepted${f.needsValidation ? `, ${f.needsValidation} needs validation (not blocking)` : ""}${f.preExisting ? `, ${f.preExisting} pre-existing (not blocking)` : ""}`, columns, 11, f.openImportant ? "attention" : undefined, "  "));
  const p = row.planConformance;
  if (p) {
    out.push(...pair("plan files", `${p.state}${p.accepted ? ", departure accepted" : ""}, ${list(p.outside).length} outside the plan, ${list(p.untouched).length} planned and untouched`, columns, 11, p.state === "departure" && !p.accepted ? "attention" : undefined, "  "));
    out.push(...bullets("outside the plan", list(p.outside), columns, "attention", "    "), ...bullets("untouched", list(p.untouched), columns, "muted", "    "));
  }
  const t = row.testIntegrity;
  if (t) {
    out.push(...pair("tests", `${t.applicability === "bug" ? "bug fix" : t.applicability === "not_bug" ? "not a bug fix" : "bug status unknown"}, red-first ${String(t.redFirst).replace("_", " ")}, files ${t.fileState}`, columns, 11, undefined, "  "));
    out.push(...bullets("modified tests", list(t.modifiedTests), columns, undefined, "    "), ...bullets("test blockers", list(t.blockers), columns, "attention", "    "));
  }
  const sp = row.securityPass;
  if (sp) {
    const shown = sp.state === "required" ? `required (${sp.matched} sensitive path${sp.matched === 1 ? "" : "s"} changed), none recorded at this head`
      : sp.state === "recorded" ? `recorded at this head (${sp.recorded?.covered ?? 0} covered, ${sp.recorded?.notCovered ?? 0} not covered)`
      : sp.state === "unknown" ? "unknown (PR file inventory incomplete or unreadable)" : "not required";
    out.push(...pair("security pass", `${shown}${list(sp.companions).length ? `; companions ${list(sp.companions).join(", ")}` : ""}`, columns, 11, sp.state === "required" || sp.state === "unknown" ? "attention" : undefined, "  "));
  }
  const e = row.evalGate;
  if (e) {
    const shown = e.state === "not_configured" ? "eval check not configured (suite choice pending the person)" : e.state === "coverage_unknown" ? "PR file coverage unknown" : `${e.check} ${String(e.state)}${e.passRate !== undefined ? `, pass rate ${e.passRate}` : ""}${e.suite !== undefined ? `, suite ${e.suite}` : ""}`;
    out.push(...pair("eval gate", `configuration PR, ${shown}`, columns, 11, e.state === "passed" && !list(e.gaps).length ? undefined : "attention", "  "));
    out.push(...bullets("eval gaps", [...list(e.gaps), ...list(e.notes)], columns, "attention", "    "));
  }
  const c = row.criteria;
  if (c) {
    out.push(...pair("criteria", `${c.ready ? "all met" : "not all met"}${c.id ? `, checklist ${c.id}` : ""}${c.note ? `, ${c.note}` : ""}`, columns, 11, readyTone(c.ready), "  "));
    out.push(...bullets("unmet", list(c.blockers), columns, "attention", "    "));
  }
  return out;
}
function lifecycleView(reply: any, columns: number | undefined, detail: boolean): Line[] {
  const rows = list(reply?.rows);
  const out: Line[] = [...heading(`SDLC lifecycle, mode ${reply?.mode ?? "unknown"}`, columns)];
  if (reply?.securityScan && typeof reply.securityScan === "object") {
    out.push(...pair("security scan", Object.entries(reply.securityScan).map(([source, value]) => `${source}: ${value === null ? "unknown" : value}`).join(", "), columns, 14));
  }
  if (!rows.length) return [...out, [s("no task has lifecycle state yet", "muted")]];
  if (!detail || rows.length > 1) {
    out.push(...grid(["ID", "STAGE", "READY", "ACTOR", "PR"], rows.map(row => [s(`#${row.id}`, "taskRef"), s(row.stage ?? "unknown"), s(yes(row.ready), readyTone(row.ready)), s(row.actor ?? "-"), s(row.receipt?.pr ? `#${row.receipt.pr}` : "-")]), columns));
  }
  // #1658: the read-back line belongs to one task's view; a list of rows has no single issue body to read it against.
  for (const row of rows) out.push(blank, ...taskBlock(row, columns, detail, detail || rows.length === 1));
  if (reply?.truncated) out.push(blank, ...para("showing the first 100 tasks; name a task to read one", columns, "muted"));
  return out;
}
/** `ahub sdlc status [task]`: one row per task, then each task's next step and blockers. */
export const renderSdlcStatus = (reply: unknown, columns?: number, _now = Date.now()): Span[][] => lifecycleView(reply, columns, false);
/** `ahub sdlc explain <task>`: the same task with every gate the hub read. */
export const renderSdlcExplain = (reply: unknown, columns?: number, _now = Date.now()): Span[][] => lifecycleView(reply, columns, true);

// ---- sdlc queue / release -----------------------------------------------------------------------------------------

/** `ahub sdlc queue <repo>`: the merge order, then each open PR's gates. */
/** The header line does not wrap: a name that fits the terminal stays in it, a longer one moves to a wrapped row under a short header. */
function titled(columns: number | undefined, ascii: boolean, lead: string, name: string): LayoutReport {
  const report = new LayoutReport(columns, ascii);
  if (columns === undefined || textWidth(` ahub ${lead} ${name}`) <= columns) return report.header("ahub", `${lead} ${name}`);
  return report.header("ahub", lead).note(name, "value");
}
export function renderSdlcQueue(reply: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = (reply as any)?.report ?? {};
  const rows = list(report.rows);
  const out = titled(columns, ascii, "Merge queue", String(report.repo ?? "unknown repository"));
  if (report.complete === false || report.truncated) {
    out.section("Caution");
    if (report.complete === false) out.bullet("warn", "incomplete: a read failed or the board changed during it; do not merge from this order");
    if (report.truncated) out.bullet("warn", "truncated: more open PRs than one read covers");
  }
  if (!rows.length) return out.note("no open PR is linked to a task").lines();
  const prs = (items: unknown) => list(items).map((pr: number) => `#${pr}`).join(", ");
  out.section("Order").kv([["order", list(report.order).length ? prs(report.order) : "none decided"], ...(list(report.unordered).length ? [["unordered", prs(report.unordered)] as const] : [])]);
  out.section("Pull requests", String(rows.length)).append(grid(["PR", "TASKS", "READY", "HEAD", "AFTER"], rows.map(row => [s(`#${row.pr}`, "issueRef"), s(list(row.tasks).map((id: number) => `#${id}`).join(" ") || "-", "taskRef"), s(yes(row.ready), readyTone(row.ready)), s(row.private ? "private" : short(row.head)), s(list(row.after).map((pr: number) => `#${pr}`).join(" ") || "-")]), columns));
  const blocked = rows.filter(row => list(row.blockers).length || row.findings?.openImportant);
  if (blocked.length) {
    out.section("Blockers", String(blocked.length));
    for (const row of blocked) { out.note(`#${row.pr}`, "value"); for (const item of list(row.blockers)) out.bullet("warn", terminalText(item), true); }
  }
  if (list(report.conflicts).length) {
    out.section("File conflicts", String(list(report.conflicts).length));
    for (const c of list(report.conflicts) as any[]) out.bullet("warn", `#${c.left} and #${c.right} share ${plural(c.files ?? 0, "file")} (${c.order === "person_required" ? "the person orders them" : "dependency order"})`);
  }
  return out.lines();
}
/** One line for the audit's unit states, shared by `audit show` and the release readback. */
function auditStates(a: any): string {
  const c = a?.counts ?? {};
  return `${c.covered ?? 0} covered${a?.prior ? ` (${a.prior} prior)` : ""}, ${c.deferred ?? 0} deferred, ${c.out_of_scope ?? 0} out of scope, ${c.planned ?? 0} planned`;
}
/** `ahub sdlc audit show`: the ledger's counts first, then each unit, then the findings. An open important finding shows its id and status only, unless the caller is the person. */
export function renderSdlcAudit(reply: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const a = (reply as any)?.audit;
  if (!a) return new LayoutReport(columns, ascii).header("ahub", "Security audit").section("Audit").kv([["audits", "none started: run ahub sdlc audit start"]]).lines();
  const out = titled(columns, ascii, "Security audit", `${a.audit} (task #${a.task})`);
  const f = a.findings ?? {};
  out.section("Summary").kv([["source", `${short(a.ref)}, profile ${a.profile}${a.scoped ? ", scoped" : ""}`], ["coverage", `${a.partial ? "partial: " : ""}${auditStates(a)}`],
    ["findings", `${f.verified ?? 0} verified, ${f.candidate ?? 0} candidate (unverified), ${f.needsValidation ?? 0} needs validation, ${f.rejected ?? 0} rejected, ${f.settled ?? 0} settled, ${f.other ?? 0} other`]]);
  if (list(a.units).length) {
    out.section("Units", String(list(a.units).length));
    for (const u of list(a.units) as any[]) out.bullet(u.state === "planned" ? "warn" : "ok", `${String(u.state).replace("_", " ")}: ${terminalText(u.unit)}${u.prior ? ` (prior audit ${u.prior.audit})` : ""}${u.reason ? `: ${terminalText(u.reason)}` : ""}`);
  }
  if (list(a.items).length) {
    out.section("Findings", String(list(a.items).length));
    for (const item of list(a.items) as any[]) out.bullet(item.status === "candidate" ? "warn" : "ok", `${String(item.status)}: ${terminalText(item.id)} (${item.severity}, ${item.disposition})${item.withheld ? ", details withheld" : item.path ? ` ${terminalText(item.path)}` : ""}`);
  }
  if (a.withheld) out.note(`${a.withheld} open important finding${a.withheld === 1 ? "" : "s"}: boundary text is shown to the person only`);
  return out.lines();
}
/** `ahub sdlc release <repo> [live-issue...]`: source, document, issue and authorization evidence, then what blocks the release. */
export function renderSdlcRelease(reply: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const r = (reply as any)?.report ?? {};
  const out = titled(columns, ascii, "Release readiness", String(r.repo ?? "unknown repository"));
  out.section("Source").kv([["version", r.version ?? (r.releasePolicy ? "undetermined" : "unknown")], ["head", short(r.head)], ["tag", r.tag ? `${r.tag} at ${short(r.tagCommit)}` : "none"],
    ["commits", `${plural(list(r.commits).length, "commit")} since the last tag`], ...(list(r.mergedPrs).length ? [["merged PRs", list(r.mergedPrs).map((p: any) => `#${p.pr}`).join(", ")] as const] : [])]);
  out.section("Readiness").kv([["source ready", yes(r.sourceReady)], ["native", String(r.native ?? "unverified")], ["release ready", yes(r.ready)]]);
  const docs = r.documents;
  out.section("Documents");
  if (r.releasePolicy?.docsSource === "none") out.kv([["documents", r.releasePolicy.authorization === "matched" ? "none (explicit exemption recorded)" : "none (configured exemption; no matching authorization)"]]);
  else {
    out.kv([["documents", docs ? `${docs.fresh ? "fresh" : "not fresh"}, ${plural(docs.errors ?? 0, "error")}, ${plural(list(docs.documents).length, "document")}` : "not read"]]);
    for (const d of list(docs?.documents) as any[]) if (d.state !== "fresh") out.bullet("warn", `${d.state}: ${terminalText(d.path ?? "(path withheld)")}${d.dirty ? " (uncommitted changes)" : ""}`);
  }
  if (r.releasePolicy) out.kv([["release policy", `version ${r.releasePolicy.versionSource}, docs ${r.releasePolicy.docsSource}, authorization ${r.releasePolicy.authorization}`]]);
  if (list(r.liveIssues).length) out.section("Live issues", String(list(r.liveIssues).length)).append(grid(["ISSUE", "STATE"], list(r.liveIssues).map((i: any) => [s(`#${i.id}`, "issueRef"), s(i.state, i.state === "closed" ? "success" : "attention")]), columns));
  const au = r.authorization;
  out.section("Authorization").kv([["authorization", au ? `${au.state}: version ${au.receipt?.version ?? "unknown"} at ${short(au.receipt?.commit)}, approved ${moment(au.receipt?.at, now)}`
    : r.releasePolicy ? `none recorded for ${r.releasePolicy.versionSource}: run ahub sdlc authorize-release <version>` : "none recorded: run ahub sdlc authorize-release <version>"]]);
  if (list(r.trains).length) {
    out.section("Trains", String(list(r.trains).length));
    for (const tr of list(r.trains) as any[]) out.bullet(list(tr.readiness?.blockers).length ? "warn" : "ok", `train #${tr.release?.id ?? "?"}: ${tr.readiness?.trigger ?? "unknown"}${list(tr.readiness?.blockers).length ? `, ${list(tr.readiness.blockers).join("; ")}` : ""}`);
  }
  const sa = r.securityAudit;
  if (sa) out.section("Security audit").kv([["security audit", `${short(sa.ref)} ${sa.profile}${sa.partial ? " (partial)" : ""}: ${auditStates(sa)}${sa.findings?.candidate ? `, ${sa.findings.candidate} unverified candidate${sa.findings.candidate === 1 ? "" : "s"}` : ""}`]]);
  const rm = r.releaseMetrics;
  if (rm) {
    const mean = (values: unknown[]) => { const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)); return known.length ? span(known.reduce((x, y) => x + y, 0) / known.length) : "unknown"; };
    out.section("Release history").kv([["releases", `${list(rm.intervals).length ? `interval ${mean(list(rm.intervals).map((i: any) => i.ms))} mean over ${plural(list(rm.intervals).length, "gap")}` : "interval unknown (needs two shipped releases with history)"}; lead time ${mean(list(rm.approvalToReleaseMs).map((x: any) => x.ms))} mean approval to release; hotfix rate ${percent(rm.hotfixRate)}${rm.hotfixCount === null || rm.hotfixCount === undefined ? "" : ` (${rm.hotfixCount})`}`],
      ...(list(rm.unknown).length ? [["unknown", `${plural(list(rm.unknown).length, "release")} without complete history: ${list(rm.unknown).map((id: number) => `#${id}`).join(", ")}`] as const] : [])]);
  }
  if (list(r.blockers).length) { out.section("Blockers", String(list(r.blockers).length)); for (const item of list(r.blockers)) out.bullet("warn", terminalText(item)); }
  return out.lines();
}

// ---- sdlc metrics / costs -----------------------------------------------------------------------------------------

const SUMMARY_ROWS: [string, string, boolean][] = [
  ["acceptance_to_plan_ms", "acceptance to plan", true], ["accepted_to_plan_ms", "task acceptance to plan", true], ["acceptance_to_first_review_ms", "acceptance to first review", true], ["acceptance_to_merge_ms", "acceptance to merge", true],
  ["rework_rounds", "rework rounds", false], ["same_head_ci_reruns", "same-head CI reruns", false], ["stale_head_re_reviews", "stale-head re-reviews", false],
  ["review_rounds_at_merge", "review rounds at merge", false], ["ci_runs_at_merge", "CI runs at merge", false], ["github_reviews_at_merge", "GitHub reviews at merge", false],
  ["full_gate_runs", "full gate runs", false], ["successful_gate_runs", "successful gate runs", false], ["failed_gate_runs", "failed gate runs", false], ["cancelled_gate_runs", "cancelled gate runs", false], ["other_gate_runs", "other gate runs", false], ["macos_shard_runs", "macOS shard runs", false],
];
const BAND_TONE: Record<string, Tone> = { ok: "success", log: "muted", diagnose: "attention", propose: "failure" };
/** `ahub sdlc metrics [--since ...]`: times and counts from board history, the two approval rates, stalls and band tiers. */
export function renderSdlcMetrics(result: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const m = result as any;
  const out = new LayoutReport(columns, ascii).header("ahub", "SDLC metrics");
  out.section("Scope").kv([["window", m?.since === null || m?.since === undefined ? "all recorded history" : `since ${moment(m.since, now)}`], ["tasks", `${m?.tasks ?? 0} counted${m?.withheldPrivate ? `, ${m.withheldPrivate} private withheld` : ""}`],
    ...(m?.securityScan && typeof m.securityScan === "object" ? [["security scan", Object.entries(m.securityScan).map(([source, value]) => `${source}: ${value === null ? "unknown" : value}`).join(", ")] as const] : [])]);
  const metrics = m?.metrics ?? {};
  const value = (n: unknown, time: boolean) => time ? span(n) : count(n);
  out.section("Times and counts").append(grid(["METRIC", "N", "UNKNOWN", "MEAN", "MEDIAN", "P90", "MAX"], SUMMARY_ROWS.map(([key, label, time]) => {
    const x = metrics[key] ?? {};
    return [s(label), s(count(x.n)), s(count(x.unknown), x.unknown ? "attention" : "muted"), s(value(x.mean, time)), s(value(x.median, time)), s(value(x.p90, time)), s(value(x.max, time))];
  }), columns));
  out.section("Approval rates").append(grid(["RATE", "N", "UNKNOWN", "VALUE"], [["first_pass_approval", "first-pass approval"], ["first_pass_check", "first-pass check"]].map(([key, label]) => {
    const x = metrics[key!] ?? {};
    return [s(label), s(count(x.n)), s(count(x.unknown), x.unknown ? "attention" : "muted"), s(percent(x.rate), x.rate === null || x.rate === undefined ? "muted" : "number")];
  }), columns));
  // #1647: the split reasons, `unset` for tasks proposed without one.
  const reasons = Object.entries((m?.byReason ?? {}) as Record<string, { tasks?: number; reviewRounds?: number; tokens?: number | null }>);
  if (reasons.length) out.section("Split reasons", String(reasons.length)).append(grid(["REASON", "TASKS", "REVIEW ROUNDS", "TOKENS"], reasons.map(([reason, x]) => [s(reason), s(count(x.tasks)), s(count(x.reviewRounds)), s(x.tokens === null || x.tokens === undefined ? "unknown" : count(x.tokens), x.tokens === null || x.tokens === undefined ? "muted" : "number")]), columns));
  const st = m?.stalls;
  if (st) out.section("Stalls").kv([["stalls", `${st.open ?? 0} open${Object.keys(st.byKind ?? {}).length ? ` (${Object.entries(st.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, ${st.doneWithoutWrites ?? 0} done without writes`]]);
  out.section("Bands");
  if (m?.bands === "off" || m?.bands === undefined) out.kv([["bands", "off"]]);
  else {
    out.append(grid(["BAND", "TIER", "BASELINE", "LAST", "Z", "SUBJECT"], list(m.bands).map((b: any) => [s(String(b.metric).replaceAll("_", " ")), s(b.tier, BAND_TONE[b.tier] ?? undefined), s(count(b.baseline)), s(count(b.last)), s(count(b.z)), s(b.lastTask ? `${b.subject === "release" ? "release " : b.subject === "scan" ? "scan " : ""}#${b.lastTask}` : "-", "taskRef")]), columns));
    for (const b of list(m.bands) as any[]) if (b.reason && b.tier !== "ok") out.note(`${String(b.metric).replaceAll("_", " ")}: ${terminalText(b.reason)}`);
  }
  return out.lines();
}
/** `ahub sdlc costs [repo]`: review and CI cost of each linked merged PR, grouped by repository. */
export function renderSdlcCosts(result: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const c = result as any;
  const rows = list(c?.rows);
  const out = new LayoutReport(columns, ascii).header("ahub", "SDLC costs");
  if (!rows.length) out.note("no linked merged PR has cost evidence");
  const repos = [...new Set(rows.map(row => String(row.repo)))];
  for (const repo of repos) {
    const own = rows.filter(row => String(row.repo) === repo);
    out.section("Repository", String(own.length)).note(repo, "value").append(grid(["PR", "ROUNDS", "CI", "RERUNS", "FULL", "DELTA", "REVIEW", "UNK", "OK"], own.map(row => [
      s(`#${row.pr}`, "issueRef"), s(count(row.reviewRounds)), s(count(row.ciRuns)), s(count(row.ciReruns)), s(count(row.fullReReviews)), s(count(row.deltaReviews)), s(span(row.reviewMs)),
      s(count(row.unknownReviewScopes), row.unknownReviewScopes ? "attention" : "muted"), s(row.complete ? "yes" : "no", row.complete ? "success" : "attention")]), columns));
    for (const row of own.filter(row => row.fullGateRuns !== undefined)) {
      out.note(`#${row.pr}: full gates ${count(row.fullGateRuns)} (success ${count(row.successfulGateRuns)}, failed ${count(row.failedGateRuns)}, cancelled ${count(row.cancelledGateRuns)}, other ${count(row.otherGateRuns)}); macOS shards ${count(row.macosShardRuns)}`, "value");
    }
  }
  if (c?.truncated) out.bullet("warn", "truncated: more PRs than one read covers, or a read was incomplete");
  if (c?.privateTasks === "withheld") out.note("private tasks are withheld");
  return out.lines();
}

// ---- sdlc authorize-release ---------------------------------------------------------------------------------------

/** `ahub sdlc authorize-release <version>`: what the person just approved. */
export function renderAuthorization(authorization: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const a = authorization as any;
  const docs = a?.docs?.source === "none" ? "none (explicit exemption)" : a?.docs ? `${a.docs.fresh ? "fresh" : "not fresh"}, ${plural(a.docs.documents ?? 0, "document")}, digest ${short(a.docs.digest)}` : "unknown";
  return new LayoutReport(columns, ascii).header("ahub", "Release authorized")
    .section("Authorization")
    .kv([["version", a?.version ?? "unknown"], ["commit", short(a?.commit)], ["by", a?.by ?? "unknown"], ["at", moment(a?.at, now)], ["docs", docs], ["id", a?.id ?? "unknown"]])
    .note("A daemon restart revokes this authorization.").lines();
}

// ---- sdlc merge ---------------------------------------------------------------------------------------------------

const MERGE_STATE: Record<string, [string, "ok" | "fail" | "warn"]> = { merged: ["merged", "ok"], not_merged: ["not merged", "fail"], unknown: ["merge state unknown", "warn"] };
/** `ahub sdlc merge <task> [--dry-run]` (#899): the hub's decision, every gate that refused it, the `gh` command, and GitHub's readback after a run. */
export function renderSdlcMerge(view: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const v = view as any;
  const refused = list(v?.refused), argv = list(v?.argv);
  const decision = v?.decision === "merge" ? "merge: every gate passed" : v?.decision === "refused" ? `refused by ${plural(refused.length, "gate")}` : "unknown";
  const ran = v?.ran === true ? "yes" : v?.ran === false ? (v?.mode === "dry-run" && argv.length ? "no (dry run: the command above was not run)" : "no") : "unknown";
  const report = new LayoutReport(columns, ascii).header("ahub", `Guarded merge of task #${v?.task ?? "unknown"}`).section("Decision")
    .kv([["mode", v?.mode ?? "unknown"], ["decision", decision], ...(argv.length ? [["command", `gh ${argv.join(" ")}`] as const] : []), ["ran", ran]]);
  if (refused.length) { report.section("Refused", String(refused.length)); for (const gate of refused) report.bullet("fail", terminalText(gate)); }
  const r = v?.result;
  if (r && typeof r === "object") {
    const [state, marker] = MERGE_STATE[String(r.state)] ?? ["merge state unknown", "warn" as const];
    report.section("Result");
    report.bullet(marker, `${state}, gh exit ${count(r.exit)}${r.mergeCommit ? `, merge commit ${short(r.mergeCommit)}` : ""}`);
    if (r.cleanup) report.kv([["cleanup", `branch cleanup ${String(r.cleanup).replaceAll("_", " ")}${r.reason ? ` (${String(r.reason).replaceAll("_", " ")})` : ""}`]]);
  }
  return report.lines();
}
