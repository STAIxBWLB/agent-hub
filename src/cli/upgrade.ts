import { nativeRestoreGroup } from "../adapters/definitions/native-identity-defaults.ts";
import { definitionOf } from "../adapters/registry.ts";
import { readInstanceConfig } from "../hub/instance-config.ts";
import { validExternalInstanceBinding, type ExternalInstanceBinding } from "../hub/external-instance.ts";
import { LIVE_TEST_PERSON_REFUSAL } from "./identity.ts";
import { checkedSessionPath } from "./recovery-session-file.ts";
import { canChooseFresh, decodeRestoreReceipt, restoreReceiptStatus } from "./upgrade-restore-state.ts";
import { databaseBusySite, isDatabaseBusy, RecoveryDatabaseBusy } from "../hub/recovery-error.ts";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS, PROJECT_COLUMNS, projectFromRow, type Project } from "../hub/registry.ts";
import { hubHome } from "../hub/project.ts";
import { readRecoveryWaits } from "./recovery-waits.ts";
import { acquireRecoveryLock, claimRunner, coordinatorCurrent, operationIdPattern, readOperation, recoveryCommand, recoveryLock, releaseRecoveryLock, writeOperation } from "../hub/recovery-store.ts";
import { resolveAcceptedBinding, piArchiveExit, recordedPeerGuidance, type RecoveryNativePeer } from "./recovery-guidance.ts";
import type { TerminalBinding } from "./terminal-recovery.ts";
import { RecoveryPresentationError, type RecoveryPresentationCause, type RecoveryWaitTiming } from "./upgrade-presentation-data.ts";

const projectDefinition = (peer: string, root?: string) => {
  const builtin = definitionOf(peer);
  if (builtin || !root) return builtin;
  try { const bound = readInstanceConfig(root); return bound.catalog.definitionOf(peer, bound.instances); } catch { return undefined; }
};


export interface RecoveryPeer {
  id: string;
  controlProtocol?: number;
  /** Read-only source observation; never consumed as restoration arguments. */
  observation?: { kind: string; attached: boolean; sessionDigest?: string };
  /** Captured stable module/instance identity; never a portable current-owner proof. */
  externalInstance?: ExternalInstanceBinding;
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
  protocolMin?: number;
  protocolMax?: number;
  peers: RecoveryPeer[];
  /** `waiting` (#272): what the running hub says keeps it from being quiet (busy peers, pending approvals); display only. */
  recovery?: { operationId?: string; phase?: string; ready?: boolean; waiting?: string[] };
  blockers: string[];
  /** #215: for a stopped runtime, the operation whose committed restart snapshot its state dir holds (unreleased). */
  snapshot?: string;
  /** The runtime may be positively stopped while its restart snapshot remains unreadable; never claim ownership. */
  snapshotError?: { code: "recovery_deferred_hub"; message: string };
}
export interface PlannedProject {
  project: Project;
  source: Inspection;
  terminals: unknown[];
  blockers: string[];
  /** Unmanaged sessions (#206): their plugin reattaches to the new daemon; no terminal is closed or relaunched and no session id is compared. */
  reconnectOnly?: string[];
  /** Attached native terminals with neither a current live launcher record nor an independently verified terminal binding. */
  unrecordedTerminals?: string[];
  /** #215: Codex threads with no rollout and no turn the hub recorded; they restart as a new session, nothing to lose. */
  freshStart?: string[];
}
export interface UpgradePlan {
  schema: 1;
  /** Present for new CLI operations; absent only on retained legacy machine-wide plans. */
  scope?: { projectRoot: string };
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
  /** One durable repair allowance per peer, retained after an attempt to prevent a second relaunch. */
  reattachments?: Partial<Record<RecoveryNativePeer, ReattachmentMarker>>;
  /** Recorded-session-only continuity, independent of a target incarnation's repair attempt allowance. */
  repairedSessions?: Partial<Record<RecoveryNativePeer, true>>;
  /** #414: last bounded native-attachment timeout, metadata only; never terminal output or task text. */
  attachmentTimeouts?: Record<string, {
    at: number;
    terminal: { handle: string; incarnationId: string; state: "unknown" | "idle" | "busy" | "exited"; connected?: boolean; orphaned?: boolean };
    hub: { state: string; instanceId?: string; peerState?: string; sessionId?: string };
    /** Client-side attempts are not recorded by the hub; an offline peer is not evidence of an attempt. */
    lastHubConnectAttempt: "unknown";
  }>;
  releaseRequested?: boolean;
  /** #215: peers the operator moved to a fresh session, with the session or thread id whose continuity is lost. */
  fresh?: Record<string, { lost: string; reason: string; at: number; repaired?: true }>;
  /** #215: set before the commit request is sent; from then on the source may have committed (abort is not offered). */
  commitSent?: boolean;
  /**
   * #225: each restart of a target that stopped after it started, recorded before the new one starts: the dead
   * instance and when. Status and audit read it; restore reads the launch records of every instance listed here.
   */
  restarts?: { instanceId: string; at: number }[];
}
export interface ReattachmentMarker {
  state: "ready" | "attempted";
  at: number;
  cause: "detached after restore";
  binding: TerminalBinding;
}
/** Trusted per-invocation attribution from the CLI identity preflight, never authority read from a receipt. */
export interface RecoveryDelegation {
  peer: string;
  command: "upgrade" | "restart" | "recovery resume" | "recovery abort" | "recovery dispose" | "recovery-run";
}
type RecoveryDelegationAudit = RecoveryDelegation & { at: number; operationId: string };
const MAX_RECOVERY_DELEGATIONS = 256;
const RECOVERY_DELEGATION_COMMANDS: readonly string[] = ["upgrade", "restart", "recovery resume", "recovery abort", "recovery dispose", "recovery-run"];

export interface RecoveryOperation {
  /**
   * #227: 2 marks a stop-and-archive recorded on an operation whose coordinator predates #215. Every older runner and
   * abort refuses a schema other than 1 before it takes the lock or claims the runner, so none can advance it.
   */
  schema: 1 | 2 | 3;
  id: string;
  plan: UpgradePlan;
  createdAt: number;
  updatedAt: number;
  phase: "pending" | "running" | "blocked" | "completed" | "cancelled";
  step: string;
  sourceRoot: string;
  /** Ids-only initiating and subsequent delegated invocations; retained across coordinator replacement. */
  delegatedAudits?: RecoveryDelegationAudit[];
  /** Source template bytes only when the project has no routing.toml; integrity is sealed in the private policy digest. */
  conductorRoutingDefaults?: Record<string, string>;
  targetRoot?: string;
  targetDigest?: string;
  /** Verified capability evidence bound to targetRoot/targetDigest; absence is legacy unknown, not an empty list. */
  targetFeatures?: readonly string[];
  projects: ProjectProgress[];
  pluginInstalled?: boolean;
  globalInstalled?: boolean;
  error?: string;
  /** Presentation observations only: old receipts without these fields have unknown timings and cause. */
  waits?: Record<string, RecoveryWaitTiming>;
  presentationCause?: RecoveryPresentationCause;
  failure?: { code: "database_busy"; retryable: true; site?: string[] };
  /** A typed verify outcome, never inferred from an error message or a peer's current state. */
  blockedReattachment?: { projectId: string; peer: RecoveryNativePeer };
  /** Positive typed store observation; disposal rechecks it before accepting a repaired-session loss. */
  missingRecordedSession?: { projectId: string; peer: RecoveryNativePeer; sessionId: string; kind: "rollout" | "transcript"; checkedPath?: string };
  freshOverride?: { peer: RecoveryNativePeer; evidence: NonNullable<RecoveryOperation["missingRecordedSession"]>; checked: "missing"; at: number };
  /** #215: every human disposition, in order. Operator reasons only; never task or message text. #776: `cause` is the operation's own `error` at that moment, the text the receipt already held. */
  audit?: { at: number; action: "fresh-session" | "stop-and-archive"; reason: string; peer?: string; cause?: string; projects: string[] }[];
  disposition?: { choice: "stop-and-archive"; at: number; projects: Record<string, string>; continuity?: Record<string, "not-archived" | "unavailable"> };
  /** #215: a refusal no resume can get past was recorded (FinalRefusal); `next` no longer offers resume. */
  final?: boolean;
}

/** #215: a refusal that holds for every resume of the operation (its staged target or preserved source is fixed). */
export class FinalRefusal extends Error {}

export class ReattachmentRequired extends Error {
  constructor(public readonly projectId: string, public readonly peer: RecoveryNativePeer, message: string, public readonly presentationError?: RecoveryPresentationError) { super(message); }
}

export class MissingRecordedSession extends Error {
  readonly code = "recorded_session_missing";
  constructor(readonly evidence: NonNullable<RecoveryOperation["missingRecordedSession"]>) {
    super(`${evidence.peer}: recorded session ${evidence.sessionId} has no resumable transcript (positively missing ${evidence.kind}${evidence.checkedPath ? ` checked at ${JSON.stringify(evidence.checkedPath)}` : ""}); choose dispose --fresh-session ${evidence.peer} --reason <text> to accept its loss, or stop-and-archive`);
  }
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

/**
 * #225: whether an operation's coordinator restarts a target that stopped after it started. Resume runs the operation's
 * own runner, so an older one keeps refusing and `next` must not offer resume for that row.
 * ponytail: a text sniff of its upgrade.ts, like targetReadsWaivers and coordinatorCurrent; a rename reads as "cannot
 * restart" (the safe side). Upgrade path: the capability list those two name.
 */
export function coordinatorRestarts(op: { sourceRoot?: string }): boolean {
  if (!op.sourceRoot) return true;
  try { return readFileSync(join(op.sourceRoot, "src/cli/upgrade.ts"), "utf8").includes("export function recordRestart"); } catch { return false; }
}

/**
 * #225: record the restart of a target that stopped after it started, before the new one starts: the dead instance and
 * the time stay for status and audit. Each done or waiting `restored:<peer>` binding of the dead instance is retired
 * (`retired:<peer>`): restore closes its terminal (or finds it absent) before that peer is relaunched, and never
 * revalidates it against the new instance. `closed:<peer>`, `commitSent`, `fresh`, waivers and the install flags stay.
 * The project goes back to `stopped`, whose path starts the target from this operation's snapshot.
 */
export function recordRestart(progress: ProjectProgress, at: number): void {
  (progress.restarts ??= []).push({ instanceId: progress.instanceId ?? "unknown", at });
  for (const [key, value] of Object.entries(progress.terminals)) {
    if (!key.startsWith("restored:")) continue;
    const receipt = decodeRestoreReceipt(value);
    if (receipt?.state !== "done" && receipt?.state !== "waiting") continue;
    const peer = key.slice("restored:".length);
    progress.terminals[`retired:${peer}`] = receipt.binding;
    delete progress.terminals[`closedRetired:${peer}`]; // a newer binding to close: its own receipt starts over
    delete progress.terminals[key];
    // Older receipts may have only the attempt marker. Retiring that binding must not retire its continuity rule.
    if (Object.hasOwn(progress.reattachments ?? {}, peer)) (progress.repairedSessions ??= {})[peer as RecoveryNativePeer] = true;
    // The allowance belongs to the target whose exact binding was retired, not every later #225 restart.
    if (progress.reattachments) delete progress.reattachments[peer as RecoveryNativePeer];
  }
  if (progress.reattachments && !Object.keys(progress.reattachments).length) delete progress.reattachments;
  delete progress.instanceId;
  progress.phase = "stopped";
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
 * #215: why resume can never get past what is live, or undefined. The runner's checks, mirrored (the invariant test in
 * test/upgrade.test.ts holds the two together); `next` offers resume and --fresh-session only when this is undefined,
 * and dispose accepts --fresh-session only then. Unavailable, starting or stopping is waited for.
 */
export function resumeBlocked(op: RecoveryOperation, live: Record<string, Inspection | undefined> = {}): string | undefined {
  if (op.final) return "staging refused this operation's fixed target or preserved source";
  const old = !!op.sourceRoot && !coordinatorCurrent(op.sourceRoot);
  for (let i = 0; i < op.projects.length; i++) {
    const p = op.projects[i]!, planned = op.plan.projects[i], state = live[p.id];
    if (!state || !planned || p.phase === "verified") continue;
    if (state.state === "missing") return `${p.id}: the project directory is missing`;
    if (state.state === "incompatible") return `${p.id}: its hub speaks another control protocol`;
    const source = p.phase === "pending" || p.phase === "prepared";
    if (state.state === "running") {
      const expected = source ? state.instanceId === planned.source.instanceId
        : state.recovery?.operationId === op.id && (!p.instanceId || state.instanceId === p.instanceId) && state.version === op.plan.version;
      if (!expected) return `${p.id}: its hub is not the one this operation expects`;
      continue;
    }
    if (state.state !== "stopped") continue;
    if (p.phase === "pending") return `${p.id}: the source stopped before it was prepared`;
    if (p.phase === "prepared" && !p.commitSent && !old) return `${p.id}: the source stopped while prepared, with no commit request`;
    // #225: a target that stopped after it started is restarted from this operation's snapshot (the line below), by a
    // coordinator that can; an older one's runner refuses it.
    if ((p.phase === "started" || p.phase === "peers-restored") && !coordinatorRestarts(op)) return `${p.id}: the target stopped after it started; this operation's coordinator cannot restart it`;
    if (state.snapshot !== op.id) return `${p.id}: its hub stopped without this operation's restart snapshot`;
  }
  return undefined;
}

/**
 * #215: why stop-and-archive would refuse, or undefined when it can act. Dispose and `next` both ask this, so `next`
 * never offers a stop-and-archive that refuses. Every unverified project must read as running, stopped or missing:
 * any other state (unavailable, starting, stopping, incompatible, not inspected) hides whether this operation owns it.
 */
export function disposeRefusal(op: RecoveryOperation, live: Record<string, Inspection | undefined> = {}): { project: string; reads: string } | undefined {
  const unsettled = op.projects.find((p) => p.phase !== "verified" && !["running", "stopped", "missing"].includes(live[p.id]?.state ?? ""));
  return unsettled ? { project: unsettled.id, reads: live[unsettled.id]?.state ?? "not inspected" } : undefined;
}

/** #272: one entry of `next`. `text` is the line status prints; a screen runs `kind` through `recoveryArgv`. */
export interface NextChoice {
  kind: "resume" | "abort" | "fresh" | "stop" | "wait" | "reattach";
  /** `fresh` only: the peer that starts as a new session. */
  peer?: string;
  text: string;
}

/**
 * #215: what the person can do now, in the receipt table's order: resume (it also launches a failed peer again),
 * abort where it can succeed, a fresh session for a failed Codex or Claude restoration, and stop-and-archive last.
 * `status`, every error that names choices and the interactive screen (#272) use this one list.
 */
export function nextChoices(receipt: RecoveryOperation, runner?: number | "unknown", live: Record<string, Inspection | undefined> = {}): NextChoice[] {
  // A receipt read without its project lists (never written so by a coordinator) still gets the general choices.
  const op: RecoveryOperation = receipt.projects ? receipt : { ...receipt, projects: [], plan: { ...receipt.plan, projects: receipt.plan?.projects ?? [] } };
  if (op.phase === "completed" || op.phase === "cancelled") return [];
  // claimRunner refuses an owner it cannot read, so resume, abort and dispose are all refused until the record reads.
  if (runner === "unknown") return [{ kind: "wait", text: `${recoveryCommand(op, "status")} again: whether a runner holds the operation could not be read (resume, abort and dispose are refused until it can)` }];
  if (runner) return [{ kind: "wait", text: `wait: runner ${runner} is working; ${recoveryCommand(op, "status")}` }];
  const unsettled = disposeRefusal(op, live);
  const stop: NextChoice = unsettled ? { kind: "wait", text: `wait until ${unsettled.project}'s hub settles, then ${recoveryCommand(op, "status")}` } : { kind: "stop", text: recoveryCommand(op, "dispose", STOP) };
  if (op.disposition) return [unsettled ? stop : { kind: "stop", text: `rerun ${stop.text}` }];
  const failed = [...new Set(op.projects.flatMap((p) => failedPeers(op, p, live)))];
  const old = !!op.sourceRoot && !coordinatorCurrent(op.sourceRoot);
  const abortable = !abortRefusal(op, live);
  const stuck = resumeBlocked(op, live);
  const selected = op.phase === "blocked" ? op.blockedReattachment : undefined;
  const repair = selected && op.projects.find(project => project.id === selected.projectId)?.reattachments?.[selected.peer];
  const reattach = selected && repair && projectDefinition(selected.peer, op.plan.projects.find(project => project.project.id === selected.projectId)?.project.root)?.session.launchRecord === true &&
    (repair.state === "ready" || repairWaiting(op, selected.projectId, selected.peer));
  return [
    ...(stuck ? [] : [{ kind: "resume" as const, text: `${recoveryCommand(op, "resume")}${op.error ? " (after the next action in error)" : ""}${old ? ` (runs the coordinator that started this operation, which cannot re-prepare an expired hold: if it reports "source is no longer prepared", use ${abortable ? "abort or " : ""}stop-and-archive)` : ""}` }]),
    ...(abortable ? [{ kind: "abort" as const, text: recoveryCommand(op, "abort") }] : []),
    ...(selected && reattach ? [{ kind: "reattach" as const, peer: selected.peer, text: recoveryCommand(op, "reattach", selected.peer) }] : []),
    ...(targetReadsWaivers(op) && !stuck ? failed.map((peer) => ({ kind: "fresh" as const, peer, text: recoveryCommand(op, "dispose", `--fresh-session ${peer} --reason <text>`) })) : []),
    stop,
  ];
}
export const nextActions = (receipt: RecoveryOperation, runner?: number | "unknown", live: Record<string, Inspection | undefined> = {}): string[] => nextChoices(receipt, runner, live).map((c) => c.text);

/**
 * #272: a runner that only waits for its source to get quiet can be stopped and the operation aborted: nothing was
 * closed, stopped or asked to commit. Abort decides again on what is live, so a runner that moved on meanwhile is
 * refused there, never here.
 */
export const cancellableWait = (op: RecoveryOperation): boolean => op.phase === "running" && op.step.startsWith("prepare:") && !op.disposition && !hasEffects(op) && !op.projects.some((p) => p.commitSent);

/**
 * "next actions: ..." from nextActions, with the inspections the caller holds. Every error that lists choices ends with
 * it, after only its own peer-specific step ("end that codex session", "close Orca terminal <h>"), so no error offers
 * an abort that abort refuses or leaves out one that would succeed.
 */
export const nextActionsText = (op: RecoveryOperation, live: Record<string, Inspection | undefined> = {}): string => `next actions: ${nextActions(op, undefined, live).join(" | ")}`;

/**
 * #215: what `next` reads, the same for status, abort and the runner's errors: every project not yet verified, its
 * source or its target. An inspection that throws reads as not inspected, never as stopped.
 */
export async function liveProjects(op: RecoveryOperation, inspect: (project: Project) => Promise<Inspection>): Promise<Record<string, Inspection | undefined>> {
  if (op.phase === "completed" || op.phase === "cancelled") return {};
  const open = op.plan.projects.filter((_, i) => op.projects[i] && op.projects[i].phase !== "verified");
  return Object.fromEntries(await Promise.all(open.map(async (p) => [p.project.id, await inspect(p.project).catch(() => undefined)] as const)));
}

function missingRepair(op: RecoveryOperation, progress: ProjectProgress, peer: string, options: { authority?: "current" | "historical" } = {}): boolean {
  const evidence = op.missingRecordedSession;
  if (!evidence || evidence.projectId !== progress.id || evidence.peer !== peer || (!progress.repairedSessions?.[evidence.peer] && !Object.hasOwn(progress.reattachments ?? {}, peer))) return false;
  const planned = op.plan.projects.find(project => project.project.id === progress.id);
  if (!planned) return false;
  try { return resolveAcceptedBinding(planned, progress, evidence.peer, options)?.sessionId === evidence.sessionId; } catch { return false; }
}
/**
 * Peers of a project whose restoration failed and for which a fresh session is a real choice: not Pi (a restored hub
 * resumes its recorded session), not one already chosen, and not a planned fresh start (nothing to lose; resume
 * launches it new again).
 */
function failedPeers(op: RecoveryOperation, progress: ProjectProgress, live: Record<string, Inspection | undefined> = {}): string[] {
  const planned = op.plan.projects.find((p) => p.project.id === progress.id);
  return Object.entries(progress.terminals).filter(([key, value]) => key.startsWith("restored:") && (() => { try { return canChooseFresh(value); } catch { return false; } })()).map(([key]) => key.slice("restored:".length))
    .filter((peer) => projectDefinition(peer, planned?.project.root)?.session.personFresh === true && ((!Object.hasOwn(progress.reattachments ?? {}, peer) && !Object.hasOwn(progress.repairedSessions ?? {}, peer)) || missingRepair(op, progress, peer)) && !progress.fresh?.[peer] && (!planned?.freshStart?.includes(peer) || missingRepair(op, progress, peer)) && !plannedAttached(op, progress, peer, live));
}

/** Read-only scope classification; it confers no delegation authority. */
export function repairedFreshSession(op: RecoveryOperation, peer: string): boolean | undefined {
  try {
    validateReceipt(op.id, op);
    if (!op.plan.projects.some(planned => planned.source.peers.some(row => row.id === peer) ||
        planned.terminals.some(value => !!value && typeof value === "object" && (value as { peer?: unknown }).peer === peer))) return undefined;
    return op.projects.some(progress => failedPeers(op, progress).includes(peer) && missingRepair(op, progress, peer));
  } catch { return undefined; } // Unknown scope never becomes an ordinary delegated disposition.
}

function repairWaiting(op: RecoveryOperation, projectId: string, peer: RecoveryNativePeer): boolean {
  try { return decodeRestoreReceipt(op.projects.find(project => project.id === projectId)?.terminals[`restored:${peer}`])?.state === "waiting"; }
  catch { return false; }
}

/** #215: the inspection shows the planned session attached for `peer`, so resume records it as restored: nothing is lost. */
function plannedAttached(op: RecoveryOperation, progress: ProjectProgress, peer: string, live: Record<string, Inspection | undefined>): boolean {
  const state = live[progress.id];
  const planned = op.plan.projects.find((p) => p.project.id === progress.id);
  const binding = planned && Object.hasOwn(progress.repairedSessions ?? {}, peer)
    ? resolveAcceptedBinding(planned, progress, peer as RecoveryNativePeer)
    : (planned?.terminals as { peer: string; sessionId: string }[] | undefined)?.find((t) => t.peer === peer);
  const current = state?.state === "running" ? state.peers.find((p) => p.id === peer && p.state !== "offline") : undefined;
  return !!binding && current?.[projectDefinition(peer, planned?.project.root)?.session.idField ?? "sessionId"] === binding.sessionId;
}

/** Registry reads for planning must not create a registry or run migrations. */
export function registeredProjects(home = hubHome()): Project[] {
  const path = join(home, "registry.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    // #226: a registry no current release opened yet has no signature column, and this read never migrates.
    const signed = (db.query("PRAGMA table_info(projects)").all() as { name: string }[]).some((c) => c.name === "pid_signature");
    return (db.query(`SELECT ${PROJECT_COLUMNS}${signed ? ", pid_signature" : ""} FROM projects ORDER BY root`).all() as Record<string, unknown>[]).map(projectFromRow);
  } finally { db.close(); }
}

export function planFingerprint(plan: Omit<UpgradePlan, "fingerprint">): string {
  const stable = { ...plan, projects: plan.projects.map((p) => ({ ...p, source: { ...p.source, recovery: undefined,
    peers: p.source.peers.map(({ state, ...peer }) => ({ ...peer, active: state !== "offline" })) } })) };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** A scoped receipt cannot expand into a second project, even when read by a later coordinator. */
export function recoveryScope(plan: Pick<UpgradePlan, "scope" | "projects">): string | undefined {
  if (plan.scope === undefined) return undefined;
  const scope = plan.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length !== 1 || !Object.hasOwn(scope, "projectRoot")
    || typeof scope.projectRoot !== "string" || !isAbsolute(scope.projectRoot) || !Array.isArray(plan.projects)
    || plan.projects.length !== 1 || plan.projects[0]?.project.root !== scope.projectRoot)
    throw new Error("reviewed project recovery scope is invalid");
  return scope.projectRoot;
}
function sealScopedPlan(op: RecoveryOperation): void {
  if (op.schema !== 3) return;
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  };
  freeze(op.plan);
  Object.defineProperty(op, "plan", { value: op.plan, enumerable: true, writable: false, configurable: false });
}

export function createOperation(plan: UpgradePlan, sourceRoot: string, home = hubHome(), delegation?: RecoveryDelegation, operationId: string = randomUUID()): RecoveryOperation {
  if (!operationIdPattern.test(operationId)) throw new Error("invalid recovery operation ID");
  if (!plan.projects.length) throw new Error("no running projects to recover");
  if (plan.blockers.length || plan.projects.some((p) => p.blockers.length)) throw new Error("upgrade plan has blockers; no runtimes were changed");
  const { fingerprint, ...body } = plan;
  if (planFingerprint(body) !== fingerprint) throw new Error("upgrade plan fingerprint is invalid");
  const scope = recoveryScope(plan);
  const id = operationId;
  const op: RecoveryOperation = {
    schema: scope === undefined ? 1 : 3, id, plan, sourceRoot, createdAt: Date.now(), updatedAt: Date.now(), phase: "pending", step: "stage",
    projects: plan.projects.map((p) => ({ id: p.project.id, phase: "pending", terminals: {} })),
  };
  if (delegation) appendRecoveryDelegation(op, delegation, op.createdAt);
  sealScopedPlan(op);
  // Publish the nonterminal receipt and its hold atomically with capture pruning's inventory.
  const registry = new Registry(join(home, "registry.db"));
  try { registry.runtimeCaptureLocked(() => { writeOperation(id, op, home); acquireRecoveryLock(id, home, scope); }); }
  finally { registry.close(); }
  return op;
}

/**
 * #227: a coordinator from before #215 never reads `disposition`, and an older global `ahub recovery resume` runs it.
 * Every older validateReceipt refuses a schema other than 1 before the lock and the runner claim, so schema 2 keeps it
 * from advancing an operation being abandoned. A #215 coordinator's runner refuses the disposition itself and keeps
 * schema 1, so a 0.12.20 CLI can still rerun its dispose. True when the receipt changed (a disposition recorded at 1
 * by 0.12.20 is moved to 2 by the next command of this release that holds the runner claim).
 */
function abandoned(op: RecoveryOperation): boolean {
  if (!op.disposition || op.schema !== 1 || !op.sourceRoot || coordinatorCurrent(op.sourceRoot)) return false;
  op.schema = 2;
  return true;
}

function validRecoveryDelegation(value: unknown): value is RecoveryDelegation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.peer === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(row.peer)
    && typeof row.command === "string" && RECOVERY_DELEGATION_COMMANDS.includes(row.command);
}

function validateRecoveryDelegations(op: RecoveryOperation): void {
  if (op.delegatedAudits === undefined) return;
  if (!Array.isArray(op.delegatedAudits) || op.delegatedAudits.length > MAX_RECOVERY_DELEGATIONS || op.delegatedAudits.some(row =>
    !validRecoveryDelegation(row) || Object.keys(row).some(key => !["at", "peer", "command", "operationId"].includes(key)) ||
    !Number.isFinite(row.at) || row.at < 0 || row.operationId !== op.id)) throw new Error("invalid recovery delegation audit");
}

function appendRecoveryDelegation(op: RecoveryOperation, delegation: RecoveryDelegation, at: number): void {
  validateRecoveryDelegations(op);
  if (!validRecoveryDelegation(delegation) || Object.keys(delegation).some(key => !["peer", "command"].includes(key)) ||
      !Number.isFinite(at) || at < 0) throw new Error("invalid recovery delegation audit");
  if ((op.delegatedAudits?.length ?? 0) >= MAX_RECOVERY_DELEGATIONS) throw new Error("recovery delegation audit is full; nothing was executed");
  (op.delegatedAudits ??= []).push({ at, peer: delegation.peer, command: delegation.command, operationId: op.id });
}

/** Record an external resume before handing off to even an older retained coordinator. */
export function recordRecoveryDelegation(id: string, delegation: RecoveryDelegation, home = hubHome()): RecoveryOperation {
  validateReceipt(id, readOperation<RecoveryOperation>(id, home));
  const releaseRunner = claimRunner(id, home);
  try {
    const op = readOperation<RecoveryOperation>(id, home);
    validateReceipt(id, op);
    const at = Date.now();
    appendRecoveryDelegation(op, delegation, at);
    op.updatedAt = at;
    writeOperation(id, op, home);
    return op;
  } finally { releaseRunner(); }
}

function validateReceipt(id: string, op: RecoveryOperation, historical = false): void {
  // Cleanup validates owned historical facts; this mode never authorizes restore, fresh or reattach.
  const options = historical ? { authority: "historical" as const } : {};
  const decode = (value: unknown) => decodeRestoreReceipt(value, options);
  const scope = recoveryScope(op.plan);
  if (!(scope === undefined ? op.schema === 1 || (op.schema === 2 && op.disposition) : op.schema === 3) || op.id !== id)
    throw new Error("unsupported operation receipt");
  validateRecoveryDelegations(op);
  if (op.targetFeatures !== undefined && (!Array.isArray(op.targetFeatures) || !op.targetFeatures.every(feature => typeof feature === "string" && feature.length > 0) || !op.targetRoot || !op.targetDigest)) throw new Error("invalid target features");
  const { fingerprint, ...reviewed } = op.plan;
  if (fingerprint !== planFingerprint(reviewed) || op.projects.length !== op.plan.projects.length ||
      op.projects.some((p, i) => p.id !== op.plan.projects[i]?.project.id)) throw new Error("reviewed operation plan or project scope changed");
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  for (const [index, progress] of op.projects.entries()) {
    const planned = op.plan.projects[index]!;
    for (const peer of planned.source.peers) {
      if (Object.hasOwn(peer, "externalInstance") && !validExternalInstanceBinding(peer.externalInstance, planned.project.root, peer.id)) throw new Error("invalid retained external module instance binding");
    }
    if (progress.repairedSessions !== undefined) {
      if (!object(progress.repairedSessions)) throw new Error("invalid repaired session provenance");
      for (const [peer, protectedSession] of Object.entries(progress.repairedSessions)) {
        const restored = decode(progress.terminals[`restored:${peer}`]);
        const bindings = [progress.reattachments?.[peer as RecoveryNativePeer]?.binding,
          restored?.state === "done" || restored?.state === "waiting" ? restored.binding : undefined,
          progress.terminals[`retired:${peer}`]];
        if (protectedSession !== true || !bindings.some(binding => {
          if (binding === undefined) return false;
          const receipt = decode({ state: "done", binding });
          return receipt?.state === "done" && receipt.binding.peer === peer && receipt.binding.projectRoot === op.plan.projects[index]?.project.root;
        })) throw new Error("repaired session provenance does not match its retained peer and project");
      }
    }
    for (const [peer, choice] of Object.entries(progress.fresh ?? {})) {
      if (choice.repaired === undefined) continue;
      const planned = op.plan.projects[index]!;
      if (choice.repaired !== true || !progress.repairedSessions?.[peer as RecoveryNativePeer] ||
          resolveAcceptedBinding(planned, progress, peer as RecoveryNativePeer, options)?.sessionId !== choice.lost) throw new Error("invalid one-use repaired-session choice");
    }
    if (progress.reattachments === undefined) continue;
    if (!object(progress.reattachments)) throw new Error("invalid reattachment markers");
    for (const [peer, marker] of Object.entries(progress.reattachments)) {
      if ((!historical && projectDefinition(peer, op.plan.projects[index]?.project.root)?.session.launchRecord !== true) || !object(marker) || Object.keys(marker).some(key => !["state", "at", "cause", "binding"].includes(key)) ||
          !["ready", "attempted"].includes(String(marker.state)) || marker.cause !== "detached after restore" || typeof marker.at !== "number" || !Number.isFinite(marker.at) || marker.at < 0) throw new Error("invalid reattachment marker");
      const receipt = decode({ state: "done", binding: marker.binding });
      if (receipt?.state !== "done" || receipt.binding.peer !== peer || receipt.binding.projectRoot !== op.plan.projects[index]?.project.root) throw new Error("reattachment binding does not match its peer and project");
    }
  }
  if (op.missingRecordedSession !== undefined) {
    const evidence = op.missingRecordedSession;
    if (!object(evidence) || Object.keys(evidence).some(key => !["projectId", "peer", "sessionId", "kind", "checkedPath"].includes(key)) ||
        typeof evidence.projectId !== "string" || typeof evidence.peer !== "string" || typeof evidence.sessionId !== "string" ||
        evidence.checkedPath !== undefined && (typeof evidence.checkedPath !== "string" || !evidence.checkedPath) ||
        !["rollout", "transcript"].includes(evidence.kind) || !op.projects.some(progress => missingRepair(op, progress, evidence.peer, options))) throw new Error("invalid recorded-session missing evidence");
  }
  if (op.freshOverride !== undefined) {
    const override = op.freshOverride, evidence = override.evidence;
    if (!object(override) || Object.keys(override).some(key => !["peer", "evidence", "checked", "at"].includes(key)) || !object(evidence) ||
        Object.keys(evidence).some(key => !["projectId", "peer", "sessionId", "kind", "checkedPath"].includes(key)) || override.checked !== "missing" ||
        !Number.isFinite(override.at) || override.at < 0 || override.peer !== evidence.peer || !["rollout", "transcript"].includes(evidence.kind) ||
        !op.audit?.some(entry => entry.action === "fresh-session" && entry.peer === override.peer && entry.at === override.at && entry.projects.includes(evidence.projectId))) throw new Error("invalid fresh override evidence");
  }
  if (op.blockedReattachment !== undefined) {
    const selected = op.blockedReattachment;
    if (!object(selected) || Object.keys(selected).some(key => !["projectId", "peer"].includes(key)) || typeof selected.projectId !== "string" || typeof selected.peer !== "string" || (!historical && projectDefinition(selected.peer, op.plan.projects.find(project => project.project.id === selected.projectId)?.project.root)?.session.launchRecord !== true) ||
        !op.projects.some(project => project.id === selected.projectId && Object.hasOwn(project.reattachments ?? {}, selected.peer))) throw new Error("invalid blocked reattachment selector");
  }
}

export interface RecoveryDriver {
  stage(op: RecoveryOperation): Promise<{ root: string; digest: string; targetFeatures?: readonly string[] }>;
  inspect(project: Project, targetFeatures?: readonly string[], purpose?: "cleanup"): Promise<Inspection>;
  prepare(project: Project, operation: string, instance: string, targetFeatures?: readonly string[]): Promise<void>;
  abort(project: Project, operation: string, instance: string): Promise<void>;
  commit(project: Project, operation: string, instance: string, targetFeatures?: readonly string[]): Promise<void>;
  closeTerminals(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, save: () => void): Promise<void>;
  start(project: Project, op: RecoveryOperation): Promise<void>;
  restore(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, group: "native" | "claude", save: () => void, onlyPeer?: RecoveryNativePeer): Promise<void>;
  installPlugin(op: RecoveryOperation): Promise<void>;
  installGlobal(op: RecoveryOperation): Promise<void>;
  refreshManager?(op: RecoveryOperation): Promise<void>;
  release(project: Project, operation: string, instance: string): Promise<void>;
  verify(planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, save?: () => void): Promise<void>;
  /** Read-only positive store evidence; absence of the port means unknown. */
  recordedSessionState?(binding: TerminalBinding, kind: "rollout" | "transcript"): Promise<"found" | "missing" | "unknown">;
  /** #215 stop-and-archive: stop this operation's unreleased target (when given) and archive its committed snapshot. */
  stopAndArchive(project: Project, op: RecoveryOperation, targetInstance?: string): Promise<void | { continuity: "not-archived" | "unavailable" }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Trusted per-invocation delegation, supplied only by the CLI's identity preflight. */
  readonly liveTestPeer?: string;
  /** Trusted actor from the live conductor preflight; receipt audit rows confer no authority. */
  readonly conductorPeer?: string;
  /** Host-only current authority proof for this exact operation and every affected project. */
  authorize?(op: RecoveryOperation, phase: "run" | "abort" | "effect"): Promise<void>;
}

async function authorizeRecoveryDriver(driver: RecoveryDriver, op: RecoveryOperation, phase: "run" | "abort" | "effect"): Promise<void> {
  if (driver.conductorPeer === undefined) return;
  if (!validRecoveryDelegation({ peer: driver.conductorPeer, command: "recovery-run" }) || typeof driver.authorize !== "function") throw new Error("conductor recovery authorization unavailable");
  await driver.authorize(op, phase);
}

function scopedRecoveryCurrent(operation: () => RecoveryOperation, scope: string | undefined, id: string, home: string): (() => void) | undefined {
  if (scope === undefined) return undefined;
  return () => {
    if (recoveryScope(operation().plan) !== scope || recoveryLock(home, scope) !== id) throw new Error("project recovery scope or hold changed");
  };
}

/** Closed effect ports only. Scoped operations also fence their project hold; inspection stays read-only. */
export function guardedRecoveryDriver(driver: RecoveryDriver, operation: () => RecoveryOperation, current?: () => void): RecoveryDriver {
  if (driver.conductorPeer === undefined && !current) return driver;
  const guard = <A extends unknown[], R>(action: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    current?.();
    await authorizeRecoveryDriver(driver, operation(), "effect");
    current?.();
    try { return await action(...args); }
    finally { await authorizeRecoveryDriver(driver, operation(), "effect"); current?.(); }
  };
  return {
    ...driver,
    stage: guard((...args: Parameters<RecoveryDriver["stage"]>) => driver.stage(...args)),
    prepare: guard((...args: Parameters<RecoveryDriver["prepare"]>) => driver.prepare(...args)),
    abort: guard((...args: Parameters<RecoveryDriver["abort"]>) => driver.abort(...args)),
    commit: guard((...args: Parameters<RecoveryDriver["commit"]>) => driver.commit(...args)),
    closeTerminals: guard((...args: Parameters<RecoveryDriver["closeTerminals"]>) => driver.closeTerminals(...args)),
    start: guard((...args: Parameters<RecoveryDriver["start"]>) => driver.start(...args)),
    restore: guard((...args: Parameters<RecoveryDriver["restore"]>) => driver.restore(...args)),
    installPlugin: guard((...args: Parameters<RecoveryDriver["installPlugin"]>) => driver.installPlugin(...args)),
    installGlobal: guard((...args: Parameters<RecoveryDriver["installGlobal"]>) => driver.installGlobal(...args)),
    ...(driver.refreshManager ? { refreshManager: guard((op: RecoveryOperation) => driver.refreshManager!(op)) } : {}),
    release: guard((...args: Parameters<RecoveryDriver["release"]>) => driver.release(...args)),
    verify: guard((...args: Parameters<RecoveryDriver["verify"]>) => driver.verify(...args)),
    stopAndArchive: guard((...args: Parameters<RecoveryDriver["stopAndArchive"]>) => driver.stopAndArchive(...args)),
    inspect: (...args) => driver.inspect(...args),
    ...(driver.recordedSessionState ? { recordedSessionState: (binding: TerminalBinding, kind: "rollout" | "transcript") => driver.recordedSessionState!(binding, kind) } : {}),
    sleep: ms => driver.sleep(ms), now: () => driver.now(),
  };
}

/** Resumable state machine. Driver actions are preceded by receipts and followed by live readback. */
export async function runRecovery(id: string, driver: RecoveryDriver, home = hubHome(), idleTimeoutMs = 600_000): Promise<RecoveryOperation> {
  // Read once to validate the selector, then claim the runner before trusting any
  // mutable phase. A concurrent runner may have completed the operation meanwhile.
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op);
  const scope = recoveryScope(op.plan);
  sealScopedPlan(op);
  if (driver.conductorPeer !== undefined) await authorizeRecoveryDriver(driver, op, "run");
  const scopeCurrent = scopedRecoveryCurrent(() => op, scope, id, home);
  acquireRecoveryLock(id, home, scope);
  const releaseRunner = claimRunner(id, home);
  try {
    op = readOperation<RecoveryOperation>(id, home);
    if (recoveryScope(op.plan) !== scope) throw new Error("project recovery scope changed while claiming its runner");
    sealScopedPlan(op);
    validateReceipt(id, op);
    if (op.phase === "completed" || op.phase === "cancelled") {
      if (recoveryLock(home, scope) === id) releaseRecoveryLock(id, home, scope);
      releaseRunner();
      return op;
    }
    if (driver.conductorPeer !== undefined) await authorizeRecoveryDriver(driver, op, "run");
    if (driver.conductorPeer ?? driver.liveTestPeer) {
      appendRecoveryDelegation(op, { peer: (driver.conductorPeer ?? driver.liveTestPeer)!, command: "recovery-run" }, driver.now());
      writeOperation(id, op, home);
    }
  } catch (error) { releaseRunner(); throw error; }
  driver = guardedRecoveryDriver(driver, () => op, scopeCurrent);
  let targetFeatures: readonly string[] = [];
  const save = () => { op.updatedAt = driver.now(); writeOperation(id, op, home); };
  const step = (value: string) => { op.step = value; save(); };
  // #225: one restart per project per resume, so a target that keeps dying never spins unattended.
  const restarted = new Set<string>();
  const stoppedAgain = (progress: ProjectProgress) => `the target stopped again after restart ${progress.restarts?.length ?? 0} in this resume`;
  const identity = (observed: Inspection, planned: PlannedProject, progress: ProjectProgress) => {
    if (observed.state === "stopped") throw new Error(restarted.has(progress.id) ? `${planned.project.id}: ${stoppedAgain(progress)}; read its hub.log before resuming again`
      : progress.phase !== "stopped" ? `${planned.project.id}: the target stopped after it started (a crash or a reboot)${observed.snapshot === id ? "; resume restarts it from this operation's snapshot" : " and this operation's restart snapshot is gone, so nothing can start it"}`
      : `${planned.project.id}: the target is stopped${observed.snapshot === id ? "" : " and this operation's restart snapshot is gone, so nothing can start it"}`);
    if (observed.state === "missing") throw new Error(`${planned.project.id}: the project directory is missing`);
    if (observed.state !== "running") throw new Error(`${planned.project.id}: the target reads as ${observed.state}; wait until it answers`);
    if (progress.instanceId && observed.instanceId !== progress.instanceId) throw new Error(`${planned.project.id}: daemon instance changed; refusing to act on its replacement`);
    if (observed.recovery?.operationId !== id) throw new Error(`${planned.project.id}: daemon is not owned by this recovery operation`);
    if (observed.version !== op.plan.version) throw new Error(`${planned.project.id}: target daemon version mismatch`);
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
    throw new Error(`${planned.project.id}: source conversation or active peer membership changed (${changed.id}); ${fix} before resuming, or end this operation: a new plan can be made once it is cancelled or ended`);
  };
  // Prepare, or after an expired lease re-prepare, the planned source and wait until it is quiet.
  const prepareSource = async (planned: PlannedProject, progress: ProjectProgress, again = false) => {
    const saveTiming = () => {
      try { save(); }
      catch { console.warn("Recovery timing observation could not be saved; recovery continues"); }
    };
    const project = planned.project, instance = planned.source.instanceId!;
    await driver.prepare(project, id, instance, targetFeatures);
    const startedAt = driver.now(), deadline = startedAt + idleTimeoutMs;
    const waitStep = op.step;
    if (waitStep) {
      (op.waits ??= {})[waitStep] = { waitStartedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadline).toISOString() };
      saveTiming();
    }
    let waitFailed = false;
    try {
    for (;;) {
      const live = await driver.inspect(project);
      if (live.instanceId !== instance) throw new Error(`${project.id}: source daemon changed during preparation`);
      if (live.recovery?.operationId !== id) {
        const other = live.recovery?.phase !== "released" ? live.recovery?.operationId : undefined;
        throw new Error(other ? `${project.id}: the source is held by another recovery operation ${other}; wait until that operation ends or its hold lapses`
          : `${project.id}: the preparation expired before the source was quiet (resume prepares it again)`);
      }
      if (live.recovery.ready) return sourceRoster(live, planned, progress, again);
      if (driver.now() >= deadline) {
        await driver.abort(project, id, instance);
        throw new Error(`${project.id}: active turns, approvals or completion checks did not finish; source runtime left running`);
      }
      await driver.sleep(250);
    }
    } catch (error) { waitFailed = true; throw error; }
    finally {
      const finish = () => {
        if (!waitStep) return;
        op.waits![waitStep] = { ...op.waits![waitStep]!, waitEndedAt: new Date(driver.now()).toISOString() };
        saveTiming();
      };
      // A best-effort end observation must not replace the error that stopped the actual wait.
      if (waitFailed) { try { finish(); } catch { /* original wait failure remains authoritative */ } }
      else finish();
    }
  };
  try {
    if (op.disposition) {
      // The stop-and-archive in progress keeps its own cause; resume never runs an operation being abandoned.
      op.error ??= `a stop-and-archive of this operation is partway; ${nextActionsText(op, await liveProjects(op, driver.inspect))}`;
      delete op.failure;
      delete op.presentationCause;
      op.phase = "blocked"; save();
      return op;
    }
    op.phase = "running"; delete op.error; delete op.failure; delete op.blockedReattachment; delete op.presentationCause;
    delete op.waits; // Timing is the current attempt's observation, never a prior attempt's countdown.
    save();
    step("stage");
    const target = await driver.stage(op);
    if (op.targetDigest && (target.root !== op.targetRoot || target.digest !== op.targetDigest)) throw new FinalRefusal("staged target changed since operation started");
    targetFeatures = target.targetFeatures ?? op.targetFeatures ?? [];
    op.targetRoot = target.root; op.targetDigest = target.digest;
    if (target.targetFeatures !== undefined) op.targetFeatures = [...target.targetFeatures];
    save();

    // Pending sources receive the verified target features before holds or terminal/runtime effects.
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!;
      if (progress.phase !== "pending") continue;
      const live = await driver.inspect(planned.project, targetFeatures);
      if (!["running", "stopped", "missing"].includes(live.state)) throw new Error(`${planned.project.id}: the source reads as ${live.state}; wait until it answers`);
      if (live.state !== "running" || live.instanceId !== planned.source.instanceId || live.version !== planned.source.version) {
        throw new Error(`${planned.project.id}: source runtime changed`);
      }
      const other = live.recovery?.phase !== "released" ? live.recovery?.operationId : undefined;
      if (other && other !== id) throw new Error(`${planned.project.id}: the source is held by another recovery operation ${other}; wait until that operation ends or its hold lapses`);
      sourceRoster(live, planned, progress);
    }
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!, project = planned.project;
      if (progress.phase === "started" || progress.phase === "peers-restored") {
        // #225: a target that stopped after it started, with this operation's snapshot, starts again from it.
        const live = await driver.inspect(project);
        if (live.state === "stopped") {
          if (live.snapshot !== id) throw new Error(`${project.id}: the target stopped after it started and this operation's restart snapshot is gone, so nothing can start it`);
          step(`restart:${project.id}`);
          recordRestart(progress, driver.now()); restarted.add(progress.id); save();
        }
      }
      if (progress.phase === "verified" || progress.phase === "peers-restored") continue;
      if (progress.phase === "pending") {
        step(`prepare:${project.id}`);
        await prepareSource(planned, progress);
        progress.phase = "prepared"; save();
      }
      if (progress.phase === "prepared") {
        step(`commit:${project.id}`);
        let live: Inspection;
        try { live = await driver.inspect(project); }
        catch (error) {
          if (!progress.commitSent || !isDatabaseBusy(error)) throw error;
          live = { state: "unavailable", peers: [], blockers: ["database_busy"] };
        }
        const resumedShutdown = progress.commitSent && live.state === "unavailable";
        let awaitShutdown = resumedShutdown;
        if (live.state === "running" && live.instanceId === planned.source.instanceId) {
          if (live.recovery?.operationId !== id || !live.recovery.ready) {
            const other = live.recovery?.operationId;
            if (other && other !== id && live.recovery?.phase !== "released") throw new Error(`${project.id}: the source is held by another recovery operation ${other}; nothing was prepared, closed or stopped, and ending this one leaves that hold alone; wait until that operation ends or its hold lapses`);
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
          await driver.commit(project, id, planned.source.instanceId!, targetFeatures);
          awaitShutdown = true;
        } else if (live.state === "running") {
          throw new Error(`${project.id}: the source daemon was replaced by instance ${live.instanceId ?? "unknown"}; refusing to prepare, close or stop it (ending this operation leaves that daemon running)`);
        } else if (live.state === "stopped" && !progress.commitSent && (!op.sourceRoot || coordinatorCurrent(op.sourceRoot))) {
          // #215: this coordinator records a commit request before sending it, so a stopped source with none crashed while
          // prepared: no snapshot was committed and there is nothing to start from. The phase stays `prepared`.
          throw new Error(`${project.id}: the source stopped while prepared and no commit was requested, so there is nothing to restore`);
        }
        if (awaitShutdown) {
          const deadline = driver.now() + readRecoveryWaits(project.root).shutdownWaitMs; // #489 H4: recovery.shutdown_wait_s, 30 s unset
          // An already-sent commit can be between its final reply and the source closing its control server.
          if (resumedShutdown) {
            if (live.instanceId && live.instanceId !== planned.source.instanceId) throw new Error(`${project.id}: another daemon started during shutdown`);
            await driver.sleep(100);
          }
          do {
            try { live = await driver.inspect(project); }
            catch (error) {
              if (!isDatabaseBusy(error)) throw error;
              // A committed source may still be stopping. Contention is an
              // unconfirmed read here, not a refusal; keep the existing bound.
              live = { state: "unavailable", peers: [], blockers: ["database_busy"] };
            }
            if (live.state === "stopped") break;
            if (live.instanceId && live.instanceId !== planned.source.instanceId) throw new Error(`${project.id}: another daemon started during shutdown`);
            await driver.sleep(100);
          } while (driver.now() < deadline);
        }
        if (live.state === "missing") throw new Error(`${project.id}: the project directory is missing`);
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
    // Legacy receipts keep their shared installation steps; project upgrades leave global tools alone.
    if (scope === undefined && op.plan.kind === "upgrade" && !op.pluginInstalled) {
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
      await driver.verify(planned, progress, op, save);
      step(`release:${planned.project.id}`);
      progress.releaseRequested = true; save();
      await driver.release(planned.project, id, progress.instanceId!);
      progress.phase = "verified"; save();
    }
    if (driver.refreshManager) { step("refresh-manager"); await driver.refreshManager(op); }
    if (scope === undefined && op.plan.kind === "upgrade" && !op.globalInstalled) {
      step("install-global"); await driver.installGlobal(op); op.globalInstalled = true; save();
    }
    releaseRecoveryLock(id, home, scope); op.phase = "completed"; step("completed");
  } catch (error) {
    // #215: every runner error ends with the choices status shows, read from every open source, never only this one.
    const presentationError = error instanceof RecoveryPresentationError ? error
      : error instanceof ReattachmentRequired && error.presentationError instanceof RecoveryPresentationError ? error.presentationError : undefined;
    if (presentationError) op.presentationCause = presentationError.presentationCause;
    else delete op.presentationCause;
    if (error instanceof MissingRecordedSession) op.missingRecordedSession = error.evidence;
    if (error instanceof ReattachmentRequired) op.blockedReattachment = { projectId: error.projectId, peer: error.peer };
    else delete op.blockedReattachment;
    if (isDatabaseBusy(error)) { op.failure = { code: "database_busy", retryable: true, site: databaseBusySite(error) }; error = new RecoveryDatabaseBusy(); }
    if (error instanceof FinalRefusal) op.final = true;
    op.phase = "blocked";
    const next = nextActionsText(op, await liveProjects(op, driver.inspect));
    op.error = `${error instanceof Error ? error.message : "recovery failed"}; ${next}`; save();
  } finally { releaseRunner(); }
  return op;
}

/** Receipts and runner state only (#215): ids, phases and effects, never task or message text. */
export function publicOperation(op: RecoveryOperation, runnerPid?: number | "unknown", live: Record<string, Inspection | undefined> = {}) {
  validateRecoveryDelegations(op);
  const effect = (key: string, value: unknown) => {
    if (!key.startsWith("restored:")) return value === "pending" || value === "failed" ? value : "done";
    const receipt = decodeRestoreReceipt(value, { authority: "historical" });
    return !receipt ? "unstarted" : receipt.state === "waiting" ? `waiting:${receipt.origin}` : receipt.state;
  };
  const choices = nextChoices(op, runnerPid, live), next = choices.map(choice => choice.text);
  return { id: op.id, phase: op.phase, step: op.step, version: op.plan.version, updatedAt: op.updatedAt,
    runner: runnerPid === "unknown" ? { state: "unknown" } : runnerPid ? { state: "running", pid: runnerPid } : { state: "none" },
    ...(op.phase === "running" && !runnerPid ? { stale: "the receipt says running but no runner holds the operation: its last runner stopped mid-step" } : {}),
    projects: op.projects.map((p) => ({ id: p.id, phase: p.phase, ...(Object.keys(p.terminals).length ? { effects: Object.fromEntries(Object.entries(p.terminals).map(([key, value]) => [key, effect(key, value)])) } : {}),
      ...(op.plan.projects.find(planned => planned.project.id === p.id) ? { recordedSessions: recordedPeerGuidance(op.plan.projects.find(planned => planned.project.id === p.id)!, p, {
        ...(op.phase === "blocked" && !op.disposition ? { stopAndArchiveCommand: recoveryCommand(op, "dispose", STOP) } : {}),
        reattachCommand: peer => op.phase === "blocked" && !op.disposition && !op.final && op.targetRoot && op.targetDigest && p.instanceId && ["started", "peers-restored"].includes(p.phase) &&
          op.blockedReattachment?.projectId === p.id && op.blockedReattachment.peer === peer && choices.some(choice => choice.kind === "reattach" && choice.peer === peer)
          ? recoveryCommand(op, "reattach", peer) : undefined,
      }) } : {}),
      ...(p.fresh ? { lostContinuity: Object.fromEntries(Object.entries(p.fresh).map(([peer, f]) => [peer, f.lost])) } : {}),
      ...(p.restarts?.length ? { restarts: p.restarts.length } : {}) })),
    pluginInstalled: !!op.pluginInstalled, globalInstalled: !!op.globalInstalled,
    ...(!targetReadsWaivers(op) && op.projects.some((p) => failedPeers(op, p).length) ? { freshSession: `not offered: target ${op.plan.version} cannot read recovery waivers, so it could not release a new session` } : {}),
    ...(op.delegatedAudits ? { delegatedAudits: op.delegatedAudits } : {}),
    ...(op.error ? { error: op.error } : {}), ...(op.failure ? { failure: op.failure } : {}), ...(op.blockedReattachment ? { blockedReattachment: op.blockedReattachment } : {}), ...(op.disposition ? { disposition: op.disposition } : {}), ...(op.audit ? { audit: op.audit } : {}), ...(op.freshOverride ? { freshOverride: op.freshOverride } : {}), ...(op.missingRecordedSession ? { missingRecordedSession: op.missingRecordedSession } : {}),
    ...(op.waits ? { waits: op.waits } : {}), ...(op.presentationCause ? { presentationCause: op.presentationCause } : {}), next };
}

/**
 * Person-command entry: restore one recorded conversation under this operation's existing hold.
 * The driver settles and records the selected native identity; this entry never performs global verification,
 * release, installation or completion. A later normal resume owns those steps.
 */
export async function reattachRecovery(id: string, peer: string, driver: RecoveryDriver, home = hubHome()): Promise<RecoveryOperation> {
  if (driver.conductorPeer !== undefined) throw new Error("recovery reattachment is person-only");
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op);
  const selection = () => {
    if (projectDefinition(peer, op.plan.projects.find(project => project.project.id === op.blockedReattachment?.projectId)?.project.root)?.session.launchRecord !== true || op.phase !== "blocked" || op.disposition || op.final || op.blockedReattachment?.peer !== peer) throw new Error("reattach is available only for the peer named by a blocked reattachment receipt");
    const progress = op.projects.find(project => project.id === op.blockedReattachment!.projectId);
    const planned = op.plan.projects.find(project => project.project.id === progress?.id);
    const native = peer as RecoveryNativePeer;
    const marker = progress?.reattachments?.[native];
    if (!progress || !planned || !marker || !["started", "peers-restored"].includes(progress.phase) || !progress.instanceId || !op.targetRoot || !op.targetDigest ||
        (marker.state !== "ready" && !repairWaiting(op, progress.id, native))) throw new Error("recorded reattachment is unavailable or its single relaunch allowance was already used; resume to inspect the saved receipt");
    return { progress, planned, marker, native };
  };
  selection(); // Finished or unrelated operations must not acquire a new lock merely to refuse.
  const scope = recoveryScope(op.plan);
  sealScopedPlan(op);
  const scopeCurrent = scopedRecoveryCurrent(() => op, scope, id, home);
  acquireRecoveryLock(id, home, scope);
  const releaseRunner = claimRunner(id, home);
  driver = guardedRecoveryDriver(driver, () => op, scopeCurrent);
  let attempted = false;
  const save = () => { op.updatedAt = driver.now(); writeOperation(id, op, home); };
  try {
    op = readOperation<RecoveryOperation>(id, home);
    if (recoveryScope(op.plan) !== scope) throw new Error("project recovery scope changed while claiming its runner");
    sealScopedPlan(op);
    validateReceipt(id, op);
    const { progress, planned, marker, native } = selection();
    const expected = structuredClone(marker.binding);
    const target = async () => {
      const observed = await driver.inspect(planned.project);
      if (observed.state !== "running" || observed.instanceId !== progress.instanceId || observed.version !== op.plan.version || observed.recovery?.operationId !== id || observed.recovery.phase === "released") throw new Error("reattach target changed or is not held by this operation; no replacement runtime is accepted");
    };
    await target();
    attempted = true;
    await driver.restore(planned, progress, op, nativeRestoreGroup(projectDefinition(native, planned.project.root)?.transport), save, native);
    // A done receipt is written by the runtime only after authenticated attachment and exact settlement.
    // Inspection peers may be unavailable; do not invent an attachment from a test or a stale status projection.
    const restored = decodeRestoreReceipt(progress.terminals[`restored:${native}`]);
    if (restored?.state !== "done" || restored.binding.peer !== native || restored.binding.projectRoot !== expected.projectRoot ||
        restored.binding.sessionId !== expected.sessionId || restored.binding.sessionFile !== expected.sessionFile) throw new Error(`${native}: recorded session reattachment was not settled with its exact identity`);
    await target();
    delete op.blockedReattachment; delete op.failure; delete op.presentationCause;
    op.phase = "blocked";
    op.error = `${native}: recorded session reattached; resume to finish verification, release and any remaining installation; ${recoveryCommand(op, "resume")}`;
    save();
    return op;
  } catch (error) {
    if (attempted) {
      const presentationError = error instanceof RecoveryPresentationError ? error
        : error instanceof ReattachmentRequired && error.presentationError instanceof RecoveryPresentationError ? error.presentationError : undefined;
      if (presentationError) op.presentationCause = presentationError.presentationCause;
      else delete op.presentationCause;
      if (error instanceof MissingRecordedSession) op.missingRecordedSession = error.evidence;
      if (error instanceof ReattachmentRequired) op.blockedReattachment = { projectId: error.projectId, peer: error.peer };
      else delete op.blockedReattachment;
      if (isDatabaseBusy(error)) { op.failure = { code: "database_busy", retryable: true, site: databaseBusySite(error) }; error = new RecoveryDatabaseBusy(); }
      op.phase = "blocked";
      op.error = `${error instanceof Error ? error.message : "reattachment is unconfirmed"}; ${nextActionsText(op, await liveProjects(op, driver.inspect))}`;
      save();
    }
    throw error;
  } finally { releaseRunner(); }
}

/** Escape a blocked preflight without abandoning a stopped runtime or an uncertain terminal mutation. */
export async function abortRecovery(id: string, driver: RecoveryDriver, home = hubHome()): Promise<void> {
  let op = readOperation<RecoveryOperation>(id, home);
  validateReceipt(id, op, true);
  const scope = recoveryScope(op.plan);
  sealScopedPlan(op);
  if (driver.conductorPeer !== undefined) await authorizeRecoveryDriver(driver, op, "abort");
  const scopeCurrent = scopedRecoveryCurrent(() => op, scope, id, home);
  acquireRecoveryLock(id, home, scope);
  const releaseRunner = claimRunner(id, home);
  try {
    // Re-read after the exclusive runner claim so cancellation cannot act on a
    // stale pending/prepared receipt after another runner advanced it.
    op = readOperation<RecoveryOperation>(id, home);
    if (recoveryScope(op.plan) !== scope) throw new Error("project recovery scope changed while claiming its runner");
    sealScopedPlan(op);
    validateReceipt(id, op, true);
    if (op.phase === "completed" || op.phase === "cancelled") {
      if (recoveryLock(home, scope) === id) releaseRecoveryLock(id, home, scope);
      return;
    }
    if (driver.conductorPeer !== undefined) await authorizeRecoveryDriver(driver, op, "abort");
    if (driver.conductorPeer ?? driver.liveTestPeer) {
      appendRecoveryDelegation(op, { peer: (driver.conductorPeer ?? driver.liveTestPeer)!, command: "recovery abort" }, driver.now());
      writeOperation(id, op, home);
    }
    driver = guardedRecoveryDriver(driver, () => op, scopeCurrent);
    if (abandoned(op)) writeOperation(id, op, home);
    const { fingerprint, ...body } = op.plan;
    if (fingerprint !== planFingerprint(body)) throw new Error("operation plan changed");
    const live = await liveProjects(op, project => driver.inspect(project, undefined, "cleanup"));
    const refusal = abortRefusal(op, live);
    if (refusal) throw new Error(`abort refused: ${refusal}; ${nextActionsText(op, live)}`);
    // Only this operation's own uncommitted holds are aborted; a lapsed hold, a replacement daemon or another
    // operation's hold is left alone, and a source that is not running had no commit sent (abortRefusal).
    for (const planned of op.plan.projects) {
      const state = live[planned.project.id];
      if (state?.recovery?.operationId === id && state.recovery.phase !== "released") await driver.abort(planned.project, id, planned.source.instanceId!);
    }
    delete op.error; delete op.failure; delete op.blockedReattachment; delete op.presentationCause;
    op.phase = "cancelled"; op.step = "cancelled"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home, scope);
  } catch (error) {
    if (isDatabaseBusy(error)) throw new RecoveryDatabaseBusy();
    throw error;
  } finally { releaseRunner(); }
}

/**
 * #215: the human-only ways out of an operation that cannot restore a native session. `fresh` records the lost
 * conversation and leaves the operation to resume; `stop-and-archive` abandons it, and releases the lock only after
 * every runtime this operation held or started is verified released or stopped.
 */
export async function disposeRecovery(id: string, choice: { fresh: string } | { stop: true }, reason: string, driver: RecoveryDriver, home = hubHome()): Promise<RecoveryOperation> {
  if (driver.conductorPeer !== undefined) throw new Error("recovery disposition is person-only");
  let op: RecoveryOperation;
  try { op = readOperation<RecoveryOperation>(id, home); validateReceipt(id, op, "stop" in choice); }
  catch (error) { if (driver.liveTestPeer && "fresh" in choice) throw new Error(LIVE_TEST_PERSON_REFUSAL); throw error; }
  if (driver.liveTestPeer && "fresh" in choice && repairedFreshSession(op, choice.fresh) !== false) throw new Error(LIVE_TEST_PERSON_REFUSAL);
  // A finished operation owns no lock: never take one only to refuse.
  if (op.phase === "completed" || op.phase === "cancelled") throw new Error(`operation is already ${op.phase}`);
  const scope = recoveryScope(op.plan);
  sealScopedPlan(op);
  const scopeCurrent = scopedRecoveryCurrent(() => op, scope, id, home);
  acquireRecoveryLock(id, home, scope);
  const releaseRunner = claimRunner(id, home);
  try {
    try { op = readOperation<RecoveryOperation>(id, home); validateReceipt(id, op, "stop" in choice); if (recoveryScope(op.plan) !== scope) throw new Error("project recovery scope changed while claiming its runner"); sealScopedPlan(op); }
    catch (error) { if (driver.liveTestPeer && "fresh" in choice) throw new Error(LIVE_TEST_PERSON_REFUSAL); throw error; }
    if (driver.liveTestPeer && "fresh" in choice && repairedFreshSession(op, choice.fresh) !== false) throw new Error(LIVE_TEST_PERSON_REFUSAL);
    if (op.phase === "completed" || op.phase === "cancelled") {
      // Another runner finished it while this one waited: leave no lock behind, as resume and abort do.
      if (recoveryLock(home, scope) === id) releaseRecoveryLock(id, home, scope);
      throw new Error(`operation is already ${op.phase}`);
    }
    if (driver.liveTestPeer) {
      appendRecoveryDelegation(op, { peer: driver.liveTestPeer, command: "recovery dispose" }, driver.now());
      writeOperation(id, op, home);
    }
    if (abandoned(op)) writeOperation(id, op, home);
    const at = driver.now();
    // Read once, as status and the runner do: every choice and refusal below is decided on it.
    const live = await liveProjects(op, project => driver.inspect(project, undefined, "stop" in choice ? "cleanup" : undefined));
    const next = nextActionsText(op, live);
    if ("fresh" in choice) {
      // `ahub pi` sends no fresh flag, and a restored hub refills a Pi start from its recorded resume (daemon startPeer).
      if (op.plan.projects.some(planned => projectDefinition(choice.fresh, planned.project.root)?.session.personFresh === false)) throw new Error(`pi: --fresh-session is not supported: a restored hub resumes Pi's recorded session, so a fresh one cannot be guaranteed; ${op.plan.projects.filter(planned => projectDefinition(choice.fresh, planned.project.root)?.session.personFresh === false).map(planned => piArchiveExit(planned, recoveryCommand(op, "dispose", STOP), choice.fresh)).join("; ")}; ${next}`);
      if (op.disposition) throw new Error(`a stop-and-archive of this operation is partway; ${next}`);
      if (!targetReadsWaivers(op)) throw new Error(`--fresh-session is not available: target ${op.plan.version} cannot read recovery waivers, so it could not release a new session; ${next}`);
      // The new session is launched by resume, so it helps only where resume can get past what is live.
      const stuck = resumeBlocked(op, live);
      if (stuck) throw new Error(`--fresh-session cannot help: ${stuck}, so resume could never launch the new session; ${next}`);
      const peer = choice.fresh;
      // Per project: a planned fresh start has nothing to lose, so only the other failed projects take the choice.
      const failed = op.projects.filter((p) => failedPeers(op, p, live).includes(peer));
      if (!failed.length && op.projects.some((p) => canChooseFresh(p.terminals[`restored:${peer}`]) && op.plan.projects.find((planned) => planned.project.id === p.id)?.freshStart?.includes(peer))) {
        throw new Error(`${peer}: its plan already restarts it as a new session (no rollout and no turn, nothing to lose), so there is no conversation to record as lost; ${next}`);
      }
      if (!failed.length && op.projects.some((p) => canChooseFresh(p.terminals[`restored:${peer}`]) && plannedAttached(op, p, peer, live))) {
        throw new Error(`${peer}: its planned session is attached again, so nothing was lost; resume records it as restored; ${next}`);
      }
      if (!failed.length) throw new Error(`${peer}: no failed restoration of it is open to a fresh session (none failed, or one is already chosen); --fresh-session applies only then (${recoveryCommand(op, "status")})`);
      // Collect every proof before changing any project, so one uncertain read cannot leave a partial choice.
      const selected = [];
      for (const progress of failed) {
        const repaired = missingRepair(op, progress, peer);
        const planned = op.plan.projects.find((p) => p.project.id === progress.id)!;
        const binding = repaired ? resolveAcceptedBinding(planned, progress, peer as RecoveryNativePeer)!
          : (planned.terminals as TerminalBinding[]).find((t) => t.peer === peer)!;
        const evidence = repaired ? { ...op.missingRecordedSession!, checkedPath: checkedSessionPath(binding, op.missingRecordedSession!.kind) } : undefined;
        if (evidence && (op.missingRecordedSession!.checkedPath !== undefined && op.missingRecordedSession!.checkedPath !== evidence.checkedPath ||
            await driver.recordedSessionState?.(binding, evidence.kind) !== "missing")) throw new Error(`${peer}: recorded conversation is not positively missing at ${JSON.stringify(evidence.checkedPath)}; no fresh-session choice was saved`);
        selected.push({ progress, binding, repaired, evidence });
      }
      for (const { progress, binding, repaired, evidence } of selected) {
        (progress.fresh ??= {})[peer] = { lost: binding.sessionId, reason, at, ...(repaired ? { repaired: true as const } : {}) };
        if (repaired) {
          (progress.repairedSessions ??= {})[peer as RecoveryNativePeer] = true;
          op.freshOverride = { peer: peer as RecoveryNativePeer, evidence: evidence!, checked: "missing", at };
        }
        if (repaired && progress.reattachments?.[peer as RecoveryNativePeer]) {
          progress.terminals[`retired:${peer}`] = binding;
          delete progress.terminals[`closedRetired:${peer}`];
          delete progress.reattachments[peer as RecoveryNativePeer];
        }
      }
      (op.audit ??= []).push({ at, action: "fresh-session", reason, peer, projects: failed.map((p) => p.id) });
      delete op.error; delete op.failure; delete op.blockedReattachment; delete op.presentationCause; delete op.missingRecordedSession;
      op.updatedAt = at; writeOperation(id, op, home);
      return op;
    }
    // Every project is inspected before acting on any, as the runner does before its first stop.
    const unsettled = disposeRefusal(op, live);
    if (unsettled) throw new Error(`${unsettled.project}: its hub reads as ${unsettled.reads}, so whether this operation owns it cannot be verified; nothing was stopped or released; ${next}`);
    const acts: { planned: PlannedProject; live?: Inspection; act: string }[] = [];
    for (let i = 0; i < op.projects.length; i++) {
      const progress = op.projects[i]!, planned = op.plan.projects[i]!;
      const state = progress.phase === "verified" ? undefined : live[planned.project.id]!;
      const ours = state?.state === "running" && state.recovery?.operationId === id && state.recovery.phase !== "released";
      // A target is known by its operation fence, not only by the receipt: `up` may have failed, or the first
      // identity read thrown, after the target started and before its instance was recorded.
      const target = ours && state.instanceId !== planned.source.instanceId && state.recovery?.phase === "restored";
      const act = !state ? "released earlier; left running"
        : state.state === "stopped" ? "stopped"
        : state.state === "missing" ? "project directory is missing; nothing was stopped or archived (ahub doctor --orphans lists a hub left running there)"
        : ours && state.instanceId === planned.source.instanceId && ["pending", "prepared"].includes(progress.phase) ? "source hold released; source left running"
        : target ? "target stopped"
        : state.instanceId === planned.source.instanceId && ["pending", "prepared"].includes(progress.phase)
          ? `source left running (${state.recovery?.operationId && state.recovery.phase !== "released" ? `held by another operation, ${state.recovery.operationId}` : progress.phase === "prepared" ? "its hold had lapsed" : "never prepared"})`
        : `left running: instance ${state.instanceId ?? "unknown"} is not held by this operation`;
      acts.push({ planned, ...(state ? { live: state } : {}), act });
    }
    // Each outcome is recorded as it happens, so a disposition that stops partway stays true and resume refuses it.
    const disposition: NonNullable<RecoveryOperation["disposition"]> = (op.disposition ??= { choice: "stop-and-archive", at, projects: {} });
    delete op.blockedReattachment;
    delete op.presentationCause;
    abandoned(op); // #227: in the same write as the disposition
    // #776: the error that blocked the operation is cleared on disposal, so the audit keeps it.
    (op.audit ??= []).push({ at, action: "stop-and-archive", reason, ...(op.error ? { cause: op.error } : {}), projects: acts.map((a) => a.planned.project.id) });
    // Recorded before the first act: a crash inside a stop leaves a disposition that resume refuses to override.
    delete op.failure;
    op.updatedAt = driver.now(); writeOperation(id, op, home);
    try {
      for (const { planned, live, act } of acts) {
        if (act.startsWith("source hold")) await driver.abort(planned.project, id, planned.source.instanceId!);
        else if (act === "stopped" || act === "target stopped") {
          const outcome = await driver.stopAndArchive(planned.project, op, act === "target stopped" ? live!.instanceId : undefined);
          if (outcome && outcome.continuity) (disposition.continuity ??= {})[planned.project.id] = outcome.continuity;
          if ((await driver.inspect(planned.project, undefined, "cleanup")).state !== "stopped") throw new Error(`${planned.project.id}: shutdown of instance ${live!.instanceId ?? "unknown"} is not verified`);
        }
        disposition.projects[planned.project.id] ??= act;
        op.updatedAt = driver.now(); writeOperation(id, op, home);
      }
    } catch (error) {
      if (isDatabaseBusy(error)) { op.failure = { code: "database_busy", retryable: true, site: databaseBusySite(error) }; error = new RecoveryDatabaseBusy(); }
      op.phase = "blocked"; op.updatedAt = driver.now();
      op.error = `stop-and-archive stopped partway and keeps the lock: ${error instanceof Error ? error.message : "disposition failed"} (a committed source stops by itself); ${nextActionsText(op, await liveProjects(op, project => driver.inspect(project, undefined, "cleanup")))}`;
      writeOperation(id, op, home);
      throw error;
    }
    delete op.error; delete op.failure;
    op.phase = "cancelled"; op.step = "disposed: stop-and-archive (abandoned, not completed)"; op.updatedAt = driver.now();
    writeOperation(id, op, home); releaseRecoveryLock(id, home, scope);
    return op;
  } finally { releaseRunner(); }
}
