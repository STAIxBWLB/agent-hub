import { sanitize } from "../hub/envelope.ts";

export interface Approval {
  id: string; peer: string; title: string; expiresAt: number;
  options: { optionId: string; name: string; kind: string }[];
}
export interface ConsoleEvent { text: string; peer?: string; kind?: string }
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
  const permission = s.approvals[s.approvalIndex];
  let prompt = s.editing ? `: ${s.input}` : "q quit | Tab panels | : command | a allow d deny v view [ ] select";
  if (s.confirm?.type === "permission") prompt = `allow ${s.confirm.option} for ${s.confirm.peer} (request ${s.confirm.id})? y/N`;
  if (s.confirm?.type === "command") prompt = `${s.confirm.args.join(" ")}? y/N`;
  if (s.optionChoice) prompt = s.approvals.find(a => a.id === s.optionChoice)?.options.filter(o => o.kind.startsWith("allow")).map((o, i) => `${i + 1}:${o.name}`).join(" | ") ?? "";
  const quotas = Object.entries(s.budget).map(([id, b]) => `${id}:${b.windows?.map((w: any) => `${w.id} ${Math.round(w.used * 100)}%`).join("/") ?? "?"}`).join(" ");
  const summary = Object.entries(s.peers).map(([id, p]) => `${id}:${p.state} q${p.queued ?? 0}${p.needsReview ? ` review${p.needsReview}` : ""}${p.paused ? " paused" : ""}`).join(" ");
  const footer = [fit(summary + (quotas ? ` | ${quotas}` : ""), columns), fit(`${s.approvals.length} approvals${permission ? ` | ${permission.peer} ${permission.id} ${Math.max(0, Math.ceil((permission.expiresAt - now) / 1000))}s` : ""}${s.notice ? ` | ${s.notice}` : ""}`, columns), fit(prompt, columns)];
  if (s.mode === "stream") return footer;
  const title = ["Peers", "Approvals", "Tasks", "Queue", "Events"][s.panel - 1];
  const lines = [fit(`agent-hub | 1 Peers 2 Approvals 3 Tasks 4 Queue 5 Events | ${title}`, columns), fit(`j/k move Enter detail Esc back ? keys${s.panel === 5 ? ` | f peer:${s.peerFilter ?? "all"} g kind:${s.kindFilter ?? "all"}` : ""}`, columns)];
  if (s.help) lines.push(...wrap("Tab stream/panels; 1-5 panel; j/k or arrows move; Enter detail; Esc back; : command; q quit. Approvals: a allow (confirm y), d deny, v title, [ ] select. Peers: p pause, r resume. Tasks: a assign (confirm y), r review. Queue: r resolve (reason and confirm y). Events: f peer filter, g kind filter.", columns));
  else if (s.detail) { const detail = wrap(s.detail, columns); lines.push(...detail.slice(Math.min(s.detailOffset, Math.max(0, detail.length - (rows - 5))))); }
  else {
    const data = panelRows(s); const capacity = Math.max(1, s.panel === 2 ? Math.floor((rows - 6) / 2) : rows - 6); const start = Math.max(0, s.selection - capacity + 1);
    for (const [i, row] of data.slice(start, start + capacity).entries()) {
      let text = "";
      if (s.panel === 1) {
        const b = s.budget[row.id];
        text = `${row.id} ${row.state} ${row.attached === false ? "detached" : "attached"} q:${row.queued ?? 0} !:${row.queuedImportant ?? 0} review:${row.needsReview ?? 0} ${row.paused ? `paused:${JSON.stringify(row.paused)}` : ""} ${b?.paused ? `budget pause ${b.paused.reason} reset:${b.paused.resetsAt}` : ""} ${b?.windows?.map((w: any) => `${w.id}:${Math.round(w.used * 100)}% reset:${w.resetsAt ?? "?"}`).join(" ") ?? "quota:?"} model:${row.servedBy ?? row.requestedModel ?? "?"}`;
      } else if (s.panel === 2) text = `${row.id} ${row.peer} ${Math.max(0, Math.ceil((row.expiresAt - now) / 1000))}s ${row.title}`;
      else if (s.panel === 3) { const at = row.history?.at(-1)?.at ?? row.updated ?? row.created; text = `#${row.id} ${row.state}${row.ready ? " ready" : ""} ${row.owner ?? "-"} review:${row.reviewer ?? "-"} ${row.class} age:${at ? Math.max(0, Math.floor((now - at) / 1000)) + "s" : "?"} ${row.title}`; }
      else if (s.panel === 4) text = `${row.id} ${row.peer} ${row.state} rev:${row.revision} age:${row.createdAt ? Math.max(0, Math.floor((now - row.createdAt) / 1000)) + "s" : "?"}`;
      else text = row.text;
      lines.push(fit(`${start + i === s.selection ? ">" : " "} ${text}`, columns));
    }
    if (!data.length) lines.push("(empty)");
    if (s.panel === 2 && permission) lines.push(...wrap(permission.title, columns).slice(0, Math.max(0, rows - 3 - lines.length)));
  }
  const body = lines.slice(0, rows - 3); while (body.length < rows - 3) body.push("");
  return [...body, ...footer];
}
