import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class Reader extends BasePeer {
  readonly delivered: string[] = [];
  constructor() { super("claude"); }
  async deliver(envs: Parameters<BasePeer["deliver"]>[0]) { this.delivered.push(...envs.map(e => e.id)); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

function fixture(durable = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-held-publish-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  const journal = durable ? open() : undefined;
  const bus = new Bus({ batchMs: 0, ...(journal ? { journal } : {}) });
  cleanup.push(() => bus.closeJournal());
  bus.add(new Reader()); bus.pause("claude");
  return { bus, open };
}

test("#478 hub notices leave carried queues exact while held and flush FIFO only once", () => {
  const { bus } = fixture();
  const carried = newEnvelope("user", "carried", { to: ["claude"] });
  bus.publish(carried);
  const expected = bus.snapshot().queues;
  bus.setRecoveryHold(true, true);
  const first = newEnvelope(HUB, "backlog", { to: ["claude"], kind: "task" });
  const second = newEnvelope(HUB, "later", { to: ["claude"], kind: "review", priority: "important" });
  expect(bus.publish(first)).toEqual(["claude"]);
  bus.publish(first); bus.publish(second);
  expect(bus.snapshot().queues).toEqual(expected);
  bus.setRecoveryHold(false);
  expect(bus.queueIds("claude")).toEqual([carried.id, first.id, second.id]);
  bus.setRecoveryHold(false);
  expect(bus.queueIds("claude")).toEqual([carried.id, first.id, second.id]);
});

test("#478 held notice survives durable reopen and can be withdrawn before release", () => {
  const { bus, open } = fixture(true);
  bus.setRecoveryHold(true, true);
  const notice = newEnvelope(HUB, "survives", { to: ["claude"], kind: "task" });
  const withdrawn = newEnvelope(HUB, "withdrawn", { to: ["claude"], kind: "task" });
  bus.publish(notice); bus.publish(withdrawn);
  expect(bus.queueIds("claude")).toEqual([]);
  bus.withdraw(withdrawn.id); bus.closeJournal();
  const reopened = new Bus({ journal: open(), batchMs: 0 });
  cleanup.push(() => reopened.closeJournal());
  reopened.setRecoveryHold(true, true); reopened.add(new Reader()); reopened.pause("claude");
  expect(reopened.queueIds("claude")).toEqual([]);
  reopened.setRecoveryHold(false);
  expect(reopened.queueIds("claude")).toEqual([notice.id]);
});

test("#478 recovery hold does not hide new peer envelopes from exact queue verification", () => {
  const { bus } = fixture();
  bus.setRecoveryHold(true, true);
  const before = bus.snapshot().queues;
  const message = newEnvelope("user", "new peer work", { to: ["claude"] });
  bus.publish(message);
  expect(bus.snapshot().queues).not.toEqual(before);
  expect(bus.queueIds("claude")).toEqual([message.id]);
});

test("#478 crash after a flush checkpoint preserves the remaining FIFO without replay", () => {
  const { bus, open } = fixture(true);
  bus.setRecoveryHold(true, true);
  const first = newEnvelope(HUB, "first", { to: ["claude"], kind: "task" });
  const second = newEnvelope(HUB, "second", { to: ["claude"], kind: "review", private: true });
  bus.publish(first); bus.publish(second);
  bus.tap(event => { if (event.t === "envelope" && event.env.id === first.id) throw new Error("simulated crash after checkpoint"); });
  expect(() => bus.setRecoveryHold(false)).toThrow("simulated crash");
  expect(bus.isRecoveryHeld).toBe(true);
  bus.closeJournal();
  const reopened = new Bus({ journal: open(), batchMs: 0 }); cleanup.push(() => reopened.closeJournal());
  reopened.add(new Reader()); reopened.pause("claude");
  expect(reopened.isRecoveryHeld).toBe(true);
  expect(reopened.queueIds("claude")).toEqual([first.id]);
  reopened.setRecoveryHold(false);
  expect(reopened.queueIds("claude")).toEqual([first.id, second.id]);
  expect(reopened.snapshot().queues.claude![1]!.private).toBe(true);
});

test("#478 an older target receives held notices in the carried queues before commit", () => {
  const { bus } = fixture(); bus.setRecoveryHold(true, true);
  const before = newEnvelope(HUB, "before capability decision", { to: ["claude"], kind: "task" });
  bus.publish(before);
  expect(bus.queueIds("claude")).toEqual([]);
  bus.setRecoveryHold(true, false);
  const after = newEnvelope(HUB, "after capability decision", { to: ["claude"], kind: "review" });
  bus.publish(after);
  expect(bus.queueIds("claude")).toEqual([before.id, after.id]);
  expect(bus.snapshot().deferredHub).toBeUndefined();
});

test("#478 release checkpoint failure retains the hold and its exact deferred originals", () => {
  const { bus } = fixture(true); bus.setRecoveryHold(true, true);
  const notice = newEnvelope(HUB, "pending", { to: ["claude"], kind: "task" }); bus.publish(notice);
  const journal = (bus as unknown as { journal: DeliveryJournal }).journal;
  const persist = journal.persistBus;
  journal.persistBus = () => { throw new Error("disk unavailable"); };
  expect(() => bus.setRecoveryHold(false)).toThrow("recovery remains held");
  expect(bus.isRecoveryHeld).toBe(true);
  expect(bus.queueIds("claude")).toEqual([]);
  expect(bus.snapshot().deferredHub).toEqual([notice]);
  journal.persistBus = persist;
  bus.setRecoveryHold(false);
  expect(bus.queueIds("claude")).toEqual([notice.id]);
});

test("#478 overflow refuses admission and keeps accepted originals under the hold", () => {
  const { bus } = fixture(); bus.setRecoveryHold(true, true);
  for (let n = 0; n < 2048; n++) bus.publish(newEnvelope(HUB, String(n), { to: ["claude"], kind: "task" }));
  expect(() => bus.publish(newEnvelope(HUB, "overflow", { to: ["claude"], kind: "task" }))).toThrow("limit reached");
  expect(bus.isRecoveryHeld).toBe(true); expect(bus.queueIds("claude")).toEqual([]);
  expect(bus.snapshot().deferredHub).toHaveLength(2048);
});

test("#478 deferred backlog retention and supervision revocation cover unpublished originals", () => {
  const { bus } = fixture(); bus.setRecoveryHold(true, true);
  const backlog = newEnvelope(HUB, "backlog", { to: ["claude"], kind: "task", refs: { backlog: [17] } });
  const feed = newEnvelope(HUB, "feed", { to: ["claude"], refs: { supervision: true, supervisionKey: "k" } });
  bus.publish(backlog); bus.publish(feed);
  expect([...bus.queuedBacklogIds("claude")]).toEqual([17]);
  expect(bus.revokeSupervision("claude")).toBe(1);
  bus.withdraw(backlog.id);
  expect(bus.pendingEnvelopes("claude")).toEqual([]);
  bus.setRecoveryHold(false); expect(bus.queueIds("claude")).toEqual([]);
});

test("#478 an online peer receives a deferred notice only after recovery release", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new Reader();
  cleanup.push(() => bus.closeJournal());
  bus.add(peer); await peer.start(); bus.setRecoveryHold(true, true);
  const notice = newEnvelope(HUB, "after release", { to: ["claude"], kind: "task" });
  bus.publish(notice); await Bun.sleep(0);
  expect(peer.delivered).toEqual([]);
  bus.setRecoveryHold(false); await Bun.sleep(0);
  expect(peer.delivered).toEqual([notice.id]);
});

test("#478 reentrant publication joins the FIFO tail even while materializing for an older target", () => {
  const { bus } = fixture(); bus.setRecoveryHold(true, true);
  const first = newEnvelope(HUB, "first", { to: ["claude"] });
  const second = newEnvelope(HUB, "second", { to: ["claude"] });
  const nested = newEnvelope(HUB, "nested", { to: ["claude"] });
  bus.publish(first); bus.publish(second);
  bus.tap(event => { if (event.t === "envelope" && event.env.id === first.id) bus.publish(nested); });
  bus.setRecoveryHold(true, false);
  expect(bus.queueIds("claude")).toEqual([first.id, second.id, nested.id]);
  expect(bus.isRecoveryHeld).toBe(true);
});

test("#478 a failed old-target materialization preserves its non-deferred hold mode", () => {
  const { bus } = fixture(true); bus.setRecoveryHold(true, true);
  const pending = newEnvelope(HUB, "pending before downgrade", { to: ["claude"] }); bus.publish(pending);
  const journal = (bus as unknown as { journal: DeliveryJournal }).journal;
  const persist = journal.persistBus;
  journal.persistBus = () => { throw new Error("storage blip"); };
  expect(() => bus.setRecoveryHold(true, false)).toThrow("recovery remains held");
  journal.persistBus = persist;
  bus.setManualPaused([]); // Clear only the recovered storage error, not the hold or its mode.
  const later = newEnvelope(HUB, "later older-target notice", { to: ["claude"] }); bus.publish(later);
  expect(bus.queueIds("claude")).toEqual([later.id]);
  expect(bus.snapshot().deferredHub).toEqual([pending]);
  expect(bus.isPaused("claude")).toBe(true);
});
