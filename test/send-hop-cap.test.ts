import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { MAX_HOP, newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";

const hopNotice = `not delivered: reply chain reached the hop cap (${MAX_HOP}); send a new message without reply_to`;
const output = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");

async function rig() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-hop-cap-")));   // the plugin compares resolved paths (#604 item 10)
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  const claude = await ControlClient.connect(dir, { role: "peer", peer: "claude", channel: false });
  const kimi = await ControlClient.connect(dir, { role: "peer", peer: "kimi", channel: false });
  const client = new Client({ name: "hop-cap-fixture", version: "0" }, { capabilities: {} });
  const env: Record<string, string> = { ...process.env as Record<string, string>, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_STATE_DIR: dir,
    AGENTHUB_PEER_ID: "claude", AGENTHUB_MODE: "tools" };
  delete env.AGENTHUB_CHANNEL; delete env.AGENTHUB_DELIVERY_ONLY;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], cwd: dir, env, stderr: "pipe" });
  let diagnostic = "";
  transport.stderr!.on("data", chunk => { diagnostic += chunk.toString(); });
  const close = async () => { await client.close(); claude.close(); kimi.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); };
  try {
    await client.connect(transport);
    for (let i = 0; i < 200 && !diagnostic.includes('connected to hub as "claude"'); i++) await Bun.sleep(5);
    expect(diagnostic).toContain('connected to hub as "claude"');
    // Register a real retained reply chain, ending with kimi at the last allowed hop.
    let parent = newEnvelope(MAX_HOP % 2 ? "claude" : "kimi", "chain root");
    daemon.bus.publish(parent);
    for (let hop = 1; hop <= MAX_HOP; hop++) {
      parent = newEnvelope(parent.from === "claude" ? "kimi" : "claude", `chain ${hop}`, { inReplyTo: parent });
      daemon.bus.publish(parent);
    }
    expect(parent.from).toBe("kimi"); expect(parent.hop).toBe(MAX_HOP);
    expect(daemon.bus.get(parent.id)?.hop).toBe(MAX_HOP);
    return { daemon, claude, parent, client, close };
  } catch (error) { await close(); throw error; }
}

test("daemon send distinguishes a hop-capped reply from no audience (#542)", async () => {
  const f = await rig();
  try {
    const queued = f.daemon.bus.queueIds("kimi");
    const result = await f.claude.request({ t: "send", body: "past the cap", reply_to: f.parent.id });
    expect(result).toMatchObject({ ok: true, targets: [], dropped: "hop", notice: hopNotice });
    expect(f.daemon.bus.queueIds("kimi")).toEqual(queued);
    expect(f.daemon.bus.peers.get("kimi")?.state).not.toBe("offline");
  } finally { await f.close(); }
});

test("Claude MCP send reports the cap and permits a new chain (#542)", async () => {
  const f = await rig();
  try {
    const result = output(await f.client.callTool({ name: "hub_send", arguments: { text: "past the cap", reply_to: f.parent.id } }));
    expect(result).toBe(hopNotice);
    expect(result).not.toContain("no other peers attached");
    expect(output(await f.client.callTool({ name: "hub_send", arguments: { text: "new chain", to: ["kimi"] } }))).toBe("sent to: kimi");
  } finally { await f.close(); }
});

test("Claude MCP send preserves true empty-audience and FYI output (#542)", async () => {
  const f = await rig();
  try {
    expect(output(await f.client.callTool({ name: "hub_send", arguments: { text: "no audience", to: ["claude"] } }))).toBe("sent to: (no other peers attached)");
    const queued = f.daemon.bus.queueIds("kimi");
    expect(output(await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] record only", to: ["kimi"] } })))
      .toBe("recorded only ([FYI]): it is on the hub console and log, and no peer spent a turn on it");
    expect(output(await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] record at cap", reply_to: f.parent.id } })))
      .toBe("recorded only ([FYI]): it is on the hub console and log, and no peer spent a turn on it");
    expect(f.daemon.bus.queueIds("kimi")).toEqual(queued);
  } finally { await f.close(); }
});
