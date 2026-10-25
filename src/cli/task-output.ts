// Human output for `ahub task show|cancel`, the backlog mutations and grooming, and the release commands (#814 T2).
// Pure: parsed hub-tool JSON in, spans out. The hub tools keep returning JSON to agents; the CLI parses the text and
// renders it, and `--json` prints that text untouched. Built from the same primitives as sdlc-output.ts (#814 T1), so
// every table fits the terminal and no identifier is cut. A private task arrives from the hub as a stub (`[pii]` title
// and detail, empty refs and plan): this module shows that stub and never asks for more.
import { type Span, type Tone, plural } from "./console-state.ts";
import { blank, bullets, count, grid, heading, list, moment, pair, para, s, short, yes } from "./sdlc-output.ts";

type Line = Span[];
const dash = (value: unknown) => value === undefined || value === null || value === "" ? "-" : String(value);
const ids = (values: unknown) => list(values).map(id => `#${id}`).join(" ") || "none";
const when = (at: unknown, now: number) => typeof at === "number" && Number.isFinite(at) ? moment(at, now) : "-";
const STATE_TONE: Record<string, Tone> = { approved: "success", in_review: "attention", in_progress: "info", proposed: "muted", backlog: "muted", cancelled: "muted", blocked: "failure" };
const stateTone = (state: unknown): Tone | undefined => typeof state === "string" ? STATE_TONE[state] : undefined;
const isStub = (task: any) => task?.title === "[pii]" && task?.detail === "[pii]";

/** The first task of a result: a stub when the hub withheld it, which says so in one line and points at the console. */
function stubNote(task: any, columns: number | undefined): Line[] {
  return isStub(task) ? [blank, ...para(`private task: the title, detail, paths and plan are withheld here. Read it where it is allowed: \`ahub task show ${task.id}\` in a console terminal.`, columns, "muted")] : [];
}
const planBlock = (plan: any, columns: number | undefined): Line[] => {
  const keys = ["paths", "symbols", "signatures", "insertion_points", "sections", "sources", "claims"];
  return keys.flatMap(key => bullets(key.replace("_", " "), list(plan?.[key]), columns, undefined, "  "));
};
const historyRows = (history: any[], now: number): Span[][] => history.map(entry => [s(when(entry.at, now), "muted"), s(entry.by ?? "-"), s(entry.event ?? "-", entry.event === "approved" ? "success" : entry.event === "changes_requested" ? "attention" : undefined), s(dash(entry.note))]);

/** The one task block: identity, who holds it, what it waits for, then plan, receipt and history. */
function taskBlock(task: any, columns: number | undefined, now: number, detail: boolean): Line[] {
  const id = `#${task?.id ?? "?"}`;
  const out: Line[] = [...para(`${id}  ${dash(task?.title)}`, columns, undefined, "", 6).map((line, i): Line => i === 0 ? [s(id, "taskRef"), s(line[0]!.text.slice(id.length), "strong")] : line)];
  const w = 10;
  out.push(...pair("state", `${dash(task?.state)}${task?.cancelled ? " (cancelled)" : ""}`, columns, w, stateTone(task?.state), "  "),
    ...pair("class", dash(task?.class), columns, w, undefined, "  "), ...pair("owner", dash(task?.owner), columns, w, undefined, "  "), ...pair("reviewer", dash(task?.reviewer), columns, w, undefined, "  "));
  if (task?.planner) out.push(...pair("planner", task.planner, columns, w, undefined, "  "));
  if (task?.reserved) out.push(...pair("reserved", task.reserved, columns, w, undefined, "  "));
  out.push(...pair("after", ids(task?.deps), columns, w, undefined, "  "));
  if (typeof task?.release === "number") out.push(...pair("release", `#${task.release}`, columns, w, undefined, "  "));
  if (typeof task?.rank === "number" || typeof task?.priority === "number") out.push(...pair("planning", [typeof task.rank === "number" ? `rank ${task.rank}` : "", typeof task.priority === "number" ? `priority P${task.priority}` : "", task.pinned ? "pinned" : ""].filter(Boolean).join(", "), columns, w, undefined, "  "));
  out.push(...pair("created", when(task?.created, now), columns, w, undefined, "  "), ...pair("updated", when(task?.updated, now), columns, w, undefined, "  "));
  if (!detail) return out;
  out.push(...stubNote(task, columns));
  if (!isStub(task) && task?.detail) out.push(blank, [s("detail", "muted")], ...para(String(task.detail), columns, undefined, "  ", 2));
  const refs = task?.refs ?? {};
  const refText = [refs.repo, refs.branch ? `branch ${refs.branch}` : "", refs.commit ? `commit ${short(refs.commit)}` : ""].filter(Boolean).join(", ");
  if (refText) out.push(blank, ...pair("refs", refText, columns, w, undefined, "  "));
  out.push(...bullets("ref paths", list(refs.paths), columns, undefined, "  "));
  const plan = planBlock(task?.plan, columns);
  if (plan.length) out.push(blank, [s("plan", "muted")], ...plan);
  const sdlc = task?.sdlc;
  if (sdlc) out.push(blank, ...pair("lifecycle", [sdlc.stage ? `stage ${sdlc.stage}` : "", sdlc.repo && sdlc.issue ? `${sdlc.repo}#${sdlc.issue}` : "", sdlc.pr ? `PR #${sdlc.pr}` : "", sdlc.head ? `head ${short(sdlc.head)}` : ""].filter(Boolean).join(", ") || "recorded", columns, w, undefined, "  "));
  if (task?.relatedMemory) out.push(...pair("memory", `${task.relatedMemory.state}${typeof task.relatedMemory.count === "number" ? `, ${plural(task.relatedMemory.count, "related note")}` : ""}`, columns, w, undefined, "  "));
  // Tasks.symbolOverlaps: { task, files, sameFileDifferentSymbols } per overlapping task, public file names only.
  if (list(task?.symbolOverlaps).length) out.push(...bullets("overlaps", list(task.symbolOverlaps).map((o: any) => `#${o?.task ?? "?"} touches ${list(o?.files).join(", ") || "files withheld"}${o?.sameFileDifferentSymbols ? " (same file, different symbols)" : ""}`), columns, "attention", "  "));
  // Tasks.deliverableStatus: { state, changedSinceReview, files: [{ id, sha256, state, path?, format, version?, private? }] }.
  const delivered = task?.deliverables;
  if (delivered) {
    out.push(blank, ...pair("deliverables", `${dash(delivered.state)}${delivered.changedSinceReview ? ", changed since review" : ""}`, columns, w, delivered.changedSinceReview ? "attention" : undefined, "  "));
    out.push(...grid(["FILE", "FORMAT", "STATE", "SHA256"], list(delivered.files).map((file: any) => [s(file.private ? "(private)" : dash(file.path ?? file.id)), s(`${dash(file.format)}${file.version ? ` ${file.version}` : ""}`), s(dash(file.state), file.state === "changed" || file.state === "missing" ? "attention" : undefined), s(short(file.sha256))]), columns));
  }
  const reviews = list(task?.reviews);
  if (reviews.length) out.push(blank, [s("reviews", "muted")], ...grid(["KIND", "REVIEWER", "AT"], reviews.map((r: any) => [s(r.kind, r.kind === "approved" ? "success" : "attention"), s(r.reviewer), s(when(r.at, now), "muted")]), columns));
  const history = list(task?.history);
  if (history.length) out.push(blank, [s(`history (${plural(history.length, "entry")}${typeof task?.flowRevision === "number" && task.flowRevision > history.length ? `, last ${history.length} shown` : ""})`, "muted")], ...grid(["AT", "BY", "EVENT", "NOTE"], historyRows(history, now), columns));
  return out;
}

/** `ahub task show <id>`: the full block. A task that does not exist arrives as a JSON string and prints as that sentence. */
export function renderTaskShow(task: unknown, columns?: number, now = Date.now()): Span[][] {
  if (typeof task === "string") return para(task, columns);
  return taskBlock(task, columns, now, true);
}

/** `ahub task cancel`: the cancelled task, with who superseded it and why. */
export function renderTaskCancel(task: unknown, columns?: number, now = Date.now()): Span[][] {
  const t = task as any;
  const out = [...heading(`Task #${t?.id ?? "?"} cancelled`, columns), ...taskBlock(t, columns, now, false)];
  const c = t?.cancelled;
  if (c) out.push(...pair("reason", dash(c.reason), columns, 10, undefined, "  "), ...(c.supersededBy ? pair("superseded", String(c.supersededBy), columns, 10, undefined, "  ") : []));
  return out;
}

const BACKLOG_HEAD: Record<string, string> = { plan: "Backlog card planned", pin: "Backlog card pinned", "return-untouched": "Task returned to the backlog", "pull-ready": "Backlog card pulled and routed", undo: "Planning change undone", split: "Backlog card split" };
/** The backlog mutations: the card as the hub now holds it; a split shows its parent and each child. */
export function renderBacklogResult(op: keyof typeof BACKLOG_HEAD, result: unknown, columns?: number, now = Date.now()): Span[][] {
  const r = result as any;
  const out: Line[] = [...heading(BACKLOG_HEAD[op] ?? "Backlog", columns)];
  if (op === "split") {
    out.push(...taskBlock(r?.parent, columns, now, false));
    const children = list(r?.children);
    out.push(blank, [s(`${plural(children.length, "child card")}`, "muted")], ...grid(["ID", "STATE", "AFTER", "TITLE"], children.map((c: any) => [s(`#${c.id}`, "taskRef"), s(dash(c.state), stateTone(c.state)), s(ids(c.deps)), s(dash(c.title))]), columns));
    return out;
  }
  out.push(...taskBlock(r, columns, now, false), ...stubNote(r, columns));
  const last = list(r?.history).at(-1);
  if (last?.note) out.push(...pair("note", String(last.note), columns, 10, "muted", "  "));
  return out;
}

const GROOM_TEXT: Record<string, string> = { "text-dependency": "text names a dependency the card does not declare", overlap: "overlaps other open work", duplicate: "may duplicate another card", "over-wip": "its owner is over the WIP limit", stale: "has not moved for a long time", superseded: "was superseded", blocked: "cannot be routed", "closed-issue": "its issue is closed" };
/** `ahub backlog groom`: what the planner would look at, one line per finding. */
export function renderGroom(digest: unknown, columns?: number, _now = Date.now()): Span[][] {
  const d = digest as any;
  const items = list(d?.items);
  const out: Line[] = [...heading("Backlog grooming", columns)];
  if (!items.length) out.push([s("nothing to groom", "muted")]);
  else out.push(...grid(["TASK", "FINDING", "RELATED", "CODE"], items.map((i: any) => [s(`#${i.task}`, "taskRef"), s(GROOM_TEXT[i.kind] ?? String(i.kind)), s(i.related?.length ? ids(i.related) : "-"), s(dash(i.code), "muted")]), columns));
  for (const item of items) if (item.personCommand) out.push(...pair(`#${item.task}`, String(item.personCommand), columns, 6, "info", ""));
  if (list(d?.unknown).length) out.push(blank, ...pair("unknown", `${ids(d.unknown)}: not enough evidence to judge`, columns, 8, "attention"));
  if (d?.truncated) out.push(...para("truncated: the board has more cards than one grooming pass reads", columns, "attention"));
  if (d?.privateTasks === "withheld") out.push(...para("private tasks are withheld", columns, "muted"));
  return out;
}

const RELEASE_TONE: Record<string, Tone> = { active: "success", frozen: "attention", shipped: "muted", dropped: "muted", planned: "info" };
function releaseBlock(row: any, columns: number | undefined, now: number): Line[] {
  const w = 14, out: Line[] = [...para(`#${row?.id ?? "?"}  ${dash(row?.name)}`, columns, undefined, "", 6).map((line, i): Line => i === 0 ? [s(`#${row?.id ?? "?"}`, "issueRef"), s(line[0]!.text.slice(`#${row?.id ?? "?"}`.length), "strong")] : line)];
  out.push(...pair("state", dash(row?.state), columns, w, RELEASE_TONE[row?.state], "  "), ...pair("goal", dash(row?.goal), columns, w, undefined, "  "), ...pair("order", count(row?.order), columns, w, undefined, "  "), ...pair("revision", count(row?.revision), columns, w, undefined, "  "));
  out.push(...pair("planned start", when(row?.plannedStart, now), columns, w, undefined, "  "), ...pair("cut", when(row?.cut, now), columns, w, undefined, "  "), ...pair("ship", when(row?.ship, now), columns, w, undefined, "  "));
  const tasks = list(row?.tasks);
  out.push(...pair("scope", tasks.length ? `${plural(tasks.length, "task")}: ${tasks.map((t: any) => `#${t.id} ${t.state}`).join(", ")}` : "no task assigned", columns, w, undefined, "  "));
  if (row?.afterCut !== undefined && row?.afterCut !== null) out.push(...pair("after the cut", `${count(row.afterCutCount)} approved outside this release: ${ids(row.afterCut)}${row.afterCutCount > list(row.afterCut).length ? " and more" : ""}`, columns, w, row.afterCutCount ? "attention" : undefined, "  "));
  if (row?.afterCutUnknownCount) out.push(...pair("unknown date", `${count(row.afterCutUnknownCount)} approved without a recorded date: ${ids(row.afterCutUnknown)}`, columns, w, "attention", "  "));
  if (row?.train) out.push(...pair("train", `${yes(row.train.active)} active${row.train.hotfix ? `, hotfix ${row.train.hotfix}` : ""}`, columns, w, undefined, "  "));
  return out;
}
/** `ahub release list`: one block per release, in order. */
export function renderReleaseList(rows: unknown, columns?: number, now = Date.now()): Span[][] {
  const releases = list(rows);
  if (!releases.length) return [[s("no releases")]];
  return releases.flatMap((row, i): Line[] => [...(i ? [blank] : []), ...releaseBlock(row, columns, now)]);
}
/** `ahub release show <name>` and the result of `release new|plan|activate|freeze|ship|drop`: the release as the hub holds it. */
export function renderReleaseShow(row: unknown, columns?: number, now = Date.now()): Span[][] {
  if (typeof row === "string") return para(row, columns);
  return releaseBlock(row, columns, now);
}
export const renderReleaseChange = (row: unknown, columns?: number, now = Date.now()): Span[][] => [...heading("Release updated", columns), ...renderReleaseShow(row, columns, now)];
export const renderReleaseNew = (row: unknown, columns?: number, now = Date.now()): Span[][] => [...heading("Release created", columns), ...renderReleaseShow(row, columns, now)];
