import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

// #1658 follow-up: a read-back row is private state an older daemon does not know, so it carries the surveys' recovery
// treatment — a feature name, a conditional floor and a digest that joins `integrity()` only while rows exist.
const readback = { repo: "fixture/readback", issue: 1658, lastEditedAt: "2026-11-23T00:36:36Z", updatedAt: "2026-11-23T00:36:36Z", reader: "codex", by: "user", at: 5 };

async function fixture(stored: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ahub-readback-recovery-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const board = new Board(join(stateDir, "hub.db"));
  if (stored) {
    const task = board.update(board.propose("user", { title: "Spec read-back", class: "implement" }).id, "user", "accepted", { owner: "claude", state: "in_progress" });
    board.readbackCreate({ ...readback, task: task.id, taskCreated: task.created });
  }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => { client?.close(); await daemon?.stop(); board.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    daemon = await startDaemon({ cwd: root, stateDir, projectId: "readback-recovery-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    const withoutReadbacks = status.features.filter((feature: string) => feature !== "spec_readbacks");
    const request = (op: string, targetFeatures: readonly string[]) => client!.request({ t: "recovery", op, operationId: "readback-recovery", expectedInstanceId: status.instanceId, targetFeatures });
    return { board, stateDir, root, status, withoutReadbacks, request, close };
  } catch (error) { await close(); throw error; }
}

test("recovery requires spec_readbacks only for stored rows and binds its digest to them", async () => {
  expect(DAEMON_FEATURES).toContain("spec_readbacks");
  for (const stored of [false, true]) {
    const f = await fixture(stored);
    try {
      expect(f.status.features).toContain("spec_readbacks");
      if (stored) for (const op of ["prepare", "commit", "inspect"]) expect(await f.request(op, f.withoutReadbacks)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks spec_readbacks") });
      const features = stored ? f.status.features : f.withoutReadbacks;
      const prepared = await f.request("prepare", features); expect(prepared.ok === true, String(prepared.error ?? "")).toBe(true);
      const committed = await f.request("commit", features); expect(committed.ok === true, String(committed.error ?? "")).toBe(true); expect(committed.committed).toBe(true);
      const snapshot = readRestartSnapshot(f.stateDir, { projectRoot: f.root, projectId: "readback-recovery-fixture", operationId: "readback-recovery" });
      expect(snapshot).toBeDefined();
      if (stored) expect(snapshot!.integrity?.specReadbacks).toEqual(f.board.specReadbackIntegrity());
      else expect(snapshot!.integrity).not.toHaveProperty("specReadbacks");
    } finally { await f.close(); }
  }
}, 20_000);

test("a corrupt read-back row refuses recovery as unknown storage instead of proving a clean digest", async () => {
  const f = await fixture(true);
  try {
    expect(f.board.specReadbackIntegrity().readbacks).toBe(1);
    const db = new Database(join(f.stateDir, "hub.db")), secret = "PRIVATE_CORRUPTION_CANARY";
    db.query("UPDATE spec_readbacks SET body=?").run(secret); db.close();
    expect(() => f.board.specReadbackIntegrity()).toThrow("spec read-back storage invalid");
    try { f.board.specReadbackIntegrity(); } catch (error) { expect(String(error)).not.toContain(secret); }
  } finally { await f.close(); }
}, 20_000);

test("a snapshot naming a malformed specReadbacks proof is ignored, never read as clean", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-readback-restart-"));
  const legacy: RestartSnapshot = { schemaVersion: 1, projectRoot: "/fixture", projectId: "readback", sourceInstanceId: "source", operationId: "operation", committedAt: 1,
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
    integrity: { queues: {}, manualPaused: [], boardDigest: "a".repeat(64), budgetDigest: "b".repeat(64) } };
  const expected = { projectRoot: "/fixture", projectId: "readback", operationId: "operation" };
  try {
    writeRestartSnapshot(root, legacy); expect(readRestartSnapshot(root, expected)).toEqual(legacy);
    const proof = { readbacks: 1, digest: "c".repeat(64) };
    writeRestartSnapshot(root, { ...legacy, integrity: { ...legacy.integrity!, specReadbacks: proof } });
    expect(readRestartSnapshot(root, expected)?.integrity?.specReadbacks).toEqual(proof);
    for (const value of [null, [], { ...proof, readbacks: -1 }, { ...proof, readbacks: 1.5 }, { ...proof, readbacks: "1" }, { ...proof, digest: "bad" }, { ...proof, reason: "PRIVATE_NARRATIVE_CANARY" }]) {
      writeRestartSnapshot(root, { ...legacy, integrity: { ...legacy.integrity!, specReadbacks: value } } as unknown as RestartSnapshot);
      expect(readRestartSnapshot(root, expected), JSON.stringify(value)).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
