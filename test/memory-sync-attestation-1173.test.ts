import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlacementWriterContextError, realPath, syncMemory, type SyncResult } from "@staix/agent-mem";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type DaemonOptions } from "../src/hub/daemon.ts";
import { hostPlacementAttestation, memorySyncErrorText, writerRefusalOf } from "../src/hub/memory-sync-attestation.ts";
import { memorySyncLine } from "../src/cli/status-lines.ts";
import { initialMemorySyncState, memorySyncView, reduceMemorySync } from "../src/hub/memory-sync-state.ts";

// Disposable memory home under tmpdir, AGENTHUB_HOME and AMEM_HOME pointed at it. The attestation is agent-mem's real
// createPlacementAttestation on a home with no active placement, so the refusal is the package's own typed error.
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-attest-1173-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), memoryDir = join(root, "memory"), stateDir = join(cwd, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  const prior = { HOME: process.env.HOME, AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.AMEM_HOME = memoryDir;
  process.env.AGENTHUB_HOME = join(root, "parent");
  cleanup.push(() => { for (const key of ["HOME", "AMEM_HOME", "AGENTHUB_HOME"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  return { cwd, memoryDir, stateDir };
}

async function hub(f: ReturnType<typeof fixture>, memorySync: NonNullable<DaemonOptions["memorySync"]>) {
  let syncNow: (() => Promise<void>) | undefined;
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.stateDir, projectId: "p-attest-1173", instanceId: "i-attest-1173",
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, memorySync, memorySyncTrigger: run => { syncNow = run; },
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true, sync_interval_min: 10 } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" });
  cleanup.push(() => person.close());
  return { syncNow: async () => { if (!syncNow) throw new Error("sync trigger not bound"); await syncNow(); },
    status: async () => (await person.request({ t: "status" })).status.memoryProfile.sync,
    snapshot: async () => (await person.request({ t: "ui_snapshot", after: 0, view: "memory" })).memorySync };
}

test("the daemon passes a placementAttestation to every syncMemory pass, bound to its memory home (#1173)", async () => {
  const f = fixture();
  const seen: unknown[] = [];
  const h = await hub(f, async (_store, options) => { seen.push(options?.placementAttestation); return { ok: true, pushed: false, entries: 0 } as SyncResult; });
  await h.syncNow();
  await h.syncNow();
  expect(seen).toHaveLength(2);
  for (const attest of seen) expect(typeof attest).toBe("function");
  expect(seen[0]).not.toBe(seen[1]); // one wrapper per pass: no cached proof crosses passes
});

test("a refused writer attestation names its category, cause and next step, once per episode, with no path or message (#1173)", async () => {
  const f = fixture();
  const canary = f.memoryDir;
  const h = await hub(f, async (_store, options) => {
    // The package's real attestation on a home without active placement throws its typed refusal; the transport turns that into a generic result.
    try { options!.placementAttestation!(); } catch { /* the transport swallows the throw into a generic result, as here */ }
    return { ok: false, pushed: false, entries: 0, error: "Placement sync is unavailable; verify the active epoch, selected sources, policy, private remote and writer pins before retrying." } as SyncResult;
  });
  await h.syncNow();
  for (const sync of [await h.status(), await h.snapshot()]) {
    expect(sync.state).toBe("failed");
    expect(sync.cause).toBe("writer");
    expect(sync.writerCategory).toBe("home floor");
    expect(sync.writerCauseClass).toBe("unavailable");
    expect(sync.nextStep).toContain("amem migrate --sync-placement --dry-run");
    expect(JSON.stringify(sync)).not.toContain(canary);
    const line = memorySyncLine(sync);
    expect(line).toContain("writer attestation refused: home floor, unavailable");
    expect(line).toContain("next: ");
    expect(line).not.toContain(canary);
  }
  await h.syncNow();
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
  expect(log.match(/hub memory sync failed: writer \(home floor, unavailable\); next: /g)).toHaveLength(1);
  expect(log).not.toContain(canary);
});

test("a PlacementWriterContextError thrown out of the sync is a writer failure, never unknown or a silent skip (#1173)", async () => {
  const f = fixture();
  const h = await hub(f, async () => { throw new PlacementWriterContextError("host package", "changed"); });
  await h.syncNow();
  const sync = await h.status();
  expect(sync).toMatchObject({ state: "failed", cause: "writer", writerCategory: "host package", writerCauseClass: "changed" });
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).toContain("hub memory sync failed: writer (host package, changed)");
});

test("a legacy store still syncs through the real syncMemory with the attestation present and unused (#1173)", async () => {
  const f = fixture();
  const h = await hub(f, (memory, options) => syncMemory(memory, { ...options, visibility: async () => "private" }));
  await h.syncNow();
  const sync = await h.status();
  expect(sync.cause).not.toBe("writer");
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("hub memory sync failed: writer");
});

test("hostPlacementAttestation keeps the first typed refusal, rethrows the error unchanged, and ignores untyped errors", () => {
  const typed = new PlacementWriterContextError("setup receipt", "missing");
  const a = hostPlacementAttestation("/unused", () => () => { throw typed; });
  expect(() => a.attest()).toThrow(typed);
  expect(a.refusal()).toEqual({ category: "setup receipt", causeClass: "missing" });
  const b = hostPlacementAttestation("/unused", () => () => { throw new Error("PRIVATE-PATH /home/x"); });
  expect(() => b.attest()).toThrow("PRIVATE-PATH");
  expect(b.refusal()).toBeUndefined();
  expect(writerRefusalOf(new Error("x"))).toBeUndefined();
  const forged = Object.assign(new Error("x"), { category: "running CLI", causeClass: "missing" });
  expect(writerRefusalOf(forged)).toBeUndefined();
});

test("writer status fields are closed words: an unknown value never reaches the view or the line", () => {
  const state = reduceMemorySync(initialMemorySyncState(), { type: "failure", at: 1, cause: "writer", writerCategory: "/Users/x/secret", writerCauseClass: "PRIVATE" }).state;
  const view = memorySyncView(state, "enabled");
  expect(view).toMatchObject({ state: "failed", cause: "writer" });
  expect(JSON.stringify(view)).not.toMatch(/secret|PRIVATE/);
  expect(memorySyncLine({ ...view, writerCategory: "/Users/x/secret" })).toContain("unknown, unavailable");
});


test("latched writer refusals outrank generic quiet, successful and thrown transport outcomes in actual hub status", async () => {
  const f = fixture();
  const outcomes = ["no generation sync remote configured", "stopped", "ok", "throw"];
  let pass = 0;
  const h = await hub(f, async (_store, options) => {
    try { options!.placementAttestation!(); } catch { /* SDK transport may replace the typed refusal. */ }
    const outcome = outcomes[pass++];
    if (outcome === "throw") throw new Error("no generation sync remote configured");
    return { ok: outcome === "ok", pushed: false, entries: 0, ...(outcome === "ok" ? {} : { error: outcome }) } as SyncResult;
  });
  for (const _outcome of outcomes) {
    await h.syncNow();
    for (const sync of [await h.status(), await h.snapshot()]) {
      expect(sync.state).toBe("failed"); expect(sync.cause).toBe("writer");
      expect(sync.writerCategory).toBe("home floor"); expect(sync.writerCauseClass).toBe("unavailable");
      expect(sync.nextStep).toContain("amem migrate --sync-placement --dry-run");
    }
  }
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
  expect(log.match(/hub memory sync failed: writer/g)).toHaveLength(1);
});

test("writer projection rejects proxies without traps and reports unknown SDK categories honestly", () => {
  const typed = new PlacementWriterContextError("host package", "changed");
  Object.defineProperty(typed, "category", { value: "PRIVATE_UNKNOWN_CATEGORY" });
  expect(writerRefusalOf(typed)).toEqual({ category: "unknown", causeClass: "changed" });
  let traps = 0;
  const proxy = new Proxy(typed, {
    getPrototypeOf() { traps++; throw new Error("PRIVATE_PROTOTYPE"); },
    getOwnPropertyDescriptor() { traps++; throw new Error("PRIVATE_DESCRIPTOR"); },
    get() { traps++; throw new Error("PRIVATE_GETTER"); },
  });
  expect(writerRefusalOf(proxy)).toBeUndefined(); expect(memorySyncErrorText(proxy)).toBeUndefined();
  const oddPrototype = Object.create(proxy);
  expect(writerRefusalOf(oddPrototype)).toBeUndefined();
  const accessor = new PlacementWriterContextError("host package", "changed");
  Object.defineProperty(accessor, "category", { get() { traps++; throw new Error("PRIVATE_CATEGORY"); } });
  Object.defineProperty(accessor, "message", { get() { traps++; throw new Error("PRIVATE_MESSAGE"); } });
  expect(writerRefusalOf(accessor)).toEqual({ category: "unknown", causeClass: "changed" });
  expect(memorySyncErrorText(accessor)).toBeUndefined();
  expect(traps).toBe(0);
  expect(memorySyncErrorText(new Error("stopped"))).toBe("stopped");
});

test("unknown SDK writer categories remain unknown in actual hub status without raw fields", async () => {
  const f = fixture();
  const typed = new PlacementWriterContextError("host package", "changed");
  Object.defineProperty(typed, "category", { value: "PRIVATE_UNKNOWN_CATEGORY" });
  const h = await hub(f, async () => { throw typed; });
  await h.syncNow();
  const sync = await h.status();
  expect(sync).toMatchObject({ state: "failed", cause: "writer", writerCategory: "unknown", writerCauseClass: "changed" });
  expect(memorySyncLine(sync)).toContain("writer attestation refused: unknown, changed");
  expect(JSON.stringify(sync)).not.toContain("PRIVATE_UNKNOWN_CATEGORY");
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("PRIVATE_UNKNOWN_CATEGORY");
});

test("an uninspectable proxy thrown by sync settles actual hub status as unknown without touching its traps", async () => {
  const f = fixture(); let traps = 0;
  const proxy = new Proxy(new Error("PRIVATE_ERROR"), { getPrototypeOf() { traps++; throw new Error("PRIVATE_TRAP"); }, get() { traps++; throw new Error("PRIVATE_GET"); } });
  const h = await hub(f, async () => { throw proxy; });
  await h.syncNow();
  const sync = await h.status();
  expect(sync).toMatchObject({ state: "failed", cause: "unknown" }); expect(traps).toBe(0);
  expect(JSON.stringify(sync)).not.toContain("PRIVATE_");
});


test("a per-pass attestation rethrows each original refusal but retains only its first typed cause", () => {
  const first = new PlacementWriterContextError("setup receipt", "missing"), later = new PlacementWriterContextError("host package", "changed");
  const pending = [first, later]; let calls = 0;
  const pass = hostPlacementAttestation("/unused", () => () => { throw pending[calls++]; });
  for (const expected of pending) {
    let observed: unknown;
    try { pass.attest(); } catch (error) { observed = error; }
    expect(observed).toBe(expected);
    expect(pass.refusal()).toEqual({ category: "setup receipt", causeClass: "missing" });
  }
});
