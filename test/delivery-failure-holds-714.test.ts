import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, type BusSnapshot } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";

const remote = "codex@hub-a", room = "room-a", member = "a".repeat(64);

class PendingRemotePeer extends BasePeer {
  readonly remoteRoom = room;
  readonly remoteMember = member;
  readonly remoteQueueTtlMs = 60_000;
  readonly deadlines = new Map<string, number>();
  readonly delivered: Envelope[][] = [];
  deliveryId?: string;
  private release!: () => void;
  private pending = new Promise<void>(resolve => { this.release = resolve; });
  constructor() { super(remote); }
  setRemoteDeadline(id: string, expiry: number) { this.deadlines.set(id, expiry); }
  async deliver(envs: Envelope[], id?: string) {
    if (!id) throw new Error("fixture expected a journal delivery");
    this.deliveryId = id;
    this.delivered.push(envs);
    await this.pending;
  }
  finish() { this.release(); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-failure-hold-714-"));
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "p", instanceId: "i" });
  const bus = new Bus({ journal, batchMs: 0 });
  return { root, journal, bus };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

for (const origin of ["known-not-sent", "proof-unavailable"] as const) {
  test(`a fresh ${origin} room hold retains its cause when a person retries the parent (#1178)`, async () => {
    const f = fixture(), peer = new PendingRemotePeer();
    try {
      await peer.start(); f.bus.add(peer);
      const env = newEnvelope("user", "private remote hold canary 714", { to: [remote], private: true });
      f.bus.publish(env);
      await until(() => peer.deliveryId !== undefined);
      const id = peer.deliveryId!;
      expect(f.journal.get(id)?.state).toBe("dispatching");
      f.bus.pause(remote);
      expect(f.bus.holdRemoteMissingIntent(peer, id, () => true, origin)).toBe(true);
      peer.finish(); await until(() => !f.bus.hasInFlight(remote));
      const held = f.journal.get(id)!;
      expect(held).toMatchObject({ state: "needs_review", failureCause: "push error" });
      expect(f.journal.resolution(id)).toBeUndefined();
      f.bus.resolveDelivery(id, held.revision, "retry", "person retries before the original deadline");
      expect(f.journal.get(id)).toMatchObject({ state: "failed", failureCause: "push error" });
      expect(f.journal.resolution(id)?.action).toBe("retry");
      expect(f.journal.unresolvedFailedCounts()).toEqual({});
      expect(f.bus.failedDeliveryCounts()).toEqual({});
      expect(f.bus.queueIds(remote)).toEqual([env.id]);
      expect(peer.delivered).toHaveLength(1);
      expect(peer.deadlines.get(env.id)).toBeGreaterThan(Date.now());
      expect(JSON.stringify({ failureCause: f.journal.get(id)?.failureCause, counts: f.bus.failedDeliveryCounts() })).not.toContain("private remote hold canary 714");
    } finally {
      peer.finish(); await until(() => !f.bus.hasInFlight(remote));
      f.bus.closeJournal(); await peer.stop(); rmSync(f.root, { recursive: true, force: true });
    }
  });
}

for (const cause of [undefined, "timeout"] as const) {
  test(`a fresh invocation hold records ${cause ?? "turn aborted"} from typed evidence (#1178)`, async () => {
    const f = fixture(), peer = new PendingRemotePeer();
    try {
      await peer.start(); f.bus.add(peer);
      const env = newEnvelope("hub", "invocation canary 714", { to: [remote], kind: "invocation" });
      f.bus.publish(env);
      await until(() => peer.deliveryId !== undefined);
      const id = peer.deliveryId!;
      expect(f.journal.get(id)?.state).toBe("dispatching");
      f.bus.pause(remote);
      f.bus.holdInvocation(env.id, "text mentioning timeout is not typed cause evidence", remote, cause);
      peer.finish(); await until(() => !f.bus.hasInFlight(remote));
      expect(f.journal.get(id)).toMatchObject({ state: "needs_review", failureCause: cause ?? "turn aborted" });
      expect(f.bus.failedDeliveryCounts()).toEqual({});
      expect(f.bus.queueIds(remote)).toEqual([]);
      expect(peer.delivered).toHaveLength(1);
      expect(f.journal.resolution(id)).toBeUndefined();
    } finally {
      peer.finish(); await until(() => !f.bus.hasInFlight(remote));
      f.bus.closeJournal(); await peer.stop(); rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("a queued remote delivery with complete expired metadata records timeout and cannot be retried (#1178)", () => {
  const f = fixture(), peer = new PendingRemotePeer();
  try {
    f.bus.add(peer); f.bus.pause(remote);
    const env = newEnvelope("user", "queued expiry canary 714", { to: [remote] });
    f.bus.publish(env);
    const expiry = f.bus.snapshot(false).remoteQueueExpires![remote]![env.id]!;
    expect(f.bus.expireRemoteQueues(expiry)).toBe(1);
    const held = f.journal.unresolved(remote)[0]!;
    expect(held).toMatchObject({ state: "needs_review", failureCause: "timeout", originals: [env] });
    expect(() => f.bus.resolveDelivery(held.id, held.revision, "retry", "cannot revive expiry")).toThrow("remote original deadline unavailable or expired");
    expect(f.journal.resolution(held.id)).toBeUndefined();
    expect(f.bus.failedDeliveryCounts()).toEqual({});
    expect(f.bus.queueIds(remote)).toEqual([]);
    expect(peer.delivered).toEqual([]);
  } finally { f.bus.closeJournal(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const missing of ["expiry", "room", "member"] as const) {
  test(`a legacy queue missing ${missing} metadata records push error rather than guessing timeout (#1178)`, () => {
    const f = fixture();
    try {
      const env = newEnvelope("user", "legacy metadata canary 714", { to: [remote] });
      const snapshot: BusSnapshot = {
        schemaVersion: 1, queues: { [remote]: [env] }, prefaces: {}, seen: [env], attempts: {}, withdrawn: [],
        ...(missing === "expiry" ? {} : { remoteQueueExpires: { [remote]: { [env.id]: Date.now() + 60_000 } } }),
        ...(missing === "room" ? {} : { remoteQueueRooms: { [remote]: room } }),
        ...(missing === "member" ? {} : { remoteQueueMembers: { [remote]: member } }),
      };
      f.bus.restore(snapshot);
      expect(f.bus.expireRemoteQueues()).toBe(1);
      const held = f.journal.unresolved(remote)[0]!;
      expect(held).toMatchObject({ state: "needs_review", failureCause: "push error", originals: [env] });
      expect(f.journal.resolution(held.id)).toBeUndefined();
      expect(f.bus.failedDeliveryCounts()).toEqual({});
      expect(f.bus.queueIds(remote)).toEqual([]);
      expect(f.bus.expireRemoteQueues()).toBe(0);
    } finally { f.bus.closeJournal(); rmSync(f.root, { recursive: true, force: true }); }
  });
}
