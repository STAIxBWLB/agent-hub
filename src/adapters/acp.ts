import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { renderDigest, replyAudience, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import { childEnv, stopOwnedProcess } from "../hub/child-process.ts";

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

export interface AcpOptions {
  /** e.g. ["kimi", "acp"]. `opencode acp` fits the same adapter. */
  cmd: string[];
  /** Coordinator-visible selected model only; contains no prompts or command arguments. */
  launchModel?: string;
  cwd: string;
  /** Optional launch environment; recovery authority is always removed before spawn. */
  env?: NodeJS.ProcessEnv;
  watchdogMs?: number;
  /** ACP stdio MCP servers for the session (the hub's task tools). */
  mcpServers?: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
  /** Appended to the standing instruction of the first delivery (role contract). */
  preamble?: string;
  /** The session's running token total from `usage_update` (inferred shape: totalTokens, else input + output, else `used`). Cumulative, not a delta. */
  onTokens?: (sessionTotal: number) => void;
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
  private proc: ChildProcessWithoutNullStreams | undefined;
  private sessionId = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private readonly toolInputs = new Map<string, unknown>();
  private readonly toolText = new Map<string, string>(); // streamed argument text, per call, until it finishes
  private primed = false;
  private turn = 0; // generation: a prompt cancelled by the watchdog must not touch the turn that followed it
  private activeDeliveryId: string | undefined;
  private deliveryAccepted = false;

  constructor(
    id: PeerId,
    private readonly opts: AcpOptions,
  ) {
    super(id, opts.watchdogMs);
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: { kind: "acp", ...(this.opts.launchModel ? { model: this.opts.launchModel } : {}) }, ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }

  async start(): Promise<void> {
    const [bin, ...args] = this.opts.cmd;
    const proc = spawn(bin!, args, { cwd: this.opts.cwd, env: childEnv({ ...process.env, ...(this.opts.env ?? {}) }), stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.on("error", (e) => this.down(`spawn failed: ${e.message}`));
    proc.on("exit", (code) => this.down(`exited with code ${code}`));
    proc.stdin.on("error", () => {}); // EPIPE from a child that died; `exit` / `error` already report it
    proc.stderr.on("data", (d) => this.opts.log?.(`[${this.id}] ${String(d).trimEnd()}`));
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));

    const handshake = async () => {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      return this.request("session/new", { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
    };
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${this.id} did not complete the ACP handshake within ${HANDSHAKE_MS / 1000} s`)), HANDSHAKE_MS).unref();
    });
    try {
      this.sessionId = (await Promise.race([handshake(), timeout])).sessionId;
    } catch (e) {
      await stopOwnedProcess(proc);
      throw e;
    }
    this.setState("idle");
  }

  async stop(): Promise<void> {
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "ACP session stopped before settlement" });
    this.activeDeliveryId = undefined;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    await stopOwnedProcess(proc);
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
        this.primed = true;
        const body = this.chunks.join("").trim();
        if (body) this.onMessage?.(body, { inReplyTo: replyParent(envs), to: replyAudience(envs) });
        if (deliveryId && this.activeDeliveryId === deliveryId) {
          this.acceptDelivery();
          this.delivery({ id: deliveryId, state: result?.stopReason === "end_turn" ? "completed" : "needs_review", ...(result?.stopReason === "end_turn" ? {} : { reason: "ACP prompt ended without normal completion" }) });
        }
      })
      .catch((e: Error) => {
        this.opts.log?.(`[${this.id}] prompt failed: ${e.message}`);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: e.message });
        else if (!deliveryId) this.onFailed?.(envs);
      })
      .finally(() => {
        if (turn === this.turn && this.state === "busy") this.setState("idle");
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
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
        // A new call starts clean, so a reused id can never show the arguments of the call before it.
        if (u.sessionUpdate === "tool_call") (this.toolInputs.delete(u.toolCallId), this.toolText.delete(u.toolCallId));
        if (u.rawInput !== undefined) this.toolInputs.set(u.toolCallId, u.rawInput);
        const text = Array.isArray(u.content) ? u.content.map((c: any) => (c?.type === "content" && c.content?.type === "text" ? String(c.content.text) : "")).join("") : "";
        if (text) this.toolText.set(u.toolCallId, text);
        if (u.status === "completed" || u.status === "failed") (this.toolInputs.delete(u.toolCallId), this.toolText.delete(u.toolCallId));
        for (const map of [this.toolInputs, this.toolText]) while (map.size > TOOL_INPUT_CAP) map.delete(map.keys().next().value as string);
      }
      else if (u?.sessionUpdate === "usage_update" && this.opts.onTokens) {
        const f = { ...u, ...(typeof u.usage === "object" ? u.usage : {}) } as Record<string, unknown>;
        const num = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : 0);
        const total = num("totalTokens") || num("total_tokens") || num("inputTokens") + num("outputTokens") || num("input_tokens") + num("output_tokens") || num("used");
        if (total > 0) this.opts.onTokens(total);
      }
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
    if (once && typeof call.title === "string" && this.opts.autoApprove?.(call.title)) {
      this.opts.log?.(`permission auto-approved for ${this.id}: ${call.title}`); // the name only: arguments may quote a PII turn
      return this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: once.optionId } } });
    }
    // The approver has to see what runs, not only the tool's name ("Bash"). The request itself carries it
    // for some agents; for the rest it was on the `tool_call` update that announced the call, as rawInput or,
    // failing that, as streamed argument text that only counts once it is a complete JSON object.
    const id = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
    const raw = call.rawInput ?? (id === undefined ? undefined : this.toolInputs.get(id) ?? jsonObject(this.toolText.get(id)));
    const full = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
    // A cut payload hides its tail, and a tail can change what runs: it is marked and buys no session-wide grant.
    const cut = full.length > 600;
    const input = raw === undefined ? "" : `: ${cut ? `${full.slice(0, 600)} [cut, ${full.length} chars]` : full}`;
    // An unknown payload is never dressed up as a description, and it must not buy a blanket grant.
    const title: string = raw === undefined ? `${call.title ?? "tool call"} (payload not reported by the agent)` : `${call.title ?? "tool call"}${input}`;
    const options: PermissionOption[] = (msg.params?.options ?? []).filter((o: PermissionOption) => (raw !== undefined && !cut) || o.kind !== "allow_always");
    // Only a bare tool name travels on its own (a desktop notice shows it); anything prose-like stays in the title.
    const tool = typeof call.title === "string" && /^[\w.:@-]{1,80}$/.test(call.title) ? call.title : undefined;
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

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
