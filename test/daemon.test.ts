import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const ROOT = join(import.meta.dir, "..");
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const until = async (cond: () => boolean, what = "condition") => {
  for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

async function hub(extra: { unattended?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-"));
  const daemon = await startDaemon({
    cwd: ROOT,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, kimi_cmd: ["bun", join(ROOT, "test/fakes/acp-server.ts")] },
    permissionTimeoutMs: 200,
    ...extra,
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  const events: any[] = [];
  const pushes: any[] = [];
  console_.onPush = (m) => (m.t === "event" ? events.push(m.e) : pushes.push(m));
  console_.send({ t: "tail" });
  return { stateDir, daemon, console_, events, pushes };
}

/** A fake Claude Code: an MCP client that spawns the channel server and records channel pushes. */
async function fakeClaude(stateDir: string) {
  const client = new Client({ name: "fake-claude", version: "0" }, { capabilities: {} });
  const channel: any[] = [];
  client.fallbackNotificationHandler = async (n) => void channel.push(n);
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(ROOT, "plugins/agent-hub/server.js")], // the shipped bundle, not the source
      env: { ...(process.env as Record<string, string>), AGENTHUB_STATE_DIR: stateDir },
      stderr: "ignore",
    }),
  );
  cleanup.push(() => client.close());
  return { client, channel };
}

test("control link: token file is 0600, wrong token and browser origins are refused", async () => {
  const { stateDir, daemon } = await hub();
  expect(statSync(join(stateDir, "control-token")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).controlPort).toBe(daemon.port);

  const res = await fetch(`http://127.0.0.1:${daemon.port}/`, { headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);

  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  const code = await new Promise<number>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "nope", role: "console" }));
    ws.onclose = (ev) => resolve(ev.code);
  });
  expect(code).toBe(4401);
});

test("claude channel: declares the capability, receives pushes with meta.source, hub_send replies keep the trace", async () => {
  const { stateDir, daemon, console_, events } = await hub();
  const { client, channel } = await fakeClaude(stateDir);
  expect(client.getServerCapabilities()?.experimental).toHaveProperty("claude/channel");
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["hub_send", "hub_inbox"]);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");

  const sent = await console_.request({ t: "send", body: "hello claude" });
  expect(sent.targets).toEqual(["claude"]);
  await until(() => channel.length === 1, "channel push");
  expect(channel[0].method).toBe("notifications/claude/channel");
  expect(channel[0].params.content).toBe("hello claude");
  expect(channel[0].params.meta.source).toBe("user");

  const res: any = await client.callTool({
    name: "hub_send",
    arguments: { text: "hello back", reply_to: channel[0].params.meta.message_id },
  });
  expect(res.content[0].text).toStartWith("sent to:");
  await until(() => events.some((e) => e.t === "envelope" && e.env.from === "claude"), "claude envelope");
  const reply = events.find((e) => e.t === "envelope" && e.env.from === "claude").env;
  expect(reply.hop).toBe(1);

  const bad: any = await client.callTool({ name: "hub_send", arguments: { text: "x", to: ["ghost"] } });
  expect(bad.content[0].text).toBe("not sent: unknown peer: ghost");
});

test("claude and an ACP peer talk through the daemon in both directions", async () => {
  const { stateDir, daemon, console_ } = await hub();
  const { client, channel } = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  expect((await console_.request({ t: "status" })).status.peers.kimi.state).toBe("idle");

  await client.callTool({ name: "hub_send", arguments: { text: "run the tests" } });
  await until(() => channel.length === 1, "kimi reply on the channel");
  expect(channel[0].params.meta.source).toBe("kimi");
  expect(channel[0].params.content).toBe("echo: run the tests");
});

test("ACP permission requests reach the console; permit answers, silence cancels, --unattended allows", async () => {
  const { console_, pushes, events } = await hub();
  await console_.request({ t: "start", peer: "kimi" });
  const replies = () => events.filter((e) => e.t === "envelope" && e.env.from === "kimi").map((e) => e.env.body);

  await console_.request({ t: "send", body: "PERMISSION", to: ["kimi"] });
  await until(() => pushes.some((p) => p.t === "permission"), "permission relay");
  const ask = pushes.find((p) => p.t === "permission");
  expect(ask.peer).toBe("kimi");
  console_.send({ t: "permit", id: ask.id, option: "yes" });
  await until(() => replies().length === 1, "permitted reply");
  expect(replies()[0]).toEndWith("permission=yes");

  await console_.request({ t: "send", body: "PERMISSION", to: ["kimi"] });
  await until(() => replies().length === 2, "timed out permission");
  expect(replies()[1]).toEndWith("permission=cancelled");

  const unattended = await hub({ unattended: true });
  await unattended.console_.request({ t: "start", peer: "kimi" });
  await unattended.console_.request({ t: "send", body: "PERMISSION", to: ["kimi"] });
  await until(() => unattended.events.some((e) => e.t === "envelope" && e.env.from === "kimi"), "unattended reply");
  expect(unattended.events.find((e) => e.t === "envelope" && e.env.from === "kimi").env.body).toEndWith("permission=yes");
});

test("a peer cannot claim the console user's id or a hub-managed adapter's id", async () => {
  const { stateDir } = await hub();
  for (const peer of ["user", "codex", "kimi", "Bad Id"]) {
    await expect(ControlClient.connect(stateDir, { role: "peer", peer })).rejects.toThrow();
  }
  (await ControlClient.connect(stateDir, { role: "peer", peer: "claude-2" })).close();
});

test("a tail opened after a permission request still sees it", async () => {
  const { stateDir, console_, events } = await hub();
  await console_.request({ t: "start", peer: "kimi" });
  await console_.request({ t: "send", body: "PERMISSION", to: ["kimi"] });
  await Bun.sleep(60);
  const late = await ControlClient.connect(stateDir, { role: "console" });
  const asks: any[] = [];
  late.onPush = (m) => m.t === "permission" && asks.push(m);
  late.send({ t: "tail" });
  await until(() => asks.length === 1, "replayed permission");
  late.send({ t: "permit", id: asks[0].id, option: "yes" });
  await until(() => events.some((e) => e.t === "envelope" && e.env.body.endsWith("permission=yes")), "permitted reply");
  late.close();
});

test("kill removes pid, status and token", async () => {
  const { stateDir, daemon, console_ } = await hub();
  console_.send({ t: "kill" });
  await daemon.stopped;
  expect(() => statSync(join(stateDir, "hub.pid"))).toThrow();
  expect(() => statSync(join(stateDir, "control-token"))).toThrow();
});
