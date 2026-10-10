import { cells, TABLES, table, fitLine, wrap, relative, terminalText, initialConsoleState, stateTone, type Span, type Tone } from "./console-state.ts";
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
  return (columns === undefined ? [flat(indent + text)] : wrap(indent + text, columns)).map(text => [span(text, tone)]);
}
/** Prepare complete physical cells for the console table; its clipping path never discards one-shot text. */
function rows(head: string[], data: Span[][], columns?: number, details?: Span[][][]): Span[][] {
  if (!data.length) return [];
  const keep = head.map((_, i) => i).filter(i => !data.every(row => flat(row[i]?.text) === "-"));
  head = keep.map(i => head[i]!); data = data.map(row => fitLine(keep.map(i => ({ ...row[i]!, text: flat(row[i]?.text) })), Infinity));
  const natural = head.map((h, i) => Math.max(width(h), ...data.map(row => width(row[i]!.text))));
  const gap = 2 * (head.length - 1);
  if (columns === undefined) {
    const limit = Math.max(natural.reduce((a, b) => a + b, 0) + gap + 2, ...natural.map(n => n * 3));
    const result = table(head, data, limit);
    // The console reserves the full remaining width for TITLE before STAGE. Pipes keep natural-width rows.
    const title = head.indexOf("TITLE");
    if (head.includes("STAGE") && title >= 0) for (const line of result) {
      const cell = line[title]!; cell.text = cell.text.trimEnd() + " ".repeat(Math.max(0, natural[title]! - width(cell.text.trimEnd())) + 2);
    }
    return details ? [result[0]!, ...result.slice(1).flatMap((line, i) => [line, ...(details[i] ?? [])])] : result;
  }
  const cap = Math.max(24, Math.floor(columns / 3));
  const widths = natural.map(n => Math.min(cap, n));
  const flexible = head.includes("STAGE") ? head.indexOf("TITLE") : head.length - 1;
  const available = Math.max(head.reduce((sum, h) => sum + width(h), 0), columns - gap - (head.includes("STAGE") ? 2 : 0));
  while (widths.reduce((a, b) => a + b, 0) > available) {
    const choices = widths.map((n, i) => ({ i, excess: n - width(head[i]!) })).filter(x => x.excess > 0);
    if (!choices.length) break;
    choices.sort((a, b) => b.excess - a.excess); widths[choices[0]!.i]!--;
  }
  const lengths: number[] = [];
  const physical = data.flatMap(row => {
    const chunks = row.map((cell, i) => wrap(cell.text, Math.max(1, widths[i]!), 0));
    const length = Math.max(...chunks.map(c => c.length)); lengths.push(length);
    return Array.from({ length }, (_, n) => row.map((cell, i) => ({ ...cell, text: chunks[i]![n] ?? "" })));
  });
  // Pin widths without adding visible rows: table's measured widths are supplied by its header cells.
  const paddedHead = head.map((h, i) => h + " ".repeat(Math.max(0, widths[i]! - width(h))));
  // TITLE/STAGE are structural keys in table(), so keep those exact and let its existing flex logic size TITLE.
  if (head.includes("STAGE")) { paddedHead[flexible] = "TITLE"; paddedHead[head.indexOf("STAGE")] = "STAGE"; }
  const rendered = table(paddedHead, physical, columns);
  if (!details) return rendered;
  let at = 1;
  return [rendered[0]!, ...lengths.flatMap((length, i) => { const group = rendered.slice(at, at + length); at += length; return [...group, ...(details[i] ?? [])]; })];
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
    if (p.heldBy) out.push(...detail("held", `${shortId(p.heldBy, columns, full)}${p.holdNote ? `: ${flat(p.holdNote)}` : ""}; ahub queue resolve ${p.heldBy} --action completed|retry|discard --reason <text>`, columns, "failure"));
    if (p.paused) out.push(...detail("paused", typeof p.paused === "object" ? `${p.paused.by ?? "paused"}${p.paused.reason ? `: ${p.paused.reason}` : ""}${typeof p.paused.at === "number" ? ` ${relative(p.paused.at, now)}` : ""}` : p.paused, columns, "attention"));
    if (p.toolsOnly) out.push(...detail("tools-only", p.toolsOnly, columns, "attention"));
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
export function renderBoard(tasks: any[], columns?: number, now = Date.now(), _full = false): Span[][] {
  if (!tasks.length) return [[span("no tasks")]];
  const s = initialConsoleState(); s.panel = 3; s.tasks = tasks;
  const progress = taskProgress(tasks); const stages = new Map(progress.stages.map(stage => [stage.id, stage]));
  const data = tasks.map(task => {
    const row = cells(s, task, false, now, stages);
    row[2] = span(row[2]!.text, peerTone(task.owner ?? ""));
    row[3] = span(row[3]!.text, peerTone(task.reviewer ?? ""));
    row[6] = span(`${task.title}${task.deps?.length ? `  after ${task.deps.map((id: number) => `#${id}`).join(", ")}` : ""}${task.signals?.includes("pii") ? `  (ahub task show ${task.id})` : ""}`);
    return row;
  });
  const counts = [...new Set(tasks.map(task => task.state))].map(state => `${tasks.filter(task => task.state === state).length} ${state}`).join(", ");
  return [...rows([...TABLES[3]!], data, columns), [], ...lines(`${tasks.length} tasks: ${counts}`, columns)];
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
