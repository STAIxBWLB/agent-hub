import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { renderDigest, replyAudience, replyParent, sanitize, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer, type DeliveryReceipt } from "../hub/peers.ts";
import { peerChildEnv, processTable, type ProcRow } from "../hub/child-process.ts";
import { processSignature } from "../pi/process-signature.ts";
import { assessVersion } from "./compat.ts";
import { qwenSessionId } from "./definitions/qwen-native.ts";
import type { PermissionRequest } from "./acp.ts";

/**
 * #286 Part 3: a Qwen Code TUI the hub drives through its dual-output files (`--input-file`, `--json-file`), verified on 0.26.1
 * (docs/verification/2026-10-25-qwen-dual-output-t0.md). The person runs Qwen in their own terminal; the hub only appends
 * `submit` and `confirmation_response` lines to the input file and tails the event file.
 *
 * Two limits, by design (spec: "Qwen dual-output TUI amendment"):
 *  1. A hub deny cancels Qwen's whole turn and Qwen emits nothing for it: after sending `allowed: false` this adapter ends the turn itself.
 *  2. The input protocol cannot stop a turn and SIGINT does not either: the watchdog never cancels. It marks the turn stalled, and the
 *     person presses Esc in the Qwen terminal. The hub never types into the terminal and never signals the process to stop a turn.
 */
export interface QwenDualMcpServer { name: string; command: string; args: string[]; env: Record<string, string> }
export interface QwenDualOptions {
  cwd: string;
  /** Where the files live: `<stateDir>/qwen-dual/`. */
  stateDir: string;
  /** The hub's whole state dir. A Qwen write or command that names it is refused: the input file is a prompt channel. Defaults to `stateDir`. */
  guardDir?: string;
  /** The configured executable argv (`qwen_cmd`); a trailing `--acp` is dropped, this is the TUI. */
  cmd: readonly string[];
  mcpServers: readonly QwenDualMcpServer[];
  model?: string;
  /** Recovery: resume this native session (`qwen -r`). */
  sessionId?: string;
  watchdogMs?: number;
  /** How often the event file is read (ms). */
  pollMs?: number;
  /** How often the owner process is checked (ms). */
  ownerMs?: number;
  preamble?: string;
  /** The hub's own tools by exact `mcp__<server>__<tool>` name, never by prefix. */
  autoApprove?: (toolName: string) => boolean;
  onPermission?: (req: PermissionRequest, signal?: AbortSignal) => Promise<string | undefined>;
  actionGate?: (call: { names: readonly string[]; input: unknown }, session: string) => { title: string; denyOnly?: true } | undefined;
  /** Called when the turn becomes stalled (true) or moves again (false). */
  onStalled?: (stalled: boolean) => void;
  /** A line for the person (console notice). Never carries model or message text. */
  onNotice?: (text: string) => void;
  /** Once, after the claimed TUI owner is gone. */
  onExit?: () => void;
  log?: (line: string) => void;
  /** Host process-identity reader; never supplied by event data. */
  signature?: typeof processSignature;
  /** The process table, to find the Qwen this adapter launched. Tests supply their own. */
  table?: () => ProcRow[] | undefined;
}

const SUBMIT_CAP = 256 * 1024;
const READ_CAP = 1024 * 1024;
const ANSWERED_CAP = 256;
/** What the console, status and dashboard say while a turn is stalled. */
export const QWEN_STALLED_NOTE = "stalled: Qwen has said nothing for a while; the hub cannot stop a Qwen turn, press Esc in the Qwen terminal";
/** Shown while the hub cannot read the event file: the Qwen TUI itself keeps working, so this is never idle. */
export const QWEN_DETACHED_NOTE = "detached: the hub cannot read Qwen's event file; Qwen keeps working in its terminal and the hub reattaches when the file is readable again";
const DIR = "qwen-dual";

type StateFile = { v: 1; sessionId?: string; offset: number; generation: number; ownerPid?: number; ownerSignature?: string };
interface Turn { envs: Envelope[]; deliveryId?: string; text: string; started: boolean; accepted: boolean }
type Json = Record<string, any>;

/** Whether a Qwen tool request names the hub's state dir: the input file is a prompt channel, so a write or command that reaches it is refused. */
export function qwenDualNamesStateDir(input: unknown, stateDir: string): boolean {
  // The directory itself, and the names of the files in it: a command can reach `input.jsonl` through a relative path or a variable the directory test would miss.
  const needles = new Set<string>([".agenthub/state", ".agenthub\\state", "qwen-dual", "input.jsonl", stateDir]);
  try { needles.add(realpathSync(stateDir)); } catch { /* an absent dir has no real path */ }
  const seen = (value: unknown, depth: number): boolean => {
    if (depth > 8) return true; // too deep to read: refuse rather than guess
    if (typeof value === "string") { const flat = value.replaceAll("\\", "/"); return [...needles].some(n => n && (value.includes(n) || flat.includes(n.replaceAll("\\", "/")))); }
    if (Array.isArray(value)) return value.some(item => seen(item, depth + 1));
    if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => seen(key, depth + 1) || seen(item, depth + 1));
    return false;
  };
  return seen(input, 0);
}

/**
 * #517: Qwen tells the model that one of its background shells finished with a `user` event of its own, which is neither the hub's submit nor the person typing. Qwen may fold
 * several finished shells into one event, each its own envelope, separated by one blank line (8 of the 48 in the live event files do). The shape is exact: the text is wholly
 * one or more complete envelopes and nothing else, so a person's text that merely contains or resembles one is still a person's prompt. Nothing inside an envelope is read
 * beyond its header lines, so nothing in it can steer the adapter.
 */
const NOTIFICATION = String.raw`<task-notification>\n<task-id>bg_[0-9a-f]{4,32}<\/task-id>\n<kind>[a-z_-]{1,32}<\/kind>\n<status>[a-z_-]{1,32}<\/status>\n(?:(?!<task-notification>|<\/task-notification>)[\s\S])*<\/task-notification>`;
const QWEN_TASK_NOTIFICATIONS = new RegExp(`^${NOTIFICATION}(?:\\n\\n${NOTIFICATION})*$`);
const NOTIFICATION_CAP = 64 * 1024;
export function isQwenTaskNotification(text: string): boolean { return text.length <= NOTIFICATION_CAP && QWEN_TASK_NOTIFICATIONS.test(text); }

/** `qwen --version` against the dual-output compat entry. Never throws: a refusal is a reason. */
export async function qwenDualVersionAsync(cmd: readonly string[], cwd: string): Promise<{ ok: true; version: string; note?: string } | { ok: false; reason: string }> {
  const [bin, ...prefix] = cmd.filter(word => word !== "--acp");
  try {
    const child = Bun.spawn([bin ?? "qwen", ...prefix, "--version"], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const out = await new Response(child.stdout).text(); await child.exited; clearTimeout(timer);
    const verdict = assessVersion("qwen-dual", out.trim());
    return verdict.ok ? { ok: true, version: verdict.version, ...(verdict.note ? { note: verdict.note } : {}) } : { ok: false, reason: verdict.reason };
  } catch { return { ok: false, reason: "Version not verified: Qwen Code version unknown; check that the executable runs" }; }
}

export class QwenDualPeer extends BasePeer {
  readonly permissionModeState = "unmanaged" as const;
  private readonly dir: string;
  private readonly inputFile: string;
  private readonly eventFile: string;
  private readonly stateFile: string;
  private readonly mcpFile: string;
  private readonly signature: typeof processSignature;
  private poller?: ReturnType<typeof setInterval>;
  private monitor?: ReturnType<typeof setInterval>;
  private state_: StateFile = { v: 1, offset: 0, generation: 0 };
  private resume = false;
  private _launch?: { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
  private stopping = true;
  private requestedStopReason: string | undefined;
  private detached = false;
  private sessionSeen = false;
  private primed = false;
  private turn?: Turn;
  /** Who owns the turn Qwen is running: the hub's submit, or the person typing in the TUI. */
  private owner: "hub" | "personal" | undefined;
  private lastAssistant?: { text: string; toolUse: boolean };
  private readonly pending = new Map<string, { controller: AbortController; turn: Turn }>();
  private readonly answered = new Set<string>();
  private stalled_ = false;
  private exited = false;
  private pollFailures = 0;
  /** Inside an event line longer than READ_CAP: its rest is dropped through the next newline. */
  private discarding = false;

  constructor(id: PeerId, private readonly opts: QwenDualOptions) {
    super(id, opts.watchdogMs);
    this.dir = join(opts.stateDir, DIR);
    this.inputFile = join(this.dir, "input.jsonl"); this.eventFile = join(this.dir, "events.jsonl");
    this.stateFile = join(this.dir, "state.json"); this.mcpFile = join(this.dir, "mcp.json");
    this.signature = opts.signature ?? processSignature;
  }

  get launch(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | undefined { return this._launch; }
  /** True when this start adopted the running TUI of an earlier hub run: nothing is launched. */
  get adopted(): boolean { return this.adopting; }
  private adopting = false;
  get stalled(): boolean { return this.stalled_; }
  get statusNotice(): { code: "qwen-stalled" | "qwen-detached"; message: string } | undefined {
    if (this.detached) return { code: "qwen-detached", message: QWEN_DETACHED_NOTE };
    return this.stalled_ ? { code: "qwen-stalled", message: QWEN_STALLED_NOTE } : undefined;
  }
  get isDetached(): boolean { return this.detached; }
  /**
   * Whether this adapter holds a person's running Qwen, whatever its state says: a detached peer reads offline while Qwen keeps working, so state is no proof. True while the bound
   * owner is verified alive, or a session was seen and no owner could be bound; false once the owner exited, the adapter stopped, or a launch never attached anything.
   */
  holdsTerminal(): boolean {
    if (this.stopping || this.exited) return false;
    if (this.state_.ownerPid !== undefined) return this.ownerAlive();
    return this.sessionSeen;
  }
  get sessionId(): string | undefined { return this.state_.sessionId; }
  get offset(): number { return this.state_.offset; }
  recoveryMetadata(): Record<string, unknown> { return { ...(this.state_.sessionId ? { sessionId: this.state_.sessionId } : {}), launch: { mode: "tui" } }; }

  // ---- files -------------------------------------------------------------------------------------------------------

  private ensureFile(path: string, create: boolean): void {
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found) { if (!create) throw new Error("Qwen dual-output file is missing"); writeFileSync(path, "", { mode: 0o600, flag: "wx" }); return; }
    if (!found.isFile() || found.isSymbolicLink()) throw new Error("Qwen dual-output path is not a plain file");
    if (typeof process.getuid === "function" && found.uid !== process.getuid()) throw new Error("Qwen dual-output file is not owned by the person running the hub");
    if ((found.mode & 0o077) !== 0) throw new Error("Qwen dual-output file is readable or writable by others");
  }

  private loadState(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 4096) return;
      const buffer = Buffer.alloc(info.size); readSync(fd, buffer, 0, info.size, 0);
      const raw = JSON.parse(buffer.toString("utf8")) as Partial<StateFile>;
      if (raw.v !== 1 || !Number.isSafeInteger(raw.offset) || raw.offset! < 0 || !Number.isSafeInteger(raw.generation)) return;
      this.state_ = { v: 1, offset: raw.offset!, generation: raw.generation!,
        ...(qwenSessionId(raw.sessionId) ? { sessionId: raw.sessionId } : {}),
        ...(Number.isSafeInteger(raw.ownerPid) && typeof raw.ownerSignature === "string" ? { ownerPid: raw.ownerPid, ownerSignature: raw.ownerSignature } : {}) };
    } catch { /* no usable record: a fresh launch */ }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ } }
  }

  private saveState(): void {
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify(this.state_)}\n`, { mode: 0o600 }); renameSync(temp, this.stateFile); }
    catch { this.opts.log?.(`[${this.id}] could not record its Qwen read position`); }
  }

  private ownerAlive(): boolean {
    const { ownerPid, ownerSignature } = this.state_;
    if (ownerPid === undefined || ownerSignature === undefined) return false;
    return this.signature(ownerPid) === ownerSignature;
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(this.dir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (typeof process.getuid === "function" && dir.uid !== process.getuid()) || (dir.mode & 0o077) !== 0) throw new Error("Qwen dual-output directory is not private to the person running the hub");
    this.loadState();
    for (const path of [this.inputFile, this.eventFile]) this.ensureFile(path, true);
    this.stopping = false; this.exited = false;
    if (this.ownerAlive()) {
      // The hub restarted while the person's Qwen kept running: read on from the saved offset. No event is processed twice and no launch happens.
      this.adopting = true;
      const probe = openSync(this.eventFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      let size = 0; try { size = fstatSync(probe).size; } finally { closeSync(probe); }
      if (size < this.state_.offset) { this.state_.offset = 0; this.state_.generation++; }
      // ponytail: a Qwen turn that was running when the hub went away is not known here, so the adopted peer reads idle until the next event says otherwise.
      // Upgrade: record the open hub turn in state.json and settle it on adoption.
      this.sessionSeen = this.state_.sessionId !== undefined; this.primed = true;
      this.saveState();
    } else {
      // A fresh or resumed launch. Qwen opens an existing event file without truncating or appending, so it would overwrite it from byte 0: start from empty files.
      this.adopting = false;
      this.resume = this.opts.sessionId !== undefined || this.state_.sessionId !== undefined;
      const resumeId = this.opts.sessionId ?? this.state_.sessionId;
      const previous = lstatSync(this.eventFile);
      if (previous.size > 0) { try { renameSync(this.eventFile, join(this.dir, "events.prev.jsonl")); } catch { /* a stale copy is only evidence */ } this.ensureFile(this.eventFile, true); }
      closeSync(openSync(this.inputFile, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_TRUNC));   // Qwen starts reading at the file's current end, so earlier submits are never replayed; empty is the clearest record
      this.state_ = { v: 1, offset: 0, generation: this.state_.generation + 1, ...(resumeId ? { sessionId: resumeId } : {}) };
      this.sessionSeen = false;
      this.saveState();
      this.writeLaunch(resumeId);
    }
    this.poller = setInterval(() => this.poll(), this.opts.pollMs ?? 100); this.poller.unref?.();
    if (!this.monitor) { this.monitor = setInterval(() => this.checkOwner(), this.opts.ownerMs ?? 1_000); this.monitor.unref?.(); }
    this.poll();
    if (this.adopting && !this.detached && this.sessionSeen) this.setState("idle");
    // A TUI that has not announced itself yet is not attached: the hub treats the peer as offline until session_start.
  }

  private writeLaunch(resumeId: string | undefined): void {
    const [bin, ...rest] = this.opts.cmd.filter(word => word !== "--acp");
    if (!bin) throw new Error("qwen_cmd must name an executable");
    const servers = Object.fromEntries(this.opts.mcpServers.map(server => [server.name, { command: server.command, args: server.args, env: server.env }]));
    writeFileSync(this.mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    const args = [...rest, "--input-file", this.inputFile, "--json-file", this.eventFile, "--mcp-config", this.mcpFile, "--approval-mode", "default",
      ...(this.opts.model ? ["--model", this.opts.model] : []), ...(resumeId ? ["-r", resumeId] : [])];
    this._launch = { cmd: bin, args, env: peerChildEnv(this.id, {}) };
  }

  /**
   * Bind the Qwen this adapter launched: the one process whose argv names this adapter's own `--input-file`. No launcher message is trusted for it; the pid and its start-time
   * signature come from the host's own process table, so a process that merely claims to be Qwen, or a reused pid, never becomes the owner. Two matches is ambiguous: no owner.
   */
  private discoverOwner(): void {
    if (this.stopping || this.state_.ownerPid !== undefined) return;
    const rows = (this.opts.table ?? processTable)();
    if (!rows) return;
    const flag = `--input-file ${this.inputFile}`;
    const matches = rows.filter(row => row.pid !== process.pid && row.command.includes(flag));
    // The real Qwen is a small tree, every member of which names the file: the person's `script` or shell wrapper, Qwen's own node launcher and its `cli.js` child (measured on
    // 0.26.1). The owner is the root of that tree, the one match whose parent is not also a match. Two separate roots (another Qwen on the same file) is ambiguous: no owner.
    const pids = new Set(matches.map(row => row.pid));
    const roots = matches.filter(row => !pids.has(row.ppid));
    if (roots.length !== 1) return;
    const pid = roots[0]!.pid, signature = this.signature(pid);
    if (!signature) return;
    this.state_.ownerPid = pid; this.state_.ownerSignature = signature; this.saveState();
  }

  private checkOwner(): void {
    if (this.stopping || this.exited) return;
    if (this.state_.ownerPid === undefined) { if (this.sessionSeen) this.discoverOwner(); return; }
    if (this.ownerAlive()) return;
    if (this.state === "offline" && !this.sessionSeen) return;
    this.exited = true;
    this.opts.log?.(`[${this.id}] the Qwen TUI exited`);
    this.failTurn("the Qwen terminal ended before the turn settled; inspect it before retrying");
    this.abortApprovals();
    delete this.state_.ownerPid; delete this.state_.ownerSignature; this.saveState();
    this.setState("offline");
    this.opts.onExit?.();
  }

  // ---- delivery ----------------------------------------------------------------------------------------------------

  private appendInput(record: Json): void {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > SUBMIT_CAP) throw new Error("Qwen submit exceeds its size bound");
    const fd = openSync(this.inputFile, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Qwen input file is not private");
      writeSync(fd, line);
    } finally { closeSync(fd); }
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle" || this.stopping || this.detached) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    let text = this.primed || !this.opts.preamble ? renderDigest(envs, this.primed) : `${this.opts.preamble}\n\n${renderDigest(envs, false)}`;
    // Qwen reads a submit like typed input: a leading `/` runs a slash command, `!` a shell line and `@` includes a file. Another agent's words must start with none of them.
    if (/^\s*[\/!@?]/.test(text)) text = `[agent-hub]\n${text}`;
    const turn: Turn = { envs, ...(deliveryId ? { deliveryId } : {}), text, started: false, accepted: false };
    this.turn = turn; this.owner = undefined; this.lastAssistant = undefined;
    this.setState("busy"); // synchronously: the bus must not drain the next envelope into this turn
    try { this.appendInput({ type: "submit", text }); }
    catch (error) {
      this.turn = undefined;
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: "Qwen input file could not be written" });
      this.setState("idle");
      throw error instanceof Error ? error : new Error("Qwen input file could not be written");
    }
    this.primed = true;
  }

  // ---- watchdog: report, never cancel -----------------------------------------------------------------------------------

  protected override onWatchdog(): void {
    if (this.state !== "busy" || this.stalled_) return;
    if (this.pending.size > 0) { this.touch(); return; } // a person deciding is not Qwen going silent
    this.stalled_ = true;
    this.opts.log?.(`[${this.id}] turn stalled; the hub cannot stop it (press Esc in the Qwen terminal)`);
    this.opts.onStalled?.(true);
    try { this.opts.onNotice?.(`${this.id}: ${QWEN_STALLED_NOTE}`); } catch { /* a notice failure changes nothing */ }
    // Still busy, still watching: the next event clears the stall and re-arms.
  }

  private alive(): void {
    if (this.stalled_) { this.stalled_ = false; this.opts.onStalled?.(false); }
    if (this.state === "busy") this.touch();
  }

  // ---- reading the event file ----------------------------------------------------------------------------------------------

  private detach(reason: string): void {
    if (this.detached) return;
    this.detached = true;
    this.opts.log?.(`[${this.id}] event file ${reason}: detached`);
    this.failTurn("the Qwen event file became unreadable before the turn settled; inspect the Qwen terminal before retrying");
    this.abortApprovals();
    if (this.state !== "offline") this.setState("offline"); // detached is never idle: nothing can be delivered to a TUI nobody can read
  }

  private poll(): void {
    if (this.stopping) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.eventFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile()) throw new Error("not a regular file");
      if (this.detached) { this.detached = false; this.pollFailures = 0; this.opts.log?.(`[${this.id}] event file readable again: reattached`); if (this.sessionSeen && this.state === "offline" && !this.exited) this.setState("idle"); }
      let offset = this.state_.offset;
      if (info.size < offset) { offset = 0; this.discarding = false; this.state_.generation++; this.opts.log?.(`[${this.id}] event file was replaced; reading from its start`); }
      while (offset < info.size) {
        const want = Math.min(info.size - offset, READ_CAP), buffer = Buffer.alloc(want);
        const got = readSync(fd, buffer, 0, want, offset);
        if (got <= 0) break;
        if (this.discarding) {
          // Inside a line longer than READ_CAP: drop it through its newline, and keep the position, so the events after it are read and a restart does not reread it.
          const newline = buffer.subarray(0, got).indexOf(10);
          offset += newline < 0 ? got : newline + 1;
          this.state_.offset = offset;
          if (newline >= 0) this.discarding = false;
          continue;
        }
        const end = buffer.subarray(0, got).lastIndexOf(10) + 1;
        if (end === 0) {
          if (got < READ_CAP) break;   // a partial line waits for its newline
          this.opts.log?.(`[${this.id}] dropped an event line over ${READ_CAP} bytes`);
          this.discarding = true; offset += got; this.state_.offset = offset; continue;
        }
        offset += end;
        this.state_.offset = offset;
        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) if (line.trim()) this.parse(line);
        if (this.stopping) break;
      }
      this.saveState();
    } catch (error) {
      this.pollFailures++;
      if (!this.detached) this.detach(`could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ } }
  }

  private parse(line: string): void {
    let event: Json;
    try { event = JSON.parse(line) as Json; } catch { this.opts.log?.(`[${this.id}] skipped an unreadable event line`); return; }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return;
    try { this.handle(event); } catch (error) { this.opts.log?.(`[${this.id}] event handling failed: ${sanitize((error as Error).message)}`); }
  }

  private handle(event: Json): void {
    this.alive();
    switch (event.type) {
      case "system": return this.onSystem(event);
      case "user": return this.onUser(event);
      case "assistant": return this.onAssistant(event);
      case "stream_event": if (event.event?.type === "message_stop") this.onMessageStop(); return;
      case "result": return this.onResult(event);
      case "control_request": return this.onControlRequest(event);
      case "control_response": return this.onControlResponse(event);
      default: return;
    }
  }

  private onSystem(event: Json): void {
    if (event.subtype !== "session_start") return;
    const data = event.data ?? {};
    const id = event.session_id ?? data.session_id;
    if (!qwenSessionId(id)) return;
    // The TUI states its own contract: a version, protocol or event set the hub did not verify is refused, however it was launched.
    const verdict = assessVersion("qwen-dual", data.version);
    const supported: unknown = data.supported_events;
    if (!verdict.ok || data.protocol_version !== 2 || !Array.isArray(supported) || !["user", "assistant", "stream_event", "control_request", "control_response"].every(name => supported.includes(name))) {
      this.opts.log?.(`[${this.id}] the Qwen TUI's dual-output contract is not verified; not attached`);
      try { this.opts.onNotice?.(`${this.id}: this Qwen's dual-output contract is not verified (${verdict.ok ? "protocol or event set" : verdict.reason}); the hub did not attach it`); } catch { /* notice only */ }
      return;
    }
    this.state_.sessionId = id; this.sessionSeen = true; this.saveState();
    // Bind the owner now, not on the next tick: a hub that stops in between would record no owner and relaunch over a Qwen that is still running.
    this.discoverOwner();
    if (!this.stopping && !this.detached && this.state === "offline") this.setState("idle");
  }

  /**
   * Judged on the raw event, not on `promptText`, which joins every text block and drops the rest: an event is Qwen's own notice only when its content is exactly one text block
   * and that block is wholly the strict envelope. A text split across blocks, or a block with anything else beside it (an image, a second text), is a person's prompt.
   */
  private isNotificationEvent(event: Json): boolean {
    const content = event.message?.content;
    if (!Array.isArray(content) || content.length !== 1) return false;
    const block = content[0];
    return !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string" && isQwenTaskNotification(block.text);
  }

  private promptText(event: Json): string | undefined {
    const content = event.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const blocks = content.filter((block: Json) => block?.type === "text" && typeof block.text === "string");
    return blocks.length ? blocks.map((block: Json) => block.text).join("") : undefined;
  }

  private onUser(event: Json): void {
    // Qwen's own background-shell notice (#517) is part of whatever turn is running and never the person typing, so it ends no hub turn and holds no queue. It changes nothing else:
    // an idle peer stays idle (Qwen may answer it or not, and a peer that waited for an answer that never comes would block its queue), and a running turn keeps its owner.
    if (this.isNotificationEvent(event)) return;
    const text = this.promptText(event);
    if (text === undefined) return; // a tool result echoed back, not a prompt
    const turn = this.turn;
    if (turn && !turn.started && (text.trim() === turn.text.trim() || text.trim().startsWith(turn.text.trim().slice(0, 200)))) {
      turn.started = true; this.owner = "hub"; this.lastAssistant = undefined;
      if (turn.deliveryId && !turn.accepted) { turn.accepted = true; this.delivery({ id: turn.deliveryId, state: "accepted" }); }
      return;
    }
    // A prompt that is not the hub's: the person typed in the TUI. If a hub turn was running, Qwen ended it without a word (Esc): settle it as uncertain.
    if (turn?.started) this.failTurn("the Qwen turn ended without a result (it was likely stopped in the terminal); inspect it before retrying", true);
    this.owner = "personal"; this.lastAssistant = undefined;
    if (this.state === "idle") this.setState("busy");
  }

  private onAssistant(event: Json): void {
    const content = event.message?.content;
    const blocks: Json[] = Array.isArray(content) ? content : [];
    const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text as string).join("");
    const toolUse = event.message?.stop_reason === "tool_use" || blocks.some(block => block?.type === "tool_use");
    this.lastAssistant = { text, toolUse };
  }

  private onMessageStop(): void {
    const last = this.lastAssistant; this.lastAssistant = undefined;
    if (!last || last.toolUse) return; // a model call that asked for a tool: the turn goes on
    this.endTurn(last.text);
  }

  private onResult(event: Json): void {
    const text = typeof event.result === "string" ? event.result : this.lastAssistant?.text ?? "";
    this.endTurn(text);
  }

  private endTurn(text: string): void {
    const turn = this.turn, owner = this.owner;
    this.owner = undefined; this.lastAssistant = undefined;
    this.abortApprovals();
    if (owner === "hub" && turn?.started) {
      this.turn = undefined;
      const body = text.trim();
      if (body) this.onMessage?.(body, { inReplyTo: replyParent(turn.envs), to: replyAudience(turn.envs) });
      if (turn.deliveryId) this.delivery({ id: turn.deliveryId, state: "completed" });
      this.stalled_ = false; this.opts.onStalled?.(false);
      this.setState("idle");
      return;
    }
    if (owner === "personal") { this.stalled_ = false; this.opts.onStalled?.(false); if (!this.turn) this.setState("idle"); }
  }

  /**
   * Settle the current hub turn without an answer. `notIdle`: the caller goes on to mark the peer busy itself. `known`: the outcome is certain (a person's deny, a refused request),
   * so the delivery completes. Anything uncertain stays `needs_review`, which holds the peer's whole queue until a person resolves it: a deny must not wedge Qwen that way.
   */
  private failTurn(reason: string, notIdle = false, known = false): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined; this.owner = undefined;
    if (turn.deliveryId) { const receipt: DeliveryReceipt = { id: turn.deliveryId, state: known ? "completed" : "needs_review", reason }; this.delivery(receipt); }
    try { this.opts.onNotice?.(`${this.id}: ${reason}`); } catch { /* notice only */ }
    if (this.stalled_) { this.stalled_ = false; this.opts.onStalled?.(false); }
    if (!notIdle && this.state === "busy") this.setState("idle");
  }

  // ---- approvals ------------------------------------------------------------------------------------------------------------

  private abortApprovals(): void {
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
  }

  private onControlRequest(event: Json): void {
    const requestId = event.request_id, request = event.request;
    if (typeof requestId !== "string" || !request || request.subtype !== "can_use_tool") return;
    const turn = this.turn;
    // Only a hub turn asks the hub. During the person's own turn the TUI prompt is theirs; asking the console too would be two prompts for one decision.
    if (!turn?.started || this.owner !== "hub" || this.stopping || this.state !== "busy") return;
    const name = typeof request.tool_name === "string" ? request.tool_name : "";
    const input = request.input ?? {};
    const hubTool = name !== "" && this.opts.autoApprove?.(name) === true;
    if (!hubTool && (qwenDualNamesStateDir({ input, path: request.blocked_path }, this.opts.guardDir ?? this.opts.stateDir))) {
      this.opts.log?.(`[${this.id}] approval refused: the call names the hub state dir`);
      return this.answer(requestId, false, turn, "a Qwen write or command that names the hub state dir was refused: the input file is a prompt channel");
    }
    let gate: { title: string; denyOnly?: true } | undefined;
    try { gate = this.state_.sessionId ? this.opts.actionGate?.({ names: [name], input }, this.state_.sessionId) : undefined; }
    catch { gate = { title: "Action approval: the always-ask check failed; command withheld", denyOnly: true }; }
    if (hubTool && !gate) { this.opts.log?.(`permission auto-approved for ${this.id}: ${name}`); return this.answer(requestId, true, turn); }
    const full = JSON.stringify(input), cut = full.length > 600;
    const title = gate ? gate.title : `${sanitize(name || "tool")}: ${cut ? `${full.slice(0, 600)} [cut, ${full.length} chars]` : full}`;
    const options = [...(gate?.denyOnly ? [] : [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }]), { optionId: "deny", name: "Deny", kind: "reject_once" as const }];
    const controller = new AbortController();
    this.pending.set(requestId, { controller, turn });
    const tool = /^[\w.:@-]{1,80}$/.test(name) ? name : undefined;
    void (async () => {
      let picked: string | undefined;
      try { picked = await this.opts.onPermission?.({ peer: this.id, title, options, ...(tool ? { tool } : {}), ...(gate ? { classed: true as const } : {}) }, controller.signal); }
      catch { picked = undefined; }
      const still = this.pending.get(requestId);
      if (!still || still.controller !== controller || controller.signal.aborted || this.turn !== turn || this.stopping) return; // answered in the TUI, or the turn is gone
      this.pending.delete(requestId);
      this.answer(requestId, picked === "allow" && options.some(option => option.optionId === "allow"), turn);
    })();
  }

  private answer(requestId: string, allowed: boolean, turn: Turn, why?: string): void {
    try { this.appendInput({ type: "confirmation_response", request_id: requestId, allowed }); }
    catch {
      // Qwen never received it: it is still blocked on the approval. Settling the turn (a deny) or reporting it answered would be a claim the hub cannot back, so the turn stays busy
      // (the watchdog reports it if nothing moves) and the person is told to answer in the Qwen terminal, where the prompt is still open.
      this.opts.log?.(`[${this.id}] could not write an approval answer`);
      try { this.opts.onNotice?.(`${this.id}: the hub could not write its approval answer (the input file is unwritable); answer the prompt in the Qwen terminal`); } catch { /* notice only */ }
      return;
    }
    this.answered.add(requestId); while (this.answered.size > ANSWERED_CAP) this.answered.delete(this.answered.values().next().value as string);
    if (allowed || this.turn !== turn) return;
    // Limit 1: a deny cancels Qwen's whole turn and Qwen emits nothing for it. The turn ends here, with no answer shared.
    this.owner = undefined;
    this.abortApprovals();
    this.failTurn(why ?? "a hub deny cancelled the Qwen turn (Qwen emits nothing for it); the turn ended without an answer", false, true);
  }

  private onControlResponse(event: Json): void {
    const response = event.response;
    const id = response?.request_id;
    if (typeof id !== "string") return;
    if (response.subtype === "error") { this.opts.log?.(`[${this.id}] Qwen refused an approval answer (stale or unknown request); not retried`); return; }
    const waiting = this.pending.get(id);
    if (waiting && !this.answered.has(id)) {
      // The person answered in the TUI before the hub did: withdraw the hub's approval, whose late answer must find nothing to grant.
      this.pending.delete(id); waiting.controller.abort();
      this.opts.log?.(`[${this.id}] an approval was answered in the Qwen terminal; the hub's was withdrawn`);
    }
  }

  // ---- teardown ------------------------------------------------------------------------------------------------------------------

  async stop(reason?: string): Promise<void> {
    if (reason !== undefined) this.requestedStopReason = reason;
    this.stopping = true;
    if (this.poller) clearInterval(this.poller); this.poller = undefined;
    if (this.monitor) clearInterval(this.monitor); this.monitor = undefined;
    this.abortApprovals();
    const turn = this.turn; this.turn = undefined; this.owner = undefined;
    if (turn?.deliveryId) this.delivery({ id: turn.deliveryId, state: "needs_review", reason: reason ?? "Qwen session stopped before settlement" });
    this.saveState();
    this.setState("offline");
    // The person's Qwen is never signalled: it belongs to their terminal.
  }
}

export function isQwenDualPeer(value: unknown): value is QwenDualPeer { return value instanceof QwenDualPeer; }
