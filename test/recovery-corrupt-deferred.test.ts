import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRecovery, makeRecoveryDriver, PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { abortRecovery, createOperation, disposeRecovery, planFingerprint, resumeBlocked, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { RecoveryDeferredHubError } from "../src/hub/deferred-hub.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { readRestartSnapshot } from "../src/hub/restart.ts";
import { readOperation, recoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { Registry } from "../src/hub/registry.ts";
import { VERSION } from "../src/version.ts";

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "ahub-478-corrupt-deferred-"));
  const oldHome = process.env.AGENTHUB_HOME;
  const home = join(temp, "home"); process.env.AGENTHUB_HOME = home;
  const root = join(temp, "project"); mkdirSync(root);
  const registry = new Registry(join(home, "registry.db"));
  const project = registry.register(root); registry.close();
  mkdirSync(project.stateDir, { recursive: true });
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: "fixture",
    projects: [{ project, source: { state: "running", instanceId: "source", version: VERSION, peers: [], blockers: [] }, terminals: [], blockers: [] }], blockers: [] };
  const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, PACKAGE_ROOT, home);
  const file = join(project.stateDir, "restart.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, projectRoot: project.root, projectId: project.id, sourceInstanceId: "source", operationId: op.id,
    committedAt: 1, bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [],
      deferredHub: [newEnvelope("codex", "forged non-hub deferred row")] }, manualPaused: [], peers: [] }));
  const bytes = readFileSync(file, "utf8");
  const driver = makeRecoveryDriver(async () => { throw new Error("no native command may run"); });
  return { home, project, op, file, bytes, driver, close() {
    if (oldHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHome;
    rmSync(temp, { recursive: true, force: true });
  } };
}

test("#478 corrupt deferred snapshot keeps stopped evidence typed and blocks restore without rewriting it", async () => {
  const f = fixture();
  try {
    // The daemon's shared restore reader still refuses the corrupt snapshot.
    expect(() => readRestartSnapshot(f.project.stateDir, { projectRoot: f.project.root, projectId: f.project.id })).toThrow(RecoveryDeferredHubError);
    const live = await inspectRecovery(f.project);
    expect(live.state).toBe("stopped");
    expect(live.snapshot).toBeUndefined();
    expect(live.snapshotError).toEqual({ code: "recovery_deferred_hub", message: "restart snapshot deferred hub notices are invalid; restore is blocked" });
    expect(live.blockers).toEqual([live.snapshotError!.message]);
    f.op.projects[0]!.phase = "stopped";
    expect(resumeBlocked(f.op, { [f.project.id]: live })).toContain("without this operation's restart snapshot");
    expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
  } finally { f.close(); }
});

test("#478 abort of an uncommitted stopped source survives corrupt deferred snapshot inspection", async () => {
  const f = fixture();
  try {
    f.op.projects[0]!.phase = "prepared";
    writeOperation(f.op.id, f.op, f.home);
    await abortRecovery(f.op.id, f.driver, f.home);
    expect(readOperation<RecoveryOperation>(f.op.id, f.home).phase).toBe("cancelled");
    expect(recoveryLock(f.home)).toBeUndefined();
    expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
  } finally { f.close(); }
});

test("#478 stop-and-archive preserves a corrupt deferred snapshot for reconciliation", async () => {
  const f = fixture();
  try {
    f.op.projects[0]!.phase = "stopped"; f.op.projects[0]!.commitSent = true;
    f.op.phase = "blocked";
    writeOperation(f.op.id, f.op, f.home);
    const result = await disposeRecovery(f.op.id, { stop: true }, "preserve corrupt snapshot for manual reconciliation", f.driver, f.home);
    expect(result.phase).toBe("cancelled");
    expect(result.disposition?.projects[f.project.id]).toBe("stopped");
    expect(recoveryLock(f.home)).toBeUndefined();
    expect(existsSync(f.file)).toBe(false);
    const archive = join(f.project.stateDir, `restart.abandoned.${createHash("sha256").update(f.op.id).digest("hex")}.json`);
    expect(readFileSync(archive, "utf8")).toBe(f.bytes);
  } finally { f.close(); }
});
