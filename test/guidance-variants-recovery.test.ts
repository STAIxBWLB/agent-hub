import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { parseRole } from "../src/hub/roles.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { guidanceVariantKey, type GuidanceVariantPayloadV1 } from "../src/hub/guidance-variants.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-recovery-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(stateDir, "hub.db"), board = new Board(file), sql = new Database(file);
  clean.push(() => board.close(), () => sql.close());
  const role = parseRole(vectors.baseline, "test-engineer", "project"), bus = new Bus({ batchMs: 0 }); clean.push(() => bus.closeJournal());
  const task = board.propose(USER, { title: "Synthetic recovery task", class: "implement", role: role.id });
  const projectKey = "guidance-recovery-fixture", tasks = new Tasks({ cwd: root, project: "fixture", board, bus, routing: () => loadRouting(root),
    catalog: { roles: new Map([[role.id, role]]), errors: [] }, notify: () => {}, executionLineage: { projectKey, cursorKey: "guidance-recovery-cursor-000001" } });
  const { id: _id, ...golden } = vectors.golden.record;
  const value: GuidanceVariantPayloadV1 = { ...golden, v: 1, projectKey, taskId: task.id, taskCreated: task.created, flowRevision: task.history.length,
    author: USER, baseline: { ...golden.baseline, layer: "project" }, evidenceRefs: [] };
  const variant = { ...value, id: guidanceVariantKey(value) };
  return { root, stateDir, file, board, sql, tasks, task, projectKey, variant };
}

async function startFixture(f: ReturnType<typeof fixture>, instanceId = "guidance-recovery-fixture") {
  mkdirSync(join(f.root, "kimi-home"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  return startDaemon({ cwd: f.root, stateDir: f.stateDir, instanceId, kimiHome: join(f.root, "kimi-home"), config,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
}

test("the first experiment and variant roll back together when the final insert fails", async () => {
  const f = fixture(), before = f.board.statusRevision(), integrity = f.board.guidanceVariantsIntegrity();
  f.sql.run("CREATE TRIGGER refuse_variant BEFORE INSERT ON guidance_variants BEGIN SELECT RAISE(ABORT,'fixture write refusal'); END");
  const error = await f.tasks.guidanceVariantCreate(USER, f.variant).catch(error => error);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PreEffectToolRefusal);
  expect(error.message).toBe("guidance storage write failed; inspect the retained task experiment and its outcome before retrying");
  expect(error.message).not.toContain("fixture write refusal");
  expect(f.board.hasGuidanceVariants()).toBe(false); expect(f.board.statusRevision()).toBe(before);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(integrity);
});

for (const phase of ["read", "create-readback", "withdraw-readback"] as const) test(`unknown ${phase} failure is plain and never reports safe pre-effect retry`, async () => {
  const f = fixture();
  if (phase === "withdraw-readback") await f.tasks.guidanceVariantCreate(USER, f.variant);
  const before = f.board.guidanceVariantsIntegrity(), revision = f.board.statusRevision();
  let error: unknown;
  if (phase === "read") {
    const read = f.board.guidanceVariants;
    f.board.guidanceVariants = () => { throw new Error("RAW_SQL_ROLE_BYTES_CANARY"); };
    try { await f.tasks.guidanceVariantCreate(USER, f.variant); } catch (failure) { error = failure; }
    finally { f.board.guidanceVariants = read; }
    expect(f.board.guidanceVariantsIntegrity()).toEqual(before); expect(f.board.statusRevision()).toBe(revision);
  } else if (phase === "create-readback") {
    const write = f.board.recordGuidanceVariant.bind(f.board);
    f.board.recordGuidanceVariant = (...args) => { write(...args); throw new Error("RAW_SQL_ROLE_BYTES_CANARY"); };
    try { await f.tasks.guidanceVariantCreate(USER, f.variant); } catch (failure) { error = failure; }
    finally { f.board.recordGuidanceVariant = write; }
    expect(f.board.guidanceVariantsIntegrity().variants).toBe(before.variants + 1);
    expect((await f.tasks.guidanceVariantCreate(USER, f.variant)).already).toBe(true);
  } else {
    const write = f.board.withdrawGuidanceVariant.bind(f.board);
    f.board.withdrawGuidanceVariant = (...args) => { write(...args); throw new PreEffectToolRefusal("RAW_SQL_ROLE_BYTES_CANARY"); };
    try { await f.tasks.guidanceVariantWithdraw(USER, { taskId: f.task.id, taskCreated: f.task.created, flowRevision: f.task.history.length, experimentId: f.variant.experimentId, id: f.variant.id }); }
    catch (failure) { error = failure; }
    finally { f.board.withdrawGuidanceVariant = write; }
    expect(f.board.guidanceVariants(f.projectKey, f.task.id, f.task.created, f.variant.experimentId)[0]!.withdrawn?.by).toBe(USER);
  }
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PreEffectToolRefusal);
  expect((error as Error).message).toContain("guidance storage"); expect((error as Error).message).not.toContain("RAW_SQL_ROLE_BYTES_CANARY");
});

for (const shape of ["oversize", "invalid-json", "wrong-hash", "wrong-scope", "partial-withdrawal", "oversize-withdrawal", "wrong-time-type"] as const)
  test(`corrupt ${shape} storage never becomes a current or successful recovery read`, async () => {
    const f = fixture(); await f.tasks.guidanceVariantCreate(USER, f.variant);
    if (shape === "oversize") f.sql.query("UPDATE guidance_variants SET body=?").run("x".repeat(32769));
    else if (shape === "invalid-json") {
      const body = "{RAW_ROLE_BYTES_CANARY";
      f.sql.query("UPDATE guidance_variants SET body=?,body_sha256=?").run(body, createHash("sha256").update(body).digest("hex"));
    }
    else if (shape === "wrong-hash") f.sql.run("UPDATE guidance_variants SET body_sha256='wrong'");
    else if (shape === "wrong-scope") f.sql.run("UPDATE guidance_variants SET experiment_id='foreign-experiment'");
    else if (shape === "partial-withdrawal") f.sql.run("UPDATE guidance_variants SET withdrawn_by='user'");
    else if (shape === "oversize-withdrawal") f.sql.query("UPDATE guidance_variants SET withdrawn_by=?").run("x".repeat(32769));
    else f.sql.query("UPDATE guidance_variants SET withdrawn_at=?").run("x".repeat(32769));
    const revision = f.board.statusRevision();
    expect(() => f.board.guidanceVariantsIntegrity()).toThrow("guidance variant integrity is unavailable; inspect retained project state before retrying");
    expect(f.tasks.guidanceVariantRead(USER, { taskId: f.task.id, taskCreated: f.task.created, experimentId: f.variant.experimentId })).toEqual({ state: "unavailable" });
    expect(f.board.statusRevision()).toBe(revision);
  });

test("SQL byte rejection precedes JSON parsing and a seventeenth stored row is corruption, never truncation", async () => {
  const f = fixture(); await f.tasks.guidanceVariantCreate(USER, f.variant);
  f.sql.query("UPDATE guidance_variants SET body=?").run("x".repeat(32769));
  const parse = JSON.parse; let oversizedParsed = false;
  JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (text.length > 32768) oversizedParsed = true; return parse(text, reviver); };
  try { expect(() => f.board.guidanceVariants(f.projectKey, f.task.id, f.task.created, f.variant.experimentId)).toThrow(); }
  finally { JSON.parse = parse; }
  expect(oversizedParsed).toBe(false);
  // Restore the exact stored body and add synthetic corrupt keys only inside this scratch database.
  const body = JSON.stringify(f.variant), digest = createHash("sha256").update(body).digest("hex");
  f.sql.query("UPDATE guidance_variants SET body=?,body_sha256=?").run(body, digest);
  for (let index = 0; index < 16; index++) f.sql.query(`INSERT INTO guidance_variants(project_id,task_id,task_created,experiment_id,id,body,body_sha256,created_by,created_at)
    SELECT project_id,task_id,task_created,experiment_id,?,body,body_sha256,created_by,created_at FROM guidance_variants WHERE id=?`)
    .run(String(index).padStart(64, "0"), f.variant.id);
  expect(() => f.board.guidanceVariants(f.projectKey, f.task.id, f.task.created, f.variant.experimentId)).toThrow();
});

test("recovery feature floor is conditional on retained state and integrity includes all immutable and withdrawal metadata", async () => {
  const f = fixture(), daemon = await startFixture(f); clean.push(() => daemon.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" }); clean.push(() => person.close());
  expect(person.features).toContain("guidance_variants");
  const inspect = (targetFeatures: readonly string[]) => person.request({ t: "recovery", op: "inspect", expectedInstanceId: "guidance-recovery-fixture", targetFeatures });
  const unsupported = DAEMON_FEATURES.filter(feature => feature !== "guidance_variants");
  expect((await inspect(unsupported)).ok).toBe(true);
  await f.tasks.guidanceVariantCreate(USER, f.variant);
  const blocked = await inspect(unsupported); expect(blocked.ok).toBe(false); expect(blocked.error).toContain("target lacks guidance_variants");
  const supported = await inspect(DAEMON_FEATURES);
  expect<boolean>(supported.ok, supported.error).toBe(true); expect(supported.recovery.integrity.current.guidanceVariants).toEqual(f.board.guidanceVariantsIntegrity());
  expect(JSON.stringify(supported.recovery)).not.toContain(f.variant.candidate.bytes);
  const before = f.board.guidanceVariantsIntegrity();
  await f.tasks.guidanceVariantWithdraw(USER, { taskId: f.task.id, taskCreated: f.task.created, flowRevision: f.task.history.length, experimentId: f.variant.experimentId, id: f.variant.id });
  const after = f.board.guidanceVariantsIntegrity(); expect(after.digest).not.toBe(before.digest); expect(after.variants).toBe(before.variants);
}, 20_000);

test("controlled restart refuses changed retained guidance metadata instead of trusting the old snapshot", async () => {
  const f = fixture(); await f.tasks.guidanceVariantCreate(USER, f.variant);
  const daemon = await startFixture(f); clean.push(() => daemon.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" }); clean.push(() => person.close());
  const request = { t: "recovery", operationId: "guidance-restart-operation", expectedInstanceId: "guidance-recovery-fixture", targetFeatures: DAEMON_FEATURES };
  const prepared = await person.request({ ...request, op: "prepare" }); expect<boolean>(prepared.ok, prepared.error).toBe(true);
  const committed = await person.request({ ...request, op: "commit" }); expect<boolean>(committed.ok, committed.error).toBe(true); expect(committed.committed).toBe(true);
  await daemon.stopped; person.close();
  f.sql.run("UPDATE guidance_variants SET created_at=created_at+1");
  const prior = process.env.AGENTHUB_RECOVERY_OPERATION; process.env.AGENTHUB_RECOVERY_OPERATION = "guidance-restart-operation";
  try { await expect(startFixture(f, "guidance-recovery-target")).rejects.toThrow("guidance variant state or recovery binding is unavailable"); }
  finally { if (prior === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = prior; }
}, 20_000);

test("restart integrity reader retains legacy absence and rejects malformed optional guidance bindings", () => {
  const f = fixture(), bus = new Bus(); clean.push(() => bus.closeJournal());
  const snapshot: RestartSnapshot = { schemaVersion: 1, projectRoot: f.root, projectId: "fixture", sourceInstanceId: "source", operationId: "operation", committedAt: Date.now(),
    bus: bus.snapshot(), manualPaused: [], peers: [], integrity: { queues: {}, manualPaused: [], boardDigest: "a", budgetDigest: "b" } };
  const expected = { projectRoot: f.root, projectId: "fixture" };
  writeRestartSnapshot(f.stateDir, snapshot); expect(readRestartSnapshot(f.stateDir, expected)).toBeDefined();
  const valid = { experiments: 1, variants: 2, digest: "a".repeat(64) };
  snapshot.integrity!.guidanceVariants = valid;
  writeRestartSnapshot(f.stateDir, snapshot); expect(readRestartSnapshot(f.stateDir, expected)?.integrity?.guidanceVariants).toEqual(valid);
  for (const invalid of [{ ...valid, experiments: -1 }, { ...valid, variants: 0 }, { ...valid, extra: true }, { ...valid, digest: "a".repeat(64) + "\n" }]) {
    writeRestartSnapshot(f.stateDir, { ...snapshot, integrity: { ...snapshot.integrity!, guidanceVariants: invalid } });
    expect(readRestartSnapshot(f.stateDir, expected)).toBeUndefined();
  }
});
