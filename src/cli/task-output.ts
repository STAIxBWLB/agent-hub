// Human output for `ahub task show|cancel`, the backlog mutations and grooming, and the release commands (#814 T2).
// Pure: parsed hub-tool JSON in, spans out. The hub tools keep returning JSON to agents; the CLI parses the text and
// renders it, and `--json` prints that text untouched. Built on the shared `Report` (#1654 AC3): a header, a `▸` section per
// group and key/value rows, with tables from the one `grid`, so every row fits the terminal and no identifier is cut. A private task arrives from the hub as a stub (`[pii]` title
// and detail, empty refs and plan): this module shows that stub and never asks for more.
import { type Span, Report, plural, terminalText } from "./console-state.ts";
import { grid, moment, s } from "./sdlc-output.ts";
import { taskHolderText } from "./role-holders.ts";

type Rows = [string, unknown][];
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const yes = (value: unknown) => value === true ? "yes" : value === false ? "no" : "unknown";
const short = (sha: unknown) => typeof sha === "string" && sha ? sha.slice(0, 8) : "-";
const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : "unknown";
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);
const ids = (values: unknown) => list(values).map(id => `#${id}`).join(" ") || "none";
const when = (at: unknown, now: number) => typeof at === "number" && Number.isFinite(at) ? moment(at, now) : "-";
const isStub = (task: any) => task?.title === "[pii]" && task?.detail === "[pii]";

const planRows = (plan: any): Rows => ["paths", "symbols", "signatures", "insertion_points", "sections", "sources", "claims"]
  .filter(key => list(plan?.[key]).length).map((key): [string, unknown] => [key.replace("_", " "), list(plan[key]).map(item => terminalText(item)).join(", ")]);
const historyRows = (history: any[], now: number): Span[][] => history.map(entry => [s(when(entry.at, now), "muted"), s(entry.instructed && entry.instructedPeer ? `${entry.by ?? "user"} via ${entry.instructedPeer}` : entry.by ?? "-"), s(entry.event ?? "-", entry.event === "approved" ? "success" : entry.event === "changes_requested" ? "attention" : undefined), s(dash(entry.note))]);

/** The one task block: identity, who holds it, what it waits for, then plan, receipt and history. The caller owns the header. */
function taskBlock(out: Report, task: any, now: number, detail: boolean): void {
  const rows: Rows = [["title", dash(task?.title)], ["state", `${dash(task?.state)}${task?.cancelled ? " (cancelled)" : ""}`], ["class", dash(task?.class)], ["owner", taskHolderText(task, "owner")], ["reviewer", taskHolderText(task, "reviewer")]];
  if (typeof task?.reason === "string") rows.push(["reason", task.reason]);
  if (task?.planner !== undefined) rows.push(["planner", taskHolderText(task, "planner")]);
  if (task?.reserved) rows.push(["reserved", task.reserved]);
  // #1454: a recorded wait, with whether it has passed: a passed one means the idle ladder restarts.
  if (task?.wait && typeof task.wait.until === "number") rows.push(["waiting", `${task.wait.passed ? "passed " : "until "}${new Date(task.wait.until).toISOString()}${task.wait.by ? `, set by ${task.wait.by}` : ""}${task.wait.reason ? `: ${task.wait.reason}` : ""}`]);
  if (task?.handoffOrigin) rows.push(["from", `project ${task.handoffOrigin.projectId}, handed off by ${task.handoffOrigin.peer}${typeof task.handoffOrigin.task === "number" ? ` (their task #${task.handoffOrigin.task})` : ""}`]);
  rows.push(["after", ids(task?.deps)]);
  if (typeof task?.release === "number") rows.push(["release", `#${task.release}`]);
  if (typeof task?.rank === "number" || typeof task?.priority === "number") rows.push(["planning", [typeof task.rank === "number" ? `rank ${task.rank}` : "", typeof task.priority === "number" ? `priority P${task.priority}` : "", task.pinned ? "pinned" : ""].filter(Boolean).join(", ")]);
  // The operands the next command needs: backlog plan|pin|split|pull-ready|undo take the planning revision (0 on an unedited card),
  // task cancel and assign --revision take the flow revision. A person must not have to switch to --json to read them.
  const revisions = [task?.state === "backlog" || typeof task?.planningRevision === "number" ? `planning rev ${count(task?.planningRevision ?? 0)}` : "", typeof task?.flowRevision === "number" ? `flow rev ${count(task.flowRevision)}` : ""].filter(Boolean);
  if (revisions.length) rows.push(["revisions", revisions.join(", ")]);
  rows.push(["created", when(task?.created, now)], ["updated", when(task?.updated, now)]);
  out.section("Task").kv(rows);
  if (!detail) return;
  if (isStub(task)) {
    out.section("Private").note("private task: the title, detail, paths and plan are withheld here; read it in a console terminal", "value").next(`ahub task show ${task.id}`);
  } else if (task?.detail) out.section("Detail").note(String(task.detail), "value");
  const refs = task?.refs ?? {};
  const refRows: Rows = [];
  const refText = [refs.repo, refs.branch ? `branch ${refs.branch}` : "", refs.commit ? `commit ${short(refs.commit)}` : ""].filter(Boolean).join(", ");
  if (refText) refRows.push(["refs", refText]);
  if (list(refs.paths).length) refRows.push(["ref paths", list(refs.paths).map(item => terminalText(item)).join(", ")]);
  if (refRows.length) out.section("Refs").kv(refRows);
  if (!isStub(task) && task?.approval) {
    const approval = task.approval;
    out.section("Approval").kv([["approval", `head ${approval.head ?? "unknown"}; latest ${approval.latestHead ?? "unknown"}; ${approval.mismatch ? "HEAD MISMATCH, approval is stale" : approval.current ? "current" : "not current, review required"}`]]);
    if (!approval.current) out.bullet("warn", approval.mismatch ? "approval is stale" : "review required");
  }
  const plan = planRows(task?.plan);
  if (plan.length) out.section("Plan").kv(plan);
  const sdlc = task?.sdlc;
  const context: Rows = [];
  if (sdlc) context.push(["lifecycle", [sdlc.stage ? `stage ${sdlc.stage}` : "", sdlc.repo && sdlc.issue ? `${sdlc.repo}#${sdlc.issue}` : "", sdlc.pr ? `PR #${sdlc.pr}` : "", sdlc.head ? `head ${short(sdlc.head)}` : ""].filter(Boolean).join(", ") || "recorded"]);
  if (task?.relatedMemory) context.push(["memory", `${task.relatedMemory.state}${typeof task.relatedMemory.count === "number" ? `, ${plural(task.relatedMemory.count, "related note")}` : ""}`]);
  if (context.length) out.section("Context").kv(context);
  // Tasks.symbolOverlaps: { task, files, sameFileDifferentSymbols } per overlapping task, public file names only.
  const overlaps = list(task?.symbolOverlaps);
  if (overlaps.length) {
    out.section("Overlaps", String(overlaps.length));
    for (const o of overlaps) out.bullet("warn", `#${o?.task ?? "?"} touches ${list(o?.files).join(", ") || "files withheld"}${o?.sameFileDifferentSymbols ? " (same file, different symbols)" : ""}`);
  }
  // Tasks.deliverableStatus: { state, changedSinceReview, files: [{ id, sha256, state, path?, format, version?, private? }] }.
  const delivered = task?.deliverables;
  if (delivered) {
    out.section("Deliverables", String(list(delivered.files).length)).kv([["deliverables", `${dash(delivered.state)}${delivered.changedSinceReview ? ", changed since review" : ""}`]]);
    if (delivered.changedSinceReview) out.bullet("warn", "changed since review");
    if (list(delivered.files).length) out.append(grid(["FILE", "FORMAT", "STATE", "SHA256"], list(delivered.files).map((file: any) => [s(file.private ? "(private)" : dash(file.path ?? file.id)), s(`${dash(file.format)}${file.version ? ` ${file.version}` : ""}`), s(dash(file.state), file.state === "changed" || file.state === "missing" ? "attention" : undefined), s(short(file.sha256))]), out.columns));
  }
  const reviews = list(task?.reviews);
  if (reviews.length) out.section("Reviews", String(reviews.length)).append(grid(["KIND", "REVIEWER", "AT"], reviews.map((r: any) => [s(r.kind, r.kind === "approved" ? "success" : "attention"), s(r.reviewer), s(when(r.at, now), "muted")]), out.columns));
  const history = list(task?.history);
  if (history.length) {
    out.section("History", String(history.length));
    if (typeof task?.flowRevision === "number" && task.flowRevision > history.length) out.note(`${plural(history.length, "entry")}, last ${history.length} shown`);
    out.append(grid(["AT", "BY", "EVENT", "NOTE"], historyRows(history, now), out.columns));
  }
}

/** `ahub task show <id>`: the full block. A task that does not exist arrives as a JSON string and prints as that sentence. */
export function renderTaskShow(task: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  if (typeof task === "string") return new Report(columns, ascii).header("ahub", "Task").note(task, "value").lines();
  const out = new Report(columns, ascii).titled("ahub", "Task", `#${(task as any)?.id ?? "?"}`, true);
  taskBlock(out, task, now, true);
  return out.lines();
}

/** `ahub task cancel`: the cancelled task, with who superseded it and why. */
export function renderTaskCancel(task: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const t = task as any;
  const out = new Report(columns, ascii).titled("ahub", `Task #${t?.id ?? "?"} cancelled`);
  taskBlock(out, t, now, false);
  const c = t?.cancelled;
  if (c) out.section("Cancelled").kv([["reason", dash(c.reason)], ...(c.supersededBy ? [["superseded", String(c.supersededBy)] as [string, unknown]] : [])]);
  return out.lines();
}

const BACKLOG_HEAD: Record<string, string> = { plan: "Backlog card planned", pin: "Backlog card pinned", "return-untouched": "Task returned to the backlog", "pull-ready": "Backlog card pulled and routed", undo: "Planning change undone", split: "Backlog card split" };
/** The backlog mutations: the card as the hub now holds it; a split shows its parent and each child. */
export function renderBacklogResult(op: keyof typeof BACKLOG_HEAD, result: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const r = result as any;
  const out = new Report(columns, ascii).titled("ahub", BACKLOG_HEAD[op] ?? "Backlog");
  if (op === "split") {
    taskBlock(out, r?.parent, now, false);
    const children = list(r?.children);
    out.section("Children", String(children.length));
    if (children.length) out.append(grid(["ID", "STATE", "AFTER", "TITLE"], children.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.state)), s(ids(c.deps)), s(dash(c.title))]), columns));
    else out.note("no child cards");
    if (children.length) out.note(plural(children.length, "child card"));
    return out.lines();
  }
  taskBlock(out, r, now, false);
  if (isStub(r)) out.section("Private").note("private task: the title, detail, paths and plan are withheld here; read it in a console terminal", "value").next(`ahub task show ${r.id}`);
  const last = list(r?.history).at(-1);
  if (last?.note) out.section("Note").note(String(last.note), "value");
  return out.lines();
}

const GROOM_TEXT: Record<string, string> = { "text-dependency": "text names a dependency the card does not declare", overlap: "overlaps other open work", duplicate: "may duplicate another card", "over-wip": "its owner is over the WIP limit", stale: "has not moved for a long time", superseded: "was superseded", blocked: "cannot be routed", "closed-issue": "its issue is closed", "wait-passed": "its recorded wait has passed, so the idle sweep runs again: record a new wait or check the owner" };
/** `ahub backlog groom`: what the planner would look at, one line per finding. */
export function renderGroom(digest: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const d = digest as any;
  const items = list(d?.items);
  const out = new Report(columns, ascii).header("ahub", "Backlog grooming");
  if (!items.length) out.note("nothing to groom");
  else {
    out.section("Findings", String(items.length)).append(grid(["TASK", "FINDING", "RELATED", "CODE"], items.map((i: any) => [s(`#${i.task}`, "taskRef"), s(GROOM_TEXT[i.kind] ?? String(i.kind)), s(i.related?.length ? ids(i.related) : "-"), s(dash(i.code), "muted")]), columns));
    const commands = items.filter((item: any) => item.personCommand).map((item: any): [string, unknown] => [`#${item.task}`, String(item.personCommand)]);
    if (commands.length) out.section("Person commands").kv(commands);
  }
  if (list(d?.unknown).length) out.bullet("unknown", `${ids(d.unknown)}: not enough evidence to judge`);
  if (d?.truncated) out.bullet("warn", "truncated: the board has more cards than one grooming pass reads");
  if (d?.privateTasks === "withheld") out.note("private tasks are withheld");
  return out.lines();
}

function releaseBlock(out: Report, row: any, now: number): void {
  const rows: Rows = [["name", dash(row?.name)], ["state", dash(row?.state)], ["goal", dash(row?.goal)], ["order", count(row?.order)], ["revision", count(row?.revision)], ["planned start", when(row?.plannedStart, now)], ["cut", when(row?.cut, now)], ["ship", when(row?.ship, now)]];
  const tasks = list(row?.tasks);
  rows.push(["scope", tasks.length ? `${plural(tasks.length, "task")}: ${tasks.map((t: any) => `#${t.id} ${t.state}`).join(", ")}` : "no task assigned"]);
  if (row?.afterCut !== undefined && row?.afterCut !== null) rows.push(["after the cut", `${count(row.afterCutCount)} approved outside this release: ${ids(row.afterCut)}${row.afterCutCount > list(row.afterCut).length ? " and more" : ""}`]);
  if (row?.afterCutUnknownCount) rows.push(["unknown date", `${count(row.afterCutUnknownCount)} approved without a recorded date: ${ids(row.afterCutUnknown)}`]);
  if (row?.train) rows.push(["train", `${yes(row.train.active)} active${row.train.hotfix ? `, hotfix ${row.train.hotfix}` : ""}`]);
  out.section(`Release #${row?.id ?? "?"}`).kv(rows);
}
/** `ahub release list`: one block per release, in order. */
export function renderReleaseList(rows: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] {
  const releases = list(rows);
  const out = new Report(columns, ascii).titled("ahub", "Releases", releases.length ? plural(releases.length, "release") : undefined);
  if (!releases.length) return out.note("no releases").lines();
  for (const row of releases) releaseBlock(out, row, now);
  return out.lines();
}
/** `ahub release show <name>` and the result of `release new|plan|activate|freeze|ship|drop`: the release as the hub holds it. */
export function renderReleaseShow(row: unknown, columns?: number, now = Date.now(), ascii = false, title = "Release"): Span[][] {
  if (typeof row === "string") return new Report(columns, ascii).header("ahub", title).note(row, "value").lines();
  const out = new Report(columns, ascii).titled("ahub", title);
  releaseBlock(out, row, now);
  return out.lines();
}
export const renderReleaseChange = (row: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] => renderReleaseShow(row, columns, now, ascii, "Release updated");
export const renderReleaseNew = (row: unknown, columns?: number, now = Date.now(), ascii = false): Span[][] => renderReleaseShow(row, columns, now, ascii, "Release created");
