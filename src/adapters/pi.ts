import { buildPiLaunch } from "../pi/launch.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { renderDigest, replyAudience, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import { stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { processSignature } from "../pi/process-signature.ts";
import { realPath } from "../hub/project.ts";
import { toolResultFailed } from "../local/tools.ts";
import { piToolStepCeiling, type PiToolStepCeiling } from "../pi/ceiling.ts";
import type { ExecutionBudgetDecision, ExecutionUnit } from "../hub/execution-budget.ts";

export interface PiModelDescriptor { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; }
export interface PiToolSchema { name: string; description?: string; parameters: Record<string, unknown>; }
export interface PiRelay { url: string; token: string; models: PiModelDescriptor[]; }
export interface PiExit {
  cause: "process_exit" | "spawn_error" | "session_shutdown" | "owner_lost";
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  started: boolean;
  turnActive: boolean;
  toolActive: boolean;
  lastToolName?: string;
}
export interface PiOptions {
  cwd: string; stateDir: string; cmd?: string[]; mode: "headless" | "tui"; backend: "auto" | "dgx" | "mlx"; sessionFile?: string; sessionId?: string;
  model?: string;
  relay: PiRelay; executeTool: (name: string, args: unknown, toolCallId: string, sessionId?: string, signal?: AbortSignal) => Promise<string>; tools: PiToolSchema[];
  preamble?: string;
  selectModel?: (envs: Envelope[]) => Promise<string | undefined>; maxSteps?: number;
  /** Atomic task/run admission immediately before provider requests or tool execution. */
  admitBudget?: (envs: Envelope[], unit: ExecutionUnit) => Promise<ExecutionBudgetDecision[]>;
  /** Reported message usage as increments, before agent_settled releases the turn. */
  onTokens?: (added: number) => void;
  /** `ceiling` is the validated, session/turn-bound tool-step ceiling signal (#179), present only when the trusted extension emitted one for this turn. */
  onTurnFailure?: (envs: Envelope[], reason: string, ceiling?: PiToolStepCeiling) => Promise<void>;
  watchdogMs?: number; log?: (line: string) => void;
  /** Once per owner, after it is offline; a TUI owner may have unknown OS exit status. */
  onExit?: (exit: PiExit) => void;
  /** How long stop() waits for a graceful TUI owner exit before verified teardown. Tests shrink this. */
  stopGraceMs?: number;
}
export interface PiTuiLaunch { cmd: string; args: string[]; env: NodeJS.ProcessEnv; }
type RpcMessage = { type?: string; id?: string | number; command?: string; success?: boolean; data?: any; [key: string]: any };
type VerifiedEmptyResume = { sessionId: string };
function ownerStillAlive(pid: number, signature: string | undefined): boolean { const current = processSignature(pid); if (current !== undefined) return current === signature; try { process.kill(pid, 0); return true; } catch { return false; } }


export class PiPeer extends BasePeer {
  readonly hubNative = true;
  private proc?: ChildProcessWithoutNullStreams;
  private server?: ReturnType<typeof Bun.serve>;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  private readonly usageSeen = new Set<string>();
  private settledText = "";
  private settledError = "";
  private settledCancelled = false;
  private currentReply?: Envelope;
  private sessionId = "";
  private sessionFile = "";
  private executionBudgetTimer?: ReturnType<typeof setTimeout>;
  private executionAbort?: AbortController;
  private readonly budgetStops = new Map<number, string>();
  private readonly ceilingStops = new Map<number, PiToolStepCeiling>();
  private readonly idleBashReservations = new Map<string, { generation: number; expiresAt: number; deadlineAt?: number }>();
  private budgetGeneration = 0;
  private modelStep = 0;
  private readonly observationScope = randomUUID();
  private emptyResumeVerified = false;
  private verifiedEmptyResume?: VerifiedEmptyResume;
  private activityObserved = false;
  private persistedOnce = false;
  private activeEnvs: Envelope[] = [];
  private activeTools = 0;
  private readonly activeDeliveryIds = new Set<string>();
  private agentRunning = false;
  private owner = randomUUID();
  private _tuiLaunch?: PiTuiLaunch;
  private requestedModel = "";
  private starting?: Promise<void>;
  private ownerClaimed = false;
  private ownerToken = "";
  private stopping = true;
  private exitReported = false;
  private started = false;
  private lastToolName?: string;
  private shutdownExit?: PiExit;
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

  /** Envelopes belonging to the currently executing Pi turn, for relay-side model-call admission. */
  /** One id per admitted provider request; parallel tools share its assistant step. */
  get observationTurn(): string | undefined { return this.agentRunning && this.modelStep ? `${this.observationScope}.${this.budgetGeneration}.${this.modelStep}` : undefined; }

  get budgetEnvelopes(): Envelope[] { return this.agentRunning && this.state === "busy" ? this.activeEnvs.slice() : []; }

  /** Mark an authoritative relay admission stop against the current Pi turn, never a later turn. */
  recordBudgetStop(decision: ExecutionBudgetDecision): { generation: number; reason: string } | undefined {
    if (!this.agentRunning || this.state !== "busy") return undefined;
    const generation = this.budgetGeneration;
    const reason = `execution budget ${decision.reason ?? "exhausted"}: ${decision.scope} ${decision.unit} used ${decision.used}${decision.limit === null ? "" : ` of ${decision.limit}`}; ${decision.remaining === null ? "remaining unknown" : `${decision.remaining} remaining`}`;
    this.budgetStops.set(generation, reason);
    this.executionAbort?.abort();
    for (const old of this.budgetStops.keys()) if (old < generation - 8) this.budgetStops.delete(old);
    return { generation, reason };
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startImpl();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async handleToolRequest(body: any): Promise<Response> {
    if (this.stopping || this.state === "offline") return Response.json({ text: "error: Pi owner is stopped" }, { status: 409 });
    let executionSignal = this.executionAbort?.signal;
    let idleBashTimer: ReturnType<typeof setTimeout> | undefined;
    if (body.purpose === "idle_user_bash") {
      const reservation = typeof body.reservation === "string" ? this.idleBashReservations.get(body.reservation) : undefined;
      if (!reservation || reservation.expiresAt < Date.now() || reservation.generation !== body.generation || !this.ownerClaimed || this.ownerPid === undefined || this.state !== "idle" || this.agentRunning || this.activeTools > 0 || this.activeEnvs.length > 0 || !Number.isSafeInteger(body.generation) || body.generation !== this.budgetGeneration) return Response.json({ text: "error: stale or non-idle Pi user shell request" }, { status: 409 });
      if (reservation.deadlineAt !== undefined && reservation.deadlineAt <= Date.now()) {
        this.idleBashReservations.delete(String(body.reservation));
        return Response.json({ text: "error: Pi user shell execution budget expired" }, { status: 409 });
      }
      this.idleBashReservations.delete(String(body.reservation));
      const idleBashAbort = new AbortController();
      executionSignal = idleBashAbort.signal;
      if (reservation.deadlineAt !== undefined) idleBashTimer = setTimeout(() => idleBashAbort.abort(), Math.max(0, reservation.deadlineAt - Date.now()));
    }
    this.noteActivity();
    const name = String(body.name);
    this.lastToolName = this.opts.tools.some((tool) => tool.name === name) && /^[a-zA-Z0-9_.-]{1,128}$/.test(name) ? name : "unknown";
    this.activeTools++;
    if (this.state === "idle") this.setState("busy");
    if (this.state === "busy") this.touch();
    // `failed` is the managed-tool failure verdict (toolResultFailed, the one contract): Pi 1.0.1
    // classifies a native tool result by isError === true alone, so the extension needs the flag,
    // not just the text (#181). An older extension simply ignores the extra field.
    try { const text = await this.opts.executeTool(String(body.name), body.args, String(body.toolCallId ?? ""), this.sessionId, executionSignal); return Response.json({ text, failed: toolResultFailed(String(body.name), text) }); }
    catch (error) { return Response.json({ text: `error: ${(error as Error).message}`, failed: true }, { status: 200 }); }
    finally {
      clearTimeout(idleBashTimer);
      this.activeTools--;
      if (this.state === "busy") {
        if (!this.activeTools && !this.agentRunning && !this.activeEnvs.length) this.setState("idle");
        else this.touch();
      }
    }
  }

  private async handleBudgetRequest(body: any): Promise<Response> {
    if (!["model_calls", "tool_calls"].includes(String(body.unit))) return Response.json({ error: "invalid Pi budget unit" }, { status: 400 });
    const idleUserBash = body.idleUserBash === true;
    const current = Number.isSafeInteger(body.generation) && body.generation === this.budgetGeneration;
    const idleOwner = this.ownerClaimed && this.ownerPid !== undefined && this.state === "idle" && !this.agentRunning && this.activeTools === 0 && this.activeEnvs.length === 0;
    if (!current || (idleUserBash ? !idleOwner : !this.agentRunning || this.state !== "busy")) return Response.json({ error: "stale Pi budget request" }, { status: 409 });
    // An interactive user shell has no task delivery. It may spend an eligible run budget only.
    const envs = idleUserBash ? [] : this.budgetEnvelopes;
    const decisions = this.opts.admitBudget ? await this.opts.admitBudget(envs, body.unit as ExecutionUnit) : [];
    const denied = decisions.find((decision) => !decision.allowed);
    const remaining = decisions.filter((decision) => decision.unit === "elapsed_ms" && decision.remaining !== null).reduce<number | undefined>((min, decision) => min === undefined ? decision.remaining! : Math.min(min, decision.remaining!), undefined);
    let reservation: string | undefined;
    if (idleUserBash && !denied) {
      for (const [key, value] of this.idleBashReservations) if (value.expiresAt < Date.now()) this.idleBashReservations.delete(key);
      reservation = randomUUID();
      this.idleBashReservations.set(reservation, { generation: body.generation, expiresAt: Date.now() + 30_000, ...(remaining === undefined ? {} : { deadlineAt: Date.now() + remaining }) });
    }
    clearTimeout(this.executionBudgetTimer);
        if (!denied && remaining !== undefined && this.state === "busy") {
          const generation = this.budgetGeneration;
          const controller = this.executionAbort;
          this.executionBudgetTimer = setTimeout(() => {
            if (!this.agentRunning || generation !== this.budgetGeneration || controller !== this.executionAbort) return;
            controller?.abort();
            void this.sendTui({ type: "abort_budget", generation }).catch((error) => this.opts.log?.(`[${this.id}] elapsed budget stop could not reach Pi: ${(error as Error).message}`));
          }, Math.max(0, remaining));
        }
    if (!denied && body.unit === "model_calls") this.modelStep++;
    return Response.json({ decisions, ...(reservation ? { reservation } : {}) });
  }

  private async startImpl(): Promise<void> {
    this.stopping = false;
    this.exitReported = false; this.started = false; this.lastToolName = undefined; this.shutdownExit = undefined;
    mkdirSync(this.opts.stateDir, { recursive: true });
    const sessions = join(this.opts.stateDir, "pi-sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    if (this.opts.sessionFile) {
      const file = realPath(this.opts.sessionFile);
      const rel = relative(realPath(sessions), file);
      if (!rel || rel.startsWith("..") || resolve(realPath(sessions), rel) !== file) throw new Error("Pi session file is outside the managed project session directory");
      const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!);
      if (header.type !== "session" || typeof header.cwd !== "string" || realPath(header.cwd) !== realPath(this.opts.cwd) || (this.opts.sessionId && header.id !== this.opts.sessionId)) throw new Error("Pi session header does not match the requested project/session");
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
      if (url.pathname === "/tool") return this.handleToolRequest(body);
      if (url.pathname === "/budget") return this.handleBudgetRequest(body);
      return new Response("not found", { status: 404 });
    } });
    this.server = bridge;
    const extension = resolve(join(import.meta.dir, "../pi/extension.ts"));
    const inherited: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TERM", "TERM_PROGRAM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "CODEX_HOME"]) if (process.env[key]) inherited[key] = process.env[key];
    this._tuiLaunch = buildPiLaunch(this.opts, inherited, extension, bridge.port!, token);
    const { cmd: bin, args, env } = this._tuiLaunch;
    if (this.opts.mode === "tui") { return; }
    // Its own process group, stopped as a whole (#115, as Codex's in #113).
    this.proc = spawn(bin, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    trackGroup(this.proc);
    this.proc.stdout.on("data", (chunk) => this.onOutput(String(chunk)));
    this.proc.stderr.on("data", (chunk) => this.opts.log?.(`[${this.id}] ${String(chunk).trimEnd()}`));
    const proc = this.proc;
    proc.on("error", (error) => {
      const exit = this.exitMetadata("spawn_error");
      this.fail(error);
      this.reportExit(exit);
    });
    proc.on("exit", (code, signal) => {
      const exit = { ...(this.shutdownExit ?? this.exitMetadata("process_exit")), code, signal };
      this.fail(new Error(`pi exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      this.reportExit(exit);
    });
    const state = await this.waitRpc("get_state", 15_000);
    if (state.success !== true || typeof state.data?.sessionId !== "string" || typeof state.data?.sessionFile !== "string" || !state.data.sessionId || !state.data.sessionFile) throw new Error("Pi get_state did not prove session identity");
    if ((this.opts.sessionId && state.data.sessionId !== this.opts.sessionId) || (this.opts.sessionFile && state.data.sessionFile !== this.opts.sessionFile)) {
      throw new Error("Pi get_state session identity does not match the requested recovery session");
    }
    this.sessionId = state.data.sessionId; this.sessionFile = state.data.sessionFile;
    this.persistedOnce = existsSync(this.sessionFile);
    if ((this.opts.sessionId && this.sessionId !== this.opts.sessionId) || (this.opts.sessionFile && this.sessionFile !== this.opts.sessionFile)) throw new Error("Pi startup session identity mismatch");
    this.started = true;
    this.setState("idle");
  }

  async stop(): Promise<void> {
    for (const id of this.activeDeliveryIds) this.delivery({ id, state: "needs_review", reason: "Pi session stopped before settlement" });
    this.activeDeliveryIds.clear();
    this.stopping = true;
    this.clearOwnerMonitor();
    if (this.opts.mode === "tui") {
      const grace = this.opts.stopGraceMs ?? 5_000;
      const alive = () => !!this.ownerPid && ownerStillAlive(this.ownerPid, this.ownerSignature);
      if (this.ownerClaimed && alive()) {
        try {
          await Promise.race([this.sendTui({ type: "shutdown" }), (async () => {
            const deadline = Date.now() + grace;
            while (alive() && Date.now() < deadline) await Bun.sleep(50);
            if (alive()) throw new Error("Pi TUI shutdown was not acknowledged");
          })()]);
        }
        catch (error) {
          // A lost shutdown acknowledgement is not a reason to leave a native owner running
          // next to its replacement: tear it down by verified identity, or fail stop (#56).
          if (alive() && !(await this.stopSurvivingOwner())) { this.setState("busy"); this.startOwnerMonitor(); throw error; }
        }
      }
      const deadline = Date.now() + grace;
      while (alive() && Date.now() < deadline) await Bun.sleep(50);
      if (alive() && !(await this.stopSurvivingOwner()) && alive()) { this.setState("busy"); this.startOwnerMonitor(); throw new Error("Pi TUI owner process did not exit"); }
      this.ownerClaimed = false;
      this.resolveTuiExit?.(); this.resolveTuiExit = undefined;
    }
    const proc = this.proc;
    // Also when it exited: what it left in its group fails the stop. The rest of the teardown runs either way; a process
    // that could not be stopped stays recorded, so a later stop tries it again.
    let failed: unknown;
    if (proc) await stopOwnedProcess(proc, { group: true }).then(() => { if (this.proc === proc) this.proc = undefined; }, (error: unknown) => { failed = error; });
    for (const waiter of this.tuiWaiters) { clearTimeout(waiter.timer); waiter.resolve(undefined); }
    this.tuiWaiters = [];
    for (const pending of this.tuiCommands.values()) pending.reject(new Error("Pi owner stopped"));
    this.tuiCommands.clear(); this.tuiQueue = [];
    for (const pending of this.pending.values()) pending.reject(new Error("Pi owner stopped"));
    this.pending.clear();
    this.server?.stop(true); this.server = undefined; this.setState("offline");
    if (failed) throw failed;
  }

  /**
   * Terminate a verified TUI owner that outlived its graceful shutdown. Every signal is
   * guarded by ownerStillAlive, which re-reads the process signature on each poll, so a
   * reused PID is never signaled. True once the owner is confirmed gone.
   */
  private async stopSurvivingOwner(): Promise<boolean> {
    const pid = this.ownerPid;
    const signature = this.ownerSignature;
    const gone = () => !pid || !ownerStillAlive(pid, signature);
    if (!pid || !signature || gone()) return true;
    try { process.kill(pid, "SIGTERM"); } catch { return gone(); }
    let deadline = Date.now() + 2_000;
    while (!gone() && Date.now() < deadline) await Bun.sleep(50);
    if (gone()) return true;
    try { process.kill(pid, "SIGKILL"); } catch { return gone(); }
    deadline = Date.now() + 2_000;
    while (!gone() && Date.now() < deadline) await Bun.sleep(50);
    return gone();
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle" || this.stopping) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is not ready` });
      throw new Error(`${this.id} is not ready`);
    }
    this.setState("busy"); this.activeEnvs = envs; this.currentReply = replyParent(envs); this.settledText = "";
    let attempted = false;
    try {
      const requested = await this.opts.selectModel?.(envs);
      if (requested) await this.setRequestedModel(requested);
      this.noteActivity();
      attempted = true;
      if (deliveryId) this.activeDeliveryIds.add(deliveryId);
      if (this.opts.mode === "tui") await this.sendTui({ type: "prompt", message: renderDigest(envs, true) });
      else await this.sendRpc({ type: "prompt", message: renderDigest(envs, true) });
      if (deliveryId && this.activeDeliveryIds.has(deliveryId)) this.delivery({ id: deliveryId, state: "accepted" });
    } catch (error) {
      if (!attempted) {
        this.activeEnvs = []; this.setState("idle");
        if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      // The prompt may have reached Pi even if its acknowledgement was lost.
      // Fence the owner before reporting failure; never return it to the bus for replay.
      const reason = error instanceof Error ? error.message : String(error);
      if (deliveryId && /process is not running/i.test(reason)) {
        this.activeDeliveryIds.delete(deliveryId);
        this.delivery({ id: deliveryId, state: "failed_safe", reason });
      }
      await this.terminateFailedTurn(error instanceof Error ? error : new Error(reason));
    }
  }

  async steer(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "busy" || this.stopping || envs.some((e) => e.kind !== "chat" || e.private || e.priority !== "important")) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: "Pi workflow/private messages must queue" });
      throw new Error("Pi workflow/private messages must queue");
    }
    const reply = replyParent([...this.activeEnvs, ...envs]);
    this.activeEnvs.push(...envs); this.currentReply = reply;
    try {
      if (deliveryId) this.activeDeliveryIds.add(deliveryId);
      if (this.opts.mode === "tui") await this.sendTui({ type: "steer", message: renderDigest(envs, true) });
      else await this.sendRpc({ type: "steer", message: renderDigest(envs, true) });
      if (deliveryId && this.activeDeliveryIds.has(deliveryId)) this.delivery({ id: deliveryId, state: "accepted" });
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
      this.startOwnerMonitor(); if (this.opts.mode === "tui") { this.started = true; this.setState("idle"); }
    }
    if (event.type === "session_shutdown") {
      const exit = this.exitMetadata("session_shutdown");
      this.shutdownExit ??= exit; // headless waits for the OS exit, retaining the pre-cleanup turn and stop facts
      this.stopping = true; this.ownerClaimed = false; this.clearOwnerMonitor(); this.resolveTuiExit?.(); this.resolveTuiExit = undefined;
      this.fail(new Error("Pi session shut down before settlement"));
      if (this.opts.mode === "tui") this.reportExit(exit);
    }
    if (event.type === "agent_start") {
      const generation = Number.isSafeInteger(event.generation) ? event.generation : this.budgetGeneration + 1;
      if (generation <= this.budgetGeneration) return;
      this.modelStep = 0;
      this.usageSeen.clear(); this.idleBashReservations.clear(); this.ceilingStops.clear(); this.executionAbort = new AbortController(); this.budgetGeneration = generation; this.noteActivity(); this.agentRunning = true; this.setState("busy");
    }
    // #179: the extension's tool-step ceiling signal. Only a schema-valid event bound to THIS session,
    // THIS turn generation and a running turn is stored; the first signal of a turn stands. Anything
    // else (stale, cross-session, free text) is dropped and the failure stays unclassified.
    if (event.type === "ceiling") {
      const ceiling = piToolStepCeiling(event);
      if (ceiling && ceiling.sessionId === this.sessionId && ceiling.generation === this.budgetGeneration && this.agentRunning && this.state === "busy" && !this.ceilingStops.has(ceiling.generation)) {
        this.ceilingStops.set(ceiling.generation, ceiling);
        for (const old of this.ceilingStops.keys()) if (old < ceiling.generation - 8) this.ceilingStops.delete(old);
      }
    }
    if (event.type === "activity" && this.state === "busy") this.touch();
    if (event.type === "tokens" && this.state === "busy" && typeof event.id === "string" && event.id.length <= 100 && Number.isSafeInteger(event.tokens) && event.tokens >= 0 && !this.usageSeen.has(event.id)) {
      this.usageSeen.add(event.id);
      if (this.usageSeen.size > 1000) this.usageSeen.delete(this.usageSeen.values().next().value!);
      if (event.tokens > 0) this.opts.onTokens?.(event.tokens);
    }
    if (event.type === "agent_end") {
      if (Number.isSafeInteger(event.generation) && event.generation !== this.budgetGeneration) return;
      clearTimeout(this.executionBudgetTimer); this.executionBudgetTimer = undefined;
      const generation = Number.isSafeInteger(event.generation) ? event.generation : this.budgetGeneration;
      const budgetStop = this.budgetStops.get(generation);
      if (budgetStop) this.executionAbort?.abort();
      this.settledText = typeof event.text === "string" ? event.text : "";
      this.settledCancelled = !budgetStop && event.cancelled === true;
      this.settledError = budgetStop ?? (event.failed ? String(event.error ?? "Pi agent run failed") : "");
    }
    if (event.type === "agent_settled") {
      if (Number.isSafeInteger(event.generation) && event.generation !== this.budgetGeneration) return;
      clearTimeout(this.executionBudgetTimer); this.executionBudgetTimer = undefined;
      this.agentRunning = false;
      if (typeof event.text === "string" && event.text.trim()) this.settledText = event.text;
      const generation = Number.isSafeInteger(event.generation) ? event.generation : this.budgetGeneration;
      const text = this.settledText.trim(); const error = this.budgetStops.get(generation) ?? this.settledError; const cancelled = !error && this.settledCancelled;
      const ceiling = this.ceilingStops.get(generation);
      this.budgetStops.delete(generation);
      this.ceilingStops.delete(generation);
      this.settledText = ""; this.settledError = ""; this.settledCancelled = false;
      // Answer the peers this turn was for, not every peer on the bus (issue #29). activeEnvs still holds the
      // whole delivery here, steered additions included.
      const reply = { inReplyTo: this.currentReply, to: replyAudience(this.activeEnvs) };
      if (cancelled) this.onMessage?.("Pi turn cancelled; inspect any partial effects before continuing.", reply);
      else if (error?.startsWith("execution budget")) this.onMessage?.(`Pi stopped at the execution budget: ${error}. Inspect partial work before continuing.`, reply);
      else if (error) void this.opts.onTurnFailure?.(this.activeEnvs, error, ceiling);
      else if (text) this.onMessage?.(text, reply);
      for (const id of this.activeDeliveryIds) this.delivery({ id, state: error || cancelled ? "needs_review" : "completed", ...(error || cancelled ? { reason: error || "Pi turn cancelled; partial effects are possible" } : {}) });
      this.activeDeliveryIds.clear();
      this.currentReply = undefined; this.activeEnvs = []; if (this.state === "busy" && !this.activeTools) this.setState("idle");
      this.executionAbort = undefined;
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
  private exitMetadata(cause: PiExit["cause"]): PiExit {
    return { cause, code: null, signal: null, expected: this.stopping, started: this.started,
      turnActive: this.agentRunning || this.activeEnvs.length > 0, toolActive: this.activeTools > 0,
      ...(this.lastToolName ? { lastToolName: this.lastToolName } : {}) };
  }

  private reportExit(exit: PiExit): void {
    if (this.exitReported) return;
    this.exitReported = true;
    const line = `[${this.id}] Pi exit: cause=${exit.cause} code=${exit.code ?? "unknown"} signal=${exit.signal ?? "unknown"} expected=${exit.expected} started=${exit.started} turnActive=${exit.turnActive} toolActive=${exit.toolActive} lastTool=${exit.lastToolName ?? "none"}`;
    try { this.opts.log?.(line); } catch { /* reporting must not prevent owner settlement */ }
    try { this.opts.onExit?.(exit); } catch { /* the owner is already offline */ }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const envs = this.activeEnvs; this.activeEnvs = [];
    for (const id of this.activeDeliveryIds) this.delivery({ id, state: "needs_review", reason: error.message });
    this.activeDeliveryIds.clear();
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
      const exit = this.exitMetadata("owner_lost");
      this.stopping = true; this.ownerClaimed = false; this.clearOwnerMonitor();
      this.resolveTuiExit?.(); this.resolveTuiExit = undefined;
      for (const pending of this.tuiCommands.values()) pending.reject(new Error("Pi owner exited"));
      this.tuiCommands.clear(); this.tuiQueue = [];
      this.fail(new Error("Pi owner process exited without session_shutdown"));
      this.reportExit(exit);
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
