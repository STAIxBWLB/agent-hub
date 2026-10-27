import { spawn, type ChildProcess } from "node:child_process";
import type { Server, ServerWebSocket } from "bun";
import { renderDigest, replyAudience, replyParent, type Envelope, type PeerId } from "../hub/envelope.ts";
import type { PermissionMode } from "../hub/permission-mode.ts";
import { BasePeer, type FrontendProxyPort } from "../hub/peers.ts";
import { codexContext, type ContextReading } from "../hub/context-window.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import type { ContextReader } from "./registry-types.ts";
import { ACTION_BUDGET_OPTION, type ActionGateVerdict, type PermissionRequest } from "./acp.ts";

const UNIDENTIFIED_CANCELLATION_NOTICE = "Codex cancelled turn has no verified native id; reattach the native session before further hub delivery";

/** A counter Codex reported: a finite non-negative number, otherwise 0 (an absent kind is not a negative delta). */
const counter = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
export interface CodexOptions {
  /** Port the TUI attaches to: `codex --enable tui_app_server --remote ws://127.0.0.1:<proxyPort>`. */
  proxyPort: number;
  permissionMode?: PermissionMode;
  /** Host-only always-ask gate, shared with ACP; an absent verdict preserves native handling. */
  actionGate?: (call: { names: readonly string[]; kind?: string; input: unknown }, session: string) => ActionGateVerdict | undefined;
  onPermission?: (request: PermissionRequest, signal?: AbortSignal) => Promise<string | undefined>;
  /** Port for the spawned `codex app-server`. Ignored when `upstreamUrl` is set. */
  appPort: number;
  /** Attach to an already running app-server instead of spawning one (tests). */
  upstreamUrl?: string;
  /** Live project membership. The proxy remains available for the same native terminal's return. */
  admitAttach?: () => boolean;
  bin?: string;
  /** Extra `codex app-server` arguments: the `-c mcp_servers.agent-hub.*` overrides that give Codex the hub's task tools. */
  extraArgs?: string[];
  /** Appended to the standing instruction of the first delivery (role contract). */
  preamble?: string;
  /** Raw `rateLimits` snapshots from app-server, and `hard = true` when a turn was refused for quota. */
  onUsage?: (rateLimits: unknown, hard: boolean) => void;
  /** Tokens the thread used since the previous update (see `tokenTotal` for how they are counted). */
  onTokens?: (added: number) => void;
  /**
   * The same update as `onTokens`, split into the kinds Codex reports (#683 U1): the increase of each `total` counter since the previous
   * update. Cached input is a part of `input`, and `reasoning` a part of `output` (Codex's own definition), so `total` is not their sum.
   */
  onTokenBreakdown?: (delta: { input: number; cachedInput: number; output: number; reasoning: number; total: number }) => void;
  onContext?: (reading: ContextReading) => void;
  /** The definition's native occupancy reader; standalone proxies retain the native default. */
  contextReader?: ContextReader;
  /** The native id of each turn as it starts, after the peer turned busy (issue #33: `ahub undo --context`). */
  onTurn?: (turnId: string) => void;
  /** Each thread the TUI starts (`fresh`) or resumes, as it is adopted (#215: which turns belong to which thread). */
  onThread?: (threadId: string, fresh: boolean) => void;
  /**
   * Each completed `fileChange`, `commandExecution`, `mcpToolCall` and `userMessage` item, for turn-free facts (issue
   * #108): the first three are boundaries, a `userMessage` is the readback of a steered fact. Codex emits
   * `item/started` about when a command has finished, so only completions are reported. Untyped JSON (hence `any`):
   * the receiver checks every field it reads.
   */
  onItem?: (item: any, nativeTurn?: string) => void;
  /** How often to ask app-server for the rate limits while a TUI is attached. */
  usagePollMs?: number;
  /** Facts wait from send; durable steers wait only after their original turn ends (default 10 s). */
  steerTimeoutMs?: number;
  cwd: string;
  /** Optional launch environment; recovery authority is always removed before spawn. */
  env?: NodeJS.ProcessEnv;
  watchdogMs?: number;
  log?: (line: string) => void;
}

interface Link {
  launchId?: string;
  tui: ServerWebSocket<Link>;
  up: WebSocket;
  backlog: string[]; // TUI frames that arrived before the upstream socket opened
  approvalIds: Set<string | number>; // intercepted native ids stay tombstoned for this socket lifetime
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
  readonly frontendProxy: FrontendProxyPort;
  private permissionMode: PermissionMode;
  private readonly actionWaits = new Map<AbortController, { link: Link; turn: string | undefined }>();
  get actionGated(): boolean { return this.opts.actionGate !== undefined; }
  private readonly nativeApprovalPolicies = new Map<string, unknown>();
  private readonly overriddenApprovals = new Set<string>();
  private readonly restoringApprovals = new Map<string | number, string>();
  private proc: ChildProcess | undefined;
  private server: Server<Link> | undefined;
  private link: Link | undefined; // the connection that owns the current thread
  /** Claimed as soon as a TUI WebSocket opens, before it can start a thread. */
  private claimedTui: Link | undefined;
  private threadId = "";
  private contextEpoch = 0;
  get sessionGeneration(): number { return this.contextEpoch; }
  /**
   * The thread's running token total at the last update, and whether the thread started here. Codex 0.156.1 also
   * sends `thread/tokenUsage/updated` for compaction (an estimate in `last`, `total` unchanged), a usage-limit refresh
   * and a replay to a connection that attaches, so `last` is not always new usage; differences of `total` are. A
   * resumed thread's first update only sets the baseline: its total holds the history from before (issue #40).
   */
  private tokenTotal: number | undefined;
  /** The per-kind counters of the last `total`, for the breakdown deltas (#683 U1). */
  private tokenKinds: { input: number; cachedInput: number; output: number; reasoning: number } | undefined;
  private freshThread = false;
  private readonly activeTurns = new Set<string>();
  private deliveryEpoch = 0;
  /** Cancellation tombstones last until that exact native completion or session replacement. */
  private readonly retiredTurns = new Set<string>();
  private unidentifiedCancellation = false;
  /** Fixed operator guidance only; native identifiers and agent text never enter status. */
  get statusNotice(): { code: "unidentified-cancellation"; message: string } | undefined {
    return this.unidentifiedCancellation ? { code: "unidentified-cancellation", message: UNIDENTIFIED_CANCELLATION_NOTICE } : undefined;
  }
  private unboundAccepted = false;
  private nextId = -1;
  private readonly pending = new Map<number, { resolve: (result?: any) => void; reject: (e: Error) => void; deliveryId?: string; kind?: "deliver" | "steer"; expectedTurnId?: string; afterTurn?: () => void; invalidate?: (reason: string) => void }>();
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
    this.permissionMode = opts.permissionMode ?? "ask";
    const owner = this;
    this.frontendProxy = {
      get url() { return owner.proxyUrl; },
      get attached() { return owner.proxyAttached; },
      setStartupPermissionMode: this.setStartupPermissionMode.bind(this),
      clearPermissionMode: this.clearPermissionMode.bind(this),
    };
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
  get nativeSession(): string | undefined { return this.threadId || undefined; }

  get proxyUrl(): string {
    return `ws://127.0.0.1:${this.server?.port ?? this.opts.proxyPort}`;
  }

  terminalOwner(launchId: string): { generation: string } | undefined {
    const link = this.link;
    return this.threadId && link && link === this.claimedTui && link.launchId === launchId &&
      link.tui.readyState === WebSocket.OPEN && link.up.readyState === WebSocket.OPEN
      ? { generation: String(this.sessionGeneration) } : undefined;
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
        const launchId = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1]; // codex --remote-auth-token-env (#586)
        if (server.upgrade(req, { data: { ...(launchId && launchId.length <= 128 ? { launchId } : {}) } as Link })) return undefined;
        return new Response("agent-hub codex proxy");
      },
      websocket: {
        open: (tui) => {
          if (this.opts.admitAttach?.() === false) { tui.close(4000, "codex is off roster; retry when a person adds it"); return; }
          if (this.claimedTui) {
            tui.close(1013, "codex TUI already attached to this hub");
            return;
          }
          this.attach(tui, upstream);
        },
        message: (tui, data) => {
          if (this.opts.admitAttach?.() === false) { tui.close(4000, "codex is off roster"); return; }
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
    this.abortActionWaits();
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
    const id = this.nextId--, epoch = this.deliveryEpoch, session = this.contextEpoch;
    this.setState("busy"); // claim the turn now so the bus stops draining
    return new Promise<void>((resolve, reject) => {
      let invalidated = false;
      const retiredAtCancel = new Set<string>();
      const invalidate = (reason: string) => {
        if (invalidated) return;
        invalidated = true;
        for (const turn of [...this.activeTurns, ...this.turnDeliveries.keys()]) if (!turn.startsWith("unknown:")) retiredAtCancel.add(turn);
        envs = []; // only the late native-id callback survives, never the cancelled audience/prompt
        if (deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason });
        reject(new Error(reason));
      };
      this.pending.set(id, {
        deliveryId, kind: "deliver", invalidate,
        resolve: (result) => {
          const nativeTurn = typeof result?.turn?.id === "string" ? result.turn.id : undefined;
          if (invalidated || epoch !== this.deliveryEpoch || session !== this.contextEpoch || link !== this.link) {
            invalidate("Codex turn acceptance arrived after its delivery was invalidated");
            if (nativeTurn && session === this.contextEpoch && link === this.link &&
              (!retiredAtCancel.has(nativeTurn) || this.retiredTurns.has(nativeTurn))) this.retireTurn(nativeTurn);
            return;
          }
          this.primed = true;
          this.injected = replyParent(envs);
          this.answering = [...envs];
          // Native acceptance can precede turn/started, also for legacy journal-less callers.
          if (nativeTurn && !this.turnDeliveries.has(nativeTurn)) this.turnDeliveries.set(nativeTurn, new Set());
          if (!nativeTurn && !this.activeTurns.size) this.unboundAccepted = true;
          if (deliveryId) {
            if (nativeTurn) this.addTurnDelivery(nativeTurn, deliveryId);
            else this.unboundDeliveries.add(deliveryId);
            this.delivery({ id: deliveryId, state: "accepted" });
          }
          resolve();
        },
        reject: (e) => {
          this.restoringApprovals.delete(id);
          if (invalidated) return; // uncertainty already settled; a late refusal cannot relabel it failed_safe
          if (epoch !== this.deliveryEpoch || session !== this.contextEpoch || link !== this.link) {
            invalidate("Codex turn refusal arrived after its delivery was invalidated"); return;
          }
          if (!this.activeTurns.size) this.setState("idle");
          if (deliveryId) this.delivery({ id: deliveryId, state: this.knownRejection(e) ? "failed_safe" : "needs_review", reason: e.message });
          reject(e);
        },
      });
      link.up.send(
        JSON.stringify({ method: "turn/start", id, params: this.applyPermissionPolicy({ threadId: this.threadId, input: [{ type: "text", text }] }, id) }),
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
    const expectedEpoch = this.contextEpoch;
    this.steers.add(id);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => { clearTimeout(timer); this.steers.delete(id); };
      const fail = (e: Error) => {
        settle();
        if (deliveryId) this.delivery({ id: deliveryId, state: this.knownRejection(e) ? "failed_safe" : "needs_review", reason: e.message });
        reject(e);
      };
      this.pending.set(id, {
        deliveryId, kind: "steer", expectedTurnId,
        afterTurn: deliveryId ? () => {
          if (timer !== undefined) return;
          timer = setTimeout(() => {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            pending?.reject(new Error("steer unanswered: RPC timeout"));
          }, this.opts.steerTimeoutMs ?? 10_000);
          timer.unref?.();
        } : undefined,
        resolve: (result) => {
          // Native completion can precede the RPC answer. A late refusal is definitive; a late acceptance is uncertain.
          if (deliveryId && (this.link !== link || this.contextEpoch !== expectedEpoch || !this.activeTurns.has(expectedTurnId) ||
            (typeof result?.turnId === "string" && result.turnId !== expectedTurnId))) {
            fail(new Error("steer accepted after its original native turn ended or changed"));
            return;
          }
          settle();
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
        reject: fail,
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
    this.abortActionWaits();
    this.deliveryEpoch++;
    const known = new Set([...this.activeTurns, ...this.turnDeliveries.keys()].filter(id => !id.startsWith("unknown:")));
    const pendingStarts = [...this.pending.values()].filter(pending => pending.kind === "deliver");
    if ([...this.activeTurns].some(id => id.startsWith("unknown:")) || (this.unboundDeliveries.size || this.unboundAccepted || pendingStarts.length) && !known.size) {
      // ponytail: after one unidentifiable cancellation, lifecycle attribution requires a session reattach.
      // Never guess that an unnamed late report or a later named start belongs to a new turn.
      this.unidentifiedCancellation = true;
      this.opts.log?.(UNIDENTIFIED_CANCELLATION_NOTICE);
    }
    for (const turnId of known) this.retireTurn(turnId);
    for (const pending of pendingStarts) pending.invalidate?.("Codex turn watchdog timeout before native acceptance was confirmed");
    this.activeTurns.clear();
    this.unboundAccepted = false;
    for (const ids of this.turnDeliveries.values()) for (const id of ids) this.delivery({ id, state: "needs_review", reason: "Codex turn watchdog timeout" });
    for (const id of this.unboundDeliveries) this.delivery({ id, state: "needs_review", reason: "Codex turn watchdog timeout" });
    this.turnDeliveries.clear(); this.unboundDeliveries.clear();
    this.injected = undefined;
    this.answering = [];
    this.lastAnswer = "";
    this.deltas.clear();
    this.abandonSteers("turn went silent");
    if (this.unidentifiedCancellation) this.setState("offline");
    else super.onWatchdog();
  }

  private retireTurn(turnId: string): void {
    this.abortActionWaits(undefined, turnId);
    this.retiredTurns.add(turnId);
    if (this.link?.up.readyState === WebSocket.OPEN) this.link.up.send(JSON.stringify({ method: "turn/interrupt", id: this.nextId--, params: { threadId: this.threadId, turnId } }));
  }

  /** A steer nobody answered must not vanish: rejecting it sends the envelope back to the queue. */
  private abandonSteers(reason: string): void {
    for (const id of this.steers) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.reject(new Error(`steer unanswered: ${reason}`));
    }
  }

  /** An ended native turn bounds only its unanswered durable steers; legacy steers retain their immediate retry. */
  private endSteers(turnId: string | undefined): void {
    for (const id of this.steers) {
      const pending = this.pending.get(id);
      if (!pending || pending.expectedTurnId !== turnId) continue;
      if (pending.deliveryId) pending.afterTurn?.();
      else { this.pending.delete(id); pending.reject(new Error("steer unanswered: turn completed")); }
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
    const env = peerChildEnv(this.id, { ...process.env, ...(this.opts.env ?? {}) });
    this.proc = spawn(this.opts.bin ?? "codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`, ...(this.opts.extraArgs ?? [])], {
      cwd: this.opts.cwd,
      env,
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
    const link: Link = { tui, up, backlog: [], tracked: new Map(), approvalIds: new Set(), ...(tui.data.launchId ? { launchId: tui.data.launchId } : {}) };
    this.claimedTui = link;
    tui.data = link;
    up.onopen = () => {
      for (const frame of link.backlog.splice(0)) up.send(frame);
    };
    up.onmessage = (ev) => this.fromAppServer(link, String(ev.data));
    up.onclose = () => tui.close();
  }

  private detach(link: Link): void {
    this.abortActionWaits(link);
    link.up.close();
    if (this.claimedTui === link) this.claimedTui = undefined;
    if (this.link !== link) return;
    clearInterval(this.usageTimer);
    this.link = undefined;
    this.restoringApprovals.clear();
    this.threadId = "";
    this.contextEpoch++;
    this.deliveryEpoch++;
    this.retiredTurns.clear(); this.unidentifiedCancellation = false;
    this.activeTurns.clear();
    this.unboundAccepted = false;
    for (const p of this.pending.values()) {
      if (p.kind === "deliver") p.invalidate?.("Codex TUI detached");
      else p.reject(new Error(p.kind === "steer" ? "Codex TUI detached" : "codex TUI detached"));
    }
    this.pending.clear();
    for (const ids of this.turnDeliveries.values()) for (const id of ids) this.delivery({ id, state: "needs_review", reason: "Codex TUI detached" });
    for (const id of this.unboundDeliveries) this.delivery({ id, state: "needs_review", reason: "Codex TUI detached" });
    this.turnDeliveries.clear(); this.unboundDeliveries.clear();
    this.forgetTurn();
    this.setState("offline");
  }
  detachForRoster(mode: PermissionMode = "ask"): void {
    this.permissionMode = mode;
    const link = this.claimedTui;
    if (!link) return;
    link.tui.close(4000, "codex is off roster; retry when a person adds it");
    this.detach(link);
  }

  /** Nothing of an interrupted turn may address a later answer: a TUI that comes back starts its own. */
  private forgetTurn(): void {
    this.injected = undefined;
    this.answering = [];
    this.lastAnswer = "";
  }

  get proxyAttached(): boolean { return !!this.link && this.link.up.readyState === WebSocket.OPEN; }

  getPermissionMode(): PermissionMode { return this.permissionMode; }
  get permissionModeState(): PermissionMode { return this.getPermissionMode(); }

  /** Reconcile the daemon's current choice after startup, before the returned proxy URL has a TUI. */
  setStartupPermissionMode(mode: PermissionMode): void {
    if (this.link || this.state !== "offline" || this.overriddenApprovals.size) throw new Error("codex startup mode reconciliation requires a fresh unattached proxy");
    this.permissionMode = mode;
  }

  /** Clear the overlay while detached, retaining each thread's restoration debt across a resume. */
  clearPermissionMode(): boolean {
    const restorable = [...this.overriddenApprovals].every(thread => this.nativeApprovalPolicies.has(thread));
    this.permissionMode = "ask";
    return restorable;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.link || this.link.up.readyState !== WebSocket.OPEN) throw new Error("codex permission mode unavailable: attach the TUI through ahub codex first");
    if (mode === "ask" && [...this.overriddenApprovals].some(thread => !this.nativeApprovalPolicies.has(thread))) throw new Error("codex cannot restore ask: native approval policy unavailable; close the TUI, then run ahub permission codex ask before you restart the Codex session with ahub codex");
    this.permissionMode = mode;
  }

  private applyPermissionPolicy(params: Record<string, unknown>, id: string | number): Record<string, unknown> {
    const thread = typeof params.threadId === "string" ? params.threadId : this.threadId;
    if (this.permissionMode !== "ask") {
      this.overriddenApprovals.add(thread);
      return { ...params, approvalPolicy: this.permissionMode === "never-ask" ? "never" : "on-request" };
    }
    if (this.overriddenApprovals.has(thread) && this.nativeApprovalPolicies.has(thread)) {
      this.restoringApprovals.set(id, thread);
      return { ...params, approvalPolicy: this.nativeApprovalPolicies.get(thread) };
    }
    return params;
  }

  private settlePermissionRestore(id: string | number, failed: boolean): void {
    const thread = this.restoringApprovals.get(id);
    this.restoringApprovals.delete(id);
    if (thread !== undefined && !failed && this.permissionMode === "ask") this.overriddenApprovals.delete(thread);
  }

  private fromTui(link: Link, raw: string): void {
    const msg = parse(raw);
    if (msg?.id !== undefined && !msg.method && link.approvalIds.has(msg.id)) return;
    if (msg?.method === "turn/interrupt" && link === this.link) this.abortActionWaits(link, typeof msg.params?.turnId === "string" ? msg.params.turnId : undefined);
    if (msg?.method === "turn/start" && msg.params && link === this.link) {
      const thread = typeof msg.params.threadId === "string" ? msg.params.threadId : this.threadId;
      // A resumed TUI can echo the sticky hub overlay. The restoring turn must use the kept baseline.
      const restoring = this.overriddenApprovals.has(thread) && this.nativeApprovalPolicies.has(thread);
      if (msg.params.approvalPolicy != null && !restoring) this.nativeApprovalPolicies.set(thread, msg.params.approvalPolicy);
      if (this.permissionMode !== "ask" || this.overriddenApprovals.has(thread)) {
        // Native turn overrides persist: ask restores the captured native policy once on successful admission.
        msg.params = this.applyPermissionPolicy(msg.params, msg.id);
        raw = JSON.stringify(msg);
      }
    }
    if (msg?.id !== undefined && TRACKED.has(msg.method)) link.tracked.set(msg.id, msg.method);
    if (link.up.readyState === WebSocket.OPEN) link.up.send(raw);
    else link.backlog.push(raw);
  }

  private fromAppServer(link: Link, raw: string): void {
    const msg = parse(raw);
    const nativeId = msg?.params?.turnId ?? msg?.params?.turn?.id ?? msg?.result?.turn?.id;
    if (this.state === "busy" && !(typeof nativeId === "string" && this.retiredTurns.has(nativeId))) this.touch();
    if (!msg) return void link.tui.send(raw);

    if (this.interceptActionApproval(link, msg)) return;
    if (msg.id !== undefined && !msg.method) this.settlePermissionRestore(msg.id, !!msg.error);
    if (typeof msg.id === "number" && msg.id < 0 && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? "app-server rejected the request"));
      else p?.resolve(msg.result);
      return; // ours: the TUI never asked for it
    }
    if (typeof msg.result?.userAgent === "string") this.version = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(msg.result.userAgent)?.[1] ?? this.version;
    const tracked = msg.id !== undefined && !msg.method ? link.tracked.get(msg.id) : undefined;
    if (tracked && link.tracked.delete(msg.id)) {
      if (typeof msg.result?.thread?.id === "string") {
        // A resumed response may report the sticky hub override, not the original native choice.
        const thread = msg.result.thread.id;
        if (!this.overriddenApprovals.has(thread) && msg.result.approvalPolicy != null) this.nativeApprovalPolicies.set(thread, msg.result.approvalPolicy);
        this.adopt(link, msg.result.thread.id, tracked === "thread/start");
      }
    }
    else if (msg.method) this.onNotification(link, msg.method, msg.params ?? {});
    link.tui.send(raw);
  }

  private abortActionWaits(link?: Link, turn?: string): void {
    for (const [controller, wait] of this.actionWaits) if ((!link || wait.link === link) && (!turn || wait.turn === turn)) controller.abort();
  }

  /** Only the two native command schemas verified on 0.163.0. Missing payloads keep their native policy. */
  private interceptActionApproval(link: Link, msg: any): boolean {
    if (!this.opts.actionGate || !(typeof msg.id === "string" || Number.isSafeInteger(msg.id))) return false;
    const legacy = msg.method === "execCommandApproval", params = msg.params;
    if (!legacy && msg.method !== "item/commandExecution/requestApproval") return false;
    if (!params || typeof params !== "object") return false;
    if (link.approvalIds.has(msg.id)) return true; // one intercepted callback has exactly one host answer
    if (legacy ? !Array.isArray(params.command) || !params.command.length || !params.command.every((word: unknown) => typeof word === "string")
      : typeof params.command !== "string" || !params.command.length || params.kind != null && params.kind !== "command") return false;
    const thread = legacy ? params.conversationId : params.threadId;
    let gate: ActionGateVerdict | undefined;
    try { gate = this.opts.actionGate({ names: ["shell"], kind: "execute", input: { command: params.command, cwd: params.cwd } }, typeof thread === "string" ? thread : ""); }
    catch { gate = { title: "Action approval: the always-ask check failed; command withheld", denyOnly: true }; }
    if (!gate) return false;
    const verdict = gate;
    // ponytail: retain at most 1024 intercepted ids per socket, never evict a tombstone and accept a late native answer.
    // Reattach is the upgrade path after this finite lifetime cap; closing both sides fails closed.
    if (link.approvalIds.size >= 1024) { this.abortActionWaits(link); link.up.close(); link.tui.close(1008, "Codex action approval id capacity reached; reattach"); return true; }
    link.approvalIds.add(msg.id);
    const named = [...this.activeTurns].filter(turn => !turn.startsWith("unknown:") && !this.retiredTurns.has(turn));
    const turn = legacy ? named.length === 1 ? named[0] : undefined : typeof params.turnId === "string" ? params.turnId : undefined;
    const epoch = this.contextEpoch, controller = new AbortController();
    const live = () => !controller.signal.aborted && link === this.link && epoch === this.contextEpoch && thread === this.threadId &&
      typeof turn === "string" && this.activeTurns.has(turn) && !this.retiredTurns.has(turn) && !this.unidentifiedCancellation && this.state === "busy" &&
      link.tui.readyState === WebSocket.OPEN && link.up.readyState === WebSocket.OPEN;
    const answer = (allow: boolean) => { if (link.up.readyState === WebSocket.OPEN) link.up.send(JSON.stringify({ id: msg.id, result: { decision: legacy ? allow ? "approved" : "abort" : allow ? "accept" : "decline" } })); };
    if (!live()) { answer(false); return true; } // no invented native turn binding, even when the command is classed
    this.actionWaits.set(controller, { link, turn });
    const options: PermissionRequest["options"] = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
    if (verdict.denyOnly) options.splice(0, 1); // keep only denial, even if a broken callback later returns allow
    if (!verdict.denyOnly && verdict.budget) options.push({ optionId: ACTION_BUDGET_OPTION, name: `Allow ${verdict.budget.label} for this session`, kind: "allow_once" });
    const alive = setInterval(() => { if (live()) this.touch(); }, Math.max(10, Math.min(30_000, Math.floor(this.watchdogMs / 3))));
    void (async () => {
      let picked: string | undefined;
      try {
        const cancelled = new Promise<undefined>(resolve => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
        picked = await Promise.race([this.opts.onPermission?.({ peer: this.id, title: verdict.title, tool: "shell", kind: "execute", classed: true, options }, controller.signal), cancelled]);
      } catch { /* a broken or missing approval handler denies */ }
      finally { clearInterval(alive); this.actionWaits.delete(controller); }
      let allow = !verdict.denyOnly && live() && picked === "allow";
      if (!verdict.denyOnly && live() && verdict.budget && picked === ACTION_BUDGET_OPTION) {
        try { allow = verdict.budget.approve() && live(); } catch { allow = false; }
      }
      answer(allow);
    })();
    return true;
  }

  private adopt(link: Link, threadId: unknown, fresh = false): void {
    if (typeof threadId !== "string" || !threadId || link !== this.claimedTui || link.tui.readyState !== WebSocket.OPEN || link.up.readyState !== WebSocket.OPEN) return;
    this.abortActionWaits();
    this.abandonSteers("thread changed");
    for (const [id, pending] of this.pending) if (pending.kind === "deliver") {
      pending.invalidate?.("Codex native thread changed before acceptance was confirmed");
      this.pending.delete(id); // a replaced session needs no late native-id callback
    }
    for (const ids of this.turnDeliveries.values()) for (const id of ids) this.delivery({ id, state: "needs_review", reason: "Codex native thread changed" });
    for (const id of this.unboundDeliveries) this.delivery({ id, state: "needs_review", reason: "Codex native thread changed" });
    this.turnDeliveries.clear(); this.unboundDeliveries.clear();
    this.tokenTotal = undefined; this.tokenKinds = undefined;
    this.freshThread = fresh;
    this.link = link;
    this.threadId = threadId;
    this.contextEpoch++;
    this.deliveryEpoch++;
    this.retiredTurns.clear(); this.unidentifiedCancellation = false;
    this.activeTurns.clear();
    this.unboundAccepted = false;
    this.forgetTurn();
    this.opts.log?.(`[${this.id}] thread ${threadId}`);
    this.opts.onThread?.(threadId, fresh);
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
  revertTurn(nativeTurn: string): Promise<void> { return this.revert(nativeTurn); }

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
    const nativeId = method === "turn/started" || method === "turn/completed" ? params.turn?.id : params.turnId;
    if (typeof nativeId === "string" && this.retiredTurns.has(nativeId)) {
      if (method === "turn/completed") this.retiredTurns.delete(nativeId);
      return;
    }
    if (this.unidentifiedCancellation) return; // native traffic is still forwarded to its TUI; hub attribution is fenced
    const unknownTurn = () => [...this.activeTurns].some(id => id.startsWith("unknown:"));
    if (method === "thread/tokenUsage/updated") {
      const reader = this.opts.contextReader;
      this.opts.onContext?.(reader ? reader.read(params.tokenUsage, this.threadId, Date.now()) : codexContext(params.tokenUsage, this.threadId, Date.now()));
      const total = Number(params.tokenUsage?.total?.totalTokens);
      if (!Number.isFinite(total)) return;
      const previous = this.tokenKinds;
      const kinds = { input: counter(params.tokenUsage?.total?.inputTokens), cachedInput: counter(params.tokenUsage?.total?.cachedInputTokens),
        output: counter(params.tokenUsage?.total?.outputTokens), reasoning: counter(params.tokenUsage?.total?.reasoningOutputTokens) };
      const added = this.tokenTotal === undefined ? (this.freshThread ? total : 0) : Math.max(0, total - this.tokenTotal);
      // The same baseline rule as the total: a thread that was resumed counts only what it adds from now on; a new one counts from zero.
      const base = previous ?? (this.freshThread && this.tokenTotal === undefined ? { input: 0, cachedInput: 0, output: 0, reasoning: 0 } : undefined);
      this.tokenTotal = total; this.tokenKinds = kinds;
      if (added > 0) this.opts.onTokens?.(added);
      if (added > 0 && base) this.opts.onTokenBreakdown?.({ input: Math.max(0, kinds.input - base.input), cachedInput: Math.max(0, kinds.cachedInput - base.cachedInput),
        output: Math.max(0, kinds.output - base.output), reasoning: Math.max(0, kinds.reasoning - base.reasoning), total: added });
      return;
    }
    if (method === "turn/started") {
      const nativeTurn = params.turn?.id ?? `unknown:${Date.now()}`;
      this.unboundAccepted = false;
      this.activeTurns.add(nativeTurn);
      for (const id of [...this.unboundDeliveries]) this.addTurnDelivery(nativeTurn, id);
      this.lastAnswer = "";
      this.setState("busy");
      if (params.turn?.id) this.opts.onTurn?.(params.turn.id);
    } else if (method === "item/agentMessage/delta") {
      if (!this.activeTurns.size || typeof params.turnId === "string" && !this.activeTurns.has(params.turnId) && !unknownTurn()) return;
      const buf = this.deltas.get(params.itemId) ?? [];
      buf.push(params.delta);
      this.deltas.set(params.itemId, buf);
    } else if (method === "item/completed" && ["fileChange", "commandExecution", "mcpToolCall", "userMessage"].includes(params.item?.type)) {
      if (typeof params.turnId === "string" && !this.activeTurns.has(params.turnId) && !unknownTurn()) return;
      try {
        this.opts.onItem?.(params.item, typeof params.turnId === "string" && this.activeTurns.has(params.turnId) ? params.turnId : undefined);
      } catch (error) {
        this.opts.log?.(`[${this.id}] item handler failed: ${(error as Error).message}`); // the proxy keeps going
      }
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      if (!this.activeTurns.size || typeof params.turnId === "string" && !this.activeTurns.has(params.turnId) && !unknownTurn()) return;
      const item = params.item;
      const text: string =
        item.text ?? item.content?.map((c: any) => c.text ?? "").join("") ?? this.deltas.get(item.id)?.join("") ?? "";
      this.deltas.delete(item.id);
      // Conclusions only: skip commentary, keep the last answer of the turn (phase may be absent).
      if (item.phase !== "commentary" && text.trim()) this.lastAnswer = text.trim();
    } else if (method === "turn/completed") {
      const nativeTurn = params.turn?.id;
      this.abortActionWaits(link, typeof nativeTurn === "string" ? nativeTurn : undefined);
      // A watchdog or a newer turn has invalidated this completion. Unknown-id legacy starts retain their fallback.
      if (!this.activeTurns.size || typeof nativeTurn === "string" && !this.activeTurns.has(nativeTurn) && ![...this.activeTurns].some(id => id.startsWith("unknown:"))) return;
      this.activeTurns.delete(nativeTurn);
      for (const id of this.activeTurns) if (id.startsWith("unknown:")) this.activeTurns.delete(id);
      if (params.turn?.status === "failed") {
        this.opts.log?.(`[${this.id}] turn failed: ${params.turn.error?.message ?? "unknown error"}`);
      }
      this.endSteers(nativeTurn);
      if (this.activeTurns.size) return;
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

export function isCodexPeer(value: unknown): value is CodexPeer {
  return value instanceof CodexPeer;
}
