import { sanitize } from "../hub/envelope.ts";

export interface Approval {
  id: string; peer: string; title: string; expiresAt: number;
  options: { optionId: string; name: string; kind: string }[];
}
export interface ConsoleEvent { text: string; peer?: string; kind?: string; tone?: Tone }
export interface ConsoleState {
  mode: "stream" | "panels"; panel: number; selection: number; approvalIndex: number;
  input: string; editing: boolean; history: string[]; historyIndex: number;
  approvals: Approval[]; events: ConsoleEvent[]; peers: Record<string, any>; budget: Record<string, any>;
  tasks: any[]; queue: any[]; detail?: Detail; detailOffset: number; help: boolean; notice: string; noticeAt?: number;
  peerFilter?: string; kindFilter?: string; project?: string;
  confirm?: { type: "permission"; id: string; option: string; peer: string } | { type: "command"; args: string[] };
  optionChoice?: string;
}
/** A detail view: text as the stream shows it, or labeled fields. */
export type Detail = string | Record<string, unknown>;
export type ConsoleEffect = { type: "exit" } | { type: "permit"; id: string; option?: string } |
  { type: "command"; args: string[] } | { type: "show"; panel: number; id: string } | { type: "print"; text: string; kind: string; tone?: Tone };
export function initialConsoleState(panels = false): ConsoleState {
  return { mode: panels ? "panels" : "stream", panel: 1, selection: 0, approvalIndex: 0,
    input: "", editing: false, history: [], historyIndex: 0, approvals: [], events: [], peers: {}, budget: {}, tasks: [], queue: [], detailOffset: 0, help: false, notice: "" };
}
/** Strip terminal controls before any daemon or child output reaches a terminal. Preserve printable Unicode. */
export function terminalText(value: unknown): string {
  return sanitize(String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_X^][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\n]?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
}
export type Tone = "info" | "strong" | "success" | "attention" | "failure" | "muted";
export interface Span { text: string; tone?: Tone }
export const PALETTE: Readonly<Record<Tone, string>> = Object.freeze({
  info: "\x1b[36m", strong: "\x1b[1;36m", success: "\x1b[32m", attention: "\x1b[33m", failure: "\x1b[31m", muted: "\x1b[90m",
});
export function paint(line: Span[], color: boolean): string {
  return line.map(span => {
    const text = terminalText(span.text);
    const sgr = span.tone && Object.hasOwn(PALETTE, span.tone) ? PALETTE[span.tone] : undefined;
    return color && sgr && text ? sgr + text + "\x1b[0m" : text;
  }).join("");
}
export function resolveColor(flag: string | undefined, env: { isTTY: boolean; TERM?: string; NO_COLOR?: string }): boolean | Error {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (flag === undefined || flag === "auto") return env.isTTY && env.TERM !== "dumb" && !env.NO_COLOR;
  return new Error("usage: ahub console [--panels] [--color=auto|always|never]");
}
export function stateTone(state: string): Tone | undefined {
  if (state === "idle" || state === "approved") return "success";
  if (["busy", "paused", "in_review", "changes_requested", "ready"].includes(state)) return "attention";
  if (["failed", "check failed", "needs_review"].includes(state)) return "failure";
  return undefined;
}
const span = (text: unknown, tone?: Tone): Span => ({ text: String(text ?? ""), ...(tone ? { tone } : {}) });
/**
 * Clip sanitized plain text to the width and keep the tones of the surviving prefix. Widths are measured as paint()
 * prints them: paint() sanitizes each span again, and a cut that ends a span in `[agent-hub` earns it a `> `.
 */
function fitLine(line: Span[], columns: number): Span[] {
  const clean = line.map(s => ({ ...s, text: terminalText(s.text).replace(/\n/g, " ") }));
  if (Bun.stringWidth(clean.map(s => s.text).join("")) <= columns) return clean;
  const marker = ".".repeat(Math.max(0, Math.min(3, columns)));
  const out: Span[] = []; let room = columns - marker.length;
  for (const s of clean) {
    let part = "";
    for (const char of s.text) { if (Bun.stringWidth(sanitize(part + char)) > room) break; part += char; }
    if (part) out.push({ ...s, text: part });
    if (part !== s.text) break;
    room -= Bun.stringWidth(part);
  }
  if (marker) out.push(span(marker));
  return out;
}
export function fit(value: unknown, columns: number): string {
  return paint(fitLine([span(value)], columns), false);
}
/**
 * A source line keeps its indent and its continuations hang `hang` columns deeper, both capped at half the width, so
 * below that cap wrapped untrusted text never starts where its source line, or a hub line at that indent, starts. Breaks fall
 * at whitespace, which they drop; only a word longer than a whole line is split. A tab counts as one space.
 * Lines come out sanitized: a width counts the `> ` that sanitize() puts before a line starting like a hub header.
 */
export function wrap(value: unknown, columns: number, hang = 4): string[] {
  const lines: string[] = [];
  const half = Math.floor(columns / 2);
  const width = (text: string) => Bun.stringWidth(sanitize(text));
  for (const part of terminalText(value).replace(/\t/g, " ").split("\n")) {
    const indent = /^\s*/.exec(part)![0];
    const lead = Math.min(Bun.stringWidth(indent), half);
    const pad = " ".repeat(Math.min(lead + hang, half));
    const first = lines.length;
    let start = " ".repeat(lead);
    let line = start;
    const push = () => { lines.push(sanitize(line.trimEnd())); line = start = pad; };
    for (const token of part.slice(indent.length).match(/\s+|\S+/g) ?? []) {
      if (width(line + token) <= columns) { line += token; continue; }
      if (line !== start) push();
      if (/^\s/.test(token)) continue;
      for (const char of token) {
        if (line !== start && width(line + char) > columns) push();
        line += char;
      }
    }
    if (line !== start || lines.length === first) lines.push(sanitize(line.trimEnd()));
  }
  return lines;
}
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** `45s`, `12m`, `3h05m`, `2d03h`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}
/** A moment as `in 2h13m` or `12m ago`. */
export const relative = (at: number, now: number) => at > now ? `in ${duration(at - now)}` : `${duration(now - at)} ago`;
const TIME_KEY = /^(?:at|created|updated|since|expires)$|At$/;
/** A detail value as text, never JSON: times relative, shares as percent, one list item per line, objects as `key value` pairs. */
function detailText(value: unknown, key: string, now: number): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number" && TIME_KEY.test(key)) return relative(value, now);
  if (typeof value === "number" && key === "used") return `${Math.round(value * 100)}%`;
  if (Array.isArray(value)) return value.length ? value.map(item => detailText(item, key, now)).join("\n") : "-";
  if (typeof value === "object") return Object.entries(value).map(([k, v]) => `${k} ${detailText(v, k, now)}`).join("; ") || "-";
  return String(value);
}
/** Labels at column 0 and every value line one column past the longest label, so untrusted text never starts where a label does. */
function fieldLines(fields: [string, unknown][], columns: number, now: number): Span[][][] {
  const pad = Math.min(16, Math.max(0, ...fields.map(([label]) => Bun.stringWidth(label))) + 2);
  return fields.map(([label, value]) => wrap(detailText(value, label, now), columns - pad).map((text, i) => {
    const head = i ? "" : fit(label, pad - 2);
    return [span(head + " ".repeat(pad - Bun.stringWidth(head)), i ? undefined : "info"), span(text)];
  }));
}
const detailLines = (detail: Detail, columns: number, now: number): Span[][] =>
  typeof detail === "string" ? wrap(detail, columns).map(text => [span(text)]) : fieldLines(Object.entries(detail), columns, now).flat();
const allowOptions = (a: Approval) => a.options.filter(o => o.kind.startsWith("allow"));
/** A request as labeled fields: allow options numbered as `a` offers them, then deny. */
function approvalFields(a: Approval): [string, unknown][] {
  const allow = allowOptions(a);
  return [["request", a.id], ["peer", a.peer], ["expires", a.expiresAt], ["title", a.title],
    ["a allow", allow.length > 1 ? allow.map((o, i) => `${i + 1} ${o.name}`) : allow[0]?.name], ["d deny", "at once, no confirmation"]];
}
/** How the stream shows a permission request: hub text at columns 2 and 4, title lines framed at column 6. */
export function permissionText(a: Pick<Approval, "id" | "peer" | "title" | "options">): string {
  return `  ? ${a.peer} asks permission: ${String(a.title).replace(/\n/g, "\n      | ")}\n    answer with: ahub permit ${a.id} <${a.options.map(o => `${o.optionId} (${o.name})`).join(", ")}> | deny`;
}
const KEYS: [string, string[]][] = [
  ["Everywhere", ["Tab stream/panels", "1-5 panel", ": command", "? keys", "Esc back", "q quit"]],
  ["Command", ["Enter run", "Esc cancel", "Up/Down history", "Ctrl-U clear"]],
  ["Lists", ["j/k or arrows move", "Enter view", "j/k scroll a view"]],
  ["Approvals", ["a allow (then y)", "d deny", "v view", "[ ] select"]],
  ["Peers", ["p pause", "r resume"]],
  ["Tasks", ["a assign (then y)", "r review"]],
  ["Queue", ["r resolve (reason, then y)"]],
  ["Events", ["f peer filter", "g kind filter"]],
];
/** The `?` key table: one group per panel, its keys kept whole and packed into the width after the group column. */
export function keyTable(columns: number): Span[][] {
  const lines: Span[][] = []; const pad = 12;
  for (const [group, items] of KEYS) {
    let text = ""; let head = group;
    const flush = () => { lines.push([span(head.padEnd(pad), head ? "info" : undefined), span(text)]); head = ""; text = ""; };
    for (const item of items) { if (text && pad + Bun.stringWidth(`${text}   ${item}`) > columns) flush(); text = text ? `${text}   ${item}` : item; }
    flush();
  }
  return lines;
}
export function pruneApprovals(s: ConsoleState, now: number): ConsoleState {
  const approvals = s.approvals.filter(a => a.expiresAt > now);
  const live = (id: string) => approvals.some(a => a.id === id);
  return { ...s, approvals, approvalIndex: Math.min(s.approvalIndex, Math.max(0, approvals.length - 1)),
    ...(s.confirm?.type === "permission" && !live(s.confirm.id) ? { confirm: undefined } : {}),
    ...(s.optionChoice && !live(s.optionChoice) ? { optionChoice: undefined } : {}) };
}
const COMMANDS = new Set(["status", "board", "task", "review", "say", "pause", "resume", "budget", "queue", "permit", "ask", "remember", "route", "turns", "undo", "check-path", "report"]);
/** A tiny argv parser, never a shell. Quotes group arguments; backslash escapes one character. */
export function parseConsoleCommand(input: string): string[] {
  const words: string[] = []; let word = ""; let quote = ""; let escaped = false; let started = false;
  for (const char of input.trim()) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === "\\") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error("unfinished quote or escape");
  if (started) words.push(word);
  if (!COMMANDS.has(words[0] ?? "")) throw new Error("use another shell for this command");
  if (words.some(w => w === "--project" || w.startsWith("--project="))) throw new Error("console commands stay in the selected project");
  return words;
}
export function commandNeedsConfirmation(args: string[]): boolean {
  return (args[0] === "task" && args[1] === "assign") || (args[0] === "queue" && args[1] === "resolve") || (args[0] === "permit" && args[2] !== "deny");
}
export function panelRows(s: ConsoleState): any[] {
  if (s.panel === 1) return Object.entries(s.peers).map(([id, peer]) => ({ id, ...peer, budget: s.budget[id] }));
  if (s.panel === 2) return s.approvals;
  if (s.panel === 3) {
    const states = ["proposed", "in_progress", "in_review", "changes_requested"];
    return s.tasks.filter(t => states.includes(t.state)).sort((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  }
  if (s.panel === 4) return s.queue.filter(q => q.state === "needs_review" || q.state === "queued");
  return s.events.filter(e => (!s.peerFilter || e.peer === s.peerFilter) && (!s.kindFilter || e.kind === s.kindFilter));
}
export function reduceConsole(state: ConsoleState, key: string, now = Date.now()): { state: ConsoleState; effects: ConsoleEffect[] } {
  let s = pruneApprovals({ ...state }, now); const effects: ConsoleEffect[] = [];
  const done = () => ({ state: s, effects });
  s.notice = ""; // a notice answers the key before this one
  if (key === "\x03") { effects.push({ type: "exit" }); return done(); }
  if (s.confirm) {
    const confirm = s.confirm; s.confirm = undefined;
    if (key === "y") {
      if (confirm.type === "command") effects.push({ type: "command", args: confirm.args });
      else if (s.approvals.some(a => a.id === confirm.id && a.options.some(o => o.optionId === confirm.option && o.kind.startsWith("allow")))) {
        effects.push({ type: "permit", id: confirm.id, option: confirm.option });
        s.approvals = s.approvals.filter(a => a.id !== confirm.id);
      }
    }
    return done();
  }
  if (s.editing || s.input) {
    if (key === "\x1b") { s.input = ""; s.editing = false; }
    else if (key === "\x7f" || key === "\b") s.input = Array.from(s.input).slice(0, -1).join("");
    else if (key === "\x15") s.input = "";
    else if (key === "\x1b[A" || key === "\x1b[B") {
      s.historyIndex = Math.max(0, Math.min(s.history.length, s.historyIndex + (key === "\x1b[A" ? -1 : 1)));
      s.input = s.history[s.historyIndex] ?? "";
    } else if (key === "\r" || key === "\n") {
      const input = s.input; s.input = ""; s.editing = false;
      if (!input.trim()) return done();
      try {
        const args = parseConsoleCommand(input);
        if (args[0] === "queue" && args[1] === "resolve") {
          const reason = args.indexOf("--reason");
          if (reason < 0 || !args[reason + 1]?.trim()) throw new Error("queue resolve requires --reason");
        }
        s.history = [...s.history, input].slice(-100); s.historyIndex = s.history.length;
        if (commandNeedsConfirmation(args)) s.confirm = { type: "command", args };
        else effects.push({ type: "command", args });
      } catch (error) { s.notice = String((error as Error).message); s.noticeAt = now; }
    } else if (!key.startsWith("\x1b")) s.input += terminalText(key).replace(/\n/g, "");
    return done();
  }
  if (key === "q") { effects.push({ type: "exit" }); return done(); }
  if (key === "\t") { s.mode = s.mode === "panels" ? "stream" : "panels"; s.detail = undefined; return done(); }
  if (key === ":") { s.editing = true; return done(); }
  if (s.mode === "panels" && /^[1-5]$/.test(key) && !s.optionChoice) { s.panel = Number(key); s.selection = 0; s.detail = undefined; return done(); }
  if (key === "?") {
    if (s.mode === "stream") effects.push({ type: "print", text: keyTable(80).map(line => paint(line, false)).join("\n"), kind: "console" });
    else s.help = !s.help;
    return done();
  }
  if (key === "\x1b") { s.detail = undefined; s.help = false; s.optionChoice = undefined; return done(); }
  if (s.mode === "panels" && ["j", "k", "\x1b[A", "\x1b[B"].includes(key)) {
    if (s.detail !== undefined) { s.detailOffset = Math.max(0, s.detailOffset + (["j", "\x1b[B"].includes(key) ? 1 : -1)); return done(); }
    s.selection = Math.max(0, Math.min(panelRows(s).length - 1, s.selection + (["j", "\x1b[B"].includes(key) ? 1 : -1)));
    if (s.panel === 2) s.approvalIndex = s.selection;
    return done();
  }
  if (key === "[" || key === "]") {
    s.approvalIndex = (s.approvalIndex + (key === "[" ? -1 : 1) + s.approvals.length) % Math.max(1, s.approvals.length); return done();
  }
  const approval = s.approvals[s.approvalIndex];
  if (s.optionChoice) {
    const a = s.approvals.find(a => a.id === s.optionChoice);
    const option = a && allowOptions(a)[Number(key) - 1];
    if (/^[1-9]$/.test(key) && a && option) { s.confirm = { type: "permission", id: a.id, peer: a.peer, option: option.optionId }; s.optionChoice = undefined; }
    return done();
  }
  if (approval && (s.mode === "stream" || s.panel === 2)) {
    if (key === "d") { effects.push({ type: "permit", id: approval.id }); s.approvals = s.approvals.filter(a => a.id !== approval.id); return done(); }
    if (key === "a") {
      const options = allowOptions(approval);
      if (options.length === 1) s.confirm = { type: "permission", id: approval.id, peer: approval.peer, option: options[0]!.optionId };
      else if (options.length) s.optionChoice = approval.id;
      return done();
    }
    if (key === "v" && s.mode === "stream") { effects.push({ type: "print", text: permissionText(approval), kind: "permission", tone: "attention" }); return done(); }
    if (key === "v") { s.detail = Object.fromEntries(approvalFields(approval)); s.detailOffset = 0; return done(); }
  }
  const row = panelRows(s)[s.selection];
  if (s.mode === "panels" && row) {
    if (key === "\r" || key === "\n") {
      if (s.panel === 3 || s.panel === 4) effects.push({ type: "show", panel: s.panel, id: String(row.id) });
      else { s.detail = s.panel === 2 ? Object.fromEntries(approvalFields(row)) : s.panel === 5 ? String(row.text) : { ...row }; s.detailOffset = 0; }
      return done();
    }
    const prefill = s.panel === 1 && key === "p" ? `pause ${row.id}` : s.panel === 1 && key === "r" ? `resume ${row.id}` :
      s.panel === 3 && key === "a" ? `task assign ${row.id} ` : s.panel === 3 && key === "r" ? `review ${row.id} ` :
      s.panel === 4 && key === "r" ? `queue resolve ${row.id} --action retry --reason ` : undefined;
    if (prefill) { s.input = prefill; s.editing = true; return done(); }
  }
  if (s.mode === "panels" && s.panel === 5 && (key === "f" || key === "g")) {
    const field = key === "f" ? "peer" : "kind"; const current = key === "f" ? s.peerFilter : s.kindFilter;
    const values = [...new Set(s.events.map(e => e[field]).filter((x): x is string => !!x))];
    const next = values[values.indexOf(current ?? "") + 1];
    if (key === "f") s.peerFilter = next; else s.kindFilter = next;
    s.selection = 0; return done();
  }
  if (s.mode === "stream" && !key.startsWith("\x1b")) { s.editing = true; s.input = terminalText(key).replace(/\n/g, ""); }
  return done();
}
export function renderConsole(s: ConsoleState, columns: number, rows = 24, now = Date.now()): string[] {
  return renderConsoleLines(s, columns, rows, now).map(line => paint(line, false));
}
const NOTICE_MS = 10_000;
const TABLES: Record<number, string[]> = {
  1: ["PEER", "STATE", "LINK", "Q", "!", "REVIEW", "PAUSE", "QUOTA", "MODEL"],
  2: ["ID", "PEER", "LEFT", "TITLE"],
  3: ["ID", "STATE", "OWNER", "REVIEWER", "CLASS", "AGE", "TITLE"],
  4: ["ID", "PEER", "STATE", "REV", "AGE"],
};
const count = (n: unknown) => typeof n === "number" && n ? String(n) : "-";
/** One span per column of a panel row; zero counters and unknown values read `-`. */
function cells(s: ConsoleState, row: any, selected: boolean, now: number): Span[] {
  const id = (text: unknown, tone: Tone | undefined = "info") => span(text, tone && (selected ? "strong" : tone));
  if (s.panel === 1) {
    const b = s.budget[row.id];
    const paused = b?.paused ? `budget ${relative(b.paused.resetsAt, now)}` : row.paused && typeof row.paused === "object"
      ? `${row.paused.by ?? "paused"}${typeof row.paused.at === "number" ? ` ${duration(now - row.paused.at)}` : ""}`
      : row.paused === "manual" ? "user" : row.paused ? String(row.paused).split(":")[0] : "-";
    return [id(row.id, row.state === "offline" ? undefined : "info"), span(row.state, stateTone(row.state)),
      span(row.toolsOnly ? "tools-only" : row.attached === false ? "detached" : "attached", row.toolsOnly ? "attention" : undefined),
      span(count(row.queued)), span(count(row.queuedImportant), row.queuedImportant ? "attention" : undefined),
      span(count(row.needsReview), row.needsReview ? "failure" : undefined), span(paused, paused === "-" ? undefined : "attention"),
      span(b?.windows?.length ? b.windows.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%${typeof w.resetsAt === "number" ? ` ${relative(w.resetsAt, now)}` : ""}`).join(", ") : "-"),
      span(row.servedBy ?? row.requestedModel ?? "-")];
  }
  if (s.panel === 2) return [id(row.id, "attention"), span(row.peer, "attention"), span(duration(row.expiresAt - now), "muted"), span(row.title)];
  if (s.panel === 3) {
    const last = row.history?.at(-1);
    const at = last?.at ?? row.updated ?? row.created;
    const failed = last?.event === "check failed" || last?.event === "failed";
    return [id(`#${row.id}`), span(`${row.state}${failed && row.state !== last.event ? ` ${last.event}` : ""}${row.ready ? " ready" : ""}`, failed ? "failure" : row.ready ? "attention" : stateTone(row.state)),
      span(row.owner ?? "-"), span(row.reviewer ?? "-"), span(row.class ?? "-"), span(typeof at === "number" ? duration(now - at) : "-", "muted"), span(row.title)];
  }
  if (s.panel === 4) return [id(row.id), span(row.peer), span(row.state, stateTone(row.state)), span(row.revision ?? "-"), span(typeof row.createdAt === "number" ? duration(now - row.createdAt) : "-", "muted")];
  const [header, ...body] = String(row.text).split("\n");
  return [span(header, row.tone), ...(body.length ? [span("\n" + body.join("\n"))] : [])];
}
/**
 * A header row, then the rows, each column starting at the same place on every row: two spaces apart, as wide as its
 * widest cell or header (Bun.stringWidth, at most a third of the width, wider cells cut with the marker); the last column
 * takes the rest.
 */
function table(head: string[], rows: Span[][], columns: number): Span[][] {
  const cap = Math.max(24, Math.floor(columns / 3));
  const width = (cell: Span | undefined) => Bun.stringWidth(terminalText(cell?.text).replace(/\n/g, " "));
  const widths = head.map((h, i) => Math.min(cap, rows.reduce((max, row) => Math.max(max, width(row[i])), Bun.stringWidth(h))));
  return [head.map(h => span(h, "info")), ...rows].map(row => row.map((cell, i) => {
    if (i === head.length - 1) return cell;
    const text = fit(cell.text, widths[i]!);
    return { ...cell, text: text + " ".repeat(widths[i]! - Bun.stringWidth(text) + 2) };
  }));
}
/** The footer's key hint: only keys that act in this mode, panel and state. */
function hint(s: ConsoleState): string {
  const pending = s.approvals.length ? ["a allow", "d deny"] : [];
  if (s.mode === "stream") return [...pending, ...(pending.length ? ["v view"] : []), ...(s.approvals.length > 1 ? ["[ ] select"] : []), "Tab panels", ": command", "? keys", "q quit"].join("  ");
  if (s.help) return "? or Esc close  q quit";
  const approvals = s.panel === 2 ? pending : [];
  if (s.detail !== undefined) return [...approvals, "j/k scroll", "Esc back", "? keys", "q quit"].join("  ");
  const row = panelRows(s)[s.selection];
  const context = !row ? [] : s.panel === 1 ? ["p pause", "r resume"] : s.panel === 3 ? ["a assign", "r review"] : s.panel === 4 ? ["r resolve"] : [];
  return [...approvals, ...context, ...(s.panel === 5 ? ["f peer", "g kind"] : []), ...(row ? ["j/k move", "Enter view"] : []), "? keys", ": command", "Tab stream", "q quit"].join("  ");
}
/** The project, then the tabs: the active one in brackets, pending approvals and held deliveries counted. */
function header(s: ConsoleState, columns: number): Span[] {
  const counts = [0, s.approvals.length, 0, s.queue.filter(q => q.state === "needs_review").length, 0];
  const tabs: Span[] = [];
  for (const [i, name] of ["Peers", "Approvals", "Tasks", "Queue", "Events"].entries()) {
    const active = i + 1 === s.panel; const tone = active ? "strong" : "info";
    tabs.push(span(active ? " [" : "  ", tone), span(`${i + 1} ${name}`, tone));
    if (counts[i]) tabs.push(span(` ${counts[i]}`, i === 1 ? "attention" : "failure"));
    tabs.push(span(active ? "]" : " ", tone));
  }
  return fitLine([span(fit(s.project ?? "agent-hub", Math.max(0, columns - Bun.stringWidth(tabs.map(t => t.text).join("")))), "info"), ...tabs], columns);
}
export function renderConsoleLines(s: ConsoleState, columns: number, rows = 24, now = Date.now()): Span[][] {
  const permission = s.approvals[s.approvalIndex];
  let prompt = s.editing ? `: ${s.input}` : hint(s);
  if (s.confirm?.type === "permission") prompt = `allow ${s.confirm.option} for ${s.confirm.peer} (request ${s.confirm.id})? y/N`;
  if (s.confirm?.type === "command") prompt = `${s.confirm.args.join(" ")}? y/N`;
  const choice = s.optionChoice ? s.approvals.find(a => a.id === s.optionChoice) : undefined;
  if (choice) prompt = `allow with: ${allowOptions(choice).map((o, i) => `${i + 1} ${o.name}`).join("  ")}  Esc cancel`;
  const summary: Span[] = [];
  for (const [id, p] of Object.entries(s.peers)) {
    if (summary.length) summary.push(span(" "));
    summary.push(span(id, p.state === "offline" ? undefined : "info"), span(":"), span(p.state, stateTone(p.state)), span(` q${p.queued ?? 0}`));
    if (p.needsReview) summary.push(span(` review${p.needsReview}`, "failure"));
    if (p.paused) summary.push(span(" paused", "attention"));
    if (p.toolsOnly) summary.push(span(" tools-only: ahub claude", "attention"));
  }
  const quotas = Object.entries(s.budget).map(([id, b]) => `${id}:${b.windows?.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%`).join("/") ?? "?"}`).join(" ");
  if (quotas) summary.push(span(` | ${quotas}`));
  const approvals = [span(plural(s.approvals.length, "approval"), s.approvals.length ? "attention" : undefined)];
  if (permission) approvals.push(span(` | ${permission.peer} ${permission.id}`, "attention"), span(` ${duration(permission.expiresAt - now)} left`, "muted"));
  if (s.notice && now - (s.noticeAt ?? now) < NOTICE_MS) approvals.push(span(" | "), span(s.notice, "failure"));
  const footer = [fitLine(summary, columns), fitLine(approvals, columns), fitLine([span(prompt, s.confirm || s.optionChoice ? "attention" : undefined)], columns)];
  const rule = [span("-".repeat(Math.max(0, columns)), "muted")];
  if (s.mode === "stream") return [rule, ...footer];
  const height = rows - 6; // header, rule, body, rule, three footer lines
  const lines: Span[][] = [];
  if (s.help) lines.push(...keyTable(columns));
  else if (s.detail !== undefined) { const detail = detailLines(s.detail, columns, now); lines.push(...detail.slice(Math.min(s.detailOffset, Math.max(0, detail.length - height)))); }
  else {
    const data = panelRows(s); const head = TABLES[s.panel];
    const capacity = Math.max(1, s.panel === 2 ? Math.floor(height / 2) - 1 : height - 1); const start = Math.max(0, s.selection - capacity + 1);
    const rowsOf = head ? table(head, data.map((row, i) => cells(s, row, i === s.selection, now)), columns) : undefined;
    lines.push(fitLine([span("  "), ...(rowsOf?.[0] ?? [span(`peer ${s.peerFilter ?? "all"}  kind ${s.kindFilter ?? "all"}`, "info")])], columns));
    for (let i = start; i < Math.min(data.length, start + capacity); i++) {
      const selected = i === s.selection;
      lines.push(fitLine([span(selected ? "> " : "  ", selected ? "strong" : undefined), ...(rowsOf?.[i + 1] ?? cells(s, data[i], selected, now))], columns));
    }
    if (!data.length) lines.push([span("  (empty)")]);
    if (s.panel === 2 && permission) {
      const [title = [], ...rest] = fieldLines(approvalFields(permission).slice(3), columns, now);
      const tail = rest.flat(); const room = Math.max(1, height - lines.length - 1 - tail.length);
      if (title.length > room) { // the label column is the hub's own: mark a cut title there, Enter shows it whole
        title.length = room;
        const [label, ...value] = title[room - 1]!;
        title[room - 1] = [span("(more)".padEnd(Bun.stringWidth(label!.text)), "attention"), ...value];
      }
      lines.push(rule, ...title, ...tail);
    }
  }
  const body = lines.slice(0, height); while (body.length < height) body.push([]);
  return [header(s, columns), rule, ...body, rule, ...footer];
}
