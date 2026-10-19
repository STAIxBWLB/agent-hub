import { expect, test } from "bun:test";
import { Bus } from "../src/hub/bus.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class OfflinePeer extends BasePeer {
  async deliver(_envs: Envelope[]): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

test("a bare recovery fence after releasing deferred hub notices does not defer them again (#192)", async () => {
  const bus = new Bus({ batchMs: 0 });
  const peer = new OfflinePeer("codex");
  bus.add(peer);

  bus.setRecoveryHold(true, true);
  const duringRecovery = newEnvelope(HUB, "recovered", { to: [peer.id] });
  bus.publish(duringRecovery);
  expect(bus.snapshot().deferredHub?.map(env => env.id)).toEqual([duringRecovery.id]);

  bus.setRecoveryHold(false);
  const afterFence = newEnvelope(HUB, "after fence", { to: [peer.id] });
  await bus.fenceRecovery();
  bus.publish(afterFence);

  expect(bus.queueIds(peer.id)).toContain(afterFence.id);
  expect(bus.snapshot().deferredHub).toBeUndefined();
  bus.closeJournal();
});
