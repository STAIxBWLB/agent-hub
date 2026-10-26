import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { readEvents } from "../src/hub/events.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import type { InstancesConfig } from "../src/hub/instances.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
const instances: InstancesConfig = { "pi-a": { kind: "pi", roles: ["reviewer"], start_mode: "headless" }, "pi-b": { kind: "pi", roles: ["reviewer"], start_mode: "headless" } };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-pi-")), stateDir = join(root, "state"), record = join(root, "native-identities.jsonl"), wrapper = join(root, "fake-pi.ts");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ instances }));
  // The existing fake deliberately uses one session id. Distinct native roots must still isolate its receipts.
  writeFileSync(wrapper, `import { appendFileSync } from "node:fs";\nif(process.argv.includes("--version")){console.log("1.4.0");process.exit(0);}\nappendFileSync(${JSON.stringify(record)}, JSON.stringify({ peer: process.env.AGENTHUB_PEER_ID, nativeRoot: process.env.PI_CODING_AGENT_DIR, sessionDir: process.argv[process.argv.indexOf("--session-dir")+1] })+"\\n");\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/pi-rpc.ts")).href)});\n`);
  const model = startFakeModelServer({ key: "instance-pi-fixture", models: ["fixture-coding", "fixture-fast"], script: body => ({ content: `fixture response ${body.messages.at(-1)?.content}` }) });
  cleanup.push(model.stop);
  const oldUrl = process.env.AGENTHUB_OMNIROUTE_URL, oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.AGENTHUB_OMNIROUTE_URL = model.url; process.env.OMNIROUTE_API_KEY = "instance-pi-fixture";
  cleanup.push(() => {
    if (oldUrl === undefined) delete process.env.AGENTHUB_OMNIROUTE_URL; else process.env.AGENTHUB_OMNIROUTE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = oldKey;
  });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      omniroute: { urls: [model.url], access_hosts: [] }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, wrapper], dgx_coding: "fixture-coding", dgx_fast: "fixture-fast" } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => console_.close());
  const start = async (id: string) => {
    expect(await console_.request({ t: "start", peer: id, args: { mode: "headless", backend: "dgx" } })).toMatchObject({ ok: true });
    await until(() => daemon.bus.stateOf(id) === "idle", `${id} fake native owner attached`);
    const peer = daemon.bus.peers.get(id) as PiPeer, launch = peer.tuiLaunch!;
    return { peer, launch, session: peer.recoveryMetadata().sessionId as string, file: peer.recoveryMetadata().sessionFile as string };
  };
  const a = await start("pi-a"), b = await start("pi-b");
  const call = async (owner: typeof a, name: string, args: unknown, callId: string) => {
    const response = await fetch(`${owner.launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: { authorization: `Bearer ${owner.launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name, args, toolCallId: callId, sessionId: owner.session, generation: 0 }) });
    expect(response.status).toBe(200); return response.json() as Promise<{ text: string }>;
  };
  return { root, stateDir, daemon, console_, model, a, b, call, identities: () => readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line) as { peer: string; nativeRoot: string; sessionDir: string }) };
}

test("I2 two Pi native owners isolate roots, exact MCP identities and colliding session/tool-call receipts", async () => {
  const f = await fixture();
  const rows = f.identities(); expect(rows.map(row => row.peer).sort()).toEqual(["pi-a", "pi-b"]);
  expect(new Set(rows.map(row => row.nativeRoot)).size).toBe(2); expect(new Set(rows.map(row => row.sessionDir)).size).toBe(2);
  expect(f.a.file).not.toBe(f.b.file); expect(existsSync(f.a.file)).toBe(true); expect(existsSync(f.b.file)).toBe(true);
  expect(f.a.session).toBe(f.b.session); // collisions are intentional, not avoided by the fixture
  writeFileSync(join(f.root, "sample.txt"), "first owner's result");
  expect((await f.call(f.a, "read", { path: "sample.txt" }, "same-call")).text).toContain("first owner's result");
  writeFileSync(join(f.root, "sample.txt"), "second owner's result");
  expect((await f.call(f.b, "read", { path: "sample.txt" }, "same-call")).text).toContain("second owner's result");
  expect((await f.call(f.a, "read", { path: "sample.txt" }, "same-call")).text).toContain("first owner's result");
  const receiver = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: f.root }); cleanup.push(() => receiver.close());
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "fake MCP recipient attached");
  const sent: Envelope[] = []; f.daemon.bus.tap(event => { if (event.t === "envelope") sent.push(event.env); });
  for (const peer of ["pi-a", "pi-b"]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], cwd: f.root,
      env: { ...process.env, AGENTHUB_MODE: "tools", AGENTHUB_PEER_ID: peer, AGENTHUB_STATE_DIR: f.stateDir, AGENTHUB_PROJECT_DIR: f.root }, stderr: "pipe" });
    let diagnostic = ""; transport.stderr?.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-4096); });
    const client = new Client({ name: "pi-instance-isolation", version: "1" }); cleanup.push(() => client.close());
    await client.connect(transport);
    await until(() => diagnostic.includes(`connected to hub as "${peer}"`), `${peer} MCP consumed authenticated handshake`);
    expect((await client.callTool({ name: "hub_send", arguments: { to: ["claude"], text: `MCP_IDENTITY_${peer}` } })).isError).not.toBe(true);
    expect(sent.some(env => env.from === peer && env.body === `MCP_IDENTITY_${peer}`)).toBe(true);
  }
}, 20_000);

test("I2 each Pi relay binds model-call budgets and route attribution to its selected native owner", async () => {
  const f = await fixture();
  expect(f.a.launch.env.AGENTHUB_PI_RELAY_URL).not.toBe(f.b.launch.env.AGENTHUB_PI_RELAY_URL);
  expect(f.a.launch.env.AGENTHUB_PI_RELAY_TOKEN).not.toBe(f.b.launch.env.AGENTHUB_PI_RELAY_TOKEN);
  for (const [peer, calls] of [["pi-a", 1], ["pi-b", 2]] as const) {
    expect(await f.console_.request({ t: "execution_budget", op: "configure", config: { id: `run:${peer}`, kind: "run", peers: [peer], limits: { model_calls: calls } } })).toMatchObject({ ok: true });
  }
  const relay = (owner: typeof f.a, text: string, token = owner.launch.env.AGENTHUB_PI_RELAY_TOKEN) => fetch(`${owner.launch.env.AGENTHUB_PI_RELAY_URL}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "hub/auto", messages: [{ role: "user", content: text }] }),
  });
  const unauthorized = await relay(f.a, "wrong-owner-token", f.b.launch.env.AGENTHUB_PI_RELAY_TOKEN); expect(unauthorized.status).toBe(401); await unauthorized.text();
  for (const [owner, label] of [[f.a, "owner-a"], [f.b, "owner-b"]] as const) { const response = await relay(owner, label); expect(response.status).toBe(200); expect(await response.text()).toContain(label); }
  const routes = readEvents(join(f.stateDir, "events.jsonl")).filter(event => event.type === "route");
  expect(routes.map(event => event.peer)).toEqual(["pi-a", "pi-b"]);
  const exhausted = await relay(f.a, "a-must-not-dispatch"); expect(exhausted.status).toBe(502); expect(await exhausted.text()).toContain("execution budget");
  const remaining = await relay(f.b, "b-still-has-own-budget"); expect(remaining.status).toBe(200); await remaining.text();
  const a = await f.console_.request({ t: "execution_budget", op: "status", id: "run:pi-a" }), b = await f.console_.request({ t: "execution_budget", op: "status", id: "run:pi-b" });
  expect(a.budgets).toMatchObject({ peers: ["pi-a"], used: { model_calls: 1 } });
  expect(b.budgets).toMatchObject({ peers: ["pi-b"], used: { model_calls: 2 } });
  expect(f.model.requests).toHaveLength(3);
  expect(JSON.stringify(f.model.requests.map(request => request.body.messages))).not.toContain("a-must-not-dispatch");
}, 20_000);
