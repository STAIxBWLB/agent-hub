import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_MODEL } from "../src/hub/guidance-probes.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });

test("probe records are private same-db retained state with a stable recovery digest", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-recovery-")), file = join(root, "hub.db");
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new GuidanceProbeStore(file); clean.push(() => store.close());
  expect(store.hasRecords()).toBe(false);
  const fixture = guidanceProbeFixture();
  const registered = store.register(fixture.registration, fixture.host, () => fixture.host);
  const first = store.integrity();
  expect(first).toMatchObject({ experiments: 1, sessions: fixture.registration.manifest.slots.length });
  expect(store.hasRecords()).toBe(true);
  const reopened = new GuidanceProbeStore(file); clean.push(() => reopened.close());
  expect(reopened.integrity()).toEqual(first);
  expect(reopened.read({ projectKey: fixture.registration.manifest.projectKey, id: registered.id })?.registration).toEqual(fixture.registration);
  expect(JSON.stringify(first)).not.toContain(fixture.registration.snapshots.task);
  expect(GUIDANCE_PROBE_MODEL).toBe("qwen27b/qwen3.8-27b");
});

test("restart snapshots accept only a closed conditional guidanceProbes digest", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-restart-"));
  clean.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const base: RestartSnapshot = {
    schemaVersion: 1, projectRoot: "/project", projectId: "project-1", sourceInstanceId: "instance-1", operationId: "operation-1",
    committedAt: 1, bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
    integrity: { queues: {}, manualPaused: [], boardDigest: "a".repeat(64), budgetDigest: "b".repeat(64),
      guidanceProbes: { experiments: 1, sessions: 2, digest: "c".repeat(64) } },
  };
  writeRestartSnapshot(stateDir, base);
  const read = () => readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "operation-1" });
  expect(read()).toEqual(base);
  for (const guidanceProbes of [
    { experiments: -1, sessions: 0, digest: "c".repeat(64) },
    { experiments: 2, sessions: 1, digest: "c".repeat(64) },
    { experiments: 1, sessions: 2, digest: "bad" },
    { experiments: 1, sessions: 2, digest: "c".repeat(64), actor: "user" },
  ]) {
    writeRestartSnapshot(stateDir, { ...base, integrity: { ...base.integrity!, guidanceProbes } as RestartSnapshot["integrity"] });
    expect(read()).toBeUndefined();
  }
});

test("retained probe rows require a target advertising guidance_probes", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-guidance-probe-target-"))), stateDir = join(root, "state"), kimiHome = join(root, "kimi-home");
  mkdirSync(stateDir); mkdirSync(kimiHome);
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const fixture = guidanceProbeFixture(), store = new GuidanceProbeStore(join(stateDir, "hub.db"));
  store.register(fixture.registration, fixture.host, () => fixture.host); store.close();
  const config = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "guidance-probe-project", instanceId: "guidance-probe-instance", kimiHome, config,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  try {
    expect(client.features).toContain("guidance_probes");
    const request = { t: "recovery", op: "prepare", expectedInstanceId: client.instanceId, operationId: "guidance-probe-target-floor" };
    const older = DAEMON_FEATURES.filter(feature => feature !== "guidance_probes");
    const refused = await client.request({ ...request, targetFeatures: older });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("target lacks guidance_probes");
    const supported = await client.request({ ...request, targetFeatures: DAEMON_FEATURES });
    expect(supported.ok).toBe(true);
    const checkStore = new GuidanceProbeStore(join(stateDir, "hub.db"));
    try { expect(supported.recovery.integrity.current.guidanceProbes).toEqual(checkStore.integrity()); }
    finally { checkStore.close(); }
  } finally { client.close(); await daemon.stop(); }
}, 20_000);

// #1226 T3: a held recovery target must not mutate probe rows (the integrity digest it carries must still match), and reconciles exactly once at release.
test("a held recovery target reconciles a carried reserved probe session only at release, after its integrity matched", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-guidance-probe-held-"))), stateDir = join(root, "state"), kimiHome = join(root, "kimi-home");
  mkdirSync(stateDir); mkdirSync(kimiHome);
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const options = { cwd: root, stateDir, projectId: "guidance-probe-held", kimiHome, config, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} };
  const source = await startDaemon({ ...options, instanceId: "probe-held-source" });
  const one = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  // While the source runs, a probe session is reserved and never settled: the state a crash leaves, carried into the snapshot's integrity digest.
  const fixture = guidanceProbeFixture(), key = guidanceProbeFixtureKey(fixture.registration);
  const seed = new GuidanceProbeStore(join(stateDir, "hub.db"), () => 1000);
  seed.register(fixture.registration, fixture.host, () => fixture.host);
  const reserved = seed.reserveSession({ key, expectedRevision: 0, host: fixture.host, now: 1000 }, () => ({ host: fixture.host }));
  if (reserved.kind !== "granted") throw new Error("expected a reservation");
  seed.close();
  const features = DAEMON_FEATURES;
  expect((await one.request({ t: "recovery", op: "prepare", operationId: "probe-held-op", expectedInstanceId: "probe-held-source", targetFeatures: features })).ok).toBe(true);
  expect((await one.request({ t: "recovery", op: "commit", operationId: "probe-held-op", expectedInstanceId: "probe-held-source", targetFeatures: features })).committed).toBe(true);
  one.close(); await source.stopped;
  const prior = process.env.AGENTHUB_RECOVERY_OPERATION;
  let target: Awaited<ReturnType<typeof startDaemon>>;
  try { process.env.AGENTHUB_RECOVERY_OPERATION = "probe-held-op"; target = await startDaemon({ ...options, instanceId: "probe-held-target" }); }
  finally { if (prior === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = prior; }
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  try {
    const reader = new GuidanceProbeStore(join(stateDir, "hub.db"), () => 2000, true);
    try {
      // Held: the carried session is untouched, so the integrity comparison the release makes can still succeed.
      expect(reader.read(key)!.sessions[0]!.state).toBe("reserved");
      expect(reader.receipts(key)).toEqual([]);
      const inspect = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "probe-held-target" });
      expect(inspect.recovery.integrity.current).toEqual(inspect.recovery.integrity.expected);
      const released = await client.request({ t: "recovery", op: "release", operationId: "probe-held-op", expectedInstanceId: "probe-held-target" });
      expect(released.released).toBe(true);
      expect(reader.read(key)!.sessions[0]!.state).toBe("unknown_held");
      expect(reader.receipts(key)[0]).toMatchObject({ slotId: "baseline", state: "unknown" });
    } finally { reader.close(); }
  } finally { client.close(); await target.stop(); }
}, 30_000);
