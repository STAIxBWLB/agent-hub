// Human output for the `ahub sdlc` read commands (#814 T1). Pure: data in, spans out, no I/O and no clock but `now`.
// Layout follows #284: aligned columns from the shared `table`, long text wrapped under its label (never cut),
// semantic tones, readable times (`2026-10-25 14:20 UTC (3h05m ago)`, never a raw ISO string). `--json` is the caller's
// branch and prints the hub's reply untouched, so nothing here may be the only copy of a field.
import { duration, plural, relative, table, terminalText, wrap, type Span, type Tone } from "./console-state.ts";

type Line = Span[];
const s = (value: unknown, tone?: Tone): Span => ({ text: terminalText(value).replace(/[\n\t]/g, " "), ...(tone ? { tone } : {}) });
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
function pair(label: string, value: unknown, columns: number | undefined, labelWidth: number, tone?: Tone, indent = ""): Line[] {
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
function grid(head: string[], data: Span[][], columns: number | undefined): Line[] {
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
const heading = (text: string, columns?: number): Line[] => wrap(text, room(columns), 2).map(line => [s(line, "strong")]);
const blank: Line = [s("")];
const readyTone = (ready: unknown): Tone => ready === true ? "success" : "attention";

// ---- sdlc status / explain ----------------------------------------------------------------------------------------

function receiptLine(receipt: any): string {
  const parts = [receipt?.repo && receipt?.issue ? `${receipt.repo}#${receipt.issue}` : receipt?.issue ? `issue #${receipt.issue}` : undefined,
    receipt?.pr ? `PR #${receipt.pr}` : undefined, receipt?.head ? `head ${short(receipt.head)}` : undefined].filter(Boolean);
  return parts.length ? parts.join(", ") : "no issue or PR recorded";
}
function taskBlock(row: any, columns: number | undefined, detail: boolean): Line[] {
  const id = `#${row.id}`;
  const out: Line[] = para(`${id}  ${row.title ?? ""}`, columns, undefined, "", 6)
    .map((line, i) => i === 0 ? [s(id, "taskRef"), s(line[0]!.text.slice(id.length), "strong")] : line);
  out.push(...pair("lifecycle", `stage ${row.stage ?? "unknown"}, mode ${row.mode ?? "unknown"}, ready ${yes(row.ready)}, actor ${row.actor ?? "unknown"}`, columns, 11, readyTone(row.ready), "  "));
  out.push(...pair("next", row.next ?? "unknown", columns, 11, undefined, "  "));
  out.push(...pair("receipt", receiptLine(row.receipt), columns, 11, undefined, "  "));
  out.push(...bullets("blockers", list(row.blockers), columns, "attention", "  "));
  if (!detail) return out;
  if (row.spec) out.push(...pair("spec", `issue #${row.spec.issue}, ${row.spec.state}`, columns, 11, undefined, "  "));
  if (row.playbook) out.push(...pair("playbook", row.playbook, columns, 11, undefined, "  "));
  if (row.definition?.name || row.definition?.id) out.push(...pair("stage", row.definition.name ?? row.definition.id, columns, 11, undefined, "  "));
  out.push(...bullets("entry", list(row.entry), columns, undefined, "  "), ...bullets("exit", list(row.exit), columns, undefined, "  "));
  const f = row.findings;
  if (f) out.push(...pair("findings", `${plural(f.important ?? 0, "important")} (${f.openImportant ?? 0} open), ${plural(f.nit ?? 0, "nit")} (${f.openNit ?? 0} open), ${f.fixed ?? 0} fixed, ${f.falsePositive ?? 0} false positive, ${f.accepted ?? 0} accepted`, columns, 11, f.openImportant ? "attention" : undefined, "  "));
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
  if (!rows.length) return [...out, [s("no task has lifecycle state yet", "muted")]];
  if (!detail || rows.length > 1) {
    out.push(...grid(["ID", "STAGE", "READY", "ACTOR", "PR"], rows.map(row => [s(`#${row.id}`, "taskRef"), s(row.stage ?? "unknown"), s(yes(row.ready), readyTone(row.ready)), s(row.actor ?? "-"), s(row.receipt?.pr ? `#${row.receipt.pr}` : "-")]), columns));
  }
  for (const row of rows) out.push(blank, ...taskBlock(row, columns, detail));
  if (reply?.truncated) out.push(blank, ...para("showing the first 100 tasks; name a task to read one", columns, "muted"));
  return out;
}
/** `ahub sdlc status [task]`: one row per task, then each task's next step and blockers. */
export const renderSdlcStatus = (reply: unknown, columns?: number, _now = Date.now()): Span[][] => lifecycleView(reply, columns, false);
/** `ahub sdlc explain <task>`: the same task with every gate the hub read. */
export const renderSdlcExplain = (reply: unknown, columns?: number, _now = Date.now()): Span[][] => lifecycleView(reply, columns, true);

// ---- sdlc queue / release -----------------------------------------------------------------------------------------

/** `ahub sdlc queue <repo>`: the merge order, then each open PR's gates. */
export function renderSdlcQueue(reply: unknown, columns?: number, _now = Date.now()): Span[][] {
  const report = (reply as any)?.report ?? {};
  const rows = list(report.rows);
  const out: Line[] = [...heading(`Merge queue ${report.repo ?? "unknown repository"}`, columns)];
  if (report.complete === false) out.push(...para("incomplete: a read failed or the board changed during it; do not merge from this order", columns, "attention"));
  if (report.truncated) out.push(...para("truncated: more open PRs than one read covers", columns, "attention"));
  if (!rows.length) return [...out, [s("no open PR is linked to a task", "muted")]];
  out.push(...pair("order", list(report.order).length ? list(report.order).map((pr: number) => `#${pr}`).join(", ") : "none decided", columns, 9));
  if (list(report.unordered).length) out.push(...pair("unordered", list(report.unordered).map((pr: number) => `#${pr}`).join(", "), columns, 9, "attention"));
  out.push(blank, ...grid(["PR", "TASKS", "READY", "HEAD", "AFTER"], rows.map(row => [s(`#${row.pr}`, "issueRef"), s(list(row.tasks).map((id: number) => `#${id}`).join(" ") || "-", "taskRef"), s(yes(row.ready), readyTone(row.ready)), s(row.private ? "private" : short(row.head)), s(list(row.after).map((pr: number) => `#${pr}`).join(" ") || "-")]), columns));
  for (const row of rows) {
    if (!list(row.blockers).length && !row.findings?.openImportant) continue;
    out.push(blank, [s(`#${row.pr}`, "issueRef")], ...bullets("blockers", list(row.blockers), columns, "attention", "  "));
  }
  if (list(report.conflicts).length) out.push(blank, ...bullets("file conflicts", list(report.conflicts).map((c: any) => `#${c.left} and #${c.right} share ${plural(c.files ?? 0, "file")} (${c.order === "person_required" ? "the person orders them" : "dependency order"})`), columns, "attention"));
  return out;
}
/** `ahub sdlc release <repo> [live-issue...]`: source, document, issue and authorization evidence, then what blocks the release. */
export function renderSdlcRelease(reply: unknown, columns?: number, now = Date.now()): Span[][] {
  const r = (reply as any)?.report ?? {};
  const out: Line[] = [...heading(`Release readiness ${r.repo ?? "unknown repository"}`, columns)];
  const w = 12;
  out.push(...pair("version", r.version ?? "unknown", columns, w), ...pair("head", short(r.head), columns, w), ...pair("tag", r.tag ? `${r.tag} at ${short(r.tagCommit)}` : "none", columns, w));
  out.push(...pair("source ready", yes(r.sourceReady), columns, w, readyTone(r.sourceReady)), ...pair("native", String(r.native ?? "unverified"), columns, w, "attention"), ...pair("release ready", yes(r.ready), columns, w, readyTone(r.ready)));
  out.push(...pair("commits", `${plural(list(r.commits).length, "commit")} since the last tag`, columns, w));
  if (list(r.mergedPrs).length) out.push(...pair("merged PRs", list(r.mergedPrs).map((p: any) => `#${p.pr}`).join(", "), columns, w));
  const docs = r.documents;
  out.push(blank, ...pair("documents", docs ? `${docs.fresh ? "fresh" : "not fresh"}, ${plural(docs.errors ?? 0, "error")}, ${plural(list(docs.documents).length, "document")}` : "not read", columns, w, docs?.fresh ? "success" : "attention"));
  for (const d of list(docs?.documents)) if (d.state !== "fresh") out.push(...pair(d.state, `${d.path ?? "(path withheld)"}${d.dirty ? " (uncommitted changes)" : ""}`, columns, w, "attention", "  "));
  if (list(r.liveIssues).length) out.push(blank, ...grid(["ISSUE", "STATE"], list(r.liveIssues).map((i: any) => [s(`#${i.id}`, "issueRef"), s(i.state, i.state === "closed" ? "success" : "attention")]), columns));
  const a = r.authorization;
  if (a) out.push(blank, ...pair("authorization", `${a.state}: version ${a.receipt?.version ?? "unknown"} at ${short(a.receipt?.commit)}, approved ${moment(a.receipt?.at, now)}`, columns, w, a.state === "matched" ? "success" : "attention"));
  else out.push(blank, ...pair("authorization", "none recorded: run ahub sdlc authorize-release <version>", columns, w, "muted"));
  for (const t of list(r.trains)) out.push(...pair(`train #${t.release?.id ?? "?"}`, `${t.readiness?.trigger ?? "unknown"}${list(t.readiness?.blockers).length ? `, ${list(t.readiness.blockers).join("; ")}` : ""}`, columns, w, list(t.readiness?.blockers).length ? "attention" : undefined));
  const rm = r.releaseMetrics;
  if (rm) {
    const mean = (values: unknown[]) => { const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)); return known.length ? span(known.reduce((a, b) => a + b, 0) / known.length) : "unknown"; };
    out.push(blank, ...pair("releases", `${list(rm.intervals).length ? `interval ${mean(list(rm.intervals).map((i: any) => i.ms))} mean over ${plural(list(rm.intervals).length, "gap")}` : "interval unknown (needs two shipped releases with history)"}; lead time ${mean(list(rm.approvalToReleaseMs).map((x: any) => x.ms))} mean approval to release; hotfix rate ${percent(rm.hotfixRate)}${rm.hotfixCount === null || rm.hotfixCount === undefined ? "" : ` (${rm.hotfixCount})`}`, columns, w));
    if (list(rm.unknown).length) out.push(...pair("unknown", `${plural(list(rm.unknown).length, "release")} without complete history: ${list(rm.unknown).map((id: number) => `#${id}`).join(", ")}`, columns, w, "attention", "  "));
  }
  out.push(...bullets("blockers", list(r.blockers), columns, "attention"));
  return out;
}

// ---- sdlc metrics / costs -----------------------------------------------------------------------------------------

const SUMMARY_ROWS: [string, string, boolean][] = [
  ["acceptance_to_plan_ms", "acceptance to plan", true], ["acceptance_to_first_review_ms", "acceptance to first review", true], ["acceptance_to_merge_ms", "acceptance to merge", true],
  ["rework_rounds", "rework rounds", false], ["same_head_ci_reruns", "same-head CI reruns", false], ["stale_head_re_reviews", "stale-head re-reviews", false],
  ["review_rounds_at_merge", "review rounds at merge", false], ["ci_runs_at_merge", "CI runs at merge", false], ["github_reviews_at_merge", "GitHub reviews at merge", false],
];
const BAND_TONE: Record<string, Tone> = { ok: "success", log: "muted", diagnose: "attention", propose: "failure" };
/** `ahub sdlc metrics [--since ...]`: times and counts from board history, the two approval rates, stalls and band tiers. */
export function renderSdlcMetrics(result: unknown, columns?: number, now = Date.now()): Span[][] {
  const m = result as any;
  const out: Line[] = [...heading("SDLC metrics", columns)];
  out.push(...pair("window", m?.since === null || m?.since === undefined ? "all recorded history" : `since ${moment(m.since, now)}`, columns, 10),
    ...pair("tasks", `${m?.tasks ?? 0} counted${m?.withheldPrivate ? `, ${m.withheldPrivate} private withheld` : ""}`, columns, 10));
  const metrics = m?.metrics ?? {};
  const value = (n: unknown, time: boolean) => time ? span(n) : count(n);
  out.push(blank, ...grid(["METRIC", "N", "UNKNOWN", "MEAN", "MEDIAN", "P90", "MAX"], SUMMARY_ROWS.map(([key, label, time]) => {
    const x = metrics[key] ?? {};
    return [s(label), s(count(x.n)), s(count(x.unknown), x.unknown ? "attention" : "muted"), s(value(x.mean, time)), s(value(x.median, time)), s(value(x.p90, time)), s(value(x.max, time))];
  }), columns));
  out.push(blank, ...grid(["RATE", "N", "UNKNOWN", "VALUE"], [["first_pass_approval", "first-pass approval"], ["first_pass_check", "first-pass check"]].map(([key, label]) => {
    const x = metrics[key!] ?? {};
    return [s(label), s(count(x.n)), s(count(x.unknown), x.unknown ? "attention" : "muted"), s(percent(x.rate), x.rate === null || x.rate === undefined ? "muted" : "number")];
  }), columns));
  const st = m?.stalls;
  if (st) out.push(blank, ...pair("stalls", `${st.open ?? 0} open${Object.keys(st.byKind ?? {}).length ? ` (${Object.entries(st.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, ${st.doneWithoutWrites ?? 0} done without writes`, columns, 10, st.open ? "attention" : undefined));
  if (m?.bands === "off" || m?.bands === undefined) out.push(...pair("bands", "off", columns, 10, "muted"));
  else {
    out.push(blank, ...grid(["BAND", "TIER", "BASELINE", "LAST", "Z", "SUBJECT"], list(m.bands).map((b: any) => [s(String(b.metric).replaceAll("_", " ")), s(b.tier, BAND_TONE[b.tier] ?? undefined), s(count(b.baseline)), s(count(b.last)), s(count(b.z)), s(b.lastTask ? `${b.subject === "release" ? "release " : b.subject === "scan" ? "scan " : ""}#${b.lastTask}` : "-", "taskRef")]), columns));
    for (const b of list(m.bands)) if (b.reason && b.tier !== "ok") out.push(...para(`${String(b.metric).replaceAll("_", " ")}: ${b.reason}`, columns, "muted", "  ", 2));
  }
  return out;
}
/** `ahub sdlc costs [repo]`: review and CI cost of each linked merged PR, grouped by repository. */
export function renderSdlcCosts(result: unknown, columns?: number, _now = Date.now()): Span[][] {
  const c = result as any;
  const rows = list(c?.rows);
  const out: Line[] = [...heading("SDLC costs", columns)];
  if (!rows.length) out.push([s("no linked merged PR has cost evidence", "muted")]);
  const repos = [...new Set(rows.map(row => String(row.repo)))];
  for (const repo of repos) {
    out.push(...(out.length > 1 ? [blank] : []), ...wrap(repo, room(columns), 2).map((line): Line => [s(line, "info")]), ...grid(["PR", "ROUNDS", "CI", "RERUNS", "FULL", "DELTA", "REVIEW", "UNK", "OK"], rows.filter(row => String(row.repo) === repo).map(row => [
      s(`#${row.pr}`, "issueRef"), s(count(row.reviewRounds)), s(count(row.ciRuns)), s(count(row.ciReruns)), s(count(row.fullReReviews)), s(count(row.deltaReviews)), s(span(row.reviewMs)),
      s(count(row.unknownReviewScopes), row.unknownReviewScopes ? "attention" : "muted"), s(row.complete ? "yes" : "no", row.complete ? "success" : "attention")]), columns));
  }
  if (c?.truncated) out.push(blank, ...para("truncated: more PRs than one read covers, or a read was incomplete", columns, "attention"));
  if (c?.privateTasks === "withheld") out.push(...para("private tasks are withheld", columns, "muted"));
  return out;
}

// ---- sdlc authorize-release ---------------------------------------------------------------------------------------

/** `ahub sdlc authorize-release <version>`: what the person just approved. */
export function renderAuthorization(authorization: unknown, columns?: number, now = Date.now()): Span[][] {
  const a = authorization as any;
  const w = 8;
  return [...heading("Release authorized", columns),
    ...pair("version", a?.version ?? "unknown", columns, w), ...pair("commit", short(a?.commit), columns, w), ...pair("by", a?.by ?? "unknown", columns, w),
    ...pair("at", moment(a?.at, now), columns, w), ...pair("docs", a?.docs ? `${a.docs.fresh ? "fresh" : "not fresh"}, ${plural(a.docs.documents ?? 0, "document")}, digest ${short(a.docs.digest)}` : "unknown", columns, w),
    ...pair("id", a?.id ?? "unknown", columns, w, "muted"), blank,
    ...para("A daemon restart revokes this authorization.", columns, "muted")];
}
