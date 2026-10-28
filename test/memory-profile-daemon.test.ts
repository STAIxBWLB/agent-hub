import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CandidateStore, MemoryStore, memoryProjectKey, migrate, realPath, type SyncResult } from "@staix/agent-mem";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type DaemonOptions, type HubConfig } from "../src/hub/daemon.ts";
import { MemoryTelemetry } from "../src/hub/memory-candidates.ts";

// Real daemon/control transports and the installed package, with synthetic homes only.
// The package CLI's explicit person/TTY context is a fixture seam, not native terminal evidence.
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const G = "e".repeat(32);

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-profile-daemon-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), memoryDir = join(root, "independent-memory"), stateDir = join(cwd, "state");
  mkdirSync(stateDir, { recursive: true });
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.AMEM_HOME = memoryDir;
  process.env.AGENTHUB_HOME = join(root, "other-parent");
  cleanup.push(() => {
    for (const key of ["AMEM_HOME", "AGENTHUB_HOME"] as const) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });
  return { root, cwd, memoryDir, stateDir, project: memoryProjectKey(cwd) };
}

function legacyRows(memoryDir: string): Record<string, string> {
  return Object.fromEntries(["log", "local"].flatMap(dir => {
    const path = join(memoryDir, dir);
    return existsSync(path) ? readdirSync(path).filter(name => name.endsWith(".jsonl")).sort().map(name => [`${dir}/${name}`, readFileSync(join(path, name), "utf8")]) : [];
  }));
}

async function hub(f: ReturnType<typeof fixture>, memory: Partial<HubConfig["memory"]> = {}, options: Partial<DaemonOptions> = {}) {
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.stateDir, projectId: "p-profile", instanceId: "i-profile",
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, ...options,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true, sync_interval_min: 0, ...memory } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" }); cleanup.push(() => person.close());
  const peer = await ControlClient.connect(f.stateDir, { role: "peer", peer: "worker" }); cleanup.push(() => peer.close());
  const recipient = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => recipient.close());
  for (const name of ["worker", "claude"]) {
    for (let attempt = 0; attempt < 200 && daemon.bus.peers.get(name)?.state !== "idle"; attempt++) await Bun.sleep(10);
    expect(daemon.bus.peers.get(name)?.state).toBe("idle");
  }
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "worker" }); cleanup.push(() => tools.close());
  const task = (op: string, args: Record<string, unknown>) => tools.request({ t: "task", op, args });
  const status = async () => {
    const reply = await person.request({ t: "status" });
    expect(reply.t).toBe("status");
    expect(typeof reply.status?.memoryProfile).toBe("object");
    expect(reply.status.memoryProfile).not.toBeNull();
    return reply.status.memoryProfile;
  };
  return { daemon, person, peer, tools, task, status };
}

async function packageCli(argv: string[], cwd: string): Promise<string> {
  // Resolve from the exact installed package, never from the sibling agent-mem checkout.
  const path = join(dirname(fileURLToPath(import.meta.resolve("@staix/agent-mem"))), "cli.ts");
  const cli = await import(path) as { runCli: (args: string[], context: { cwd: string; env: Record<string, string>; stdinTTY: boolean }) => Promise<string> };
  return cli.runCli(argv, { cwd, env: {}, stdinTTY: true });
}

test("daemon default binding is shared v1 at AMEM_HOME independently of project state", async () => {
  const f = fixture(), h = await hub(f);
  expect(await h.status()).toMatchObject({ home: f.memoryDir, profile: "shared-v1", state: "ready", agentMemVersion: "0.12.0" });
  expect((await h.task("hub_remember", { text: "shared default synthetic note", kind: "finding" })).ok).toBe(true);
  const store = new MemoryStore(); cleanup.push(() => store.close());
  expect(store.list({ project: f.project }).some(note => note.text === "shared default synthetic note")).toBe(true);
  expect(existsSync(join(f.stateDir, "memory"))).toBe(false);
  expect(existsSync(join(f.memoryDir, "profile.json"))).toBe(false);
});

test("migrated daemon bridges legacy and package CLI and tools cross-read and cross-write only the generation", async () => {
  const f = fixture();
  const legacy = new MemoryStore({ profile: "shared-v1" });
  const oldId = legacy.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "legacy synthetic contract", about: [] });
  legacy.close();
  const original = legacyRows(f.memoryDir);
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const h = await hub(f);
  const receipt = await h.status();
  expect(receipt).toMatchObject({ home: f.memoryDir, profile: "generation", generation: G, state: "ready", agentMemVersion: "0.12.0" });
  expect(receipt.selectorRevision).toMatch(/^[a-f0-9]{64}$/);
  const old = await h.task("hub_memory_show", { ids: [oldId] });
  expect(old.ok).toBe(true); expect(old.text).toContain("legacy synthetic contract");
  const saved = await h.task("hub_remember", { text: "daemon synthetic generation contract", kind: "contract", horizon: "long" });
  expect(saved.ok).toBe(true); expect(saved.text).toContain("hub memory");
  const store = new MemoryStore(); cleanup.push(() => store.close());
  expect(store.profile.generation).toBe(G);
  const note = store.list({ project: f.project }).find(row => row.text === "daemon synthetic generation contract");
  expect(note).toBeDefined();
  expect(await packageCli(["show", note!.id, "--json"], f.cwd)).toContain("daemon synthetic generation contract");
  await packageCli(["demote", note!.id], f.cwd);
  const demoted = await h.task("hub_memory_show", { ids: [note!.id] });
  expect(demoted.ok).toBe(true); expect(demoted.text).toContain("short");
  const packageId = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "package synthetic cross write", about: [] });
  const packageRead = await h.task("hub_memory_show", { ids: [packageId] });
  expect(packageRead.ok).toBe(true); expect(packageRead.text).toContain("package synthetic cross write");
  expect(legacyRows(f.memoryDir)).toEqual(original);
  expect(existsSync(join(f.memoryDir, "candidates.db"))).toBe(true);
  expect(existsSync(join(f.memoryDir, "generations", G, "candidates.db"))).toBe(false);
  expect(existsSync(join(f.root, "other-parent", "memory"))).toBe(false);
  // agent-mem 0.7.0 integrates candidate review on a generation home (agent-mem#40 F8/F9, its #419 replaced the "not yet integrated" ceiling): an empty queue lists as [], and the legacy log stays byte-unchanged.
  expect(JSON.parse(await packageCli(["review", "--json"], f.cwd))).toEqual([]);
  expect(legacyRows(f.memoryDir)).toEqual(original);
});

for (const invalid of ["invalid selector", "missing generation"] as const) {
  test(`${invalid} leaves daemon bus and board running without legacy fallback`, async () => {
    const f = fixture();
    const legacy = new MemoryStore({ profile: "shared-v1" }); legacy.close();
    const original = legacyRows(f.memoryDir);
    writeFileSync(join(f.memoryDir, "profile.json"), invalid === "invalid selector" ? "not JSON\n" : JSON.stringify({ schema: "agent-mem.profile/v1", kind: "generation", generation: G }));
    const h = await hub(f);
    expect(await h.status()).toMatchObject({ state: "unavailable", agentMemVersion: "0.12.0" });
    const result = await h.task("hub_remember", { text: "must never fall back to legacy", kind: "finding" });
    expect(`${result.text ?? ""} ${result.error ?? ""}`).not.toContain("saved to shared memory");
    const board = await h.task("hub_task_list", {}); expect(board.ok).toBe(true);
    expect(await h.person.request({ t: "status" })).toMatchObject({ t: "status", status: { memoryProfile: { state: "unavailable" } } });
    expect(legacyRows(f.memoryDir)).toEqual(original);
    expect(existsSync(join(f.memoryDir, "candidates.db"))).toBe(false);
  });
}

test("selector change fences retained daemon notes, corrections and citation counters without stopping the bus", async () => {
  const f = fixture();
  const initial = new MemoryStore({ profile: "shared-v1" }); initial.close();
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const h = await hub(f);
  await h.task("hub_remember", { text: "citation target generation note", kind: "contract", horizon: "long" });
  const reader = new MemoryStore(); cleanup.push(() => reader.close());
  const target = reader.list({ project: f.project }).find(note => note.text === "citation target generation note");
  expect(target).toBeDefined();
  const correction = await h.task("hub_memory_correct", { id: target!.id, text: "synthetic proposed replacement", reason: "synthetic fixture correction" });
  expect(correction.ok).toBe(true); expect(correction.text).toContain("candidate:");
  const sidecar = new CandidateStore(); cleanup.push(() => sidecar.close());
  const beforeCandidates = sidecar.list({ project: f.project, status: "all" });
  expect(beforeCandidates).toHaveLength(1);
  // Ordinary native peer messaging reaches the daemon's retained citation observer.
  const citation = await h.tools.request({ t: "send", body: `mem:${target!.id} synthetic citation before switch`, to: ["claude"] });
  expect(citation).toMatchObject({ t: "sent", ok: true, targets: ["claude"] });
  const beforeCounters = sidecar.counters(f.project);
  expect(beforeCounters.some(counter => counter.cited === 1)).toBe(true);
  const ownedBefore = legacyRows(join(f.memoryDir, "generations", G));
  const legacyBefore = legacyRows(f.memoryDir);
  writeFileSync(join(f.memoryDir, "profile.json"), JSON.stringify({ schema: "agent-mem.profile/v1", kind: "shared-v1" }));
  expect(await h.status()).toMatchObject({ profile: "generation", generation: G, state: "unavailable" });
  await h.task("hub_remember", { text: "forbidden stale generation note", kind: "finding" });
  const refused = await h.task("hub_memory_correct", { id: target!.id, text: "forbidden stale candidate", reason: "selector has changed" });
  expect(refused.ok).toBe(false);
  const postCitation = await h.tools.request({ t: "send", body: `mem:${target!.id} synthetic citation after switch`, to: ["claude"] });
  expect(postCitation).toMatchObject({ t: "sent", ok: true, targets: ["claude"] });
  expect((await h.task("hub_task_list", {})).ok).toBe(true);
  expect(sidecar.list({ project: f.project, status: "all" })).toEqual(beforeCandidates);
  expect(sidecar.counters(f.project)).toEqual(beforeCounters);
  expect(legacyRows(join(f.memoryDir, "generations", G))).toEqual(ownedBefore);
  expect(legacyRows(f.memoryDir)).toEqual(legacyBefore);
});

test("telemetry checks profile entry before reading and rechecks before counter writes", () => {
  const f = fixture(), store = new MemoryStore(); cleanup.push(() => store.close());
  const id = store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic telemetry target", about: [] });
  const sidecar = new CandidateStore(); cleanup.push(() => sidecar.close());
  const list = store.list.bind(store);
  let reads = 0, current = false;
  store.list = (...args) => { reads++; return list(...args); };
  const check = () => { if (!current) throw new Error("synthetic stale binding"); };
  const stale = new MemoryTelemetry(sidecar, store, f.project, rows => rows, check);
  for (const field of ["rendered", "delivered", "cited"] as const) stale.record(`mem:${id}`, { deliveryId: `stale-${field}` }, field);
  expect(reads).toBe(0); expect(sidecar.counters(f.project)).toEqual([]);
  current = true;
  const changesDuringProjection = new MemoryTelemetry(sidecar, store, f.project, rows => {
    if (rows.some(row => row.text === "synthetic telemetry target")) current = false;
    return rows;
  }, check);
  changesDuringProjection.record(`mem:${id}`, { deliveryId: "changed-before-counter" }, "cited");
  expect(reads).toBe(1); expect(current).toBe(false);
  expect(sidecar.counters(f.project)).toEqual([]);
});


test("disk status keeps the reduced memory receipt while authenticated console retains full binding", async () => {
  const f = fixture(), legacy = new MemoryStore({ profile: "shared-v1" }); legacy.close();
  await migrate({ memoryDir: f.memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const h = await hub(f), full = await h.status();
  expect(full).toMatchObject({ home: f.memoryDir, generation: G, profile: "generation", state: "ready", agentMemVersion: "0.12.0" });
  expect(full.selectorRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(typeof full.skippedRows).toBe("number");
  const disk = JSON.parse(readFileSync(join(f.stateDir, "status.json"), "utf8")) as { memoryProfile: Record<string, unknown> };
  expect(disk.memoryProfile).toMatchObject({ profile: "generation", generation: G.slice(0, 8), state: "ready", agentMemVersion: "0.12.0" });
  for (const field of ["home", "selectorRevision", "skippedRows"]) expect(disk.memoryProfile).not.toHaveProperty(field);
  const rendered = JSON.stringify(disk.memoryProfile);
  expect(rendered).not.toContain(f.memoryDir);
  expect(rendered).not.toContain(G);
  expect(rendered).not.toContain(full.selectorRevision);
});

for (const mode of ["disabled", "unavailable"] as const) {
  test(`authenticated console reports an unbound ${mode} receipt without a profile`, async () => {
    const f = fixture();
    if (mode === "unavailable") {
      mkdirSync(f.memoryDir, { recursive: true });
      writeFileSync(join(f.memoryDir, "profile.json"), "{invalid selector");
    }
    const h = await hub(f, { native: mode !== "disabled" });
    const unbound = await h.status();
    expect(unbound).toMatchObject({ state: mode, home: f.memoryDir, agentMemVersion: "0.12.0" });
    expect(unbound).not.toHaveProperty("profile");
    expect(unbound).not.toHaveProperty("generation");
    expect(unbound).not.toHaveProperty("selectorRevision");
    expect(unbound).not.toHaveProperty("skippedRows");
  });
}

test("scheduled memory sync checks the selected profile before invoking the sync dependency", async () => {
  const f = fixture();
  let scheduled: (() => void) | undefined;
  const originalInterval = globalThis.setInterval;
  let resolveSync!: (value: SyncResult) => void;
  const completed = new Promise<SyncResult>(resolve => { resolveSync = resolve; });
  let calls = 0;
  globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0], milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 7 * 60_000 && typeof handler === "function") scheduled = () => { Reflect.apply(handler, undefined, args); };
    return Reflect.apply(originalInterval, globalThis, [handler, milliseconds, ...args]);
  }) as typeof setInterval;
  let h: Awaited<ReturnType<typeof hub>>;
  try {
    h = await hub(f, { sync_interval_min: 7 }, { memorySync: () => { calls++; return completed; } });
  } finally { globalThis.setInterval = originalInterval; }
  expect(scheduled).toBeDefined();
  scheduled!();
  expect(calls).toBe(1);
  resolveSync({ ok: true, pushed: false, entries: 0 });
  // syncNow registered its await before this await, so its finally clears syncRun
  // before the test fires the same scheduled callback again.
  await completed;
  writeFileSync(join(f.memoryDir, "profile.json"), "{changed selector");
  scheduled!();
  expect(calls).toBe(1);
  expect(await h.status()).toMatchObject({ state: "unavailable" });
  expect((await h.task("hub_task_list", {})).ok).toBe(true);
});
