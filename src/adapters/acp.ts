import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { renderDigest, replyAudience, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import { KIMI_MODE_IDS, type PermissionMode } from "../hub/permission-mode.ts";
import { BasePeer } from "../hub/peers.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}
export interface PermissionRequest {
  peer: PeerId;
  title: string;
  options: PermissionOption[];
  /** The tool's name alone, when the adapter knows it apart from the title (which can quote the payload). */
  tool?: string;
}

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
  /** e.g. ["kimi", "acp"]. `opencode acp` fits the same adapter. */
  cmd: string[];
  /** Coordinator-visible selected model only; contains no prompts or command arguments. */
  launchModel?: string;
  permissionMode?: PermissionMode;
  /** Bound for native mode acknowledgement; defaults to the handshake deadline. */
  permissionModeTimeoutMs?: number;
  /** Load this earlier session (ACP `session/load`) instead of starting a new one: crash recovery, issue #37. */
  resumeSessionId?: string;
  cwd: string;
  /** Optional launch environment; recovery authority is always removed before spawn. */
  env?: NodeJS.ProcessEnv;
  watchdogMs?: number;
  /** ACP stdio MCP servers for the session (the hub's task tools). */
  mcpServers?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
  /** Appended to the standing instruction of the first delivery (role contract). */
  preamble?: string;
  /** The session's running token total from `usage_update` (checked totalTokens or input/output pair; `used` context occupancy is diagnostic only). Cumulative, not a delta. */
  onTokens?: (sessionTotal: number, sessionId: string) => void;
  /** The prompt rejected or ended without normal completion, even when it streamed partial text.
   *  Same shape as Pi's onTurnFailure; a stale cancelled turn never reports. */
  onTurnFailure?: (envs: Envelope[], reason: string) => Promise<void> | void;
  onUsageDiagnostic?: (observation: ACPUsageDiagnostic) => void;
  /** Resolve with an optionId, or undefined to cancel. Absent = every request is cancelled.
   *  A request whose payload could not be resolved is titled as such and carries no session-wide allow option. */
  onPermission?: (req: PermissionRequest) => Promise<string | undefined>;
  /** Tool titles approved once without asking: the hub's own tools, as Codex gets them (issue #72). Exact names only. */
  autoApprove?: (toolTitle: string) => boolean;
  log?: (line: string) => void;
}

const HANDSHAKE_MS = 30_000;
/** Tool calls whose arguments are remembered until their permission request arrives. */
const TOOL_INPUT_CAP = 64;

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
  private permissionMode: PermissionMode;
  private modeUnknown = false;
  private kimiAgent = false;
  private availableModes = new Set<string>();
  private proc: ChildProcessWithoutNullStreams | undefined;
  private sessionId = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private readonly toolInputs = new Map<string, unknown>();
  private readonly toolText = new Map<string, string>(); // streamed argument text, per call, until it finishes
  private readonly toolTitles = new Map<string, string>(); // the title a call was announced with, per call id (#138)
  private primed = false;
  private turn = 0; // generation: a prompt cancelled by the watchdog must not touch the turn that followed it
  private activeDeliveryId: string | undefined;
  private deliveryAccepted = false;

  constructor(
    id: PeerId,
    private readonly opts: AcpOptions,
  ) {
    super(id, opts.watchdogMs);
    this.permissionMode = opts.permissionMode ?? "ask";
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: { kind: "acp", ...(this.opts.launchModel ? { model: this.opts.launchModel } : {}) }, ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }

  async start(): Promise<void> {
    const [bin, ...args] = this.opts.cmd;
    // Its own process group, stopped as a whole (#115, as Codex's in #113): an agent CLI may be a launcher with a native child.
    const proc = spawn(bin!, args, { cwd: this.opts.cwd, env: peerChildEnv(this.id, { ...process.env, ...(this.opts.env ?? {}) }), stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.proc = proc;
    trackGroup(proc);
    proc.on("error", (e) => this.down(`spawn failed: ${e.message}`));
    proc.on("exit", (code) => this.down(`exited with code ${code}`));
    proc.stdin.on("error", () => {}); // EPIPE from a child that died; `exit` / `error` already report it
    proc.stderr.on("data", (d) => this.opts.log?.(`[${this.id}] ${String(d).trimEnd()}`));
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));

    const handshake = async () => {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      // The configured peer id and command are labels, not an agent-specific mode contract.
      // Installed Kimi Code CLI's ACP initialize advertises this exact name.
      this.kimiAgent = init?.agentInfo?.name === "Kimi Code CLI";
      const resume = this.opts.resumeSessionId;
      if (!resume) return this.request("session/new", { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
      // The agent replays the session as updates while it loads; they arrive before the peer is idle, so none of
      // them is taken for an answer.
      if (!init?.agentCapabilities?.loadSession) throw new Error(`${this.id} cannot load an earlier session (the agent offers no loadSession)`);
      const loaded = await this.request("session/load", { sessionId: resume, cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
      return { ...loaded, sessionId: resume };
    };
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${this.id} did not complete the ACP handshake within ${HANDSHAKE_MS / 1000} s`)), HANDSHAKE_MS).unref();
    });
    try {
      const session = await Promise.race([handshake(), timeout]);
      this.sessionId = session.sessionId;
      const modes: unknown = session.modes?.availableModes;
      this.availableModes = new Set(Array.isArray(modes) ? modes.flatMap((mode) => typeof mode?.id === "string" ? [mode.id] : []) : []);
      // A recovered session can retain a previous runtime opt-in. An advertised non-default mode
      // must be reset for the configured ask default before any prompt; a fresh ask session stays untouched.
      const resetResumed = this.opts.resumeSessionId && typeof session.modes?.currentModeId === "string" && session.modes.currentModeId !== KIMI_MODE_IDS.ask;
      // Other ACP vendors retain their native policy, including reported non-default modes on resume.
      if (this.kimiAgent && (this.permissionMode !== "ask" || resetResumed)) await this.setPermissionMode(this.permissionMode);
    } catch (e) {
      this.setState("offline");
      if (this.proc === proc) {
        await stopOwnedProcess(proc, { group: true }).then(() => { if (this.proc === proc) this.proc = undefined; }, (stop: Error) => this.opts.log?.(`[${this.id}] ${stop.message}`));
      }
      throw e;
    }
    this.setState("idle");
  }

  getPermissionMode(): PermissionMode { return this.permissionMode; }
  get permissionModeState(): PermissionMode | "unknown" | "unmanaged" {
    return !this.kimiAgent ? "unmanaged" : this.modeUnknown ? "unknown" : this.permissionMode;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.kimiAgent) throw new Error(`${this.id} permission mode ${mode} unmanaged: this ACP agent has no verified mode mapping; use Kimi Code CLI or add an agent-specific mapping`);
    if (this.modeUnknown) throw new Error(`${this.id} permission mode unknown after an unanswered change; restart the peer before changing modes`);
    const id = KIMI_MODE_IDS[mode];
    if (!this.sessionId || !this.proc || !this.availableModes.has(id)) throw new Error(`${this.id} permission mode ${mode} unavailable: session does not offer ${id}`);
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
        throw new Error(`${this.id} permission mode ${mode} unknown: ${error.message}; peer is offline, restart it before sending work`);
      }
      throw new Error(`${this.id} permission mode ${mode} refused: ${(error as Error).message}`);
    }
    if (this.modeUnknown) throw new Error(`${this.id} permission mode unknown; restart the peer`);
    this.permissionMode = mode;
  }

  async stop(): Promise<void> {
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "ACP session stopped before settlement" });
    this.activeDeliveryId = undefined;
    const proc = this.proc;
    if (!proc) return;
    await stopOwnedProcess(proc, { group: true }); // also when it exited: what it left in its group fails the stop
    if (this.proc === proc) this.proc = undefined;
  }

  /** Resolves once the prompt is in flight; the turn result arrives on its own. */
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle") {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const turn = ++this.turn;
    this.activeDeliveryId = deliveryId;
    this.deliveryAccepted = false;
    this.chunks = [];
    this.setState("busy");
    // session/prompt answers only when the turn ends, so deliver resolves now and failures come back through onFailed.
    const prompt = this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: this.primed || !this.opts.preamble ? renderDigest(envs, this.primed) : `${this.opts.preamble}\n\n${renderDigest(envs, false)}` }] });
    prompt
      .then((result) => {
        if (turn !== this.turn) return; // superseded: these chunks belong to a later turn
        this.observeUsage(result, "prompt_result");
        this.primed = true;
        const body = this.chunks.join("").trim();
        if (body) this.onMessage?.(body, { inReplyTo: replyParent(envs), to: replyAudience(envs) });
        // Partial output cannot certify normal completion (#160).
        if (result?.stopReason !== "end_turn") this.reportTurnFailure(envs, `ACP prompt ended without normal completion (${String(result?.stopReason ?? "unknown")})`);
        if (deliveryId && this.activeDeliveryId === deliveryId) {
          this.acceptDelivery();
          this.delivery({ id: deliveryId, state: result?.stopReason === "end_turn" ? "completed" : "needs_review", ...(result?.stopReason === "end_turn" ? {} : { reason: "ACP prompt ended without normal completion" }) });
        }
      })
      .catch((e: Error) => {
        this.opts.log?.(`[${this.id}] prompt failed: ${e.message}`);
        if (turn === this.turn) this.reportTurnFailure(envs, e.message); // a watchdog-cancelled turn reports stale, never as this turn's failure
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: e.message });
        else if (!deliveryId) this.onFailed?.(envs);
      })
      .finally(() => {
        if (turn === this.turn && this.state === "busy") this.setState("idle");
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
  }

  private reportTurnFailure(envs: Envelope[], reason: string): void {
    try {
      const result = this.opts.onTurnFailure?.(envs, reason);
      if (result) void result.catch(() => this.opts.log?.("ACP failure handoff could not be completed"));
    } catch {
      this.opts.log?.("ACP failure handoff could not be completed");
    }
  }

  protected override onWatchdog(): void {
    const durable = !!this.activeDeliveryId;
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "ACP turn watchdog timeout" });
    this.activeDeliveryId = undefined;
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.turn++; // whatever the cancelled prompt still reports is stale
    // ACP updates carry only a session ID, not a turn ID. After a durable turn times out,
    // keep the adapter offline until it is restarted so late chunks cannot contaminate a new turn.
    if (durable) this.setState("offline");
    else super.onWatchdog();
  }

  private observeUsage(value: unknown, source: ACPUsageDiagnostic["source"]): void {
    const observation = normalizeACPUsage(value, source);
    this.opts.onUsageDiagnostic?.(observation);
    if (observation.availability === "known") this.opts.onTokens?.(observation.total!, this.sessionId);
  }

  private acceptDelivery(): void {
    if (!this.activeDeliveryId || this.deliveryAccepted) return;
    this.deliveryAccepted = true;
    this.delivery({ id: this.activeDeliveryId, state: "accepted" });
  }

  private down(reason: string): void {
    this.opts.log?.(`[${this.id}] ${reason}`);
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason });
    this.activeDeliveryId = undefined;
    this.setState("offline");
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (this.state === "busy") this.touch();

    if (msg.method === "session/update") {
      if (msg.params?.sessionId && msg.params.sessionId !== this.sessionId) return;
      if (this.state !== "busy") return;
      this.acceptDelivery();
      const u = msg.params?.update;
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
        if (u.status === "completed" || u.status === "failed") (this.toolInputs.delete(u.toolCallId), this.toolText.delete(u.toolCallId), this.toolTitles.delete(u.toolCallId));
        for (const map of [this.toolInputs, this.toolText, this.toolTitles]) while (map.size > TOOL_INPUT_CAP) map.delete(map.keys().next().value as string);
      }
      else if (u?.sessionUpdate === "usage_update") this.observeUsage(u, "usage_update");
    } else if (msg.method === "session/request_permission") {
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
    const call = msg.params?.toolCall ?? {};
    const once = (msg.params?.options ?? []).find((o: PermissionOption) => o.kind === "allow_once");
    const id = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
    const announced = id === undefined ? undefined : this.toolTitles.get(id);
    // Qwen 0.24.7 announces an MCP call as `<tool> (<server> MCP Server)` and then titles the permission
    // request with the serialized arguments (#138). Identity comes back from the announced title, bound to
    // the call id, and only when the server half is a server this session was configured with: the canonical
    // `mcp__<server>__<tool>` name is the only derived candidate the exact-match whitelist ever sees, and
    // argument text is never one.
    const canonical = canonicalMcpToolName(announced, this.opts.mcpServers?.map((s) => s.name));
    const identity = [typeof call.title === "string" ? call.title : undefined, canonical].find((candidate) => candidate !== undefined && this.opts.autoApprove?.(candidate));
    if (once && identity) {
      this.opts.log?.(`permission auto-approved for ${this.id}: ${identity}`); // the name only: arguments may quote a PII turn
      return this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: once.optionId } } });
    }
    // The approver has to see what runs, not only the tool's name ("Bash"). The request itself carries it
    // for some agents; for the rest it was on the `tool_call` update that announced the call, as rawInput or,
    // failing that, as streamed argument text that only counts once it is a complete JSON object.
    const raw = call.rawInput ?? (id === undefined ? undefined : this.toolInputs.get(id) ?? jsonObject(this.toolText.get(id)));
    const full = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
    // A cut payload hides its tail, and a tail can change what runs: it is marked and buys no session-wide grant.
    const cut = full.length > 600;
    const input = raw === undefined ? "" : `: ${cut ? `${full.slice(0, 600)} [cut, ${full.length} chars]` : full}`;
    // A request titled with the argument JSON is no title at all: display what the call was announced as.
    const named = typeof call.title === "string" && jsonObject(call.title) === undefined ? call.title : announced;
    // An unknown payload is never dressed up as a description, and it must not buy a blanket grant.
    const title: string = raw === undefined ? `${named ?? "tool call"} (payload not reported by the agent)` : `${named ?? "tool call"}${input}`;
    const options: PermissionOption[] = (msg.params?.options ?? []).filter((o: PermissionOption) => (raw !== undefined && !cut) || o.kind !== "allow_always");
    // Only a bare tool name travels on its own (a desktop notice shows it); anything prose-like stays in the title.
    const tool = typeof named === "string" && /^[\w.:@-]{1,80}$/.test(named) ? named : undefined;
    // Waiting for a person is not the agent going silent: keep the watchdog from cancelling the turn meanwhile.
    const turn = this.turn;
    const alive = setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), Math.max(10, Math.min(30_000, Math.floor(this.watchdogMs / 3))));
    let picked: string | undefined;
    try {
      picked = await this.opts.onPermission?.({ peer: this.id, title, options, ...(tool ? { tool } : {}) }).catch(() => undefined);
    } finally {
      clearInterval(alive); // also when there is no handler at all
    }
    const valid = options.some((o) => o.optionId === picked);
    this.send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { outcome: valid ? { outcome: "selected", optionId: picked } : { outcome: "cancelled" } },
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
