import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../hub/registry.ts";
import { hubHome } from "../hub/project.ts";
import { acquireRecoveryLock, claimRunner, coordinatorCurrent, readOperation, recoveryCommand, recoveryLock, releaseRecoveryLock, writeOperation } from "../hub/recovery-store.ts";

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

export { recoveryCommand };
const STOP = "--stop-and-archive --reason <text>";
/**
 * Whether the staged target reads recovery waivers: a fresh session cannot be released without them. The one waiver
 * check (status, dispose, staging and restore all use it).
 * ponytail: a text sniff of the target's restart.ts; a rename or re-export reads as "no waivers" (the safe side). Upgrade
 * path: a capability list in package.json read here and by coordinatorCurrent.
 */
export function targetReadsWaivers(op: { targetRoot?: string }): boolean {
  try { return !!op.targetRoot && readFileSync(join(op.targetRoot, "src/hub/restart.ts"), "utf8").includes("export function readRecoveryWaivers"); } catch { return false; }
}

/** Effects anywhere in the operation: a project past `prepared` or any terminal receipt. Abort needs none. */
export const hasEffects = (op: RecoveryOperation) => op.projects.some((p) => !["pending", "prepared"].includes(p.phase) || Object.keys(p.terminals).length > 0);
/**
 * #215: why abort would refuse, or undefined when it can cancel. Abort and `next` both ask this, so `next` never
 * offers an abort that refuses. `live` holds inspections of the operation's projects. A #215 coordinator writes
 * `commitSent` before every commit request, so its receipt alone rules a commit in or out; an older one does not,
 * and a prepared source of its operation that is not running (or was not inspected) may have committed.
 */
export function abortRefusal(op: RecoveryOperation, live: Record<string, Inspection | undefined> = {}): string | undefined {
  if (op.disposition) return "a stop-and-archive of this operation is partway";
  if (hasEffects(op)) return "operation has stopped runtimes or uncertain terminal effects";
  const recorded = !op.sourceRoot || coordinatorCurrent(op.sourceRoot);
  for (let i = 0; i < op.projects.length; i++) {
    const progress = op.projects[i]!, planned = op.plan.projects[i]!, state = live[progress.id];
    if (progress.commitSent) return `${progress.id}: its commit request may have been sent`;
    if (state?.recovery?.operationId === op.id && state.recovery.phase !== "released" &&
        (state.instanceId !== planned.source.instanceId || !["preparing", "prepared"].includes(state.recovery.phase ?? ""))) return `${progress.id}: recovery has progressed`;
    // A #215 coordinator's prepared source that stopped was never asked to commit; one that cannot be read (unavailable,
    // stopping, not inspected) may still hold this operation's hold. An older coordinator records no sent commit.
    if (progress.phase === "prepared" && state?.state !== "running" && (!recorded || state?.state !== "stopped")) {
      return recorded ? `${progress.id}: the source reads as ${state?.state ?? "not inspected"}, so whether this operation's hold still stands is uncertain`
        : `${progress.id}: the source is ${state?.state ?? "not inspected"} and may have committed (this operation's coordinator does not record a sent commit)`;
    }
  }
  return undefined;
}

/**
 * #215: what the person can do now, in the receipt table's order: resume (it also launches a failed peer again),
 * abort where it can succeed, a fresh session for a failed Codex or Claude restoration, and stop-and-archive last.
 * `status` and every error that names choices use this one list.
 */
export function nextActions(receipt: RecoveryOperation, runner?: number | "unknown", live: Record<string, Inspection | undefined> = {}): string[] {
  // A receipt read without its project lists (never written so by a coordinator) still gets the general choices.
  const op: RecoveryOperation = receipt.projects ? receipt : { ...receipt, projects: [], plan: { ...receipt.plan, projects: receipt.plan?.projects ?? [] } };
  if (op.phase === "completed" || op.phase === "cancelled") return [];
  if (runner === "unknown") return [`${recoveryCommand(op, "status")} again: whether a runner holds the operation could not be read`];
  if (runner) return [`wait: runner ${runner} is working; ${recoveryCommand(op, "status")}`];
  if (op.disposition) return [`rerun ${recoveryCommand(op, "dispose", STOP)} once its runtimes have settled`];
  const failed = [...new Set(op.projects.flatMap((p) => failedPeers(op, p)))];
  const waivers = targetReadsWaivers(op);
  const old = !!op.sourceRoot && !coordinatorCurrent(op.sourceRoot);
  const abortable = !abortRefusal(op, live);
  // Resume can never get past a source replaced by another instance (a stopped one comes back as another), nor a
  // prepared source of this coordinator that stopped with no commit request: there is nothing to start from.
  const stuck = op.projects.some((p, i) => {
    const state = live[p.id], planned = op.plan.projects[i];
    if (!state || !planned || !["pending", "prepared"].includes(p.phase)) return false;
    if (state.state === "running") return state.instanceId !== planned.source.instanceId;
    return state.state === "stopped" && (p.phase === "pending" || (!p.commitSent && !old));
  });
  return [
    ...(stuck ? [] : [`${recoveryCommand(op, "resume")}${op.error ? " (after the next action in error)" : ""}${old ? ` (runs the coordinator that started this operation, which cannot re-prepare an expired hold: if it reports "source is no longer prepared", use ${abortable ? "abort or " : ""}stop-and-archive)` : ""}`]),
    ...(abortable ? [recoveryCommand(op, "abort")] : []),
    ...(waivers ? failed.map((peer) => recoveryCommand(op, "dispose", `--fresh-session ${peer} --reason <text>`)) : []),
    ...(!waivers && failed.length ? [`(no --fresh-session: target ${op.plan.version} cannot read recovery waivers, so it could not release a new session)`] : []),
    recoveryCommand(op, "dispose", STOP),
  ];
}

/**
 * "next actions: ..." from nextActions, with the inspections the caller holds. Every error that lists choices ends with
 * it, after only its own peer-specific step ("end that codex session", "close Orca terminal <h>"), so no error offers
 * an abort that abort refuses or leaves out one that would succeed.
 */
export const nextActionsText = (op: RecoveryOperation, live: Record<string, Inspection | undefined> = {}): string => `next actions: ${nextActions(op, undefined, live).join(" | ")}`;

/**
 * #215: what `next` reads, the same for status, abort and the runner's errors: every source not yet stopped by this
 * operation (all of them before any effect). An inspection that throws reads as not inspected, never as stopped.
 */
export async function liveSources(op: RecoveryOperation, inspect: (project: Project) => Promise<Inspection>): Promise<Record<string, Inspection | undefined>> {
  if (op.disposition || op.phase === "completed" || op.phase === "cancelled") return {};
  const open = op.plan.projects.filter((_, i) => ["pending", "prepared"].includes(op.projects[i]?.phase ?? ""));
  return Object.fromEntries(await Promise.all(open.map(async (p) => [p.project.id, await inspect(p.project).catch(() => undefined)] as const)));
}

/**
 * Peers of a project whose restoration failed and for which a fresh session is a real choice: not Pi (a restored hub
 * resumes its recorded session), not one already chosen, and not a planned fresh start (nothing to lose; resume
 * launches it new again).
 */
function failedPeers(op: RecoveryOperation, progress: ProjectProgress): string[] {
  const planned = op.plan.projects.find((p) => p.project.id === progress.id);
  return Object.entries(progress.terminals).filter(([key, value]) => key.startsWith("restored:") && value === "failed").map(([key]) => key.slice("restored:".length))
    .filter((peer) => peer !== "pi" && !progress.fresh?.[peer] && !planned?.freshStart?.includes(peer));
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
    if (hasEffects(op)) throw new Error(`${planned.project.id}: ${changed.id} changed while this operation has recorded effects, so a new plan cannot replace it; ${fix} before resuming`);
    // The lock this operation holds refuses a new upgrade until the operation is cancelled or ended.
    throw new Error(`${planned.project.id}: source conversation or active peer membership changed; a new plan can be made once this operation is cancelled or ended`);
  };
  // Prepare, or after an expired lease re-prepare, the planned source and wait until it is quiet.
  const prepareSource = async (planned: PlannedProject, progress: ProjectProgress, again = false) => {
    const project = planned.project, instance = planned.source.instanceId!;
    await driver.prepare(project, id, instance);
    const deadline = driver.now() + idleTimeoutMs;
    for (;;) {
      const live = await driver.inspect(project);
      if (live.instanceId !== instance) throw new Error(`${project.id}: source daemon changed during preparation`);
      if (live.recovery?.operationId !== id) throw new Error(`${project.id}: the preparation expired or another operation holds the source (resume prepares it again)`);
      if (live.recovery.ready) return sourceRoster(live, planned, progress, again);
      if (driver.now() >= deadline) {
        await driver.abort(project, id, instance);
        throw new Error(`${project.id}: active turns, approvals or completion checks did not finish; source runtime left running`);
      }
      await driver.sleep(250);
    }
  };
  try {
    if (op.disposition) {
      // The stop-and-archive in progress keeps its own cause; resume never runs an operation being abandoned.
      op.error ??= `a stop-and-archive of this operation is partway; ${nextActionsText(op)}`;
      op.phase = "blocked"; save();
      return op;
    }
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
        throw new Error(`${planned.project.id}: source runtime changed`);
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
            if (other && other !== id && live.recovery?.phase !== "released") throw new Error(`${project.id}: the source is held by another recovery operation ${other}; nothing was prepared, closed or stopped, and ending this one leaves that hold alone`);
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
            if (live.instanceId && live.instanceId !== planned.source.instanceId) throw new Error(`${project.id}: another daemon started during shutdown`);
            await driver.sleep(100);
          } while (driver.now() < deadline);
        } else if (live.state === "running") {
          throw new Error(`${project.id}: the source daemon was replaced by instance ${live.instanceId ?? "unknown"}; refusing to prepare, close or stop it (ending this operation leaves that daemon running)`);
        } else if (live.state === "stopped" && !progress.commitSent && (!op.sourceRoot || coordinatorCurrent(op.sourceRoot))) {
          // #215: this coordinator records a commit request before sending it, so a stopped source with none crashed while
          // prepared: no snapshot was committed and there is nothing to start from. The phase stays `prepared`.
          throw new Error(`${project.id}: the source stopped while prepared and no commit was requested, so there is nothing to restore`);
        }
        if (live.state !== "stopped") throw new Error(`${project.id}: old shutdown is not verified (the source reads as ${live.state}); not starting a second daemon; check ${recoveryCommand(op, "status")} once it answers`);
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
    // #215: every runner error ends with the choices status shows, read from every open source, never only this one.
    const next = nextActionsText(op, await liveSources(op, driver.inspect));
    op.phase = "blocked"; op.error = `${error instanceof Error ? error.message : "recovery failed"}; ${next}`; save();
  } finally { releaseRunner(); }
  return op;
}

/** Receipts and runner state only (#215): ids, phases and effects, never task or message text. */
export function publicOperation(op: RecoveryOperation, runnerPid?: number | "unknown", live: Record<string, Inspection | undefined> = {}) {
  const effect = (value: unknown) => value === "pending" || value === "failed" ? value : "done";
  const next = nextActions(op, runnerPid, live);
  return { id: op.id, phase: op.phase, step: op.step, version: op.plan.version, updatedAt: op.updatedAt,
    runner: runnerPid === "unknown" ? { state: "unknown" } : runnerPid ? { state: "running", pid: runnerPid } : { state: "none" },
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
    const { fingerprint, ...body } = op.plan;
    if (fingerprint !== planFingerprint(body)) throw new Error("operation plan changed");
    const live = await liveSources(op, driver.inspect);
    const refusal = abortRefusal(op, live);
    if (refusal) throw new Error(`abort refused: ${refusal}; ${nextActionsText(op, live)}`);
    // Only this operation's own uncommitted holds are aborted; a lapsed hold, a replacement daemon or another
    // operation's hold is left alone, and a source that is not running had no commit sent (abortRefusal).
    for (const planned of op.plan.projects) {
      const state = live[planned.project.id];
      if (state?.recovery?.operationId === id && state.recovery.phase !== "released") await driver.abort(planned.project, id, planned.source.instanceId!);
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
      if (choice.fresh === "pi") throw new Error(`pi: --fresh-session is not supported: a restored hub resumes Pi's recorded session, so a fresh one cannot be guaranteed; ${nextActionsText(op)}`);
      if (op.disposition) throw new Error(`a stop-and-archive of this operation is partway; ${nextActionsText(op)}`);
      if (!targetReadsWaivers(op)) throw new Error(`--fresh-session is not available: target ${op.plan.version} cannot read recovery waivers, so it could not release a new session; ${nextActionsText(op)}`);
      const peer = choice.fresh;
      // Per project: a planned fresh start has nothing to lose, so only the other failed projects take the choice.
      const failed = op.projects.filter((p) => failedPeers(op, p).includes(peer));
      if (!failed.length && op.projects.some((p) => p.terminals[`restored:${peer}`] === "failed" && op.plan.projects.find((planned) => planned.project.id === p.id)?.freshStart?.includes(peer))) {
        throw new Error(`${peer}: its plan already restarts it as a new session (no rollout and no turn, nothing to lose), so there is no conversation to record as lost; ${nextActionsText(op)}`);
      }
      if (!failed.length) throw new Error(`${peer}: no failed restoration of it is open to a fresh session (none failed, or one is already chosen); --fresh-session applies only then (${recoveryCommand(op, "status")})`);
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
          ? `source left running (${live.recovery?.operationId && live.recovery.phase !== "released" ? `held by another operation, ${live.recovery.operationId}` : progress.phase === "prepared" ? "its hold had lapsed" : "never prepared"})`
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
      op.error = `stop-and-archive stopped partway and keeps the lock: ${error instanceof Error ? error.message : "disposition failed"} (a committed source stops by itself); ${nextActionsText(op)}`;
      writeOperation(id, op, home);
      throw error;
    }
    delete op.error;
    op.phase = "cancelled"; op.step = "disposed: stop-and-archive (abandoned, not completed)"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home);
    return op;
  } finally { releaseRunner(); }
}
