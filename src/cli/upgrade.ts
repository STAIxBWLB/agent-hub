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
  /** Unmanaged sessions (#206): their plugin reattaches to the new daemon; no terminal is closed or relaunched and no session id is compared. */
  reconnectOnly?: string[];
  /** #215: Codex threads with no rollout and no turn the hub recorded; they restart as a new session, nothing to lose. */
  freshStart?: string[];
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
  /** #215: peers the operator moved to a fresh session, with the session or thread id whose continuity is lost. */
  fresh?: Record<string, { lost: string; reason: string; at: number }>;
  /** #215: set before the commit request is sent; from then on the source may have committed (abort is not offered). */
  commitSent?: boolean;
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
  /** #215: every human disposition, in order. Operator reasons only; never task or message text. */
  audit?: { at: number; action: "fresh-session" | "stop-and-archive"; reason: string; peer?: string; projects: string[] }[];
  disposition?: { choice: "stop-and-archive"; at: number; projects: Record<string, string> };
}

/**
 * #215: the command line of this operation's own coordinator, which has every recovery command. Mid-upgrade the global
 * `ahub` may still be the older release, so next actions and errors never name it bare.
 */
export function recoveryCommand(op: { id: string; sourceRoot?: string }, action: "status" | "resume" | "abort" | "dispose", flags = ""): string {
  // An operation started by an older coordinator is resumed by it, but only a release with dispose can dispose of it.
  const entry = !op.sourceRoot ? undefined : action === "dispose" && !hasDispose(op.sourceRoot) ? join(import.meta.dir, "main.js") : join(op.sourceRoot, "src/cli/main.js");
  const cli = !entry ? "ahub" : /^[\w./@+-]+$/.test(entry) ? `bun ${entry}` : `bun '${entry.replace(/'/g, `'\\''`)}'`;
  return `${cli} recovery ${action} ${op.id}${flags ? ` ${flags}` : ""}`;
}
const STOP = "--stop-and-archive --reason <text>";
function hasDispose(sourceRoot: string): boolean {
  try { return readFileSync(join(sourceRoot, "src/cli/upgrade.ts"), "utf8").includes("export async function disposeRecovery"); } catch { return false; }
}

/** Effects anywhere in the operation: a project past `prepared` or any terminal receipt. Abort needs none. */
export const hasEffects = (op: RecoveryOperation) => op.projects.some((p) => !["pending", "prepared"].includes(p.phase) || Object.keys(p.terminals).length > 0);
/** Abort is offered only where the receipt shows it can succeed: no effects, and no commit that may have been sent. */
const abortable = (op: RecoveryOperation) => !hasEffects(op) && !op.projects.some((p) => p.commitSent);

/**
 * #215: what the person can do now, in the receipt table's order: resume (it also launches a failed peer again),
 * abort where it can succeed, a fresh session for a failed Codex or Claude restoration, and stop-and-archive last.
 * `status` and every error that names choices use this one list.
 */
export function nextActions(op: RecoveryOperation, runnerPid?: number): string[] {
  if (op.phase === "completed" || op.phase === "cancelled") return [];
  if (runnerPid) return [`wait: runner ${runnerPid} is working; ${recoveryCommand(op, "status")}`];
  if (op.disposition) return [`rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled`];
  const failed = [...new Set(op.projects.flatMap((p) => Object.entries(p.terminals).filter(([key, value]) => key.startsWith("restored:") && key !== "restored:pi" && value === "failed" && !p.fresh?.[key.slice("restored:".length)]).map(([key]) => key.slice("restored:".length))))];
  return [
    `${recoveryCommand(op, "resume")}${op.error ? " (after the next action in error)" : ""}`,
    ...(abortable(op) ? [recoveryCommand(op, "abort")] : []),
    ...failed.map((peer) => recoveryCommand(op, "dispose", `--fresh-session ${peer} --reason <text>`)),
    recoveryCommand(op, "dispose", STOP),
  ];
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
  /** #215 stop-and-archive: stop this operation's unreleased target (when given) and archive its committed snapshot. */
  stopAndArchive(project: Project, op: RecoveryOperation, targetInstance?: string): Promise<void>;
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
  const sourceRoster = (live: Inspection, planned: PlannedProject, progress: ProjectProgress, again = false) => {
    // #215: a peer whose terminal this operation already closed must stay detached after a re-preparation, and a
    // planned peer that detached since may pass it, as the daemon's readiness lets it (#21): closeTerminals then
    // records its close only once Orca no longer lists the terminal.
    const closed = (peer: string) => progress.terminals[`closed:${peer}`] === true;
    const expected = planned.source.peers.filter((p) => p.state !== "offline");
    const active = live.peers.filter((p) => p.state !== "offline");
    const extra = active.find((p) => !expected.some((peer) => peer.id === p.id));
    const changed = extra ?? expected.find((peer) => {
      const current = active.find((p) => p.id === peer.id);
      if (closed(peer.id)) return !!current;
      if (!current) return !again;
      return !planned.reconnectOnly?.includes(peer.id) && (current.threadId !== peer.threadId || current.sessionId !== peer.sessionId);
    });
    if (!changed) return;
    // A session that is not in the plan, or whose terminal this operation closed, has no original to restore.
    const fix = extra || closed(changed.id) ? `end that ${changed.id} session` : `restore ${changed.id}'s original session`;
    if (hasEffects(op)) throw new Error(`${planned.project.id}: ${changed.id} changed while this operation has recorded effects, so a new plan cannot replace it; next action: ${fix}, then ${recoveryCommand(op, "resume")}; or ${recoveryCommand(op, "dispose", STOP)}`);
    // The lock this operation holds refuses a new upgrade until the operation is cancelled.
    throw new Error(`source conversation or active peer membership changed; next action: ${recoveryCommand(op, "abort")}, then make a new plan`);
  };
  // A changed source cannot be planned again while this operation holds the lock: cancel it (abort leaves a running
  // replacement alone) or, once anything was done, end it.
  const wayOut = () => hasEffects(op) ? recoveryCommand(op, "dispose", STOP) : `${recoveryCommand(op, "abort")}, then make a new plan`;
  // Prepare, or after an expired lease re-prepare, the planned source and wait until it is quiet.
  const prepareSource = async (planned: PlannedProject, progress: ProjectProgress, again = false) => {
    const project = planned.project, instance = planned.source.instanceId!;
    await driver.prepare(project, id, instance);
    const deadline = driver.now() + idleTimeoutMs;
    for (;;) {
      const live = await driver.inspect(project);
      if (live.instanceId !== instance) throw new Error(`${project.id}: source daemon changed during preparation; next action: ${wayOut()}`);
      if (live.recovery?.operationId !== id) throw new Error(`${project.id}: the preparation expired or another operation holds the source; next action: ${recoveryCommand(op, "resume")} prepares it again, or ${wayOut()}`);
      if (live.recovery.ready) return sourceRoster(live, planned, progress, again);
      if (driver.now() >= deadline) {
        await driver.abort(project, id, instance);
        throw new Error(`${project.id}: active turns, approvals or completion checks did not finish; source runtime left running`);
      }
      await driver.sleep(250);
    }
  };
  try {
    if (op.disposition) throw new Error(`a stop-and-archive of this operation is partway; next action: rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled`);
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
        throw new Error(`${planned.project.id}: source runtime changed; next action: ${wayOut()}`);
      }
      sourceRoster(live, planned, progress);
    }
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!, project = planned.project;
      if (progress.phase === "verified" || progress.phase === "peers-restored") continue;
      if (progress.phase === "pending") {
        step(`prepare:${project.id}`);
        await prepareSource(planned, progress);
        progress.phase = "prepared"; save();
      }
      if (progress.phase === "prepared") {
        step(`commit:${project.id}`);
        let live = await driver.inspect(project);
        if (live.state === "running" && live.instanceId === planned.source.instanceId) {
          if (live.recovery?.operationId !== id || !live.recovery.ready) {
            const other = live.recovery?.operationId;
            if (other && other !== id && live.recovery?.phase !== "released") throw new Error(`${project.id}: the source is held by another recovery operation ${other}; nothing was prepared, closed or stopped; next action: ${recoveryCommand(op, "status")}, then ${recoveryCommand(op, "dispose", STOP)} ends this operation and leaves that hold alone`);
            // #215: the hold lapsed (an expired lease) after this operation may have recorded terminal effects.
            // Re-prepare the same verified source; the receipts stay, so no terminal is closed twice.
            step(`reprepare:${project.id}`);
            await prepareSource(planned, progress, true);
            step(`commit:${project.id}`);
          } else {
            // #215: a hold of ours can predate a roster change, as after a resume whose roster check failed: check again.
            sourceRoster(live, planned, progress, true);
          }
          await driver.closeTerminals(planned, progress, op, save);
          // Durable, unlike `step`: from here the source may have committed, which status and abort must not forget.
          progress.commitSent = true; save();
          await driver.commit(project, id, planned.source.instanceId!);
          const deadline = driver.now() + 30_000;
          do {
            live = await driver.inspect(project);
            if (live.state === "stopped") break;
            if (live.instanceId && live.instanceId !== planned.source.instanceId) throw new Error("another daemon started during shutdown");
            await driver.sleep(100);
          } while (driver.now() < deadline);
        } else if (live.state === "running") {
          throw new Error(`${project.id}: the source daemon was replaced by instance ${live.instanceId ?? "unknown"}; refusing to prepare, close or stop it; next action: ${recoveryCommand(op, "status")} lists the recorded effects, and ${recoveryCommand(op, "dispose", STOP)} ends this operation, leaving that daemon running`);
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

/** Receipts and runner state only (#215): ids, phases and effects, never task or message text. */
export function publicOperation(op: RecoveryOperation, runnerPid?: number) {
  const effect = (value: unknown) => value === "pending" || value === "failed" ? value : "done";
  const next = nextActions(op, runnerPid);
  return { id: op.id, phase: op.phase, step: op.step, version: op.plan.version, updatedAt: op.updatedAt,
    runner: runnerPid ? { state: "running", pid: runnerPid } : { state: "none" },
    ...(op.phase === "running" && !runnerPid ? { stale: "the receipt says running but no runner holds the operation: its last runner stopped mid-step" } : {}),
    projects: op.projects.map((p) => ({ id: p.id, phase: p.phase, ...(Object.keys(p.terminals).length ? { effects: Object.fromEntries(Object.entries(p.terminals).map(([key, value]) => [key, effect(value)])) } : {}),
      ...(p.fresh ? { lostContinuity: Object.fromEntries(Object.entries(p.fresh).map(([peer, f]) => [peer, f.lost])) } : {}) })),
    pluginInstalled: !!op.pluginInstalled, globalInstalled: !!op.globalInstalled,
    ...(op.error ? { error: op.error } : {}), ...(op.disposition ? { disposition: op.disposition } : {}), ...(op.audit ? { audit: op.audit } : {}), next };
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
    if (op.disposition) throw new Error(`a stop-and-archive of this operation is partway; next action: rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled`);
    if (hasEffects(op)) {
      throw new Error(`operation has stopped runtimes or uncertain terminal effects; resume it instead (${recoveryCommand(op, "resume")}), or end it with ${recoveryCommand(op, "dispose", STOP)}`);
    }
    const { fingerprint, ...body } = op.plan;
    if (fingerprint !== planFingerprint(body)) throw new Error("operation plan changed");
    for (const planned of op.plan.projects) {
      const live = await driver.inspect(planned.project);
      if (live.recovery?.operationId === id && live.recovery.phase !== "released") {
        if (live.instanceId !== planned.source.instanceId || !["preparing", "prepared"].includes(live.recovery.phase ?? "")) throw new Error(`recovery has progressed; resume it instead (${recoveryCommand(op, "resume")})`);
        await driver.abort(planned.project, id, planned.source.instanceId!);
      } else if (op.projects.find((p) => p.id === planned.project.id)?.phase === "prepared" && live.state !== "running") {
        // #215: a source that is not running may have committed. A running one this operation does not hold (its hold
        // lapsed, a replacement daemon, another operation's hold) was never committed by it and is left alone.
        throw new Error(`prepared source outcome is uncertain: ${planned.project.id} is ${live.state} and may have committed; resume it instead (${recoveryCommand(op, "resume")})`);
      }
    }
    op.phase = "cancelled"; op.step = "cancelled"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home);
  } finally { releaseRunner(); }
}

/**
 * #215: the human-only ways out of an operation that cannot restore a native session. `fresh` records the lost
 * conversation and leaves the operation to resume; `stop-and-archive` abandons it, and releases the lock only after
 * every runtime this operation held or started is verified released or stopped.
 */
export async function disposeRecovery(id: string, choice: { fresh: string } | { stop: true }, reason: string, driver: RecoveryDriver, home = hubHome()): Promise<RecoveryOperation> {
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op);
  // A finished operation owns no lock: never take one only to refuse.
  if (op.phase === "completed" || op.phase === "cancelled") throw new Error(`operation is already ${op.phase}`);
  acquireRecoveryLock(id, home);
  const releaseRunner = claimRunner(id, home);
  try {
    op = readOperation<RecoveryOperation>(id, home);
    validateReceipt(id, op);
    if (op.phase === "completed" || op.phase === "cancelled") {
      // Another runner finished it while this one waited: leave no lock behind, as resume and abort do.
      if (recoveryLock(home) === id) releaseRecoveryLock(id, home);
      throw new Error(`operation is already ${op.phase}`);
    }
    const at = driver.now();
    if ("fresh" in choice) {
      // `ahub pi` sends no fresh flag, and a restored hub refills a Pi start from its recorded resume (daemon startPeer).
      if (choice.fresh === "pi") throw new Error(`pi: --fresh-session is not supported: a restored hub resumes Pi's recorded session, so a fresh one cannot be guaranteed; next action: ${recoveryCommand(op, "dispose", STOP)}`);
      if (op.disposition) throw new Error(`a stop-and-archive of this operation is partway; next action: rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled`);
      const peer = choice.fresh;
      const failed = op.projects.filter((p) => p.terminals[`restored:${peer}`] === "failed");
      if (!failed.length) throw new Error(`${peer}: no restoration of it failed in this operation; --fresh-session applies only then (${recoveryCommand(op, "status")})`);
      for (const progress of failed) {
        const binding = (op.plan.projects.find((p) => p.project.id === progress.id)!.terminals as { peer: string; sessionId: string }[]).find((t) => t.peer === peer)!;
        (progress.fresh ??= {})[peer] = { lost: binding.sessionId, reason, at };
      }
      (op.audit ??= []).push({ at, action: "fresh-session", reason, peer, projects: failed.map((p) => p.id) });
      op.updatedAt = at; writeOperation(id, op, home);
      return op;
    }
    // Inspect every project before acting on any, as the runner does before its first stop.
    const acts: { planned: PlannedProject; live?: Inspection; act: string }[] = [];
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!;
      const live = progress.phase === "verified" ? undefined : await driver.inspect(planned.project);
      const ours = live?.state === "running" && live.recovery?.operationId === id && live.recovery.phase !== "released";
      // A target is known by its operation fence, not only by the receipt: `up` may have failed, or the first
      // identity read thrown, after the target started and before its instance was recorded.
      const target = ours && live.instanceId !== planned.source.instanceId && live.recovery?.phase === "restored";
      const act = !live ? "released earlier; left running"
        : live.state === "stopped" ? "stopped"
        : live.state === "missing" ? "project directory is missing; nothing was stopped or archived (ahub doctor --orphans lists a hub left running there)"
        : live.state !== "running" ? undefined
        : ours && live.instanceId === planned.source.instanceId && ["pending", "prepared"].includes(progress.phase) ? "source hold released; source left running"
        : target ? "target stopped"
        : live.instanceId === planned.source.instanceId && ["pending", "prepared"].includes(progress.phase)
          ? `source left running (${progress.phase === "prepared" ? "its hold had lapsed" : "never prepared"})`
        : `left running: instance ${live.instanceId ?? "unknown"} is not held by this operation`;
      if (!act) throw new Error(`${planned.project.id}: runtime is ${live!.state}, so its ownership cannot be verified; nothing was stopped or released; retry once it settles`);
      acts.push({ planned, ...(live ? { live } : {}), act });
    }
    // Each outcome is recorded as it happens, so a disposition that stops partway stays true and resume refuses it.
    const disposition = (op.disposition ??= { choice: "stop-and-archive", at, projects: {} });
    (op.audit ??= []).push({ at, action: "stop-and-archive", reason, projects: acts.map((a) => a.planned.project.id) });
    // Recorded before the first act: a crash inside a stop leaves a disposition that resume refuses to override.
    op.updatedAt = driver.now(); writeOperation(id, op, home);
    try {
      for (const { planned, live, act } of acts) {
        if (act.startsWith("source hold")) await driver.abort(planned.project, id, planned.source.instanceId!);
        else if (act === "stopped" || act === "target stopped") {
          await driver.stopAndArchive(planned.project, op, act === "target stopped" ? live!.instanceId : undefined);
          if ((await driver.inspect(planned.project)).state !== "stopped") throw new Error(`${planned.project.id}: shutdown of instance ${live!.instanceId ?? "unknown"} is not verified`);
        }
        disposition.projects[planned.project.id] ??= act;
        op.updatedAt = driver.now(); writeOperation(id, op, home);
      }
    } catch (error) {
      op.phase = "blocked"; op.updatedAt = driver.now();
      op.error = `stop-and-archive stopped partway and keeps the lock: ${error instanceof Error ? error.message : "disposition failed"}; next action: rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled (a committed source stops by itself)`;
      writeOperation(id, op, home);
      throw error;
    }
    delete op.error;
    op.phase = "cancelled"; op.step = "disposed: stop-and-archive (abandoned, not completed)"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home);
    return op;
  } finally { releaseRunner(); }
}
