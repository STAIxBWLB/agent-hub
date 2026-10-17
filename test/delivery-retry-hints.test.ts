import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { renderHeldHint } from "../src/hub/delivery-hints.ts";

async function rig(peer: string, mode: "channel" | "pull" | "tools", deliveryOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-retry-hints-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "hint", instanceId: "old" });
  const env = newEnvelope("user", "DO NOT EXPOSE PRIVATE CONTENT", { private: true });
  journal.createDelivery({ id: "my-private-held", peer, state: "needs_review", createdAt: env.ts, originals: [env], out: [env] }); journal.close();
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, projectId: "hint", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  const client = new Client({ name: "retry-hint-fixture", version: "0" }, { capabilities: {} });
  const envs: Record<string, string> = { ...process.env as Record<string, string>, AGENTHUB_STATE_DIR: dir, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: peer, AGENTHUB_MODE: mode === "tools" ? "tools" : "", AGENTHUB_CHANNEL: mode === "channel" ? "1" : "", AGENTHUB_DELIVERY_ONLY: deliveryOnly ? "true" : "" };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], env: envs, stderr: "pipe" });
  let diagnostics = ""; transport.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  await client.connect(transport);
  for (let i = 0; i < 100 && !diagnostics.includes(`connected to hub as "${peer}"`); i++) await Bun.sleep(5);
  expect(diagnostics).toContain(`connected to hub as "${peer}"`);
  return { daemon, client, close: async () => { await client.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
for (const mode of ["channel", "pull", "tools"] as const) {
  test(`actual ${mode} MCP tool results expose own held ids regardless important enqueue, with no body`, async () => {
    const f = await rig(mode === "tools" ? "codex" : "claude", mode);
    try {
      const result = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] hint smoke" } }) as any;
      expect(result.content[0].text).toStartWith("recorded only");
      expect(result.content[1].text).toContain("my-private-held"); expect(result.content[1].text).toContain("from user kind chat age");
      expect(JSON.stringify(result)).not.toContain("DO NOT EXPOSE PRIVATE CONTENT");
      const tools = await f.client.listTools(); expect(tools.tools.some(tool => tool.name === "hub_delivery_retry")).toBe(true);
    } finally { await f.close(); }
  });
}

test("delivery-only MCP sessions hide retry and ask the person while pull-only Kimi keeps recipient retry (#434)", async () => {
  for (const deliveryOnly of [true, false]) {
    const f = await rig("kimi", deliveryOnly ? "tools" : "pull", deliveryOnly);
    try {
      const tools = await f.client.listTools();
      expect(tools.tools.some(tool => tool.name === "hub_delivery_retry")).toBe(!deliveryOnly);
      const result = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] delivery mode hint" } }) as any;
      expect(result.content[1].text).toContain("my-private-held");
      expect(result.content[1].text).toContain(deliveryOnly ? "Ask the person to resolve" : "Use hub_delivery_retry");
      expect(JSON.stringify(result)).not.toContain("DO NOT EXPOSE PRIVATE CONTENT");
    } finally { await f.close(); }
  }
});

test("a new ordinary held row is visible on the next tools-mode result without an important enqueue", async () => {
  const f = await rig("codex", "tools");
  class Uncertain extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver(_envs: Envelope[], id?: string) { if (id) this.delivery({ id, state: "needs_review" }); }
  }
  try {
    const row = f.daemon.bus.queueShow("my-private-held")!; f.daemon.bus.resolveDelivery(row.id, row.revision, "completed", "fixture handled");
    const first = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] before hold" } }) as any; expect(first.content).toHaveLength(1);
    const peer = new Uncertain("codex"); f.daemon.bus.add(peer); await peer.start();
    f.daemon.bus.publish(newEnvelope("user", "UNSEEN PRIVATE BODY", { to: ["codex"], private: true }));
    for (let i = 0; i < 100 && !f.daemon.bus.queueList("codex").some(item => item.state === "needs_review"); i++) await Bun.sleep(1);
    const held = f.daemon.bus.queueList("codex").find(item => item.state === "needs_review")!; expect(held).toBeDefined();
    const next = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] after hold" } }) as any;
    expect(next.content[1].text).toContain(held.id); expect(JSON.stringify(next)).not.toContain("UNSEEN PRIVATE BODY");
  } finally { await f.close(); }
});

test("malformed or unavailable advisory held metadata cannot turn a successful MCP effect into an error", async () => {
  const f = await rig("codex", "tools");
  try {
    f.daemon.bus.heldDeliveryHints = () => ({ count: 1, rows: null, truncated: false }) as any;
    const first = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] malformed metadata effect" } }) as any;
    expect(first.content[0].text).toStartWith("recorded only"); expect(first.content).toHaveLength(1);
    f.daemon.bus.heldDeliveryHints = () => { throw new Error("metadata unavailable"); };
    const second = await f.client.callTool({ name: "hub_send", arguments: { text: "[FYI] unavailable metadata effect" } }) as any;
    expect(second.content[0].text).toStartWith("recorded only"); expect(second.content).toHaveLength(1);
  } finally { await f.close(); }
});

test("hint renderer rejects malformed payloads", () => {
  for (const value of [null, {}, { count: 1, rows: null }, { count: 1, rows: [{ id: "x", senders: [7], kinds: ["chat"], createdAt: 0 }], truncated: false }]) expect(renderHeldHint(value)).toBe("");

});

test("actual in-process local task callback carries person-resolution hints and refuses recipient retry before effects", async () => {
  const { ControlClient } = await import("../src/hub/control-client.ts");
  const { startFakeModelServer } = await import("./fakes/model-server.ts");
  const { PreEffectToolRefusal } = await import("../src/hub/tool-refusal.ts");
  const dir = mkdtempSync(join(tmpdir(), "ahub-native-retry-hint-"));
  const previousKey = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "sk-retry-fixture";
  const model = startFakeModelServer({ key: "sk-retry-fixture", models: ["m"] });
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "native-hint", instanceId: "old" });
  const env = newEnvelope("user", "NATIVE PRIVATE BODY", { private: true });
  journal.createDelivery({ id: "native-held", peer: "local", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] }); journal.close();
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, projectId: "native-hint", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, omniroute: { urls: [model.url], access_hosts: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  const console_ = await ControlClient.connect(dir, { role: "console" });
  try {
    const started = await console_.request({ t: "start", peer: "local", args: { model: "m" } }); expect(started.ok).toBe(true);
    const peer = daemon.bus.peers.get("local") as any;
    const taskTool = peer.opts.taskTool;
    const result = await taskTool("hub_task_list", {}, { pii: false });
    expect(result).toContain("native-held"); expect(result).not.toContain("NATIVE PRIVATE BODY");
    let refusal: unknown;
    try { await taskTool("hub_delivery_retry", { delivery_id: "not-my-row" }, { pii: false }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(PreEffectToolRefusal);
    expect((refusal as Error).message).toContain("native-held"); expect((refusal as Error).message).not.toContain("NATIVE PRIVATE BODY");
    peer.setState("busy");
    await expect(taskTool("hub_delivery_retry", { delivery_id: "native-held" }, { pii: false })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(result).toContain("Ask the person to resolve");
    expect(daemon.bus.queueShow("native-held")?.state).toBe("needs_review");
    expect(daemon.bus.queued("local")).toBe(0); expect(daemon.bus.stateOf("local")).toBe("busy");
    expect(model.requests).toHaveLength(0);
  } finally {
    await console_.close(); await daemon.stop(); model.stop(); rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previousKey;
  }
});

test("actual pull-mode MCP recipient retry hands back the original once with the fixed warning", async () => {
  const f = await rig("claude", "pull");
  try {
    const retried = await f.client.callTool({ name: "hub_delivery_retry", arguments: { delivery_id: "my-private-held" } }) as any;
    expect(retried.content[0].text).toStartWith("retry queued");
    expect(JSON.stringify(retried)).not.toContain("DO NOT EXPOSE PRIVATE CONTENT");
    const inbox = await f.client.callTool({ name: "hub_inbox", arguments: {} }) as any;
    expect(inbox.content[0].text).toContain("Hub redelivery warning:");
    expect(inbox.content[0].text).toContain("DO NOT EXPOSE PRIVATE CONTENT"); // only the addressed recipient's deliberate redelivery
    const repeated = await f.client.callTool({ name: "hub_delivery_retry", arguments: { delivery_id: "my-private-held" } }) as any;
    expect(repeated.content[0].text).toStartWith("error:");
  } finally { await f.close(); }
});
