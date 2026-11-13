import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class PullPeer extends BasePeer {
  readonly pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() { throw new Error("pull-only peer must not receive push delivery"); }
  busy() { this.setState("busy"); }
}

class SteeringPeer extends BasePeer {
  events: string[] = [];
  releaseSteer?: () => void;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() { throw new Error("busy peer must not receive push delivery"); }
  steer = async () => {
    this.events.push("steer");
    await new Promise<void>(resolve => { this.releaseSteer = resolve; });
  };
  busy() { this.setState("busy"); }
}

test("#1056 package publication evidence survives terminal pruning and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-publication-")), file = join(dir, "hub.db");
  let journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "one", terminalHistoryLimit: () => 1 });
  try {
    const env = newEnvelope("hub", "immutable person comment", { to: ["codex"], kind: "review", refs: { task: "1", taskRecipient: "owner", reviewPackage: "review-person-package" } });
    journal.createDelivery({ id: "package-delivery", peer: "codex", state: "completed", createdAt: env.ts, originals: [env], out: [env] });
    for (let n = 0; n < 3; n++) {
      const ordinary = newEnvelope("user", "ordinary history");
      journal.createDelivery({ id: `ordinary-${n}`, peer: "codex", state: "completed", createdAt: env.ts + n + 1, originals: [ordinary], out: [ordinary] });
    }
    expect(journal.get("ordinary-0")).toBeUndefined();
    expect(journal.reviewEnvelopePublished(env.id)).toBe(true);
    journal.close();
    journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "two", terminalHistoryLimit: () => 1 });
    const bus = new Bus({ journal, batchMs: 0 });
    expect(bus.get(env.id)).toBeUndefined(); // No reply-cache evidence survives this fixture.
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("published");
    expect(bus.publishReviewEnvelope(env)).toEqual(["codex"]);
    expect(() => bus.publishReviewEnvelope({ ...env, body: "changed package body" })).toThrow("differs from its publication evidence");
    expect(bus.queued("codex")).toBe(0);
    expect(bus.reviewEnvelopeStatus(crypto.randomUUID())).toBe("absent");
    bus.closeJournal();
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("unknown");
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 package publication proof includes saved queues and refuses an unavailable journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-publication-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "one" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    const env = newEnvelope("hub", "saved package", { to: ["codex"], kind: "review", refs: { reviewPackage: "review-saved-package" } });
    journal.persistBus({ schemaVersion: 1, queues: { codex: [env] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, []);
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("published");
    const ephemeral = new Bus();
    expect(ephemeral.reviewEnvelopeStatus(env.id)).toBe("unknown");
    expect(() => ephemeral.publishReviewEnvelope(env)).toThrow("publication evidence is unavailable");
    ephemeral.closeJournal();
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 terminal reviewer requests prune while person package receipts remain recoverable", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-request-pruning-")), file = join(dir, "hub.db");
  const journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "one", terminalHistoryLimit: () => 1 });
  try {
    const personPackage = newEnvelope("hub", "person package", { to: ["codex"], kind: "review", refs: { reviewPackage: `review-${crypto.randomUUID()}` } });
    const reviewerRequest = newEnvelope("hub", "reviewer request", { to: ["claude"], kind: "review", refs: { reviewPackage: `reviewer-request-${crypto.randomUUID()}` } });
    const ordinary = newEnvelope("user", "ordinary history");
    journal.createDelivery({ id: "person-package", peer: "codex", state: "completed", createdAt: 1, originals: [personPackage], out: [personPackage] });
    journal.createDelivery({ id: "reviewer-request", peer: "claude", state: "completed", createdAt: 2, originals: [reviewerRequest], out: [reviewerRequest] });
    journal.createDelivery({ id: "ordinary-terminal", peer: "codex", state: "completed", createdAt: 3, originals: [ordinary], out: [ordinary] });
    expect(journal.get("person-package")).toBeDefined();
    expect(journal.get("reviewer-request")).toBeUndefined();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 failed and discarded package deliveries report their terminal state without replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-publication-terminal-")), journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "one" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    for (const state of ["failed", "discarded"] as const) {
      const env = newEnvelope("hub", `saved ${state} package`, { to: ["codex"], kind: "review", refs: { reviewPackage: `review-${crypto.randomUUID()}` } });
      journal.createDelivery({ id: `package-${state}`, peer: "codex", state, createdAt: env.ts, originals: [env], out: [env] });
      expect(bus.reviewEnvelopeStatus(env.id)).toBe(state);
      expect(() => bus.publishReviewEnvelope(env)).toThrow(`delivery is ${state}`);
      expect(bus.queued("codex")).toBe(0);
    }
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 unsettled review scope follows the original recipient until explicit disposition across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-former-recipient-")), file = join(dir, "hub.db");
  let journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "one" });
  try {
    const env = newEnvelope("hub", "former reviewer source quote", { to: ["former-reviewer"], kind: "review", refs: { task: "7", reviewPackage: "finding-original-recipient" } });
    journal.createDelivery({ id: "uncertain-review", peer: "former-reviewer", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    journal.close();
    journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "two" });
    const bus = new Bus({ journal, batchMs: 0 });
    expect(bus.hasUnsettledReviewScope("former-reviewer", 7)).toBe(true);
    expect(bus.hasUnsettledReviewScope("former-reviewer", 8)).toBe(false);
    expect(bus.hasUnsettledReviewScope("replacement-reviewer", 7)).toBe(false);
    const held = journal.get("uncertain-review")!;
    journal.resolve(held.id, held.revision, "completed", "person confirmed handling");
    expect(bus.hasUnsettledReviewScope("former-reviewer", 7)).toBe(false);
    bus.closeJournal();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 queued and recovery-deferred review scope retains its actual recipient", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-pending-recipient-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "one" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    const env = newEnvelope("hub", "pending source quote", { to: ["old-owner"], kind: "review", priority: "important", refs: { task: "9", reviewPackage: "finding-pending-recipient" } });
    const snapshot = { schemaVersion: 1 as const, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
    journal.persistBus({ ...snapshot, queues: { "old-owner": [env] } }, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(true);
    expect(bus.hasUnsettledReviewScope("new-owner", 9)).toBe(false);
    journal.persistBus({ ...snapshot, deferredHub: [env] }, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(true);
    journal.persistBus(snapshot, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(false);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 pulled review input becomes current metadata without ACK and retains named-parent provenance", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new PullPeer("claude");
  const pulled: Envelope[][] = [], replies: Envelope[] = [];
  let acknowledged = 0;
  bus.add(peer); await peer.start();
  bus.onPulled = (recipient, originals) => { if (recipient === peer.id) pulled.push(originals); };
  bus.onDelivered = () => { acknowledged++; };
  bus.tap(event => { if (event.t === "envelope" && event.env.from === peer.id) replies.push(event.env); });
  try {
    const review = newEnvelope("hub", "quote-bearing review request", { to: [peer.id], kind: "review", refs: { task: "7", reviewPackage: "reviewer-request-7" } });
    bus.publish(review);
    expect(bus.pull(peer.id)?.map(env => env.id)).toEqual([review.id]);
    expect(bus.lastDeliveredTo(peer.id).map(env => env.id)).toEqual([review.id]);
    expect(pulled[0]?.map(env => env.id)).toEqual([review.id]);

    const ordinary = newEnvelope("hub", "ordinary task input", { to: [peer.id], kind: "task" });
    bus.publish(ordinary);
    expect(bus.pull(peer.id)?.map(env => env.id)).toEqual([ordinary.id]);
    expect(bus.lastDeliveredTo(peer.id).map(env => env.id)).toEqual([ordinary.id]);
    expect(pulled[1]?.map(env => env.id)).toEqual([ordinary.id]);

    peer.onMessage!("ordinary reply", { kind: "chat", inReplyTo: ordinary });
    const ordinaryReply = replies.find(env => env.body === "ordinary reply")!;
    expect(ordinaryReply.refs?.reviewResponse).toBeUndefined();
    peer.onMessage!("reply to pulled review", { kind: "chat", inReplyTo: review });
    const reviewReply = replies.find(env => env.body === "reply to pulled review")!;
    expect(reviewReply.refs?.reviewResponse).toBe("reviewer-request-7");
    expect(acknowledged).toBe(0);
  } finally { bus.closeJournal(); await peer.stop(); }
});

test("steering records quote input before handoff without firing delivery callbacks", async () => {
  const bus = new Bus({ batchMs: 0 }), steering = new SteeringPeer("claude"), queued = new PullPeer("codex");
  const steeringPeers: string[] = [];
  let delivered = 0, deliveries = 0;
  let acknowledge!: () => void;
  const positiveAck = new Promise<void>(resolve => { acknowledge = resolve; });
  bus.add(steering); bus.add(queued); await steering.start(); await queued.start(); steering.busy(); queued.busy();
  bus.onSteering = peer => { steeringPeers.push(peer); if (peer === steering.id) steering.events.push("metadata"); };
  bus.onDeliver = () => { deliveries++; };
  bus.onDelivered = peer => { if (peer === steering.id) { delivered++; acknowledge(); } };
  try {
    bus.publish(newEnvelope("hub", "quoted review steer", { to: [steering.id], kind: "review", priority: "important", refs: { reviewPackage: "reviewer-request-steer" } }));
    expect(steering.events).toEqual(["metadata", "steer"]);
    expect(deliveries).toBe(0);
    expect(delivered).toBe(0);

    bus.publish(newEnvelope("hub", "important but only queued", { to: [queued.id], kind: "review", priority: "important", refs: { reviewPackage: "reviewer-request-queued" } }));
    expect(bus.queueIds(queued.id)).toHaveLength(1);
    expect(steeringPeers).toEqual([steering.id]);
    expect(delivered).toBe(0);
    steering.releaseSteer!();
    await positiveAck;
    expect(delivered).toBe(1);
    expect(deliveries).toBe(0);
  } finally { bus.closeJournal(); await Promise.all([steering.stop(), queued.stop()]); }
});
