import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONDUCTOR_TOOLS } from "../src/hub/hub-tools.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { AcpOwnedGroup } from "../src/adapters/acp-owned-group.ts";
import { isAcpPeer } from "../src/adapters/acp.ts";
import { DAEMON_FEATURES, ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import type { Envelope } from "../src/hub/envelope.ts";

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await Bun.sleep(10);
  expect(check(), label).toBe(true);
}
async function fixture(options: { on?: boolean; pin?: string; readOnly?: boolean; configured?: boolean; productionConfig?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-configured-acp-daemon-")), stateDir = join(root, "state"), home = join(root, "home"), protocol = join(root, "protocol.jsonl");
  const previousHome = process.env.HOME;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const clients: ControlClient[] = [];
  const close = async () => {
    try { for (const c of clients.reverse()) c.close(); client?.close(); await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  };
  try {
    mkdirSync(home); mkdirSync(join(root, ".agenthub")); process.env.HOME = home;
    if (hubGitSync(["init", "-q", root], { encoding: "utf8" }).status !== 0) throw new Error("fixture git init failed");
    const adapter = { transport: "acp" as const, command: process.execPath, args: [join(import.meta.dir, "fakes/acp-server.ts"), "--agent-name", "Fixture ACP", "--agent-version", "1", "--modes", "default,plan", "--record-protocol", protocol], displayName: "Fixture ACP", roles: ["implementer", "verifier"], identity: { name: options.pin ?? "Fixture ACP", version: "1" }, permission: { ask: "default" }, readOnly: "plan" };
    const adapters: NonNullable<HubConfig["adapters"]> = options.configured === false ? {} : { fixture: adapter };
    const instances: NonNullable<HubConfig["instances"]> = options.readOnly ? { "fixture-check": { kind: "fixture", roles: ["verifier"], start_mode: "headless" as const, readOnly: true } } : {};
    const local = { adapters, instances, roster: options.configured === false ? {} : { fixture: options.on === true, ...(options.readOnly ? { "fixture-check": true } : {}) } };
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify(local));
    const config: HubConfig = { ...DEFAULT_CONFIG, ...local, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } };
    if (options.productionConfig) writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({
      batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false },
      snapshots: { enabled: false }, approvals: { notify: false }, mlx: { enabled: false },
      pi: { enabled: false, auto_start: false },
    }));
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, ...(options.productionConfig ? {} : { config }) });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const connectTools = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: root }); clients.push(c); return c; };
    const records = (): Array<{ method?: string; params?: any }> => existsSync(protocol) ? readFileSync(protocol, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
    return { root, stateDir, daemon, client, local, adapter, connectTools, records, close };
  } catch (error) { await close(); throw error; }
}

test("configured ACP is off roster by default and cannot be claimed by an external hello", async () => {
  const f = await fixture();
  try {
    expect((await f.client.request({ t: "start", peer: "fixture" })).ok).toBe(false);
    expect(f.records()).toEqual([]);
    await expect(ControlClient.connect(f.stateDir, { role: "peer", peer: "fixture", projectRoot: f.root })).rejects.toThrow();
    expect(f.daemon.bus.peers.has("fixture")).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("configured ACP runs its real foreground fake, delivers once and stops its owned process", async () => {
  const f = await fixture({ on: true });
  try {
    await expect(ControlClient.connect(f.stateDir, { role: "peer", peer: "fixture", projectRoot: f.root })).rejects.toThrow();
    expect(await f.client.request({ t: "start", peer: "fixture" })).toMatchObject({ ok: true });
    const answers: Envelope[] = [], untap = f.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "fixture") answers.push(event.env); });
    try {
      expect((await f.client.request({ t: "send", to: ["fixture"], body: "configured-delivery-proof" })).ok).toBe(true);
      await until(() => answers.some(env => env.body.includes("configured-delivery-proof")) && f.daemon.bus.stateOf("fixture") === "idle", "configured native answer settled");
      expect(answers.filter(env => env.body.includes("configured-delivery-proof"))).toHaveLength(1);
      expect(f.records().some(row => row.method === "session/set_mode" && row.params?.modeId === "default")).toBe(true);
      expect((await f.client.request({ t: "peer_stop", peer: "fixture" })).ok).toBe(true);
      expect(f.daemon.bus.stateOf("fixture")).toBe("offline");
    } finally { untap(); }
  } finally { await f.close(); }
}, 20_000);

test("configured ACP identity and restored-session mismatches refuse before a prompt", async () => {
  for (const mode of ["identity", "load"] as const) {
    const f = await fixture({ on: true, ...(mode === "identity" ? { pin: "Wrong native" } : {}) });
    try {
      const result = await f.client.request({ t: "start", peer: "fixture", ...(mode === "load" ? { args: { sessionId: "prior-session" } } : {}) });
      expect(result.ok).toBe(false);
      expect(f.records().some(row => row.method === "session/prompt")).toBe(false);
      if (mode === "load") expect(f.records().some(row => row.method === "session/load")).toBe(true);
      expect(f.daemon.bus.stateOf("fixture")).toBe("offline");
    } finally { await f.close(); }
  }
}, 20_000);

test("configured read-only instances acknowledge their native mode and refuse task mutation before board effects", async () => {
  const f = await fixture({ readOnly: true });
  try {
    expect(await f.client.request({ t: "start", peer: "fixture-check" })).toMatchObject({ ok: true });
    expect(f.records().some(row => row.method === "session/set_mode" && row.params?.modeId === "plan")).toBe(true);
    const tools = await f.connectTools("fixture-check");
    const before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    const result = await tools.request({ t: "task", op: "hub_task_propose", args: { title: "must never be recorded", class: "implement" } });
    expect(result.ok).toBe(false); expect(result.error).toContain("read-only");
    const after = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    expect(JSON.parse(after.text)).toEqual(JSON.parse(before.text));
    expect((await f.client.request({ t: "permission", peer: "fixture-check", mode: "never-ask", confirmed: true })).ok).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("adapter role edits remain restart-bound and configured identities never leak into another daemon", async () => {
  const f = await fixture({ on: true });
  try {
    const before = (await f.client.request({ t: "status" })).status.roleInfo.fixture.flowRoles;
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ ...f.local, adapters: { fixture: { ...f.adapter, roles: ["verifier"] } } }));
    let reloaded = await f.client.request({ t: "settings_reload" });
    if (reloaded.confirmation?.token) reloaded = await f.client.request({ t: "settings_reload", confirm: reloaded.confirmation.token });
    expect(reloaded.ok).toBe(true);
    const status = (await f.client.request({ t: "status" })).status;
    expect(status.roleInfo.fixture.flowRoles).toEqual(before);
    expect(status.pendingRestart.some((row: { key: string }) => row.key.startsWith("adapters.fixture"))).toBe(true);
    expect(definitionOf("fixture")).toBeUndefined();
  } finally { await f.close(); }
  const second = await fixture({ configured: false });
  try {
    expect((await second.client.request({ t: "start", peer: "fixture" })).ok).toBe(false);
    expect((await second.client.request({ t: "status" })).status.peers.fixture).toBeUndefined();
    expect(second.records()).toEqual([]);
  } finally { await second.close(); }
}, 20_000);


test("configured ACP keeps an unconfirmed stopped owner and retries teardown without replacing its child", async () => {
  const f = await fixture({ on: true });
  const original = AcpOwnedGroup.prototype.stop;
  let calls = 0;
  try {
    expect(await f.client.request({ t: "start", peer: "fixture" })).toMatchObject({ ok: true });
    await until(() => f.daemon.bus.stateOf("fixture") === "idle", "foreground fixture ready for stop");
    const owner = f.daemon.bus.peers.get("fixture");
    if (!isAcpPeer(owner)) throw new Error("configured native owner missing");
    const initializes = f.records().filter(row => row.method === "initialize").length;
    AcpOwnedGroup.prototype.stop = async function (options) {
      calls++;
      if (calls === 1) throw new Error("fixture transient stop verification unavailable");
      return original.call(this, options);
    };
    expect((await f.client.request({ t: "peer_stop", peer: "fixture" })).ok).toBe(false);
    expect(owner.state).toBe("offline"); expect(owner.pendingOwnedProcess).toBe(true);
    const retryStart = await f.client.request({ t: "start", peer: "fixture" });
    expect(retryStart.ok).toBe(false); expect(retryStart.error).toContain("teardown");
    expect(f.daemon.bus.peers.get("fixture")).toBe(owner);
    expect(f.records().filter(row => row.method === "initialize")).toHaveLength(initializes);
    expect(calls).toBe(1);
    AcpOwnedGroup.prototype.stop = original;
    expect((await f.client.request({ t: "peer_stop", peer: "fixture" })).ok).toBe(true);
    expect(owner.pendingOwnedProcess).toBe(false);
    expect(owner.state).toBe("offline");
  } finally { AcpOwnedGroup.prototype.stop = original; await f.close(); }
}, 20_000);

test("configured ACP recovery target incompatibility refuses inspection without holding the bus", async () => {
  const f = await fixture();
  try {
    expect(f.daemon.bus.isRecoveryHeld).toBe(false);
    const result = await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.client.instanceId,
      targetFeatures: DAEMON_FEATURES.filter(feature => feature !== "configured_acp") });
    expect(result.ok).toBe(false); expect(result.error).toContain("configured_acp");
    expect(f.daemon.bus.isRecoveryHeld).toBe(false);
    expect((await f.client.request({ t: "status" })).status.recovery).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);


test("the bundled MCP server publishes configured targets and enforces read-only tools over actual SDK transport", async () => {
  const f = await fixture({ on: true, readOnly: true });
  const sessions: Client[] = [];
  const originalTools = structuredClone(CONDUCTOR_TOOLS);
  const session = async (peer: "fixture" | "fixture-check") => {
    const home = join(f.root, "home");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home,
      AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "memory"), CLAUDE_CONFIG_DIR: join(home, "claude"),
      AGENTHUB_PROJECT_DIR: f.root, AGENTHUB_STATE_DIR: f.stateDir, AGENTHUB_PEER_ID: peer, AGENTHUB_MODE: "tools",
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    const sdk = new Client({ name: `configured-tools-${peer}`, version: "1" });
    sessions.push(sdk); // Own it before connect, including a failed native MCP startup.
    await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../plugins/agent-hub/server.js")], env, cwd: f.root, stderr: "ignore" }));
    return sdk;
  };
  try {
    const ordinary = await session("fixture");
    const tools = (await ordinary.listTools()).tools;
    const targets = (tools.find(tool => tool.name === "hub_peer_start")?.inputSchema.properties?.peer as { enum: string[] } | undefined)?.enum;
    expect(targets).toContain("fixture"); expect(targets).toContain("fixture-check");
    expect(CONDUCTOR_TOOLS).toEqual(originalTools);
    await ordinary.close(); sessions.splice(sessions.indexOf(ordinary), 1);

    const readOnly = await session("fixture-check");
    const names = (await readOnly.listTools()).tools.map(tool => tool.name);
    const allowed = ["hub_send", "hub_inbox", "hub_delivery_done", "hub_review", "hub_task_show", "hub_task_list", "hub_memory_search", "hub_memory_show", "hub_memory_graph", "hub_source_read", "hub_status"];
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(name => allowed.includes(name))).toBe(true);
    expect(names).toContain("hub_review"); expect(names).toContain("hub_task_list");
    expect(names).toContain("hub_source_read");
    expect(names).not.toContain("hub_task_propose"); expect(names).not.toContain("hub_peer_start");
    // Existing tools-only publication excludes inbox/delivery_done regardless of read-only status.
    expect(names).not.toContain("hub_inbox"); expect(names).not.toContain("hub_delivery_done");
    const listed = await readOnly.callTool({ name: "hub_task_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.content).toContainEqual({ type: "text", text: "[]" });
    const before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    // Bypass tool-list absence deliberately: the authenticated server/daemon must still refuse the mutation.
    const refused = await readOnly.request({ method: "tools/call", params: { name: "hub_task_propose", arguments: { title: "raw SDK mutation must not be recorded", class: "implement" } } }, CallToolResultSchema);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("read-only");
    const after = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    expect(JSON.parse(after.text)).toEqual(JSON.parse(before.text));
    expect(CONDUCTOR_TOOLS).toEqual(originalTools);
  } finally {
    try { await Promise.allSettled(sessions.reverse().map(sdk => sdk.close())); }
    finally { await f.close(); }
  }
}, 20_000);

test("production-loaded configured adapter defaults stay restart-bound across repeated confirmed reloads", async () => {
  const f = await fixture({ on: true, productionConfig: true });
  try {
    const before = (await f.client.request({ t: "status" })).status.roleInfo.fixture.flowRoles;
    expect(before).toContain("implementer");
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ ...f.local, adapters: { fixture: { ...f.adapter, roles: ["verifier"] } } }));
    for (let pass = 0; pass < 2; pass++) {
      let reload = await f.client.request({ t: "settings_reload" });
      if (reload.confirmation?.token) reload = await f.client.request({ t: "settings_reload", confirm: reload.confirmation.token });
      expect(reload.ok).toBe(true);
      const status = (await f.client.request({ t: "status" })).status;
      expect(status.roleInfo.fixture.flowRoles).toEqual(before);
      expect(status.pendingRestart.some((row: { key: string }) => row.key.startsWith("adapters.fixture"))).toBe(true);
    }
    expect(f.records()).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("production-loaded explicit role policy still tightens live without a declaration change", async () => {
  const f = await fixture({ on: true, productionConfig: true });
  try {
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ ...f.local, roles: { fixture: ["verifier"] } }));
    let reload = await f.client.request({ t: "settings_reload" });
    if (reload.confirmation?.token) reload = await f.client.request({ t: "settings_reload", confirm: reload.confirmation.token });
    expect(reload.ok).toBe(true);
    const status = (await f.client.request({ t: "status" })).status;
    expect(status.roleInfo.fixture.flowRoles).toEqual(["verifier"]);
    expect(status.pendingRestart.some((row: { key: string }) => row.key.startsWith("adapters.fixture"))).toBe(false);
    expect(f.records()).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("raw configured ACP start refuses invalid explicit session selectors before spawning", async () => {
  const f = await fixture({ on: true });
  try {
    const selectors: unknown[] = [0, null, "", "   ", false, {}, "bad\nidentity", "x".repeat(4097)];
    for (const sessionId of selectors) {
      const result = await f.client.request({ t: "start", peer: "fixture", args: { sessionId } });
      expect(result).toMatchObject({ ok: false, error: "configured ACP session selector is invalid" });
      expect(f.records()).toEqual([]);
    }
  } finally { await f.close(); }
}, 20_000);

test("live configured ACP distinguishes requested session identity without creating a second session", async () => {
  const f = await fixture({ on: true });
  try {
    expect(await f.client.request({ t: "start", peer: "fixture" })).toMatchObject({ ok: true });
    const owner = f.daemon.bus.peers.get("fixture");
    if (!isAcpPeer(owner)) throw new Error("configured owner unavailable");
    const sessionId = owner.recoveryMetadata().sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toBeTruthy();
    const initializeCount = f.records().filter(row => row.method === "initialize").length;
    expect(initializeCount).toBe(1);
    const different = await f.client.request({ t: "start", peer: "fixture", args: { sessionId: "PRIVATE_DIFFERENT_SESSION" } });
    expect(different).toMatchObject({ ok: false });
    expect(different.error).toContain("different native session");
    expect(JSON.stringify(different)).not.toContain("PRIVATE_DIFFERENT_SESSION");
    expect(await f.client.request({ t: "start", peer: "fixture", args: { sessionId } })).toMatchObject({ ok: true, already: true });
    expect(await f.client.request({ t: "start", peer: "fixture" })).toMatchObject({ ok: true, already: true });
    expect(f.daemon.bus.peers.get("fixture")).toBe(owner);
    expect(f.records().filter(row => row.method === "initialize")).toHaveLength(initializeCount);
    expect(f.records().filter(row => row.method === "session/new")).toHaveLength(1);
    expect(f.records().filter(row => row.method === "session/load")).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("concurrent configured ACP starts never join a different requested native session", async () => {
  const f = await fixture({ on: true });
  try {
    const first = f.client.request({ t: "start", peer: "fixture" });
    const second = f.client.request({ t: "start", peer: "fixture", args: { sessionId: "PRIVATE_CONCURRENT_SESSION" } });
    const [started, refused] = await Promise.all([first, second]);
    expect(started).toMatchObject({ ok: true });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toMatch(/start already in progress|different native session/);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE_CONCURRENT_SESSION");
    expect(f.records().filter(row => row.method === "initialize")).toHaveLength(1);
    expect(f.records().filter(row => row.method === "session/new")).toHaveLength(1);
    expect(f.records().filter(row => row.method === "session/load")).toEqual([]);
  } finally { await f.close(); }
}, 20_000);
