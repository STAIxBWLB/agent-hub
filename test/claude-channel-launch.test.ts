import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

async function plugin(launchId: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "ahub-channel-launch-"));
  const hellos: any[] = [], replies = new Map<number, (value: any) => void>();
  let socket: { close(code: number, reason: string): unknown } | undefined;
  let diagnostics = "", sequence = 0;
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("websocket only", { status: 400 }); },
    websocket: { message(ws, raw) {
      const message = JSON.parse(String(raw));
      if (message.t === "hello") {
        hellos.push(message); socket = ws;
        ws.send(JSON.stringify({ t: "welcome", rid: message.rid, ok: true, projectId: "launch-fixture", instanceId: "fixture-instance", cwd: root }));
      } else ws.send(JSON.stringify({ rid: message.rid, ok: true, held: { count: 0, rows: [], truncated: false }, envs: [], queued: 0, important: 0 }));
    } },
  });
  const manifest = { protocol: PROTOCOL, controlPort: daemon.port, projectId: "launch-fixture", instanceId: "fixture-instance", cwd: root };
  writeFileSync(join(root, "status.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "control-token"), "fixture-token");
  const entry = join(import.meta.dir, "../src/adapters/claude-channel.ts");
  // Accelerate only the plugin's 1..30s retry timers. The marker is an observable scheduling barrier:
  // a terminal close must never schedule even the first retry. Handshake timers remain unchanged.
  const wrapper = join(root, "channel-fixture.ts");
  writeFileSync(wrapper, `const original = globalThis.setTimeout; globalThis.setTimeout = ((callback, delay, ...args) => { if (delay >= 1000 && delay <= 30000 && delay !== 3000 && delay !== 5000) { console.error("[fixture retry timer] " + delay); return original(callback, 0, ...args); } return original(callback, delay, ...args); }); await import(${JSON.stringify(entry)});`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, AGENTHUB_HOME: join(root, "hub-home"), AMEM_HOME: join(root, "memory-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"), AGENTHUB_CHANNEL: "1", AGENTHUB_PEER_ID: "claude", AGENTHUB_STATE_DIR: root, AGENTHUB_PROJECT_DIR: root, AGENTHUB_INSTANCE_ID: "fixture-instance" };
  delete env.AGENTHUB_MODE; delete env.AGENTHUB_DELIVERY_ONLY;
  if (launchId === undefined) delete env.AGENTHUB_LAUNCH_ID; else env.AGENTHUB_LAUNCH_ID = launchId;
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = (async () => { for await (const data of child.stderr) diagnostics += Buffer.from(data).toString(); })();
  const stdout = (async () => {
    let buffer = "";
    for await (const data of child.stdout) {
      buffer += Buffer.from(data).toString(); let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line), resolve = replies.get(value.id);
        if (resolve) { replies.delete(value.id); resolve(value); }
      }
    }
  })();
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { replies.delete(id); reject(new Error(`MCP ${method} timeout: ${diagnostics}`)); }, 3000);
    replies.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const until = async (ready: () => boolean, label: string) => { for (let n = 0; n < 400 && !ready(); n++) await Bun.sleep(5); expect(ready(), `${label}: ${diagnostics}`).toBe(true); };
  const close = async () => {
    child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await child.exited; clearTimeout(timer); await Promise.all([stdout, stderr]); daemon.stop(true); rmSync(root, { recursive: true, force: true });
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "launch-test", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await until(() => diagnostics.includes('connected to hub as "claude"'), "plugin consumed welcome");
    return { hellos, rpc, until, close, diagnostics: () => diagnostics, disconnect: (code: number) => socket!.close(code, code === 4430 ? "stale launch" : "replaced"),
      status: (peers: unknown) => writeFileSync(join(root, "status.json"), JSON.stringify({ ...manifest, peers })) };
  } catch (error) { await close(); throw error; }
}

for (const launchId of ["managed-launch", undefined]) test(`#551 plugin hello ${launchId ? "carries launch id" : "preserves absent launch compatibility"}`, async () => {
  const f = await plugin(launchId);
  try { expect(f.hellos).toHaveLength(1); expect(f.hellos[0].launchId).toBe(launchId); expect(f.hellos[0].standby).not.toBe(true); expect(f.hellos[0].cwd).toBe(realPath(f.hellos[0].projectRoot)); }
  finally { await f.close(); }
});

test("#551 stale-launch 4430 stops plugin reconnect scheduling and explains the ended launch through hub tools", async () => {
  const f = await plugin("ended-launch");
  try {
    f.disconnect(4430);
    await f.until(() => f.diagnostics().includes("stopped reconnecting"), "terminal refusal consumed");
    // Two completed MCP round trips cross the child's I/O loop after onClose; the timer marker proves
    // that no reconnect was queued, without waiting for an arbitrary fraction of the backoff.
    await f.rpc("ping");
    const result = await f.rpc("tools/call", { name: "hub_inbox", arguments: {} });
    const text = result.content.filter((row: any) => row.type === "text").map((row: any) => row.text).join("\n");
    expect(text).toContain("launch"); expect(text).toContain("ahub claude"); expect(text).toMatch(/ended|stale|previous/);
    expect(f.diagnostics()).not.toContain("[fixture retry timer]"); expect(f.hellos).toHaveLength(1);
  } finally { await f.close(); }
});

test("#551 plugin marks every reconnect after replacement as standby even when status incorrectly reports offline", async () => {
  const f = await plugin("valid-launch");
  try {
    f.status({ claude: { state: "offline" } });
    f.disconnect(4000);
    await f.until(() => f.hellos.length >= 2, "standby reconnect");
    expect(f.hellos[1]).toMatchObject({ launchId: "valid-launch", standby: true, channel: true });
    expect(f.diagnostics()).toContain("[fixture retry timer] 1000");
  } finally { await f.close(); }
});
