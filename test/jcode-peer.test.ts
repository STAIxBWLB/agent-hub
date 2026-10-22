import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { personEnv } from "../src/hub/child-process.ts";
import { createServer, createConnection } from "node:net";
import { basename, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JcodePeer, jcodeCommand, jcodeVersionSupported, verifiedJcodeCommand } from "../src/adapters/jcode.ts";
import { COMPAT } from "../src/adapters/compat.ts";
import { configureJcodeMcp, jcodeMcpReady, JCODE_MCP_FILE, JCODE_MCP_NAME } from "../src/cli/jcode-mcp.ts";
import { launcherPreview } from "../src/cli/preview.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { permissionBoundary, permissionDefaults, grantablePath } from "../src/hub/permission-mode.ts";
import { rosterAllows } from "../src/hub/roster.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";

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
  const dir = root(); expect(rosterAllows({}, "jcode", false, undefined, builtinProjectCatalog())).toBe(false);
  expect(classifyPeerCommand("jcode", [])).toBe("console"); expect(permissionBoundary("jcode", undefined, builtinProjectCatalog())).toContain("unmanaged");
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
  // Every owned jcode process opts out of native telemetry (#529).
  expect(rows.filter(row => row.kind === "rpc" || row.kind === "serve").every(row => row.telemetry === "1")).toBe(true);
  await peer.stop(); expect(existsSync(server.socket)).toBe(false);
  expect(() => process.kill(server.pid, 0)).toThrow();
});

test("Jcode native identity outside the supported range refuses the peer and cleans its owned daemon (#332, #529)", async () => {
  for (const version of ["0.94.0", "0.97.9", "1.0.0", "0.99.0-rc.1"]) {
    const dir = root(), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
    const peer = new JcodePeer({ command: [...fake, "--version-id", version], cwd: dir, home }); cleanups.push(() => peer.stop());
    await expect(peer.start()).rejects.toThrow("native ACP identity"); expect(peer.state).toBe("offline");
  }
});

test("Jcode accepts any native release from the verified minimum up to the breaking version, the minor unpinned (#529)", async () => {
  expect(COMPAT.jcode.line).toEqual({ min: "0.98.0", below: "1.0.0" });
  for (const version of ["0.98.0", "0.98.1", "0.99.0", "0.120.3"]) expect(jcodeVersionSupported(version)).toBe(true);
  for (const version of ["0.94.0", "0.97.9", "1.0.0", "2.1.0", "0.99.0-rc.1", "0.98", "v0.98.1", "", undefined, 98]) expect(jcodeVersionSupported(version)).toBe(false);
  const dir = root(), home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--version-id", "0.98.1"], cwd: dir, home }); cleanups.push(() => peer.stop());
  await peer.start(); expect(peer.state).toBe("idle");
  for (const [semver, ok] of [["0.98.0", true], ["0.98.1", true], ["0.97.9", false], ["0.94.0", false], ["1.0.0", false]] as const) expect(verifiedJcodeCommand([...fake, "--semver", semver], dir)).toBe(ok);
});

test("the owned Jcode socket name keeps the native debug socket apart from the main one (#529)", () => {
  const dir = root(), home = join(dir, "home"); mkdirSync(home);
  const peer = new JcodePeer({ command: fake, cwd: dir, home }); cleanups.push(() => peer.stop());
  const socket = (peer as unknown as { socket: string }).socket;
  // jcode derives its debug socket by replacing ".sock" in the file name; without it both binds are one path.
  expect(socket.endsWith(".sock")).toBe(true);
  expect(join(dirname(socket), basename(socket).replace(".sock", "-debug.sock"))).not.toBe(socket);
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


test("Jcode doctor probes the full configured wrapper argv with the native JSON version command (#332)", () => {
  const dir = root(), record = join(dir, "version");
  expect(verifiedJcodeCommand([...fake, "--record", record], dir)).toBe(true);
  const row = JSON.parse(readFileSync(record, "utf8").trim());
  expect(row.args.slice(-3)).toEqual(["--quiet", "version", "--json"]); expect(row.telemetry).toBe("1");
  expect(row.args).toContain(record);
});


test("Jcode stays non-ready across socket unlink until delayed owned-process exit is observed (#332)", async () => {
  const dir = root(), home = join(dir, "home"), record = join(dir, "record"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--record", record, "--exit-after-prompt", "--exit-delay-ms", "250"], cwd: dir, home }); cleanups.push(() => peer.stop());
  await peer.start();
  const rows = () => readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const server = rows().find(row => row.kind === "serve");
  await peer.deliver([newEnvelope("user", "fixture", { to: ["jcode"] })]);
  await until(() => rows().some(row => row.kind === "term") && !existsSync(server.socket));
  expect(peer.state).not.toBe("offline"); expect(peer.state).not.toBe("idle");
  await until(() => peer.state === "offline"); expect(() => process.kill(server.pid, 0)).toThrow();
});

test("pre-marker Jcode entries stay stale read-only until configure adds the delivery-only marker (#434)", () => {
  const dir = root(), state = join(dir, "state"), bundle = "bundle";
  configureJcodeMcp(dir, state, bundle);
  const file = join(dir, JCODE_MCP_FILE), current = JSON.parse(readFileSync(file, "utf8"));
  const legacy = structuredClone(current); delete legacy.mcpServers[JCODE_MCP_NAME].env.AGENTHUB_DELIVERY_ONLY;
  writeFileSync(file, JSON.stringify(legacy)); const before = readFileSync(file, "utf8");
  expect(jcodeMcpReady(dir, state, bundle)).toBe(false); expect(readFileSync(file, "utf8")).toBe(before);
  for (const mutate of [(entry: any) => { entry.env.AGENTHUB_DELIVERY_ONLY = "false"; }, (entry: any) => { entry.command = "foreign"; }, (entry: any) => { entry.env.AGENTHUB_PEER_ID = "codex"; }, (entry: any) => { entry.env.AGENTHUB_STATE_DIR = "other"; }, (entry: any) => { entry.args.push("--extra"); }]) {
    const changed = structuredClone(legacy); mutate(changed.mcpServers[JCODE_MCP_NAME]); writeFileSync(file, JSON.stringify(changed));
    expect(jcodeMcpReady(dir, state, bundle)).toBe(false);
  }
  writeFileSync(file, before); expect(configureJcodeMcp(dir, state, bundle).changed).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers[JCODE_MCP_NAME].env.AGENTHUB_DELIVERY_ONLY).toBe("true");
  expect(jcodeMcpReady(dir, state, bundle)).toBe(true);
});


test("only a console can resolve the same owned Jcode launch, and a new session waits for its native save (#464)", async () => {
  const dir = root(), stateDir = join(dir, "state"), home = join(dir, "home");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: [...fake, "--save-native-session"], jcode_home: home, roster: { jcode: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => consoleClient.close());
  expect((await consoleClient.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  const waiting = await consoleClient.request({ t: "native_tui_launch", peer: "jcode" });
  expect(waiting.ok).toBe(true);
  expect(waiting.state).toBe("waiting");
  expect(waiting.binding).toMatchObject({ sessionId: "jcode-s1" });
  expect(waiting.launch).toBeUndefined();
  expect(existsSync(join(home, "sessions", "jcode-s1.json"))).toBe(false);
  const toolsClient = await ControlClient.connect(stateDir, { role: "tools", peer: "jcode" }); cleanups.push(() => toolsClient.close());
  const denied = await toolsClient.request({ t: "native_tui_launch", peer: "jcode" });
  expect(denied.ok).toBe(false); expect(denied.launch).toBeUndefined(); expect(denied.binding).toBeUndefined();
  const stale = await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: { ...waiting.binding as object, launchId: "stale" } });
  expect(stale.ok).toBe(false); expect(stale.launch).toBeUndefined();
  const peer = daemon.bus.peers.get("jcode")!;
  await peer.deliver([newEnvelope("user", "fixture", { to: ["jcode"] })]);
  await until(() => existsSync(join(home, "sessions", "jcode-s1.json")) && peer.state === "idle");
  const ready = await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding });
  expect(ready.ok).toBe(true); expect(ready.state).toBe("ready"); expect(ready.binding).toEqual(waiting.binding);
  expect(ready.launch.args).toContain("--resume"); expect(ready.launch.args).not.toContain("acp"); expect(ready.launch.args).not.toContain("connect");
  expect(ready.launch.env).toEqual({ JCODE_HOME: home, JCODE_SOCKET: ready.launch.env.JCODE_SOCKET, JCODE_DISABLE_CLAUDE_MCP: "1", JCODE_NO_TELEMETRY: "1" });
  expect(JSON.stringify((await consoleClient.request({ t: "status" })).status)).not.toContain(ready.launch.env.JCODE_SOCKET);
  const frontend = await consoleClient.request({ t: "peer_start", peer: "jcode" });
  expect(frontend.ok).toBe(false); expect(frontend.command).toBe("ahub jcode --mode tui");
  expect(frontend.already).toBeUndefined(); expect(frontend.launch).toBeUndefined();
  const file = join(home, "sessions", "jcode-s1.json");
  writeFileSync(file, JSON.stringify({ id: "another", messages: [] }));
  expect((await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding })).ok).toBe(false);
  writeFileSync(file, "{}"); truncateSync(file, 32 * 1024 * 1024 + 1);
  expect((await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding })).ok).toBe(false);
  rmSync(file); mkdirSync(file);
  expect((await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding })).ok).toBe(false);
  rmSync(file, { recursive: true }); symlinkSync(join(home, "mcp.json"), file);
  expect((await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding })).ok).toBe(false);
  await peer.stop();
  expect((await consoleClient.request({ t: "native_tui_launch", peer: "jcode", binding: waiting.binding })).ok).toBe(false);
});


test("the actual person CLI waits for native persistence and executes the TUI with Jcode identity while ACP stays alive (#464)", async () => {
  // The CLI resolves --project to the real path; macOS's default TMPDIR is a symlink (#559 N6).
  const dir = realPath(root()), stateDir = join(dir, ".agenthub", "state"), home = join(dir, "home"), record = join(dir, "record");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); mkdirSync(join(dir, ".agenthub"));
  expect(Bun.spawnSync(["git", "init", "--quiet", dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).exitCode).toBe(0);
  const command = [...fake, "--save-native-session", "--record", record];
  const config = { ...DEFAULT_CONFIG, jcode_cmd: command, jcode_home: home, roster: { jcode: true },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } };
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(config));
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  cleanups.push(() => daemon.stop());
  const main = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(dir, "person-cli.ts");
  writeFileSync(wrapper, `Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.argv = [process.execPath, ${JSON.stringify(main)}, "--project", ${JSON.stringify(dir)}, "jcode"];
await import(${JSON.stringify(main)});
`);
  const env = personEnv({ ...process.env, HOME: home });
  for (const name of ["AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete env[name];
  const child = Bun.spawn([process.execPath, wrapper], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  let stdout = "";
  const output = (async () => { for await (const chunk of child.stdout) stdout += Buffer.from(chunk).toString(); })();
  const errors = new Response(child.stderr).text();
  await until(() => stdout.includes("jcode's TUI opens after its first hub turn; send it work, or Ctrl-C") || child.exitCode !== null);
  if (child.exitCode !== null) { await output; expect(await errors).toBe(""); }
  expect(stdout).toContain("jcode's TUI opens after its first hub turn; send it work, or Ctrl-C");
  const rows = () => readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows().some(row => row.kind === "tui")).toBe(false);
  const peer = daemon.bus.peers.get("jcode")!;
  await peer.deliver([newEnvelope("user", "fixture", { to: ["jcode"] })]);
  expect(await child.exited).toBe(0); await output; expect(await errors).toBe("");
  const tui = rows().find(row => row.kind === "tui");
  expect(tui.peer).toBe("jcode"); expect(tui.home).toBe(home); expect(tui.telemetry).toBe("1");
  expect(tui.args).toContain("--resume"); expect(tui.args).not.toContain("acp");
  expect(tui.socket).toBe(rows().find(row => row.kind === "serve").socket);
  expect(peer.state).toBe("idle"); expect(existsSync(tui.socket)).toBe(true);
});

// #572 AC1: jcode's server accepts a message into a running session (a soft interrupt, injected at the next tool
// boundary). Verified on 0.99.0 under an isolated home; the fake models only what the hub's steer uses.
function steerRig(extra: string[] = []) {
  const dir = realPath(root()), home = join(dir, "home"), record = join(dir, "record"), gate = join(dir, "gate");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = new JcodePeer({ command: [...fake, "--record", record, "--steer-file", gate, ...extra], cwd: dir, home, steerTimeoutMs: 600 }); cleanups.push(() => peer.stop());
  const receipts: { id: string; state: string; reason?: string }[] = [], replies: { body: string; opts?: any }[] = [];
  peer.onDelivery = receipt => { receipts.push(receipt); };
  peer.onMessage = (body, opts) => { replies.push({ body, opts }); };
  const rows = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, peer, receipts, replies, rows, gate };
}

test("a busy Jcode takes an important message into its running turn and answers its sender too (#572 AC1)", async () => {
  const rig = steerRig();
  await rig.peer.start();
  const first = newEnvelope("user", "start the long job", { to: ["jcode"] });
  await rig.peer.deliver([first], "d-first");
  await until(() => rig.peer.state === "busy" && existsSync(`${rig.gate}.busy`));
  const important = newEnvelope("claude", "put the main checkout back on main", { to: ["jcode"], priority: "important" });
  await rig.peer.steer!([important], "d-steer");
  const steered = rig.rows().find(row => row.kind === "soft_interrupt");
  expect(steered.content).toContain("put the main checkout back on main"); expect(steered.content).toContain('from "claude"');
  expect(typeof steered.client_id).toBe("string"); expect(steered.urgent).toBe(false);
  await until(() => rig.receipts.some(r => r.id === "d-steer" && r.state === "completed"));
  expect(rig.receipts.filter(r => r.id === "d-steer").map(r => r.state)).toEqual(["accepted", "completed"]);
  expect(rig.receipts.filter(r => r.id === "d-first").map(r => r.state)).toEqual(["accepted", "completed"]);
  expect(rig.replies).toHaveLength(1);
  expect(rig.replies[0]!.opts.to).toEqual(["user", "claude"]);
  expect(rig.replies[0]!.opts.inReplyTo.id).toBe(important.id);
  await until(() => rig.peer.state === "idle");
});

test("a steer that the owned server cannot take is refused before anything is sent, so the message stays queued (#572 AC1)", async () => {
  for (const [flag, why] of [["--no-soft-interrupt", "soft interrupt"], ["--wrong-session", "session"]] as const) {
    const rig = steerRig([flag]);
    await rig.peer.start();
    await rig.peer.deliver([newEnvelope("user", "work", { to: ["jcode"] })], "d-first");
    await until(() => existsSync(`${rig.gate}.busy`));
    await expect(rig.peer.steer!([newEnvelope("claude", "urgent", { to: ["jcode"], priority: "important" })], "d-steer")).rejects.toThrow(why);
    expect(rig.rows().some(row => row.kind === "soft_interrupt")).toBe(false);
    expect(rig.receipts.find(r => r.id === "d-steer")).toMatchObject({ state: "failed_safe" });
    writeFileSync(rig.gate, "release"); await until(() => rig.peer.state === "idle");
  }
  const idle = steerRig();
  await idle.peer.start();
  await expect(idle.peer.steer!([newEnvelope("claude", "urgent", { to: ["jcode"], priority: "important" })], "d-idle")).rejects.toThrow("idle");
  expect(idle.rows().some(row => row.kind === "soft_interrupt")).toBe(false);
  expect(idle.receipts.find(r => r.id === "d-idle")).toMatchObject({ state: "failed_safe" });
});

test("a steer sent but never acknowledged is held for review, never requeued as if it had not gone in (#572 AC1)", async () => {
  const rig = steerRig(["--no-ack"]);
  await rig.peer.start();
  await rig.peer.deliver([newEnvelope("user", "work", { to: ["jcode"] })], "d-first");
  await until(() => existsSync(`${rig.gate}.busy`));
  await expect(rig.peer.steer!([newEnvelope("claude", "urgent", { to: ["jcode"], priority: "important" })], "d-steer")).rejects.toThrow("uncertain");
  expect(rig.rows().some(row => row.kind === "soft_interrupt")).toBe(true);
  expect(rig.receipts.find(r => r.id === "d-steer")).toMatchObject({ state: "needs_review" });
  writeFileSync(rig.gate, "release"); await until(() => rig.peer.state === "idle");
});

test("the bus steers an important message into a busy Jcode through the owned socket (#572 AC1)", async () => {
  const dir = realPath(root()), stateDir = join(dir, "state"), home = join(dir, "home"), record = join(dir, "record"), gate = join(dir, "gate");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: [...fake, "--record", record, "--steer-file", gate], jcode_home: home, roster: { jcode: true }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => consoleClient.close());
  expect((await consoleClient.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  daemon.bus.publish(newEnvelope("user", "long job", { to: ["jcode"] }));
  await until(() => existsSync(`${gate}.busy`));
  daemon.bus.publish(newEnvelope("user", "STEER-ME-NOW", { to: ["jcode"], priority: "important" }));
  await until(() => existsSync(record) && readFileSync(record, "utf8").includes("STEER-ME-NOW"));
  await until(() => daemon.bus.queued("jcode") === 0 && daemon.bus.peers.get("jcode")!.state === "idle");
  expect(readFileSync(record, "utf8").match(/"kind":"soft_interrupt"/g)).toHaveLength(1);
});

test("a conductor start of an attached Jcode answers already and opens no terminal; the console's start still reopens one (#559 N1)", async () => {
  const dir = realPath(root()), stateDir = join(dir, "state"), home = join(dir, "home"), opened: string[][] = [];
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); mkdirSync(join(dir, ".agenthub"));
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const terminal = () => ({ available: () => ({ ok: true as const, via: "fixture" }), open: async (_title: string, argv: readonly string[]) => { opened.push([...argv]); return { ok: true as const, via: "fixture" }; } });
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, terminal,
    config: { ...DEFAULT_CONFIG, jcode_cmd: [...fake, "--save-native-session"], jcode_home: home, roster: { jcode: true }, roles: { ...DEFAULT_CONFIG.roles, claude: ["conductor"] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => consoleClient.close());
  const lead = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); cleanups.push(() => lead.close());
  expect((await consoleClient.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  expect(daemon.bus.peers.get("jcode")?.state).not.toBe("offline");
  for (let i = 0; i < 2; i++) {
    const reply = await lead.request({ t: "task", op: "hub_peer_start", args: { peer: "jcode" } });
    expect(reply.ok).toBe(true);
    expect(JSON.parse(reply.text)).toMatchObject({ peer: "jcode", mode: "tui", already: true });
  }
  expect(opened).toEqual([]);
  const person = await consoleClient.request({ t: "peer_start", peer: "jcode" });
  expect(person.ok).toBe(true); expect(person.opened).toBe("fixture"); expect(person.already).toBeUndefined();
  expect(opened).toHaveLength(1);
});

test("a steer acknowledged after its turn ended is never adopted into the next turn (#572 AC1, review I1)", async () => {
  const rig = steerRig(["--ack-delay-ms", "500"]);
  await rig.peer.start();
  await rig.peer.deliver([newEnvelope("user", "turn A", { to: ["jcode"] })], "d-A");
  await until(() => existsSync(`${rig.gate}.busy`));
  const important = newEnvelope("claude", "important for A", { to: ["jcode"], priority: "important" });
  const outcome = rig.peer.steer!([important], "d-steer").then(() => "adopted", (error: Error) => error.message);
  // The server took the message and A ends before the acknowledgement arrives; an unrelated turn B starts on the same session.
  await until(() => rig.rows().some(row => row.kind === "soft_interrupt"));
  await until(() => rig.peer.state === "idle" && rig.receipts.some(r => r.id === "d-A" && r.state === "completed"));
  rmSync(rig.gate, { force: true });
  await rig.peer.deliver([newEnvelope("qwen", "turn B, another audience", { to: ["jcode"] })], "d-B");
  await until(() => existsSync(`${rig.gate}.busy`));
  expect(rig.peer.state).toBe("busy");
  expect(await outcome).toContain("uncertain");
  writeFileSync(rig.gate, "release B"); await until(() => rig.peer.state === "idle");
  const steer = rig.receipts.filter(r => r.id === "d-steer").map(r => r.state);
  expect(steer).toContain("needs_review"); expect(steer).not.toContain("completed"); expect(steer).not.toContain("accepted"); expect(steer).not.toContain("failed_safe");
  expect(rig.replies.at(-1)!.opts.to).toEqual(["qwen"]); // B answers only its own sender, never A's steered one
  expect(rig.replies.at(-1)!.opts.inReplyTo.from).toBe("qwen");
});

test("a steer whose turn changed while the hub waited on the server is refused before anything is sent (#572 AC1, review round 2 I1)", async () => {
  const dir = realPath(root()), stateGate = join(dir, "state-gate");
  const rig = steerRig(["--state-reply-gate", stateGate]);
  await rig.peer.start();
  await rig.peer.deliver([newEnvelope("user", "turn A", { to: ["jcode"] })], "d-A");
  await until(() => existsSync(`${rig.gate}.busy`));
  const outcome = rig.peer.steer!([newEnvelope("claude", "meant for A", { to: ["jcode"], priority: "important" })], "d-steer").then(() => "sent", (error: Error) => error.message);
  await until(() => existsSync(`${stateGate}.waiting`)); // the server's state reply is held: the hub is between ping and send
  expect(rig.rows().some(row => row.kind === "soft_interrupt")).toBe(false);
  writeFileSync(rig.gate, "finish A"); await until(() => rig.peer.state === "idle" && rig.receipts.some(r => r.id === "d-A" && r.state === "completed"));
  rmSync(rig.gate, { force: true });
  await rig.peer.deliver([newEnvelope("qwen", "turn B, another audience", { to: ["jcode"] })], "d-B");
  await until(() => existsSync(`${rig.gate}.busy`)); // B is busy, so the held reply will now say "processing"
  writeFileSync(stateGate, "release");
  expect(await outcome).toContain("turn changed");
  expect(rig.rows().some(row => row.kind === "soft_interrupt")).toBe(false); // nothing reached the native server, so B is untouched
  writeFileSync(rig.gate, "finish B"); await until(() => rig.peer.state === "idle");
  expect(rig.receipts.filter(r => r.id === "d-steer").map(r => r.state)).toEqual(["failed_safe"]);
  expect(rig.replies.at(-1)!.opts.to).toEqual(["qwen"]);
});

test("a stop, a cancel or a replaced launch before the send also refuses the steer without sending (#572 AC1, review round 2 I1)", async () => {
  const dir = realPath(root()), stateGate = join(dir, "state-gate");
  const rig = steerRig(["--state-reply-gate", stateGate]);
  await rig.peer.start();
  await rig.peer.deliver([newEnvelope("user", "turn A", { to: ["jcode"] })], "d-A");
  await until(() => existsSync(`${rig.gate}.busy`));
  const outcome = rig.peer.steer!([newEnvelope("claude", "meant for A", { to: ["jcode"], priority: "important" })], "d-steer").then(() => "sent", (error: Error) => error.message);
  await until(() => existsSync(`${stateGate}.waiting`));
  const stopping = rig.peer.stop("a person stopped it"); // the owned server goes away while the steer waits
  writeFileSync(stateGate, "release");
  expect(await outcome).not.toBe("sent");
  await stopping;
  expect(rig.rows().some(row => row.kind === "soft_interrupt")).toBe(false);
  const states = rig.receipts.filter(r => r.id === "d-steer").map(r => r.state);
  expect(states).not.toContain("accepted"); expect(states).not.toContain("completed");
});

test("Jcode configuration is refused from scoped grants under symlink aliases and case variants (#332 AC5)", () => {
  const dir = realPath(root());
  const canonical = join(dir, ".jcode");
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, "mcp.json"), "{}");
  writeFileSync(join(canonical, "config.json"), "{}");

  // Case variants: upper, title, mixed case, nested paths
  for (const variant of [".JCODE", ".Jcode", ".jCode"]) {
    const vdir = join(dir, variant);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, "mcp.json"), "{}");
    expect(grantablePath(dir, vdir)).toBe(false);
    expect(grantablePath(dir, join(vdir, "mcp.json"))).toBe(false);
    expect(grantablePath(dir, join(dir, "nested", variant, "config.json"))).toBe(false);
  }

  // Symlink alias to .jcode directory
  const aliasDir = join(dir, "jcode-alias");
  symlinkSync(canonical, aliasDir);
  expect(grantablePath(dir, realPath(aliasDir))).toBe(false);
  expect(grantablePath(dir, realPath(join(aliasDir, "mcp.json")))).toBe(false);
  expect(grantablePath(dir, realPath(join(aliasDir, "config.json")), join(aliasDir, "config.json"))).toBe(false);

  // Symlink file pointing into .jcode
  const fileAlias = join(dir, "alias-mcp.json");
  symlinkSync(join(canonical, "mcp.json"), fileAlias);
  expect(grantablePath(dir, realPath(fileAlias))).toBe(false);
  expect(grantablePath(dir, realPath(fileAlias), fileAlias)).toBe(false);

  // Symlink inside .jcode pointing outside to an ordinary file
  const ordinaryFile = join(dir, "ordinary.txt");
  writeFileSync(ordinaryFile, "hello");
  const linkInJcode = join(canonical, "link-to-ordinary.txt");
  symlinkSync(ordinaryFile, linkInJcode);
  expect(grantablePath(dir, realPath(linkInJcode), linkInJcode)).toBe(false);
});

// Observe the actual fake child argv/env without changing the shared conformance fake.
function recordedJcode(dir: string) {
  const record = join(dir, "native.jsonl"), launches = join(dir, "launches.jsonl"), wrapper = join(dir, "record-native.ts");
  writeFileSync(wrapper, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ args: process.argv.slice(2), launchId: process.env.AGENTHUB_LAUNCH_ID }) + "\\n");
await import(${JSON.stringify(fake[1])});
`);
  return { record, command: [process.execPath, wrapper, "--record", record],
    launches: (): { args: string[]; launchId?: string }[] => readFileSync(launches, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

test("Jcode PII routing withholds confidential tasks from jcode and applies public markers (#332 AC5)", async () => {
  const dir = realPath(root()), stateDir = join(dir, "state"), home = join(dir, "home");
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));

  const native = recordedJcode(dir);

  // 1. assign() refuses jcode for PII tasks because trust.onPrem is false
  const routing = loadRouting(process.cwd());
  const jcodeRouting = { ...routing, classes: { ...routing.classes, implement: { ...routing.classes.implement, peers: ["jcode"] } } };
  const assignment = assign({ id: 1, class: "implement", signals: ["pii"] }, { jcode: "idle" }, jcodeRouting, {});
  expect(assignment.owner).toBeUndefined();
  expect(assignment.refusals).toEqual([
    expect.objectContaining({ peer: "jcode", role: "owner", code: "pii", reason: "pii: on-prem peers only" }),
  ]);

  // 2. Daemon live flow: propose a PII task and verify withholding and public markers
  const daemon = await startDaemon({
    cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: {
      ...DEFAULT_CONFIG,
      jcode_cmd: native.command,
      jcode_home: home,
      roster: { jcode: true },
      roles: { ...DEFAULT_CONFIG.roles, jcode: ["implementer"] },
      batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    },
  });
  cleanups.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => consoleClient.close());
  expect((await consoleClient.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);

  daemon.bus.pause("jcode"); // A withheld task cannot be confused with a prompt that was delivered and drained.
  const SECRET = "patient-900101-1234567";
  const title = `update record ${SECRET}`;
  const prop = await consoleClient.request({
    t: "task", op: "hub_task_propose",
    args: { title, detail: "confidential medical file", class: "implement", signals: ["pii"] },
  });
  expect(prop.ok).toBe(true);

  // Tools client as jcode: verify public view and markers
  const ownedLaunch = native.launches().find(row => row.args.includes("acp"));
  expect(ownedLaunch).toBeDefined();
  const jcodeClient = await ControlClient.connect(stateDir, { role: "tools", peer: "jcode", ...(ownedLaunch?.launchId ? { launchId: ownedLaunch.launchId } : {}) }); cleanups.push(() => jcodeClient.close());
  const jcodeList = await jcodeClient.request({ t: "task", op: "hub_task_list", args: {} });
  expect(jcodeList.ok).toBe(true);
  const rows = JSON.parse(jcodeList.text);
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe("[pii]");
  expect(rows[0].detail).toBe("[pii]");
  expect(jcodeList.text).not.toContain(SECRET);

  // Jcode cannot claim or accept the PII task
  const accept = await jcodeClient.request({ t: "task", op: "hub_task_accept", args: { id: 1, plan: { paths: ["src/a.ts"] } } });
  expect(accept.ok).toBe(false);

  // The queue is checked while paused, then an ordinary prompt acts as a consuming barrier.
  expect(daemon.bus.queued("jcode")).toBe(0);
  const barrier = "PII_NATIVE_BARRIER";
  daemon.bus.publish(newEnvelope("user", barrier, { to: ["jcode"] }));
  expect(daemon.bus.queued("jcode")).toBe(1);
  daemon.bus.resume("jcode");
  await until(() => readFileSync(native.record, "utf8").includes(barrier));
  await until(() => daemon.bus.peers.get("jcode")!.state === "idle");
  const received = readFileSync(native.record, "utf8");
  expect(received).toContain("session/prompt");
  expect(received).toContain(barrier);
  expect(received).not.toContain(title);
  expect(received).not.toContain(SECRET);
});

test("no raw native payload or credential from Jcode reaches hub.log or events (#332 AC5)", async () => {
  const dir = realPath(root()), stateDir = join(dir, "state"), home = join(dir, "home");
  const native = recordedJcode(dir), record = native.record;
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));

  const SECRET_PROFILE = "secret-provider-credential-987";
  const SECRET_MODEL = "secret-model-credential-654";
  const SECRET_PII = "confidential-pii-payload-321";

  // Launcher preview redacts model and provider profile credentials
  const preview = launcherPreview("jcode", ["--model", SECRET_MODEL, "--provider-profile", SECRET_PROFILE], dir, stateDir, false);
  expect(JSON.stringify(preview)).not.toContain(SECRET_MODEL);
  expect(JSON.stringify(preview)).not.toContain(SECRET_PROFILE);

  const daemon = await startDaemon({
    cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: {
      ...DEFAULT_CONFIG,
      jcode_cmd: native.command,
      jcode_home: home,
      jcode_provider_profile: SECRET_PROFILE,
      roster: { jcode: true },
      batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    },
  });
  cleanups.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => consoleClient.close());
  expect((await consoleClient.request({ t: "start", peer: "jcode", args: { mode: "headless", model: SECRET_MODEL, providerProfile: SECRET_PROFILE } })).ok).toBe(true);

  const actualLaunches = native.launches().filter(row => row.args.includes("serve") || row.args.includes("acp"));
  expect(actualLaunches).toHaveLength(2);
  for (const launch of actualLaunches) {
    expect(launch.args).toContain("--model"); expect(launch.args).toContain(SECRET_MODEL);
    expect(launch.args).toContain("--provider-profile"); expect(launch.args).toContain(SECRET_PROFILE);
  }
  const readEvents = (): { type: string; id?: string; peer?: string }[] => readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

  // Deliver turn with normal message
  const normal = newEnvelope("user", "normal turn message", { to: ["jcode"] });
  daemon.bus.publish(normal);
  await until(() => existsSync(record) && readFileSync(record, "utf8").includes("normal turn message"));
  await until(() => daemon.bus.queued("jcode") === 0 && daemon.bus.peers.get("jcode")!.state === "idle");

  await until(() => readEvents().some(row => row.type === "turn_end" && row.peer === "jcode"));
  const normalEnds = readEvents().filter(row => row.type === "turn_end" && row.peer === "jcode").length;

  // Publish a private envelope
  daemon.bus.publish(newEnvelope("hub", `private work ${SECRET_PII}`, { to: ["jcode"], private: true, priority: "important" }));
  await until(() => readFileSync(record, "utf8").includes(SECRET_PII));
  await until(() => readEvents().filter(row => row.type === "turn_end" && row.peer === "jcode").length > normalEnds);

  const log = existsSync(join(stateDir, "hub.log")) ? readFileSync(join(stateDir, "hub.log"), "utf8") : "";
  const events = existsSync(join(stateDir, "events.jsonl")) ? readFileSync(join(stateDir, "events.jsonl"), "utf8") : "";

  // Positive controls: real native prompts and this normal turn's public event exist.
  expect(readFileSync(record, "utf8")).toContain("session/prompt");
  expect(readFileSync(record, "utf8")).toContain(SECRET_PII);
  expect(readEvents()).toContainEqual(expect.objectContaining({ type: "envelope", id: normal.id }));

  // Proves credentials never reach hub.log or events
  expect(log).not.toContain(SECRET_PROFILE);
  expect(events).not.toContain(SECRET_PROFILE);
  expect(log).not.toContain(SECRET_MODEL);
  expect(events).not.toContain(SECRET_MODEL);

  // Proves raw native JSON-RPC payloads (session/prompt, jsonrpc wire frames) never reach hub.log or events
  expect(log).not.toContain("session/prompt");
  expect(log).not.toContain('"jsonrpc":"2.0"');
  expect(events).not.toContain("session/prompt");
  expect(events).not.toContain('"jsonrpc":"2.0"');

  // Proves private PII text is not leaked into hub.log or events
  expect(log).not.toContain(SECRET_PII);
  expect(events).not.toContain(SECRET_PII);
});
