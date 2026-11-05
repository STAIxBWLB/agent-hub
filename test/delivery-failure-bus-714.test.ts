import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  readonly acceptedSettlement = "explicit" as const;
  handed?: string;
  receive?: (envs: Envelope[], id: string) => void;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
  async deliver(envs: Envelope[], id?: string) {
    if (!id) throw new Error("missing delivery id");
    this.handed = id;
    this.setState("busy");
    this.receive?.(envs, id);
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}
for (const scenario of ["adapter refused", "push error", "turn aborted", "peer offline", "timeout"] as const) {
  test(`delivery cause follows ${scenario} lifecycle evidence without classifying native text (#1178)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ahub-failure-bus-"));
    const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "p", instanceId: "i" });
    const bus = new Bus({ journal, batchMs: 0, maxAttempts: () => 1, acceptedSettleMs: () => 1000 });
    const peer = new Peer("codex");
    const canary = "BODY_NATIVE_ERROR_CANARY_714";
    try {
      await peer.start(); bus.add(peer);
      peer.receive = (envs, id) => {
        if (scenario === "adapter refused") peer.onDelivery?.({ id, state: "failed_safe", reason: canary });
        else if (scenario === "push error") throw new Error(canary);
        else if (scenario === "turn aborted") peer.onFailed?.(envs);
        else if (scenario === "peer offline") peer.set("offline");
        else peer.onDelivery?.({ id, state: "accepted" });
      };
      bus.publish(newEnvelope("user", canary, { private: true, to: [peer.id] }));
      await until(() => !!peer.handed && journal.get(peer.handed)?.state !== "dispatching");
      if (scenario === "timeout") {
        const row = journal.get(peer.handed!)!;
        expect(bus.expireAcceptedDeliveries(row.updatedAt + 1000)).toHaveLength(1);
      }
      const row = journal.get(peer.handed!)!;
      expect(row.failureCause).toBe(scenario);
      expect(row.state).toBe(scenario === "adapter refused" ? "failed" : "needs_review");
      expect(JSON.stringify({ failureCause: row.failureCause, counts: bus.failedDeliveryCounts() })).not.toContain(canary);
      expect(bus.failedDeliveryCounts()).toEqual(scenario === "adapter refused" ? { codex: 1 } : {});
      expect(bus.queueIds(peer.id)).toEqual([]);
    } finally { bus.closeJournal(); await peer.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("queue overflow has a fixed refusal class and failed-count reads never hydrate retained payloads (#1178)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-failure-count-"));
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "p", instanceId: "i" });
  const bus = new Bus({ journal, queueCap: 1 });
  try {
    bus.ensureKnownRecipientQueue("codex");
    bus.publish(newEnvelope("user", "first canary", { to: ["codex"] }));
    bus.publish(newEnvelope("user", "second canary", { to: ["codex"] }));
    expect(journal.list("codex").filter(row => row.state === "failed").map(row => row.failureCause)).toEqual(["adapter refused"]);
    journal.list = () => { throw new Error("status hydrated history"); };
    journal.unresolved = () => { throw new Error("status hydrated pending bodies"); };
    expect(bus.failedDeliveryCounts()).toEqual({ codex: 1 });
    bus.closeJournal();
    expect(bus.failedDeliveryCounts()).toBeUndefined();
  } finally { bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
});
