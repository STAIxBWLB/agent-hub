import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, MAX_ATTEMPTS, DIGEST_MAX, PULL_BUDGET_BYTES, NOTES_KEPT, type BusEvent } from "../src/hub/bus.ts";
import { DeliveryJournal, TERMINAL_CAP } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, noteLine, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { busOperationalReaders, OPERATIONAL_NUMBERS, type BusOperationalConfig } from "../src/hub/operational-settings.ts";
import { configApply, validateRawConfig, validateOperationalConfig } from "../src/hub/config-apply.ts";
import { checkSettingValue, settingDef } from "../src/hub/settings.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rows = OPERATIONAL_NUMBERS.filter(def => def.key.startsWith("bus."));
const defaults = [MAX_ATTEMPTS, DIGEST_MAX, PULL_BUDGET_BYTES, NOTES_KEPT, TERMINAL_CAP];
const until = async (condition: () => boolean) => {
  for (let n = 0; n < 400 && !condition(); n++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};
class Peer extends BasePeer {
  batches: Envelope[][] = [];
  fail = false;
  quota = false;
  beforeFailure?: () => void;
  constructor(id: string, readonly pullOnly = false) { super(id); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
  async deliver(envs: Envelope[], deliveryId?: string) {
    this.setState("busy"); this.batches.push(envs);
    if (this.fail) {
      this.beforeFailure?.();
      if (deliveryId) this.onDelivery?.({ id: deliveryId, state: "failed_safe", ...(this.quota ? { quota: true as const } : {}) });
      else this.onFailed?.(envs, this.quota ? { quota: true } : undefined);
    }
  }
}
function bus(config: () => BusOperationalConfig, pullOnly = false) {
  const b = new Bus({ batchMs: 0, ...busOperationalReaders(config) }), p = new Peer("claude", pullOnly);
  b.add(p); cleanup.push(() => p.stop(), () => b.closeJournal());
  return { b, p };
}

test("#489 H3 defaults remain the five original constants, and all bounds/apply/UI checks share H1", () => {
  expect(defaults).toEqual([3, 10, 65_536, 10, 2048]);
  expect(rows).toHaveLength(5);
  for (const [index, row] of rows.entries()) {
    expect(row.defaultValue).toBe(defaults[index]!);
    expect(configApply(row.key)).toEqual({ applies: "live" });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ min: 1, max: row.max, type: "integer", applies: "live" });
    for (const value of [1, row.defaultValue, row.max]) {
      expect(checkSettingValue(def, value)).toBe(value);
      expect(() => validateRawConfig({ bus: { [row.path[1]!]: value } })).not.toThrow();
      expect(() => validateOperationalConfig({ bus: { [row.path[1]!]: value } })).not.toThrow();
    }
    for (const value of [0, -1, 1.5, row.max + 1, NaN, Infinity, "2", null]) {
      if (value === null) expect(checkSettingValue(def, value)).toBeNull(); // UI inherit removes the local leaf
      else expect(() => checkSettingValue(def, value)).toThrow();
      expect(() => validateRawConfig({ bus: { [row.path[1]!]: value } })).toThrow(row.key);
      expect(() => validateOperationalConfig({ bus: { [row.path[1]!]: value } })).toThrow(row.key);
    }
    if (row.key !== "bus.max_attempts") expect(row.max).toBe(row.defaultValue); // four existing ceilings only tighten
  }
});

test("#489 unset readers preserve legacy digest, pull and preface text", () => {
  for (const pullOnly of [false, true]) {
    const legacy = new Bus({ batchMs: 0 }), { b } = bus(() => ({}), pullOnly);
    const peer = new Peer("claude", pullOnly); legacy.add(peer);
    cleanup.push(() => peer.stop(), () => legacy.closeJournal());
    for (let n = 0; n < 12; n++) {
      const env = newEnvelope("user", `${n}: ${"x".repeat(7000)}`, { to: ["claude"] });
      legacy.publish(env); b.publish(env);
      for (const target of [legacy, b]) target.note("claude", noteLine("codex", "finding", `note ${n}`));
    }
    expect(b.snapshot(false).prefaces.claude!.body).toBe(legacy.snapshot(false).prefaces.claude!.body);
    const normalized = (envs: Envelope[]) => envs.map(env => env.from === "hub" ? { body: env.body, kind: env.kind } : env);
    expect(normalized(b.pull("claude")!)).toEqual(normalized(legacy.pull("claude")!));
    expect(b.queueIds("claude")).toEqual(legacy.queueIds("claude"));
  }
});

test("#489 digest reload leaves queued order intact and applies at the next take", () => {
  let config: BusOperationalConfig = { bus: { digest_max: 2 } };
  const { b } = bus(() => config);
  const envs = ["first", "second", "important", "last"].map((body, n) => newEnvelope("user", body, { to: ["claude"], priority: n === 2 ? "important" : "status" }));
  envs.forEach(env => b.publish(env));
  expect(b.pull("claude")!.map(env => env.body)).toEqual(["important", "first"]);
  const before = b.snapshot(false);
  config = { bus: { digest_max: 1 } };
  expect(b.snapshot(false)).toEqual(before);
  expect(b.pull("claude")!.map(env => env.body)).toEqual(["second"]);
  expect(b.pull("claude")!.map(env => env.body)).toEqual(["last"]);
});

test("#489 pull budget reload keeps FIFO and lets the first oversized item through", () => {
  let config: BusOperationalConfig = { bus: { pull_budget_bytes: 1 } };
  const { b } = bus(() => config, true);
  const envs = ["big".repeat(1000), "second", "third"].map(body => newEnvelope("user", body, { to: ["claude"] }));
  envs.forEach(env => b.publish(env));
  expect(b.pull("claude")!.map(env => env.id)).toEqual([envs[0]!.id]);
  const before = b.snapshot(false);
  config = { bus: { pull_budget_bytes: 65_536 } };
  expect(b.snapshot(false)).toEqual(before);
  expect(b.pull("claude")!.map(env => env.id)).toEqual(envs.slice(1).map(env => env.id));
});

test("#489 notes reload trims only on the next merge and preserves non-note recall", () => {
  let config: BusOperationalConfig = {};
  const { b } = bus(() => config);
  b.preface("claude", "retained recall");
  for (let n = 0; n < 4; n++) b.note("claude", noteLine("codex", "finding", `n${n}`));
  const before = b.snapshot(false);
  config = { bus: { notes_kept: 2 } };
  expect(b.snapshot(false)).toEqual(before);
  b.note("claude", noteLine("codex", "finding", "n4"));
  expect(b.snapshot(false).prefaces.claude!.body).toBe("retained recall\n\nnote from codex [finding]: n3\nnote from codex [finding]: n4");
});

test("#489 retry reload uses existing counts, keeps poison alone and exempts a paused quota refusal", async () => {
  let config: BusOperationalConfig = { bus: { max_attempts: 4 } };
  const { b, p } = bus(() => config), events: BusEvent[] = [];
  b.tap(event => events.push(event)); p.fail = true; await p.start();
  const first = newEnvelope("user", "poison", { to: [p.id] }); b.publish(first);
  await until(() => b.attemptState()[`${p.id}:${first.id}`] === 1);
  const before = b.snapshot(false);
  config = { bus: { max_attempts: 2 } };
  expect(b.snapshot(false)).toEqual(before);
  const next = newEnvelope("user", "innocent", { to: [p.id] }); b.publish(next);
  p.set("idle");
  await until(() => events.some(event => event.t === "undeliverable" && event.env.id === first.id));
  expect(p.batches[1]!.map(env => env.id)).toEqual([first.id]);
  expect(b.queueIds(p.id)).toEqual([next.id]);
  p.quota = true; p.beforeFailure = () => b.pause(p.id); p.set("idle");
  await until(() => p.batches.length === 3);
  expect(b.queueIds(p.id)).toEqual([next.id]);
  expect(b.attemptState()).toEqual({});
});

test("#489 a failed in-flight preface merges under the current note limit without losing recall", async () => {
  let config: BusOperationalConfig = { bus: { notes_kept: 3 } };
  const { b, p } = bus(() => config);
  b.preface(p.id, "retained recall");
  for (let n = 0; n < 3; n++) b.note(p.id, noteLine("codex", "finding", `old ${n}`));
  p.fail = true;
  p.beforeFailure = () => {
    config = { bus: { notes_kept: 1 } };
    b.note(p.id, noteLine("codex", "finding", "arrived during delivery"));
  };
  await p.start();
  const env = newEnvelope("user", "safe failure", { to: [p.id] }); b.publish(env);
  await until(() => b.attemptState()[`${p.id}:${env.id}`] === 1);
  expect(b.snapshot(false).prefaces[p.id]!.body).toBe("retained recall\n\n\nnote from codex [finding]: arrived during delivery");
});

test("#489 terminal history reload prunes only at settlement and preserves unresolved retry ancestry", () => {
  let config: BusOperationalConfig = { bus: { terminal_history_limit: 3 } };
  const dir = mkdtempSync(join(tmpdir(), "ahub-operational-history-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i", terminalHistoryLimit: busOperationalReaders(() => config).terminalHistoryLimit });
  cleanup.push(() => journal.close());
  const env = newEnvelope("user", "history");
  const terminal = (id: string) => journal.createDelivery({ id, peer: "claude", state: "completed", createdAt: env.ts, originals: [env], out: [env] });
  terminal("protected");
  journal.createDelivery({ id: "held", peer: "claude", state: "needs_review", previousId: "protected", createdAt: env.ts, originals: [env], out: [env] });
  terminal("a"); terminal("b");
  const before = journal.snapshot();
  config = { bus: { terminal_history_limit: 1 } };
  expect(journal.snapshot()).toEqual(before);
  journal.createDelivery({ id: "pending", peer: "claude", state: "queued", createdAt: env.ts, originals: [env], out: [env] });
  journal.transition("pending", "needs_review");
  expect(journal.list().filter(row => row.state === "completed")).toHaveLength(3);
  terminal("c");
  expect(journal.get("protected")?.state).toBe("completed");
  expect(journal.get("held")?.state).toBe("needs_review");
  expect(journal.get("c")?.state).toBe("completed");
  expect(journal.list().filter(row => row.state === "completed")).toHaveLength(2); // protected parent plus current receipt
  const held = journal.get("held")!;
  expect(journal.resolve(held.id, held.revision, "discard", "verified unnecessary").state).toBe("discarded");
  expect(journal.get("held")?.state).toBe("discarded");
  expect(journal.get("protected")?.state).toBe("completed");
  expect(journal.get("pending")?.state).toBe("needs_review");
});

test("#489 grouped handoff keeps both parents and retry ancestry open at history limit one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-grouped-history-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i", terminalHistoryLimit: () => 1 });
  cleanup.push(() => journal.close());
  const first = newEnvelope("user", "previously retried"), second = newEnvelope("user", "grouped neighbor");
  const ancestor = journal.createDelivery({ id: "ancestor", peer: "claude", state: "needs_review", createdAt: first.ts, originals: [first], out: [first] });
  journal.resolve(ancestor.id, ancestor.revision, "retry", "person inspected the first attempt");
  const parent = journal.list("claude").find(row => row.previousId === ancestor.id)!;
  const neighbor = journal.createDelivery({ id: "neighbor", peer: "claude", state: "queued", createdAt: parent.createdAt + 1, originals: [second], out: [second] });
  const snapshot = { schemaVersion: 1 as const, queues: { claude: [] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
  const handoff = journal.checkpointDelivery(snapshot, { id: "handoff", peer: "claude", state: "dispatching", createdAt: neighbor.createdAt + 1, originals: [first, second], out: [first, second] });
  expect(handoff.previousId).toBe(parent.id);
  for (const state of ["dispatching", "accepted", "needs_review"] as const) {
    if (state !== "dispatching") journal.transition(handoff.id, state);
    expect(journal.get(parent.id)?.state).toBe("discarded");
    expect(journal.get(neighbor.id)?.state).toBe("discarded");
    expect(journal.get(handoff.previousId!)?.previousId).toBe(ancestor.id);
    expect(journal.get(ancestor.id)?.state).toBe("failed");
  }
  const held = journal.get(handoff.id)!;
  expect(journal.resolve(held.id, held.revision, "completed", "verified the grouped work").state).toBe("completed");
  expect(journal.get(handoff.previousId!)?.previousId).toBe(ancestor.id);
  expect(journal.get(ancestor.id)?.state).toBe("failed");
  expect(journal.retryEvidence("claude", [first, second])).toBe("used");
});

test("#489 default history target also retains the current grouped receipt behind protected ancestry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-grouped-default-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  cleanup.push(() => journal.close());
  const first = newEnvelope("user", "first grouped"), second = newEnvelope("user", "second grouped");
  const snapshot = { schemaVersion: 1 as const, queues: { claude: [] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
  // Bulk fixture insertion avoids thousands of unrelated prune scans before the one transition under test.
  const protectedRows: Parameters<DeliveryJournal["persistBusAndDeliveries"]>[2] = [];
  for (let n = 0; n < TERMINAL_CAP - 1; n++) {
    const id = `protected-${n}`;
    protectedRows.push({ id, peer: "claude", state: "completed", createdAt: first.ts, originals: [first], out: [first] });
    protectedRows.push({ id: `open-${n}`, peer: "claude", state: "needs_review", previousId: id, createdAt: first.ts, originals: [first], out: [first] });
  }
  journal.persistBusAndDeliveries(snapshot, [], protectedRows);
  journal.createDelivery({ id: "group-a", peer: "claude", state: "queued", createdAt: first.ts + 1, originals: [first], out: [first] });
  journal.createDelivery({ id: "group-b", peer: "claude", state: "queued", createdAt: first.ts + 2, originals: [second], out: [second] });
  const handoff = journal.checkpointDelivery(snapshot, { id: "handoff", peer: "claude", state: "dispatching", createdAt: first.ts + 3, originals: [first, second], out: [first, second] });
  expect(journal.get("group-a")?.state).toBe("discarded");
  expect(journal.get("group-b")?.state).toBe("discarded");
  expect(journal.resolve(handoff.id, handoff.revision, "completed", "verified grouped work").state).toBe("completed");
  expect(journal.get(handoff.id)?.state).toBe("completed");
  expect(journal.get(handoff.previousId!)?.state).toBe("discarded");
  expect(journal.list().filter(row => row.state === "needs_review")).toHaveLength(TERMINAL_CAP - 1);
}, 20_000);

test("#489 failed grouped handoff rolls back parents and restores ordinary pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-grouped-rollback-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i", terminalHistoryLimit: () => 1 });
  cleanup.push(() => journal.close());
  const envs = [newEnvelope("user", "first"), newEnvelope("user", "second")];
  for (const [n, env] of envs.entries()) journal.createDelivery({ id: `parent-${n}`, peer: "claude", state: "queued", createdAt: env.ts + n, originals: [env], out: [env] });
  const before = journal.snapshot();
  const snapshot = { schemaVersion: 1 as const, queues: { claude: [] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
  expect(() => journal.checkpointDelivery(snapshot, { id: "parent-0", peer: "claude", state: "dispatching", createdAt: Date.now(), originals: envs, out: envs })).toThrow();
  expect(journal.snapshot()).toEqual(before);
  for (const id of ["terminal-a", "terminal-b"]) journal.createDelivery({ id, peer: "claude", state: "completed", createdAt: Date.now(), originals: envs, out: envs });
  expect(journal.get("terminal-a")).toBeUndefined();
  expect(journal.get("terminal-b")?.state).toBe("completed");
  expect(journal.get("parent-0")?.state).toBe("queued");
  expect(journal.get("parent-1")?.state).toBe("queued");
});

test("#489 five real daemon settings rows write, inherit and undo through the existing local file", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-bus-config-"))), state = join(cwd, ".agenthub/state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true })); mkdirSync(join(cwd, ".agenthub"));
  const shared = JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { auto_start: false }, research: { enabled: false }, snapshots: { enabled: false } });
  writeFileSync(join(cwd, ".agenthub/config.json"), shared);
  const daemon = await startDaemon({ cwd, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console", projectRoot: cwd }); cleanup.push(() => client.close());
  const instance = (await client.request({ t: "status" })).status.instanceId;
  for (const row of rows) {
    const get = async () => (await client.request({ t: "settings_get" })).rows.find((entry: { key: string }) => entry.key === row.key);
    expect(await get()).toMatchObject({ value: row.defaultValue, applies: "live" });
    const set = (value: unknown) => client.request({ t: "settings_set", key: row.key, value, reason: "bus settings regression" });
    expect((await set(1)).ok).toBe(true);
    expect((await get()).value).toBe(1);
    expect(loadConfig(cwd).bus?.[row.path[1] as keyof NonNullable<BusOperationalConfig["bus"]>]).toBe(1);
    // Exercise the daemon's constructor wiring as well as its settings projection.
    if (row.key === "bus.max_attempts") {
      const peer = new Peer("claude"), dropped: string[] = [];
      daemon.bus.add(peer); cleanup.push(() => peer.stop()); peer.fail = true;
      daemon.bus.tap(event => { if (event.t === "undeliverable") dropped.push(event.env.id); });
      await peer.start();
      const env = newEnvelope("user", "one-attempt fixture", { to: [peer.id] }); daemon.bus.publish(env);
      await until(() => dropped.includes(env.id));
      expect(peer.batches).toHaveLength(1);
      expect(daemon.bus.queueIds(peer.id)).not.toContain(env.id);
      await peer.stop();
    } else if (row.key === "bus.digest_max" || row.key === "bus.pull_budget_bytes") {
      if (row.key === "bus.pull_budget_bytes") daemon.bus.add(new Peer("claude", true));
      const envs = [0, 1].map(n => newEnvelope("user", `${n}: ${"x".repeat(2000)}`, { to: ["claude"] }));
      envs.forEach(env => daemon.bus.publish(env));
      const ids = new Set(envs.map(env => env.id));
      expect(daemon.bus.pull("claude")!.filter(env => ids.has(env.id)).map(env => env.id)).toEqual([envs[0]!.id]);
      expect(daemon.bus.pull("claude")!.filter(env => ids.has(env.id)).map(env => env.id)).toEqual([envs[1]!.id]);
    } else if (row.key === "bus.notes_kept") {
      daemon.bus.preface("claude", "daemon recall");
      daemon.bus.note("claude", noteLine("codex", "finding", "first"));
      daemon.bus.note("claude", noteLine("codex", "finding", "second"));
      expect(daemon.bus.snapshot(false).prefaces.claude!.body).toBe("daemon recall\n\nnote from codex [finding]: second");
      daemon.bus.pull("claude");
    } else if (row.key === "bus.terminal_history_limit") {
      daemon.bus.publish(newEnvelope("user", "terminal fixture", { to: ["claude"] }));
      daemon.bus.pull("claude");
      expect(daemon.bus.queueList("claude").filter(delivery => delivery.state === "completed")).toHaveLength(1);
    }
    const saved = readFileSync(join(cwd, ".agenthub/config.local.json"), "utf8");
    expect((await set(row.max + 1)).ok).toBe(false);
    expect(readFileSync(join(cwd, ".agenthub/config.local.json"), "utf8")).toBe(saved);
    expect((await set(null)).ok).toBe(true);
    expect((await get()).value).toBe(row.defaultValue);
    expect((await client.request({ t: "settings_undo", reason: "restore bus override" })).ok).toBe(true);
    expect((await get()).value).toBe(1);
    expect((await set(null)).ok).toBe(true);
  }
  expect((await client.request({ t: "status" })).status.instanceId).toBe(instance);
  expect(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).toBe(shared);
}, 20_000);
