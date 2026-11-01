import type { QueueBackpressureStatus } from "../hub/queue-backpressure.ts";
import { definitionOf } from "../adapters/registry.ts";
import { windowKind } from "../hub/window-kind.ts";
import { boardColumns, type BoardPeerInput } from "../ui/task-board.ts";
import { peerStyle } from "../ui/peer-palette.ts";
import { cells, TABLES, table, fitLine, wrap, duration, relative, plural, terminalText, initialConsoleState, stateTone, type Span, type Tone } from "./console-state.ts";
import { taskProgress } from "../ui/task-progress.ts";
import { backendLabel } from "./status-lines.ts";
import { ownerIsolationText } from "./role-holders.ts";
import { schedulePeriodText, scheduleWhen } from "../hub/schedules.ts";
import { formatReport, formatTaskReport, type Report, type TaskReport } from "../hub/report.ts";
import type { Counter, LimitsResult, TotalResult, UsageResult } from "../hub/usage-rollup.ts";

export interface DoctorCheck { section: "Tools" | "Hub" | "Config" | "Models" | "Memory"; level: "ok" | "warn" | "fail" | "unknown"; name: string; detail: string }
export interface StatusOutput {
  queueBackpressure?: QueueBackpressureStatus;
  pendingRestart?: readonly { key: string; reason: string }[];
  retainedConfig?: readonly { key: string; reason: string }[];
  /** #572 AC3: advisory, present while the project root checkout is on a branch other than the default. */
  mainCheckout?: string;
  /** #843 AC3: installed agent CLIs not on a verified version; ids, version, state and a receipt path only. */
  agentDrift?: readonly { id: string; version: string; state: string; receipt: string }[];
  /** #512a: one row per machine-local schedule; ids, times and a state only, never task text. */
  schedules?: readonly { id: string; every?: string; cron?: string; zone?: string; class: string; queue: string; next: number; last?: number; task?: number; state: string; coalesced?: number; error?: string }[];
  taskStalls?: readonly { task: number; cause: { kind: string; peer?: string; dependency?: number; code: string } }[];
  pendingTaskOffers?: readonly { task: number; peer: string }[];
  isolatedChecks?: { pending?: number; orphans?: string[]; unknownReceipts?: readonly string[]; maintenanceUnavailable?: boolean };
  memoryRead?: { truncated: boolean; scanned: number; limit: number };
  memoryProfile?: { profile?: string; generation?: string; state?: string; agentMemVersion?: string; skippedRows?: number; error?: string };
  /** #784 AC3: `active`, `reviewWait` and `reserved` add up to `wip`; absent from an older hub. */
  taskWip?: Record<string, { wip: number; wipLimit: number; active?: number; reviewWait?: number; reserved?: number }>;
  pid?: number; controlPort?: number; cwd?: string; version?: string; peers: Record<string, any>; roleInfo?: Record<string, any>; actionPolicyInfo?: Record<string, { note: string; enforceable: boolean }>; budget?: Record<string, any>; planner?: { peers?: string[]; source?: string };
  ownerIsolation?: Record<string, boolean>; ownerIsolationNotes?: Record<string, string>;
  tasks?: Record<string, number>; models?: { backends?: any[] }; permissionDefaults?: any[]; deliveryError?: string; crash?: string[];
}
/** `peers`: one note per peer that shows no number, and why (no quota, nothing read yet); absent from an older hub. */
export interface BudgetOutput { budget: Record<string, any>; gate?: number; peers?: { peer: string; kind?: string; note: string }[] }
export interface RosterRow { peer: string; on: boolean; startMode: string; state: string; queued: number; tasks: number }
export function renderRoster(data: RosterRow[], columns?: number): Span[][] {
  return rows(["PEER", "ROSTER", "START", "STATE", "Q", "TASKS"], data.map(row => [span(row.peer, "info", true), span(row.on ? "on" : "off", row.on ? "success" : "muted", true), span(row.startMode, undefined, true), span(row.state, stateTone(row.state), true), span(row.queued, undefined, true), span(row.tasks, undefined, true)]), columns);
}
export function outputWidth(env: { isTTY: boolean; columns?: number; COLUMNS?: string }): number | undefined {
  if (env.isTTY) return Math.max(80, Number.isFinite(env.columns) ? env.columns! : 80);
  return env.COLUMNS && /^[1-9][0-9]*$/.test(env.COLUMNS) && Number.isSafeInteger(Number(env.COLUMNS)) ? Number(env.COLUMNS) : undefined;
}
interface OutputCell extends Span { atomic?: boolean; items?: string[]; pathItems?: boolean; prefix?: string }
const span = (text: unknown, tone?: Tone, atomic = false): OutputCell => ({ text: String(text ?? ""), ...(tone ? { tone } : {}), ...(atomic ? { atomic: true } : {}) });
const flat = (value: unknown) => terminalText(value).replace(/[\n\t]/g, " ");
const width = (value: string) => Bun.stringWidth(value);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (value: string) => [...graphemes.segment(value)].map(unit => unit.segment);
const peerTone = (id: string): Tone => peerStyle(id).tone;
const shortId = (id: unknown, columns?: number, full = false) => full || columns === undefined ? String(id) : String(id).slice(0, 8);
function lines(text: string, columns?: number, tone?: Tone, indent = ""): Span[][] {
  return (columns === undefined ? [flat(indent + text)] : wrap(flat(indent + text), columns)).map(text => [span(text, tone)]);
}
/** Prefer path separators while retaining every character; only oversized individual segments use ordinary wrapping, with a cell reserved so the segment's trailing slash rides its last piece. */
function pathChunks(text: string, columns: number): string[] {
  const chunks: string[] = []; let line = "";
  for (const part of text.match(/[^/]+\/?|\//g) ?? []) {
    if (line && width(line + part) > columns) { chunks.push(line); line = ""; }
    if (width(part) > columns) {
      const slash = part.endsWith("/");
      const split = wrap(slash ? part.slice(0, -1) : part, slash ? columns - 1 : columns, 0);
      chunks.push(...split.slice(0, -1)); line = split.at(-1)! + (slash ? "/" : "");
    } else line += part;
  }
  if (line || !chunks.length) chunks.push(line);
  return chunks.flatMap(chunk => wrap(chunk, columns, 0));
}
/** Keep logical list items together before breaking oversized paths or words. A separator trails the item it follows: when an item and its separator do not fit, the item moves to the next line whole (or breaks after a slash, reserving a cell for the separator); the separator never gives, never leads a line, never holds one alone. */
function itemChunks(cell: OutputCell, columns: number): string[] {
  if (!cell.items?.length) return wrap(cell.text, columns, 0);
  const chunks: string[] = []; let line = cell.prefix ?? "";
  for (const [index, item] of cell.items!.entries()) {
    const last = index === cell.items!.length - 1;
    const unit = item + (last ? "" : ",");
    const glue = line && (index || cell.prefix) ? " " : "";
    if (width(line + glue + unit) <= columns) { line += glue + unit; continue; }
    if (line) chunks.push(line);
    const room = last ? columns : columns - 1;
    const split = width(item) <= room ? [item] : cell.pathItems ? pathChunks(item, room) : wrap(item, room, 0);
    // A slashless split keeps three visible graphemes beside its comma when they fit.
    // Rebalance complete units, including combining marks/ZWJ sequences, never UTF-16 halves.
    if (!last && split.length > 1 && !item.includes("/") && characters(split.at(-1)!).filter(unit => width(unit) > 0).length < 3 && split.join("") === item) {
      const units = characters(split.slice(-2).join(""));
      let cut = units.length, visible = 0;
      while (cut > 0 && visible < 3) if (width(units[--cut]!) > 0) visible++;
      const prefix = units.slice(0, cut).join(""), tail = units.slice(cut).join("");
      if (visible === 3 && prefix && width(prefix) <= room && width(tail) <= room) split.splice(-2, 2, prefix, tail);
    }
    if (!last) split[split.length - 1] += ",";
    chunks.push(...split.slice(0, -1)); line = split.at(-1)!;
  }
  if (line || !chunks.length) chunks.push(line);
  return chunks.flatMap(chunk => wrap(chunk, columns, 0));
}
/** Wrap complete cells before handing canonical headers and explicit widths to the shared console table. A column that is "-" on every row is dropped at the top level; a band keeps it, so a narrow render carries the same cells as the unbounded one (#284 round 4). */
function rows(head: string[], data: OutputCell[][], columns?: number, details?: Span[][][], keepDash = false): Span[][] {
  if (!data.length) return [];
  const keep = head.map((_, i) => i).filter(i => keepDash || !data.every(row => flat(row[i]?.text) === "-"));
  head = keep.map(i => head[i]!); data = data.map(row => fitLine(keep.map(i => ({ ...row[i]!, text: flat(row[i]?.text), ...(row[i]?.items ? { items: row[i]!.items!.map(flat), prefix: row[i]!.prefix === undefined ? undefined : flat(row[i]!.prefix) } : {}) })), Infinity));
  const natural = head.map((h, i) => Math.max(width(h), ...data.map(row => width(row[i]!.text))));
  const interleave = (rendered: Span[][], lengths: number[], headerHeight = 1) => {
    if (!details) return rendered;
    let at = headerHeight;
    return [...rendered.slice(0, headerHeight), ...lengths.flatMap((length, i) => { const group = rendered.slice(at, at + length); at += length; return [...group, ...(details[i] ?? [])]; })];
  };
  const renderAtWidths = (widths: number[]) => {
    const lengths: number[] = [];
    const physical = data.flatMap(row => {
      const chunks = row.map((cell, i) => cell.items ? itemChunks(cell, widths[i]!) : head[i] === "ROOT" ? pathChunks(cell.text, widths[i]!) : wrap(cell.text, widths[i]!, 0));
      const length = Math.max(...chunks.map(c => c.length)); lengths.push(length);
      return Array.from({ length }, (_, n) => row.map((cell, i) => ({ ...cell, text: chunks[i]![n] ?? "" })));
    });
    return interleave(table(head, physical, columns ?? Infinity, widths), lengths);
  };
  if (columns === undefined) return interleave(table(head, data, Infinity, natural), data.map(() => 1));
  if (head.length === 1) {
    const size = Math.min(columns, natural[0]!);
    const chunk = (cell: OutputCell) => cell.items ? itemChunks(cell, size) : head[0] === "ROOT" ? pathChunks(cell.text, size) : wrap(cell.text, size, 0);
    const lengths = data.map(row => chunk(row[0]!).length);
    const physical = data.flatMap(row => chunk(row[0]!).map(text => [{ ...row[0]!, text }]));
    return interleave(table(head, physical, columns, [size]), lengths, wrap(head[0]!, size, 0).length);
  }
  const flexible = head.includes("TITLE") ? head.indexOf("TITLE") : head.length - 1;
  // TASKS is not protected: its items stay whole at any width (itemChunks breaks between them), so it wraps
  // before ROOT floors (#284 round 3).
  const protectedColumns = new Set(head.map((h, i) => ["ID", "PROJECT", "TURN", "TASK", "OWNER", "REVIEWER", "AGE", "STAGE", "Q", "!", "REVIEW", "REV", "PEER", "PEERS", "PIDS", "TURNS", "BUSY", "TOKENS", "COUNT", "FIELD", "STATE", "MODE", "LEVEL", "LINK", "CLASS"].includes(h) ? i : -1));
  const words = head.map((_, i) => Math.max(...data.flatMap(row => row[i]!.text.split(/\s+/).map(width))));
  const minimum = head.map((h, i) => Math.max(width(h), protectedColumns.has(i) ? words[i]! : 0,
    Math.max(0, ...data.filter(row => row[i]!.atomic).map(row => width(row[i]!.text))),
    h === "TASKS" ? Math.max(0, ...data.flatMap(row => row[i]!.items?.map((item, j, all) => width(item) + (j < all.length - 1 ? 1 : 0)) ?? [])) : 0));
  // Reserve readable flexible text before a multi-word state consumes the space; atomic words still win.
  // A ROOT column keeps a quarter of a wide table: an item list (TASKS) wraps between its items instead (#284 round 3).
  const pathFloor = head[flexible] === "ROOT" && columns !== undefined && columns > 80 ? Math.floor(columns / 4) : 12;
  if (["TITLE", "CONTEXT", "ROOT", "FILES"].includes(head[flexible]!)) minimum[flexible] = Math.max(minimum[flexible]!, Math.min(natural[flexible]!, pathFloor));
  // A FILES column has no floor of its own: a floor is paid by the time and state cells before the shorter-only
  // comparison below looks at anything, so it would wrap them without the listing getting shorter (#284 round 5).
  // Label/value pairs never become unrelated lists. Narrow values wrap beside their own label.
  if (head[0] === "FIELD" && head[1] === "VALUE" && natural[0]! + minimum[1]! + 2 > columns) {
    if (columns < 12) return [...lines("FIELD  VALUE", columns), ...data.flatMap(row => lines(`${row[0]!.text}: ${row[1]!.text}`, columns, row[1]!.tone))];
    const label = Math.min(natural[0]!, columns - 2 - width(head[1]!));
    return renderAtWidths([label, columns - 2 - label]);
  }
  // Narrow tables become linked bands before an id, peer, age, counter or state word would split.
  if (minimum.reduce((sum, n) => sum + n, 0) + 2 * (head.length - 1) > columns) {
    const bands: number[][] = []; let band = [0];
    for (let i = 1; i < head.length; i++) {
      // Keep a board title with its stage meter: if both cannot fit here, give the title the next band's room.
      const stage = head.indexOf("STAGE");
      const trial = [...band, i, ...(i === flexible && stage > i ? [stage] : [])];
      if (trial.reduce((sum, index) => sum + minimum[index]!, 0) + 2 * (trial.length - 1) > columns) {
        bands.push(band);
        band = minimum[0]! + minimum[i]! + 2 <= columns ? [0] : [];
      }
      band.push(i);
    }
    bands.push(band);
    return bands.flatMap((indices, i) => {
      const part = indices.includes(0)
        ? rows(indices.map(index => head[index]!), data.map(row => indices.map(index => row[index]!)), columns, i === bands.length - 1 ? details : undefined, true)
        : data.flatMap((row, n) => [...rows([head[0]!], [[row[0]!]], columns, undefined, true),
          ...rows(indices.map(index => head[index]!), [indices.map(index => row[index]!)], columns, i === bands.length - 1 && details ? [details[n]!] : undefined, true)]);
      return [...(i ? [[]] : []), ...part];
    });
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
  // A flexible FILES column grows toward natural while protected columns give down to their longest word, but only
  // when that makes the listing shorter: both layouts are rendered and the taller one is dropped (#284 round 4).
  if (head[flexible] === "FILES") {
    const grown = [...widths];
    while (grown[flexible]! < natural[flexible]!) {
      const donors = grown.map((n, i) => ({ i, room: i === flexible ? 0 : n - Math.max(minimum[i]!, protectedColumns.has(i) ? words[i]! : 0) })).filter(d => d.room > 0);
      if (!donors.length) break;
      donors.sort((a, b) => b.room - a.room);
      grown[donors[0]!.i]!--; grown[flexible]!++;
    }
    if (grown[flexible]! > widths[flexible]!) {
      const grownRender = renderAtWidths(grown);
      const plainRender = renderAtWidths(widths);
      return grownRender.length < plainRender.length ? grownRender : plainRender;
    }
  }
  return renderAtWidths(widths);
}
/** #784 AC3: ` (active 1, review-wait 2, reserved 0)`; nothing from an older hub that sends no breakdown. */
function wipSplit(value: { active?: number; reviewWait?: number; reserved?: number }): string {
  return [value.active, value.reviewWait, value.reserved].every(n => Number.isSafeInteger(n)) ? ` (active ${value.active}, review-wait ${value.reviewWait}, reserved ${value.reserved})` : "";
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
  if (data.roleInfo) data = { ...data, peers: Object.fromEntries(Object.entries(data.peers).map(([peer, value]) => [peer, { ...value, ...data.roleInfo?.[peer] }])) };
  const out = lines(`agent-hub${data.version ? ` ${data.version}` : ""}  pid ${data.pid ?? "unknown"}  control 127.0.0.1:${data.controlPort ?? "unknown"}`, columns, "info");
  if (data.cwd) out.push(...lines(data.cwd, columns));
  for (const pending of data.pendingRestart ?? []) out.push(...detail("pending restart", `${pending.key}: ${pending.reason}`, columns, "attention"));
  if (data.mainCheckout) out.push(...detail("main checkout", data.mainCheckout, columns, "attention"));
  for (const drift of data.agentDrift ?? []) out.push(...detail("agent CLI drift", `${drift.id} ${drift.version} ${drift.state}; last receipt ${drift.receipt}`, columns, "attention"));
  if (data.retainedConfig?.length) {
    out.push(...detail("config retained", `${data.retainedConfig.map(row => row.key).join(", ")}; run ahub settings reload`, columns, "attention"));
    for (const pending of data.retainedConfig) out.push(...detail("retained reason", `${pending.key}: ${pending.reason}`, columns, "attention"));
  }
  for (const row of data.schedules ?? []) {
    const when = (at: number) => row.zone ? scheduleWhen(row, at) : new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z";
    const text = `${row.state === "paused" ? `paused (ahub schedule resume ${row.id}); would be next ${when(row.next)}` : row.state === "scheduled" ? `next ${when(row.next)}` : row.state === "due" ? "due now" : row.state === "waiting" ? `due, waiting for task #${row.task} to close` : "due, held (the hub is stopping or recovering)"}; ${schedulePeriodText(row)}; ${row.class} to ${row.queue}${row.last ? `; last ${when(row.last)}${row.task ? ` as task #${row.task}` : ""}` : "; never run"}${row.coalesced ? `; ${row.coalesced} skipped run${row.coalesced === 1 ? "" : "s"} coalesced` : ""}${row.error ? `; last error: ${row.error}` : ""}`;
    out.push(...detail(`schedule ${row.id}`, text, columns, row.error ? "attention" : undefined));
  }
  if (data.queueBackpressure) {
    const pressure = data.queueBackpressure, policy = pressure.policy;
    out.push(...detail("queue backpressure", `max queued ${policy.max_queued || "disabled"}; max oldest age ${policy.max_oldest_s ? `${policy.max_oldest_s}s` : "disabled"}; explicit assignment overrides only that role`, columns));
    for (const [peer, row] of Object.entries(pressure.peers)) {
      if (row.queued === 0 && !row.blocked) continue;
      const age = typeof row.oldestAgeMs === "number" && Number.isFinite(row.oldestAgeMs) && row.oldestAgeMs >= 0 ? duration(row.oldestAgeMs) : "unknown";
      out.push(...detail(`${peer} queue pressure`, `queued ${row.queued ?? "unknown"}; oldest ${age}${row.blocked ? `; automatic offers held: ${row.reason ?? row.code ?? "unknown"}` : ""}`, columns, row.blocked ? "attention" : undefined));
    }
  }
  for (const stall of data.taskStalls ?? []) out.push(...detail(`task #${stall.task} stalled`, `${stall.cause.kind}${stall.cause.peer ? ` ${stall.cause.peer}` : ""}${stall.cause.dependency ? ` #${stall.cause.dependency}` : ""}: ${stall.cause.code}; configure the peer, ahub task assign ${stall.task} <peer>, or ahub task cancel ${stall.task} --reason <text>`, columns, "attention"));
  for (const offer of data.pendingTaskOffers ?? []) out.push(...detail("task offer", `open ${offer.peer}: task #${offer.task} is waiting for it`, columns, "attention"));
  if (data.memoryProfile) {
    const memory = data.memoryProfile;
    const profile = memory.profile === "generation" ? `generation ${memory.generation?.slice(0, 8) ?? "unknown"}` : memory.profile ?? "unbound";
    out.push(...detail("memory", `${profile}; ${memory.state ?? "unknown"}; agent-mem ${memory.agentMemVersion ?? "unknown"}${memory.skippedRows ? `; malformed legacy rows skipped: ${memory.skippedRows}` : ""}${memory.error ? `; ${memory.error}` : ""}`, columns, memory.state === "unavailable" ? "attention" : undefined));
  }
  if (data.memoryRead?.truncated) out.push(...detail("memory view", `truncated: newest ${data.memoryRead.limit} project candidates considered`, columns, "attention"));
  if (data.planner) out.push(...detail("planner", `${data.planner.peers?.join(", ") || "nobody"} (${data.planner.source ?? "unknown"})${data.planner.source === "automatic" || data.planner.source === "none" ? "; pin it with ahub settings set planner <peer>" : ""}`, columns, data.planner.source === "none" ? "attention" : undefined));
  for (const [id, isolated] of Object.entries(data.ownerIsolation ?? {})) {
    const text = ownerIsolationText(isolated, data.ownerIsolationNotes?.[id]);
    if (text) out.push(...detail(`${id} owner isolation`, text, columns, isolated ? undefined : "attention"));
  }
  if (data.deliveryError) out.push(...detail("delivery storage", `${data.deliveryError}; dispatch is stopped`, columns, "failure"));
  for (const pending of data.permissionDefaults ?? []) out.push(...detail("permission default", `${pending.peer}: never-ask from ${pending.source}, stays ask until a person confirms in ahub console`, columns, "attention"));
  for (const crash of data.crash ?? []) out.push(...detail("crash recovery", crash, columns, "attention"));
  for (const warning of data.isolatedChecks?.orphans ?? []) out.push(...detail("isolated check warning", warning, columns, "attention"));
  for (const id of data.isolatedChecks?.unknownReceipts ?? []) out.push(...detail("check receipt", `${id}: unknown; receipt storage unavailable`, columns, "attention"));
  if (data.isolatedChecks?.maintenanceUnavailable) out.push(...detail("check maintenance", "unavailable; saved run outcomes are unchanged", columns, "attention"));
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
    if (typeof p.form === "string") out.push(...detail(`${id} form`, p.form, columns));
    if (Array.isArray(p.capableRoles)) out.push(...detail(`${id} capable roles`, p.capableRoles.join(", ") || "none", columns));
    if (p.flowRoles) out.push(...detail(`${id} flow roles`, p.flowRoles.join(", ") || "none", columns));
    if (p.catalogRoles) { out.push(...detail(`${id} catalog roles`, Array.isArray(p.catalogRoles.value) ? p.catalogRoles.value.join(", ") || "none" : "unconfirmed", columns)); if (p.catalogRoles.pending !== undefined) out.push(...detail(`${id} pending roles`, p.catalogRoles.pending.join(", ") || "none", columns, "attention")); }
    if (p.liveAccepted?.length) { settling = true; out.push(...detail("settling", p.liveAccepted.map((v: string) => shortId(v, columns, full)).join(", "), columns, "attention")); }
    if (p.heldRows?.length) {
      for (const row of p.heldRows) out.push(...detail("held", `${id}: needs_review ${shortId(row.id, columns, full)}; from ${row.senders.join(",")}; kind ${row.kinds.join(",")}; age ${duration(Math.max(0, now - row.createdAt))}${row.context ? `; ${row.context}` : ""}; ahub queue show ${row.id}`, columns, "failure"));
    } else if (p.heldBy) {
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
    if (p.toolsOnly) out.push(...detail(definitionOf(id)?.attach?.pullOnlyForms?.includes("tui") && p.pullOnly ? "pull-only" : "tools-only", flat(p.toolsOnly).replace(/^(?:tools-only|pull-only):\s*/, ""), columns, "attention"));
    if (p.pullOnly && definitionOf(id)?.attach?.pullOnlyForms?.includes("tui")) out.push(...detail(`${id} last read`, typeof p.lastInboxAt === "number" ? relative(p.lastInboxAt, now) : "never", columns, "muted"));
    const actionPolicy = data.actionPolicyInfo?.[id];
    if (actionPolicy?.note) out.push(...detail(`${id} action policy`, actionPolicy.note, columns, actionPolicy.enforceable ? "muted" : "attention"));
    if (typeof p.reviewerUnavailable === "string" && p.reviewerUnavailable) out.push(...detail("reviewer", flat(p.reviewerUnavailable), columns, "failure")); // #722: the cause class, never a path
    if (p.ownerIsolationNote) out.push(...detail("owner isolation", p.ownerIsolationNote, columns, "attention"));
    if (p.permissionNote) out.push(...detail("permission", p.permissionNote, columns, "muted"));
    if (typeof p.statusNotice?.message === "string" && p.statusNotice.message) out.push(...detail("status notice", p.statusNotice.message, columns, "attention"));
    if (p.requestedModel && p.servedBy && p.requestedModel !== p.servedBy) out.push(...detail("requested model", p.requestedModel, columns));
    if (p.reviewScope === "code" || p.reviewScope === "full") out.push(...detail("review scope", p.reviewScope === "code" ? "code only (cannot run tests or read CI; the merger gates on exact-head CI)" : "full", columns, "muted")); // #852
    if (typeof p.modelSource === "string" && p.modelSource) out.push(...detail("model source", flat(p.modelSource), columns, "muted")); // an extra Jcode instance (#685): names only, never a URL or token
    if (typeof p.importantWaitingSince === "number" && p.importantWaitingNote) out.push(...detail("important waiting", `${p.importantWaitingNote.replace(/^\d+ important messages? waiting/, "important messages waiting")}`, columns, "attention"));
    if (typeof p.oldestQueuedAt === "number") out.push(...detail(`${id} oldest queued`, relative(p.oldestQueuedAt, now), columns, "muted"));
    return out;
  });
  if (peerRows.length) out.push([], ...rows(head, peerRows, columns, peerDetails));
  else out.push(...lines("no peers attached yet (ahub claude | ahub codex | ahub kimi)", columns));
  if (settling) out.push([], ...lines("settling: the adapter has not confirmed these deliveries yet (Claude: reply or hub_delivery_done). Task state is independent.", columns, "muted"));
  if (data.taskWip) for (const [peer, value] of Object.entries(data.taskWip)) out.push(...detail(`${peer} planner WIP`, `${value.wip}/${value.wipLimit}${wipSplit(value)}`, columns));
  if (data.models?.backends?.length) {
    out.push([], ...rows(["MODEL", "STATE", "ACTIVE", "REQUESTED", "ACTUAL", "PROVIDER"], data.models.backends.map(b => [span(backendLabel(b)), span(b.state ?? "unknown", stateTone(b.state ?? "")), span(b.active || "-"), span(b.requestedModel ?? "-"), span(b.actualModel ?? "-"), span(b.provider ?? "-")]), columns));
    for (const b of data.models.backends) for (const [key, label] of [["coolingUntil", "cooling"], ["failingUntil", "dispatch held"]]) if (b[key!]) { const at = Date.parse(b[key!]); out.push(...detail(`${backendLabel(b)} ${label}`, `${Number.isFinite(at) ? relative(at, now) : "unknown"}${key === "coolingUntil" && typeof b.failures === "number" ? ` after ${b.failures} failures` : key === "failingUntil" ? "; no load moves until then" : ""}`, columns, "attention")); }
  }
  const counts = Object.entries(data.tasks ?? {}).map(([state, count]) => `${count} ${state}`).join(", ");
  if (counts) out.push([], ...lines(`TASKS  ${counts} (ahub board)`, columns));
  return out;
}
// #724: short next-step codes for the compact board, keyed on the blocker texts of src/hub/sdlc.ts; the full advice stays in --full and ahub task show.
const STAGE_CODES: [string, string][] = [["issue identity missing", "issue?"], ["PR identity missing", "PR?"], ["PR is not open", "PR closed"], ["current PR evidence unknown", "PR state?"],
  ["required check", "CI?"], ["local gate", "gate?"], ["current head has not been reviewed", "review?"], ["GitHub review approval", "approval?"], ["review requests", "requests?"],
  ["review threads", "threads?"], ["open important review findings", "findings"], ["person may inspect merge readiness", "ready"]];
export function stageCode(next: string): string {
  const known = STAGE_CODES.find(([prefix]) => next.startsWith(prefix));
  return known ? known[1] : width(next) <= 12 ? next : characters(next).slice(0, 9).join("") + "...";
}
const BOARD_LEGEND = "STAGE: [#---] SDLC progress, stage: next step. issue? no issue, PR? no PR, CI? checks, review? not reviewed, threads? open threads. Full advice: ahub board --full.";
const ellipsis = (text: string, room: number) => width(text) <= room ? text : room <= 3 ? ".".repeat(Math.max(0, room)) : (() => { let out = ""; for (const unit of characters(text)) { if (width(out + unit) > room - 3) break; out += unit; } return out + "..."; })();
/**
 * #399: `ahub backlog list` as a table: one line per card, by rank (unranked last) then id. With a width, TITLE goes last and is
 * cut like the compact board, and AGE then CLASS give way first on a narrow terminal; without one (piped) or with full, titles are whole.
 */
export function renderBacklog(cards: any[], columns?: number, now = Date.now(), full = false): Span[][] {
  if (!cards.length) return [[span("no backlog cards")]];
  const sorted = [...cards].sort((a, b) => (typeof a.rank === "number" ? a.rank : Infinity) - (typeof b.rank === "number" ? b.rank : Infinity) || a.id - b.id);
  let names = ["RANK", "ID", "PRI", "RESERVED", "AFTER", "CLASS", "AGE", "TITLE"];
  let table: OutputCell[][] = sorted.map(card => {
    const deps: number[] = Array.isArray(card.deps) ? card.deps : [];
    return [span(typeof card.rank === "number" ? card.rank : "-", "muted", true), span(`#${card.id}`, "info", true), span(typeof card.priority === "number" ? `P${card.priority}` : "-", undefined, true),
      span(card.reserved ?? "-", peerTone(card.reserved ?? ""), true), span(deps.length ? (full || columns === undefined ? deps.map(id => `#${id}`).join(",") : `#${deps[0]}${deps.length > 1 ? `,+${deps.length - 1}` : ""}`) : "-", undefined, true), span(card.class ?? "-", undefined, true),
      span(typeof card.created === "number" ? duration(now - card.created) : "-", "muted", true), span(flat(card.title))];
  });
  if (!full && columns !== undefined) {
    const drop = (name: string) => { const at = names.indexOf(name); if (at < 0) return; names = names.filter((_, i) => i !== at); table = table.map(row => row.filter((_, i) => i !== at)); };
    const room = () => columns - names.reduce((sum, name, i) => name === "TITLE" ? sum : sum + Math.max(width(name), ...table.map(row => width(flat(row[i]!.text)))), 0) - 2 * (names.length - 1);
    const want = Math.min(30, Math.max(...table.map(row => width(row[row.length - 1]!.text))));
    for (const name of ["AGE", "CLASS", "PRI"]) if (room() < want) drop(name);
    const titleRoom = Math.max(5, room());
    table = table.map(row => [...row.slice(0, -1), { ...row[row.length - 1]!, text: ellipsis(row[row.length - 1]!.text, titleRoom) }]);
  }
  const owners = new Map<string, number>();
  for (const card of sorted) owners.set(card.reserved ?? "unreserved", (owners.get(card.reserved ?? "unreserved") ?? 0) + 1);
  const summary = `${plural(sorted.length, "backlog card")}; reserved: ${[...owners].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([owner, n]) => `${owner} ${n}`).join(", ")}`;
  return [...rows(names, table, columns), [], ...lines(summary, columns)];
}
/** #724: one line per task. TITLE goes last and is cut to the room left; at a narrow width REVIEWER, CLASS and AGE give way first. */
/** #604: a task another project handed over says so on the board: the project id and the peer, both ids and nothing a handoff wrote. */
const handoffMark = (task: any): string => task?.handoffOrigin ? `  (handed off from ${String(task.handoffOrigin.projectId).slice(0, 24)} by ${String(task.handoffOrigin.peer).slice(0, 32)})` : "";
function compactBoard(tasks: any[], data: OutputCell[][], columns: number, staged: boolean): Span[][] {
  const head = ["ID", "STATE", "OWNER", "REVIEWER", "CLASS", "AGE", "AFTER", ...(staged ? ["STAGE"] : []), "TITLE"];
  let table = tasks.map((task, i) => {
    const row = data[i]!, deps: number[] = task.deps ?? [];
    const after = deps.length ? `#${deps[0]}${deps.length > 1 ? `,+${deps.length - 1}` : ""}` : "-";
    const meter = /^\[[^\]]*\](?: cancelled)?/.exec(row[7]?.text ?? "")?.[0] ?? "[----]";
    const stage = task.lifecycle ? `${meter} ${task.lifecycle.stage}: ${stageCode(String(task.lifecycle.next ?? ""))}` : meter;
    const short = task.lifecycle ? `${meter} ${stageCode(String(task.lifecycle.next ?? ""))}` : meter;
    return [row[0]!, row[1]!, row[2]!, row[3]!, row[4]!, row[5]!, span(after, undefined, true), ...(staged ? [{ ...span(stage, row[7]!.tone, true), short }] : []), span(`${flat(task.title)}${handoffMark(task)}`)];
  });
  let names = [...head];
  const drop = (name: string) => { const at = names.indexOf(name); if (at < 0) return; names = names.filter((_, i) => i !== at); table = table.map(row => row.filter((_, i) => i !== at)); };
  for (const name of [...names]) if (name !== "TITLE" && table.every(row => flat(row[names.indexOf(name)]?.text) === "-")) drop(name);
  const room = () => { const t = names.indexOf("TITLE"); return columns - names.reduce((sum, name, i) => i === t ? sum : sum + Math.max(width(name), ...table.map(row => width(flat(row[i]!.text)))), 0) - 2 * (names.length - 1); };
  const want = Math.min(30, Math.max(...table.map(row => width(row[row.length - 1]!.text))));
  for (const name of ["REVIEWER", "CLASS", "AGE", "STAGE"]) if (room() < want) {
    // STAGE is never dropped: it falls back to the meter and the code, the stage name being the meter's position.
    if (name !== "STAGE") drop(name);
    else { const at = names.indexOf("STAGE"); if (at >= 0) table = table.map(row => row.map((cell, i) => i === at ? { ...cell, text: (cell as OutputCell & { short?: string }).short ?? cell.text } : cell)); }
  }
  // Still too narrow (a long instance id as OWNER): AFTER gives way, then OWNER is cut, so the row never becomes linked bands.
  if (room() < 8) drop("AFTER");
  const owner = names.indexOf("OWNER");
  if (room() < 8 && owner >= 0) { const cut = Math.max(5, Math.max(...table.map(row => width(flat(row[owner]!.text)))) - (8 - room())); table = table.map(row => row.map((cell, i) => i === owner ? { ...cell, text: ellipsis(flat(cell.text), cut) } : cell)); }
  const titleRoom = Math.max(5, room());
  // A PII row keeps its whole "ahub task show" hint when 8 columns of title remain; the cut title is never wrapped.
  table = table.map((row, i) => { const pii = `  (ahub task show ${tasks[i].id})`, hint = tasks[i].signals?.includes("pii") && titleRoom - width(pii) >= 8 ? pii : ""; return [...row.slice(0, -1), { ...row[row.length - 1]!, text: ellipsis(row[row.length - 1]!.text, Math.max(4, titleRoom - width(hint))) + hint }]; });
  return rows(names, table, columns);
}
export function renderBoard(tasks: any[], columns?: number, now = Date.now(), full = false, allTasks: any[] | null = tasks): Span[][] {
  if (!tasks.length) return [[span("no tasks")]];
  const s = initialConsoleState(); s.panel = 3; s.tasks = tasks;
  const stages = allTasks === null ? undefined : new Map(taskProgress(boardColumnContext(tasks, allTasks)).stages.map(stage => [stage.id, stage]));
  const counts = [...new Set(tasks.map(task => task.state))].map(state => `${tasks.filter(task => task.state === state).length} ${state}`).join(", ");
  if (!full && columns !== undefined) {
    const data = tasks.map(task => { const row = cells(s, task, false, now, stages); row[2] = span(row[2]!.text, peerTone(task.owner ?? "")); row[3] = span(row[3]!.text, peerTone(task.reviewer ?? "")); return row; });
    return [...compactBoard(tasks, data, columns, allTasks !== null), [], ...lines(`${plural(tasks.length, "task")}: ${counts}`, columns), ...(allTasks !== null ? lines(BOARD_LEGEND, columns, "muted") : [])];
  }
  const data = tasks.map(task => {
    const row = cells(s, task, false, now, stages);
    row[2] = span(row[2]!.text, peerTone(task.owner ?? ""));
    row[3] = span(row[3]!.text, peerTone(task.reviewer ?? ""));
    row[6] = span(`${task.title}${handoffMark(task)}${task.deps?.length ? `  after ${task.deps.map((id: number) => `#${id}`).join(", ")}` : ""}${task.signals?.includes("pii") ? `  (ahub task show ${task.id})` : ""}`);
    if (allTasks === null) row.pop();
    return row;
  });
  return [...rows(allTasks === null ? TABLES[3]!.slice(0, -1) : [...TABLES[3]!], data, columns), [], ...lines(`${plural(tasks.length, "task")}: ${counts}`, columns)];
}
export function renderBudget(data: BudgetOutput, columns?: number, now = Date.now(), _full = false): Span[][] {
  const out: Span[][] = [];
  // KIND names what the number is (#285): the provider's own (native), tokens the hub counted against a ceiling (count), or a person's (manual).
  // A window without a kind, from an older hub, is classified by `windowKind`. A fresh window that does not gate says so in STATE.
  const windows = Object.entries(data.budget).flatMap(([peer, b]) => (b.windows ?? []).map((w: any) => [span(peer, peerTone(peer)), span(w.id), span(`${Math.round(w.used * 100)}%`, "number"), span(typeof w.resetsAt === "number" ? relative(w.resetsAt, now) : "-", "muted"), span(windowKind({ id: w.id, source: w.source ?? "", kind: w.kind }), "muted"), span(w.source ?? "unknown", "muted"), span(typeof w.at === "number" ? relative(w.at, now) : "unknown", "muted"), span(w.stale ? "stale" : w.superseded ? "info only" : "fresh", w.stale ? "attention" : undefined)]));
  if (windows.length) out.push(...rows(["PEER", "WINDOW", "USED", "RESETS", "KIND", "SOURCE", "MEASURED", "STATE"], windows, columns));
  else if (!data.peers?.length) out.push(...lines(`no quota readings yet (gate ${data.gate ?? "unknown"}). Sources: Codex rate limits, Claude's status line (ahub claude), ahub budget set.`, columns));
  // A peer with no number says why, in its own line, so a peer without quota is not mistaken for one that has not reported.
  for (const note of data.peers ?? []) out.push(...detail(note.peer, note.note, columns, peerTone(note.peer)));
  for (const [peer, b] of Object.entries(data.budget)) if (b.paused) out.push(...detail(`paused ${peer}`, `${b.paused.reason ?? "budget"}${typeof b.paused.resetsAt === "number" ? `; resumes ${relative(b.paused.resetsAt, now)}` : ""}`, columns, "attention"));
  return out;
}
function boardColumnContext(tasks: any[], allTasks: any[] | null): any[] {
  if (allTasks === null) throw new Error("board column dependency context unavailable; retry with a complete snapshot");
  const first = new Map(tasks.map(task => [task.id, task])), context = allTasks.map(task => first.get(task.id) ?? task);
  const included = new Set(context.map(task => task.id));
  for (const task of tasks) if (!included.has(task.id)) context.push(task);
  return context;
}
export function boardColumnModel(tasks: any[], peers: Record<string, BoardPeerInput>, allTasks: any[] | null = tasks) {
  const visible = new Set(tasks.map(task => task.id)), context = boardColumnContext(tasks, allTasks);
  const model = boardColumns(context.map(task => ({ ...task, urgent: task.signals?.includes("urgent") === true })), peers);
  return { columns: model.columns.map(column => ({ ...column, ready: column.ready.filter(card => visible.has(card.id)), waiting: column.waiting.filter(card => visible.has(card.id)) })), unknown: model.unknown.filter(id => visible.has(id)) };
}
export function renderBoardColumns(tasks: any[], peers: Record<string, BoardPeerInput>, columns?: number, now = Date.now(), full = false, allTasks: any[] | null = tasks): Span[][] {
  const visible = new Set(tasks.map(task => task.id)), byId = new Map(tasks.map(task => [task.id, task]));
  const context = boardColumnContext(tasks, allTasks), model = boardColumnModel(tasks, peers, context), out: Span[][] = [];
  for (const column of model.columns) {
    const ready = column.ready.filter(card => visible.has(card.id)), waiting = column.waiting.filter(card => visible.has(card.id));
    if (out.length) out.push([]); out.push([span(column.label, "strong")]);
    if (!ready.length && !waiting.length) { out.push([span("(empty)", "muted")]); continue; }
    if (column.id === "todo") out.push([span("Ready", "strong")]);
    if (ready.length) out.push(...renderBoard(ready.map(card => byId.get(card.id)), columns, now, full, context));
    if (waiting.length) { out.push([span("Waiting", "strong")]); out.push(...renderBoard(waiting.map(card => byId.get(card.id)), columns, now, full, context)); for (const card of waiting) out.push(...lines(`#${card.id}: ${card.waiting.join("; ")}`, columns)); }
  }
  const unknown = model.unknown.filter(id => visible.has(id));
  if (unknown.length) out.push([], [span("Unknown state", "strong")], ...renderBoard(unknown.map(id => byId.get(id)), columns, now, full, context));
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

export function renderProjects(projects: any[], columns?: number, _now = Date.now()): Span[][] {
  if (!projects.length) return lines("No registered projects. Run ahub init in a project directory.", columns);
  return rows(["PROJECT", "STATE", "PEERS", "TASKS", "ROOT"], projects.map(project => {
    const tasks = Object.entries(project.status?.tasks ?? {}).map(([state, n]) => `${n} ${state}`).join(", ");
    return [span(project.id, "info"), span(project.state ?? "unknown", stateTone(project.state ?? "")),
      span(project.status ? Object.keys(project.status.peers ?? {}).length : "unknown", "number"), { ...span(tasks || "-"), items: Object.entries(project.status?.tasks ?? {}).map(([state, n]) => `${n} ${state}`) }, span(project.root)];
  }), columns, projects.map(project => project.error ? detail("error", project.error, columns, "failure") : []));
}
export function renderQueue(deliveries: any[], columns?: number, now = Date.now()): Span[][] {
  if (!deliveries.length) return lines("no retained deliveries", columns);
  const s = initialConsoleState(); s.panel = 4;
  const data = deliveries.map(delivery => {
    const row = cells(s, { ...delivery, id: String(delivery.id) }, false, now);
    row[1] = span(row[1]!.text, peerTone(delivery.peer)); return row;
  });
  return rows([...TABLES[4]!], data, columns, deliveries.map(delivery => delivery.important ? detail("priority", "important", columns, "attention") : []));
}
const moment = (value: unknown, now: number) => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? relative(at, now) : "unknown";
};
export function renderTurns(turns: any[], columns?: number, now = Date.now()): Span[][] {
  if (!turns.length) return lines("no turns recorded (they need a git work tree and snapshots.enabled)", columns);
  return rows(["TURN", "PEER", "STARTED", "STATE", "FILES"], turns.map(turn => {
    const state = !turn.ended ? "running" : !turn.end_tree ? "no end snapshot" : "completed";
    const files = turn.changed ?? [];
    // #798 D2: a dirty submodule is listed beside the files, tagged, so a turn that edited only a submodule never reads "0 files".
    const unobserved: string[] = Array.isArray(turn.unobserved) ? turn.unobserved.filter((path: unknown): path is string => typeof path === "string") : [];
    const shown = [...files, ...unobserved.map(path => `${path} (changed, contents unobserved)`)];
    return [span(turn.id, "info"), span(turn.peer ?? "unknown", peerTone(turn.peer)), span(moment(turn.started, now), "muted"),
      span(state, state === "running" ? "attention" : state === "no end snapshot" ? "failure" : "success"), { ...span(`${plural(files.length, "file")}${shown.length ? `: ${shown.join(", ")}` : ""}`), ...(shown.length ? { items: shown, pathItems: true, prefix: `${plural(files.length, "file")}:` } : {}) }];
  }), columns);
}
export function renderOrphans(orphans: { project: any; pids: number[] }[], columns?: number, _now = Date.now(), killing = false): Span[][] {
  if (!orphans.length) return lines("no orphaned hub registrations", columns);
  return [...lines("orphaned hub registrations (the project root is gone):", columns, "strong"),
    ...rows(["PROJECT", "STATE", "PIDS", "ROOT"], orphans.map(({ project, pids }) => [span(project.id, "info"), span(pids.length ? "live" : "no live process", pids.length ? "attention" : "muted"), span(pids.length ? pids.join(", ") : "-", "number"), span(project.root)]), columns),
    ...(killing ? [] : [[], ...lines("kill live orphans with ahub doctor --orphans --kill", columns)]),
    ...orphans.flatMap(({ project }) => detail("forget", `ahub projects remove ${project.id}`, columns))];
}
/** `ahub doctor --orphans --kill` from the conductor's shell (#812, #899): the hub inspects and stops only its own positively identified process; the shell prints what it answered. */
export function renderOrphanCleanup(result: unknown, columns?: number, _now = Date.now()): Span[][] {
  const r = result as any;
  const stopped: number[] | undefined = Array.isArray(r?.stopped) ? r.stopped.filter((pid: unknown) => typeof pid === "number") : undefined;
  const out = stopped === undefined ? lines("stopped processes unknown", columns, "attention")
    : stopped.length ? lines(`stopped ${stopped.length} orphaned hub process${stopped.length === 1 ? "" : "es"}: ${stopped.join(", ")}`, columns, "success")
    : lines("no orphaned hub process to stop", columns, "muted");
  if (r?.self === true) out.push(...lines("this hub was itself an orphan and is stopping", columns, "attention"));
  if (r?.unknown === true) out.push(...lines("a candidate could not be confirmed stopped; a person can inspect it with ahub doctor --orphans", columns, "attention"));
  return out;
}
const TIME_FIELD = /^(?:at|ts|started|ended|created|updated|expires)$|(?:At|Until)$/;
const ID_FIELD = /^(?:id|trace|previousId|sessionId|threadId|operationId|turnId|envelopeIds)$/;
/** Labelled scalar leaves preserve the daemon's public view without a raw document or inferred privacy changes. */
function fields(value: unknown, columns: number | undefined, now: number, prefix = ""): Span[][] {
  const leaves: OutputCell[][] = [];
  const visit = (current: unknown, label: string, key: string) => {
    if (Array.isArray(current)) {
      if (!current.length) leaves.push([span(label), span("none", "muted")]);
      else current.forEach((item, index) => visit(item, `${label}${label ? " " : ""}${index + 1}`, key));
      return;
    }
    if (current && typeof current === "object") {
      const entries = Object.entries(current);
      if (!entries.length) leaves.push([span(label), span("none", "muted")]);
      else for (const [child, item] of entries) visit(item, `${label}${label ? " " : ""}${child}`, child);
      return;
    }
    let text: string;
    if (current === null || current === undefined) text = "unknown";
    else if (TIME_FIELD.test(key)) text = moment(current, now);
    else if (/(?:^| )elapsed_ms(?: |$)/.test(label) && typeof current === "number") text = duration(current);
    else text = flat(current);
    leaves.push([span(label || "value"), span(text, ID_FIELD.test(key) ? "info" : key === "state" ? stateTone(text) : typeof current === "number" ? "number" : TIME_FIELD.test(key) ? "muted" : undefined, ID_FIELD.test(key))]);
  };
  visit(value, prefix, prefix);
  return rows(["FIELD", "VALUE"], leaves, columns);
}
export function renderQueueShow(delivery: any, columns?: number, now = Date.now()): Span[][] {
  const out = [...lines("Delivery", columns, "strong"), ...fields(delivery, columns, now)];
  if (delivery?.state === "needs_review" && delivery.id) out.push([], ...detail("resolve", `ahub queue resolve ${delivery.id} --action completed|retry|discard --reason <text>`, columns, "failure"));
  return out;
}
export function renderModelsStatus(status: unknown, columns?: number, now = Date.now()): Span[][] {
  return [...lines("Models", columns, "strong"), ...fields(status, columns, now)];
}
export function renderExecutionBudgetStatus(budgets: unknown, columns?: number, now = Date.now()): Span[][] {
  return [...lines("Execution budget", columns, "strong"), ...(Array.isArray(budgets) && !budgets.length ? lines("No execution budgets configured.", columns) : budgets === undefined ? lines("No matching execution budget.", columns) : fields(budgets, columns, now))];
}
/** Retain the report's coverage and attribution sentences; add sections and aligned counters for scanning. */
export function renderReport(report: Report | TaskReport, columns?: number, now = Date.now(), byTask = false): Span[][] {
  const out = lines(`period: ${report.from ? moment(report.from, now) : "-"} .. ${report.to ? moment(report.to, now) : "-"}`, columns, "muted");
  const formatted = byTask ? formatTaskReport(report as TaskReport) : formatReport(report as Report);
  if (!byTask) {
    const r = report as Report;
    out.push([], ...lines("Counters", columns, "strong"), ...rows(["METRIC", "COUNT"], [
      [span("messages"), span(r.messages.total, "number")], [span("overflow"), span(r.messages.overflow, "number")],
      [span("undeliverable"), span(r.messages.undeliverable, "number")], [span("messages per task"), span(r.messages.perTask, "number")],
      [span("overlap warnings"), span(r.overlaps.warnings, "number")], [span("task pairs"), span(r.overlaps.pairs, "number")],
      [span("edit conflicts"), span(r.conflicts, "number")], [span("quota readings"), span(r.quota.readings, "number")], [span("hard limits"), span(r.quota.hard, "number")],
    ], columns));
  }
  let previous = "";
  const section = (line: string) => byTask
    ? line.startsWith("task #") ? "Tasks" : line.startsWith("class ") ? "Classes" : line.startsWith("unattributed:") ? "Unattributed" : line.startsWith("before attribution:") ? "Before attribution" : previous
    : line.startsWith("peer ") ? "Peers" : line.startsWith("usage ") ? "Usage" : line.startsWith("supervision ") ? "Supervision" : line.startsWith("conductor ") ? "Conductor" : line.startsWith("messages:") ? "Messages" : line.startsWith("overlap warnings:") ? "Coordination" : line.startsWith("task events:") ? "Tasks" : line.startsWith("quota readings:") ? "Quota" : line.startsWith("route ") ? "Routes" : "Report";
  for (const sentence of formatted.slice(1)) {
    const name = section(sentence);
    if (name !== previous) {
      out.push([], ...lines(name, columns, "strong")); previous = name;
      if (name === "Peers" && !byTask) out.push(...rows(["PEER", "TURNS", "BUSY", "TOKENS"], Object.entries((report as Report).peers).map(([peer, p]) => [span(peer, peerTone(peer)), span(p.turns ?? "unknown", "number"), span(`${p.busyMinutes}m`, "muted"), span(p.tokens || "unknown", "number")]), columns));
      if (name === "Tasks" && byTask) out.push(...rows(["TASK", "CLASS", "OUTCOME", "TURNS", "WALL"], Object.entries((report as TaskReport).tasks).map(([id, task]) => [span(`#${id}${task.pii ? " [pii]" : ""}`, "taskRef"), span(task.class ?? "unknown"), span(task.outcome ?? "unknown", stateTone(task.outcome ?? "")), span(task.turns, "number"), span(task.wallMs === null ? "unknown" : duration(task.wallMs), "muted")]), columns));
    }
    out.push(...lines(sentence, columns, undefined, "  "));
  }
  return out;
}

// ---- ahub usage (#683 U2): every number names its source; an unknown number prints `unknown`, never 0 ----------------------------------------------
const SOURCE_NAME: Record<Counter["source"], string> = { native: "native", count: "hub count", manual: "manual", partial: "partial, at least", unknown: "unknown" };
/** `1234 (native)`, `1234 (hub count)`, or `unknown`: a missing counter is never shown as zero. */
export const usageNumber = (c: Counter): string => c.value === null ? "unknown" : `${c.value} (${SOURCE_NAME[c.source]})`;
const usageCell = (c: Counter): OutputCell => c.value === null ? span("unknown", "muted") : span(usageNumber(c), "number");

export function renderUsage(result: UsageResult, columns?: number): Span[][] {
  const out = lines(`usage by ${result.by}: ${result.coverage.records} records, ${result.coverage.withUsage} with provider counters, ${result.coverage.withoutUsage} without`, columns, "muted");
  const header = ["KEY", "TOTAL", "WITHOUT CACHE", "CACHE READ", "INPUT", "OUTPUT", "REASONING", "HUB COUNT"];
  const row = (r: UsageResult["rows"][number]) => [span(r.pii ? `${r.key} [pii]` : r.key), usageCell(r.total), usageCell(r.totalWithoutCache), usageCell(r.cacheRead), usageCell(r.input), usageCell(r.output), usageCell(r.reasoning), usageCell(r.counted)];
  const all = [...result.rows, ...(result.unattributed ? [result.unattributed] : [])];
  if (!all.length) return [...out, ...lines("no usage recorded in this period", columns)];
  return [...out, [], ...rows(header, all.map(row), columns, undefined, true),
    ...lines("TOTAL is the provider's own total, cache reads included; WITHOUT CACHE removes them. HUB COUNT is what the hub counted itself and covers peers that report no usage record. unknown is never zero.", columns, "muted")];
}

export function renderLimits(result: LimitsResult, current: unknown, columns?: number): Span[][] {
  const out = lines(`limit history: ${result.truncated ? `the newest ${result.shown} of ${result.total}` : `${result.total}`} events, ${result.open.length} open pause${result.open.length === 1 ? "" : "s"}`, columns, "muted");
  if (result.truncated) out.push(...lines(`${result.omitted} older events are not shown: use --limit <n> (up to ${result.maxLimit}) for more`, columns, "attention"));
  for (const o of result.open) out.push(...lines(`open pause: ${o.peer} ${o.window} since ${o.since}, resets ${new Date(o.resetsAt).toISOString()}`, columns, "attention"));
  for (const o of result.endedUnknown) out.push(...lines(`pause ended, end unknown: ${o.peer} ${o.window} since ${o.since} (the hub no longer holds it, for example after ahub reset; no resume was recorded)`, columns, "muted"));
  const windows = current && typeof current === "object" ? Object.entries(current as Record<string, { windows?: { id: string; used: number; resetsAt?: number }[] }>) : [];
  const live = windows.flatMap(([peer, b]) => (b?.windows ?? []).map(w => [span(peer), span(w.id), span(`${Math.round(w.used * 100)}%`, "number"), span(w.resetsAt ? new Date(w.resetsAt).toISOString() : "unknown", w.resetsAt ? undefined : "muted")]));
  if (live.length) out.push([], ...lines("current windows", columns, "strong"), ...rows(["PEER", "WINDOW", "USED", "RESETS"], live, columns, undefined, true));
  const hist = result.history.map(h => [span(h.at), span(h.type.replace("budget_", "").replace("quota_reset", "reset")), span(h.peer), span(h.window), span(Object.entries(h.detail).map(([k, v]) => `${k} ${v}`).join(", "), "muted")]);
  if (hist.length) out.push([], ...lines("history", columns, "strong"), ...rows(["AT", "EVENT", "PEER", "WINDOW", "DETAIL"], hist, columns, undefined, true));
  return out;
}

export function renderTotal(result: TotalResult, columns?: number): Span[][] {
  const out = lines(`lifetime development tokens since ${result.since ?? "the first event"}`, columns, "muted");
  const table = result.peers.map(p => [span(p.peer), usageCell(p.tokens), usageCell(p.withoutCache), usageCell(p.cacheRead)]);
  table.push([span("ALL PEERS", "strong"), usageCell(result.overall.tokens), usageCell(result.overall.withoutCache), usageCell(result.overall.cacheRead)]);
  const left = (label: string, peers: string[]) => peers.length ? lines(`${label} leaves out ${peers.join(", ")} (unknown, not counted as 0): a lower bound`, columns, "attention") : [];
  return [...out, [], ...rows(["PEER", "TOTAL", "WITHOUT CACHE", "CACHE READ"], table, columns, undefined, true),
    ...left("ALL PEERS TOTAL", result.overall.tokens.source === "partial" ? result.unknownPeers.tokens : []), ...left("ALL PEERS CACHE READ", result.overall.cacheRead.source === "partial" ? result.unknownPeers.cacheRead : []),
    ...lines("A peer with no provider counters (for example jcode, kimi) shows the hub's own count where one exists, otherwise unknown. The overall WITHOUT CACHE is unknown unless every peer's cache split is known.", columns, "muted")];
}
