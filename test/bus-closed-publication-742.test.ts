import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, type PublishResult } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class Recipient extends BasePeer {
  readonly remoteRoom?: string;
  readonly remoteMember?: string;
  deliveries: Envelope[][] = [];
  constructor(remote: boolean) {
    super(remote ? "codex@hub-a" : "local");
    if (remote) { this.remoteRoom = "room-a"; this.remoteMember = "a".repeat(64); }
  }
  async deliver(envs: Envelope[]) { this.deliveries.push(envs); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

for (const remote of [false, true]) test(`closed bus publication has no effects for ${remote ? "remote" : "local"} recipients (#742)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-closed-publication-"));
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "closed", instanceId: "fixture" });
  const effects: string[] = [];
  const bus = new Bus({
    journal, batchMs: 0,
    reviewObserverScope: () => { effects.push("provenance"); return "review-canary"; },
    remotePrivate: () => { effects.push("privacy"); return true; },
    remotePending: () => { effects.push("outbox"); return []; },
    onDeliver: () => { effects.push("handoff"); },
  });
  const peer = new Recipient(remote);
  bus.add(peer);
  await peer.start();
  bus.tap(() => effects.push("tap"));
  bus.onQueues = () => effects.push("queues");
  bus.onMemoryDelivery = () => { effects.push("memory"); };
  bus.closeJournal();
  // Verify this fixture really exercises a closed journal, not a missing journal.
  expect(() => journal.pendingPeers()).toThrow("delivery journal is closed");
  const pending = spyOn(journal, "pendingPeers"), list = spyOn(journal, "list"), persist = spyOn(journal, "persistBus");
  effects.length = 0;
  const beforeQueue = bus.queueIds(peer.id);
  const envelopes = ["result-canary", "wrapper-canary", "deferred-canary"].map(body => newEnvelope("user", body, { to: [peer.id] }));
  try {
    expect(bus.publishResult(envelopes[0]!)).toEqual({ targets: [] });
    expect(bus.publish(envelopes[1]!)).toEqual([]);
    // Deferred replay bypasses publishResult; fence that internal entry independently.
    const replay = bus as unknown as { publishNow(env: Envelope): PublishResult };
    expect(replay.publishNow(envelopes[2]!)).toEqual({ targets: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(pending).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    expect(peer.deliveries).toEqual([]);
    expect(bus.queueIds(peer.id)).toEqual(beforeQueue);
    for (const env of envelopes) {
      expect(bus.get(env.id)).toBeUndefined();
      expect(env.private).toBeUndefined();
    }
  } finally {
    pending.mockRestore(); list.mockRestore(); persist.mockRestore();
    await peer.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("an open bus still exposes live journal failures before publication (#742)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-open-publication-"));
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "open", instanceId: "fixture" });
  const bus = new Bus({ journal }), peer = new Recipient(true), effects: string[] = [];
  bus.add(peer); bus.tap(() => effects.push("tap"));
  const env = newEnvelope("user", "live-failure-canary", { to: [peer.id] });
  // A storage failure while the bus is open must not become a successful empty send.
  const pending = spyOn(journal, "pendingPeers").mockImplementation(() => { throw new Error("live journal canary"); });
  try {
    expect(() => bus.publishResult(env)).toThrow("live journal canary");
    expect(bus.get(env.id)).toBeUndefined(); expect(bus.queueIds(peer.id)).toEqual([]); expect(effects).toEqual([]);
  } finally { pending.mockRestore(); bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
});
