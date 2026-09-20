import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal, type JournalDelivery } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
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
