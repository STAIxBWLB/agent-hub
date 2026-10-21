import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectContext } from "./project.ts";
import { externalAdapterMetadata, type ExternalAdapterMetadata } from "../adapters/external-metadata.ts";

export function stateDirFor(cwd: string): string {
  return projectContext(cwd).stateDir;
}

/** Control WS wire version. 2 = `deliver` carries `envs` (digests); 3 = `tools` role and task messages; 4 = budget messages and `hub_checkpoint`; 5 = `ask`; 6 = console-only `ui` session bootstrap; 8 = controlled recovery; 9 = Pi bridge metadata; 10 = durable delivery receipts; 11 = queue hold diagnostics; 12 = generation-bound channel settlement and execution budgets; 13 = turn-free facts (`facts` with tool, session and transcript binding, `silenced`) and per-recipient send results (issue #108). 14 = native context-window status and session-bound context checkpoint request ids (issue #185). 15 = conductor tools and permission deadlines/closed events (issues #190, #194). 16 = a Claude session without channel evidence: hello `channel: false` and `inbox` (issue #205). The plugin is installed apart from the daemon, so they can drift. */
export const PROTOCOL = 16;
export const DAEMON_FEATURES = ["external_adapter_modules", "configured_acp", "native_hook_launch", "task_cancel", "recovery_deferred_hub", "peer_instances", "release_trains", "reviewer_pool", "native_tui_launch", "terminal_owner", "cli_audit_delegated"] as const;
/** Protocols a current coordinator may authenticate while upgrading a running source. */
export const RECOVERY_SOURCE_PROTOCOLS = [9, 10, 11, 12, 13, 14, 15, PROTOCOL] as const;

export interface Hello {
  /** `tools`: acts for `peer` (task tools, hub_send) without being a delivery target: the MCP server Kimi and Codex run. */
  role: "peer" | "console" | "tools";
  peer?: string;
  /** `peer` only: false when the session cannot show channel pushes; its queue then waits for `inbox` (issue #205). */
  channel?: boolean;
  /** Managed Claude launch identity; absent for plain or pre-daemon sessions. */
  launchId?: string;
  /** Reclaim after replacement, never an intentional initial takeover. */
  standby?: boolean;
  projectId?: string;
  instanceId?: string;
  projectRoot?: string;
}

export interface ControlDescriptor {
  url: string;
  token: string;
  projectId?: string;
  instanceId?: string;
  cwd?: string;
  protocol?: number;
  pid?: number;
  features?: readonly string[];
  /** The daemon's accepted native start modes, used by launchers when the file value is retained. */
  startModes?: Readonly<Record<string, "tui" | "headless">>;
  externalAdapters?: readonly ExternalAdapterMetadata[];
  /** #226: the daemon's processSignature, written into status.json only (not the status reply); absent before 0.12.21. */
  pidSignature?: string;
}

/** Where the daemon of this state dir listens. Re-read before every connect: port and token change per run. */
export function readControl(stateDir: string): ControlDescriptor | undefined {
  try {
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
    if (!Number.isInteger(status.controlPort) || status.controlPort < 1 || status.controlPort > 65535 || !token) return undefined;
    const startModes = status.startModes && typeof status.startModes === "object" && !Array.isArray(status.startModes)
      ? Object.fromEntries(Object.entries(status.startModes).filter((entry): entry is [string, "tui" | "headless"] => entry[1] === "tui" || entry[1] === "headless"))
      : undefined;
    return { url: `ws://127.0.0.1:${status.controlPort}`, token, projectId: status.projectId,
      instanceId: status.instanceId, cwd: status.cwd, protocol: status.protocol, pid: status.pid, features: Array.isArray(status.features) ? status.features.filter((feature: unknown): feature is string => typeof feature === "string") : [],
      ...(startModes ? { startModes } : {}),
      ...(status.externalAdapters !== undefined ? { externalAdapters: externalAdapterMetadata(status.externalAdapters) } : {}),
      ...(typeof status.pidSignature === "string" && status.pidSignature ? { pidSignature: status.pidSignature } : {}) };
  } catch {
    return undefined;
  }
}

const instancePins = new Map<string, { instanceId: string }>();

/** One authenticated control connection. `request` correlates replies by `rid`; everything else goes to `onPush`. */
export class ControlClient {
  features: readonly string[] = [];
  private welcomeInstanceId?: string;
  /** Identity from the authenticated welcome, never the unauthenticated descriptor alone. */
  get instanceId(): string | undefined { return this.welcomeInstanceId; }
  get isOpen(): boolean { return this.ws.readyState === WebSocket.OPEN; }
  private nextRid = 1;
  private readonly pending = new Map<number, (msg: any) => void>();
  onPush: (msg: any) => void = () => {};
  /** `code`/`reason`: what the hub closed with, e.g. 4000 when another client attached as the same peer. */
  onClose: (code: number, reason: string) => void = () => {};

  private constructor(private readonly ws: WebSocket) {}

  /** Scope all helper-module connections in one CLI invocation to its authenticated audit consumer. */
  static pinInstance(stateDir: string, instanceId: string): () => void {
    const key = resolve(stateDir), pin = { instanceId };
    if (!instanceId || instancePins.has(key)) throw new Error("control instance is already pinned or unavailable");
    instancePins.set(key, pin);
    return () => { if (instancePins.get(key) === pin) instancePins.delete(key); };
  }

  /** `protocol` is used only by the upgrade coordinator for an authenticated, explicitly supported source contract. */
  static connect(stateDir: string, hello: Hello, timeoutMs = 3000, protocol = PROTOCOL): Promise<ControlClient> {
    if (!RECOVERY_SOURCE_PROTOCOLS.includes(protocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number])) return Promise.reject(new Error(`unsupported recovery source protocol ${protocol}`));
    const control = readControl(stateDir);
    if (!control) return Promise.reject(new Error(`no hub running for ${stateDir} (run: ahub up)`));
    const pin = instancePins.get(resolve(stateDir));
    if (pin && (control.instanceId !== pin.instanceId || hello.instanceId !== undefined && hello.instanceId !== pin.instanceId)) {
      return Promise.reject(new Error("delegated audit consumer changed; refusing a connection to its replacement"));
    }
    if (control.protocol !== undefined && control.protocol !== protocol) {
      return Promise.reject(Object.assign(new Error(`wire version mismatch: hub speaks ${control.protocol}, CLI speaks ${protocol}; stop it with its matching CLI, then upgrade and restart`), { code: 4426 }));
    }
    if ((hello.projectId && hello.projectId !== control.projectId) ||
        (hello.instanceId && hello.instanceId !== control.instanceId) ||
        (hello.projectRoot && hello.projectRoot !== control.cwd)) {
      return Promise.reject(Object.assign(new Error("hub project or instance does not match the selected project"), { code: 4404 }));
    }
    const expected = { projectId: hello.projectId ?? control.projectId, instanceId: pin?.instanceId ?? hello.instanceId ?? control.instanceId,
      projectRoot: hello.projectRoot ?? control.cwd };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(control.url);
      const client = new ControlClient(ws);
      const timer = setTimeout(() => refuse(new Error(`hub connection timed out at ${control.url}`)), timeoutMs);
      const refuse = (error: Error) => { clearTimeout(timer); reject(error); ws.close(); };
      ws.onerror = () => refuse(new Error(`cannot reach hub at ${control.url}`));
      ws.onclose = (ev) => {
        clearTimeout(timer);
        // A refused hello carries its reason (bad token, wire version, peer id); say that, not a guess.
        reject(Object.assign(new Error(`hub closed the connection: ${ev.reason || "stale token?"}`), { code: ev.code }));
        for (const done of client.pending.values()) done({ ok: false, error: "hub connection closed" });
        client.pending.clear();
        client.onClose(ev.code, ev.reason);
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return refuse(new Error("invalid hub response")); }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return refuse(new Error("invalid hub response"));
        const done = msg.rid !== undefined ? client.pending.get(msg.rid) : undefined;
        if (!done) return client.onPush(msg);
        client.pending.delete(msg.rid);
        done(msg);
      };
      ws.onopen = () => void client.request({ t: "hello", v: protocol, token: control.token, ...hello, ...expected }, timeoutMs).then((reply) => {
        if (reply.t !== "welcome" || reply.ok === false) return refuse(new Error(reply.error ?? "hub refused handshake"));
        if ((expected.projectId && reply.projectId !== expected.projectId) ||
            (expected.instanceId && reply.instanceId !== expected.instanceId) ||
            (expected.projectRoot && reply.cwd !== expected.projectRoot)) {
          return refuse(Object.assign(new Error("connected hub has a different project or instance"), { code: 4404 }));
        }
        client.features = Object.freeze(Array.isArray(reply.features) ? reply.features.filter((feature: unknown): feature is string => typeof feature === "string") : []);
        client.welcomeInstanceId = typeof reply.instanceId === "string" && reply.instanceId ? reply.instanceId : undefined;
        clearTimeout(timer);
        resolve(client);
      });
    });
  }

  /** `timeoutMs`: for calls a person waits on. The hub has its own budget; this one only makes sure the CLI never hangs. */
  request(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "hub connection is not open" });
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      const timer = timeoutMs ? setTimeout(() => (this.pending.delete(rid), resolve({ ok: false, error: `no answer from the hub within ${Math.round(timeoutMs / 1000)} s` })), timeoutMs) : undefined;
      this.pending.set(rid, (reply) => (clearTimeout(timer), resolve(reply)));
      this.ws.send(JSON.stringify({ ...msg, rid }));
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}
