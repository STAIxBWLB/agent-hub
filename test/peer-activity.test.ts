import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";
import { gitProject } from "./fakes/git-project.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { ACP_ACTIVITY, LOCAL_ACTIVITY, codexActivityServers, nativeActivity } from "../src/adapters/definitions/native-activity.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { PeerActivityTracker, type ActivityKind } from "../src/hub/peer-activity.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import { DOC_READ_SCHEMA, TOOL_SCHEMAS, WEB_FETCH_SCHEMA } from "../src/local/tools.ts";

const ACTIVITY_KINDS = ["files", "shell", "network", "hub", "memory", "agents", "model", "unknown"] as const;

class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() { this.setState("busy"); }
  idle() { this.setState("idle"); }
}

test("native Codex items use a closed kind and the configured MCP server, never tool arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-activity-config-"));
  try {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, "config.toml"), "[mcp_servers.agent-mem]\ncommand='fixture'\n[mcp_servers.claude-mem]\nenabled=false\n");
    const servers = codexActivityServers(root, root);
    const owner = new CodexPeer("codex", { cwd: root, appPort: 0, proxyPort: 0, activityServers: servers });
    const link = { modelStarts: new Map() }, frame = owner as unknown as { onNotification(link: object, method: string, params: object): void };
    Reflect.set(owner, "link", link);
    Reflect.set(owner, "threadId", "fixture-thread");
    const observed: (ActivityKind | undefined)[] = [];
    owner.onActivity = kind => observed.push(kind);
    frame.onNotification(link, "turn/started", { threadId: "fixture-thread", turn: { id: "turn" } });
    const start = (type: string, server?: string) => frame.onNotification(link, "item/started", {
      threadId: "fixture-thread", turnId: "turn", item: { type, server, command: "command-canary", path: "path-canary", arguments: { server: "agent-hub", url: "url-canary" } },
    });
    for (const name of ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
      "collabAgentToolCall", "webSearch", "imageView", "imageGeneration"]) start(name);
    expect(observed.slice(1)).toEqual(["shell", "files", "network", "unknown", "agents", "network", "files", "model"]);
    for (const server of ["agent-hub", "agent-mem", "claude-mem", "other"]) start("mcpToolCall", server);
    expect(observed.slice(-4)).toEqual(["hub", "memory", "network", "network"]);
    start("newNativeKind");
    start("agentMessage");
    expect(observed.at(-1)).toBe("unknown");
    expect(observed.every(kind => kind === undefined || ACTIVITY_KINDS.includes(kind))).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("canary");
    Reflect.set(owner, "link", undefined);
    Reflect.set(owner, "threadId", undefined);
    await owner.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP announcements classify kind without title, raw input or later mutable updates", async () => {
  class FixtureAcp extends AcpPeer { busy() { this.setState("busy"); } }
  const peer = new FixtureAcp("fixture-acp", { cwd: import.meta.dir, cmd: ["/usr/bin/false"], activityKinds: ACP_ACTIVITY });
  const onLine = (peer as unknown as { onLine(line: string): void }).onLine.bind(peer);
  Reflect.set(peer, "sessionId", "fixture");
  const observed: (ActivityKind | undefined)[] = [];
  peer.onActivity = kind => observed.push(kind);
  peer.busy();
  const feed = (kind: string, sessionUpdate = "tool_call") => onLine(JSON.stringify({ method: "session/update", params: {
    sessionId: "fixture", update: { sessionUpdate, kind, toolCallId: kind, title: "title-canary", rawInput: { command: "command-canary", path: "path-canary", url: "url-canary" } },
  } }));
  for (const kind of Object.keys(ACP_ACTIVITY)) feed(kind);
  expect(observed).toEqual(Object.values(ACP_ACTIVITY));
  feed("invented-kind");
  feed("execute", "tool_call_update");
  expect(observed).toEqual([...Object.values(ACP_ACTIVITY), "unknown"]);
  expect(JSON.stringify(observed)).not.toContain("canary");
  await peer.stop();
});

test("local definitions cover every native tool schema with a closed activity enum", () => {
  const tools = [...TOOL_SCHEMAS, DOC_READ_SCHEMA, WEB_FETCH_SCHEMA];
  for (const tool of tools) expect(nativeActivity(LOCAL_ACTIVITY, tool.function.name)).not.toBe("unknown");
  expect(Object.values(LOCAL_ACTIVITY).every(kind => ACTIVITY_KINDS.includes(kind))).toBe(true);
  expect(nativeActivity(LOCAL_ACTIVITY, "read:path-canary")).toBe("unknown");
});

test("local worker publishes a kind from tool names only on a scripted turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-activity-local-"));
  const previous = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "local-activity-fixture";
  const model = startFakeModelServer({ key: "local-activity-fixture", script: (_request, index) => index === 1
    ? { tool_calls: [toolCall("read", { path: "path-canary" }), toolCall("unknown-tool", { url: "url-canary" })] }
    : { content: "fixture answer" } });
  const peer = new LocalPeer("local", { cwd: root, omni: new OmniRoute({ urls: [model.url], access_hosts: [] }),
    fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => false } });
  const observed: (ActivityKind | undefined)[] = [];
  peer.onActivity = kind => observed.push(kind);
  try {
    await peer.start();
    await peer.deliver([newEnvelope(USER, "fixture request")]);
    for (const end = Date.now() + 2000; peer.state === "busy" && Date.now() < end;) await Bun.sleep(10);
    expect(observed).toEqual(["files", "unknown"]);
    expect(JSON.stringify(observed)).not.toContain("canary");
  } finally {
    await peer.stop(); model.stop();
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bus clears activity at idle, reset and replacement and ignores old-owner emissions", async () => {
  const tracker = new PeerActivityTracker(), bus = new Bus({ batchMs: 0, activity: (id, kind) => tracker.observe(id, kind, () => false, 42) });
  const peer = new FixturePeer("fixture");
  bus.add(peer); await peer.deliver();
  peer.onActivity?.("shell");
  expect(tracker.view(peer.id, () => false)).toEqual({ kind: "shell", since: 42 });
  peer.idle();
  expect(tracker.view(peer.id, () => false)).toBeUndefined();
  await peer.deliver(); peer.onActivity?.("files");
  peer.onDoing?.("reset");
  expect(tracker.view(peer.id, () => false)).toBeUndefined();
  peer.onActivity?.("model");
  bus.resetLastDelivery(peer.id);
  expect(tracker.view(peer.id, () => false)).toBeUndefined();
  peer.onActivity?.("memory");
  const replacement = new FixturePeer(peer.id);
  bus.add(replacement);
  peer.onActivity?.("network");
  expect(tracker.view(peer.id, () => false)).toBeUndefined();
  await peer.stop(); await replacement.stop(); bus.closeJournal();
});

test("activity privacy suppression is sticky until clear", () => {
  const tracker = new PeerActivityTracker();
  tracker.observe("peer", "files", () => false);
  expect(tracker.view("peer", () => true)).toBeUndefined();
  tracker.observe("peer", "shell", () => false);
  expect(tracker.view("peer", () => false)).toBeUndefined();
  tracker.observe("peer", undefined, () => false);
  tracker.observe("peer", "model", () => true);
  expect(tracker.view("peer", () => false)).toBeUndefined();
  tracker.observe("peer", undefined, () => false);
  tracker.observe("peer", "network", () => false);
  expect(tracker.view("peer", () => false)?.kind).toBe("network");
});

test("daemon exposes activity only on live console status and never records it in state", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-peer-activity-"))), stateDir = join(cwd, ".agenthub/state");
  gitProject(cwd);
  const home = join(cwd, "home"); mkdirSync(home);
  const cfg = DEFAULT_CONFIG;
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...cfg, memory: { ...cfg.memory, enabled: false, native: false }, snapshots: { ...cfg.snapshots, enabled: false },
      inference: { ...cfg.inference, enabled: false, triage: false }, pi: { ...cfg.pi, enabled: false, auto_start: false },
      mlx: { ...cfg.mlx, enabled: false } } });
  const board = new Board(join(stateDir, "hub.db"));
  const client = await ControlClient.connect(stateDir, { role: "console" });
  const peer = new FixturePeer("activity-fixture");
  try {
    daemon.bus.add(peer); await peer.deliver();
    peer.onActivity?.("agents");
    const live = await client.request({ t: "status" });
    expect(live.status.peers[peer.id]?.activity).toEqual({ kind: "agents", since: expect.any(Number) });
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "status", "--json"], {
      cwd, env: { HOME: home, AGENTHUB_HOME: join(home, "hub"), PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, json, error] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    expect(code, error).toBe(0);
    expect(JSON.parse(json).peers[peer.id]?.activity).toEqual(live.status.peers[peer.id]?.activity);
    expect(json).not.toMatch(/(?:command|path|url)-canary/);
    const hidden = board.propose("user", { title: "fixture", class: "implement", signals: ["pii"] });
    board.update(hidden.id, "user", "assigned", { owner: peer.id });
    expect((await client.request({ t: "status" })).status.peers[peer.id]?.activity).toBeUndefined();
    peer.onActivity?.("network");
    expect((await client.request({ t: "status" })).status.peers[peer.id]?.activity).toBeUndefined();
    peer.idle();
    const allFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? allFiles(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
    for (const file of allFiles(stateDir)) {
      const body = readFileSync(file);
      expect(body.includes('"activity":{"kind"'), file).toBe(false);
      expect(body.includes('"kind":"agents","since"'), file).toBe(false);
    }
  } finally { client.close(); board.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); }
});
