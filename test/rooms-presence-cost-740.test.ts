import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";

const roots: string[] = [], buses: Bus[] = [];
afterEach(() => { for (const bus of buses.splice(0)) bus.closeJournal(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function opened(root = mkdtempSync(join(tmpdir(), "ahub-presence-cost-"))) {
  if (!roots.includes(root)) roots.push(root);
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "presence", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal, batchMs: 0 }); buses.push(bus);
  return { root, journal, bus };
}

test("transient presence pause and resume do not rewrite an unchanged journal snapshot", () => {
  const { journal, bus } = opened(), before = journal.revision(), states: string[] = [];
  bus.tap(event => { if (event.t === "state") states.push(event.state); });
  for (let n = 0; n < 1000; n++) {
    if (n % 2 === 0) bus.pause("codex"); else bus.resume("codex");
    expect(bus.isPaused("codex")).toBe(n % 2 === 0);
  }
  expect(states).toHaveLength(1000);
  expect(journal.revision()).toBe(before);
  expect(bus.snapshot(false).manualPaused).toEqual([]);
});

test("an explicit manual pause still persists and survives a journal reopen", () => {
  const first = opened(), before = first.journal.revision();
  first.bus.setManualPaused(["codex"]); first.bus.pause("codex");
  expect(first.journal.revision()).toBeGreaterThan(before);
  first.bus.closeJournal();
  const restored = opened(first.root);
  expect(restored.bus.manualPausedPeers()).toEqual(["codex"]);
  expect(restored.bus.isPaused("codex")).toBe(true);
  restored.bus.setManualPaused([]); const released = restored.journal.revision(); restored.bus.resume("codex");
  expect(restored.journal.revision()).toBe(released);
  restored.bus.closeJournal();
  expect(opened(first.root).bus.manualPausedPeers()).toEqual([]);
});

test("resume still persists the queued delivery it actually drains", async () => {
  const first = opened(); let complete!: () => void; let deliveredId = "";
  const completed = new Promise<void>(resolve => { complete = resolve; });
  class Peer extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver(envs: Envelope[], id?: string) {
      deliveredId = id!;
      expect(first.journal.get(id!)?.state).toBe("dispatching");
      expect(first.journal.get(id!)?.originals.map(env => env.id)).toEqual(envs.map(env => env.id));
      this.delivery({ id: id!, state: "completed" }); complete();
    }
  }
  const peer = new Peer("codex"); first.bus.add(peer); await peer.start(); first.bus.pause(peer.id);
  const env = newEnvelope("user", "queued while paused", { to: [peer.id] }); first.bus.publish(env);
  const queued = first.journal.unresolved(peer.id).find(row => row.originals.some(item => item.id === env.id))!;
  expect(queued.state).toBe("queued"); const before = first.journal.revision();
  first.bus.resume(peer.id); await completed;
  expect(first.journal.revision()).toBeGreaterThan(before);
  const row = first.journal.get(deliveredId)!;
  expect(row.state).toBe("completed"); expect(first.bus.queueIds(peer.id)).toEqual([]);
  await peer.stop(); first.bus.closeJournal();
  const restored = opened(first.root);
  expect(restored.journal.get(row.id)?.state).toBe("completed");
  expect(restored.bus.queueIds(peer.id)).toEqual([]);
});
