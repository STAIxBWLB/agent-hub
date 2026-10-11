import { createServer, createConnection } from "node:net";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JcodePeer, jcodeCommand } from "../src/adapters/jcode.ts";
import { configureJcodeMcp, jcodeMcpReady, JCODE_MCP_FILE, JCODE_MCP_NAME } from "../src/cli/jcode-mcp.ts";
import { launcherPreview } from "../src/cli/preview.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { permissionBoundary, permissionDefaults, grantablePath } from "../src/hub/permission-mode.ts";
import { rosterAllows } from "../src/hub/roster.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-test-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts")];
const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10); expect(condition()).toBe(true); };

test("Jcode project bridge preserves foreign values, supports both maps, refuses override/link/foreign collisions and stays private (#332)", () => {
  for (const key of ["servers", "mcpServers"]) {
    const dir = root(), file = join(dir, JCODE_MCP_FILE); mkdirSync(join(dir, ".jcode"));
    const foreign = { command: "foreign", args: ["keep"] };
    writeFileSync(file, JSON.stringify({ other: "keep", [key]: { foreign } }));
    expect(configureJcodeMcp(dir, "state", "bundle").changed).toBe(true);
    const data = JSON.parse(readFileSync(file, "utf8")); expect(data.other).toBe("keep"); expect(data[key].foreign).toEqual(foreign); expect(data[key][JCODE_MCP_NAME].shared).toBe(false);
    expect(jcodeMcpReady(dir, "state", "bundle")).toBe(true); expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(configureJcodeMcp(dir, "state", "bundle").changed).toBe(false);
    configureJcodeMcp(dir, "state", "bundle", true); expect(JSON.parse(readFileSync(file, "utf8"))[key]).toEqual({ foreign });
    writeFileSync(file, JSON.stringify({ [key]: { [JCODE_MCP_NAME]: foreign } }));
    expect(() => configureJcodeMcp(dir, "state", "bundle")).toThrow("foreign");
    writeFileSync(file, "{}"); writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { [JCODE_MCP_NAME]: foreign } }));
    expect(() => configureJcodeMcp(dir, "state", "bundle")).toThrow("overrides");
  }
  const dir = root(), target = root(); symlinkSync(target, join(dir, ".jcode"));
  expect(() => configureJcodeMcp(dir, "state", "bundle")).toThrow("not a link");
});

test("Jcode is off by default, native policy unmanaged, protected from scoped writes and previewed without side effects (#332)", () => {
  const dir = root(); expect(rosterAllows({}, "jcode", false)).toBe(false);
  expect(classifyPeerCommand("jcode", [])).toBe("console"); expect(permissionBoundary("jcode")).toContain("unmanaged");
  expect(() => permissionDefaults({ jcode: "ask" })).toThrow("no hub");
  mkdirSync(join(dir, ".jcode")); expect(grantablePath(dir, join(dir, ".jcode"))).toBe(false);
  const preview = launcherPreview("jcode", ["--model", "private-model", "--provider-profile", "private-profile"], dir, "state", false);
  expect(JSON.stringify(preview)).not.toContain("private-model"); expect(JSON.stringify(preview)).not.toContain("private-profile"); expect(existsSync(join(dir, JCODE_MCP_FILE))).toBe(false);
  expect(jcodeCommand(["jcode"], "serve", "socket", dir)).toContain("--temporary-server");
});

test("owned Jcode daemon and ACP client deliver, resume the exact id and stop without a global stop command (#332)", async () => {
  const dir = root(), home = join(dir, "home"), record = join(dir, "record"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--record", record], cwd: dir, home, resumeSessionId: "saved-jcode", launchModel: "fixture", providerProfile: "fixture" }); cleanups.push(() => peer.stop());
  const replies: string[] = []; peer.onMessage = message => { replies.push(message); };
  await peer.start(); expect(peer.permissionModeState).toBe("unmanaged");
  expect(peer.recoveryMetadata().sessionId).toBe("saved-jcode");
  await expect(peer.setPermissionMode("ask")).rejects.toThrow("no verified mode mapping");
  await peer.deliver([newEnvelope("user", "fixture", { to: ["jcode"] })]); await until(() => replies.length > 0);
  expect(replies[0]).toBe("JCODE_REPLY");
  const rows = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.find(row => row.method === "session/load").params.sessionId).toBe("saved-jcode");
  expect(rows.filter(row => row.kind === "rpc").every(row => row.home === home)).toBe(true);
  const server = rows.find(row => row.kind === "serve"); expect(existsSync(server.socket)).toBe(true);
  await peer.stop(); expect(existsSync(server.socket)).toBe(false);
  expect(() => process.kill(server.pid, 0)).toThrow();
});

test("Jcode source identity drift refuses the peer and cleans its owned daemon (#332)", async () => {
  const dir = root(), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--version-id", "0.95.0"], cwd: dir, home }); cleanups.push(() => peer.stop());
  await expect(peer.start()).rejects.toThrow("native ACP identity"); expect(peer.state).toBe("offline");
});

test("daemon verifies Jcode MCP read-only and preserves human-only policy and stop boundaries (#332)", async () => {
  const dir = root(), stateDir = join(dir, "state"), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: fake, jcode_home: home, roster: { jcode: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } }); cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "start", peer: "jcode" })).error).toContain("MCP entry"); expect(existsSync(join(dir, JCODE_MCP_FILE))).toBe(false);
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  expect((await client.request({ t: "start", peer: "jcode" })).ok).toBe(true);
  expect((await client.request({ t: "permission", peer: "jcode", mode: "ask" })).error).toContain("unmanaged");
  expect((await client.request({ t: "peer_stop", peer: "jcode" })).ok).toBe(true);
});


test("Jcode load without native identity proof refuses before any prompt or restored claim (#332)", async () => {
  const dir = root(), home = join(dir, "home"), record = join(dir, "record"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--record", record, "--no-load-echo"], cwd: dir, home, resumeSessionId: "saved-jcode" }); cleanups.push(() => peer.stop());
  await expect(peer.start()).rejects.toThrow("did not confirm"); expect(peer.state).toBe("offline");
  const rows = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.some(row => row.method === "session/prompt")).toBe(false);
});


test("a Jcode ACP transport exit closes its owned daemon and leaves no private socket (#332)", async () => {
  const dir = root(), home = join(dir, "home"), record = join(dir, "record"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--record", record, "--exit-after-prompt"], cwd: dir, home }); cleanups.push(() => peer.stop());
  await peer.start();
  const server = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.kind === "serve");
  await peer.deliver([newEnvelope("user", "fixture", { to: ["jcode"] })]);
  await until(() => peer.state === "offline" && !existsSync(server.socket));
  expect(() => process.kill(server.pid, 0)).toThrow();
});

test("the configured Jcode MCP SDK bridge reaches this project's tools as jcode (#332)", async () => {
  const dir = root(), stateDir = join(dir, "state"), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: fake, jcode_home: home, roster: { jcode: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } }); cleanups.push(() => daemon.stop());
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "jcode" })).ok).toBe(true);
  const entry = JSON.parse(readFileSync(join(dir, JCODE_MCP_FILE), "utf8")).mcpServers[JCODE_MCP_NAME];
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...entry.env }, stderr: "pipe" });
  let diagnostics = ""; transport.stderr?.on("data", data => { diagnostics += String(data); });
  const client = new Client({ name: "fixture", version: "1" }); cleanups.push(() => client.close());
  await client.connect(transport);
  await until(() => diagnostics.includes('connected to hub as "jcode"'));
  const receiver = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true }); cleanups.push(() => receiver.close());
  await until(() => daemon.bus.peers.get("claude")?.state === "idle");
  const seen: string[] = []; daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "jcode") seen.push(event.env.body); });
  const result = await client.callTool({ name: "hub_send", arguments: { to: ["claude"], text: "MCP_JCODE_FIXTURE" } });
  expect(result.isError).not.toBe(true); expect(seen, JSON.stringify(result)).toContain("MCP_JCODE_FIXTURE");
});


test("an occupied foreign socket is neither adopted nor unlinked by Jcode startup/stop (#332)", async () => {
  const dir = root(), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: fake, cwd: dir, home });
  const socket = (peer as unknown as { socket: string }).socket;
  const foreign = createServer(connection => connection.end());
  await new Promise<void>(resolve => foreign.listen(socket, resolve));
  cleanups.push(async () => { await new Promise<void>(resolve => foreign.close(() => resolve())); rmSync(dirname(socket), { recursive: true, force: true }); });
  await expect(peer.start()).rejects.toThrow("occupied"); await peer.stop(); expect(existsSync(socket)).toBe(true);
  await new Promise<void>((resolve, reject) => { const client = createConnection(socket); client.once("connect", () => { client.end(); resolve(); }); client.once("error", reject); });
});
