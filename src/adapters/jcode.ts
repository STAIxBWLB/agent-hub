import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { assessVersion, COMPAT, type CompatVerdict } from "./compat.ts";
import { createConnection } from "node:net";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { renderDigest, type Envelope, type PeerState } from "../hub/envelope.ts";
import { AcpPeer, type AcpOptions } from "./acp.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";

export interface JcodeOptions extends Omit<AcpOptions, "cmd" | "qwen025" | "expectedAgent" | "mcpServers" | "permissionMode"> {
  command: string[];
  home: string;
  providerProfile?: string;
  /** How long a native steer may take to be acknowledged (#572); default 5 s. */
  steerTimeoutMs?: number;
}
export function jcodeCommand(command: string[], kind: "serve" | "acp", socket: string, cwd: string, model?: string, profile?: string): string[] {
  if (!command.length || command.some(word => typeof word !== "string" || !word)) throw new Error("jcode_cmd must name an executable argv");
  return [...command, kind, "--socket", socket, "--cwd", cwd, "--no-update", "--no-selfdev", ...(model ? ["--model", model] : []), ...(profile ? ["--provider-profile", profile] : []),
    ...(kind === "serve" ? ["--temporary-server", "--owner-pid", String(process.pid), "--server-name", "agent-hub-jcode"] : ["--mcp-tools", "eager"])];
}
export interface JcodeTuiBinding { launchId: string; sessionId: string }
export type JcodeTuiState = { state: "waiting"; binding: JcodeTuiBinding } |
  { state: "ready"; binding: JcodeTuiBinding; launch: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } };

export function jcodeTuiCommand(command: string[], socket: string, sessionId: string, model?: string, profile?: string): string[] {
  if (!command.length || command.some(word => typeof word !== "string" || !word)) throw new Error("jcode_cmd must name an executable argv");
  return [...command, "--socket", socket, "--resume", sessionId, "--no-update", "--no-selfdev",
    ...(model ? ["--model", model] : []), ...(profile ? ["--provider-profile", profile] : [])];
}

/** Read native persistence only. Never synthesize a native session or send a save-inducing prompt. */
function savedSession(home: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid native session identity");
  const directory = join(home, "sessions"), info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe native session directory");
  const file = join(directory, `${id}.json`), entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe native session proof");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const before = fstatSync(fd);
    // ponytail: bound native persistence proof to 32 MiB; larger conversations need a native saved-session API.
    if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 * 1024) throw new Error("unsafe native session proof");
    if (!before.size) return false;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) return false; offset += n; }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    let data: unknown;
    try { data = JSON.parse(bytes.toString("utf8")); } catch { return false; }
    if (!data || typeof data !== "object" || (data as { id?: unknown }).id !== id || !Array.isArray((data as { messages?: unknown }).messages)) throw new Error("native saved session identity is unproven");
    return true;
  } finally { closeSync(fd); }
}

/** Set on every owned jcode process: no Claude MCP import, and no native telemetry (jcode-telemetry-core is_enabled, #529). */
/** A TUI launch option that differs from the running owned session; carries the flag name only. */
export class JcodeOptionMismatch extends Error {
  constructor(readonly option: "--session-id" | "--model" | "--provider-profile") { super("Jcode launch options differ from its running session"); }
}
const JCODE_OWNED_ENV = { JCODE_DISABLE_CLAUDE_MCP: "1", JCODE_NO_TELEMETRY: "1" } as const;
/** #691: the verdict lives in `src/adapters/compat.ts` (line, verified versions, the person's trust); never pin here. */
export const jcodeVersionSupported = (version: unknown): boolean => assessVersion("jcode", version).ok;

/** A native steer the server did not take, with nothing sent: the message may safely stay queued. */
class SteerRefused extends Error {}
/** A native steer that was sent but not acknowledged: it may have gone in, so it is never requeued as if it had not. */
class SteerUncertain extends Error {}
const STEER_TIMEOUT_MS = 5000;

/**
 * #572 AC1: a second client on the hub's own private server socket queues a soft interrupt into the running session
 * (jcode injects it at the next tool boundary, or when a text-only turn ends). Established on 0.99.0 under an isolated
 * home: ping lists `soft_interrupt_ids`, subscribe with `target_session_id` joins the same session without a new one,
 * `state` says whether a turn runs, and the injection survives this client's disconnect. Nothing here cancels the turn.
 * `canSend` runs immediately before the soft interrupt is written and names why the hub no longer wants it sent. What
 * cannot be closed from here is the native side: the server's `state` reply is a snapshot, so a turn that ends and
 * another that begins inside the server between its reply and the write still receives the message. Such a steer is
 * acknowledged, adopted by nobody, and held for review; an upstream atomic "steer turn N" request would remove it.
 */
function nativeSteer(socket: string, cwd: string, sessionId: string, text: string, clientId: string, timeoutMs = STEER_TIMEOUT_MS, canSend: () => string | undefined = () => undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const conn = createConnection(socket);
    let phase: "ping" | "subscribe" | "state" | "sent" = "ping", buffer = "", finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); conn.destroy();
      if (error) reject(error); else resolve();
    };
    const fail = (why: string) => finish(phase === "sent" ? new SteerUncertain(`Jcode steering outcome is uncertain: ${why}`) : new SteerRefused(`Jcode owned server cannot take a steer: ${why}`));
    const timer = setTimeout(() => fail(`no answer in the ${phase} step`), timeoutMs);
    const send = (value: Record<string, unknown>) => conn.write(`${JSON.stringify(value)}\n`);
    conn.once("error", () => fail("connection failed"));
    conn.once("close", () => fail("connection closed"));
    conn.once("connect", () => send({ type: "ping", id: 1 }));
    conn.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return fail("oversized reply");
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        let msg: { type?: unknown; id?: unknown; capabilities?: unknown; session_id?: unknown; is_processing?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "error" && typeof msg.id === "number" && msg.id >= 1) return fail("the server refused a request");
        if (phase === "ping" && msg.type === "pong" && msg.id === 1) {
          if (!Array.isArray(msg.capabilities) || !msg.capabilities.includes("soft_interrupt_ids")) return fail("no soft interrupt support");
          phase = "subscribe"; send({ type: "subscribe", id: 2, working_dir: cwd, target_session_id: sessionId, continue_on_disconnect: true });
        } else if (phase === "subscribe" && msg.type === "session") {
          if (msg.session_id !== sessionId) return fail("the server answered for another session");
          phase = "state"; send({ type: "state", id: 3 });
        } else if (phase === "state" && msg.type === "state" && msg.id === 3) {
          if (msg.session_id !== sessionId || msg.is_processing !== true) return fail("the session has no running turn");
          // The last check before anything is sent (review round 2 I1): the hub's own turn, launch, session and stop state may
          // have changed during the connect, ping, subscribe and state round trips. Past this write the server may have taken
          // the message, so it is never refused as unsent again.
          const changed = canSend();
          if (changed) return fail(changed);
          phase = "sent"; send({ type: "soft_interrupt", id: 4, content: text, urgent: false, client_id: clientId });
        } else if (phase === "sent" && msg.type === "ack" && msg.id === 4) finish();
      }
    });
  });
}

/** The wrapper contract preserves every configured prefix argument before the native probe. */
export function jcodeVersion(command: string[], cwd: string): CompatVerdict {
  const [bin, ...prefix] = command;
  if (!bin) return assessVersion("jcode", undefined);
  try {
    const result = spawnSync(bin, [...prefix, "--quiet", "version", "--json"], { cwd, env: { ...peerChildEnv("jcode"), ...JCODE_OWNED_ENV }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    return assessVersion("jcode", result.status === 0 ? COMPAT.jcode.parse(result.stdout) : undefined);
  } catch { return assessVersion("jcode", undefined); }
}
export const verifiedJcodeCommand = (command: string[], cwd: string): boolean => jcodeVersion(command, cwd).ok;
/** Collects at most `cap` bytes; the chunk that would pass it, and every later one, is refused and not kept. */
export function boundedOutput(cap: number): { push(chunk: Buffer): boolean; text(): string; readonly size: number; readonly overflowed: boolean } {
  const chunks: Buffer[] = [];
  let size = 0, overflowed = false;
  return {
    push(chunk) { if (overflowed || size + chunk.length > cap) { overflowed = true; return false; } chunks.push(chunk); size += chunk.length; return true; },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get size() { return size; },
    get overflowed() { return overflowed; },
  };
}
/**
 * The daemon's preflight: the same probe without blocking the event loop (a slow wrapper must not stall peers). The probe owns its
 * process group: at the deadline, or once stdout passes 64 KiB, the whole group is stopped, descendants included (kimi-review's pattern).
 */
export function jcodeVersionAsync(command: string[], cwd: string, timeoutMs = 10_000): Promise<CompatVerdict> {
  const [bin, ...prefix] = command;
  if (!bin) return Promise.resolve(assessVersion("jcode", undefined));
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(bin, [...prefix, "--quiet", "version", "--json"], { cwd, env: { ...peerChildEnv("jcode"), ...JCODE_OWNED_ENV }, detached: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(assessVersion("jcode", undefined)); return; }
    const output = boundedOutput(64 * 1024);
    let done = false;
    const finish = async (code: number | null) => {
      if (done) return; done = true; clearTimeout(timer);
      try { await stopOwnedProcess(child, { group: true }); } catch { resolve(assessVersion("jcode", undefined)); return; }
      resolve(assessVersion("jcode", code === 0 && !output.overflowed ? COMPAT.jcode.parse(output.text()) : undefined));
    };
    const timer = setTimeout(() => { void finish(null); }, timeoutMs);
    child.once("spawn", () => trackGroup(child));
    // Chunks after the cap or after settling are drained and discarded, never buffered.
    child.stdout!.on("data", (bytes: Buffer) => { if (!done && !output.push(bytes)) void finish(null); });
    child.once("error", () => { void finish(null); });
    child.once("close", code => { void finish(code); });
  });
}

/** Both processes are ours. The user's global daemon and its sockets are never stopped. */
export class JcodePeer extends AcpPeer {
  private readonly launchId = crypto.randomUUID();
  private socketIdentity: { dev: number; ino: number } | undefined;
  private readonly root: string;
  private readonly socket: string;
  private server: ChildProcess | undefined;
  private ending = false;
  private preserveRoot = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly jcode: JcodeOptions) {
    if (!isAbsolute(jcode.home)) throw new Error("jcode_home must be an absolute native data path");
    jcodeCommand(jcode.command, "acp", "preview", jcode.cwd);
    // The name must end in ".sock": jcode names its debug socket by replacing that suffix, so "s" binds one path twice.
    const root = mkdtempSync(join(tmpdir(), "ahub-jcode-")), socket = join(root, "j.sock");
    const cmd = jcodeCommand(jcode.command, "acp", socket, jcode.cwd, jcode.launchModel, jcode.providerProfile);
    super("jcode", { ...jcode, cmd, env: { ...jcode.env, JCODE_HOME: jcode.home, JCODE_SOCKET: socket, ...JCODE_OWNED_ENV }, mcpServers: [], requireLoadSessionEcho: true, expectedAgent: { name: "jcode", version: jcodeVersionSupported } });
    this.root = root; this.socket = socket;
  }

  override async start(): Promise<void> {
    // The native loader otherwise imports Codex MCP into the user's store on first use.
    if (!existsSync(join(this.jcode.home, "mcp.json"))) throw new Error("initialize Jcode's global MCP store with its native client before enabling this peer; the hub never initializes or copies it");
    if (existsSync(this.socket)) { this.preserveRoot = true; throw new Error("Jcode private socket is occupied; no daemon was adopted or removed"); }
    this.ending = false;
    const [bin, ...args] = jcodeCommand(this.jcode.command, "serve", this.socket, this.jcode.cwd, this.jcode.launchModel, this.jcode.providerProfile);
    const server = spawn(bin!, args, { cwd: this.jcode.cwd, detached: true, env: { ...peerChildEnv("jcode"), JCODE_HOME: this.jcode.home, JCODE_SOCKET: this.socket, JCODE_READY_FD: "3", ...JCODE_OWNED_ENV }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    this.server = server; trackGroup(server);
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = server.stdio[3] as Readable;
        const timer = setTimeout(() => reject(new Error("Jcode owned daemon did not become ready within 30 s")), 30_000);
        const fail = () => { clearTimeout(timer); reject(new Error("Jcode owned daemon exited before readiness; details withheld")); };
        server.once("error", fail); server.once("exit", fail);
        ready.once("data", () => { clearTimeout(timer); server.off("exit", fail); if (lstatSync(this.socket, { throwIfNoEntry: false })?.isSocket()) resolve(); else reject(new Error("Jcode readiness has no private socket")); });
      });
      server.once("exit", () => { if (!this.ending && this.server === server) void this.stop("Jcode owned daemon disconnected").catch(() => {}); });
      const identity = lstatSync(this.socket);
      this.socketIdentity = { dev: identity.dev, ino: identity.ino };
      await super.start();
    } catch (error) { await this.stop().catch(() => {}); throw error; }
  }

  protected override setState(next: PeerState): void {
    if (next === "offline" && this.server) {
      // A removed socket is not process-exit proof. Retain a non-ready state until both owned groups settle.
      if (!this.ending) { super.setState("busy"); void this.stop("Jcode ACP transport ended").catch(() => {}); }
      return;
    }
    super.setState(next);
  }
  override async stop(reason?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.end(reason); this.stopPromise = pending;
    try { await pending; } finally { if (this.stopPromise === pending) this.stopPromise = undefined; }
  }
  private async end(reason?: string): Promise<void> {
    this.ending = true;
    if (this.server && this.state !== "offline") super.setState("busy");
    let failure: unknown;
    try { await super.stop(reason); } catch (error) { failure = error; }
    try {
      if (this.server) {
        const server = this.server;
        const closed = server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => server.once("close", () => resolve()));
        await stopOwnedProcess(server, { group: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Jcode child exit is not confirmed; runtime retained")), 3000); })]);
        } finally { clearTimeout(timer); }
        if (this.server === server) this.server = undefined;
      }
    } catch (error) { failure ??= error; }
    if (!failure && !this.server) {
      if (!this.preserveRoot) rmSync(this.root, { recursive: true, force: true });
      super.setState("offline");
    }
    if (failure) throw failure;
  }
  /**
   * #572 AC1: an `important` message to a busy Jcode goes into its running turn through its own server (a soft
   * interrupt), with the receipt contract of Codex's steer: `failed_safe` when nothing was sent, `needs_review` when it
   * may have gone in, `accepted` once the server acknowledged it, and `completed` when the turn ends normally.
   * The hub never cancels the turn to deliver.
   */
  async steer(envs: Envelope[], deliveryId?: string): Promise<void> {
    const refuse = (reason: string): never => {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason });
      throw new Error(reason);
    };
    const sessionId = super.recoveryMetadata().sessionId;
    const socket = lstatSync(this.socket, { throwIfNoEntry: false });
    if (this.state !== "busy") refuse(`jcode is ${this.state}`);
    if (this.ending || !this.server || this.server.exitCode !== null || this.server.signalCode !== null ||
      !socket?.isSocket() || socket.dev !== this.socketIdentity?.dev || socket.ino !== this.socketIdentity.ino || typeof sessionId !== "string") refuse("owned Jcode server is unavailable");
    // The turn this steer is for. The native acknowledgement is asynchronous: only this exact turn may take the message.
    const turn = this.currentTurn(), launch = this.server!, identity = this.socketIdentity; // both proven present above
    const stillCurrent = (): string | undefined => {
      if (this.currentTurn() !== turn || this.state !== "busy") return `jcode's turn changed before the steer was sent (${this.state})`;
      if (this.ending || this.server !== launch || launch.exitCode !== null || launch.signalCode !== null || this.socketIdentity !== identity) return "owned Jcode server changed before the steer was sent";
      if (super.recoveryMetadata().sessionId !== sessionId) return "jcode's session changed before the steer was sent";
      const now = lstatSync(this.socket, { throwIfNoEntry: false });
      if (!now?.isSocket() || now.dev !== identity?.dev || now.ino !== identity.ino) return "owned Jcode socket changed before the steer was sent";
      return undefined;
    };
    try { await nativeSteer(this.socket, this.jcode.cwd, sessionId as string, renderDigest(envs, true), deliveryId ?? crypto.randomUUID(), this.jcode.steerTimeoutMs, stillCurrent); }
    catch (error) {
      if (error instanceof SteerUncertain) {
        if (deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: "steering outcome is uncertain" });
        throw error;
      }
      return refuse(error instanceof Error ? error.message : "Jcode steer failed");
    }
    // The turn may have ended, or another begun, while the server answered: it did take the message, so it is held for review, never refused as unsent and never adopted into a different turn.
    try { this.adoptIntoTurn(turn, envs, deliveryId); }
    catch { if (deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: "steered turn ended before its receipt" }); throw new SteerUncertain("Jcode steering outcome is uncertain: its turn ended first"); }
  }
  tuiLaunch(expected?: JcodeTuiBinding, options: { model?: string; providerProfile?: string; sessionId?: string } = {}): JcodeTuiState {
    const sessionId = super.recoveryMetadata().sessionId;
    const socket = lstatSync(this.socket, { throwIfNoEntry: false });
    if (this.ending || !this.server || this.server.exitCode !== null || this.server.signalCode !== null || this.state === "offline" ||
      !socket?.isSocket() || socket.dev !== this.socketIdentity?.dev || socket.ino !== this.socketIdentity.ino || typeof sessionId !== "string") throw new Error("owned Jcode launch is unavailable");
    const binding = { launchId: this.launchId, sessionId };
    if (expected && (expected.launchId !== binding.launchId || expected.sessionId !== binding.sessionId)) throw new Error("Jcode launch changed");
    // Names the option, never its value: the flag is the person's own and carries nothing private (#559).
    const differs = options.sessionId !== undefined && options.sessionId !== sessionId ? "--session-id"
      : options.model !== undefined && options.model !== this.jcode.launchModel ? "--model"
      : options.providerProfile !== undefined && options.providerProfile !== this.jcode.providerProfile ? "--provider-profile" : undefined;
    if (differs) throw new JcodeOptionMismatch(differs);
    if (!savedSession(this.jcode.home, sessionId)) return { state: "waiting", binding };
    const [cmd, ...args] = jcodeTuiCommand(this.jcode.command, this.socket, sessionId, this.jcode.launchModel, this.jcode.providerProfile);
    return { state: "ready", binding, launch: { cmd: cmd!, args, env: { JCODE_HOME: this.jcode.home, JCODE_SOCKET: this.socket, ...JCODE_OWNED_ENV } } };
  }
  override recoveryMetadata(): Record<string, unknown> {
    return { ...super.recoveryMetadata(), launch: { kind: "jcode", peer: "jcode", mode: "headless", ...(this.jcode.launchModel ? { model: this.jcode.launchModel } : {}), ...(this.jcode.providerProfile ? { providerProfile: this.jcode.providerProfile } : {}) } };
  }
}

export function isJcodePeer(value: unknown): value is JcodePeer {
  return value instanceof JcodePeer;
}
