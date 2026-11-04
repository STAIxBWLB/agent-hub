import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal, ACCEPTED_SETTLE_TIMEOUT_REASON } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { renderHeldHint } from "../src/hub/delivery-hints.ts";

class ChannelPeer extends BasePeer {
  readonly acceptedSettlement = "explicit" as const;
  deliveryCount = 0;
  deliveryIds: string[] = [];
  envelopeIds: string[] = [];
  onPhysicalDelivery?: () => void;
  async deliver(_envs: Envelope[], deliveryId?: string) {
    this.deliveryCount++;
    this.envelopeIds.push(..._envs.map(env => env.id));
    if (deliveryId) {
      this.deliveryIds.push(deliveryId);
      this.setState("busy");
      this.onDelivery?.({ id: deliveryId, state: "accepted" });
    }
    this.onPhysicalDelivery?.();
  }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
}
class OrdinaryPeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-channel-settlement-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "settlement", instanceId: "test" });
  const peer = new ChannelPeer("claude");
  const bus = new Bus({ journal, batchMs: 0, acceptedSettleMs: () => 1_000 });
  bus.add(peer);
  return { dir, journal, peer, bus };
}

test("accepted channel settlement expires once without replay and exposes only bounded metadata", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "private body must not appear", { private: true, kind: "review", priority: "important" });
    journal.createDelivery({ id: "accepted-review", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    const ageBase = journal.get("accepted-review")!.updatedAt;
    const expiry = bus.expireAcceptedDeliveries(ageBase + 1_000);
    expect(expiry).toEqual([{ id: "accepted-review", peer: "claude", revision: 2, notifyConductor: true }]);
    expect(journal.get("accepted-review")).toMatchObject({ state: "needs_review", reason: ACCEPTED_SETTLE_TIMEOUT_REASON, revision: 2 });
    expect(bus.expireAcceptedDeliveries(ageBase + 1_000)).toEqual([]);
    bus.deliveryReceipt(peer.id, { id: "accepted-review", state: "completed" });
    expect(journal.get("accepted-review")?.state).toBe("needs_review");
    const hint = JSON.stringify(bus.heldDeliveryHints(peer.id, true));
    expect(hint).toContain("accepted-review");
    expect(hint).toContain("needs_review");
    expect(hint).not.toContain("private body");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("a thrown queue observer cannot hide the durable timeout metadata", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "private body", { private: true });
    const row = journal.createDelivery({ id: "observer-timeout", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    bus.onQueues = () => { throw new Error("observer failed"); };
    expect(bus.expireAcceptedDeliveries(row.updatedAt + 1_000).map(expiry => expiry.id)).toEqual([row.id]);
    expect(journal.get(row.id)?.state).toBe("needs_review");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("zero-epoch accepted delivery expires only at its exact deadline", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "zero epoch");
    const row = journal.createDelivery({ id: "zero-epoch", peer: peer.id, state: "accepted", createdAt: env.ts, updatedAt: 0, originals: [env], out: [env] });
    expect(row.updatedAt).toBe(0);
    expect(bus.expireAcceptedDeliveries(999)).toEqual([]);
    expect(journal.get(row.id)?.state).toBe("accepted");
    expect(bus.expireAcceptedDeliveries(1_000).map(expiry => expiry.id)).toEqual([row.id]);
    expect(journal.get(row.id)?.state).toBe("needs_review");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeout hold query is false before expiry, true while held, then false after disposition", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    expect(bus.hasAcceptedTimeoutHolds()).toBe(false);
    const env = newEnvelope("user", "timeout hold");
    const row = journal.createDelivery({ id: "timeout-hold-query", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    const expired = bus.expireAcceptedDeliveries(row.updatedAt + 1_000)[0]!;
    expect(bus.hasAcceptedTimeoutHolds()).toBe(true);
    bus.resolveOwnDelivery(peer.id, expired.id, expired.revision, "completed", "inspected result");
    expect(bus.hasAcceptedTimeoutHolds()).toBe(false);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed channel delivery is completed and repeated accepted receipt does not extend its age", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "confirmed");
    const row = journal.createDelivery({ id: "confirmed", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    journal.transition(row.id, "accepted");
    expect(journal.get(row.id)?.revision).toBe(row.revision);
    journal.completeDelivered(row.id, peer.id, "adapter", "confirmed");
    expect(bus.expireAcceptedDeliveries()).toEqual([]);
    expect(journal.get(row.id)?.state).toBe("completed");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("accepted expiry filters eligible channels before its bounded limit and pauses during recovery", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "old acceptance");
    for (let index = 0; index < 257; index++) journal.createDelivery({ id: `ordinary-${index}`, peer: `codex-${index}`, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    journal.createDelivery({ id: "channel-due", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    const ageBase = journal.get("channel-due")!.updatedAt;
    bus.setRecoveryHold(true);
    expect(bus.expireAcceptedDeliveries(ageBase + 1_000)).toEqual([]);
    expect(journal.get("channel-due")?.state).toBe("accepted");
    bus.setRecoveryHold(false);
    expect(bus.expireAcceptedDeliveries(ageBase + 1_000).map(row => row.id)).toEqual(["channel-due"]);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

for (const action of ["completed", "discard"] as const) test(`explicit channel can disposition its accepted delivery as ${action} without read proof`, () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("hub", "offer", { kind: "task", refs: { taskOffer: 1 } });
    const row = journal.createDelivery({ id: `own-${action}`, peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    bus.resolveOwnDelivery(peer.id, row.id, row.revision, action, "I inspected this delivery");
    expect(journal.get(row.id)?.state).toBe(action === "completed" ? "completed" : "discarded");
    expect(journal.offerRead(peer.id, env.id)).toBe(false);
    expect(journal.resolution(row.id)).toMatchObject({ action, actor: `peer:${peer.id}` });
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("real bus delivery stays single after channel completion before timeout", async () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    let delivered!: () => void;
    const firstDelivery = new Promise<void>(resolve => { delivered = resolve; });
    peer.onPhysicalDelivery = delivered;
    await peer.start();
    bus.publish(newEnvelope("user", "one push", { to: [peer.id], priority: "important" }));
    await firstDelivery;
    const id = peer.deliveryIds[0]!;
    const accepted = journal.get(id)!;
    expect(accepted.state).toBe("accepted");
    bus.completeReply(peer.id, peer.envelopeIds[0]!);
    expect(journal.get(id)?.state).toBe("completed");
    expect(bus.completeDelivery(peer.id, id)).toBe(true);
    expect(bus.expireAcceptedDeliveries(accepted.updatedAt + 1_000)).toEqual([]);
    expect(peer.deliveryCount).toBe(1);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("real bus timeout, late confirmation, and idle transition do not replay accepted work", async () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    let delivered!: () => void;
    const firstDelivery = new Promise<void>(resolve => { delivered = resolve; });
    peer.onPhysicalDelivery = delivered;
    await peer.start();
    bus.publish(newEnvelope("user", "one push", { to: [peer.id], priority: "important" }));
    await firstDelivery;
    const id = peer.deliveryIds[0]!;
    const accepted = journal.get(id)!;
    peer.onDelivery?.({ id, state: "accepted" });
    expect(journal.get(id)?.revision).toBe(accepted.revision);
    const queued = newEnvelope("user", "later work", { to: [peer.id], priority: "important" });
    bus.publish(queued);
    bus.onQueues = () => { throw new Error("observer failed"); };
    expect(bus.expireAcceptedDeliveries(accepted.updatedAt + 1_000).map(expiry => expiry.id)).toEqual([id]);
    expect(journal.get(id)?.state).toBe("needs_review");
    expect(peer.deliveryCount).toBe(1);
    bus.onQueues = undefined;
    bus.deliveryReceipt(peer.id, { id, state: "completed" });
    let drained!: () => void;
    const settledIdle = new Promise<void>(resolve => { drained = resolve; });
    bus.onQueues = drained;
    peer.set("idle");
    await settledIdle;
    expect(journal.get(id)?.state).toBe("needs_review");
    expect(bus.queueIds(peer.id)).toContain(queued.id);
    expect(peer.deliveryCount).toBe(1);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("accepted invocation timeout marks uncertainty once even when observers throw", async () => {
  const { dir, journal, peer, bus } = fixture();
  let failures = 0, receipts = 0, uncertain = 0;
  try {
    let delivered!: () => void;
    const firstDelivery = new Promise<void>(resolve => { delivered = resolve; });
    peer.onPhysicalDelivery = delivered;
    bus.onDeliveryFailed = () => { failures++; throw new Error("delivery observer failed"); };
    bus.onInvocationReceipt = () => { receipts++; throw new Error("receipt observer failed"); };
    bus.onInvocationUncertain = () => { uncertain++; throw new Error("uncertain observer failed"); };
    await peer.start();
    const invocation = newEnvelope("hub", "run this request", { to: [peer.id], kind: "invocation", priority: "important" });
    bus.publish(invocation);
    await firstDelivery;
    const id = peer.deliveryIds[0]!;
    const accepted = journal.get(id)!;
    expect(bus.expireAcceptedDeliveries(accepted.updatedAt + 1_000).map(expiry => expiry.id)).toEqual([id]);
    expect(journal.get(id)?.state).toBe("needs_review");
    expect(bus.invocationUncertain(invocation.id)).toBe(true);
    expect([failures, receipts, uncertain]).toEqual([1, 1, 1]);
    peer.onDelivery?.({ id, state: "completed" });
    expect(journal.get(id)?.state).toBe("needs_review");
    expect(bus.expireAcceptedDeliveries(accepted.updatedAt + 1_000)).toEqual([]);
    expect([failures, receipts, uncertain]).toEqual([1, 1, 1]);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("pull returns its committed batch when the queue observer throws and never hands it out twice", async () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    await peer.start();
    peer.set("busy");
    const env = newEnvelope("user", "inbox result", { to: [peer.id], priority: "important" });
    bus.publish(env);
    bus.onQueues = () => { throw new Error("observer failed after commit"); };
    expect(bus.pull(peer.id)?.map(item => item.id)).toEqual([env.id]);
    const completed = journal.list().filter(row => row.originals.some(item => item.id === env.id) && row.state === "completed");
    expect(completed).toHaveLength(1);

    let drained!: () => void;
    const idleSettled = new Promise<void>(resolve => { drained = resolve; });
    bus.onQueues = drained;
    peer.set("idle");
    await idleSettled;
    expect(bus.pull(peer.id)).toEqual([]);
    expect(journal.list().filter(row => row.originals.some(item => item.id === env.id) && row.state === "completed")).toHaveLength(1);
    expect(peer.deliveryCount).toBe(0);
  } finally { bus.closeJournal(); await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a declared configured recipient persists without an adapter while undeclared targets stay refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-configured-recipient-"));
  const options = { file: join(dir, "hub.db"), projectRoot: dir, projectId: "configured-recipient" };
  const journal = new DeliveryJournal({ ...options, instanceId: "first" });
  let bus: Bus | undefined = new Bus({ journal, batchMs: 0 });
  try {
    expect(bus.publish(newEnvelope("hub", "undeclared", { to: ["codex"] }))).toEqual([]);
    expect(bus.queueIds("codex")).toEqual([]);
    bus.ensureKnownRecipientQueue("codex");
    const notice = newEnvelope("hub", "configured conductor notice", { to: ["codex"], kind: "review", priority: "important" });
    expect(bus.publish(notice)).toEqual(["codex"]);
    expect(bus.queueIds("codex")).toEqual([notice.id]);
    expect(bus.publish(newEnvelope("hub", "still undeclared", { to: ["qwen"] }))).toEqual([]);
    bus.closeJournal();
    bus = undefined;

    const restoredJournal = new DeliveryJournal({ ...options, instanceId: "restored" });
    const restored = new Bus({ journal: restoredJournal, batchMs: 0 });
    try {
      expect(restored.knownPeers()).toContain("codex");
      expect(restored.queueIds("codex")).toEqual([notice.id]);
      expect(restored.queueShow(`q:codex:${notice.id}`)?.state).toBe("queued");
    } finally { restored.closeJournal(); }
  } finally { bus?.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("accepted channel disposition is owner and revision fenced, while ordinary held rows remain resolvable", () => {
  const { dir, journal, peer, bus } = fixture();
  try {
    const env = newEnvelope("user", "held");
    const accepted = journal.createDelivery({ id: "owned", peer: peer.id, state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
    expect(() => bus.resolveOwnDelivery("codex", accepted.id, accepted.revision, "completed", "wrong owner")).toThrow();
    expect(() => bus.resolveOwnDelivery(peer.id, accepted.id, accepted.revision + 1, "completed", "stale")).toThrow();
    const codex = new OrdinaryPeer("codex"); bus.add(codex);
    const held = journal.createDelivery({ id: "ordinary-held", peer: codex.id, state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    bus.resolveOwnDelivery(codex.id, held.id, held.revision, "completed", "verified held work");
    expect(journal.get(held.id)?.state).toBe("completed");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("accepted inbox hints advertise explicit disposition and preserve held-only guidance", () => {
  const acceptedOnly = renderHeldHint({ count: 1, rows: [{ id: "accepted-17", revision: 8, createdAt: 1_000, senders: ["hub"], kinds: ["task"], state: "accepted" }], truncated: false }, 2_000, true);
  expect(acceptedOnly).toContain("accepted-17 revision 8");
  expect(acceptedOnly).toContain('delivery_id: "<shown id>"');
  expect(acceptedOnly).toContain("revision: <shown revision>");
  expect(acceptedOnly).toContain('action: "completed" or "discard"');
  expect(acceptedOnly).toContain("not native-read or task-approval proof");
  expect(acceptedOnly).toContain("do not retry or replay them");
  expect(acceptedOnly).not.toContain("hub_delivery_retry");

  const mixed = renderHeldHint({ count: 2, rows: [
    { id: "accepted-18", revision: 10, createdAt: 1_000, senders: ["hub"], kinds: ["review"], state: "accepted" },
    { id: "held-19", revision: 11, createdAt: 1_000, senders: ["user"], kinds: ["chat"], state: "needs_review" },
  ], truncated: false }, 2_000, true);
  expect(mixed).toContain("accepted-18 revision 10");
  expect(mixed).toContain("held row");
  expect(mixed).toContain("hub_delivery_retry only to request its one uncertain redelivery");

  const legacy = { count: 1, rows: [{ id: "held-20", revision: 12, createdAt: 1_000, senders: ["user"], kinds: ["task"] }], truncated: false };
  const statefulHeld = { count: 1, rows: [{ ...legacy.rows[0]!, state: "needs_review" }], truncated: false };
  expect(renderHeldHint(statefulHeld, 2_000, true)).toBe(renderHeldHint(legacy, 2_000, true));
  expect(renderHeldHint({ count: 1, rows: [{ ...legacy.rows[0]!, state: "dispatching" }], truncated: false }, 2_000, true)).toBe("");
});
