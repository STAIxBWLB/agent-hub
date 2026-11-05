import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";

class RefusingPeer extends BasePeer {
  handed?: string;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[], id?: string) {
    this.setState("busy"); this.handed = id;
    if (id) this.onDelivery?.({ id, state: "failed_safe", reason: "native error text is not a cause" });
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("real queue JSON and status expose fixed cause and unresolved count, then discard clears count without leaking a private body (#1178)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-failure-daemon-")), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  const peer = new RefusingPeer("codex");
  try {
    await peer.start(); daemon.bus.add(peer);
    const canary = "PRIVATE_BODY_CANARY_714";
    daemon.bus.publish(newEnvelope("user", canary, { private: true, to: [peer.id] }));
    await until(() => !!peer.handed && daemon.bus.queueShow(peer.handed)?.state === "failed");
    const list = await person.request({ t: "queue", op: "list" });
    expect(list.deliveries.find((row: { id: string }) => row.id === peer.handed).failureCause).toBe("adapter refused");
    const show = await person.request({ t: "queue", op: "show", id: peer.handed });
    expect(show.delivery.failureCause).toBe("adapter refused");
    expect(JSON.stringify(show)).not.toContain(canary);
    const before = await person.request({ t: "status" });
    expect(before.deliveryFailures).toEqual({ codex: 1 });
    expect(JSON.stringify(before)).not.toContain(canary);
    const resolved = await person.request({ t: "queue", op: "resolve", id: peer.handed, revision: show.delivery.revision, action: "discard", reason: "person inspected" });
    expect(resolved.ok).toBe(true);
    expect((await person.request({ t: "status" })).deliveryFailures).toEqual({});
    const history = await person.request({ t: "queue", op: "show", id: peer.handed });
    expect(history.delivery.failureCause).toBe("adapter refused");
    expect(history.delivery.resolvedBy).toBe("discard");
  } finally { person.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});
