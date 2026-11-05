import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { syntheticClaudeParentEvidenceSetup } from "./fakes/claude-channel-parent.ts";

const config = { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } };
async function until(check: () => boolean, tries = 400) {
  for (let i = 0; i < tries && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) throw new Error("MCP tool result has no content array");
  return result.content.map((block: unknown) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("\n");
}

async function channelSession(dir: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENTHUB_") && k !== "CLAUDECODE" && k !== "CLAUDE_CODE_SESSION_ID") env[k] = v;
  Object.assign(env, { HOME: dir, AGENTHUB_HOME: join(dir, "hub-home"), AMEM_HOME: join(dir, "memory-home"), CLAUDE_CONFIG_DIR: join(dir, "claude-home"),
    AGENTHUB_STATE_DIR: dir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: "claude", AGENTHUB_CHANNEL: "1" });
  const client = new Client({ name: "fixture-claude", version: "1" });
  const changes: string[] = [];
  client.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema, async () => { changes.push("list_changed"); });
  const entry = join(import.meta.dir, "../src/adapters/claude-channel.ts"), wrapper = join(dir, "claude-channel-fixture.ts");
  writeFileSync(wrapper, `${syntheticClaudeParentEvidenceSetup()} await import(${JSON.stringify(entry)});`);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [wrapper], env, cwd: dir, stderr: "ignore" }));
  return { client, changes };
}

test("a Claude channel session lists the same hub tools after a hub restart as before it (#490)", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-restart-")));
  let daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const { client, changes } = await channelSession(dir);
  try {
    await until(() => daemon.bus.peers.get("claude")?.state === "idle");
    const names = async () => (await client.listTools()).tools.map(tool => tool.name).sort();
    const before = await names();
    await daemon.stop();
    const during = await names();
    daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
    await until(() => daemon.bus.peers.get("claude")?.state === "idle", 3000);
    const after = await names();
    expect(after).toEqual(before);
    // While the hub was down the lifecycle-gated hub_sdlc_record was not listed; the reconnect must tell the host to
    // list the tools again, or a session that listed them during the outage keeps the short list (#490).
    expect(during).not.toContain("hub_sdlc_record");
    expect(before.filter(name => !during.includes(name))).toEqual(["hub_sdlc_record"]);
    await until(() => changes.length > 0, 300);
  } finally { await client.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("a restart that changes only tool schemas, not names, re-announces the tool list (#490)", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-schema-")));
  let daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const { client, changes } = await channelSession(dir);
  try {
    await until(() => daemon.bus.peers.get("claude")?.state === "idle");
    const before = (await client.listTools()).tools;
    await daemon.stop();
    mkdirSync(join(dir, ".agenthub"), { recursive: true });
    writeFileSync(join(dir, ".agenthub/sdlc.toml"), 'mode = "advise"\nstages = ["question", "draft", "approve", "publish"]\n[definitions.question]\nbase = "plan"\n[definitions.draft]\nbase = "implement"\n[definitions.approve]\nbase = "review"\n[definitions.publish]\nbase = "merge"\n');
    daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
    await until(() => daemon.bus.peers.get("claude")?.state === "idle", 3000);
    await until(() => changes.length > 0, 300);
    const after = (await client.listTools()).tools;
    expect(after.map(tool => tool.name).sort()).toEqual(before.map(tool => tool.name).sort());
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  } finally { await client.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("retained Claude standby takes over on a person request and the old MCP reports the takeover cause", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-takeover-")));
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const owner = await channelSession(dir);
  let standby: Awaited<ReturnType<typeof channelSession>> | undefined;
  let console_: ControlClient | undefined;
  try {
    await owner.client.listTools(); // Consume the fake MCP initialized/tool-list read barrier before checking daemon attachment.
    await until(() => daemon.bus.peers.get("claude")?.state === "idle");
    standby = await channelSession(dir);
    await standby.client.listTools(); // The retained welcome is handled before this fake host can call any peer tool.
    await until(() => {
      const peer = daemon.bus.peers.get("claude") as any;
      return peer?.standbySessions?.length === 1;
    });
    console_ = await ControlClient.connect(dir, { role: "console" });
    const status = await console_.request({ t: "status" });
    const standbyId = status.status.peers.claude.standbySessions[0].id;
    const held = await standby.client.callTool({ name: "hub_inbox", arguments: {} });
    expect(toolText(held)).toContain("standing by");

    const requested = await console_.request({ t: "peer_takeover", peer: "claude", standbyId });
    expect(requested).toMatchObject({ ok: true, outcome: "requested", standbyId });
    await until(() => daemon.bus.peers.get("claude")?.state === "idle");
    const old = await owner.client.callTool({ name: "hub_inbox", arguments: {} });
    expect(old.isError).toBe(true);
    expect(toolText(old)).toContain("detached by the person");
    const current = await standby.client.callTool({ name: "hub_inbox", arguments: {} });
    expect(toolText(current)).not.toContain("standing by");
  } finally {
    await console_?.close();
    await owner.client.close();
    await standby?.client.close();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
