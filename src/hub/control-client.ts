import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectContext } from "./project.ts";

export function stateDirFor(cwd: string): string {
  return projectContext(cwd).stateDir;
}

/** Control WS wire version. 2 = `deliver` carries `envs` (digests); 3 = `tools` role and task messages; 4 = budget messages and `hub_checkpoint`; 5 = `ask`; 6 = console-only `ui` session bootstrap. The plugin is installed apart from the daemon, so they can drift. */
export const PROTOCOL = 8; // controlled daemon restart/recovery RPC and project/instance identity

export interface Hello {
  /** `tools`: acts for `peer` (task tools, hub_send) without being a delivery target: the MCP server Kimi and Codex run. */
  role: "peer" | "console" | "tools";
  peer?: string;
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
}

/** Where the daemon of this state dir listens. Re-read before every connect: port and token change per run. */
export function readControl(stateDir: string): ControlDescriptor | undefined {
  try {
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
    if (!Number.isInteger(status.controlPort) || status.controlPort < 1 || status.controlPort > 65535 || !token) return undefined;
    return { url: `ws://127.0.0.1:${status.controlPort}`, token, projectId: status.projectId,
      instanceId: status.instanceId, cwd: status.cwd, protocol: status.protocol, pid: status.pid };
  } catch {
    return undefined;
  }
}

/** One authenticated control connection. `request` correlates replies by `rid`; everything else goes to `onPush`. */
export class ControlClient {
  private nextRid = 1;
  private readonly pending = new Map<number, (msg: any) => void>();
  onPush: (msg: any) => void = () => {};
  /** `code`/`reason`: what the hub closed with, e.g. 4000 when another client attached as the same peer. */
  onClose: (code: number, reason: string) => void = () => {};

  private constructor(private readonly ws: WebSocket) {}

  static connect(stateDir: string, hello: Hello, timeoutMs = 3000): Promise<ControlClient> {
    const control = readControl(stateDir);
    if (!control) return Promise.reject(new Error(`no hub running for ${stateDir} (run: ahub up)`));
    if (control.protocol !== undefined && control.protocol !== PROTOCOL) {
      return Promise.reject(Object.assign(new Error(`wire version mismatch: hub speaks ${control.protocol}, CLI speaks ${PROTOCOL}; stop it with its matching CLI, then upgrade and restart`), { code: 4426 }));
    }
    if ((hello.projectId && hello.projectId !== control.projectId) ||
        (hello.instanceId && hello.instanceId !== control.instanceId) ||
        (hello.projectRoot && hello.projectRoot !== control.cwd)) {
      return Promise.reject(Object.assign(new Error("hub project or instance does not match the selected project"), { code: 4404 }));
    }
    const expected = { projectId: hello.projectId ?? control.projectId, instanceId: hello.instanceId ?? control.instanceId,
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
      ws.onopen = () => void client.request({ t: "hello", v: PROTOCOL, token: control.token, ...hello, ...expected }, timeoutMs).then((reply) => {
        if (reply.t !== "welcome" || reply.ok === false) return refuse(new Error(reply.error ?? "hub refused handshake"));
        if ((expected.projectId && reply.projectId !== expected.projectId) ||
            (expected.instanceId && reply.instanceId !== expected.instanceId) ||
            (expected.projectRoot && reply.cwd !== expected.projectRoot)) {
          return refuse(Object.assign(new Error("connected hub has a different project or instance"), { code: 4404 }));
        }
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
