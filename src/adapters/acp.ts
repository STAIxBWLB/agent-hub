import { activityText, updateActivity, type Activity, type ActivityKind } from "../hub/activity.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { renderDigest, replyAudience, replyParent, sanitize, type Envelope, type PeerId, type PeerState } from "../hub/envelope.ts";
import { acpQuotaRefusal, type ACPQuotaRefusal } from "./acp-quota.ts";
import type { PermissionMode } from "../hub/permission-mode.ts";
import { KIMI_MODE_IDS } from "./definitions/kimi-native.ts";
import { QWEN_MODE_IDS, qwenNativeIdentity } from "./definitions/qwen-native.ts";
export { QwenIdentityError } from "./definitions/qwen-native.ts";
import { BasePeer } from "../hub/peers.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { AcpOwnedGroup } from "./acp-owned-group.ts";
import type { StartForm } from "./registry-types.ts";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}
export interface PermissionRequest {
  peer: PeerId;
  title: string;
  options: PermissionOption[];
  /** Native ACP tool kind, when the request reports it. Never inferred from its title. */
  kind?: string;
  /** The tool's name alone, when the adapter knows it apart from the title (which can quote the payload). */
  tool?: string;
  /** An always-ask class call (#636): the host never answers it on its own, not even for an unattended hub. */
  classed?: true;
}

/** What the host's always-ask gate says about one request (#636): the approval text it must show, and a class-budget choice when one applies. */
export interface ActionGateVerdict {
  title: string;
  /** The person cannot see the complete command: no allow option or class-budget grant is valid. */
  denyOnly?: true;
  /** A person's explicit choice to approve the classes for the rest of the session's budget (`label` names them); never an ordinary allow. */
  budget?: { label: string; approve(): boolean };
}
/** The option id of that choice. The agent never sees it: it is answered with the agent's own allow_once. */
export const ACTION_BUDGET_OPTION = "agent-hub:action-budget";

export interface ACPUsageDiagnostic {
  source: "usage_update" | "prompt_result";
  availability: "known" | "unsupported" | "invalid";
  shape: "total" | "input-output" | "context-used" | "none";
  contextUsed?: number;
  contextCapacity?: number;
  total?: number;
}

/** Counter-only projection: no source payload, text, tools or metadata escapes. */
export function normalizeACPUsage(value: unknown, source: ACPUsageDiagnostic["source"] = "usage_update"): ACPUsageDiagnostic {
  const unknown: ACPUsageDiagnostic = { source, availability: "unsupported", shape: "none" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
  const raw = value as Record<string, unknown>;
  const f = raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage) ? raw.usage as Record<string, unknown> : raw;
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const key of ["totalTokens", "total_tokens"]) {
    if (f[key] === undefined) continue;
    const shape = "total";
    return valid(f[key]) ? { source, availability: "known", shape, total: f[key] } : { source, availability: "invalid", shape };
  }
  for (const [input, output] of [["inputTokens", "outputTokens"], ["input_tokens", "output_tokens"]]) {
    if (f[input!] === undefined && f[output!] === undefined) continue;
    const a = f[input!], b = f[output!];
    return valid(a) && valid(b) && Number.isFinite(a + b) ? { source, availability: "known", shape: "input-output", total: a + b } : { source, availability: "invalid", shape: "input-output" };
  }
  if (f.used !== undefined) {
    if (!valid(f.used) || !valid(f.size) || !Number.isSafeInteger(f.used) || !Number.isSafeInteger(f.size) || f.size <= 0) return { source, availability: "invalid", shape: "context-used" };
    // Qwen 0.24.7 derives this from collectContextData: occupancy is not cumulative consumption.
    return { source, availability: "unsupported", shape: "context-used", contextUsed: f.used, contextCapacity: f.size };
  }
  return unknown;
}

export interface AcpOptions {
  /** Trusted host declaration, never inferred from an instance suffix or advertised agent text. */
  kind?: string;
  /** e.g. ["kimi", "acp"]. `opencode acp` fits the same adapter. */
  cmd: string[];
  /** Coordinator-visible selected model only; contains no prompts or command arguments. */
  launchModel?: string;
  permissionMode?: PermissionMode;
  /** Presence replaces all identity-inferred native mode and quota policy. */
  nativePolicy?: { modes?: Partial<Record<PermissionMode, string>>; readOnly?: string; lockedReadOnly?: boolean };
  /** Configured ACP execution requires a host-captured process-group ownership proof. */
  requireOwnedGroup?: boolean;
  /** Production Qwen only; legacy benchmark adapters retain their own native policy. */
  qwen025?: boolean;
  /** A production adapter's source-pinned identity; no table is inferred from it. */
  expectedAgent?: { name: string; version: string | ((version: unknown) => boolean) };
  /** Vendors with uncertain load semantics must explicitly echo the restored identity. */
  requireLoadSessionEcho?: boolean;
  /** Bound for native mode acknowledgement; defaults to the handshake deadline. */
  permissionModeTimeoutMs?: number;
  /** Load this earlier session (ACP `session/load`) instead of starting a new one: crash recovery, issue #37. */
  resumeSessionId?: string;
  cwd: string;
  /** Optional launch environment; recovery authority is always removed before spawn. */
  env?: NodeJS.ProcessEnv;
  watchdogMs?: number;
  /** #542 D4: how long an open tool call keeps a silent turn alive; defaults to 30 minutes, never below the watchdog. */
  toolCeilingMs?: number;
  /** Bound for a journal-less watchdog cancellation to report its prompt; defaults to the 30 s ACP handshake cap. */
  cancelWaitMs?: number;
  /** ACP stdio MCP servers for the session (the hub's task tools). */
  mcpServers?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
  /** Appended to the standing instruction of the first delivery (role contract). */
  preamble?: string;
  /** The session's running token total from `usage_update` (checked totalTokens or input/output pair; `used` context occupancy is diagnostic only). Cumulative, not a delta. */
  onTokens?: (sessionTotal: number, sessionId: string) => void;
  /** The prompt rejected or ended without normal completion, even when it streamed partial text.
   *  Same shape as Pi's onTurnFailure; a stale cancelled turn never reports. */
  onTurnFailure?: (envs: Envelope[], reason: string) => Promise<void> | void;
  /** The sessionId is the adapter's own: the daemon binds a context reading to it, not to a lookup of its own (#285). */
  onUsageDiagnostic?: (observation: ACPUsageDiagnostic, sessionId: string) => void;
  /** Return true only when the current-session refusal has an authoritative quota pause; otherwise hold delivery. */
  onQuotaRefusal?: (window: ACPQuotaRefusal) => boolean;
  /** Resolve with an optionId, or undefined to cancel. Absent = every request is cancelled.
   *  A request whose payload could not be resolved is titled as such and carries no session-wide allow option. */
  onPermission?: (req: PermissionRequest, signal?: AbortSignal) => Promise<string | undefined>;
  /** Tool titles approved once without asking: the hub's own tools, as Codex gets them (issue #72). Exact names only. */
  autoApprove?: (toolTitle: string) => boolean;
  /**
   * Always-ask (#636): given a request's tool names, kind and arguments, a verdict only when a person must be asked, else undefined (the
   * request then follows the permission mode as before). A verdict beats `autoApprove`, withholds `allow_always` and carries the approval text.
   */
  actionGate?: (call: { names: readonly string[]; kind?: string; input: unknown }, session: string) => ActionGateVerdict | undefined;
  /** Transient person-only stream; no native update escapes through another observer. */
  onActivity?: (item: Activity) => void;
  isPrivateTurn?: () => boolean;
  log?: (line: string) => void;
}

const HANDSHAKE_MS = 30_000;
/** Tool calls whose arguments are remembered until their permission request arrives. */
const TOOL_INPUT_CAP = 64;
const TOOL_CEILING_MS = 30 * 60_000;

/**
 * The canonical tool binding (#138): an announced `<tool> (<server> MCP Server)` title resolves to
 * `mcp__<server>__<tool>` only when <server> is one this session was configured with. A title that
 * quotes argument JSON or names an unconfigured server resolves to nothing.
 */
export function canonicalMcpToolName(announcedTitle: string | undefined, serverNames: readonly string[] | undefined): string | undefined {
  const m = announcedTitle?.match(/^([\w-]{1,80}) \((.+) MCP Server\)$/);
  return m && serverNames?.some((name) => name === m[2]) ? `mcp__${m[2]}__${m[1]}` : undefined;
}

class RpcTimeoutError extends Error {}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Streamed argument text as a payload: a complete JSON object, or nothing (a partial stream is not what will run). */
function jsonObject(text: string | undefined): object | undefined {
  try {
    const v = text === undefined ? undefined : JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** ACP client (JSON-RPC 2.0, newline-delimited, over the child's stdio). One session, one prompt in flight. */
export class AcpPeer extends BasePeer {
  readonly deliveryOnly: boolean = true;
  readonly hubOwned: boolean = true;
  readonly form: StartForm = "headless";
  private permissionMode: PermissionMode;
  private readonly nativePolicy: AcpOptions["nativePolicy"];
  private modeUnknown = false;
  private kimiAgent = false;
  private qwenAgent = false;
  private availableModes = new Set<string>();
  private proc: ChildProcessWithoutNullStreams | undefined;
  private ownedGroup: { proc: ChildProcessWithoutNullStreams; proof: AcpOwnedGroup } | undefined;
  private sessionId = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private readonly toolInputs = new Map<string, unknown>();
  private readonly toolText = new Map<string, string>(); // streamed argument text, per call, until it finishes
  private readonly toolTitles = new Map<string, string>(); // the title a call was announced with, per call id (#138)
  private readonly openTools = new Map<string, string>(); // this turn's started, unfinished tool calls (#542 D4)
  private lastSignAt = 0;
  private primed = false;
  private turn = 0; // generation: a prompt cancelled by the watchdog must not touch the turn that followed it
  private stopping = false;
  private activeDeliveryId: string | undefined;
  private activeLegacy: { turn: number; envs: Envelope[] } | undefined;
  private deliveryAccepted = false;
  /** What the running turn answers: its delivery plus whatever the transport took into it mid-turn (#572). */
  private turnEnvs: Envelope[] = [];
  private steerIds: string[] = [];
  private cancelWait: { turn: number; successor: number; timer: ReturnType<typeof setTimeout>; reported: boolean; released: Promise<void>; release: () => void } | undefined;
  private promptActivity = false;
  private activityOpen = false;
  private activityPrivate = false;
  private activityStub = false;
  private activityStarted = 0;
  private activityPending: { kind: "message" | "thought"; text: string } | undefined;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  private emitActivity(kind: ActivityKind, text: string): void {
    if (!this.opts.onActivity || !this.activityOpen) return;
    // Privacy latches for the whole turn, even when the associated task closes mid-turn.
    try { this.activityPrivate ||= this.opts.isPrivateTurn?.() === true; } catch { this.activityPrivate = true; }
    if (this.activityPrivate) {
      if (this.activityStub) return;
      this.activityStub = true; kind = "private"; text = "Private turn: activity withheld";
    }
    try { this.opts.onActivity({ kind, text: activityText(text), at: Date.now(), turn: this.turn }); } catch { /* watch cannot affect delivery */ }
  }
  private flushActivity(): void {
    clearTimeout(this.activityTimer); this.activityTimer = undefined;
    const pending = this.activityPending; this.activityPending = undefined;
    if (pending) this.emitActivity(pending.kind, pending.text);
  }
  private updateWatch(u: unknown): void {
    if (!this.opts.onActivity) return;
    const item = updateActivity(u);
    if (!item) return;
    if (item.kind === "message" || item.kind === "thought") {
      if (this.activityPending?.kind !== item.kind || (this.activityPending.text.length + item.text.length > 4096)) this.flushActivity();
      if (this.activityPending) this.activityPending.text += item.text;
      else this.activityPending = { kind: item.kind, text: item.text };
      this.activityTimer ??= setTimeout(() => this.flushActivity(), 50);
      this.activityTimer.unref?.();
    } else { this.flushActivity(); this.emitActivity(item.kind, item.text); }
  }
  private clearActivity(): void {
    clearTimeout(this.activityTimer); this.activityTimer = undefined; this.activityPending = undefined;
  }
  private endActivity(reason: string, discardPending = false): void {
    if (discardPending) this.clearActivity(); else this.flushActivity();
    this.emitActivity("turn_end", `${reason}; ${Date.now() - this.activityStarted} ms`);
    this.activityOpen = false;
  }
  private readonly permissionWaits = new Set<AbortController>();

  protected override setState(next: PeerState): void {
    if (next === "offline") { this.clearActivity(); this.cancelPermissions(); }
    super.setState(next);
  }

  private cancelPermissions(): void {
    for (const wait of this.permissionWaits) wait.abort();
    this.permissionWaits.clear();
  }

  constructor(
    id: PeerId,
    private readonly opts: AcpOptions,
  ) {
    super(id, opts.watchdogMs);
    this.nativePolicy = opts.nativePolicy === undefined ? undefined : { ...opts.nativePolicy, ...(opts.nativePolicy.modes === undefined ? {} : { modes: { ...opts.nativePolicy.modes } }) };
    this.permissionMode = this.nativePolicy?.lockedReadOnly ? "ask" : opts.permissionMode ?? "ask";
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: { kind: "acp", ...(this.opts.launchModel ? { model: this.opts.launchModel } : {}) }, ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }
  get nativeSession(): string | undefined {
    const session = this.recoveryMetadata().sessionId;
    return typeof session === "string" ? session : undefined;
  }

  async start(): Promise<void> {
    if (this.opts.requireOwnedGroup && this.proc) throw new Error("Configured ACP still has a process; stop it before starting another");
    this.stopping = false;
    const [bin, ...args] = this.opts.cmd;
    // Its own process group, stopped as a whole (#115, as Codex's in #113): an agent CLI may be a launcher with a native child.
    const proc = spawn(bin!, args, { cwd: this.opts.cwd, env: peerChildEnv(this.id, { ...process.env, ...(this.opts.env ?? {}) }), stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.proc = proc;
    trackGroup(proc);
    proc.on("error", (e) => { if (!this.opts.requireOwnedGroup || this.proc === proc) this.down(`spawn failed: ${e.message}`); });
    proc.on("exit", (code) => { if (!this.opts.requireOwnedGroup || this.proc === proc) this.down(`exited with code ${code}`); });
    proc.stdin.on("error", () => {}); // EPIPE from a child that died; `exit` / `error` already report it
    proc.stderr.on("data", (d) => this.opts.log?.(this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP stderr output withheld" : `[${this.id}] ${String(d).trimEnd()}`));
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));

    const handshake = async () => {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      // The configured peer id and command are labels, not an agent-specific mode contract.
      // Installed Kimi Code CLI's ACP initialize advertises this exact name.
      this.kimiAgent = this.nativePolicy === undefined && init?.agentInfo?.name === "Kimi Code CLI";
      const expected = this.opts.expectedAgent, version = init?.agentInfo?.version;
      if (expected && (init?.agentInfo?.name !== expected.name || !(typeof expected.version === "function" ? expected.version(version) : version === expected.version))) throw new Error("native ACP identity is not verified for this production adapter");
      const qwen = qwenNativeIdentity(this.id, this.opts.qwen025, init, this.opts.kind);
      this.qwenAgent = this.nativePolicy === undefined && qwen;
      const resume = this.opts.resumeSessionId;
      if (!resume) return this.request("session/new", { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
      // The agent replays the session as updates while it loads; they arrive before the peer is idle, so none of
      // them is taken for an answer.
      if (!init?.agentCapabilities?.loadSession) throw new Error(`${this.id} cannot load an earlier session (the agent offers no loadSession)`);
      const loaded = await this.request("session/load", { sessionId: resume, cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
      if ((loaded?.sessionId !== undefined && loaded.sessionId !== resume) || (this.opts.requireLoadSessionEcho && loaded?.sessionId !== resume)) throw new Error("native ACP load did not confirm the requested conversation; no restored session is claimed");
      return { ...loaded, sessionId: resume };
    };
    try {
      if (this.opts.requireOwnedGroup) {
        const proof = await AcpOwnedGroup.capture(proc);
        this.ownedGroup = { proc, proof };
        if (this.proc !== proc || this.stopping) throw new Error("Configured ACP process ownership could not be verified");
      }
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${this.id} did not complete the ACP handshake within ${HANDSHAKE_MS / 1000} s`)), HANDSHAKE_MS).unref();
      });
      const session = await Promise.race([handshake(), timeout]);
      if (this.nativePolicy !== undefined && (typeof session?.sessionId !== "string" || !session.sessionId.trim()
        || Buffer.byteLength(session.sessionId) > 4096 || /[\p{Cc}\p{Cf}]/u.test(session.sessionId))) {
        throw new Error("Configured ACP did not provide a valid native session identity");
      }
      this.sessionId = session.sessionId;
      const modes: unknown = session.modes?.availableModes;
      this.availableModes = new Set(Array.isArray(modes) ? modes.flatMap((mode) => typeof mode?.id === "string" ? [mode.id] : []) : []);
      // A recovered session can retain a previous runtime opt-in. An advertised non-default mode
      // must be reset for the configured ask default before any prompt; a fresh ask session stays untouched.
      const resetResumed = this.opts.resumeSessionId && typeof session.modes?.currentModeId === "string" && session.modes.currentModeId !== KIMI_MODE_IDS.ask;
      // Other ACP vendors retain their native policy, including reported non-default modes on resume.
      if (this.nativePolicy?.lockedReadOnly) await this.applyNativeMode(this.nativePolicy.readOnly, "ask");
      else if (this.nativePolicy?.modes !== undefined || this.qwenAgent || (this.kimiAgent && (this.permissionMode !== "ask" || resetResumed))) await this.setPermissionMode(this.permissionMode);
      if (this.opts.requireOwnedGroup) {
        const owned = this.ownedGroup;
        if (!owned || owned.proc !== proc || this.proc !== proc || this.stopping) throw new Error("Configured ACP process ownership could not be verified");
        await owned.proof.verify();
        if (this.proc !== proc || this.stopping) throw new Error("Configured ACP process ownership could not be verified");
      }
    } catch (e) {
      this.setState("offline");
      if (this.proc === proc) {
        if (this.opts.requireOwnedGroup) {
          const owned = this.ownedGroup;
          if (owned?.proc === proc) {
            await owned.proof.stop().then(() => { if (this.proc === proc) { this.proc = undefined; this.ownedGroup = undefined; } }, () => this.opts.log?.("Configured ACP process group shutdown incomplete"));
          } else {
            proc.stdin.end(); // No ownership proof: only close our pipe, never fall back to signals or tree discovery.
            if (await AcpOwnedGroup.confirmGone(proc) && this.proc === proc) { this.proc = undefined; this.ownedGroup = undefined; }
            else this.opts.log?.("Configured ACP process ownership could not be verified; no process signals were sent");
          }
        } else await stopOwnedProcess(proc, { group: true }).then(() => { if (this.proc === proc) this.proc = undefined; }, (stop: Error) => this.opts.log?.(`[${this.id}] ${stop.message}`));
      }
      throw e;
    }
    this.setState("idle");
  }

  getPermissionMode(): PermissionMode { return this.permissionMode; }

  /** Whether this peer's permission requests pass through an always-ask gate (#636). */
  get actionGated(): boolean { return this.opts.actionGate !== undefined; }
  /** Offline does not certify shutdown: retain the original runtime until its owned group is confirmed gone. */
  get pendingOwnedProcess(): boolean { return this.opts.requireOwnedGroup === true && this.proc !== undefined; }
  get permissionModeState(): PermissionMode | "unknown" | "unmanaged" {
    return this.nativePolicy?.lockedReadOnly || this.nativePolicy?.modes !== undefined || this.kimiAgent || this.qwenAgent
      ? this.modeUnknown ? "unknown" : this.permissionMode : "unmanaged";
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.nativePolicy?.lockedReadOnly) throw new Error(`${this.id} permission mode is locked read-only; runtime changes are refused`);
    const modes = this.nativePolicy !== undefined ? this.nativePolicy.modes : this.qwenAgent ? QWEN_MODE_IDS : this.kimiAgent ? KIMI_MODE_IDS : undefined;
    if (modes === undefined) throw new Error(`${this.id} permission mode ${mode} unmanaged: this ACP agent has no verified mode mapping; use Kimi Code CLI or add an agent-specific mapping`);
    await this.applyNativeMode(modes[mode], mode);
  }

  private async applyNativeMode(id: string | undefined, mode: PermissionMode): Promise<void> {
    if (this.modeUnknown) throw new Error(`${this.id} permission mode unknown after an unanswered change; restart the peer before changing modes`);
    if (typeof id !== "string" || !id || !this.sessionId || !this.proc || !this.availableModes.has(id)) throw new Error(`${this.id} permission mode ${mode} unavailable: session does not offer ${id}`);
    try {
      await this.request("session/set_mode", { sessionId: this.sessionId, modeId: id }, this.opts.permissionModeTimeoutMs ?? HANDSHAKE_MS);
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        // No reply means the native mode may have changed. Invalidate the turn before stopping
        // our verified process group; neither a late prompt result nor a late mode ack restores idle.
        this.modeUnknown = true;
        this.turn++;
        this.setState("offline");
        await this.stop().catch((stop: Error) => this.opts.log?.(`[${this.id}] ${stop.message}`));
        throw new Error(this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP native permission mode unknown; peer is offline, restart it before sending work" : `${this.id} permission mode ${mode} unknown: ${error.message}; peer is offline, restart it before sending work`);
      }
      throw new Error(this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP native permission mode refused" : `${this.id} permission mode ${mode} refused: ${(error as Error).message}`);
    }
    // A mode reply after a cancelled prompt must also observe its queued cleanup.
    if (this.cancelWait?.reported) await this.cancelWait.released;
    if (this.modeUnknown) throw new Error(`${this.id} permission mode unknown; restart the peer`);
    this.permissionMode = mode;
  }

  async stop(reason?: string): Promise<void> {
    if (this.activityOpen) this.endActivity("stopped", true);
    this.stopping = true;
    this.cancelPermissions();
    this.clearCancelWait();
    const legacy = this.activeLegacy;
    this.activeLegacy = undefined;
    // Journal-less work has no durable receipt: return it before a requested stop
    // invalidates its generation, while stopping still prevents a drain.
    if (legacy?.turn === this.turn) this.onFailed?.(legacy.envs);
    if (reason !== undefined) this.turn++; // a requested stop cannot escalate or complete the cancelled turn
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: reason ?? "ACP session stopped before settlement" });
    this.settleSteers("needs_review", reason ?? "ACP session stopped before settlement");
    this.activeDeliveryId = undefined;
    const proc = this.proc;
    if (!proc) { this.setState("offline"); return; }
    if (this.opts.requireOwnedGroup) {
      this.setState("offline");
      const owned = this.ownedGroup;
      if (!owned) {
        if (await AcpOwnedGroup.confirmGone(proc) && this.proc === proc) { this.proc = undefined; return; }
        throw new Error("Configured ACP process ownership could not be verified");
      }
      if (owned.proc !== proc) throw new Error("Configured ACP process ownership could not be verified");
      await owned.proof.stop();
      if (this.ownedGroup === owned) this.ownedGroup = undefined;
    } else await stopOwnedProcess(proc, { group: true }); // Builtins keep their existing verified descendant-tree stop.
    if (this.proc === proc) this.proc = undefined;
    this.setState("offline");
  }

  /** Resolves once the prompt is in flight; the turn result arrives on its own. */
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle" || this.stopping) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const turn = ++this.turn;
    this.activeDeliveryId = deliveryId;
    this.activeLegacy = deliveryId ? undefined : { turn, envs };
    this.turnEnvs = envs; this.steerIds = [];
    this.deliveryAccepted = false;
    this.promptActivity = false;
    this.chunks = [];
    this.openTools.clear();
    this.activityOpen = true;
    this.activityPrivate = envs.some(env => env.private === true);
    try { this.activityPrivate ||= this.opts.isPrivateTurn?.() === true; } catch { this.activityPrivate = true; }
    this.activityStub = false; this.activityStarted = Date.now();
    this.setState("busy");
    this.emitActivity("delivery", envs.map(env => `${env.from} ${env.id}`).join(", "));

    // session/prompt answers only when the turn ends, so deliver resolves now and failures come back through onFailed.
    const prompt = this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: this.primed || !this.opts.preamble ? renderDigest(envs, this.primed) : `${this.opts.preamble}\n\n${renderDigest(envs, false)}` }] });
    const reported = () => { if (this.cancelWait?.turn === turn) this.cancelWait.reported = true; };
    void prompt.then(reported, reported);
    prompt
      .then((result) => {
        if (turn !== this.turn) return; // superseded: these chunks belong to a later turn
        // This prompt has reported. A synchronous observer stop must not return
        // completed work as if its native request were still in flight.
        if (this.activeLegacy?.turn === turn) this.activeLegacy = undefined;
        this.endActivity(typeof result?.stopReason === "string" ? result.stopReason : "unknown", result?.stopReason === "cancelled");
        this.observeUsage(result, "prompt_result");
        this.primed = true;
        const body = this.chunks.join("").trim();
        // What was steered into the turn is answered by it too: its senders hear back, and the hop cap still holds.
        const answering = this.turnEnvs.length ? this.turnEnvs : envs;
        if (body) this.onMessage?.(body, { inReplyTo: replyParent(answering), to: replyAudience(answering) });
        // Partial output cannot certify normal completion (#160).
        if (result?.stopReason !== "end_turn") this.reportTurnFailure(envs, `ACP prompt ended without normal completion (${String(result?.stopReason ?? "unknown")})`);
        if (deliveryId && this.activeDeliveryId === deliveryId) {
          this.acceptDelivery();
          this.delivery({ id: deliveryId, state: result?.stopReason === "end_turn" ? "completed" : "needs_review", ...(result?.stopReason === "end_turn" ? {} : { reason: "ACP prompt ended without normal completion" }) });
        }
        this.settleSteers(result?.stopReason === "end_turn" ? "completed" : "needs_review", "ACP prompt ended without normal completion");
      })
      .catch((e: Error) => {
        if (turn !== this.turn) {
          if (this.cancelWait?.turn === turn) this.opts.log?.(this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP cancelled prompt rejected; native details withheld" : `[${this.id}] cancelled prompt rejected: ${sanitize(e.message)}`);
          return; // cancelled prompt errors are discarded, like their late results
        }
        this.endActivity("failed", true);
        const reason = this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP prompt failed" : sanitize(e.message);
        this.settleSteers("needs_review", reason);
        this.opts.log?.(this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP prompt failed; native details withheld" : `[${this.id}] prompt failed: ${reason}`);
        const quota = !this.stopping && this.kimiAgent ? acpQuotaRefusal(e.message) : undefined;
        if (quota) {
          let paused = false;
          try { paused = this.opts.onQuotaRefusal?.(quota) === true; }
          catch (error) { this.opts.log?.(`[${this.id}] quota pause failed: ${sanitize(error instanceof Error ? error.message : String(error))}`); }
          const safe = paused && !this.deliveryAccepted && !this.promptActivity;
          if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: safe ? "failed_safe" : "needs_review", reason, ...(safe ? { quota: true as const } : {}) });
          else if (!deliveryId && this.activeLegacy?.turn === turn) { this.activeLegacy = undefined; this.onFailed?.(envs, safe ? { quota: true } : undefined); }
          return; // quota relay owns reassignment, not the ordinary turn-failure path
        }
        this.reportTurnFailure(envs, reason);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason });
        else if (!deliveryId && this.activeLegacy?.turn === turn) { this.activeLegacy = undefined; this.onFailed?.(envs); }
      })
      .finally(() => {
        const waiting = this.cancelWait;
        if (waiting?.turn === turn) {
          this.clearCancelWait();
          if (!this.stopping && this.turn === waiting.successor && this.state === "busy") this.setState("idle");
          return;
        }
        if (turn === this.turn && !this.stopping && this.state === "busy") this.setState("idle");
        if (this.activeLegacy?.turn === turn) this.activeLegacy = undefined;
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
  }

  private reportTurnFailure(envs: Envelope[], reason: string): void {
    try {
      const result = this.opts.onTurnFailure?.(envs, this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? "Configured ACP prompt failed" : reason);
      if (result) void result.catch(() => this.opts.log?.("ACP failure handoff could not be completed"));
    } catch {
      this.opts.log?.("ACP failure handoff could not be completed");
    }
  }

  protected override onWatchdog(): void {
    if (this.state !== "busy") return;
    if (this.cancelWait) { this.clearWatchdog(); return; }
    // #542 D4: a tool call that started and has not finished is running, not silent, up to its own ceiling.
    if (this.openTools.size) {
      const ceiling = Math.max(this.watchdogMs, this.opts.toolCeilingMs ?? TOOL_CEILING_MS);
      const remaining = ceiling - (Date.now() - this.lastSignAt);
      if (remaining > 0) { this.touch(Math.min(this.watchdogMs, remaining)); return; }
      // Privacy latches for the turn and fails closed, as in emitActivity; the title is agent-written, so one quoted line.
      try { this.activityPrivate ||= this.opts.isPrivateTurn?.() === true; } catch { this.activityPrivate = true; }
      const tools = this.activityPrivate ? "a tool call" : [...new Set(this.openTools.values())].map(title => JSON.stringify(activityText(title).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, 80))).join(", ");
      this.opts.log?.(`[${this.id}] open tool call (${tools}) silent past the ${Math.round(ceiling / 60_000)} min tool ceiling; cancelling the turn`);
    }
    this.endActivity("watchdog cancelled", true);
    const cancelledTurn = this.turn;
    this.cancelPermissions();
    this.activeLegacy = undefined; // the cancelled prompt is discarded, never returned by a later stop
    const durable = !!this.activeDeliveryId;
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "ACP turn watchdog timeout" });
    this.settleSteers("needs_review", "ACP turn watchdog timeout");
    this.activeDeliveryId = undefined;
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.turn++; // whatever the cancelled prompt still reports is stale
    // ACP updates carry only a session ID, not a turn ID. After a durable turn times out,
    // keep the adapter offline until it is restarted so late chunks cannot contaminate a new turn.
    if (durable) this.setState("offline");
    else {
      this.clearWatchdog(); // waiting for cancellation is not a second inactive model turn
      const successor = this.turn;
      const timer = setTimeout(() => {
        const waiting = this.cancelWait;
        if (!waiting || waiting.turn !== cancelledTurn || waiting.successor !== successor) return;
        this.clearCancelWait();
        if (!this.stopping && this.turn === successor) {
          this.setState("offline"); // keep queued work until restart
          this.opts.log?.(`[${this.id}] cancelled prompt did not report within the cancellation deadline; peer offline, queued work retained; stop and restart the peer to resume delivery`);
        }
      }, this.opts.cancelWaitMs ?? HANDSHAKE_MS);
      timer.unref?.();
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      this.cancelWait = { turn: cancelledTurn, successor, timer, reported: false, released, release };
    }
  }

  private clearCancelWait(): void {
    const waiting = this.cancelWait;
    this.cancelWait = undefined;
    if (waiting) { clearTimeout(waiting.timer); waiting.release(); }
  }

  private observeUsage(value: unknown, source: ACPUsageDiagnostic["source"]): void {
    const observation = normalizeACPUsage(value, source);
    this.opts.onUsageDiagnostic?.(observation, this.sessionId);
    if (observation.availability === "known") this.opts.onTokens?.(observation.total!, this.sessionId);
  }

  /** The running turn's generation, for a transport that must adopt into exactly this turn after an async step (#572). */
  protected currentTurn(): number { return this.turn; }

  /**
   * A transport that took envelopes into the running turn (#572) reports them here, once it has acknowledged them. The
   * turn now answers their senders too, and their receipts settle with the turn: completed on a normal end, held for
   * review on anything else. Only the busy turn the caller named (`currentTurn()` before sending) can adopt.
   */
  protected adoptIntoTurn(turn: number, envs: Envelope[], deliveryId?: string): void {
    // Fenced to the exact turn the caller saw before it sent anything: a later turn on the same session is never adopted into.
    if (turn !== this.turn || this.state !== "busy" || this.cancelWait || this.stopping) throw new Error(`${this.id} is ${this.state}, or its turn changed`);
    this.turnEnvs = [...this.turnEnvs, ...envs];
    this.activityPrivate ||= envs.some(env => env.private === true);
    this.primed = true;
    if (deliveryId) { this.steerIds.push(deliveryId); this.delivery({ id: deliveryId, state: "accepted" }); }
  }

  private settleSteers(state: "completed" | "needs_review", reason?: string): void {
    const ids = this.steerIds; this.steerIds = [];
    for (const id of ids) this.delivery({ id, state, ...(state === "needs_review" ? { reason: reason ?? "steered turn did not complete normally" } : {}) });
  }

  private acceptDelivery(): void {
    if (!this.activeDeliveryId || this.deliveryAccepted) return;
    this.deliveryAccepted = true;
    this.delivery({ id: this.activeDeliveryId, state: "accepted" });
  }

  private down(reason: string): void {
    this.clearCancelWait();
    if (this.nativePolicy !== undefined || this.opts.requireOwnedGroup) reason = "Configured ACP transport stopped";
    this.opts.log?.(`[${this.id}] ${reason}`);
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason });
    this.settleSteers("needs_review", reason);
    this.activeDeliveryId = undefined;
    this.setState("offline");
  }

  private onLine(line: string): void {
    if (this.stopping) return; // buffered native callbacks cannot recreate approvals after peer_stop
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (this.state === "busy" && !this.cancelWait) { this.lastSignAt = Date.now(); this.touch(); }

    if (msg.method === "session/update") {
      if (msg.params?.sessionId && msg.params.sessionId !== this.sessionId) return;
      const u = msg.params?.update;
      // Occupancy is the session's, not the turn's: 2.1.1's source text emits usage_update after the prompt
      // resolves, when the peer may already be idle (read from the source, not observed live; #285). So a
      // context-used update is accepted while idle too, but then it must name the current session; in a turn the
      // lenient session check above stands, as before. Every other update stays behind the busy gate, and a
      // watchdog-cancelled turn's late chunks still lose their turn (the prompt result path is turn-fenced); an
      // occupancy reading carries no turn state.
      if (u?.sessionUpdate === "usage_update" && this.state !== "offline") {
        const observation = normalizeACPUsage(u, "usage_update");
        if (observation.shape === "context-used") {
          if ((this.state === "busy" && !this.cancelWait) || msg.params?.sessionId === this.sessionId) this.opts.onUsageDiagnostic?.(observation, this.sessionId);
          return;
        }
      }
      if (this.state !== "busy" || this.cancelWait) return;
      this.promptActivity = true;
      this.acceptDelivery();
      this.updateWatch(u);
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") this.chunks.push(u.content.text);
      // The permission request that follows may carry no `rawInput` (Kimi 2.0.1 does not), and then the
      // console would be asked to approve a bare tool name. Keep what the call said it would run (issue #31).
      // Kimi 2.1.1 sends no rawInput before the answer either: the argument JSON streams as content text (issue #72).
      else if ((u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
        // A new call starts clean, so a reused id can never show the arguments or identity of the call before it.
        if (u.sessionUpdate === "tool_call") (this.toolInputs.delete(u.toolCallId), this.toolText.delete(u.toolCallId), this.toolTitles.delete(u.toolCallId));
        if (u.rawInput !== undefined) this.toolInputs.set(u.toolCallId, u.rawInput);
        // Identity is bound at the announcement only: a later update's display title is mutable and must
        // never rewrite what the call was announced as (#138 review).
        if (u.sessionUpdate === "tool_call" && typeof u.title === "string") this.toolTitles.set(u.toolCallId, u.title);
        const text = Array.isArray(u.content) ? u.content.map((c: any) => (c?.type === "content" && c.content?.type === "text" ? String(c.content.text) : "")).join("") : "";
        if (text) this.toolText.set(u.toolCallId, text);
        if (u.status === "completed" || u.status === "failed") (this.toolInputs.delete(u.toolCallId), this.toolText.delete(u.toolCallId), this.toolTitles.delete(u.toolCallId), this.openTools.delete(u.toolCallId));
        else if (u.sessionUpdate === "tool_call" || this.openTools.has(u.toolCallId)) this.openTools.set(u.toolCallId, this.toolTitles.get(u.toolCallId) ?? "tool");
        while (this.openTools.size > TOOL_INPUT_CAP) this.openTools.delete(this.openTools.keys().next().value as string);
        for (const map of [this.toolInputs, this.toolText, this.toolTitles]) while (map.size > TOOL_INPUT_CAP) map.delete(map.keys().next().value as string);
      }
      else if (u?.sessionUpdate === "usage_update") this.observeUsage(u, "usage_update");
    } else if (msg.method === "session/request_permission") {
      if (this.cancelWait || this.state === "offline") { this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }); return; }
      if (this.state === "busy" && (!msg.params?.sessionId || msg.params.sessionId === this.sessionId)) this.promptActivity = true;
      void this.answerPermission(msg);
    } else if (msg.method && msg.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported by agent-hub" } });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? "rpc error"));
      else p?.resolve(msg.result);
    }
  }

  private async answerPermission(msg: any): Promise<void> {
    this.flushActivity();
    const call = msg.params?.toolCall ?? {};
    const kind = typeof call.kind === "string" ? call.kind : undefined;
    if (this.nativePolicy?.lockedReadOnly && !["read", "search", "think"].includes(kind ?? "")) {
      const rejected = (msg.params?.options ?? []).find((option: PermissionOption) => option.kind === "reject_once");
      return this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: rejected ? { outcome: "selected", optionId: rejected.optionId } : { outcome: "cancelled" } } });
    }
    const once = (msg.params?.options ?? []).find((o: PermissionOption) => o.kind === "allow_once");
    const id = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
    const announced = id === undefined ? undefined : this.toolTitles.get(id);
    // Qwen 0.24.7 announces an MCP call as `<tool> (<server> MCP Server)` and then titles the permission
    // request with the serialized arguments (#138). Identity comes back from the announced title, bound to
    // the call id, and only when the server half is a server this session was configured with: the canonical
    // `mcp__<server>__<tool>` name is the only derived candidate the exact-match whitelist ever sees, and
    // argument text is never one.
    const canonical = canonicalMcpToolName(announced, this.opts.mcpServers?.map((s) => s.name));
    // Configured ACP titles are not trusted MCP identity, even when they spell a hub tool exactly.
    const identity = this.nativePolicy !== undefined || this.opts.requireOwnedGroup ? undefined
      : [typeof call.title === "string" ? call.title : undefined, canonical].find((candidate) => candidate !== undefined && this.opts.autoApprove?.(candidate));
    // Always-ask (#636): classed before anything may answer for the person. A call whose arguments the agent did not report is not classed
    // (unknown follows the permission mode); a classed call is never auto-approved, whatever its title says.
    const rawInput = call.rawInput ?? (id === undefined ? undefined : this.toolInputs.get(id) ?? jsonObject(this.toolText.get(id)));
    let gate: ActionGateVerdict | undefined;
    try {
      gate = rawInput === undefined || !this.sessionId ? undefined : this.opts.actionGate?.({ names: [call.title, announced, canonical].filter((name): name is string => typeof name === "string"), ...(kind ? { kind } : {}), input: rawInput }, this.sessionId);
    } catch { gate = { title: "Action approval: the always-ask check failed; command withheld", denyOnly: true }; } // a failing gate asks, never allows
    if (once && identity && !gate) {
      this.opts.log?.(`permission auto-approved for ${this.id}: ${identity}`); // the name only: arguments may quote a PII turn
      this.emitActivity("ask", `${String(msg.id)}: ${activityText(announced ?? call.title)} (automatic)`);
      this.emitActivity("answered", `${String(msg.id)}: allow_once (automatic)`);
      return this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: once.optionId } } });
    }
    // The approver has to see what runs, not only the tool's name ("Bash"). The request itself carries it
    // for some agents; for the rest it was on the `tool_call` update that announced the call, as rawInput or,
    // failing that, as streamed argument text that only counts once it is a complete JSON object.
    const raw = rawInput;
    const full = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
    // A cut payload hides its tail, and a tail can change what runs: it is marked and buys no session-wide grant.
    const cut = full.length > 600;
    const input = raw === undefined ? "" : `: ${cut ? `${full.slice(0, 600)} [cut, ${full.length} chars]` : full}`;
    // A request titled with the argument JSON is no title at all: display what the call was announced as.
    const named = typeof call.title === "string" && jsonObject(call.title) === undefined ? call.title : announced;
    // An unknown payload is never dressed up as a description, and it must not buy a blanket grant.
    const title: string = gate ? gate.title : raw === undefined ? `${named ?? "tool call"} (payload not reported by the agent)` : `${named ?? "tool call"}${input}`;
    this.emitActivity("ask", `${String(msg.id)}: ${activityText(title)}; answer in ahub console`);
    let options: PermissionOption[] = (msg.params?.options ?? []).filter((o: PermissionOption) => o.kind !== "allow_always" || !gate && !this.nativePolicy?.lockedReadOnly && raw !== undefined && !cut);
    if (gate?.denyOnly) options = options.filter(o => o.kind === "reject_once" || o.kind === "reject_always");
    // The class-budget choice is the hub's own option: answered to the agent as its allow_once once the ledger has recorded the grant.
    const budgetOption: PermissionOption | undefined = !gate?.denyOnly && gate?.budget && once ? { optionId: ACTION_BUDGET_OPTION, name: `Allow ${gate.budget.label} for this session`, kind: "allow_once" } : undefined;
    if (budgetOption) options = [...options, budgetOption];
    // Only a bare tool name travels on its own (a desktop notice shows it); anything prose-like stays in the title.
    const tool = typeof named === "string" && /^[\w.:@-]{1,80}$/.test(named) ? named : undefined;
    // Waiting for a person is not the agent going silent: keep the watchdog from cancelling the turn meanwhile.
    const turn = this.turn;
    const alive = setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), Math.max(10, Math.min(30_000, Math.floor(this.watchdogMs / 3))));
    const controller = new AbortController();
    this.permissionWaits.add(controller);
    let picked: string | undefined;
    try {
      const cancelled = new Promise<undefined>(resolve => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      picked = await Promise.race([this.opts.onPermission?.({ peer: this.id, title, options, ...(tool ? { tool } : {}), ...(kind ? { kind } : {}), ...(gate ? { classed: true as const } : {}) }, controller.signal).catch(() => undefined), cancelled]);
    } finally {
      clearInterval(alive); // also when there is no handler at all
      this.permissionWaits.delete(controller);
    }
    let valid = !controller.signal.aborted && this.state !== "offline" && turn === this.turn && !this.stopping && options.some((o) => o.optionId === picked);
    let answer = picked;
    // A class-budget grant is recorded only for a still-current session and policy; if the ledger refuses it, nothing is allowed (fail closed).
    if (valid && budgetOption && picked === budgetOption.optionId) {
      let granted = false;
      try { granted = gate!.budget!.approve(); } catch { /* not granted */ }
      if (granted && once) answer = once.optionId; else valid = false;
    }
    if (turn === this.turn) this.emitActivity("answered", `${String(msg.id)}: ${valid ? options.find(o => o.optionId === picked)?.kind : "cancelled"}`);
    this.send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { outcome: valid ? { outcome: "selected", optionId: answer } : { outcome: "cancelled" } },
    });
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(`${method} did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      timer?.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    if (this.proc?.stdin.writable) this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }
}

export function isAcpPeer(value: unknown): value is AcpPeer {
  return value instanceof AcpPeer;
}
