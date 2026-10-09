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
  tasks: any[]; queue: any[]; detail?: string; detailOffset: number; help: boolean; notice: string;
  peerFilter?: string; kindFilter?: string;
  confirm?: { type: "permission"; id: string; option: string; peer: string } | { type: "command"; args: string[] };
  optionChoice?: string;
}
export type ConsoleEffect = { type: "exit" } | { type: "permit"; id: string; option?: string } |
  { type: "command"; args: string[] } | { type: "show"; panel: number; id: string };
export function initialConsoleState(panels = false): ConsoleState {
  return { mode: panels ? "panels" : "stream", panel: 1, selection: 0, approvalIndex: 0,
    input: "", editing: false, history: [], historyIndex: 0, approvals: [], events: [], peers: {}, budget: {}, tasks: [], queue: [], detailOffset: 0, help: false, notice: "" };
}
/** Strip terminal controls before any daemon or child output reaches a terminal. Preserve printable Unicode. */
export function terminalText(value: unknown): string {
  return sanitize(String(value ?? ""))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P_X^][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\n]?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
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
/** Clip only sanitized plain text, then retain the tones of the surviving prefix. */
function fitLine(line: Span[], columns: number): Span[] {
  const clean = line.map(s => ({ ...s, text: terminalText(s.text).replace(/\n/g, " ") }));
  const text = clean.map(s => s.text).join("");
  const clipped = fit(text, columns);
  const marker = text === clipped ? "" : ".".repeat(Math.max(0, Math.min(3, columns)));
  let remaining = clipped.length - marker.length;
  const out: Span[] = [];
  for (const s of clean) { const part = s.text.slice(0, Math.max(0, remaining)); if (part) out.push({ ...s, text: part }); remaining -= part.length; }
  if (marker) out.push(span(marker));
  return out;
}
export function fit(value: unknown, columns: number): string {
  const text = terminalText(value).replace(/\n/g, " ");
  if (columns <= 0) return "";
  if (Bun.stringWidth(text) <= columns) return text;
  let result = ""; const marker = ".".repeat(Math.min(3, columns));
  for (const char of text) { if (Bun.stringWidth(result + char) > columns - marker.length) break; result += char; }
  return result + marker;
}
export function wrap(value: unknown, columns: number): string[] {
  const lines: string[] = [];
  for (const part of terminalText(value).split("\n")) {
    let line = "";
    for (const char of part) {
      if (Bun.stringWidth(line + char) > columns) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
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
      } catch (error) { s.notice = String((error as Error).message); }
    } else if (!key.startsWith("\x1b")) s.input += terminalText(key).replace(/\n/g, "");
    return done();
  }
  if (key === "q") { effects.push({ type: "exit" }); return done(); }
  if (key === "\t") { s.mode = s.mode === "panels" ? "stream" : "panels"; s.detail = undefined; return done(); }
  if (key === ":") { s.editing = true; return done(); }
  if (s.mode === "panels" && /^[1-5]$/.test(key) && !s.optionChoice) { s.panel = Number(key); s.selection = 0; s.detail = undefined; return done(); }
  if (key === "?") { s.help = !s.help; return done(); }
  if (key === "\x1b") { s.detail = undefined; s.help = false; s.optionChoice = undefined; return done(); }
  if (s.mode === "panels" && ["j", "k", "\x1b[A", "\x1b[B"].includes(key)) {
    if (s.detail) { s.detailOffset = Math.max(0, s.detailOffset + (["j", "\x1b[B"].includes(key) ? 1 : -1)); return done(); }
    s.selection = Math.max(0, Math.min(panelRows(s).length - 1, s.selection + (["j", "\x1b[B"].includes(key) ? 1 : -1)));
    if (s.panel === 2) s.approvalIndex = s.selection;
    return done();
  }
  if (key === "[" || key === "]") {
    s.approvalIndex = (s.approvalIndex + (key === "[" ? -1 : 1) + s.approvals.length) % Math.max(1, s.approvals.length); return done();
  }
  const approval = s.approvals[s.approvalIndex];
  if (s.optionChoice) {
    const a = s.approvals.find(a => a.id === s.optionChoice); const options = a?.options.filter(o => o.kind.startsWith("allow")) ?? [];
    const option = options[Number(key) - 1];
    if (/^[1-9]$/.test(key) && a && option) { s.confirm = { type: "permission", id: a.id, peer: a.peer, option: option.optionId }; s.optionChoice = undefined; }
    return done();
  }
  if (approval && (s.mode === "stream" || s.panel === 2)) {
    if (key === "d") { effects.push({ type: "permit", id: approval.id }); s.approvals = s.approvals.filter(a => a.id !== approval.id); return done(); }
    if (key === "a") {
      const options = approval.options.filter(o => o.kind.startsWith("allow"));
      if (options.length === 1) s.confirm = { type: "permission", id: approval.id, peer: approval.peer, option: options[0]!.optionId };
      else if (options.length) s.optionChoice = approval.id;
      return done();
    }
    if (key === "v") { s.detail = approval.title; s.detailOffset = 0; return done(); }
  }
  const row = panelRows(s)[s.selection];
  if (s.mode === "panels" && row) {
    if (key === "\r" || key === "\n") {
      if (s.panel === 3 || s.panel === 4) effects.push({ type: "show", panel: s.panel, id: String(row.id) });
      else { s.detail = s.panel === 2 ? row.title : s.panel === 5 ? row.text : JSON.stringify(row, null, 2); s.detailOffset = 0; }
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
export function renderConsoleLines(s: ConsoleState, columns: number, rows = 24, now = Date.now()): Span[][] {
  const permission = s.approvals[s.approvalIndex];
  let prompt = s.editing ? `: ${s.input}` : "q quit | Tab panels | : command | a allow d deny v view [ ] select";
  if (s.confirm?.type === "permission") prompt = `allow ${s.confirm.option} for ${s.confirm.peer} (request ${s.confirm.id})? y/N`;
  if (s.confirm?.type === "command") prompt = `${s.confirm.args.join(" ")}? y/N`;
  if (s.optionChoice) prompt = s.approvals.find(a => a.id === s.optionChoice)?.options.filter(o => o.kind.startsWith("allow")).map((o, i) => `${i + 1}:${o.name}`).join(" | ") ?? "";
  const summary: Span[] = [];
  for (const [id, p] of Object.entries(s.peers)) {
    if (summary.length) summary.push(span(" "));
    summary.push(span(id, p.state === "offline" ? undefined : "info"), span(":"), span(p.state, stateTone(p.state)), span(` q${p.queued ?? 0}`));
    if (p.needsReview) summary.push(span(` review${p.needsReview}`, "failure"));
    if (p.paused) summary.push(span(" paused", "attention"));
  }
  const quotas = Object.entries(s.budget).map(([id, b]) => `${id}:${b.windows?.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%`).join("/") ?? "?"}`).join(" ");
  if (quotas) summary.push(span(` | ${quotas}`));
  const approvals = [span(`${s.approvals.length} approvals`, s.approvals.length ? "attention" : undefined)];
  if (permission) approvals.push(span(` | ${permission.peer} ${permission.id}`, "attention"), span(` ${Math.max(0, Math.ceil((permission.expiresAt - now) / 1000))}s`, "muted"));
  if (s.notice) approvals.push(span(` | ${s.notice}`));
  const footer = [fitLine(summary, columns), fitLine(approvals, columns), fitLine([span(prompt, s.confirm || s.optionChoice ? "attention" : undefined)], columns)];
  if (s.mode === "stream") return footer;
  const titles = ["Peers", "Approvals", "Tasks", "Queue", "Events"];
  const title = titles[s.panel - 1];
  const tabs = [span("agent-hub | ", "info")];
  for (const [i, name] of titles.entries()) tabs.push(span(`${i + 1} ${name}${i < 4 ? " " : ""}`, i + 1 === s.panel ? "strong" : "info"));
  tabs.push(span(` | ${title}`, "strong"));
  const lines: Span[][] = [fitLine(tabs, columns), fitLine([span(`j/k move Enter detail Esc back ? keys${s.panel === 5 ? ` | f peer:${s.peerFilter ?? "all"} g kind:${s.kindFilter ?? "all"}` : ""}`)], columns)];
  if (s.help) lines.push(...wrap("Tab stream/panels; 1-5 panel; j/k or arrows move; Enter detail; Esc back; : command; q quit. Approvals: a allow (confirm y), d deny, v title, [ ] select. Peers: p pause, r resume. Tasks: a assign (confirm y), r review. Queue: r resolve (reason and confirm y). Events: f peer filter, g kind filter.", columns).map(text => [span(text)]));
  else if (s.detail) { const detail = wrap(s.detail, columns); lines.push(...detail.slice(Math.min(s.detailOffset, Math.max(0, detail.length - (rows - 5)))).map(text => [span(text)])); }
  else {
    const data = panelRows(s); const capacity = Math.max(1, s.panel === 2 ? Math.floor((rows - 6) / 2) : rows - 6); const start = Math.max(0, s.selection - capacity + 1);
    for (const [i, row] of data.slice(start, start + capacity).entries()) {
      const selected = start + i === s.selection;
      const line = [span(`${selected ? ">" : " "} `, selected ? "strong" : undefined)];
      if (s.panel === 1) {
        const b = s.budget[row.id];
        line.push(span(row.id, row.state === "offline" ? undefined : selected ? "strong" : "info"), span(" "), span(row.state, stateTone(row.state)),
          span(` ${row.attached === false ? "detached" : "attached"} q:${row.queued ?? 0} `), span(`!:${row.queuedImportant ?? 0}`, row.queuedImportant ? "attention" : undefined),
          span(` review:${row.needsReview ?? 0}`, row.needsReview ? "failure" : undefined), span(" "),
          span(row.paused ? `paused:${JSON.stringify(row.paused)}` : "", "attention"), span(" "),
          span(b?.paused ? `budget pause ${b.paused.reason} reset:${b.paused.resetsAt}` : "", "attention"), span(" "),
          span(b?.windows?.map((w: any) => `${w.id}:${Math.round(w.used * 100)}% reset:${w.resetsAt ?? "?"}`).join(" ") ?? "quota:?"), span(` model:${row.servedBy ?? row.requestedModel ?? "?"}`));
      } else if (s.panel === 2) line.push(span(`${row.id} ${row.peer}`, "attention"), span(` ${Math.max(0, Math.ceil((row.expiresAt - now) / 1000))}s`, "muted"), span(` ${row.title}`));
      else if (s.panel === 3) {
        const at = row.history?.at(-1)?.at ?? row.updated ?? row.created;
        line.push(span(`#${row.id}`, selected ? "strong" : "info"), span(" "), span(row.state, stateTone(row.state)), span(row.ready ? " ready" : "", "attention"),
          span(` ${row.owner ?? "-"} review:${row.reviewer ?? "-"} ${row.class} `), span(`age:${at ? Math.max(0, Math.floor((now - at) / 1000)) + "s" : "?"}`, "muted"), span(` ${row.title}`));
      } else if (s.panel === 4) line.push(span(row.id, selected ? "strong" : "info"), span(` ${row.peer} `), span(row.state, stateTone(row.state)), span(` rev:${row.revision} `), span(`age:${row.createdAt ? Math.max(0, Math.floor((now - row.createdAt) / 1000)) + "s" : "?"}`, "muted"));
      else { const [header, ...body] = String(row.text).split("\n"); line.push(span(header, row.tone)); if (body.length) line.push(span("\n" + body.join("\n"))); }
      lines.push(fitLine(line, columns));
    }
    if (!data.length) lines.push([span("(empty)")]);
    if (s.panel === 2 && permission) lines.push(...wrap(permission.title, columns).slice(0, Math.max(0, rows - 3 - lines.length)).map(text => [span(text)]));
  }
  const body = lines.slice(0, rows - 3); while (body.length < rows - 3) body.push([]);
  return [...body, ...footer];
}
