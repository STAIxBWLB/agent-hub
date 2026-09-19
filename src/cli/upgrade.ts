import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../hub/registry.ts";
import { hubHome } from "../hub/project.ts";
import { acquireRecoveryLock, claimRunner, readOperation, recoveryLock, releaseRecoveryLock, writeOperation } from "../hub/recovery-store.ts";

export interface RecoveryPeer {
  id: string;
  state: string;
  threadId?: string;
  sessionId?: string;
  sessionFile?: string;
  args?: Record<string, string>;
}
export interface Inspection {
  state: string;
  instanceId?: string;
  version?: string;
  protocol?: number;
  peers: RecoveryPeer[];
  recovery?: { operationId?: string; phase?: string; ready?: boolean };
  blockers: string[];
}
export interface PlannedProject {
  project: Project;
  source: Inspection;
  terminals: unknown[];
  blockers: string[];
}
export interface UpgradePlan {
  schema: 1;
  kind: "restart" | "upgrade";
  version: string;
  integrity?: string;
  sourceRoot: string;
  sourceDigest: string;
  projects: PlannedProject[];
  fingerprint: string;
  blockers: string[];
}
export interface ProjectProgress {
  id: string;
  phase: "pending" | "prepared" | "stopped" | "started" | "peers-restored" | "verified";
  instanceId?: string;
  terminals: Record<string, unknown>;
  releaseRequested?: boolean;
}
export interface RecoveryOperation {
  schema: 1;
  id: string;
  plan: UpgradePlan;
  createdAt: number;
  updatedAt: number;
  phase: "pending" | "running" | "blocked" | "completed" | "cancelled";
  step: string;
  sourceRoot: string;
  targetRoot?: string;
  targetDigest?: string;
  projects: ProjectProgress[];
  pluginInstalled?: boolean;
  globalInstalled?: boolean;
  error?: string;
}

/** Registry reads for planning must not create a registry or run migrations. */
export function registeredProjects(home = hubHome()): Project[] {
  const path = join(home, "registry.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT id, root, state_dir as stateDir, base_port as basePort, instance_id as instanceId, pid FROM projects ORDER BY root").all() as Project[];
  } finally { db.close(); }
}

export function planFingerprint(plan: Omit<UpgradePlan, "fingerprint">): string {
  const stable = { ...plan, projects: plan.projects.map((p) => ({ ...p, source: { ...p.source, recovery: undefined,
    peers: p.source.peers.map(({ state, ...peer }) => ({ ...peer, active: state !== "offline" })) } })) };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function createOperation(plan: UpgradePlan, sourceRoot: string, home = hubHome()): RecoveryOperation {
  if (plan.blockers.length || plan.projects.some((p) => p.blockers.length)) throw new Error("upgrade plan has blockers; no runtimes were changed");
  if (!plan.projects.length) throw new Error("no running projects to recover");
  const { fingerprint, ...body } = plan;
  if (planFingerprint(body) !== fingerprint) throw new Error("upgrade plan fingerprint is invalid");
  const id = randomUUID();
  const op: RecoveryOperation = {
    schema: 1, id, plan, sourceRoot, createdAt: Date.now(), updatedAt: Date.now(), phase: "pending", step: "stage",
    projects: plan.projects.map((p) => ({ id: p.project.id, phase: "pending", terminals: {} })),
  };
  writeOperation(id, op, home);
  acquireRecoveryLock(id, home);
  return op;
}

function validateReceipt(id: string, op: RecoveryOperation): void {
  if (op.schema !== 1 || op.id !== id) throw new Error("unsupported operation receipt");
  const { fingerprint, ...reviewed } = op.plan;
  if (fingerprint !== planFingerprint(reviewed) || op.projects.length !== op.plan.projects.length ||
      op.projects.some((p, i) => p.id !== op.plan.projects[i]?.project.id)) throw new Error("reviewed operation plan or project scope changed");
}

export interface RecoveryDriver {
  stage(op: RecoveryOperation): Promise<{ root: string; digest: string }>;
  inspect(project: Project): Promise<Inspection>;
  prepare(project: Project, operation: string, instance: string): Promise<void>;
  abort(project: Project, operation: string, instance: string): Promise<void>;
  commit(project: Project, operation: string, instance: string): Promise<void>;
  closeTerminals(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, save: () => void): Promise<void>;
  start(project: Project, op: RecoveryOperation): Promise<void>;
  restore(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, group: "native" | "claude", save: () => void): Promise<void>;
  installPlugin(op: RecoveryOperation): Promise<void>;
  installGlobal(op: RecoveryOperation): Promise<void>;
  refreshManager?(op: RecoveryOperation): Promise<void>;
  release(project: Project, operation: string, instance: string): Promise<void>;
  verify(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Resumable state machine. Driver actions are preceded by receipts and followed by live readback. */
export async function runRecovery(id: string, driver: RecoveryDriver, home = hubHome(), idleTimeoutMs = 600_000): Promise<RecoveryOperation> {
  // Read once to validate the selector, then claim the runner before trusting any
  // mutable phase. A concurrent runner may have completed the operation meanwhile.
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op);
  acquireRecoveryLock(id, home);
  const releaseRunner = claimRunner(id, home);
  try {
    op = readOperation<RecoveryOperation>(id, home);
    validateReceipt(id, op);
    if (op.phase === "completed" || op.phase === "cancelled") {
      if (recoveryLock(home) === id) releaseRecoveryLock(id, home);
      releaseRunner();
      return op;
    }
  } catch (error) { releaseRunner(); throw error; }
  const save = () => { op.updatedAt = driver.now(); writeOperation(id, op, home); };
  const step = (value: string) => { op.step = value; save(); };
  const identity = (observed: Inspection, planned: PlannedProject, progress: ProjectProgress) => {
    if (observed.state !== "running") throw new Error(`${planned.project.id}: runtime is ${observed.state}`);
    if (progress.instanceId && observed.instanceId !== progress.instanceId) throw new Error("daemon instance changed; refusing to act on its replacement");
    if (observed.recovery?.operationId !== id) throw new Error("daemon is not owned by this recovery operation");
    if (observed.version !== op.plan.version) throw new Error("target daemon version mismatch");
  };
  const sourceRoster = (live: Inspection, planned: PlannedProject) => {
    const expected = planned.source.peers.filter((p) => p.state !== "offline");
    const active = live.peers.filter((p) => p.state !== "offline");
    if (active.length !== expected.length || expected.some((peer) => {
      const current = active.find((p) => p.id === peer.id);
      return !current || current.threadId !== peer.threadId || current.sessionId !== peer.sessionId;
    })) throw new Error("source conversation or active peer membership changed; make a new plan");
  };
  try {
    op.phase = "running"; delete op.error; save();
    step("stage");
    const target = await driver.stage(op);
    if (op.targetDigest && (target.root !== op.targetRoot || target.digest !== op.targetDigest)) throw new Error("staged target changed since operation started");
    op.targetRoot = target.root; op.targetDigest = target.digest; save();

    // Check every untouched source before stopping even the first project.
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!;
      if (progress.phase !== "pending") continue;
      const live = await driver.inspect(planned.project);
      if (live.state !== "running" || live.instanceId !== planned.source.instanceId || live.version !== planned.source.version) {
        throw new Error(`${planned.project.id}: source runtime changed; make a new plan`);
      }
      sourceRoster(live, planned);
    }
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!, project = planned.project;
      if (progress.phase === "verified" || progress.phase === "peers-restored") continue;
      if (progress.phase === "pending") {
        step(`prepare:${project.id}`);
        await driver.prepare(project, id, planned.source.instanceId!);
        const deadline = driver.now() + idleTimeoutMs;
        for (;;) {
          const live = await driver.inspect(project);
          if (live.instanceId !== planned.source.instanceId) throw new Error("source daemon changed during preparation");
          if (live.recovery?.operationId !== id) throw new Error("preparation expired or belongs to another operation");
          if (live.recovery.ready) { sourceRoster(live, planned); break; }
          if (driver.now() >= deadline) {
            await driver.abort(project, id, planned.source.instanceId!);
            throw new Error(`${project.id}: active turns or approvals did not finish; source runtime left running`);
          }
          await driver.sleep(250);
        }
        progress.phase = "prepared"; save();
      }
      if (progress.phase === "prepared") {
        step(`commit:${project.id}`);
        let live = await driver.inspect(project);
        if (live.state === "running" && live.instanceId === planned.source.instanceId) {
          if (live.recovery?.operationId !== id || !live.recovery.ready) throw new Error("source is no longer prepared");
          await driver.closeTerminals(planned, progress, op, save);
          await driver.commit(project, id, planned.source.instanceId!);
          const deadline = driver.now() + 30_000;
          do {
            live = await driver.inspect(project);
            if (live.state === "stopped") break;
            if (live.instanceId && live.instanceId !== planned.source.instanceId) throw new Error("another daemon started during shutdown");
            await driver.sleep(100);
          } while (driver.now() < deadline);
        }
        if (live.state !== "stopped") throw new Error("old shutdown is not verified; not starting a second daemon");
        progress.phase = "stopped"; save();
      }
      if (progress.phase === "stopped") {
        step(`start:${project.id}`);
        let live = await driver.inspect(project);
        if (live.state === "stopped") {
          await driver.start(project, op);
          live = await driver.inspect(project);
        }
        identity(live, planned, progress);
        progress.instanceId = live.instanceId; progress.phase = "started"; save();
      }
      if (progress.phase === "started") {
        identity(await driver.inspect(project), planned, progress);
        step(`restore:${project.id}`);
        await driver.restore(planned, progress, op, "native", save);
        progress.phase = "peers-restored"; save();
      }
    }
    // Claude is deliberately a shared final phase: no project-level plugin isolation is claimed.
    if (op.plan.kind === "upgrade" && !op.pluginInstalled) {
      step("install-plugin"); await driver.installPlugin(op); op.pluginInstalled = true; save();
    }
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!;
      if (progress.phase === "verified") continue;
      const observed = await driver.inspect(planned.project);
      identity(observed, planned, progress);
      if (progress.releaseRequested && observed.recovery?.phase === "released") {
        // Queues and tasks may legitimately change after release. Never replay or compare
        // that live work to the old snapshot when only the release reply was lost.
        progress.phase = "verified"; save(); continue;
      }
      step(`restore-claude:${planned.project.id}`);
      await driver.restore(planned, progress, op, "claude", save);
      await driver.verify(planned, progress, op);
      step(`release:${planned.project.id}`);
      progress.releaseRequested = true; save();
      await driver.release(planned.project, id, progress.instanceId!);
      progress.phase = "verified"; save();
    }
    if (driver.refreshManager) { step("refresh-manager"); await driver.refreshManager(op); }
    if (op.plan.kind === "upgrade" && !op.globalInstalled) {
      step("install-global"); await driver.installGlobal(op); op.globalInstalled = true; save();
    }
    releaseRecoveryLock(id, home); op.phase = "completed"; step("completed");
  } catch (error) {
    op.phase = "blocked"; op.error = error instanceof Error ? error.message : "recovery failed"; save();
  } finally { releaseRunner(); }
  return op;
}

export function publicOperation(op: RecoveryOperation) {
  return { id: op.id, phase: op.phase, step: op.step, version: op.plan.version, updatedAt: op.updatedAt,
    projects: op.projects.map((p) => ({ id: p.id, phase: p.phase })), ...(op.error ? { error: op.error } : {}) };
}

/** Escape a blocked preflight without abandoning a stopped runtime or an uncertain terminal mutation. */
export async function abortRecovery(id: string, driver: RecoveryDriver, home = hubHome()): Promise<void> {
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op);
  acquireRecoveryLock(id, home);
  const releaseRunner = claimRunner(id, home);
  try {
    // Re-read after the exclusive runner claim so cancellation cannot act on a
    // stale pending/prepared receipt after another runner advanced it.
    op = readOperation<RecoveryOperation>(id, home);
    validateReceipt(id, op);
    if (op.phase === "completed" || op.phase === "cancelled") {
      if (recoveryLock(home) === id) releaseRecoveryLock(id, home);
      return;
    }
    if (op.projects.some((p) => !["pending", "prepared"].includes(p.phase) || Object.keys(p.terminals).length)) {
      throw new Error("operation has stopped runtimes or uncertain terminal effects; resume it instead");
    }
    const { fingerprint, ...body } = op.plan;
    if (fingerprint !== planFingerprint(body)) throw new Error("operation plan changed");
    for (const planned of op.plan.projects) {
      const live = await driver.inspect(planned.project);
      if (live.recovery?.operationId === id) {
        if (live.instanceId !== planned.source.instanceId || !["preparing", "prepared"].includes(live.recovery.phase ?? "")) throw new Error("recovery has progressed; resume it instead");
        await driver.abort(planned.project, id, planned.source.instanceId!);
      } else if (op.projects.find((p) => p.id === planned.project.id)?.phase === "prepared") {
        throw new Error("prepared source outcome is uncertain; resume it instead");
      }
    }
    op.phase = "cancelled"; op.step = "cancelled"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home);
  } finally { releaseRunner(); }
}
