import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { ControlClient } from "../hub/control-client.ts";
import { contextLine } from "./status-lines.ts";
import { renderTailEvent } from "./tail-render.ts";
import { initialConsoleState, pruneApprovals, reduceConsole, renderConsole, terminalText, wrap } from "./console-state.ts";
import type { ConsoleEffect, ConsoleEvent } from "./console-state.ts";

export interface ConsoleTerminal {
  columns: number; rows: number; isTTY: boolean; isRaw?: boolean;
  write(text: string): void;
  raw(enabled: boolean): void;
  onData(listener: (text: string) => void): () => void;
  onResize(listener: () => void): () => void;
  onSignal(listener: () => void): () => void;
  onError?(listener: (error: Error) => void): () => void;
}
export interface ConsoleOptions {
  client: Pick<ControlClient, "request" | "send" | "close" | "onPush" | "onClose">;
  cwd: string; stateDir: string; panels?: boolean; columns?: number; rows?: number;
  terminal?: ConsoleTerminal;
  /** Injected command runner must use argv, closed stdin, and return a cancellation handle. */
  runCommand?: (args: string[], output: (text: string) => void, done: () => void) => (() => void);
  pollMs?: number;
}
export const RESTORE_CONSOLE = "\x1b[?1049l\x1b[r\x1b[0m\x1b[?25h";
function nativeTerminal(): ConsoleTerminal {
  return {
    get columns() { return process.stdout.columns ?? 80; }, get rows() { return process.stdout.rows ?? 24; },
    get isTTY() { return !!process.stdin.isTTY && !!process.stdout.isTTY; }, get isRaw() { return process.stdin.isRaw; },
    write: text => { process.stdout.write(text); }, raw: enabled => { process.stdin.setRawMode(enabled); },
    onData: listener => {
      const decoder = new StringDecoder("utf8"); const onData = (data: Buffer) => listener(decoder.write(data));
      process.stdin.on("data", onData); process.stdin.resume();
      return () => { process.stdin.off("data", onData); process.stdin.pause(); };
    },
    onResize: listener => { process.stdout.on("resize", listener); return () => { process.stdout.off("resize", listener); }; },
    onError: listener => {
      const rejected = (reason: unknown) => listener(reason instanceof Error ? reason : new Error(String(reason)));
      process.on("uncaughtException", listener); process.on("unhandledRejection", rejected);
      return () => { process.off("uncaughtException", listener); process.off("unhandledRejection", rejected); };
    },
    onSignal: listener => { process.on("SIGINT", listener); process.on("SIGTERM", listener); return () => { process.off("SIGINT", listener); process.off("SIGTERM", listener); }; },
  };
}
/** One terminal client, no daemon ownership. All text crosses terminalText before writing. */
export async function runConsole(options: ConsoleOptions): Promise<void> {
  const { client } = options; const terminal = options.terminal ?? nativeTerminal();
  let state = initialConsoleState(!!options.panels);
  let columns = options.columns ?? terminal.columns; let rows = options.rows ?? terminal.rows;
  let active = true; let inAlternate = false; let plain = !terminal.isTTY || columns < 80 || rows < 24;
  let polling = false; let childRunning = false; let cancelChild: (() => void) | undefined;
  const priorPush = client.onPush; const priorClose = client.onClose; const priorRaw = !!terminal.isRaw;
  const removers: (() => void)[] = []; const timers: ReturnType<typeof setInterval>[] = [];
  let resolveDone: () => void = () => {}; const done = new Promise<void>(resolve => { resolveDone = resolve; });
  let pendingStream: ConsoleEvent[] = []; let droppedStream = 0;
  const safeWrite = (text: string) => terminal.write(terminalText(text));
  const writeStream = (text: string) => {
    terminal.write(`\x1b[${rows - 3};1H`);
    for (const line of wrap(text, columns)) { safeWrite(line); terminal.write("\r\n"); }
  };
  const stream = (event: ConsoleEvent) => {
    state.events = [...state.events, { ...event, text: terminalText(event.text) }].slice(-1000);
    if (plain) safeWrite(event.text + "\n");
    else if (state.mode === "stream") writeStream(event.text);
    else { pendingStream.push(event); if (pendingStream.length > 1000) { pendingStream.shift(); droppedStream++; } }
  };
  const draw = () => {
    if (!active || plain) return;
    if (state.mode === "panels" && !inAlternate) { terminal.write("\x1b[r\x1b[?1049h\x1b[2J"); inAlternate = true; }
    else if (state.mode === "stream" && inAlternate) {
      terminal.write(`\x1b[?1049l\x1b[1;${rows - 3}r`); inAlternate = false;
      if (droppedStream) writeStream(`${droppedStream} older panel-mode events omitted from console memory; inspect hub.log for the full stream.`);
      for (const event of pendingStream) writeStream(event.text);
      pendingStream = []; droppedStream = 0;
    }
    terminal.write(state.mode === "stream" ? `\x1b[1;${rows - 3}r` : "\x1b[r");
    const lines = renderConsole(state, columns, rows);
    const start = state.mode === "stream" ? rows - 2 : 1;
    for (const [index, line] of lines.entries()) { terminal.write(`\x1b[${start + index};1H\x1b[2K`); safeWrite(line); }
    terminal.write(`\x1b[${rows};${Math.min(columns, Bun.stringWidth(lines.at(-1) ?? "") + 1)}H\x1b[?25h`);
  };
  const stop = (reason?: string) => {
    if (!active) return;
    active = false;
    for (const timer of timers) clearInterval(timer);
    for (const remove of removers) remove();
    cancelChild?.(); cancelChild = undefined;
    client.onPush = priorPush; client.onClose = priorClose;
    if (terminal.isTTY) {
      try { terminal.raw(priorRaw); } finally { terminal.write(RESTORE_CONSOLE + "\r\n"); }
    }
    client.close();
    safeWrite(`${reason ? reason + "\n" : ""}Left console; the hub keeps running (ahub kill stops it).\n`);
    resolveDone();
  };
  const refresh = async () => {
    if (polling || !active) return; polling = true;
    try {
      const panels = state.mode === "panels" && !plain;
      const replies = await Promise.all([
        client.request({ t: "status" }, 3000), client.request({ t: "budget" }, 3000),
        ...(panels ? [client.request({ t: "task", op: "hub_task_list", args: {} }, 3000), client.request({ t: "queue", op: "list" }, 3000), client.request({ t: "task", op: "hub_task_list", args: { ready: true } }, 3000)] : []),
      ]);
      if (!active) return;
      const [status, budget, tasks, queue, ready] = replies;
      if (status.status?.peers) state.peers = status.status.peers;
      if (budget.budget) state.budget = budget.budget;
      if (tasks?.ok && state.mode === "panels") { const parsed = JSON.parse(tasks.text); if (Array.isArray(parsed)) {
          const readyIds = new Set(ready?.ok ? JSON.parse(ready.text).map((task: any) => task.id) : []);
          state.tasks = parsed.map(task => ({ ...task, ready: readyIds.has(task.id) }));
        } }
      if (queue?.ok && state.mode === "panels" && Array.isArray(queue.deliveries)) state.queue = queue.deliveries;
      const error = replies.find(reply => reply.ok === false)?.error; if (error) state.notice = String(error);
      draw();
    } catch (error) { if (active) { state.notice = String((error as Error).message); draw(); } }
    finally { polling = false; }
  };
  const run = options.runCommand ?? ((args, output, finished) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url)), "--project", options.cwd, ...args], {
      cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const read = async (source: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder(); const reader = source.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; output(decoder.decode(value, { stream: true })); } const end = decoder.decode(); if (end) output(end); }
      finally { reader.releaseLock(); }
    };
    void Promise.all([read(child.stdout), read(child.stderr), child.exited]).then(([, , code]) => { if (code) output(`command exited ${code}`); }).catch(error => output(String(error.message))).finally(finished);
    return () => { child.kill(); };
  });
  const effect = async (action: ConsoleEffect) => {
    if (action.type === "exit") return stop();
    if (action.type === "permit") { client.send({ t: "permit", surface: "console", id: action.id, ...(action.option ? { option: action.option } : {}) }); return; }
    if (action.type === "show") {
      const result = await client.request(action.panel === 3 ? { t: "task", op: "task_show", args: { id: action.id } } : { t: "queue", op: "show", id: action.id }, 3000);
      if (!active) return;
      state.detailOffset = 0;
      state.detail = result.ok === false ? String(result.error) : action.panel === 3 ? String(result.text) : JSON.stringify(result.delivery, null, 2);
      draw(); return;
    }
    if (childRunning) { state.notice = "a command is already running"; draw(); return; }
    childRunning = true;
    stream({ text: `> ${action.args.join(" ")}`, kind: "command" });
    try {
      cancelChild = run(action.args, text => { if (active) { stream({ text, kind: "command" }); draw(); } }, () => { childRunning = false; cancelChild = undefined; if (active) void refresh(); });
    } catch (error) { childRunning = false; state.notice = String((error as Error).message); draw(); }
  };
  const handle = (key: string) => {
    if (!active) return;
    const result = reduceConsole(state, key); state = result.state;
    if (state.mode === "panels" && (plain || columns < 80 || rows < 24)) { state.mode = "stream"; state.notice = "panels need at least 80x24"; }
    for (const action of result.effects) void effect(action).catch(error => stop(`Console error: ${String(error.message)}`));
    draw();
    if (key === "v" && state.detail && state.mode === "stream") { stream({ text: state.detail, kind: "permission" }); state.detail = undefined; draw(); }
    if (key === "\t") void refresh();
  };
  client.onPush = msg => {
    if (!active) return;
    try {
      if (msg.t === "event") stream({ text: renderTailEvent(msg.e), peer: msg.e.peer ?? msg.e.env?.from, kind: msg.e.env?.kind ?? msg.e.t });
      else if (msg.t === "context") stream({ text: `  ${msg.peer}: ${contextLine(msg.reading)}`, peer: msg.peer, kind: "context" });
      else if (msg.t === "notice") stream({ text: `  * ${msg.line}`, kind: "notice" });
      else if (msg.t === "permission") {
        stream({ text: `  ? ${msg.peer} asks permission: ${String(msg.title).replace(/\n/g, "\n      | ")}\n    answer with: ahub permit ${msg.id} <${msg.options.map((o: any) => `${o.optionId} (${o.name})`).join(", ")}> | deny`, peer: msg.peer, kind: "permission" });
        if (typeof msg.expiresAt === "number" && msg.expiresAt > Date.now() && !state.approvals.some(a => a.id === msg.id)) state.approvals.push(msg);
      } else if (msg.t === "permission_closed") {
        state.approvals = state.approvals.filter(a => a.id !== msg.id); state = pruneApprovals(state, Date.now());
      }
      draw();
    } catch (error) { stop(`Console error: ${String((error as Error).message)}`); }
  };
  client.onClose = (_code, reason) => stop(`Hub connection closed${reason ? `: ${reason}` : ""}`);
  try {
    if (plain) { state.mode = "stream"; safeWrite("Console panels need a terminal of at least 80x24; showing the plain stream.\n"); }
    if (terminal.isTTY) {
      terminal.raw(true);
      removers.push(terminal.onData(text => {
        // A pasted chunk can only edit text, never approve, confirm or run commands. Bracketed-paste delimiters are stripped.
        if (Array.from(text).length > 1 && !["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"].includes(text)) {
          state.confirm = undefined; state.optionChoice = undefined; state.editing = true;
          state.input += terminalText(text.replace(/\x1b\[20[01]~/g, "")).replace(/\n/g, " "); draw();
        } else handle(text);
      }));
      removers.push(terminal.onResize(() => {
        columns = terminal.columns; rows = terminal.rows; plain = columns < 80 || rows < 24;
        if (plain) {
          if (inAlternate) { terminal.write("\x1b[?1049l"); inAlternate = false; }
          terminal.write("\x1b[r"); state.mode = "stream"; state.notice = "panels need at least 80x24";
          safeWrite("\nTerminal below 80x24; showing the plain stream.\n");
        }
        draw();
      }));
    }
    removers.push(terminal.onSignal(() => stop()));
    if (terminal.onError) removers.push(terminal.onError(error => { process.exitCode = 1; stop(`Console error: ${error.message}`); }));
    timers.push(setInterval(() => { try { state = pruneApprovals(state, Date.now()); draw(); } catch (error) { stop(`Console error: ${String((error as Error).message)}`); } }, 1000));
    timers.push(setInterval(() => void refresh(), Math.max(2000, options.pollMs ?? 4000)));
    draw(); client.send({ t: "tail" }); void refresh(); await done;
  } catch (error) { stop(`Console error: ${String((error as Error).message)}`); }
  finally { stop(); }
}
