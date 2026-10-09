import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class Conductor extends BasePeer {
  batches: Envelope[][] = [];
  steers: Envelope[][] = [];
  receipts: string[] = [];
  fail = false;
  accept = false;
  async deliver(envs: Envelope[], id?: string) {
    if (this.fail) { this.fail = false; throw new Error("safe fixture failure"); }
    this.batches.push(envs);
    if (id) { this.receipts.push(id); if (this.accept) this.onDelivery?.({ id, state: "accepted" }); }
  }
  steer = async (envs: Envelope[]) => { this.steers.push(envs); };
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
}
const notice = (body: string, key = "task:1:moved", priority: "status" | "important" = "status") => newEnvelope(HUB, body, {
  to: ["claude"], kind: "task", priority, refs: { supervision: true, supervisionKey: key, task: "1" },
});
const tick = () => Bun.sleep(5);

test("five status feed milestones wait one time window with default batchMax three", async () => {
  const bus = new Bus({ batchMs: 40 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  for (let n = 1; n <= 5; n++) bus.publish(notice(`milestone ${n}`, `task:${n}:accepted`));
  expect(peer.batches).toHaveLength(0);
  expect(bus.queued("claude")).toBe(5);
  await Bun.sleep(70);
  expect(peer.batches).toHaveLength(1);
  expect(peer.batches[0]).toHaveLength(5);
  bus.closeJournal();
});

test("mixed ordinary traffic retains default count-triggered batching", async () => {
  const bus = new Bus({ batchMs: 60_000 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  bus.publish(notice("milestone one", "task:1:accepted"));
  bus.publish(notice("milestone two", "task:2:accepted"));
  bus.publish(newEnvelope("user", "ordinary work", { to: ["claude"] }));
  await tick();
  expect(peer.batches).toHaveLength(1);
  expect(peer.batches[0]).toHaveLength(3);
  bus.closeJournal();
});

test("a supervision window larger than ten retains the bounded digest ceiling", async () => {
  const bus = new Bus({ batchMs: 40 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  for (let n = 1; n <= 11; n++) bus.publish(notice(`milestone ${n}`, `task:${n}:accepted`));
  expect(peer.batches).toHaveLength(0);
  await Bun.sleep(70);
  expect(peer.batches.map((batch) => batch.length)).toEqual([10, 1]);
  bus.closeJournal();
});

test("milestones share the existing batch window and repeat keys keep only latest without resetting deadline", async () => {
  const bus = new Bus({ batchMs: 50, batchMax: 100 });
  const peer = new Conductor("claude");
  bus.add(peer); await peer.start();
  const first = notice("old owner");
  bus.publish(first);
  const latest = notice("new owner");
  latest.ts = first.ts + 40;
  bus.publish(latest);
  bus.publish(notice("accepted", "task:1:accepted"));
  expect(bus.queued("claude")).toBe(2);
  expect(bus.snapshot().queues.claude?.[0]?.ts).toBe(first.ts);
  await Bun.sleep(80);
  expect(peer.batches).toHaveLength(1);
  expect(peer.batches[0]?.map((e) => e.body)).toEqual(["new owner", "accepted"]);
  bus.closeJournal();
});

test("revoking pending feed preserves other queued work and in-flight durable acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-supervision-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    const peer = new Conductor("claude"); peer.accept = true;
    bus.add(peer); await peer.start();
    const observed: Envelope[][] = [];
    bus.onDelivered = (_peer, envs) => { observed.push(envs); };
    bus.publish(notice("accepted native work")); await tick();
    const id = peer.receipts[0]!;
    expect(journal.get(id)?.state).toBe("accepted");
    expect(observed).toHaveLength(1);
    peer.onDelivery?.({ id, state: "accepted" });
    expect(observed).toHaveLength(1);
    peer.set("busy");
    bus.publish(notice("new pending owner"));
    bus.publish(newEnvelope("user", "other pending work", { to: ["claude"] }));
    expect(bus.revokeSupervision("claude")).toBe(1);
    expect(journal.get(id)?.state).toBe("accepted");
    expect(bus.queued("claude")).toBe(1);
    expect(observed).toHaveLength(1);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("revocation cancels pending asynchronous preparation without touching native dispatch", async () => {
  let release!: (envs: Envelope[]) => void;
  let preparing!: () => void;
  const ready = new Promise<void>((resolve) => { preparing = resolve; });
  const bus = new Bus({ batchMs: 0, condense: (envs) => { preparing(); return new Promise<Envelope[]>((resolve) => { release = () => resolve(envs); }); } });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  bus.publish(notice("still preparing")); await ready;
  expect(bus.revokeSupervision("claude")).toBe(1);
  release([]); await tick();
  expect(peer.batches).toHaveLength(0);
  expect(bus.queued("claude")).toBe(0);
  bus.closeJournal();
});

test("a repeated milestone arriving during preparation replaces unsent originals", async () => {
  let release!: () => void;
  let count = 0;
  const bus = new Bus({ batchMs: 0, condense: async (envs) => {
    if (++count === 1) await new Promise<void>((resolve) => { release = resolve; });
    return envs;
  } });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  bus.publish(notice("old prepared owner"));
  await tick();
  bus.publish(notice("latest prepared owner"));
  release(); await tick();
  expect(peer.batches).toHaveLength(1);
  expect(peer.batches[0]?.map((e) => e.body)).toEqual(["latest prepared owner"]);
  bus.closeJournal();
});

test("safe failure originals retain retry authority when a later milestone has the same key", async () => {
  const bus = new Bus({ batchMs: 0, retryMs: 1000 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start();
  peer.fail = true;
  bus.publish(notice("retry original")); await tick();
  peer.set("busy");
  bus.publish(notice("new milestone"));
  expect(bus.queued("claude")).toBe(2);
  peer.set("idle"); await tick();
  expect(peer.batches[0]?.map((e) => e.body)).toEqual(["retry original"]);
  expect(peer.batches[1]?.map((e) => e.body)).toEqual(["new milestone"]);
  bus.closeJournal();
});

test("important feed steer reports actual admission and ordinary feed does not steer", async () => {
  const bus = new Bus({ batchMs: 0 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start(); peer.set("busy");
  const observed: Envelope[][] = [];
  bus.onDelivered = (_peer, envs) => { observed.push(envs); };
  bus.publish(notice("ordinary"));
  bus.publish(notice("approval waiting", "approval:one", "important")); await tick();
  expect(peer.steers).toHaveLength(1);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.[0]?.body).toBe("approval waiting");
  expect(bus.queued("claude")).toBe(1);
  bus.closeJournal();
});

test("durable native failure is observed synchronously before queue metrics and only once per receipt", async () => {
  for (const state of ["failed_safe", "needs_review"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "ahub-supervision-failure-"));
    const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
    const bus = new Bus({ journal, batchMs: 0, retryMs: 60_000 });
    try {
      const peer = new Conductor("claude"); peer.accept = true;
      bus.add(peer); await peer.start();
      bus.publish(notice("native work")); await tick();
      const id = peer.receipts[0]!;
      const order: string[] = [];
      bus.onDeliveryFailed = (p) => { order.push(`failed:${p}`); };
      bus.onQueues = () => { order.push("queues"); };
      peer.onDelivery?.({ id, state });
      expect(order[0]).toBe("failed:claude");
      expect(order.filter((e) => e === "failed:claude")).toHaveLength(1);
      peer.onDelivery?.({ id, state });
      expect(order.filter((e) => e === "failed:claude")).toHaveLength(1);
    } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("non-durable transport failure is observed without reporting admission", async () => {
  const bus = new Bus({ batchMs: 0, retryMs: 60_000 });
  const peer = new Conductor("claude"); bus.add(peer); await peer.start(); peer.fail = true;
  const failures: string[] = [];
  const admissions: string[] = [];
  bus.onDeliveryFailed = (p) => { failures.push(p); };
  bus.onDelivered = (p) => { admissions.push(p); };
  bus.publish(notice("rejected transport")); await tick();
  expect(failures).toEqual(["claude"]);
  expect(admissions).toEqual([]);
  bus.closeJournal();
});
