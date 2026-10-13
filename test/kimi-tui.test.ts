import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { HUB, newEnvelope, USER } from "../src/hub/envelope.ts";
import { startModeOf } from "../src/hub/start-mode.ts";
import { SETTINGS } from "../src/hub/settings.ts";
import { renderStatus } from "../src/cli/output.ts";
import { configureKimiMcp } from "../src/cli/kimi-mcp.ts";
import { nativeLaunchEnv } from "../src/cli/launch.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function observed(condition: () => boolean) {
  const end = performance.now() + 5000;
  while (!condition() && performance.now() < end) await Bun.sleep(10);
  expect(condition()).toBe(true);
}
async function rig(mode?: "tui" | "headless") {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-tui-"))), stateDir = join(cwd, "state");
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: mode ? { kimi: { start_mode: mode } } : {}, batch_ms: 0,
      kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")],
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  async function attach() {
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "kimi", channel: false }); cleanups.push(() => peer.close());
    await observed(() => daemon.bus.peers.get("kimi")?.state === "idle");
    return peer;
  }
  return { cwd, stateDir, daemon, console_, attach };
}

test("Kimi default and settings floor are TUI, and native hello admits only pull mode (#316)", async () => {
  expect(startModeOf(undefined, "kimi")).toBe("tui");
  expect(SETTINGS.find(row => row.key === "peers.kimi.start_mode")).toMatchObject({ floor: "tui", values: ["tui", "headless"] });
  const hub = await rig();
  await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer: "kimi", channel: true })).rejects.toThrow();
  const peer = await hub.attach();
  expect((await hub.console_.request({ t: "status" })).status.peers.kimi).toMatchObject({ state: "idle", pullOnly: true, queued: 0, lastInboxAt: null });
  expect((await peer.request({ t: "inbox" })).ok).toBe(true);
  expect((await hub.console_.request({ t: "start", peer: "kimi" })).error).toContain("run ahub kimi in a terminal");
  expect((await hub.console_.request({ t: "permission", peer: "kimi", mode: "ask" })).error).toContain("own TUI");
  expect((await hub.console_.request({ t: "peer_stop", peer: "kimi" })).error).toContain("own TUI");
  const other = await rig("headless");
  for (const channel of [false, true]) await expect(ControlClient.connect(other.stateDir, { role: "peer", peer: "kimi", channel })).rejects.toThrow();
});

test("Kimi pulls chat, task and review once, completes the journal and exposes last read (#316)", async () => {
  const hub = await rig(), peer = await hub.attach();
  const pushes: any[] = []; peer.onPush = message => pushes.push(message);
  const messages = [newEnvelope(USER, "queued chat", { to: ["kimi"] }), newEnvelope(HUB, "queued task", { to: ["kimi"], kind: "task" }), newEnvelope(HUB, "queued review", { to: ["kimi"], kind: "review" })];
  for (const message of messages) hub.daemon.bus.publish(message);
  const before = (await hub.console_.request({ t: "status" })).status;
  expect(before.peers.kimi).toMatchObject({ state: "idle", queued: 3, pullOnly: true, lastInboxAt: null });
  await hub.console_.request({ t: "pause", peer: "kimi" });
  expect((await peer.request({ t: "inbox" })).error).toContain("pause");
  expect(hub.daemon.bus.queued("kimi")).toBe(3);
  await hub.console_.request({ t: "resume", peer: "kimi" });
  const read = await peer.request({ t: "inbox" });
  expect(read.ok).toBe(true); expect(read.envs.map((message: any) => message.kind)).toEqual(["chat", "task", "review"]); expect(read.envs.map((message: any) => message.id)).toEqual(messages.map(message => message.id));
  expect((await peer.request({ t: "inbox" })).envs).toEqual([]);
  expect(pushes.filter(message => message.t === "deliver")).toEqual([]);
  const rows = hub.daemon.bus.queueList("kimi").filter(row => row.originals.some(message => messages.some(original => original.id === message.id)));
  expect(rows).toHaveLength(1); expect(rows[0]!.state).toBe("completed");
  const status = (await hub.console_.request({ t: "status" })).status;
  expect(status.peers.kimi).toMatchObject({ state: "idle", queued: 0, pullOnly: true }); expect(status.peers.kimi.lastInboxAt).toBeGreaterThan(0);
  const text = renderStatus(status, 120, status.peers.kimi.lastInboxAt + 1000).map(line => line.map(span => span.text).join("")).join("\n");
  expect(text).toContain("pull-only"); expect(text).toMatch(/kimi last read +1s ago/);
  expect((await hub.console_.request({ t: "ui_snapshot", after: 0 })).status.peers.kimi.lastInboxAt).toBe(status.peers.kimi.lastInboxAt);
});

test("Kimi mode switch refuses a live TUI and stale MCP entry, then delivers retained work to ACP (#316)", async () => {
  const hub = await rig(), peer = await hub.attach();
  const proposed = await hub.console_.request({ t: "task", op: "hub_task_propose", args: { title: "retain Kimi task across modes", class: "implement", owner: "kimi" } });
  expect(proposed.ok).toBe(true);
  const id = Number(proposed.text.match(/task #(\d+)/i)![1]);
  expect((await peer.request({ t: "task", op: "hub_task_accept", args: { id } })).ok).toBe(true);
  const original = newEnvelope(USER, "one queued after switch", { to: ["kimi"] }); hub.daemon.bus.publish(original);
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "headless" } })).error).toContain("end it there");
  peer.close(); await observed(() => hub.daemon.bus.peers.get("kimi")?.state === "offline");
  configureKimiMcp(hub.cwd, hub.stateDir, "/bundle/server.js", "tui");
  const file = join(hub.cwd, ".kimi-code/mcp.json"), before = readFileSync(file, "utf8");
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "headless" } })).error).toContain("project MCP file");
  expect(readFileSync(file, "utf8")).toBe(before);
  configureKimiMcp(hub.cwd, hub.stateDir, "/bundle/server.js", "headless");
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "headless" } })).ok).toBe(true);
  await observed(() => hub.daemon.bus.queueList("kimi").some(row => row.state === "completed" && row.originals.some(message => message.id === original.id)));
  expect(hub.daemon.bus.queueList("kimi").filter(row => row.state === "completed" && row.originals.some(message => message.id === original.id))).toHaveLength(1);
  const tasks = JSON.parse((await hub.console_.request({ t: "task", op: "hub_task_list", args: {} })).text);
  expect(tasks.find((task: any) => task.id === id)).toMatchObject({ owner: "kimi", state: "in_progress" });
  expect((await hub.console_.request({ t: "peer_stop", peer: "kimi" })).ok).toBe(true);
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } })).ok).toBe(true);
  await hub.attach();
});

test("Kimi's MCP child exposes inbox without completion and round-trips queued kinds and a reply (#316)", async () => {
  const hub = await rig();
  const receiver = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude", channel: true }); cleanups.push(() => receiver.close());
  await observed(() => hub.daemon.bus.peers.get("claude")?.state === "idle");
  const delivered: any[] = []; receiver.onPush = message => { if (message.t === "deliver") delivered.push(...message.envs); };
  const env = nativeLaunchEnv("kimi", { ...process.env, AGENTHUB_MODE: "tools", AGENTHUB_CHANNEL: "1" });
  expect(env.AGENTHUB_MODE).toBeUndefined(); expect(env.AGENTHUB_CHANNEL).toBeUndefined();
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], env: { ...env as Record<string, string>, AGENTHUB_STATE_DIR: hub.stateDir, AGENTHUB_PROJECT_DIR: hub.cwd }, stderr: "pipe" });
  let diagnostics = ""; transport.stderr?.on("data", data => { diagnostics += String(data); });
  const client = new Client({ name: "kimi-pull-fixture", version: "0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(transport);
  await observed(() => diagnostics.includes('connected to hub as "kimi"'));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain("hub_inbox"); expect(names).not.toContain("hub_delivery_done");
  const messages = [newEnvelope(USER, "MCP chat", { to: ["kimi"] }), newEnvelope(HUB, "MCP task", { to: ["kimi"], kind: "task" }), newEnvelope(HUB, "MCP review", { to: ["kimi"], kind: "review" })];
  for (const message of messages) hub.daemon.bus.publish(message);
  const read = await client.callTool({ name: "hub_inbox", arguments: {} });
  const text = JSON.stringify(read);
  for (const message of messages) { expect(text).toContain(message.id); expect(text).toContain(message.body); }
  expect(hub.daemon.bus.queueList("kimi").filter(row => row.originals.some(message => messages.some(original => original.id === message.id)))).toMatchObject([{ state: "completed" }]);
  const reply = await client.callTool({ name: "hub_send", arguments: { to: ["claude"], text: "MCP answer once" } });
  expect(reply.isError).not.toBe(true);
  await observed(() => delivered.some(message => message.body.includes("MCP answer once")));
  expect(delivered.filter(message => message.body.includes("MCP answer once"))).toHaveLength(1);
});

test("the person's Kimi TUI launcher writes MCP then runs the configured fake with its own clean identity (#316)", async () => {
  const hub = await rig();
  const fake = join(hub.cwd, "fake-kimi");
  writeFileSync(fake, `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; console.log(JSON.stringify({peer:process.env.AGENTHUB_PEER_ID,mode:process.env.AGENTHUB_MODE??null,channel:process.env.AGENTHUB_CHANNEL??null,recovery:process.env.AGENTHUB_RECOVERY_OPERATION??null,args:process.argv.slice(2),mcp:JSON.parse(readFileSync('.kimi-code/mcp.json','utf8'))}));\n`); chmodSync(fake, 0o700);
  expect(hubGitSync(["init", "-q"], { cwd: hub.cwd, encoding: "utf8" }).status).toBe(0);
  writeFileSync(join(hub.cwd, ".agenthub/config.local.json"), JSON.stringify({ kimi_cmd: [fake, "acp"] }));
  expect(loadConfig(hub.cwd).kimi_cmd).toEqual([fake, "acp"]); // proves the child is a fixture before anything can launch
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: join(hub.cwd, "home"), AGENTHUB_PROJECT_DIR: hub.cwd, AGENTHUB_STATE_DIR: hub.stateDir, AGENTHUB_MODE: "tools" };
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "kimi", "--mode", "tui", "--model", "fixture-model"], { cwd: hub.cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(""); expect(code).toBe(0);
  const native = JSON.parse(out);
  expect(native).toMatchObject({ peer: "kimi", mode: null, channel: null, recovery: null, args: ["--model", "fixture-model"] });
  expect(native.mcp.mcpServers["agent-hub"]).toMatchObject({ command: "bun", env: { AGENTHUB_PEER_ID: "kimi", AGENTHUB_STATE_DIR: hub.stateDir, AGENTHUB_PROJECT_DIR: hub.cwd } });
  expect(native.mcp.mcpServers["agent-hub"].env).not.toHaveProperty("AGENTHUB_MODE");
});

test("Kimi TUI argv admits only a single executable or exact final acp, and never echoes custom argv (#316)", async () => {
  const { buildKimiTuiLaunch } = await import("../src/cli/launch.ts");
  expect(buildKimiTuiLaunch(["/fixture/kimi"])).toMatchObject({ cmd: "/fixture/kimi", args: [] });
  expect(buildKimiTuiLaunch(["/fixture/wrapper", "--safe", "acp"])).toMatchObject({ cmd: "/fixture/wrapper", args: ["--safe"] });
  expect(buildKimiTuiLaunch(["/fixture/wrapper", "acp"], "fixture-model")).toMatchObject({ args: ["--model", "fixture-model"] });
  for (const tail of ["serve", "ACP", "acp ", "CUSTOM_ARG_SECRET"]) {
    let reason = "";
    try { buildKimiTuiLaunch(["/fixture/PRIVATE_COMMAND", tail]); } catch (error) { reason = (error as Error).message; }
    expect(reason).toContain("kimi_cmd"); expect(reason).toContain("ahub kimi --mode headless");
    expect(reason).not.toContain(tail); expect(reason).not.toContain("PRIVATE_COMMAND");
  }
});


test("a one-launch Kimi TUI override ends at detach and failed launch cleanup (#316)", async () => {
  const hub = await rig("headless");
  const failed = await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } });
  expect(failed.admissionId).toBeString();
  const tools = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "kimi" }); cleanups.push(() => tools.close());
  expect((await tools.request({ t: "kimi_launch_end", admissionId: failed.admissionId })).ok).toBe(false);
  expect((await hub.console_.request({ t: "kimi_launch_end", admissionId: failed.admissionId })).ok).toBe(true);
  await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer: "kimi", channel: false })).rejects.toThrow();
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } })).ok).toBe(true);
  const peer = await hub.attach(); peer.close();
  await observed(() => hub.daemon.bus.peers.get("kimi")?.state === "offline");
  await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer: "kimi", channel: false })).rejects.toThrow();
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } })).ok).toBe(true);
  const second = await hub.attach(); expect((await second.request({ t: "inbox" })).ok).toBe(true);
});

test("a hub-opened Kimi command pins the selected mode despite a later configuration edit (#316)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-pin-"))); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let words: string[] = [];
  const daemon = await startDaemon({ cwd: root, stateDir: join(root, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } },
    terminal: () => ({ available: () => ({ ok: true, via: "template" }), open: async (_title, argv) => { words = [...argv]; return { ok: true, via: "template" }; } }) }); cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(join(root, "state"), { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "peer_start", peer: "kimi" })).ok).toBe(true);
  expect(words.slice(-3)).toEqual(["kimi", "--mode", "tui"]);
});

test("watch follows a running headless Kimi under the default TUI start mode (#382)", async () => {
  const hub = await rig();
  expect((await hub.console_.request({ t: "watch", peer: "kimi" })).ok).toBe(false);
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "headless" } })).ok).toBe(true);
  await observed(() => hub.daemon.bus.peers.get("kimi")?.state === "idle");
  expect((await hub.console_.request({ t: "watch", peer: "kimi" })).ok).toBe(true);
});

test("an older Kimi TUI socket closing keeps a newer launch's admission (#382)", async () => {
  const hub = await rig("headless");
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } })).ok).toBe(true);
  const first = await hub.attach();
  expect((await hub.console_.request({ t: "start", peer: "kimi", args: { mode: "tui" } })).ok).toBe(true);
  first.close();
  await observed(() => hub.daemon.bus.peers.get("kimi")?.state === "offline");
  const refusal = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "kimi", channel: false })
    .then(second => { cleanups.push(() => second.close()); return undefined; }, (error: Error) => error.message);
  expect(refusal).toBeUndefined();
  await observed(() => hub.daemon.bus.peers.get("kimi")?.state === "idle");
});
