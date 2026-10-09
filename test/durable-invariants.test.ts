import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal, type JournalDelivery } from "../src/hub/delivery-journal.ts";
import { newEnvelope, noteLine, type Envelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt, PeerAdapter } from "../src/hub/peers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const waitFor = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(2);
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
};
function journal(instance = "i1", operationId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-durable-invariants-")); dirs.push(dir);
  return { dir, journal: new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "project", instanceId: instance, ...(operationId ? { operationId } : {}) }) };
}
class FakePeer implements PeerAdapter {
  state: "idle" | "busy" | "paused" | "offline" = "idle";
  readonly deliveries: { envs: Envelope[]; id?: string }[] = [];
  readonly steers: { envs: Envelope[]; id?: string }[] = [];
  onMessage?: PeerAdapter["onMessage"];
  onState?: PeerAdapter["onState"];
  onFailed?: PeerAdapter["onFailed"];
  onDelivery?: (receipt: DeliveryReceipt) => void;
  constructor(readonly id: string, private readonly deliverFn: (envs: Envelope[], id?: string) => Promise<void> = async () => {}) {}
  async deliver(envs: Envelope[], id?: string): Promise<void> { this.deliveries.push({ envs, id }); await this.deliverFn(envs, id); }
  async steer(envs: Envelope[], id?: string): Promise<void> { this.steers.push({ envs, id }); throw new Error("unknown steering outcome"); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  setState(state: FakePeer["state"]): void { this.state = state; this.onState?.(state); }
}
function setupBus(options: Partial<ConstructorParameters<typeof Bus>[0]> = {}) {
  const { journal: durable } = journal();
  const bus = new Bus({ journal: durable, batchMax: 1, batchMs: 0, retryMs: 1, ...options });
  return { bus, durable };
}

test("a pull-only peer is never handed a delivery: its queue is counted, then read once as one completed delivery (#205)", async () => {
  const { bus, durable } = setupBus();
  const peer = Object.assign(new FakePeer("claude"), { pullOnly: true }); bus.add(peer);
  bus.preface("claude", "recall");
  const env = newEnvelope("user", "review task #3", { to: ["claude"] });
  bus.publish(env);
  peer.setState("idle"); // the idle transition that drains every other peer
  await Bun.sleep(10);
  expect(peer.deliveries).toHaveLength(0);
  expect(bus.queued("claude")).toBe(1);
  bus.pause("claude"); // the console, budget and conductor holds all pause the bus
  expect(bus.pull("claude")).toBeUndefined();
  expect(durable.list("claude")).toEqual([]);
  bus.resume("claude");
  expect(peer.deliveries).toHaveLength(0);
  expect(bus.pull("claude")!.map((e) => [e.from, e.kind])).toEqual([["hub", "presence"], ["user", env.kind]]);
  expect(bus.queued("claude")).toBe(0);
  expect(bus.pull("claude")).toEqual([]);
  expect(durable.list("claude").map((r) => [r.state, r.reason])).toEqual([["completed", "read through hub_inbox"]]);
  expect(durable.snapshot().bus.queues.claude).toEqual([]);
  durable.close();
});

test("a push being condensed when a session without pushes takes the peer is not handed over, and stays pullable (#205)", async () => {
  let release!: () => void;
  let condensing = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { bus, durable } = setupBus({ condense: async (envs) => { condensing = true; await pending; return envs; } });
  const peer = new FakePeer("claude"); bus.add(peer);
  const env = newEnvelope("user", "first", { to: ["claude"], priority: "status" });
  bus.publish(env);
  await waitFor(() => condensing, "condensation");
  Object.assign(peer, { pullOnly: true }); // what attach does for a plain session's hello
  peer.setState("offline"); peer.setState("idle");
  release();
  await Bun.sleep(10);
  expect(peer.deliveries).toHaveLength(0);
  expect(durable.list("claude").filter((r) => r.state !== "completed")).toEqual([]);
  expect(bus.pull("claude")!.map((e) => e.id)).toEqual([env.id]);
  durable.close();
});

test("a pull groups the queued row an operator retry left, so no journal row stays queued (#205)", async () => {
  const { bus, durable } = setupBus();
  const peer = new FakePeer("claude", async () => { throw new Error("socket disappeared"); }); bus.add(peer);
  const env = newEnvelope("user", "lost", { to: ["claude"] });
  bus.publish(env);
  await waitFor(() => durable.list("claude").some((r) => r.state === "needs_review"), "uncertain delivery");
  Object.assign(peer, { pullOnly: true });
  const row = durable.list("claude").find((r) => r.state === "needs_review")!;
  bus.resolveDelivery(row.id, row.revision, "retry", "not shown");
  expect(durable.list("claude").filter((r) => r.state === "queued").map((r) => r.id)).toEqual([`${row.id}:retry:1`]);
  expect(bus.pull("claude")!.map((e) => e.id)).toEqual([env.id]);
  expect(durable.list("claude").filter((r) => r.state === "queued")).toEqual([]);
  expect(durable.list("claude").find((r) => r.reason === "read through hub_inbox")).toMatchObject({ state: "completed", previousId: `${row.id}:retry:1` });
  durable.close();
});

test("what a pull hands over resolves as reply_to, a preface and an envelope that aged out of the seen cache included (#205)", () => {
  const bus = new Bus({ batchMs: 0 });
  bus.add(Object.assign(new FakePeer("claude"), { pullOnly: true }));
  bus.preface("claude", "recall");
  const env = newEnvelope("user", "old question", { to: ["claude"] });
  bus.publish(env);
  for (let i = 0; i < 2100; i++) bus.publish(newEnvelope("user", `noise ${i}`, { to: ["nobody"] }));
  expect(bus.get(env.id)).toBeUndefined();
  const read = bus.pull("claude")!;
  expect(read).toHaveLength(2);
  expect(read.map((e) => bus.get(e.id)?.id)).toEqual(read.map((e) => e.id));
});

test("a pull moves what it hands over to the newest end of the seen cache, so an envelope near eviction stays resolvable (#205)", () => {
  const bus = new Bus({ batchMs: 0 });
  bus.add(Object.assign(new FakePeer("claude"), { pullOnly: true }));
  const env = newEnvelope("user", "old question", { to: ["claude"] });
  bus.publish(env);
  for (let i = 0; i < 2000; i++) bus.publish(newEnvelope("user", `noise ${i}`, { to: ["nobody"] }));
  expect(bus.get(env.id)).toBeDefined(); // cached, and now the oldest entry
  bus.pull("claude");
  for (let i = 0; i < 100; i++) bus.publish(newEnvelope("user", `later ${i}`, { to: ["nobody"] }));
  expect(bus.get(env.id)?.id).toBe(env.id);
});

test("a read clears the peer's delivery failure streak, as a completed push does (#205)", async () => {
  const bus = new Bus({ batchMs: 0, batchMax: 1, retryMs: 1 });
  const peer = new FakePeer("claude", async () => { throw new Error("socket disappeared"); }); bus.add(peer);
  for (let i = 0; i < 3; i++) bus.publish(newEnvelope("user", `lost ${i}`, { to: ["claude"] }));
  await waitFor(() => !!bus.failingPeers().claude, "three exhausted deliveries");
  Object.assign(peer, { pullOnly: true });
  bus.publish(newEnvelope("user", "read", { to: ["claude"] }));
  expect(bus.pull("claude")!.map((e) => e.body)).toEqual(["read"]);
  expect(bus.failingPeers()).toEqual({});
});

test("a pull whose journal write fails keeps every pause, the queue and the preface, and stops the bus (#205)", () => {
  const { bus, durable } = setupBus();
  bus.add(Object.assign(new FakePeer("claude"), { pullOnly: true }));
  bus.add(new FakePeer("codex"));
  bus.pause("codex"); // a budget or conductor pause, which the snapshot does not carry
  bus.preface("claude", "recall");
  const env = newEnvelope("user", "kept", { to: ["claude"] });
  bus.publish(env);
  durable.close();
  expect(() => bus.pull("claude")).toThrow();
  expect(bus.isPaused("codex")).toBe(true);
  expect(bus.queueIds("claude")).toEqual([env.id]);
  expect(bus.snapshot(false).prefaces.claude).toBeDefined();
  expect(bus.storageError).toBe("delivery journal unavailable");
});

test("one pull takes what one push delivery would, and the rest keep waiting (#205)", () => {
  const { bus, durable } = setupBus();
  bus.add(Object.assign(new FakePeer("claude"), { pullOnly: true }));
  for (let i = 0; i < 12; i++) bus.publish(newEnvelope("user", `m${i}`, { to: ["claude"], priority: "status" }));
  expect(bus.pull("claude")).toHaveLength(10);
  expect(bus.queued("claude")).toBe(2);
  expect(bus.pull("claude")!.map((e) => e.body)).toEqual(["m10", "m11"]);
  expect(durable.list("claude").map((r) => r.state)).toEqual(["completed", "completed"]);
  durable.close();
});

test("an async condensation cannot checkpoint away a batch when another publish persists the bus", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { bus, durable } = setupBus({ condense: async (envs) => { await pending; return envs; } });
  const peer = new FakePeer("claude"); bus.add(peer);
  const first = newEnvelope("user", "first", { to: ["claude"], priority: "status" });
  bus.publish(first);
  await waitFor(() => peer.deliveries.length === 0 && durable.snapshot().bus.queues.claude?.length === 1, "condensation to retain its batch");
  const second = newEnvelope("user", "second", { to: ["claude"], priority: "status" });
  bus.publish(second);
  release();
  await waitFor(() => peer.deliveries.length === 2, "both deliveries");
  expect(peer.deliveries.flatMap((d) => d.envs).map((e) => e.body)).toEqual(["first", "second"]);
  durable.close();
});

test("unknown delivery and steering outcomes become needs_review and are not replayed", async () => {
  const { bus, durable } = setupBus();
  const peer = new FakePeer("claude", async () => { throw new Error("socket disappeared"); }); bus.add(peer);
  bus.publish(newEnvelope("user", "uncertain", { to: ["claude"], priority: "important" }));
  await waitFor(() => durable.list("claude").some((row) => row.state === "needs_review"), "delivery review hold");
  const review = durable.list("claude").find((row) => row.state === "needs_review")!;
  await Bun.sleep(20);
  expect(peer.deliveries).toHaveLength(1);
  expect(bus.queueList("claude").find((row) => row.id === review.id)?.state).toBe("needs_review");

  const steering = new FakePeer("steer"); steering.setState("busy"); bus.add(steering);
  bus.publish(newEnvelope("user", "steer uncertain", { to: ["steer"], priority: "important" }));
  await waitFor(() => durable.list("steer").some((row) => row.state === "needs_review"), "steering review hold");
  expect(steering.steers).toHaveLength(1);
  durable.close();
});

test("failed_safe before a throwing adapter is preserved and requeues exactly once", async () => {
  const { bus, durable } = setupBus();
  let calls = 0;
  const peer = new FakePeer("claude", async (_envs, id) => {
    calls++;
    if (calls === 1) { peer.onDelivery?.({ id: id!, state: "failed_safe", reason: "socket rejected before acceptance" }); throw new Error("late adapter throw"); }
    peer.onDelivery?.({ id: id!, state: "completed" });
  });
  bus.add(peer);
  bus.publish(newEnvelope("user", "retry safely", { to: ["claude"], priority: "important" }));
  await waitFor(() => calls === 2, "one safe retry");
  expect(calls).toBe(2);
  expect(durable.list("claude").filter((row) => row.state === "completed")).toHaveLength(1);
  expect(durable.list("claude").some((row) => row.state === "needs_review")).toBe(false);
  durable.close();
});

test("operator retry is idempotent across repeated calls and a journal restart", () => {
  const { dir, journal: durable } = journal("i1");
  const env = newEnvelope("user", "retry me");
  const row = durable.createDelivery({ id: "delivery-1", peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  const failed = durable.resolve(row.id, row.revision, "retry", "operator confirmed retry is safe");
  expect(durable.resolve(row.id, row.revision, "retry", "operator confirmed retry is safe").revision).toBe(failed.revision);
  expect(durable.list().filter((item) => item.previousId === row.id)).toHaveLength(1);
  durable.close();
  const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "project", instanceId: "i2" });
  expect(reopened.list().filter((item) => item.previousId === row.id)).toHaveLength(1);
  reopened.close();
});

test("broadcast queues use recipient-specific IDs and discarding one recipient leaves the other", () => {
  const { bus, durable } = setupBus();
  const a = new FakePeer("alpha"), b = new FakePeer("bravo"); bus.add(a); bus.add(b); bus.pause("alpha"); bus.pause("bravo");
  const env = newEnvelope("user", "fan out", { priority: "status" });
  expect(bus.publish(env)).toEqual(["alpha", "bravo"]);
  const rows = bus.queueList();
  expect(rows).toHaveLength(2);
  expect(rows[0]!.id).not.toBe(rows[1]!.id);
  bus.resolveDelivery(rows.find((row) => row.peer === "alpha")!.id, rows.find((row) => row.peer === "alpha")!.revision, "discard", "recipient no longer exists");
  expect(bus.queueList().map((row) => [row.peer, row.state])).toEqual([["alpha", "discarded"], ["bravo", "queued"]]);
  durable.close();
});

test("corrupt metadata and stale instance fences are rejected without pretending ownership", () => {
  const { dir, journal: durable } = journal("i1");
  durable.close();
  const db = new Database(join(dir, "hub.db"));
  db.query("UPDATE delivery_meta SET bus_snapshot = ? WHERE project_id = ?").run("{broken", "project"); db.close();
  expect(() => new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "project", instanceId: "i2" })).toThrow(/invalid delivery journal/);

  const clean = journal("owner");
  const other = new DeliveryJournal({ file: join(clean.dir, "hub.db"), projectRoot: clean.dir, projectId: "project", instanceId: "other" });
  expect(() => clean.journal.persistBus({ schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, [])).toThrow(/instance fence/);
  other.close(); clean.journal.close();
});

test("invalid snapshot import fails before mutating an uninitialized journal", () => {
  const { journal: durable } = journal("target", "operation");
  const before = durable.snapshot();
  const invalid = { ...before, schemaVersion: 99 };
  expect(() => durable.importSnapshot(invalid as any, "operation")).toThrow(/invalid delivery journal/);
  expect(durable.snapshot()).toMatchObject({ revision: before.revision, deliveries: [], bus: before.bus });
  durable.close();
});

test("queue overflow is retained as a durable failed outcome", () => {
  const { bus, durable } = setupBus({ queueCap: 1 });
  bus.add(new FakePeer("claude")); bus.pause("claude");
  const first = newEnvelope("user", "evicted", { to: ["claude"] });
  const second = newEnvelope("user", "retained", { to: ["claude"] });
  bus.publish(first); bus.publish(second);
  expect(durable.snapshot().bus.queues.claude!.map((env) => env.id)).toEqual([second.id]);
  expect(durable.list().find((row) => row.originals.some((env) => env.id === first.id))).toMatchObject({ state: "failed", reason: "queue capacity exceeded" });
  bus.closeJournal();
});

test("a note that arrives while a delivery with the preface is in flight survives failed_safe and an operator retry, once each", async () => {
  const { bus, durable } = setupBus();
  let calls = 0;
  const peer = new FakePeer("claude", async (_envs, id) => {
    calls++;
    if (calls === 1) { bus.note("claude", noteLine("codex", "fail", "mid-flight")); peer.onDelivery?.({ id: id!, state: "failed_safe" }); return; }
    if (calls === 3) throw new Error("socket gone");
    peer.onDelivery?.({ id: id!, state: "completed" });
  });
  bus.add(peer);
  bus.preface("claude", "recall block");
  bus.publish(newEnvelope("user", "m1", { to: ["claude"], priority: "important" }));
  await waitFor(() => calls === 2, "safe retry");
  expect(peer.deliveries[1]!.envs.map((e) => e.body)).toEqual(["recall block\n\nnote from codex [fail]: mid-flight", "m1"]);

  bus.note("claude", noteLine("kimi", "finding", "second"));
  bus.publish(newEnvelope("user", "m2", { to: ["claude"], priority: "important" }));
  await waitFor(() => durable.list("claude").some((row) => row.state === "needs_review"), "review hold");
  bus.note("claude", noteLine("kimi", "fail", "after the failure"));
  const row = durable.list("claude").find((r) => r.state === "needs_review")!;
  bus.resolveDelivery(row.id, row.revision, "retry", "operator");
  await waitFor(() => calls === 4, "operator retry");
  expect(peer.deliveries[3]!.envs.map((e) => e.body)).toEqual(["note from kimi [finding]: second\n\nnote from kimi [fail]: after the failure", "m2"]);
  durable.close();
});

// issue #106: the journal keeps what was dropped, so an operator can see why a notice never arrived.
test("a stale notice is recorded as discarded with its reason and never handed to the peer", async () => {
  let closed = false;
  const { bus, durable } = setupBus({ relevant: (_peer, env) => !(closed && env.body === "notice") });
  const peer = new FakePeer("claude"); bus.add(peer);
  peer.setState("busy");
  const notice = newEnvelope("hub", "notice", { to: ["claude"], kind: "task", refs: { task: "1" } });
  bus.publish(notice);
  closed = true;
  peer.setState("idle");
  await waitFor(() => durable.list("claude").some((r) => r.state === "discarded"), "the discarded row");
  const row = durable.list("claude").find((r) => r.state === "discarded")!;
  expect(row.reason).toBe("stale: task #1 is no longer open for claude");
  expect(row.originals.map((e) => e.id)).toEqual([notice.id]);
  expect(peer.deliveries).toEqual([]);
  expect(bus.queued("claude")).toBe(0);
  durable.close();
});

// issue #106, AC8: a stale discard never resolves another delivery. An uncertain delivery stays needs_review and holds
// the queue until an operator acts; only then is the stale notice behind it discarded, under its own row.
test("a stale notice behind a needs_review delivery waits for the operator and leaves that delivery's record alone", async () => {
  let closed = false;
  const { bus, durable } = setupBus({ relevant: (_peer, env) => !(closed && env.body === "notice") });
  let calls = 0;
  const peer = new FakePeer("claude", async () => { if (++calls === 1) throw new Error("socket disappeared"); });
  bus.add(peer);
  bus.publish(newEnvelope("user", "uncertain", { to: ["claude"], priority: "important" }));
  await waitFor(() => durable.list("claude").some((row) => row.state === "needs_review"), "the review hold");
  bus.publish(newEnvelope("hub", "notice", { to: ["claude"], kind: "task", refs: { task: "1" } }));
  closed = true;
  await Bun.sleep(20);
  const review = durable.list("claude").find((row) => row.state === "needs_review")!;
  expect(review).toBeDefined(); // not resolved by anything but an operator
  expect(durable.list("claude").some((row) => row.state === "discarded")).toBe(false); // held: nothing drained
  bus.resolveDelivery(review.id, review.revision, "discard", "operator checked the peer");
  await waitFor(() => durable.list("claude").some((row) => row.reason?.startsWith("stale:")), "the stale discard");
  expect(durable.get(review.id)!.reason).toBe("operator checked the peer");
  expect(calls).toBe(1);
  durable.close();
});


test("an uncertain native receipt retains needs_review instead of fabricating completion", async () => {
  const { bus, durable } = setupBus();
  let receiptRecorded = false;
  const peer = new FakePeer("claude", async (_envs, id) => {
    peer.onDelivery?.({ id: id!, state: "needs_review", reason: "native outcome unknown" });
    receiptRecorded = true;
  });
  bus.add(peer);
  bus.publish(newEnvelope("user", "uncertain", { to: ["claude"], priority: "important" }));
  await waitFor(() => receiptRecorded, "the native receipt callback");
  try {
    expect(durable.list("claude")[0]?.state).toBe("needs_review");
    expect(bus.queueList("claude")[0]?.state).toBe("needs_review");
  } finally { bus.closeJournal(); }
});
