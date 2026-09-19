import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { renderDigest, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import { stopOwnedProcess } from "../hub/child-process.ts";

export interface PiModelDescriptor { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; }
export interface PiToolSchema { name: string; description?: string; parameters: Record<string, unknown>; }
export interface PiRelay { url: string; token: string; models: PiModelDescriptor[]; }
export interface PiOptions {
  cwd: string; stateDir: string; cmd?: string[]; mode: "headless" | "tui"; backend: "auto" | "dgx" | "mlx"; sessionFile?: string; sessionId?: string;
  model?: string;
  relay: PiRelay; executeTool: (name: string, args: unknown, toolCallId: string, sessionId?: string) => Promise<string>; tools: PiToolSchema[];
  preamble?: string;
  selectModel?: (envs: Envelope[]) => Promise<string | undefined>; maxSteps?: number;
  onTurnFailure?: (envs: Envelope[], reason: string) => Promise<void>;
  watchdogMs?: number; log?: (line: string) => void;
}
export interface PiTuiLaunch { cmd: string; args: string[]; env: NodeJS.ProcessEnv; }
type RpcMessage = { type?: string; id?: string | number; command?: string; success?: boolean; data?: any; [key: string]: any };
type VerifiedEmptyResume = { sessionId: string };
function processSignature(pid: number): string | undefined { try { const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=,comm="], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) return undefined; const text = result.stdout.toString().trim(); return text ? new Bun.CryptoHasher("sha256").update(text).digest("hex") : undefined; } catch { return undefined; } }
function ownerStillAlive(pid: number, signature: string | undefined): boolean { const current = processSignature(pid); if (current !== undefined) return current === signature; try { process.kill(pid, 0); return true; } catch { return false; } }

const modelFor = (backend: PiOptions["backend"], models: PiModelDescriptor[]): string => {
  const ids = models.map((m) => m.id);
  const find = (needle: string) => ids.find((id) => id === needle) ?? needle;
  if (backend === "mlx") return find("mlx/fast");
  if (backend === "dgx") return find("dgx/coding");
  return find(ids.find((id) => id === "dgx/coding") ? "dgx/coding" : ids.find((id) => id === "mlx/fast") ?? "dgx/coding");
};

export class PiPeer extends BasePeer {
  private proc?: ChildProcessWithoutNullStreams;
  private server?: ReturnType<typeof Bun.serve>;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  private settledText = "";
  private settledError = "";
  private settledCancelled = false;
  private currentReply?: Envelope;
  private sessionId = "";
  private sessionFile = "";
  private emptyResumeVerified = false;
  private verifiedEmptyResume?: VerifiedEmptyResume;
  private activityObserved = false;
  private persistedOnce = false;
  private activeEnvs: Envelope[] = [];
  private activeTools = 0;
  private agentRunning = false;
  private owner = randomUUID();
  private _tuiLaunch?: PiTuiLaunch;
  private requestedModel = "";
  private starting?: Promise<void>;
  private ownerClaimed = false;
  private ownerToken = "";
  private stopping = true;
  private ownerPid?: number;
  private ownerSignature?: string;
  private ownerMonitor?: ReturnType<typeof setInterval>;
  private tuiExit?: Promise<void>;
  private resolveTuiExit?: () => void;
  private tuiCommands = new Map<string, { command: Record<string, unknown>; resolve: (value: any) => void; reject: (error: Error) => void }>();
  private tuiQueue: Record<string, unknown>[] = [];
  private tuiWaiters: Array<{ resolve: (command: Record<string, unknown> | undefined) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(id: PeerId, private readonly opts: PiOptions) { super(id, opts.watchdogMs); }
  get tuiLaunch(): PiTuiLaunch | undefined { return this._tuiLaunch; }
  get pendingResume(): { sessionId?: string; sessionFile?: string } {
    if (this.canReuseVerifiedEmptyResume()) return { sessionId: this.verifiedEmptyResume!.sessionId };
    return { sessionId: this.opts.sessionId, sessionFile: this.opts.sessionFile };
  }
  get acceptingTools(): boolean { return !this.stopping; }
  /** Idle verified owners can be stopped; uncertain live owners and pending launches stay fenced. */
  get recoveryReady(): boolean {
    if (this.state === "busy" || this.starting || this.activeTools) return false;
    if (this.sessionFile && !existsSync(this.sessionFile) && (this.activityObserved || this.persistedOnce)) return false;
    if (this.opts.mode === "headless") return this.state === "idle" || !this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null;
    if (this.state === "idle") return this.ownerClaimed && !!this.ownerPid && processSignature(this.ownerPid) === this.ownerSignature;
    return this.stopping && !this.ownerClaimed && (!this.ownerPid || !ownerStillAlive(this.ownerPid, this.ownerSignature));
  }
  recoveryMetadata(): Record<string, unknown> {
    const exists = !!this.sessionFile && existsSync(this.sessionFile);
    if (exists) { this.persistedOnce = true; this.verifiedEmptyResume = undefined; }
    const empty = this.emptyResumeVerified && !this.activityObserved && !this.persistedOnce;
    const file = this.sessionFile && (exists || !empty) ? this.sessionFile : undefined;
    return { launch: { kind: "pi", cwd: this.opts.cwd, mode: this.opts.mode, backend: this.opts.backend, ...(this.opts.model ? { model: this.opts.model } : {}), ...(file ? { sessionFile: file } : {}) }, ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(file ? { sessionFile: file } : {}) };
  }

  /** Verify the live source before choosing ID-only restoration. Never infer emptiness from a missing file. */
  async captureResume(): Promise<Record<string, unknown>> {
    if (this.state === "offline") {
      if (this.canReuseVerifiedEmptyResume()) return this.recoveryMetadata();
      if (this.recoveryReady && this.sessionFile && existsSync(this.sessionFile)) return this.recoveryMetadata();
      throw new Error("Pi source session is offline and has no verified persisted resume state");
    }
    this.emptyResumeVerified = false;
    if (this.state !== "idle" || this.stopping || this.activeTools) throw new Error("Pi must settle before session capture");
    if (this.sessionFile && existsSync(this.sessionFile)) return this.recoveryMetadata();
    const snapshot = this.opts.mode === "headless"
      ? (await this.waitRpc("get_state", 15_000)).data
      : await this.sendTui({ type: "get_session_state" });
    if (this.state !== "idle" || this.activeTools || snapshot?.sessionId !== this.sessionId || snapshot?.sessionFile !== this.sessionFile) throw new Error("Pi source session changed during capture");
    const empty = this.opts.mode === "headless"
      ? snapshot.messageCount === 0 && snapshot.pendingMessageCount === 0 && snapshot.isStreaming === false && snapshot.isCompacting !== true && !snapshot.sessionName
      : snapshot.empty === true && snapshot.idle === true;
    if (!empty || this.activityObserved || this.persistedOnce) throw new Error("Pi session history is not persisted; refusing to recreate it");
    this.emptyResumeVerified = true;
    const captured = this.recoveryMetadata();
    if (typeof captured.sessionId === "string" && !captured.sessionFile) this.verifiedEmptyResume = { sessionId: captured.sessionId };
    return captured;
  }

  private canReuseVerifiedEmptyResume(): boolean {
    return !!this.verifiedEmptyResume && this.recoveryReady && !this.activityObserved && !this.persistedOnce && this.sessionId === this.verifiedEmptyResume.sessionId && (!this.sessionFile || !existsSync(this.sessionFile));
  }

  private noteActivity(): void {
    this.activityObserved = true;
    this.emptyResumeVerified = false;
    this.verifiedEmptyResume = undefined;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startImpl();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async startImpl(): Promise<void> {
    this.stopping = false;
    mkdirSync(this.opts.stateDir, { recursive: true });
    const sessions = join(this.opts.stateDir, "pi-sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    if (this.opts.sessionFile) {
      const file = realpathSync(this.opts.sessionFile);
      const rel = relative(realpathSync(sessions), file);
      if (!rel || rel.startsWith("..") || resolve(realpathSync(sessions), rel) !== file) throw new Error("Pi session file is outside the managed project session directory");
      const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!);
      if (header.type !== "session" || typeof header.cwd !== "string" || realpathSync(header.cwd) !== realpathSync(this.opts.cwd) || (this.opts.sessionId && header.id !== this.opts.sessionId)) throw new Error("Pi session header does not match the requested project/session");
    }
    const token = randomUUID();
    this.tuiExit = new Promise((resolvePromise) => { this.resolveTuiExit = resolvePromise; });
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, maxRequestBodySize: 2_000_000, fetch: async (request) => {
      const origin = request.headers.get("origin"); if (origin) return new Response("forbidden", { status: 403 });
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("forbidden", { status: 403 });
      const url = new URL(request.url);
      if (url.pathname === "/commands" && request.method === "GET") {
        const command = await this.nextTuiCommand(25_000);
        return Response.json(command ? { command } : { command: null });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = await request.json() as any;
      if (url.pathname === "/event") { if (body.type === "session_start" && this.stopping) return Response.json({ ok: false, error: "Pi launch has ended" }, { status: 409 }); if (body.type === "session_start" && (typeof body.sessionId !== "string" || !body.sessionId || typeof body.sessionFile !== "string" || !body.sessionFile)) return Response.json({ ok: false, error: "Pi session identity is missing" }, { status: 400 }); if (body.type === "session_start" && this.ownerClaimed && (body.ownerToken !== this.ownerToken || body.pid !== this.ownerPid || body.signature !== this.ownerSignature || (this.sessionId && body.sessionId !== this.sessionId) || (this.sessionFile && body.sessionFile !== this.sessionFile))) return Response.json({ ok: false, error: "Pi session owner or identity already claimed" }, { status: 409 }); if (body.type === "session_start" && (!Number.isInteger(body.pid) || !body.signature || processSignature(body.pid) !== body.signature)) return Response.json({ ok: false, error: "Pi process identity is not verified" }, { status: 409 }); this.handleBridgeEvent(body); return Response.json({ ok: true }); }
      if (url.pathname === "/ack") {
        const pending = this.tuiCommands.get(String(body.id));
        if (!pending) return Response.json({ ok: false }, { status: 404 });
        this.tuiCommands.delete(String(body.id)); body.ok ? pending.resolve(body.result) : pending.reject(new Error(String(body.error ?? "Pi TUI command failed")));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/tool") {
        if (this.stopping || this.state === "offline") return Response.json({ text: "error: Pi owner is stopped" }, { status: 409 });
        this.noteActivity();
        this.activeTools++;
        if (this.state === "idle") this.setState("busy");
        if (this.state === "busy") this.touch();
        try { return Response.json({ text: await this.opts.executeTool(String(body.name), body.args, String(body.toolCallId ?? ""), this.sessionId) }); }
        catch (error) { return Response.json({ text: `error: ${(error as Error).message}` }, { status: 200 }); }
        finally {
          this.activeTools--;
          if (this.state === "busy") {
            if (!this.activeTools && !this.agentRunning && !this.activeEnvs.length) this.setState("idle");
            else this.touch();
          }
        }
      }
      return new Response("not found", { status: 404 });
    } });
    this.server = bridge;
    const extension = resolve(join(import.meta.dir, "../pi/extension.ts"));
    const inherited: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TERM", "TERM_PROGRAM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "CODEX_HOME"]) if (process.env[key]) inherited[key] = process.env[key];
    const env: NodeJS.ProcessEnv = { ...inherited, PI_CODING_AGENT_DIR: join(this.opts.stateDir, "pi"), AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`, AGENTHUB_PI_BRIDGE_TOKEN: token, AGENTHUB_PI_OWNER_TOKEN: token, AGENTHUB_PI_RELAY_URL: this.opts.relay.url, AGENTHUB_PI_RELAY_TOKEN: this.opts.relay.token, AGENTHUB_PI_MODELS: JSON.stringify(this.opts.relay.models), AGENTHUB_PI_TOOLS: JSON.stringify(this.opts.tools), AGENTHUB_PI_MAX_STEPS: String(this.opts.maxSteps ?? 30) };
    const args = [ ...(this.opts.mode === "headless" ? ["--mode", "rpc"] : []), "--provider", "agent-hub-local", "--model", this.opts.model ?? modelFor(this.opts.backend, this.opts.relay.models), "--models", this.opts.relay.models.map((model) => `agent-hub-local/${model.id}`).join(","), "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-extensions", "--extension", extension, ...(this.opts.preamble ? ["--append-system-prompt", this.opts.preamble] : []), "--session-dir", join(this.opts.stateDir, "pi-sessions")];
    if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile); else if (this.opts.sessionId) args.push("--session-id", this.opts.sessionId);
    const command = this.opts.cmd ?? ["pi"];
    this._tuiLaunch = { cmd: command[0]!, args: [...command.slice(1), ...args], env };
    if (this.opts.mode === "tui") { return; }
    this.proc = spawn(command[0]!, [...command.slice(1), ...args], { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (chunk) => this.onOutput(String(chunk)));
    this.proc.stderr.on("data", (chunk) => this.opts.log?.(`[${this.id}] ${String(chunk).trimEnd()}`));
    this.proc.on("error", (error) => this.fail(error));
    this.proc.on("exit", (code) => { if (code !== 0) this.fail(new Error(`pi exited with code ${code}`)); else this.setState("offline"); });
    const state = await this.waitRpc("get_state", 15_000);
    if (state.success !== true || typeof state.data?.sessionId !== "string" || typeof state.data?.sessionFile !== "string" || !state.data.sessionId || !state.data.sessionFile) throw new Error("Pi get_state did not prove session identity");
    if ((this.opts.sessionId && state.data.sessionId !== this.opts.sessionId) || (this.opts.sessionFile && state.data.sessionFile !== this.opts.sessionFile)) {
      throw new Error("Pi get_state session identity does not match the requested recovery session");
    }
    this.sessionId = state.data.sessionId; this.sessionFile = state.data.sessionFile;
    this.persistedOnce = existsSync(this.sessionFile);
    if ((this.opts.sessionId && this.sessionId !== this.opts.sessionId) || (this.opts.sessionFile && this.sessionFile !== this.opts.sessionFile)) throw new Error("Pi startup session identity mismatch");
    this.setState("idle");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearOwnerMonitor();
    if (this.opts.mode === "tui") {
      const alive = () => !!this.ownerPid && ownerStillAlive(this.ownerPid, this.ownerSignature);
      if (this.ownerClaimed && alive()) {
        try {
          await Promise.race([this.sendTui({ type: "shutdown" }), (async () => {
            const deadline = Date.now() + 5_000;
            while (alive() && Date.now() < deadline) await Bun.sleep(50);
            if (alive()) throw new Error("Pi TUI shutdown was not acknowledged");
          })()]);
        }
        catch (error) {
          if (alive()) { this.setState("busy"); this.startOwnerMonitor(); throw error; }
        }
      }
      const deadline = Date.now() + 5_000;
      while (alive() && Date.now() < deadline) await Bun.sleep(50);
      if (alive()) { this.setState("busy"); this.startOwnerMonitor(); throw new Error("Pi TUI owner process did not exit"); }
      this.ownerClaimed = false;
      this.resolveTuiExit?.(); this.resolveTuiExit = undefined;
    }
    const proc = this.proc;
    if (proc && proc.exitCode === null) await stopOwnedProcess(proc);
    this.proc = undefined;
    for (const waiter of this.tuiWaiters) { clearTimeout(waiter.timer); waiter.resolve(undefined); }
    this.tuiWaiters = [];
    for (const pending of this.tuiCommands.values()) pending.reject(new Error("Pi owner stopped"));
    this.tuiCommands.clear(); this.tuiQueue = [];
    for (const pending of this.pending.values()) pending.reject(new Error("Pi owner stopped"));
    this.pending.clear();
    this.server?.stop(true); this.server = undefined; this.setState("offline");
  }

  async deliver(envs: Envelope[]): Promise<void> {
    if (this.state !== "idle" || this.stopping) throw new Error(`${this.id} is not ready`);
    this.setState("busy"); this.activeEnvs = envs; this.currentReply = replyParent(envs); this.settledText = "";
    let attempted = false;
    try {
      const requested = await this.opts.selectModel?.(envs);
      if (requested) await this.setRequestedModel(requested);
      this.noteActivity();
      attempted = true;
      if (this.opts.mode === "tui") await this.sendTui({ type: "prompt", message: renderDigest(envs, true) });
      else await this.sendRpc({ type: "prompt", message: renderDigest(envs, true) });
    } catch (error) {
      if (!attempted) { this.activeEnvs = []; this.setState("idle"); throw error; }
      // The prompt may have reached Pi even if its acknowledgement was lost.
      // Fence the owner before reporting failure; never return it to the bus for replay.
      await this.terminateFailedTurn(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async steer(envs: Envelope[]): Promise<void> {
    if (this.state !== "busy" || this.stopping || envs.some((e) => e.kind !== "chat" || e.private || e.priority !== "important")) throw new Error("Pi workflow/private messages must queue");
    const reply = replyParent([...this.activeEnvs, ...envs]);
    this.activeEnvs.push(...envs); this.currentReply = reply;
    try {
      if (this.opts.mode === "tui") await this.sendTui({ type: "steer", message: renderDigest(envs, true) });
      else await this.sendRpc({ type: "steer", message: renderDigest(envs, true) });
    } catch (error) {
      await this.terminateFailedTurn(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getRequestedModel(): string { return this.requestedModel; }
  async setRequestedModel(model: string): Promise<void> {
    const slash = model.indexOf("/");
    const provider = "agent-hub-local";
    const modelId = model;
    if (this.opts.mode === "tui") await this.sendTui({ type: "set_model", provider, modelId }); else await this.sendRpc({ type: "set_model", provider, modelId });
    this.requestedModel = model;
  }

  private handleBridgeEvent(event: any): void {
    if (event.type === "session_start") {
      if (!this.ownerClaimed) { this.ownerClaimed = true; this.ownerToken = String(event.ownerToken ?? ""); }
      this.sessionId = String(event.sessionId ?? ""); this.sessionFile = String(event.sessionFile ?? "");
      this.ownerPid = Number.isInteger(event.pid) ? event.pid : undefined; this.ownerSignature = typeof event.signature === "string" ? event.signature : undefined;
      if ((this.opts.sessionId && this.sessionId !== this.opts.sessionId) || (this.opts.sessionFile && this.sessionFile !== this.opts.sessionFile)) { this.opts.log?.(`[${this.id}] Pi session identity mismatch`); return; }
      this.startOwnerMonitor(); if (this.opts.mode === "tui") this.setState("idle");
    }
    if (event.type === "session_shutdown") { this.stopping = true; this.ownerClaimed = false; this.clearOwnerMonitor(); this.resolveTuiExit?.(); this.resolveTuiExit = undefined; this.setState("offline"); }
    if (event.type === "agent_start") { this.noteActivity(); this.agentRunning = true; this.setState("busy"); }
    if (event.type === "activity" && this.state === "busy") this.touch();
    if (event.type === "agent_end") {
      this.settledText = typeof event.text === "string" ? event.text : "";
      this.settledCancelled = event.cancelled === true;
      this.settledError = event.failed ? String(event.error ?? "Pi agent run failed") : "";
    }
    if (event.type === "agent_settled") {
      this.agentRunning = false;
      if (typeof event.text === "string" && event.text.trim()) this.settledText = event.text;
      const text = this.settledText.trim(); const error = this.settledError; const cancelled = this.settledCancelled;
      this.settledText = ""; this.settledError = ""; this.settledCancelled = false;
      if (cancelled) this.onMessage?.("Pi turn cancelled; inspect any partial effects before continuing.", { inReplyTo: this.currentReply });
      else if (error) void this.opts.onTurnFailure?.(this.activeEnvs, error);
      else if (text) this.onMessage?.(text, { inReplyTo: this.currentReply });
      this.currentReply = undefined; this.activeEnvs = []; if (this.state === "busy" && !this.activeTools) this.setState("idle");
    }
  }

  private onOutput(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, index).replace(/\r$/, ""); this.buffer = this.buffer.slice(index + 1); if (!line) continue; try { this.handleRpc(JSON.parse(line) as RpcMessage); } catch (error) { this.opts.log?.(`[${this.id}] invalid Pi RPC output: ${(error as Error).message}`); } }
  }
  private nextTuiCommand(timeout: number): Promise<Record<string, unknown> | undefined> {
    const next = this.tuiQueue.shift(); if (next) return Promise.resolve(next);
    return new Promise((resolvePromise) => { const entry = { resolve: resolvePromise, timer: setTimeout(() => { const i = this.tuiWaiters.indexOf(entry); if (i >= 0) this.tuiWaiters.splice(i, 1); resolvePromise(undefined); }, timeout) }; this.tuiWaiters.push(entry); });
  }
  private sendTui(command: Record<string, unknown>): Promise<any> {
    const id = `ahub-${++this.seq}`;
    const wire = { id, ...command };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.tuiCommands.delete(id);
        this.tuiQueue = this.tuiQueue.filter((queued) => queued.id !== id);
        reject(new Error(`Pi TUI ${String(command.type)} acknowledgement timed out`));
      }, 30_000);
      this.tuiCommands.set(id, { command: wire, resolve: (value) => { clearTimeout(timer); resolvePromise(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      const waiter = this.tuiWaiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(wire); } else this.tuiQueue.push(wire);
    });
  }
  private handleRpc(message: RpcMessage): void { if (["message_update", "tool_execution_update"].includes(message.type ?? "") && this.state === "busy") this.touch();  if (message.type === "agent_settled") return; // The authenticated extension is the single lifecycle source.
    if (message.id !== undefined) { const pending = this.pending.get(String(message.id)); if (pending) { this.pending.delete(String(message.id)); message.success === false ? pending.reject(new Error(message.error ?? "Pi RPC command failed")) : pending.resolve(message); } } }
  private sendRpc(command: Record<string, unknown>): Promise<RpcMessage> { if (!this.proc?.stdin.writable) return Promise.reject(new Error("Pi process is not running")); const id = `ahub-${++this.seq}`; return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC ${String(command.type)} timed out`)); }, 30_000); this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolvePromise(m); }, reject: (e) => { clearTimeout(timer); reject(e); } }); this.proc!.stdin.write(`${JSON.stringify({ id, ...command })}\n`); }); }
  private async waitRpc(command: string, timeout: number): Promise<RpcMessage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.sendRpc({ type: command }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Pi ${command} timed out`)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const envs = this.activeEnvs; this.activeEnvs = [];
    if (envs.length) {
      this.onMessage?.("Pi turn failed; inspect its session and any partial effects before continuing.", { inReplyTo: this.currentReply });
      void this.opts.onTurnFailure?.(envs, error.message).catch(() => this.opts.log?.("Pi failure handoff could not be completed"));
    }
    this.currentReply = undefined;
    this.setState("offline");
  }
  private startOwnerMonitor(): void {
    this.clearOwnerMonitor();
    if (this.opts.mode !== "tui" || !this.ownerPid || !this.ownerSignature) return;
    this.ownerMonitor = setInterval(() => {
      if (!this.ownerPid || ownerStillAlive(this.ownerPid, this.ownerSignature)) return;
      this.stopping = true; this.ownerClaimed = false; this.clearOwnerMonitor();
      this.resolveTuiExit?.(); this.resolveTuiExit = undefined;
      for (const pending of this.tuiCommands.values()) pending.reject(new Error("Pi owner exited"));
      this.tuiCommands.clear(); this.tuiQueue = [];
      this.fail(new Error("Pi owner process exited without session_shutdown"));
    }, 500);
    this.ownerMonitor.unref?.();
  }
  private clearOwnerMonitor(): void { if (this.ownerMonitor) clearInterval(this.ownerMonitor); this.ownerMonitor = undefined; }
  private async terminateFailedTurn(error: Error): Promise<void> {
    const envs = this.activeEnvs.slice(), reply = this.currentReply;
    this.stopping = true;
    try {
      await this.stop();
      // The process exit handler may already have reported this failure.
      if (this.activeEnvs.length) this.fail(error);
    } catch {
      this.activeEnvs = envs; this.currentReply = reply;
      this.stopping = true;
      this.setState("busy");
      this.opts.log?.("Pi owner could not be stopped; session remains fenced, no automatic escalation");
    }
  }
  protected override onWatchdog(): void {
    if (this.stopping) return;
    if (this.activeTools) { this.touch(); return; }
    void this.terminateFailedTurn(new Error("Pi run became inactive before agent_settled"));
  }
}
