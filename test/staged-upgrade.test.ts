import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { acquireRecoveryLock, assertLifecycleAvailable, operationPath, readOperation, recoveryLock, releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { createOperation, planFingerprint, runRecovery, type Inspection, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222", C = "33333333-3333-3333-3333-333333333333";
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-staged-locks-"))), home = join(root, "home");
  const a = join(root, "project-a"), b = join(root, "project-b");
  for (const dir of [home, a, b]) mkdirSync(dir);
  const oldHome = process.env.AGENTHUB_HOME, oldOperation = process.env.AGENTHUB_RECOVERY_OPERATION;
  process.env.AGENTHUB_HOME = home; delete process.env.AGENTHUB_RECOVERY_OPERATION;
  clean.push(() => {
    if (oldHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHome;
    if (oldOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = oldOperation;
    rmSync(root, { recursive: true, force: true });
  });
  return { home, a: realPath(a), b: realPath(b), database: join(home, "recovery/project-locks.db") };
}

test("project-scoped recovery locks for A and B coexist and release independently", () => {
  const f = fixture();
  acquireRecoveryLock(A, f.home, f.a); acquireRecoveryLock(B, f.home, f.b);
  expect(recoveryLock(f.home, f.a)).toBe(A); expect(recoveryLock(f.home, f.b)).toBe(B);
  // Old callers without a project see only the legacy global lock.
  expect(recoveryLock(f.home)).toBeUndefined();
  releaseRecoveryLock(A, f.home, f.a);
  expect(recoveryLock(f.home, f.a)).toBeUndefined(); expect(recoveryLock(f.home, f.b)).toBe(B);
  releaseRecoveryLock(B, f.home, f.b); expect(recoveryLock(f.home, f.b)).toBeUndefined();
});

test("lifecycle commands for B remain available while only A is held, and operation bypass is scoped", () => {
  const f = fixture(); acquireRecoveryLock(A, f.home, f.a);
  expect(() => assertLifecycleAvailable(f.a)).toThrow(A);
  expect(() => assertLifecycleAvailable(f.b)).not.toThrow();
  acquireRecoveryLock(B, f.home, f.b); process.env.AGENTHUB_RECOVERY_OPERATION = A;
  expect(() => assertLifecycleAvailable(f.a)).not.toThrow(); expect(() => assertLifecycleAvailable(f.b)).toThrow(B);
  process.env.AGENTHUB_RECOVERY_OPERATION = B;
  expect(() => assertLifecycleAvailable(f.b)).not.toThrow(); expect(() => assertLifecycleAvailable(f.a)).toThrow(A);
});

test("a legacy global hold remains authoritative for both projects", () => {
  const f = fixture(); acquireRecoveryLock(C, f.home);
  expect(recoveryLock(f.home)).toBe(C);
  for (const [id, root] of [[A, f.a], [B, f.b]] as const) {
    expect(recoveryLock(f.home, root)).toBe(C);
    expect(() => assertLifecycleAvailable(root)).toThrow(C);
    expect(() => acquireRecoveryLock(id, f.home, root)).toThrow("owns this machine");
  }
  expect(() => releaseRecoveryLock(A, f.home)).toThrow("ownership changed"); expect(recoveryLock(f.home)).toBe(C);
  releaseRecoveryLock(C, f.home);
  expect(() => assertLifecycleAvailable(f.a)).not.toThrow(); expect(() => assertLifecycleAvailable(f.b)).not.toThrow();
});

test("the same canonical root is exclusive while acquisition by its existing operation is idempotent", () => {
  const f = fixture(); acquireRecoveryLock(A, f.home, f.a);
  expect(() => acquireRecoveryLock(A, f.home, realPath(f.a))).not.toThrow();
  expect(() => acquireRecoveryLock(B, f.home, realPath(f.a))).toThrow("owns this project");
  expect(recoveryLock(f.home, f.a)).toBe(A); expect(recoveryLock(f.home, f.b)).toBeUndefined();
});

test("wrong-root, wrong-owner and stale releases cannot remove a replacement holder", () => {
  const f = fixture(); acquireRecoveryLock(A, f.home, f.a); acquireRecoveryLock(B, f.home, f.b);
  expect(() => releaseRecoveryLock(A, f.home, f.b)).toThrow("ownership changed");
  expect(() => releaseRecoveryLock(C, f.home, f.a)).toThrow("ownership changed");
  expect(recoveryLock(f.home, f.a)).toBe(A); expect(recoveryLock(f.home, f.b)).toBe(B);
  releaseRecoveryLock(A, f.home, f.a); acquireRecoveryLock(C, f.home, f.a);
  expect(() => releaseRecoveryLock(A, f.home, f.a)).toThrow("ownership changed");
  expect(recoveryLock(f.home, f.a)).toBe(C); expect(recoveryLock(f.home, f.b)).toBe(B);
});

test("malformed legacy lock records refuse lifecycle and scoped acquisition without rewriting the record", () => {
  const f = fixture(), file = join(f.home, "recovery.lock");
  for (const text of ["{", "null", "[]", "{}", '{"operationId":42}', '{"operationId":"broken"}']) {
    writeFileSync(file, text, { mode: 0o600 });
    for (const root of [f.a, f.b]) {
      expect(() => recoveryLock(f.home, root)).toThrow("unreadable");
      expect(() => assertLifecycleAvailable(root)).toThrow("unreadable");
      expect(() => acquireRecoveryLock(A, f.home, root)).toThrow("unreadable");
    }
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});

test("a malformed project holder fails closed and cannot be deleted by supplying its malformed owner string", () => {
  const f = fixture(); acquireRecoveryLock(A, f.home, f.a);
  const db = new Database(f.database);
  try { db.query("UPDATE project_locks SET operation_id=? WHERE project_root=?").run("broken", f.a); }
  finally { db.close(); }
  expect(() => recoveryLock(f.home, f.a)).toThrow("unreadable");
  expect(() => acquireRecoveryLock(B, f.home, f.a)).toThrow("unreadable");
  expect(() => releaseRecoveryLock(A, f.home, f.a)).toThrow();
  expect(() => releaseRecoveryLock("broken", f.home, f.a)).toThrow();
  const observed = new Database(f.database, { readonly: true });
  try { expect(observed.query("SELECT operation_id FROM project_locks WHERE project_root=?").get(f.a)).toEqual({ operation_id: "broken" }); }
  finally { observed.close(); }
});

test("corrupt or incomplete project coordination databases refuse both scopes without being recreated", () => {
  const f = fixture(); mkdirSync(join(f.home, "recovery"));
  for (const kind of ["corrupt", "missing-table"]) {
    rmSync(f.database, { force: true });
    if (kind === "corrupt") writeFileSync(f.database, "not a sqlite database", { mode: 0o600 });
    else { const db = new Database(f.database); try { db.run("CREATE TABLE unrelated (id INTEGER)"); } finally { db.close(); } }
    const before = readFileSync(f.database);
    for (const root of [f.a, f.b]) {
      expect(() => recoveryLock(f.home, root)).toThrow("unreadable");
      expect(() => acquireRecoveryLock(A, f.home, root)).toThrow("unreadable");
    }
    expect(readFileSync(f.database)).toEqual(before);
  }
});

function recoveryFixture(scoped = true, create = true) {
  const f = fixture(), calls: string[] = [], states = new Map<string, Inspection>();
  const source: Inspection = { state: "running", instanceId: "old-a", version: "0.5.0", protocol: 16, peers: [], blockers: [] };
  states.set("a", structuredClone(source));
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, ...(scoped ? { scope: { projectRoot: f.a } } : {}), kind: "upgrade", version: "0.5.0",
    sourceRoot: PACKAGE_ROOT, sourceDigest: "synthetic-source-digest", projects: [{ project: { id: "a", root: f.a, stateDir: join(f.a, "state"), pid: 123, instanceId: "old-a", basePort: 4600 }, source, terminals: [], blockers: [] }], blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
  const operation = create ? createOperation(plan, PACKAGE_ROOT, f.home) : undefined;
  let clock = 0;
  const driver: RecoveryDriver = {
    stage: async () => { calls.push("stage"); return { root: PACKAGE_ROOT, digest: "synthetic-target-digest" }; },
    inspect: async project => structuredClone(states.get(project.id)!),
    prepare: async (project, id) => { calls.push(`prepare:${project.id}`); states.get(project.id)!.recovery = { operationId: id, phase: "prepared", ready: true }; },
    abort: async project => { calls.push(`abort:${project.id}`); delete states.get(project.id)!.recovery; },
    closeTerminals: async planned => { calls.push(`close:${planned.project.id}`); },
    commit: async project => { calls.push(`commit:${project.id}`); states.set(project.id, { state: "stopped", peers: [], blockers: [] }); },
    start: async (project, op) => { calls.push(`start:${project.id}`); states.set(project.id, { state: "running", instanceId: `new-${project.id}`, version: "0.5.0", protocol: 17,
      peers: [], blockers: [], recovery: { operationId: op.id, phase: "restored", ready: true } }); },
    restore: async (planned, _progress, _op, group) => { calls.push(`${group}:${planned.project.id}`); },
    installPlugin: async () => { calls.push("plugin"); }, installGlobal: async () => { calls.push("global"); },
    release: async project => { calls.push(`release:${project.id}`); states.get(project.id)!.recovery!.phase = "released"; },
    verify: async planned => { calls.push(`verify:${planned.project.id}`); },
    stopAndArchive: async project => { calls.push(`archive:${project.id}`); states.set(project.id, { state: "stopped", peers: [], blockers: [] }); },
    now: () => clock, sleep: async milliseconds => { clock += milliseconds; },
  };
  return { ...f, plan, operation, driver, calls, states };
}

test("a scoped schema3 upgrade completes exactly one project without shared plugin or global installation", async () => {
  const f = recoveryFixture(), op = f.operation!;
  expect(op.schema).toBe(3); expect(op.plan.scope).toEqual({ projectRoot: f.a }); expect(op.projects).toHaveLength(1);
  expect(recoveryLock(f.home, f.a)).toBe(op.id); expect(() => assertLifecycleAvailable(f.b)).not.toThrow();
  const completed = await runRecovery(op.id, f.driver, f.home);
  expect(completed).toMatchObject({ schema: 3, phase: "completed" });
  expect(f.calls).toEqual(["stage", "prepare:a", "close:a", "commit:a", "start:a", "native:a", "claude:a", "verify:a", "release:a"]);
  expect(f.calls).not.toContain("plugin"); expect(f.calls).not.toContain("global");
  expect(recoveryLock(f.home, f.a)).toBeUndefined(); expect(recoveryLock(f.home, f.b)).toBeUndefined();
  expect(readOperation<RecoveryOperation>(op.id, f.home).schema).toBe(3);
  const calls = [...f.calls]; await runRecovery(op.id, f.driver, f.home); expect(f.calls).toEqual(calls);
});

test("a retained unscoped schema1 upgrade keeps the legacy shared plugin and global install steps", async () => {
  const f = recoveryFixture(false), op = f.operation!;
  expect(op.schema).toBe(1); expect(op.plan.scope).toBeUndefined();
  expect((await runRecovery(op.id, f.driver, f.home)).phase).toBe("completed");
  expect(f.calls.filter(call => call === "plugin")).toHaveLength(1); expect(f.calls.filter(call => call === "global")).toHaveLength(1);
  expect(f.calls.indexOf("plugin")).toBeLessThan(f.calls.indexOf("claude:a")); expect(f.calls.at(-1)).toBe("global");
  expect(recoveryLock(f.home)).toBeUndefined();
});

test("changed or two-project scoped plans refuse before creating receipts, holds or driver effects", () => {
  const f = recoveryFixture(true, false), second = structuredClone(f.plan.projects[0]!);
  second.project = { ...second.project, id: "b", root: f.b, stateDir: join(f.b, "state"), instanceId: "old-b" };
  second.source.instanceId = "old-b";
  for (const changed of [{ ...f.plan, scope: { projectRoot: f.b } }, { ...f.plan, projects: [...f.plan.projects, second] }]) {
    const { fingerprint: _old, ...body } = changed, plan = { ...body, fingerprint: planFingerprint(body) };
    expect(() => createOperation(plan, PACKAGE_ROOT, f.home)).toThrow("scope");
    expect(existsSync(join(f.home, "recovery"))).toBe(false);
    expect(recoveryLock(f.home, f.a)).toBeUndefined(); expect(recoveryLock(f.home, f.b)).toBeUndefined(); expect(f.calls).toEqual([]);
  }
});

test("a stored scope changed after review is refused before any receipt rewrite or recovery effect", async () => {
  const f = recoveryFixture(), altered = structuredClone(f.operation!);
  altered.plan.scope = { projectRoot: f.b }; writeOperation(altered.id, altered, f.home);
  const before = readFileSync(operationPath(altered.id, f.home));
  await expect(runRecovery(altered.id, f.driver, f.home)).rejects.toThrow();
  expect(readFileSync(operationPath(altered.id, f.home))).toEqual(before); expect(f.calls).toEqual([]);
  expect(recoveryLock(f.home, f.a)).toBe(altered.id); expect(recoveryLock(f.home, f.b)).toBeUndefined();
});

test("scoped plans cannot expand or be replaced across the second asynchronous conductor authorization", async () => {
  const f = recoveryFixture(), op = f.operation!;
  let release!: () => void, entered!: () => void, authorized: RecoveryOperation | undefined, runChecks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const driver: RecoveryDriver = { ...f.driver, conductorPeer: "claude", authorize: async (current, phase) => {
    if (phase === "run" && ++runChecks === 2) { authorized = current; entered(); await gate; }
  } };
  const pending = runRecovery(op.id, driver, f.home), outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started, pending.then(() => { throw new Error("recovery missed the second authorization barrier"); })]);
    const current = authorized; if (!current) throw new Error("authorization did not expose its scoped receipt");
    expect(Object.isFrozen(current.plan)).toBe(true); expect(Object.isFrozen(current.plan.projects)).toBe(true); expect(Object.isFrozen(current.plan.scope)).toBe(true);
    expect(Reflect.set(current.plan.scope!, "projectRoot", f.b)).toBe(false);
    expect(Reflect.set(current.plan.projects, "1", structuredClone(current.plan.projects[0]!))).toBe(false);
    const original = current.plan, expanded = structuredClone(original); expanded.scope = { projectRoot: f.b };
    const replaced = Reflect.set(current, "plan", expanded);
    if (replaced) Reflect.set(current, "plan", original); // failure-path cleanup keeps a faulty implementation inside this fixture's original scope
    expect(replaced).toBe(false);
    expect(f.calls).toEqual([]); expect(recoveryLock(f.home, f.b)).toBeUndefined();
  } finally { release(); await outcome; }
  const result = await outcome; if ("error" in result) throw result.error;
  expect(result.value.phase).toBe("completed"); expect(f.calls).not.toContain("plugin"); expect(f.calls).not.toContain("global");
  expect(f.calls.some(call => call.endsWith(":b"))).toBe(false);
}, 20_000);
