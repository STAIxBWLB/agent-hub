import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, type BusOptions } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { DIGEST, newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";

type Observation = { peer: string; id: string; out: Envelope[]; field: "rendered" | "delivered"; state: string | undefined };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

class ReceiptPeer implements PeerAdapter {
  state: PeerState = "idle";
  readonly batches: { id: string; out: Envelope[] }[] = [];
  onState?: PeerAdapter["onState"];
  onDelivery?: PeerAdapter["onDelivery"];
  constructor(readonly id = "codex", readonly pullOnly = false) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  set(state: PeerState): void { this.state = state; this.onState?.(state); }
  async deliver(out: Envelope[], id?: string): Promise<void> {
    if (!id) throw new Error("fixture requires a journal delivery id");
    this.set("busy");
    this.batches.push({ id, out });
  }
}

function setup(options: Partial<BusOptions> = {}, pullOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-memory-delivery-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "fixture", instanceId: "fixture" });
  const bus = new Bus({ batchMs: 0, retryMs: 1, journal, ...options });
  cleanup.push(() => { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); });
  const observations: Observation[] = [];
  bus.onMemoryDelivery = (peer, id, out, field) => observations.push({ peer, id, out: structuredClone(out), field, state: journal.get(id)?.state });
  const peer = new ReceiptPeer("codex", pullOnly);
  bus.add(peer);
  return { bus, journal, peer, observations };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

function publish(bus: Bus, body = "mem:12345678 fail long: avoid this approach", isPrivate = false): Envelope {
  const env = newEnvelope("user", body, { to: ["codex"], private: isPrivate });
  bus.publish(env);
  return env;
}

test("memory delivery observes durable push once and the first positive receipt once", async () => {
  const { bus, peer, observations, journal } = setup();
  const env = publish(bus);
  await waitFor(() => peer.batches.length === 1);
  const { id } = peer.batches[0]!;
  expect(observations).toEqual([{ peer: "codex", id, out: [env], field: "rendered", state: "dispatching" }]);
  // A different peer cannot acknowledge this recipient's delivery.
  bus.deliveryReceipt("claude", { id, state: "completed" });
  expect(observations).toHaveLength(1);
  for (const state of ["accepted", "accepted", "completed", "completed"] as const) peer.onDelivery?.({ id, state });
  expect(observations.map(o => [o.id, o.field, o.state])).toEqual([[id, "rendered", "dispatching"], [id, "delivered", "accepted"]]);
  expect(observations[1]!.out).toEqual([env]);
  expect(journal.get(id)?.state).toBe("completed");
});

test("a direct completed receipt and a correlated reply each observe delivery only once", async () => {
  for (const reply of [false, true]) {
    const { bus, peer, observations, journal } = setup();
    const env = publish(bus);
    await waitFor(() => peer.batches.length === 1);
    const { id } = peer.batches[0]!;
    if (reply) { bus.completeReply("codex", env.id); bus.completeReply("codex", env.id); }
    else peer.onDelivery?.({ id, state: "completed" });
    peer.onDelivery?.({ id, state: "accepted" });
    peer.onDelivery?.({ id, state: "completed" });
    expect(observations.map(o => [o.field, o.state])).toEqual([["rendered", "dispatching"], ["delivered", "completed"]]);
    expect(journal.get(id)?.state).toBe("completed");
  }
});

test("failed_safe does not count delivered and its retry has its own observation id", async () => {
  const { bus, peer, observations, journal } = setup();
  const env = publish(bus);
  await waitFor(() => peer.batches.length === 1);
  const first = peer.batches[0]!.id;
  peer.onDelivery?.({ id: first, state: "failed_safe", reason: "not admitted" });
  expect(journal.get(first)?.state).toBe("failed");
  expect(observations.map(o => o.field)).toEqual(["rendered"]);
  expect(bus.queueIds("codex")).toEqual([env.id]);
  peer.set("idle");
  await waitFor(() => peer.batches.length === 2);
  const retry = peer.batches[1]!.id;
  expect(retry).not.toBe(first);
  expect(peer.batches[1]!.out).toEqual([env]);
  peer.onDelivery?.({ id: first, state: "completed" });
  peer.onDelivery?.({ id: retry, state: "completed" });
  expect(observations.map(o => [o.id, o.field])).toEqual([[first, "rendered"], [retry, "rendered"], [retry, "delivered"]]);
  expect(journal.get(retry)?.state).toBe("completed");
});

test("pull observes the completed journal transaction and an empty second pull adds nothing", () => {
  const { bus, peer, observations, journal } = setup({}, true);
  bus.preface("codex", "mem:abcdefgh contract long: retain this contract");
  const env = publish(bus);
  expect(observations).toEqual([]);
  const out = bus.pull("codex")!;
  expect(out.map(e => e.body)).toEqual(["mem:abcdefgh contract long: retain this contract", env.body]);
  expect(peer.batches).toEqual([]);
  expect(observations.map(o => [o.field, o.state])).toEqual([["rendered", "completed"], ["delivered", "completed"]]);
  expect(observations[0]!.id).toBe(observations[1]!.id);
  expect(observations[1]!.out).toEqual(out);
  expect(journal.get(observations[1]!.id)?.out).toEqual(out);
  expect(bus.pull("codex")).toEqual([]);
  expect(observations).toHaveLength(2);
});

test("a rolled-back pull restores queue and preface without publishing memory observations", () => {
  const { bus, journal, observations } = setup({}, true);
  bus.preface("codex", "mem:abcdefgh contract long: retain this contract");
  const env = publish(bus);
  const before = bus.snapshot();
  const journalBefore = journal.list("codex");
  const transition = journal.transition.bind(journal);
  let attemptedId: string | undefined;
  journal.transition = (...args) => {
    if (args[1] === "completed") {
      attemptedId = args[0];
      throw new Error("injected pull completion failure");
    }
    return transition(...args);
  };
  expect(() => bus.pull("codex")).toThrow("injected pull completion failure");
  expect(attemptedId).toBeDefined();
  expect(journal.get(attemptedId!)).toBeUndefined();
  expect(journal.list("codex")).toEqual(journalBefore);
  expect(bus.queueIds("codex")).toEqual([env.id]);
  expect(bus.snapshot().prefaces).toEqual(before.prefaces);
  expect(bus.storageError).toBe("delivery journal unavailable");
  expect(observations).toEqual([]);
});

test("condensation telemetry measures actual transport output rather than its originals", async () => {
  const condensed = newEnvelope(DIGEST, "mem:cccccccc decision long: condensed result", { to: ["codex"] });
  const { bus, peer, observations, journal } = setup({ condense: async () => [condensed] });
  peer.set("busy");
  const first = publish(bus, "mem:aaaaaaaa fail long: original fail");
  const second = publish(bus, "mem:bbbbbbbb contract long: original contract");
  peer.set("idle");
  await waitFor(() => peer.batches.length === 1);
  const { id, out } = peer.batches[0]!;
  expect(journal.get(id)?.originals).toEqual([first, second]);
  expect(out).toEqual([condensed]);
  peer.onDelivery?.({ id, state: "completed" });
  expect(observations.map(o => o.out)).toEqual([[condensed], [condensed]]);
});

test("private delivery payloads never reach memory telemetry while transport still receives them", async () => {
  const { bus, peer, observations, journal } = setup();
  const env = publish(bus, "synthetic private mem:dddddddd fail long: private example", true);
  await waitFor(() => peer.batches.length === 1);
  const { id, out } = peer.batches[0]!;
  expect(out).toEqual([env]);
  peer.onDelivery?.({ id, state: "completed" });
  expect(observations).toEqual([]);
  expect(journal.get(id)?.state).toBe("completed");
});

test("condensation cannot expose memory telemetry for private originals through a public output", async () => {
  const condensed = newEnvelope(DIGEST, "mem:eeeeeeee decision long: synthetic summary", { to: ["codex"] });
  const { bus, peer, observations, journal } = setup({ condense: async () => [condensed] });
  peer.set("busy");
  const privateEnv = publish(bus, "synthetic private original", true);
  const ordinaryEnv = publish(bus, "ordinary original");
  peer.set("idle");
  await waitFor(() => peer.batches.length === 1);
  const { id, out } = peer.batches[0]!;
  expect(out).toEqual([condensed]);
  expect(out[0]?.private).toBeUndefined();
  expect(journal.get(id)?.originals).toEqual([privateEnv, ordinaryEnv]);
  peer.onDelivery?.({ id, state: "completed" });
  expect(observations).toEqual([]);
  expect(journal.get(id)?.state).toBe("completed");
});

test("throwing memory observers cannot break push settlement or pull completion", async () => {
  for (const pullOnly of [false, true]) {
    const { bus, peer, journal } = setup({}, pullOnly);
    const fields: string[] = [];
    bus.onMemoryDelivery = (_peer, _id, _out, field) => { fields.push(field); throw new Error("telemetry unavailable"); };
    const env = publish(bus);
    if (pullOnly) expect(bus.pull("codex")).toEqual([env]);
    else {
      await waitFor(() => peer.batches.length === 1);
      peer.onDelivery?.({ id: peer.batches[0]!.id, state: "completed" });
    }
    expect(fields).toEqual(["rendered", "delivered"]);
    expect(journal.list("codex").map(row => row.state)).toEqual(["completed"]);
    expect(bus.queued("codex")).toBe(0);
  }
});
