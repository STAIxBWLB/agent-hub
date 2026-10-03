import { spawn, type ChildProcess } from "node:child_process";
import type { Server, ServerWebSocket } from "bun";
import { renderDigest, replyAudience, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import { childEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";

export interface CodexOptions {
  /** Port the TUI attaches to: `codex --enable tui_app_server --remote ws://127.0.0.1:<proxyPort>`. */
  proxyPort: number;
  /** Port for the spawned `codex app-server`. Ignored when `upstreamUrl` is set. */
  appPort: number;
  /** Attach to an already running app-server instead of spawning one (tests). */
  upstreamUrl?: string;
  bin?: string;
  /** Extra `codex app-server` arguments: the `-c mcp_servers.agent-hub.*` overrides that give Codex the hub's task tools. */
  extraArgs?: string[];
  /** Appended to the standing instruction of the first delivery (role contract). */
  preamble?: string;
  /** Raw `rateLimits` snapshots from app-server, and `hard = true` when a turn was refused for quota. */
  onUsage?: (rateLimits: unknown, hard: boolean) => void;
  /** Tokens the thread used since the previous update (see `tokenTotal` for how they are counted). */
  onTokens?: (added: number) => void;
  /** The native id of each turn as it starts, after the peer turned busy (issue #33: `ahub undo --context`). */
  onTurn?: (turnId: string) => void;
  /**
   * Each completed `fileChange`, `commandExecution`, `mcpToolCall` and `userMessage` item, for turn-free facts (issue
   * #108): the first three are boundaries, a `userMessage` is the readback of a steered fact. Codex emits
   * `item/started` about when a command has finished, so only completions are reported. Untyped JSON (hence `any`):
   * the receiver checks every field it reads.
   */
  onItem?: (item: any) => void;
  /** How often to ask app-server for the rate limits while a TUI is attached. */
  usagePollMs?: number;
  /** How long a fact's steer waits for app-server's answer (tests shorten it). */
  steerTimeoutMs?: number;
  cwd: string;
  /** Optional launch environment; recovery authority is always removed before spawn. */
  env?: NodeJS.ProcessEnv;
  watchdogMs?: number;
  log?: (line: string) => void;
}

interface Link {
  tui: ServerWebSocket<Link>;
  up: WebSocket;
  backlog: string[]; // TUI frames that arrived before the upstream socket opened
  tracked: Map<string | number, string>; // request id -> method, for thread/start and thread/resume
}

const TRACKED = new Set(["thread/start", "thread/resume"]);

/**
 * Man-in-the-middle proxy between the Codex TUI and `codex app-server`. It never runs its own
 * handshake: the TUI's initialize and thread/start are forwarded, and the hub learns the thread and
 * turn ids from the traffic. Hub-originated requests use negative ids so they cannot collide with the
 * TUI's, and their responses are swallowed.
 */
export class CodexPeer extends BasePeer {
  private proc: ChildProcess | undefined;
  private server: Server<Link> | undefined;
  private link: Link | undefined; // the connection that owns the current thread
  /** Claimed as soon as a TUI WebSocket opens, before it can start a thread. */
  private claimedTui: Link | undefined;
  private threadId = "";
  /**
   * The thread's running token total at the last update, and whether the thread started here. Codex 0.156.1 also
   * sends `thread/tokenUsage/updated` for compaction (an estimate in `last`, `total` unchanged), a usage-limit refresh
   * and a replay to a connection that attaches, so `last` is not always new usage; differences of `total` are. A
   * resumed thread's first update only sets the baseline: its total holds the history from before (issue #40).
   */
  private tokenTotal: number | undefined;
  private freshThread = false;
  private readonly activeTurns = new Set<string>();
  private nextId = -1;
  private readonly pending = new Map<number, { resolve: (result?: any) => void; reject: (e: Error) => void; deliveryId?: string; kind?: "deliver" | "steer" }>();
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private injected: Envelope | undefined; // the hub envelope that started the current turn, if any
  private answering: Envelope[] = []; // everything delivered or steered into the current turn: who its answer is for
  private lastAnswer = "";
  private readonly deltas = new Map<string, string[]>();
  private primed = false;
  /** The Codex version app-server reported in its `initialize` answer (`<client>/<version> (...)`), once seen. */
  version: string | undefined;
  private readonly steers = new Set<number>(); // request ids of turn/steer calls app-server has not answered yet
  private readonly turnDeliveries = new Map<string, Set<string>>();
  private readonly unboundDeliveries = new Set<string>();

  constructor(
    id: PeerId,
    private readonly opts: CodexOptions,
  ) {
    super(id, opts.watchdogMs);
  }

  recoveryMetadata(): Record<string, unknown> {
    return {
      launch: { kind: "codex", bin: this.opts.bin ?? "codex", cwd: this.opts.cwd, appPort: this.opts.appPort, proxyPort: this.opts.proxyPort },
      ...(this.threadId ? { threadId: this.threadId } : {}),
    };
  }

  /** The app-server thread the hub drives; a new one is a new native session. */
  get thread(): string {
    return this.threadId;
  }

  get proxyUrl(): string {
    return `ws://127.0.0.1:${this.server?.port ?? this.opts.proxyPort}`;
  }

  async start(): Promise<void> {
    const upstream = this.opts.upstreamUrl ?? (await this.spawnAppServer());
    try {
      this.server = Bun.serve<Link>({
      hostname: "127.0.0.1",
      port: this.opts.proxyPort,
      fetch: (req, server) => {
        // Browsers always send Origin on WebSocket upgrades; the TUI never does.
        if (req.headers.has("origin")) return new Response("forbidden", { status: 403 });
        if (server.upgrade(req, { data: {} as Link })) return undefined;
        return new Response("agent-hub codex proxy");
      },
      websocket: {
        open: (tui) => {
          if (this.claimedTui) {
            tui.close(1013, "codex TUI already attached to this hub");
            return;
          }
          this.attach(tui, upstream);
        },
        message: (tui, data) => {
          if (tui.data?.up) this.fromTui(tui.data, String(data));
        },
        close: (tui) => {
          // A rejected second attachment never passed through attach(), so it has no Link.
          if (tui.data?.up) this.detach(tui.data);
        },
      },
      });
    } catch (error) {
      const proc = this.proc;
      // The start's own error is the one reported: a stop that fails too is logged beside it.
      if (proc && (await this.stopQuietly(proc)) && this.proc === proc) this.proc = undefined;
      throw error;
    }
  }

  /** Stops `proc` as a group; a failure is logged and reported as false, for paths that throw an error of their own. */
  private stopQuietly(proc: ChildProcess): Promise<boolean> {
    return stopOwnedProcess(proc, { group: true }).then(() => true, (error: Error) => { this.opts.log?.(`[${this.id}] ${error.message}`); return false; });
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.claimedTui?.tui.close(1001, "hub shutting down");
    const proc = this.proc;
    if (proc) {
      // Wait for the port to be released: `ahub codex` may restart the adapter right away. A launcher that already
      // exited still has its pipes dropped there, so nothing it left can keep the hub alive, and a group it left members
      // in fails the stop rather than freeing the port for a restart.
      await stopOwnedProcess(proc, { group: true });
      if (this.proc === proc) this.proc = undefined;
    }
    this.setState("offline");
  }

  /** Resolves when app-server accepts the turn. Only called while idle, i.e. a thread exists and no turn runs. */
  deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    const link = this.link;
    if (this.state !== "idle" || !link || link.up.readyState !== WebSocket.OPEN) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is not injectable` });
      return Promise.reject(new Error(`${this.id} is not injectable`));
    }
    const text = this.render(envs);
    const id = this.nextId--;
    this.setState("busy"); // claim the turn now so the bus stops draining
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        deliveryId, kind: "deliver",
        resolve: (result) => {
          this.primed = true;
          this.injected = replyParent(envs);
          this.answering = [...envs];
          const nativeTurn = typeof result?.turn?.id === "string" ? result.turn.id : undefined;
          if (deliveryId) {
            if (nativeTurn) this.addTurnDelivery(nativeTurn, deliveryId);
            else this.unboundDeliveries.add(deliveryId);
            this.delivery({ id: deliveryId, state: "accepted" });
          }
          resolve();
        },
        reject: (e) => {
          if (!this.activeTurns.size) this.setState("idle");
          if (deliveryId) this.delivery({ id: deliveryId, state: this.knownRejection(e) ? "failed_safe" : "needs_review", reason: e.message });
          reject(e);
        },
      });
      link.up.send(
        JSON.stringify({ method: "turn/start", id, params: { threadId: this.threadId, input: [{ type: "text", text }] } }),
      );
    });
  }

  private render(envs: Envelope[]): string {
    return this.primed || !this.opts.preamble ? renderDigest(envs, this.primed) : `${this.opts.preamble}\n\n${renderDigest(envs, false)}`;
  }

  /** `important` while a turn runs: feed it into that turn. Rejects when there is no steerable turn or app-server refuses. */
  steer(envs: Envelope[], deliveryId?: string): Promise<void> {
    const link = this.link;
    const expectedTurnId = [...this.activeTurns].reverse().find((t) => !t.startsWith("unknown:"));
    if (!link || link.up.readyState !== WebSocket.OPEN || !expectedTurnId) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} has no steerable turn` });
      return Promise.reject(new Error(`${this.id} has no steerable turn`));
    }
    const id = this.nextId--;
    this.steers.add(id);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        deliveryId, kind: "steer",
        resolve: () => {
          this.steers.delete(id);
          this.primed = true;
          // The turn now answers these too; the highest hop wins so a steer cannot reset the hop cap.
          this.injected = replyParent(this.injected ? [this.injected, ...envs] : envs);
          this.answering.push(...envs);
          if (deliveryId) {
            this.addTurnDelivery(expectedTurnId, deliveryId);
            this.delivery({ id: deliveryId, state: "accepted" });
          }
          resolve();
        },
        reject: (e) => {
          this.steers.delete(id);
          if (deliveryId) this.delivery({ id: deliveryId, state: this.knownRejection(e) ? "failed_safe" : "needs_review", reason: e.message });
          reject(e);
        },
      });
      const input = [{ type: "text", text: this.render(envs) }];
      link.up.send(JSON.stringify({ method: "turn/steer", id, params: { threadId: this.threadId, expectedTurnId, input } }));
    });
  }

  /**
   * A turn-free fact for the running turn (issue #108). Not a message: no envelope, no delivery record, nothing the
   * turn's answer is addressed to. `refused` when there is no running turn or app-server says no: it never went in.
   * `unanswered` when app-server did not answer in time: it may have gone in, and its readback can still come.
   */
  steerText(text: string): Promise<"accepted" | "refused" | "unanswered"> {
    const link = this.link;
    const expectedTurnId = [...this.activeTurns].reverse().find((t) => !t.startsWith("unknown:"));
    if (!link || link.up.readyState !== WebSocket.OPEN || !expectedTurnId) return Promise.resolve("refused");
    const id = this.nextId--;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.pending.delete(id) && resolve("unanswered"), this.opts.steerTimeoutMs ?? 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve: () => (clearTimeout(timer), resolve("accepted")), reject: () => (clearTimeout(timer), resolve("refused")) });
      link.up.send(JSON.stringify({ method: "turn/steer", id, params: { threadId: this.threadId, expectedTurnId, input: [{ type: "text", text }] } }));
    });
  }

  /** A silent turn is interrupted before the peer is declared idle, or the next turn/start would land inside it. */
  protected override onWatchdog(): void {
    for (const turnId of this.activeTurns) {
      if (turnId.startsWith("unknown:")) continue;
      this.link?.up.send(JSON.stringify({ method: "turn/interrupt", id: this.nextId--, params: { threadId: this.threadId, turnId } }));
    }
    this.activeTurns.clear();
    for (const ids of this.turnDeliveries.values()) for (const id of ids) this.delivery({ id, state: "needs_review", reason: "Codex turn watchdog timeout" });
    for (const id of this.unboundDeliveries) this.delivery({ id, state: "needs_review", reason: "Codex turn watchdog timeout" });
    this.turnDeliveries.clear(); this.unboundDeliveries.clear();
    this.injected = undefined;
    this.answering = [];
    this.lastAnswer = "";
    this.abandonSteers("turn went silent");
    super.onWatchdog();
  }

  /** A steer nobody answered must not vanish: rejecting it sends the envelope back to the queue. */
  private abandonSteers(reason: string): void {
    for (const id of this.steers) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.reject(new Error(`steer unanswered: ${reason}`));
    }
  }

  private addTurnDelivery(turnId: string, deliveryId: string): void {
    const ids = this.turnDeliveries.get(turnId) ?? new Set<string>();
    ids.add(deliveryId); this.turnDeliveries.set(turnId, ids); this.unboundDeliveries.delete(deliveryId);
  }

  private knownRejection(error: Error): boolean {
    return /turn in progress|no active turn|not injectable|rejected|usage limit/i.test(error.message);
  }

  private async spawnAppServer(): Promise<string> {
    const port = this.opts.appPort;
    const probe = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    if (await probe()) {
      throw new Error(`port ${port} already answers /healthz: an app-server the hub does not own is running (orphan from a crashed hub?)`);
    }
    let gone = "";
    this.proc = spawn(this.opts.bin ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`, ...(this.opts.extraArgs ?? [])], {
      cwd: this.opts.cwd,
      env: childEnv({ ...process.env, ...(this.opts.env ?? {}) }),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true, // its own process group, stopped as a whole (#113): `codex` is a launcher with a native child
    });
    trackGroup(this.proc);
    this.proc.stderr?.on("data", (d) => this.opts.log?.(`[${this.id}] ${String(d).trimEnd()}`));
    this.proc.on("error", (e) => (gone = `cannot run ${this.opts.bin ?? "codex"}: ${e.message}`));
    this.proc.on("exit", (code) => {
      gone ||= `codex app-server exited with code ${code}`;
      this.opts.log?.(`[${this.id}] ${gone}`);
      this.setState("offline");
    });
    for (let i = 0; i < 100 && !gone; i++) {
      if (await probe()) return `ws://127.0.0.1:${port}`;
      await Bun.sleep(100);
    }
    if (gone) throw new Error(gone);
    const proc = this.proc;
    if (proc && (await this.stopQuietly(proc)) && this.proc === proc) this.proc = undefined;
    throw new Error("codex app-server did not become healthy within 10 s");
  }

  private attach(tui: ServerWebSocket<Link>, upstream: string): void {
    const up = new WebSocket(upstream);
    const link: Link = { tui, up, backlog: [], tracked: new Map() };
    this.claimedTui = link;
    tui.data = link;
    up.onopen = () => {
      for (const frame of link.backlog.splice(0)) up.send(frame);
    };
    up.onmessage = (ev) => this.fromAppServer(link, String(ev.data));
    up.onclose = () => tui.close();
  }

  private detach(link: Link): void {
    link.up.close();
    if (this.claimedTui === link) this.claimedTui = undefined;
    if (this.link !== link) return;
    clearInterval(this.usageTimer);
    this.link = undefined;
    this.threadId = "";
    this.activeTurns.clear();
    for (const p of this.pending.values()) {
      if (p.deliveryId) this.delivery({ id: p.deliveryId, state: "needs_review", reason: "Codex TUI detached" });
      p.reject(new Error("codex TUI detached"));
    }
    this.pending.clear();
    for (const ids of this.turnDeliveries.values()) for (const id of ids) this.delivery({ id, state: "needs_review", reason: "Codex TUI detached" });
    for (const id of this.unboundDeliveries) this.delivery({ id, state: "needs_review", reason: "Codex TUI detached" });
    this.turnDeliveries.clear(); this.unboundDeliveries.clear();
    this.forgetTurn();
    this.setState("offline");
  }

  /** Nothing of an interrupted turn may address a later answer: a TUI that comes back starts its own. */
  private forgetTurn(): void {
    this.injected = undefined;
    this.answering = [];
    this.lastAnswer = "";
  }

  private fromTui(link: Link, raw: string): void {
    const msg = parse(raw);
    if (msg?.id !== undefined && TRACKED.has(msg.method)) link.tracked.set(msg.id, msg.method);
    if (link.up.readyState === WebSocket.OPEN) link.up.send(raw);
    else link.backlog.push(raw);
  }

  private fromAppServer(link: Link, raw: string): void {
    const msg = parse(raw);
    if (this.state === "busy") this.touch();
    if (!msg) return void link.tui.send(raw);

    if (typeof msg.id === "number" && msg.id < 0 && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? "app-server rejected the request"));
      else p?.resolve(msg.result);
      return; // ours: the TUI never asked for it
    }
    if (typeof msg.result?.userAgent === "string") this.version = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(msg.result.userAgent)?.[1] ?? this.version;
    const tracked = msg.id !== undefined && !msg.method ? link.tracked.get(msg.id) : undefined;
    if (tracked && link.tracked.delete(msg.id)) this.adopt(link, msg.result?.thread?.id, tracked === "thread/start");
    else if (msg.method) this.onNotification(link, msg.method, msg.params ?? {});
    link.tui.send(raw);
  }

  private adopt(link: Link, threadId: unknown, fresh = false): void {
    if (typeof threadId !== "string" || !threadId) return;
    this.tokenTotal = undefined;
    this.freshThread = fresh;
    this.link = link;
    this.threadId = threadId;
    this.activeTurns.clear();
    this.forgetTurn();
    this.opts.log?.(`[${this.id}] thread ${threadId}`);
    this.setState("idle");
    this.readUsage();
    clearInterval(this.usageTimer);
    this.usageTimer = setInterval(() => this.readUsage(), this.opts.usagePollMs ?? 600_000);
    this.usageTimer.unref?.();
  }

  /**
   * thread/revert through the TUI's connection (issue #33): drops `turnId` and every later turn from the conversation
   * history. It touches no file; `ahub undo` restores those. The TUI sees the `thread/reverted` notification.
   */
  revert(turnId: string): Promise<void> {
    const link = this.link;
    if (this.state !== "idle" || !link || link.up.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${this.id} is not idle`));
    const id = this.nextId--;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.pending.delete(id) && reject(new Error("thread/revert got no answer")), 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve: () => (clearTimeout(timer), resolve()), reject: (e) => (clearTimeout(timer), reject(e)) });
      link.up.send(JSON.stringify({ method: "thread/revert", id, params: { threadId: this.threadId, beforeTurnId: turnId } }));
    });
  }

  /** account/rateLimits/read through the TUI's connection, with a hub id so the answer never reaches the TUI. */
  private readUsage(): void {
    const link = this.link;
    if (!this.opts.onUsage || !link || link.up.readyState !== WebSocket.OPEN) return;
    const id = this.nextId--;
    this.pending.set(id, { resolve: (result) => this.opts.onUsage?.(result?.rateLimits, false), reject: () => {} });
    link.up.send(JSON.stringify({ method: "account/rateLimits/read", id }));
    setTimeout(() => this.pending.delete(id), 30_000).unref?.(); // an unanswered poll must not pile up until detach
  }

  private onNotification(link: Link, method: string, params: any): void {
    // Account-level notifications carry no threadId.
    if (link === this.link && method === "account/rateLimits/updated") return void this.opts.onUsage?.(params.rateLimits, false);
    if (link === this.link && method === "error" && params.error?.codexErrorInfo === "usageLimitExceeded") {
      this.opts.onUsage?.({ rateLimitReachedType: "usageLimitExceeded" }, true);
    }
    if (link !== this.link || params.threadId !== this.threadId) return;
    if (method === "thread/tokenUsage/updated") {
      const total = Number(params.tokenUsage?.total?.totalTokens);
      if (!Number.isFinite(total)) return;
      const added = this.tokenTotal === undefined ? (this.freshThread ? total : 0) : Math.max(0, total - this.tokenTotal);
      this.tokenTotal = total;
      if (added > 0) this.opts.onTokens?.(added);
      return;
    }
    if (method === "turn/started") {
      const nativeTurn = params.turn?.id ?? `unknown:${Date.now()}`;
      this.activeTurns.add(nativeTurn);
      for (const id of [...this.unboundDeliveries]) this.addTurnDelivery(nativeTurn, id);
      this.lastAnswer = "";
      this.setState("busy");
      if (params.turn?.id) this.opts.onTurn?.(params.turn.id);
    } else if (method === "item/agentMessage/delta") {
      const buf = this.deltas.get(params.itemId) ?? [];
      buf.push(params.delta);
      this.deltas.set(params.itemId, buf);
    } else if (method === "item/completed" && ["fileChange", "commandExecution", "mcpToolCall", "userMessage"].includes(params.item?.type)) {
      try {
        this.opts.onItem?.(params.item);
      } catch (error) {
        this.opts.log?.(`[${this.id}] item handler failed: ${(error as Error).message}`); // the proxy keeps going
      }
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      const item = params.item;
      const text: string =
        item.text ?? item.content?.map((c: any) => c.text ?? "").join("") ?? this.deltas.get(item.id)?.join("") ?? "";
      this.deltas.delete(item.id);
      // Conclusions only: skip commentary, keep the last answer of the turn (phase may be absent).
      if (item.phase !== "commentary" && text.trim()) this.lastAnswer = text.trim();
    } else if (method === "turn/completed") {
      const nativeTurn = params.turn?.id;
      this.activeTurns.delete(nativeTurn);
      for (const id of this.activeTurns) if (id.startsWith("unknown:")) this.activeTurns.delete(id);
      if (params.turn?.status === "failed") {
        this.opts.log?.(`[${this.id}] turn failed: ${params.turn.error?.message ?? "unknown error"}`);
      }
      if (this.activeTurns.size) return;
      this.abandonSteers("turn completed");
      if (typeof nativeTurn === "string") {
        for (const id of this.turnDeliveries.get(nativeTurn) ?? []) this.delivery({ id, state: params.turn?.status === "failed" ? "needs_review" : "completed", ...(params.turn?.status === "failed" ? { reason: params.turn?.error?.message ?? "Codex turn failed" } : {}) });
        this.turnDeliveries.delete(nativeTurn);
      }
      const inReplyTo = this.injected;
      const to = replyAudience(this.answering);
      this.injected = undefined;
      this.answering = [];
      this.deltas.clear();
      // Addressed like every other adapter's answer (issue #3): each sender it answers, including one steered in;
      // the bus maps a condensed delivery's `digest` back to the senders it replaced, a steer beside it or not.
      if (this.lastAnswer) this.onMessage?.(this.lastAnswer, inReplyTo ? { inReplyTo, to } : {});
      this.lastAnswer = "";
      this.setState("idle");
    }
  }
}


function parse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
