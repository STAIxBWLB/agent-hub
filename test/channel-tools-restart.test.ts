import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";

const config = { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } };
async function until(check: () => boolean, tries = 400) {
  for (let i = 0; i < tries && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("a Claude channel session lists the same hub tools after a hub restart as before it (#490)", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-restart-")));
  let daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENTHUB_") && k !== "CLAUDECODE" && k !== "CLAUDE_CODE_SESSION_ID") env[k] = v;
  Object.assign(env, { HOME: dir, AGENTHUB_HOME: join(dir, "hub-home"), AMEM_HOME: join(dir, "memory-home"), CLAUDE_CONFIG_DIR: join(dir, "claude-home"),
    AGENTHUB_STATE_DIR: dir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: "claude", AGENTHUB_CHANNEL: "1" });
  const client = new Client({ name: "fixture-claude", version: "1" });
  const changes: string[] = [];
  client.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema, async () => { changes.push("list_changed"); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], env, cwd: dir, stderr: "ignore" }));
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
