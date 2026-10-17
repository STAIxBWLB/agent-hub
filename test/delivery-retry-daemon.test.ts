import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { TASK_TOOLS, TASK_TOOL_NAMES } from "../src/hub/hub-tools.ts";

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-retry-tool-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "retry-tool", instanceId: "old" });
  const env = newEnvelope("user", "PRIVATE BODY 900101-1234567", { private: true });
  journal.createDelivery({ id: "own-held", peer: "codex", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  journal.createDelivery({ id: "other-held", peer: "pi", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  journal.close();
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, projectId: "retry-tool", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  const peer = await ControlClient.connect(dir, { role: "tools", peer: "codex" });
  return { dir, daemon, peer, close: async () => { await peer.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("AC5 shared retry tool has only delivery_id and server rejects foreign rows/action injection without effects", async () => {
  const definition = TASK_TOOLS.find(tool => tool.name === "hub_delivery_retry");
  expect(definition).toBeDefined(); expect(TASK_TOOL_NAMES.has("hub_delivery_retry")).toBe(true);
  expect(Object.keys(definition!.inputSchema.properties)).toEqual(["delivery_id"]);
  const f = await rig();
  try {
    const run = (args: object) => f.peer.request({ t: "task", op: "hub_delivery_retry", args });
    expect((await run({ delivery_id: "other-held" })).ok).toBe(false);
    for (const action of ["completed", "discard"]) {
      expect((await run({ delivery_id: "own-held", action })).ok).toBe(false);
      expect(f.daemon.bus.queueShow("own-held")?.state).toBe("needs_review");
    }
    const result = await run({ delivery_id: "own-held" });
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
    expect(f.daemon.bus.queued("codex")).toBe(1);
    expect(f.daemon.bus.queueShow("other-held")?.state).toBe("needs_review");
    expect((await run({ delivery_id: "own-held" })).ok).toBe(false);
  } finally { await f.close(); }
});

test("own held-delivery discovery returns bounded ids/senders/kinds/age source and never another peer/body", async () => {
  const f = await rig();
  try {
    const result = await f.peer.request({ t: "delivery_holds" });
    expect(result.ok).toBe(true); expect(result.held.count).toBe(1);
    expect(result.held.rows[0]).toMatchObject({ id: "own-held", senders: ["user"], kinds: ["chat"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE BODY"); expect(JSON.stringify(result)).not.toContain("900101");
    expect(JSON.stringify(result)).not.toContain("other-held");
  } finally { await f.close(); }
});

test("held hint metadata is bounded and explicitly reports omitted ids without private bodies", async () => {
  const f = await rig();
  const journal = new DeliveryJournal({ file: join(f.dir, "hub.db"), projectRoot: f.dir, projectId: "retry-tool", instanceId: (await f.peer.request({ t: "status" })).status.instanceId });
  try {
    journal.transaction(() => { for (let i = 0; i < 40; i++) {
      const env = newEnvelope("user", "EXTRA PRIVATE BODY", { private: true });
      journal.createDelivery({ id: `held-${i}`, peer: "codex", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    } });
    const result = await f.peer.request({ t: "delivery_holds" });
    expect(result.held.count).toBe(41); expect(result.held.rows.length).toBeLessThanOrEqual(32); expect(result.held.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  } finally { journal.close(); await f.close(); }
});
