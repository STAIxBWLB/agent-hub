import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { VisualStore } from "../src/hub/visual.ts";
import { realPath } from "../src/hub/project.ts";
import { openHubDatabase } from "../src/hub/db-schema.ts";

const VISUAL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OPERATION = "visual-recovery";
async function fixture(retained = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-visual-recovery-"))), stateDir = join(root, "state"), configDir = join(root, ".agenthub");
  mkdirSync(stateDir); mkdirSync(configDir);
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { const dir = join(root, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  // No real peer/account/model leg; the current process owns only these disposable daemon state roots.
  const config = { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  // Deliberately no visuals key: default in-memory policy must not raise a legacy feature floor.
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false } }));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally { for (const key of keys) { const old = saved[key]; if (old === undefined) delete process.env[key]; else process.env[key] = old; } rmSync(root, { recursive: true, force: true }); }
  };
  try {
    if (retained) {
      const store = new VisualStore(join(stateDir, "hub.db"));
      try { store.insert({ id: VISUAL, from: "codex", kind: "mermaid", title: "Recovery fixture", payload: { kind: "mermaid", title: "Recovery fixture", source: "flowchart LR\nA-->B" }, files: [], created: Date.now() }); }
      finally { store.close(); }
    }
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    const request = (op: string, targetFeatures?: readonly string[]) => client!.request({ t: "recovery", op, operationId: OPERATION,
      expectedInstanceId: status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
    const restart = async (mutate?: () => void) => {
      await daemon!.stopped; client!.close();
      const snapshot = readRestartSnapshot(stateDir, { projectRoot: root, projectId: status.projectId, operationId: OPERATION });
      expect(snapshot?.sourceInstanceId).toBe(status.instanceId);
      mutate?.();
      const previous = process.env.AGENTHUB_RECOVERY_OPERATION; process.env.AGENTHUB_RECOVERY_OPERATION = OPERATION;
      try { daemon = await startDaemon({ cwd: root, stateDir, projectId: status.projectId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config }); }
      finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
      client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
      const targetStatus = (await client.request({ t: "status" })).status;
      return { daemon, request: (op: string) => client!.request({ t: "recovery", op, operationId: OPERATION, expectedInstanceId: targetStatus.instanceId }) };
    };
    return { root, stateDir, configDir, status, request, restart, close, withoutVisuals: DAEMON_FEATURES.filter(feature => feature !== "visuals") };
  } catch (error) { await close(); throw error; }
}

test("empty unconfigured recovery remains compatible with a target without visuals", async () => {
  const f = await fixture();
  try {
    expect(DAEMON_FEATURES).toContain("visuals");
    expect((await f.request("inspect")).recovery.integrity.current.visuals).toBeUndefined();
    expect(await f.request("prepare", f.withoutVisuals)).toMatchObject({ ok: true, recovery: { phase: "prepared" } });
  } finally { await f.close(); }
}, 20_000);

test("retained visual rows require a supporting target before preparation", async () => {
  const f = await fixture(true);
  try {
    const refused = await f.request("prepare", f.withoutVisuals);
    expect(refused.ok).toBe(false); expect(refused.error).toContain("target lacks visuals");
    expect(refused.error).toContain("retained visual records");
    expect(await f.request("prepare", DAEMON_FEATURES)).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("explicit raw visuals configuration, even empty, requires the feature; unreadable config fails closed", async () => {
  for (const raw of [JSON.stringify({ visuals: {} }), JSON.stringify({ visuals: { retention_days: 30 } }), "invalid-json"]) {
    const f = await fixture();
    try {
      writeFileSync(join(f.configDir, "config.local.json"), raw);
      const refused = await f.request("prepare", f.withoutVisuals);
      expect(refused.ok).toBe(false); expect(refused.error).toMatch(/visuals/);
      if (raw === "invalid-json") expect(refused.error).toContain("unknown");
      else expect(refused.error).toContain("explicit visuals configuration");
    } finally { await f.close(); }
  }
}, 20_000);

for (const change of ["unchanged", "payload", "row-loss"] as const) test(`supporting two-daemon recovery binds visual integrity: ${change}`, async () => {
  const f = await fixture(true);
  try {
    const before = (await f.request("inspect")).recovery.integrity.current.visuals;
    expect(before).toMatchObject({ count: 1 }); expect(before.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.request("prepare", DAEMON_FEATURES)).toMatchObject({ ok: true });
    expect(await f.request("commit", DAEMON_FEATURES)).toMatchObject({ ok: true, committed: true });
    const target = await f.restart(change === "unchanged" ? undefined : () => {
      const db = openHubDatabase(join(f.stateDir, "hub.db"), { create: true });
      try {
        if (change === "row-loss") db.query("DELETE FROM visuals WHERE id=?").run(VISUAL);
        else db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(JSON.stringify({ kind: "mermaid", title: "Recovery fixture", source: "flowchart LR\nA-->Changed" }), VISUAL);
      } finally { db.close(); }
    });
    const restored = await target.request("inspect");
    expect(restored).toMatchObject({ ok: true, recovery: { phase: "restored" } });
    const current = restored.recovery.integrity.current.visuals;
    if (change === "unchanged") expect(current).toEqual(before); else expect(current).not.toEqual(before);
    const released = await target.request("release");
    if (change === "unchanged") { expect(released).toMatchObject({ ok: true, released: true }); expect(target.daemon.bus.isRecoveryHeld).toBe(false); }
    else { expect(released.ok).toBe(false); expect(released.error).toContain("integrity changed"); expect(target.daemon.bus.isRecoveryHeld).toBe(true); }
  } finally { await f.close(); }
}, 20_000);

test("restart visual integrity is optional and rejects malformed or expanded shapes", () => {
  const stateDir = realPath(mkdtempSync(join(tmpdir(), "ahub-visual-snapshot-"))), bus = new Bus({ batchMs: 0 });
  try {
    const visuals = { count: 1, digest: "a".repeat(64) };
    const snapshot: RestartSnapshot = { schemaVersion: 1, projectRoot: stateDir, projectId: "fixture", sourceInstanceId: "source", operationId: OPERATION, committedAt: 1,
      bus: bus.snapshot(), manualPaused: [], peers: [], integrity: { queues: {}, manualPaused: [], boardDigest: "board", budgetDigest: "budget", visuals } };
    const expected = { projectRoot: stateDir, projectId: "fixture", operationId: OPERATION };
    writeRestartSnapshot(stateDir, snapshot); expect(readRestartSnapshot(stateDir, expected)?.integrity?.visuals).toEqual(visuals);
    for (const invalid of [{ ...visuals, count: -1 }, { ...visuals, count: 0.5 }, { ...visuals, count: Number.MAX_SAFE_INTEGER + 1 }, { count: 1 }, { ...visuals, digest: "invalid" }, { ...visuals, source: "forbidden" }, [], null]) {
      writeRestartSnapshot(stateDir, { ...snapshot, integrity: { ...snapshot.integrity!, visuals: invalid } } as RestartSnapshot);
      expect(readRestartSnapshot(stateDir, expected)).toBeUndefined();
    }
    const { visuals: _removed, ...legacy } = snapshot.integrity!;
    writeRestartSnapshot(stateDir, { ...snapshot, integrity: legacy });
    expect(readRestartSnapshot(stateDir, expected)?.integrity).toEqual(legacy);
  } finally { bus.closeJournal(); rmSync(stateDir, { recursive: true, force: true }); }
});
