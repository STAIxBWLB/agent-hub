import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";
const cleanup: (() => unknown)[] = []; afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const ids = ["question", "draft", "approve", "publish"];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-lifecycle-native-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub/sdlc.toml"), 'mode = "advise"\nstages = ["question", "draft", "approve", "publish"]\n[definitions.question]\nbase = "plan"\n[definitions.draft]\nbase = "implement"\n[definitions.approve]\nbase = "review"\n[definitions.publish]\nbase = "merge"\n');
  return dir;
}
test("every managed MCP surface advertises the project lifecycle ids in its real tools response (#257)", async () => {
  const dir = root();
  for (const entry of ["../src/adapters/claude-channel.ts", "../plugins/agent-hub/server.js"]) for (const [peer, mode] of [["claude", "inbox"], ["claude", "channel"], ["codex", "tools"], ["kimi", "tools"], ["qwen", "tools"], ["jcode", "tools"], ["pi", "tools"]] as const) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_CHANNEL", "AGENTHUB_MODE", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"].includes(key))) as Record<string, string>;
    Object.assign(env, { AGENTHUB_PROJECT_DIR: dir, AGENTHUB_STATE_DIR: join(dir, "state"), AGENTHUB_PEER_ID: peer });
    if (mode === "channel") env.AGENTHUB_CHANNEL = "1"; if (mode === "tools") env.AGENTHUB_MODE = "tools";
    const client = new Client({ name: "lifecycle-schema-fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, entry)], env, stderr: "pipe" });
    try {
      await client.connect(transport); const tools = await client.listTools();
      const schema = tools.tools.find(t => t.name === "hub_sdlc_record")?.inputSchema.properties?.receipt as { properties: { stage: { enum: string[] } } };
      expect(schema.properties.stage.enum, `${entry}:${peer}/${mode}`).toEqual(ids);
    } finally { await client.close(); }
  }
});
test("daemon forwards its active custom lifecycle schema to the actual LocalPeer provider request (#257)", async () => {
  const dir = root(), stateDir = join(dir, "state");
  const previous = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "fixture-key"; cleanup.push(() => { if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous; });
  const model = startFakeModelServer({ key: "fixture-key", script: () => ({ content: "schema observed" }) }); cleanup.push(model.stop);
  const daemon = await startDaemon({ cwd: dir, stateDir, unattended: true, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG,
    omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "local", args: { model: "fixture" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("local")!; await peer.deliver([newEnvelope("user", "inspect lifecycle tools")]);
  for (let i = 0; i < 300 && peer.state !== "idle"; i++) await Bun.sleep(5); expect(peer.state).toBe("idle"); expect(model.requests.length).toBeGreaterThan(0);
  const tools = model.requests.at(-1)!.body.tools as { function: { name: string; parameters: { properties: { receipt: { properties: { stage: { enum: string[] } } } } } } }[];
  expect(tools.find(t => t.function.name === "hub_sdlc_record")?.function.parameters.properties.receipt.properties.stage.enum).toEqual(ids);
});
