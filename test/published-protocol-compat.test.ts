import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as currentDaemon from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL, readControl } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { packageDigest, preserveRuntimePackage } from "../src/cli/recovery-package.ts";

// Installed separately by the gate with its own frozen lock. No fixture package is installed or fetched by a test.
// The bounded preservation helper copies unchanged executable assets and the sole amem0.15 dependency to unique
// scratch inodes, then verifies the same package digest. It never copies an entire node_modules tree.
// The old daemon and self-contained plugin need only their own core; the current source plugin uses SDK1.30.0,
// the same version in the published release's lock. Neither installed nor copied old source is patched.
const OLD_ROOT = join(import.meta.dir, "fixtures/protocol-v16/node_modules/@staix/agent-hub");
const CURRENT_ROOT = join(import.meta.dir, "..");
type Config = Record<string, unknown> & { memory: Record<string, unknown>; snapshots: Record<string, unknown>; inference: Record<string, unknown>;
  mlx: Record<string, unknown>; pi: Record<string, unknown>; research: Record<string, unknown>; task_sweep: Record<string, unknown>; approvals: Record<string, unknown> };
interface DaemonHandle { stop(): Promise<void>; bus: { publish(envelope: Envelope): unknown } }
interface DaemonModule { DEFAULT_CONFIG: Config; startDaemon(options: { cwd: string; stateDir: string; controlPort: number; codexAppPort: number; codexProxyPort: number; configWatch: false; config: Record<string, unknown> }): Promise<DaemonHandle> }
interface ClientPort { request(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown>; close(): void }
interface ClientModule { PROTOCOL: number; ControlClient: { connect(stateDir: string, hello: { role: "console"; projectRoot: string }, timeoutMs?: number): Promise<ClientPort> } }
interface Published { root: string; daemon: DaemonModule; client: ClientModule }

function metadata(root: string): Record<string, unknown> { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>; }
function packageFor(entry: string, name: string): Record<string, unknown> {
  let root = dirname(entry);
  for (let count = 0; count < 8; count++) {
    try { const found = metadata(root); if (found.name === name) return found; } catch { /* entry may be below a package's module-format boundary */ }
    const parent = dirname(root); if (parent === root) break; root = parent;
  }
  throw new Error(`fixture dependency metadata unavailable for ${name}`);
}
let loaded: Promise<Published> | undefined;
let preservedParent: string | undefined;
afterAll(() => { if (preservedParent) rmSync(preservedParent, { recursive: true, force: true }); });
function published(): Promise<Published> {
  return loaded ??= (async () => {
    expect(metadata(OLD_ROOT)).toMatchObject({ name: "@staix/agent-hub", version: "0.24.0", dependencies: { "@staix/agent-mem": "0.15.0" } });
    expect(packageFor(Bun.resolveSync("@staix/agent-mem", join(OLD_ROOT, "src")), "@staix/agent-mem").version).toBe("0.15.0");
    expect(packageFor(Bun.resolveSync("@modelcontextprotocol/sdk/server/index.js", CURRENT_ROOT), "@modelcontextprotocol/sdk").version).toBe("1.30.0");
    preservedParent = mkdtempSync(join(tmpdir(), "ahub-published-runtime-"));
    const digest = packageDigest(OLD_ROOT), captured = preserveRuntimePackage(OLD_ROOT, join(preservedParent, "runtime"), digest);
    expect(captured).toMatchObject({ version: "0.24.0", digest });
    expect(packageDigest(captured.root, { ownDependencies: true })).toBe(digest);
    expect(metadata(captured.root)).toMatchObject({ name: "@staix/agent-hub", version: "0.24.0" });
    expect(packageFor(Bun.resolveSync("@staix/agent-mem", join(captured.root, "src")), "@staix/agent-mem").version).toBe("0.15.0");
    const installed = lstatSync(join(OLD_ROOT, "src/hub/control-client.ts")), copied = lstatSync(join(captured.root, "src/hub/control-client.ts"));
    expect(copied.nlink).toBe(1); expect([copied.dev, copied.ino]).not.toEqual([installed.dev, installed.ino]);
    // Computed URLs deliberately keep old package source outside the current TypeScript compilation graph.
    const client = await import(pathToFileURL(join(captured.root, "src/hub/control-client.ts")).href) as unknown as ClientModule;
    const daemon = await import(pathToFileURL(join(captured.root, "src/hub/daemon.ts")).href) as unknown as DaemonModule;
    expect(client.PROTOCOL).toBe(16); expect(PROTOCOL).toBe(17);
    return { root: captured.root, daemon, client };
  })();
}

async function fixture(module: DaemonModule) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-published-wire-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]])), env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of keys) { const dir = join(root, key); mkdirSync(dir); process.env[key] = dir; env[key] = dir; }
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_MODE", "AGENTHUB_CHANNEL", "AGENTHUB_UNATTENDED", "AGENTHUB_DELIVERY_ONLY", "AGENTHUB_PERMISSION_TOOL", "AGENTHUB_RECOVERY_CONDUCTOR", "AGENTHUB_RECOVERY_OPERATION"]) delete env[key];
  let daemon: DaemonHandle | undefined;
  const close = async () => { try { await daemon?.stop(); } finally { for (const key of keys) { const before = saved[key]; if (before === undefined) delete process.env[key]; else process.env[key] = before; } rmSync(root, { recursive: true, force: true }); } };
  try {
    const defaults = module.DEFAULT_CONFIG;
    daemon = await module.startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...defaults, roster: { claude: true, codex: false, kimi: false, pi: false, local: false, qwen: false, jcode: false, agy: false }, batch_ms: 0, memory: { ...defaults.memory, enabled: false, native: false },
        snapshots: { ...defaults.snapshots, enabled: false }, inference: { ...defaults.inference, enabled: false }, mlx: { ...defaults.mlx, enabled: false },
        pi: { ...defaults.pi, enabled: false, auto_start: false }, research: { ...defaults.research, enabled: false },
        task_sweep: { ...defaults.task_sweep, enabled: false }, approvals: { ...defaults.approvals, notify: false } } });
    const descriptor = readControl(stateDir); if (!descriptor) throw new Error("isolated daemon did not publish its descriptor");
    return { root, stateDir, daemon, env: { ...env, AGENTHUB_PEER_ID: "claude", AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: root, AGENTHUB_INSTANCE_ID: descriptor.instanceId, AGENTHUB_CHANNEL: "1" }, close };
  } catch (error) { await close(); throw error; }
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid plugin JSON object");
  return input as Record<string, unknown>;
}
async function plugin(entry: string, f: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn([process.execPath, entry], { cwd: f.root, env: f.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const replies = new Map<number, (value: Record<string, unknown>) => void>(), notifications: Record<string, unknown>[] = [];
  let sequence = 0, diagnostics = "", outputBytes = 0, failure: unknown;
  const track = (bytes: Uint8Array) => { outputBytes += bytes.length; if (outputBytes > 1024 * 1024) throw new Error("plugin fixture output exceeded1MiB"); };
  const stderr = (async () => { for await (const bytes of child.stderr) { track(bytes); diagnostics = (diagnostics + Buffer.from(bytes).toString("utf8")).slice(-8192); } })().catch(error => { failure = error; child.kill("SIGKILL"); });
  const stdout = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const bytes of child.stdout) {
      track(bytes); buffer += decoder.decode(bytes, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        const message = object(JSON.parse(line));
        const done = typeof message.id === "number" ? replies.get(message.id) : undefined;
        if (done) { replies.delete(message.id as number); done(message); } else notifications.push(message);
      }
    }
  })().catch(error => { failure = error; child.kill("SIGKILL"); });
  const rpc = (method: string, params: unknown = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { replies.delete(id); reject(new Error(`plugin ${method} timed out: ${diagnostics}`)); }, 3000);
    replies.set(id, message => { clearTimeout(timer); message.error ? reject(new Error("plugin MCP request refused")) : resolve(message.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const waitFor = async (ready: () => boolean, label: string) => {
    const until = Date.now() + 5000;
    while (!ready() && !failure && Date.now() < until) await Bun.sleep(10);
    if (failure) throw failure;
    expect(ready(), `${label}: ${diagnostics}`).toBe(true);
  };
  const close = async () => {
    child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await child.exited; } finally { clearTimeout(timer); await Promise.all([stdout, stderr]); }
  };
  try {
    expect(await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "published-protocol-fixture", version: "1" } })).toMatchObject({ serverInfo: { name: "agent-hub" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await waitFor(() => diagnostics.includes('connected to hub as "claude"'), "actual plugin consumed welcome");
    return { close, async digest(marker: string) {
      f.daemon.bus.publish(newEnvelope("user", marker, { to: ["claude"], kind: "chat" }));
      const until = Date.now() + 5000; let found = false;
      while (!found && Date.now() < until) {
        await waitFor(() => notifications.length > 0, "channel delivery");
        for (const message of notifications.splice(0)) {
          if (message.method !== "notifications/claude/channel") continue;
          const params = object(message.params), meta = object(params.meta);
          if (typeof params.content === "string" && params.content.includes(marker)) found = true;
          if (typeof meta.delivery_id === "string" && typeof meta.delivery_generation === "string") await rpc("tools/call", { name: "hub_delivery_done", arguments: { delivery_id: meta.delivery_id, delivery_generation: meta.delivery_generation } });
        }
      }
      expect(found, "the actual plugin emitted the queued digest").toBe(true);
    } };
  } catch (error) { await close(); throw error; }
}

test("published0.24 client and unchanged plugin bundle connect to the new17 daemon through the16 descriptor floor", async () => {
  const old = await published(), f = await fixture(currentDaemon as unknown as DaemonModule);
  let client: ClientPort | undefined, channel: Awaited<ReturnType<typeof plugin>> | undefined;
  try {
    expect(readControl(f.stateDir)).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
    client = await old.client.ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root });
    expect(await client.request({ t: "status" })).toMatchObject({ status: { protocol: 16, protocolMin: 16, protocolMax: 17 } });
    channel = await plugin(join(old.root, "plugins/agent-hub/server.js"), f);
    await channel.digest("published-v16-plugin-to-new-v17-daemon");
  } finally { try { await channel?.close(); client?.close(); } finally { await f.close(); } }
}, 20_000);

test("new17 client and unchanged current plugin source connect to the actual published0.24 daemon using16", async () => {
  const old = await published(), f = await fixture(old.daemon);
  let client: ClientPort | undefined, channel: Awaited<ReturnType<typeof plugin>> | undefined;
  try {
    const connected = await ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root }); client = connected;
    expect(connected.protocol).toBe(16); expect(await client.request({ t: "status" })).toMatchObject({ status: { protocol: 16, version: "0.24.0" } });
    channel = await plugin(join(CURRENT_ROOT, "src/adapters/claude-channel.ts"), f);
    await channel.digest("current-v17-plugin-to-published-v16-daemon");
  } finally { try { await channel?.close(); client?.close(); } finally { await f.close(); } }
}, 20_000);
