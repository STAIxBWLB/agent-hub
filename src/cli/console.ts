import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { ControlClient } from "../hub/control-client.ts";
import { contextLine } from "./status-lines.ts";
import { renderTailEvent } from "./tail-render.ts";
import { reviewResult } from "./console-review.ts";
import { syncPermissionDefaults, permissionDefaultText, approvalFrom, initialConsoleState, keyTable, notify, paint, permissionText, plural, pruneApprovals, reduceConsole, renderConsoleLines, resolveColor, stateTone, streamTokens, wrapStreamTokens, terminalText, wrap, captureConsoleSelection, selectedPanelRow, appendEvent, FIRST_KEYS, LAST_KEYS } from "./console-state.ts";
import type { ConsoleEffect, ConsoleEvent, Detail, Tone } from "./console-state.ts";
import type { BusEvent } from "../hub/bus.ts";
import { consoleNeeds, attentionFacts } from "./attention.ts";
import { loadPetConfig } from "./pet-config.ts";
import { CHARACTER_IDS, petGlyphs, petSize } from "../pet/frame.ts";
import { activeNotice, consoleFooterRows } from "./console-state.ts";
import { characterAttentionLine } from "./attention.ts";

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
  color?: boolean;
  noPet?: boolean;
  /** Explicit delegation inherited only by this console's ahub subprocesses. */
  liveTest?: boolean;
  /** Injected command runner must use argv, closed stdin, and return a cancellation handle. */
  runCommand?: (args: string[], output: (text: string) => void, done: (code?: number) => void, columns?: number) => (() => void);
  pollMs?: number;
}
/** Exact navigation sequences only (#309, #441); anything else in a multi-character read is a paste. */
const NAVIGATION = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", ...FIRST_KEYS, ...LAST_KEYS].filter(key => key.startsWith("\x1b"));
export function navigationPresses(text: string): string[] | undefined {
  const keys: string[] = [];
  for (let at = 0; at < text.length;) {
    const key = NAVIGATION.find(k => text.startsWith(k, at));
    if (!key) return undefined;
    keys.push(key); at += key.length;
  }
  return keys.length ? keys : undefined;
}
export const RESTORE_CONSOLE = "\x1b[?1049l\x1b[r\x1b[0m\x1b[?25h";
/** Console-only styling uses event structure; tail text and message bodies are never parsed for meaning. */
export function eventTone(e: BusEvent): Tone | undefined {
  if (e.t === "state") return stateTone(e.state);
  if (e.t === "undeliverable" || e.t === "overflow") return "failure";
  if (e.t === "envelope") {
    if (e.dropped === "hop") return "failure";
    if (e.env.priority === "important" || e.env.kind === "task" || e.env.kind === "review" || e.env.kind === "budget") return "attention";
    return "info";
  }
  return undefined;
}
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
/** `task_show` text as labeled fields; a message that is not a task stays text. */
function labeled(text: string): Detail {
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : String(value); }
  catch { return text; }
}
/** One terminal client, no daemon ownership. All text crosses terminalText before writing. */
export async function runConsole(options: ConsoleOptions): Promise<void> {
  const { client } = options; const terminal = options.terminal ?? nativeTerminal();
  const color = options.color ?? resolveColor(undefined, { isTTY: terminal.isTTY, TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR }) === true;
  let state = initialConsoleState(!!options.panels); state.project = basename(options.cwd);
  let pet = loadPetConfig(options.cwd);
  let petSignature = JSON.stringify([pet.enabled, pet.character, pet.size, pet.glyphs, pet.blink, pet.bell]);
  state.petEnabled = pet.enabled && !options.noPet; state.petBlink = pet.blink;
  state.petChoices = CHARACTER_IDS; state.petCharacter = pet.character ?? "stai";
  state.petSize = pet.size; state.petGlyphs = petGlyphs(pet.glyphs);
  let lastAct = 0; let lastBell = -Infinity;
  let columns = options.columns ?? terminal.columns; let rows = options.rows ?? terminal.rows;
  let active = true; let inAlternate = false; let plain = !terminal.isTTY || columns < 80 || rows < 24;
  let polling = false; let refreshPending = false; let childRunning = false; let cancelChild: (() => void) | undefined;
  const priorPush = client.onPush; const priorClose = client.onClose; const priorRaw = !!terminal.isRaw;
  const removers: (() => void)[] = []; const timers: ReturnType<typeof setInterval>[] = [];
  let resolveDone: () => void = () => {}; const done = new Promise<void>(resolve => { resolveDone = resolve; });
  let pendingStream: ConsoleEvent[] = []; let droppedStream = 0;
  let priorStreamFooterStart: number | undefined;
  let lastExpandedNotice = "";
  const notice = (text: string, tone: Tone = "failure") => notify(state, text, Date.now(), tone);
  const safeWrite = (text: string) => terminal.write(paint([{ text }], color));
  const streamLines = (event: ConsoleEvent) => terminalText(event.text).replace(/\t/g, " ").split("\n").flatMap((text, index) => {
    // Tabs are flattened before measuring, as wrap() does; commands already wrap cells at their own offsets.
    if (event.kind === "command" && Bun.stringWidth(text) <= columns) return [[{ text }]];
    return index === 0 ? wrapStreamTokens(text, columns, event.tone, event.kind) : wrap(text, columns).map(line => [{ text: line }]);
  });
  const writeStream = (event: ConsoleEvent) => {
    terminal.write(`\x1b[${rows - consoleFooterRows(state, columns, rows)};1H`); // the scroll region ends above the rule and the three footer lines
    for (const line of streamLines(event)) { terminal.write(paint(line, color)); terminal.write("\r\n"); }
  };
  /** `record: false` is for the console's own prints (the key table, a request viewed again): not events, so not in Events. */
  const stream = (event: ConsoleEvent, record = true) => {
    if (event.kind === "command") event = { ...event, text: terminalText(event.text).replace(/\t/g, " ") };
    if (record) appendEvent(state, { ...event, text: terminalText(event.text) });
    if (plain) {
      const [header, ...body] = terminalText(event.text).split("\n");
      terminal.write(paint([...(color ? streamTokens(header ?? "", event.tone, event.kind) : [{ text: header ?? "" }]), ...body.map(text => ({ text: "\n" + text }))], color) + "\n");
    }
    else if (state.mode === "stream") writeStream(event);
    else { pendingStream.push(event); if (pendingStream.length > 1000) { pendingStream.shift(); droppedStream++; } }
  };
  const draw = () => {
    if (!active) return;
    if (state.petEnabled) {
      const attention = consoleNeeds(state, Date.now());
      if (plain && attention.act !== lastAct) safeWrite(characterAttentionLine(attention, state.petCharacter) + "\n");
      if (pet.bell && !lastAct && attention.act && attention.items.some(item => item.level === "act" && item.kind !== "message") && Date.now() - lastBell >= 60000) { terminal.write("\x07"); lastBell = Date.now(); }
      lastAct = attention.act;
    }
    if (plain) return;
    const returningToStream = state.mode === "stream" && inAlternate;
    if (state.mode === "panels" && !inAlternate) { terminal.write("\x1b[r\x1b[?1049h\x1b[2J"); inAlternate = true; }
    else if (state.mode === "stream" && inAlternate) {
      terminal.write(`\x1b[?1049l\x1b[1;${rows - consoleFooterRows(state, columns, rows)}r`); inAlternate = false;
    }
    const footerStart = rows - consoleFooterRows(state, columns, rows) + 1;
    if (state.mode === "stream" && priorStreamFooterStart !== undefined && priorStreamFooterStart < footerStart) {
      for (let row = priorStreamFooterStart; row < footerStart; row++) terminal.write(`\x1b[${row};1H\x1b[2K`);
    }
    if (state.mode === "stream") priorStreamFooterStart = footerStart;
    terminal.write(state.mode === "stream" ? `\x1b[1;${rows - consoleFooterRows(state, columns, rows)}r` : "\x1b[r");
    if (returningToStream) {
      if (droppedStream) writeStream({ text: `${plural(droppedStream, "older panel-mode event")} omitted from console memory; inspect hub.log for the full stream.` });
      for (const event of pendingStream) writeStream(event);
      pendingStream = []; droppedStream = 0;
    }
    if (state.mode === "stream" && state.petEnabled && petSize(state.petSize, columns, rows) !== "line" && activeNotice(state)) {
      const key = JSON.stringify([state.noticeAt, state.notice]);
      if (key !== lastExpandedNotice) { lastExpandedNotice = key; stream({ text: `Notice: ${state.notice}`, kind: "notice", tone: state.noticeTone ?? "failure" }, false); }
    }
    const lines = renderConsoleLines(state, columns, rows);
    const start = rows - lines.length + 1;
    for (const [index, line] of lines.entries()) { terminal.write(`\x1b[${start + index};1H\x1b[2K`); terminal.write(paint(line, color)); }
    terminal.write(`\x1b[${rows};${Math.min(columns, Bun.stringWidth(paint(lines.at(-1) ?? [], false)) + 1)}H\x1b[?25h`);
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
  const reconcileDetail = () => {
    if (state.detail === undefined || typeof state.detail !== "object" || (state.panel !== 3 && state.panel !== 4)) return;
    const id = state.detail.id;
    if (id === undefined || id === null) return;
    const key = state.panel === 3 ? "flowRevision" : "revision", rows = state.panel === 3 ? state.tasks : state.queue;
    const fresh = rows.find(row => String(row.id) === String(id));
    if (!fresh || state.detail[key] !== fresh[key]) {
      state.detail = undefined; state.detailOffset = 0;
      notice(`detail ${id} changed or is no longer available`);
    }
  };
  const refresh = async () => {
    if (polling || !active) { if (active) refreshPending = true; return; }
    polling = true;
    try {
      const panels = state.mode === "panels" && !plain;
      const replies = await Promise.all([
        client.request({ t: "status" }, 3000), client.request({ t: "budget" }, 3000),
        ...(panels ? [client.request({ t: "task", op: "hub_task_list", args: {} }, 3000), client.request({ t: "queue", op: "list" }, 3000), client.request({ t: "task", op: "hub_task_list", args: { ready: true } }, 3000)] : []),
        ...(panels && (state.panel === 1 || state.panel === 6) ? [client.request({ t: "settings_get" }, 3000)] : []),
      ]);
      // #683 U3: the Usage panel asks the hub's roll-up only while it is open (UTC day, 7 UTC days, lifetime, the limits history and the selected task).
      // The task is read at the time of the request, so a reply for a task that is no longer selected is dropped below.
      const usageTask = panels && state.panel === 7 ? state.usageTask : undefined;
      const usageReplies = panels && state.panel === 7 ? await (async () => {
        const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
        return Promise.all([client.request({ t: "usage", by: "peer", since: startOfDay }, 5000), client.request({ t: "usage", by: "peer", since: startOfDay - 6 * 86_400_000 }, 5000),
          client.request({ t: "usage", by: "peer" }, 5000), client.request({ t: "usage", op: "limits", limit: 1000 }, 5000),
          ...(usageTask !== undefined ? [client.request({ t: "usage", by: "peer", task: usageTask }, 5000)] : [])]);
      })() : undefined;
      if (!active) return;
      const [status, budget, tasks, queue, ready, settings] = replies;
      captureConsoleSelection(state);
      try {
        const latestPet = loadPetConfig(options.cwd);
        const nextSignature = JSON.stringify([latestPet.enabled, latestPet.character, latestPet.size, latestPet.glyphs, latestPet.blink, latestPet.bell]);
        if (nextSignature !== petSignature) {
          pet = latestPet; petSignature = nextSignature;
          state.petEnabled = pet.enabled && !options.noPet; state.petBlink = pet.blink;
          state.petCharacter = pet.character ?? "stai"; state.petSize = pet.size; state.petGlyphs = petGlyphs(pet.glyphs);
        }
      } catch { /* retain running console presentation while a config file is unreadable */ }
      if (status.status?.tasks && status.ok !== false) state.taskCounts = status.status.tasks;
      if (status.status && status.ok !== false) state.pendingRestart = Array.isArray(status.status.pendingRestart) ? status.status.pendingRestart : [];
      if (status.status && status.ok !== false) state.retainedConfig = Array.isArray(status.status.retainedConfig) ? status.status.retainedConfig : [];
      if (status.status) state.features = Array.isArray(status.status.features) ? status.status.features : [];
      if (status.status?.peers) state.peers = Object.fromEntries(Object.entries(status.status.peers).map(([peer, value]) => [peer, { ...(value as object), ...status.status.roleInfo?.[peer],
        ...(typeof status.status.ownerIsolation?.[peer] === "boolean" ? { ownerIsolation: status.status.ownerIsolation[peer] } : {}),
        ...(typeof status.status.ownerIsolationNotes?.[peer] === "string" ? { ownerIsolationNote: status.status.ownerIsolationNotes[peer] } : {}) }]));
      if (status.status && status.ok !== false) {
        state.taskWip = status.status.taskWip ?? {};
        state.attentionFacts = attentionFacts(status.status.attentionItems);
        state.storageBlocked = !!status.status.deliveryError;
        state.recoveryNeed = status.status.recovery ? { id: status.status.recovery.operationId, running: true } : undefined;
      }
      if (syncPermissionDefaults(state, status.status?.permissionDefaults) && state.confirm?.type === "permission_default") stream({ text: permissionDefaultText(state.confirm), kind: "permission_default", peer: state.confirm.peer, tone: "attention" });
      if (budget.budget) {
        // #285: the hub's note per peer (no quota, nothing read yet) rides next to the windows, so the peer detail says why a number is missing.
        const notes = new Map<string, any>((Array.isArray(budget.peers) ? budget.peers : []).map((n: any) => [String(n?.peer), n] as const));
        state.budget = Object.fromEntries([...new Set([...Object.keys(budget.budget), ...notes.keys()])].map(peer => [peer, { windows: [], ...budget.budget[peer], ...(notes.get(peer)?.note ? { note: String(notes.get(peer).note) } : {}) }]));
      }
      if (usageReplies) {
        const [today, week, life, limits, task] = usageReplies, failed = usageReplies.find(reply => reply?.ok === false);
        if (failed || !today?.usage || !week?.usage || !life?.usage || !limits?.limits) state.usage = { ...state.usage, problem: String(failed?.error ?? "usage is unavailable") };
        else state.usage = { today: today.usage, week: week.usage, life: life.usage, limits: limits.limits, at: Date.now(), ...(usageReplies.some(reply => reply?.behind) ? { behind: true } : {}),
          ...(usageTask !== undefined && task?.usage && state.usageTask === usageTask ? { task: task.usage, taskId: usageTask } : {}) };
      }
      if (tasks?.ok) { const parsed = JSON.parse(tasks.text); if (Array.isArray(parsed)) {
          const readyIds = new Set(ready?.ok ? JSON.parse(ready.text).map((task: any) => task.id) : []);
          state.tasks = parsed.map(task => ({ ...task, ready: readyIds.has(task.id) }));
          state.tasksKnown = true;
        } }
      if (queue?.ok && state.mode === "panels" && Array.isArray(queue.deliveries)) state.queue = queue.deliveries;
      if (settings) {
        if (settings.ok && Array.isArray(settings.rows)) {
          state.settingsRows = settings.rows; state.settingsKnown = true; state.settingsProblem = undefined;
          state.settingsUndo = typeof settings.undo === "string" ? settings.undo : undefined;
          const revisions = (settings.configEdit as { revisions?: unknown } | undefined)?.revisions;
          const known = (settings.configEdit as { known?: unknown } | undefined)?.known;
          state.configInstances = Array.isArray(known) ? known.map(String).filter(Boolean) : [];
          if (revisions && typeof revisions === "object") state.configRevisions = Object.fromEntries(Object.entries(revisions).filter(([, value]) => typeof value === "string")) as Record<string, string>;
          state.pendingRestart = Array.isArray(settings.pendingRestart) ? settings.pendingRestart : [];
          state.retainedConfig = Array.isArray(settings.retainedConfig) ? settings.retainedConfig : [];
        } else state.settingsProblem = String(settings.error ?? "settings are unavailable");
      }
      reconcileDetail();
      const error = replies.find(reply => reply.ok === false)?.error; if (error) notice(String(error));
      draw();
    } catch (error) { if (active) { notice(String((error as Error).message)); draw(); } }
    finally {
      polling = false;
      if (refreshPending) { refreshPending = false; void refresh(); }
    }
  };
  const run = options.runCommand ?? ((args, output, finished, commandColumns) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url)), "--project", options.cwd, ...(options.liveTest ? ["--live-test"] : []), ...args], {
      cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, COLUMNS: String(commandColumns), NO_COLOR: "1" },
    });
    const read = async (source: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder(); const reader = source.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; output(decoder.decode(value, { stream: true })); } const end = decoder.decode(); if (end) output(end); }
      finally { reader.releaseLock(); }
    };
    let exitCode = 0;
    void Promise.all([read(child.stdout), read(child.stderr), child.exited]).then(([, , code]) => { exitCode = code; if (code) output(`command exited ${code}`); }).catch(error => { exitCode = 1; output(String(error.message)); }).finally(() => finished(exitCode));
    return () => { child.kill(); };
  });
  const effect = async (action: ConsoleEffect) => {
    if (action.type === "exit") return stop();
    if (action.type === "settings_preview") {
      const response = await client.request(action.undo ? { t: "settings_preview", undo: true } : { t: "settings_preview", key: action.key, value: action.value }, 3000);
      const edit = state.settingsEdit;
      if (!active || state.mode !== "panels" || !edit || state.panel !== (edit.panel ?? 6) || edit.phase !== "preview" || edit.token !== action.token || edit.undo !== action.undo || edit.key !== action.key || (!action.undo && JSON.stringify(edit.value) !== JSON.stringify(action.value))) return;
      if (response.ok === false) { state.settingsEdit = undefined; notice(String(response.error ?? "setting preview refused")); }
      else if (action.undo && (typeof response.key !== "string" || !response.key || response.key.trim() !== response.key || response.key.length > 160 || typeof response.undoDigest !== "string" || !/^[a-f0-9]{64}$/i.test(response.undoDigest))) {
        state.settingsEdit = undefined; notice("undo preview is unavailable or changed; reload settings and review it again");
      } else state.settingsEdit = { ...edit, ...(action.undo ? { key: response.key, undoDigest: response.undoDigest } : {}), phase: "reason", text: "", lines: [...(Array.isArray(response.lines) ? response.lines.map(String) : []), ...(Array.isArray(response.tasks) ? response.tasks.flatMap((task: any) => [String(task.before?.join("\n") ?? ""), String(task.after?.join("\n") ?? "")]) : []), ...(response.hidden ? [`${response.hidden} more open tasks are not shown`] : [])], ...(typeof response.confirm === "string" ? { confirm: response.confirm } : {}) };
      draw(); return;
    }
    if (action.type === "config_preview") {
      const response = await client.request({ t: "config_edit_preview", edit: action.edit }, 5000);
      const form = state.configForm;
      // A reply for a form that was cancelled or replaced is dropped: it never opens a confirmation of its own.
      if (!active || state.mode !== "panels" || !form || form.token !== action.token) return; // every form has its own token and one outstanding preview
      if (response.ok === false) { state.configForm = undefined; notice(String(response.error ?? "config preview refused")); }
      else state.configForm = { ...form, phase: "reason", text: "", lines: (Array.isArray(response.lines) ? response.lines : []).map(String).slice(0, 40),
        ...(typeof response.confirm === "string" ? { typed: response.confirm, warning: typeof response.warning === "string" ? response.warning : undefined } : {}) };
      draw(); return;
    }
    if (action.type === "config_write") {
      const result = await client.request({ t: "config_edit_apply", edit: action.edit, reason: action.reason, ...(action.confirm ? { confirm: action.confirm } : {}) }, 35_000);
      if (!active) return;
      if (result.ok === false) notice(String(result.error ?? "config write refused"));
      else {
        const text = [String(result.text ?? "config saved"), ...(Array.isArray(result.restartPending) && result.restartPending.length ? [`restart pending: ${result.restartPending.join(", ")}`] : [])].join("; ");
        stream({ text, kind: "settings" }); notice(text, "info");
      }
      await refresh(); draw(); return;
    }
    if (action.type === "settings_write") {
      const result = await client.request({ t: action.undo ? "settings_undo" : "settings_set", key: action.key, ...(!action.undo ? { value: action.value } : { undoDigest: action.undoDigest }), reason: action.reason, ...(action.confirm ? { confirm: action.confirm } : {}) }, 35_000);
      if (!active) return;
      if (result.ok === false) notice(String(result.error ?? "setting write refused"));
      else stream({ text: String(result.text ?? "setting saved"), kind: "settings" });
      await refresh(); draw(); return;
    }
    if (action.type === "permission_default") {
      const result = await client.request({ t: "permission_default", peer: action.peer, confirmed: action.confirmed }, 35_000);
      if (!active) return;
      if (result.ok === false) {
        notice(String(result.error ?? "permission default refused"));
      } else stream({ text: `  ${action.peer} never-ask default ${action.confirmed ? "enabled" : "cancelled for this hub"}`, kind: "permission_default", peer: action.peer, tone: "attention" });
      await refresh(); draw(); return;
    }
    if (action.type === "permit") {
      client.send({ t: "permit", surface: "console", id: action.id, ...(action.option ? { option: action.option } : {}) });
      if (!action.option) stream({ text: `  ! denial requested for permission ${action.id}`, kind: "permission", tone: "failure" });
      return;
    }
    if (action.type === "keys") return stream({ text: keyTable(columns, !!state.petEnabled || !!state.petChoices?.length, !!state.petChoices?.length).map(line => paint(line, false)).join("\n"), kind: "console" }, false);
    if (action.type === "print") return stream({ text: action.text, kind: action.kind, ...(action.tone ? { tone: action.tone } : {}) }, false);
    if (action.type === "show") {
      const result = await client.request(action.panel === 3 ? { t: "task", op: "task_show", args: { id: action.id } } : { t: "queue", op: "show", id: action.id }, 3000);
      // A late reply is for the panel and row it was asked for: once the person has moved on, it would show one item
      // while the keys act on another, so it is dropped.
      if (!active || state.mode !== "panels" || state.panel !== action.panel || state.help || state.detail !== undefined || String(selectedPanelRow(state)?.id) !== action.id) return;
      state.detailOffset = 0;
      state.detail = result.ok === false ? String(result.error) : action.panel === 3 ? labeled(String(result.text)) : result.delivery ?? "delivery not found";
      draw(); return;
    }
    if (childRunning) { notice("a command is already running"); draw(); return; }
    childRunning = true;
    stream({ text: `> ${action.args.join(" ")}`, kind: "command" });
    try {
      let diagnostic = "";
      // Output lines sit at column 4, as message bodies do: what a command prints can carry peer text, and columns 0 and 2 are the hub's.
      const output = (text: string) => { if (active) { diagnostic = (diagnostic + terminalText(text)).slice(-2000); stream({ text: terminalText(text).replace(/\t/g, " ").replace(/\n$/, "").replace(/^/gm, "    "), kind: "command" }); draw(); } };
      cancelChild = run(action.args, output, (code = 0) => {
        childRunning = false; cancelChild = undefined;
        if (active) {
          // #711: a review's result is a notice in panels mode too (where the stream is not on screen): `#372 approved`, or the CLI's own refusal verbatim.
          const review = reviewResult(action.args, code, diagnostic.trim());
          if (review) notify(state, review.text, Date.now(), review.tone === "success" ? "success" : "failure");
          else if (code) notice(diagnostic.trim() || `command exited ${code}`);
          void refresh(); draw();
        }
      }, Math.max(1, columns - 4));
    } catch (error) { childRunning = false; notice(String((error as Error).message)); draw(); }
  };
  const handle = (key: string) => {
    if (!active) return;
    const priorPanel = state.panel;
    const result = reduceConsole(state, key); state = result.state;
    state.attentionMessages = []; state.attentionSelection = key === "n" ? state.attentionSelection : undefined;
    if (state.mode === "panels" && (plain || columns < 80 || rows < 24)) { state.mode = "stream"; notice("panels need at least 80x24"); }
    for (const action of result.effects) void effect(action).catch(error => stop(`Console error: ${String(error.message)}`));
    draw();
    if (key === "\t" || state.panel !== priorPanel) void refresh();
  };
  client.onPush = msg => {
    if (!active) return;
    try {
      if (msg.t === "event") {
        if (state.petEnabled && msg.e.t === "envelope" && !msg.e.dropped && msg.e.env.to?.includes("user")) state.attentionMessages = [...(state.attentionMessages ?? []), { id: msg.e.env.id, peer: msg.e.env.from, important: msg.e.env.priority === "important", since: msg.e.env.ts }].slice(-1000);
        stream({ text: renderTailEvent(msg.e), peer: msg.e.peer ?? msg.e.env?.from, kind: msg.e.env?.kind ?? msg.e.t, tone: eventTone(msg.e) });
      }
      else if (msg.t === "context") stream({ text: `  ${msg.peer}: ${contextLine(msg.reading, at => new Date(at).toLocaleTimeString())}`, peer: msg.peer, kind: "context" });
      else if (msg.t === "notice") stream({ text: `  * ${msg.line}`, kind: "notice" });
      else if (msg.t === "permission") {
        const request = approvalFrom(msg);
        stream({ text: permissionText(request), peer: request.peer, kind: "permission", tone: "attention" });
        // Only the first request is selected on arrival: once a selection has ended, a request that arrives as the person
        // reacts must not take its place, so from then on only [ ], j or k select.
        if (request.expiresAt > Date.now() && !state.approvals.some(a => a.id === request.id)) {
          state.approvals.push(request);
          if (!state.autoSelected) { state.approvalId = request.id; state.autoSelected = true; }
        }
      } else if (msg.t === "permission_closed") {
        state.approvals = state.approvals.filter(a => a.id !== msg.id); state = pruneApprovals(state, Date.now());
        if (msg.reason === "expired" || msg.outcome === "cancelled" || msg.outcome?.startsWith("reject")) stream({ text: `  ! ${msg.peer} permission ${msg.id} ${msg.reason ?? msg.outcome}`, peer: msg.peer, kind: "permission", tone: "failure" });
      }
      draw();
    } catch (error) { stop(`Console error: ${String((error as Error).message)}`); }
  };
  client.onClose = (_code, reason) => stop(`Hub connection closed${reason ? `: ${reason}` : ""}`);
  try {
    if (state.petEnabled && pet.notice) {
      if (state.mode === "panels" && !plain) notify(state, pet.notice, Date.now(), "attention");
      else stream({ text: pet.notice, kind: "attention", tone: "attention" }, false);
    }
    if (plain) { state.mode = "stream"; safeWrite("Console panels need a terminal of at least 80x24; showing the plain stream.\n"); }
    if (terminal.isTTY) {
      terminal.raw(true);
      removers.push(terminal.onData(text => {
        // A pasted chunk can only edit text, never approve, confirm or run commands. Bracketed-paste delimiters are stripped.
        // Under the modal key table it does nothing at all. A read holding nothing but arrow or Home/End sequences is
        // that many key presses (key repeat, a slow link), not a paste (#309, #441): each reaches the reducer on its own.
        const presses = navigationPresses(text);
        if (Array.from(text).length > 1 && presses?.length !== 1) {
          if (presses) { for (const key of presses) handle(key); }
          else {
            state.attentionMessages = []; state.attentionSelection = undefined;
            if (state.help && state.mode === "panels") { draw(); return; }
            if (state.confirm?.type === "permission_default") { draw(); return; }
            if (state.settingsEdit) {
              const edit = state.settingsEdit;
              if (edit.phase === "value" || edit.phase === "reason") state.settingsEdit = { ...edit, text: (edit.text + terminalText(text.replace(/\x1b\[20[01]~/g, "")).replace(/[\r\n]/g, " ")).slice(0, 1000) };
              else state.settingsEdit = undefined;
              draw(); return;
            }
            state.confirm = undefined; state.optionChoice = undefined; state.editing = true;
            state.input += terminalText(text.replace(/\x1b\[20[01]~/g, "")).replace(/\n/g, " "); draw();
          }
        } else handle(text);
      }));
      removers.push(terminal.onResize(() => {
        columns = terminal.columns; rows = terminal.rows; plain = columns < 80 || rows < 24;
        if (plain) {
          if (inAlternate) { terminal.write("\x1b[?1049l"); inAlternate = false; }
          terminal.write("\x1b[r"); state.mode = "stream"; notice("panels need at least 80x24");
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
