import { cells, TABLES, table, fitLine, wrap, relative, plural, terminalText, initialConsoleState, stateTone, type Span, type Tone } from "./console-state.ts";
import { taskProgress } from "../ui/task-progress.ts";
import { backendLabel } from "./status-lines.ts";

export interface DoctorCheck { section: "Tools" | "Hub" | "Config" | "Models" | "Memory"; level: "ok" | "warn" | "fail" | "unknown"; name: string; detail: string }
export interface StatusOutput {
  pid?: number; controlPort?: number; cwd?: string; version?: string; peers: Record<string, any>; budget?: Record<string, any>;
  tasks?: Record<string, number>; models?: { backends?: any[] }; permissionDefaults?: any[]; deliveryError?: string; crash?: string[]; switchyard?: string;
}
export interface BudgetOutput { budget: Record<string, any>; gate?: number }
export function outputWidth(env: { isTTY: boolean; columns?: number; COLUMNS?: string }): number | undefined {
  if (env.isTTY) return Math.max(80, Number.isFinite(env.columns) ? env.columns! : 80);
  return env.COLUMNS && /^[1-9][0-9]*$/.test(env.COLUMNS) && Number.isSafeInteger(Number(env.COLUMNS)) ? Number(env.COLUMNS) : undefined;
}
const span = (text: unknown, tone?: Tone): Span => ({ text: String(text ?? ""), ...(tone ? { tone } : {}) });
const flat = (value: unknown) => terminalText(value).replace(/[\n\t]/g, " ");
const width = (value: string) => Bun.stringWidth(value);
const peerTone = (id: string): Tone | undefined => id === "claude" ? "peerClaude" : id === "codex" ? "peerCodex" : undefined;
const shortId = (id: unknown, columns?: number, full = false) => full || columns === undefined ? String(id) : String(id).slice(0, 8);
function lines(text: string, columns?: number, tone?: Tone, indent = ""): Span[][] {
  return (columns === undefined ? [flat(indent + text)] : wrap(flat(indent + text), columns)).map(text => [span(text, tone)]);
}
/** Wrap complete cells before handing canonical headers and explicit widths to the shared console table. */
function rows(head: string[], data: Span[][], columns?: number, details?: Span[][][]): Span[][] {
  if (!data.length) return [];
  const keep = head.map((_, i) => i).filter(i => !data.every(row => flat(row[i]?.text) === "-"));
  head = keep.map(i => head[i]!); data = data.map(row => fitLine(keep.map(i => ({ ...row[i]!, text: flat(row[i]?.text) })), Infinity));
  const natural = head.map((h, i) => Math.max(width(h), ...data.map(row => width(row[i]!.text))));
  const interleave = (rendered: Span[][], lengths: number[], headerHeight = 1) => {
    if (!details) return rendered;
    let at = headerHeight;
    return [...rendered.slice(0, headerHeight), ...lengths.flatMap((length, i) => { const group = rendered.slice(at, at + length); at += length; return [...group, ...(details[i] ?? [])]; })];
  };
  if (columns === undefined) return interleave(table(head, data, Infinity, natural), data.map(() => 1));
  if (head.length === 1) {
    const size = Math.min(columns, natural[0]!);
    const lengths = data.map(row => wrap(row[0]!.text, size, 0).length);
    const physical = data.flatMap(row => wrap(row[0]!.text, size, 0).map(text => [{ ...row[0]!, text }]));
    return interleave(table(head, physical, columns, [size]), lengths, wrap(head[0]!, size, 0).length);
  }
  const flexible = head.includes("TITLE") ? head.indexOf("TITLE") : head.length - 1;
  const protectedColumns = new Set(head.map((h, i) => ["ID", "OWNER", "REVIEWER", "AGE", "STAGE", "Q", "!", "REVIEW", "REV", "PEER", "STATE", "MODE", "LEVEL", "LINK", "CLASS"].includes(h) ? i : -1));
  const words = head.map((_, i) => Math.max(...data.flatMap(row => row[i]!.text.split(/\s+/).map(width))));
  const minimum = head.map((h, i) => Math.max(width(h), protectedColumns.has(i) ? words[i]! : 0));
  // Context gets a readable soft minimum only after ids, counters and other atomic metadata have their room.
  if (head[flexible] === "CONTEXT") {
    const remaining = columns - 2 * (head.length - 1) - minimum.reduce((sum, n, i) => sum + (i === flexible ? 0 : n), 0);
    minimum[flexible] = Math.max(width(head[flexible]!), Math.min(natural[flexible]!, 12, remaining));
  }
  // Narrow tables become linked bands before an id, peer, age, counter or state word would split.
  if (minimum.reduce((sum, n) => sum + n, 0) + 2 * (head.length - 1) > columns) {
    const bands: number[][] = []; let band = [0];
    for (let i = 1; i < head.length; i++) {
      if ([...band, i].reduce((sum, index) => sum + minimum[index]!, 0) + 2 * band.length > columns) {
        bands.push(band);
        band = minimum[0]! + minimum[i]! + 2 <= columns ? [0] : [];
      }
      band.push(i);
    }
    bands.push(band);
    return bands.flatMap((indices, i) => [...(i ? [[]] : []), ...rows(indices.map(index => head[index]!), data.map(row => indices.map(index => row[index]!)), columns, i === bands.length - 1 ? details : undefined)]);
  }
  const available = columns - 2 * (head.length - 1);
  const widths = natural.map((n, i) => i === flexible ? Math.max(minimum[i]!, Math.min(n, 12)) : Math.max(minimum[i]!, Math.min(n, Math.max(24, Math.floor(columns / 3)))));
  // Whole state phrases have priority too: they shrink to word boundaries only if the other columns need the room.
  for (const i of protectedColumns) if (i >= 0) widths[i] = natural[i]!;
  while (widths.reduce((sum, n) => sum + n, 0) > available) {
    const choices = widths.map((n, i) => ({ i, excess: n - minimum[i]! })).filter(item => item.excess > 0);
    if (!choices.length) break;
    choices.sort((a, b) => Number(b.i === flexible) - Number(a.i === flexible) ||
      Number(protectedColumns.has(a.i)) - Number(protectedColumns.has(b.i)) || b.excess - a.excess);
    widths[choices[0]!.i]!--;
  }
  widths[flexible] = Math.max(minimum[flexible]!, Math.min(natural[flexible]!, available - widths.reduce((sum, n, i) => sum + (i === flexible ? 0 : n), 0)));
  const lengths: number[] = [];
  const physical = data.flatMap(row => {
    const chunks = row.map((cell, i) => wrap(cell.text, widths[i]!, 0));
    const length = Math.max(...chunks.map(c => c.length)); lengths.push(length);
    return Array.from({ length }, (_, n) => row.map((cell, i) => ({ ...cell, text: chunks[i]![n] ?? "" })));
  });
  return interleave(table(head, physical, columns, widths), lengths);
}
function detail(label: string, text: unknown, columns?: number, tone?: Tone): Span[][] {
  return lines(`${label}  ${flat(text)}`, columns, tone, "  ");
}
function contextText(p: any, now: number): string {
  const c = p.context;
  if (!c) return "unknown";
  return `${c.used === null || c.used === undefined ? "unknown" : `${Math.round(c.used * 100)}%`}${c.freshness === "stale" ? " stale" : ""}${typeof c.measuredAt === "number" ? ` ${relative(c.measuredAt, now)}` : ""}${c.source ? ` ${c.source}` : ""}`;
}
export function renderStatus(data: StatusOutput, columns?: number, now = Date.now(), full = false): Span[][] {
  const out = lines(`agent-hub${data.version ? ` ${data.version}` : ""}  pid ${data.pid ?? "unknown"}  control 127.0.0.1:${data.controlPort ?? "unknown"}`, columns, "info");
  if (data.cwd) out.push(...lines(data.cwd, columns));
  if (data.deliveryError) out.push(...detail("delivery storage", `${data.deliveryError}; dispatch is stopped`, columns, "failure"));
  for (const pending of data.permissionDefaults ?? []) out.push(...detail("permission default", `${pending.peer}: never-ask from ${pending.source}, stays ask until a person confirms in ahub console`, columns, "attention"));
  for (const crash of data.crash ?? []) out.push(...detail("crash recovery", crash, columns, "attention"));
  const s = initialConsoleState(); s.panel = 1; s.peers = data.peers; s.budget = data.budget ?? {};
  const head = Object.values(data.peers).some(p => p.permissionMode && p.permissionMode !== "ask") ? ["PEER", "STATE", "MODE", ...TABLES[1]!.slice(2)] : [...TABLES[1]!];
  head.push("CONTEXT");
  const peerRows = Object.entries(data.peers).map(([id, p]) => {
    const result = cells(s, { id, ...p }, false, now); result[0] = span(id, peerTone(id));
    result.push(span(contextText(p, now))); return result;
  });
  let settling = false;
  const peerDetails = Object.entries(data.peers).map(([id, p]) => {
    const out: Span[][] = [];
    if (p.liveAccepted?.length) { settling = true; out.push(...detail("settling", p.liveAccepted.map((v: string) => shortId(v, columns, full)).join(", "), columns, "attention")); }
    if (p.heldBy) {
      const note = flat(p.holdNote ?? "");
      const command = `ahub queue resolve ${p.heldBy} --action completed|retry|discard --reason <text>`;
      const normalized = note.startsWith(`held by needs_review ${p.heldBy}`)
        ? note.replace(`held by needs_review ${p.heldBy}`, `by needs_review ${shortId(p.heldBy, columns, full)}`)
        : `${shortId(p.heldBy, columns, full)}${note ? `: ${note}` : ""}`;
      out.push(...detail("held", `${normalized}${note.includes(`ahub queue resolve ${p.heldBy}`) ? "" : `; ${command}`}`, columns, "failure"));
    }
    if (p.paused) {
      const budgetPause = s.budget[id]?.paused;
      const pauseText = budgetPause ? `budget: ${budgetPause.reason ?? "threshold"}${typeof budgetPause.resetsAt === "number" ? `; resets ${relative(budgetPause.resetsAt, now)}` : "; reset unknown"}`
        : typeof p.paused === "object" ? `${p.paused.by ?? "paused"}${p.paused.reason ? `: ${p.paused.reason}` : ""}${typeof p.paused.at === "number" ? ` ${relative(p.paused.at, now)}` : ""}`
        : flat(p.paused).replace(/^(budget: .*), resets .+$/, "$1; reset unknown");
      out.push(...detail("paused", pauseText, columns, "attention"));
    }
    if (p.toolsOnly) out.push(...detail("tools-only", flat(p.toolsOnly).replace(/^tools-only:\s*/, ""), columns, "attention"));
    if (p.requestedModel && p.servedBy && p.requestedModel !== p.servedBy) out.push(...detail("requested model", p.requestedModel, columns));
    if (typeof p.oldestQueuedAt === "number") out.push(...detail(`${id} oldest queued`, relative(p.oldestQueuedAt, now), columns, "muted"));
    return out;
  });
  if (peerRows.length) out.push([], ...rows(head, peerRows, columns, peerDetails));
  else out.push(...lines("no peers attached yet (ahub claude | ahub codex | ahub kimi)", columns));
  if (settling) out.push([], ...lines("settling: the adapter has not confirmed these deliveries yet (Claude: reply or hub_delivery_done). Task state is independent.", columns, "muted"));
  if (data.models?.backends?.length) {
    out.push([], ...rows(["MODEL", "STATE", "ACTIVE", "REQUESTED", "ACTUAL", "PROVIDER"], data.models.backends.map(b => [span(backendLabel(b)), span(b.state ?? "unknown", stateTone(b.state ?? "")), span(b.active || "-"), span(b.requestedModel ?? "-"), span(b.actualModel ?? "-"), span(b.provider ?? "-")]), columns));
    for (const b of data.models.backends) for (const [key, label] of [["coolingUntil", "cooling"], ["failingUntil", "dispatch held"]]) if (b[key!]) { const at = Date.parse(b[key!]); out.push(...detail(`${backendLabel(b)} ${label}`, `${Number.isFinite(at) ? relative(at, now) : "unknown"}${key === "coolingUntil" && typeof b.failures === "number" ? ` after ${b.failures} failures` : key === "failingUntil" ? "; no load moves until then" : ""}`, columns, "attention")); }
  }
  if (data.switchyard) out.push(...detail("switchyard", data.switchyard, columns));
  const counts = Object.entries(data.tasks ?? {}).map(([state, count]) => `${count} ${state}`).join(", ");
  if (counts) out.push([], ...lines(`TASKS  ${counts} (ahub board)`, columns));
  return out;
}
export function renderBoard(tasks: any[], columns?: number, now = Date.now(), _full = false, allTasks: any[] | null = tasks): Span[][] {
  if (!tasks.length) return [[span("no tasks")]];
  const s = initialConsoleState(); s.panel = 3; s.tasks = tasks;
  const stages = allTasks === null ? undefined : new Map(taskProgress(allTasks).stages.map(stage => [stage.id, stage]));
  const data = tasks.map(task => {
    const row = cells(s, task, false, now, stages);
    row[2] = span(row[2]!.text, peerTone(task.owner ?? ""));
    row[3] = span(row[3]!.text, peerTone(task.reviewer ?? ""));
    row[6] = span(`${task.title}${task.deps?.length ? `  after ${task.deps.map((id: number) => `#${id}`).join(", ")}` : ""}${task.signals?.includes("pii") ? `  (ahub task show ${task.id})` : ""}`);
    if (allTasks === null) row.pop();
    return row;
  });
  const counts = [...new Set(tasks.map(task => task.state))].map(state => `${tasks.filter(task => task.state === state).length} ${state}`).join(", ");
  return [...rows(allTasks === null ? TABLES[3]!.slice(0, -1) : [...TABLES[3]!], data, columns), [], ...lines(`${plural(tasks.length, "task")}: ${counts}`, columns)];
}
export function renderBudget(data: BudgetOutput, columns?: number, now = Date.now(), _full = false): Span[][] {
  const out: Span[][] = [];
  const windows = Object.entries(data.budget).flatMap(([peer, b]) => (b.windows ?? []).map((w: any) => [span(peer, peerTone(peer)), span(w.id), span(`${Math.round(w.used * 100)}%`, "number"), span(typeof w.resetsAt === "number" ? relative(w.resetsAt, now) : "-", "muted"), span(w.source ?? "unknown", "muted"), span(typeof w.at === "number" ? relative(w.at, now) : "unknown", "muted"), span(w.stale ? "stale" : "fresh", w.stale ? "attention" : undefined)]));
  if (windows.length) out.push(...rows(["PEER", "WINDOW", "USED", "RESETS", "SOURCE", "MEASURED", "STATE"], windows, columns));
  else out.push(...lines(`no quota readings yet (gate ${data.gate ?? "unknown"}). Sources: Codex rate limits, Claude's status line (ahub claude), ahub budget set.`, columns));
  for (const [peer, b] of Object.entries(data.budget)) if (b.paused) out.push(...detail(`paused ${peer}`, `${b.paused.reason ?? "budget"}${typeof b.paused.resetsAt === "number" ? `; resumes ${relative(b.paused.resetsAt, now)}` : ""}`, columns, "attention"));
  return out;
}
export function renderDoctor(checks: DoctorCheck[], columns?: number, _now = Date.now(), _full = false): Span[][] {
  const out: Span[][] = [];
  const tone = { ok: "success", warn: "attention", fail: "failure", unknown: "muted" } as const;
  for (const section of ["Tools", "Hub", "Config", "Models", "Memory"] as const) {
    const group = checks.filter(check => check.section === section); if (!group.length) continue;
    if (out.length) out.push([]); out.push([span(section, "strong")]);
    out.push(...rows(["LEVEL", "CHECK", "FINDING"], group.map(check => [span(check.level, tone[check.level]), span(check.name), span(check.detail || "finding unknown")]), columns));
  }
  const count = (level: DoctorCheck["level"]) => checks.filter(c => c.level === level).length;
  out.push([], ...lines(`${count("fail")} failure${count("fail") === 1 ? "" : "s"}, ${count("warn")} warning${count("warn") === 1 ? "" : "s"}, ${count("ok")} ok, ${count("unknown")} unknown`, columns));
  return out;
}
