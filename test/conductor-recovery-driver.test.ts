import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { abortRecovery, createOperation, disposeRecovery, guardedRecoveryDriver, planFingerprint, reattachRecovery, runRecovery, type Inspection, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { operationPath, readOperation, recoveryLock, releaseRecoveryLock } from "../src/hub/recovery-store.ts";

const homes: string[] = [], root = resolve(import.meta.dir, "..");
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-conductor-recovery-driver-")); homes.push(home);
  const source: Inspection = { state: "running", instanceId: "old-alpha", version: "0.5.0", protocol: 9, peers: [], blockers: [] };
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.5.0", sourceRoot: root, sourceDigest: "source",
    projects: [{ project: { id: "alpha", root: "/alpha", stateDir: "/alpha/state", pid: 123, instanceId: "old-alpha", basePort: 4600 }, source, terminals: [], blockers: [] }], blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
  const op = createOperation(plan, root, home);
  releaseRecoveryLock(op.id, home);
  let state = structuredClone(source);
  const calls: string[] = [], effect = (name: string) => async () => { calls.push(name); };
  const driver: RecoveryDriver = {
    stage: async () => { calls.push("stage"); return { root, digest: "target" }; },
    inspect: async () => structuredClone(state),
    prepare: async (_project, id) => { calls.push("prepare"); state.recovery = { operationId: id, phase: "prepared", ready: true }; },
    abort: async () => { calls.push("abort"); delete state.recovery; },
    closeTerminals: effect("closeTerminals"),
    commit: async () => { calls.push("commit"); state = { state: "stopped", peers: [], blockers: [] }; },
    start: async (_project, operation) => { calls.push("start"); state = { state: "running", instanceId: "new-alpha", version: plan.version, protocol: 10,
      recovery: { operationId: operation.id, phase: "restored", ready: true }, peers: [], blockers: [] }; },
    restore: effect("restore"), installPlugin: effect("installPlugin"), installGlobal: effect("installGlobal"), refreshManager: effect("refreshManager"),
    release: async () => { calls.push("release"); state.recovery!.phase = "released"; },
    verify: effect("verify"), stopAndArchive: effect("stopAndArchive"), sleep: async () => {}, now: () => 1,
  };
  return { home, op, plan, driver, calls, hold() { state.recovery = { operationId: op.id, phase: "prepared", ready: true }; } };
}

test("conductor recovery requires live authorization before lock or runner, never historical delegation", async () => {
  for (const action of ["run", "abort"] as const) {
    const f = fixture(); Object.assign(f.driver, { conductorPeer: "codex" });
    f.op.delegatedAudits = [{ peer: "codex", command: "recovery-run", at: 1, operationId: f.op.id }];
    // This audit is intentionally passed only to the guard; it cannot supply the absent authorize port.
    const guarded = guardedRecoveryDriver(f.driver, () => f.op);
    await expect(guarded.stage(f.op)).rejects.toThrow("authorization unavailable");
    await expect(action === "run" ? runRecovery(f.op.id, f.driver, f.home) : abortRecovery(f.op.id, f.driver, f.home)).rejects.toThrow("authorization unavailable");
    expect(f.calls).toEqual([]); expect(recoveryLock(f.home)).toBeUndefined();
    expect(existsSync(`${operationPath(f.op.id, f.home)}.runner.db`)).toBe(false);
  }
});

test("a conductor rechecks the exclusive reread before stage or abort effects", async () => {
  for (const action of ["run", "abort"] as const) {
    const f = fixture(); Object.assign(f.driver, { conductorPeer: "codex" }); let authorizations = 0;
    f.driver.authorize = async (_op, phase) => { expect(phase).toBe(action); if (++authorizations === 2) throw new Error("authority revoked"); };
    await expect(action === "run" ? runRecovery(f.op.id, f.driver, f.home) : abortRecovery(f.op.id, f.driver, f.home)).rejects.toThrow("authority revoked");
    expect(authorizations).toBe(2); expect(f.calls).toEqual([]);
    expect(readOperation<RecoveryOperation>(f.op.id, f.home).delegatedAudits).toBeUndefined();
  }
});

test("every closed recovery effect authorizes before and after its await while inspection remains read-only", async () => {
  const f = fixture(), observations: string[] = [];
  Object.assign(f.driver, { conductorPeer: "codex" });
  f.driver.authorize = async (_op, phase) => { observations.push(phase); };
  const guarded = guardedRecoveryDriver(f.driver, () => f.op);
  for (const name of ["stage", "prepare", "abort", "commit", "closeTerminals", "start", "restore", "installPlugin", "installGlobal", "refreshManager", "release", "verify", "stopAndArchive"] as const) {
    const original = f.driver[name];
    Object.assign(f.driver, { [name]: async () => { observations.push(name); await Promise.resolve(); } });
    observations.length = 0;
    await Reflect.apply(guarded[name]!, guarded, []);
    expect(observations).toEqual(["effect", name, "effect"]);
    Object.assign(f.driver, { [name]: original });
  }
  observations.length = 0;
  await guarded.inspect(f.plan.projects[0]!.project);
  expect(observations).toEqual([]);
});

test("revocation during an effect await blocks the next effect and retains actual conductor attribution", async () => {
  const f = fixture(); let allowed = true;
  Object.assign(f.driver, { conductorPeer: "codex" });
  f.driver.authorize = async () => { if (!allowed) throw new Error("authority revoked"); };
  f.driver.stage = async () => { f.calls.push("stage"); await Promise.resolve(); allowed = false; return { root, digest: "target" }; };
  const result = await runRecovery(f.op.id, f.driver, f.home);
  expect(result.phase).toBe("blocked"); expect(result.error).toContain("authority revoked"); expect(f.calls).toEqual(["stage"]);
  expect(result.delegatedAudits).toEqual([{ peer: "codex", command: "recovery-run", at: 1, operationId: f.op.id }]);
  expect(result.targetRoot).toBeUndefined();
});

test("conductor abort uses effect guards and attributes the actor, while dispose and reattach stay person-only", async () => {
  const f = fixture(), phases: string[] = []; f.hold(); Object.assign(f.driver, { conductorPeer: "codex" });
  f.driver.authorize = async (_op, phase) => { phases.push(phase); };
  await abortRecovery(f.op.id, f.driver, f.home);
  expect(f.calls).toEqual(["abort"]); expect(phases).toEqual(["abort", "abort", "effect", "effect"]);
  expect(readOperation<RecoveryOperation>(f.op.id, f.home).delegatedAudits?.at(-1)?.peer).toBe("codex");
  await expect(disposeRecovery("not-a-receipt", { stop: true }, "fixture", f.driver, f.home)).rejects.toThrow("person-only");
  await expect(reattachRecovery("not-a-receipt", "pi", f.driver, f.home)).rejects.toThrow("person-only");
});

test("person and live-test drivers keep their existing path without conductor authorization", async () => {
  for (const liveTest of [false, true]) {
    const f = fixture();
    f.driver.authorize = async () => { throw new Error("person must not use conductor proof"); };
    if (liveTest) Object.assign(f.driver, { liveTestPeer: "codex" });
    expect(guardedRecoveryDriver(f.driver, () => f.op)).toBe(f.driver);
    const result = await runRecovery(f.op.id, f.driver, f.home);
    expect(result.phase).toBe("completed"); expect(f.calls).toContain("commit");
    expect(result.delegatedAudits?.at(-1)?.peer).toBe(liveTest ? "codex" : undefined);
  }
});

test("a host-selected operation ID is validated before creating its receipt or lock", () => {
  const f = fixture(), id = crypto.randomUUID();
  const selected = createOperation(f.plan, root, f.home, undefined, id);
  expect(selected.id).toBe(id); expect(readOperation<RecoveryOperation>(id, f.home).id).toBe(id);
  releaseRecoveryLock(id, f.home);
  expect(() => createOperation(f.plan, root, f.home, undefined, "../invalid")).toThrow("invalid recovery operation ID");
  expect(recoveryLock(f.home)).toBeUndefined();
});
