import { spawn, type ChildProcess } from "node:child_process";
import type { Server, ServerWebSocket } from "bun";
import { framed, type Envelope, type PeerId } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";

export interface CodexOptions {
  /** Port the TUI attaches to: `codex --enable tui_app_server --remote ws://127.0.0.1:<proxyPort>`. */
  proxyPort: number;
  /** Port for the spawned `codex app-server`. Ignored when `upstreamUrl` is set. */
  appPort: number;
  /** Attach to an already running app-server instead of spawning one (tests). */
  upstreamUrl?: string;
  bin?: string;
  cwd: string;
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
  private threadId = "";
  private readonly activeTurns = new Set<string>();
  private nextId = -1;
  private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private injected: Envelope | undefined; // the hub envelope that started the current turn, if any
  private lastAnswer = "";
  private readonly deltas = new Map<string, string[]>();
  private primed = false;

  constructor(
    id: PeerId,
    private readonly opts: CodexOptions,
  ) {
    super(id, opts.watchdogMs);
  }

  get proxyUrl(): string {
    return `ws://127.0.0.1:${this.server?.port ?? this.opts.proxyPort}`;
  }

  async start(): Promise<void> {
    const upstream = this.opts.upstreamUrl ?? (await this.spawnAppServer());
    this.server = Bun.serve<Link>({
      hostname: "127.0.0.1",
      port: this.opts.proxyPort,
      fetch: (req, server) => {
        // Browsers always send Origin on WebSocket upgrades; the TUI never does.
        if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
        if (server.upgrade(req, { data: {} as Link })) return undefined;
        return new Response("agent-hub codex proxy");
      },
      websocket: {
        open: (tui) => this.attach(tui, upstream),
        message: (tui, data) => this.fromTui(tui.data, String(data)),
        close: (tui) => this.detach(tui.data),
      },
    });
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      // Wait for the port to be released: `hub codex` may restart the adapter right away.
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await Promise.race([exited, Bun.sleep(3000)]);
    }
    this.setState("offline");
  }

  /** Resolves when app-server accepts the turn. Only called while idle, i.e. a thread exists and no turn runs. */
  deliver(env: Envelope): Promise<void> {
    const link = this.link;
    if (this.state !== "idle" || !link || link.up.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.id} is not injectable`));
    }
    const text = framed(env, this.primed);
    const id = this.nextId--;
    this.setState("busy"); // claim the turn now so the bus stops draining
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => {
          this.primed = true;
          this.injected = env;
          resolve();
        },
        reject: (e) => {
          if (!this.activeTurns.size) this.setState("idle");
          reject(e);
        },
      });
      link.up.send(
        JSON.stringify({ method: "turn/start", id, params: { threadId: this.threadId, input: [{ type: "text", text }] } }),
      );
    });
  }

  /** A silent turn is interrupted before the peer is declared idle, or the next turn/start would land inside it. */
  protected override onWatchdog(): void {
    for (const turnId of this.activeTurns) {
      if (turnId.startsWith("unknown:")) continue;
      this.link?.up.send(JSON.stringify({ method: "turn/interrupt", id: this.nextId--, params: { threadId: this.threadId, turnId } }));
    }
    this.activeTurns.clear();
    this.injected = undefined;
    this.lastAnswer = "";
    super.onWatchdog();
  }

  private async spawnAppServer(): Promise<string> {
    const port = this.opts.appPort;
    const probe = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    if (await probe()) {
      throw new Error(`port ${port} already answers /healthz: an app-server the hub does not own is running (orphan from a crashed hub?)`);
    }
    let gone = "";
    this.proc = spawn(this.opts.bin ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
      cwd: this.opts.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
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
    this.proc.kill();
    throw new Error("codex app-server did not become healthy within 10 s");
  }

  private attach(tui: ServerWebSocket<Link>, upstream: string): void {
    const up = new WebSocket(upstream);
    const link: Link = { tui, up, backlog: [], tracked: new Map() };
    tui.data = link;
    up.onopen = () => {
      for (const frame of link.backlog.splice(0)) up.send(frame);
    };
    up.onmessage = (ev) => this.fromAppServer(link, String(ev.data));
    up.onclose = () => tui.close();
  }

  private detach(link: Link): void {
    link.up.close();
    if (this.link !== link) return;
    this.link = undefined;
    this.threadId = "";
    this.activeTurns.clear();
    for (const p of this.pending.values()) p.reject(new Error("codex TUI detached"));
    this.pending.clear();
    this.setState("offline");
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
      if (msg.error) p?.reject(new Error(msg.error.message ?? "turn/start rejected"));
      else p?.resolve();
      return; // ours: the TUI never asked for it
    }
    if (msg.id !== undefined && !msg.method && link.tracked.delete(msg.id)) this.adopt(link, msg.result?.thread?.id);
    else if (msg.method) this.onNotification(link, msg.method, msg.params ?? {});
    link.tui.send(raw);
  }

  private adopt(link: Link, threadId: unknown): void {
    if (typeof threadId !== "string" || !threadId) return;
    this.link = link;
    this.threadId = threadId;
    this.activeTurns.clear();
    this.opts.log?.(`[${this.id}] thread ${threadId}`);
    this.setState("idle");
  }

  private onNotification(link: Link, method: string, params: any): void {
    if (link !== this.link || params.threadId !== this.threadId) return;
    if (method === "turn/started") {
      this.activeTurns.add(params.turn?.id ?? `unknown:${Date.now()}`);
      this.lastAnswer = "";
      this.setState("busy");
    } else if (method === "item/agentMessage/delta") {
      const buf = this.deltas.get(params.itemId) ?? [];
      buf.push(params.delta);
      this.deltas.set(params.itemId, buf);
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      const item = params.item;
      const text: string =
        item.text ?? item.content?.map((c: any) => c.text ?? "").join("") ?? this.deltas.get(item.id)?.join("") ?? "";
      this.deltas.delete(item.id);
      // Conclusions only: skip commentary, keep the last answer of the turn (phase may be absent).
      if (item.phase !== "commentary" && text.trim()) this.lastAnswer = text.trim();
    } else if (method === "turn/completed") {
      this.activeTurns.delete(params.turn?.id);
      for (const id of this.activeTurns) if (id.startsWith("unknown:")) this.activeTurns.delete(id);
      if (params.turn?.status === "failed") {
        this.opts.log?.(`[${this.id}] turn failed: ${params.turn.error?.message ?? "unknown error"}`);
      }
      if (this.activeTurns.size) return;
      const inReplyTo = this.injected;
      this.injected = undefined;
      this.deltas.clear();
      if (this.lastAnswer) this.onMessage?.(this.lastAnswer, inReplyTo ? { inReplyTo } : {});
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
