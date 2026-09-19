import { readFileSync } from "node:fs";
import { join } from "node:path";

export function stateDirFor(cwd: string): string {
  return process.env.AGENTHUB_STATE_DIR ?? join(cwd, ".agenthub", "state");
}

/** Control WS wire version. 2 = `deliver` carries `envs` (digests); 3 = `tools` role and task messages. The plugin is installed apart from the daemon, so they can drift. */
export const PROTOCOL = 3;

export interface Hello {
  /** `tools`: acts for `peer` (task tools, hub_send) without being a delivery target: the MCP server Kimi and Codex run. */
  role: "peer" | "console" | "tools";
  peer?: string;
}

/** Where the daemon of this state dir listens. Re-read before every connect: port and token change per run. */
export function readControl(stateDir: string): { url: string; token: string } | undefined {
  try {
    const status = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
    const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
    return { url: `ws://127.0.0.1:${status.controlPort}`, token };
  } catch {
    return undefined;
  }
}

/** One authenticated control connection. `request` correlates replies by `rid`; everything else goes to `onPush`. */
export class ControlClient {
  private nextRid = 1;
  private readonly pending = new Map<number, (msg: any) => void>();
  onPush: (msg: any) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private readonly ws: WebSocket) {}

  static connect(stateDir: string, hello: Hello): Promise<ControlClient> {
    const control = readControl(stateDir);
    if (!control) return Promise.reject(new Error(`no hub running for ${stateDir} (run: hub up)`));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(control.url);
      const client = new ControlClient(ws);
      ws.onerror = () => reject(new Error(`cannot reach hub at ${control.url}`));
      ws.onclose = () => {
        reject(new Error("hub closed the connection (stale token?)"));
        for (const done of client.pending.values()) done({ ok: false, error: "hub connection closed" });
        client.pending.clear();
        client.onClose();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        const done = msg.rid !== undefined ? client.pending.get(msg.rid) : undefined;
        if (!done) return client.onPush(msg);
        client.pending.delete(msg.rid);
        done(msg);
      };
      ws.onopen = () => void client.request({ t: "hello", v: PROTOCOL, token: control.token, ...hello }).then(() => resolve(client));
    });
  }

  request(msg: Record<string, unknown>): Promise<any> {
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      this.pending.set(rid, resolve);
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
