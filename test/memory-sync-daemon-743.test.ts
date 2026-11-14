import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey, realPath, syncMemory, type SyncResult } from "@staix/agent-mem";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type DaemonOptions } from "../src/hub/daemon.ts";

// Real daemon/control transports and package storage in synthetic homes. The success
// result seam tests projection only: it does not activate v3 or attest a placement.
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-sync-daemon-743-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), memoryDir = join(root, "memory"), stateDir = join(cwd, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.AMEM_HOME = memoryDir;
  process.env.AGENTHUB_HOME = join(root, "parent");
  cleanup.push(() => {
    for (const key of ["AMEM_HOME", "AGENTHUB_HOME"] as const) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });
  // agent-mem 0.26.0 reads the configured transport before outbound screening; a real private
  // remote keeps the decline reachable. The decline stops the pass before any fetch or push.
  const remote = join(root, "remote.git");
  const init = Bun.spawnSync(["git", "init", "-q", "--bare", remote], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  return { cwd, memoryDir, stateDir, remote };
}

async function hub(f: ReturnType<typeof fixture>, memorySync: NonNullable<DaemonOptions["memorySync"]>) {
  let syncNow: (() => Promise<void>) | undefined;
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.stateDir, projectId: "p-sync-743", instanceId: "i-sync-743",
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, memorySync,
    memorySyncTrigger: run => { syncNow = run; },
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true, sync_interval_min: 10 } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" });
  cleanup.push(() => person.close());
  return { person, syncNow: async () => { if (!syncNow) throw new Error("sync trigger not bound"); await syncNow(); },
    status: async () => {
      const reply = await person.request({ t: "status" });
      expect(reply.t).toBe("status");
      return reply.status.memoryProfile.sync;
    },
    snapshot: async () => (await person.request({ t: "ui_snapshot", after: 0, view: "memory" })).memorySync };
}

function excludesPrivate(sync: unknown, canaries: readonly string[]) {
  const publicText = JSON.stringify(sync);
  for (const canary of canaries) expect(publicText).not.toContain(canary);
}

test("trusted successful placement counts pass through the real daemon status and dashboard projection (#1173)", async () => {
  const f = fixture();
  const canaries = ["PRIVATE-ATTEMPT-HASH-743", "PRIVATE-POLICY-HASH-743", "PRIVATE-ROW-TEXT-743"];
  const placementPublication: NonNullable<SyncResult["placementPublication"]> = { outcome: "committed", withheld: 2, exported: 5,
    attemptHash: canaries[0], lastPolicyHash: canaries[1], policyCeiling: "last-positive-check-before-in-flight-push" };
  const h = await hub(f, async () => ({ ok: true, pushed: false, entries: 5, placementPublication, warning: canaries[2] }));
  expect(await h.status()).toEqual({ state: "notrun" });
  await h.syncNow();
  for (const sync of [await h.status(), await h.snapshot()]) {
    excludesPrivate(sync, canaries);
    expect(Object.keys(sync).sort()).toEqual(["at", "exportedCount", "state", "withheldCount"]);
    expect(sync.state).toBe("ok");
    expect(sync.withheldCount).toBe(2);
    expect(sync.exportedCount).toBe(5);
  }
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
  for (const canary of canaries) expect(log).not.toContain(canary);
  expect(log).not.toContain("hub memory sync failed:");
});

test("a real package legacy backlog decline reaches daemon status as placement inactive without row text (#1173)", async () => {
  const f = fixture(), canary = "PRIVATE-LEGACY-BACKLOG-743";
  writeFileSync(join(f.memoryDir, "amem.config.json"), JSON.stringify({ piiPatterns: [canary] }));
  // Raw SDK seeding models an existing legacy backlog, bypassing hub write-time
  // refusal without changing that refusal or manufacturing a v3 attestation.
  const store = new MemoryStore({ memoryDir: f.memoryDir, profile: "shared-v1" });
  let id: string;
  try {
    id = store.note({ op: "note", project: memoryProjectKey(f.cwd), scope: "project", tier: "long", kind: "decision",
      peer: "person", source: "person", text: canary, about: [] });
  } finally { store.close(); }
  const h = await hub(f, (memory, options) => syncMemory(memory, { ...options, remote: f.remote, visibility: async () => "private" }));
  await h.syncNow();
  for (const sync of [await h.status(), await h.snapshot()]) {
    excludesPrivate(sync, [canary, id!]);
    expect(sync.state).toBe("failed");
    expect(sync.cause).toBe("declined");
    expect(sync.declinedCount).toBe(1);
    expect(sync.placementActive).toBe(false);
    expect(sync.nextStep).toBe("ahub memory declined");
    expect(sync).not.toHaveProperty("withheldCount");
    expect(sync).not.toHaveProperty("exportedCount");
  }
  await h.syncNow();
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
  expect(log.match(/hub memory sync failed: declined/g)).toHaveLength(1);
  excludesPrivate(log, [canary, id!]);
});
