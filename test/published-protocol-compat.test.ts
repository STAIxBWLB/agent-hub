import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as currentDaemon from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL, PROTOCOL_MIN, readControl } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { packageDigest, preserveRuntimePackage } from "../src/cli/recovery-package.ts";
import { parseVersion } from "../scripts/lib/release-plan.ts";

// Installed separately by the gate with its own frozen lock. No fixture package is installed or fetched by a test.
// The bounded preservation helper copies unchanged executable assets and each release's exact amem dependency to unique
// scratch inodes, then verifies the same package digest. It never copies an entire node_modules tree.
// The old daemon and self-contained plugin need only their own core; the current source plugin uses the root's
// verified SDK1.30.0. Neither installed nor copied old source is patched.
const PUBLISHED_FIXTURES = [
  { directory: "protocol-v16", version: "0.25.0", memoryVersion: "0.18.0", protocol: 16, role: "protocol floor" },
  { directory: "release-n-1", version: "0.29.0", memoryVersion: "0.20.0", protocol: 17, role: "release N-1" },
] as const;
type PublishedFixture = typeof PUBLISHED_FIXTURES[number];
const CURRENT_ROOT = join(import.meta.dir, "..");
type Config = Record<string, unknown> & { memory: Record<string, unknown>; snapshots: Record<string, unknown>; inference: Record<string, unknown>;
  mlx: Record<string, unknown>; pi: Record<string, unknown>; research: Record<string, unknown>; task_sweep: Record<string, unknown>; approvals: Record<string, unknown> };
interface DaemonHandle { stop(): Promise<void>; bus: { publish(envelope: Envelope): unknown } }
interface DaemonModule { DEFAULT_CONFIG: Config; startDaemon(options: { cwd: string; stateDir: string; controlPort: number; codexAppPort: number; codexProxyPort: number; configWatch: false; config: Record<string, unknown> }): Promise<DaemonHandle> }
interface ClientPort { readonly protocol?: number; request(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown>; close(): void }
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
const loaded = new Map<string, Promise<Published>>();
const preservedParents: string[] = [];
afterAll(() => { for (const parent of preservedParents) rmSync(parent, { recursive: true, force: true }); });
function published(entry: PublishedFixture): Promise<Published> {
  let result = loaded.get(entry.directory);
  if (!result) {
    result = (async () => {
      const installedRoot = join(import.meta.dir, "fixtures", entry.directory, "node_modules/@staix/agent-hub");
      expect(metadata(join(import.meta.dir, "fixtures", entry.directory))).toMatchObject({ private: true, dependencies: { "@staix/agent-hub": entry.version } });
      expect(metadata(installedRoot)).toMatchObject({ name: "@staix/agent-hub", version: entry.version, dependencies: { "@staix/agent-mem": entry.memoryVersion } });
      expect(packageFor(Bun.resolveSync("@staix/agent-mem", join(installedRoot, "src")), "@staix/agent-mem").version).toBe(entry.memoryVersion);
      expect(packageFor(Bun.resolveSync("@modelcontextprotocol/sdk/server/index.js", CURRENT_ROOT), "@modelcontextprotocol/sdk").version).toBe("1.30.0");
      const parent = mkdtempSync(join(tmpdir(), "ahub-published-runtime-")); preservedParents.push(parent);
      const digest = packageDigest(installedRoot), captured = preserveRuntimePackage(installedRoot, join(parent, "runtime"), digest);
      expect(captured).toMatchObject({ version: entry.version, digest });
      expect(packageDigest(captured.root, { ownDependencies: true })).toBe(digest);
      expect(metadata(captured.root)).toMatchObject({ name: "@staix/agent-hub", version: entry.version });
      expect(packageFor(Bun.resolveSync("@staix/agent-mem", join(captured.root, "src")), "@staix/agent-mem").version).toBe(entry.memoryVersion);
      const installed = lstatSync(join(installedRoot, "src/hub/control-client.ts")), copied = lstatSync(join(captured.root, "src/hub/control-client.ts"));
      expect(copied.nlink).toBe(1); expect([copied.dev, copied.ino]).not.toEqual([installed.dev, installed.ino]);
      // Computed URLs deliberately keep old package source outside the current TypeScript compilation graph.
      const client = await import(pathToFileURL(join(captured.root, "src/hub/control-client.ts")).href) as unknown as ClientModule;
      const daemon = await import(pathToFileURL(join(captured.root, "src/hub/daemon.ts")).href) as unknown as DaemonModule;
      expect(client.PROTOCOL).toBe(entry.protocol); expect(PROTOCOL).toBe(17);
      return { root: captured.root, daemon, client };
    })();
    loaded.set(entry.directory, result);
  }
  return result;
}

test("release N-1 fixture follows the current release's previous minor independently of the supported wire floor", () => {
  const current = parseVersion(String(metadata(CURRENT_ROOT).version));
  expect(current).toBeDefined();
  const release = PUBLISHED_FIXTURES.find(entry => entry.role === "release N-1")!;
  const pin = metadata(join(import.meta.dir, "fixtures", release.directory)).dependencies as Record<string, unknown>;
  expect(pin["@staix/agent-hub"]).toBe(release.version);
  const previous = release.version.split(".").map(Number);
  // ponytail: this guard covers previous minors within one major; 1.0.0 needs a predecessor policy.
  // Replace the same-major arithmetic with an explicit predecessor mapping at that boundary.
  expect(previous[0]).toBe(current![0]);
  expect(previous[1]).toBe(current![1] - 1);
  // Patches retain their minor line's baseline. The literal wire floor pins the separate protocol-16 promise.
  expect(PROTOCOL_MIN).toBe(16);
  expect(PUBLISHED_FIXTURES.find(entry => entry.role === "protocol floor")?.version).toBe("0.25.0");
});

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

for (const entry of PUBLISHED_FIXTURES) {
  test(`${entry.role}: published ${entry.version} client and unchanged plugin bundle use protocol ${entry.protocol} with the new v17 daemon (descriptor floor v16)`, async () => {
    const old = await published(entry), f = await fixture(currentDaemon as unknown as DaemonModule);
    let client: ClientPort | undefined, channel: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      expect(readControl(f.stateDir)).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
      client = await old.client.ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root });
      if (entry.protocol === 17) expect(client.protocol).toBe(17);
      expect(await client.request({ t: "status" })).toMatchObject({ status: { protocol: 16, protocolMin: 16, protocolMax: 17 } });
      channel = await plugin(join(old.root, "plugins/agent-hub/server.js"), f);
      await channel.digest(`published-${entry.version}-plugin-to-new-v17-daemon`);
    } finally { try { await channel?.close(); client?.close(); } finally { await f.close(); } }
  }, 20_000);

  test(`${entry.role}: new17 client and unchanged current plugin source connect to the actual published${entry.version} daemon using${entry.protocol}`, async () => {
    const old = await published(entry), f = await fixture(old.daemon);
    let client: ClientPort | undefined, channel: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      const connected = await ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root }); client = connected;
      expect(connected.protocol).toBe(entry.protocol); expect(await client.request({ t: "status" })).toMatchObject({ status: { protocol: 16, version: entry.version } });
      channel = await plugin(join(CURRENT_ROOT, "src/adapters/claude-channel.ts"), f);
      await channel.digest(`current-v17-plugin-to-published-${entry.version}-daemon`);
    } finally { try { await channel?.close(); client?.close(); } finally { await f.close(); } }
  }, 20_000);
}
