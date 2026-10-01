import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Turns } from "../src/hub/snapshots.ts";
import { readEvents } from "../src/hub/events.ts";
import { summarize } from "../src/hub/report.ts";
import { parse as parseOverlaps } from "../scripts/overlaps.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const ROOT = join(import.meta.dir, "..");
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const until = async (cond: () => boolean, what = "condition") => {
  for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

async function hub(extra: { unattended?: boolean; memoryUrl?: string; modelUrl?: string; notifier?: (title: string, body: string) => void; approvals?: { timeout_s: number; notify: boolean }; permissionTimeoutMs?: number; cwd?: string; checks?: typeof DEFAULT_CONFIG.checks; ignored?: string[]; snapshots?: typeof DEFAULT_CONFIG.snapshots; codex_bin?: string; codexAppPort?: number; codexProxyPort?: number } = {}) {
  const { memoryUrl, modelUrl, approvals, checks, ignored, snapshots, codex_bin, ...rest } = extra;
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-"));
  const daemon = await startDaemon({
    cwd: ROOT,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: {
      ...DEFAULT_CONFIG,
      kimi_cmd: ["bun", join(ROOT, "test/fakes/acp-server.ts")],
      batch_ms: 30,
      ...(modelUrl ? { omniroute: { urls: [modelUrl], access_hosts: [] } } : {}),
      memory: memoryUrl ? { enabled: true, worker_url: memoryUrl, inject_tokens: 40, brief_items: 8 } : { ...DEFAULT_CONFIG.memory, enabled: false },
      ...(approvals ? { approvals } : {}),
      ...(checks ? { checks } : {}),
      ...(ignored ? { ignored } : {}),
      ...(snapshots ? { snapshots } : {}),
      ...(codex_bin ? { codex_bin } : {}),
    },
    permissionTimeoutMs: 200,
    ...rest,
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  const events: any[] = [];
  const pushes: any[] = [];
  console_.onPush = (m) => (m.t === "event" ? events.push(m.e) : pushes.push(m));
  console_.send({ t: "tail" });
  return { stateDir, daemon, console_, events, pushes };
}

async function dashboardClient(console_: ControlClient) {
  const opened = await console_.request({ t: "ui" });
  expect(opened.ok).toBe(true);
  const url = new URL(opened.url);
  const origin = url.origin;
  const headers: Record<string, string> = { origin, "content-type": "application/json" };
  const session = await fetch(`${origin}/session`, { method: "POST", headers, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  expect(session.status).toBe(200);
  headers.cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const post = async (path: string, body: unknown = {}) => (await fetch(`${origin}/${path}`, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<any>;
  return { origin, post };
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
  expect((await client.listTools()).tools.map((t) => t.name).slice(0, 2)).toEqual(["hub_send", "hub_inbox"]); // the task tools follow (M4)
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

// issue #72: Kimi's requests for the hub's own tools no longer wait on the console; anything else still does.
test("Kimi's requests for the hub's own tools are approved without a console prompt, and logged by name", async () => {
  const { console_, pushes, events, stateDir } = await hub();
  await console_.request({ t: "start", peer: "kimi" });
  const replies = () => events.filter((e) => e.t === "envelope" && e.env.from === "kimi").map((e) => e.env.body);
  await console_.request({ t: "send", body: "PERMISSION HUBTOOL", to: ["kimi"] });
  await until(() => replies().length === 1, "hub tool reply");
  expect(replies()[0]).toEndWith("permission=yes");
  expect(pushes.some((p) => p.t === "permission")).toBe(false);
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("permission auto-approved for kimi: mcp__agent-hub__hub_task_list");

  await console_.request({ t: "send", body: "PERMISSION STREAMED", to: ["kimi"] });
  await until(() => pushes.some((p) => p.t === "permission"), "console prompt for Bash");
  const ask = pushes.find((p) => p.t === "permission");
  expect(ask.title).toBe('Bash: {"command":"make test"}');
  console_.send({ t: "permit", id: ask.id, option: "no" });
  await until(() => replies().length === 2, "bash reply");

  // the daemon's own predicate: an exact name only, and only when allow_once is on offer
  for (const [n, body] of [[3, "PERMISSION SPOOF"], [4, "PERMISSION NOONCE"]] as const) {
    await console_.request({ t: "send", body, to: ["kimi"] });
    await until(() => pushes.filter((p) => p.t === "permission").length === n - 1, `console prompt for ${body}`);
    const next = pushes.filter((p) => p.t === "permission").at(-1);
    expect(next.title).toStartWith(body.endsWith("SPOOF") ? "mcp__agent-hub__rm_rf" : "mcp__agent-hub__hub_task_list");
    console_.send({ t: "permit", id: next.id, option: "no" });
    await until(() => replies().length === n, `${body} reply`);
  }
});

// issue #5: a waiting approval reaches the desktop with the peer and the tool only; an unanswered one says so.
test("a pending approval notifies once with peer and tool, never the payload; a timeout leaves a line", async () => {
  const shown: string[] = [];
  const { console_, events, stateDir } = await hub({ notifier: (_t, body) => shown.push(body), approvals: { timeout_s: 120, notify: true } });
  await console_.request({ t: "start", peer: "kimi" });
  const replies = () => events.filter((e) => e.t === "envelope" && e.env.from === "kimi");
  await console_.request({ t: "send", body: "PERMISSION ANNOUNCED", to: ["kimi"] }); // title carries "rm -rf build && make"
  await until(() => replies().length === 1, "cancelled reply");
  expect(shown).toEqual(["kimi asks for approval: Bash (ahub tail)"]);
  expect(readFileSync(join(stateDir, "hub.log"), "utf8").match(/permission \w+ from kimi was not answered within 0s and was cancelled/g)).toHaveLength(1);
});

test("approvals.timeout_s is what cancels a request; outside 30-3600 it falls back to 120; notify off sends nothing", async () => {
  const shown: string[] = [];
  const set = await hub({ notifier: (_t, body) => shown.push(body), approvals: { timeout_s: 45, notify: false }, permissionTimeoutMs: undefined });
  await set.console_.request({ t: "start", peer: "kimi" });
  await set.console_.request({ t: "send", body: "PERMISSION ANNOUNCED", to: ["kimi"] }); // title "Bash": a bare tool name
  await until(() => set.pushes.some((p) => p.t === "permission"), "request shown");
  expect(readFileSync(join(set.stateDir, "hub.log"), "utf8")).toMatch(/permission \w+ requested by kimi .*cancelled after 45s\)/);
  expect(set.pushes.find((p) => p.t === "permission").tool).toBeUndefined(); // the console push keeps its shape
  expect(shown).toEqual([]); // notify off: a real request raised nothing
  set.console_.send({ t: "permit", id: set.pushes.find((p) => p.t === "permission").id, option: "yes" });

  const off = await hub({ approvals: { timeout_s: 5, notify: false } });
  expect(readFileSync(join(off.stateDir, "hub.log"), "utf8")).toContain("approvals.timeout_s 5 is outside 30-3600 seconds; using 120");
});

test("a project config turns approval notifications on for macOS unless it says otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-approvals-"));
  expect(DEFAULT_CONFIG.approvals.notify).toBe(false);
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), "{}");
  expect(loadConfig(dir).approvals).toEqual({ timeout_s: 120, notify: process.platform === "darwin" });
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ approvals: { notify: false, timeout_s: 600 } }));
  expect(loadConfig(dir).approvals).toEqual({ timeout_s: 600, notify: false });
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ approvals: { notify: "false" } }));
  expect(loadConfig(dir).approvals.notify).toBe(process.platform === "darwin"); // a string is not a boolean
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

test("console messages go out at once, agent status is batched into one digest notification, fyi reaches nobody", async () => {
  const { stateDir, daemon, console_, events } = await hub();
  const ui = await dashboardClient(console_);
  const { channel } = await fakeClaude(stateDir);
  const other = await ControlClient.connect(stateDir, { role: "peer", peer: "claude-2" });
  await until(() => daemon.bus.peers.get("claude")?.state === "idle" && daemon.bus.peers.get("claude-2")?.state === "idle", "attach");

  await console_.request({ t: "send", body: "now", to: ["claude"] });
  await until(() => channel.length === 1, "immediate console message");
  expect(channel[0].params.meta.priority).toBe("important");

  // Hold the recipient while the two status requests are accepted so the test does not
  // depend on both WebSocket round trips completing inside the 30 ms batch window.
  daemon.bus.pause("claude");
  await other.request({ t: "send", body: "[FYI] for the record" });
  await other.request({ t: "send", body: "one" });
  await other.request({ t: "send", body: "[STATUS] two" });
  daemon.bus.resume("claude");
  await until(() => channel.length === 2, "digest");
  await Bun.sleep(60);
  expect(channel).toHaveLength(2); // one notification for both, none for the fyi
  expect(channel[1].params.meta.source).toBe("hub-digest");
  expect(channel[1].params.meta.sources).toBe("claude-2");
  expect(channel[1].params.content).toContain("--- from claude-2");
  expect(channel[1].params.content).toContain("one");
  expect(channel[1].params.content).toContain("two");
  expect(events.some((e) => e.t === "envelope" && e.dropped === "fyi")).toBe(true);
  other.close();
});

test("Claude channel preserves a single workflow kind and distinguishes recall from workflow items in a digest", async () => {
  const { stateDir, daemon } = await hub();
  const { channel } = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");

  const single = newEnvelope(HUB, "Review task #7", { to: ["claude"], kind: "review", priority: "important" });
  daemon.bus.publish(single);
  await until(() => channel.length === 1, "single review notification");
  expect(channel[0].params.content).toBe(single.body);
  expect(channel[0].params.meta.source).toBe(HUB);
  expect(channel[0].params.meta.kind).toBe("review");

  daemon.bus.pause("claude");
  const recall = newEnvelope(HUB, "Earlier decisions", { to: ["claude"], kind: "presence", priority: "important" });
  const task = newEnvelope(HUB, "Accept task #8", { to: ["claude"], kind: "task", priority: "important" });
  const chat = newEnvelope("codex", "Ordinary update", { to: ["claude"], priority: "important" });
  for (const env of [recall, task, chat]) daemon.bus.publish(env);
  daemon.bus.resume("claude");
  await until(() => channel.length === 2, "mixed digest notification");
  expect(channel[1].params.meta.source).toBe("hub-digest");
  for (const env of [recall, task, chat]) {
    expect(channel[1].params.content).toContain(`--- from ${env.from} (id ${env.id}, kind ${env.kind}) ---\n${env.body}`);
  }
  await Bun.sleep(60);
  expect(channel).toHaveLength(2);
});

test("an outdated plugin is refused loudly instead of silently dropping digests; fyi sends say so", async () => {
  const { stateDir, daemon, console_ } = await hub();
  const token = readFileSync(join(stateDir, "control-token"), "utf8");
  const old = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  const code = await new Promise<number>((resolve) => {
    old.onopen = () => old.send(JSON.stringify({ t: "hello", token, role: "peer", peer: "claude" })); // no `v`
    old.onclose = (ev) => resolve(ev.code);
  });
  expect(code).toBe(4426);
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("wire version 1");

  const res = await console_.request({ t: "send", body: "[FYI] note" });
  expect(res).toMatchObject({ ok: true, recorded: true, targets: [] });
});

// issue #30: the replaced session used to stay detached for good, even after the taker left.
test("a second session attached as the same peer wins, and the replaced one stands by and takes it back", async () => {
  const { stateDir, daemon, events } = await hub();
  const first = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "first attach");
  const second = await fakeClaude(stateDir);
  await until(() => events.filter((e) => e.t === "state" && e.peer === "claude" && e.state === "offline").length === 1, "replacement");
  await Bun.sleep(2500); // past the replaced side's first retries: it must not fight for a peer someone holds
  expect(events.filter((e) => e.t === "state" && e.peer === "claude" && e.state === "offline")).toHaveLength(1);
  expect(daemon.bus.peers.get("claude")?.state).toBe("idle");
  const held: any = await first.client.callTool({ name: "hub_send", arguments: { text: "x" } });
  expect(held.content[0].text).toStartWith('another session is attached to the hub as "claude"');

  await second.client.close(); // the taking session leaves: the slot is free again
  await until(() => events.filter((e) => e.t === "state" && e.peer === "claude" && e.state === "offline").length === 2, "taker left");
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "reclaimed without a restart");
  const back: any = await first.client.callTool({ name: "hub_send", arguments: { text: "back" } });
  expect(back.content[0].text).not.toContain("standing by");
}, 30_000);

// Codex review of #34: the standing-by gate reads status.json, so a hello that is still arriving must show there.
test("a hello that has not finished its preface is reported as claiming, not as an offline peer", async () => {
  let injects = 0;
  let slow = true;
  const slowMem = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
      if (path === "/api/context/inject" && (injects++, slow)) await Bun.sleep(600);
      return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
    },
  });
  cleanup.push(() => void slowMem.stop(true));
  const { stateDir, daemon } = await hub({ memoryUrl: `http://127.0.0.1:${slowMem.port}` });
  const token = readFileSync(join(stateDir, "control-token"), "utf8");
  const peerOf = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).peers?.claude;

  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  await new Promise<void>((r) => (ws.onopen = () => (ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, token, role: "peer", peer: "claude", rid: 1 })), r())));
  await until(() => injects > 0, "recall started");
  expect(peerOf()).toMatchObject({ state: "offline", claiming: true }); // arriving: a standing-by session must wait
  slow = false;
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "attached");
  expect(peerOf().claiming).toBeUndefined();
  ws.close();
}, 15_000);

test("the newest hello wins even when an older session's recall finishes last", async () => {
  let injects = 0;
  let slow = true; // only the older session's recall is slow
  const slowMem = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
      if (path === "/api/context/inject" && (injects++, slow)) await Bun.sleep(600);
      return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
    },
  });
  cleanup.push(() => void slowMem.stop(true));
  const { stateDir, daemon } = await hub({ memoryUrl: `http://127.0.0.1:${slowMem.port}` });
  const token = readFileSync(join(stateDir, "control-token"), "utf8");
  const open = (): Promise<{ ws: WebSocket; closed: Promise<number> }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
      const closed = new Promise<number>((r) => (ws.onclose = (ev) => r(ev.code)));
      ws.onopen = () => (ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, token, role: "peer", peer: "claude", rid: 1 })), resolve({ ws, closed }));
    });
  const older = await open();
  await until(() => injects > 0, "older recall started");
  slow = false;
  const newer = await open();
  expect(await older.closed).toBe(4000);
  await Bun.sleep(100);
  expect(newer.ws.readyState).toBe(WebSocket.OPEN);
  expect(daemon.bus.peers.get("claude")?.state).toBe("idle");
  newer.ws.close();
});

test("the channel server exits when its host goes away and does not retry a hub that refused its wire version", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-"));
  let hellos = 0;
  const fake = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: { message: (ws) => (hellos++, ws.close(4426, "wire version mismatch")) },
  });
  cleanup.push(() => void fake.stop(true)); // awaiting it hangs while a closed upgrade is pending
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: fake.port, protocol: PROTOCOL, cwd: ROOT }));
  writeFileSync(join(stateDir, "control-token"), "t");

  const { client } = await fakeClaude(stateDir);
  await until(() => hellos === 1, "first hello");
  await Bun.sleep(2500);
  expect(hellos).toBe(1);
  const res: any = await client.callTool({ name: "hub_send", arguments: { text: "x" } });
  expect(res.content[0].text).toContain("wire version mismatch");

  const proc = Bun.spawn(["bun", join(ROOT, "plugins/agent-hub/server.js")], { env: { ...process.env, AGENTHUB_STATE_DIR: stateDir }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => proc.kill());
  await Bun.sleep(300);
  proc.stdin.end();
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "still running")]);
  expect(exited).toBe(0);
}, 15_000);

test("two starts of the same peer at once share one adapter", async () => {
  const mem = startFakeMemWorker({ claude: ["1 line"] });
  cleanup.push(mem.stop);
  const { console_ } = await hub({ memoryUrl: mem.url });
  const [a, b] = await Promise.all([console_.request({ t: "start", peer: "kimi" }), console_.request({ t: "start", peer: "kimi" })]);
  expect([a.ok, b.ok]).toEqual([true, true]);
  expect(mem.calls.filter((c) => c.path === "/api/context/inject")).toHaveLength(1);
  expect((await console_.request({ t: "status" })).status.peers.kimi.state).toBe("idle");
});

test("queue diagnostics are console-only and private delivery bodies stay redacted", async () => {
  const { stateDir, daemon, console_ } = await hub();
  const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
  cleanup.push(() => peer.close());
  await console_.request({ t: "pause", peer: "claude" });
  daemon.bus.publish(newEnvelope(HUB, "private fixture must not leak", { to: ["claude"], private: true, priority: "important" }));
  const list = await console_.request({ t: "queue", op: "list" });
  expect(list.ok).toBe(true);
  expect(list.deliveries.length).toBeGreaterThan(0);
  expect(JSON.stringify(list)).not.toContain("private fixture");
  const item = list.deliveries.find((row: any) => row.peer === "claude" && row.state === "queued");
  expect(item).toBeDefined();
  const shown = await console_.request({ t: "queue", op: "show", id: item.id });
  expect(JSON.stringify(shown)).not.toContain("private fixture");
  expect(JSON.stringify(shown)).toContain("[private:");
  expect((await peer.request({ t: "queue", op: "list" })).ok).toBe(false);
  expect((await peer.request({ t: "queue", op: "resolve", id: item.id, revision: item.revision, action: "discard", reason: "not authorized" })).ok).toBe(false);
});

test("withdrawing an expired queued request updates status.json immediately", async () => {
  const { stateDir, daemon, console_ } = await hub();
  await console_.request({ t: "start", peer: "kimi" });
  await console_.request({ t: "pause", peer: "kimi" });
  const ask = newEnvelope(HUB, "checkpoint?", { to: ["kimi"], kind: "budget", priority: "important" });
  daemon.bus.publish(ask);
  const peer = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).peers.kimi;
  expect(peer()).toEqual({ state: "paused", queued: 1, queuedImportant: 1, oldestQueuedAt: expect.any(Number) });
  expect(daemon.bus.withdraw(ask.id)).toBe(true);
  expect(peer()).toEqual({ state: "paused", queued: 0 });
});

test("pause and resume from the console", async () => {
  const { stateDir, console_, events } = await hub();
  await console_.request({ t: "start", peer: "kimi" });
  expect((await console_.request({ t: "pause", peer: "kimi" })).state).toBe("paused");
  expect((await console_.request({ t: "pause", peer: "ghost" })).ok).toBe(false);
  await console_.request({ t: "send", body: "held one", to: ["kimi"] });
  await console_.request({ t: "send", body: "held two", to: ["kimi"] });
  await Bun.sleep(80);
  const status = (await console_.request({ t: "status" })).status.peers.kimi;
  expect(status).toEqual({ state: "paused", queued: 2, queuedImportant: 2, oldestQueuedAt: expect.any(Number) });
  // status.json is what a client parses on connect, and a queue change is not a bus event: `publish` emits its
  // envelope event before it enqueues, so the file used to report the queue as it was one message ago.
  const peers = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).peers.kimi;
  expect(peers()).toEqual({ state: "paused", queued: 2, queuedImportant: 2, oldestQueuedAt: expect.any(Number) });
  await console_.request({ t: "resume", peer: "kimi" });
  await until(() => events.some((e) => e.t === "envelope" && e.env.from === "kimi"), "digest reply");
  expect(events.find((e) => e.t === "envelope" && e.env.from === "kimi").env.body).toBe("echo: held two (2 items)");
  await until(() => peers().queued === 0, "status.json follows the drained queue");
  expect(peers().queuedImportant).toBeUndefined();
});

test("session-start recall rides on the first delivery, is capped, and is not repeated when the peer restarts", async () => {
  const mem = startFakeMemWorker({
    claude: ["65001 10:00a decision Claude chose the proxy design"],
    kimi: Array.from({ length: 30 }, (_, i) => `6600${i} 10:0${i % 10}a change kimi filler line number ${i}`),
  });
  cleanup.push(mem.stop);
  const { daemon, console_, events } = await hub({ memoryUrl: mem.url });
  const replies = () => events.filter((e) => e.t === "envelope" && e.env.from === "kimi").map((e) => e.env.body);

  await console_.request({ t: "start", peer: "kimi" });
  const inject = mem.calls.filter((c) => c.path === "/api/context/inject");
  expect(inject).toHaveLength(1);
  expect(inject[0]!.query).not.toContain("platformSource"); // kimi gets every platform

  let delivered = "";
  const kimi = daemon.bus.peers.get("kimi")!;
  const deliver = kimi.deliver.bind(kimi);
  kimi.deliver = (envs, deliveryId) => ((delivered = envs.map((e) => `${e.from}:${e.body}`).join("\n")), deliver(envs, deliveryId));
  await console_.request({ t: "send", body: "hello", to: ["kimi"] });
  await until(() => replies().length === 1, "first reply");
  expect(replies()[0]).toBe("echo: hello (2 items) +memory");
  expect(delivered).toContain("Claude chose the proxy design");
  expect(delivered).toContain("(trimmed)");
  expect(delivered.length).toBeLessThan(600); // 40 tokens * 3 chars + header + the message

  await kimi.stop();
  await until(() => daemon.bus.stateOf("kimi") === "offline", "kimi down");
  await console_.request({ t: "start", peer: "kimi" });
  await console_.request({ t: "send", body: "again", to: ["kimi"] });
  await until(() => replies().length === 2, "second session reply");
  expect(replies()[1]).toBe("echo: again");
  expect(mem.calls.filter((c) => c.path === "/api/context/inject")).toHaveLength(1);
});

test("ahub local: a fourth peer on the hub-owned model path; writes wait for ahub permit; status names what served the call", async () => {
  const model = startFakeModelServer({
    key: "sk-daemon-test",
    script: (body) =>
      body.messages.some((m) => m.role === "tool")
        ? { content: `result: ${body.messages.at(-1)?.content}` }
        : { tool_calls: [toolCall("write", { path: ".agenthub/state/scratch-from-test.txt", content: "x" })] },
  });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "sk-daemon-test";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { console_, events, pushes } = await hub({ modelUrl: model.url });

  const started = await console_.request({ t: "start", peer: "local", args: { model: "vllm/pinned" } });
  expect(started).toMatchObject({ ok: true, model: "vllm/pinned" });
  expect((await console_.request({ t: "start", peer: "local", args: { route: "sy/nope" } })).already).toBe(true);

  await console_.request({ t: "send", body: "write the file", to: ["local"] });
  await until(() => events.some((e) => e.t === "envelope" && e.env.from === "local"), "local answer");
  // the write targeted the hub's own state dir: refused by the path guard before any permission was asked
  expect(events.find((e) => e.t === "envelope" && e.env.from === "local").env.body).toMatch(/result: error: .*denylist/);
  expect(pushes.filter((p) => p.t === "permission")).toHaveLength(0);
  const status = (await console_.request({ t: "status" })).status;
  expect(status.peers.local).toMatchObject({ state: "idle", servedBy: "omniroute vllm/pinned (provider vllm)" });
  expect(model.requests[0]!.body.model).toBe("vllm/pinned");
});

test("task tools from every surface: Claude plugin, a tools-role client acting for kimi, the console; roles reach the instructions; the board survives a restart", async () => {
  const record = join(mkdtempSync(join(tmpdir(), "agenthub-rec-")), "session-new.json");
  process.env.FAKE_ACP_RECORD = record;
  cleanup.push(() => delete process.env.FAKE_ACP_RECORD);
  const first = await hub();
  const { client } = await fakeClaude(first.stateDir);
  await until(() => first.daemon.bus.peers.get("claude")?.state === "idle", "claude attach");
  await first.console_.request({ t: "start", peer: "kimi" });

  // Kimi is handed the hub's MCP server in tools mode through ACP session/new
  const sessionNew = JSON.parse(readFileSync(record, "utf8"));
  expect(sessionNew.mcpServers[0]).toMatchObject({ name: "agent-hub", command: "bun" });
  expect(sessionNew.mcpServers[0].env).toContainEqual({ name: "AGENTHUB_MODE", value: "tools" });
  expect(sessionNew.mcpServers[0].env).toContainEqual({ name: "AGENTHUB_PEER_ID", value: "kimi" });

  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["hub_send", "hub_inbox", "hub_task_propose", "hub_task_done", "hub_review", "hub_remember"]));
  expect(client.getInstructions()).toContain("planner: break work into tasks");

  const proposed: any = await client.callTool({ name: "hub_task_propose", arguments: { title: "write the smoke doc", class: "test" } });
  expect(proposed.content[0].text).toBe("task #1: proposed, owner kimi, reviewer claude");

  // the same bundle in tools mode, as Kimi or Codex would run it
  const kimiTools = new Client({ name: "fake-kimi-mcp", version: "0" }, { capabilities: {} });
  await kimiTools.connect(new StdioClientTransport({ command: "bun", args: [join(ROOT, "plugins/agent-hub/server.js")], env: { ...(process.env as Record<string, string>), AGENTHUB_STATE_DIR: first.stateDir, AGENTHUB_MODE: "tools", AGENTHUB_PEER_ID: "kimi" }, stderr: "ignore" }));
  cleanup.push(() => kimiTools.close());
  expect(kimiTools.getServerCapabilities()?.experimental).toBeUndefined(); // no channel in tools mode
  expect((await kimiTools.listTools()).tools.map((t) => t.name)).not.toContain("hub_inbox");
  expect(kimiTools.getInstructions()).toContain("verifier: run the checks");
  const call = async (name: string, args: unknown) => ((await kimiTools.callTool({ name, arguments: args as any })) as any).content[0].text as string;
  for (let i = 0; i < 50 && (await call("hub_task_list", {})).startsWith("hub is not running"); i++) await Bun.sleep(50);
  expect(await call("hub_task_accept", { id: 1 })).toBe("task #1: in_progress, owner kimi, reviewer claude"); // attributed to kimi
  expect(await call("hub_review", { id: 1, verdict: "approved" })).toMatch(/^error: .*only its reviewer \(claude\)/);
  expect(await call("hub_task_done", { id: 1, summary: "doc written" })).toContain("in_review");
  expect(first.daemon.bus.peers.has("kimi")).toBe(true);
  expect([...first.daemon.bus.peers.keys()].sort()).toEqual(["claude", "kimi"]); // the tools client is not a delivery target

  const verdict: any = await client.callTool({ name: "hub_review", arguments: { id: 1, verdict: "approved", note: "fine" } });
  expect(verdict.content[0].text).toContain("approved");
  expect((await first.console_.request({ t: "task", op: "task_show", args: { id: 1 } })).text).toContain('"event": "approved"');
  expect((await first.console_.request({ t: "status" })).status.tasks).toEqual({ approved: 1 });
  const peerOnly: any = await client.callTool({ name: "hub_task_list", arguments: {} });
  expect(JSON.parse(peerOnly.content[0].text)).toHaveLength(1);
  const denied = await ControlClient.connect(first.stateDir, { role: "tools", peer: "kimi" });
  expect(await denied.request({ t: "task", op: "task_assign", args: { id: 1, peer: "kimi" } })).toMatchObject({ ok: false, error: "task_assign is a console command" });
  denied.close();

  // a second hub on the same state dir sees the board
  const stateDir = first.stateDir;
  await first.daemon.stop();
  const again = await startDaemon({ cwd: ROOT, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => again.stop());
  const c2 = await ControlClient.connect(stateDir, { role: "console" });
  expect(JSON.parse((await c2.request({ t: "task", op: "hub_task_list", args: {} })).text)[0]).toMatchObject({ id: 1, state: "approved" });
  c2.close();
});

test("a note from one peer rides on the others' next delivery, never its own; a claim's result names the open task it overlaps", async () => {
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const { stateDir, daemon, console_ } = await hub({ memoryUrl: mem.url });
  const { client, channel } = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");
  await console_.request({ t: "start", peer: "kimi" });
  let toKimi = "";
  const kimi = daemon.bus.peers.get("kimi")!;
  const deliver = kimi.deliver.bind(kimi);
  kimi.deliver = (envs, deliveryId) => ((toKimi += envs.map((e) => e.body).join("\n")), deliver(envs, deliveryId));

  const kimiTools = new Client({ name: "fake-kimi-mcp", version: "0" }, { capabilities: {} });
  await kimiTools.connect(new StdioClientTransport({ command: "bun", args: [join(ROOT, "plugins/agent-hub/server.js")], env: { ...(process.env as Record<string, string>), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_MODE: "tools", AGENTHUB_PEER_ID: "kimi" }, stderr: "ignore" }));
  cleanup.push(() => kimiTools.close());
  const call = async (name: string, args: unknown) => ((await kimiTools.callTool({ name, arguments: args as any })) as any).content[0].text as string;
  for (let i = 0; i < 50 && (await call("hub_task_list", {})).startsWith("hub is not running"); i++) await Bun.sleep(50);

  expect(await call("hub_remember", { title: "WAL mode", text: "locks the test db", kind: "fail" })).toBe("saved to shared memory; the other agents get it with their next message");
  await Bun.sleep(60);
  expect(channel).toHaveLength(0); // no delivery of its own
  await console_.request({ t: "send", body: "hello", to: ["claude"] });
  await until(() => channel.length === 1, "delivery to claude");
  expect(channel[0].params.content).toContain("note from kimi [fail]: WAL mode: locks the test db");
  await console_.request({ t: "send", body: "hello", to: ["kimi"] });
  await until(() => toKimi.includes("hello"), "delivery to kimi");
  expect(toKimi).not.toContain("note from kimi"); // never back to its author

  expect(await call("hub_task_propose", { title: "hub refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub"] } })).toBe("task #1: in_progress, owner kimi, reviewer claude");
  const claimed: any = await client.callTool({ name: "hub_task_propose", arguments: { title: "bus docs", class: "plan", owner: "claude", refs: { paths: ["src/hub/bus.ts"] } } });
  expect(claimed.content[0].text).toContain("task #2: in_progress, owner claude");
  expect(claimed.content[0].text).toContain("Overlaps #1 (owner kimi) on src/hub/bus.ts. Settle it with that owner");
  // proposed for someone else: the caller hears that the new owner was told, not to settle it itself
  expect(await call("hub_task_propose", { title: "channel docs", class: "plan", owner: "claude", refs: { paths: ["src/hub/envelope.ts"] } })).toBe("task #3: proposed, owner claude, reviewer none\nOverlaps #1 (owner kimi) on src/hub/envelope.ts. claude is told to settle it.");
});

test("a PII task shows nowhere but the local console's task view: not on ahub tail, not in hub.log, not to cloud peers", async () => {
  // the worker tries to save a note and to spin off a task mid-turn: both would carry the PII out
  const model = startFakeModelServer({
    key: "k",
    script: (body) => {
      const tools = body.messages.filter((m) => m.role === "tool");
      if (tools.length === 0) return { tool_calls: [toolCall("hub_remember", { text: "follow-up for 900101-1234567 decided" }), toolCall("hub_task_propose", { title: "call the patient back", class: "implement" })] };
      return { content: `updated the record of 900101-1234567; tools said: ${tools.map((t) => t.content).join(" | ")}` };
    },
  });
  const mem = startFakeMemWorker();
  cleanup.push(model.stop, mem.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { stateDir, daemon, console_, events, pushes } = await hub({ modelUrl: model.url, memoryUrl: mem.url });
  const ui = await dashboardClient(console_);
  const { channel } = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");
  await console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } });

  const res = await console_.request({ t: "task", op: "hub_task_propose", args: { title: "fix the entry for 900101-1234567", class: "implement", refs: { paths: ["900101-private.txt"], branch: "900101-private" } } });
  expect(res.text).toBe("task #1: proposed, owner local, reviewer user");
  await until(() => events.some((e) => e.t === "envelope" && e.env.from === "local"), "local answer");
  await Bun.sleep(80);

  const uiOutput = JSON.stringify(await ui.post("snapshot"));
  expect(uiOutput).toContain("[pii]");
  const everything = uiOutput + JSON.stringify(events) + JSON.stringify(pushes) + JSON.stringify(channel) + readFileSync(join(stateDir, "hub.log"), "utf8");
  expect(everything).not.toContain("900101");
  expect(everything).toContain("[private: task #1, see ahub task show 1]");
  expect(events.filter((e) => e.t === "envelope" && e.env.from === "local").every((e) => e.env.body.includes("task #1"))).toBe(true); // the answer's stub names the task
  expect((await console_.request({ t: "task", op: "task_show", args: { id: 1 } })).text).toContain('"event": "answer"'); // and the board kept its text
  expect(channel).toHaveLength(0); // claude heard nothing about it
  const shown = (await console_.request({ t: "task", op: "task_show", args: { id: 1 } })).text;
  expect(shown).toContain("hub_remember is not available while working on a PII task");
  expect(shown).toContain("hub_task_propose is not available while working on a PII task");
  expect(JSON.stringify(mem.calls.map((c) => c.body ?? c.query))).not.toContain("900101"); // nothing of it reached claude-mem
  expect((await console_.request({ t: "status" })).status.tasks).toEqual({ proposed: 1 }); // and no second task was created
  expect(JSON.stringify(model.requests[0]!.body)).toContain("900101-1234567"); // the on-prem model got the real text
  expect((await console_.request({ t: "task", op: "task_show", args: { id: 1 } })).text).toContain("900101-1234567");
  expect((await console_.request({ t: "task", op: "hub_task_list", args: {} })).text).not.toContain("900101"); // the board itself stays redacted

  const asClaude = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" });
  expect((await asClaude.request({ t: "task", op: "hub_task_list", args: {} })).text).not.toContain("900101");
  asClaude.close();
});

test("budget relay end to end: checkpoint, pause, task to local with the summary, idempotent, resume with the list of moves; a manual pause is not lifted", async () => {
  const model = startFakeModelServer({ key: "k", script: (b) => ({ content: `local got: ${String(b.messages.at(-1)?.content).includes("Handoff from the previous owner") ? "handoff" : "no handoff"}` }) });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { stateDir, daemon, console_, events, pushes } = await hub({ modelUrl: model.url });
  await console_.request({ t: "start", peer: "kimi" });
  await console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } });
  expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: "port the parser", class: "implement", owner: "kimi" } })).text).toContain("owner kimi");
  const kimiTools = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi" });
  await kimiTools.request({ t: "task", op: "hub_task_accept", args: { id: 1 } });

  const before = events.length;
  expect((await console_.request({ t: "budget", set: { peer: "ghost", used: 0.5 } })).ok).toBe(false);
  await console_.request({ t: "budget", set: { peer: "kimi", used: 0.95, resetsInMs: 3_600_000 } });
  await until(() => events.slice(before).some((e) => e.t === "envelope" && e.env.kind === "budget" && e.env.to?.[0] === "kimi"), "checkpoint request");
  expect(daemon.bus.stateOf("kimi")).not.toBe("paused"); // checkpoint first, pause second
  expect((await kimiTools.request({ t: "task", op: "hub_checkpoint", args: { summary: "tokenizer done, grammar half done" } })).text).toContain("checkpoint received");
  await until(() => daemon.bus.stateOf("kimi") === "paused", "pause");
  await until(() => events.some((e) => e.t === "envelope" && e.env.from === "local"), "local took it over");
  expect(events.find((e) => e.t === "envelope" && e.env.from === "local").env.body).toBe("local got: handoff");
  const notices = () => pushes.filter((p) => p.t === "notice").map((p) => p.line as string);
  expect(notices().some((l) => l.includes("moved from kimi: #1 owner -> local"))).toBe(true);

  await console_.request({ t: "budget", set: { peer: "kimi", used: 0.97, resetsInMs: 3_600_000 } }); // again: nothing happens
  await Bun.sleep(50);
  expect(notices().filter((l) => l.includes("kimi paused"))).toHaveLength(1);
  const shown = await console_.request({ t: "budget" });
  expect(shown.budget.kimi.paused.reason).toContain("95%");
  expect((await console_.request({ t: "status" })).status.peers.kimi.paused).toContain("budget: 5h window at 95%");
  const refused = await console_.request({ t: "resume", peer: "kimi" }); // ahub resume does not override the coordinator
  expect(refused).toMatchObject({ ok: false });
  expect(refused.error).toContain("ahub budget resume kimi");
  const ui = await dashboardClient(console_);
  expect(await ui.post("action", { action: "resume", peer: "kimi" })).toMatchObject({ ok: false });
  expect((await ui.post("snapshot")).budget.kimi.paused.reason).toContain("95%");

  await console_.request({ t: "pause", peer: "kimi" }); // the user also pauses it by hand
  await console_.request({ t: "budget", set: { peer: "kimi", used: 0.2 } }); // the mocked reset
  await until(() => notices().some((l) => l.includes("kimi resumed")), "budget resume");
  expect(daemon.bus.stateOf("kimi")).toBe("paused"); // the manual pause stays
  expect((await console_.request({ t: "resume", peer: "kimi" })).ok).toBe(true);
  await until(() => events.some((e) => e.t === "envelope" && e.env.kind === "budget" && e.env.body.includes("has resumed you")), "resume envelope");
  expect(events.find((e) => e.t === "envelope" && e.env.body.includes("has resumed you")).env.body).toContain("#1 port the parser (owner -> local)");
  kimiTools.close();
});

test("ahub ask over the control link: console only, evidence from the board, --remember saves a note but never one that rests on a PII task", async () => {
  const mem = startFakeMemWorker();
  const model = startFakeModelServer({ key: "k", script: (b) => ({ content: JSON.parse(String(b.messages[1]!.content)).evidence.some((e: any) => e.id === "task #2") ? "Two tasks are open [task #1] [task #2]." : "One task is open [task #1]." }) });
  cleanup.push(mem.stop, model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { stateDir, console_ } = await hub({ modelUrl: model.url, memoryUrl: mem.url });
  await console_.request({ t: "task", op: "hub_task_propose", args: { title: "write the release notes", class: "summarize" } });

  const res = await console_.request({ t: "ask", question: "what is open?", remember: true });
  expect(res).toMatchObject({ ok: true, found: true, answer: "One task is open [task #1].", pii: false, saved: "saved to shared memory as a model-written answer" });
  expect(res.evidence[0]).toMatchObject({ id: "task #1", kind: "task" });
  // saved as what it is: the hub's model wrote it, the user only asked
  const note = mem.calls.filter((c) => c.path === "/api/memory/save").at(-1)!.body as any;
  expect(note.metadata).toMatchObject({ peer: "hub", asked_by: "user", source: "ahub ask" });
  expect(note.title).toStartWith("ahub ask (model answer)");

  await console_.request({ t: "task", op: "hub_task_propose", args: { title: "fix the entry for 900101-1234567", class: "implement", refs: { paths: ["900101-private.txt"], branch: "900101-private" } } });
  const saves = mem.calls.filter((c) => c.path === "/api/memory/save").length;
  const withPii = await console_.request({ t: "ask", question: "what is open?", remember: true });
  expect(withPii).toMatchObject({ pii: true, saved: "not saved: PII is involved" });
  expect(mem.calls.filter((c) => c.path === "/api/memory/save")).toHaveLength(saves);
  expect(JSON.stringify(mem.calls.map((c) => c.body ?? c.query))).not.toContain("900101");

  // a peer-side client gets no answer at all
  const asKimi = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi" });
  expect(await asKimi.request({ t: "ask", question: "what is open?" })).toMatchObject({ ok: false, error: "ask is a console command" });
  // and a message this hub does not know is answered, not left hanging (a newer CLI against an older hub)
  expect(await asKimi.request({ t: "from-the-future" })).toMatchObject({ ok: false });
  asKimi.close();
});

test("kill removes pid, status and token", async () => {
  const { stateDir, daemon, console_ } = await hub();
  console_.send({ t: "kill" });
  await daemon.stopped;
  expect(() => statSync(join(stateDir, "hub.pid"))).toThrow();
  expect(() => statSync(join(stateDir, "control-token"))).toThrow();
});


test("dashboard is lazy, console-only, closes with daemon and keeps the control origin ban", async () => {
  const { daemon, console_, stateDir } = await hub();
  expect((await console_.request({ t: "status" })).status.uiOrigin).toBeUndefined();
  const peer = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" });
  expect(await peer.request({ t: "ui" })).toMatchObject({ ok: false });
  peer.close();
  expect((await console_.request({ t: "status" })).status.uiOrigin).toBeUndefined();
  const cli = Bun.spawn([process.execPath, join(ROOT, "src/cli/main.js"), "ui", "--no-open"], { cwd: ROOT, env: { ...process.env, AGENTHUB_STATE_DIR: stateDir }, stdout: "pipe", stderr: "pipe" });
  const link = (await new Response(cli.stdout).text()).trim();
  expect(await cli.exited).toBe(0);
  expect(new URL(link).hash).toMatch(/^#[a-f0-9]{64}$/);
  expect(link).not.toContain(daemon.token);
  const ui = await dashboardClient(console_);
  expect(new URL(link).origin).toBe(ui.origin);
  expect((await console_.request({ t: "status" })).status.uiOrigin).toBe(ui.origin);
  for (const origin of [ui.origin, "https://evil.example", "null", ""]) {
    expect((await fetch(`http://127.0.0.1:${daemon.port}/healthz`, { headers: { origin } })).status).toBe(403);
  }
  const shell = await (await fetch(ui.origin)).text();
  expect(shell).not.toContain(daemon.token);
  expect(JSON.stringify(await ui.post("snapshot"))).not.toContain(daemon.token);
  await daemon.stop();
  await expect(fetch(ui.origin)).rejects.toThrow();
});

test("dashboard snapshots, allow/deny approvals, task actions, pauses and restricted actions work end to end", async () => {
  const { console_, pushes, events, stateDir } = await hub();
  const ui = await dashboardClient(console_);
  const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
  cleanup.push(() => claude.close());
  await console_.request({ t: "start", peer: "kimi" });
  expect((await ui.post("snapshot")).status.peers.kimi).toMatchObject({ state: "idle", queued: 0 });
  for (const option of ["yes", "no"]) {
    pushes.length = 0;
    expect(await ui.post("action", { action: "send", to: ["kimi"], body: "PERMISSION" })).toMatchObject({ ok: true });
    await until(() => pushes.some((p) => p.t === "permission"));
    const pending = (await ui.post("snapshot")).permissions[0];
    expect(pending.title).toBe("write file (payload not reported by the agent)");
    expect(await ui.post("action", { action: "permit", id: pending.id, option: "made-up" })).toMatchObject({ ok: false });
    expect(await ui.post("action", { action: "permit", id: pending.id, option })).toMatchObject({ ok: true });
    await until(() => events.some((e) => e.t === "envelope" && e.env.body.endsWith(`permission=${option}`)));
    expect(await ui.post("action", { action: "permit", id: pending.id, option })).toMatchObject({ ok: false });
    expect((await ui.post("snapshot")).permissions).toHaveLength(0);
  }
  expect(await ui.post("action", { action: "pause", peer: "kimi" })).toMatchObject({ ok: true });
  expect(await ui.post("action", { action: "send", body: "queued message", to: ["kimi"] })).toMatchObject({ ok: true });
  expect((await ui.post("snapshot")).status.peers.kimi).toMatchObject({ state: "paused", queued: 1 });
  expect(await ui.post("action", { action: "resume", peer: "kimi" })).toMatchObject({ ok: true });
  expect(await ui.post("action", { action: "propose", title: "Dashboard task", class: "implement" })).toMatchObject({ ok: true });
  expect(await ui.post("action", { action: "assign", id: 1, peer: "kimi" })).toMatchObject({ ok: true });
  expect((await ui.post("snapshot")).tasks[0]).toMatchObject({ title: "Dashboard task", owner: "kimi" });
  await console_.request({ t: "budget", set: { peer: "kimi", used: 0.25, resetsInMs: 30_000 } });
  expect((await ui.post("snapshot")).budget.kimi.windows[0].used).toBe(0.25);
  // Kimi is still answering the resumed message and its new task: let the hub go quiet before taking the cursor.
  let snap = await ui.post("snapshot");
  for (let i = 0; i < 40; i++) { // about 2 s, inside bun's 5 s test timeout: a hub that never goes quiet fails below
    await Bun.sleep(50);
    const again = await ui.post("snapshot");
    const kimi = again.status.peers.kimi;
    if (again.cursor === snap.cursor && kimi.state === "idle" && kimi.queued === 0) break;
    snap = again;
  }
  expect(snap.events.length).toBeGreaterThan(0);
  expect((await ui.post("snapshot", { after: snap.cursor })).events).toHaveLength(0);
  for (const action of ["task_show", "task", "ask", "kill", "start", "budget", "hub_remember", "shell"]) {
    expect(await ui.post("action", { action, id: 1, body: "bad" })).toMatchObject({ ok: false });
  }
});


test("dashboard hides local permission contents, refuses allow and can deny", async () => {
  const privateValue = "900101-1234567";
  const model = startFakeModelServer({ key: "k", script: (body) => body.messages.some((m) => m.role === "tool")
    ? { content: "write refused" }
    : { tool_calls: [toolCall("write", { path: "dashboard-denied-test.txt", content: privateValue })] } });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { console_, pushes } = await hub({ modelUrl: model.url });
  const ui = await dashboardClient(console_);
  await console_.request({ t: "start", peer: "local", args: { model: "vllm/test" } });
  await console_.request({ t: "send", to: ["local"], body: "write a file" });
  await until(() => pushes.some((p) => p.t === "permission"));
  expect(pushes.find((p) => p.t === "permission").title).toContain(privateValue);
  const snapshot = await ui.post("snapshot");
  expect(JSON.stringify(snapshot)).not.toContain(privateValue);
  const pending = snapshot.permissions[0];
  expect(pending.terminalOnly).toBe(true);
  expect(pending.options.map((o: any) => o.optionId)).toEqual(["deny"]);
  expect(await ui.post("action", { action: "permit", id: pending.id, option: "allow" })).toMatchObject({ ok: false });
  expect(await ui.post("action", { action: "permit", id: pending.id, option: "deny" })).toMatchObject({ ok: true });
});

// issue #7: the daemon's side of completion checks.
test("completion checks: run where git vouches for the config, refused where it cannot, and none starts after the hub stops", async () => {
  const project = (git: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "agenthub-checks-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    if (git) Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
    return dir;
  };
  const ops = (h: Awaited<ReturnType<typeof hub>>) => async (op: string, args: unknown) => (await h.console_.request({ t: "task", op, args })).text as string;

  const ran = await hub({ cwd: project(true), checks: { timeout_s: 600, implement: "echo checked", nonsense: "true" } });
  const op = ops(ran);
  await op("hub_task_propose", { title: "fix", class: "implement" });
  expect(await op("hub_task_done", { id: 1, summary: "fixed" })).toContain("its check is queued or running");
  let shown = "";
  for (let i = 0; i < 100 && !shown.includes("check passed"); i++) (shown = await op("task_show", { id: 1 })), await Bun.sleep(20);
  expect(shown).toContain("echo checked -> exit 0");
  expect(readFileSync(join(ran.stateDir, "hub.log"), "utf8")).toContain("checks ignored for nonsense: not a task class");

  // Outside a repository the loader keeps the default checks (issue #17) and the daemon logs why.
  const plain = project(false);
  mkdirSync(join(plain, ".agenthub"));
  writeFileSync(join(plain, ".agenthub", "config.json"), JSON.stringify({ checks: { implement: "echo checked" } }));
  const loaded = loadConfig(plain);
  const refused = await hub({ cwd: plain, checks: loaded.checks, ignored: loaded.ignored });
  expect(readFileSync(join(refused.stateDir, "hub.log"), "utf8")).toContain("checks in .agenthub/config.json ignored: git could not confirm that .agenthub/config.json is untracked; only a config file nobody committed may set it");
  await ops(refused)("hub_task_propose", { title: "fix", class: "implement" });
  expect(await ops(refused)("hub_task_done", { id: 1, summary: "fixed" })).not.toContain("check");

  const dir = project(true);
  const stopped = await hub({ cwd: dir, checks: { timeout_s: 600, implement: "echo $$ >> pids; sleep 30" } });
  const sop = ops(stopped);
  for (const id of [1, 2]) {
    await sop("hub_task_propose", { title: `fix ${id}`, class: "implement" });
    await sop("hub_task_done", { id, summary: "fixed" });
  }
  await until(() => existsSync(join(dir, "pids")), "the first check to start");
  await stopped.daemon.stop();
  await Bun.sleep(700); // past the drain window: the queued second check would have started by now
  const pids = readFileSync(join(dir, "pids"), "utf8").trim().split("\n");
  expect(pids).toHaveLength(1);
  expect(() => process.kill(Number(pids[0]), 0)).toThrow();
});

// issue #40: events.jsonl from a scripted hub reproduces the known counts and never carries a body.
test("telemetry: a scripted hub's events give the known counts, match the overlap counter, and hold no bodies", async () => {
  const { stateDir, daemon, console_ } = await hub();
  const { client } = await fakeClaude(stateDir);
  await until(() => daemon.bus.peers.get("claude")?.state === "idle", "claude attach");
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const op = async (o: string, args: unknown) => (await console_.request({ t: "task", op: o, args })).text as string;
  await op("hub_task_propose", { title: "refactor the bus", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] } });
  await op("hub_task_propose", { title: "retry backoff", class: "implement", owner: "claude", refs: { paths: ["src/hub/bus.ts"] } });
  await op("hub_task_propose", { title: "patient 900101-1234567 needs a follow-up", class: "implement" });
  await client.callTool({ name: "hub_send", arguments: { text: "secret-body-text run the tests" } });
  const file = join(stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "turn_end" && e.peer === "kimi"), "a kimi turn");
  const events = readEvents(file);
  const r = summarize(events);
  expect(r.overlaps).toEqual({ warnings: 1, pairs: 1 });
  expect(r.tasks.proposed).toBe(3);
  expect(r.peers.kimi!.turns).toBeGreaterThanOrEqual(1);
  expect(r.peers.kimi!.tokens).toBe(50 * r.peers.kimi!.turns); // the fake's usage_update: a session total, 50 per prompt
  expect(r.messages.total).toBeGreaterThanOrEqual(1);
  // The same notice the human sees, counted by scripts/overlaps.ts from hub.log.
  expect(parseOverlaps(readFileSync(join(stateDir, "hub.log"), "utf8")).length).toBe(r.overlaps.warnings);
  const raw = readFileSync(file, "utf8");
  expect(raw).not.toContain("secret-body-text");
  expect(raw).not.toContain("900101-1234567");
  expect(events.every((e) => !("body" in e))).toBe(true);
});

// Review of #46: a pause shows a busy peer as paused, but the work goes on, so it is one turn.
test("telemetry: pausing a busy peer does not split its turn, and sizes are UTF-8 bytes", async () => {
  const { stateDir, daemon, console_ } = await hub();
  let finish!: () => void;
  class Slow extends BasePeer {
    async start() { this.setState("idle"); }
    async deliver() {
      this.setState("busy");
      finish = () => this.setState("idle");
    }
    async stop() { this.setState("offline"); }
  }
  const slow = new Slow("slow");
  daemon.bus.add(slow);
  await slow.start();
  expect((await console_.request({ t: "send", body: "héllo 안녕", to: ["slow"] })).ok).toBe(true);
  await until(() => slow.state === "busy", "the slow turn");
  daemon.bus.pause("slow");
  daemon.bus.resume("slow");
  finish();
  // and a turn that finishes while its peer is paused (what a budget pause does) ends then
  const file0 = join(stateDir, "events.jsonl");
  await until(() => readEvents(file0).some((e) => e.type === "turn_end" && e.peer === "slow"), "the first turn's end");
  expect((await console_.request({ t: "send", body: "again", to: ["slow"] })).ok).toBe(true);
  await until(() => slow.state === "busy", "the second turn");
  daemon.bus.pause("slow");
  finish();
  await until(() => readEvents(file0).filter((e) => e.type === "turn_end" && e.peer === "slow").length === 2, "the paused turn's end");
  daemon.bus.resume("slow");
  const events = readEvents(file0);
  expect(events.filter((e) => e.type === "turn_start" && e.peer === "slow")).toHaveLength(2);
  expect(events.filter((e) => e.type === "state" && e.peer === "slow").map((e) => (e as { state: string }).state)).toContain("paused");
  const sent = events.find((e) => e.type === "envelope" && e.from === "user" && e.to?.includes("slow")) as { bytes: number };
  expect(sent.bytes).toBe(Buffer.byteLength("héllo 안녕"));
});

// issue #33: a turn's files are known from snapshots, not from tool events, so a shell-made change counts too.
test("snapshots: a turn records what it changed, and ahub undo restores it unless the file changed since", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-snaprepo-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a]);
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const { stateDir, daemon, console_ } = await hub({ cwd: dir, snapshots: { enabled: true, keep: 20 } });
  class Editor extends BasePeer {
    async start() { this.setState("idle"); }
    async deliver() {
      this.setState("busy");
      writeFileSync(join(dir, "a.txt"), "edited\n"); // what a shell command does: no tool event says so
      writeFileSync(join(dir, "made.txt"), "new\n");
      setTimeout(() => this.setState("idle"), 5);
    }
    async stop() { this.setState("offline"); }
  }
  const editor = new Editor("editor");
  daemon.bus.add(editor);
  await editor.start();
  expect((await console_.request({ t: "send", body: "edit please", to: ["editor"] })).ok).toBe(true);
  const file = join(stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "turn_end" && e.peer === "editor"), "the editor's turn");
  const ended = readEvents(file).find((e) => e.type === "turn_end" && e.peer === "editor") as { files?: number; snapshotMs?: number };
  expect(ended.files).toBe(2);
  expect(ended.snapshotMs).toBeGreaterThanOrEqual(0);

  // Async: the hub runs in this process, and a blocking spawn would keep it from answering the CLI.
  const cli = async (...a: string[]) => {
    const p = Bun.spawn([process.execPath, join(ROOT, "src/cli/main.js"), ...a], { cwd: dir, env: { ...process.env, AGENTHUB_STATE_DIR: stateDir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };
  const listed = await cli("turns", "editor");
  expect(listed.out).toContain("2 files: a.txt, made.txt");
  const turn = listed.out.split(/\s/)[0]!;
  expect((await cli("undo", turn)).out).toContain("add --yes"); // a dry run by default
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("edited\n");
  writeFileSync(join(dir, "a.txt"), "somebody else's work\n");
  const refused = await cli("undo", turn, "--yes");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("a.txt");
  expect(existsSync(join(dir, "made.txt"))).toBe(true); // nothing was touched
  writeFileSync(join(dir, "a.txt"), "edited\n");
  const noContext = await cli("undo", turn, "--yes", "--context"); // the conversation half goes first, so a refusal leaves the files
  expect(noContext.code).toBe(1);
  expect(noContext.err).toContain("no Codex conversation turn");
  expect(existsSync(join(dir, "made.txt"))).toBe(true);
  const undone = await cli("undo", turn, "--yes");
  expect(undone.code).toBe(0);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(dir, "made.txt"))).toBe(false);
  expect(git("status", "--porcelain").stdout.toString()).toBe(""); // back to the committed state, index untouched
});

// Review of #47 (F9): the daemon side of `ahub undo --context`, with Codex on the fake app-server.
test("snapshots: a Codex turn records its native id, and turn_revert reverts the thread while holding Codex's deliveries", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-revert-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  const record = join(dir, "..", `${dir.split("/").at(-1)}-reverts.jsonl`);
  cleanup.push(() => rmSync(record, { force: true }));
  const bin = join(dir, "..", `${dir.split("/").at(-1)}-codex.sh`);
  writeFileSync(bin, `#!/bin/sh\nexec bun ${join(ROOT, "test/fakes/codex-bin.ts")} --record ${record} "$@"\n`, { mode: 0o755 });
  cleanup.push(() => rmSync(bin, { force: true }));
  const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port as number; s.stop(true); return p; };
  const [appPort, proxyPort] = [freePort(), freePort()];
  const { stateDir, daemon, console_ } = await hub({ cwd: dir, snapshots: { enabled: true, keep: 20 }, codex_bin: bin, codexAppPort: appPort, codexProxyPort: proxyPort });
  expect((await console_.request({ t: "start", peer: "codex" })).ok).toBe(true);
  const tui = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
  cleanup.push(() => tui.close());
  await new Promise((r) => (tui.onopen = r));
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => daemon.bus.stateOf("codex") === "idle", "codex thread");
  expect((await console_.request({ t: "send", body: "do it", to: ["codex"] })).ok).toBe(true);
  const file = join(stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "turn_end" && e.peer === "codex"), "the codex turn");
  await until(() => daemon.bus.stateOf("codex") === "idle" && daemon.bus.queued("codex") === 0, "a quiet codex");
  const records = new Turns(join(stateDir, "hub.db"), true);
  const latest = records.latest("codex")!;
  records.close();
  expect(latest.native).toMatch(/^turn\d+$/);
  const turn = latest.id;
  const states: string[] = [];
  const off = daemon.bus.tap((e) => void (e.t === "state" && e.peer === "codex" && states.push(e.state)));
  const reverted = await console_.request({ t: "task", op: "turn_revert", args: { turn } });
  off();
  expect(reverted).toMatchObject({ ok: true, text: `Codex's conversation no longer holds turn ${turn}` });
  expect(readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ threadId: "th1", beforeTurnId: latest.native }]);
  expect(states).toEqual(["paused", "idle"]); // held during the revert, released after
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain(`turn_revert ${turn}: Codex conversation reverted to before ${latest.native}`);
});

// Review of #47 (R3): a peer with a PII task open, accepted or not, is not snapshotted; its turn is recorded without trees.
test("snapshots: a turn of a peer holding an unaccepted PII task is recorded without snapshots", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-piisnap-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  const { stateDir, daemon, console_ } = await hub({ cwd: dir, snapshots: { enabled: true, keep: 20 } });
  class Worker extends BasePeer {
    async start() { this.setState("idle"); }
    async deliver() {
      this.setState("busy");
      writeFileSync(join(dir, "record.txt"), "900101-1234567\n");
      setTimeout(() => this.setState("idle"), 5);
    }
    async stop() { this.setState("offline"); }
  }
  const local = new Worker("local");
  daemon.bus.add(local);
  await local.start();
  expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: "fix the entry for 900101-1234567", class: "implement" } })).text).toContain("owner local");
  const file = join(stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "turn_end" && e.peer === "local"), "the PII offer's turn");
  const ended = readEvents(file).find((e) => e.type === "turn_end" && e.peer === "local") as { files?: number };
  expect(ended.files).toBeUndefined();
  const records = new Turns(join(stateDir, "hub.db"), true);
  expect(records.latest("local")).toMatchObject({ start_tree: null, end_tree: null, changed: [] });
  records.close();
});

// Review of #48 (H1): a PII turn cannot carry the worker's words onto an ordinary task (plan, summary, review note).
test("during a PII turn the local worker cannot accept with a plan, finish or review an ordinary task", async () => {
  const model = startFakeModelServer({
    key: "k",
    script: (body) => {
      const text = JSON.stringify(body.messages);
      const tools = body.messages.filter((m) => m.role === "tool");
      if (!text.includes("900101")) return { content: "noted" }; // the ordinary offer: no tools
      if (tools.length === 0) return { tool_calls: [toolCall("hub_task_accept", { id: 1, plan: { signatures: ["callBack(patientId)"] } }), toolCall("hub_task_done", { id: 1, summary: "called the patient back" }), toolCall("hub_review", { id: 1, verdict: "approved", note: "fine" })] };
      return { content: `tools said: ${tools.map((t) => t.content).join(" | ")}` };
    },
  });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  cleanup.push(() => delete process.env.OMNIROUTE_API_KEY);
  const { console_ } = await hub({ modelUrl: model.url });
  await console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } });
  const op = async (o: string, args: unknown) => console_.request({ t: "task", op: o, args });
  expect((await op("hub_task_propose", { title: "ordinary cleanup", class: "implement", owner: "local" })).text).toContain("task #1");
  await until(() => model.requests.length >= 1, "the ordinary turn");
  expect((await op("hub_task_propose", { title: "fix the entry for 900101-1234567", class: "implement" })).text).toContain("task #2");
  await until(() => model.requests.some((r) => r.body.messages.some((m: { role: string }) => m.role === "tool")), "the PII turn's tools");
  // the turn's answer, with the tools' refusals, is filed on the PII task after the last request
  let answer = "";
  for (let i = 0; i < 300 && !answer.includes("hub_review on task #1"); i++) {
    answer = (await op("task_show", { id: 2 })).text;
    if (!answer.includes("hub_review on task #1")) await Bun.sleep(10);
  }
  const shown = JSON.parse((await op("task_show", { id: 1 })).text);
  expect(shown.plan).toEqual({});
  expect(shown.state).toBe("proposed");
  for (const name of ["hub_task_accept", "hub_task_done", "hub_review"]) expect(answer).toContain(`${name} on task #1 is not available while working on a PII task`);
});
