import { consoleNeeds, characterAttentionLine, attentionCommand } from "./attention.ts";
import { CHARACTERS, petFrame, petSize, petFooterRows, type CharacterId, type PetSize, type PetPose } from "../pet/frame.ts";
import { PEER_PALETTE } from "../ui/peer-palette.ts";
import { PERMISSION_MODES, permissionBoundary } from "../hub/permission-mode.ts";
import { PLANNER_PEERS, definitionOf, nativeStreamTone } from "../adapters/registry.ts";
import { taskProgress } from "../ui/task-progress.ts";
import type { ProgressStage } from "../ui/task-progress.ts";
import { sanitize } from "../hub/envelope.ts";
import type { SettingRow, SettingValue } from "../hub/settings.ts";

export interface Approval {
  id: string; peer: string; title: string; expiresAt: number;
  options: { optionId: string; name: string; kind: string }[];
}
export interface PermissionDefault { peer: string; mode: "never-ask"; source: string }
export interface ConsoleEvent { text: string; peer?: string; kind?: string; tone?: Tone }
export interface SettingsEdit {
  token: number; key?: string; undo: boolean; phase: "value" | "preview" | "reason" | "confirm";
  /** The existing editor can also be opened by the Peers WIP shortcut. */
  panel?: 1 | 6;
  text: string; value?: SettingValue; reason?: string; lines?: string[]; confirm?: string; undoDigest?: string;
}
export interface ConsoleState {
  settingsRows?: SettingRow[]; settingsKnown?: boolean; settingsUndo?: string; settingsProblem?: string;
  settingsEdit?: SettingsEdit; settingsSequence?: number;
  pendingRestart?: { key: string; reason: string }[];
  retainedConfig?: { key: string; reason: string }[];
  features?: readonly string[];
  /** Older embedding callers omit choices and retain the original STAI/off toggle. */
  petChoices?: readonly CharacterId[]; petCharacter?: CharacterId; petSize?: PetSize; petGlyphs?: "ascii" | "blocks";
  attentionFacts?: { kind: "review" | "offline" | "stall" | "offer"; id: number; peer?: string }[];
  attentionFingerprint?: string;
  petEnabled?: boolean; petBlink?: boolean; attentionMessages?: { id?: string; peer?: string; important: boolean; since?: number }[]; storageBlocked?: boolean; recoveryNeed?: { id?: string; running: boolean; since?: number }; attentionSelection?: number;
  mode: "stream" | "panels"; panel: number; selection: number;
  /** The selected request, by id: a, d and v act on it alone, and it is cleared, never moved, when the request closes. */
  approvalId?: string;
  /** The request whose detail is open: always the selected one (see `bound`). */
  requestDetail?: string;
  /** A request was selected on arrival once; after that only [ ], j or k select, so a closed selection never moves. */
  autoSelected?: boolean;
  input: string; editing: boolean; history: string[]; historyIndex: number;
  approvals: Approval[]; events: ConsoleEvent[]; peers: Record<string, any>; budget: Record<string, any>;
  taskWip?: Record<string, { wip: number; wipLimit: number }>;
  tasks: any[]; tasksKnown?: boolean; taskCounts?: Record<string, number>; queue: any[]; detail?: Detail; detailOffset: number; help: boolean; notice: string; noticeAt?: number; noticeTone?: Tone;
  peerFilter?: string; kindFilter?: string; project?: string;
  taskSelection?: number; queueSelection?: string;
  actionLock?: { prefix: string[]; id: string; revision: number; state: string; owner?: string; reserved?: string; reviewer?: string; waiting?: boolean };
  confirm?: { type: "permission"; id: string; option: string; peer: string } | { type: "command"; args: string[]; prompt?: string } | { type: "permission_default"; peer: string; source: string };
  optionChoice?: string;
  modeChoice?: string;
  permissionDefaults: PermissionDefault[];
  permissionDefaultsHandled: string[];
}
/** A detail view: text as the stream shows it, or labeled fields. */
export type Detail = string | Record<string, unknown>;
export type ConsoleEffect = { type: "exit" } | { type: "permit"; id: string; option?: string } |
  { type: "settings_preview"; token: number; key?: string; value?: SettingValue; undo: boolean } |
  { type: "settings_write"; key?: string; value?: SettingValue; undo: boolean; reason: string; confirm?: string; undoDigest?: string } |
  { type: "permission_default"; peer: string; confirmed: boolean } | { type: "command"; args: string[] } | { type: "show"; panel: number; id: string } | { type: "print"; text: string; kind: string; tone?: Tone } | { type: "keys" };
export function initialConsoleState(panels = false): ConsoleState {
  return { mode: panels ? "panels" : "stream", panel: 1, selection: 0,
    input: "", editing: false, history: [], historyIndex: 0, approvals: [], events: [], peers: {}, budget: {}, tasks: [], tasksKnown: false, queue: [], permissionDefaults: [], permissionDefaultsHandled: [], detailOffset: 0, help: false, notice: "" };
}
export { permissionBoundary };
function permissionModeRefusal(peer: string, mode: unknown): string | undefined {
  if (mode === "unmanaged") return `${peer} permission mode is unmanaged; use its native controls`;
  if (mode === "unverified") return `${peer} permission mode is unverified; start with ahub ${peer} and run a tool first`;
  if (mode === "unknown") return `${peer} permission mode is unknown; inspect or reconnect its native session`;
  return undefined;
}
/** Queue sizes and timestamps do not make a refused/default-deferred peer ready. */
function permissionDefaultFingerprint(s: ConsoleState, row: Pick<PermissionDefault, "peer" | "source">): string {
  const peer = s.peers[row.peer];
  // Readiness, not activity: a peer going idle or busy does not make a deferred default worth asking about again.
  return JSON.stringify([row.peer, row.source, !peer ? "absent" : peer.state === "offline" ? "offline" : "attached", peer?.permissionMode ?? "ask", peer?.attached ?? !!peer, peer?.claiming ?? false, peer?.toolsOnly ?? false]);
}
/** Offer one file default only when no other keyboard decision or edit is active. */
export function syncPermissionDefaults(s: ConsoleState, rows: unknown): boolean {
  if (!Array.isArray(rows)) rows = [];
  s.permissionDefaults = (rows as unknown[]).filter((row): row is PermissionDefault => !!row && typeof row === "object" &&
    typeof (row as PermissionDefault).peer === "string" && (row as PermissionDefault).mode === "never-ask" && typeof (row as PermissionDefault).source === "string");
  const current = new Set(s.permissionDefaults.map(row => permissionDefaultFingerprint(s, row)));
  s.permissionDefaultsHandled = s.permissionDefaultsHandled.filter(fingerprint => current.has(fingerprint));
  const pending = s.confirm;
  if (pending?.type === "permission_default" && !s.permissionDefaults.some(row => row.peer === pending.peer && row.source === pending.source)) s.confirm = undefined;
  if (s.settingsEdit || s.confirm || s.editing || s.input || s.modeChoice || s.optionChoice || s.help) return false;
  const next = s.permissionDefaults.find(row => !s.permissionDefaultsHandled.includes(permissionDefaultFingerprint(s, row)));
  if (!next) return false;
  s.confirm = { type: "permission_default", peer: next.peer, source: next.source };
  return true;
}
export function permissionDefaultText(row: Pick<PermissionDefault, "peer" | "source">): string {
  return `never-ask default for ${row.peer} from ${quoted(row.source)}\n${permissionBoundary(row.peer)}\nUntil you answer y, this default stays ask. y enables; n cancels for this hub; Esc defers.`;
}
/** Strip terminal controls before any daemon or child output reaches a terminal. Preserve printable Unicode. */
export function terminalText(value: unknown): string {
  return sanitize(String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_X^][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\n]?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
}
export type Tone = "info" | "strong" | "success" | "attention" | "failure" | "muted" | "peerClaude" | "peerCodex" | "taskKeyword" | "number" | "issueRef" | "taskRef";
export interface Span { text: string; tone?: Tone }
export const PALETTE: Readonly<Record<Tone, string>> = Object.freeze({
  info: PEER_PALETTE.hub.ansi, strong: "\x1b[1;36m", success: PEER_PALETTE.local.ansi, attention: PEER_PALETTE.pi.ansi, failure: "\x1b[31m", muted: PEER_PALETTE.other.ansi,
  peerClaude: PEER_PALETTE.claude.ansi, peerCodex: PEER_PALETTE.codex.ansi,
  taskKeyword: PEER_PALETTE.kimi.ansi, number: "\x1b[1m", issueRef: "\x1b[4m", taskRef: "\x1b[4;35m",
});
export function paint(line: Span[], color: boolean): string {
  return line.map(span => {
    const text = terminalText(span.text);
    const sgr = span.tone && Object.hasOwn(PALETTE, span.tone) ? PALETTE[span.tone] : undefined;
    return color && sgr && text ? sgr + text + "\x1b[0m" : text;
  }).join("");
}
/** Console stream headers only. Tokenize sanitized text; bodies and command output stay plain. */
export function streamTokens(value: string, eventTone?: Tone, kind?: string): Span[] {
  const text = terminalText(value);
  if (kind === "command" || kind === "console") return [{ text }];
  // Hub-written peer slots only; words such as local/pi/hub in a title do not identify a speaker.
  const peerSlots = new Set<number>();
  const leading = text.match(/^\s*(?:[.?*!]\s+)?([A-Za-z_][A-Za-z_0-9-]*)(?=:| is | asks permission:| permission )/);
  if (leading) peerSlots.add(leading[0].lastIndexOf(leading[1]!));
  const route = text.match(/^\s*(?:[0-9:]+ (?:AM|PM) )?([A-Za-z_][A-Za-z_0-9-]*) -> ([A-Za-z_][A-Za-z_0-9,-]*|\*)/);
  if (route) {
    const start = route[0].indexOf(route[1]!); peerSlots.add(start);
    let at = route[0].lastIndexOf(route[2]!);
    for (const recipient of route[2]!.split(",")) { peerSlots.add(at); at += recipient.length + 1; }
  }
  if (/^\s*\* task #[0-9]+ .+ (?:accepted by|assigned to) [A-Za-z_][A-Za-z_0-9-]*$/.test(text) && !/ declined| reason:/.test(text)) {
    const owner = text.match(/(?:accepted by|assigned to) ([A-Za-z_][A-Za-z_0-9-]*)$/);
    if (owner) peerSlots.add(owner.index! + owner[0].lastIndexOf(owner[1]!));
  }
  const marker = text.match(/^\s*([.?*!])/);
  const markerAt = marker ? marker[0].length - 1 : -1;
  const state = kind === "state" ? text.match(/ is ([A-Za-z_]+)$/) : undefined;
  const stateAt = state ? state.index! + 4 : -1;
  const permissionIds = new Set<number>();
  for (const match of text.matchAll(/\b(?:permission|request|permit) ([0-9]{8})(?=\b)/g)) permissionIds.add(match.index + match[0].length - 8);
  const taskKeyword = text.match(/^\s*\*?\s*(task)(?![\w-])/i);
  const taskKeywordAt = taskKeyword ? taskKeyword[0].length - taskKeyword[1]!.length : -1;
  const out: Span[] = []; let end = 0; let previousToken = ""; let previousStart = -1;
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_#-])#[0-9]+(?![\p{L}\p{N}_-])|(?<![\p{L}\p{N}_#.:-])(?:[0-9]+(?::[0-9]+)+(?: AM| PM)?|[0-9]+(?:\.[0-9]+)?(?:%|ms|s|m|h)?)(?![\p{L}\p{N}_%-]|[.:][\p{L}\p{N}])|[A-Za-z_][A-Za-z_0-9-]*|->|[.?*!]/gu)) {
    const token = match[0]; const start = match.index;
    const gap = text.slice(end, start);
    if (gap) out.push({ text: gap });
    let tone: Tone | undefined;
    const peerTone = nativeStreamTone(token);
    // ponytail: legacy notices have no typed reference ranges. Classify task/review prefixes textually;
    // assign/which #N remains an issue reference until notices carry structured reference spans.
    if (token.startsWith("#")) {
      const task = previousToken.toLowerCase() === "task" && /^\s*$/.test(gap);
      const review = previousToken.toLowerCase() === "review" && /^\s*$/.test(gap) && text[previousStart - 1] === "[" && text[start + token.length] === "]";
      tone = task || review ? "taskRef" : "issueRef";
    }
    else if (start === taskKeywordAt) tone = "taskKeyword";
    else if (/^[0-9]/.test(token) && !permissionIds.has(start)) tone = "number";
    else if (peerSlots.has(start) && peerTone) tone = peerTone;
    else if (start === markerAt || start === stateAt || (route && token === "->" && start < route[0].length)) tone = eventTone;
    out.push({ text: token, ...(tone ? { tone } : {}) });
    previousToken = token; previousStart = start; end = start + token.length;
  }
  if (end < text.length) out.push({ text: text.slice(end) });
  return out;
}
/** Wrap plain text first, then project original token spans onto it, preserving trusted slots across continuations. */
export function wrapStreamTokens(value: string, columns: number, tone?: Tone, kind?: string): Span[][] {
  const spans = streamTokens(terminalText(value).replace(/\t/g, " "), tone, kind);
  const text = spans.map(s => s.text).join("");
  let cursor = 0; let projecting = true; let spanIndex = 0; let spanAt = 0;
  return wrap(text, columns).map((line, index) => {
    const content = line.trimStart();
    const start = projecting ? text.indexOf(content, cursor) : -1;
    if (!content || start < 0) {
      if (content) projecting = false;
      // Only the first physical header can have structural markers. Never infer structure from a continuation.
      return index === 0 ? streamTokens(line, tone, kind).map(s => ({ text: s.text, ...(s.tone === tone && tone ? { tone } : {}) })) : [{ text: line }];
    }
    const end = start + content.length; cursor = end;
    const out: Span[] = [{ text: line.slice(0, line.length - content.length) }];
    while (spanIndex < spans.length && spanAt + spans[spanIndex]!.text.length <= start) {
      spanAt += spans[spanIndex++]!.text.length;
    }
    while (spanIndex < spans.length && spanAt < end) {
      const span = spans[spanIndex]!; const next = spanAt + span.text.length;
      out.push({ ...span, text: span.text.slice(Math.max(0, start - spanAt), Math.min(span.text.length, end - spanAt)) });
      if (next > end) break;
      spanAt = next; spanIndex++;
    }
    return out;
  });
}
export function resolveColor(flag: string | undefined, env: { isTTY: boolean; TERM?: string; NO_COLOR?: string }): boolean | Error {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (flag === undefined || flag === "auto") return env.isTTY && env.TERM !== "dumb" && !env.NO_COLOR;
  return new Error("usage: ahub <command> [--color=auto|always|never]");
}
export function stateTone(state: string): Tone | undefined {
  if (state === "idle" || state === "approved") return "success";
  if (["busy", "paused", "in_review", "changes_requested", "ready"].includes(state)) return "attention";
  if (["failed", "check failed", "needs_review"].includes(state)) return "failure";
  return undefined;
}
const span = (text: unknown, tone?: Tone): Span => ({ text: String(text ?? ""), ...(tone ? { tone } : {}) });
/** One line of sanitized text: a newline or a tab becomes a space, as wrap() counts a tab (stringWidth("\t") is 0). */
const flat = (value: unknown) => {
  const text = terminalText(value), line = text.replace(/[\n\t]/g, " ");
  return text.includes("\t") ? terminalText(line) : line;
};
/**
 * Clip sanitized plain text to the width and keep the tones of the surviving prefix. Widths are measured as paint()
 * prints them: paint() sanitizes each span again, and a cut that ends a span in `[agent-hub` earns it a `> `.
 */
export function fitLine(line: Span[], columns: number): Span[] {
  const clean = line.map(s => ({ ...s, text: flat(s.text) }));
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
  // A bare chunk ending in "--- from" becomes a header marker when table padding follows it.
  const quoteChunk = (text: string) => sanitize(text + " ").slice(0, -1);
  const width = (text: string) => Bun.stringWidth(quoteChunk(text));
  for (const part of terminalText(value).replace(/\t/g, " ").split("\n")) {
    const indent = /^\s*/.exec(part)![0];
    const lead = Math.min(Bun.stringWidth(indent), half);
    const pad = " ".repeat(Math.min(lead + hang, half));
    const first = lines.length;
    let start = " ".repeat(lead);
    let line = start;
    const push = () => { lines.push(quoteChunk(line.trimEnd())); line = start = pad; };
    for (const token of part.slice(indent.length).match(/\s+|\S+/g) ?? []) {
      if (width(line + token) <= columns) { line += token; continue; }
      if (line !== start) push();
      if (/^\s/.test(token)) continue;
      for (const char of token) {
        if (line !== start && width(line + char) > columns) push();
        line += char;
      }
    }
    if (line !== start || lines.length === first) lines.push(quoteChunk(line.trimEnd()));
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
const WORD = /^\p{L}[\p{L}\p{N}_./:@#+-]*$/u; // a letter first: `1 2` must not read as two numbers
/**
 * An agent-written string inside hub-built text (a detail below its field, an option name in a prompt): a plain word as
 * it is, anything else JSON-quoted, so no `;`, `,`, `)`, quote or newline in it can end it and pass for hub structure.
 */
export const quoted = (text: unknown) => { const value = String(text ?? ""); return WORD.test(value) ? value : JSON.stringify(value); };
const TIME_KEY = /^(?:at|created|updated|since|expires)$|At$/;
/**
 * A detail value as text, never JSON: times relative, shares as percent, objects as `key value` pairs, nested lists
 * inline. Only a field's own string value shows as written; every string below it goes through `quoted`.
 */
function detailText(value: unknown, key: string, now: number, nested = false): string {
  if (value === null || value === undefined || (value === "" && !nested)) return "-";
  if (typeof value === "number" && TIME_KEY.test(key)) return relative(value, now);
  if (typeof value === "number" && key === "used") return `${Math.round(value * 100)}%`;
  if (Array.isArray(value)) return value.map(item => item && typeof item === "object" && !Array.isArray(item) ? `(${detailText(item, key, now, true)})` : detailText(item, key, now, true)).join(", ") || "-";
  if (typeof value === "object") return Object.entries(value).map(([k, v]) => `${k} ${detailText(v, k, now, true)}`).join("; ") || "-";
  return nested ? quoted(value) : String(value);
}
/**
 * Labels at column 0, values one column past the longest label. A list puts the hub's `- ` before each item, and every
 * other line of a value (its own newlines, wrapped continuations) starts two columns deeper: untrusted text can pass
 * neither for a label nor for an item. Allow options keep one line each, cut rather than wrapped.
 */
function fieldLines(fields: [string, unknown][], columns: number, now: number): Span[][][] {
  const pad = Math.min(16, Math.max(0, ...fields.map(([label]) => Bun.stringWidth(label))) + 2);
  const width = columns - pad - 2;
  return fields.map(([label, value]) => {
    const list = Array.isArray(value) && value.length > 0;
    const items = list ? (value as unknown[]).map(item => detailText(item, label, now, true)) : [detailText(value, label, now)];
    const lines = items.flatMap(item => (label === "a allow" ? [fit(item, width)] : wrap(item, width)).map((text, i) => (i ? "  " : list ? "- " : "") + text));
    return lines.map((text, i) => {
      const head = i ? "" : fit(label, pad - 2);
      return [span(head + " ".repeat(pad - Bun.stringWidth(head)), i ? undefined : "info"), span(text)];
    });
  });
}
const detailLines = (detail: Detail, columns: number, now: number): Span[][] =>
  typeof detail === "string" ? wrap(detail, columns).map(text => [span(text)]) : fieldLines(Object.entries(detail), columns, now).flat();
const allowOptions = (a: Approval) => a.options.filter(o => o.kind.startsWith("allow"));
/** A pushed request as the console keeps it: every agent-supplied field a string, so no draw can throw on one. */
export function approvalFrom(msg: any): Approval {
  return { id: String(msg.id ?? ""), peer: String(msg.peer ?? ""), title: String(msg.title ?? ""), expiresAt: Number(msg.expiresAt),
    options: (Array.isArray(msg.options) ? msg.options : []).map((o: any) => ({ optionId: String(o?.optionId ?? ""), name: String(o?.name ?? ""), kind: String(o?.kind ?? "") })) };
}
/** Errors and refusals take the failure tone; a notice that only informs passes `attention`. */
export function notify(s: ConsoleState, text: string, now: number, tone: Tone = "failure"): void {
  s.notice = text; s.noticeAt = now; s.noticeTone = tone;
}
/** A request as labeled fields: allow options numbered as `a` offers them (`{ 2: name }`: the number is the hub's, the name quoted), then deny. */
function approvalFields(a: Approval): [string, unknown][] {
  const allow = allowOptions(a);
  return [["request", a.id], ["peer", a.peer], ["expires", a.expiresAt], ["title", a.title],
    ["a allow", allow.length > 1 ? allow.map((o, i) => ({ [i + 1]: o.name })) : allow[0] && quoted(allow[0].name)], ["d deny", "at once, no confirmation"]];
}
/** How the stream shows a permission request: hub text at columns 2 and 4, title lines framed at column 6. */
export function permissionText(a: Pick<Approval, "id" | "peer" | "title" | "options">): string {
  return `  ? ${a.peer} asks permission: ${String(a.title).replace(/\n/g, "\n      | ")}\n    answer with: ahub permit ${a.id} <${a.options.map(o => `${quoted(o.optionId)} (${quoted(o.name)})`).join(", ")}> | deny`;
}
/** #441: Home/End as terminals send them, plus `<` and `>` for keyboards without those keys. */
export const FIRST_KEYS = ["<", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"];
export const LAST_KEYS = [">", "\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"];
const KEYS: [string, string[]][] = [
  ["Everywhere", ["Tab stream/panels", ": command", "? keys", "Esc back", "q quit"]],
  ["Command", ["Enter run", "Esc cancel", "Up/Down history", "Ctrl-U clear"]],
  ["Panels", ["1-5 panel", "Left/Right panel", "j/k or Up/Down move", "Home/< first, End/> last", "Enter view", "j/k scroll a view", "w web UI (outside Peers)", "o pet window"]],
  ["Approvals", ["a allow (then y)", "d deny", "v view", "[ ] select"]],
  ["Peers", ["p pause", "r resume", "m permission mode", "w WIP limit", "l make planner (then y)"]],
  ["Tasks", ["a assign/reviewer (then y)", "u unassign (then y)", "r review (in review)"]],
  ["Queue", ["r resolve (reason, then y)", "queued=discard, needs_review=retry"]],
  ["Events", ["f peer filter", "g kind filter"]],
  ["Settings", ["6 Settings panel", "e edit", "u undo", "preview, reason, then y"]],
];
/** The `?` key table: one group per panel, its keys kept whole and packed into the width after the group column. */
export function keyTable(columns: number, attention = false, characters = false): Span[][] {
  const lines: Span[][] = []; const pad = 12;
  for (const [group, items] of [...KEYS, ...(attention ? [[characters ? "Pet" : "Attention", ["n next need", characters ? "P next character/off" : "P STAI/off"]] as [string, string[]]] : [])]) {
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
  const gone = s.approvalId !== undefined && !live(s.approvalId);
  return bound({ ...s, approvals,
    ...(gone ? { approvalId: undefined, notice: `request ${s.approvalId} closed${approvals.length ? "; [ ] selects another" : ""}`, noticeAt: now, noticeTone: "attention" as const } : {}) });
}
/**
 * Everything pending on a request belongs to the selected one: a choice or confirmation for any other request is
 * dropped, and an open detail follows the selection from its top (it closes when nothing is selected). Every reducer
 * exit and every prune passes through here, so no key can act on a request other than the one shown.
 */
function bound(s: ConsoleState): ConsoleState {
  if (s.optionChoice && s.optionChoice !== s.approvalId) s.optionChoice = undefined;
  if (s.confirm?.type === "permission" && s.confirm.id !== s.approvalId) s.confirm = undefined;
  if (s.requestDetail && s.requestDetail !== s.approvalId) { s.requestDetail = s.approvalId; s.detailOffset = 0; }
  return s;
}
const COMMANDS = new Set(["status", "board", "task", "review", "say", "pause", "resume", "budget", "queue", "permit", "permission", "ask", "remember", "route", "sdlc", "turns", "undo", "check-path", "report", "ui", "pet"]);
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
  const positional = args.filter(arg => arg !== "--yes");
  return (positional[0] === "permission" && positional[2] === "never-ask") || (args[0] === "task" && ["assign", "unassign", "cancel"].includes(args[1] ?? "")) || (args[0] === "queue" && args[1] === "resolve") || (args[0] === "permit" && args[2] !== "deny");
}
export function panelRows(s: ConsoleState): any[] {
  if (s.panel === 1) return Object.entries(s.peers).map(([id, peer]) => ({ id, ...peer, budget: s.budget[id] }));
  if (s.panel === 2) return s.approvals;
  if (s.panel === 3) {
    const states = ["proposed", "in_progress", "in_review", "changes_requested"];
    return s.tasks.filter(t => states.includes(t.state)).sort((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  }
  if (s.panel === 6) return [...(s.settingsRows ?? [])].sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
  if (s.panel === 4) return s.queue.filter(q => q.state === "needs_review" || q.state === "queued");
  return s.events.filter(e => (!s.peerFilter || e.peer === s.peerFilter) && (!s.kindFilter || e.kind === s.kindFilter));
}
/** #441: Events follow the newest row while the selection is on the last one; a row the person moved to stays put. */
export function appendEvent(s: ConsoleState, event: ConsoleEvent, cap = 1000): void {
  if (s.panel !== 5) { s.events = [...s.events, event].slice(-cap); return; }
  const before = panelRows(s), held = before[s.selection], following = !held || s.selection >= before.length - 1;
  s.events = [...s.events, event].slice(-cap);
  const rows = panelRows(s);
  s.selection = following ? Math.max(0, rows.length - 1) : Math.max(0, rows.indexOf(held));
}
const newestEvent = (s: ConsoleState) => Math.max(0, panelRows(s).length - 1);
export const selectedApproval = (s: ConsoleState) => s.approvals.find(a => a.id === s.approvalId);
/** The selected row: approvals and refreshed Tasks/Queue rows are bound by id, never by a replacement row. */
const selection = (s: ConsoleState) => {
  if (s.panel === 2) return s.approvals.findIndex(a => a.id === s.approvalId);
  if (s.panel === 3 && s.taskSelection !== undefined) return panelRows(s).findIndex(row => row.id === s.taskSelection);
  if (s.panel === 4 && s.queueSelection !== undefined) return panelRows(s).findIndex(row => row.id === s.queueSelection);
  return s.selection;
};
export const selectedPanelRow = (s: ConsoleState): any | undefined => panelRows(s)[selection(s)];
export function captureConsoleSelection(s: ConsoleState, byIndex = false): void {
  const row = byIndex ? panelRows(s)[s.selection] : selectedPanelRow(s);
  if (s.panel === 3 && row) s.taskSelection = Number(row.id);
  if (s.panel === 4 && row) s.queueSelection = String(row.id);
}
const commandFlag = (args: string[], name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
function validateLockedCommand(lock: NonNullable<ConsoleState["actionLock"]>, args: string[]): void {
  const revisions = args.flatMap((arg, index) => arg === "--revision" ? [args[index + 1]] : []);
  if (args[0] !== lock.prefix[0] || args[1] !== lock.prefix[1] || args[2] !== lock.id || revisions.length !== 1 || revisions[0] !== String(lock.revision)) {
    throw new Error("the selected id and revision cannot be edited; start again from the row");
  }
}
function lockedCommandPrompt(lock: NonNullable<ConsoleState["actionLock"]>, args: string[]): string {
  if (lock.prefix[0] === "queue") {
    const action = commandFlag(args, "--action") ?? "resolve";
    return `${action} delivery ${lock.id} at revision ${lock.revision}${action === "completed" ? "; this asserts external effects" : action === "discard" ? "; no task or native turn is cancelled" : ""}`;
  }
  if (lock.prefix[1] === "cancel") return `cancel task #${lock.id} at revision ${lock.revision}; native turns and worktrees are retained`;
  const role = commandFlag(args, "--role") ?? "owner";
  if (lock.prefix[1] === "assign") return `assign ${role} on task #${lock.id} at revision ${lock.revision}${lock.waiting && role === "owner" ? " as a reservation until dependencies approve" : ""}`;
  const affected = role === "owner" ? [lock.owner, lock.reserved].filter(Boolean).join(" and ") : lock.reviewer ?? "none";
  const resulting = role === "owner" ? "proposed" : lock.state;
  const guidance = role === "reviewer" && lock.state !== "in_review" ? "; later completion without a reviewer may approve directly" : lock.state === "in_review" ? `; use ahub review ${lock.id}` : "";
  return `unassign ${role} ${affected} on task #${lock.id} at revision ${lock.revision} -> ${resulting}${guidance}; native work and uncertain deliveries are not stopped or resolved`;
}
export function reduceConsole(state: ConsoleState, key: string, now = Date.now()): { state: ConsoleState; effects: ConsoleEffect[] } {
  const attentionKeyBlocked = !!(state.settingsEdit || state.confirm || state.optionChoice || state.modeChoice || state.help || state.editing || state.input);
  // A notice answers the key before this one; one that pruning raises now stays.
  let s = pruneApprovals({ ...state, notice: "" }, now); const effects: ConsoleEffect[] = [];
  const done = () => ({ state: bound(s), effects });
  const answered = (id: string) => { s.approvals = s.approvals.filter(a => a.id !== id); if (s.approvalId === id) s.approvalId = undefined; };
  if (key === "\x03") { effects.push({ type: "exit" }); return done(); }
  if (s.settingsEdit) {
    const edit = { ...s.settingsEdit }; s.settingsEdit = edit;
    if (key === "\x1b") { s.settingsEdit = undefined; return done(); }
    if (edit.phase === "preview") return done();
    if (edit.phase === "confirm") {
      s.settingsEdit = undefined;
      if (key === "y") {
        if (edit.undo && (!edit.key || !edit.undoDigest)) { notify(s, "undo preview changed; reload settings and review it again", now); return done(); }
        effects.push({ type: "settings_write", undo: edit.undo, ...(edit.key ? { key: edit.key } : {}), ...(!edit.undo ? { value: edit.value } : { undoDigest: edit.undoDigest }), reason: edit.reason!, ...(edit.confirm ? { confirm: edit.confirm } : {}) });
      }
      return done();
    }
    if (key === "\x7f" || key === "\b") edit.text = Array.from(edit.text).slice(0, -1).join("");
    else if (key === "\x15") edit.text = "";
    else if (key === "\r" || key === "\n") {
      if (edit.phase === "reason") {
        if (!edit.text.trim() || Buffer.byteLength(edit.text.trim()) > 400) { notify(s, "give a reason from 1 to 400 UTF-8 bytes", now); return done(); }
        edit.reason = edit.text.trim(); edit.text = ""; edit.phase = "confirm";
      } else {
        const row = s.settingsRows?.find(row => row.key === edit.key);
        if (!row) { s.settingsEdit = undefined; notify(s, "setting is no longer available", now); return done(); }
        const text = edit.text;
        edit.value = text === "inherit" ? null : row.type === "boolean" ? text === "true" ? true : text === "false" ? false : text : row.type === "number" ? text.trim() && Number.isFinite(Number(text)) ? Number(text) : text : row.type === "integer" ? /^(0|[1-9]\d*)$/.test(text) ? Number(text) : text : row.type === "peers" || row.type === "roles" ? text.split(",").map(value => value.trim()).filter(Boolean) : text;
        edit.phase = "preview"; edit.text = "";
        effects.push({ type: "settings_preview", token: edit.token, key: edit.key, value: edit.value, undo: false });
      }
    } else if (!key.startsWith("\x1b")) edit.text += terminalText(key).replace(/\n/g, "").slice(0, Math.max(0, 1000 - edit.text.length));
    return done();
  }
  if (s.confirm) {
    const confirm = s.confirm; s.confirm = undefined;
    if (confirm.type === "permission_default") {
      if (key !== "y" && key !== "n" && key !== "\x1b") { s.confirm = confirm; return done(); }
      s.permissionDefaultsHandled = [...s.permissionDefaultsHandled, permissionDefaultFingerprint(s, confirm)];
      if (key === "\x1b") { notify(s, `${confirm.peer} never-ask default deferred; remains pending and ask`, now, "attention"); return done(); }
      effects.push({ type: "permission_default", peer: confirm.peer, confirmed: key === "y" });
      return done();
    }
    if (key === "y") {
      if (confirm.type === "command") effects.push({ type: "command", args: confirm.args[0] === "permission" && confirm.args[2] === "never-ask" ? [...confirm.args.filter(arg => arg !== "--yes"), "--yes"] : confirm.args });
      else if (s.approvals.some(a => a.id === confirm.id && allowOptions(a).some(o => o.optionId === confirm.option))) {
        effects.push({ type: "permit", id: confirm.id, option: confirm.option });
        answered(confirm.id);
      }
    }
    return done();
  }
  if (s.modeChoice) {
    const peer = s.modeChoice;
    if (key === "\x1b") { s.modeChoice = undefined; return done(); }
    const mode = PERMISSION_MODES[Number(key) - 1];
    if (/^[1-3]$/.test(key) && mode) {
      s.modeChoice = undefined;
      if (!s.peers[peer] || s.peers[peer].state === "offline") notify(s, `${peer} is no longer attached`, now);
      else if (permissionModeRefusal(peer, s.peers[peer].permissionMode)) notify(s, permissionModeRefusal(peer, s.peers[peer].permissionMode)!, now);
      else if (mode === "never-ask") s.confirm = { type: "command", args: ["permission", peer, mode] };
      else effects.push({ type: "command", args: ["permission", peer, mode] });
    }
    return done();
  }
  if (s.help && s.mode === "panels" && !["?", "\x1b", "q"].includes(key)) return done(); // the key table is modal
  if (s.editing || s.input) {
    if (key === "\x1b") { s.input = ""; s.editing = false; s.actionLock = undefined; }
    else if (key === "\x7f" || key === "\b") s.input = Array.from(s.input).slice(0, -1).join("");
    else if (key === "\x15") s.input = "";
    else if (key === "\x1b[A" || key === "\x1b[B") {
      s.historyIndex = Math.max(0, Math.min(s.history.length, s.historyIndex + (key === "\x1b[A" ? -1 : 1)));
      s.input = s.history[s.historyIndex] ?? "";
    } else if (key === "\r" || key === "\n") {
      const input = s.input, lock = s.actionLock; s.input = ""; s.editing = false; s.actionLock = undefined;
      if (!input.trim()) return done();
      try {
        const parsed = parseConsoleCommand(input);
        const args = parsed[0] === "permission" ? [...parsed.filter(arg => arg !== "--yes"), ...(parsed.includes("--yes") ? ["--yes"] : [])] : parsed;
        if (args[0] === "queue" && args[1] === "resolve") {
          const reason = args.indexOf("--reason"), action = commandFlag(args, "--action");
          if (reason < 0 || !args[reason + 1]?.trim()) throw new Error("queue resolve requires --reason");
          if (!["completed", "retry", "discard"].includes(action ?? "")) throw new Error("queue resolve requires --action completed|retry|discard");
        }
        if (lock) {
          validateLockedCommand(lock, args);
          if (lock.prefix[0] === "task" && !["owner", "reviewer"].includes(commandFlag(args, "--role") ?? "owner")) throw new Error("role must be owner or reviewer");
        }
        s.history = [...s.history, input].slice(-100); s.historyIndex = s.history.length;
        if (commandNeedsConfirmation(args)) s.confirm = { type: "command", args, ...(lock ? { prompt: lockedCommandPrompt(lock, args) } : {}) };
        else effects.push({ type: "command", args });
      } catch (error) { notify(s, String((error as Error).message), now); }
    } else if (!key.startsWith("\x1b")) s.input += terminalText(key).replace(/\n/g, "");
    return done();
  }
  if ((key === "n" || key === "P") && attentionKeyBlocked) return done();
  if (key === "q") { effects.push({ type: "exit" }); return done(); }
  if (key === "P" && !s.optionChoice && !s.help) {
    const choices = s.petChoices;
    if (!choices?.length) s.petEnabled = !s.petEnabled;
    else if (!s.petEnabled) { s.petEnabled = true; s.petCharacter = choices[0]; }
    else { const next = choices.indexOf(s.petCharacter ?? "stai") + 1; s.petEnabled = next < choices.length; if (s.petEnabled) s.petCharacter = choices[next]; }
    return done();
  }
  if (key === "n" && s.petEnabled && !s.optionChoice && !s.help) {
    const items = consoleNeeds(s, now).items;
    if (!items.length) return done();
    const fingerprint = JSON.stringify(items);
    const prior = s.attentionFingerprint === fingerprint ? s.attentionSelection ?? -1 : -1;
    const index = (prior + 1) % items.length;
    s.attentionFingerprint = fingerprint;
    s.attentionSelection = index;
    const item = items[index]!;
    let navigated = false;
    if (item.kind === "approval") {
      s.approvalId = String(item.id);
      if (s.mode === "panels") { s.panel = 2; s.selection = s.approvals.findIndex(row => row.id === item.id); }
      navigated = true;
    } else if (item.kind === "delivery" && s.mode === "panels") {
      const rows = s.queue.filter(row => row.state === "needs_review" || row.state === "queued");
      const selected = item.id === undefined ? -1 : rows.findIndex(row => row.id === item.id);
      if (selected >= 0) { s.panel = 4; s.selection = selected; navigated = true; }
    } else if (item.kind === "review" && s.mode === "panels") {
      const rows = panelRows({ ...s, panel: 3 });
      const selected = rows.findIndex(row => row.id === item.id);
      if (selected >= 0) { s.panel = 3; s.selection = selected; navigated = true; }
    }
    if (navigated) { captureConsoleSelection(s, true); s.detail = undefined; s.requestDetail = undefined; }
    else {
      const command = attentionCommand(item);
      const text = `${item.kind}${item.peer ? ` ${item.peer}` : ""}${item.id ? ` ${item.id}` : ""}: ${command}`;
      if (s.mode === "panels") notify(s, text, now, "attention");
      effects.push({ type: "print", text, kind: "attention", tone: "attention" });
    }
    return done();
  }
  if (key === "\t") { s.mode = s.mode === "panels" ? "stream" : "panels"; s.detail = undefined; s.requestDetail = undefined; return done(); }
  if (key === ":") { s.editing = true; return done(); }
  const switchPanel = (panel: number) => { s.panel = panel; s.selection = panel === 5 ? newestEvent(s) : 0; s.taskSelection = undefined; s.queueSelection = undefined; s.detail = undefined; s.requestDetail = undefined; return done(); };
  if (s.mode === "panels" && /^[1-6]$/.test(key) && !s.optionChoice) return switchPanel(Number(key));
  // Right and Left are the digit of the next or previous tab, wrapping at both ends (#309); the same guards as the
  // digits apply (the confirm, mode-choice, key-table and editing branches above returned already).
  if (s.mode === "panels" && (key === "\x1b[C" || key === "\x1b[D") && !s.optionChoice) return switchPanel(s.panel === 6 ? key === "\x1b[C" ? 1 : 5 : (s.panel + (key === "\x1b[C" ? 0 : 3)) % 5 + 1);
  if (s.mode === "panels" && s.panel === 1 && key === "w") {
    const peer = selectedPanelRow(s)?.id;
    if (!peer || s.detail !== undefined) { notify(s, "select a peer row to edit its planner WIP limit", now); return done(); }
    const wip = s.taskWip?.[peer];
    if (!wip || s.peers[peer]?.rostered === false) { notify(s, `planner WIP is unavailable for ${peer}`, now); return done(); }
    const row = s.settingsRows?.find(row => row.key === `tasks.wip_limits.${peer}`);
    if (!row || s.settingsProblem) { notify(s, s.settingsProblem ?? "WIP setting is unavailable; refresh settings and try again", now); return done(); }
    const token = (s.settingsSequence ?? 0) + 1; s.settingsSequence = token;
    s.settingsEdit = { token, panel: 1, key: row.key, undo: false, phase: "value", text: String(wip.wipLimit) };
    return done();
  }
  if (s.mode === "panels" && s.panel === 6 && s.detail === undefined && (key === "e" || key === "u")) {
    const row = selectedPanelRow(s);
    if (key === "u" && !s.settingsUndo) { notify(s, "nothing to undo", now); return done(); }
    if (key === "e" && !row) return done();
    const token = (s.settingsSequence ?? 0) + 1; s.settingsSequence = token;
    s.settingsEdit = { token, undo: key === "u", ...(key === "e" ? { key: row.key } : {}), phase: key === "u" ? "preview" : "value", text: key === "e" ? settingValueText(row.fileValue) : "" };
    if (key === "u") effects.push({ type: "settings_preview", token, undo: true });
    return done();
  }
  if (key === "?") {
    if (s.mode === "stream") effects.push({ type: "keys" });
    else s.help = !s.help;
    return done();
  }
  if (key === "\x1b") { s.detail = undefined; s.requestDetail = undefined; s.help = false; s.optionChoice = undefined; return done(); }
  // #452: open the project dashboard or the pet window as a person's console command; both return at once.
  if (s.mode === "panels" && (key === "w" || key === "o") && !s.optionChoice) {
    effects.push({ type: "command", args: key === "w" ? ["ui"] : ["pet", "--window"] });
    return done();
  }
  if (s.mode === "panels" && (FIRST_KEYS.includes(key) || LAST_KEYS.includes(key))) {
    const first = FIRST_KEYS.includes(key);
    if (s.detail !== undefined || s.requestDetail) { if (first) s.detailOffset = 0; return done(); }
    s.selection = first ? 0 : Math.max(0, panelRows(s).length - 1);
    if (s.panel === 2) s.approvalId = s.approvals[s.selection]?.id;
    captureConsoleSelection(s, true);
    return done();
  }
  if (s.mode === "panels" && ["j", "k", "\x1b[A", "\x1b[B"].includes(key)) {
    if (s.detail !== undefined || s.requestDetail) { s.detailOffset = Math.max(0, s.detailOffset + (["j", "\x1b[B"].includes(key) ? 1 : -1)); return done(); }
    s.selection = Math.max(0, Math.min(panelRows(s).length - 1, selection(s) + (["j", "\x1b[B"].includes(key) ? 1 : -1)));
    if (s.panel === 2) s.approvalId = s.approvals[s.selection]?.id;
    captureConsoleSelection(s, true);
    return done();
  }
  if (key === "[" || key === "]") {
    const i = s.approvals.findIndex(a => a.id === s.approvalId), n = s.approvals.length;
    if (n) s.approvalId = s.approvals[i < 0 ? (key === "]" ? 0 : n - 1) : (i + (key === "[" ? -1 : 1) + n) % n]!.id;
    return done();
  }
  const approval = selectedApproval(s);
  if (s.optionChoice) {
    const a = s.approvals.find(a => a.id === s.optionChoice);
    const option = a && allowOptions(a)[Number(key) - 1];
    if (/^[1-9]$/.test(key) && a && option) { s.confirm = { type: "permission", id: a.id, peer: a.peer, option: option.optionId }; s.optionChoice = undefined; }
    return done();
  }
  const requestShown = s.mode === "stream" || (s.panel === 2 && s.detail === undefined);
  if (!approval && s.approvals.length && requestShown && ["a", "d", "v"].includes(key)) {
    notify(s, "no request selected; [ ] selects one", now, "attention"); return done();
  }
  if (approval && requestShown) {
    if (key === "d") { effects.push({ type: "permit", id: approval.id }); answered(approval.id); return done(); }
    if (key === "a") {
      const options = allowOptions(approval);
      if (options.length === 1) s.confirm = { type: "permission", id: approval.id, peer: approval.peer, option: options[0]!.optionId };
      else if (options.length) s.optionChoice = approval.id;
      return done();
    }
    if (key === "v" && s.mode === "stream") { effects.push({ type: "print", text: permissionText(approval), kind: "permission", tone: "attention" }); return done(); }
    if (key === "v") { s.requestDetail = approval.id; s.detailOffset = 0; return done(); }
  }
  const row = selectedPanelRow(s);
  // With a detail open the keys act on the item it shows (its id), never on what a refresh moved under the selection;
  // a detail that is only a message names no item.
  const selected = s.detail === undefined ? row : typeof s.detail === "object" ? s.detail : undefined;
  const item = selected?.id;
  if (s.mode === "panels" && row && s.detail === undefined && (key === "\r" || key === "\n")) {
    if (s.panel === 3 || s.panel === 4) effects.push({ type: "show", panel: s.panel, id: String(row.id) });
    else if (s.panel === 2) { s.requestDetail = row.id; s.detailOffset = 0; } // the row is the selected request
    else { s.detail = s.panel === 5 ? String(row.text) : { ...row }; s.detailOffset = 0; }
    return done();
  }
  if (s.mode === "panels" && item !== undefined && item !== null) {
    if (s.panel === 1 && key === "m") {
      const peer = String(item);
      const info = s.peers[peer];
      if (!info || info.state === "offline") notify(s, `${peer} is not attached`, now);
      else if (permissionModeRefusal(peer, info.permissionMode)) notify(s, permissionModeRefusal(peer, info.permissionMode)!, now);
      else s.modeChoice = peer;
      return done();
    }
    // #455: the planner is a setting; the command runs only after y, as a person's terminal command.
    if (s.panel === 1 && key === "l") {
      const peer = String(item);
      if (!(PLANNER_PEERS as readonly string[]).includes(peer)) notify(s, `${peer} cannot plan: the planner is one of ${PLANNER_PEERS.join(", ")}`, now);
      else if (s.peers[peer]?.planner === "setting") notify(s, `${peer} is already the pinned planner`, now, "attention");
      else s.confirm = { type: "command", args: ["settings", "set", "planner", peer], prompt: `make ${peer} the planner` };
      return done();
    }
    const prefill = s.panel === 1 && key === "p" ? `pause ${item}` : s.panel === 1 && key === "r" ? `resume ${item}` :
      s.panel === 3 && key === "r" && selected.state === "in_review" ? `review ${item} ` : undefined;
    if (prefill) { s.input = prefill; s.editing = true; return done(); }
    if (s.panel === 3 && key === "c") {
      if (!s.features?.includes("task_cancel")) { notify(s, "task cancellation requires a newer hub", now); return done(); }
      const revision = selected.flowRevision;
      if (!["proposed", "in_progress", "in_review", "changes_requested", "backlog"].includes(selected.state)) return done();
      if (!Number.isSafeInteger(revision) || revision < 0) { notify(s, "task row actions need flowRevision; upgrade the hub", now); return done(); }
      s.actionLock = { prefix: ["task", "cancel"], id: String(item), revision, state: String(selected.state) };
      s.input = `task cancel ${item} --revision ${revision} --reason `; s.editing = true; return done();
    }
    if (s.panel === 3 && (key === "a" || key === "u")) {
      if (!["proposed", "in_progress", "in_review", "changes_requested"].includes(selected.state)) return done();
      const revision = selected.flowRevision, role = selected.state === "in_review" || key === "u" && !selected.owner && !selected.reserved && selected.reviewer ? "reviewer" : "owner";
      if (!Number.isSafeInteger(revision) || revision < 0) { notify(s, "task row actions need flowRevision; upgrade the hub", now); return done(); }
      if (key === "u" && (role === "owner" && !selected.owner && !selected.reserved || role === "reviewer" && !selected.reviewer)) { notify(s, `task #${item}: no ${role} to unassign`, now); return done(); }
      const listed = s.tasks.find(task => task.id === item), ready = listed?.ready ?? selected.ready;
      const waiting = selected.state === "proposed" && ready !== true && Array.isArray(selected.deps) && selected.deps.length > 0;
      s.actionLock = { prefix: ["task", key === "a" ? "assign" : "unassign"], id: String(item), revision, state: String(selected.state), ...(selected.owner ? { owner: String(selected.owner) } : {}), ...(selected.reserved ? { reserved: String(selected.reserved) } : {}), ...(selected.reviewer ? { reviewer: String(selected.reviewer) } : {}), waiting };
      s.input = key === "a" ? `task assign ${item} ${role === "reviewer" ? "--role reviewer " : ""}--revision ${revision} ` : `task unassign ${item} --role ${role} --revision ${revision}`;
      s.editing = true; return done();
    }
    if (s.panel === 4 && key === "r") {
      if (!["queued", "needs_review"].includes(selected.state)) return done();
      const revision = selected.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) { notify(s, "queue row actions need a delivery revision; upgrade the hub", now); return done(); }
      const action = selected.state === "queued" ? "discard" : "retry";
      s.actionLock = { prefix: ["queue", "resolve"], id: String(item), revision, state: String(selected.state) };
      s.input = `queue resolve ${item} --action ${action} --revision ${revision} --reason `;
      s.editing = true; return done();
    }
  }
  if (s.mode === "panels" && s.panel === 5 && (key === "f" || key === "g")) {
    const field = key === "f" ? "peer" : "kind"; const current = key === "f" ? s.peerFilter : s.kindFilter;
    const values = [...new Set(s.events.map(e => e[field]).filter((x): x is string => !!x))];
    const next = values[values.indexOf(current ?? "") + 1];
    if (key === "f") s.peerFilter = next; else s.kindFilter = next;
    s.selection = newestEvent(s); return done();
  }
  if (s.mode === "stream" && !key.startsWith("\x1b")) { s.editing = true; s.input = terminalText(key).replace(/\n/g, ""); }
  return done();
}
export function renderConsole(s: ConsoleState, columns: number, rows = 24, now = Date.now()): string[] {
  return renderConsoleLines(s, columns, rows, now).map(line => paint(line, false));
}
const NOTICE_MS = 10_000;
export function activeNotice(s: Pick<ConsoleState, "notice" | "noticeAt">, now = Date.now()): boolean {
  return !!s.notice && now - (s.noticeAt ?? now) < NOTICE_MS;
}
export const TABLES: Record<number, string[]> = {
  1: ["PEER", "STATE", "LINK", "Q", "!", "WIP", "REVIEW", "PAUSE", "QUOTA", "MODEL"],
  2: ["ID", "PEER", "LEFT", "TITLE"],
  3: ["ID", "STATE", "OWNER", "REVIEWER", "CLASS", "AGE", "TITLE", "STAGE"],
  4: ["ID", "PEER", "STATE", "REV", "AGE"],
  6: ["GROUP", "KEY", "VALUE", "SOURCE", "APPLIES"],
};
const showPermissionModes = (s: ConsoleState) => Object.values(s.peers).some(peer => peer.permissionMode && peer.permissionMode !== "ask");
const count = (n: unknown) => typeof n === "number" && n ? String(n) : "-";
/** One span per column of a panel row; zero counters and unknown values read `-`. */
export function cells(s: ConsoleState, row: any, selected: boolean, now: number, stages?: Map<number, ProgressStage>): Span[] {
  const id = (text: unknown, tone: Tone | undefined) => span(text, tone && (selected ? "strong" : tone));
  if (s.panel === 1) {
    const b = s.budget[row.id];
    const wip = s.taskWip?.[row.id];
    const paused = b?.paused ? `budget ${relative(b.paused.resetsAt, now)}` : row.paused && typeof row.paused === "object"
      ? `${row.paused.by ?? "paused"}${typeof row.paused.at === "number" ? ` ${duration(now - row.paused.at)}` : ""}`
      : row.paused === "manual" ? "user" : row.paused ? String(row.paused).split(":")[0] : "-";
    return [id(row.planner ? `${row.id} (planner)` : row.id, row.state === "offline" ? undefined : "info"), span(row.rostered === false ? `${row.state} off roster` : row.state, stateTone(row.state)),
      ...(showPermissionModes(s) ? [span(row.permissionMode && row.permissionMode !== "ask" ? row.permissionMode : "-", row.permissionMode === "never-ask" ? "attention" : undefined)] : []),
      span(row.pullOnly && definitionOf(row.id)?.attach?.pullOnlyForms?.includes("tui") ? "pull-only" : row.toolsOnly ? "tools-only" : row.attached === false ? "detached" : "attached", row.toolsOnly ? "attention" : undefined),
      span(count(row.queued)), span(count(row.queuedImportant), row.queuedImportant ? "attention" : undefined),
      span(wip ? `${wip.wip}/${wip.wipLimit}` : "-", wip && wip.wip >= wip.wipLimit ? "attention" : undefined),
      span(count(row.needsReview), row.needsReview ? "failure" : undefined), span(paused, paused === "-" ? undefined : "attention"),
      span(b?.windows?.length ? b.windows.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%${typeof w.resetsAt === "number" ? ` ${relative(w.resetsAt, now)}` : ""}`).join(", ") : "-"),
      span(row.servedBy ?? row.requestedModel ?? "-")];
  }
  if (s.panel === 2) return [id(row.id, "attention"), span(row.peer, "attention"), span(duration(row.expiresAt - now), "muted"), span(row.title)];
  if (s.panel === 3) {
    const last = row.history?.at(-1);
    const at = last?.at ?? row.updated ?? row.created;
    const failed = last?.event === "check failed" || last?.event === "failed";
    const stage = stages?.get(row.id);
    const meter = stage?.cancelled ? "[----] cancelled" : stage ? "[" + "#".repeat(stage.stage - (stage.changes ? 1 : 0)) + (stage.changes ? "!" : "") + "-".repeat(4 - stage.stage) + "]" : "[----]";
    return [id(`#${row.id}`, "info"), span(`${row.state}${s.attentionFacts?.some(fact => fact.kind === "stall" && fact.id === row.id) ? " stalled" : ""}${failed && row.state !== last.event ? ` ${last.event}` : ""}${row.ready ? " ready" : ""}${stage?.waiting ? " waiting" : ""}`, failed ? "failure" : row.ready || stage?.waiting ? "attention" : stateTone(row.state)),
      span(row.owner ?? "-"), span(row.reviewer ?? "-"), span(row.profileClass ? `${row.profileClass} (base ${row.class})` : row.class ?? "-"), span(typeof at === "number" ? duration(now - at) : "-", "muted"), span(row.title), span(row.lifecycle ? `${meter} ${row.lifecycle.workflow ? row.lifecycle.workflow + " " : ""}SDLC ${row.lifecycle.stage}${row.lifecycle.definition ? ` (base ${row.lifecycle.definition.base}) / next: ${row.lifecycle.actor} / entry: ${row.lifecycle.entry?.length ? "blocked" : "ready"} / exit: ${row.lifecycle.exit?.length ? "blocked" : "ready"}` : ""}: ${row.lifecycle.next}` : meter, stage?.cancelled ? "muted" : stage?.changes ? "failure" : stateTone(row.state))];
  }
  if (s.panel === 6) return [span(row.group), span(row.key, selected ? "strong" : "info"), span(settingValueText(row.value)), span(row.source), span(`${row.applies}${row.pending !== undefined ? ` (file ${settingValueText(row.fileValue)})` : ""}`, row.pending !== undefined ? "attention" : undefined)];
  if (s.panel === 4) return [id(row.id, "info"), span(row.peer), span(row.rostered === false ? `${row.state} off roster` : row.state, stateTone(row.state)), span(row.revision ?? "-"), span(typeof row.createdAt === "number" ? duration(now - row.createdAt) : "-", "muted")];
  const [header, ...body] = String(row.text).split("\n");
  // The header goes through the stream's own tokenizer with the event's tone and kind, on the same tab-flattened
  // text the stream tokenizes, so an event reads the same in both places (#309); body lines stay plain, as in the
  // stream. Colour off concatenates to the same bytes.
  return [...streamTokens((header ?? "").replace(/\t/g, " "), row.tone, row.kind), ...(body.length ? [span("\n" + body.join("\n"))] : [])];
}
/**
 * A header row, then the rows, each column starting at the same place on every row: two spaces apart, as wide as its
 * widest cell or header (Bun.stringWidth, at most a third of the width, wider cells cut with the marker); the last column
 * takes the rest. One-shot callers may supply widths for already-wrapped cells; console defaults stay unchanged.
 */
export function table(head: string[], rows: Span[][], columns: number, explicitWidths?: readonly number[]): Span[][] {
  const cap = Math.max(24, Math.floor(columns / 3));
  const width = (cell: Span | undefined) => Bun.stringWidth(flat(cell?.text));
  const widths = explicitWidths ? [...explicitWidths] : head.map((h, i) => Math.min(cap, rows.reduce((max, row) => Math.max(max, width(row[i])), Bun.stringWidth(h))));
  const flexible = head.includes("STAGE") ? head.indexOf("TITLE") : head.length - 1;
  if (!explicitWidths && head.includes("STAGE")) {
    // Keep the original columns adjacent; stage meters occupy a fixed right-edge column.
    const room = () => columns - 2 - widths.reduce((sum, value, index) => sum + (index === flexible ? 0 : value), 0) - 2 * (head.length - 1);
    for (const key of ["CLASS", "OWNER", "REVIEWER", "AGE", "STATE"]) {
      const metadata = head.indexOf(key);
      while (room() < 7 && widths[metadata]! > head[metadata]!.length) widths[metadata] = widths[metadata]! - 1;
    }
    widths[flexible] = Math.max(0, room());
  }
  const headerCells = explicitWidths ? head.map((h, i) => wrap(h, Math.max(1, widths[i]!), 0)) : undefined;
  const headers = headerCells ? Array.from({ length: Math.max(...headerCells.map(cell => cell.length)) }, (_, n) => head.map((_, i) => span(headerCells[i]![n] ?? "", "info"))) : [head.map(h => span(h, "info"))];
  return [...headers, ...rows].map(row => row.map((cell, i) => {
    if (i === head.length - 1 && flexible === i) return cell;
    const text = fit(cell.text, widths[i]!);
    return { ...cell, text: text + " ".repeat(Math.max(0, widths[i]! - Bun.stringWidth(text)) + (i === head.length - 1 ? 0 : 2)) };
  }));
}
/** Keep the status/quota columns visible instead of clipping them behind optional peer metadata. */
function peerTable(head: string[], rows: Span[][], columns: number): Span[][] {
  const cap = Math.max(24, Math.floor(columns / 3));
  const widths = head.map((name, i) => Math.min(cap, rows.reduce((max, row) => Math.max(max, Bun.stringWidth(flat(row[i]?.text ?? ""))), name.length)));
  const keep = head.map((_, i) => i);
  const total = () => keep.reduce((sum, i) => sum + widths[i]!, 0) + 2 * (keep.length - 1);
  for (const name of ["MODEL", "WIP", "PAUSE", "REVIEW", "LINK", "Q", "!", "MODE"]) {
    if (total() <= columns - 2) break;
    const at = keep.findIndex(i => head[i] === name);
    if (at >= 0) keep.splice(at, 1);
  }
  // Very long peer/state/quota values still fit, with their headers intact.
  while (total() > columns - 2) {
    const largest = keep.reduce((best, i) => widths[i]! - head[i]!.length > widths[best]! - head[best]!.length ? i : best, keep[0]!);
    if (widths[largest]! <= head[largest]!.length) break;
    widths[largest] = widths[largest]! - 1;
  }
  return table(keep.map(i => head[i]!), rows.map(row => keep.map(i => row[i]!)), columns, keep.map(i => widths[i]!));
}
function taskHints(row: any): string[] {
  if (!["proposed", "in_progress", "in_review", "changes_requested"].includes(row.state)) return [];
  const review = row.state === "in_review";
  const hints = [review ? "a reviewer" : "a assign"];
  if (review ? row.reviewer : row.owner || row.reserved) hints.push("u unassign");
  if (review) hints.push("r review");
  return hints;
}
const settingValueText = (value: unknown): string => value === null || value === undefined ? "inherit" : Array.isArray(value) ? value.join(",") : String(value);
function panelContext(s: ConsoleState, row: any): string[] {
  if (!row) return [];
  if (s.panel === 6) return ["e edit", ...(s.settingsUndo ? ["u undo"] : [])];
  if (s.panel === 1) return ["p pause", "r resume", "m permission mode", "w WIP limit"];
  if (s.panel === 3) return [...taskHints(row), ...(s.features?.includes("task_cancel") ? ["c cancel"] : [])];
  if (s.panel === 4) return [row.state === "queued" ? "r discard" : "r resolve"];
  return [];
}
/** The footer's key hint: only keys that act in this mode, panel and state. */
function hint(s: ConsoleState, columns: number): string {
  const pending = selectedApproval(s) ? ["a allow", "d deny"] : [];
  if (s.mode === "stream") return [...pending, ...(pending.length ? ["v view"] : []), ...(s.approvals.length > (pending.length ? 1 : 0) ? ["[ ] select"] : []), "Tab panels", ": command", "? keys", "q quit"].join("  ");
  if (s.help) return "? or Esc close  q quit";
  const approvals = s.panel === 2 ? pending : [];
  if (s.detail !== undefined || s.requestDetail) return [...approvals, "j/k scroll", "Esc back", "? keys", "q quit"].join("  ");
  const rows = panelRows(s); const row = selectedPanelRow(s);
  const text = [...approvals, ...panelContext(s, row), ...(s.panel === 5 ? ["f peer", "g kind"] : []), ...(rows.length ? ["j/k move"] : []), ...(row ? ["Enter view"] : []), "? keys", ": command", "Tab stream", "q quit"].join("  ");
  if (s.panel !== 1 || Bun.stringWidth(text) <= columns) return text;
  const compact = text.replace("m permission mode", "m mode").replace("w WIP limit", "w WIP").replace("j/k move", "j/k").replace(": command", ": cmd");
  return Bun.stringWidth(compact) > columns ? compact.replace("Enter view", "Enter") : compact;
}
/** The project, then the tabs: the active one in brackets, pending approvals and held deliveries counted. */
function header(s: ConsoleState, columns: number): Span[] {
  const counts = [0, s.approvals.length, 0, s.queue.filter(q => q.state === "needs_review").length, 0];
  const tabs: Span[] = [];
  for (const [i, name] of ["Peers", "Approvals", "Tasks", "Queue", "Events", "Settings"].entries()) {
    const active = i + 1 === s.panel; const tone = active ? "strong" : "info";
    tabs.push(span(active ? " [" : "  ", tone), span(`${i + 1} ${name}`, tone));
    if (counts[i]) tabs.push(span(` ${counts[i]}`, i === 1 ? "attention" : "failure"));
    tabs.push(span(active ? "]" : " ", tone));
  }
  return fitLine([span(fit(s.project ?? "agent-hub", Math.max(0, columns - Bun.stringWidth(tabs.map(t => t.text).join("")))), "info"), ...tabs], columns);
}
/** The label column is the hub's own: a cut title or option list is marked `(more)` there; Enter shows it whole. */
const more = (line: Span[], text?: string): Span[] => [span("(more)".padEnd(Bun.stringWidth(line[0]!.text)), "attention"), ...(text === undefined ? line.slice(1) : [span(text)])];
export function consoleFooterRows(s: ConsoleState, columns: number, rows: number): number {
  return s.petEnabled ? petFooterRows(petSize(s.petSize, columns, rows)) : 4;
}
function decoratePetFooter(s: ConsoleState, columns: number, rows: number, now: number, rule: Span[], footer: Span[][], noticeShown: boolean): Span[][] {
  if (!s.petEnabled) return [rule, ...footer];
  const value = consoleNeeds(s, now), character = s.petCharacter ?? "stai", size = petSize(s.petSize, columns, rows);
  const tone: Tone = value.state === "blocked" ? "failure" : value.act ? "attention" : "muted";
  if (size === "line") {
    const text = characterAttentionLine(value, character, now, s.petBlink, true, s.petGlyphs);
    return [Bun.stringWidth(text) + 4 <= columns ? [span("-".repeat(columns - Bun.stringWidth(text) - 2) + " ", "muted"), span(text.slice(0, 5)), span(text.slice(5), tone), span("-", "muted")] : rule, ...footer];
  }
  const pose: PetPose = s.petBlink && value.items.some(item => item.kind === "approval") && Math.floor(now / 1000) % 2 ? "waitingBlink" : value.state;
  const frame = petFrame(character, pose, size, s.petGlyphs), width = size === "mini" ? 9 : 12, height = size === "mini" ? 3 : 8;
  const available = columns - width - 1, caption = characterAttentionLine(value, character, now, false).slice(6);
  const left: Span[][] = [[span(caption, tone)], footer[0]!, footer[1]!];
  // Notices and source paths stay in their existing views, never beside an expanded character.
  if (noticeShown || s.confirm?.type === "permission_default") left[2] = [span(`${s.approvals.length} approvals / ${value.act} action / ${value.watch} watch`, tone)];
  for (let index = 0; index < height - 3; index++) {
    const item = value.items[index];
    left.push(item ? [span([item.kind, item.peer, item.id].filter(part => part !== undefined).join(" "), item.level === "act" ? "attention" : "muted")] : []);
  }
  const result = left.map((line, index) => {
    const fitted = fitLine(line, available), text = fitted.map(cell => cell.text).join("");
    const body = frame[index] ?? " ".repeat(width), accent = CHARACTERS[character].accent?.[size];
    const bodySpans = accent?.row === index ? [span(body.slice(0, accent.start)), span(body.slice(accent.start, accent.start + accent.length), "attention"), span(body.slice(accent.start + accent.length))] : [span(body)];
    return [...fitted, span(" ".repeat(Math.max(0, available - Bun.stringWidth(text)) + 1)), ...bodySpans];
  });
  return [...result, footer[2]!]; // The prompt line remains full-width and in its original terminal row.
}
export function renderConsoleLines(s: ConsoleState, columns: number, rows = 24, now = Date.now()): Span[][] {
  const permission = selectedApproval(s);
  let prompt = s.editing ? `: ${s.input}` : hint(s, columns);
  if (s.confirm?.type === "permission") prompt = `allow ${quoted(s.confirm.option)} for ${s.confirm.peer} (request ${s.confirm.id})? y/N`;
  if (s.confirm?.type === "command") prompt = `${s.confirm.prompt ?? s.confirm.args.join(" ")}? y/N`;
  if (s.settingsEdit) {
    const edit = s.settingsEdit;
    prompt = edit.phase === "value" ? `value for ${edit.key} (inherit removes): ${edit.text}` : edit.phase === "preview" ? "checking setting preview; Esc cancels" : edit.phase === "reason" ? `reason: ${edit.text}` : `${edit.undo ? "undo last setting" : `set ${edit.key}`} (${edit.reason})? y/N`;
  }
  if (s.modeChoice) prompt = `permission ${s.modeChoice}: 1 ask  2 ask-when-needed  3 never-ask  Esc cancel`;
  const choice = s.optionChoice ? s.approvals.find(a => a.id === s.optionChoice) : undefined;
  if (choice) prompt = `allow request ${choice.id} (${choice.peer}) with: ${allowOptions(choice).map((o, i) => `${i + 1} ${quoted(o.name)}`).join("  ")}  Esc cancel`;
  const summary: Span[] = [];
  for (const [id, p] of Object.entries(s.peers)) {
    if (summary.length) summary.push(span(" "));
    summary.push(span(id, p.state === "offline" ? undefined : "info"), span(":"), span(p.state, stateTone(p.state)), span(` q${p.queued ?? 0}`));
    if (p.permissionMode && p.permissionMode !== "ask") summary.push(span(` ${p.permissionMode}`, "attention"));
    if (p.needsReview) summary.push(span(` review${p.needsReview}`, "failure"));
    if (p.paused) summary.push(span(" paused", "attention"));
    if (typeof p.importantWaitingSince === "number") summary.push(span(` important waiting ${duration(now - p.importantWaitingSince)}`, "attention")); // #572 AC1: a busy ACP peer that cannot be steered
    if (p.toolsOnly) summary.push(span(definitionOf(id)?.attach?.pullOnlyForms?.includes("tui") ? ` pull-only, read ${typeof p.lastInboxAt === "number" ? relative(p.lastInboxAt, now) : "never"}` : " tools-only: ahub claude", "attention"));
  }
  if (s.pendingRestart?.length) summary.push(span(`${summary.length ? " | " : ""}restart pending: ${s.pendingRestart.map(row => row.key).join(", ")}`, "attention"));
  if (s.retainedConfig?.length) summary.push(span(`${summary.length ? " | " : ""}config retained: ${s.retainedConfig.map(row => row.key).join(", ")}; run ahub settings reload`, "attention"));
  const quotas = Object.entries(s.budget).map(([id, b]) => `${id}:${b.windows?.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%`).join("/") ?? "?"}`).join(" ");
  if (quotas) summary.push(span(`${summary.length ? " | " : ""}${quotas}`));
  const approvals = [span(plural(s.approvals.length, "approval"), s.approvals.length ? "attention" : undefined)];
  if (permission) approvals.push(span(` | ${permission.peer} ${permission.id}`, "attention"), span(` ${duration(permission.expiresAt - now)} left`, "muted"));
  else if (s.approvals.length) approvals.push(span(" | none selected", "muted"));
  const noticeShown = activeNotice(s, now);
  if (noticeShown) approvals.push(span(" | "), span(s.notice, s.noticeTone ?? "failure"));
  const neverPeer = s.confirm?.type === "permission_default" ? s.confirm.peer : s.confirm?.type === "command" && s.confirm.args[0] === "permission" && s.confirm.args[2] === "never-ask" ? s.confirm.args[1] : undefined;
  const defaultSource = s.confirm?.type === "permission_default" ? s.confirm.source : undefined;
  if (s.confirm?.type === "permission_default") prompt = `enable never-ask default for ${s.confirm.peer}? y/n Esc defer`;
  const footer = [fitLine(neverPeer ? [span(permissionBoundary(neverPeer), "attention")] : summary, columns),
    fitLine(defaultSource !== undefined ? [span(`source ${quoted(defaultSource.split(/[\\/]/).at(-1))}; stays ask until y`, "attention")] : approvals, columns),
    fitLine([span(prompt, s.confirm || s.optionChoice ? "attention" : undefined)], columns)];
  const rule = [span("-".repeat(Math.max(0, columns)), "muted")];
  if (s.mode === "stream") {
    const counts = s.taskCounts;
    const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0;
    const taskCount = span(counts ? `tasks ${counts.approved ?? 0}/${total} approved` : "tasks loading...", counts ? "success" : "attention");
    if (!noticeShown && defaultSource === undefined && (counts || !s.approvals.length) && Bun.stringWidth(taskCount.text + " | " + approvals.map(s => s.text).join("")) <= columns) {
      footer[1] = fitLine([taskCount, span(" | "), ...approvals], columns);
    }
    return decoratePetFooter(s, columns, rows, now, rule, footer, noticeShown);
  }
  const progress = taskProgress(s.tasks);
  const bodyHeight = rows - 2 - consoleFooterRows(s, columns, rows);
  const noticeLines = noticeShown && s.petEnabled && petSize(s.petSize, columns, rows) !== "line" ? wrap(`Notice: ${s.notice}`, columns).slice(0, Math.max(0, bodyHeight - 6)).map(text => [span(text, s.noticeTone ?? "failure")]) : [];
  const height = bodyHeight - noticeLines.length;
  const lines: Span[][] = [];
  if (s.confirm?.type === "permission_default") lines.push(...fieldLines([["default", `${s.confirm.peer} never-ask`], ["source", s.confirm.source], ["bounds", permissionBoundary(s.confirm.peer)], ["decision", "y enables; n cancels for this hub; Esc defers; until then ask"]], columns, now).flat());
  else if (s.settingsEdit) {
    const edit = s.settingsEdit;
    const row = s.settingsRows?.find(row => row.key === edit.key);
    const definition: [string, unknown][] = row ? [["type", row.type], ...(row.min !== undefined || row.max !== undefined ? [["range", `${row.min ?? "-"}..${row.max ?? "-"}`] as [string, unknown]] : []), ["risk", row.risk], ["applies", row.applies]] : [];
    lines.push(...fieldLines([["setting", edit.key ?? s.settingsUndo ?? "last write"], ...definition, ["preview", (edit.lines ?? []).join("\n")], ["decision", "Esc cancels; saving needs a reason and explicit y"]], columns, now).flat());
  }
  else if (s.help) lines.push(...keyTable(columns, !!s.petEnabled || !!s.petChoices?.length, !!s.petChoices?.length));
  else if (s.detail !== undefined || (s.requestDetail && permission)) {
    const detail = s.detail !== undefined ? detailLines(s.detail, columns, now) : fieldLines(approvalFields(permission!), columns, now).flat();
    lines.push(...detail.slice(Math.min(s.detailOffset, Math.max(0, detail.length - height))));
  }
  else {
    const data = panelRows(s); const head = s.panel === 1 && showPermissionModes(s) ? ["PEER", "STATE", "MODE", ...TABLES[1]!.slice(2)] : TABLES[s.panel]; const at = selection(s);
    // Below the Approvals table: the selected request's title, its allow options and deny, one line each. Deny always
    // shows; options that do not fit are counted, rows give way to the rest, and the title gets what is left.
    const [title = [], allow = [], deny = []] = s.panel === 2 && permission ? fieldLines(approvalFields(permission).slice(3), columns, now) : [];
    const fits = Math.max(1, height - 5); // table header, one row, rule, one title line, deny
    if (allow.length > fits) allow.splice(fits - 1, Infinity, more(allow[0]!, `${plural(allow.length - fits + 1, "more option")}: Enter shows them all`));
    const tail = [...allow, ...deny];
    const capacity = Math.max(1, s.panel === 2 ? Math.min(Math.floor(height / 2) - 1, height - 3 - tail.length) : height - (s.panel === 3 ? 2 : 1)); const start = Math.max(0, at - capacity + 1);
    const stages = new Map(progress.stages.map(stage => [stage.id, stage]));
    const rowsOf = head ? (s.panel === 1 ? peerTable : table)(head, data.map((row, i) => cells(s, row, i === at, now, stages)), columns) : undefined;
    if (s.panel === 6) {
      const row = selectedPanelRow(s);
      const info = s.settingsProblem ?? (!s.settingsKnown ? "settings loading..." : row?.restartReason ?? row?.note ?? row?.label ?? "Settings");
      lines.push(...wrap(info, columns).slice(0, 2).map(text => [span(text, s.settingsProblem ? "failure" : "info")]));
      if (s.pendingRestart?.length) lines.push(fitLine([span(`pending restart: ${s.pendingRestart.map(row => `${row.key}: ${row.reason}`).join("; ")}`, "attention")], columns));
      if (s.retainedConfig?.length) {
        lines.push(fitLine([span(`config retained: ${s.retainedConfig.map(row => row.key).join(", ")}; run ahub settings reload`, "attention")], columns));
        for (const pending of s.retainedConfig) lines.push(fitLine([span(`${pending.key}: ${pending.reason}`, "attention")], columns));
      }
    }
    if (s.panel === 3) {
      const done = progress.total ? Math.floor(progress.counts.approved * 20 / progress.total) : 0;
      const main = s.tasksKnown === false && !progress.total ? "tasks loading..." : `${progress.counts.approved}/${progress.total} approved [${"#".repeat(done)}${".".repeat(20 - done)}] ${progress.total ? Math.floor(progress.counts.approved * 100 / progress.total) : 0}%`;
      const known = s.tasksKnown !== false || progress.total > 0;
      const parts = [span(main, known ? "success" : "attention")];
      for (const [label, value, tone] of [["changes", progress.counts.changes_requested, "failure"], ["review", progress.counts.in_review, "attention"], ["waiting", progress.counts.waiting, "attention"], ["in progress", progress.counts.in_progress, undefined], ["proposed", progress.counts.proposed, undefined], ...(progress.counts.unknown ? [["unknown", progress.counts.unknown, "attention"] as const] : [])] as const) {
        const extra = `  ${label} ${value}`;
        if (!known || Bun.stringWidth(parts.map(p => p.text).join("") + extra) > columns) break;
        parts.push(span(extra, tone));
      }
      lines.push(fitLine(parts, columns));
    }
    lines.push(fitLine([span("  "), ...(rowsOf?.[0] ?? [span(`peer ${s.peerFilter ?? "all"}  kind ${s.kindFilter ?? "all"}`, "info")])], columns));
    for (let i = start; i < Math.min(data.length, start + capacity); i++) {
      const selected = i === at;
      lines.push(fitLine([span(selected ? "> " : "  ", selected ? "strong" : undefined), ...(rowsOf?.[i + 1] ?? cells(s, data[i], selected, now))], columns));
    }
    if (!data.length) lines.push([span("  (empty)")]);
    if (title.length) {
      const room = Math.max(1, height - lines.length - 1 - tail.length);
      if (title.length > room) { title.length = room; title[room - 1] = more(title[room - 1]!); }
      lines.push(rule, ...title, ...tail);
    }
  }
  const body = lines.slice(0, height); while (body.length < height) body.push([]);
  return [header(s, columns), rule, ...noticeLines, ...body, ...decoratePetFooter(s, columns, rows, now, rule, footer, noticeShown)];
}
