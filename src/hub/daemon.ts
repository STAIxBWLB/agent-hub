import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AcpPeer, type PermissionRequest } from "../adapters/acp.ts";
import { CodexPeer } from "../adapters/codex-appserver.ts";
import { LocalPeer } from "../adapters/local-worker.ts";
import { Capture, skipTools } from "../memory/capture.ts";
import { DEFAULT_OMNIROUTE, OmniRoute, type OmniRouteConfig } from "../omniroute/client.ts";
import { Sidecar } from "../switchyard/sidecar.ts";
import { loadRouting } from "./routing.ts";
import { Bus } from "./bus.ts";
import { PROTOCOL, stateDirFor } from "./control-client.ts";
import { newEnvelope, parseMarker, USER, type Envelope, type PeerId } from "./envelope.ts";
import { BasePeer, DEFAULT_WATCHDOG_MS } from "./peers.ts";
import { MemoryClient, workerUrl } from "../memory/client.ts";
import { projectChain, recallFor } from "../memory/recall.ts";

export interface HubConfig {
  watchdog_ms: number;
  kimi_cmd: string[];
  codex_bin: string;
  batch_max: number;
  batch_ms: number;
  queue_cap: number;
  memory: { enabled: boolean; worker_url?: string; inject_tokens: number };
  omniroute: OmniRouteConfig;
  local: { deny: string[]; bash_network: boolean; max_steps: number; read_allow: string[] };
}
export const DEFAULT_CONFIG: HubConfig = {
  watchdog_ms: DEFAULT_WATCHDOG_MS,
  kimi_cmd: ["kimi", "acp"],
  codex_bin: "codex",
  batch_max: 3,
  batch_ms: 15_000,
  queue_cap: 200,
  memory: { enabled: true, inject_tokens: 2000 },
  omniroute: DEFAULT_OMNIROUTE,
  local: { deny: [], bash_network: false, max_steps: 30, read_allow: [] },
};

export { stateDirFor };

/** Ids an external process may not claim: the console user and the adapters the daemon runs itself. */
const RESERVED_IDS = new Set([USER, "codex", "kimi", "local", "hub"]);
const PEER_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function loadConfig(cwd: string): HubConfig {
  try {
    const file = JSON.parse(readFileSync(join(cwd, ".agenthub", "config.json"), "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...file,
      memory: { ...DEFAULT_CONFIG.memory, ...file.memory },
      omniroute: { ...DEFAULT_CONFIG.omniroute, ...file.omniroute },
      local: { ...DEFAULT_CONFIG.local, ...file.local },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export interface DaemonOptions {
  cwd: string;
  stateDir: string;
  controlPort: number;
  codexAppPort: number;
  codexProxyPort: number;
  /** 0 disables the Switchyard sidecar. */
  switchyardPort?: number;
  switchyardBin?: string;
  config?: HubConfig;
  /** Auto-approve ACP permission requests with the agent's allow_once option. */
  unattended?: boolean;
  permissionTimeoutMs?: number;
}

interface Client {
  authed: boolean;
  role?: "peer" | "console";
  peer?: PeerId;
  tail?: () => void;
}
type Sock = ServerWebSocket<Client>;

/** A peer that lives in another process and attaches over the control WS (the Claude channel plugin). */
class WsPeer extends BasePeer {
  private sock: Sock | undefined;
  attach(sock: Sock): void {
    this.sock?.close(4000, "replaced");
    this.sock = sock;
    this.setState("idle");
  }
  detach(sock: Sock): void {
    if (this.sock !== sock) return;
    this.sock = undefined;
    this.setState("offline");
  }
  async deliver(envs: Envelope[]): Promise<void> {
    if (!this.sock) throw new Error(`${this.id} is offline`);
    this.sock.send(JSON.stringify({ t: "deliver", envs }));
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.sock?.close();
  }
}

export async function startDaemon(opts: DaemonOptions) {
  const config = opts.config ?? loadConfig(opts.cwd);
  mkdirSync(opts.stateDir, { recursive: true });
  const logFile = join(opts.stateDir, "hub.log");
  const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

  // Any local web page can open a WebSocket to a loopback port, so the control link needs a secret.
  // The file is written only after the port is bound: a second daemon that loses the bind must not clobber it.
  const token = randomBytes(24).toString("hex");

  const bus = new Bus({ batchMax: config.batch_max, batchMs: config.batch_ms, queueCap: config.queue_cap });
  const memory = new MemoryClient(config.memory.worker_url ?? workerUrl(), 2000, log);
  const chain = projectChain(opts.cwd);
  const recalled = new Set<PeerId>(); // once per peer per hub run, however often the peer's session restarts

  /** Session-start cross-platform recall. Awaited before the peer can receive anything, so it rides on the first delivery. Fail-open. */
  async function ensurePreface(peer: PeerId): Promise<void> {
    if (!config.memory.enabled || recalled.has(peer)) return;
    const block = await recallFor(peer, memory, chain, config.memory.inject_tokens);
    if (!block || recalled.has(peer)) return; // nothing yet (worker down, no memory): the peer's next session tries again
    recalled.add(peer);
    bus.preface(peer, block);
    log(`recall ${peer}: ${block.length} chars`);
  }

  const omni = new OmniRoute(config.omniroute, log);
  let sidecar: Sidecar | undefined; // L2, started by the first hub-owned model call, stopped with the hub
  let sidecarRouting = "";

  const consoles = new Set<Sock>();
  const permissions = new Map<string, { push: string; done: (optionId: string | undefined) => void }>();
  let stopping = false;

  const status = () => ({
    pid: process.pid,
    cwd: opts.cwd,
    controlPort: server.port,
    codexProxyPort: opts.codexProxyPort,
    peers: Object.fromEntries(
      [...bus.peers].map(([id, p]) => [id, { state: bus.stateOf(id), queued: bus.queued(id), ...(p instanceof LocalPeer && p.lastServedBy ? { servedBy: p.lastServedBy } : {}) }]),
    ),
    ...(sidecar ? { switchyard: sidecar.status } : {}),
  });
  const writeStatus = () => {
    const file = join(opts.stateDir, "status.json"); // clients parse this on every connect: replace it atomically
    writeFileSync(`${file}.tmp`, `${JSON.stringify(status(), null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };

  bus.tap((e) => {
    if (e.t === "state") log(`state ${e.peer} -> ${e.state}`);
    else if (e.t === "undeliverable") log(`UNDELIVERABLE to ${e.peer} after retries: ${e.env.id} from ${e.env.from}`);
    else if (e.t === "overflow") log(`OVERFLOW ${e.peer}: dropped ${e.env.id} from ${e.env.from}`);
    else log(`msg ${e.env.from} -> ${e.env.to?.join(",") ?? "*"} ${e.env.priority} hop=${e.env.hop}${e.dropped ? ` NOT DELIVERED(${e.dropped})` : ""}: ${e.env.body.slice(0, 200)}`);
    if (!stopping) writeStatus();
  });

  async function onPermission(req: PermissionRequest): Promise<string | undefined> {
    if (opts.unattended) return req.options.find((o) => o.kind === "allow_once")?.optionId;
    const id = randomUUID().slice(0, 8);
    // The title is written by an agent and read by the person approving it: escape sequences and carriage returns
    // could repaint the terminal line, so everything but newline and tab is made visible.
    const title = req.title.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
    log(`permission ${id} ${req.peer}: ${title.slice(0, 300)}`);
    const push = JSON.stringify({ t: "permission", id, ...req, title });
    for (const c of consoles) if (c.data.tail) c.send(push);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), opts.permissionTimeoutMs ?? 120_000);
      const done = (optionId: string | undefined) => {
        clearTimeout(timer);
        permissions.delete(id);
        resolve(optionId);
      };
      permissions.set(id, { push, done }); // kept so a `hub tail` opened later still sees it
    });
  }

  // One start per peer at a time: a second `hub codex` must not tear down an adapter that is still coming up.
  const starting = new Map<string, Promise<Record<string, unknown>>>();
  function startPeer(peer: string, args: { model?: string; route?: string }): Promise<Record<string, unknown>> {
    const running = starting.get(peer) ?? startPeerOnce(peer, args).finally(() => starting.delete(peer));
    starting.set(peer, running);
    return running;
  }

  async function startPeerOnce(peer: string, args: { model?: string; route?: string }): Promise<Record<string, unknown>> {
    const existing = bus.peers.get(peer);
    if (existing && existing.state !== "offline") {
      return { ok: true, already: true, ...(existing instanceof CodexPeer ? { proxyUrl: existing.proxyUrl } : {}) };
    }
    await existing?.stop();
    if (peer === "kimi") {
      const [bin, ...rest] = config.kimi_cmd;
      const cmd = args.model ? [bin!, "--model", args.model, ...rest] : config.kimi_cmd;
      const kimi = new AcpPeer("kimi", { cmd, cwd: opts.cwd, watchdogMs: config.watchdog_ms, onPermission, log });
      await ensurePreface("kimi");
      bus.add(kimi);
      await kimi.start();
      return { ok: true };
    }
    if (peer === "codex") {
      const codex = new CodexPeer("codex", {
        appPort: opts.codexAppPort,
        proxyPort: opts.codexProxyPort,
        bin: config.codex_bin,
        cwd: opts.cwd,
        watchdogMs: config.watchdog_ms,
        log,
      });
      await ensurePreface("codex");
      bus.add(codex);
      await codex.start();
      return { ok: true, proxyUrl: codex.proxyUrl };
    }
    if (peer === "local") {
      const routing = loadRouting(opts.cwd);
      // `--model` pins a model on OmniRoute and skips L2; `--route` picks another Switchyard route.
      const route = args.model ? undefined : (args.route ?? routing.local.route);
      if (route && !routing.routes[route]) return { ok: false, error: `routing.toml has no route "${route}"` };
      // The sidecar serves the routes it was generated from: a changed routing.toml needs a new one.
      const routingKey = JSON.stringify([routing.targets, routing.routes]);
      if (sidecar && routingKey !== sidecarRouting) {
        sidecar.stop();
        sidecar = undefined;
      }
      if (route && opts.switchyardPort) {
        sidecarRouting = routingKey;
        sidecar ??= new Sidecar({ routing, omni, stateDir: opts.stateDir, port: opts.switchyardPort, log, ...(opts.switchyardBin ? { bin: opts.switchyardBin } : {}) });
      }
      const capture = config.memory.enabled
        ? new Capture(memory, { project: chain.at(-1)!, cwd: opts.cwd, skip: skipTools(), deny: config.local.deny })
        : undefined;
      const permit = (title: string) =>
        onPermission({
          peer: "local",
          title,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        }).then((picked) => picked === "allow");
      const local = new LocalPeer("local", {
        cwd: opts.cwd,
        omni,
        ...(sidecar && route ? { sidecar, route } : {}),
        fixedModel: args.model ?? routing.local.fixed_model,
        tools: { deny: config.local.deny, bashNetwork: config.local.bash_network, readAllow: config.local.read_allow, permit },
        ...(capture ? { capture } : {}),
        watchdogMs: config.watchdog_ms,
        maxSteps: config.local.max_steps,
        log,
      });
      await ensurePreface("local");
      bus.add(local);
      await local.start();
      return { ok: true, model: route ? `${route} (fallback ${routing.local.fixed_model})` : (args.model ?? routing.local.fixed_model) };
    }
    return { ok: false, error: `unknown peer "${peer}"` };
  }

  function onMessage(sock: Sock, msg: any): void {
    const c = sock.data;
    const reply = (body: Record<string, unknown>) => sock.send(JSON.stringify({ rid: msg.rid, ...body }));
    if (!c.authed) {
      if (msg.t !== "hello" || msg.token !== token) return sock.close(4401, "bad token");
      if (msg.v !== PROTOCOL) {
        // An outdated plugin would drop every digest without a trace. Refuse it loudly instead.
        log(`refused ${msg.role} ${msg.peer ?? ""}: wire version ${msg.v ?? 1}, hub speaks ${PROTOCOL} (claude plugin update agent-hub@agent-hub)`);
        return sock.close(4426, `wire version mismatch: hub speaks ${PROTOCOL}; update the agent-hub plugin`);
      }
      c.authed = true;
      c.role = msg.role === "peer" ? "peer" : "console";
      if (c.role === "console") consoles.add(sock);
      else {
        c.peer = String(msg.peer ?? "claude");
        if (!PEER_ID.test(c.peer) || RESERVED_IDS.has(c.peer)) return sock.close(4403, "peer id is reserved or malformed");
        let peer = bus.peers.get(c.peer);
        if (!peer) bus.add((peer = new WsPeer(c.peer)));
        if (!(peer instanceof WsPeer)) return sock.close(4409, "peer id is taken by a hub-managed adapter");
        const ws = peer;
        void ensurePreface(c.peer).finally(() => {
          if (sock.readyState === WebSocket.OPEN) ws.attach(sock);
        });
      }
      return void reply({ t: "welcome" });
    }
    switch (msg.t) {
      case "send": {
        // A human at the console should not wait out the batch window; agents default to status.
        const { priority, body } = parseMarker(String(msg.body ?? ""), c.peer ? "status" : "important");
        if (!body) return void reply({ t: "sent", ok: false, error: "empty body" });
        const to: PeerId[] | undefined = Array.isArray(msg.to) && msg.to.length ? msg.to.map(String) : undefined;
        const unknown = to?.filter((id) => !bus.peers.has(id)) ?? [];
        if (unknown.length) return void reply({ t: "sent", ok: false, error: `unknown peer: ${unknown.join(", ")}` });
        const inReplyTo = msg.reply_to ? bus.get(String(msg.reply_to)) : undefined;
        const targets = bus.publish(newEnvelope(c.peer ?? USER, body, { priority, ...(to ? { to } : {}), ...(inReplyTo ? { inReplyTo } : {}) }));
        return void reply({ t: "sent", ok: true, targets, recorded: priority === "fyi" });
      }
      case "tail":
        if (c.role !== "console" || c.tail) return;
        c.tail = bus.tap((e) => sock.send(JSON.stringify({ t: "event", e })));
        for (const p of permissions.values()) sock.send(p.push);
        return;
      case "status":
        return void reply({ t: "status", status: status() });
      case "start":
        if (c.role !== "console") return;
        startPeer(String(msg.peer), msg.args ?? {})
          .catch((e: Error) => ({ ok: false, error: e.message }))
          .then((r) => {
            if (!r.ok) log(`start ${msg.peer} failed: ${r.error}`);
            reply({ t: "started", ...r });
          });
        return;
      case "pause":
      case "resume": {
        if (c.role !== "console") return;
        const id = String(msg.peer);
        if (!bus.peers.has(id)) return void reply({ t: msg.t, ok: false, error: `unknown peer: ${id}` });
        if (msg.t === "pause") bus.pause(id);
        else bus.resume(id);
        return void reply({ t: msg.t, ok: true, state: bus.stateOf(id) });
      }
      case "permit":
        if (c.role === "console") permissions.get(String(msg.id))?.done(msg.option ? String(msg.option) : undefined);
        return;
      case "kill":
        if (c.role === "console") void stop();
        return;
    }
  }

  const server = Bun.serve<Client>({
    hostname: "127.0.0.1",
    port: opts.controlPort,
    fetch(req, srv) {
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      if (new URL(req.url).pathname === "/healthz") return new Response("ok");
      return srv.upgrade(req, { data: { authed: false } }) ? undefined : new Response("agent-hub control");
    },
    websocket: {
      message(sock, data) {
        try {
          onMessage(sock, JSON.parse(String(data)));
        } catch (e) {
          log(`bad control message: ${(e as Error).message}`);
        }
      },
      close(sock) {
        consoles.delete(sock);
        sock.data.tail?.();
        const peer = sock.data.peer ? bus.peers.get(sock.data.peer) : undefined;
        if (peer instanceof WsPeer) peer.detach(sock);
      },
    },
  });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    log("hub stopping");
    await Promise.allSettled([...bus.peers.values()].map((p) => p.stop()));
    sidecar?.stop();
    server.stop(true);
    for (const f of ["hub.pid", "status.json", "control-token"]) rmSync(join(opts.stateDir, f), { force: true });
    onStop?.();
  }
  let onStop: (() => void) | undefined;

  const tokenFile = join(opts.stateDir, "control-token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  writeFileSync(join(opts.stateDir, "hub.pid"), `${process.pid}\n`);
  writeStatus();
  log(`hub up pid=${process.pid} control=127.0.0.1:${server.port} cwd=${opts.cwd}`);
  return { bus, token, port: server.port as number, stop, stopped: new Promise<void>((r) => (onStop = r)) };
}
