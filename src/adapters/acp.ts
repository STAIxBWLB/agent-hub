import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { framed, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}
export interface PermissionRequest {
  peer: PeerId;
  title: string;
  options: PermissionOption[];
}

export interface AcpOptions {
  /** e.g. ["kimi", "acp"]. `opencode acp` fits the same adapter. */
  cmd: string[];
  cwd: string;
  watchdogMs?: number;
  /** Resolve with an optionId, or undefined to cancel. Absent = every request is cancelled. */
  onPermission?: (req: PermissionRequest) => Promise<string | undefined>;
  log?: (line: string) => void;
}

const HANDSHAKE_MS = 30_000;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** ACP client (JSON-RPC 2.0, newline-delimited, over the child's stdio). One session, one prompt in flight. */
export class AcpPeer extends BasePeer {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private sessionId = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private primed = false;
  private turn = 0; // generation: a prompt cancelled by the watchdog must not touch the turn that followed it

  constructor(
    id: PeerId,
    private readonly opts: AcpOptions,
  ) {
    super(id, opts.watchdogMs);
  }

  async start(): Promise<void> {
    const [bin, ...args] = this.opts.cmd;
    const proc = spawn(bin!, args, { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
      return this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] });
    };
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${this.id} did not complete the ACP handshake within ${HANDSHAKE_MS / 1000} s`)), HANDSHAKE_MS).unref();
    });
    try {
      this.sessionId = (await Promise.race([handshake(), timeout])).sessionId;
    } catch (e) {
      proc.kill();
      throw e;
    }
    this.setState("idle");
  }

  async stop(): Promise<void> {
    this.proc?.kill();
  }

  /** Resolves once the prompt is in flight; the turn result arrives on its own. */
  async deliver(env: Envelope): Promise<void> {
    if (this.state !== "idle") throw new Error(`${this.id} is ${this.state}`);
    const turn = ++this.turn;
    this.chunks = [];
    this.setState("busy");
    // session/prompt answers only when the turn ends, so deliver resolves now and failures come back through onFailed.
    this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: framed(env, this.primed) }] })
      .then(() => {
        this.primed = true;
        if (turn !== this.turn) return; // superseded: these chunks belong to a later turn
        const body = this.chunks.join("").trim();
        if (body) this.onMessage?.(body, { inReplyTo: env });
      })
      .catch((e: Error) => {
        this.opts.log?.(`[${this.id}] prompt failed: ${e.message}`);
        this.onFailed?.(env);
      })
      .finally(() => {
        if (turn === this.turn && this.state === "busy") this.setState("idle");
      });
  }

  protected override onWatchdog(): void {
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.turn++; // whatever the cancelled prompt still reports is stale
    super.onWatchdog();
  }

  private down(reason: string): void {
    this.opts.log?.(`[${this.id}] ${reason}`);
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
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
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") this.chunks.push(u.content.text);
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
    const options: PermissionOption[] = msg.params?.options ?? [];
    const title: string = msg.params?.toolCall?.title ?? "tool call";
    const picked = await this.opts.onPermission?.({ peer: this.id, title, options }).catch(() => undefined);
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
