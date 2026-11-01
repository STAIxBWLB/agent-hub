import { parseAttemptReceipt, parseResearchRunners, verifyAttemptReceipt } from "./research-runner.ts";
import type { InvocationRow } from "./invocations.ts";
import type { ContextAdmission } from "./context-window.ts";
import { queueBackpressure, queueBackpressurePolicy, type QueueBackpressureCode, type QueueBackpressurePolicy, type QueueBackpressureStatus, type QueuePressure } from "./queue-backpressure.ts";
import { canonicalMemorySymbolNode, normalizeMemorySymbolInput, MEMORY_SYMBOL_LIMIT, type MemorySymbolNodes } from "./memory-symbols.ts";
import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./packs.ts";
import { parseExperimentProtocol, parseExperimentAttempt, parseExperimentEvent, protocolHash, checkRunObservation, deliverableObservation, projectExperimentWithObservations, projectRunnerReceipt,
  type ExperimentProtocolContract, type ExperimentProtocolRecord, type ExperimentAttemptRecord, type ExperimentWriteFence, type ExperimentHostEvidence, type ExperimentStatus } from "./research-experiments.ts";
import { parseComparisonPlan, comparisonPlanHash, comparisonProjection, evaluatorIdentityHash, protocolApprovalBindingMatches, type ComparisonPlanV1 } from "./research-experiments.ts";
import { parseResearchHandoff, studyProjection, campaignHash, parseResearchCampaign, type ResearchCampaignContract, type ResearchCampaignStatus } from "./research-campaign.ts";
import type { ResearchCampaignRecord, ResearchUnitBinding, PreparedResearchUnit, HandoffOutboundRow } from "./board.ts";
import { HANDOFF_EVENTS, HandoffRefusal, followBackLine, handoffEventFor, parseHandoff, type HandoffEvent } from "./handoff.ts";
import { taskShellBindingValid, type TaskShellBinding } from "./task-shell-command.ts";
import { buildTaskCodeSymbols, publicTaskCodeSymbols, taskCodeSymbolsDisjoint, HOST_CODE_SYMBOLS } from "./task-code-symbols.ts";
import { normalizePlanSymbol, symbolsOverlap } from "./symbol-normalizer.ts";
import { publicTestIntegrity, readTestIntegrity, testIntegrityBlockers, type TestIntegrity } from "./test-integrity.ts";
import { evalAdvice, evalGapBlockers, evalRequiredChecks, readEvalFor } from "./eval-gate.ts";
import { completePlanInventory, planConformance, planConformanceBlockers, planFingerprint, type PlanConformance } from "./plan-conformance.ts";
import { RELEASE_TRAIN_HISTORY_LIMIT, releaseTrainData, releaseTrainReadiness, releaseMetrics } from "./sdlc-release.ts";
import { cleanCostPlan, costMetrics, type CostPlan, type ReviewCost } from "./cost-governance.ts";
import { qualifiedTitleRepos, siblingTitleRefs, specRefs } from "./spec-read.ts";
import { folderDetail, MAX_NEW_PER_POLL, scheduleNext, SOURCE_ID, scheduledDetail, scheduleKeyOf, type FolderEntry, type FolderRunResult, type FolderScan, type FolderStorePort, type ScannedFile, type ScheduleEntry, type ScheduleRunResult, type ScheduleStore } from "./schedules.ts";
import { INTAKE_MAX_SOURCES, INTAKE_MAX_TEXT, intakeDetail, intakeSystemPrompt, intakeUserMessage, parseIntakeDetail, parseIntakeSplit, plannerRequestBody } from "./intake.ts";
import { DEFAULT_BAND, EPISODE_LOOKBACK, sdlcMetrics, type BandMetric, type BandResult, type MetricTask, type MetricsReport, type SeriesPoint } from "./sdlc-metrics.ts";
import { readSecurityScan } from "./security-baseline.ts";
import { cleanMergeCost } from "./cost-governance.ts";
import type { InstancesConfig } from "./instances.ts";
import { composeRememberText } from "./memory-fail.ts";
import { VERSION } from "../version.ts";
import { NoWriteTurns } from "./no-writes.ts";
import { readGitHubImport, type GitHubSource, type GitHubImportSelection } from "./github-import.ts";
import { BACKLOG_SPLIT_SCREEN_TIMEOUT_MS, actualTaskDates, planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import { readMergeQueue, type DeliveryTask, type MergeQueue } from "./sdlc-queue.ts";
import { guardedMerge, mergeModeFor, mergeView, type MergeView } from "./sdlc-merge.ts";
import { mirrorVerdict as mirrorToGitHub, type MirrorVerdict } from "./sdlc-mirror.ts";
import { CODE_SCOPE_LINE, evidenceOnlyNotice, type ReviewScope } from "./review-scope.ts";
import { DEFAULT_MAX_NITS, parseReviewFindings, findingsForHead, findingHead as resolveFindingHead, findingTally, type ReviewFinding, type ReviewFindingSet } from "./review-findings.ts";
import { readReleaseReadiness } from "./sdlc-release.ts";
import { loadRoleCatalog, taskRole, taskRoleText, type RoleCatalog } from "./roles.ts";
import { matchesPolicy, policyRealPath, insideRoot } from "./path-policy.ts";
import { isDenied } from "../local/deny.ts";
import { foldSegment, isHubWritePath } from "./permission-mode.ts";
import { correctionInput, resolveVisibleMemory } from "./memory-candidates.ts";
import type { MemoryScreen } from "./read-tools.ts";
import { withoutPii, mentionsPrivatePath } from "./memory-policy.ts";
import { profileClass, profileData, profileTaskLabel, projectProfile, type ProfileName, type ProfileSelection, type ProjectProfile } from "./profiles.ts";
import { criteriaView, unmetCriteriaIds, workflowHash } from "./workflow.ts";
import { candidateCard, criterionKey, groupUnmetCriteria, LEARNING_DEFAULTS, overridesDiff, parseCandidateCard, selectGroups, type CriterionGroup } from "./learning.ts";
/** #514b: how a closed candidate card says what the person decided; `learnCandidates` reads them back. */
const LEARN_ACCEPTED = "candidate accepted", LEARN_REJECTED = "candidate rejected";
/** What the person decided on a candidate card, read from its cancellation: only an entry the person wrote counts, so no other note can pass for a verdict. Undefined while it is open or closed for another reason. */
const learnVerdict = (card: Pick<Task, "state" | "history">): "accepted" | "rejected" | undefined => {
  if (card.state !== "cancelled") return undefined;
  const closed = card.history.findLast(entry => entry.event === "cancelled");
  if (!closed || closed.by !== USER) return undefined;
  return closed.note?.startsWith(LEARN_ACCEPTED) ? "accepted" : closed.note?.startsWith(LEARN_REJECTED) ? "rejected" : undefined;
};
import { approvedDeliverables, latestDeliverables, parseDeliverableClaims, publicDeliverables, type DeliverableRecord, type DeliverableStatus } from "./deliverables.ts";
import { checkDeliverables, DeliverableRefusal, hashDeliverables, vetDeliverables, type DeliverablePorts } from "./deliverable-files.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { Briefs, NativeItem } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { candidateTargetRevision, type CandidateInput, type CandidateStore, extractNodes, looksSecret, PROMOTED_KINDS, taskKey, type GoalView, type Kind, type MemoryStore, type Scope, type Tier } from "@staix/agent-mem";
import { parseClaimVerdict, claimListId, CLASSES, OUTCOMES_KEPT_MS, ALL_PLAN_KEYS, TASK_MOVE_REASONS, taskCanPlan, taskHasWorkEvidence, taskHasStarted, planningUndoEntry, isClosedTaskState, type TaskStall, type HistoryEntry, type ReviewerHistory, type Board, type Task, type TaskClass, type TaskMoveReason, type TaskPlan, type TaskRefs, type PlannerBinding } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, NOTE_KINDS, noteLine, sanitize, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import type { PiiVerdict, ScreenItem, ScreenRecord } from "./inference.ts";
import { assign, isRemotePeerId, detectSignals, peerEntry, predictSplit, relayCandidates, type Assignment, type InstanceRoutingOptions, type PeerCapabilities, type Routing, type SplitObservation, type SplitPrediction } from "./routing.ts";
import { ExecutionBudget, type ExecutionBudgetConfig, type ExecutionBudgetDecision, type ExecutionBudgetStatus, type ExecutionUnit } from "./execution-budget.ts";
import { Cohorts, MAX_REQUESTS, type Cohort, type Completion } from "./cohorts.ts";
import { realPath } from "./project.ts";
import { TaskRepositories } from "./task-repository.ts";
import { mainCheckoutWarning } from "./main-checkout.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { coverageGap, renderReviewBrief, type ReviewBrief } from "./review-brief.ts";
import { definitionOf as builtinDefinitionOf } from "../adapters/registry.ts";
import { ADAPTERS, DEFAULT_REVIEW_POOL, definitionOf, familyOf, type ProjectAdapterCatalog } from "../adapters/registry.ts";
import { plannerGrooming, nextSweep, taskSweepConfig, type TaskSweepConfig, type SweepRecord } from "./task-sweep.ts";
import { CiWatchers, pollCi, type CiOutcome, type CiWatch } from "./ci-watch.ts";
import { planningIssueReceipt, linkedReceipt, openPrFor, readPrCostHistory, readReviewReadiness, reviewReadinessFromEvidence, type PrEvidence, type ReviewReadiness, readPlanIssueMetadata, canonicalStage, checklistOf, readSdlcPr, readSpecEdit, sdlcConfig, sdlcReceipt, sdlcStatus, specState, SPEC_STATE_TEXT, stageDefinition, lifecycleStage, type SdlcConfig, type MergeRecord, type PlanIssueMetadata, sdlcGh, type SdlcGh, type SdlcStatus, type SpecEdit, type SpecState } from "./sdlc.ts";

function requireLocalTaskPeer(peer: unknown): void {
  if (isRemotePeerId(peer)) throw new PreEffectToolRefusal("remote peers have no local task authority");
}

export type TaskAssignmentRole = "owner" | "reviewer" | "planner";

export interface ReleaseWindow { at: number; host: boolean; quota: boolean; idle: boolean; reasons: string[]; current?: () => boolean; close?: () => Promise<void>; }

export interface TasksDeps {
  adapterCatalog?: ProjectAdapterCatalog;
  /** Host-bound evidence only; absent/expired observations never admit a release cut. */
  releaseWindow?: () => Promise<ReleaseWindow>;
  /** Effective per-peer planner capacity, taken from the existing settings loader. */
  wipLimit?: (peer: PeerId) => number;
  recordPlanning?: (change: { by: string; task?: number; release?: number; fields: string[]; revision: number }) => void;
  /** The clock of the planner board-changed notice window (#758); tests inject one. Absent: `Date.now`. */
  now?: () => number;
  board: Board;
  bus: Bus;
  routing: () => Routing;
  /** #800: normalized machine-local admission policy; absent or both zero preserve the old queue behaviour. */
  queueBackpressure?: () => QueueBackpressurePolicy;
  /** Host-only native context snapshots, separate from checkpoint notification and quota. */
  contextAdmission?: () => ContextAdmission;
  /** Startup-bound project declarations; routing never discovers instances from peer names. */
  instances?: () => InstancesConfig;
  /** Host proof of each live extra runtime's actual isolated execution root; config paths alone are not proof. */
  ownerIsolation?: () => Readonly<Record<string, boolean>>;
  cwd: string;
  project: string;
  profile?: ProfileName;
  profileData?: ProjectProfile;
  piiPaths?: string[];
  /** The project's secrets denylist (`local.deny`), for the deliverable file reader (#509a). */
  deny?: string[];
  /**
   * #509a: the root a peer's files live under: its verified execution root (the daemon's `ownerWriteRoot`), which for a declared worktree
   * instance is not the project checkout. `undefined` means the root is not proven right now. Absent (library use): the project root.
   */
  executionRoot?: (peer: PeerId) => string | undefined;
  catalog?: RoleCatalog;
  /** Role ids whose contract was prepared for the current native session. */
  sessionRoles?: (peer: PeerId) => string[];
  /** Optional bounded snapshot presentation; never stored in task history or memory. */
  projectedReview?: (task: Task) => string | undefined;
  /** Closed host evidence since the current acceptance: false means proven no writes; undefined is unknown. */
  ownerWrites?: (task: Task, since: number) => boolean | undefined;
  /** Explicit acceptance/self-claim only; implicit done has no pre-work baseline. */
  ownerAccepted?: (task: Task) => void;
  /** #520: the review brief for a task's commit (git only, bounded); undefined when the task names no commit. */
  prepareReviewBrief?: (task: Task) => Promise<void>;
  reviewBrief?: (task: Task) => ReviewBrief | { unavailable: string } | undefined;
  /** Host-verified existing symbols at this task's admitted completion head; never plan guesses. */
  memorySymbolNodes?: (task: Task) => MemorySymbolNodes | undefined;
  sdlc?: { config: () => SdlcConfig; gh?: SdlcGh };
  /** #785 P1b: the per-head CI watcher's bounds; tests shorten them, the defaults are `CI_WATCH_*` in `ci-watch.ts`. */
  ciWatch?: { deadlineMs?: number; pollMs?: number };
  /** #785 P1c: `tasks.auto_pull`, read at each capacity release so a reload applies to the next one; absent or false pulls nothing. */
  autoPull?: () => boolean;
  briefs?: Briefs;
  /** Screened live fail notes directly intersecting the task plan or refs; read-only advice. */
  planFails?: (task: Task) => NativeItem[];
  candidates?: CandidateStore;
  candidateScreen?: MemoryScreen;
  /** Authenticated live turn context, not a model-supplied flag. */
  privateTurn?: (peer: PeerId) => boolean;
  /** #223 R4: the hub's reading of a verdict's context (`fresh` only for a reviewer session started for this review). */
  reviewContext?: (by: PeerId, task: number) => "fresh" | "continuing" | undefined;
  /** #852: what a reviewer reads. `code` (the fixed sandboxed reviewers by default, or a local `review_scope`) reads the code only; unset or `full` also runs tests and reads CI. */
  reviewScope?: (peer: PeerId) => ReviewScope;
  /** #223 R2: a reviewer-only instance gets review facts, not the builder's done summary. */
  reviewOnly?: (peer: PeerId) => boolean;
  /** #223: captured when a verdict call starts; a non-undefined result refuses the verdict at every later check. */
  reviewAuthority?: (by: PeerId, task: number) => (() => string | undefined) | undefined;
  /** Host-captured current-child authority, rechecked before an admitted async tool first commits effects. */
  requestAuthority?: (by: PeerId) => (() => string | undefined) | undefined;
  /**
   * #933: whether `by` runs this call inside an admitted, audited conductor operation. The host rechecks the role on every call and throws
   * its authority refusal when it ended; a peer outside such a call gets `false`. Host-only: never read from configuration or a tool.
   */
  operational?: (by: PeerId) => boolean;
  memory?: MemoryClient;
  /** Captured native profile fence at our memory operation boundaries; no board mutation. */
  memoryCheck?: () => void;
  /** #258: the hub's own store, the project name it files entries under (the git chain) and the repo `#N` issues belong to. */
  store?: { store: MemoryStore; project: string; repo: string; deny?: string[]; onNote?: (id: string) => void };
  /** a line for the human: console tail and hub.log */
  notify: (line: string) => void;
  /** The completion check configured for a class, if any (local config only; issue #7). */
  check?: (cls: TaskClass, task?: Task) => string | undefined;
  /** #901: the key of the `checks` entry `check` chose for this task (the profile class alias, else the class): the same lookup, so the two cannot disagree. Absent: the key is unknown. */
  checkKey?: (cls: TaskClass, task?: Task) => string | undefined;
  /** Runs one check; the hub runs them one at a time. */
  runCheck?: (command: string) => Promise<{ code: number | null; timedOut: boolean; interrupted?: boolean; tail: string }>;
  /** Hands a saved note to every other peer; it rides on their next delivery. */
  share?: (by: PeerId, line: string) => void;
  /** Hands one peer a line that rides on its next delivery, without a turn of its own (issue #6). */
  tell?: (peer: PeerId, line: string) => void;
  /** Structured overlap records for telemetry (issue #40); the notice line stays for the human. */
  recordOverlap?: (task: number, owner: PeerId, others: { task: number; owner: PeerId; paths: string[]; symbols?: string[] }[]) => void;
  /** Quota per peer from fresh readings (issue #36): routing drains the windows that reset soonest first. */
  quota?: () => Record<PeerId, { headroom: number; resetsAt?: number }>;
  /** Optional persisted task/run execution limits (issue #102). */
  executionBudget?: ExecutionBudget;
  /** Project-scoped immutable-source metadata, read only before a study transaction. */
  studySource?: (id: string) => { id: string; sha256: string; private: boolean } | undefined;
  /** Host-only fixture clock; never read from model input or project configuration. */
  studyNow?: () => number;
  /** Host-only reader for this project's check-runner receipts; record inputs never supply a receipt. */
  experimentCheck?: (run: string) => Promise<unknown>;
  /** Fresh trusted machine-local runner registrations. A source-trust failure refuses new receipts. */
  researchRunners?: () => unknown;
  /** Reviewer choice from recorded review outcomes (issue #35); off unless the project config turns it on. */
  review?: { adaptive: boolean; min_reviews: number; pool?: readonly string[]; rerotate?: boolean; same_family?: "fallback" | "never" };
  /** Peers whose recent deliveries all failed, with the reason (issue #89); routing skips them. */
  capabilities?: () => Record<PeerId, PeerCapabilities>;
  repository?: string;
  offerRead?: (peer: PeerId, envelopeId: string) => boolean;
  offerPullOnly?: (peer: PeerId) => boolean;
  cancellationHeld?: () => boolean;
  stallNotice?: (stall: TaskStall) => void;
  failing?: () => Record<PeerId, string>;
  /** Peers whose queue a needs_review delivery holds, with the hold detail (issue #90); routing explains the hold, never rejects. */
  held?: () => Record<PeerId, string>;
  /** Closed host facts only; approval text and quota reasons never enter the grooming projection. */
  plannerBlocks?: () => Record<PeerId, ("approvals" | "quota")[]>;
  /** Roles from `.agenthub/config.json` (issue #92): peers with the reviewer role join the reviewer candidates. */
  roles?: Record<string, string[]>;
  /** Optional: name a class for a task proposed without one. `onCampus` says whether the model call stays on campus. */
  triage?: { classify: (title: string, detail: string) => Promise<TaskClass | undefined>; onCampus: () => Promise<boolean> };
  /** #334: natural-language intake. `split` is the hub model's one call, `partsSchema` the profile's `hub_backlog_split` parts schema, `sourceKnown` the source registry. */
  intake?: { split: (system: string, user: string, opts: { campusOnly: boolean }) => Promise<string | undefined>; partsSchema: () => unknown; sourceKnown: (id: string) => boolean };
  /** The PII screen (issue #198): a closed verdict from a model on this machine or on campus, `unknown` on any failure. */
  piiScreen?: (text: string) => Promise<PiiVerdict>;
  /** Each screen verdict, for the record: item, label, source and category, never the text. */
  recordScreen?: (record: ScreenRecord) => void;
  /** Turn-free coordination (issue #107): configured and no PII task open. Asked at each use. */
  turnFree?: () => boolean;
  /** Coordination preference captured for each newly created task; existing rows keep their initial mode. */
  coordination?: () => boolean;
  /** Whether a peer's context path for facts is verified in its current session (issue #108). */
  capable?: (peer: PeerId) => boolean;
  /** Whether `peer` is between native turns now (issue #107): Codex not busy, Claude stopped since its last tool call. */
  idle?: (peer: PeerId) => boolean;
  /** One hash over these project files as they are now: an integration target (issue #107). */
  treeHash?: (paths: string[], windows: { peer: PeerId; since: number; until?: number }[]) => string;
  /** The facts due for a peer, offered with an integration request; acknowledged by its next done. */
  integrationFacts?: (peer: PeerId) => { id: string; text: string } | undefined;
  ackFacts?: (peer: PeerId, id: string) => void;
  /** Whether a peer has been shown every change to its files. */
  factsCurrent?: (peer: PeerId) => boolean;
  /**
   * A peer's split profile now (issue #109): the hub's version, its agent's and the hook profile. Each hand-over is
   * tagged with it, and only records with a peer's current profile are its observations. Undefined while unknown.
   */
  splitProfile?: (peer: PeerId) => string | undefined;
  /**
   * A shadow split prediction, for the record (issue #109): `routing` when routing chose the owner of a task that
   * overlaps another owner's task not started yet (what calibration reads), `cohort` when an overlap formed a cohort.
   */
  recordSplit?: (task: number, prediction: SplitPrediction, where: "routing" | "cohort") => void;
  /** A cohort formed, changed or was lifted (issue #107), for the record: the benchmark's treatment check reads it. */
  recordCohort?: (cohort: { id: number; event: "formed" | "joined" | "lifted"; silent: boolean; tasks: number[]; owners: PeerId[] }) => void;
  sweep?: TaskSweepConfig;
  /** #798 D1: the project's declared submodule paths, project-relative. Absent: none are known, so no notice. */
  submodules?: () => string[];
  /** Shutdown or coordinator work (recovery) holds task sweeps, and a guarded merge at its dispatch (#491). */
  sweepHeld?: () => boolean;
  /** Consecutive changes_requested verdicts that move a task to another peer (`tasks.escalate_after`, #488). */
  escalateAfter?: () => number;
  /** #489 H1: current host configuration, read at each planner-notice flush; no task/request override. */
  groomFyiWindowMin?: () => number;
  /** #489 H2: current host configuration, read at each use (no cache, no task/request override); absent is the constant each replaces. */
  demoteAt?: () => number;
  demotionHalfLifeH?: () => number;
  contradictionWindowDays?: () => number;
  rescreenMax?: () => number;
  splitMinObservations?: () => number;
  splitMaxFailureShare?: () => number;
}

/** The `tasks.escalate_after` default (#488): the third consecutive changes_requested escalates. */
export const ESCALATE_AFTER = 3;
// Demotion (issue #36): a failure counts half after a day. A peer is demoted for a class once its decayed failures
// reach 1.5 (two within about half a day, three within two days) and outweigh its decayed successes there.
// #489 H2: `tasks.demotion_half_life_h` and `tasks.demote_at` set these; unset they are exactly the constants below (pinned in test/operational-settings.test.ts).
export const DEMOTION_HALF_LIFE_MS = 24 * 3_600_000;
export const DEMOTE_AT = 1.5;
/** An approval counts as contradicted when work on the same places fails within this window (issue #35); `tasks.contradiction_window_days` sets it. */
export const CONTRADICTION_WINDOW_MS = 7 * 86_400_000;
const OPEN: Task["state"][] = ["proposed", "in_progress", "changes_requested"];
const QUEUE_PRESSURE_CODES: readonly QueueBackpressureCode[] = ["queue-count", "queue-age", "queue-age-unknown"];
const isQueuePressureCode = (code: string): code is QueueBackpressureCode => (QUEUE_PRESSURE_CODES as readonly string[]).includes(code);
const QUEUE_RECHECK_PAGE = 32;
interface QueuePressurePass { ownerAfter: number; reviewAfter: number; ownerDone: boolean; reviewDone: boolean; retained: boolean; generation: number }
/** Board events that leave a task where its completion check found it; any other event means it moved on meanwhile. */
const QUIET_EVENTS = new Set(["answer", "reviewer changed", "idle sweep", "memory reference started"]);
QUIET_EVENTS.add("ready held"); // #655: the hub's note that a ready task waits for its reserved owner's WIP slot.
QUIET_EVENTS.add("plan observed"); // Host observation does not move the task or replace completion intent.
QUIET_EVENTS.add("planner changed"); // Planning authority does not move the execution owner or revoke its handoff.
QUIET_EVENTS.add("claim verdict"); // #901: a person's bookkeeping on a plan claim moves nothing, so it must not turn a running check into "check finished late".
QUIET_EVENTS.add("invocation");
QUIET_EVENTS.add("shell branch bound"); // #880: the hub's host-observed branch binding (#845) is bookkeeping; it neither moves nor settles the task.
/** The records of the `done (checking)` entry a passed check now completes: what the owner delivered then (#509a). */
const latestPendingDeliverables = (task: Task): DeliverableRecord[] | undefined => {
  const checking = task.history.findLastIndex(entry => entry.event === "done (checking)");
  return checking >= 0 && !task.history.slice(checking + 1).some(entry => entry.event === "done") ? task.history[checking]!.deliverables : undefined;
};

/**
 * Thrown when an assignment's board write is saved but a publish or notify after it failed (#297): the move is
 * fact, the delivery is unconfirmed. Callers decide by this type, never by comparing owners or reading history.
 * It stays a plain Error subclass, so the preEffect rule and the #231 ready-offer contract are unchanged.
 * `task` and `cause` are non-enumerable: a PII task's title and detail must not reach a JSON.stringify of the error.
 */
export class AssignmentUndeliveredError extends Error {
  /** The task as the board has it after the write. */
  declare readonly task: Task;
  declare readonly cause: unknown;
  constructor(task: Task, cause: unknown) {
    super(`task #${task.id}: the assignment to ${task.owner} is saved, but its delivery is not confirmed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AssignmentUndeliveredError";
    Object.defineProperty(this, "task", { value: task, enumerable: false });
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}

/** A later task-flow event won before the assignment could be published, so the stale envelope is suppressed. */
export class AssignmentSupersededError extends Error {
  constructor(task: Task) {
    super(`task #${task.id}: assignment was superseded before publication`);
    this.name = "AssignmentSupersededError";
  }
}

/** A project path as one spelling (#67): no leading `./`, no repeated or trailing `/`; the root is `.`. */
export const normPath = (p: string) => p.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || ".";

/** Same path, or one is a directory of the other; the project root (`.`) holds everything. */
export const samePlace = (a: string, b: string) => {
  const [x, y] = [normPath(a), normPath(b)];
  return x === "." || y === "." || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

/** Events that hand a task to an owner (or take it away); newer history records that owner on them (#67). */
export const OWNERSHIP_EVENTS = new Set(["assigned", "escalated", "reassigned", "unassigned"]);
/** The note on an accept recorded by the done call itself: its stages are unknown to the split prediction (issue #109). */
const WITH_DONE = "with its done";
/** How many times a task changed hands: a cohort member's generation (issue #107). */
const ownerGen = (t: Task) => t.history.filter((h) => OWNERSHIP_EVENTS.has(h.event)).length;
/** One hand-over of a task to an owner: a task handed back to a peer that had it before is a new one (#115). */
const handOver = (t: Task, owner: PeerId) => `${t.id}@${owner}#${ownerGen(t)}`;
/** When the task was handed to its current owner (its creation, if it never changed hands). */
const handedAt = (t: Task) => [...t.history].reverse().find((h) => OWNERSHIP_EVENTS.has(h.event) && h.event !== "unassigned")?.at ?? t.history[0]?.at ?? Date.now();

/** One line of model-written text: whitespace (newlines included) collapses, so it can never start a forged log line. */
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 300) : undefined);
/** A list of short strings; a lone string counts as a list of one. */
const textList = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(text).filter((p): p is string => !!p).slice(0, 50);
const fields = (input: unknown) => (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;

/** Tool callers are models: inputSchema is not enforced on the way in, so refs are normalized before they reach the board. */
function cleanRefs(input: unknown): TaskRefs {
  const r = fields(input);
  const paths = [...new Set(textList(r.paths).map(normPath))];
  const out: TaskRefs = {};
  for (const k of ["repo", "branch", "commit"] as const) if (text(r[k])) out[k] = text(r[k])!;
  if (paths.length) out.paths = paths;
  return out;
}

/** Acceptance may correct repository metadata, never file intent or work evidence. */
function acceptRefs(input: unknown): TaskRefs | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "repo")) throw new PreEffectToolRefusal("accept refs may contain only repo");
  const raw = input as Record<string, unknown>;
  if (!Object.hasOwn(raw, "repo")) return undefined;
  if (typeof raw.repo !== "string" || !raw.repo.trim() || raw.repo.length > 300) throw new PreEffectToolRefusal("accept refs.repo must be a bounded repository slug or path");
  return { repo: text(raw.repo)! };
}

/** The same for a plan (issue #31): only its four lists, each of short strings. */
function cleanPlan(input: unknown, profile: ProfileSelection = "dev"): TaskPlan {
  const r = fields(input);
  const evidence: Pick<TaskPlan, "proof" | "risks"> = {};
  for (const key of ["proof", "risks"] as const) {
    const value = r[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string" || item.length > 512)) throw new PreEffectToolRefusal(`plan.${key}: expected at most 32 strings of at most 512 characters`);
    const items = value.map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (items.length) evidence[key] = items;
  }
  let scope: CostPlan;
  try { scope = cleanCostPlan(r); } catch { throw new PreEffectToolRefusal("invalid review or CI cost scope"); }
  return { ...Object.fromEntries((profileData(profile).plan_keys as (keyof TaskPlan)[]).map((k) => [k, k === "paths" ? [...new Set(textList(r[k]).map(normPath))] : textList(r[k])] as const).filter(([, v]) => v.length)), ...evidence, ...scope };
}

/** A plan as one line for other owners; the whole plan is on the board. */
const planText = (plan: TaskPlan = {}) => ALL_PLAN_KEYS.filter((k) => plan[k]?.length).map((k) => `${k.replace("_", " ")}: ${plan[k]!.join("; ")}`).join(" | ");
/** What the PII screen reads of a task (#198): the text the patterns are checked against. */
const screenText = (t: { title: string; detail: string; plan?: TaskPlan; external?: Task["external"] }) => [t.title, t.detail, planText(t.plan), t.external?.repo, t.external?.url].filter(value => value !== undefined).join("\n");
/** Re-screens of one task whose verdict was unknown, per hub run (#198). */
export const RESCREEN_MAX = 10;
/** #758: the planner "board changed" notice. Its body starts with this, so an unsettled copy is found (and replaced) by the prefix. */
const GROOM_NOTICE_PREFIX = "The board changed";
/** #758: a board change that needs no plan review is recorded at most once per planner in this window. */
export const GROOM_FYI_WINDOW_MS = 10 * 60_000;

/**
 * The task flow. Adapters and tools never touch the board: every change comes through here, where assignment,
 * PII handling, envelopes, briefs and memory notes are decided in one place.
 */
/** #694: a PR staged at done with the commit or branch it was read for. */
export interface ResearchCampaignReceipt { id: string; parentTaskId: number; revision: number; status: ResearchCampaignStatus; unitCount: number; units: ResearchUnitBinding[] }
interface StudyReferences { parent: Task; adopted: Map<string, Task>; reused: Map<string, Task>; private: boolean; key: string }
export interface ExperimentReceipt { kind: "protocol" | "attempt" | "event" | "receipt"; protocolHash: string; attemptId?: string; seq?: number; receiptId?: string }
export interface ComparisonPlanReceipt { kind: "plan"; planHash: string }
export interface ProtocolApprovalReceipt { protocolHash: string; evaluatorHash: string; approvedBy: string; approvedAt: number }
export interface ExperimentAttemptView {
  id: string; protocolHash: string; taskId: number; phase: "development" | "final"; status: ExperimentStatus; private: boolean;
  protocol: unknown; events: unknown[]; evidence: Record<string, unknown>; eventsComplete: boolean; nextEventCursor?: number;
  campaignRevision: number; approval: "approved" | "unapproved"; postHoc: "unknown" | "predeclared" | "post-hoc";
  retryOf?: string; reproducesAttemptId?: string; independentlyReproduced: false;
}
export interface ExperimentView { attempts: ExperimentAttemptView[]; counts: { all: number; statuses: Record<ExperimentStatus, number> }; nextCursor?: number;
  comparison?: { planHash: string; baselineAttemptId: string; variantAttemptId: string; approved: boolean; private: boolean; projection: ReturnType<typeof comparisonProjection> | "[pii]" } }
interface ExperimentContext { task: Task; campaign: ResearchCampaignRecord; private: boolean; key: string; fence: ExperimentWriteFence }
interface CompletionRefresh { revision: number; commit: string }
interface IdentityLink { repo: string; pr: number; basis: { commit?: string; branch?: string } }

/** What one live check of a task's files says as a whole (#317): `unchanged` only when EVERY file measured unchanged. A change outranks a missing file, which outranks one the hub could not read. */
export type DeliverableResult = "changed" | "missing" | "unknown" | "unchanged";
export const deliverableResult = (states: readonly DeliverableStatus["state"][]): DeliverableResult =>
  states.includes("changed") ? "changed" : states.includes("missing") ? "missing" : states.includes("unknown") || !states.length ? "unknown" : "unchanged";

/** One row of `ahub deliverables` and one card's badge (#317): ids, hashes and sizes always; a path only where `publicDeliverables` allows it. */
export interface DeliverableRow {
  task: number; title: string; taskState: string; state: "delivered" | "approved";
  /** True only when the files were measured for this row. Without it `changedSinceReview` is absent: the board alone cannot know. */
  checked: boolean; changedSinceReview?: boolean;
  /** Present only when `checked`: the whole-row reading of the measurement (never `unchanged` while any file is missing or unreadable). */
  result?: DeliverableResult;
  files: { id: string; path?: string; format: string; version?: string; sha256: string; bytes: number; private?: true; state?: DeliverableStatus["state"] }[];
}

export class Tasks {
  private readonly planReviewRequests = new Map<number, string>();
  private readonly repositories: TaskRepositories;
  private readonly incomingBacklog = new Set<number>();
  private readonly plannerBacklog = new Map<PeerId, Set<number>>();
  private readonly plannerBlockedQueue = new Map<PeerId, string>();
  private readonly knownPlanners = new Set<PeerId>();
  /**
   * #758: what the planner board-changed notice has read of the board. `revision` is the board status revision last scanned, `lengths` each task's
   * history length at that scan (so only entries added since are read), `pending` what each planner has not yet been told (`review`: a planning
   * revision or dependency change of a card it plans; `other`: a state move, review or assignment) and `sent` when it was last told.
   * ponytail: a scan lists the whole board once per status revision (at most one per flush); the upgrade is an indexed history read.
   */
  private readonly groomScan = { revision: -1, lengths: new Map<number, number>(), deps: new Map<number, string>(), pending: new Map<PeerId, { review: boolean; other: boolean }>(), sent: new Map<PeerId, { fyiAt: number }>() };
  /** Turn-free cohorts (issue #107): who works without messages, and who integrates. */
  readonly cohorts: Cohorts;
  private readonly coordinationModes = new Map<number, boolean>();
  private sweepConfig: TaskSweepConfig;
  private readonly noWriteTurns = new NoWriteTurns();
  private sweeping = false;
  /** #785 P1b: one bounded CI watcher per exact PR head, and the reviews the hub held as premature, by task id. */
  private readonly ciWatchers: CiWatchers;
  private readonly heldReviews = new Map<number, { head: string; reviewer: PeerId; revision: number }>();

  constructor(private readonly d: TasksDeps) {
    this.ciWatchers = new CiWatchers({
      ...d.ciWatch,
      poll: watch => pollCi(watch, watch.head, d.sdlc?.config().requiredChecks ?? [], d.sdlc?.gh ?? sdlcGh),
      current: watch => this.ciWatchCurrent(watch),
      finish: (watch, outcome) => this.ciCompleted(watch, outcome),
    });
    d.board.trackPlanRevisions = () => (d.sdlc?.config().mode ?? "off") !== "off";
    this.repositories = new TaskRepositories(d.cwd, d.repository);
    d.board.proposalPlanner = task => this.proposalPlanner(task);
    for (const task of d.board.list()) this.warmRepository(task);
    if (d.coordination) {
      const mode = d.coordination();
      for (const task of d.board.list()) this.coordinationModes.set(task.id, mode);
    }
    const backlog = d.board.list("backlog");
    for (const [peer, roles] of Object.entries(d.roles ?? {})) {
      if (!roles.includes("planner")) continue;
      this.knownPlanners.add(peer);
      const queued = d.bus.queuedBacklogIds(peer);
      this.addPlannerBacklog(peer, backlog.filter(task => !queued.has(task.id)).map(task => task.id));
    }
    this.sweepConfig = taskSweepConfig(d.sweep);
    this.cohorts = new Cohorts({
      silence: (owners) => this.turnFree() && owners.every((p) => p !== USER && p !== HUB && (this.d.capable?.(p) ?? false)),
      idle: (peer) => this.d.idle?.(peer) ?? false,
    });
    // What the on-prem worker says about a PII task is private on the bus (console tail and log show a stub), so the
    // board keeps the text: `ahub task show <id>` is where the console user reads it, a refusal included.
    d.bus.tap((e) => {
      if (e.t === "overflow" && e.env.from === HUB && e.env.kind === "task" && Array.isArray(e.env.refs?.backlog)) {
        const ids = e.env.refs.backlog;
        if (ids.length <= 64 && ids.every(id => Number.isSafeInteger(id) && id > 0)) this.addPlannerBacklog(e.peer, ids);
        this.plannerBlockedQueue.set(e.peer, JSON.stringify(d.bus.queueIds(e.peer)));
      }
      // A turn that ends takes its hand-overs with it: busy later is another turn (#115). The adapter's own state, since a
      // pause shows as `paused` while the turn goes on.
      if (e.t === "state" && d.bus.peers.get(e.peer)?.state !== "busy") for (const [k, p] of this.sent) if (p === e.peer) this.sent.delete(k);
      if (e.t !== "envelope" || !e.env.private || e.env.from === HUB || !e.env.refs?.task) return;
      try {
        d.board.update(Number(e.env.refs.task), e.env.from, "answer", {}, e.env.body.slice(0, 4000));
      } catch {
        // the task is gone: nothing to attach the answer to
      }
    });
  }

  isPii = (task: Pick<Task, "signals">) => task.signals.includes("pii_path") || (task.signals.includes("pii") && this.d.routing().constraints.pii === "local_only");

  private signalsFor(task: Pick<Task, "title" | "detail" | "refs"> & { plan?: TaskPlan }, routing = this.d.routing()) {
    const signals = detectSignals(task, routing, this.d.cwd);
    const paths = [...(task.refs.paths ?? []), ...(task.plan?.paths ?? []), ...(task.plan?.sections ?? []).map(anchor => anchor.split("#")[0]!).filter(Boolean)];
    if (paths.some(path => matchesPolicy(this.d.cwd, path, this.d.piiPaths ?? [], true))) {
      if (!signals.includes("pii")) signals.push("pii");
      signals.push("pii_path");
    }
    return signals;
  }

  /** `signals.pii_screen = "local"` where the PII constraint applies (issue #198); on without a screener, every verdict is unknown. */
  screenOn = (): boolean => {
    const r = this.d.routing();
    return r.signals.pii_screen === "local" && r.constraints.pii === "local_only";
  };

  /** One bounded screen call. A screener that fails is no verdict, handled as PII (fail closed). */
  private requestCheck(by: PeerId, fence?: () => string | undefined): () => void {
    requireLocalTaskPeer(by);
    const authority = this.d.requestAuthority?.(by);
    const check = () => { const reason = authority?.() ?? fence?.(); if (reason) throw new PreEffectToolRefusal(reason); };
    check(); return check;
  }

  private async screenCall(text: string): Promise<PiiVerdict> {
    return (await this.d.piiScreen?.(text).catch(() => undefined)) ?? { label: "unknown", miss: "failed", ms: 0 };
  }

  private recordScreen(task: number | undefined, item: ScreenItem, v: PiiVerdict | undefined, inherited = false): void {
    const record: ScreenRecord = inherited ? { item, label: "pii", source: "inherited" } : !v
      ? { item, label: "pii", source: "regex" }
      : { item, label: v.label === "clear" ? "clear" : "pii", source: v.label === "unknown" ? "unknown" : "screen", ...(v.category ? { category: v.category } : {}), ...(v.miss ? { miss: v.miss } : {}), ms: v.ms };
    try {
      this.d.recordScreen?.({ ...(task === undefined ? {} : { task }), ...record });
    } catch { /* telemetry only */ }
  }

  /**
   * Whether the model screen withholds free text about an ordinary task (issue #198): it is on and its verdict is not
   * `clear`. Text that matches a pattern needs no call (the #69 checks withhold it; only the record says so), and a PII
   * task's text is private. Tool callers are models: anything but a string is not screened, so `off` stays as it was.
   */
  private async withholds(item: ScreenItem, text: unknown, task?: Task): Promise<boolean> {
    if (typeof text !== "string" || !text.trim() || !this.screenOn() || (task && this.isPii(task))) return false;
    if (!this.nameable(text)) return (this.recordScreen(task?.id, item, undefined), false);
    const v = await this.screenCall(text);
    this.recordScreen(task?.id, item, v);
    return v.label !== "clear";
  }

  /** Why free text is withheld: the pattern check first, as #69 words it. */
  private whyWithheld = (text: string) => (this.nameable(text) ? "the PII screen did not clear it" : "it matches a PII pattern");

  /** Task-owned, default-off between-turn ladder. Persist before sending so restart cannot repeat a step. */
  async sweep(now = Date.now()): Promise<{ task: number; finding: SweepRecord }[]> {
    const recorded: { task: number; finding: SweepRecord }[] = [];
    const config = this.sweepConfig;
    if (!config.enabled || this.sweeping || this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) return recorded;
    this.sweeping = true;
    try {
      for (const task of this.d.board.list()) {
        if (this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) break;
        if (!task.owner && this.personUnassigned(task)) continue;
        const finding = nextSweep(task, config, now, this.waitsFor(task).length === 0);
        if (!finding || this.waitsFor(task).length || this.isChecking(task.id) || this.silentFor(task.id)) continue;
        if (finding.kind === "ready-unassigned") {
          this.d.board.update(task.id, HUB, "idle sweep", {}, undefined, { sweep: finding });
          recorded.push({ task: task.id, finding });
          const planners = this.taskPlanner(task).filter(peer => this.d.bus.isRostered(peer));
          const text = `Task #${task.id}: ready-unassigned, idle escalation ${finding.step}/3.`;
          if (finding.step === 1 || finding.step === 2) {
            if (finding.step === 2 || !planners.length) this.releaseNotice(text);
            for (const peer of planners) this.releaseNotice(`task #${task.id}: sweep notice unavailable`, () => this.sweepNotice(task, peer, `${text} Check the board and assign, re-plan or cancel it.`, "planner"));
          } else {
            const admission = this.plannerPullRecord(task)?.pull ? this.plannerAssignment(task, true) : assign(task, this.states(), this.d.routing(), { exclude: this.excluded(task), ...this.weights(task.class, task) });
            this.releaseNotice(`${text} Owner reassignment suggestion: ${admission.owner ?? "no eligible peer"}.`);
            if (admission.owner && config.auto_reassign && this.sweepAvailable(admission.owner) && !this.reservedHold(task)) {
              try { await this.assignOwner(this.d.board.get(task.id)!, HUB, { candidates: [admission.owner], event: "reassigned", reason: "idle", note: "ready-unassigned idle sweep" }); }
              catch (e) { if (!(e instanceof AssignmentUndeliveredError)) throw e; }
            }
          }
          continue;
        }
        const responsible = finding.kind === "review-pending" ? task.reviewer! : task.owner!;
        if (responsible !== USER && !this.sweepAvailable(responsible)) continue;
        if (finding.step === 3 && finding.kind !== "review-pending" && config.auto_reassign && this.plannerPullRecord(task)?.pull && !assign(task, this.states(), this.d.routing(), { exclude: [...this.excluded(task), responsible], excludeOwners: this.plannerFull(task), waitsFor: this.waitsFor(task), ...this.weights(task.class, task) }).owner) continue;
        const title = this.publicTitle(task);
        const message = `Task ${title}: ${finding.kind}, idle escalation ${finding.step}/3.`;
        // Only identifiers, kind and step are kept in the ladder event. A crash after this write and before publish
        // leaves the notice unpublished or uncertain; the durable-delivery journal owns any delivery retries.
        this.d.board.update(task.id, HUB, "idle sweep", {}, undefined, { sweep: finding });
        recorded.push({ task: task.id, finding });
        if (finding.step === 1) {
          this.sweepNotice(task, responsible, `${message} Check its current state with hub_task_list and accept, complete or review your assigned work.`, finding.kind === "review-pending" ? "reviewer" : "owner");
        } else if (finding.step === 2) {
          this.d.notify(message);
          for (const peer of this.taskPlanner(task)) {
            if (peer !== responsible && this.sweepAvailable(peer)) this.sweepNotice(task, peer, `${message} The assigned ${finding.kind === "review-pending" ? "reviewer" : "owner"} has not recorded fresh task activity; check the board before coordinating.`, "planner");
          }
        } else {
          const reviewer = finding.kind === "review-pending";
          const a = assign(task, this.states(), this.d.routing(), { exclude: [...this.excluded(task), responsible], excludeOwners: finding.kind !== "review-pending" && this.plannerPullRecord(task)?.pull ? this.plannerFull(task) : [], waitsFor: this.waitsFor(task), ...(reviewer ? { candidates: [], notReviewer: task.owner ?? undefined } : {}), ...this.weights(task.class, task) });
          const candidate = reviewer ? a.reviewer : a.owner;
          this.passedOver(task, a);
          this.d.notify(`${message} ${reviewer ? "Reviewer" : "Owner"} reassignment suggestion: ${candidate ?? "no eligible peer"}.`);
          if (!reviewer && candidate && config.auto_reassign && this.sweepAvailable(candidate)) {
            try {
              await this.assignOwner(this.d.board.get(task.id)!, HUB, { candidates: [candidate], exclude: [responsible], event: "reassigned", reason: "idle", note: `idle sweep: ${finding.kind}; from ${responsible}` });
            } catch (e) {
              // A saved move whose delivery failed: the console notice was printed where the error was thrown, and
              // the sweep goes on (#297).
              if (!(e instanceof AssignmentUndeliveredError)) throw e;
            }
          }
        }
      }
    } finally { this.sweeping = false; }
    return recorded;
  }

  /** A validated snapshot takes effect on the next sweep, never halfway through one. */
  configureSweep(config: TaskSweepConfig): void {
    this.sweepConfig = taskSweepConfig(config);
    if (this.sweepConfig.no_writes_turns === 0) {
      this.noWriteTurns.retain([]);
      for (const stall of this.d.board.stalls()) if (stall.cause.kind === "no-writes") this.d.board.clearStall(stall.task);
    }
  }

  private ownerAcceptance(task: Task, first = false): { index: number; at: number } | undefined {
    if (!task.owner) return undefined;
    const boundary = task.history.findLastIndex(entry => OWNERSHIP_EVENTS.has(entry.event) || entry.owner !== undefined && entry.owner !== task.owner);
    const accepted = (entry: Task["history"][number], index: number) => index > boundary && entry.event === "accepted" && (entry.by === task.owner || entry.by === USER);
    const index = first ? task.history.findIndex(accepted) : task.history.findLastIndex(accepted);
    return index > boundary && index >= 0 ? { index, at: task.history[index]!.at } : undefined;
  }

  /** Captured at native turn start, not supplied by a model. */
  ownerTurnTasks(peer: PeerId): { id: number; acceptance: number }[] {
    requireLocalTaskPeer(peer);
    return this.d.board.list("in_progress").flatMap(task => {
      const accepted = task.owner === peer && ["implement", "bulk_edit"].includes(task.class) ? this.ownerAcceptance(task) : undefined;
      return accepted ? [{ id: task.id, acceptance: accepted.index }] : [];
    });
  }

  /** Host-only audit: no tool accepts this record and no task state or notification changes. */
  recordInvocation(id: number, row: InvocationRow): void {
    const task = this.d.board.get(id);
    if (!task) throw new Error("invocation audit task is unavailable");
    if (row.task !== id) throw new Error("invocation audit task mismatch");
    if (row.outcome === "queued" && (this.isPii(task) || this.d.privateTurn?.(row.caller) || isClosedTaskState(task.state) || task.state === "backlog" || task.owner !== row.caller && task.reviewer !== row.caller)) throw new Error("invocation audit task scope changed");
    if (task.history.some(entry => entry.invocation?.id === row.id && entry.invocation.outcome === row.outcome)) return;
    const { id: invocationId, caller, target, capability, digest, class: sideEffect, approval, argsSha256, outcome } = row;
    this.d.board.update(id, HUB, "invocation", {}, undefined, { invocation: { id: invocationId, caller, target, capability, digest, class: sideEffect, approval, argsSha256, outcome } });
  }

  recordOwnerTurn(peer: PeerId, bindings: readonly { id: number; acceptance: number }[], changed: boolean | undefined, effect: boolean): void {
    requireLocalTaskPeer(peer);
    this.noWriteTurns.retain(this.d.board.list("in_progress").filter(task => ["implement", "bulk_edit"].includes(task.class)).map(task => task.id));
    const current = new Map(this.ownerTurnTasks(peer).map(binding => [binding.id, binding.acceptance]));
    for (const binding of bindings) {
      if (current.get(binding.id) !== binding.acceptance) continue;
      const task = this.d.board.get(binding.id)!;
      const limit = this.sweepConfig.no_writes_turns ?? 2;
      if (changed !== false || effect || limit === 0) {
        if (this.d.board.stalls().some(stall => stall.task === task.id && stall.cause.kind === "no-writes")) this.d.board.clearStall(task.id);
      }
      const count = this.noWriteTurns.observe({ task: task.id, generation: `${task.created}:${peer}:${binding.acceptance}`, limit, changed, effect });
      if (count === undefined) continue;
      this.reportStall(task, { kind: "no-writes", code: "no-writes", peer, turns: count, acceptance: binding.acceptance }, Date.now(),
        `Task ${this.publicTitle(task)} stalled: ${count} consecutive owner turns with no writes or task tool effects recorded.`);
    }
  }

  private captureOwnerAcceptance(task: Task): void {
    try { this.d.ownerAccepted?.(task); } catch { /* advisory capture cannot fail a saved acceptance */ }
  }

  /** Host evidence spans the first acceptance after the latest ownership change, including plan revisions. */
  ownerWriteAcceptance(task: Task): { index: number; at: number } | undefined { return this.ownerAcceptance(task, true); }

  private noWritesRecorded(task: Task): boolean {
    if (!["implement", "bulk_edit"].includes(task.class) || task.refs.branch || this.reviewHead(task) || task.sdlc?.pr) return false;
    const accepted = this.ownerWriteAcceptance(task);
    if (!accepted) return false;
    try { return this.d.ownerWrites?.(task, accepted.at) === false; } catch { return false; }
  }

  private sweepAvailable(peer: PeerId): boolean {
    const bus = this.d.bus;
    return bus.stateOf(peer) === "idle" && (this.d.idle?.(peer) ?? true) && !peerEntry(this.d.held?.(), peer) && !bus.queueSummary(peer).heldBy && !bus.queued(peer) && !bus.hasInFlight(peer);
  }

  private sweepNotice(task: Task, peer: PeerId, body: string, taskRecipient: "owner" | "reviewer" | "planner"): void {
    if (peer === USER) this.d.notify(body);
    else this.d.bus.publish(newEnvelope(HUB, body, { to: [peer], kind: "task", refs: { task: String(task.id), taskRecipient } }));
  }

  configureExecutionBudget = (config: ExecutionBudgetConfig): ExecutionBudgetStatus | undefined => {
    if (!this.d.executionBudget) return undefined;
    if (config.kind === "task" && (!config.taskId || !this.d.board.get(config.taskId))) throw new Error(`task #${config.taskId ?? "?"} does not exist`);
    return this.d.executionBudget.configure(config);
  };
  disableExecutionBudget = (id: string): boolean => this.d.executionBudget?.disable(id) ?? false;
  executionBudgetStatus = (id?: string): ExecutionBudgetStatus | ExecutionBudgetStatus[] | undefined => this.d.executionBudget?.status(id);
  /** Charge only budgets matching the task actually delivered to this peer, plus active run budgets. */
  admitExecution = (taskId: number | undefined, peer: PeerId, unit: ExecutionUnit, amount = 1): ExecutionBudgetDecision[] => this.d.executionBudget?.admitTask(taskId, peer, unit, amount) ?? [];
  /** A digest may include several tasks. Charge each matching task budget and each run budget once, atomically. */
  admitExecutionEnvelopes = (envs: Envelope[], peer: PeerId, unit: ExecutionUnit, amount = 1): ExecutionBudgetDecision[] =>
    this.d.executionBudget?.admitTasks(this.budgetTaskIds(envs), peer, unit, amount) ?? [];

  /** Whether an execution budget meters this peer's work on these envelopes; admits nothing. */
  budgetApplies = (envs: Envelope[], peer: PeerId): boolean => this.d.executionBudget?.applies(this.budgetTaskIds(envs), peer) ?? false;

  private budgetTaskIds(envs: Envelope[]): number[] {
    return [...new Set(envs.flatMap((e) => {
      const value = e.refs?.task;
      const id = typeof value === "string" ? Number(value) : NaN;
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    }))];
  }

  /** What peers other than the owner, the console stream and the log may see of a task. */
  publicTitle = (task: Task) => (this.isPii(task) ? `#${task.id} [pii]` : `#${task.id} ${task.title}`);

  private reviewFindingSets(task: Task): ReviewFindingSet[] { return task.history.flatMap(entry => entry.reviewFindings ? [entry.reviewFindings] : []); }

  private findingHead(task: Task, reviewedHead?: string): string | undefined {
    return resolveFindingHead(task.sdlc, reviewedHead ? { head: reviewedHead } : undefined, task.refs.commit);
  }

  private findingTextAllowed(task: Task, items: readonly ReviewFinding[]): boolean {
    return this.candidateTextAllowed(JSON.stringify(items), task)
      && items.every(item => !item.path || !matchesPolicy(this.d.cwd, item.path, this.d.piiPaths ?? [], true));
  }

  /** Host-authored proposals contain only cleared IDs, integer task references and fixed instruction targets. */
  /**
   * #736: how many separate pieces of work the tasks are. Tasks that share a PR, a branch in one repository, or a
   * supersession (a cancelled task names its replacement) are one piece of work, as an approve-as-step follow-up is: a
   * finding carried between them is the same finding, not a recurrence.
   */
  private workUnits(rows: readonly Task[]): number {
    const parent = new Map<number, number>();
    const find = (id: number): number => { let at = id; while (parent.has(at)) at = parent.get(at)!; return at; };
    const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
    const first = new Map<string, number>(), ids = new Set(rows.map(row => row.id));
    for (const row of rows) {
      // Repository identity comes from the board's own resolver, so aliases match and an outside path never falls back to this project.
      const prRepo = row.sdlc?.pr ? this.repositories.scope(row.sdlc.repo ? { repo: row.sdlc.repo, paths: row.refs.paths } : row.refs).key : "";
      const branchRepo = row.refs.branch ? this.repositories.scope(row.refs).key : "";
      for (const key of [prRepo ? `pr ${prRepo}#${row.sdlc!.pr}` : "", branchRepo ? `branch ${branchRepo} ${row.refs.branch}` : ""]) {
        if (!key) continue;
        const seen = first.get(key);
        if (seen === undefined) first.set(key, row.id); else join(row.id, seen);
      }
      // superseded_by is free text ("task #73", "#73" or "73"); the first task number in it names the replacement.
      const next = Number(/#?(\d+)/.exec(row.cancelled?.supersededBy ?? "")?.[1]);
      if (ids.has(next)) join(row.id, next);
    }
    return new Set(rows.map(row => find(row.id))).size;
  }
  /**
   * #514b: the person's view of the recurring-criterion candidates (`ahub learn list`). The person only: a conductor or an agent gets a refusal, never a list. A card that does not parse as the
   * hub's own is not listed. Ids, counts and the key parts only: the card's text is never echoed, and a PII row is never reached because the cards are already screened when filed.
   */
  learnCandidates(by: PeerId, opts: { all?: boolean } = {}): Record<string, unknown>[] {
    if (by !== USER) throw new PreEffectToolRefusal("ahub learn is a person's command");
    const rows: Record<string, unknown>[] = [];
    for (const card of this.d.board.list()) {
      const parsed = parseCandidateCard(card);
      if ("refused" in parsed) continue;
      const open = card.state === "backlog" || card.state === "proposed";
      const closed = card.history.findLast(entry => entry.event === "cancelled");
      const verdict = learnVerdict(card) ?? (closed ? "closed" : undefined);
      if (!open && !opts.all) continue;
      if (!open && !closed) continue;
      rows.push({ id: card.id, state: card.state, ...parsed, status: open ? "open" : verdict, tasks: this.learnEvidence(parsed).tasks, line: overridesDiff({ ...parsed, tasks: this.learnEvidence(parsed).tasks }).profile_overrides.review_checklist[0] });
    }
    return rows;
  }
  /** The distinct tasks that name this criterion unmet on this profile and class in the window, from the board as it is now: the count the written line states is recomputed, never read from the card. */
  private learnEvidence(card: { profile: string; class: string; criterion: string }): { tasks: number[] } {
    const eligible = this.d.board.list().filter(row => this.candidateTextAllowed(`${row.profile ?? ""} ${row.profileClass ?? ""} ${row.class}`, row));
    const group = groupUnmetCriteria(eligible, { windowMs: LEARNING_DEFAULTS.windowMs, now: Date.now() }).find(g => g.profile === card.profile && g.class === card.class && g.criterion === card.criterion);
    return { tasks: group?.tasks ?? [] };
  }
  /**
   * #514b: what `ahub learn accept` would write for card `id`, or why not. Person only. It reads ONLY the card's key line (`parseCandidateCard`), requires the card to be open, and builds the
   * line from the board's own evidence with `overridesDiff`: nothing of the card's text is parsed as a value. The daemon adds the line to the stored checklist and writes it through the settings path.
   */
  learnAcceptPlan(by: PeerId, id: unknown): { id: number; profile: string; class: string; criterion: string; line: string; tasks: number } {
    if (by !== USER) throw new PreEffectToolRefusal("ahub learn accept is a person's command");
    const card = this.learnCard(id);
    const evidence = this.learnEvidence(card);
    if (!evidence.tasks.length) throw new PreEffectToolRefusal(`no task in the window still names ${card.criterion} unmet on ${card.profile}/${card.class}: nothing to accept; reject the card to close it`);
    const line = overridesDiff({ ...card, tasks: evidence.tasks }).profile_overrides.review_checklist[0]!;
    return { id: card.id, profile: card.profile, class: card.class, criterion: card.criterion, line, tasks: evidence.tasks.length };
  }
  /**
   * #514b: whether `ahub learn accept` already decided this card. Person only. A card the person accepted answers `"accepted"`, so a repeat accept is a no-write success (the plan's idempotency);
   * a rejected card, a card closed some other way and an open one answer undefined and take the normal path, which refuses the closed ones.
   */
  learnAccepted(by: PeerId, id: unknown): { id: number; profile: string; class: string; criterion: string } | undefined {
    if (by !== USER) throw new PreEffectToolRefusal("ahub learn accept is a person's command");
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
    const task = this.d.board.get(id);
    if (!task || learnVerdict(task) !== "accepted") return undefined;
    const parsed = parseCandidateCard(task);
    return "refused" in parsed ? undefined : { id, ...parsed };
  }
  /** The card, which must be an open candidate the hub filed. */
  private learnCard(id: unknown): { id: number; profile: string; class: string; criterion: string } {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new PreEffectToolRefusal("id must be a positive task number");
    const task = this.d.board.get(id);
    if (!task) throw new PreEffectToolRefusal(`no task #${id}`);
    const parsed = parseCandidateCard(task);
    if ("refused" in parsed) throw new PreEffectToolRefusal(`task #${id}: ${parsed.refused}`);
    if (task.state !== "backlog" && task.state !== "proposed") throw new PreEffectToolRefusal(`task #${id} is already ${task.state === "cancelled" ? "closed" : task.state}`);
    return { id, ...parsed };
  }
  /**
   * #514b: closes a candidate card after the person's verdict, through `cancel` (never a direct board write): the row stays, the verdict is in its history, and because the dedupe key is the card's
   * detail the same criterion is never filed again. `accepted` is recorded only after the write succeeded (the daemon calls this last); a repeat of either verdict is refused by `learnCard`.
   */
  async learnClose(by: PeerId, id: unknown, verdict: "accepted" | "rejected"): Promise<Task> {
    if (by !== USER) throw new PreEffectToolRefusal("ahub learn is a person's command");
    const card = this.learnCard(id);
    return this.cancel(card.id, USER, { reason: verdict === "accepted" ? `${LEARN_ACCEPTED} by the person: its review checklist line was written to config.local.json` : `${LEARN_REJECTED} by the person` });
  }
  /**
   * #514a: the same recurrence path for recurring UNMET CRITERIA. A criterion id that reviews keep naming unmet on the same profile and class, on at least
   * `threshold` tasks that are at least two separate pieces of work (`workUnits`), files one backlog card for a person to review, with the `profile_overrides`
   * fragment as text. Nothing is applied. A PII task and a withheld or private-turn review are never evidence and never named; the card carries ids and counts only.
   */
  private proposeCriterionCandidates(task: Task, by: PeerId, withheld: boolean): void {
    if (withheld || this.isPii(task) || this.d.privateTurn?.(by) || !task.history.at(-1)?.unmetCriteria?.length) return;
    const rows = this.d.board.list();
    const keys = new Set(rows.filter(row => row.class === "plan" && row.history[0]?.by === HUB)
      .flatMap(row => row.detail?.split("\n").filter(line => line.startsWith("Criterion candidate key: ")) ?? []));
    // Only the rows that may count: candidateTextAllowed refuses a PII row and one whose text the screen refuses, so those are evidence of nothing.
    const eligible = rows.filter(row => this.candidateTextAllowed(`${row.profile ?? ""} ${row.profileClass ?? ""} ${row.class}`, row));
    const named = new Set(task.history.at(-1)!.unmetCriteria);
    const created: number[] = [];
    // No await separates the durable dedupe read from creation; concurrent verdicts see the first card.
    const groups = groupUnmetCriteria(eligible, { windowMs: LEARNING_DEFAULTS.windowMs, now: Date.now() });
    const unitsOf = (group: CriterionGroup) => this.workUnits(eligible.filter(row => group.tasks.includes(row.id)));
    for (const group of selectGroups(groups, { named, threshold: LEARNING_DEFAULTS.threshold, max: LEARNING_DEFAULTS.maxGroups, has: g => keys.has(criterionKey(g)), units: unitsOf })) {
      const card = candidateCard(group, Math.round(LEARNING_DEFAULTS.windowMs / 86_400_000), unitsOf(group));
      const draft = { title: card.title, detail: card.detail, refs: { paths: ["docs/profiles.md"] } };
      const signals = this.signalsFor(draft);
      if (this.isPii({ signals }) || !this.candidateTextAllowed(`${card.title}\n${card.detail}`)) continue;
      const proposal = this.d.board.propose(HUB, { ...draft, class: "plan", backlog: true, signals });
      this.incomingBacklog.add(proposal.id); keys.add(criterionKey(group)); created.push(proposal.id);
    }
    for (const id of created) this.releaseNotice(`task #${id}: recurring unmet criterion candidate proposed in the backlog`);
  }
  private proposeRecurringFindings(task: Task, by: PeerId, items: readonly ReviewFinding[], withheld: boolean): void {
    if (withheld || this.isPii(task) || this.d.privateTurn?.(by) || !items.length || !this.findingTextAllowed(task, items)) return;
    const rows = this.d.board.list();
    const keys = new Set(rows.filter(row => row.class === "plan" && row.history[0]?.by === HUB)
      .flatMap(row => row.detail?.split("\n").filter(line => line.startsWith("Review finding key: ")) ?? []));
    const created: number[] = [];
    // No await separates the durable dedupe read from creation; concurrent verdicts see the first proposal.
    for (const item of items.filter(item => item.disposition !== "false_positive")) {
      const same = (finding: ReviewFinding) => finding.id === item.id && finding.pass === item.pass;
      const holders = rows.filter(row => {
        if (this.isPii(row)) return false;
        const last = row.history.findLast(entry => entry.reviewFindings?.items.some(value => value.id === item.id));
        const finding = last?.reviewFindings?.items.find(value => value.id === item.id);
        // #328: a follow-up that only records an earlier task's finding as fixed never had it; it counts once seen open.
        // By id alone: a reclassified finding keeps its id (task note); a withheld review is never evidence.
        const occurred = row.history.some(entry => !entry.withheld && entry.reviewFindings?.items.some(value => value.id === item.id && (value.disposition === "open" || value.disposition === "accepted")));
        return !last?.withheld && finding && same(finding) && occurred && finding.disposition !== "false_positive" && this.findingTextAllowed(row, [finding]);
      });
      if (this.workUnits(holders) < 2) continue;
      const key = `Review finding key: ${item.pass}:${item.id}`;
      if (keys.has(key)) continue;
      const title = `Review policy amendment for recurring finding ${item.pass}:${item.id}`;
      const detail = `${key}\nFinding ${item.pass}:${item.id} recurred on tasks ${holders.slice(0, 8).map(row => `#${row.id}`).join(", ")}. Inspect their review histories and propose an AGENTS.md or relevant docs/agent-notes/ amendment. This backlog card is a proposal, not authorization to edit instruction files.`;
      const draft = { title, detail, refs: { paths: ["AGENTS.md", "docs/agent-notes/"] } };
      const signals = this.signalsFor(draft);
      if (this.isPii({ signals }) || !this.candidateTextAllowed(`${title}\n${detail}`)) continue;
      const proposal = this.d.board.propose(HUB, { ...draft, class: "plan", backlog: true, signals });
      this.incomingBacklog.add(proposal.id); keys.add(key); created.push(proposal.id);
    }
    for (const id of created) this.releaseNotice(`task #${id}: recurring review finding amendment proposed in the backlog`);
  }

  /** A task as a cloud peer may see it. */

  publicView(task: Task, fullHistory = false): Record<string, unknown> {
    const { title, detail, history, external, cancelled, codeSymbols, ...taskRest } = task;
    const plannerBinding = history.findLast(h => h.planner === task.planner && h.plannerReason !== undefined);
    const ownerBinding = history.findLast(h => h.owner === task.owner && ["assigned", "reassigned", "escalated", "backlog pulled"].includes(h.event));
    const reviewerBinding = history.findLast(h => ["assigned", "reassigned", "escalated", "done", "reviewer changed", "reviewer unavailable"].includes(h.event));
    const rest = { ...taskRest,
      ...(plannerBinding?.plannerReason && ["rotation", "named", "kept", "none"].includes(plannerBinding.plannerReason) ? { plannerReason: plannerBinding.plannerReason } : {}),
      ...(ownerBinding?.reason && TASK_MOVE_REASONS.includes(ownerBinding.reason) ? { ownerReason: ownerBinding.reason === "manual" && ownerBinding.event === "reassigned" && ownerBinding.by !== HUB ? "named" : ownerBinding.reason } : {}),
      ...(reviewerBinding?.reviewerReason && ["rotation", "implementer skip", "unavailable skip", "same-family fallback"].includes(reviewerBinding.reviewerReason) ? { reviewerReason: reviewerBinding.reviewerReason } : reviewerBinding?.event === "reviewer changed" && reviewerBinding.reason === "manual" ? { reviewerReason: "named" } : {}),
      ...(history.some(h => h.by === USER && h.planDeparture) ? { planDepartureAccepted: true } : {}) };
    if (this.isPii(task)) return { ...rest, actualDates: actualTaskDates(task), refs: {}, plan: {}, ...(task.sdlc ? { sdlc: { stage: stageDefinition(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc.stage)?.base ?? "unknown" } } : {}), title: "[pii]", detail: "[pii]" };
    if (rest.sdlc?.redFirst && !this.publicMetadataText(JSON.stringify(rest.sdlc.redFirst))) {
      const { redFirst: _withheld, ...receipt } = rest.sdlc; rest.sdlc = receipt;
    }
    const screenHistoryText = (text: string, field: string, withheld = false): string => !withheld && this.nameable(text) ? text : `[history ${field} withheld: ${this.whyWithheld(text)}; ahub task show ${task.id}]`;
    const publicHistory = (fullHistory ? history : history.slice(-5)).map(h => ({
      at: h.at, by: h.by, event: h.event,
      ...(h.note === undefined ? {} : { note: screenHistoryText(h.note, "note", h.withheld) }),
      ...(h.reviewFindings ? { reviewFindings: !h.withheld && this.findingTextAllowed(task, h.reviewFindings.items) ? h.reviewFindings
        : { ...(h.reviewFindings.head ? { head: h.reviewFindings.head } : {}), tally: findingTally(h.reviewFindings.items), withheld: true } } : {}),
      ...(h.supersededBy === undefined ? {} : { supersededBy: screenHistoryText(h.supersededBy, "supersession", h.withheld) }),
      ...(h.invocation ? { invocation: h.invocation } : {}),
      ...(h.profile === undefined ? {} : { profile: screenHistoryText(h.profile, "profile") }),
      ...(h.owner === undefined ? {} : { owner: h.owner }),
      ...(h.planner === undefined ? {} : { planner: h.planner }),
      ...(h.plannerReason ? { plannerReason: h.plannerReason } : {}),
      ...(h.planAuthor === undefined ? {} : { planAuthor: h.planAuthor }),
      ...(h.selfReview ? { selfReview: true } : {}),
      ...(h.reviewerFamily ? { reviewerFamily: screenHistoryText(h.reviewerFamily, "reviewer family") } : {}),
      ...(h.reviewerReason ? { reviewerReason: h.reviewerReason } : {}),
      ...(h.reviewScope === "code" ? { reviewScope: "code" as const } : {}),
      ...(h.evidenceOnly ? { evidenceOnly: true as const } : {}),
      ...(h.unmetCriteria?.length ? { unmetCriteria: h.unmetCriteria } : {}),
      ...(h.deliverables?.length ? { deliverables: publicDeliverables(h.deliverables, this.nameable) } : {}),
      ...(h.reviewBlocked ? { reviewBlocked: true } : {}),
      ...(h.queueReviewHeld ? { queueReviewHeld: true } : {}),
      ...(h.reviewerFailure ? { reviewerFailure: { peer: screenHistoryText(h.reviewerFailure.peer, "reviewer"), cause: h.reviewerFailure.cause, ...(h.reviewerFailure.head ? { head: screenHistoryText(h.reviewerFailure.head, "review head") } : {}) } } : {}),
      ...(h.planning ? { planning: { revision: h.planning.revision, fields: h.planning.fields, ...(h.planning.split ? { children: h.planning.split.children.map(child => child.id) } : {}) } } : {}),
      ...(h.reason && TASK_MOVE_REASONS.includes(h.reason) ? { reason: h.reason } : {}),
      ...(h.sweep ? { sweep: { kind: h.sweep.kind, activity: h.sweep.activity, step: h.sweep.step, at: h.sweep.at } } : {}),
    }));
    const sets = this.reviewFindingSets(task), current = findingsForHead(sets, this.findingHead(task));
    const symbolRepository = codeSymbols && this.codeSymbolsRepository(task);
    const publicSymbols = codeSymbols && symbolRepository ? publicTaskCodeSymbols(codeSymbols, this.reviewHead(task), symbolRepository.key, this.publicMetadataText) : undefined;
    const handedOff = this.d.board.handoffOrigin(task.id);   // #604: where another project's handoff came from; two ids, never text
    return { ...rest, ...(handedOff ? { handoffOrigin: { projectId: handedOff.projectId, peer: handedOff.peer, ...(handedOff.originTask === null ? {} : { task: handedOff.originTask }) } } : {}), ...(publicSymbols ? { codeSymbols: publicSymbols } : {}), ...(current.length ? { findings: findingTally(current) } : {}), ...(cancelled ? { cancelled: { ...cancelled, reason: screenHistoryText(cancelled.reason, "cancellation", cancelled.withheld), ...(cancelled.supersededBy ? { supersededBy: screenHistoryText(cancelled.supersededBy, "supersession", cancelled.withheld) } : {}) } } : {}), ...(external && this.nameable(external.url) ? { external } : {}), actualDates: actualTaskDates(task), ...(((this.d.sdlc?.config().mode ?? "off") !== "off" || this.d.sdlc?.config().workflow === "gsd-lite") ? { lifecycle: sdlcStatus(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc, undefined, this.workflowView(task), undefined, sets, task.refs.commit) } : {}), title, detail, history: publicHistory };
  }

  /** Console results expose direct approval and delivery holds, not just the chosen peer ids. */
  resultLine(task: Task): string {
    const base = `task #${task.id}: ${task.state}, owner ${task.owner ?? "none"}, reviewer ${task.reviewer ?? "none"}`;
    const noReview = task.class !== "review" && !task.reviewer && OPEN.includes(task.state) && !this.waitsFor(task).length
      ? this.noReviewer(assign(task, this.states(), this.d.routing(), { candidates: task.owner ? [task.owner] : [], notReviewer: task.owner ?? undefined, ...this.weights(task.class, task) }))
      : undefined;
    const held = task.owner ? peerEntry(this.d.held?.(), task.owner) : undefined;
    const holdText = held ? `${task.owner}'s queue is held (${held}); it receives the task once the hold is resolved` : undefined;
    const request = task.history.findLast(entry => ["done", "reviewer changed", "reviewer unavailable"].includes(entry.event));
    const poolBlocked = task.state === "in_review" && task.reviewer === USER && request?.reviewBlocked ? "blocked: no reviewer can run" : undefined;
    return [base, noReview, poolBlocked, holdText].filter(Boolean).join("; ");
  }

  private states(): Record<PeerId, PeerState> {
    return Object.fromEntries([...this.d.bus.peers.keys()].map((id) => [id, this.d.bus.stateOf(id)]));
  }

  /** Dependencies of a task that are not approved yet: while there are any, it is offered to nobody (issue #34). */
  waitsFor = (task: Pick<Task, "deps">): number[] => (task.deps ?? []).filter((id) => this.d.board.get(id)?.state !== "approved");

  /** Decayed failure weights of the peers demoted for a class: failures count half after a day (issue #36). */
  demoted(cls: TaskClass, now = Date.now()): Record<PeerId, number> {
    const sums = new Map<PeerId, { bad: number; good: number }>();
    const halfLifeH = this.d.demotionHalfLifeH?.(), halfLifeMs = halfLifeH === undefined ? DEMOTION_HALF_LIFE_MS : halfLifeH * 3_600_000, demoteAt = this.d.demoteAt?.() ?? DEMOTE_AT;
    for (const o of this.d.board.outcomes(cls, now - OUTCOMES_KEPT_MS)) {
      const w = 0.5 ** ((now - o.at) / halfLifeMs);
      const s = sums.get(o.peer) ?? { bad: 0, good: 0 };
      if (o.ok) s.good += w;
      else s.bad += w;
      sums.set(o.peer, s);
    }
    return Object.fromEntries([...sums].filter(([, s]) => s.bad >= demoteAt && s.bad > s.good).map(([p, s]) => [p, s.bad]));
  }

  /** How each reviewer's reviews of each implementer's work in a class held up (issue #35). */
  reviewRecord(cls: TaskClass): Record<PeerId, Record<PeerId, { score: number; n: number }>> {
    // Counted per task: a review that asked for changes and then approved is one review, not two.
    const c = new Map<string, { reviewed: Set<number>; contradicted: Set<number> }>();
    for (const r of this.d.board.reviews({ class: cls })) {
      const key = `${r.implementer}\0${r.reviewer}`;
      const s = c.get(key) ?? { reviewed: new Set<number>(), contradicted: new Set<number>() };
      (r.kind === "contradicted" ? s.contradicted : s.reviewed).add(r.task);
      c.set(key, s);
    }
    const out: Record<PeerId, Record<PeerId, { score: number; n: number }>> = {};
    for (const [key, s] of c) {
      const [implementer, reviewer] = key.split("\0") as [PeerId, PeerId];
      const n = s.reviewed.size;
      if (n) (out[implementer] ??= {})[reviewer] = { score: (n - [...s.contradicted].filter((t) => s.reviewed.has(t)).length) / n, n };
    }
    return out;
  }

  /** Who asked for changes on the current owner's work: requests made before the task changed hands were about someone else's. */
  private requestedChanges(task: Task): Set<PeerId> {
    // The window starts where the owner last changed. Newer entries carry the owner, so handing a task to the owner it
    // already had (`ahub task assign <id> <owner>`) keeps the window; older ones do not, and any of them starts it.
    let since = -1;
    let owner: PeerId | null | undefined = null;
    task.history.forEach((h, i) => {
      if (!OWNERSHIP_EVENTS.has(h.event)) return;
      if (h.owner === undefined || h.owner !== owner) since = i;
      owner = h.owner;
    });
    return new Set(task.history.slice(since + 1).filter((h) => h.event === "changes_requested" && h.evidenceOnly !== true).map((h) => h.by));
  }

  /** Workload is board/queue data only: wip() never calls health() or weights(). */
  private instanceRouting(ownerIsolation?: Readonly<Record<string, boolean>>): InstanceRoutingOptions {
    const instances = this.d.instances?.();
    if (!instances || !Object.keys(instances).length) return { adapterCatalog: this.d.adapterCatalog };
    const peers = [...new Set([...(this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind), ...Object.keys(instances), ...this.d.bus.peers.keys()])];
    return { adapterCatalog: this.d.adapterCatalog, instances, ownerIsolation: ownerIsolation ?? this.d.ownerIsolation?.() ?? {}, wip: Object.fromEntries(peers.map(peer => [peer, this.wip(peer)])), load: Object.fromEntries(peers.map(peer => [peer, this.d.bus.queued(peer)])) };
  }

  private queuePolicy(): QueueBackpressurePolicy | undefined {
    const policy = queueBackpressurePolicy(this.d.queueBackpressure?.());
    return policy.max_queued > 0 || policy.max_oldest_s > 0 ? policy : undefined;
  }

  /** Admission is pending metadata only; an unavailable read never invents an empty/fresh queue. */
  private queueRouting(peers: readonly PeerId[], policy = this.queuePolicy()): Pick<InstanceRoutingOptions, "queues" | "queueBackpressure"> & { now?: number } {
    if (!policy) return {};
    const queues = Object.fromEntries([...new Set(peers)].map(peer => {
      let value: QueuePressure;
      try { value = this.d.bus.assignmentQueue(peer); } catch { value = { queued: NaN }; }
      return [peer, value];
    }));
    return { queueBackpressure: policy, queues, now: this.d.now?.() ?? Date.now() };
  }

  private contextRouting(): Pick<InstanceRoutingOptions, "contextAdmission"> & { now?: number } {
    const admission = this.d.contextAdmission?.();
    if (!admission || !Number.isFinite(admission.policy.max_used) || admission.policy.max_used <= 0 || admission.policy.max_used > 1) return {};
    return { contextAdmission: admission, now: this.d.now?.() ?? Date.now() };
  }

  /** Public ids/counts/reasons only; no board history, pending envelope body or task text is read. */
  queuePressureStatus(peers: readonly string[]): QueueBackpressureStatus | undefined {
    const policy = this.queuePolicy();
    if (!policy) return undefined;
    const all = [...new Set(peers)].filter(peer => /^[a-z][a-z0-9-]{0,31}$/.test(peer));
    const bounded = all.slice(0, 4096), input = this.queueRouting(bounded, policy), now = input.now!;
    const rows = Object.fromEntries(bounded.map(peer => {
      const value = peerEntry(input.queues, peer), refusal = queueBackpressure(peer, policy, value, now);
      const queued = value && Number.isSafeInteger(value.queued) && value.queued >= 0 ? value.queued : null;
      const at = queued !== null && queued > 0 && typeof value?.oldestQueuedAt === "number" && Number.isSafeInteger(value.oldestQueuedAt) && value.oldestQueuedAt >= 0 && value.oldestQueuedAt <= now ? value.oldestQueuedAt : null;
      return [peer, { queued, oldestQueuedAt: at, oldestAgeMs: at === null ? null : now - at, blocked: refusal !== undefined, ...(refusal ? { code: refusal.code, reason: refusal.reason } : {}) }];
    }));
    return { policy, peers: rows, ...(all.length > bounded.length ? { truncated: true as const } : {}) };
  }

  /** Peer health and roles the daemon feeds routing (issues #89, #90, #92): failing peers are skipped, held queues explained. */
  private health(ownerIsolation?: Readonly<Record<string, boolean>>) {
    const failing = this.d.failing?.();
    const held = this.d.held?.();
    const workload = this.instanceRouting(ownerIsolation);
    const peers = workload.instances ? [...new Set([...(this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind), ...Object.keys(workload.instances), ...this.d.bus.peers.keys()])] : (this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind);
    return { ...workload, ...this.contextRouting(), ...this.queueRouting([...new Set([...peers, ...this.d.bus.peers.keys()])]), reviewPool: { pool: this.d.review?.pool ?? DEFAULT_REVIEW_POOL, rerotate: this.d.review?.rerotate, required: this.d.review?.pool !== undefined, ...(this.d.review?.same_family === "never" ? { sameFamily: "never" as const } : {}) }, ...(this.d.capabilities ? { capabilities: this.d.capabilities(), repository: this.d.repository } : {}), pullOnly: [...this.d.bus.peers.values()].filter(peer => (this.d.adapterCatalog?.definitionOf ?? definitionOf)(peer.id, workload.instances)?.attach?.pullOnlyForms?.length && peer.pullOnly).map(peer => peer.id), offRoster: peers.filter(peer => !this.d.bus.isRostered(peer)), ...(failing ? { failing } : {}), ...(held ? { held } : {}), ...(this.d.roles ? { roles: this.d.roles } : {}) };
  }

  private reviewHead(task: Task): string | undefined { return task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead; }

  private reviewPoolOptions(task: Task) {
    const head = this.reviewHead(task);
    const round = task.state === "in_review" ? task.history.slice(task.history.findLastIndex(entry => entry.event === "done") + 1) : [];
    const failed = [...new Set(round.flatMap(entry => entry.reviewerFailure?.head === head && entry.reviewerFailure ? [entry.reviewerFailure.peer] : []))];
    return { pool: this.d.review?.pool ?? DEFAULT_REVIEW_POOL, rerotate: this.d.review?.rerotate, failed, required: this.d.review?.pool !== undefined, ...(this.d.review?.same_family === "never" ? { sameFamily: "never" as const } : {}) };
  }

  private manuallyNamedReviewer(task: Task): boolean {
    const event = task.history.findLast(entry => ["reviewer changed", "assigned", "reassigned", "escalated"].includes(entry.event));
    return event?.event === "reviewer changed" && event.reason === "manual";
  }

  private poolReview(task: Task, refs?: TaskRefs): Assignment | undefined {
    if (this.manuallyNamedReviewer(task) || this.isPii(task) || task.class === "review") return undefined;
    const draft = { ...task, refs: { ...task.refs, ...cleanRefs(refs) } };
    const weights = this.weights(task.class, draft);
    const selection = assign(draft, this.states(), this.d.routing(), { ...weights, candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}) });
    const heldSelection = task.reviewer === USER && task.history[this.reviewRequestRevision(task) - 1]?.queueReviewHeld === true;
    const previous = task.reviewer && task.reviewer !== USER ? assign(draft, this.states(), this.d.routing(), { ...weights, candidates: [], namedReviewer: task.reviewer, ...(task.owner ? { notReviewer: task.owner } : {}) }) : undefined;
    const queueRefused = previous?.refusals?.some(row => row.role === "reviewer" && row.peer === task.reviewer && isQueuePressureCode(row.code));
    const newlyBlocked = selection.reviewBlocked && selection.refusals?.some(row => row.role === "reviewer" && isQueuePressureCode(row.code));
    return selection.reviewSelection || queueRefused || newlyBlocked || heldSelection ? selection : undefined;
  }

  private reviewMetadata(assignment?: Assignment, task?: Task): ReviewerHistory {
    const choice = assignment?.reviewSelection;
    const family = choice && assignment?.plannerFallback && assignment.reviewer ? (this.d.adapterCatalog?.familyOf ?? familyOf)(assignment.reviewer, this.d.instances?.()) : choice?.family;
    const reason = choice && assignment?.plannerFallback
      ? assignment.sameFamilyFallback ? "same-family fallback" as const : "unavailable skip" as const
      : choice?.reason;
    const queueReviewHeld = task !== undefined && !this.isPii(task) && assignment?.reviewer === USER && assignment.reviewBlocked === true
      && assignment.refusals?.some(row => row.role === "reviewer" && isQueuePressureCode(row.code));
    const queueReviewBinding = task ? this.queueReviewBinding(task) : undefined;
    return { ...(family ? { reviewerFamily: family } : {}), ...(reason ? { reviewerReason: reason } : {}), ...(assignment?.reviewBlocked ? { reviewBlocked: true } : {}), ...(queueReviewHeld ? { queueReviewHeld: true as const, ...(queueReviewBinding !== undefined ? { queueReviewBinding } : {}) } : {}) };
  }

  /** Capability admission precedes explicit assignments/reservations, independent of readiness or transient peer health. */
  private requireCapabilities(task: Parameters<typeof assign>[0], peer: PeerId, role: Exclude<TaskAssignmentRole, "planner"> = "owner", preEffect = true): void {
    requireLocalTaskPeer(peer);
    const instances = this.d.instances?.(), adapter = (this.d.adapterCatalog?.definitionOf ?? definitionOf)(peer, instances);
    const declaredExtra = !!adapter && adapter.kind !== peer;
    if ((!this.d.capabilities || this.isPii(task)) && !declaredExtra) return;
    const { state: _state, ...draft } = task; // backlog/readiness must not bypass an explicit reservation's admission
    const admission = assign(draft, this.states(), this.d.routing(), { candidates: role === "owner" ? [peer] : [], ...(role === "owner" ? { namedOwner: peer } : { namedReviewer: peer }), ...this.weights(task.class) });
    const missing = (admission.refusals ?? []).filter(row => row.peer === peer && row.role === role && (row.code === "tests" || row.code === "spec" || declaredExtra && role === "owner" && row.code === "owner-admission")).map(row => `  ${role} candidate ${peer}: skipped, ${row.reason}`);
    if (missing.length) throw new (preEffect ? PreEffectToolRefusal : Error)(`cannot assign ${peer}: ${missing.join("; ")}`);
  }

  /** What assignment weighs besides states and policy: quota, demotion and the review record. */
  /**
   * #525-3: the settled planner holders, sorted: the one input of the planner walk. It comes from the same settled role map as planner
   * authority (`d.roles`), restricted to rostered peers, so assignment, planner notices and `route explain` agree on who the holders are.
   * Selection stays in assign(); task bindings only keep that selection while the holder remains eligible.
   */
  private plannerHolders(): PeerId[] {
    return Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("planner") && this.d.bus.isRostered(peer)).map(([peer]) => peer).sort();
  }

  private weights(cls: TaskClass, task?: Task, projectedHealth?: ReturnType<Tasks["health"]>) {
    const now = Date.now();
    const quota = this.d.quota?.();
    const health = projectedHealth ?? this.health(), clock = health.now ?? now;
    return { ...health, ...(task && this.hasPersonReservation(task) && task.reserved ? { queueReservedHold: task.reserved } : {}), planners: this.plannerHolders(), ...(task ? { reviewPool: this.reviewPoolOptions(task), ...(task.planner ? { keptPlanner: task.planner } : {}) } : {}), now: clock, demoted: this.demoted(cls, clock), reviews: this.reviewRecord(cls), ...(quota ? { quota } : {}), ...(this.d.review?.adaptive ? { adaptive: { min: this.d.review.min_reviews } } : {}) };
  }

  /**
   * A peer's tasks of a class, across hub runs, as split observations (issue #109): each hand-over to it by someone
   * else (claims left out) while it had the profile it has now, typed by outcome. Stages are the board's own proxies and
   * stay unknown when the accept came with the done.
   * ponytail: the profile is taken at the hand-over; a hub restarted with another version before the done mixes two in
   * one record. Tag the done as well if that ever shows up in the data.
   */
  splitObservations(cls: TaskClass, peer: PeerId, exclude?: number): SplitObservation[] {
    const profile = this.d.splitProfile?.(peer);
    if (!profile) return [];
    const failed = ["check failed", "changes_requested", "escalated", "released", "declined", "integration unresolved"];
    return this.d.board.list().flatMap((t): SplitObservation[] => {
      if (t.class !== cls || t.id === exclude) return [];
      // One observation per time the task was handed to `peer` by someone else: what happened from that hand-over up to
      // and with the next one is that peer's, so an escalation away or a decline counts against the peer that failed,
      // never against the next owner, and work that ended elsewhere is still counted (no survivors only).
      return t.history.flatMap((given, i): SplitObservation[] => {
        if (!OWNERSHIP_EVENTS.has(given.event) || given.event === "unassigned" || given.owner !== peer || given.profile !== profile || given.by === peer) return [];
        const next = t.history.findIndex((h, j) => j > i && OWNERSHIP_EVENTS.has(h.event));
        const span = t.history.slice(i + 1, next < 0 ? undefined : next + 1);
        if (span.some((h) => failed.includes(h.event) && h.evidenceOnly !== true)) return [{ outcome: "failed" }];
        if (next >= 0 || t.state !== "approved") return []; // handed on without a failure (a relay), or still open
        const accepted = span.find((h) => h.event === "accepted" && h.by === peer);
        // The work stage ends at its first done call: checks and an integration step are not the work itself.
        const intent = accepted && span.find((h) => h.at >= accepted.at && ["done", "done (checking)", "integration requested"].includes(h.event));
        if (!accepted || !intent || accepted.note === WITH_DONE) return [{ outcome: "approved" }];
        return [{ outcome: "approved", orient: accepted.at - given.at, work: intent.at - accepted.at }];
      });
    });
  }

  /**
   * The shadow split prediction for routing `task` to `candidate` (issue #109): the pair it would form with the owner of
   * an open task it overlaps (`unstarted`: one not started yet). Assignment never reads it; `route explain` shows it and
   * assignment records it.
   */
  splitShadow(task: Task, candidate: PeerId | undefined, unstarted = false): SplitPrediction | undefined {
    if (!candidate) return undefined;
    const others = this.overlapHits({ ...task, owner: null }).map((h) => h.task).filter((t) => t.owner && t.owner !== candidate && t.owner !== USER && t.owner !== HUB);
    // A task not started yet first: the pair the routing record is about, so explain and the record agree on it.
    const other = others.find((t) => t.state === "proposed") ?? (unstarted ? undefined : others[0]);
    if (!other) return undefined;
    const peers: [PeerId, PeerId] = [candidate, other.owner!];
    const states = this.states();
    const failing = this.d.failing?.() ?? {};
    // Other open work, and the overlapping task itself once its owner has started it: either way that owner would not
    // start from orientation plus two whole units.
    const open = this.d.board.list().filter((t) => OPEN.includes(t.state) && t.id !== task.id && (t.id !== other.id || t.state !== "proposed"));
    // One task of a class is one unit: the only normalization the board supports, so another class is unknown.
    const unit = task.class === other.class ? 1 : undefined;
    const taking = (p: PeerId) => states[p] === "busy" && (p === candidate ? this.sent.has(handOver(task, p)) : other.state === "proposed" && this.sent.has(handOver(other, p)));
    return predictSplit({
      peers,
      observations: Object.fromEntries(peers.map((p) => [p, this.splitObservations(task.class, p, task.id)])),
      units: [unit, unit],
      ...(this.d.splitMinObservations ? { minObservations: this.d.splitMinObservations() } : {}),
      ...(this.d.splitMaxFailureShare ? { maxFailureShare: this.d.splitMaxFailureShare() } : {}),
      profiles: Object.fromEntries(peers.map((p) => [p, this.d.splitProfile?.(p)])),
      backlog: Object.fromEntries(peers.map((p) => [p, open.filter((t) => t.owner === p).length])),
      // Busy is taking the task in question only in the turn that task started (an owner goes busy as its task is
      // delivered) or in which it claimed it: the routed peer this very task, the other owner the overlapped one while it
      // is not started. Busy otherwise, it is at work on something else (#109, #115; a routing or cohort record is taken
      // before the task is sent, so a busy candidate is not available then).
      available: Object.fromEntries(peers.map((p) => [p, !peerEntry(failing, p) && (states[p] === "idle" || taking(p))])),
    });
  }

  /**
   * Work on these places failed (a check failure, or changes requested): approvals of other tasks on the same places
   * within the window were contradicted. Each approval counts once.
   */
  private contradict(failed: Task): void {
    if (this.isPii(failed)) return; // its places are left out everywhere else too
    const now = Date.now();
    const contradictionDays = this.d.contradictionWindowDays?.(), contradictionWindowMs = contradictionDays === undefined ? CONTRADICTION_WINDOW_MS : contradictionDays * 86_400_000;
    const mine = this.places(failed);
    for (const t of this.d.board.list("approved")) {
      if (t.id === failed.id || !t.owner || this.isPii(t)) continue;
      const approval = [...t.history].reverse().find((h) => h.event === "approved");
      if (!approval || now - approval.at > contradictionWindowMs || approval.by === USER) continue;
      const theirs = this.places(t);
      // Blame needs the same file or symbol: a directory or `.` would contradict every approval under it. Older rows
      // were stored as written, so both sides are compared in one spelling.
      if (mine.repositoryKey !== theirs.repositoryKey) continue;
      const file = (p: string) => normPath(p) !== "." && theirs.paths.some((q) => normPath(q) === normPath(p));
      const same = mine.paths.some(file) || mine.symbols.some((x) => theirs.symbols.some((y) => symbolsOverlap(x, y)));
      if (!same || this.d.board.reviews({ task: t.id }).some((r) => r.kind === "contradicted")) continue;
      this.d.board.recordReview({ implementer: t.owner, reviewer: approval.by, class: t.class, kind: "contradicted", task: t.id });
    }
  }

  private planningRecorded(change: { by: string; task?: number; release?: number; fields: string[]; revision: number }): void {
    try { this.d.recordPlanning?.(change); } catch { /* telemetry never changes a durable result */ }
  }

  /** A removed/off-roster binding falls back to legacy holders; a busy, paused or offline holder keeps authority. */
  taskPlanner(task: Pick<Task, "planner">): PeerId[] {
    const holders = Object.keys(this.d.roles ?? {}).filter(peer => !isRemotePeerId(peer) && this.d.roles?.[peer]?.includes("planner")).sort();
    return task.planner && holders.includes(task.planner) && this.d.bus.isRostered(task.planner) ? [task.planner] : holders;
  }

  /** Current planner rulings amend review context, never person-only plan-departure acceptance. */
  plannerRulings(task: Task, recipient: PeerId): { historyIndex: number; by: PeerId; at: number; note: string }[] {
    requireLocalTaskPeer(recipient);
    if (this.isPii(task)) return [];
    const boundary = task.history.findLastIndex(entry => entry.event === "accepted" || entry.event === "claimed");
    if (boundary < 0) return [];
    const planners = new Set(this.taskPlanner(task));
    const rulings: { historyIndex: number; by: PeerId; at: number; note: string }[] = [];
    for (let historyIndex = boundary + 1; historyIndex < task.history.length && rulings.length < 5; historyIndex++) {
      const entry = task.history[historyIndex]!;
      if (entry.event !== "plan reviewed" || !planners.has(entry.by) || !this.d.roles?.[entry.by]?.includes("planner")
        || typeof entry.note !== "string" || !entry.note.trim() || !Number.isFinite(entry.at)) continue;
      // Screen the entire original note before the display bound, including a sensitive suffix past 1000 characters.
      const note = sanitize(this.screen(task, entry.note, "planner ruling", recipient, entry.withheld)).slice(0, 1000);
      rulings.push({ historyIndex, by: entry.by, at: entry.at, note });
    }
    return rulings;
  }

  private planningAuthority(by: PeerId, task?: Pick<Task, "planner">): void {
    requireLocalTaskPeer(by);
    if (by !== USER && (!this.d.roles?.[by]?.includes("planner") || task !== undefined && !this.taskPlanner(task).includes(by))) throw new PreEffectToolRefusal(`planning requires a person or configured planner role${task ? "; only the task's effective planner may act" : ""}`);
  }

  /** #812 AC5: a peer holding the configured planner role. The conductor's task reads accept it; it grants no write. */
  isConfiguredPlanner(peer: PeerId): boolean { return !isRemotePeerId(peer) && peer !== USER && peer !== HUB && !!this.d.roles?.[peer]?.includes("planner"); }

  private plannerWriteAuthority(by: PeerId, task?: Pick<Task, "planner">): void {
    requireLocalTaskPeer(by);
    if (by !== USER && this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("planner writes are unavailable during a private turn");
    this.planningAuthority(by, task);
  }

  private studiesRunning = 0;
  private studyStopped = false;
  private readonly studyDrainWaiters = new Set<() => void>();
  studiesPending = (): number => this.studiesRunning;

  async stopStudies(): Promise<void> {
    this.studyStopped = true;
    if (this.studiesRunning) await new Promise<void>(resolve => this.studyDrainWaiters.add(resolve));
  }

  private studyHold(): string | undefined {
    try {
      if (this.studyStopped || this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError)
        return "study writes are held by recovery, shutdown or storage failure";
    } catch { return "study write admission is unavailable"; }
    return undefined;
  }

  private async studyWrite<T>(write: () => Promise<T>): Promise<T> {
    this.studiesRunning++;
    try { return await write(); } finally {
      if (--this.studiesRunning === 0) { for (const resolve of this.studyDrainWaiters) resolve(); this.studyDrainWaiters.clear(); }
    }
  }

  private studyFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
      throw new PreEffectToolRefusal("study request must be a plain data object");
    const fields = Object.getOwnPropertyDescriptors(input);
    if (Object.entries(fields).some(([key, descriptor]) => !allowed.includes(key) || !Object.hasOwn(descriptor, "value")))
      throw new PreEffectToolRefusal("study request has unknown fields or accessors");
    return Object.fromEntries(Object.entries(fields).map(([key, descriptor]) => [key, descriptor.value]));
  }

  private studyId(value: unknown): string {
    if (typeof value !== "string" || !/^rc-[a-f0-9]{12}$/.test(value)) throw new PreEffectToolRefusal("study id is invalid");
    return value;
  }

  private studyNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new PreEffectToolRefusal(`${field} must be a positive integer`);
    return value;
  }

  private studyContract(value: unknown): ResearchCampaignContract {
    try { return parseResearchCampaign(value); }
    catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "invalid study contract"); }
  }

  private studyTime(): number {
    const now = this.d.studyNow?.() ?? Date.now();
    if (!Number.isFinite(now)) throw new PreEffectToolRefusal("study clock is unavailable");
    return now;
  }

  private studyRecord(id: string, revision?: number): ResearchCampaignRecord {
    let record: ResearchCampaignRecord | undefined;
    try { record = this.d.board.researchCampaign(id, revision); }
    catch { throw new PreEffectToolRefusal("study record is unavailable or invalid"); }
    if (!record || record.project !== this.d.project) throw new PreEffectToolRefusal("study is unavailable in this project");
    return record;
  }

  private studyParent(id: number): Task {
    const parent = this.need(id, false, true, true);
    if (this.places(parent).repositoryKey !== this.repositories.scope({}).key) throw new PreEffectToolRefusal("study parent is outside this project");
    return parent;
  }

  /** Write receipts expose no contract text; only person-only approval returns the unit mapping. */
  private studyReceipt(record: ResearchCampaignRecord, includeMapping = false): ResearchCampaignReceipt {
    const units = this.d.board.researchCampaignBindings(record.id, record.revision);
    return { id: record.id, parentTaskId: record.parentTaskId, revision: record.revision, status: record.status,
      unitCount: units.length, units: includeMapping ? units : [] };
  }

  private studySource(id: string): { id: string; sha256: string; private: boolean } | undefined {
    try {
      const source = this.d.studySource?.(id);
      return source && source.id === id && /^[a-f0-9]{64}$/.test(source.sha256) && typeof source.private === "boolean"
        ? { id: source.id, sha256: source.sha256, private: source.private } : undefined;
    } catch { return undefined; }
  }

  private studyLatest(id: string, revision: number): ResearchCampaignRecord {
    const record = this.studyRecord(id);
    if (record.revision !== revision || record.status === "closed") throw new PreEffectToolRefusal("study revision is stale or closed");
    return record;
  }

  private studyFamily(parent: Task): Set<number> {
    if (!parent.history.some(entry => entry.event === "draft approved")) throw new PreEffectToolRefusal("adoption requires an approved intake family");
    const family = new Set<number>(), pending = [...(parent.deps ?? [])];
    // ponytail: 512 dependency nodes bound intake provenance walks; a larger family needs indexed family identities.
    while (pending.length) {
      const id = pending.pop()!;
      if (family.has(id)) continue;
      if (family.size >= 512) throw new PreEffectToolRefusal("study intake family exceeds its bounded scope");
      const task = this.d.board.get(id);
      if (!task) throw new PreEffectToolRefusal("study intake family is incomplete");
      family.add(id); pending.push(...(task.deps ?? []));
    }
    family.delete(parent.id);
    return family;
  }

  private studyReferences(parentId: number, contract: ResearchCampaignContract, campaignId?: string): StudyReferences {
    const parent = this.studyParent(parentId);
    const profile = parent.profile ?? "dev", storedProfile = profile === (this.d.profile ?? "dev") ? this.d.profileData ?? profile : profile;
    try {
      if (profileClass(parent.profileClass ?? parent.class, storedProfile) !== parent.class) throw new Error("changed class");
    } catch { throw new PreEffectToolRefusal("study parent profile class is unavailable or changed"); }
    const sources = contract.sourceIds.map(id => {
      const source = this.studySource(id);
      if (!source)
        throw new PreEffectToolRefusal("study source is unavailable in this project");
      return source;
    });
    if (contract.budget) {
      const budget = this.d.executionBudget?.status(contract.budget.id);
      if (!budget || Array.isArray(budget)) throw new PreEffectToolRefusal("study budget is unavailable");
    }
    const adopted = new Map<string, Task>();
    const family = contract.units.some(unit => unit.adoptTaskId !== undefined) ? this.studyFamily(parent) : new Set<number>();
    for (const unit of contract.units) if (unit.adoptTaskId !== undefined) {
      const task = this.studyParent(unit.adoptTaskId);
      if (!family.has(task.id) || task.draft || !task.history.some(entry => entry.event === "draft approved"))
        throw new PreEffectToolRefusal("study unit must adopt an approved intake child");
      const binding = this.d.board.researchTaskBinding(task.id);
      if (binding && (binding.campaignId !== campaignId || binding.unitId !== unit.id)) throw new PreEffectToolRefusal("intake child is already bound to another study unit");
      adopted.set(unit.id, task);
    }
    const reused = new Map<string, Task>();
    if (campaignId) for (const unit of contract.units) {
      const previous = this.d.board.researchLatestUnitBinding(campaignId, unit.id);
      if (previous) reused.set(unit.id, this.studyParent(previous.taskId));
    }
    const priv = this.isPii(parent) || sources.some(source => source.private) || [...adopted.values(), ...reused.values()].some(task => this.isPii(task))
      || !this.nameable(JSON.stringify(contract));
    const flows = (rows: Map<string, Task>) => [...rows].map(([unit, task]) => [unit, task.id, task.history.length]);
    return { parent, adopted, reused, private: priv, key: JSON.stringify([parent.history.length, sources, flows(adopted), flows(reused), priv]) };
  }

  /** Always re-read persisted approval and limits at the dispatch write, including after a metadata await. */
  private studyDispatchReason(task: Task, owner?: PeerId): string | undefined {
    try {
      const bound = this.d.board.researchDispatchBinding(task.id);
      if (!bound) return undefined;
      const { campaign, binding } = bound;
      if (campaign.project !== this.d.project || campaign.status !== "approved" || !binding) return "study revision is not approved or its unit was removed";
      const stop = campaign.contract.stopPolicy;
      if (Date.parse(stop.deadline) <= this.studyTime()) return "study deadline has expired";
      const units = this.d.board.researchCampaignBindings(campaign.id, campaign.revision);
      if (units.length > stop.maxUnits || binding.round > stop.maxFollowUpRounds) return "study stop limit exceeded";
      const budget = campaign.contract.budget;
      if (budget?.hardCap.length) {
        const ledger = this.d.executionBudget, current = ledger?.status(budget.id);
        if (!ledger || !current || Array.isArray(current) || !campaign.eligibleOwners?.length ||
          budget.hardCap.some(resource => resource === "tokens" || current.limits[resource] === undefined || resource === "model_calls" && current.limits.tokens !== undefined)) return "study hard-cap budget is unavailable";
        if (budget.hardCap.some(resource => !current.units[resource] || current.units[resource]!.remaining <= 0 || current.units[resource]!.reason === "unknown_usage")) return "study hard-cap budget is exhausted or usage is unknown";
        if (owner && (!campaign.eligibleOwners.includes(owner) || !ledger.covers(budget.id, task.id, owner, budget.hardCap)))
          return "study owner is not covered by its named hard-cap budget";
      }
      return undefined;
    } catch { return "study dispatch evidence is unavailable"; }
  }

  private studyDispatchCheck(task: Task, owner?: PeerId): void {
    const reason = this.studyDispatchReason(task, owner);
    if (reason) throw new PreEffectToolRefusal(reason);
  }

  private studyExcludedOwners(task: Task): PeerId[] {
    return Object.keys(this.states()).filter(peer => this.studyDispatchReason(task, peer) !== undefined);
  }

  private studyEligibleOwners(contract: ResearchCampaignContract): string[] | undefined {
    if (!contract.budget?.hardCap.length) return undefined;
    const ledger = this.d.executionBudget, budget = ledger?.status(contract.budget.id);
    if (!ledger || !budget || Array.isArray(budget) || contract.budget.hardCap.some(resource => resource === "tokens" || budget.limits[resource] === undefined || resource === "model_calls" && budget.limits.tokens !== undefined))
      throw new PreEffectToolRefusal("study hard-cap requires an enabled budget with supported resource limits");
    const eligible = budget.peers.filter(peer => ledger.instrumented(peer)).sort();
    if (!eligible.length) throw new PreEffectToolRefusal("study hard-cap has no instrumented eligible owner");
    return eligible;
  }

  private studyRoundCheck(original: ResearchCampaignRecord, contract: ResearchCampaignContract): void {
    const added = contract.units.filter(unit => unit.round > 0 && !original.contract.units.some(previous => previous.id === unit.id && previous.round === unit.round));
    if (!added.length) return;
    const stored = this.d.board.researchCampaignBindings(original.id, original.revision), handoffs = this.d.board.researchHandoffs(original.id, original.revision);
    for (const unit of added) {
      // The revised contract decides which discovery units precede this round: a discovery added in the same revision has no stored binding, so it has no handoff and refuses.
      const previous = contract.units.filter(value => value.round === unit.round - 1 && value.purpose === "discovery");
      if (!previous.length || previous.some(value => {
        const binding = stored.find(bound => bound.unitId === value.id && bound.round === value.round && bound.purpose === "discovery");
        const handoff = binding && handoffs.find(handoff => handoff.handoff.unitId === value.id);
        return !handoff || !handoff.handoff.insufficientEvidence && value.sourceIds.some(source => !handoff.handoff.evidence.some(item => item.sourceId === source));
      })) throw new PreEffectToolRefusal("follow-up rounds require complete stored discovery handoffs or insufficientEvidence");
    }
  }

  async studyHandoff(by: PeerId, input: unknown): Promise<{ campaignId: string; unitId: string; seq: number }> {
    const requestCheck = this.requestCheck(by, () => this.studyHold());
    let handoff: ReturnType<typeof parseResearchHandoff>;
    try { handoff = parseResearchHandoff(input); } catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "invalid study handoff"); }
    return this.studyWrite(async () => {
      const campaign = this.studyRecord(handoff.campaignId, handoff.revision), task = this.studyParent(handoff.taskId);
      if (by !== task.owner || task.state !== "in_progress" || this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("handoff requires the current in-progress unit owner");
      const sources = campaign.contract.sourceIds.map(id => this.studySource(id));
      if (sources.some(source => !source)) throw new PreEffectToolRefusal("study handoff source is unavailable");
      const sourceKey = JSON.stringify(sources);
      const text = JSON.stringify(handoff);
      const withheld = !this.nameable(text) || looksSecret(text) || await this.withholds("note", text, task);
      requestCheck();
      const current = this.studyParent(task.id);
      if (current.history.length !== task.history.length || current.owner !== by || current.state !== "in_progress") throw new PreEffectToolRefusal("study handoff task changed during screening");
      if (JSON.stringify(campaign.contract.sourceIds.map(id => this.studySource(id))) !== sourceKey) throw new PreEffectToolRefusal("study handoff sources changed during screening");
      if ((withheld || this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId))) && !this.isPii(current)) throw new PreEffectToolRefusal("study handoff privacy requires private task authority");
      requestCheck();
      try {
        const saved = this.d.board.recordResearchHandoff(handoff, this.d.project, by, this.studyTime(), current.history.length);
        return { campaignId: saved.handoff.campaignId, unitId: saved.handoff.unitId, seq: saved.seq };
      } catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "study handoff was not saved"); }
    });
  }

  /**
   * #601: one page of receipts, one per campaign of this project, newest revision, never its question, scope, sources or unit text. At most 50 rows per call (the spec's readback bound), in id
   * order, strictly after the optional cursor `after`; `next` names the last id of a page that has more behind it. The bound is in the Board query, not in a slice after loading everything.
   */
  studyList(by: PeerId, input: unknown): { campaigns: ResearchCampaignReceipt[]; next?: string } {
    requireLocalTaskPeer(by);
    const fields = this.studyFields(input, ["after"]);
    const after = fields.after === undefined ? undefined : this.studyId(fields.after);
    const page = this.d.board.researchCampaignPage(this.d.project, after, 50);
    return { campaigns: page.ids.map(id => this.studyReceipt(this.studyRecord(id))), ...(page.next ? { next: page.next } : {}) };
  }

  studyShow(by: PeerId, input: unknown): ReturnType<typeof studyProjection> {
    requireLocalTaskPeer(by);
    const fields = this.studyFields(input, ["id"]), campaign = this.studyRecord(this.studyId(fields.id));
    const bindings = this.d.board.researchCampaignBindings(campaign.id, campaign.revision);
    const tasks = bindings.map(unit => this.d.board.get(unit.taskId)).filter((task): task is Task => !!task);
    const ledger = this.d.executionBudget, configured = campaign.contract.budget, budget = configured && ledger?.status(configured.id);
    const instrumentedPeers = tasks.flatMap(task => task.owner && ledger?.instrumented(task.owner) ? [task.owner] : []);
    const projection = studyProjection({ campaign, bindings, tasks, handoffs: this.d.board.researchHandoffs(campaign.id), now: this.studyTime(), instrumentedPeers,
      ...(budget && !Array.isArray(budget) ? { budget: { ...budget, coveredTaskIds: tasks.filter(task => task.owner && ledger?.covers(budget.id, task.id, task.owner, [])).map(task => task.id) } } : {}) });
    projection.reasons = [...new Set([...projection.reasons, ...tasks.flatMap(task => { const reason = this.studyDispatchReason(task, task.owner ?? undefined); return reason ? [reason] : []; })])];
    projection.held = projection.reasons.length > 0;
    if (this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId))) {
      // IDs, counts, states and resource names only. Source references are private view data too.
      for (const unit of projection.units) { unit.sourceIds = []; unit.duplicateSourceIds = []; unit.handoff.coveredSourceIds = []; }
    }
    return projection;
  }

  private studyReplayPrivacy(record: ResearchCampaignRecord, parent: Task): boolean {
    return record.private || this.isPii(parent) || record.contract.sourceIds.some(id => {
      const source = this.studySource(id);
      return !source || source.private;
    }) || this.d.board.researchCampaignBindings(record.id, record.revision).some(unit => {
      const task = this.d.board.get(unit.taskId); return !task || this.isPii(task);
    });
  }

  /**
   * #604 (agent-hub#1030), ORIGIN side. Who may hand work to another project: the person, or a configured planner, or the conductor. The host (the daemon) has already resolved and
   * checked the target; this is the authority and privacy gate before anything leaves this project, so a refusal here leaves no row in either board.
   */
  handoffOutAuthority(by: PeerId, piiTask?: Task): void {
    requireLocalTaskPeer(by);
    if (by !== USER && this.d.privateTurn?.(by)) throw new HandoffRefusal("pii_turn", "a handoff is unavailable during a private turn: nothing from it may leave this project");
    if (piiTask && this.isPii(piiTask)) throw new HandoffRefusal("pii_task", "a [pii] task is not handed off: nothing about it leaves this project");
    if (by !== USER && !this.d.roles?.[by]?.includes("planner") && this.d.operational?.(by) !== true) throw new HandoffRefusal("no_authority", "a handoff needs the person, a configured planner or the conductor");
  }

  /** ORIGIN side: remember what was handed over, once the target answered with its task id. */
  handoffSent(by: PeerId, target: { projectId: string }, remoteTask: number, title: string, localTask?: number): void {
    this.d.board.recordHandoffOutbound({ remoteProject: target.projectId, remoteTask, originPeer: by, ...(localTask === undefined ? {} : { localTask }), title: title.slice(0, 300), state: "proposed" });
  }

  /**
   * TARGET side. The origin peer gets no identity or authority here: the task is an ownerless proposal made by the hub on the origin's behalf, with the origin recorded in its own table.
   * The request was parsed closed by the origin and is parsed again here, because a control message is data from another process: the body is bounded, control characters are refused and the
   * text is sanitized before it is stored. A `[pii]` result is refused whole, and nothing is left behind.
   */
  async handoffIn(origin: { projectId: unknown; peer: unknown; taskId?: unknown }, input: unknown, fence: () => string | undefined = () => undefined): Promise<{ task: number; state: string; note?: string }> {
    const request = parseHandoff({ ...(input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : { invalid: true }), project: "local" });
    if (typeof origin.projectId !== "string" || !origin.projectId || origin.projectId.length > 200 || typeof origin.peer !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(origin.peer)
      || origin.taskId !== undefined && (!Number.isSafeInteger(origin.taskId) || (origin.taskId as number) < 1)) throw new HandoffRefusal("invalid", "handoff origin is malformed");
    if (origin.projectId === this.d.project) throw new HandoffRefusal("same_project", "that is this project: a task for this project goes through hub_task_propose");
    // The fence is asked right before the board write and after every await: a recovery that began while the PII screen was pending must find nothing written (agent-hub#1030, review).
    const held = (): void => { const reason = fence(); if (reason) throw new HandoffRefusal("invalid", reason); };
    held();
    // The spec issue the caller named is kept in the task itself, as its own line: the target's planner reads it from the detail, and `ahub task show` shows it there.
    const issueLine = request.issue === undefined ? "" : `spec issue: #${request.issue} in this repository`;
    const detail = sanitize([request.detail, issueLine, `[handed off from project ${origin.projectId} by ${origin.peer}${origin.taskId === undefined ? "" : ` (their task #${origin.taskId})`}]`].filter(Boolean).join("\n\n"));
    const refs: TaskRefs = { ...(request.paths.length ? { paths: request.paths } : {}) };
    const signals = this.signalsFor({ title: request.title, detail, refs, plan: {} });
    if (signals.includes("pii")) throw new HandoffRefusal("pii_task", "the handed-off text matches a PII pattern; it is not stored here");
    const screening = this.screenOn();
    const screened = screening ? await this.screenCall(screenText({ title: request.title, detail: [detail, ...request.paths].join("\n"), plan: {} })) : undefined;
    held();
    if (screening && (!screened || screened.label !== "clear")) throw new HandoffRefusal("pii_task", "the handed-off text could not be cleared by the PII screen; it is not stored here");
    let task = this.d.board.propose(HUB, { title: request.title, detail, class: request.class, refs, plan: {}, signals });
    this.d.board.setHandoffOrigin(task.id, { projectId: origin.projectId, peer: origin.peer, ...(origin.taskId === undefined ? {} : { originTask: origin.taskId as number }) });
    // From here the task and its origin are saved, so nothing below may fail the handoff: the origin must learn the task id, or the target keeps work nobody can track.
    try { task = this.linkOnWrite(task); } catch { /* the lifecycle link is advice */ }
    try { this.d.notify(`task ${this.publicTitle(task)} handed off from project ${origin.projectId} by ${origin.peer}`); } catch { /* never throw after a board write */ }
    let note: string | undefined;
    try { task = await this.assignOwner(task, HUB, {}); }
    catch (error) {
      if (error instanceof AssignmentUndeliveredError) { task = error.task; note = "the assignment is saved but its delivery is not confirmed yet; this hub retries it"; }
      else note = "the task is saved but was not offered to an owner yet; this hub's routing offers it"; // a routing refusal leaves an ordinary proposal for the planner
    }
    return { task: task.id, state: task.state, ...(note ? { note } : {}) };
  }

  /** TARGET side: the origin recorded for a task, for `ahub task show` and the board. */
  handoffOriginOf(taskId: number): { projectId: string; peer: string; originTask: number | null } | undefined {
    const origin = this.d.board.handoffOrigin(taskId);
    return origin ? { projectId: origin.projectId, peer: origin.peer, originTask: origin.originTask } : undefined;
  }

  /** ORIGIN side: the target reported a state change. Records it and tells the origin peer with one `kind: task` envelope. Idempotent: a state already recorded sends nothing. */
  handoffEvent(input: unknown): { recorded: boolean } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HandoffRefusal("invalid", "handoff event must be a data object");
    const e = input as Record<string, unknown>;
    if (typeof e.projectId !== "string" || !e.projectId || e.projectId.length > 200 || !Number.isSafeInteger(e.remoteTask) || (e.remoteTask as number) < 1
      || typeof e.state !== "string" || !(HANDOFF_EVENTS as readonly string[]).includes(e.state)) throw new HandoffRefusal("invalid", "handoff event is malformed");
    const row = this.d.board.handoffOutboundFor(e.projectId, e.remoteTask as number);
    if (!row) throw new HandoffRefusal("invalid", "no handoff of ours is recorded for that task");
    const pr = Number.isSafeInteger(e.pr) && (e.pr as number) > 0 ? e.pr as number : undefined, head = typeof e.head === "string" && /^[0-9a-f]{40}$/.test(e.head) ? e.head : undefined;
    if (row.state === e.state && (pr === undefined || pr === row.pr) && (head === undefined || head === row.head)) return { recorded: false };
    this.d.board.recordHandoffOutbound({ remoteProject: row.remoteProject, remoteTask: row.remoteTask, originPeer: row.originPeer, ...(row.localTask === null ? {} : { localTask: row.localTask }), title: row.title, state: e.state, ...(pr === undefined ? {} : { pr }), ...(head === undefined ? {} : { head }) });
    const body = followBackLine(row.remoteTask, e.state as HandoffEvent, { pr, head });
    if (row.originPeer !== USER && row.originPeer !== HUB) {
      try { this.d.bus.publish(newEnvelope(HUB, body, { to: [row.originPeer], kind: "task", priority: "important", refs: { task: String(row.localTask ?? row.remoteTask) } })); }
      catch { /* never throw after a board write */ }
    }
    return { recorded: true };
  }

  /**
   * TARGET side, catch-up (#1030 design 4): the origin asks for the current state of the tasks it handed us, by id, after it was down. Answers only for tasks whose recorded origin IS the asking
   * project, and only with the same fields a live event carries (the event name, a PR number, a full head), so an origin learns nothing it could not have been told live.
   */
  handoffStatesFor(projectId: unknown, taskIds: unknown): { task: number; state: HandoffEvent | "proposed"; pr?: number; head?: string }[] {
    if (typeof projectId !== "string" || !projectId || projectId.length > 200 || !Array.isArray(taskIds) || taskIds.length > 200 || !taskIds.every(id => Number.isSafeInteger(id) && id > 0)) throw new HandoffRefusal("invalid", "handoff state request is malformed");
    const out: { task: number; state: HandoffEvent | "proposed"; pr?: number; head?: string }[] = [];
    for (const id of taskIds as number[]) {
      const origin = this.d.board.handoffOrigin(id), task = origin?.projectId === projectId ? this.d.board.get(id) : undefined;
      if (!task) continue;
      const entry = task.history.findLast(h => handoffEventFor(h.event, task.state) !== undefined);
      const state = entry ? handoffEventFor(entry.event, task.state) ?? "proposed" : "proposed";
      const pr = typeof task.sdlc?.pr === "number" && Number.isSafeInteger(task.sdlc.pr) && task.sdlc.pr > 0 ? task.sdlc.pr : undefined;
      const rawHead = task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead, head = typeof rawHead === "string" && /^[0-9a-f]{40}$/.test(rawHead) ? rawHead : undefined;   // the owner's commit, else the receipt's head; only a full SHA crosses
      out.push({ task: id, state, ...(pr === undefined ? {} : { pr }), ...(head === undefined ? {} : { head }) });
    }
    return out;
  }

  /** ORIGIN side: record what a target answered to the catch-up, and tell the origin peer about a change this project missed while it was down. */
  handoffCaughtUp(projectId: string, rows: { task: number; state: string; pr?: number; head?: string }[]): number {
    let changed = 0;
    for (const row of rows) {
      if (!(HANDOFF_EVENTS as readonly string[]).includes(row.state)) continue;
      try { if (this.handoffEvent({ projectId, remoteTask: row.task, state: row.state, ...(row.pr === undefined ? {} : { pr: row.pr }), ...(row.head === undefined ? {} : { head: row.head }) }).recorded) changed++; }
      catch { /* a row we hold no handoff for is not ours */ }
    }
    return changed;
  }

  /** ORIGIN side, readback: what this project handed over, with the last state each target reported. */
  handoffList(): HandoffOutboundRow[] { return this.d.board.handoffOutbound(); }

  async studyDraft(by: PeerId, input: unknown): Promise<ResearchCampaignReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold()); this.plannerWriteAuthority(by);
    const fields = this.studyFields(input, ["parentTaskId", "contract"]), parentId = this.studyNumber(fields.parentTaskId, "parentTaskId");
    const contract = this.studyContract(fields.contract);
    if (contract.units.some(unit => unit.round !== 0)) throw new PreEffectToolRefusal("an initial study contains only round zero");
    return this.studyWrite(async () => {
      this.plannerWriteAuthority(by, this.studyParent(parentId));
      const before = this.studyReferences(parentId, contract);
      const withheld = await this.withholds("note", JSON.stringify(contract), before.parent);
      requestCheck();
      const current = this.studyReferences(parentId, contract); this.plannerWriteAuthority(by, current.parent);
      if (current.key !== before.key) throw new PreEffectToolRefusal("study references changed during draft screening");
      const record: ResearchCampaignRecord = { id: `rc-${randomBytes(6).toString("hex")}`, project: this.d.project, parentTaskId: parentId,
        revision: 1, status: "draft", contract, hash: campaignHash(contract), private: current.private || withheld, createdBy: by, createdAt: this.studyTime() };
      let saved: ResearchCampaignRecord;
      requestCheck(); this.plannerWriteAuthority(by, current.parent);
      try { saved = this.d.board.saveResearchCampaignDraft(record, undefined, current.parent.history.length); }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "study draft was not saved"); }
      this.releaseNotice(`study ${saved.id} revision ${saved.revision} drafted`);
      return this.studyReceipt(saved);
    });
  }

  async studyRevise(by: PeerId, input: unknown): Promise<ResearchCampaignReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold()); this.plannerWriteAuthority(by);
    const fields = this.studyFields(input, ["id", "revision", "contract"]), id = this.studyId(fields.id), revision = this.studyNumber(fields.revision, "revision");
    const contract = this.studyContract(fields.contract);
    return this.studyWrite(async () => {
      const original = this.studyLatest(id, revision);
      this.plannerWriteAuthority(by, this.studyParent(original.parentTaskId));
      const before = this.studyReferences(original.parentTaskId, contract, id);
      this.studyRoundCheck(original, contract);
      const withheld = await this.withholds("note", JSON.stringify(contract), before.parent);
      requestCheck();
      const latest = this.studyLatest(id, revision), current = this.studyReferences(latest.parentTaskId, contract, id);
      this.plannerWriteAuthority(by, current.parent);
      if (latest.hash !== original.hash || current.key !== before.key) throw new PreEffectToolRefusal("study changed during revision screening");
      this.studyRoundCheck(latest, contract);
      const next: ResearchCampaignRecord = { id, project: this.d.project, parentTaskId: latest.parentTaskId, revision: revision + 1, status: "draft",
        contract, hash: campaignHash(contract), private: latest.private || current.private || withheld, createdBy: by, createdAt: this.studyTime() };
      let saved: ResearchCampaignRecord;
      requestCheck(); this.plannerWriteAuthority(by, current.parent);
      try { saved = this.d.board.saveResearchCampaignDraft(next, revision, current.parent.history.length); }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "study revision was not saved"); }
      this.releaseNotice(`study ${id} revision ${saved.revision} drafted`);
      return this.studyReceipt(saved);
    });
  }

  async studyApprove(by: PeerId, input: unknown): Promise<ResearchCampaignReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold());
    if (by !== USER) throw new PreEffectToolRefusal("study approval requires the person");
    const fields = this.studyFields(input, ["id", "revision"]), id = this.studyId(fields.id), revision = this.studyNumber(fields.revision, "revision");
    return this.studyWrite(async () => {
      const original = this.studyRecord(id, revision), parent = this.studyParent(original.parentTaskId);
      if (original.status === "approved") {
        const privacy = this.studyReplayPrivacy(original, parent); requestCheck();
        const replay = this.d.board.activateCampaign(id, revision, this.d.project, by, this.studyTime(), [], parent.history.length, privacy);
        return this.studyReceipt(replay.campaign, true);
      }
      this.studyLatest(id, revision);
      if (original.status !== "draft" || parent.draft) throw new PreEffectToolRefusal("study approval requires a draft and an approved parent input");
      this.studyEligibleOwners(original.contract);
      const before = this.studyReferences(parent.id, original.contract, id);
      let priv = original.private || before.private || await this.withholds("note", JSON.stringify(original.contract), parent);
      const prepared: PreparedResearchUnit[] = [];
      for (const unit of original.contract.units) {
        requestCheck();
        const reused = before.reused.get(unit.id);
        if (reused) { prepared.push({ unitId: unit.id, reuse: { taskId: reused.id, flowRevision: reused.history.length } }); continue; }
        const adopted = before.adopted.get(unit.id);
        if (adopted) { prepared.push({ unitId: unit.id, adopt: { taskId: adopted.id, flowRevision: adopted.history.length } }); continue; }
        const title = `Study unit ${unit.id}`, detail = `Study: ${id} unit ${unit.id}\nQuestion: ${unit.question}\nPerspective: ${unit.perspective}\nRequired output: ${unit.requiredOutput}\nSources: ${unit.sourceIds.join(", ")}`;
        priv ||= await this.withholds("task", detail, parent);
        const refs = cleanRefs(parent.refs), signals = [...new Set([...this.signalsFor({ title, detail, refs }), ...parent.signals.filter(signal => ["pii", "pii_path", "urgent"].includes(signal))])];
        prepared.push({ unitId: unit.id, create: { title, detail, class: parent.class, refs, signals,
          ...(parent.profile ? { profile: parent.profile } : {}), ...(parent.profileClass ? { profileClass: parent.profileClass } : {}),
        } });
      }
      requestCheck();
      const latest = this.studyLatest(id, revision), current = this.studyReferences(parent.id, original.contract, id);
      if (latest.hash !== original.hash || current.key !== before.key) throw new PreEffectToolRefusal("study changed during approval screening");
      const now = this.studyTime(), deadline = Date.parse(original.contract.stopPolicy.deadline);
      if (deadline <= now || deadline - now > 90 * 86_400_000) throw new PreEffectToolRefusal("study deadline must be in the next ninety days at approval");
      priv ||= latest.private || current.private;
      if (priv && [...current.adopted.values(), ...current.reused.values()].some(task => !this.isPii(task)))
        throw new PreEffectToolRefusal("a private study cannot retain a public task without changing its authority");
      for (const unit of prepared) if (unit.create) {
        if (priv && !unit.create.signals?.includes("pii")) unit.create.signals = [...(unit.create.signals ?? []), "pii"];
        const planner = this.proposalPlanner({ ...parent, ...unit.create, signals: unit.create.signals ?? [], refs: unit.create.refs ?? {}, draft: undefined, state: "backlog", owner: null, reviewer: null });
        unit.create.planner = planner.planner; unit.create.plannerReason = planner.plannerReason;
        this.warmRepository({ refs: unit.create.refs ?? {}, plan: unit.create.plan });
      }
      const mode = this.d.coordination?.();
      let result: ReturnType<Board["activateCampaign"]>;
      requestCheck();
      try { result = this.d.board.activateCampaign(id, revision, this.d.project, by, now, prepared, current.parent.history.length, priv, { eligibleOwners: this.studyEligibleOwners(original.contract) }); }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "study approval was not saved"); }
      for (const child of result.children) {
        this.incomingBacklog.add(child.id);
        if (mode !== undefined) this.coordinationModes.set(child.id, mode);
      }
      this.releaseNotice(`study ${id} revision ${revision} approved; ${result.bindings.length} units`);
      await this.studyReoffer(result.bindings.map(unit => unit.taskId));
      return this.studyReceipt(result.campaign, true);
    });
  }

  /**
   * A unit held only because a newer draft existed lost its queued offer at delivery. Once a revision is approved, each retained unit task whose offer was dropped, that still has
   * the same owner and has not been accepted, gets a fresh offer through the one offer path (`sendTask`), which re-runs `studyDispatchCheck`. The approval is already saved: a
   * refusal here is a notice, never a failure of the approval.
   */
  private async studyReoffer(taskIds: readonly number[]): Promise<void> {
    for (const taskId of taskIds) {
      let owner: PeerId | undefined;
      try { owner = this.d.board.researchDroppedOffer(taskId); } catch (e) { this.releaseNotice(`task #${taskId}: study dropped-offer record is unreadable: ${e instanceof Error ? e.message : String(e)}`); continue; }
      if (owner === undefined) continue;
      const task = this.d.board.get(taskId);
      // The record names an owner that no longer holds the unproposed task: it is stale, not a pending offer.
      if (!task || task.owner !== owner || task.state !== "proposed") { this.d.board.clearResearchDroppedOffer(taskId); continue; }
      try {
        await this.sendTask(task, { owner, ...(task.reviewer ? { reviewer: task.reviewer } : {}), trace: [] });
        this.d.board.clearResearchDroppedOffer(taskId);   // after the offer is published: a refusal keeps the record for the next approval
      } catch (e) { this.releaseNotice(`task ${this.publicTitle(task)}: could not re-offer after the study was approved: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  async studyClose(by: PeerId, input: unknown): Promise<ResearchCampaignReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold()); this.plannerWriteAuthority(by);
    const fields = this.studyFields(input, ["id", "revision", "reason"]), id = this.studyId(fields.id), revision = this.studyNumber(fields.revision, "revision");
    if (typeof fields.reason !== "string" || !fields.reason.trim() || Buffer.byteLength(fields.reason, "utf8") > 512) throw new PreEffectToolRefusal("study close needs a bounded reason");
    const reason = fields.reason;
    return this.studyWrite(async () => {
      const original = this.studyLatest(id, revision), parent = this.studyParent(original.parentTaskId);
      this.plannerWriteAuthority(by, parent);
      const withheld = await this.withholds("note", reason, parent);
      requestCheck();
      const latest = this.studyLatest(id, revision), currentParent = this.studyParent(latest.parentTaskId);
      this.plannerWriteAuthority(by, currentParent);
      if (latest.hash !== original.hash || currentParent.history.length !== parent.history.length) throw new PreEffectToolRefusal("study changed during close screening");
      const priv = this.studyReplayPrivacy(latest, currentParent) || withheld || !this.nameable(reason);
      let closed: ResearchCampaignRecord;
      requestCheck(); this.plannerWriteAuthority(by, currentParent);
      try { closed = this.d.board.closeCampaign(id, revision, this.d.project, by, this.studyTime(), reason, currentParent.history.length, priv); }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "study close was not saved"); }
      this.releaseNotice(`study ${id} revision ${revision} closed`);
      return this.studyReceipt(closed);
    });
  }

  private experimentHash(input: unknown): string { return createHash("sha256").update(canonicalJson(input)).digest("hex"); }

  private experimentId(input: unknown): string {
    if (typeof input !== "string" || !/^ra-[a-f0-9]{12}$/.test(input)) throw new PreEffectToolRefusal("experiment identity is invalid");
    return input;
  }

  private experimentProtocol(hash: string): ExperimentProtocolRecord {
    try {
      const record = this.d.board.experimentProtocol(hash);
      if (record?.project === this.d.project) return record;
    } catch { /* damaged records are never returned as evidence */ }
    throw new PreEffectToolRefusal("experiment protocol is unavailable in this project");
  }

  private experimentAttempt(id: string): ExperimentAttemptRecord {
    try {
      const record = this.d.board.experimentAttempt(id);
      if (record?.project === this.d.project) return record;
    } catch { /* fail closed without including any stored body */ }
    throw new PreEffectToolRefusal("experiment attempt is unavailable in this project");
  }

  private experimentContext(by: PeerId, taskId: number, protocol: ExperimentProtocolContract, recordedForTaskId = taskId): ExperimentContext {
    const task = this.studyParent(taskId), bound = this.d.board.researchDispatchBinding(taskId);
    if (task.owner !== by || task.state !== "in_progress") throw new PreEffectToolRefusal("experiment records require the current in-progress task owner");
    if (this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("a private turn cannot write experiment records on a public task");
    const campaign = bound?.campaign;
    // ponytail: new attempts against an older revision's protocol are refused; upgrade: explicit membership+source fence.
    if (!bound?.binding || !campaign || campaign.project !== this.d.project || campaign.id !== protocol.campaignId || campaign.revision !== protocol.campaignRevision || campaign.status !== "approved")
      throw new PreEffectToolRefusal("experiment task must be a unit of the protocol's current approved campaign revision");
    const recording = this.d.board.researchDispatchBinding(recordedForTaskId), origin = this.studyParent(recordedForTaskId);
    if (!recording?.binding || recording.campaign.id !== campaign.id || recording.campaign.revision !== campaign.revision || recording.campaign.status !== "approved")
      throw new PreEffectToolRefusal("experiment recording task is no longer a unit of this campaign");
    const sources = protocol.inputs.map(input => {
      const source = this.studySource(input.sourceId);
      if (!campaign.contract.sourceIds.includes(input.sourceId) || !source || source.sha256 !== input.sha256) throw new PreEffectToolRefusal("experiment input source identity or hash is unavailable in this campaign");
      return source;
    });
    let artifactPrivate = false;
    if ("deliverable" in protocol.code) {
      const reference = protocol.code.deliverable, artifact = latestDeliverables(origin.history)?.find(value => value.id === reference.id && value.sha256 === reference.sha256);
      if (!artifact) throw new PreEffectToolRefusal("experiment code deliverable identity is not recorded for its task");
      artifactPrivate = artifact.private === true;
    }
    const privateRecord = this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId)) || this.isPii(task) || this.isPii(origin) || artifactPrivate || sources.some(source => source.private);
    const fence: ExperimentWriteFence = { project: this.d.project, taskId, taskFlowRevision: task.history.length, owner: by,
      campaignId: campaign.id, campaignRevision: campaign.revision, campaignHash: campaign.hash };
    return { task, campaign, private: privateRecord, fence, key: JSON.stringify([fence, sources, privateRecord, origin.history.length, recording.binding]) };
  }

  private experimentFresh(before: ExperimentContext, by: PeerId, protocol: ExperimentProtocolContract, recordedForTaskId?: number): ExperimentContext {
    const current = this.experimentContext(by, before.task.id, protocol, recordedForTaskId);
    if (current.key !== before.key) throw new PreEffectToolRefusal("experiment authority, source or campaign changed during admission");
    return current;
  }

  private async experimentScreen(text: string, task: Task): Promise<void> {
    if (!this.isPii(task) && (!this.nameable(text) || looksSecret(text) || await this.withholds("note", text, task)))
      throw new PreEffectToolRefusal("experiment text was not cleared; nothing was recorded");
  }

  private experimentPlanContext(by: PeerId, taskId: number, plan: ComparisonPlanV1): ExperimentContext {
    const task = this.studyParent(taskId), bound = this.d.board.researchDispatchBinding(taskId), campaign = bound?.campaign;
    if (task.owner !== by || task.state !== "in_progress" || !bound?.binding || !campaign || campaign.project !== this.d.project
      || campaign.id !== plan.campaignId || campaign.status !== "approved")
      throw new PreEffectToolRefusal("comparison plans require the current in-progress campaign unit owner");
    if (this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("a private turn cannot write comparison plans on a public task");
    const sources = plan.fixed.inputs.map(input => {
      const source = this.studySource(input.sourceId);
      if (!campaign.contract.sourceIds.includes(input.sourceId) || !source || source.sha256 !== input.sha256)
        throw new PreEffectToolRefusal("comparison input source identity or hash is unavailable in this campaign");
      return source;
    });
    const privateRecord = this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId)) || this.isPii(task) || sources.some(source => source.private);
    const fence: ExperimentWriteFence = { project: this.d.project, taskId, taskFlowRevision: task.history.length, owner: by,
      campaignId: campaign.id, campaignRevision: campaign.revision, campaignHash: campaign.hash };
    return { task, campaign, private: privateRecord, fence, key: canonicalJson([fence, privateRecord, sources, bound.binding]) };
  }

  private experimentApproved(record: ExperimentProtocolRecord): boolean {
    const approval = this.d.board.experimentProtocolApproval(record.hash);
    return protocolApprovalBindingMatches(record.protocol, approval && { protocolHash: approval.protocolHash, evaluatorHash: approval.evaluatorHash });
  }

  /** Approval is an explicit person's decision about immutable bytes, including historical protocols. */
  async experimentApproveProtocol(by: PeerId, input: unknown): Promise<ProtocolApprovalReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold());
    if (by !== USER) throw new PreEffectToolRefusal("protocol approval is person only");
    const fields = this.studyFields(input, ["hash"]);
    if (typeof fields.hash !== "string" || fields.hash.length !== 64 || !/^[a-f0-9]{64}$/.test(fields.hash)) throw new PreEffectToolRefusal("protocol approval needs an exact protocol hash");
    const hash = fields.hash;
    return this.studyWrite(async () => {
      requestCheck();
      const record = this.experimentProtocol(hash), evaluatorHash = evaluatorIdentityHash(record.protocol);
      requestCheck();
      let saved;
      try { saved = this.d.board.approveExperimentProtocol(this.d.project, hash, evaluatorHash, by, this.studyTime()); }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "protocol approval was not saved"); }
      return { protocolHash: saved.protocolHash, evaluatorHash: saved.evaluatorHash, approvedBy: saved.approvedBy, approvedAt: saved.at };
    });
  }

  /** Record evidence only: this path never runs a check, a shell command or a runner. */
  async experimentRecord(by: PeerId, input: { kind: "plan"; [key: string]: unknown }): Promise<ComparisonPlanReceipt>;
  async experimentRecord(by: PeerId, input: { kind: "protocol" | "attempt" | "event" | "receipt"; [key: string]: unknown }): Promise<ExperimentReceipt>;
  async experimentRecord(by: PeerId, input: unknown): Promise<ExperimentReceipt | ComparisonPlanReceipt>;
  async experimentRecord(by: PeerId, input: unknown): Promise<ExperimentReceipt | ComparisonPlanReceipt> {
    const requestCheck = this.requestCheck(by, () => this.studyHold());
    const envelope = this.studyFields(input, ["kind", "taskId", "protocol", "attempt", "attemptId", "idempotencyKey", "event", "plan", "receipt", "signature"]);
    return this.studyWrite(async () => {
      try {
        if (envelope.kind === "receipt") {
          const fields = this.studyFields(input, ["kind", "receipt", "signature"]), receipt = parseAttemptReceipt(fields.receipt);
          const attempt = this.experimentAttempt(receipt.attemptId), record = this.experimentProtocol(attempt.attempt.protocolHash);
          const relayOwner = by === USER ? this.studyParent(attempt.attempt.taskId).owner : by;
          if (!relayOwner) throw new PreEffectToolRefusal("receipt relay requires a current task owner");
          const before = this.experimentContext(relayOwner, attempt.attempt.taskId, record.protocol, record.recordedForTaskId);
          requestCheck();
          const proof = (stored: NonNullable<ReturnType<Board["runnerReceipt"]>>): ExperimentReceipt => ({ kind: "receipt", protocolHash: record.hash,
            attemptId: attempt.attemptId, seq: stored.seq, receiptId: receipt.receiptId });
          const known = this.d.board.runnerReceipt(receipt.receiptId);
          if (known) {
            if (canonicalJson(known.receipt) !== canonicalJson(receipt) || known.signature !== fields.signature)
              throw new PreEffectToolRefusal("receiptId already records different signed bytes");
            this.experimentFresh(before, relayOwner, record.protocol, record.recordedForTaskId); requestCheck();
            return proof(known); // immutable stored proof: do not re-verify against a revoked/replaced registration or write on replay
          }
          const registrations = parseResearchRunners(this.d.researchRunners?.() ?? {}), registrationKey = canonicalJson(registrations);
          const context = { projectId: this.d.project, attempt: { id: attempt.attemptId, projectId: attempt.project, protocolHash: attempt.attempt.protocolHash,
            ...("commit" in record.protocol.code ? { codeCommit: record.protocol.code.commit } : {}) } };
          verifyAttemptReceipt(receipt, fields.signature, { ...context, runners: registrations });
          const lastSeq = this.d.board.experimentLastSeq(attempt.attemptId);
          await this.experimentScreen(canonicalJson(receipt), before.task); requestCheck();
          const current = this.experimentFresh(before, relayOwner, record.protocol, record.recordedForTaskId);
          const latest = parseResearchRunners(this.d.researchRunners?.() ?? {});
          if (canonicalJson(latest) !== registrationKey) throw new PreEffectToolRefusal("runner registration changed during receipt admission");
          verifyAttemptReceipt(receipt, fields.signature, { ...context, runners: latest }); requestCheck();
          const saved = this.d.board.appendRunnerReceipt({ receipt, signature: fields.signature as string, publicKey: latest[receipt.runner]!.publicKey,
            by, at: this.studyTime(), private: current.private || record.private || attempt.private }, lastSeq, current.fence);
          return proof(saved);
        }
        if (envelope.kind === "plan") {
          const fields = this.studyFields(input, ["kind", "taskId", "plan"]), taskId = this.studyNumber(fields.taskId, "taskId"), plan = parseComparisonPlan(fields.plan);
          const before = this.experimentPlanContext(by, taskId, plan);
          await this.experimentScreen(canonicalJson(plan), before.task); requestCheck();
          const current = this.experimentPlanContext(by, taskId, plan);
          if (current.key !== before.key) throw new PreEffectToolRefusal("comparison authority, source or campaign changed during admission");
          requestCheck();
          const saved = this.d.board.saveExperimentComparisonPlan({ hash: comparisonPlanHash(plan), project: this.d.project, recordedForTaskId: taskId,
            plan, by, at: this.studyTime(), private: current.private }, current.fence);
          return { kind: "plan", planHash: saved.hash };
        }
        if (envelope.kind === "protocol") {
          const fields = this.studyFields(input, ["kind", "taskId", "protocol"]), taskId = this.studyNumber(fields.taskId, "taskId"), protocol = parseExperimentProtocol(fields.protocol);
          const before = this.experimentContext(by, taskId, protocol);
          for (const reference of [protocol.variantOf, protocol.supersedes]) if (reference) {
            const previous = this.experimentProtocol(reference);
            if (previous.protocol.campaignId !== protocol.campaignId || reference === protocol.supersedes && previous.protocol.lineage !== protocol.lineage)
              throw new PreEffectToolRefusal("experiment protocol reference belongs to another campaign or lineage");
          }
          await this.experimentScreen(canonicalJson(protocol), before.task); requestCheck();
          const current = this.experimentFresh(before, by, protocol); requestCheck();
          const saved = this.d.board.saveExperimentProtocol({ hash: protocolHash(protocol), project: this.d.project, recordedForTaskId: taskId, protocol, by, at: this.studyTime(), private: current.private }, current.fence);
          return { kind: "protocol", protocolHash: saved.hash };
        }
        if (envelope.kind === "attempt") {
          const fields = this.studyFields(input, ["kind", "attempt"]), attempt = parseExperimentAttempt(fields.attempt), record = this.experimentProtocol(attempt.protocolHash);
          const before = this.experimentContext(by, attempt.taskId, record.protocol, record.recordedForTaskId);
          for (const reference of [attempt.retryOf, attempt.reproducesAttemptId]) if (reference) {
            const previous = this.experimentAttempt(reference), protocol = this.experimentProtocol(previous.attempt.protocolHash);
            if (protocol.protocol.campaignId !== record.protocol.campaignId) throw new PreEffectToolRefusal("attempt reference belongs to another campaign");
          }
          await this.experimentScreen(canonicalJson(attempt), before.task); requestCheck();
          const current = this.experimentFresh(before, by, record.protocol, record.recordedForTaskId); requestCheck();
          const saved = this.d.board.createExperimentAttempt({ attemptId: `ra-${randomBytes(6).toString("hex")}`, project: this.d.project, attempt, bodyHash: this.experimentHash(attempt), by, at: this.studyTime(), private: current.private || record.private }, current.fence);
          return { kind: "attempt", protocolHash: saved.attempt.protocolHash, attemptId: saved.attemptId };
        }
        if (envelope.kind === "event") {
          const fields = this.studyFields(input, ["kind", "attemptId", "idempotencyKey", "event"]), id = this.experimentId(fields.attemptId), key = fields.idempotencyKey;
          if (typeof key !== "string" || !key.trim() || key.length > 64 || Buffer.byteLength(key, "utf8") > 64 || Buffer.from(key, "utf8").toString("utf8") !== key) throw new PreEffectToolRefusal("event idempotencyKey needs at most 64 UTF-8 bytes");
          const attempt = this.experimentAttempt(id), record = this.experimentProtocol(attempt.attempt.protocolHash), event = parseExperimentEvent(fields.event, record.protocol);
          const before = this.experimentContext(by, attempt.attempt.taskId, record.protocol, record.recordedForTaskId), lastSeq = this.d.board.experimentLastSeq(id);
          await this.experimentScreen(canonicalJson([key, event]), before.task); requestCheck();
          this.experimentFresh(before, by, record.protocol, record.recordedForTaskId);
          const observations: ExperimentHostEvidence[] = [];
          let outputPrivate = event.kind === "output" && "path" in event.body ? this.experimentOutputPrivate(before.task, event.body.path) : false;
          if (event.kind === "end" && event.body.run && this.d.experimentCheck) {
            let receipt: unknown;
            try { receipt = await this.d.experimentCheck(event.body.run); } catch { /* unavailable is unknown */ }
            requestCheck(); this.experimentFresh(before, by, record.protocol, record.recordedForTaskId);
            const observation = checkRunObservation(receipt, event.body.run, before.task.id, record.protocol);
            if (observation) observations.push(observation);
          } else if (event.kind === "output" && "path" in event.body) {
            try {
              const measured = await hashDeliverables([event.body], this.deliverablePorts(before.task));
              const output = measured[0];
              if (output) { observations.push(deliverableObservation(output)); outputPrivate ||= output.private === true; }
            } catch { /* #509 refusal, missing or unreadable means unknown; never use a declared fallback hash */ }
            requestCheck(); this.experimentFresh(before, by, record.protocol, record.recordedForTaskId);
          }
          const current = this.experimentFresh(before, by, record.protocol, record.recordedForTaskId); requestCheck();
          if (event.kind === "output" && "path" in event.body) outputPrivate ||= this.experimentOutputPrivate(current.task, event.body.path);
          const saved = this.d.board.appendExperimentEvent(id, key, event, observations, by, this.studyTime(), current.private || record.private || attempt.private || outputPrivate, lastSeq, current.fence);
          return { kind: "event", protocolHash: record.hash, attemptId: id, seq: saved.event.seq };
        }
        throw new PreEffectToolRefusal("unsupported experiment record kind");
      } catch (error) {
        if (error instanceof PreEffectToolRefusal) throw error;
        throw new PreEffectToolRefusal(error instanceof Error ? error.message : "experiment record was not saved");
      }
    });
  }

  private runnerKeyStatus(stored: NonNullable<ReturnType<Board["runnerReceipt"]>>): "active" | "revoked" | "replaced" | "unavailable" {
    try {
      const runners = parseResearchRunners(this.d.researchRunners?.() ?? {});
      if (!Object.hasOwn(runners, stored.receipt.runner)) return "unavailable";
      const current = runners[stored.receipt.runner]!;
      if (current.publicKey !== stored.publicKey) return "replaced";
      if (current.revoked) return "revoked";
      return current.projects.includes(stored.receipt.projectId) ? "active" : "unavailable";
    } catch { return "unavailable"; }
  }

  private experimentPrivate(record: ExperimentProtocolRecord, attempt: ExperimentAttemptRecord): boolean {
    try {
      const campaign = this.d.board.researchCampaign(record.protocol.campaignId, record.protocol.campaignRevision), task = this.d.board.get(attempt.attempt.taskId);
      return record.private || attempt.private || !campaign || this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId)) || !task || this.isPii(task)
        || record.protocol.inputs.some(input => { const source = this.studySource(input.sourceId); return !source || source.private; });
    } catch { return true; }
  }

  async experimentShow(by: PeerId, input: unknown): Promise<ExperimentView> {
    return this.experimentRead(by, input);
  }

  private experimentRead(by: PeerId, input: unknown): ExperimentView {
    requireLocalTaskPeer(by);
    const fields = this.studyFields(input, ["attemptId", "campaignId", "after", "eventAfter", "limit", "planHash", "baselineAttemptId", "variantAttemptId"]);
    const cursor = (value: unknown, name: string) => value === undefined ? 0 : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : (() => { throw new PreEffectToolRefusal(`${name} must be a nonnegative integer`); })();
    const after = cursor(fields.after, "after"), eventAfter = cursor(fields.eventAfter, "eventAfter"), limit = fields.limit === undefined ? 50 : this.studyNumber(fields.limit, "limit");
    if (limit > 50) throw new PreEffectToolRefusal("experiment readback is limited to 50 rows");
    if (fields.planHash !== undefined || fields.baselineAttemptId !== undefined || fields.variantAttemptId !== undefined) {
      if (fields.attemptId !== undefined || fields.campaignId !== undefined || fields.after !== undefined
        || typeof fields.planHash !== "string" || fields.planHash.length !== 64 || !/^[a-f0-9]{64}$/.test(fields.planHash))
        throw new PreEffectToolRefusal("comparison readback needs one plan hash and two attempt ids");
      const plan = this.d.board.experimentComparisonPlan(fields.planHash);
      if (!plan || plan.project !== this.d.project) throw new PreEffectToolRefusal("comparison plan is unavailable in this project");
      const baseline = this.experimentAttempt(this.experimentId(fields.baselineAttemptId)), variant = this.experimentAttempt(this.experimentId(fields.variantAttemptId));
      const first = this.experimentProtocol(baseline.attempt.protocolHash), second = this.experimentProtocol(variant.attempt.protocolHash);
      if (first.protocol.campaignId !== plan.plan.campaignId || second.protocol.campaignId !== plan.plan.campaignId)
        throw new PreEffectToolRefusal("comparison attempts must belong to the plan's campaign");
      const left = this.experimentRead(by, { attemptId: baseline.attemptId, eventAfter, limit });
      const right = this.experimentRead(by, { attemptId: variant.attemptId, eventAfter, limit });
      let planPrivate = true;
      try {
        const campaign = this.studyRecord(plan.plan.campaignId);
        planPrivate = plan.private || this.studyReplayPrivacy(campaign, this.studyParent(campaign.parentTaskId))
          || plan.plan.fixed.inputs.some(input => { const source = this.studySource(input.sourceId); return !source || source.private; });
      } catch { /* an unavailable privacy classification withholds the comparison */ }
      const privateRecord = planPrivate || left.attempts.some(row => row.private) || right.attempts.some(row => row.private);
      return { attempts: [...left.attempts, ...right.attempts], counts: left.counts,
        comparison: { planHash: plan.hash, baselineAttemptId: baseline.attemptId, variantAttemptId: variant.attemptId,
          approved: this.experimentApproved(first) && this.experimentApproved(second), private: privateRecord,
          projection: privateRecord ? "[pii]" : comparisonProjection(plan.plan, first.protocol, second.protocol) } };
    }
    let campaignId: string, attempts: ExperimentAttemptRecord[], nextCursor: number | undefined;
    if (fields.attemptId !== undefined) {
      if (fields.campaignId !== undefined || fields.after !== undefined) throw new PreEffectToolRefusal("choose one attempt or campaign page");
      const attempt = this.experimentAttempt(this.experimentId(fields.attemptId));
      campaignId = this.experimentProtocol(attempt.attempt.protocolHash).protocol.campaignId; attempts = [attempt];
    } else {
      campaignId = this.studyId(fields.campaignId); this.studyRecord(campaignId);
      const page = this.d.board.experimentAttempts(this.d.project, campaignId, after, limit); attempts = page.rows;
      if (!page.done) nextCursor = page.afterRow;
    }
    const summary = this.d.board.experimentSummary(this.d.project, campaignId), views: ExperimentAttemptView[] = [];
    for (const attempt of attempts) {
      const record = this.experimentProtocol(attempt.attempt.protocolHash), page = this.d.board.experimentEvents(attempt.attemptId, eventAfter, limit);
      const runnerReceipts = this.d.board.runnerReceipts(attempt.attemptId);
      const privateRecord = this.experimentPrivate(record, attempt) || page.rows.some(row => row.private)
        || runnerReceipts.some(row => row.private || !this.nameable(canonicalJson(row.receipt)) || looksSecret(canonicalJson(row.receipt)));
      const status = this.d.board.experimentAttemptStatus(attempt.attemptId);
      const observations = page.rows.flatMap(row => row.observations), events = page.rows.map(row => row.event);
      const evidence = { ...projectExperimentWithObservations(record.protocol, events, observations),
        ...(runnerReceipts.length ? { runnerAttested: runnerReceipts.map(row => ({ ...projectRunnerReceipt(record.protocol, row.receipt), key: { hash: row.keyHash, status: this.runnerKeyStatus(row) } })) } : {}) };
      views.push({ id: attempt.attemptId, protocolHash: record.hash, taskId: attempt.attempt.taskId, phase: attempt.attempt.phase, status, private: privateRecord,
        campaignRevision: record.protocol.campaignRevision, approval: this.experimentApproved(record) ? "approved" : "unapproved",
        postHoc: this.d.board.experimentProtocolContext(record.hash).state,
        ...(attempt.attempt.retryOf ? { retryOf: attempt.attempt.retryOf } : {}), ...(attempt.attempt.reproducesAttemptId ? { reproducesAttemptId: attempt.attempt.reproducesAttemptId } : {}), independentlyReproduced: false,
        protocol: { value: privateRecord ? "[pii]" : record.protocol, provenance: "declared" },
        events: page.rows.map(row => privateRecord ? { seq: row.event.seq, kind: row.event.kind, at: row.event.at, provenance: row.event.provenance, body: "[pii]" } : row.event),
        evidence: privateRecord ? { declared: "[pii]", measured: evidence.measured.map(row => ({ eventSeq: row.eventSeq, source: row.source, provenance: "host-observed", values: "[pii]" })), ...(runnerReceipts.length ? { runnerAttested: runnerReceipts.map(() => ({ provenance: "runner-attested", values: "[pii]" })) } : {}) } : evidence,
        eventsComplete: page.done, ...(!page.done ? { nextEventCursor: page.afterSeq } : {}) });
    }
    return { attempts: views, counts: { all: summary.total, statuses: summary.statuses }, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  /** Every new host proposal, including split children, consumes the same pure walk before its first notification. */
  private proposalPlanner(task: Task): PlannerBinding {
    const choice = assign({ ...task, state: "proposed" }, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [] });
    return { planner: this.isPii(task) ? null : choice.planner ?? null, plannerReason: this.isPii(task) ? "none" : choice.plannerReason ?? "none" };
  }

  private plannerBinding(task: Task, assignment: Assignment, bindNull = false): PlannerBinding | undefined {
    if (bindNull && task.planner == null) return { planner: this.isPii(task) ? null : assignment.planner ?? null, plannerReason: assignment.plannerReason ?? "none" };
    return task.planner && this.plannerHolders().includes(task.planner) ? { planner: task.planner, plannerReason: "kept" } : undefined;
  }

  private planAuthor(task: Task): PeerId | null {
    // Review scope bookkeeping preserves the existing plan-content author.
    const authored = task.history.findLast(entry => entry.event !== "plan reviewed" && entry.planRevision !== undefined)
      ?? task.history.findLast(entry => entry.event !== "plan reviewed" && (entry.planning?.fields as readonly string[] | undefined)?.includes("plan"));
    if (authored && authored !== task.history[0]) return authored.by;
    return ALL_PLAN_KEYS.some(key => !!task.plan?.[key]?.length) ? authored?.by ?? task.history[0]?.by ?? null : null;
  }

  private planReviewAuthority(by: PeerId, task: Task): { planAuthor: PeerId | null; selfReview?: true } {
    this.plannerWriteAuthority(by); // Independent settled holders have review authority only, not the task's other planner powers.
    const author = this.planAuthor(task);
    const independent = this.plannerHolders().filter(peer => peer !== author && this.d.bus.stateOf(peer) !== "offline");
    if (by !== USER && by === author && independent.length) throw new PreEffectToolRefusal("an independent planner reviews this plan");
    return { planAuthor: author, ...(by === author ? { selfReview: true as const } : {}) };
  }

  private requestIndependentPlanReview(task: Task): void {
    const author = this.planAuthor(task);
    if (!author || !this.taskPlanner(task).includes(author)) return;
    const planners = this.plannerHolders().filter(peer => peer !== author && this.d.bus.stateOf(peer) !== "offline");
    if (!planners.length) return;
    const selected = assign({ ...task, state: "proposed" }, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [], planners, keptPlanner: undefined }).planner;
    if (!selected) return;
    const revision = task.planningRevision ?? 0, signature = `${revision}:${author}:${selected}`;
    if (this.planReviewRequests.get(task.id) === signature) return;
    const view = this.publicView(task);
    const queued = this.d.bus.publish(newEnvelope(HUB, `Independent plan review requested for task #${view.id}, revision ${revision}. Record hub_plan_review for that revision.`, {
      to: [selected], kind: "task", refs: { task: String(task.id), planReview: revision, planReviewFlow: task.history.length, planAuthor: author }, ...(this.isPii(task) ? { private: true } : {}),
    }));
    if (queued.includes(selected)) this.planReviewRequests.set(task.id, signature);
  }

  wipLimit(peer: PeerId): number {
    const limit = this.d.wipLimit?.(peer) ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 32) throw new PreEffectToolRefusal("invalid planner WIP capacity");
    return limit;
  }
  private plannerPullRecord(task: Task): HistoryEntry["planning"] {
    return task.history.findLast(entry => entry.event === "backlog pulled" || entry.event === "backlog returned")?.planning;
  }
  private hasPersonReservation(task: Task): boolean {
    const reservation = task.history.findLast(entry => entry.event === "reserved" || entry.planning?.fields.includes("reserved") && !["backlog pulled", "backlog returned"].includes(entry.event)) ?? (task.history[0]?.event === "backlogged" ? task.history[0] : undefined);
    return !!task.reserved && reservation?.by === USER;
  }
  wip(peer: PeerId, except?: number): number {
    return this.d.board.plannerWip(peer, except);
  }

  /** Host-observed task branch/root binding (#845), never a tool-call branch claim or an execution grant. */
  bindShellBranch(peer: PeerId, id: number, binding: TaskShellBinding & { worktree: string }, current: () => boolean): boolean {
    requireLocalTaskPeer(peer);
    try {
      if (!Number.isSafeInteger(id) || id < 1 || !taskShellBindingValid(binding) || !this.publicMetadataText(binding.branch)
        || !current() || this.d.privateTurn?.(peer)) return false;
      const task = this.d.board.get(id), root = this.d.executionRoot?.(peer);
      if (!task || task.owner !== peer || !["in_progress", "changes_requested"].includes(task.state) || this.isPii(task)
        || !root || realPath(root) === realPath(this.d.cwd) || realPath(root) !== realPath(binding.worktree)) return false;
      const worktree = createHash("sha256").update(realPath(root)).digest("hex");
      const previous = task.history.findLast(entry => entry.by === HUB && entry.event === "shell branch bound");
      if (previous) {
        const saved: unknown = JSON.parse(previous.note ?? "");
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
        const record = saved as Record<string, unknown>;
        if (record.branch !== binding.branch || record.worktree !== worktree) return false;
      }
      if (task.refs.branch !== undefined && task.refs.branch !== binding.branch) return false;
      const scope = this.repositories.scope(task.refs);
      const others = this.d.board.list().filter(row => row.id !== id && !isClosedTaskState(row.state))
        .map(row => ({ row, scope: this.repositories.scope(row.refs) }));
      if (scope.key !== this.repositories.project.key || others.some(other => other.scope.key === scope.key && other.row.refs.branch === binding.branch)) return false;
      if (!current() || this.d.privateTurn?.(peer) || this.d.board.get(id)?.history.length !== task.history.length) return false;
      if (previous) return true;
      let recorded = false;
      this.releaseNotice(`task #${id}: execution branch binding unavailable`, () => {
        this.d.board.update(id, HUB, "shell branch bound", { refs: { branch: binding.branch } }, JSON.stringify({ branch: binding.branch, worktree }), {}, task.history.length);
        recorded = true;
      });
      return recorded;
    } catch { return false; }
  }
  private capacityBefore(task: Task): Map<PeerId, number> {
    return new Map([...new Set([task.owner, task.reserved])].filter((peer): peer is PeerId => !!peer).map(peer => [peer, this.wip(peer)]));
  }

  /** Write-driven wake-ups (#785): one unsettled ids-only task notice per planner, never a polling pull. */
  private writePlannerNotices(task: Task, before: ReadonlyMap<PeerId, number>, approved = false): void {
    this.releaseNotice(`task #${task.id}: could not notify planner about ready work`, () => {
      const changes = new Map<PeerId, { capacity: Set<PeerId>; ready: Set<number> }>();
      const add = (planner: PeerId, peer?: PeerId, id?: number) => {
        if (!this.d.bus.isRostered(planner)) return;
        const change = changes.get(planner) ?? { capacity: new Set<PeerId>(), ready: new Set<number>() };
        if (peer) change.capacity.add(peer);
        if (id !== undefined) change.ready.add(id);
        changes.set(planner, change);
      };
      const released = new Set<PeerId>();
      for (const [peer, used] of before) if (this.wip(peer) < used) { released.add(peer); for (const planner of this.taskPlanner(task)) add(planner, peer); }
      if (approved) for (const card of this.d.board.list("backlog")) {
        if (card.deps?.includes(task.id) && !this.waitsFor(card).length) for (const planner of this.taskPlanner(card)) add(planner, undefined, card.id);
      }
      for (const [planner, change] of changes) this.releaseNotice(`could not notify planner ${planner} about ready work`, () => {
        const pending = this.d.bus.pendingEnvelopes(planner).filter(env => env.from === HUB && env.kind === "task" && env.body.startsWith("Planner work ready:"));
        // The bus retains these hub-written lines across restart; an in-memory cache would lose unsettled events.
        for (const env of pending) for (const line of env.body.split("\n")) {
          const capacity = /^capacity_released: (\S+) WIP \d+; reserved ready (?:#\d+|none)$/.exec(line);
          if (capacity) change.capacity.add(capacity[1]!);
          const ready = /^backlog_ready: #(\d+)$/.exec(line);
          if (ready && Number.isSafeInteger(Number(ready[1]))) change.ready.add(Number(ready[1]));
        }
        const lines: string[] = [];
        for (const peer of change.capacity) {
          const top = this.topReservedReady(peer, planner);
          lines.push(`capacity_released: ${peer} WIP ${this.wip(peer)}; reserved ready ${top ? `#${top.id}` : "none"}`);
        }
        for (const id of change.ready) {
          const card = this.d.board.get(id);
          if (card?.state === "backlog" && this.taskPlanner(card).includes(planner) && !this.waitsFor(card).length) lines.push(`backlog_ready: #${id}`);
          else change.ready.delete(id);
        }
        for (const env of pending) this.d.bus.withdraw(env.id);
        const env = newEnvelope(HUB, sanitize(`Planner work ready:\n${lines.join("\n")}\nRead the current board before planning or pulling work.`), { to: [planner], kind: "task" });
        if (!this.d.bus.publish(env).includes(planner)) throw new Error("the notice was not queued");
      });
      // #785 P1c: only this write's own release, never a merged earlier one, and only when the person turned it on.
      if (this.d.autoPull?.() === true) this.queueAutoPulls(released);
    });
  }

  /** The top card explicitly reserved for `peer` that this planner may pull now; the notice and the opt-in pull read the same rule. `pullable` keeps the staged backlog cards only. */
  private topReservedReady(peer: PeerId, planner?: PeerId, pullable = false): Task | undefined {
    return this.d.board.list().filter(card => (pullable ? card.state === "backlog" : ["backlog", "proposed"].includes(card.state)) && !card.owner && card.reserved === peer
      && (planner === undefined || this.taskPlanner(card).includes(planner)) && !(pullable && this.isPii(card)) && !card.pinned && !card.draft && taskCanPlan(card) && !this.waitsFor(card).length && !this.excluded(card).includes(peer)
      && (card.release == null || ["planning", "active"].includes(this.d.board.release(card.release)?.state ?? ""))).sort(this.readyOrder)[0];
  }

  /**
   * #785 P1c: `tasks.auto_pull`. A slot freed for a peer pulls the one top backlog card explicitly reserved for it, through `pullPlanned` as the hub acting for that card's planner of
   * record: revision, dependency, reservation, pinned, frozen-release, P0 order and WIP checks all run there unchanged. One card per release. Never an unreserved card, never PII.
   * Serialized on one chain, so two releases cannot pick the same card; each job re-reads the board, so a card that moved meanwhile is skipped.
   */
  private autoPulls: Promise<void> = Promise.resolve();
  private autoPullsOpen = 0;
  /** Queued or running auto pulls, so a recovery commit waits for them the way it waits for `checksPending` (#785 P1c): one that is mid-admission would otherwise write after the commit's digest. */
  autoPullsPending = (): number => this.autoPullsOpen;
  private queueAutoPulls(released: ReadonlySet<PeerId>): void {
    for (const peer of released) {
      this.autoPullsOpen++;
      this.autoPulls = this.autoPulls.then(() => this.autoPull(peer)).catch(() => { /* autoPull reports its own refusals */ }).finally(() => { this.autoPullsOpen--; });
    }
  }
  /** Whether the hub may still start work on its own: the setting is on, and no recovery, shutdown or storage hold is active. Read at entry and again right before the assignment write. */
  private autoPullAdmitted(): boolean {
    return this.d.autoPull?.() === true && !this.d.sweepHeld?.() && !this.d.bus.isRecoveryHeld && !this.d.bus.storageError;
  }
  private async autoPull(peer: PeerId): Promise<void> {
    if (!this.autoPullAdmitted()) return;
    const card = this.topReservedReady(peer, undefined, true);
    if (!card) return;
    // The planner of record is the card's own: its bound planner, else the first current holder, and it must be rostered. A private card never gets here (topReservedReady skips it).
    const planner = this.taskPlanner(card)[0];
    if (!planner || !this.d.bus.isRostered(planner)) return;
    const reason = `auto_pull: capacity released for ${peer}; hub acted for planner ${planner}`;
    try {
      await this.pullPlanned(HUB, { id: card.id, revision: card.planningRevision ?? 0, reason }, { onBehalfOf: planner, guard: () => { if (!this.autoPullAdmitted()) throw new PreEffectToolRefusal("auto pull is no longer admitted: tasks.auto_pull was turned off or a recovery, shutdown or storage hold began"); } });
    } catch (e) {
      // A guard refusal is the setting or a hold doing its job, not a failure to report.
      if (!this.autoPullAdmitted()) return;
      this.releaseNotice(`task ${this.publicTitle(card)}: auto_pull for ${peer} refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** #784 AC3: the read-only breakdown of `wip` for status, the console and the dashboard: one grouped query for every peer. Admission still reads `wip()`. */
  wipBreakdown(peers: readonly PeerId[]): Record<string, { wip: number; active: number; reviewWait: number; reserved: number; wipLimit: number }> {
    const grouped = this.d.board.plannerWipBreakdown();
    return Object.fromEntries(peers.map(peer => {
      const row = grouped[peer] ?? { active: 0, reviewWait: 0, reserved: 0 };
      return [peer, { wip: row.active + row.reviewWait + row.reserved, ...row, wipLimit: this.wipLimit(peer) }];
    }));
  }
  private prerequisiteOf(task: Task, prerequisite: number): boolean {
    const pending = [...(task.deps ?? [])], seen = new Set<number>();
    while (pending.length) { const id = pending.pop()!; if (id === prerequisite) return true; if (seen.has(id)) continue; seen.add(id); pending.push(...(this.d.board.get(id)?.deps ?? [])); }
    return false;
  }
  private plannerFull(task: Task): PeerId[] {
    return Object.keys(this.states()).filter(peer => { const queue = this.d.bus.queueSummary(peer); return this.wip(peer, task.id) >= this.wipLimit(peer) || !!queue.heldBy || queue.needsReview > 0; });
  }
  /**
   * Why a planner pull finds no owner (#531), named from what the assignment saw and never from task text: the peers a
   * lasting exclusion keeps out, a peer at its WIP limit (with wip/limit), a held queue and needs_review. Peer ids and counts
   * only, so the text is safe for a PII task too. `route explain` reads the same `excluded()` and `plannerFull` inputs.
   */
  plannerRefusal(task: Task): string {
    const parts: string[] = [];
    const excluded = [...new Set(this.excluded(task))];
    const pressure = this.queueRouting(Object.keys(this.states()));
    if (excluded.length) parts.push(`${excluded.join(", ")} declined or was escalated away from this task for good; only a person's ahub task assign lifts that`);
    for (const peer of Object.keys(this.states())) {
      if (excluded.includes(peer)) continue;
      const queue = this.d.bus.queueSummary(peer), wip = this.wip(peer, task.id), limit = this.wipLimit(peer);
      if (wip >= limit) parts.push(`${peer} WIP full (${wip}/${limit}); no eligible planner WIP capacity`);
      else if (queue.heldBy) parts.push(`${peer} has a held queue (a delivery is held; resolve it with ahub queue list)`);
      else if (queue.needsReview > 0) parts.push(`${peer} has ${queue.needsReview} delivery(ies) in needs_review`);
      const refusal = queueBackpressure(peer, pressure.queueBackpressure, peerEntry(pressure.queues, peer), pressure.now ?? NaN);
      if (refusal) parts.push(`${peer} ${refusal.reason}`);
    }
    return parts.length ? `no peer can take the planner pull: ${parts.join("; ")}` : "no peer has eligible planner WIP capacity";
  }
  private plannerAssignment(task: Task, reservedOnly = false, routing: Routing = this.d.routing(), queueOverride?: "owner", projectedHealth?: ReturnType<Tasks["health"]>): Assignment {
    const states = this.states();
    const full = this.plannerFull(task);
    // Preview the To Do transition without routing or offering the persisted backlog row.
    return assign({ ...task, state: "proposed" }, states, routing, { exclude: this.excluded(task), excludeOwners: [...full, ...this.studyExcludedOwners(task)], ...(reservedOnly && task.reserved ? { candidates: [task.reserved], namedOwner: task.reserved } : {}), waitsFor: this.waitsFor(task), ...this.weights(task.class, task, projectedHealth), ...(queueOverride ? { queueOverride, contextOverride: true } : {}) });
  }

  async pullPlanned(by: PeerId, input: { id: number; revision: number; reason: string }, opts: { onBehalfOf?: PeerId; guard?: () => void } = {}): Promise<Task> {
    // #455: one authority check, made before the screen and again after it (a person may move the planner meanwhile).
    // #785 P1c: `by` is the actor the history records; the hub's opt-in auto pull names the planner it acts for, and that planner's authority is what is checked.
    if (opts.onBehalfOf !== undefined && by !== HUB) throw new PreEffectToolRefusal("only the hub pulls on a planner's behalf");
    const planner = opts.onBehalfOf ?? by;
    let queueAssignment: { current: () => void } | undefined;
    // `opts.guard` (the auto pull's own admission, #785 P1c) throws a PreEffectToolRefusal once the pull is no longer wanted; it runs wherever authority is rechecked, so it
    // also runs after the awaited PII screen and right before the assignment write, where a setting turned off or a recovery that began meanwhile must still stop it.
    const authorized = () => { this.planningAuthority(planner); opts.guard?.(); queueAssignment?.current(); };
    authorized();
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("planner pull needs an id, revision and bounded reason");
    queueAssignment = by !== HUB && opts.onBehalfOf === undefined && this.d.board.get(input.id)?.reserved
      ? this.explicitQueueAssignment(by, "owner", true) : undefined;
    queueAssignment?.current();
    const validate = () => {
      const task = this.d.board.get(input.id);
      if (task?.draft) throw new PreEffectToolRefusal(`task #${task.id} is an intake draft; the person approves it first`);
      if (!task || (task.planningRevision ?? 0) !== input.revision || task.state !== "backlog" || task.owner || !taskCanPlan(task) || task.pinned) throw new PreEffectToolRefusal("planner pull changed, pinned or already started");
      this.planningAuthority(planner, task);
      const release = task.release == null ? undefined : this.d.board.release(task.release);
      if (task.release != null && (!release || ["frozen", "shipped", "dropped"].includes(release.state))) throw new PreEffectToolRefusal("planner pull requires unfrozen release scope");
      if (this.waitsFor(task).length) throw new PreEffectToolRefusal("planner pull waits for dependency approval");
      const priority = task.priority ?? (task.signals.includes("urgent") ? 0 : 2);
      if (priority === 0) {
        const goals = this.d.board.list().filter(goal => !isClosedTaskState(goal.state) && (goal.priority ?? (goal.signals.includes("urgent") ? 0 : 2)) === 0 && goal.rank != null && goal.history.some(entry => entry.by === USER && entry.planning?.fields.includes("rank")));
        const effectiveOrder = (candidate: Task) => goals.filter(goal => goal.id === candidate.id || this.prerequisiteOf(goal, candidate.id)).map(goal => ({ rank: goal.rank!, id: goal.id })).sort((a,b) => a.rank-b.rank || a.id-b.id)[0];
        const order = effectiveOrder(task) ?? { rank: task.rank ?? Number.MAX_SAFE_INTEGER, id: task.id };
        if (this.d.board.list("backlog").some(other => {
          if (other.id === task.id || this.prerequisiteOf(other, task.id) || (other.priority ?? (other.signals.includes("urgent") ? 0 : 2)) !== 0) return false;
          const competing = effectiveOrder(other);
          return !!competing && (competing.rank < order.rank || competing.rank === order.rank && competing.id < order.id);
        })) throw new PreEffectToolRefusal("a person's P0 backlog order is retained");
      }
      if (task.reserved && this.excluded(task).includes(task.reserved)) throw new PreEffectToolRefusal(this.plannerRefusal(task));
      const assignment = this.plannerAssignment(task, !!task.reserved, this.d.routing(), queueAssignment ? "owner" : undefined);
      if (!assignment.owner) {
        const refusal = task.reserved ? `reserved peer ${task.reserved} cannot take the planner pull: ${assignment.refusals?.find(row => row.role === "owner" && row.peer === task.reserved)?.reason ?? "not eligible"}; ${this.plannerRefusal(task)}` : this.plannerRefusal(task);
        throw new PreEffectToolRefusal(`${this.hasPersonReservation(task) ? "a person's reservation is retained; " : ""}${refusal}`);
      }
      this.studyDispatchCheck(task, assignment.owner);
      return { task, owner: assignment.owner, assignment };
    };
    const initial = validate(), withheld = await this.withholds("note", input.reason, initial.task);
    authorized();
    const current = validate();
    if (current.task.reserved) {
      return this.assignOwner(current.task, by, { candidates: [current.owner], namedOwner: current.owner, planner: true, refuseNamed: "pre", ...(queueAssignment ? { queueOverride: "owner" as const, current: queueAssignment.current } : {}),
        plannerPull: { revision: input.revision, note: input.reason.trim(), withheld, guard: () => {
          authorized();
          const checked = validate();
          if (checked.task.history.length !== current.task.history.length || checked.owner !== current.owner) throw new PreEffectToolRefusal("planner pull changed during admission");
        } } });
    }
    opts.guard?.();
    this.studyDispatchCheck(current.task, current.owner);
    const pulled = this.d.board.pullPlanned(current.task.id, by, current.owner, input.revision, input.reason.trim(), withheld, this.plannerBinding(current.task, current.assignment, true));
    this.planningRecorded({ by, task: pulled.id, fields: ["pull", "reserved"], revision: pulled.planningRevision! });
    return pulled;
  }

  backlogList(by: PeerId): Record<string, unknown>[] {
    this.planningAuthority(by);
    return this.d.board.list("backlog").sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id).map(task => this.publicView(task));
  }
  private addPlannerBacklog(peer: PeerId, ids: readonly number[]): void {
    if (!this.d.roles?.[peer]?.includes("planner")) return;
    const pending = this.plannerBacklog.get(peer) ?? new Set<number>();
    for (const id of ids) {
      const task = this.d.board.get(id);
      if (task?.state === "backlog" && !task.draft && this.taskPlanner(task).includes(peer)) pending.add(id);
    }
    if (pending.size) this.plannerBacklog.set(peer, pending);
  }
  /**
   * The planner "board changed" notice (#758). Read only what was added to a card's history since the last scan, and tell each attached planner of
   * what it did not write itself and plans (`taskPlanner`, the #525-2 scoping): a planning revision or dependency change (in or outside a
   * `planning` entry) or the creation of a card is a task notice, replacing a copy that
   * is still unsettled so the planner meets the latest revision once; a state move, review or assignment is recorded at `fyi` weight (no turn),
   * at most once per planner per ten minutes. The hub's own bookkeeping entries tell nobody. A planner with no earlier notice gets one task notice
   * (a restart, or the first one after it was attached), as before.
   */
  private groomNotices(configured: readonly PeerId[], planners: readonly PeerId[]): void {
    const scan = this.groomScan, revision = this.d.board.statusRevision(), first = scan.revision < 0;
    if (scan.revision !== revision) {
      for (const task of this.d.board.list()) {
        const seen = scan.lengths.get(task.id), depsKey = JSON.stringify(task.deps ?? []), depsBefore = scan.deps.get(task.id);
        scan.lengths.set(task.id, task.history.length); scan.deps.set(task.id, depsKey);
        if (first || seen === task.history.length && depsBefore === depsKey) continue;
        const holders = this.taskPlanner(task);
        const tell = (author: string, review: boolean) => {
          for (const holder of configured) {              // every configured planner, so a change made while one was offline is not lost
            if (holder === author || !holders.includes(holder)) continue;
            const pending = scan.pending.get(holder) ?? { review: false, other: false };
            if (review) pending.review = true; else pending.other = true;
            scan.pending.set(holder, pending);
          }
        };
        // A card's creation (a propose, with or without `after`, a split child, a generated card) is new work to consolidate, so it needs a plan review.
        if (seen === undefined) tell(task.history[0]?.by ?? HUB, true);
        for (const entry of seen === undefined ? task.history.slice(1) : task.history.slice(seen)) {
          if (entry.by === HUB && entry.planning === undefined) continue;   // the hub's own bookkeeping (lifecycle links, sweeps, holds) is not a board change to tell anyone about
          tell(entry.by, entry.planning !== undefined);
        }
        // Dependencies changed outside a `planning` entry (a propose with `after`, a split, any other write): the same as a planning change.
        // Its author is the last entry's only when this scan saw a new entry; a write with no entry has no known author, so no planner is skipped.
        if (depsBefore !== undefined && depsBefore !== depsKey) tell(seen !== undefined && seen < task.history.length ? task.history.at(-1)!.by : "", true);
      }
      scan.revision = revision;
    }
    const now = this.d.now?.() ?? Date.now();
    const configuredFyiMin = this.d.groomFyiWindowMin?.();
    const fyiWindowMs = configuredFyiMin === undefined ? GROOM_FYI_WINDOW_MS : configuredFyiMin * 60_000;
    for (const peer of planners) {
      const told = scan.sent.get(peer), pending = scan.pending.get(peer);
      const review = told === undefined || pending?.review === true;
      if (!review && !pending?.other) continue;
      if (!review && now - told!.fyiAt < fyiWindowMs) { scan.pending.delete(peer); continue; }
      this.releaseNotice(`could not notify planner ${peer} about grooming`, () => {
        if (review) this.sendGroomNotice(peer, revision);
        else this.d.bus.publish(newEnvelope(HUB, `${GROOM_NOTICE_PREFIX} (revision ${revision}): state moves, reviews or assignments only. No plan review is needed.`, { to: [peer], kind: "task", priority: "fyi" }));
        scan.pending.delete(peer);
        scan.sent.set(peer, { fyiAt: review ? told?.fyiAt ?? 0 : now });
      });
    }
  }

  /** The task-weight notice: an unsettled earlier copy for this planner is withdrawn and replaced, never a second one queued. */
  private sendGroomNotice(peer: PeerId, revision: number): void {
    const body = `${GROOM_NOTICE_PREFIX} (revision ${revision}). Before offering or accepting build work, read hub_planner_groom, consolidate dependencies and priorities, and record hub_plan_review against the current planning revision.`;
    for (const old of this.d.bus.pendingEnvelopes(peer)) if (old.from === HUB && old.kind === "task" && old.body.startsWith(GROOM_NOTICE_PREFIX)) this.d.bus.withdraw(old.id);
    const recipients = this.d.bus.publish(newEnvelope(HUB, body, { to: [peer], kind: "task" }));
    if (!recipients.includes(peer)) throw new Error("the notice was not queued");
  }

  /** One bounded ids-only batch per attached planner; failed or evicted copies stay pending. */
  flushPlannerNotices(): number {
    const configured = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && roles.includes("planner")).map(([peer]) => peer);
    for (const peer of this.knownPlanners) if (!configured.includes(peer)) {
      this.knownPlanners.delete(peer); this.plannerBacklog.delete(peer); this.plannerBlockedQueue.delete(peer);
      this.groomScan.pending.delete(peer); this.groomScan.sent.delete(peer);
    }
    for (const peer of configured) if (!this.knownPlanners.has(peer)) {
      this.knownPlanners.add(peer);
      const retained = this.d.bus.queuedBacklogIds(peer);
      this.addPlannerBacklog(peer, this.d.board.list("backlog").filter(task => !retained.has(task.id)).map(task => task.id));
    }
    const planners = configured.filter(peer => this.d.bus.isRostered(peer) && this.d.bus.peers.has(peer) && this.d.bus.stateOf(peer) !== "offline");
    if (!planners.length) return 0;
    if ((this.d.sdlc?.config().mode ?? "off") !== "off") this.groomNotices(configured, planners);
    for (const id of this.incomingBacklog) if (this.d.board.get(id)?.state !== "backlog") this.incomingBacklog.delete(id);
    const incoming = [...this.incomingBacklog].sort((a, b) => a - b).slice(0, 64);
    if (incoming.length) {
      for (const peer of configured) {
        const queued = this.d.bus.queuedBacklogIds(peer);
        this.addPlannerBacklog(peer, incoming.filter(id => !queued.has(id)));
      }
    }
    for (const id of incoming) this.incomingBacklog.delete(id);
    const notified = new Set<number>();
    for (const peer of planners) {
      const pending = this.plannerBacklog.get(peer);
      if (!pending) continue;
      for (const id of pending) {
        const task = this.d.board.get(id);
        if (task?.state !== "backlog") pending.delete(id);
        else if (!this.taskPlanner(task).includes(peer)) {
          pending.delete(id);
          for (const recipient of this.taskPlanner(task)) this.addPlannerBacklog(recipient, [id]);
        }
      }
      const blockedQueue = this.plannerBlockedQueue.get(peer);
      if (blockedQueue !== undefined && blockedQueue === JSON.stringify(this.d.bus.queueIds(peer))) continue;
      this.plannerBlockedQueue.delete(peer);
      const ids = [...pending].sort((a, b) => a - b).slice(0, 64);
      if (!ids.length) continue;
      // Remove before publish: an immediate overflow callback may put this recipient's ids back.
      for (const id of ids) pending.delete(id);
      try {
        const queued = this.d.bus.publish(newEnvelope(HUB, `Backlog items ${ids.map(id => `#${id}`).join(", ")}. Read hub_backlog_list and plan the next work with a reason for each change.`, { to: [peer], kind: "task", refs: { backlog: ids } }));
        if (!queued.includes(peer)) this.addPlannerBacklog(peer, ids);
        for (const id of ids) notified.add(id);
      } catch (error) { this.addPlannerBacklog(peer, ids); throw error; }
    }
    return notified.size;
  }
  releaseList(by: PeerId): Record<string, unknown>[] {
    this.planningAuthority(by);
    const scopes = new Map<number, { id: number; state: Task["state"]; deps: number[] }[]>();
    type Approval = { id: number; release: Task["release"]; doneAt: number | null };
    const approved: Approval[] = [], owned = new Map<number, Approval[]>();
    for (const task of this.d.board.list()) {
      if (typeof task.release === "number") {
        const scope = scopes.get(task.release) ?? [];
        scope.push({ id: task.id, state: task.state, deps: task.deps ?? [] }); scopes.set(task.release, scope);
      }
      if (task.state !== "approved") continue;
      const row = { id: task.id, release: task.release, doneAt: actualTaskDates(task).doneAt };
      approved.push(row);
      if (typeof task.release === "number") { const rows = owned.get(task.release) ?? []; rows.push(row); owned.set(task.release, rows); }
    }
    const compare = (a: Approval, b: Approval) => a.doneAt! - b.doneAt! || a.id - b.id;
    const known = approved.filter(task => task.doneAt !== null).sort(compare), unknown = approved.filter(task => task.doneAt === null);
    const after = (rows: Approval[], cut: number) => {
      let low = 0, high = rows.length;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (rows[mid]!.doneAt! <= cut) low = mid + 1; else high = mid; }
      return low;
    };
    // ponytail: audit previews show 32 ids plus exact counts; add a paginated audit endpoint for exhaustive lists.
    const outsideIds = (rows: Approval[], start: number, release: number) => {
      const result: number[] = [];
      for (let i = start; i < rows.length && result.length < 32; i++) if (rows[i]!.release !== release) result.push(rows[i]!.id);
      return result;
    };
    return this.d.board.releases().map(release => {
      const own = owned.get(release.id) ?? [], ownKnown = own.filter(task => task.doneAt !== null).sort(compare);
      const cutStart = release.cut === null ? known.length : after(known, release.cut);
      const unknownPool = release.cut === null ? approved : unknown;
      return { ...this.publicRelease(release),
        name: this.nameable(release.name) ? release.name : "[withheld]",
        goal: this.nameable(release.goal) ? release.goal : "[withheld]",
        tasks: scopes.get(release.id) ?? [],
        afterCutUnknown: outsideIds(unknownPool, 0, release.id),
        afterCutUnknownCount: release.cut === null ? approved.length - own.length : unknown.length - (own.length - ownKnown.length),
        afterCut: release.cut === null ? null : outsideIds(known, cutStart, release.id),
        afterCutCount: release.cut === null ? null : known.length - cutStart - (ownKnown.length - after(ownKnown, release.cut)),
      };
    });
  }

  async planBacklog(by: PeerId, input: { id: number; revision: number; fields?: unknown; reason: string }): Promise<Task> {
    this.planningAuthority(by);
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new PreEffectToolRefusal("invalid planning identity or revision");
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("planning needs a bounded reason");
    let patch: PlanningFields;
    try { patch = planningPatch(input.fields); } catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const validate = () => {
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision) throw new PreEffectToolRefusal("planning revision changed");
      this.planningAuthority(by, task);
      if (patch.sdlc !== undefined) {
        if (task.state !== "backlog" || task.owner || taskHasStarted(task)) throw new PreEffectToolRefusal("issue identity changes require unstarted backlog work");
        if (by !== USER && this.isPii(task)) throw new PreEffectToolRefusal("private issue identity changes require the person");
        if (!this.isPii(task) && !this.publicMetadataText(JSON.stringify(patch.sdlc))) throw new PreEffectToolRefusal("planning identity metadata is private or sensitive");
      }
      if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal("closed work is final");
      if (by !== USER && (task.state !== "backlog" || !taskCanPlan(task) || task.pinned || Object.hasOwn(patch, "pinned"))) throw new PreEffectToolRefusal("planner changes only unpinned backlog work");
      if (by !== USER && patch.rank !== undefined && task.history.some(entry => entry.by === USER && entry.planning?.fields.includes("rank"))) throw new PreEffectToolRefusal("a person's backlog order is retained");
      if (by !== USER && Object.hasOwn(patch, "reserved") && this.hasPersonReservation(task)) throw new PreEffectToolRefusal("a person's reservation is retained");
      if (Object.hasOwn(patch, "deps") || Object.hasOwn(patch, "reserved")) {
        const returnedUntouched = task.state === "backlog" && !task.owner && taskHasStarted(task) && taskCanPlan(task);
        if (!returnedUntouched) {
          if (task.state !== "backlog" || taskHasStarted(task) || task.owner) throw new PreEffectToolRefusal("dependency and reservation changes require unstarted backlog work");
        }
        const definitionOf = this.d.adapterCatalog?.definitionOf ?? builtinDefinitionOf;
        if (patch.reserved && !definitionOf(patch.reserved, this.d.instances?.()) && !this.d.bus.knownPeers().includes(patch.reserved) && !this.d.routing().classes[task.class]?.peers.includes(patch.reserved)) throw new PreEffectToolRefusal("reserved owner is not a supported or configured peer");
        if (patch.reserved && !this.d.bus.isRostered(patch.reserved)) throw new PreEffectToolRefusal("reserved owner is off roster");
        // #531 D3: a reservation for a peer routing leaves out for good could never be honoured. Say so, and who can lift it.
        if (patch.reserved && this.excluded(task).includes(patch.reserved)) throw new PreEffectToolRefusal(`${patch.reserved} is excluded from this task (it declined it or was escalated away from it for good); a reservation for it can never be honoured. Only a person's ahub task assign lifts the exclusion`);
        if (patch.reserved) this.requireCapabilities(task, patch.reserved);
        const rows = new Map(this.d.board.list().map(row => [row.id, row]));
        const pending = [...(patch.deps ?? task.deps ?? [])], seen = new Set<number>();
        while (pending.length) {
          const id = pending.pop()!;
          if (id === task.id) throw new PreEffectToolRefusal("planning dependencies would form a cycle");
          if (seen.has(id)) continue;
          seen.add(id);
          const dependency = rows.get(id);
          if (!dependency) throw new PreEffectToolRefusal(`no dependency task #${id}`);
          pending.push(...(dependency.deps ?? []));
        }
      }
      const target = patch.release === undefined ? task.release : patch.release;
      if (target != null && !this.d.board.release(target)) throw new PreEffectToolRefusal("no such release");
      for (const id of new Set([task.release, target])) {
        if (id == null) continue;
        const release = this.d.board.release(id)!;
        if (Object.hasOwn(patch, "release")) this.planningAuthority(by, release);
        if (["shipped", "dropped"].includes(release.state)) throw new PreEffectToolRefusal("settled release scope is final");
        if (by !== USER && release.state === "frozen") throw new PreEffectToolRefusal("frozen release changes require a person");
      }
      return task;
    };
    const task = validate(), withheld = await this.withholds("note", input.reason, task);
    this.planningAuthority(by); // #455: or moved the planner
    const latest = validate(); // a person may have changed planning or frozen a release while the screen ran
    let receipt: Task["sdlc"];
    try { receipt = patch.sdlc === undefined ? undefined : planningIssueReceipt(patch.sdlc, latest.sdlc, this.d.sdlc?.config() ?? sdlcConfig(undefined)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const updated = this.d.board.plan(task.id, by, patch, input.revision, input.reason.trim(), withheld, receipt);
    this.planningRecorded({ by, task: task.id, fields: Object.keys(patch), revision: updated.planningRevision! });
    return updated; // persistence/readback failures must never claim no effect
  }

  async undoPlanning(by: PeerId, id: number, revision: number): Promise<Task> {
    this.planningAuthority(by);
    const task = this.d.board.get(id), entry = task ? planningUndoEntry(task) : undefined;
    if (!task || !entry?.planning || entry.planning.revision !== revision || (task.planningRevision ?? 0) !== revision || by !== USER && entry.by !== by) throw new PreEffectToolRefusal("planning undo is stale or not owned");
    this.planningAuthority(by, task);
    if (entry.planning.split) {
      const release = task.release == null ? undefined : this.d.board.release(task.release);
      if (task.state !== "backlog" || task.owner || taskHasStarted(task) || release && ["shipped", "dropped"].includes(release.state) || by !== USER && (task.pinned || release?.state === "frozen")) throw new PreEffectToolRefusal("split undo is no longer eligible");
      if (entry.planning.split.children.some(saved => this.d.board.get(saved.id)?.history.some(item => item.event === "memory reference started"))) throw new PreEffectToolRefusal("split children are referenced by persistent long-term memory");
      const childIds = new Set(entry.planning.split.children.map(child => child.id)), budgets = this.d.executionBudget?.status();
      if (Array.isArray(budgets) && budgets.some(budget => budget.kind === "task" && budget.taskId !== undefined && childIds.has(budget.taskId))) throw new PreEffectToolRefusal("split children are referenced by execution budgets");
      if (this.d.store) {
        try { this.d.memoryCheck?.(); this.d.store.store.refresh(); } catch { throw new PreEffectToolRefusal("split undo requires current memory link evidence"); }
        const children = new Set(entry.planning.split.children.map(child => this.d.board.get(child.id)).filter((child): child is Task => !!child).map(child => this.memoryKey(child)));
        if ([...children].some(key => this.d.store!.store.hasTask(key)) || this.d.store.store.goals().some(goal => goal.links.some(link => children.has(link.task)))) throw new PreEffectToolRefusal("split children are referenced by long-term tasks");
      }
      const restored = this.d.board.undoBacklogSplit(id, by, revision);
      this.planningRecorded({ by, task: id, fields: ["split", "deps"], revision: restored.planningRevision! });
      return restored;
    }
    if (entry.planning.pull) {
      const release = task.release == null ? undefined : this.d.board.release(task.release);
      if (task.state !== "proposed" || task.owner || taskHasStarted(task) || by !== USER && (task.pinned || release && ["frozen", "shipped", "dropped"].includes(release.state))) throw new PreEffectToolRefusal("planner pull undo is no longer eligible");
      const capacity = this.capacityBefore(task);
      const returned = this.d.board.undoPlannedPull(id, by, revision);
      this.writePlannerNotices(returned, capacity);
      this.offered.delete(id); this.incomingBacklog.add(id);
      this.planningRecorded({ by, task: id, fields: ["pull", "reserved"], revision: returned.planningRevision! });
      return returned;
    }
    return this.planBacklog(by, { id, revision, fields: entry.planning.previous, reason: `undo planning revision ${revision}` });
  }

  async importGitHub(by: PeerId, input: GitHubImportSelection, run?: SdlcGh): Promise<{ imported: number[]; existing: number[]; partial: boolean; complete: boolean; unconfirmed?: true }> {
    if (!this.personOrConductor(by)) throw new PreEffectToolRefusal("GitHub import is a person console command");
    const deadline = performance.now() + 20_000;
    const page = await readGitHubImport(input, run ?? ((args, timeout, _cwd, bound) => sdlcGh(args, timeout, this.d.cwd, bound)));
    const imported: number[] = [], existing: number[] = [];
    for (const issue of page.issues) {
      if (performance.now() >= deadline) return { imported, existing, partial: true, complete: false };
      let created = false;
      try {
        const prior = this.d.board.imported(issue.source.repo, issue.source.issue);
        if (prior) { existing.push(prior.id); continue; }
        const classes = profileData(this.d.profileData ?? this.d.profile ?? "dev").classes;
        const cls = Object.keys(classes).find(name => classes[name] === "implement") ?? Object.keys(classes)[0];
        const task = await this.propose(by, { title: issue.title, detail: issue.detail, class: cls, backlog: true }, issue.source, () => { created = true; });
        (created ? imported : existing).push(task.id);
        if (performance.now() >= deadline) return { imported, existing, partial: true, complete: false };
      } catch {
        if (created) {
          try {
            const saved = this.d.board.imported(issue.source.repo, issue.source.issue);
            if (saved) { if (!imported.includes(saved.id)) imported.push(saved.id); if (saved.state === "backlog") this.incomingBacklog.add(saved.id); return { imported, existing, partial: true, complete: false }; }
          } catch { /* A failed readback leaves the committed identity unconfirmed. */ }
        }
        return { imported, existing, partial: true, complete: false, unconfirmed: true };
      }
    }
    return { imported, existing, partial: page.partial, complete: !page.partial };
  }

  async splitBacklog(by: PeerId, input: { id: number; revision: number; parts: unknown; reason: string }, opts: { intake?: true } = {}): Promise<{ parent: Task; children: Task[] }> {
    // #334: the hub writes an intake draft's own model split; no other write by the hub passes as a planner.
    const authority = (task?: Pick<Task, "planner">) => { if (!(opts.intake && by === HUB)) this.planningAuthority(by, task); };
    authority();
    const { id, revision } = input;
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(revision) || revision < 0 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("split needs an id, revision and bounded reason");
    const reason = input.reason.trim();
    let parts: unknown;
    try { parts = structuredClone(input.parts); } catch { throw new PreEffectToolRefusal("split parts must be cloneable data"); }
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > 8) throw new PreEffectToolRefusal("split needs two to eight parts");
    const rows = parts as Record<string, unknown>[];
    const validate = () => {
      const parent = this.d.board.get(id);
      if (!parent || parent.state !== "backlog" || parent.owner || taskHasStarted(parent) || (parent.planningRevision ?? 0) !== revision || by !== USER && parent.pinned) throw new PreEffectToolRefusal("split changed, pinned or already started");
      const release = parent.release == null ? undefined : this.d.board.release(parent.release);
      if (parent.release != null && (!release || ["shipped", "dropped"].includes(release.state) || by !== USER && release.state === "frozen")) throw new PreEffectToolRefusal("split release scope is frozen or final");
      authority(parent);
      // #334: the hub writes a split only into a draft that is still a draft. Both validations run (before and after the awaited screen), and the board asks again in its transaction.
      if (opts.intake && by === HUB && !parent.draft) throw new PreEffectToolRefusal("split changed, pinned or already started");
      const profile = parent.profile ?? "dev";
      const drafts = rows.map((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).some(key => !["title", "detail", "class", "refs", "plan", "after", "afterParts"].includes(key)) || typeof part.title !== "string" || !part.title.trim() || part.title.length > 300 || part.detail !== undefined && (typeof part.detail !== "string" || part.detail.length > 8000) || part.class !== undefined && typeof part.class !== "string") throw new PreEffectToolRefusal("invalid split part");
        const given = part.class ?? parent.profileClass ?? parent.class;
        const storedProfile = !parent.profile ? "dev" : profile === (this.d.profile ?? "dev") ? this.d.profileData ?? profile : profile;
        let cls: TaskClass;
        try { cls = part.class === undefined ? parent.class : profileClass(given as string, storedProfile); } catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
        const after = part.after ?? [], afterParts = part.afterParts ?? [];
        if (!Array.isArray(after) || after.length > 64 || after.some(dep => !Number.isSafeInteger(dep) || dep <= 0) || new Set(after).size !== after.length || !Array.isArray(afterParts) || afterParts.length > 8 || afterParts.some(dep => !Number.isSafeInteger(dep) || dep < 0 || dep >= index) || new Set(afterParts).size !== afterParts.length) throw new PreEffectToolRefusal("split dependencies must name existing tasks or earlier parts");
        const deps = [...new Set([...(parent.deps ?? []), ...after as number[]])], pending = [...deps], seen = new Set<number>();
        const direct = afterParts.length ? deps.filter(dep => !parent.deps?.includes(dep)) : deps;
        if (direct.length + afterParts.length > 64) throw new PreEffectToolRefusal("split child dependencies exceed the 64-edge cap");
        while (pending.length) { const dependency = pending.pop()!; if (dependency === id) throw new PreEffectToolRefusal("split dependency reaches its parent"); if (seen.has(dependency)) continue; seen.add(dependency); const task = this.d.board.get(dependency); if (!task) throw new PreEffectToolRefusal("split dependency is missing"); pending.push(...(task.deps ?? [])); }
        const refs = part.refs === undefined ? parent.refs : cleanRefs(part.refs), plan = cleanPlan(part.plan, storedProfile);
        const draft = { title: part.title.replace(/\s+/g, " ").trim(), detail: part.detail as string | undefined ?? "", class: cls, refs, plan, deps, afterParts: afterParts as number[], ...(parent.role && cls === parent.class ? { role: parent.role } : {}), ...(parent.profile ? { profile: parent.profile, profileClass: given as string, ...(parent.profile === "dev" ? { customProfile: true as const } : {}) } : {}) };
        const fields: PlanningFields = {};
        for (const key of ["priority", "release", "plannedStart", "due"] as const) if (parent[key] !== undefined) fields[key] = parent[key];
        return { ...draft, fields };
      });
      return { parent, drafts };
    };
    const initial = validate(), screening = this.screenOn();
    const initialPrivacy = initial.drafts.map(part => this.signalsFor({ ...part, detail: [part.detail, planText(part.plan)].join("\n") }).filter(signal => signal === "pii" || signal === "pii_path"));
    const initialPrivate = initialPrivacy.map(signals => this.isPii({ signals })), initialParentPrivate = this.isPii(initial.parent);
    const initialParentPrivacy = initial.parent.signals.filter(signal => signal === "pii" || signal === "pii_path");
    const initialReasonPrivate = initialParentPrivate || !this.nameable(reason);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const attempt = Promise.all([
      Promise.all(initial.drafts.map((part, index) => screening && !initialParentPrivate && !initialPrivate[index] ? this.screenCall(screenText({ title: part.title, detail: part.detail, plan: part.plan })) : undefined)),
      this.withholds("note", reason, initial.parent),
    ]);
    let screened: Awaited<typeof attempt>;
    try { screened = await Promise.race([attempt, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new PreEffectToolRefusal("split screening request deadline exceeded")), BACKLOG_SPLIT_SCREEN_TIMEOUT_MS); })]); }
    finally { if (deadline !== undefined) clearTimeout(deadline); }
    authority(); // #455: a person may have moved the planner while the screen ran
    const [screenedVerdicts, withheld] = screened, current = validate();
    const finalSignals = current.drafts.map(part => this.signalsFor({ ...part, detail: [part.detail, planText(part.plan)].join("\n") }));
    const deterministicPrivate = finalSignals.map((signals, index) => initialPrivate[index] || this.isPii({ signals }));
    const verdicts = screenedVerdicts.map((verdict, index) => deterministicPrivate[index] ? undefined : verdict);
    const inherited = current.drafts.map((_part, index) => (initialParentPrivate || this.isPii(current.parent)) && !deterministicPrivate[index]);
    const drafts = current.drafts.map((part, index) => ({ ...part, ...(screening ? { screeningNote: inherited[index] ? "pii: inherited" : this.screenNote(verdicts[index]) } : {}), signals: [...new Set([...initialPrivacy[index]!, ...initialParentPrivacy, ...finalSignals[index]!, ...current.parent.signals.filter(signal => ["pii", "pii_path", "urgent"].includes(signal)), ...(verdicts[index] && verdicts[index]!.label !== "clear" ? ["pii"] : [])])] }));
    for (const draft of drafts) this.warmRepository(draft);
    // #334: the hub's intake split is only for a draft; the board asks for it again inside its transaction (a flag set for exactly this write, never left on).
    this.d.board.requireDraftForNextSplit = opts.intake === true && by === HUB;
    const result = this.d.board.splitBacklog(id, by, revision, drafts, reason, withheld || initialReasonPrivate || this.isPii(current.parent) || !this.nameable(reason));
    if (this.d.coordination) {
      const mode = this.d.coordination();
      for (const child of result.children) this.coordinationModes.set(child.id, mode);
    }
    for (const [index, child] of result.children.entries()) {
      this.incomingBacklog.add(child.id);
      if (screening) { this.recordScreen(child.id, "task", verdicts[index], inherited[index]); if (verdicts[index]?.label === "unknown") this.releaseNotice(`task #${child.id}: the PII screen gave no verdict (${verdicts[index]!.miss}); it is handled as a PII task`); }
    }
    this.planningRecorded({ by, task: id, fields: ["split", "deps"], revision: result.parent.planningRevision! });
    return result;
  }

  /**
   * The draft and every open draft card split from it, at any depth, parent first. A planner may split an intake child again before approval, and
   * the grandchildren inherit the mark, so the walk follows `deps` through draft cards only: a dependency on ordinary work is never followed.
   */
  private intakeFamily(id: number): Task[] {
    const root = this.d.board.get(id);
    if (!root || !root.draft || root.state !== "backlog") throw new PreEffectToolRefusal(`task #${id} is not an open intake draft`);
    const family: Task[] = [root], seen = new Set([root.id]);
    for (let next = 0; next < family.length; next++) {
      for (const dep of family[next]!.deps ?? []) {
        if (seen.has(dep)) continue;
        const child = this.d.board.get(dep);
        if (!child || !child.draft || child.state !== "backlog") continue;
        seen.add(dep); family.push(child);
      }
    }
    return family;
  }

  /**
   * #334 (#511a): the person's request becomes one parent draft, a backlog card that nothing offers or pulls. A planner is asked to split it with
   * `hub_backlog_split`; with none, or for a request that is PII, the hub's model proposes the split and the hub writes it. A split that does not
   * validate leaves the draft whole, with the reason on its history.
   */
  async intake(by: PeerId, input: { text: unknown; sources?: unknown }): Promise<{ draft: Task; children: Task[]; split: "planner" | "hub" | "unsplit"; reason?: string }> {
    if (by !== USER) throw new PreEffectToolRefusal("intake is a console command");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > INTAKE_MAX_TEXT) throw new PreEffectToolRefusal(`intake needs a request of 1 to ${INTAKE_MAX_TEXT} characters`);
    const given = input.sources ?? [];
    if (!Array.isArray(given) || given.length > INTAKE_MAX_SOURCES || given.some(id => typeof id !== "string" || !SOURCE_ID.test(id)) || new Set(given).size !== given.length) throw new PreEffectToolRefusal(`sources: at most ${INTAKE_MAX_SOURCES} distinct src:<16 hex> ids`);
    const sources = given as string[];
    for (const id of sources) if (!this.d.intake?.sourceKnown(id)) throw new PreEffectToolRefusal(`unknown source ${id}; register it with ahub source add`);
    const title = `Intake: ${text.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 80)}`;
    let draft = await this.propose(USER, { title, detail: intakeDetail(text, sources), class: "plan", backlog: true, draft: true });
    this.incomingBacklog.delete(draft.id);
    const priv = this.isPii(draft);
    const planner = priv ? undefined : this.taskPlanner(draft).find(peer => this.d.bus.isRostered(peer) && this.d.bus.peers.has(peer) && this.d.bus.stateOf(peer) !== "offline");
    if (planner) {
      const body = plannerRequestBody({ id: draft.id, revision: draft.planningRevision ?? 0, text: parseIntakeDetail(String(this.publicView(draft).detail)).text, sources });
      try {
        if (this.d.bus.publish(newEnvelope(HUB, sanitize(body), { to: [planner], kind: "task", refs: { task: String(draft.id), taskRecipient: "planner" } })).includes(planner)) return { draft, children: [], split: "planner" };
      } catch { /* the planner is not reachable: the hub model takes it */ }
    }
    return { ...(await this.intakeByHub(draft, text, sources, priv)), draft: this.d.board.get(draft.id) ?? draft };
  }

  /** The hub model's split of a draft, validated against the profile's `hub_backlog_split` parts schema and written through `splitBacklog`. */
  private async intakeByHub(draft: Task, text: string, sources: string[], priv: boolean): Promise<{ children: Task[]; split: "hub" | "unsplit"; reason?: string }> {
    const unsplit = (reason: string) => { this.d.board.update(draft.id, HUB, "intake unsplit", {}, reason); return { children: [], split: "unsplit" as const, reason }; };
    if (!this.d.intake) return unsplit("no planner is attached and the hub has no model for a split");
    // A request that is PII goes only to a model reached on campus; without one it stays whole for the person.
    if (priv && !(await this.d.triage?.onCampus().catch(() => false))) return unsplit("the request is PII and no on-prem model was reached");
    let raw: string | undefined;
    try { raw = await this.d.intake.split(intakeSystemPrompt(Object.keys(profileData(this.d.profileData ?? this.d.profile ?? "dev").classes), this.d.intake.partsSchema()), intakeUserMessage(text, sources), { campusOnly: priv }); } catch { raw = undefined; }
    const parsed = parseIntakeSplit(raw, this.d.intake.partsSchema(), sources);
    if ("error" in parsed) return unsplit(parsed.error);
    const current = this.d.board.get(draft.id);
    if (!current || !current.draft || current.state !== "backlog") return unsplit("the draft changed while the model answered");
    try {
      const result = await this.splitBacklog(HUB, { id: draft.id, revision: current.planningRevision ?? 0, parts: parsed.parts, reason: "intake: split by the hub model" }, { intake: true });
      return { children: result.children, split: "hub" };
    } catch (error) { return unsplit(`the split was refused: ${error instanceof PreEffectToolRefusal ? sanitize(error.message).slice(0, 200) : "the board refused it"}`); }
  }

  /** #334: the person approves a draft; it and its children leave draft and follow the normal backlog pull. */
  async approveIntake(by: PeerId, id: unknown): Promise<Task[]> {
    if (!this.personOrConductor(by)) throw new PreEffectToolRefusal("intake approval is a console command");
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new PreEffectToolRefusal("id must be a positive task number");
    const family = this.intakeFamily(id);
    let approved: Task[];
    try { approved = this.d.board.approveDrafts(family.map(task => task.id), by, by === USER ? "intake approved by the person" : `intake approved by the conductor ${by}`); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    for (const task of approved) this.incomingBacklog.add(task.id);
    this.releaseNotice(`intake draft #${id} approved: ${approved.length} backlog card${approved.length === 1 ? "" : "s"}`);
    return approved;
  }

  /** #334: the person discards a draft; it and its children are cancelled through `cancel`. */
  async discardIntake(by: PeerId, id: unknown): Promise<Task[]> {
    if (by !== USER) throw new PreEffectToolRefusal("intake discard is a console command");
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new PreEffectToolRefusal("id must be a positive task number");
    const cancelled: Task[] = [];
    for (const task of this.intakeFamily(id)) cancelled.push(await this.cancel(task.id, USER, { reason: "intake draft discarded by the person" }));
    return cancelled;
  }

  /** Release assignment changes no execution role, dependency, reservation or state. */
  async assignRelease(by: PeerId, input: { id: number; revision: number; release: number | null; reason: string }): Promise<Task> {
    this.plannerWriteAuthority(by);
    if (typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason) > 1000) throw new PreEffectToolRefusal("release assignment needs a bounded reason");
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.release !== null && (!Number.isSafeInteger(input.release) || input.release <= 0)) throw new PreEffectToolRefusal("invalid release assignment");
    const validate = () => {
      this.plannerWriteAuthority(by);
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision) throw new PreEffectToolRefusal("release assignment changed");
      this.plannerWriteAuthority(by, task);
      if (by !== USER && (this.isPii(task) || task.pinned)) throw new PreEffectToolRefusal("private or pinned release scope requires the person");
      for (const id of new Set([task.release, input.release])) if (id != null) {
        const release = this.d.board.release(id);
        if (!release || ["frozen", "shipped", "dropped"].includes(release.state)) throw new PreEffectToolRefusal("release scope is frozen or final");
        this.plannerWriteAuthority(by, release);
      }
      return task;
    };
    const before = validate(), signature = JSON.stringify(before), privateScope = this.isPii(before);
    if (!privateScope && (!this.nameable(input.reason) || this.screenOn() && (await this.screenCall(input.reason)).label !== "clear")) throw new PreEffectToolRefusal("release reason was not cleared for public planning");
    if (JSON.stringify(validate()) !== signature) throw new PreEffectToolRefusal("release assignment changed during screening");
    const result = this.d.board.plan(input.id, by, { release: input.release }, input.revision, input.reason.trim(), privateScope);
    this.planningRecorded({ by, task: input.id, fields: ["release"], revision: result.planningRevision! });
    return result;
  }

  async configureRelease(by: PeerId, input: { id: number; revision: number; hotfix?: unknown; state?: "active"; cut?: number }): Promise<Release> {
    this.plannerWriteAuthority(by);
    const validate = () => {
      this.plannerWriteAuthority(by);
      if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new PreEffectToolRefusal("invalid release identity or revision");
      const release = this.d.board.release(input.id);
      if (!release || release.revision !== input.revision || !["planning", "active"].includes(release.state)) throw new PreEffectToolRefusal("release revision changed or scope frozen");
      this.plannerWriteAuthority(by, release);
      if (input.state !== undefined && input.state !== "active") throw new PreEffectToolRefusal("invalid train state");
      if (input.cut !== undefined && (!Number.isSafeInteger(input.cut) || input.cut <= 0 || input.cut > 8_640_000_000_000_000)) throw new PreEffectToolRefusal("release cut must be a positive safe UTC timestamp");
      const dates = [release.plannedStart, input.cut ?? release.cut, release.ship].filter((date): date is number => date !== null);
      if (dates.some((date, index) => index > 0 && dates[index - 1]! > date)) throw new PreEffectToolRefusal("invalid release planned dates");
      if ((input.state ?? release.state) === "active" && this.d.board.releases().some(row => row.id !== input.id && ["active", "frozen"].includes(row.state))) throw new PreEffectToolRefusal("one open release train at a time");
      return release;
    };
    const release = validate();
    let train;
    try { train = releaseTrainData({ ...(release.train ?? { history: [] }), ...(input.hotfix === undefined ? {} : { hotfix: input.hotfix }) }); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    if (train.hotfix && (!this.nameable(train.hotfix.reason) || this.screenOn() && (await this.screenCall(train.hotfix.reason)).label !== "clear")) throw new PreEffectToolRefusal("hotfix reason was not cleared");
    const validatedRelease = validate();
    if (JSON.stringify(validatedRelease) !== JSON.stringify(release)) throw new PreEffectToolRefusal("release changed during screening");
    if (release.train && JSON.stringify(train) === JSON.stringify(release.train) && (input.state ?? release.state) === release.state && (input.cut ?? release.cut) === release.cut) return validatedRelease;
    if (train.history.length >= RELEASE_TRAIN_HISTORY_LIMIT - 2) throw new PreEffectToolRefusal("release train history full; keep the remaining slots for cut and ship");
    train.history.push({ at: Date.now(), by, event: "configured" });
    const updated = this.d.board.updateRelease(input.id, { train: releaseTrainData(train), ...(input.state ? { state: input.state } : {}), ...(input.cut === undefined ? {} : { cut: input.cut }) }, input.revision);
    this.planningRecorded({ by, release: input.id, fields: ["train"], revision: updated.revision });
    return updated;
  }

  publicRelease(release: Release): Release {
    return { ...release, name: this.nameable(release.name) ? release.name : "[withheld]", goal: this.nameable(release.goal) ? release.goal : "[withheld]", ...(release.train?.hotfix && !this.nameable(release.train.hotfix.reason) ? { train: { ...release.train, hotfix: { ...release.train.hotfix, reason: "[withheld]" } } } : {}) };
  }

  releaseReport(by: PeerId, id: number) {
    this.planningAuthority(by);
    if (by !== USER && this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("release report unavailable during a private turn");
    const release = Number.isSafeInteger(id) && id > 0 ? this.d.board.release(id) : undefined;
    if (!release) throw new PreEffectToolRefusal("no such release");
    const all = this.d.board.list(), publicTasks = all.filter(task => !this.isPii(task));
    if (all.some(task => task.release === id && this.isPii(task))) throw new PreEffectToolRefusal("release scope contains private work; public readiness unavailable");
    return { release: this.publicRelease(release), readiness: releaseTrainReadiness(release, publicTasks), metrics: releaseMetrics(this.d.board.releases().filter(row => !all.some(task => task.release === row.id && this.isPii(task))), publicTasks), native: "unverified" as const };
  }

  /** Scope freeze only. This never tags, publishes, upgrades, or authorizes a release. */
  async cutRelease(by: PeerId, input: { id: number; revision: number }): Promise<Release> {
    const validate = () => {
      this.plannerWriteAuthority(by);
      if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new PreEffectToolRefusal("invalid release identity or revision");
      const release = this.d.board.release(input.id);
      if (!release || release.revision !== input.revision || release.state !== "active") throw new PreEffectToolRefusal("release revision changed or train is not active");
      this.plannerWriteAuthority(by, release);
      if (this.d.board.releases().some(row => row.id !== input.id && ["active", "frozen"].includes(row.state))) throw new PreEffectToolRefusal("one open release train at a time");
      if ((release.train?.history.length ?? 0) > RELEASE_TRAIN_HISTORY_LIMIT - 2) throw new PreEffectToolRefusal("release train history full; cut needs slots for cut and ship, drop this train and create a replacement");
      const report = this.releaseReport(by, input.id);
      if (report.readiness.blockers.length) throw new PreEffectToolRefusal(`release cut blocked: ${report.readiness.blockers.join("; ")}`);
      return { release, scope: this.d.board.list().filter(task => task.release === input.id) };
    };
    const before = validate(), signature = JSON.stringify(before);
    const expected = new Set(before.scope.flatMap(task => task.sdlc?.repo && task.sdlc.pr ? [`${task.sdlc.repo.toLowerCase()}#${task.sdlc.pr}`] : []));
    let ciRuns: number | undefined;
    if (expected.size && before.scope.every(task => task.sdlc?.repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.sdlc.repo) && !task.sdlc.repo.startsWith("-") && Number.isSafeInteger(task.sdlc.pr) && task.sdlc.pr! > 0)) {
      const repositories = [...new Set(before.scope.flatMap(task => task.sdlc?.repo ? [task.sdlc.repo] : []))];
      if (repositories.length === 1 && expected.size <= 16) {
        try {
          const costs = await this.costReport(by, repositories[0], before.scope.map(task => task.sdlc!.pr!)), rows = costs.rows as import("./cost-governance.ts").CostRow[];
          const selected = rows.filter(row => expected.has(`${row.repo.toLowerCase()}#${row.pr}`));
          if (!costs.truncated && selected.length === expected.size && selected.every(row => row.ciRuns !== null && row.ciReruns !== null)) ciRuns = selected.reduce((sum, row) => sum + row.ciRuns! + row.ciReruns!, 0);
        } catch { /* Optional cost evidence stays unknown; validation below still rechecks scope and authority. */ }
      }
    }
    if (JSON.stringify(validate()) !== signature) throw new PreEffectToolRefusal("release scope changed during cost readback");
    const window = await this.d.releaseWindow?.();
    try {
    if (JSON.stringify({ release: this.d.board.release(input.id), scope: this.d.board.list().filter(task => task.release === input.id) }) !== signature) throw new PreEffectToolRefusal("release scope changed during admission");
    const freshScope = validate();
    if (!window || !Number.isFinite(window.at) || Date.now() - window.at > 5000 || window.at > Date.now() || window.host !== true || window.quota !== true || window.current?.() === false) throw new PreEffectToolRefusal(`release cut deferred: ${window?.reasons?.join("; ") || "host or peer quota evidence unavailable"}; inspect ahub budget and ahub budget set <peer> <0..1>; stop or resume the paused peer; the person can use ahub release drop or explicitly disable lifecycle mode before retrying`);
    const scope = freshScope.scope.map(task => task.id).sort((a, b) => a - b), train = releaseTrainData(freshScope.release.train ?? { history: [] });
    train.scope = scope; train.history.push({ at: Date.now(), by, event: "cut", scope, reviews: freshScope.scope.reduce((sum, task) => sum + task.history.filter(row => ["approved", "changes_requested"].includes(row.event)).length, 0), ...(ciRuns === undefined ? {} : { ciRuns }) });
    const updated = this.d.board.freezeRelease(input.id, input.revision, freshScope.scope, releaseTrainData(train));
    this.planningRecorded({ by, release: input.id, fields: ["state", "train"], revision: updated.revision });
    return updated;
    } finally {
      try { await window?.close?.(); }
      catch { this.releaseNotice(`release #${input.id}: admission cleanup incomplete; inspect the host lease before retrying`); }
    }
  }

  async newRelease(by: PeerId, input: { name: string; goal: string; order: number }): Promise<Release> {
    this.plannerWriteAuthority(by);
    if (typeof input.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name) || typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 1000 || !Number.isSafeInteger(input.order) || input.order < 0) throw new PreEffectToolRefusal("invalid release name, goal or order");
    const text = input.name + "\n" + input.goal;
    if (!this.nameable(text) || this.screenOn() && (await this.screenCall(text)).label !== "clear") throw new PreEffectToolRefusal("release text was not cleared for public planning");
    this.plannerWriteAuthority(by); // Privacy and planner identity may change while screening.
    if (this.d.board.releases().some(release => release.name === input.name)) throw new PreEffectToolRefusal("release name already exists");
    const release = this.d.board.newRelease(input.name, input.goal.trim(), input.order, by === USER ? null : by);
    this.planningRecorded({ by, release: release.id, fields: ["created"], revision: release.revision });
    return release;
  }

  changeRelease(by: PeerId, input: { id: number; revision: number; state?: ReleaseState; plannedStart?: number | null; cut?: number | null; ship?: number | null }): Release {
    this.planningAuthority(by);
    const release = this.d.board.release(input.id);
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || !release || release.revision !== input.revision) throw new PreEffectToolRefusal("release revision changed");
    this.planningAuthority(by, release);
    if (["shipped", "dropped"].includes(release.state)) throw new PreEffectToolRefusal("settled release is final");
    if (by !== USER && (release.state === "frozen" || input.state === "frozen" || input.state === "shipped" || input.state === "dropped")) throw new PreEffectToolRefusal("freeze, ship, drop and frozen changes require a person");
    if (input.state === "shipped" && this.d.board.list().some(task => task.release === release.id && !isClosedTaskState(task.state))) throw new PreEffectToolRefusal("every release task must be approved, cancelled, or moved out before ship");
    if (input.state === "active" && (release.train || this.d.sdlc?.config().mode !== undefined && this.d.sdlc.config().mode !== "off" || this.d.board.releases().some(row => row.train && ["active", "frozen"].includes(row.state))) && this.d.board.releases().some(row => row.id !== release.id && ["active", "frozen"].includes(row.state))) throw new PreEffectToolRefusal("one open release train at a time");
    if (input.state === "frozen" && (release.train || this.d.sdlc?.config().mode !== undefined && this.d.sdlc.config().mode !== "off")) throw new PreEffectToolRefusal("use the resource-admitted release cut operation");
    if (input.state === "shipped" && release.train) {
      if (release.train.history.length >= RELEASE_TRAIN_HISTORY_LIMIT) throw new PreEffectToolRefusal("release train history full; ship needs one history slot, drop this train and create a replacement");
      const readiness = releaseTrainReadiness(release, this.d.board.list());
      if (readiness.blockers.length) throw new PreEffectToolRefusal(`release ship blocked: ${readiness.blockers.join("; ")}`);
    }
    const { id, revision, ...patch } = input;
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !["state", "plannedStart", "cut", "ship"].includes(key))) throw new PreEffectToolRefusal("unknown or empty release fields");
    const trained = release.train && input.state === "shipped" ? releaseTrainData({ ...release.train, history: [...release.train.history, { at: Date.now(), by, event: "shipped" }] }) : undefined;
    const updated = this.d.board.updateRelease(id, { ...patch, ...(trained ? { train: trained } : {}) }, revision);
    this.planningRecorded({ by, release: id, fields: Object.keys(patch), revision: updated.revision });
    return updated; // a failed readback may follow a durable release write
  }

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; role?: unknown; refs?: TaskRefs; plan?: TaskPlan; owner?: PeerId; after?: unknown; urgent?: unknown; backlog?: unknown; draft?: unknown; goal?: unknown }, external?: GitHubSource, created?: () => void, fence?: () => string | undefined): Promise<Task> {
    const requestCheck = this.requestCheck(by, fence);
    requireLocalTaskPeer(input.owner);
    external = external ? { ...external } : undefined;
    if (external && (!this.personOrConductor(by) || input.backlog !== true)) throw new PreEffectToolRefusal("external intake requires person-owned backlog staging");
    if (input.backlog !== undefined && typeof input.backlog !== "boolean") throw new PreEffectToolRefusal("backlog must be a boolean");
    const backlog = input.backlog === true;
    if (input.draft !== undefined && (input.draft !== true || !backlog || by !== USER)) throw new PreEffectToolRefusal("only the person's intake stages a backlog draft");
    const claiming = !backlog && input.owner === by;
    if (claiming) {
      this.acceptanceCapacity({ id: -1, owner: by, state: "proposed" });
      this.pendingClaims.set(by, (this.pendingClaims.get(by) ?? 0) + 1);
    }
    try {
    if (backlog && input.owner && !this.d.bus.isRostered(input.owner)) throw new PreEffectToolRefusal(`${input.owner} is off roster; add it before reserving work`);
    // Callers are models: a title is one line (it is part of console and hub.log lines), not a document.
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!title) throw new PreEffectToolRefusal("title is required");
    const goal = input.goal == null || input.goal === "" ? undefined : this.goalFor(by, input.goal);
    // Dependencies can only name tasks that exist, so the new task closes no cycle: nothing can depend on it yet.
    // Callers are models: a missing or null `after` is no dependency, and an id is an integer or a digit string.
    let afterIds: unknown[] = [];
    if (Array.isArray(input.after)) afterIds = input.after;
    else if (input.after != null) afterIds = [input.after];
    const deps: number[] = [];
    for (const v of afterIds) {
      const id = typeof v === "number" || (typeof v === "string" && /^\s*\d+\s*$/.test(v)) ? Number(v) : NaN;
      if (!Number.isInteger(id)) throw new PreEffectToolRefusal(`after: ${JSON.stringify(v)} is not a task id`);
      if (!this.d.board.get(id)) throw new PreEffectToolRefusal(`after: no task #${id}`);
      if (!deps.includes(id)) deps.push(id);
    }
    // An owner for work that waits is reserved (issue #207): routing offers it to that peer first once it is ready.
    const reserved = backlog || this.waitsFor({ deps }).length ? input.owner : undefined;
    const given = input.class === undefined || input.class === "" ? undefined : input.class;
    const profile = this.d.profile ?? "dev";
    let baseGiven: TaskClass | undefined;
    try { if (given !== undefined) baseGiven = profileClass(given, this.d.profileData ?? profile); } catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const text = { title, detail: String(input.detail ?? "").slice(0, 8000), refs: cleanRefs(input.refs) };
    const plan = cleanPlan(input.plan, this.d.profileData ?? profile);
    // The plan reaches other owners, so a PII pattern in it makes the task a PII task like one in the detail would.
    const screenDetail = [text.detail, text.refs.repo, external?.repo, external?.url].filter(value => value !== undefined && value !== "").join("\n");
    const signals = this.signalsFor({ ...text, detail: [screenDetail, planText(plan)].join("\n"), plan });
    // Urgent work is handed over even when its paused owner's window resets soon (issue #36).
    if (input.urgent === true && !signals.includes("urgent")) signals.push("urgent");
    // The PII screen (issue #198) reads the same text before anything else does: until its verdict the task is on no
    // board, in no envelope and before no other model. A pattern match is PII without a call; no verdict is PII too.
    const screening = this.screenOn();
    const screened = screening && !signals.includes("pii") ? await this.screenCall(screenText({ ...text, detail: screenDetail, plan })) : undefined;
    requestCheck();
    if (screened && screened.label !== "clear") signals.push("pii");
    let cls = baseGiven;
    let triaged = false;
    let fenced = false; // a PII task off campus: triage is not asked
    if (!cls && this.d.triage) {
      // Signals first: a PII task's text may only go to a model that is reached without leaving the campus network.
      const pii = this.isPii({ signals });
      const reached = !pii || await this.d.triage.onCampus().catch(() => false);
      requestCheck();
      if (reached) cls = await this.d.triage.classify(text.title, text.detail).catch(() => undefined);
      else fenced = true;
      requestCheck();
      triaged = !!cls;
    }
    // A claim is work the caller will do itself: without a class and a model to name one, it is implementation (#6).
    const defaulted = !backlog && !cls && input.owner === by;
    if (defaulted) cls = "implement";
    if (!cls) throw new PreEffectToolRefusal(`class is required (one of ${CLASSES.join(", ")}); ${fenced ? "the task is handled as PII and the hub's model is not reached on campus, so it was not asked to name one" : "the hub could not name one for you"}`);
    if (claiming) this.acceptanceCapacity({ id: -1, owner: by, state: "proposed" }, 1);
    let selected;
    try { selected = taskRole(input.role, cls, this.d.catalog ?? loadRoleCatalog(this.d.cwd)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const draft = { ...text, class: cls, ...(selected ? { role: selected.id } : {}), ...(profile !== "dev" || given !== undefined && given !== cls || this.d.profileData && this.d.profileData !== projectProfile("dev") ? { profile, profileClass: given ?? cls, ...(profile === "dev" ? { customProfile: true as const } : {}) } : {}) };
    if (external) { const prior = this.d.board.imported(external.repo, external.issue); if (prior) return prior; }
    if (reserved) this.requireCapabilities({ ...draft, signals, ...(external ? { external } : {}) }, reserved);
    this.warmRepository({ refs: draft.refs, plan });
    const repositoryMismatch = !this.isPii({ signals }) && this.repositories.mismatch(draft.refs, plan);
    requestCheck();
    let task = this.d.board.propose(by, { ...draft, plan, ...(external ? { external } : {}), ...(deps.length ? { deps } : {}), ...(reserved ? { reserved } : {}), signals, ...(backlog ? { backlog: true } : {}), ...(input.draft === true ? { draft: true } : {}) });
    if (repositoryMismatch) this.releaseNotice(`task #${task.id}: refs and plan name different repositories; check refs.repo before editing`);
    if (this.d.coordination) this.coordinationModes.set(task.id, this.d.coordination());
    created?.();
    if (screening) task = this.screenedTask(task, screened);
    task = this.linkOnWrite(task); // #723
    if (goal) this.linkNative(task, goal, by);
    if (triaged) task = this.d.board.update(task.id, "hub", "triaged", {}, `class ${cls} named by the hub's model`);
    if (defaulted) task = this.d.board.update(task.id, "hub", "class defaulted", {}, "class implement for a claim without one");
    if (backlog) {
      this.incomingBacklog.add(task.id);
      this.releaseNotice(`task ${this.publicTitle(task)} backlogged by ${by} [${profileTaskLabel(task)}]`);
      return task;
    }
    this.d.notify(`task ${this.publicTitle(task)} proposed by ${by} [${profileTaskLabel(task)}]${task.signals.length ? ` signals: ${task.signals.join(", ")}` : ""}`);
    // Re-read: a dependency approved while triage was awaited looked for its dependents before this row existed.
    const still = this.waitsFor(task);
    if (still.length) {
      this.d.notify(`task ${this.publicTitle(task)} waits for ${still.map((id) => `#${id}`).join(", ")}; it is offered ${task.reserved ? `to ${task.reserved} first ` : ""}once they are approved`);
      return this.d.board.update(task.id, HUB, "blocked", {}, `waits for ${still.map((id) => `#${id}`).join(", ")}`);
    }
    // Naming yourself is a claim: the work is already yours, so no offer comes back to you (paper: Agensh CLAIM, #68).
    return await this.assignOwner(task, by, input.owner ? { candidates: [input.owner], namedOwner: input.owner, claim: input.owner === by } : {});
    } finally {
      if (claiming) {
        const remaining = (this.pendingClaims.get(by) ?? 1) - 1;
        if (remaining) this.pendingClaims.set(by, remaining); else this.pendingClaims.delete(by);
      }
    }
  }

  async returnUntouchedToBacklog(by: PeerId, input: { id: number; revision: number; reason: string }): Promise<Task> {
    this.plannerWriteAuthority(by);
    if (!Number.isSafeInteger(input.id) || input.id < 1 || !Number.isSafeInteger(input.revision) || input.revision < 0
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("untouched return needs an id, revision and bounded reason");
    const validate = () => {
      const task = this.need(input.id, false, true);
      this.plannerWriteAuthority(by, task);
      if (!["proposed", "in_progress"].includes(task.state) || (task.planningRevision ?? 0) !== input.revision || taskHasWorkEvidence(task)) throw new PreEffectToolRefusal("work has execution evidence or its planning revision changed");
      if (by !== USER && task.pinned) throw new PreEffectToolRefusal("pinned work requires the person");
      const release = task.release == null ? undefined : this.d.board.release(task.release);
      if (release && (["shipped", "dropped"].includes(release.state) || by !== USER && release.state === "frozen")) throw new PreEffectToolRefusal("settled or frozen release scope cannot return");
      return task;
    };
    const task = validate(), flow = task.history.length;
    const withheld = await this.withholds("note", input.reason, task);
    this.plannerWriteAuthority(by);
    const confirmed = validate();
    if (confirmed.history.length !== flow) throw new PreEffectToolRefusal("task changed during untouched return");
    const capacity = this.capacityBefore(confirmed);
    const returned = this.d.board.update(confirmed.id, by, "backlog returned untouched", { state: "backlog", owner: null, reviewer: null }, input.reason.trim(), { ...(withheld ? { withheld: true } : {}) }, flow);
    this.writePlannerNotices(returned, capacity);
    this.offered.delete(confirmed.id);
    this.cohorts.leave(confirmed.id);
    this.withdrawRoleRequest(confirmed, returned, "owner");
    this.withdrawRoleRequest(confirmed, returned, "reviewer");
    this.incomingBacklog.add(confirmed.id);
    this.planningRecorded({ by, task: confirmed.id, fields: ["return"], revision: confirmed.planningRevision ?? 0 });
    await this.releaseHeld(confirmed.owner); // its owner's slot is free (#655)
    return returned;
  }

  /** Person-owned staging only. Flow transitions remain with their existing owners and reviewers. */
  async moveBacklog(by: PeerId, id: unknown, pull: boolean): Promise<Task> {
    if (by !== USER) throw new PreEffectToolRefusal("backlog pull/return is a console command");
    if (typeof pull !== "boolean") throw new PreEffectToolRefusal("pull must be a boolean");
    const n = typeof id === "number" ? id : typeof id === "string" && /^\s*\d+\s*$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new PreEffectToolRefusal("id must be a positive task number");
    const task = this.d.board.get(n);
    if (!task) throw new PreEffectToolRefusal(`no task #${n}`);
    if (pull && task.draft) throw new PreEffectToolRefusal(`task #${n} is an intake draft; approve it with ahub intake approve ${n} first`);
    if (task.state !== (pull ? "backlog" : "proposed") || task.owner) throw new PreEffectToolRefusal(`task #${n}: ${pull ? "only backlog may be pulled" : "only ownerless proposed work may return to backlog"}`);
    if (!pull && taskHasStarted(task)) throw new PreEffectToolRefusal(`task #${n}: started work cannot return to backlog`);
    const pulled = task.history.findLast(entry => entry.event === "backlog pulled" || entry.event === "backlog returned");
    const restoreReservation = !pull && pulled?.planning?.pull && !task.history.slice(task.history.lastIndexOf(pulled) + 1).some(entry => entry.event === "reserved" || entry.planning?.fields.includes("reserved"));
    const capacity = this.capacityBefore(task);
    const next = this.d.board.update(n, by, pull ? "backlog pulled" : "backlog returned", { state: pull ? "proposed" : "backlog", owner: null, reviewer: null, ...(restoreReservation ? { reserved: pulled.planning!.previous.reserved ?? null } : {}) });
    this.writePlannerNotices(next, capacity);
    this.offered.delete(n);
    if (!pull) { this.incomingBacklog.add(n); return next; }
    const waits = this.waitsFor(next);
    if (waits.length) return this.d.board.update(n, HUB, "blocked", {}, `waits for ${waits.map(v => `#${v}`).join(", ")}`);
    // This persisted ready marker also lets a restart offer ownerless work once a peer attaches.
    const ready = this.d.board.update(n, HUB, "ready", {}, "pulled from backlog");
    return this.assignOwner(ready, by);
  }

  /** Where a screened task's `pii` signal came from, on its history and in events (issue #198); no verdict is a console line by id. */
  private screenNote(v: PiiVerdict | undefined): string { return !v ? "pii: regex" : v.label === "clear" ? "clear" : v.label === "pii" ? `pii: screen, ${v.category}` : `pii: unknown, ${v.miss}`; }
  private screenedTask(task: Task, v: PiiVerdict | undefined): Task {
    this.recordScreen(task.id, "task", v);
    if (v?.label === "unknown") this.d.notify(`task #${task.id}: the PII screen gave no verdict (${v.miss}); it is handled as a PII task`);
    const note = this.screenNote(v);
    return this.d.board.update(task.id, HUB, "screened", {}, note);
  }

  /** How often each task was screened again in this hub run. ponytail: in memory, so a restart allows another round. */
  private readonly rescreens = new Map<number, number>();

  /**
   * A task whose screen gave no verdict waits as a PII task (#198). While it is proposed and no peer ever owned it,
   * nothing private was sent anywhere, so the daemon's release timer asks again here: one task per call (the timer runs
   * one at a time), the least tried first, at most RESCREEN_MAX times each in a hub run; text too long for the screen
   * never clears. `clear` lifts the pii signal and routes the task as usual (a named owner is not remembered, a reserved
   * one is offered first as always), `pii` settles it, another unknown changes only the record. A task an owner took
   * (`local`), even one declined back since, keeps its PII path: its notes, summary and decline reason are not screened.
   */
  async rescreen(): Promise<void> {
    if (!this.screenOn()) return;
    const waiting = (t: Task) => {
      const last = [...t.history].reverse().find((h) => h.event === "screened")?.note ?? "";
      return t.state === "proposed" && !t.owner && !t.history.some((h) => h.owner) && t.signals.includes("pii") && last.startsWith("pii: unknown") && last !== "pii: unknown, too long";
    };
    const tries = (t: Task) => this.rescreens.get(t.id) ?? 0;
    const rescreenMax = this.d.rescreenMax?.() ?? RESCREEN_MAX;
    const task = this.d.board.list("proposed").filter((t) => waiting(t) && tries(t) < rescreenMax).sort((a, b) => tries(a) - tries(b))[0];
    if (!task) return;
    this.rescreens.set(task.id, (this.rescreens.get(task.id) ?? 0) + 1);
    const text = screenText(task);
    const v = this.nameable(text) ? await this.screenCall(text) : undefined; // a pattern added since settles it
    const now = this.d.board.get(task.id);
    if (!now || !waiting(now)) return; // taken or moved meanwhile: its verdict stands
    this.recordScreen(task.id, "task", v);
    if (v?.label === "unknown") return;
    if (v?.label !== "clear") return void this.d.board.update(task.id, HUB, "screened", {}, v ? `pii: screen, ${v.category}` : "pii: regex");
    const lifted = this.d.board.update(task.id, HUB, "screened", { signals: now.signals.filter((s) => s !== "pii") }, "clear, screened again");
    if (this.personUnassigned(lifted)) return;
    this.d.notify(`task ${this.publicTitle(lifted)}: the PII screen cleared it on a second look; it is routed as usual`);
    const still = this.waitsFor(lifted);
    if (still.length) return void this.d.board.update(lifted.id, HUB, "blocked", {}, `waits for ${still.map((id) => `#${id}`).join(", ")}`);
    try {
      await this.assignOwner(lifted, HUB);
    } catch (e) {
      // A saved move whose delivery failed: the console notice was printed where the error was thrown (#297).
      if (!(e instanceof AssignmentUndeliveredError)) throw e;
    }
  }

  /**
   * Open tasks of other owners whose paths overlap this one's. The later claimant settles it with the other owner, so
   * only the new owner reads "settle it"; anyone else learns that the owner was told. PII tasks are left out on both
   * sides: their refs are hidden from cloud peers.
   */
  overlaps(task: Task, forOwner = true, found = this.overlapHits(task)): string {
    const hits = found.map((h) => `#${h.task.id} (owner ${h.task.owner}) on ${this.where(h)}`);
    if (!hits.length) return "";
    if (this.silentFor(task.id)) {
      // A silent cohort (issue #107): the plans are what the owner works from, and nobody negotiates by message.
      const plans = found.map((h) => (planText(h.task.plan) ? `#${h.task.id}'s plan: ${planText(h.task.plan)}` : "")).filter(Boolean);
      const who = forOwner
        ? `Do not message ${found.length > 1 ? "those owners" : "that owner"}: you are in one turn-free cohort, the hub shows you their changes as you work and asks the last of you to finish to check the work against the others.${plans.length ? ` ${plans.join(" | ")}` : ""}`
        : `${task.owner ?? "Whoever takes it"} works alongside without messages (turn-free).`;
      return `Overlaps ${hits.join("; ")}. ${who}`;
    }
    const who = forOwner ? "Settle it with that owner via hub_send before editing those paths." : `${task.owner ?? "Whoever takes it"} is told to settle it.`;
    return `Overlaps ${hits.join("; ")}. ${who}`;
  }

  turnFree = (): boolean => this.d.turnFree?.() ?? false;

  /** Whether `task` is in a silent cohort: its owner works without messages to the other members (issue #107). */
  silentFor = (task: number): boolean => this.turnFree() && !!this.cohorts.of(task)?.silent;

  /** The live silent cohort that makes a message from `from` to `to` cohort coordination (issue #107). */
  silenced = (from: PeerId, to: PeerId) => (this.turnFree() ? this.cohorts.silenced(from, to) : undefined);

  /**
   * What `peer`'s turn-free facts cover (issue #108): for each live cohort in which it still has an open task, the paths
   * every member's task names, the other members' plans, and the task its own writes are reported under. Membership,
   * not open overlap, so the last member to finish still sees the others' final edits. Undefined without such a task.
   */
  factScope = (peer: PeerId): { paths: string[]; plans: { task: number; owner: PeerId; text: string }[]; task?: { id: number; title: string }; since?: number } | undefined => {
    const open = (task: number) => OPEN.includes(this.d.board.get(task)?.state ?? "approved");
    const members = this.cohorts.list().filter((c) => [...c.members.values()].some((m) => m.owner === peer && open(m.task))).flatMap((c) => [...c.members.values()]);
    const tasks = members.flatMap((m) => {
      const t = this.d.board.get(m.task);
      return t && t.owner === m.owner && !this.isPii(t) ? [t] : [];
    });
    const mine = tasks.filter((t) => t.owner === peer && OPEN.includes(t.state));
    if (!mine.length) return undefined;
    const paths = [...new Set(tasks.flatMap((t) => this.places(t).paths))].filter((p) => p !== "." && this.nameable(p));
    const plans = tasks.filter((t) => t.owner !== peer).map((t) => ({ task: t.id, owner: t.owner!, text: planText(t.plan) })).filter((p) => p.text);
    // When the earliest of its tasks was handed over: work from before facts were tracked is not covered.
    const since = Math.min(...mine.map(handedAt));
    return { paths, plans, task: { id: mine[0]!.id, title: mine[0]!.title }, since };
  };

  /** The tasks an overlap text for `task` names: their plans are in it (issue #108). */
  overlapTasks = (task: Task): number[] => this.overlapHits(task).map((h) => h.task.id);

  /** Console detail advice only: no pair persistence, and no private task on either side. */
  symbolOverlaps(task: Task): { task: number; files: string[]; sameFileDifferentSymbols: boolean }[] {
    // A routing-locality opt-out does not make symbol metadata for a marked task public.
    const markedPrivate = (value: Task) => value.signals.includes("pii") || value.signals.includes("pii_path");
    if (markedPrivate(task)) return [];
    return this.overlapHits(task).filter(hit => !markedPrivate(hit.task)).map(hit => ({
      task: hit.task.id,
      files: hit.paths.filter(this.publicMetadataText),
      sameFileDifferentSymbols: this.sameFileDifferentSymbols(task, hit),
    }));
  }

  /**
   * Dashboard warning links (#264): the board's overlap pairs and the live cohorts, as task and peer ids only.
   * Paths, symbols and plans stay out; PII tasks are excluded by the same rules overlapHits applies.
   * ponytail: O(open²) board reads per call, fine at dashboard board sizes; cache by board revision if it ever shows.
   */
  overlapLinks(): { tasks: [number, number]; peers: string[] }[] {
    const links: { tasks: [number, number]; peers: string[] }[] = [];
    const seen = new Set<string>();
    for (const task of this.d.board.list()) {
      if (!OPEN.includes(task.state) || !task.owner || this.isPii(task)) continue;
      for (const hit of this.overlapHits(task)) {
        const pair = [task.id, hit.task.id].sort((a, b) => a - b) as [number, number];
        const key = pair.join(":");
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ tasks: pair, peers: [...new Set([task.owner, hit.task.owner!])].sort() });
      }
    }
    return links;
  }

  /** The live cohorts as dashboard links (#264): member task ids and their owners, nothing else. */
  cohortLinks(): { tasks: number[]; peers: string[] }[] {
    const links: { tasks: number[]; peers: string[] }[] = [];
    for (const cohort of this.cohorts.list()) {
      const members = [...cohort.members.values()].filter(member => { const task = this.d.board.get(member.task); return task && !this.isPii(task); });
      if (members.length < 2) continue;
      links.push({ tasks: members.map((m) => m.task).sort((a, b) => a - b), peers: [...new Set(members.map((m) => m.owner))].sort() });
    }
    return links;
  }

  /** While a gone owner's tasks move, its other tasks are about to move too: they are no one to settle with. */
  private releasing: PeerId | undefined;

  /**
   * Notices that only matter while their recipient's task is open (issue #106): envelope id -> recipient and task, the
   * newest 1024. An envelope without a record (another kind, a restart, an evicted record) is delivered as before: its
   * purpose is never guessed from its kind.
   * ponytail: kept in memory, so after a restart such a notice is delivered whatever its task's state; persist the
   * condition if stale notices after restarts show up.
   */
  private readonly conditional = new Map<string, { peer: PeerId; task: number; tasks?: number[]; states: Task["state"][] }>();

  /**
   * Publish a notice about `task`, which only matters to `to` while that task is in one of `states` for it (issue
   * #106): open work by default; the conflict notices of #91 count a task in review too.
   */
  /**
   * #713: the completed-change notice of task `done` for one recipient, about all of its tasks in `about`. It stays relevant while any of them is still open for the
   * recipient, and carries `completedFor` so the bus replaces an earlier queued notice for the same `done` task and recipient.
   */
  whileOpenFor(to: PeerId, done: number, about: number[], body: string): void {
    requireLocalTaskPeer(to);
    const env = newEnvelope(HUB, body, { to: [to], kind: "task", refs: { task: String(about[0]), taskRecipient: "owner", completedFor: done } });
    this.conditional.set(env.id, { peer: to, task: about[0]!, tasks: about, states: OPEN });
    if (this.conditional.size > 1024) this.conditional.delete(this.conditional.keys().next().value as string);
    this.d.bus.publish(env);
  }

  whileOpen(to: PeerId, task: number, body: string, states: Task["state"][] = OPEN): void {
    requireLocalTaskPeer(to);
    const env = newEnvelope(HUB, body, { to: [to], kind: "task", refs: { task: String(task), taskRecipient: "owner" } });
    this.conditional.set(env.id, { peer: to, task, states });
    if (this.conditional.size > 1024) this.conditional.delete(this.conditional.keys().next().value as string);
    this.d.bus.publish(env);
  }

  /**
   * Whether a queued envelope still matters to `peer`; the bus asks per recipient at delivery (issue #106). False only
   * for a recorded notice to this peer whose task is gone, has another owner, or left the states it was about.
   */
  relevant = (peer: PeerId, env: Envelope): boolean => {
    if (env.from === HUB && env.kind === "task" && env.refs?.backlog) {
      const ids = env.refs.backlog;
      if (!Array.isArray(ids) || !ids.length || ids.length > 64 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return false;
      const current = ids.filter(id => {
        const task = this.d.board.get(id);
        return task?.state === "backlog" && this.taskPlanner(task).includes(peer);
      });
      if (current.length !== ids.length || !this.d.roles?.[peer]?.includes("planner") || !this.d.bus.isRostered(peer)) {
        this.addPlannerBacklog(peer, current);
        for (const id of ids) {
          const task = this.d.board.get(id);
          if (task?.state === "backlog" && !this.taskPlanner(task).includes(peer)) {
            for (const recipient of this.taskPlanner(task)) this.addPlannerBacklog(recipient, [id]);
          }
        }
        return false;
      }
      return true;
    }
    if (env.from === HUB && env.refs?.task) {
      const task = this.d.board.get(Number(env.refs.task));
      if (env.kind === "task" && env.refs.taskOffer !== undefined && task?.owner === peer && this.studyDispatchReason(task, peer)) {
        // The bus discards a false verdict for good and cannot hold the envelope. Remember the owner it was for (on the board, so it survives a restart), so approving the study again offers the retained task afresh.
        try { this.d.board.recordResearchDroppedOffer(task.id, peer); }
        catch (e) { this.releaseNotice(`task ${this.publicTitle(task)}: could not record the dropped study offer: ${e instanceof Error ? e.message : String(e)}`); }
        return false;
      }
      if (task?.state === "cancelled") return env.kind === "task" && typeof env.refs.taskCancelled === "number" && env.refs.taskCancelled === task.cancelled?.flowRevision;
      if (env.refs.taskRecipient === "planner") return !!task && this.taskPlanner(task).includes(peer);
      if (env.refs.planReview !== undefined) return !!task && !isClosedTaskState(task.state) && (task.planningRevision ?? 0) === env.refs.planReview
        && this.plannerHolders().includes(peer) && this.planAuthor(task) !== peer && Number.isSafeInteger(env.refs.planReviewFlow)
        && !task.history.slice(env.refs.planReviewFlow).some(entry => entry.event === "plan reviewed");
    }
    const c = this.conditional.get(env.id);
    if (!c || c.peer !== peer) return true;
    // A notice about several of the recipient's tasks matters while any one of them is still open for it (#713).
    return (c.tasks ?? [c.task]).some((id) => { const t = this.d.board.get(id); return !!t && t.owner === peer && c.states.includes(t.state); });
  };

  /** Whether a model-written name may be shown to other peers and in the log: one matching a PII pattern may be PII. */
  nameable = (t: string): boolean => !this.isPii({ signals: detectSignals({ title: "", detail: t, refs: {} }, this.d.routing(), this.d.cwd) });

  /**
   * Model-written free text about an ordinary task (a done summary, a review note with its unmet items, a handoff)
   * that matches a PII pattern stays on this machine (#69): every peer gets a stub, `local` too, which handles an
   * ordinary task's turn like any other (gateway off campus allowed, memory capture on). The board keeps the text for
   * `ahub task show`. A PII task's messages are private already. `withheld`: the PII screen did not clear it (#198).
   */
  private screen(task: Task, text: string, what: string, to: PeerId | null | undefined, withheld = false): string {
    if (!text || this.isPii(task) || to === USER || (!withheld && this.nameable(text))) return text;
    this.d.notify(`task #${task.id}: the ${what} was withheld from ${to ?? "a peer"} (${this.whyWithheld(text)})`);
    return `[${what} withheld: ${this.whyWithheld(text)}; ahub task show ${task.id}]`;
  }

  /** Where two tasks meet: shared paths, then shared symbols, leaving out any name that matches a PII pattern. */
  private where(hit: { paths: string[]; symbols: string[] }): string {
    const shown = [...hit.paths.filter(this.nameable), ...hit.symbols.filter(this.nameable).map((s) => `symbol ${s}`)];
    return shown.length ? shown.join(", ") : "a path whose name is withheld (it matches a PII pattern)";
  }

  /**
   * Paths from refs and plan, symbols from the plan: the places a task says it touches (issue #31). Models write paths
   * absolute or relative: one inside the project is compared in its project-relative spelling.
   */
  private warmRepository(task: Pick<Task, "refs" | "plan">): void {
    const scope = this.repositories.scope(task.refs);
    if (scope !== this.repositories.project) for (const path of [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])]) this.repositories.relativePath(scope, path);
  }

  private places(task: Task): { repositoryKey: string; paths: string[]; symbols: string[] } {
    const scope = this.repositories.scope(task.refs);
    const paths = [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])].map((p) => scope === this.repositories.project ? this.projectPath(p) : normPath(this.repositories.relativePath(scope, p)));
    const symbols = [
      ...(task.plan?.symbols ?? []).map(normalizePlanSymbol),
      ...(task.plan?.sections ?? []).map(v => `section ${v}`),
      ...(task.plan?.sources ?? []).map(v => `source ${v}`),
    ];
    return { repositoryKey: scope.key, paths: [...new Set(paths)], symbols: [...new Set(symbols)] };
  }

  private roots?: string[];
  private projectPath(p: string): string {
    if (!isAbsolute(p)) return normPath(p);
    if (!this.roots) {
      let real = this.d.cwd;
      try { real = realPath(this.d.cwd); } catch { /* compared as given */ }
      this.roots = [...new Set([this.d.cwd, real])];
    }
    for (const root of this.roots) {
      const r = relative(root, p);
      if (!r.startsWith("..") && !isAbsolute(r)) return normPath(r || ".");
    }
    return p;
  }

  private overlapHits(task: Task): { task: Task; paths: string[]; symbols: string[] }[] {
    const mine = this.places(task);
    if ((!mine.paths.length && !mine.symbols.length) || this.isPii(task)) return [];
    return this.d.board.list().flatMap((t) => {
      if (t.id === task.id || !t.owner || t.owner === task.owner || t.owner === this.releasing || !OPEN.includes(t.state) || this.isPii(t)) return [];
      const theirs = this.places(t);
      if (mine.repositoryKey !== theirs.repositoryKey) return [];
      const paths = task.profile && t.profile && (task.plan?.sections?.length && t.plan?.sections?.length) ? [] : mine.paths.filter((p) => theirs.paths.some((q) => samePlace(p, q)));
      const symbols = mine.symbols.filter((x) => theirs.symbols.some((y) => symbolsOverlap(x, y)));
      return paths.length || symbols.length ? [{ task: t, paths, symbols }] : [];
    });
  }

  /** The console notice and the telemetry record of an overlap; the two are counted against each other (issue #40). */
  private announceOverlap(task: Task, hits: ReturnType<Tasks["overlapHits"]>): void {
    this.d.notify(`task ${this.publicTitle(task)} (${task.owner}): ${this.overlaps(task, false, hits)}`);
    this.d.recordOverlap?.(task.id, task.owner!, hits.map((h) => ({ task: h.task.id, owner: h.task.owner!, paths: h.paths.filter(this.nameable), ...(h.symbols.length ? { symbols: h.symbols.filter(this.nameable) } : {}) })));
  }

  /**
   * The earlier owners hear of an overlap on their next delivery, costing them no turn; the newcomer settles it (#6).
   * Its plan rides along, so they know what it will touch (issue #31).
   */
  private tellEarlierOwners(task: Task, hits = this.overlapHits(task)): void {
    if (!task.owner || !this.d.tell) return;
    const plan = planText(task.plan);
    for (const hit of hits) {
      if (hit.task.owner === USER || hit.task.owner === HUB) continue;
      const how = this.silentFor(task.id) ? `do not message ${task.owner}: you are in one turn-free cohort and the hub shows you its changes as you work` : `${task.owner} is told to settle it`;
      this.d.tell(hit.task.owner!, noteLine(HUB, "finding", `task #${task.id} (owner ${task.owner}) now overlaps your #${hit.task.id} on ${this.where(hit)}; ${how}${plan ? `. Its plan (full: hub_task_list): ${plan}` : ""}`));
    }
  }

  /**
   * An owner offline past the limit loses its open tasks back to routing, through the same path a budget pause uses.
   * Only when some other peer can take a task: with nobody to hand it to, it stays with its owner.
   */
  async releaseFromGone(peer: PeerId, minutes: number): Promise<{ id: number; title: string; to: PeerId | null }[]> {
    requireLocalTaskPeer(peer);
    const moved: { id: number; title: string; to: PeerId | null }[] = [];
    const why = `owner ${peer} offline for ${minutes} min`;
    const ids = this.d.board.list().filter((t) => t.owner === peer && OPEN.includes(t.state)).map((t) => t.id);
    this.releasing = peer;
    try {
      for (const id of ids) {
        // Awaits run between tasks (briefs, memory): re-read, and stop for anything that changed meanwhile.
        const task = this.d.board.get(id);
        if (!task || task.owner !== peer || !OPEN.includes(task.state) || this.d.bus.stateOf(peer) !== "offline") continue;
        if (!assign(task, this.states(), this.d.routing(), { exclude: [...this.excluded(task), peer], excludeOwners: this.plannerPullRecord(task)?.pull ? this.plannerFull(task) : [], ...this.health() }).owner) continue;
        try {
          const back = task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, why) : task;
          const next = await this.assignOwner(back, HUB, { exclude: [peer], event: "reassigned", reason: "offline", note: why });
          if (this.ownOwnerMove(back, next, HUB, "reassigned")) moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner });
          // The gone owner hears it on its next delivery, if it comes back mid-work.
          if (next.owner && next.owner !== peer) this.d.tell?.(peer, noteLine(HUB, "decision", `task #${task.id} moved to ${next.owner} while you were offline; stop working on it`));
        } catch (e) {
          if (e instanceof AssignmentUndeliveredError) {
            // The move is fact for the board, so it is fact here too: record it, and tell the gone owner to stop
            // (the console notice was printed where the error was thrown) (#297).
            moved.push({ id: task.id, title: this.publicTitle(task), to: e.task.owner });
            if (e.task.owner && e.task.owner !== peer) this.d.tell?.(peer, noteLine(HUB, "decision", `task #${task.id} moved to ${e.task.owner} while you were offline; stop working on it`));
          } else this.d.notify(`task ${this.publicTitle(task)}: could not be released from ${peer}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.releasing = undefined;
    }
    return moved;
  }

  /** Same code as assignment, without doing it. `routing`: a candidate policy to explain under (the settings preview, #269). */
  explain(target: number | { title: string; detail?: string; class: TaskClass; refs?: TaskRefs }, routing: Routing = this.d.routing()): string[] {
    const workflow = this.d.sdlc?.config().workflow === "gsd-lite" ? [`criteria checklist required on every task (retired gsd-lite setting, ${this.d.sdlc.config().mode}); board dependencies authoritative`] : [];
    if (typeof target === "number") {
      const task = this.d.board.get(target);
      if (!task) throw new Error(`no task #${target}`);
      if (isClosedTaskState(task.state)) return [...workflow, `task ${this.publicTitle(task)} (${task.state}): closed; not routed`];
      const planned = task.state === "backlog" && !!task.reserved || this.plannerPullRecord(task)?.pull === true;
      const a = planned ? this.plannerAssignment(task, true, routing)
        : assign(task, this.states(), routing, { exclude: this.excluded(task), waitsFor: this.waitsFor(task), ...this.weights(task.class, task) });
      // The split trace is for the pair the record is about: the task's owner when it has one (issue #109).
      return [...workflow, `task ${this.publicTitle(task)} (${task.state}, owner ${task.owner ?? "none"}${task.reserved ? `, reserved for ${task.reserved}` : ""})`, ...(task.profileClass ? [`profile class ${profileTaskLabel(task)}`] : []), ...(task.role ? [`task role ${task.role} (guidance only)`] : []), "if it were assigned now:", ...a.trace, ...(this.splitShadow(task, task.owner ?? a.owner)?.trace ?? [])];
    }
    const draft = { title: target.title, detail: target.detail ?? "", refs: target.refs ?? {} };
    const signals = this.signalsFor(draft, routing);
    const base = profileClass(target.class, this.d.profileData ?? this.d.profile);
    const trace = [...(this.d.profile && this.d.profile !== "dev" ? [`profile class ${target.class} (base ${base}, ${this.d.profile})`] : []), ...assign({ class: base, signals, ...draft }, this.states(), routing, this.weights(base)).trace];
    // A draft is not sent to the PII screen (issue #198): a proposal is, and a pii or unknown verdict adds the pii signal.
    return [...workflow, ...(this.screenOn() && !signals.includes("pii") ? [...trace, "pii_screen is on: at proposal a pii or unknown verdict adds signal pii (local only)"] : trace)];
  }

  /** Public read path: every generated line is screened, including profile/config-derived trace fields. */
  publicExplain(target: number | { title: string; detail?: string; class: TaskClass; refs?: TaskRefs }, routing?: Routing): string[] {
    const trace = this.explain(target, routing);
    const holds = Object.entries(this.d.held?.() ?? {}).flatMap(([peer, hold]) =>
      trace.some(line => line.startsWith(`  hold: ${peer}'s queue is held:`)) ? [] : [`${peer} queue: ${hold}`]);
    return [...trace, ...holds].map(line => this.nameable(line) ? line : "[routing explanation withheld: it matches a PII pattern]");
  }

  /**
   * Peers routing leaves out for good (#207): the owners a task was declined for (the console declines for one; older rows
   * name only the decliner) and the owners it was escalated away from, so a reservation never hands it back to them.
   */
  private excluded = (task: Task) => task.history.flatMap((h) => (h.event === "declined" && h.capacity !== true ? [h.from ?? h.by] : h.event === "escalated" && h.from ? [h.from] : []));

  private checkFlowRevision(task: Task, expected: number | undefined, preEffect = false): void {
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || task.history.length !== expected)) {
      throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: flow revision changed; reload and retry`);
    }
  }

  /** Authorized manual owner removal sticks until a later explicit assignment/reservation, across hub runs. */
  private personUnassigned(task: Task): boolean {
    const manual = (h: HistoryEntry) => h.by === USER || h.conductorManual === true;
    const removed = task.history.findLastIndex((h) => h.event === "unassigned" && manual(h));
    if (removed < 0) return false;
    return !task.history.slice(removed + 1).some((h) => manual(h) && ["assigned", "reassigned", "escalated", "reserved", "backlog pulled"].includes(h.event));
  }

  /**
   * Says on the console and hub.log that routing passed over the reserved owner (#207); returns the history note's suffix.
   * Only news is said: not when the reserved owner is the one the task moves away from, nor once it refused the task for
   * good (its decline or escalation said that).
   */
  private passedOver(task: Task, a: Assignment): string {
    if (!a.unreserved || task.reserved === task.owner || this.excluded(task).includes(task.reserved!)) return "";
    // Before the write, but after the caller's own (a decline's, say): a throwing console fails nothing (#297).
    this.releaseNotice(`task ${this.publicTitle(task)}: its reserved owner ${task.reserved} is passed over (${a.unreserved}); routing proceeds`);
    return `; reserved owner ${task.reserved} passed over: ${a.unreserved}`;
  }

  /** Why the task will approve directly at done: no reviewer could be picked, and who was skipped (issue #92). */
  private noReviewer(a: Assignment): string {
    if (a.reviewBlocked) return "blocked: no reviewer can run";
    const skipped = a.trace.flatMap((l) => {
      const m = /^ {2}reviewer candidate (\S+): skipped, (.*)$/.exec(l);
      return m ? [`${m[1]} (${m[2]})`] : [];
    });
    return `no reviewer: done will approve directly${skipped.length ? ` (skipped: ${skipped.join("; ")})` : ""}`;
  }

  private announceRouting(task: Task, a: Assignment): void {
    if (task.class !== "review" && !a.reviewer) this.d.notify(`task ${this.publicTitle(task)}: ${this.noReviewer(a)}`);
    const hold = a.owner ? peerEntry(this.d.held?.(), a.owner) : undefined;
    if (hold) this.d.notify(`task ${this.publicTitle(task)}: ${a.owner}'s queue is held (${hold}); the task arrives once the hold is resolved`);
  }

  private assignmentNote(note: string, assignment: Assignment): string {
    const tagged = assignment.sameFamilyFallback ? `${note}; sameFamilyFallback=true` : note;
    const pool = assignment.reviewSelection, metadata = this.reviewMetadata(assignment);
    const walk = pool?.blocked ? pool.walk.slice(0, 16).map(row => {
      const reason = this.nameable(row.reason) ? Array.from(sanitize(row.reason).replace(/\s+/g, " ")).slice(0, 80).join("") : "[withheld]";
      return `${row.id || row.kind}: ${reason}`;
    }).join("; ") + (pool.walk.length > 16 ? `; +${pool.walk.length - 16} walk entries` : "") : "";
    const recorded = pool ? `${tagged}; reviewerFamily=${metadata.reviewerFamily ?? "none"}; reviewerReason=${metadata.reviewerReason ?? pool.blocked}${pool.blocked ? `; pool=${pool.blocked}; walk: ${walk}` : ""}` : tagged;
    return assignment.plannerFallback ? `${recorded}; reviewer=planner (fallback)` : recorded;
  }

  /** A later move to another owner means the caller's assignment was superseded, so its success tail is not authoritative. */
  private ownOwnerMove(before: Task, after: Task, by: PeerId, event: string): boolean {
    const moves = (task: Task) => task.history.filter(entry => ["assigned", "reassigned", "escalated", "unassigned"].includes(entry.event));
    const prior = moves(before).length, entries = moves(after).slice(prior), own = entries[0];
    if (!own || own.by !== by || own.event !== event) return false;
    if (own.event === "unassigned") return entries.length === 1;
    return entries.every(entry => entry.owner === own.owner);
  }

  /** `override`: a person's explicit assign, which past refusals do not block and which drops an agent's reservation (#207). */
  private async assignOwner(task: Task, by: PeerId, opts: { current?: () => void; conductorManual?: true; queueOverride?: "owner"; candidates?: PeerId[]; namedOwner?: PeerId; event?: string; note?: string; reason?: TaskMoveReason; clearOnFail?: boolean; exclude?: PeerId[]; context?: string; contextWithheld?: boolean; claim?: boolean; override?: boolean; roster?: boolean; planner?: boolean; expectedFlowRevision?: number; refuseNamed?: "pre" | "plain"; plannerPull?: { revision: number; note: string; withheld: boolean; guard: () => void } } = {}): Promise<Task> {
    opts.current?.();
    if (task.state === "backlog" && !opts.plannerPull) throw new PreEffectToolRefusal(`task #${task.id}: pull backlog work before assigning it`);
    const studyReason = this.studyDispatchReason(task, opts.namedOwner);
    if (studyReason) {
      if (opts.refuseNamed || opts.plannerPull || opts.claim) throw new PreEffectToolRefusal(studyReason);
      if (task.state === "proposed" && !task.owner) this.holdReady(task, "study dispatch", studyReason);
      return task;
    }
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    let stagedClaimGap: string | undefined;
    if (mode !== "off" && this.isBuildTask(task)) {
      const gap = task.sdlc?.planReview ? await this.planReviewGap(task) : "plan not reviewed since proposal";
      opts.current?.();
      const current = this.d.board.get(task.id);
      if (!current || !this.ownerAssignmentCurrent(task, current)) {
        if (opts.plannerPull) throw new PreEffectToolRefusal("planner pull changed during admission");
        return current ?? task;
      }
      task = current; // Reviewer-only and quiet bookkeeping updates do not supersede ownership authority.
      if (gap) {
        this.requestIndependentPlanReview(current);
        this.releaseNotice(`task ${this.publicTitle(current)}: ${gap}; planner: call hub_planner_groom then hub_plan_review`);
        if (mode === "enforce") {
          if (opts.claim && opts.namedOwner === by) stagedClaimGap = gap;
          else {
            if (opts.refuseNamed && opts.namedOwner) throw new (opts.refuseNamed === "pre" ? PreEffectToolRefusal : Error)(`cannot assign task #${current.id} to ${opts.namedOwner}: ${gap}; planner: call hub_planner_groom then hub_plan_review`); // #601, before the stall write
            this.reportStall(current, { kind: "no-eligible-peer", code: "policy" });
            return current;
          }
        }
      }
    }
    const waits = this.waitsFor(task);
    const plannedMove = opts.planner || this.plannerPullRecord(task)?.pull === true && (by === HUB || opts.roster) && (opts.reason !== "manual" || opts.roster);
    const plannerFull = plannedMove ? this.plannerFull(task) : [];
    const a = assign(opts.plannerPull ? { ...task, state: "proposed" } : task, this.states(), this.d.routing(), { exclude: [...(opts.override ? [] : this.excluded(task)), ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], excludeOwners: [...plannerFull, ...this.studyExcludedOwners(task)], ...(opts.candidates ? { candidates: opts.candidates } : {}), waitsFor: waits, ...this.weights(task.class, task), ...(opts.namedOwner ? { namedOwner: opts.namedOwner } : {}), // A self-claim hands over no envelope; reviewer admission remains automatic.
      contextOverride: !!(opts.queueOverride || opts.claim),
      ...(opts.queueOverride || opts.claim ? { queueOverride: opts.queueOverride ?? "owner" as const } : {}) });

    if (waits.length) {
      if (opts.plannerPull) throw new PreEffectToolRefusal("planner pull waits for dependency approval");
      this.releaseNotice(`task ${this.publicTitle(task)} waits for ${waits.map((id) => `#${id}`).join(", ")}; it is offered once they are approved`);
      return task;
    }
    const passed = this.passedOver(task, a);
    if (!a.owner) {
      // An explicit assignment says why the named peer cannot take it, before any write (#601).
      if (opts.refuseNamed && opts.namedOwner) {
        const why = a.refusals?.find(row => row.role === "owner" && row.peer === opts.namedOwner)?.reason ?? "not eligible";
        throw new (opts.refuseNamed === "pre" ? PreEffectToolRefusal : Error)(`cannot assign task #${task.id} to ${opts.namedOwner}: ${why}${/offline|not attached/.test(why) ? "; assign again once it is attached" : ""}`);
      }
      this.releaseNotice(opts.roster
        ? `task ${this.publicTitle(task)}: ${task.owner} is off roster and no peer can take it; it stays with ${task.owner} in ${task.state}; assign with: ahub task assign ${task.id} <peer>`
        : `task ${this.publicTitle(task)}: no peer can take it (${a.trace.filter((l) => l.includes("skipped")).length} skipped); assign with: ahub task assign ${task.id} <peer>`);
      // Only a decline takes the task away from its owner; a failed console assign or escalation leaves it where it was.
      if (opts.clearOnFail && task.owner) {
        this.cohorts.leave(task.id);
        task = this.d.board.update(task.id, by, "unassigned", { owner: null });
      }
      if (!task.owner && task.state === "proposed") {
        const cause = this.ownerStallCause(task, a, !opts.claim);
        // A named proposal remains bound to that target when pressure clears.
        this.reportStall(task, cause.kind === "no-eligible-peer" && isQueuePressureCode(cause.code) && opts.namedOwner ? { ...cause, peer: opts.namedOwner } : cause);
      }
      return task;
    }
    const profile = this.d.splitProfile?.(a.owner);
    // A person's explicit assign replaces an agent's reservation (#207). Only a refusal keeps the owner it moves away from
    // out for good: a reviewer's rejections or an escalation by hand, never the hub's own move after a failed delivery.
    const lasting = opts.event === "escalated" && task.owner && (opts.reason === "rejections" || opts.reason === "manual");
    opts.plannerPull?.guard();
    const assignmentNote = this.assignmentNote(`${opts.note ?? `to ${a.owner}`}${passed}`, a);
    const binding = this.plannerBinding(task, a, !!opts.plannerPull);
    const assignmentExtra = { ...this.reviewMetadata(a, task), ...(binding ? { plannerReason: binding.plannerReason } : {}), ...(profile ? { profile } : {}), ...(opts.reason ? { reason: opts.reason } : {}), ...(lasting ? { from: task.owner! } : {}), ...(opts.conductorManual ? { conductorManual: true as const } : {}) };
    opts.current?.();
    this.studyDispatchCheck(this.d.board.get(task.id) ?? task, a.owner);
    const next = opts.plannerPull
      ? this.d.board.pullAssigned(task.id, by, a.owner, opts.plannerPull.revision, opts.plannerPull.note, opts.plannerPull.withheld, a.reviewer ?? null, assignmentNote, assignmentExtra, task.history.length, binding)
      : this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(binding ? { planner: binding.planner } : {}), ...(opts.roster && task.state === "in_progress" ? { state: "proposed" as const } : {}), ...(opts.event === "escalated" ? { rejections: 0 } : {}), ...(opts.override && task.reserved ? { reserved: null } : {}) }, assignmentNote, assignmentExtra, opts.expectedFlowRevision);
    this.queueReviewWritten(next);
    if (opts.plannerPull) this.planningRecorded({ by, task: next.id, fields: ["pull", "reserved"], revision: next.planningRevision! });
    // What calibration reads (issue #109): routing chose the first owner (no single named candidate, no claim; not an
    // escalation, relay or reassignment of work already begun), and the work overlaps another owner's task not started
    // yet. For the record only. Work routed back to its proposer is left out, as its observations are (by === owner).
    if ((opts.event ?? "assigned") === "assigned" && !opts.claim && opts.candidates?.length !== 1 && a.owner !== by) {
      try {
        const shadow = this.splitShadow(next, a.owner, true);
        if (shadow) this.d.recordSplit?.(next.id, shadow, "routing");
      } catch { /* shadow only: never between the board write and the delivery */ }
    }
    // A claim is its own hand-over: the claimant took the task in the turn it is in, so it is taking it, not busy elsewhere.
    // The cohort record formed just below reads it, and so does `route explain` while that turn lasts.
    if (opts.claim && a.owner === by && this.d.bus.peers.get(by)?.state === "busy") this.sent.set(handOver(next, by), by);
    try {
      opts.current?.();
      if (opts.plannerPull && task.offer) {
        const prior = { ...task, owner: task.offer.owner };
        this.withdrawRoleRequest(prior, next, "owner");
        this.releaseNotice(`task #${next.id}: stale offer withdrawal failed`, () => this.d.bus.withdraw(task.offer!.envelopeId));
      }
      if (by === USER && opts.event === "reassigned") this.withdrawRoleRequest(task, next, "owner");
      const hits = this.overlapHits(next);
      this.formCohort(next, hits);
      if (hits.length) {
        this.announceOverlap(next, hits);
        this.tellEarlierOwners(next, hits);
      }
      this.announceRouting(next, a);
      if (!opts.claim || a.owner !== by) await this.sendTask(next, a, opts.context, this.overlaps(next, true, hits), opts.contextWithheld, opts.current);
    } catch (e) {
      // Everything between the write and the end of the delivery is in here: the move is fact, and a failure is a
      // delivery failure (#297). The one console notice is printed here, once, for every caller; callers decide
      // control flow by the error type.
      let saved = next;
      try {
        saved = this.d.board.get(task.id) ?? next;
      } catch { /* the write's row is still true */ }
      // Superseded means a later entry that moves or settles the task: another assignment, an unassign, the
      // owner's accept, done, approval, close. Entries that do neither (the hub's quiet bookkeeping, a check
      // result landing during the brief) leave the assignment exactly as undelivered as before: the notice and
      // the typed error stand (#297 Decisions).
      const moves = (entries: Task["history"]) => entries.filter((h) => !QUIET_EVENTS.has(h.event) && !h.event.startsWith("check "));
      if (moves(saved.history).length !== moves(next.history).length) {
        if (e instanceof AssignmentSupersededError) return saved;
        throw e;
      }
      this.releaseNotice(this.undeliveredNotice(saved, e));
      throw new AssignmentUndeliveredError(saved, e);
    }
    // A claim is its own hand-over, with no delivery: its accepted write and its line stay as they were (#297).
    if (opts.claim && a.owner === by) {
      // #481 S1: a claim of build work starts it only from an accepted spec. In enforce the claim stays an assignment
      // (owner set, still proposed); hub_task_accept starts it once the person accepted the spec.
      if (this.specGated(next) && specState(next.sdlc, undefined) === "missing") {
        if (this.d.sdlc?.config().mode === "enforce") { this.releaseNotice(`${this.specText(next, "missing", "blocked")}; the claim stays assigned to ${by}`); return next; }
        this.releaseNotice(this.specText(next, "missing", "advice"));
      }
      if (stagedClaimGap) return next; // An explicit claim may reserve its owner, but no offer or acceptance bypasses review.
      this.studyDispatchCheck(next, by);
      const claimed = this.d.board.update(next.id, by, "accepted", { state: "in_progress" });
      this.captureOwnerAcceptance(claimed);
      this.releaseNotice(`task ${this.publicTitle(claimed)} claimed by ${by}`);
      return claimed;
    }
    return next;
  }

  /** #933: the person, or the configured conductor inside an admitted operation (`TasksDeps.operational` rechecks the role). */
  private personOrConductor(by: PeerId): boolean { return by === USER || this.d.operational?.(by) === true; }

  /** Advice changes by the person or, #933, the task's own owner never change ownership, class or authority. */
  setRole(by: PeerId, id: unknown, raw: unknown): Task {
    if (raw === undefined) throw new PreEffectToolRefusal("name a catalog role id or explicit null to clear it");
    const task = this.need(id, false, true);
    if (by !== USER && task.owner !== by) throw new PreEffectToolRefusal(`task #${task.id} is not yours: an agent changes the catalog role of its own task only`);
    // #933: under review the role is what the reviewer reviews against; only the person changes it then.
    if (by !== USER && task.state === "in_review") throw new PreEffectToolRefusal(`task #${task.id} is in review: only the person changes its catalog role until the verdict`);
    if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal("a closed task's role is historical; propose new work instead");
    let selected;
    try { selected = taskRole(raw === null ? undefined : raw, task.class, this.d.catalog ?? loadRoleCatalog(this.d.cwd)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    if (task.role === selected?.id) return task;
    const next = this.d.board.update(task.id, by, "catalog role changed", { role: selected?.id });
    for (const peer of new Set([next.owner, next.state === "in_review" ? next.reviewer : null])) {
      if (!peer || peer === USER) continue;
      this.releaseNotice(`task ${this.publicTitle(next)}: catalog role update delivery unconfirmed`, () => this.d.bus.publish(newEnvelope(HUB,
        `Task #${next.id}: catalog role changed by ${by === USER ? "the person" : by}. ${next.role ? this.roleGuidance(next, peer, peer === next.reviewer) : "Catalog guidance cleared; follow the task's existing plan and requirements."}`,
        { to: [peer], kind: "task", refs: { task: String(next.id), taskRecipient: peer === next.reviewer ? "reviewer" : "owner" }, ...(this.isPii(next) ? { private: true } : {}) })));
    }
    return next;
  }

  /** A self-claim has no assignment envelope; its tool result carries the same bounded guidance. */
  claimRoleGuidance(task: Task, peer: PeerId): string {
    requireLocalTaskPeer(peer);
    return task.owner === peer && task.state === "in_progress" ? this.roleGuidance(task, peer) : "";
  }

  private roleGuidance(task: Task, peer: PeerId, review = false): string {
    if (!task.role) return "";
    if (!review && this.d.sessionRoles?.(peer).includes(task.role)) return `Task role ${task.role} (already in your session guidance).`;
    const role = (this.d.catalog ?? loadRoleCatalog(this.d.cwd)).roles.get(task.role);
    if (role) try { return taskRoleText(role, review); } catch { /* a changed definition cannot break a saved assignment */ }
    return `Task role ${task.role}: definition unavailable or exceeds the task guidance limit; grants no authority.`;
  }

  private ownerAssignmentCurrent(assigned: Task, current: Task): boolean {
    if (current.owner !== assigned.owner) return false;
    const moves = (entries: Task["history"]) => entries.filter((h) => !QUIET_EVENTS.has(h.event) && !h.event.startsWith("check "));
    return moves(current.history).length === moves(assigned.history).length;
  }

  /** `contextWithheld`: the PII screen did not clear a budget hand-off (#198); an escalation's reason is the hub's own words. */
  private async sendTask(task: Task, a: Assignment, context?: string, overlap = "", contextWithheld = false, currentAuthority?: () => void): Promise<void> {
    currentAuthority?.();
    const brief = this.isPii(task) ? undefined : await this.d.briefs?.forTask(task.owner!, task, this.planGuardItems(task)).catch(() => undefined);
    currentAuthority?.();
    const current = this.d.board.get(task.id);
    if (!current || !this.ownerAssignmentCurrent(task, current)) throw new AssignmentSupersededError(current ?? task);
    this.studyDispatchCheck(current, current.owner ?? undefined);
    task = current;
    const pii = this.isPii(task), delivery = { ...a, reviewer: task.reviewer ?? undefined };
    const rejected = task.history.filter((h) => h.event === "changes_requested").map((h) => `- ${h.by}: ${this.screen(task, h.note ?? "", "review note", delivery.owner, h.withheld)}`);
    const handoff = context && !pii ? this.screen(task, context, "handoff", delivery.owner, contextWithheld).slice(0, 3000) : "";
    const facts = [`class ${profileTaskLabel(task)}`, delivery.owner && (this.d.adapterCatalog?.definitionOf ?? definitionOf)(delivery.owner, this.d.instances?.())?.routing?.backendLabel ? `backend ${(this.d.adapterCatalog?.definitionOf ?? definitionOf)(delivery.owner, this.d.instances?.())!.routing!.backendLabel}/${delivery.piBackend ?? "dgx"}` : "", task.refs.paths?.length ? `paths ${task.refs.paths.join(", ")}` : "", task.refs.branch ? `branch ${task.refs.branch}` : "", delivery.reviewer ? `reviewer ${delivery.reviewer}` : task.class === "review" ? "no reviewer" : this.noReviewer(delivery)].filter(Boolean).join("; ");
    const plan = planText(task.plan);
    const body = [
      `Task #${task.id} [${profileTaskLabel(task)}] ${task.title}`,
      task.detail,
      `Facts: ${facts}`,
      this.roleGuidance(task, task.owner!),
      plan ? `Plan so far: ${plan}` : "",
      overlap,
      rejected.length ? `Earlier review notes:\n${rejected.join("\n")}` : "",
      brief ?? "",
      // What the previous owner left behind. Peer-written free text: never attached to a PII task.
      handoff ? `Handoff from the previous owner:\n${handoff}` : "",
      task.state === "in_review"
        ? `Ownership moved while this task is already under review. Read it with hub_task_show {id: ${task.id}} and wait for the review verdict; do not accept it or repeat completed work.`
        : `Take it with hub_task_accept {id: ${task.id}, plan: {paths, symbols, signatures, insertion_points}} (what you will change, before you start${pii ? "" : "; owners of overlapping tasks see it"}) or pass with hub_task_decline. When finished: hub_task_done {id: ${task.id}, summary: what changed, why, and the check you ran with its result, refs}.`,
    ].filter(Boolean).join("\n\n");
    // A hand-over the owner takes in a turn of its own (#109, #115): idle before, busy after and not queued, this envelope
    // was in the delivery that started its turn. Busy before, it is queued, or steered into a turn about something else
    // (Codex, Pi); held, it starts no turn yet: neither is taking it.
    const owner = task.owner!;
    const idle = this.d.bus.stateOf(owner) === "idle";
    const env = newEnvelope(HUB, body, { to: [owner], kind: "task", priority: "important", refs: { ...task.refs, task: String(task.id), taskRecipient: "owner", taskOffer: task.history.length }, ...(pii ? { private: true } : {}) });
    currentAuthority?.();
    this.studyDispatchCheck(task, owner);
    this.d.board.recordTaskOffer(task.id, { envelopeId: env.id, owner, assignmentFlowRevision: task.history.length, ...(this.d.offerPullOnly ? { pullOnly: this.d.offerPullOnly(owner) } : {}) }, task.history.length);
    currentAuthority?.();
    this.studyDispatchCheck(task, owner);
    this.d.bus.publish(env);
    if (idle && this.d.bus.stateOf(owner) === "busy" && !this.d.bus.queueIds(owner).includes(env.id)) this.sent.set(handOver(task, owner), owner);
  }

  /** Nobody, the console user included, works on a task before what it waits for is approved. */
  private ready(task: Task, preEffect = false): void {
    const waits = this.waitsFor(task);
    if (waits.length) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} waits for ${waits.map((id) => `#${id}`).join(", ")}, not approved yet`);
  }

  /** Ready offers between their cap check and the owner write (#655): task id -> reserved owner whose slot it takes. */
  private readonly readyInFlight = new Map<number, PeerId>();

  /** Offer order for ready work (#655): priority (urgent is P0, none is P2), then rank, then id. */
  private readonly readyOrder = (a: Task, b: Task): number =>
    (a.priority ?? (a.signals.includes("urgent") ? 0 : 2)) - (b.priority ?? (b.signals.includes("urgent") ? 0 : 2))
    || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

  /** Ready work the hub parked on its reserved owner's WIP cap (#655): its latest move-or-hold entry is `ready held`. */
  private isHeld(task: Task): boolean {
    // A planner's priority or rank edit (`planned`) is no move: it must not make held work look released.
    return task.history.findLast(entry => entry.event === "ready held" || !QUIET_EVENTS.has(entry.event) && entry.event !== "planned")?.event === "ready held";
  }

  /**
   * Why readiness must not hand `task` to its reserved owner yet (#655): that owner is at its planner WIP cap, the count
   * `acceptanceCapacity` refuses at. Peer id and counts only, so it is safe for a PII task. A reserved owner the task
   * excludes is not honoured by routing, and planner-pulled work was admitted by its pull: neither is held.
   */
  private reservedHold(task: Task): string | undefined {
    const owner = task.reserved;
    if (!owner || task.owner || this.plannerPullRecord(task)?.pull === true || this.excluded(task).includes(owner)) return undefined;
    // Offers in flight take a slot before their owner is written; once it is written wip() counts it, so never twice.
    const flying = [...this.readyInFlight].filter(([id, peer]) => peer === owner && id !== task.id && !this.d.board.get(id)?.owner).length;
    const limit = this.wipLimit(owner), used = this.wip(owner, task.id) + (this.pendingClaims.get(owner) ?? 0) + flying;
    return used >= limit ? `reserved owner ${owner} is at its planner WIP cap (${used}/${limit}); stays ready in To Do with its reservation until a slot frees` : undefined;
  }

  /** The task is ready but its reserved owner has no room: say so once on the task history, never assign. */
  private holdReady(task: Task, why: string, reason: string): void {
    if (this.isHeld(task)) return;
    const ready = task.history.at(-1)?.event === "ready" ? task : this.d.board.update(task.id, HUB, "ready", {}, why);
    this.d.board.update(ready.id, HUB, "ready held", {}, reason);
    this.releaseNotice(`task ${this.publicTitle(ready)} is ready but held: ${reason}`);
  }

  /** An approved task may be the last thing others waited for: those go through assignment now (issue #34). */
  private async releaseDependents(approved: Task): Promise<void> {
    try {
      // Its dependents and, as its owner's slot just freed (#655), that owner's held ready tasks: one list in priority order.
      const ready = this.d.board.list("proposed").filter(t => !t.owner && !this.waitsFor(t).length
        && (t.deps?.includes(approved.id) || !!approved.owner && t.reserved === approved.owner && this.isHeld(t))).sort(this.readyOrder);
      for (const t of ready) await this.offerReady(t, t.deps?.includes(approved.id) ? `#${approved.id} approved` : "owner slot freed");
    } catch (e) {
      this.releaseNotice(`task #${approved.id}: could not release dependents: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The one guard for a publish or notify after a board write (#231, #243): the write took effect, so a failure
   * never throws back to the caller. A failed publish becomes a console notice naming what was lost; a failed notify
   * is dropped (a second attempt would fail the same way). A lost publish is not retried here: the delivery
   * journal's own recovery covers a storage error.
   */
  private releaseNotice(line: string, run?: () => unknown): void {
    if (!run) {
      try { this.d.notify(line); } catch { /* best effort; the release timer retries ownerless work */ }
      return;
    }
    try { run(); } catch (e) {
      try { this.d.notify(`${line}: ${e instanceof Error ? e.message : String(e)}`); } catch { /* best effort */ }
    }
  }

  /**
   * The one text for a saved assignment whose delivery is unconfirmed (#297), built through publicTitle (a PII task
   * shows nothing more than it does today): what to check, and how to send it again. No automatic resend: a blind
   * resend can duplicate a publish that did leave (the #276 decision).
   */
  undeliveredNotice(task: Task, cause: unknown): string {
    const owner = task.owner ?? "its owner";
    return `task ${this.publicTitle(task)}: the move to ${owner} is saved, but its assignment's delivery is not confirmed (${cause instanceof Error ? cause.message : String(cause)}); look for a queued or needs_review delivery with ahub queue list --peer ${owner} (then ahub queue show <id>), or the accepted entry in ahub task show ${task.id} if the journal is down; send it again with: ahub task assign ${task.id} ${owner}`;
  }

  private readonly offered = new Set<number>(); // assignments in this hub run, including offers still in flight
  private readonly sent = new Map<string, PeerId>(); // hand-over (`handOver`) -> owner, for the owner's current turn: its task envelope started it, or it claimed the task in it

  /**
   * A stop between an approval and the assignment of its dependents (both are saved on their own) leaves them ownerless
   * with nothing left to wait for, and no later approval to offer them. The daemon calls this on its release timer:
   * each such task is offered once an attached peer can take it (peers attach one by one). Only an assignment uses
   * up its offer for this hub run; a failed or ownerless offer stays eligible, after approval and on the timer alike.
   */
  private offerCandidates?: { revision: number; offers: { task: number; peer: PeerId; envelopeId: string; assignmentFlowRevision: number; pullOnly?: boolean }[] };
  private stallCandidates?: { revision: number; rows: { stall: TaskStall; task: Task; planned: boolean }[] };
  private stallView?: { key: string; stalls: TaskStall[] };

  pendingOffers(): { task: number; peer: PeerId; envelopeId: string; assignmentFlowRevision: number; pullOnly?: boolean }[] {
    const revision = this.d.board.statusRevision();
    if (this.offerCandidates?.revision !== revision) this.offerCandidates = { revision, offers: this.d.board.list("proposed").flatMap(task => {
      const offer = task.offer;
      if (!offer || task.owner !== offer.owner || task.history.slice(offer.assignmentFlowRevision).some(h => ["accepted", "declined", "assigned", "reassigned", "escalated", "unassigned", "reserved", "backlog returned"].includes(h.event) || h.owner !== undefined && h.owner !== offer.owner)) return [];
      return [{ task: task.id, peer: offer.owner, envelopeId: offer.envelopeId, assignmentFlowRevision: offer.assignmentFlowRevision, ...(offer.pullOnly === undefined ? {} : { pullOnly: offer.pullOnly }) }];
    }) };
    return this.offerCandidates.offers.filter(offer => {
      try { return this.d.offerRead?.(offer.peer, offer.envelopeId) !== true; } catch { return true; }
    }).map(offer => ({ ...offer }));
  }
  /** A status-only snapshot is advisory; all effect/admission callers retain fresh health by default. */
  stalled(projection?: { ownerIsolation: Readonly<Record<string, boolean>> }): TaskStall[] {
    const revision = this.d.board.statusRevision();
    if (this.stallCandidates?.revision !== revision) this.stallCandidates = { revision, rows: this.d.board.stalls().flatMap(stall => {
      const task = this.d.board.get(stall.task);
      if (stall.cause.kind === "no-writes") return (this.sweepConfig.no_writes_turns ?? 2) > 0 && task?.state === "in_progress" && ["implement", "bulk_edit"].includes(task.class) && task.owner === stall.cause.peer && this.ownerAcceptance(task)?.index === stall.cause.acceptance ? [{ stall, task, planned: false }] : [];
      if (task?.state !== "proposed" || task.owner || (task.planningRevision ?? 0) !== stall.replanRevision) return [];
      if (stall.cause.kind === "cancelled-dependency") return task.deps?.includes(stall.cause.dependency!) === true && this.d.board.get(stall.cause.dependency!)?.state === "cancelled" ? [{ stall, task, planned: false }] : [];
      return this.waitsFor(task).length ? [] : [{ stall, task, planned: this.plannerPullRecord(task)?.pull === true }];
    }) };
    // Eligibility inputs are live; queue journal writes alone do not re-decode board histories.
    const health = this.health(projection?.ownerIsolation);
    const key = JSON.stringify([revision, this.states(), this.d.routing(), health, [...this.d.bus.peers.keys()].map(peer => {
      const queue = this.d.bus.queueSummary(peer);
      return [peer, this.wipLimit(peer), queue.heldBy, queue.needsReview];
    })]);
    if (this.stallView?.key !== key) this.stallView = { key, stalls: this.stallCandidates.rows.filter(({ stall, task, planned }) => stall.cause.kind === "no-writes" || stall.cause.kind === "cancelled-dependency" || !(planned ? this.plannerAssignment(task, true, this.d.routing(), undefined, health) : assign(task, this.states(), this.d.routing(), { exclude: this.excluded(task), ...this.weights(task.class, task, health), ...(stall.cause.kind === "no-eligible-peer" && isQueuePressureCode(stall.cause.code) && stall.cause.peer ? { candidates: [stall.cause.peer], namedOwner: stall.cause.peer } : {}) })).owner).map(({ stall }) => stall) };
    return structuredClone(this.stallView.stalls);
  }
  private queuePressureKnown: boolean | undefined;
  private queuePressureGeneration = 0;
  private queuePressureQueued = false;
  private queuePressureRunning = false;
  private queuePressureDirty = false;
  private queuePressureStopped = false;
  private queuePressurePass?: QueuePressurePass;
  private queuePressureContinuation?: ReturnType<typeof setImmediate>;

  private markQueuePressureCandidate(): void {
    this.queuePressureKnown = true; this.queuePressureGeneration++;
    this.scheduleQueuePressureRecheck();
  }
  private queueReviewWritten(task: Task): void {
    if (task.state === "in_review" && task.reviewer === USER && task.history.at(-1)?.queueReviewHeld) this.markQueuePressureCandidate();
  }
  private queuePressureAdmitted(): boolean {
    try { return !this.queuePressureStopped && !this.d.sweepHeld?.() && !this.d.bus.isRecoveryHeld && !this.d.bus.storageError; }
    catch { return false; }
  }
  /** Run after the bus's synchronous queue checkpoint, coalescing notifications without polling. */
  scheduleQueuePressureRecheck(): void {
    if (this.queuePressureStopped || this.queuePressureKnown === false) return;
    this.queuePressureDirty = true;
    if (this.queuePressureQueued || this.queuePressureRunning || this.queuePressureContinuation) return;
    this.queuePressureQueued = true;
    queueMicrotask(() => {
      this.queuePressureQueued = false;
      if (!this.queuePressureAdmitted()) return;
      this.queuePressureDirty = false;
      const pass = this.queuePressurePass ??= { ownerAfter: 0, reviewAfter: 0, ownerDone: false, reviewDone: false, retained: false, generation: this.queuePressureGeneration };
      this.queuePressureRunning = true;
      let failed = false;
      void this.recheckQueuePressureBatch(pass).catch(() => {
        failed = true;
        // A failed/unknown metadata or authority read never creates an assignment.
        this.queuePressureKnown = true; this.queuePressurePass = undefined;
      }).finally(() => {
        this.queuePressureRunning = false;
        if (!this.queuePressureAdmitted()) { this.queuePressurePass = undefined; return; }
        if (failed) return;
        if (this.queuePressurePass && (!pass.ownerDone || !pass.reviewDone)) {
          this.queuePressureContinuation = setImmediate(() => { this.queuePressureContinuation = undefined; this.scheduleQueuePressureRecheck(); });
          this.queuePressureContinuation.unref?.();
          return;
        }
        this.queuePressurePass = undefined;
        const changed = pass.generation !== this.queuePressureGeneration;
        this.queuePressureKnown = pass.retained || changed;
        if ((this.queuePressureDirty || changed) && this.queuePressureKnown) this.scheduleQueuePressureRecheck();
      });
    });
  }
  /** Recovery waits for queued/running host writers; a stop fences a writer already in an await. */
  queuePressureRechecksPending = (): number => Number(this.queuePressureQueued || this.queuePressureRunning || this.queuePressureContinuation !== undefined);
  stopQueuePressureRechecks(): void {
    this.queuePressureStopped = true; this.queuePressureDirty = false; this.queuePressureQueued = false;
    if (this.queuePressureContinuation) clearImmediate(this.queuePressureContinuation);
    this.queuePressureContinuation = undefined; this.queuePressurePass = undefined;
  }
  private ordinaryQueueProposal(stall: TaskStall, task: Task | undefined): task is Task {
    return !!task && task.state === "proposed" && !task.owner && !task.draft
      && !this.waitsFor(task).length && !this.personUnassigned(task) && !this.plannerPullRecord(task)?.pull;
  }
  private queueReviewBinding(task: Task): string {
    return createHash("sha256").update(JSON.stringify([this.reviewHead(task) ?? null, task.refs.repo ?? null, task.sdlc?.repo ?? null, task.sdlc?.pr ?? null])).digest("hex");
  }
  private queueReviewHeld(task: Task): boolean {
    if (task.state !== "in_review" || task.reviewer !== USER || this.isPii(task) || this.manuallyNamedReviewer(task)) return false;
    const role = task.history[this.reviewRequestRevision(task) - 1];
    return role?.queueReviewHeld === true && role.queueReviewBinding === this.queueReviewBinding(task);
  }
  private async recheckQueuePressureBatch(pass: QueuePressurePass): Promise<void> {
    if (!this.queuePressureAdmitted()) return;
    if (!pass.ownerDone) {
      const page = this.d.board.queuePressureStallPage(pass.ownerAfter, QUEUE_RECHECK_PAGE);
      pass.ownerAfter = page.afterTask; pass.ownerDone = page.done;
      for (const stall of page.rows) {
        if (!this.queuePressureAdmitted()) return;
        const task = this.d.board.get(stall.task);
        if (!this.ordinaryQueueProposal(stall, task)) { this.d.board.clearStall(stall.task); continue; }
        // A planning revision asks for fresh admission, never erases an automatic offer.
        const namedOwner = stall.cause.peer;
        const retry = namedOwner ? { candidates: [namedOwner], namedOwner } : {};
        const choice = assign(task, this.states(), this.d.routing(), { exclude: this.excluded(task), waitsFor: this.waitsFor(task), ...this.weights(task.class, task), ...retry });
        if (choice.owner) {
          const current = () => { if (!this.queuePressureAdmitted()) throw new PreEffectToolRefusal("queue-pressure retry is no longer admitted"); };
          try {
            // Reserved ready work shares the existing WIP, in-flight slot and offered fences.
            if (task.reserved) await this.offerReady(task, "queue pressure cleared", current);
            else await this.assignOwner(task, HUB, { current, ...retry });
          } catch (error) {
            if (!(error instanceof AssignmentUndeliveredError) && this.queuePressureAdmitted()) pass.retained = true;
          }
          if (!this.queuePressureAdmitted()) return;
        } // Pure transient eligibility reads keep the origin; only a gate that owns retries replaces it.
        const latest = this.d.board.get(task.id);
        if (this.ordinaryQueueProposal(stall, latest)) {
          const origin = this.d.board.queuePressureStallPage(task.id - 1, 1).rows.find(row => row.task === task.id);
          if (this.isHeld(latest)) this.d.board.clearStall(task.id); // WIP release owns its ready-held task now.
          else if (origin) {
            this.d.board.recordStall({ ...origin, replanRevision: latest.planningRevision ?? 0 });
            pass.retained = true;
          } else {
            const replacing = this.d.board.stall(task.id);
            const selected = choice.owner;
            const refusal = replacing && selected ? replacing.cause.peer === selected ? replacing.cause.code : replacing.cause.refusals?.find(row => row.peer === selected)?.code : undefined;
            const transient = replacing && (replacing.cause.kind === "no-eligible-peer" || replacing.cause.kind === "reservation") && replacing.cause.code !== "policy" && (refusal === "offline" || refusal === "not-attached");
            if (transient) {
              // The initially eligible owner vanished during admission; a policy gate never reaches this restore.
              this.d.board.recordStall({ ...stall, replanRevision: latest.planningRevision ?? 0 });
              pass.retained = true;
            }
          } // Other replacing gates keep their stall and own any later retry.
        } else this.d.board.clearStall(task.id);
      }
    }
    if (!pass.reviewDone && this.queuePressureAdmitted()) {
      const ids = this.d.board.humanReviewPage(pass.reviewAfter, QUEUE_RECHECK_PAGE);
      pass.reviewAfter = ids.at(-1) ?? pass.reviewAfter; pass.reviewDone = ids.length < QUEUE_RECHECK_PAGE;
      for (const id of ids) {
        if (!this.queuePressureAdmitted()) return;
        const task = this.d.board.get(id);
        if (!task || !this.queueReviewHeld(task)) continue;
        const reviewer = await this.recheckQueueReview(task);
        if (!this.queuePressureAdmitted()) return;
        const latest = this.d.board.get(id);
        if (!reviewer && latest && this.queueReviewHeld(latest)) pass.retained = true;
      }
    }
  }
  private async recheckQueueReview(before: Task): Promise<PeerId | undefined> {
    const revision = this.reviewRequestRevision(before), head = this.reviewHead(before), owner = before.owner;
    const valid = () => {
      if (!this.queuePressureAdmitted()) throw new PreEffectToolRefusal("queue-pressure retry is no longer admitted");
      const task = this.need(before.id, false, true);
      if (!this.queueReviewHeld(task) || this.reviewRequestRevision(task) !== revision || this.reviewHead(task) !== head || task.owner !== owner) throw new PreEffectToolRefusal("queue-held review changed");
      return task;
    };
    const choose = (task: Task) => assign(task, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}) });
    const initial = choose(valid());
    if (!initial.reviewer || initial.reviewer === USER || initial.reviewBlocked) return undefined;
    try {
      const admission = await this.reviewRequestAdmission(before, undefined, true, before.owner ?? USER, undefined, () => { valid(); return true; });
      const task = valid(), selection = choose(task), reviewer = selection.reviewer;
      if (!reviewer || reviewer === USER || selection.reviewBlocked) return undefined;
      valid();
      const next = this.d.board.update(task.id, HUB, "reviewer changed", { reviewer }, this.assignmentNote("queue pressure cleared", selection), this.reviewMetadata(selection), task.history.length);
      this.heldReviews.delete(next.id);
      // The current head is unchanged; its watcher reads the live reviewer at completion.
      this.releaseNotice(`task #${next.id}: queued review request unavailable`, () => this.sendReview(next, reviewer, "", admission));
      return reviewer;
    } catch { return undefined; }
  }

  /** Why a proposal's named owner (a self-claim included) did not get it, from the stall its proposal recorded (#601); undefined when it did. */
  namedOwnerNote(task: Task, named: PeerId | undefined, by: PeerId): string | undefined {
    requireLocalTaskPeer(by);
    if (!named || task.owner || task.state !== "proposed") return undefined;
    const stall = this.d.board.stalls().find(row => row.task === task.id);
    if (!stall) return undefined;
    const code = stall.cause.refusals?.find(row => row.peer === named)?.code ?? (stall.cause.peer === named ? stall.cause.code : undefined);
    return `${named} was not assigned${code ? ` (${code})` : ""}: ${stall.cause.kind}; assign it again with hub_task_assign once ${named} can take it`;
  }
  private ownerStallCause(task: Task, admission: Assignment, automatic = true): TaskStall["cause"] {
    const refusal = admission.refusals?.find(row => row.role === "owner" && row.peer === task.reserved);
    // Persist the existing stall vocabulary; the assignment/explain keeps the precise instance/family refusal.
    const persisted = (code: NonNullable<Assignment["refusals"]>[number]["code"]): TaskStall["cause"]["code"] => code === "context-headroom" || code === "instance" || code === "family" ? "policy" : code;
    const pressure = automatic ? admission.refusals?.find(row => row.role === "owner" && isQueuePressureCode(row.code)) : undefined;
    return refusal && !(automatic && isQueuePressureCode(refusal.code)) ? { kind: "reservation", peer: refusal.peer, code: persisted(refusal.code) } : { kind: "no-eligible-peer", code: pressure ? persisted(pressure.code) : "unavailable", refusals: admission.refusals?.filter(row => row.role === "owner").map(({ peer, code }) => ({ peer, code: persisted(code) })).sort((a, b) => a.peer.localeCompare(b.peer)) ?? [] };
  }
  private reportStall(task: Task, cause: TaskStall["cause"], now = Date.now(), description?: string): void {
    const stall: TaskStall = { task: task.id, cause, signature: JSON.stringify(cause), replanRevision: task.planningRevision ?? 0, at: now };
    if (!this.d.board.recordStall(stall)) return;
    if (cause.kind === "no-eligible-peer" && isQueuePressureCode(cause.code)) this.markQueuePressureCandidate();
    const text = description ?? `Task #${task.id} stalled: ${cause.kind}${cause.peer ? ` ${cause.peer}` : ""}${cause.dependency ? ` #${cause.dependency}` : ""} (${cause.code}); configure the runner or peer, ahub task assign ${task.id} <peer>, re-plan dependencies, or cancel it.`;
    this.releaseNotice(text);
    try { this.d.stallNotice?.(stall); } catch { /* advisory never changes task authority */ }
    // Advice joins the planner's next delivery; it must not manufacture a turn beside a withheld backlog batch.
    for (const peer of this.taskPlanner(task).filter(peer => this.d.bus.isRostered(peer))) this.releaseNotice(`task #${task.id}: stall notice unavailable`, () => this.d.tell?.(peer, noteLine(HUB, "finding", text)));
  }
  /**
   * #901: the person's verdict on one declared claim of a document plan, with the model label they say produced it. Person only (an agent's word on its own claim is no verdict, and task
   * approval never supplies one). The claim is named by its 1-based slot in the task's current plan; its text is not stored, sent or echoed, so a PII task records the same counters and
   * its history entry stays a stub. The entry is not a transition and moves nothing; a later verdict for the same slot supersedes the earlier one (the scorecard reads the last).
   */
  recordClaimVerdict(by: PeerId, id: unknown, input: unknown): Task {
    if (by !== USER) throw new Error("only the console user may record a claim verdict");
    if (this.d.cancellationHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) throw new Error("recovery or shutdown is holding task writes");
    const task = this.need(id);
    const claims = task.plan?.claims?.length ?? 0;
    if (!claims) throw new Error(`task #${task.id} declares no plan claims: add them to its plan first`);
    const claim = parseClaimVerdict(input, claims);
    // Bound to the claim list it evaluated: a hash of the plan's claims (never their text), so a later replacement or reorder of the list leaves this verdict naming no claim of the new list.
    return this.d.board.update(task.id, USER, "claim verdict", {}, undefined, { claim: { ...claim, list: claimListId(task.plan?.claims) } });  // no note: nothing a person typed beyond the closed fields is kept
  }

  async cancel(id: unknown, by: PeerId, input: { reason: string; supersededBy?: string; expectedFlowRevision?: number }): Promise<Task> {
    requireLocalTaskPeer(by);
    if (typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason) > 4000 || input.supersededBy !== undefined && (typeof input.supersededBy !== "string" || !input.supersededBy.trim() || Buffer.byteLength(input.supersededBy) > 1000)) throw new PreEffectToolRefusal("cancellation needs a bounded reason and supersession reference");
    const validate = () => {
      if (this.d.cancellationHeld?.() || this.d.bus.isRecoveryHeld) throw new PreEffectToolRefusal("recovery or shutdown is holding cancellation");
      const task = this.need(id, false, true, true);
      this.checkFlowRevision(task, input.expectedFlowRevision, true);
      if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal(`task #${task.id} is already ${task.state}`);
      if (by !== USER && this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("cancellation on ordinary work is unavailable during a private turn");
      if (by !== USER) {
        this.planningAuthority(by, task);
        const proposer = task.history.find(h => h.event === "proposed" || h.event === "backlogged")?.by;
        // #812 AC5: back in proposed or backlog with no execution evidence (the `hub_backlog_return_untouched` test: no branch, commit, PR, local check, done, verdict or reopen), an accepted-then-declined task is cancellable; any such evidence keeps today's refusal.
        if (proposer !== by || !["backlog", "proposed"].includes(task.state) || taskHasWorkEvidence(task)) throw new PreEffectToolRefusal("planner may cancel only its own historically unaccepted backlog or proposed work");
      }
      return task;
    };
    const before = validate(), revision = before.history.length;
    const reasonText = [input.reason, input.supersededBy].filter(Boolean).join("\n");
    const withheld = looksSecret(reasonText) || this.aboutPrivatePath("", reasonText, before) || await this.withholds("note", reasonText, before);
    const task = validate();
    if (task.history.length !== revision) throw new PreEffectToolRefusal("task flow revision changed");
    const cancelled = { reason: input.reason.trim(), ...(input.supersededBy ? { supersededBy: input.supersededBy.trim() } : {}), flowRevision: revision + 1, ...(withheld ? { withheld: true as const } : {}) };
    const capacity = this.capacityBefore(task);
    this.ciWatchers.cancel(task.id); this.heldReviews.delete(task.id);
    const next = this.d.board.update(task.id, by, "cancelled", { state: "cancelled", reserved: null, cancelled }, cancelled.reason, { ...(withheld ? { withheld: true as const } : {}) }, revision);
    this.writePlannerNotices(next, capacity);
    this.releaseNotice(`task #${task.id}: cancellation cohort cleanup unavailable`, () => this.cohorts.leave(task.id));
    this.offered.delete(task.id);
    this.releaseNotice(`task #${task.id}: cancellation stall cleanup unavailable`, () => this.d.board.clearStall(task.id));
    for (const peer of new Set([task.owner, task.reviewer])) if (peer && peer !== USER) this.releaseNotice(`task #${task.id}: cancellation notice unavailable`, () => this.d.bus.publish(newEnvelope(HUB, sanitize(`Task #${task.id} cancelled. Stop working on it. No native turn or working tree was changed.`), { to: [peer], kind: "task", priority: "important", refs: { task: String(task.id), taskCancelled: cancelled.flowRevision }, ...(this.isPii(next) ? { private: true } : {}) })));
    await this.releaseHeld(task.owner); // its owner's slot is free (#655)
    this.releaseNotice(`task #${task.id}: cancellation dependent advice unavailable`, () => {
      for (const dependent of this.d.board.list()) if (!isClosedTaskState(dependent.state) && !dependent.owner && dependent.deps?.includes(task.id)) this.releaseNotice(`task #${dependent.id}: cancellation stall advice unavailable`, () => this.reportStall(dependent, { kind: "cancelled-dependency", dependency: task.id, code: "cancelled" }));
    });
    return next;
  }

  /** A slot freed for `peer` (cancel, untouched return): its held ready tasks are offered in priority order, and the cap stops the offers (#655). */
  private async releaseHeld(peer: PeerId | null | undefined): Promise<void> {
    if (!peer) return;
    try {
      for (const t of this.d.board.list("proposed").filter(t => !t.owner && t.reserved === peer && this.isHeld(t) && !this.waitsFor(t).length).sort(this.readyOrder)) await this.offerReady(t, "owner slot freed");
    } catch (e) {
      this.releaseNotice(`task ${peer}: could not offer held ready work: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async releaseReady(): Promise<void> {
    const haveQueueOrigins = this.queuePressureKnown !== false && this.d.board.queuePressureStallPage(0, 1).afterTask > 0;
    for (const t of [...this.d.board.list("proposed")].sort(this.readyOrder)) {
      if (t.owner) { this.d.board.clearStall(t.id); continue; }
      const cancelledDependency = t.deps?.find(id => this.d.board.get(id)?.state === "cancelled");
      if (cancelledDependency) { this.reportStall(t, { kind: "cancelled-dependency", dependency: cancelledDependency, code: "cancelled" }); continue; }
      const last = t.history.findLast(entry => !QUIET_EVENTS.has(entry.event))?.event, planned = this.plannerPullRecord(t)?.pull === true;
      if (this.personUnassigned(t) || this.offered.has(t.id) || this.waitsFor(t).length) continue;
      if (haveQueueOrigins) {
        const origin = this.d.board.queuePressureStallPage(t.id - 1, 1).rows.find(row => row.task === t.id);
        if (origin && this.ordinaryQueueProposal(origin, t)) { this.scheduleQueuePressureRecheck(); continue; }
      }
      const admission = planned ? this.plannerAssignment(t, true) : assign(t, this.states(), this.d.routing(), { exclude: this.excluded(t), ...this.weights(t.class, t) });
      if (!admission.owner) {
        // A diagnostic legacy pass is not evidence that an automatic proposal was attempted.
        this.reportStall(t, this.ownerStallCause(t, admission, this.hasPersonReservation(t)));
        continue;
      }
      this.d.board.clearStall(t.id);
      if ((!t.deps?.length && !t.history.some(h => h.event === "backlog pulled")) || (!planned && last !== "blocked" && last !== "ready" && last !== "reserved" && !this.isHeld(t))) continue;
      // ponytail: a reserved owner (#207) that attaches after another peer that can take the task is passed over here like
      // an offline one; hold reserved tasks for a grace period if restarts show that up.
      await this.offerReady(t, "nothing left to wait for");
    }
  }

  /** Callers hold a list read before an await: re-read, or a task the other caller offered meanwhile is offered twice. */
  private async offerReady(stale: Task, why: string, current?: () => void): Promise<void> {
    current?.();
    let offering = false, undelivered: AssignmentUndeliveredError | undefined, slot: PeerId | undefined;
    try {
      const t = this.d.board.get(stale.id);
      if (!t || t.state !== "proposed" || t.owner || this.personUnassigned(t) || this.offered.has(t.id)) return;
      const planned = this.plannerPullRecord(t)?.pull === true;
      const selected = planned ? this.plannerAssignment(t, true).owner : undefined;
      if (planned && !selected) return;
      const held = planned ? undefined : this.reservedHold(t); // #655: the cap holds before the ready move is offered
      if (held) { this.holdReady(t, why, held); return; }
      // The check and the slot are one synchronous step: assignOwner can yield before it writes the owner, and a second offer
      // for the same reserved owner must see this one as taking the last slot.
      if (!planned && t.reserved) { slot = t.reserved; this.readyInFlight.set(t.id, slot); }
      this.offered.add(t.id);
      offering = true;
      const ready = t.history.at(-1)?.event === "ready" ? t : this.d.board.update(t.id, HUB, "ready", {}, why);
      this.releaseNotice(`task ${this.publicTitle(ready)} is ready: what it waited for is approved`);
      await this.assignOwner(ready, HUB, { current, ...(planned ? { candidates: [selected!], namedOwner: selected!, planner: true } : {}) });
    } catch (e) {
      // A saved move whose delivery failed is not "could not be assigned" (#297); the console notice was printed
      // where the error was thrown. The offer stays consumed by the error's own evidence, without the readback.
      if (e instanceof AssignmentUndeliveredError) undelivered = e;
      else this.releaseNotice(`task ${this.publicTitle(stale)}: could not be assigned: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (slot) this.readyInFlight.delete(stale.id);
      if (offering && !undelivered) {
        try {
          if (!this.d.board.get(stale.id)?.owner) this.offered.delete(stale.id);
        } catch (e) {
          this.offered.delete(stale.id);
          this.releaseNotice(`task ${this.publicTitle(stale)}: could not verify assignment: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  private mine(task: Task, by: PeerId, role: "owner" | "reviewer", preEffect = false): void {
    requireLocalTaskPeer(by);
    if (by !== USER && task[role] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: only its ${role} (${task[role] ?? "none"}) or the console user can do that`);
  }

  /**
   * #723: link the issue a task names the moment it is proposed or accepted, in advise and enforce, so the lifecycle never
   * waits for a groom. It is a local parse with no GitHub read, and it never refuses or fails the write it follows.
   */
  private linkOnWrite(task: Task): Task {
    try { return (this.d.sdlc?.config().mode ?? "off") === "off" ? task : this.linkIssue(task); }
    catch { return task; }
  }

  /**
   * #723: a title that qualifies another repository (`agent-mem#13`, `owner/repo#N`) while `refs.repo` is absent cannot link
   * (the identity needs the repository), so the proposer is told to set it. Advice only; a PII task gets none.
   */
  refsRepoHint(task: Task): string | undefined {
    if (this.isPii(task) || task.refs.repo || task.sdlc?.issue || (this.d.sdlc?.config().mode ?? "off") === "off") return undefined;
    const names = qualifiedTitleRepos(task.title);
    return names.length ? `task #${task.id}: the title names ${names.join(", ")}; set refs.repo to that repository (owner/name) so its issue links and the lifecycle shows it` : undefined;
  }

  /**
   * #798 D1: a declared path (refs, plan paths, the file part of a section anchor) inside a git submodule of this project: snapshots, facts, overlap and undo do not observe
   * inside a submodule. A notice, never a refusal: the task stays valid. Advice only, so a PII task gets none, a path whose name matches a PII pattern is not named, and a
   * task bound to another repository is judged against that one's layout, which this project's `.gitmodules` does not describe (its scope is not the project's).
   */
  submoduleNotice(task: Task): string | undefined {
    if (this.isPii(task)) return undefined;
    let submodules: string[];
    try { submodules = this.d.submodules?.() ?? []; } catch { return undefined; }
    if (!submodules.length) return undefined;
    if (this.repositories.scope(task.refs) !== this.repositories.project) return undefined;
    const declared = [...(task.refs.paths ?? []), ...(task.plan?.paths ?? []), ...(task.plan?.sections ?? []).map(anchor => anchor.split("#")[0]!).filter(Boolean)];
    const inside = new Set<string>();
    for (const path of declared) {
      let local: string;
      try { local = this.projectPath(path); } catch { continue; }
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) continue;
      const hit = submodules.find(sub => local === sub || local.startsWith(`${sub}/`));
      if (hit) inside.add(hit);
    }
    const named = [...inside].filter(this.nameable).sort();
    if (!named.length) return inside.size ? "inside a submodule (path withheld, it matches a PII pattern): facts, overlap and undo do not observe it" : undefined;
    return named.map(path => `inside submodule ${path}: facts, overlap and undo do not observe it`).join("\n");
  }

  /** #694: write the one issue the task itself names (the plan-review source) into its lifecycle receipt, once; never relinks. */
  private linkIssue(task: Task): Task {
    if (this.isPii(task) || task.sdlc?.issue) return task;
    let identity: { repo: string; issue: number } | undefined;
    try { identity = this.planIssueIdentity(task); } catch { return task; }
    const next = identity && linkedReceipt(task.sdlc, identity, this.d.sdlc?.config() ?? sdlcConfig(undefined));
    return next ? this.d.board.update(task.id, HUB, "lifecycle linked", { sdlc: next }, `issue #${identity!.issue}`) : task;
  }

  /**
   * #694: the PR the hub can verify for a done, without writing it: the one open PR whose head is the done's full commit
   * (or, with no commit, its branch). The read's basis travels with it, so a task whose commit or branch changed while the
   * read was awaited never receives a PR found for another head. The done persists it only after its gates admit it, so a
   * refused done stays effect-free (#254).
   */
  private async identityLink(task: Task, refs?: TaskRefs): Promise<IdentityLink | undefined> {
    if (this.isPii(task) || task.sdlc?.pr) return undefined;
    const repository = task.sdlc?.repo ?? task.refs.repo ?? this.d.repository;
    const commit = refs?.commit ?? task.refs.commit, branch = refs?.branch ?? task.refs.branch;
    if (!repository || !commit && !branch) return undefined;
    const pr = await openPrFor(repository, commit ? { commit } : { branch }, this.d.sdlc?.gh ?? sdlcGh);
    return pr ? { repo: repository, pr, basis: { commit, branch } } : undefined;
  }

  /**
   * The task as the done's gates see it: the issue the current task names (re-resolved now, so a changed title or refs
   * counts) and the staged PR only while the done's effective commit and branch are still the ones it was read for.
   */
  private withLink(task: Task, link: IdentityLink | undefined, refs?: TaskRefs): Task {
    if ((this.d.sdlc?.config().mode ?? "off") === "off" || this.isPii(task)) return task;
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    let issue: { repo: string; issue: number } | undefined;
    if (!task.sdlc?.issue) { try { issue = this.planIssueIdentity(task); } catch { issue = undefined; } }
    const commit = refs?.commit ?? task.refs.commit, branch = refs?.branch ?? task.refs.branch;
    const repository = task.sdlc?.repo ?? task.refs.repo ?? this.d.repository;
    const pr = link && !task.sdlc?.pr && repository?.toLowerCase() === link.repo.toLowerCase() && link.basis.commit === commit && (commit !== undefined || link.basis.branch === branch) ? link : undefined;
    let next = task.sdlc;
    if (issue) next = linkedReceipt(next, issue, config) ?? next;
    if (pr) next = linkedReceipt(next, { repo: pr.repo, pr: pr.pr }, config) ?? next;
    return next === task.sdlc ? task : { ...task, sdlc: next };
  }

  private planIssueIdentity(task: Task): { repo: string; issue: number } | undefined {
    const source = task.external ?? task.sdlc;
    if (source?.repo && source.issue) return { repo: source.repo, issue: source.issue };
    const repository = task.refs.repo ?? this.d.repository ?? "";
    let issues: number[];
    try { issues = specRefs(task, repository); }
    catch { throw new PreEffectToolRefusal("plan review issue identity unavailable"); }
    // #723: a title that qualifies the sibling repository `refs.repo` names (`agent-mem#13`) is a local parse, never a read.
    // A sibling shorthand next to a bare #N is two identities, refused below, never the bare one alone.
    issues = [...new Set([...issues, ...siblingTitleRefs(task.title, task.refs.repo)])];
    if (issues.length > 1) throw new PreEffectToolRefusal("plan review needs one explicit issue identity");
    return issues[0] ? { repo: repository, issue: issues[0] } : undefined;
  }

  async groomingDigest(by: PeerId): Promise<Record<string, unknown>> {
    this.planningAuthority(by);
    this.backfillIssueLinks(by); // #723: first, bounded, before the slow reads
    const included = (task: Task) => !isClosedTaskState(task.state) || task.state === "cancelled" && task.history.some(entry => !!entry.supersededBy);
    const snapshot = this.d.board.list().filter(included), issues = new Map<string, PlanIssueMetadata>(), attempted = new Set<string>();
    const deadline = performance.now() + 4_000;
    let reads = 0, incomplete = false;
    // ponytail: at most eight metadata reads within four seconds; add paginated revision-bound readback for larger boards.
    for (const listed of snapshot) {
      this.planningAuthority(by);
      const task = this.d.board.get(listed.id);
      if (!task || this.isPii(task) || isClosedTaskState(task.state)) continue;
      let source: { repo: string; issue: number } | undefined;
      try { source = this.planIssueIdentity(task); } catch { continue; }
      if (!source) continue;
      const key = `${source.repo.toLowerCase()}#${source.issue}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      if (reads >= 8 || performance.now() >= deadline) { incomplete = true; break; }
      reads++;
      const run = this.d.sdlc?.gh ?? sdlcGh;
      const issue = await readPlanIssueMetadata(source.repo, source.issue, (args, timeout, cwd, cap) => run(args, Math.max(1, Math.min(timeout ?? 10_000, deadline - performance.now())), cwd, cap));
      if (issue) issues.set(key, issue);
    }
    this.planningAuthority(by);
    const all = this.d.board.list(), current = all.filter(included), visible = current.filter(task => !this.isPii(task));
    // Include only bounded public dependency context, so approved intermediate phases do not disappear from reachability.
    const indexed = new Map(all.map(task => [task.id, task])), dependencies = new Map<number, readonly number[]>();
    const pending = visible.slice(0, 500).map(task => task.id).reverse(), visited = new Set<number>();
    while (pending.length && visited.size < 500) {
      const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id);
      const task = indexed.get(id); if (!task || this.isPii(task)) continue;
      dependencies.set(id, task.deps ?? []); pending.push(...task.deps ?? []);
    }
    const dependencyTruncated = pending.some(id => !visited.has(id));
    const peers = [...new Set([...Object.keys(this.states()), ...current.flatMap(task => task.owner ? [task.owner] : [])])];
    const reviewedIssues = new Map(visible.flatMap(task => task.sdlc?.planReview?.issue ? [[task.id, task.sdlc.planReview.issue] as const] : []));
    const acceptedIssues = new Map(visible.flatMap(task => task.sdlc?.acceptance ? [[task.id, task.sdlc.acceptance] as const] : []));
    const currentNoWrites = new Set(this.stalled().filter(stall => stall.cause.kind === "no-writes").map(stall => stall.task));
    const blockers: { task: number; code: string }[] = this.d.board.stalls().filter(stall => stall.cause.kind !== "no-writes" || currentNoWrites.has(stall.task)).map(stall => ({ task: stall.task, code: stall.cause.code }));
    const health = this.health(), states = this.states(), routing = this.d.routing(), hostBlocks = this.d.plannerBlocks?.() ?? {};
    for (const task of visible.filter(task => !isClosedTaskState(task.state)).slice(0, 500)) {
      const owner = task.owner ?? task.reserved;
      if (owner) for (const code of peerEntry(hostBlocks, owner) ?? []) blockers.push({ task: task.id, code });
      const result = assign(task.state === "backlog" ? { ...task, state: "proposed" } : task, states, routing, { ...health, waitsFor: this.waitsFor(task), ...(owner ? { candidates: [owner], namedOwner: owner } : {}) });
      if (!result.owner) for (const refusal of result.refusals ?? []) if (refusal.role === "owner") blockers.push({ task: task.id, code: refusal.code === "instance" || refusal.code === "family" ? "policy" : refusal.code });
      if (this.waitsFor(task).length) blockers.push({ task: task.id, code: "dependency" });
    }
    const digest = plannerGrooming(visible, { dependencies, dependencyTruncated, repository: this.d.repository ?? `path:${realPath(this.d.cwd)}`,
      limits: Object.fromEntries(peers.map(peer => [peer, this.wipLimit(peer)])), wip: Object.fromEntries(peers.map(peer => [peer, this.wip(peer)])),
      states, issues, reviewedIssues, acceptedIssues, blockers });
    return { ...digest, truncated: digest.truncated || incomplete, ...(current.some(task => this.isPii(task)) ? { privateTasks: "withheld" } : {}) };
  }

  /**
   * #694, #723: backfill lifecycle issue links with their own bounds, run first and apart from the slow metadata reads and
   * the digest, so a groom that later times out has still linked. Each call links up to 32 open tasks that still lack one
   * within a one-second budget, so later tasks are reached on later calls. A local parse; a failure skips that task only.
   */
  private backfillCursor = 0;
  private backfillIssueLinks(by: PeerId): number {
    if ((this.d.sdlc?.config().mode ?? "off") === "off") return 0;
    // ponytail: 32 links and 1 s per call; raise both only with a measured groom time on a 400-task board.
    const deadline = performance.now() + 1_000;
    let linked = 0, i = 0;
    const list = this.d.board.list(), n = list.length;
    // The scan resumes where the last call stopped, so rows that never link cannot hold later ones back.
    for (; i < n; i++) {
      if (linked >= 32 || performance.now() >= deadline) break;
      const task = list[(this.backfillCursor + i) % n]!;
      if (isClosedTaskState(task.state) || task.sdlc?.issue || this.isPii(task)) continue;
      this.planningAuthority(by);
      try { if (this.linkIssue(task) !== task) linked++; } catch { /* one task never stops the rest */ }
    }
    this.backfillCursor = n ? (this.backfillCursor + i) % n : 0;
    return linked;
  }

  /**
   * #481 S7: the SDLC metrics from board history, read-only. Private tasks are counted as withheld and read for nothing else; PR
   * readbacks are not made here (the cost report owns them), so merge time and same-head reruns read `unknown` unless given.
   * Detection never calls a model and the report writes nothing.
   */
  sdlcMetrics(by: PeerId, since?: unknown, merged?: { mergedAt?: Record<number, number>; ciReruns?: Record<number, number | null> }): MetricsReport {
    this.planningAuthority(by);
    if (by !== USER && this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("metrics unavailable during private work");
    let cutoff: number | undefined;
    if (since !== undefined && since !== null && since !== "") {
      cutoff = typeof since === "number" ? since : /^\d+$/.test(String(since)) ? Number(since) : Date.parse(String(since));
      if (!Number.isFinite(cutoff) || cutoff < 0) throw new PreEffectToolRefusal("since must be a time (YYYY-MM-DD or an ISO timestamp) or milliseconds");
    }
    const rows = this.d.board.list();
    const tasks: MetricTask[] = rows.map(task => ({ id: task.id, private: this.isPii(task), history: task.history.map(entry => ({ at: entry.at, event: entry.event,
      ...(entry.reviewCost?.head ? { requestHead: entry.reviewCost.head } : {}), ...(entry.reviewFindings?.head ? { verdictHead: entry.reviewFindings.head } : {}), ...(entry.evidenceOnly ? { evidenceOnly: true as const } : {}) })) }));
    const visibleIds = new Set(rows.filter(task => !this.isPii(task)).map(task => task.id));
    const byKind: Record<string, number> = {};
    for (const stall of this.stalled()) if (visibleIds.has(stall.task)) byKind[stall.cause.kind] = (byKind[stall.cause.kind] ?? 0) + 1;
    const stalls = { open: Object.values(byKind).reduce((sum, n) => sum + n, 0), byKind, doneWithoutWrites: rows.filter(task => visibleIds.has(task.id) && task.history.findLast(entry => entry.event === "done")?.noWrites).length };
    // #481 S7: the merge-time readback the guarded merge recorded on each merged task's receipt (host-written, never a tool input), and the two series that are not made of tasks.
    const mergedAt: Record<number, number> = {}, ciReruns: Record<number, number | null> = {}, ciRuns: Record<number, number | null> = {}, reviews: Record<number, number | null> = {};
    for (const task of rows) {
      const merge = task.sdlc?.merge;
      if (!visibleIds.has(task.id) || merge?.state !== "merged") continue;
      const cost = cleanMergeCost(merge.cost);
      const at = cost?.mergedAt ?? (Number.isSafeInteger(merge.at) ? merge.at : null);
      if (at !== null) mergedAt[task.id] = at;
      if (cost) { ciReruns[task.id] = cost.ciReruns; ciRuns[task.id] = cost.ciRuns; reviews[task.id] = cost.reviews; }
    }
    return sdlcMetrics(tasks, { ...(cutoff !== undefined ? { since: cutoff } : {}), ...(this.d.sdlc?.config().bands ? { bands: this.d.sdlc.config().bands } : {}), stalls, mergedAt, ciReruns, ciRuns, reviews, external: this.externalSeries(), ...(merged ?? {}) });
  }

  /** #481 S7: one point per shipped release (1 for a hotfix, 0 otherwise; a release with no recorded train is skipped, never a 0) and one per recorded security scan whose total is known. */
  private externalSeries(): Partial<Record<BandMetric, SeriesPoint[]>> {
    const rows = this.d.board.list(), privateRelease = (id: number) => rows.some(task => task.release === id && this.isPii(task));
    const hotfix = this.d.board.releases().filter(release => release.state === "shipped" && release.shippedAt !== null && release.train?.history.length && !privateRelease(release.id))
      .sort((a, b) => a.shippedAt! - b.shippedAt! || a.id - b.id).map(release => ({ value: release.train!.hotfix ? 1 : 0, task: release.id }));
    const config = this.d.sdlc?.config().securityScan, repo = config?.repo ?? this.d.repository;
    // A band needs `window` baseline points plus the newest one, and the episode walk looks back up to EPISODE_LOOKBACK more, so the series loads that many known
    // totals (unknown ones are filtered in SQL, never counted against the limit). The board caps one read at 1000 rows.
    const need = (this.d.sdlc?.config().bands?.security_open_alerts?.window ?? DEFAULT_BAND.window) + EPISODE_LOOKBACK + 2;
    const scans = config && typeof repo === "string" ? this.d.board.securityScans(repo, config.sources.join(","), need, true).map(scan => ({ value: scan.total!, task: scan.id })) : [];
    return { hotfix_rate: hotfix, security_open_alerts: scans };
  }

  /**
   * #481 S7: the scheduled security-scan baseline. Reads the open-alert counts GitHub already holds (`security-baseline.ts`), records one row per interval and then runs the
   * same band path as every other metric, so a breach is one deduplicated card. Held like every host writer; a private repository identity, a mode off, no `[security_scan]`
   * table and a scan that is not yet due all do nothing. A source GitHub will not read (not enabled, not permitted) records an unknown total, never zero. Returns the scan id.
   */
  async runSecurityScan(now = Date.now()): Promise<number | undefined> {
    const config = this.d.sdlc?.config(), scan = config?.securityScan;
    if (!config || config.mode === "off" || !scan) return undefined;
    const repo = scan.repo ?? this.d.repository;
    if (typeof repo !== "string" || !this.nameable(repo)) return undefined;
    const held = () => !!this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || !!this.d.bus.storageError;
    if (held()) return undefined;
    const sources = scan.sources.join(","), last = this.d.board.securityScans(repo, sources, 1).at(-1);
    if (last && now - last.at < scan.everyH * 3_600_000) return undefined;
    const read = await readSecurityScan(repo, scan.sources, this.d.sdlc?.gh ?? sdlcGh);
    const after = this.d.sdlc?.config();
    // The read awaited: the lifecycle, the schedule or a hold may have changed meanwhile, so nothing is written from a stale decision.
    if (!read || held() || !after || after.mode === "off" || JSON.stringify(after.securityScan) !== JSON.stringify(scan)) return undefined;
    const id = this.d.board.recordSecurityScan({ repo, sources, counts: read.counts as Record<string, number | null>, total: read.total });
    this.proposeFromBands();
    return id;
  }

  /**
   * #481 S7: act on the band tiers, deterministically and once per breach episode. An episode is a run of non-ok values for one metric
   * (`BandResult.episode`, derived from history), so a sustained shift is one episode however many tasks finish inside it. `log` is one
   * hub notice, `diagnose` one read-only `triage` backlog task and `propose` one `plan` backlog card naming the metric and its evidence.
   * A metric with an open band card (a backlog or open task whose detail carries its key) writes nothing more, so a value that grows
   * from diagnose to propose inside one episode does not add a second card. Held while the hub is stopping, recovering or has a
   * storage error, like every host writer. The text is fixed words, numbers and task ids, never task text, and no GitHub issue is
   * created. Returns the task ids created.
   */
  /**
   * Whether `proposeFromBands` would run now, and a signature of what it would read. The daemon timer records a board revision only for a
   * pass that ran, and re-runs when the signature changes (a reload that enables bands or edits them on an idle board).
   */
  bandsState(): { ready: boolean; signature: string } {
    const config = this.d.sdlc?.config();
    const configured = !!config && config.mode !== "off" && !!config.bands && Object.keys(config.bands).length > 0;
    // The release and scan series do not move the task board's revision, so what they last held is part of the signature: a shipped release or a new scan row is a reason to run again.
    const external = configured ? this.externalSeries() : {};
    return { ready: configured && !this.d.sweepHeld?.() && !this.d.bus.isRecoveryHeld && !this.d.bus.storageError,
      signature: configured ? JSON.stringify([config!.mode, config!.bands, config!.securityScan ?? null, external.hotfix_rate?.length ?? 0, external.security_open_alerts?.at(-1)?.task ?? 0]) : "" };
  }

  proposeFromBands(by: PeerId = HUB): number[] {
    requireLocalTaskPeer(by);
    const config = this.d.sdlc?.config();
    if (!config || config.mode === "off" || !config.bands || !Object.keys(config.bands).length) return [];
    if (this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) return [];
    if (by !== HUB && by !== USER) this.planningAuthority(by);
    const report = this.sdlcMetrics(by === HUB ? USER : by);
    if (report.bands === "off") return [];
    const rows = this.d.board.list();
    const bandRows = rows.filter(row => row.history[0]?.by === HUB && row.detail?.startsWith("Band breach key: "));
    const keyOf = (row: Task) => row.detail!.split("\n")[0]!.slice("Band breach key: ".length);
    const seen = new Set(bandRows.map(keyOf));
    // A card counts as open while its task is not closed: the planner has not yet decided on it.
    const open = new Set(bandRows.filter(row => !isClosedTaskState(row.state)).map(row => keyOf(row).split(":")[0]!));
    const created: number[] = [];
    // Fixed words and a number: a release or a security scan is named by its id, a task by `task #id`.
    const subjectText = (band: BandResult, id: number) => band.subject === "release" ? `release #${id}` : band.subject === "scan" ? `security scan #${id}` : `task #${id}`;
    for (const band of report.bands as BandResult[]) {
      if (band.tier === "ok" || band.lastTask === null || band.episode === null) continue;
      const key = `${band.metric}:#${band.episode}`;
      if (band.tier === "log") {
        const marker = `${key}:log`;
        if (!open.has(band.metric) && this.d.board.recordBandNotice(marker)) this.releaseNotice(`sdlc band: ${band.metric} is ${band.reason}; last value ${band.last} on ${subjectText(band, band.lastTask)}`);
        continue;
      }
      if (seen.has(`${key}:propose`) || seen.has(`${key}:diagnose`) || open.has(band.metric)) continue;
      const tier = band.tier === "propose" ? "propose" : "diagnose";
      const full = `${key}:${tier}`;
      const evidence = `metric ${band.metric}; newest value ${band.last} on ${subjectText(band, band.lastTask)}; episode began at ${subjectText(band, band.episode)}; baseline mean ${band.mean}, deviation ${band.sd} over ${band.baseline} ${band.subject === "release" ? "releases" : band.subject === "scan" ? "scans" : "tasks"}; ${band.reason}`;
      const diagnose = tier === "diagnose";
      const title = diagnose ? `Diagnose SDLC metric ${band.metric}: read-only triage` : `Review SDLC metric ${band.metric}: control band breach`;
      const detail = `Band breach key: ${full}\n${evidence}\n${diagnose
        ? `Read-only triage for the planner: inspect the recent ${band.subject === "release" ? "releases" : band.subject === "scan" ? "security scans" : "task histories"} behind this metric and report what changed. Do not edit files, branches or the board.`
        : "Backlog card for the planner: decide whether this breach needs a process change. It names the metric and its evidence; it opens no GitHub issue."}`;
      const draft = { title, detail, refs: {} };
      const signals = this.signalsFor(draft);
      if (this.isPii({ signals }) || !this.candidateTextAllowed(`${title}\n${detail}`)) continue;
      const proposal = this.d.board.propose(HUB, { ...draft, class: diagnose ? "triage" : "plan", backlog: true, signals });
      this.incomingBacklog.add(proposal.id); seen.add(full); open.add(band.metric); created.push(proposal.id);
    }
    for (const id of created) this.releaseNotice(`task #${id}: SDLC control band breach proposed in the backlog`);
    return created;
  }

  /** The open task each schedule made: a hub-written card (first history entry by the hub) whose detail starts with the schedule marker and that is not closed. */
  openScheduled(): Map<string, number> {
    const open = new Map<string, number>();
    for (const row of this.d.board.list()) {
      const key = row.history[0]?.by === HUB && !isClosedTaskState(row.state) ? scheduleKeyOf(row.detail) : undefined;
      if (key !== undefined && !open.has(key)) open.set(key, row.id);
    }
    return open;
  }

  /** Whether a scheduled run may write now: the same holds as every host writer (stopping or recovering, held by the daemon, a storage error). */
  schedulesHeld(): boolean { return !!this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || !!this.d.bus.storageError; }

  private schedulesRunning = false;
  /** 1 while a schedules pass is running (its PII screen and triage are awaited), so a recovery commit waits for it like it waits for `checksPending` and `autoPullsPending`: a run mid-admission would write after the commit's digest. */
  schedulesPending = (): number => (this.schedulesRunning ? 1 : 0);
  /**
   * One due schedule's run: the hold, the open-task rule and the proposal, shared by the timer and `ahub schedule run`, so a manual run can never do what a due
   * one may not. `propose` asks the fence again right before its board write, so a run admitted and then overtaken by a hold writes nothing and counts as a skip.
   */
  private async runSchedule(store: ScheduleStore, entry: ScheduleEntry, now: number, extraHold: () => boolean, manual = false): Promise<ScheduleRunResult> {
    const hold = () => this.schedulesHeld() || extraHold() ? "the hub is held" : undefined;
    // A skipped tick is counted for the timer only: a person's refused run is not a missed period, so it never feeds the coalescing count.
    const skip = () => { if (!manual) store.skipped(entry.id); };
    if (hold()) { skip(); return { id: entry.id, outcome: "held" }; }
    const open = this.openScheduled().get(entry.id);
    if (open !== undefined) { skip(); return { id: entry.id, outcome: "waiting", task: open }; }
    // The PII screen and triage are awaited inside `propose`, and a hold can begin during them (shutdown, recovery, a storage error). `propose` asks this fence
    // again right before its board write, so a run that was admitted and then overtaken by a hold writes nothing and counts as a skip, like one held at the start.
    // The same fence also reads the schedule's pause generation (#335): a person who paused or resumed it after this run was admitted has changed what should happen,
    // so the run writes nothing. A timer run that finds it paused or resumed meanwhile is dropped (the next pass decides); a person's own run never races its own command.
    const admitted = store.epoch(entry.id);
    let overtaken = false, changed = false;
    const fence = () => {
      const reason = hold(); if (reason) overtaken = true;
      if (!reason && !manual && store.epoch(entry.id) !== admitted) { changed = true; return "the schedule was paused or resumed"; }
      return reason;
    };
    try {
      const task = await this.propose(HUB, { title: entry.title, detail: scheduledDetail(entry), class: entry.class, backlog: entry.queue === "backlog",
        ...(entry.owner ? { owner: entry.owner } : {}) }, undefined, undefined, fence);
      store.ran(entry.id, now, task.id);
      return { id: entry.id, outcome: "ran", task: task.id };
    } catch (error) {
      if (changed) return { id: entry.id, outcome: "changed" };
      if (overtaken) { try { skip(); } catch { /* the store closed with the hub */ } return { id: entry.id, outcome: "held" }; }
      store.failed(entry.id, sanitize((error as Error).message));
      return { id: entry.id, outcome: "failed" };
    }
  }

  /**
   * #512a: one pass over the machine-local schedules. A schedule is due once `every` has passed since its period began (first sight, then its last run).
   * A due schedule proposes at most one task per pass, through `propose` like any proposal (the PII screen, triage, routing and notices all apply), and none
   * while the task its previous run made is still open. While the hub is held the whole pass skips and every due schedule counts the skip, so a long hold
   * ends in one run per schedule, never a burst. A run restarts the period at `now`: nothing a restart or a hold missed is replayed. Returns what each due schedule did.
   */
  async proposeFromSchedules(store: ScheduleStore, entries: readonly ScheduleEntry[], now: number, extraHold: () => boolean = () => false): Promise<ScheduleRunResult[]> {
    if (this.schedulesRunning) return [];
    this.schedulesRunning = true;
    const out: ScheduleRunResult[] = [];
    try {
      store.prune(entries.map(entry => entry.id));
      for (const entry of entries) {
        const row = store.ensure(entry.id, now);
        if (row.paused) continue; // #335: a person's pause is neither a run nor a skipped tick
        if (now < scheduleNext(entry, row.anchor)) continue;
        out.push(await this.runSchedule(store, entry, now, extraHold));
      }
    } finally { this.schedulesRunning = false; }
    return out;
  }

  /**
   * #335: `ahub schedule run <id>`. The person runs one configured schedule now, whatever its period says. It takes the same pass guard as the timer (so it never
   * overlaps one), the same hold, open-task and `propose` path (`runSchedule`), and restarts that schedule's period on success like a due run. A paused schedule
   * runs too: a pause stops the timer, not the person. Only the person may.
   */
  async runScheduleNow(by: PeerId, store: ScheduleStore, entries: readonly ScheduleEntry[], id: unknown, now: number, extraHold: () => boolean = () => false): Promise<ScheduleRunResult & { reason?: string }> {
    if (!this.personOrConductor(by)) throw new PreEffectToolRefusal("schedule run is a console command");
    const entry = typeof id === "string" ? entries.find(candidate => candidate.id === id) : undefined;
    if (!entry) throw new PreEffectToolRefusal(`no schedule ${typeof id === "string" ? JSON.stringify(id.slice(0, 64)) : "named"}; ahub schedule list shows the configured ones`);
    if (this.schedulesRunning) throw new PreEffectToolRefusal("a schedules pass is running; try again in a moment");
    this.schedulesRunning = true;
    try {
      store.ensure(entry.id, now);
      // #933: the board-write fence asks the hold again after the PII screen, so a conductor whose role or connection ended meanwhile writes nothing.
      const result = await this.runSchedule(store, entry, now, () => extraHold() || !this.personOrConductor(by), true);
      const reason = result.outcome === "failed" ? store.get(entry.id)?.last_error ?? undefined : undefined;
      return reason ? { ...result, reason } : result;
    } finally { this.schedulesRunning = false; }
  }

  /** #335: pause or resume one configured schedule. Only the person may; resuming starts a fresh period, so a pause is never replayed as a run. */
  setSchedulePaused(by: PeerId, store: ScheduleStore, entries: readonly ScheduleEntry[], id: unknown, paused: boolean, now: number): void {
    if (!this.personOrConductor(by)) throw new PreEffectToolRefusal(`schedule ${paused ? "pause" : "resume"} is a console command`);
    const entry = typeof id === "string" ? entries.find(candidate => candidate.id === id) : undefined;
    if (!entry) throw new PreEffectToolRefusal(`no schedule ${typeof id === "string" ? JSON.stringify(id.slice(0, 64)) : "named"}; ahub schedule list shows the configured ones`);
    store.setPaused(entry.id, paused, now);
  }

  /**
   * #336 (#512c): one pass over the machine-local folder triggers, on the schedules timer. Each trigger's folder is read once (never watched). The first poll of a trigger
   * records what is already there and proposes nothing, so adding a trigger to a full inbox does not flood the board; after that a file the trigger has not recorded (by
   * real path and content hash) is registered as a source through `register` and proposes ONE task through `propose` as the hub, which names the source id and never the
   * file's name or path. A rename or a touch keeps the hash and proposes nothing. While the hub is held nothing is read or recorded, so the files wait for the next poll.
   * A file is recorded only after its task exists, so a failure or a hold between the two leaves it to be tried again (a crash in that window can repeat one task; it
   * never loses a file). At most MAX_NEW_PER_POLL files per trigger per pass.
   */
  async runFolderTriggers(store: FolderStorePort, entries: readonly FolderEntry[], scan: (entry: FolderEntry) => FolderScan, register: (file: ScannedFile) => { id: string; private: boolean }, now: number, extraHold: () => boolean = () => false): Promise<FolderRunResult[]> {
    if (this.schedulesRunning) return [];
    this.schedulesRunning = true;
    const out: FolderRunResult[] = [];
    try {
      store.prune(entries.map(entry => entry.id));
      for (const entry of entries) out.push(await this.runFolderTrigger(store, entry, scan, register, now, extraHold));
    } finally { this.schedulesRunning = false; }
    return out;
  }

  private async runFolderTrigger(store: FolderStorePort, entry: FolderEntry, scanOf: (entry: FolderEntry) => FolderScan, register: (file: ScannedFile) => { id: string; private: boolean }, now: number, extraHold: () => boolean): Promise<FolderRunResult> {
    const hold = () => this.schedulesHeld() || extraHold() ? "the hub is held" : undefined;
    if (hold()) return { id: entry.id, outcome: "held", tasks: [], files: 0 };
    const scan = scanOf(entry);
    // A refused folder never starts the trigger: when it becomes readable, what is in it then is the baseline, not news.
    if (scan.refused) { store.polled(entry.id, now, scan.refused); return { id: entry.id, outcome: "refused", tasks: [], files: 0, reason: scan.refused }; }
    // The baseline is every file already in the folder when the trigger starts. A folder too big to hash in one poll (the scan's budget, `truncated`) is baselined over
    // several polls: each records what it read and proposes nothing, and the poll that reaches the end of the folder completes it. Only then is a file news.
    if (!store.baselined(entry.id)) {
      store.begin(entry.id, now);
      for (const file of scan.files) if (!file.seen) store.record(entry.id, file, null, now);
      if (!scan.truncated) store.markBaselined(entry.id, now); else store.polled(entry.id, now);
      return { id: entry.id, outcome: "baseline", tasks: [], files: scan.files.length };
    }
    // A file the trigger already knows by content (a rename, a touch, a copy) proposes nothing, but its new path, size and mtime are recorded, so the next scan finds it with
    // `known` instead of hashing it again: otherwise such files would spend the hash budget on every poll and starve a genuinely new one behind them.
    for (const file of scan.files) if (!file.seen && !store.isNew(entry.id, file.sha256)) store.observe(entry.id, file, now);
    // `isNew` is asked again for each file below, not only here: two files with the same new bytes can arrive before one poll, and the first one's record must suppress the second.
    const fresh = scan.files.filter(file => !file.seen && store.isNew(entry.id, file.sha256));
    const tasks: number[] = [];
    let error: string | undefined;
    for (const file of fresh) {
      if (tasks.length >= MAX_NEW_PER_POLL || hold()) break;
      if (!store.isNew(entry.id, file.sha256)) { store.observe(entry.id, file, now); continue; } // a duplicate found inside the loop: recorded, never a second task
      let overtaken = false;
      const fence = () => { const reason = hold(); if (reason) overtaken = true; return reason; };
      try {
        const source = register(file);
        const task = await this.propose(HUB, { title: entry.title, detail: folderDetail(entry, source.id), class: entry.class, backlog: entry.queue === "backlog", ...(entry.owner ? { owner: entry.owner } : {}) }, undefined, undefined, fence);
        store.record(entry.id, file, task.id, now);
        tasks.push(task.id);
      } catch (caught) {
        if (overtaken) break;
        error = sanitize((caught as Error).message);
        break; // the next poll tries this file again; later files wait behind it so order is kept
      }
    }
    store.polled(entry.id, now, error);
    return { id: entry.id, outcome: error ? "failed" : tasks.length ? "ran" : "none", tasks, files: fresh.length, ...(scan.truncated ? { more: true as const } : {}), ...(error ? { reason: error } : {}) };
  }

  /** S10 read-only planner report; S7 owns rolling bands and automatic board proposals. */
  async costReport(by: PeerId, repository?: unknown, scopePrs?: readonly number[]): Promise<Record<string, unknown>> {
    const authority = () => {
      this.planningAuthority(by);
      if (by !== USER && this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("cost report unavailable during private work");
    };
    authority();
    const repo = repository ?? this.d.repository;
    if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith("-") || !this.nameable(repo)) throw new PreEffectToolRefusal("cost report requires a public owner/repository identity");
    const deadline = performance.now() + 20_000;
    const bounded = (args: string[], timeout?: number, cwd?: string, cap?: number) => performance.now() < deadline
      ? (this.d.sdlc?.gh ?? sdlcGh)(args, Math.max(1, Math.min(timeout ?? 10_000, deadline - performance.now())), cwd, cap)
      : Promise.resolve({ code: 1, stdout: "" });
    const requested = scopePrs === undefined ? undefined : new Set(scopePrs);
    const linked = () => this.d.board.list().filter(task => task.sdlc?.repo?.toLowerCase() === repo.toLowerCase() && Number.isSafeInteger(task.sdlc.pr) && task.sdlc.pr! > 0 && (!requested || requested.has(task.sdlc.pr!)));
    const ids = [...new Set(linked().filter(task => !this.isPii(task)).map(task => task.sdlc!.pr!))].sort((a, b) => a - b);
    const observations: import("./cost-governance.ts").CostPr[] = [];
    let incomplete = ids.length > 16;
    for (const pr of ids.slice(0, 16)) {
      authority();
      if (linked().some(task => task.sdlc?.pr === pr && this.isPii(task))) continue;
      if (performance.now() >= deadline) { incomplete = true; break; }
      const evidence = await readPrCostHistory(repo, pr, (args, timeout, cwd, cap) => {
        authority();
        const fresh = linked().filter(task => task.sdlc?.pr === pr);
        if (!fresh.length || fresh.some(task => this.isPii(task))) return Promise.resolve({ code: 1, stdout: "" });
        return bounded(args, timeout, cwd, cap);
      });
      if (evidence) observations.push(evidence); else incomplete = true;
    }
    authority();
    const current = linked();
    const visiblePrs = new Set(current.filter(task => !this.isPii(task)).map(task => task.sdlc!.pr!));
    for (const task of current) if (this.isPii(task)) visiblePrs.delete(task.sdlc!.pr!);
    if (JSON.stringify([...visiblePrs].sort((a, b) => a - b)) !== JSON.stringify(ids)) incomplete = true;
    const report = costMetrics(current.map(task => ({ repo, pr: task.sdlc!.pr!, private: this.isPii(task), history: task.history })), observations.filter(pr => visiblePrs.has(pr.pr)));
    const scoped = current.filter(task => visiblePrs.has(task.sdlc!.pr!) && !this.isPii(task));
    const scopedIds = new Set(scoped.map(task => task.id));
    const stalls = { noWrites: this.stalled().filter(stall => stall.cause.kind === "no-writes" && scopedIds.has(stall.task)).length, doneWithoutWrites: scoped.filter(task => task.history.findLast(entry => entry.event === "done")?.noWrites).length };
    return { ...report, stalls, truncated: report.truncated || incomplete, ...(current.some(task => this.isPii(task)) ? { privateTasks: "withheld" } : {}), bands: "see ahub sdlc metrics" };
  }

  async planReviewGap(task: Task): Promise<string | undefined> {
    const receipt = task.sdlc?.planReview;
    if (!receipt) return "plan not reviewed since proposal";
    if (!receipt.planner || !Number.isFinite(receipt.recordedAt)) return "plan not reviewed since planning revision change";
    const revision = task.planningRevision ?? 0;
    if (receipt.planningRevision !== revision) {
      const changes = task.history.filter(entry => entry.planning && entry.planning.revision > receipt.planningRevision);
      if (receipt.planningRevision > revision || changes.length !== revision - receipt.planningRevision || changes.some((entry, index) => entry.event !== "planned" || entry.planning!.revision !== receipt.planningRevision + index + 1 || entry.planning!.fields.length !== 1 || entry.planning!.fields[0] !== "release")) return "plan not reviewed since planning revision change";
    }
    if (receipt.scope && JSON.stringify(receipt.scope) !== JSON.stringify(cleanCostPlan(task.plan ?? {}))) return "plan not reviewed since cost scope change";
    const identity = this.planIssueIdentity(task);
    if (identity?.issue && this.isPii(task)) return "private issue plan review evidence unavailable";
    if (!identity?.issue) return receipt.issue ? "plan not reviewed since issue identity change" : undefined;
    if (!identity.repo || typeof receipt.issue?.repo !== "string" || receipt.issue.repo.toLowerCase() !== identity.repo.toLowerCase() || receipt.issue.issue !== identity.issue) return "plan not reviewed since issue identity change";
    const current = await readPlanIssueMetadata(identity.repo, identity.issue, this.d.sdlc?.gh ?? sdlcGh);
    if (!current) return "plan review issue metadata unavailable";
    if (current.state !== "OPEN") return "plan review issue is closed";
    return current.editedAt !== receipt.issue.editedAt ? "plan not reviewed since issue edit" : undefined;
  }

  /** Planner authority and issue edit evidence are rechecked across every external await. */
  async recordPlanReview(by: PeerId, id: unknown, input: unknown): Promise<Task> {
    this.plannerWriteAuthority(by);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PreEffectToolRefusal("plan review needs a revision and reason");
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some(key => !["revision", "reason", "review", "ci"].includes(key)) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0
      || typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 1000) throw new PreEffectToolRefusal("plan review needs a current revision and bounded reason");
    const task = this.need(id, false, true, true), revision = raw.revision as number;
    this.planReviewAuthority(by, task);
    if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal("closed work is final");
    if ((task.planningRevision ?? 0) !== revision) throw new PreEffectToolRefusal("planning revision changed");
    let scope: CostPlan;
    try { scope = cleanCostPlan({ ...task.plan, ...("review" in raw ? { review: raw.review } : {}), ...("ci" in raw ? { ci: raw.ci } : {}) }); }
    catch { throw new PreEffectToolRefusal("invalid review or CI cost scope"); }
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (!scope.review || !scope.ci) {
      if (mode === "enforce") throw new PreEffectToolRefusal("review and CI cost scope required for a new plan receipt");
      if (mode === "advise") this.releaseNotice(`task ${this.publicTitle(task)}: cost scope unspecified`);
    }
    const flow = task.history.length, withheld = await this.withholds("note", raw.reason, task);
    this.plannerWriteAuthority(by);
    const observed = this.need(task.id, false, true, true);
    this.planReviewAuthority(by, observed);
    if (observed.history.length !== flow || (observed.planningRevision ?? 0) !== revision) throw new PreEffectToolRefusal("plan review changed during readback");
    const identity = this.planIssueIdentity(observed);
    if (identity?.issue && this.isPii(observed)) throw new PreEffectToolRefusal("private issue plan review readback unavailable");
    const issue = identity?.repo && identity.issue ? await readPlanIssueMetadata(identity.repo, identity.issue, this.d.sdlc?.gh ?? sdlcGh) : undefined;
    if (identity?.issue && !issue) throw new PreEffectToolRefusal("plan review issue metadata unavailable");
    if (issue && !this.isPii(task) && !this.nameable(JSON.stringify(issue))) throw new PreEffectToolRefusal("plan review metadata matches a PII pattern");
    this.plannerWriteAuthority(by);
    const current = this.need(task.id, false, true, true);
    const authorship = this.planReviewAuthority(by, current);
    if (current.history.length !== flow || (current.planningRevision ?? 0) !== revision) throw new PreEffectToolRefusal("plan review changed during readback");
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    let updated = this.d.board.update(current.id, by, "plan reviewed", { ...(Object.keys(scope).length ? { plan: { ...current.plan, ...scope } } : {}), sdlc: { ...current.sdlc, stage: current.sdlc?.stage ?? lifecycleStage(config, "plan"),
      planReview: { planner: by, ...authorship, planningRevision: revision, recordedAt: Date.now(), ...(Object.keys(scope).length ? { scope } : {}), ...(issue ? { issue } : {}) } } }, raw.reason.trim(), { ...authorship, ...(withheld ? { withheld: true } : {}) }, flow);
    this.planReviewRequests.delete(updated.id);
    if (config.mode !== "off") updated = this.linkIssue(updated); // #694
    if (updated.state === "proposed" && !updated.owner) {
      this.offered.delete(updated.id);
      try { await this.offerReady(updated, "planner review recorded"); }
      catch { this.releaseNotice(`task #${updated.id}: plan review saved; inspect its owner delivery before retrying`); }
    }
    return this.d.board.get(updated.id) ?? updated;
  }

  /** Artifact links and claimed local gates stay on the board; no outside text is accepted. */
  /**
   * `hub_sdlc_record` (#509a): the receipt may also name `deliverables`. They are split off here, claims vetted and the files hashed by the hub,
   * and only then is the rest recorded as before. A receipt with deliverables and nothing else records just the deliverables.
   */
  async recordSdlc(by: PeerId, id: unknown, input: unknown): Promise<Task> {
    const requestCheck = this.requestCheck(by);
    if (!input || typeof input !== "object" || Array.isArray(input) || !("deliverables" in input)) return this.recordLifecycle(by, id, input);
    const { deliverables, ...receipt } = input as Record<string, unknown>;
    const task = this.need(id, false, true);
    if (by !== USER && by !== task.owner && by !== task.reviewer) throw new PreEffectToolRefusal("only the task owner, reviewer or console user may record lifecycle evidence");
    const claims = this.deliverableClaims(deliverables, task);
    const records = await this.hashClaims(claims, task, true);
    requestCheck();
    const current = this.need(id, false, true);
    if (current.history.length !== task.history.length) throw new PreEffectToolRefusal("task changed while its deliverables were hashed; record them again");
    return this.recordLifecycle(by, id, receipt, records);
  }

  recordLifecycle(by: PeerId, id: unknown, input: unknown, deliverables?: DeliverableRecord[]): Task {
    requireLocalTaskPeer(by);
    const task = this.need(id, false, true);
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const next = sdlcReceipt(input, task.sdlc, config, VERSION);
    const definition = stageDefinition(config, next.stage);
    const plannerStage = !!input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "stage")
      && Object.keys(input).every(key => ["stage", "repo", "issue"].includes(key))
      && (definition?.actor === "planner" || definition?.actor === "owner/planner") && this.taskPlanner(task).includes(by);
    if (by !== USER && by !== task.owner && by !== task.reviewer && !plannerStage) throw new PreEffectToolRefusal("only the task owner, reviewer or console user may record lifecycle evidence; a stage planner may record stage identity");
    // The spec identity is person-owned in enforce. No observation cache or restart can reopen a relink bypass.
    const specRelink = (task.sdlc?.repo !== undefined && next.repo !== task.sdlc.repo) || (task.sdlc?.issue !== undefined && next.issue !== task.sdlc.issue);
    if (config.mode === "enforce" && by !== USER && specRelink) throw new PreEffectToolRefusal("only the person may relink an established repository or issue in enforce");
    if (next.redFirst && input && typeof input === "object" && "redFirst" in input && !this.isPii(task) && !this.publicMetadataText(JSON.stringify(next.redFirst))) throw new PreEffectToolRefusal("red-first metadata matches a PII pattern; use private work");
    // #481 S1: entering a build stage in enforce needs the person's spec acceptance; the person may move any stage.
    if (config.mode === "enforce" && by !== USER && next.stage !== task.sdlc?.stage && definition && canonicalStage(definition.base) === "build" && specState(next, undefined) === "missing") throw new PreEffectToolRefusal(this.specText(task, "missing", "blocked"));
    if (config.mode === "enforce" && config.definitions && input && typeof input === "object" && "stage" in input && next.stage !== task.sdlc?.stage && by !== USER) {
      const actor = definition?.actor;
      const acts = actor === "owner" ? by === task.owner : actor === "reviewer" ? by === task.reviewer : actor === "planner" ? this.taskPlanner(task).includes(by) : actor === "owner/planner" && (by === task.owner || this.taskPlanner(task).includes(by));
      if (!acts) throw new PreEffectToolRefusal(`lifecycle stage requires its ${actor ?? "unknown"} actor or the person`);
    }
    if (input && typeof input === "object" && ("criteria" in input || "phase" in input)) {
      this.mine(task, by, "reviewer", true);
      // Screen whichever name stored the checklist: off keeps the #257 phase key (#481 S8).
      const checklist = checklistOf(next);
      if (checklist && !this.isPii(task) && !this.nameable(JSON.stringify(checklist))) throw new PreEffectToolRefusal("checklist metadata matches a PII pattern; use private work");
    }
    // Recording a head is the reviewer's; a head dropped because the repo or PR changed is not a recording, and a
    // head supplied with a new PR identity is one even when its value is unchanged (#382).
    const suppliedHead = !!input && typeof input === "object" && (input as { reviewedHead?: unknown }).reviewedHead !== undefined;
    const artifactChanged = next.repo !== task.sdlc?.repo || next.pr !== task.sdlc?.pr;
    if (next.reviewedHead !== undefined && (next.reviewedHead !== task.sdlc?.reviewedHead || (suppliedHead && artifactChanged))) this.mine(task, by, "reviewer", true);
    const departure = task.history.findLast(h => h.by === USER && h.planDeparture)?.planDeparture;
    const invalidatesDeparture = !!departure && (artifactChanged || next.localHead !== task.sdlc?.localHead && next.localHead !== undefined && next.localHead !== departure.head || next.reviewedHead !== task.sdlc?.reviewedHead && next.reviewedHead !== undefined && next.reviewedHead !== departure.head);
    return this.d.board.update(task.id, by, "lifecycle", { sdlc: next }, undefined, { ...this.planObservation({ ...task, sdlc: next }), ...(invalidatesDeparture ? { planDepartureInvalidated: true } : {}), ...(deliverables ? { deliverables } : {}) });
  }

  /** The board as the merge queue and the guarded merge read it (#786): ids, dependencies, privacy, receipts, findings and plans. */
  private deliveryLinks(config: SdlcConfig): DeliveryTask[] {
    return this.d.board.list().map(t => ({ id: t.id, after: t.deps ?? [], private: this.isPii(t), receipt: t.sdlc, phase: this.isPii(t) ? undefined : this.workflowView(t), findings: this.isPii(t) ? undefined : this.reviewFindingSets(t), plan: config.mode === "off" || this.isPii(t) ? undefined : { paths: this.planPaths(t), revision: t.history.findLast(h => h.planRevision)?.planRevision?.revision ?? 0, fingerprint: planFingerprint(t.plan ?? {}), accepted: this.validPlanDepartures(t) } }));
  }

  /**
   * The board links one `readMergeQueue` read used for a subject (#491): the subject, the holders of the PRs in the open set it read (repository names compare without
   * case, as the queue does), and the tasks those holders and the subject depend on. Nothing else reaches the queue: a proposal, a plan or finding elsewhere, a holder
   * of a closed or merged PR that nobody depends on, or a receipt in another repository cannot change what it saw. Pass the queue the decision read: its rows are the
   * open set. Without one (the read failed) every link counts.
   */
  private queueLinks(links: DeliveryTask[], subject: DeliveryTask, queue: MergeQueue | undefined): DeliveryTask[] {
    if (!queue) return links;
    const repo = subject.receipt?.repo?.toLowerCase(), open = new Set(queue.rows.map(row => row.pr));
    // The subject's own dependencies are also reached as a holder of its open PR; naming them here keeps the fence right if that PR were ever absent from the rows.
    const used = new Set<number>([subject.id, ...subject.after]);
    for (const link of links) {
      if (repo === undefined || link.receipt?.repo?.toLowerCase() !== repo || link.receipt.pr === undefined || !open.has(link.receipt.pr)) continue;
      used.add(link.id);
      for (const id of link.after) used.add(id);
    }
    return links.filter(link => used.has(link.id));
  }

  async deliveryQueue(repo: string) {
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const before = workflowHash(this.d.board.list().map(t => ({ id: t.id, state: t.state, after: t.deps, sdlc: t.sdlc, history: t.history.length })));
    const links = this.deliveryLinks(config);
    const report = await readMergeQueue(repo, config, links, this.d.sdlc?.gh, this.publicMetadataText);
    // Policy can change across remote awaits without any board write. Never return its stale public projection.
    const currentPrivacy = this.d.board.list().map(task => ({ id: task.id, private: this.isPii(task) }));
    if (workflowHash(links.map(({ id, private: hidden }) => ({ id, private: hidden }))) !== workflowHash(currentPrivacy)) {
      return { ...report, complete: false, rows: [], order: [], unordered: [], conflicts: [] };
    }

    const after = workflowHash(this.d.board.list().map(t => ({ id: t.id, state: t.state, after: t.deps, sdlc: t.sdlc, history: t.history.length })));
    if (before !== after) { report.complete = false; report.order = []; if (report.rows.length) report.unordered = report.rows.map(row => row.pr); for (const row of report.rows) { row.ready = false; row.blockers.push("board changed during delivery readback"); } }
    else if (config.mode !== "off") for (const row of report.rows) if (row.head && !row.private) for (const id of row.tasks) {
      const task = this.d.board.get(id);
      if (task?.sdlc?.repo?.toLowerCase() === report.repo.toLowerCase() && task.sdlc.pr === row.pr) {
        if (this.validPlanDepartures(task).length && row.planConformance?.some(item => item.task === id && item.state !== "unknown" && !item.accepted)) this.invalidatedPlanDepartures.add(id);
        this.capturePlanHead(task, row.head);
      }
    }
    for (const row of report.rows) if (row.testIntegrity) {
      row.testIntegrity = row.testIntegrity.map(item => ({ ...publicTestIntegrity(item, this.publicMetadataText), ...(item.task === undefined ? {} : { task: item.task }) }));
      if (config.mode === "enforce") {
        row.blockers = [...new Set([...row.blockers, ...row.testIntegrity.flatMap(testIntegrityBlockers)])];
        row.ready = row.ready && row.blockers.length === 0;
      }
    }
    return report;
  }
  private readonly mergesInFlight = new Set<number>();
  /** #786: who may ask for a guarded merge. The hub's own approval trigger acts as HUB; a peer must be the one configured conductor. */
  private mergeAuthority(by: PeerId): boolean {
    if (isRemotePeerId(by)) return false;
    if (by === USER || by === HUB) return true;
    const holders = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
    return holders.length === 1 && holders[0] === by;
  }
  /**
   * #786 T1/T2: the guarded merge of one approved task. `sdlc.auto_merge` (or the repository's table) says whether it only reports (`dry-run`) or acts (`on`);
   * `opts.dryRun` forces a report. Every gate is re-read right now (`sdlc-merge.ts`); this method owns authority, privacy and the notices, which name the task
   * and the gates only (a PII task shows its stub and is never merged by the hub). Off/dry-run write nothing to the board; on-mode records gate refusals
   * and post-run host observations, claiming eligible post-MERGED remote cleanup and owner notices durably.
   */
  async guardedMerge(by: PeerId, id: unknown, opts: { dryRun?: boolean; trigger?: "review" | "command" } = {}): Promise<{ task: number } & MergeView> {
    if (!this.mergeAuthority(by)) throw new Error("only the console user or the configured conductor may merge");
    const task = this.need(id), label = `#${task.id}`;   // the number only: a notice about a merge never carries a title (a PII task has none to show)
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const mode = opts.dryRun ? "dry-run" as const : mergeModeFor(config, task.sdlc?.repo);
    const refuse = (gate: string) => {
      if(mode==="on")this.recordMergeRefusal(task.id,by,[gate]);
      return { task: task.id, ...mergeView({ mode, decision: { refused: [gate] }, ran: false }) };
    };
    if (this.isPii(task)) return refuse("private task: a person merges");
    if (mode === "off") return refuse("auto_merge is off for this repository");
    if (this.mergesInFlight.has(task.id)) return refuse("a merge check for this task is already running");
    const previous=task.sdlc?.merge;
    if(previous && !(opts.trigger==="command" && previous.state==="not_merged") && previous.repo===task.sdlc?.repo && previous.pr===task.sdlc.pr && previous.head===task.sdlc.reviewedHead)
      return refuse("merge attempt already recorded: inspect its result and any uncertain cleanup before acting");
    // Ephemeral identity excludes merge progress so our own durable writes cannot rebind the observation.
    const artifactIdentity=(row:Task)=>JSON.stringify([row.sdlc?.repo,row.sdlc?.pr,row.sdlc?.issue,row.sdlc?.head,row.sdlc?.reviewedHead,row.sdlc?.localHead,row.refs.repo,row.refs.commit]);
    const initialArtifact=artifactIdentity(task);
    const artifactCurrent=()=>{const row=this.d.board.get(task.id);return !!row && artifactIdentity(row)===initialArtifact;};
    this.mergesInFlight.add(task.id);
    try {
      const links = this.deliveryLinks(config), subject = links.find(link => link.id === task.id)!;
      const outcome = await guardedMerge({ mode, subject, state: task.state, taskState: n => this.d.board.get(n)?.state, config, tasks: links, run: this.d.sdlc?.gh ?? sdlcGh, readableMetadata: this.publicMetadataText,
        recordMerge: record=>this.recordMergeResult(task.id,by,record,artifactCurrent),
        beforeMerge: queue => {
          if (!this.mergeAuthority(by)) return "merge authority changed during the merge check: nothing was run";
          // Only the links this queue read count: a change to one of those (a dependency artifact, an ordering edge, a relink, a new holder of an open PR) invalidates
          // that remote evidence, and any other task's change does not. Both sides are projected through the same queue, so a new holder of an open PR shows.
          const currentConfig = this.d.sdlc?.config() ?? sdlcConfig(undefined);
          const currentLinks = this.deliveryLinks(currentConfig), currentSubject = currentLinks.find(link => link.id === task.id);
          return currentSubject && workflowHash({ config: currentConfig, links: this.queueLinks(currentLinks, currentSubject, queue) }) === workflowHash({ config, links: this.queueLinks(links, subject, queue) })
            ? undefined : "merge queue inputs changed during the merge check: nothing was run";
        },
        // Read synchronously at dispatch, after the last PR read: the task (state, receipt, privacy, dependencies, findings), the configuration and mode in force, and whether
        // the asker may still act and the hub may still write. Nothing is awaited between this read and the gh call.
        fresh: () => {
          const now = this.d.board.get(task.id), cfg = this.d.sdlc?.config() ?? sdlcConfig(undefined);
          const current = now && this.deliveryLinks(cfg).find(link => link.id === now.id);
          return now && current ? { subject: current, state: now.state, config: cfg, mode: opts.dryRun ? "dry-run" : mergeModeFor(cfg, now.sdlc?.repo), allowed: this.mergeAuthority(by) && !this.d.sweepHeld?.() && !this.d.bus.isRecoveryHeld && !this.d.bus.storageError } : undefined;
        } });
      if(mode==="on" && !outcome.ran && "refused" in outcome.decision)this.recordMergeRefusal(task.id,by,outcome.decision.refused);
      if(outcome.result?.state==="merged") {
        try {this.mergeOwnerNotice(task.id,by,artifactCurrent);} catch {this.releaseNotice(`task ${label}: merge owner notice unconfirmed`);}
      }
      const view = mergeView(outcome);
      const head = (text?: string) => text ? text.slice(0, 8) : "unknown";
      if (outcome.result && (this.isPii(this.d.board.get(task.id) ?? task) || this.d.privateTurn?.(by))) this.releaseNotice(`task ${label}: merge result withheld`);
      else if (outcome.result) this.releaseNotice(outcome.result.state === "merged" ? `task ${label}: merged (squash, commit ${head(outcome.result.mergeCommit)})` : `task ${label}: gh pr merge exited ${outcome.result.exit}; GitHub reports it ${outcome.result.state === "unknown" ? "unreadable" : "not merged"}`);
      else if (opts.trigger === "review") this.releaseNotice("action" in outcome.decision ? `task ${label}: auto-merge dry-run: would merge at ${head(outcome.decision.head)}` : `task ${label}: auto-merge refused: ${outcome.decision.refused.join("; ")}`);
      return { task: task.id, ...view };
    } finally { this.mergesInFlight.delete(task.id); }
  }
  private recordMergeRefusal(id:number,by:PeerId,gates:string[]):void {
    const current=this.d.board.get(id);
    if(!current)return;
    const note=JSON.stringify({gates:gates.slice(0,32).map(g=>this.publicMetadataText(g)?g.slice(0,256):"merge gate withheld")});
    if(!current.history.some(h=>h.by===HUB && h.event==="merge refused" && h.note===note))
      this.d.board.update(id,HUB,"merge refused",{},note,{...(this.isPii(current)||this.d.privateTurn?.(by)?{withheld:true}:{})});
  }
  private mergeRecordCurrent(id:number,by:PeerId,record:MergeRecord,artifactCurrent:()=>boolean):Task|undefined {
    const now=this.d.board.get(id);
    return artifactCurrent() && now && now.sdlc?.repo===record.repo && now.sdlc.pr===record.pr && now.sdlc.reviewedHead===record.head
      && now.state==="approved" && !this.isPii(now) && !this.d.privateTurn?.(by) && this.mergeAuthority(by)
      && !this.d.bus.isRecoveryHeld && !this.d.bus.storageError ? now : undefined;
  }
  /** Save host facts without ever rebinding an old result to a replacement artifact. */
  private recordMergeResult(id: number, by: PeerId, record: MergeRecord,artifactCurrent:()=>boolean): boolean {
    const now=this.d.board.get(id);
    if(!now)return false;
    const allowed=this.mergeRecordCurrent(id,by,record,artifactCurrent)!==undefined;
    // A bounded old-attempt fact remains history even after a relink or privacy/authority change. No remote prose or branch name is retained.
    const note=JSON.stringify(record);
    if(allowed) {
      if(JSON.stringify(now.sdlc!.merge)!==note)this.d.board.update(id,HUB,"merge result",{sdlc:{...now.sdlc!,merge:record}},note);
    } else if(!now.history.some(h=>h.by===HUB && h.event==="merge result (detached)" && h.note===note)) {
      this.d.board.update(id,HUB,"merge result (detached)",{},note,{...(this.isPii(now)||this.d.privateTurn?.(by)?{withheld:true}:{})});
    }
    // Board observers run synchronously. A claim write can itself revoke authority, privacy or artifact identity.
    return this.mergeRecordCurrent(id,by,record,artifactCurrent)!==undefined && JSON.stringify(this.d.board.get(id)?.sdlc?.merge)===note;
  }

  /** Claim before publishing: a lost acknowledgement remains unknown and is never automatically sent twice. */
  private mergeOwnerNotice(id:number,by:PeerId,artifactCurrent:()=>boolean):void {
    const task=this.d.board.get(id),record=task?.sdlc?.merge;
    if(!task || !record || record.state!=="merged" || !record.mergeCommit || record.ownerNotice!=="not_started")return;
    const claimed:MergeRecord={...record,ownerNotice:"claimed"};
    if(!this.recordMergeResult(id,by,claimed,artifactCurrent))return;
    const current=this.mergeRecordCurrent(id,by,claimed,artifactCurrent);
    if(!current)return;
    const view=this.publicView(current);
    if(view.title==="[pii]")return;
    const owner=typeof view.owner==="string"?view.owner:undefined;
    const body=`Task #${id}: GitHub reports the PR merged (commit ${record.mergeCommit.slice(0,8)}). Remote branch cleanup: ${record.cleanup}. Remove your local worktree and local branch when safe; the hub leaves them in place.`;
    // Public projection and a synchronous claim observer must not let stale owner text escape.
    const last=this.mergeRecordCurrent(id,by,claimed,artifactCurrent);
    if(!last || (last.owner??undefined)!==owner)return;
    let sent=false;
    try {
      if(owner && owner!==USER)sent=this.d.bus.publish(newEnvelope(HUB,body,{to:[owner],kind:"task",refs:{task:String(id),taskRecipient:"owner"}})).includes(owner);
      else {this.d.notify(body);sent=true;}
    } catch { /* The durable claim keeps an uncertain publication from being repeated. */ }
    this.recordMergeResult(id,by,{...claimed,ownerNotice:sent?"sent":"unknown"},artifactCurrent);
  }
  /**
   * #786 T3 (AC1): mirror a saved verdict as ONE `COMMENT` review on the head it was given for (`sdlc-mirror.ts`). Gated by the same `auto_merge` setting as the merge: off posts
   * nothing, dry-run only reports, on posts. Never awaited by the verdict and never throws: the returned promise always resolves, and a failure is a notice naming the task number.
   * The note goes out only when it is public: not a PII task, not withheld by the review screen, not in a private turn and matching no private pattern; otherwise the review is its headline alone.
   */
  private mirrorVerdict(task: Task, by: PeerId, verdict: MirrorVerdict, head: string | undefined, note: string | undefined, withheld: boolean): Promise<void> {
    try {
      const repo = task.sdlc?.repo, pr = task.sdlc?.pr;
      if (!repo || !pr || !head) return Promise.resolve();
      const mode = mergeModeFor(this.d.sdlc?.config() ?? sdlcConfig(undefined), repo);
      if (mode === "off") return Promise.resolve();
      const text = note && !withheld && !this.isPii(task) && !this.d.privateTurn?.(by) && this.publicMetadataText(note) ? note : undefined;
      const label = `#${task.id}`;
      return Promise.resolve().then(() => mirrorToGitHub({ repo, pr, head, verdict, task: task.id, reviewer: by, ...(text !== undefined ? { note: text } : {}), mode, run: this.d.sdlc?.gh ?? sdlcGh })).then(out => {
        if (out.reason === "posted") this.releaseNotice(`task ${label}: ${verdict} mirrored to GitHub as a comment review`);
        else if (out.reason === "post failed") this.releaseNotice(`task ${label}: verdict mirror could not be posted`);
        else if (out.reason === "dry-run") this.releaseNotice(`task ${label}: verdict mirror dry-run: would post one ${verdict} comment review at ${head.slice(0, 8)}`);
      }).catch(() => this.releaseNotice(`task ${label}: verdict mirror unavailable`));
    } catch { return Promise.resolve(); }
  }
  /** After an approving verdict, never blocking or failing it: the check runs on a later tick and reports through a notice. `after` (the verdict mirror) settles first, so the review lands before the PR can merge. */
  private autoMerge(task: Task, after?: Promise<void>): void {
    try {
      if (!task.sdlc?.repo || !task.sdlc.pr || mergeModeFor(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc.repo) === "off") return;
      const label = `#${task.id}`;
      // Promise.resolve().then also catches a synchronous throw, which would otherwise escape a microtask.
      void Promise.resolve(after).then(() => this.guardedMerge(HUB, task.id, { trigger: "review" })).catch(() => this.releaseNotice(`task ${label}: auto-merge check unavailable`));
    } catch { /* an approval never fails because of the merge check */ }
  }
  async releaseReadiness(repo: string, liveIssues: number[]) {
    const report = await readReleaseReadiness(this.d.cwd, repo, liveIssues, { gh: this.d.sdlc?.gh });
    if (report.documents) report.documents.documents = report.documents.documents.map(d => {
      if (d.path && (!this.nameable(d.path) || matchesPolicy(this.d.cwd, d.path, this.d.piiPaths ?? [], true))) { const { path: _privatePath, ...metadata } = d; return metadata; }
      return d;
    });
    // #481 AC12: release interval, lead time from approval to release and hotfix rate, from the shipped releases' recorded history; unknown stays null (never 0).
    // Releases whose scope holds private work are left out, like the per-release report does.
    const rowsNow = this.d.board.list();
    const publicShipped = this.d.board.releases().filter(release => !rowsNow.some(task => task.release === release.id && this.isPii(task)));
    const metrics = publicShipped.some(release => release.state === "shipped") ? releaseMetrics(publicShipped, rowsNow.filter(task => !this.isPii(task))) : undefined;
    if (metrics) report.releaseMetrics = metrics;
    const trains = this.d.board.releases().filter(release => release.train && ["active", "frozen"].includes(release.state));
    if (trains.length) {
      const planned = trains.map(release => {
        try { return this.releaseReport(USER, release.id); }
        catch { return { release: { id: release.id }, readiness: { trigger: "waiting", tasks: [], blockers: ["release scope unavailable"] } }; }
      });
      if (planned.some(row => row.readiness.blockers.length)) { report.sourceReady = false; report.blockers.push("planned release scope is not approved or available"); }
      return { ...report, trains: planned };
    }
    return report;
  }

  private workflowView(task: Task) {
    return criteriaView(this.d.sdlc?.config() ?? sdlcConfig(undefined), task, t => this.isPii(t));
  }
  workflowExport(id: unknown): Record<string, unknown> {
    const task = this.need(id), config = this.d.sdlc?.config() ?? sdlcConfig(undefined), stage = task.sdlc?.stage ?? config.stages[0] ?? "spec";
    // Off keeps the #257 export bytes; schema 2 (criteria, no workflow framing) is for an enabled or retired-setting lifecycle.
    if (config.mode === "off" && !config.workflow) {
      const legacy = { id: task.id, state: task.state, stage, ...(this.isPii(task) ? { private: true } : { phase: null }) };
      return { schema: 1, workflow: "none", state: legacy, stateHash: workflowHash(legacy), sourceHash: workflowHash(config) };
    }
    const state = { id: task.id, state: task.state, stage, ...(this.isPii(task) ? { private: true } : { criteria: this.workflowView(task) ?? null }) };
    return { schema: 2, state, stateHash: workflowHash(state), sourceHash: workflowHash(config) };
  }
  private readonly planReads = new Map<number, { identity: string; evidence: PrEvidence }>();
  // ponytail: consent expires on restart because a refused readback cannot first mutate the task's history.
  // A durable host observation journal can retain safe consent across lifetimes without reviving pending invalidations.
  private readonly departureGeneration = crypto.randomUUID();
  private readonly invalidatedPlanDepartures = new Set<number>();
  private readonly observedPlans = new Map<number, NonNullable<HistoryEntry["planObservation"]>>();
  private planIdentity(task: Task): string {
    return JSON.stringify([task.refs, task.sdlc, task.plan, task.owner, task.reviewer, task.state, this.isPii(task), this.d.sdlc?.config()]);
  }
  private planReadIdentity(task: Task): string { return JSON.stringify([task.sdlc?.repo, task.sdlc?.pr, task.refs.repo, planFingerprint(task.plan ?? {})]); }
  private planPaths(task: Task): string[] | undefined {
    if (!task.sdlc?.repo) return;
    // Resolve the artifact slug first: it may warm the canonical project's previously unnamed identity.
    const artifact = this.repositories.scope({ repo: task.sdlc.repo, paths: task.refs.paths });
    const scope = this.repositories.scope(task.refs);
    if (scope.key !== artifact.key) return;
    return task.plan?.paths?.map(path => scope === this.repositories.project ? this.projectPath(path) : this.repositories.relativePath(scope, path));
  }
  private planScopeIdentity(task: Task): string {
    const paths = this.planPaths(task); // Warm verified aliases before capturing the scope identity.
    const scope = this.repositories.scope(task.refs);
    return planFingerprint({ key: scope.key, root: scope.root ?? null, aliases: [...scope.aliases].sort(),
      repo: task.refs.repo ?? null, absoluteRefs: (task.refs.paths ?? []).filter(isAbsolute).sort(), paths: paths ?? null });
  }
  private validPlanDepartures(task: Task): NonNullable<HistoryEntry["planDeparture"]>[] {
    const invalidated = task.history.findLastIndex(h => h.planDepartureInvalidated && !h.planDeparture);
    if (this.invalidatedPlanDepartures.has(task.id)) return [];
    const latest = task.history.findLastIndex(h => h.by === USER && h.event === "plan departure accepted" && h.planDeparture);
    return latest > invalidated && task.history[latest]!.planDeparture!.generation === this.departureGeneration
      && task.history[latest]!.planDeparture!.scope === this.planScopeIdentity(task) ? [task.history[latest]!.planDeparture!] : [];
  }
  private planReport(task: Task, evidence?: PrEvidence) {
    const rawReport = planConformance(this.isPii(task) ? undefined : this.planPaths(task), this.isPii(task) ? undefined : evidence);
    const safe = [...rawReport.outside, ...rawReport.untouched].every(path => this.publicMetadataText(path));
    const report: PlanConformance = safe ? rawReport : { state: "unknown", head: rawReport.head, outside: [], untouched: [] };
    const fingerprint = planFingerprint(task.plan ?? {});
    const observation = task.history.find(h => h.planObservation?.repo === task.sdlc?.repo && h.planObservation?.pr === task.sdlc?.pr)?.planObservation ?? this.observedPlans.get(task.id);
    const revision = task.history.findLast(h => h.planRevision)?.planRevision?.revision;
    const acceptance = evidence && this.validPlanDepartures(task).findLast(item => item.repo === task.sdlc?.repo && item.pr === task.sdlc?.pr && item.head === evidence.head
      && item.revision === (revision ?? 0) && item.fingerprint === fingerprint && JSON.stringify([...item.paths].sort()) === JSON.stringify([...evidence.paths].sort()));
    return { ...report, accepted: !!acceptance, earlierPushes: "unknown" as const,
      ...(observation && observation.repo === task.sdlc?.repo && observation.pr === task.sdlc?.pr ? { revisionsAfterFirstObservedPush: Math.max(0, (revision ?? 0) - observation.revision) } : {}) };
  }
  private capturePlanRead(task: Task, evidence: PrEvidence | undefined): void {
    if ((this.d.sdlc?.config().mode ?? "off") === "off" || !evidence || this.isPii(task) || !task.sdlc?.repo || !task.sdlc.pr) return;
    if (this.planReads.size >= 256 && !this.planReads.has(task.id)) this.planReads.delete(this.planReads.keys().next().value!);
    this.planReads.set(task.id, { identity: this.planReadIdentity(task), evidence });
    const accepted = task.history.findLast(h => h.by === USER && h.planDeparture)?.planDeparture;
    if (accepted && evidence.pathsComplete === true && JSON.stringify([...accepted.paths].sort()) !== JSON.stringify([...evidence.paths].sort())) this.invalidatedPlanDepartures.add(task.id);
    this.capturePlanHead(task, evidence.head);
  }
  private capturePlanHead(task: Task, head: string): void {
    if ((this.d.sdlc?.config().mode ?? "off") === "off" || this.isPii(task) || !task.sdlc?.repo || !task.sdlc.pr) return;
    if (this.planReads.get(task.id)?.evidence.head !== head) this.planReads.delete(task.id);
    const accepted = task.history.findLast(h => h.by === USER && h.planDeparture)?.planDeparture;
    if (accepted && (accepted.head !== head || accepted.repo !== task.sdlc.repo || accepted.pr !== task.sdlc.pr)) this.invalidatedPlanDepartures.add(task.id);
    if (!task.history.some(h => h.planObservation?.repo === task.sdlc?.repo && h.planObservation?.pr === task.sdlc?.pr)
      && (!this.observedPlans.has(task.id) || this.observedPlans.get(task.id)?.repo !== task.sdlc.repo || this.observedPlans.get(task.id)?.pr !== task.sdlc.pr)) {
      // ponytail: this is first observed push, not a true push event. Earlier pushes stay unknown; upgrade to a webhook/Actions push receipt.
      if (this.observedPlans.size >= 256) this.observedPlans.delete(this.observedPlans.keys().next().value!);
      this.observedPlans.set(task.id, { repo: task.sdlc.repo, pr: task.sdlc.pr, head,
        revision: task.history.findLast(h => h.planRevision)?.planRevision?.revision ?? 0, fingerprint: planFingerprint(task.plan ?? {}) });
    }
  }
  private planObservation(task: Task): Pick<HistoryEntry, "planObservation" | "planDepartureInvalidated"> {
    if ((this.d.sdlc?.config().mode ?? "off") === "off") return {};
    const observation = this.observedPlans.get(task.id);
    const lastAcceptance = task.history.findLastIndex(h => h.by === USER && h.planDeparture);
    return {
      ...(observation && observation.repo === task.sdlc?.repo && observation.pr === task.sdlc?.pr
        && !task.history.some(h => h.planObservation?.repo === observation.repo && h.planObservation.pr === observation.pr) ? { planObservation: observation } : {}),
      ...(this.invalidatedPlanDepartures.has(task.id) && !task.history.slice(lastAcceptance + 1).some(h => h.planDepartureInvalidated) ? { planDepartureInvalidated: true as const } : {}),
    };
  }
  async acceptPlanDeparture(by: PeerId, id: unknown, head: unknown, reason: unknown): Promise<Task> {
    if (by !== USER) throw new PreEffectToolRefusal("only the person may accept a plan departure");
    if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head) || typeof reason !== "string" || !reason.trim() || reason.length > 2048) throw new PreEffectToolRefusal("departure acceptance requires a full head and a bounded reason");
    const initial = this.need(id, false, true), identity = this.planIdentity(initial), scope = this.planScopeIdentity(initial), history = initial.history.length;
    const valid = () => { const now = this.need(id, false, true); if (isClosedTaskState(now.state) || identity !== this.planIdentity(now) || scope !== this.planScopeIdentity(now) || history !== now.history.length) throw new PreEffectToolRefusal("task changed during departure readback"); return now; };
    if (this.isPii(initial)) throw new PreEffectToolRefusal("private PR file evidence is unavailable; amend the private plan instead");
    const read: SdlcGh = (args, timeout, cwd, cap) => { valid(); return (this.d.sdlc?.gh ?? sdlcGh)(args, timeout, cwd, cap); };
    const evidence = initial.sdlc && await readSdlcPr(initial.sdlc, read); valid();
    if (!evidence || completePlanInventory(evidence) === undefined) throw new PreEffectToolRefusal("complete PR file inventory unknown");
    if (evidence.head !== head) throw new PreEffectToolRefusal("departure acceptance head is not the current PR head");
    if (this.planReport(initial, evidence).state !== "departure") throw new PreEffectToolRefusal("current plan conformance is not a known departure; amend unknown scope or coverage first");
    const note = sanitize(reason.replace(/\s+/g, " ").trim());
    const withheld = await this.withholds("note", note, initial); const current = valid();
    this.capturePlanRead(current, evidence);
    const next = this.d.board.update(current.id, USER, "plan departure accepted", {}, note, { withheld: withheld || undefined, ...this.planObservation(current),
      planDeparture: { generation: this.departureGeneration, scope, repo: current.sdlc!.repo!, pr: current.sdlc!.pr!, head, revision: current.history.findLast(h => h.planRevision)?.planRevision?.revision ?? 0, fingerprint: planFingerprint(current.plan ?? {}), paths: [...evidence.paths] } });
    this.invalidatedPlanDepartures.delete(current.id);
    return next;
  }
  async lifecycleStatus(id: unknown, refresh = true): Promise<SdlcStatus> {
    const task = this.need(id), config = this.d.sdlc?.config() ?? sdlcConfig(undefined), identity = this.planIdentity(task);
    const valid = () => { const now = this.need(id, false, true); if (this.planIdentity(now) !== identity || now.history.length !== task.history.length) throw new PreEffectToolRefusal("task changed during lifecycle readback"); return now; };
    const deadline = performance.now() + 20_000;
    const read: SdlcGh = (args, timeout, cwd, cap) => { valid(); const remaining = deadline - performance.now(); return remaining > 0 ? (this.d.sdlc?.gh ?? sdlcGh)(args, Math.min(timeout ?? 10_000, remaining), cwd, cap) : Promise.resolve({ code: 1, stdout: "" }); };
    const evidence = task.sdlc && !this.isPii(task) && refresh && config.mode !== "off" ? await readSdlcPr(task.sdlc, read, true) : undefined;
    valid();
    const accepted = task.sdlc?.acceptance;
    const edit = accepted && !this.isPii(task) && refresh && config.mode !== "off" ? await readSpecEdit(accepted.repo, accepted.issue, read) : undefined;
    const integrity = config.mode !== "off" ? publicTestIntegrity(task.sdlc && evidence && !this.isPii(task) ? await readTestIntegrity(task.sdlc, evidence, read) : this.unknownTestIntegrity(this.isPii(task)), this.publicMetadataText) : undefined;
    const evalResult = task.sdlc && !this.isPii(task) ? await readEvalFor(config, evidence, task.sdlc.repo, read) : undefined;
    const current = valid();
    if (this.planIdentity(current) !== this.planIdentity(task) || current.history.length !== task.history.length) throw new PreEffectToolRefusal("task changed during lifecycle readback");
    this.capturePlanRead(current, evidence);
    return sdlcStatus(config, current.sdlc, evidence, this.workflowView(current), edit, this.isPii(current) ? [] : this.reviewFindingSets(current), current.refs.commit,
      config.mode !== "off" ? this.planReport(this.d.board.get(current.id)!, evidence) : undefined, integrity, evalResult);
  }

  /** #481 S1: only build work starts from an accepted spec. */
  private specGated(task: Task): boolean {
    return (this.d.sdlc?.config().mode ?? "off") !== "off" && (task.class === "implement" || task.class === "bulk_edit");
  }
  private specText(task: Task, state: Exclude<SpecState, "current">, verb: "blocked" | "advice"): string {
    const issue = task.sdlc?.issue;
    const why = issue ? SPEC_STATE_TEXT[state].replace("<task>", String(task.id)).replace("<n>", String(issue)) : "spec issue unknown: record repo and issue with hub_sdlc_record, then the person accepts it with ahub sdlc accept";
    return `task #${task.id}: SDLC build entry ${verb}: ${why}`;
  }

  /** The person's acceptance of the task's spec issue at its current body (#481 S1); identity and edit times only. */
  acceptSpec(by: PeerId, id: unknown, spec: { repo?: unknown; issue: unknown; edit: SpecEdit }): Task {
    if (by !== USER) throw new PreEffectToolRefusal("spec acceptance is the person's: run ahub sdlc accept in a terminal");
    const task = this.need(id, false, true, true), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const repo = spec.repo ?? task.sdlc?.repo;
    if (task.sdlc?.issue !== undefined && task.sdlc.issue !== spec.issue) throw new PreEffectToolRefusal(`task #${task.id} links issue #${task.sdlc.issue}; relink it with hub_sdlc_record before accepting another`);
    const next = sdlcReceipt({ repo, issue: spec.issue }, task.sdlc, config);
    if (!next.repo || !next.issue) throw new PreEffectToolRefusal("spec acceptance needs the repository (owner/repository) and the issue number");
    next.acceptance = { repo: next.repo, issue: next.issue, lastEditedAt: spec.edit.lastEditedAt, updatedAt: spec.edit.updatedAt, acceptedAt: Date.now() };
    return this.d.board.update(task.id, USER, "spec accepted", { sdlc: next }, `issue #${next.issue}, body last edited ${spec.edit.lastEditedAt ?? "never"}`);
  }

  /** Build entry with a live readback of the spec's body edit time (#481 S1): enforce refuses, advise notifies, off does nothing. */
  async specGate(by: PeerId, id: unknown): Promise<void> {
    requireLocalTaskPeer(by);
    const task = this.need(id, false, true);
    if (!this.specGated(task) || task.owner !== by && by !== USER) return; // accept reports its own refusals
    const accepted = task.sdlc?.acceptance;
    const edit = accepted && !this.isPii(task) ? await readSpecEdit(accepted.repo, accepted.issue, this.d.sdlc?.gh) : undefined;
    if (this.specMoved(task)) return;
    this.specVerdict(task, task.sdlc?.issue ? specState(task.sdlc, edit) : "missing");
  }

  /** #481 S1: a build stage change by an agent re-reads the body edit time first, as accept does. */
  async specStageGate(by: PeerId, id: unknown, input: unknown): Promise<void> {
    requireLocalTaskPeer(by);
    const task = this.need(id, false, true), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (config.mode === "off" || by === USER || !input || typeof input !== "object" || !("stage" in input)) return;
    let next: ReturnType<typeof sdlcReceipt>;
    // #509a: `deliverables` ride in the receipt but are not a lifecycle field: recordSdlc splits them off, so the gate reads the same receipt it will record.
    const { deliverables: _carried, ...lifecycleInput } = input as Record<string, unknown>;
    try { next = sdlcReceipt(lifecycleInput, task.sdlc, config, VERSION); } catch { return; } // recordLifecycle reports an invalid receipt
    const definition = stageDefinition(config, next.stage);
    if (next.stage === task.sdlc?.stage || !definition || canonicalStage(definition.base) !== "build") return;
    const accepted = next.acceptance;
    const edit = accepted && !this.isPii(task) ? await readSpecEdit(accepted.repo, accepted.issue, this.d.sdlc?.gh) : undefined;
    if (this.specMoved(task)) return;
    this.specVerdict(task, next.issue ? specState(next, edit) : "missing");
  }

  /**
   * The task a spec readback started from changed while it was awaited (flow, link, acceptance, owner or privacy): the
   * reading belongs to other work. Enforce refuses before any write; advise drops the stale advice.
   */
  private specMoved(before: Task): boolean {
    const now = this.need(before.id, false, true);
    if (now.history.length === before.history.length && now.owner === before.owner && this.isPii(now) === this.isPii(before)
      && JSON.stringify(now.sdlc ?? null) === JSON.stringify(before.sdlc ?? null)) return false;
    if (this.d.sdlc?.config().mode === "enforce") throw new PreEffectToolRefusal(`task #${before.id}: changed during the spec readback; nothing was recorded, retry on current work`);
    return true;
  }
  private specVerdict(task: Task, state: SpecState): void {
    if (state === "current") return;
    if (this.d.sdlc?.config().mode === "enforce") throw new PreEffectToolRefusal(this.specText(task, state, "blocked"));
    this.d.notify(this.specText(task, state, "advice"));
  }

  private unknownTestIntegrity(privateTask = false): TestIntegrity {
    return { applicability: "unknown", redFirst: "unknown", fileState: "unknown", modifiedTests: [], blockers: [privateTask ? "test integrity: private evidence unavailable" : "test integrity: current evidence unknown"] };
  }

  /** The eval record the last approval-time lifecycle read produced for a task; consumed by the verdict that follows it. */
  private readonly evalRecords = new Map<number, string>();
  private async lifecycleGate(task: Task, transition: "review" | "approval", reviewedHead?: string, findings?: readonly ReviewFindingSet[]): Promise<PrEvidence | undefined> {
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (config.mode === "off") return;
    const receipt = task.sdlc && { ...task.sdlc, ...(reviewedHead ? { reviewedHead } : {}) };
    const deadline = performance.now() + 20_000;
    const read: SdlcGh = (args, timeout, cwd, cap) => {
      const current = this.need(task.id, false, true);
      if (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || this.isPii(current) !== this.isPii(task)) return Promise.resolve({ code: 1, stdout: "" });
      const remaining = deadline - performance.now();
      return remaining > 0 ? (this.d.sdlc?.gh ?? sdlcGh)(args, Math.min(timeout ?? 10_000, remaining), cwd, cap) : Promise.resolve({ code: 1, stdout: "" });
    };
    const evidence = receipt && !this.isPii(task) ? await readSdlcPr(receipt, read, true) : undefined;
    const integrity = publicTestIntegrity(receipt && evidence && !this.isPii(task) ? await readTestIntegrity(receipt, evidence, read) : this.unknownTestIntegrity(this.isPii(task)), this.publicMetadataText);
    const evalResult = receipt && !this.isPii(task) ? await readEvalFor(config, evidence, receipt.repo, read) : undefined;
    const current = this.need(task.id, false, true);
    if (config.mode === "enforce" && (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || current.state !== task.state)) throw new PreEffectToolRefusal(`task #${task.id}: changed during lifecycle readback; retry on current work`);
    // Advise may continue on the current task, but evidence from its previous link cannot admit that task's review.
    if (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || current.state !== task.state || this.isPii(current) !== this.isPii(task)) return;
    this.capturePlanRead(current, evidence);
    const planReport = this.planReport(current, evidence);
    const status = sdlcStatus(config, receipt, evidence, this.workflowView(current), undefined, this.isPii(current) ? [] : findings ?? this.reviewFindingSets(current), current.refs.commit, planReport, integrity, evalResult);
    // #481 S5: review entry keeps the eval gate's own blockers (its check, and in enforce its evidence gaps), like the premature-review rule does for the ordinary required checks.
    const evalNames = evalRequiredChecks(config, evidence).filter(name => !config.requiredChecks.includes(name));
    const evalBlocker = (blocker: string) => evalNames.some(name => blocker.startsWith(`required check ${name}:`)) || evalGapBlockers(status.evalGate).includes(blocker);
    const blockers = transition === "review" ? [...new Set([...status.blockers.filter(blocker => ["lifecycle stage definition unknown", "issue identity missing", "PR identity missing", "current PR evidence unknown", "PR is not open", "local gate on current head missing or failed"].includes(blocker) || blocker.startsWith("test integrity:") || evalBlocker(blocker)), ...(status.entry ?? []), ...(status.exit ?? [])])] : status.blockers;
    if (config.mode === "enforce" && blockers.length) throw new PreEffectToolRefusal(`task #${task.id}: SDLC ${transition} blocked: ${blockers.join("; ")}`);
    // #481 S5: the recorded pass rate and suite version ride the approval note; a code-only PR, an unconfigured gate or an unreported value records nothing.
    const gate = status.evalGate;
    if (transition === "approval" && gate?.state === "passed" && gate.passRate !== undefined && gate.suite !== undefined && !this.isPii(task)) this.evalRecords.set(task.id, `Eval gate: ${gate.check} passed at ${evidence!.head.slice(0, 12)}, pass rate ${gate.passRate}, suite ${gate.suite}`);
    else this.evalRecords.delete(task.id);
    const advice = [...new Set([...blockers, ...planConformanceBlockers(planReport), ...testIntegrityBlockers(integrity), ...evalAdvice(status.evalGate)])];
    if (config.mode === "advise" && advice.length) this.d.notify(`task ${this.publicTitle(task)}: SDLC ${transition} advice: ${this.isPii(task) ? "private lifecycle evidence unknown" : advice.join("; ")}`);
    return evidence;
  }

  private need(id: unknown, open = false, preEffect = false, allowBacklog = false): Task {
    // Callers are models (#70): an id is a whole number or a digit string, never an array that Number() would accept.
    const n = typeof id === "number" ? id : typeof id === "string" && /^\s*\d+\s*$/.test(id) ? Number(id) : NaN;
    if (!Number.isInteger(n)) throw new (preEffect ? PreEffectToolRefusal : Error)(`id must be a task number, not ${(typeof id === "number" ? String(id) : JSON.stringify(id ?? null)).slice(0, 60)}`);
    const task = this.d.board.get(n);
    if (!task) throw new (preEffect ? PreEffectToolRefusal : Error)(`no task #${n}`);
    if (task.state === "backlog" && !allowBacklog) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${n} is backlog: pull it into To Do first`);
    // Handing a task to someone else only makes sense while there is work left on it.
    if (open && !OPEN.includes(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: it can no longer change hands`);
    return task;
  }

  private readonly pendingClaims = new Map<PeerId, number>();
  private readonly reviewedAdmissions = new Map<number, { flow: number; owner: string | null }>();
  private isBuildTask(task: Task): boolean {
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (["implement", "bulk_edit"].includes(task.class)) return true;
    const base = task.sdlc ? stageDefinition(config, task.sdlc.stage)?.base : undefined;
    return base === "build" || base === "implement";
  }
  async acceptReviewed(by: PeerId, id: unknown, plan?: unknown, refs?: unknown): Promise<Task> {
    const requestCheck = this.requestCheck(by);
    const metadata = acceptRefs(refs);
    const task = this.need(id, false, true);
    this.mine(task, by, "owner", true);
    this.acceptanceCapacity(task);
    if (metadata && !this.isPii(task) && (!this.nameable(metadata.repo!) || looksSecret(metadata.repo!) || this.aboutPrivatePath("", metadata.repo!, task))) throw new PreEffectToolRefusal("this repository metadata is private or sensitive and is not kept");
    const draft = metadata ? { ...task, refs: { ...task.refs, ...metadata } } : task;
    this.warmRepository(draft);
    if ((this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode === "off" || !this.isBuildTask(task)) return this.accept(by, id, plan, metadata);
    await this.specGate(by, id);
    await this.planEntryGate(by, draft);
    requestCheck();
    const current = this.need(id, false, true);
    this.mine(current, by, "owner", true);
    if (current.history.length !== task.history.length || current.owner !== task.owner) throw new PreEffectToolRefusal("task changed during build admission");
    this.reviewedAdmissions.set(current.id, { flow: current.history.length, owner: current.owner });
    try { return this.accept(by, id, plan, metadata); }
    finally { this.reviewedAdmissions.delete(current.id); }
  }

  /** Spec and plan readbacks share the caller's original task snapshot until the final acceptance write. */
  private async planEntryGate(by: PeerId, task: Task): Promise<void> {
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (mode === "off" || !this.isBuildTask(task)) return;
    const gap = await this.planReviewGap(task);
    if (mode === "advise" && !task.sdlc?.planReview?.scope) this.releaseNotice(`task ${this.publicTitle(task)}: cost scope unspecified`);
    const current = this.need(task.id, false, true);
    this.mine(current, by, "owner", true);
    if (current.history.length !== task.history.length || current.owner !== task.owner) throw new PreEffectToolRefusal("task changed during plan readback");
    if (gap && mode === "enforce") throw new PreEffectToolRefusal(gap);
    if (gap) this.releaseNotice(`task ${this.publicTitle(current)}: ${gap}`);
  }

  private acceptanceCapacity(task: Pick<Task, "id" | "owner" | "reserved" | "state"> & Partial<Pick<Task, "history">>, excludePending = 0): void {
    const owner = task.owner ?? task.reserved;
    if (!owner) return;
    if ((task.state === "in_progress" || task.state === "changes_requested") && task.history) {
      let boundary = 0, previous: PeerId | null | undefined;
      task.history.forEach((entry, index) => {
        if (entry.owner !== undefined) {
          if (entry.owner !== previous) boundary = index;
          previous = entry.owner;
        } else if (OWNERSHIP_EVENTS.has(entry.event)) { boundary = index; previous = undefined; }
      });
      if (task.history.slice(boundary).some(entry => entry.event === "accepted" && (entry.by === owner || entry.by === USER))) return;
    }
    const limit = this.wipLimit(owner), pending = Math.max(0, (this.pendingClaims.get(owner) ?? 0) - excludePending);
    if (this.wip(owner, task.id) + pending < limit) return;
    const open = this.d.board.list().filter(other => other.id !== task.id && !["backlog", "approved", "cancelled"].includes(other.state)
      && (other.owner === owner || !other.owner && other.reserved === owner && this.plannerPullRecord(other)?.pull)).map(other => `#${other.id}`);
    throw new PreEffectToolRefusal(`planner WIP capacity for ${owner}: limit ${limit}; open tasks ${open.join(", ") || "none"}${pending ? `; pending claims ${pending}` : ""}`);
  }

  /**
   * With a plan, the owners of overlapping tasks get it as a ride-along line, and an overlap only the plan reveals is
   * announced like one found at assignment (issue #31).
   */
  accept(by: PeerId, id: unknown, plan?: unknown, refs?: unknown): Task {
    requireLocalTaskPeer(by);
    const metadata = acceptRefs(refs);
    const task = this.need(id, false, true);
    this.mine(task, by, "owner", true);
    this.ready(task, true);
    if (task.state !== "proposed" && task.state !== "changes_requested" && task.state !== "in_progress") throw new PreEffectToolRefusal(`task #${task.id} is ${task.state}: cannot move to in_progress`);
    this.studyDispatchCheck(task, task.owner ?? undefined);
    this.acceptanceCapacity(task);
    // S1 spec acceptance and S9 plan review are independent prerequisites; retain S1's missing-spec refusal first.
    if (this.specGated(task) && this.d.sdlc?.config().mode === "enforce" && specState(task.sdlc, undefined) === "missing") throw new PreEffectToolRefusal(this.specText(task, "missing", "blocked"));
    if ((this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode === "enforce" && this.isBuildTask(task)) {
      const readback = this.reviewedAdmissions.get(task.id);
      this.reviewedAdmissions.delete(task.id);
      if (!readback || readback.flow !== task.history.length || readback.owner !== task.owner) throw new PreEffectToolRefusal("current plan-review readback required before acceptance");
    }
    // Models send null or {} for an optional field they leave empty: neither replaces a plan.
    const given = plan == null ? undefined : cleanPlan(plan, (task.profile ?? "dev") === (this.d.profile ?? "dev") ? this.d.profileData ?? task.profile ?? "dev" : task.profile ?? "dev");
    // File-list intent still replaces the old lists; omitted budget keys retain the planner-reviewed scope.
    const cleaned = given && Object.keys(given).length ? { ...cleanCostPlan(task.plan ?? {}), ...given } : undefined;
    if (this.d.sdlc?.config().mode === "enforce" && task.sdlc?.planReview && !task.sdlc.planReview.scope
      && given && Object.keys(cleanCostPlan(given)).length) throw new PreEffectToolRefusal("legacy plan cost scope is unspecified; record a scoped planner review before acceptance");
    if (this.d.sdlc?.config().mode === "enforce" && task.sdlc?.planReview?.scope
      && JSON.stringify(cleanCostPlan(cleaned ?? task.plan ?? {})) !== JSON.stringify(task.sdlc.planReview.scope)) {
      throw new PreEffectToolRefusal("plan cost scope changed; record a new planner review before acceptance");
    }
    // A task's signals are fixed when it is proposed: text that matches a PII pattern cannot be let in afterwards.
    if (cleaned && !this.isPii(task) && this.isPii({ signals: this.signalsFor({ title: "", detail: planText(cleaned), refs: {}, plan: cleaned }) })) {
      throw new PreEffectToolRefusal("this plan matches a PII pattern and is not kept: other owners would see it");
    }
    if (metadata && !this.isPii(task) && (!this.nameable(metadata.repo!) || looksSecret(metadata.repo!) || this.aboutPrivatePath("", metadata.repo!, task))) throw new PreEffectToolRefusal("this repository metadata is private or sensitive and is not kept");
    const draft = { ...task, refs: { ...task.refs, ...metadata }, ...(cleaned ? { plan: cleaned } : {}) };
    this.warmRepository(draft);
    const repositoryChanged = this.repositories.scope(task.refs).key !== this.repositories.scope(draft.refs).key;
    const before = new Set(this.overlapHits(task).map((h) => h.task.id));
    this.studyDispatchCheck(task, task.owner ?? undefined);
    const next = this.linkOnWrite(this.d.board.update(task.id, by, "accepted", { state: "in_progress", ...(cleaned ? { plan: cleaned } : {}), ...(metadata ? { refs: metadata } : {}) })); // #723: refs.repo may have just arrived
    this.captureOwnerAcceptance(next);
    this.d.notify(`task ${this.publicTitle(next)} accepted by ${by}`);
    if (repositoryChanged) this.cohorts.leave(next.id);
    if (cleaned || metadata) {
      const hits = this.overlapHits(next);
      this.formCohort(next, hits);
      const fresh = hits.filter((h) => !before.has(h.task.id));
      if (fresh.length) this.announceOverlap(next, fresh);
      this.tellEarlierOwners(next, hits);
    }
    return next;
  }

  /**
   * Put `task` and the open tasks it overlaps into one cohort (issue #107). A silent cohort that an owner without a
   * verified context path joins speaks again, and its members hear so.
   */
  private formCohort(task: Task, hits: ReturnType<Tasks["overlapHits"]>): void {
    if (!task.owner || this.isPii(task)) return;
    const coordinate = this.coordinationModes.get(task.id);
    const coordinated = this.d.coordination ? hits.filter(hit => this.coordinationModes.get(hit.task.id) === coordinate) : hits;
    const before = this.cohorts.of(task.id)?.revision;
    const joined = this.cohorts.join(task, coordinated.map((h) => h.task), ownerGen, handedAt, !this.d.coordination || coordinate === true);
    if (!joined) return;
    const c = joined.cohort;
    if (joined.formed || c.revision !== before) {
      this.d.recordCohort?.({ id: c.id, event: joined.formed ? "formed" : "joined", silent: c.silent, tasks: [...c.members.keys()].sort((a, b) => a - b), owners: [...new Set([...c.members.values()].map((m) => m.owner))].sort() });
      // A shadow split prediction for the pair that just overlapped, named owner or not (issue #109): for the record only.
      const shadow = this.splitShadow(task, task.owner);
      if (shadow) this.d.recordSplit?.(task.id, shadow, "cohort");
    }
    if (joined.lifted) this.announceLift(c, `${task.owner} cannot be shown the others' changes`);
  }

  /** Members of a cohort that is no longer silent may message each other again. */
  announceLift(cohort: Cohort, why: string): void {
    const owners = [...new Set([...cohort.members.values()].map((m) => m.owner))];
    this.d.notify(`turn-free cohort #${cohort.id} (${owners.join(", ")}) is no longer silent: ${why}`);
    this.d.recordCohort?.({ id: cohort.id, event: "lifted", silent: false, tasks: [...cohort.members.keys()].sort((a, b) => a - b), owners: [...owners].sort() });
    // Members still at work hear it, with the completed-change notices the silence held (they replace the integration
    // step that will not run); a member whose task closed is not started on a turn for it (#106).
    for (const m of cohort.members.values()) {
      const t = this.d.board.get(m.task);
      if (m.owner === USER || m.owner === HUB || !t || !OPEN.includes(t.state)) continue;
      const evidence = this.heldEvidence(cohort, t);
      this.whileOpen(m.owner, m.task, [`Task #${m.task}: turn-free silence is lifted for the overlapping work of ${owners.filter((o) => o !== m.owner).join(", ")} (${why}). Settle overlaps with them via hub_send, as usual.`, evidence ?? ""].filter(Boolean).join("\n"));
    }
    cohort.held.clear();
  }

  /** Text a done result carries besides the board line (issue #107): held notices when no integration ran. */
  private readonly doneNotes = new Map<number, string>();
  takeDoneNote = (id: number): string | undefined => {
    const note = this.doneNotes.get(id);
    this.doneNotes.delete(id);
    return note;
  };
  /** #572 AC3: what the owner's `hub_task_done` result adds while the project root checkout is on a task branch. */
  checkoutNote = (): string | undefined => { const warning = mainCheckoutWarning(this.d.cwd, this.publicMetadataText); return warning ? `Note: ${warning}.` : undefined; };

  /**
   * `capacity` (#531): the owner has no room right now, so the decline excludes it only from this move's own reroute
   * (below), never from a later reroute or planner pull. Without it, a decline is a lasting refusal (`excluded()`), and so
   * is every older row, which has no such field.
   */
  async decline(by: PeerId, id: unknown, reason?: string, capacity?: boolean): Promise<Task> {
    const task = this.need(id, true, true);
    this.mine(task, by, "owner", true);
    // The owner it is declined for goes on the entry, also when the console declines for it: `excluded()` keeps it out (#207).
    const capacityBefore = this.capacityBefore(task);
    const planned = this.plannerPullRecord(task)?.pull === true;
    const back = this.d.board.update(task.id, by, "declined", { ...(["in_progress", "changes_requested"].includes(task.state) ? { state: "proposed" as const } : {}), ...(planned ? { reserved: null } : {}) }, reason, task.owner ? { from: task.owner, ...(capacity === true ? { capacity: true as const } : {}) } : {});
    if (planned) this.offered.delete(task.id);
    this.d.notify(`task ${this.publicTitle(back)} declined${capacity === true ? " (capacity only)" : ""} by ${by}${reason && !this.isPii(back) ? `: ${reason}` : ""}`);
    // A capacity decline is not in excluded(), so this move's own reroute leaves the decliner out explicitly.
    try {
      return await this.assignOwner(back, HUB, { event: "reassigned", reason: "declined", clearOnFail: true, ...(capacity === true && task.owner ? { exclude: [task.owner] } : {}), ...(planned ? { planner: true } : {}) });
    } finally {
      this.writePlannerNotices(this.d.board.get(task.id) ?? back, capacityBefore);
    }
  }

  /**
   * #509a: the task's deliverables as they are now against what was delivered and what was approved. `changedSinceReview` is true only for a file
   * measured to differ from the bytes a reviewer approved (or, before approval, from the bytes delivered); a file the hub cannot read is
   * `unknown`, never `unchanged`. Ids, hashes and sizes only for a private record. Undefined when the task delivered nothing.
   */
  async deliverableStatus(task: Task): Promise<{ state: "none" | "delivered" | "approved"; changedSinceReview: boolean; files: DeliverableStatus[] } | undefined> {
    const delivered = latestDeliverables(task.history);
    if (!delivered) return undefined;
    const approved = task.state === "approved" ? approvedDeliverables(task.history) : undefined;
    const basis = approved ?? delivered;
    const checks = await this.checkRecords(basis, task);
    const shown = publicDeliverables(basis, this.nameable)!;
    const files = checks.map((check, i): DeliverableStatus => {
      const { sha256, id, format, version, path, private: hidden } = shown[i]!;
      return { id, sha256, state: check.state, ...(path ? { path } : {}), format, ...(version ? { version } : {}), ...(hidden ? { private: true as const } : {}) };
    });
    const changedSinceReview = files.some(file => file.state === "changed");
    this.deliverableSeen.set(task.id, { key: Tasks.deliverableKey(basis), at: Date.now(), result: deliverableResult(files.map(file => file.state)) });
    return { state: approved ? "approved" : "delivered", changedSinceReview, files };
  }

  /** The last live check per task (#317): what the dashboard may say about "changed since review" without hashing on its 1 s poll. Keyed by the records it measured. */
  private deliverableSeen = new Map<number, { key: string; at: number; result: DeliverableResult }>();
  private static deliverableKey = (records: readonly DeliverableRecord[]) => records.map(record => `${record.id}:${record.sha256}`).join(",");

  /**
   * #317: the deliverables of the board's tasks, newest task first, for `ahub deliverables`. `approved` is what a reviewer's approval bound (else what was delivered).
   * Without `check` this reads the board only: no file is opened, so no row claims `changedSinceReview`. With `check` every file is measured now (one task at a time).
   * Every path goes through `publicDeliverables`, so a PII task or a path under `pii.paths` shows id, hash and size only.
   */
  async deliverableList(opts: { task?: number; approvedOnly?: boolean; check?: boolean; visible?: (task: Task) => boolean } = {}): Promise<DeliverableRow[]> {
    const rows: DeliverableRow[] = [];
    // #933: `visible` drops a task before anything is read or measured (an agent's list holds only what hub_task_show shows it).
    const tasks = (opts.task !== undefined ? [this.d.board.get(opts.task)].filter((task): task is Task => !!task) : this.d.board.list()).filter(task => !opts.visible || opts.visible(task)).sort((a, b) => b.id - a.id);
    for (const task of tasks) {
      const delivered = latestDeliverables(task.history);
      if (!delivered) continue;
      const approved = task.state === "approved" ? approvedDeliverables(task.history) : undefined;
      if (opts.approvedOnly && !approved) continue;
      const basis = approved ?? delivered, shown = publicDeliverables(basis, this.nameable)!;
      const row: DeliverableRow = { task: task.id, title: this.publicTitle(task), taskState: task.state, state: approved ? "approved" : "delivered", checked: false,
        files: shown.map(({ id, path, format, version, sha256, bytes, private: hidden }) => ({ id, ...(path ? { path } : {}), format, ...(version ? { version } : {}), sha256, bytes, ...(hidden ? { private: true as const } : {}) })) };
      if (opts.check) {
        const status = await this.deliverableStatus(task);
        if (status) { row.checked = true; row.changedSinceReview = status.changedSinceReview; row.result = deliverableResult(status.files.map(file => file.state)); row.files = row.files.map((file, i) => ({ ...file, state: status.files[i]!.state })); }
      }
      rows.push(row);
    }
    return rows;
  }

  /** What the dashboard card shows: the board's records, plus the last live check when it measured exactly these records. Opens no file. */
  deliverableBadge(task: Task): { state: "delivered" | "approved"; files: DeliverableRow["files"]; checked?: { at: number; result: DeliverableResult } } | undefined {
    const delivered = latestDeliverables(task.history);
    if (!delivered) return undefined;
    const approved = task.state === "approved" ? approvedDeliverables(task.history) : undefined;
    const basis = approved ?? delivered, seen = this.deliverableSeen.get(task.id);
    return { state: approved ? "approved" : "delivered",
      files: publicDeliverables(basis, this.nameable)!.map(({ id, path, format, version, sha256, bytes, private: hidden }) => ({ id, ...(path ? { path } : {}), format, ...(version ? { version } : {}), sha256, bytes, ...(hidden ? { private: true as const } : {}) })),
      ...(seen && seen.key === Tasks.deliverableKey(basis) ? { checked: { at: seen.at, result: seen.result } } : {}) };
  }

  /** Check records against the owner's root; with that root unproven every file is `unknown` (never `unchanged`, never an exception). */
  private async checkRecords(records: DeliverableRecord[], task: Task) {
    try { return await checkDeliverables(records, this.deliverablePorts(task)); }
    catch (error) { return records.map(record => ({ record, state: "unknown" as const, why: error instanceof Error ? error.message : "unreadable" })); }
  }

  /** What the deliverable reader needs from the host: the project root, the secrets denylist, and which files make a record private (#509a). */
  private deliverablePorts(task: Task, policy: { failClosedOnDiscoveryLimit?: boolean } = {}): DeliverablePorts {
    const taskPrivate = this.isPii(task);
    // The owner's own root: a declared worktree instance writes under its worktree, so its deliverables are hashed there, never in the canonical
    // checkout (which holds a different file or none). With the root unproven there is nothing safe to hash: refuse rather than guess.
    const root = !this.d.executionRoot || !task.owner || task.owner === USER ? this.d.cwd : this.d.executionRoot(task.owner);
    if (root === undefined) throw new DeliverableRefusal(`deliverables: ${task.owner}'s execution root is not verified right now, so its files cannot be hashed`);
    return { cwd: root, deny: this.d.deny ?? [], private: path => taskPrivate || matchesPolicy(root, path, this.d.piiPaths ?? [], true, policy) };
  }

  /** Path privacy exists even when measurement cannot open the output. Use the #509 policies on both names. */
  private experimentOutputPrivate(task: Task, path: string): boolean {
    try {
      const ports = this.deliverablePorts(task, { failClosedOnDiscoveryLimit: true }), root = realPath(ports.cwd), deny = [...ports.deny];
      const typed = relative(root, resolve(root, path)), actual = relative(root, policyRealPath(resolve(root, path)));
      return !insideRoot(typed) || !insideRoot(actual) || ports.private(path)
        || [typed, actual].some(name => isHubWritePath(name) || isDenied(name, deny) || isDenied(foldSegment(name), deny.map(foldSegment)));
    } catch { return true; }
  }

  /**
   * #509a: parse and vet a call's deliverable claims before any effect. A claimed hash is a refusal (the hub hashes the files itself), and so is a
   * path outside the project, on the denylist, inside the hub's own state, not a regular file, missing or too large. Nothing is hashed or stored here.
   */
  private deliverableClaims(input: unknown, task: Task, preEffect = true) {
    try {
      const claims = parseDeliverableClaims(input);
      vetDeliverables(claims, this.deliverablePorts(task));
      return claims;
    } catch (error) { throw new (preEffect ? PreEffectToolRefusal : Error)(error instanceof Error ? error.message : "invalid deliverables"); }
  }

  /** Hash vetted claims now. A refusal during the read (the file changed while it was read) is still before any write. */
  private async hashClaims(claims: ReturnType<Tasks["deliverableClaims"]>, task: Task, preEffect = true): Promise<DeliverableRecord[]> {
    try { return await hashDeliverables(claims, this.deliverablePorts(task)); }
    catch (error) { throw new (preEffect ? PreEffectToolRefusal : Error)(error instanceof DeliverableRefusal || error instanceof Error ? error.message : "deliverables could not be hashed"); }
  }

  /** Tasks whose check is queued or running, and the owner it was started for. */
  private readonly checking = new Map<number, PeerId | null>();
  private checkQueue: Promise<void> = Promise.resolve();
  private pendingChecks = 0;
  /** Checks queued or running, until their result is on the board: a recovery commit waits for them. */
  checksPending = () => this.pendingChecks;

  /** Whether a completion check is still running for this task. */
  isChecking = (id: number) => this.checking.has(id);

  /** Invalidate stale artifact evidence without changing spec acceptance or open findings. */
  private completionDraft(task: Task, refresh?: CompletionRefresh): Task {
    if (!refresh || !task.sdlc) return task;
    const sdlc = { ...task.sdlc };
    if (sdlc.head !== refresh.commit) { delete sdlc.head; delete sdlc.observed; }
    if (sdlc.reviewedHead !== refresh.commit) delete sdlc.reviewedHead;
    if (sdlc.localHead !== refresh.commit) { delete sdlc.localHead; delete sdlc.localResult; }
    delete sdlc.merge;
    return { ...task, sdlc };
  }

  private completionCurrent(id: unknown, by: PeerId, preEffect: boolean, refresh?: CompletionRefresh): Task {
    const task = this.need(id, false, preEffect);
    this.mine(task, by, "owner", preEffect);
    if (refresh && (task.state !== "in_review" || task.history.length !== refresh.revision))
      throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: review changed during re-file; retry on current work`);
    if (preEffect) {
      if (task.state === "in_review" && !refresh || isClosedTaskState(task.state)) throw new PreEffectToolRefusal(`task #${task.id} is already ${task.state}`);
    } else {
      if (task.state === "in_review" && !refresh || isClosedTaskState(task.state)) throw new Error(`task #${task.id} is already ${task.state}`);
    }
    this.ready(task, preEffect);
    if (task.state === "proposed" || task.state === "changes_requested") this.acceptanceCapacity(task);
    if (this.checking.has(task.id)) {
      // The result goes only to the owner the check was started for: anyone who took the task since hears nothing.
      throw new (preEffect ? PreEffectToolRefusal : Error)(this.checking.get(task.id) === task.owner ? `task #${task.id}: its check is still running; its result comes as a task message` : `task #${task.id}: a check from before it changed hands is still running; call hub_task_done again in a few minutes`);
    }
    return this.completionDraft(task, refresh);
  }

  async done(by: PeerId, id: unknown, summary?: string, refs?: TaskRefs, deliverables?: unknown): Promise<Task> {
    const requestCheck = this.requestCheck(by);
    const initial = this.need(id, false, true);
    this.mine(initial, by, "owner", true);
    let refresh: CompletionRefresh | undefined;
    if (initial.state === "in_review") {
      const commit = cleanRefs(refs).commit;
      if (!commit || !/^[a-f0-9]{40}$/.test(commit) || commit === this.reviewHead(initial))
        throw new PreEffectToolRefusal(`task #${initial.id} is already in_review; re-file requires a different full head SHA`);
      refresh = { revision: initial.history.length, commit };
    }
    const valid = () => { requestCheck(); return this.completionCurrent(id, by, true, refresh); };
    // #509a: a bad claim (a claimed hash, an outside or denied path, a missing file) is refused before any effect, with nothing recorded.
    const claims = deliverables === undefined ? undefined : this.deliverableClaims(deliverables, valid());
    // The PII screen reads the summary of a done that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("summary", summary, valid());
    let task = valid();
    // The hub hashes the files itself, once, here: what the owner delivered is what this read, whatever the file becomes afterwards.
    const records = claims ? await this.hashClaims(claims, task, true) : undefined;
    task = valid();
    // #481 S1: done without a separate accept starts build work too: the same live spec check as accept, before any write.
    if (task.state === "proposed" || task.state === "changes_requested") {
      const admission = task;
      await this.specGate(by, task.id);
      await this.planEntryGate(by, admission);
      task = valid();
    }
    // #694: stage the identities the hub can verify; the gates read them, and only the admitted done persists them.
    const link = this.d.sdlc && this.d.sdlc.config().mode !== "off" ? await this.identityLink(task, refs) : undefined;
    const current = () => this.withLink(valid(), link, refs);
    task = current();
    let reviewEvidence: PrEvidence | undefined;
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off") { reviewEvidence = await this.lifecycleGate(task, "review"); task = current(); }
    const reviewAdmission = task.reviewer || this.d.prepareReviewBrief ? await this.reviewRequestAdmission(task, refs, true, by, reviewEvidence, undefined, staged => this.withLink(this.completionDraft(staged, refresh), link, refs), !task.reviewer) : undefined;
    task = current();
    // A member of a silent cohort (issue #107): its done is an intent, and the last of them integrates first.
    const cohort = this.cohorts.of(task.id);
    const silentMember = !!cohort?.silent && this.turnFree() && !!task.owner && !this.isPii(task);
    if (silentMember && by === USER) {
      // The console finishing a member: its done still counts as an intent, so the last member integrates; what the
      // silence held goes to the console.
      this.cohorts.intent(cohort!, task, ownerGen(task));
      const evidence = this.heldEvidence(cohort!, task);
      if (evidence) this.d.notify(`task ${this.publicTitle(task)} done by the console; overlapping work finished meanwhile:\n${evidence}`);
    } else if (silentMember) {
      const gen = ownerGen(task);
      // A retry right after the request: the same request again, nothing acknowledged or counted.
      if (this.cohorts.isRetry(cohort!, task, gen)) return this.d.board.get(task.id)!;
      const ig = cohort!.integration;
      if (ig?.task === task.id && ig.offer) this.d.ackFacts?.(task.owner!, ig.offer); // this call is the proof the request arrived
      const r = this.cohorts.completion(cohort!, task, { gen, tree: this.tree(cohort!), factsCurrent: this.d.factsCurrent?.(task.owner!) ?? true, handed: handedAt(task) });
      if (r.action === "request") return this.d.board.update(task.id, HUB, "integration requested", {}, this.integrationRequest(task, r));
      if (r.action === "unresolved") {
        this.d.notify(`task ${this.publicTitle(task)}: turn-free integration unresolved after ${MAX_REQUESTS} requests (${r.why}); its done is recorded, check the overlapping work by hand`);
        task = this.withLink(this.d.board.update(task.id, HUB, "integration unresolved", {}, r.why), link, refs);
      } else if (r.integrated) task = this.withLink(this.d.board.update(task.id, HUB, "integrated", {}, `cohort #${cohort!.id}, revision ${cohort!.revision}`), link, refs);
    } else if (cohort?.held.size && !this.isPii(task)) {
      // No integration step for this member (silence lifted, a PII task open): the notices the silence held stand in
      // for it (issue #107, AC4).
      const evidence = this.heldEvidence(cohort, task);
      if (evidence && by === USER) this.d.notify(`task ${this.publicTitle(task)} done by the console; overlapping work finished meanwhile:\n${evidence}`);
      else if (evidence) this.doneNotes.set(task.id, `Overlapping work finished while you worked (no turn-free integration step ran):\n${evidence}`);
    }
    if (task.state === "proposed" || task.state === "changes_requested") task = this.withLink(this.d.board.update(task.id, by, "accepted", { state: "in_progress" }, WITH_DONE), link, refs); // done without a separate accept
    const command = this.d.runCheck ? this.d.check?.(task.class, task) : undefined;
    if (!command) return this.complete(task, by, summary, refs, "", withheld, "review", reviewAdmission, link, records, requestCheck, refresh);
    // The tool call returns now; a check can outlast an agent's tool timeout. The result decides what comes next.
    this.checking.set(task.id, task.owner);
    const checkedRefs = cleanRefs(refs);
    this.warmRepository({ ...task, refs: { ...task.refs, ...checkedRefs } });
    const pending = this.d.board.update(task.id, by, "done (checking)", { ...(refresh ? { state: "in_progress" as const } : {}), codeSymbols: this.observedCodeSymbols({ ...task, refs: { ...task.refs, ...checkedRefs } }), refs: checkedRefs, ...(task.sdlc ? { sdlc: task.sdlc } : {}) }, summary, { withheld: withheld || undefined, ...(records ? { deliverables: records } : {}) }, task.history.length, HOST_CODE_SYMBOLS);
    if (refresh) { this.ciWatchers.cancel(pending.id); this.heldReviews.delete(pending.id); }
    this.releaseNotice(`task ${this.publicTitle(pending)} done by ${by}; its check is queued or running: ${command}`);
    const seen = { events: pending.history.length, owner: pending.owner };
    this.pendingChecks++;
    this.checkQueue = this.checkQueue
      .then(() => this.finishChecked(pending.id, by, summary, command, seen, withheld))
      .catch((e: Error) => {
        this.releaseNotice(`task #${pending.id}: its check result could not be recorded: ${e.message}`);
        this.releaseNotice(`task #${pending.id}: its owner retry notice could not be published`, () => {
          const current = this.d.board.get(pending.id);
          if (current?.state === "in_progress" && current.owner === seen.owner) this.tell(current, `Task #${current.id}: its check completion was refused. Call hub_task_done again when it is ready.`, this.isPii(current));
        });
      })
      .finally(() => this.pendingChecks--);
    return pending;
  }

  /**
   * After a restart (issue #107) the cohorts, intents and turn ends are gone, so an integration that was asked for and
   * not confirmed can never be: it is recorded as unresolved, and the owner's next done is recorded as usual.
   */
  recoverIntegrations(): void {
    const marks = new Set(["integration requested", "integrated", "integration unresolved", "done", "done (checking)", "reopened", "accepted", "assigned", "reassigned", "escalated"]);
    for (const t of this.d.board.list()) {
      if (!OPEN.includes(t.state) || [...t.history].reverse().find((h) => marks.has(h.event))?.event !== "integration requested") continue;
      this.d.board.update(t.id, HUB, "integration unresolved", {}, "the hub restarted before the integration was confirmed");
      this.d.notify(`task ${this.publicTitle(t)}: turn-free integration unresolved (the hub restarted); check the overlapping work by hand`);
    }
  }

  /**
   * After a restart in a turn-free project (issue #107) the cohorts are gone, and with them what their silence held. When
   * `peer` first attaches, each of its open tasks that overlaps another owner's work hears that overlaps are settled by
   * message again, with the completed-change notices of the overlapping tasks finished since it was handed over. A
   * duplicate notice is the price of never losing one.
   */
  replayHeld(peer: PeerId): void {
    requireLocalTaskPeer(peer);
    const finished = this.d.board.list().filter((u) => (u.state === "approved" || u.state === "in_review") && u.owner && !this.isPii(u));
    for (const t of this.d.board.list()) {
      if (!OPEN.includes(t.state) || t.owner !== peer || this.isPii(t)) continue;
      const open = this.overlapHits(t).filter((h) => h.task.owner !== USER && h.task.owner !== HUB);
      const mine = this.places(t);
      const done = finished.flatMap((u) => {
        const at = [...u.history].reverse().find((h) => h.event === "done");
        if (u.owner === t.owner || !at || at.at < handedAt(t)) return [];
        const theirs = this.places(u);
        if (mine.repositoryKey !== theirs.repositoryKey) return [];
        const paths = t.profile && u.profile && (t.plan?.sections?.length && u.plan?.sections?.length) ? [] : mine.paths.filter((p) => theirs.paths.some((q) => samePlace(p, q)));
        const symbols = mine.symbols.filter((x) => theirs.symbols.some((y) => symbolsOverlap(x, y)));
        return paths.length || symbols.length ? [this.completedNotice(u, { task: t, paths, symbols }, at.note, at.withheld)] : [];
      });
      if (!open.length && !done.length) continue;
      const owners = [...new Set(open.map((h) => h.task.owner!))];
      const head = owners.length ? `Task #${t.id}: the hub restarted, so overlaps with ${owners.join(", ")} are settled via hub_send again (any turn-free silence is lifted).` : `Task #${t.id}: the hub restarted; overlapping work finished meanwhile.`;
      this.whileOpen(peer, t.id, [head, ...done].join("\n"));
    }
  }

  /** One hash over the files a cohort's tasks name and its members wrote while at work, as they are now: the integration target (issue #107). */
  private tree(cohort: Cohort): string {
    const paths = [...new Set([...cohort.members.keys()].flatMap((id) => { const t = this.d.board.get(id); return t ? this.places(t).paths : []; }))];
    // Each member's writes count from when its owner was handed the task until it settled: settling keeps its files in
    // the target, and its later writes are its next task's.
    const windows = [...cohort.members.values()].map((m) => ({ peer: m.owner, since: m.since, ...(m.settledAt !== undefined ? { until: m.settledAt } : {}) }));
    return this.d.treeHash?.(paths, windows) ?? "";
  }

  /**
   * What the integrating member reads as its done result (issue #107): what the others finished, the facts it has not
   * been shown, and what makes the next done count. Its facts offer is acknowledged by that next done.
   */
  private integrationRequest(task: Task, r: Extract<Completion, { action: "request" }>): string {
    const others = [...r.cohort.members.values()].filter((m) => m.task !== task.id).flatMap((m) => { const t = this.d.board.get(m.task); return t ? [t] : []; });
    const doneAt = (t: Task) => [...t.history].reverse().find((h) => h.event === "done" || h.event === "done (checking)");
    const lines = others.map((t) => {
      const files = this.places(t).paths.filter(this.nameable);
      const signatures = (t.plan?.signatures ?? []).filter(this.nameable);
      const done = doneAt(t);
      const first = done?.withheld ? undefined : (done?.note ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
      return [
        `- ${this.publicTitle(t)} (owner ${t.owner}, ${t.state})`,
        files.length ? `  changed files: ${files.join(", ")}` : "",
        signatures.length ? `  signatures: ${signatures.join("; ")}` : "",
        first && this.nameable(first) ? `  summary: ${first}` : "",
      ].filter(Boolean).join("\n");
    });
    const facts = task.owner ? this.d.integrationFacts?.(task.owner) : undefined;
    if (facts && r.cohort.integration) r.cohort.integration.offer = facts.id;
    const head = r.requests === 1
      ? `Before task #${task.id} is recorded as done: you are the last of turn-free cohort #${r.cohort.id} to finish. Check your work against the others' below, fix what conflicts, then call hub_task_done again.`
      : `Task #${task.id} is not recorded as done yet (integration request ${r.requests} of ${MAX_REQUESTS}): ${r.why}. Check again, then call hub_task_done again.`;
    return [head, "The done counts once the files did not change between two calls and the others have stopped.", ...lines, facts?.text ?? ""].filter(Boolean).join("\n");
  }

  /**
   * #901: which check key produced this result, and how many citation keys the example citation check said were unresolved. The key is the hub's own selection (`Deps.checkKey`, the lookup
   * `Deps.check` makes), never read from output; without that dependency it is not recorded. The count is read only from the example check's own last line (`citations: N declared keys, M missing`, scripts/check-citations.ts);
   * a tail without that exact line, or with a number past the bound, records no count: unknown, never zero.
   */
  private checkProvenance(task: Task, tail: string): Pick<HistoryEntry, "checkKey" | "missingKeys"> {
    let key: string | undefined;
    try { key = this.d.checkKey?.(task.class, task); } catch { key = undefined; }
    const lines = tail.split("\n").map(line => line.trim()).filter(Boolean);
    const match = /^citations: (\d{1,6}) declared keys, (\d{1,6}) missing$/.exec(lines.at(-1) ?? "");
    return { ...(key ? { checkKey: key } : {}), ...(match ? { missingKeys: Number(match[2]) } : {}) };
  }

  private async finishChecked(id: number, by: PeerId, summary: string | undefined, command: string, seen: { events: number; owner: PeerId | null }, withheld: boolean): Promise<void> {
    const result = await this.d.runCheck!(command).catch((e: Error) => ({ code: null, timedOut: false, interrupted: false, tail: e.message }));
    this.checking.delete(id);
    const task = this.d.board.get(id);
    if (!task) return;
    const outcome = `${command} -> ${result.interrupted ? "interrupted by a hub stop" : result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`}`;
    // Not a verdict on the work, and nobody is listening any more: the owner marks the task done again (spec).
    if (result.interrupted) return void this.d.board.update(id, HUB, "check interrupted", {}, outcome);
    const pii = this.isPii(task);
    // Moved on meanwhile (escalated, reassigned, released, and maybe back again): the result is kept, nothing else changes.
    if (task.state !== "in_progress" || task.history.slice(seen.events).some((h) => !QUIET_EVENTS.has(h.event))) {
      this.d.board.update(id, HUB, "check finished late", {}, outcome);
      if (task.state === "in_progress" && task.owner === seen.owner) this.tell(task, `Task #${id}: the check of your earlier hub_task_done finished after the task changed hands (${outcome}). Call hub_task_done again when it is ready.`, pii);
      return;
    }
    if (result.code === 0 && !result.timedOut) {
      // An integrating member's check counts only for the target it confirmed (issue #107).
      const cohort = this.cohorts.of(id);
      if (cohort?.silent && !this.cohorts.holds(id, ownerGen(task), this.tree(cohort))) {
        this.d.board.update(id, HUB, "check finished late", {}, `${outcome}; the integration target changed while it ran`);
        this.tell(task, `Task #${id}: its check passed, but the overlapping work or the files changed while it ran (turn-free integration). Call hub_task_done again.`, pii);
        return;
      }
      this.d.board.update(id, HUB, "check passed", {}, `${outcome}\n${result.tail}`.trim(), this.checkProvenance(task, result.tail));
      // The output goes to the reviewer with the done note, not into shared memory: nobody screened it.
      await this.complete(this.d.board.get(id)!, by, `${summary ?? ""}\nCheck: ${outcome}`.trim(), undefined, result.tail, withheld);
      return;
    }
    this.d.board.update(id, HUB, "check failed", {}, `${outcome}\n${result.tail}`.trim(), this.checkProvenance(task, result.tail));
    this.cohorts.withdraw(id); // open again: its done intent no longer counts (issue #107)
    if (task.owner) this.d.board.recordOutcome(task.owner, task.class, false);
    this.contradict(task);
    this.d.notify(`task ${this.publicTitle(task)}: its check failed (${outcome}); it stays with ${task.owner ?? by}`);
    this.tell(task, `Task #${id}: its check failed.\n$ ${outcome}${result.tail ? `\n${result.tail}` : ""}\nFix it and call hub_task_done again.`, pii);
  }

  /** `gated`: the transition `done()` already gated with no await since, so it is not read back twice (#382). */
  private async complete(task: Task, by: PeerId, summary?: string, refs?: TaskRefs, checkOutput = "", withheld = false, gated?: "review", admission?: ReviewReadiness, link?: IdentityLink, records?: DeliverableRecord[], requestCheck: () => void = () => {}, refresh?: CompletionRefresh): Promise<Task> {
    requestCheck();
    // A check's completion carries the records its `done (checking)` bound: the same bytes the owner delivered, not a later read.
    records ??= latestPendingDeliverables(task);
    let selection = this.poolReview(task, refs);
    let reviewer = selection?.reviewer ?? task.reviewer, reviewEvidence: PrEvidence | undefined;
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off" && gated !== (reviewer ? "review" : "approval")) {
      reviewEvidence = await this.lifecycleGate(task, reviewer ? "review" : "approval");
      requestCheck();
      task = this.withLink(this.completionCurrent(task.id, by, false, refresh), link, refs);
      selection = this.poolReview(task, refs);
      reviewer = selection?.reviewer ?? task.reviewer;
    }
    // A delayed local check needs a new readback; a completion-selected reviewer also needs optional facts in off mode.
    if (!admission && ((reviewer && (this.d.sdlc?.config().mode ?? "off") !== "off") || this.d.prepareReviewBrief)) {
      admission = await this.reviewRequestAdmission(task, refs, false, by, reviewEvidence, undefined, staged => this.withLink(this.completionDraft(staged, refresh), link, refs), !reviewer);
      requestCheck();
      task = this.withLink(this.completionCurrent(task.id, by, false, refresh), link, refs);
    }
    selection = this.poolReview(task, refs);
    reviewer = selection?.reviewer ?? task.reviewer;
    const reviewCost: ReviewCost | undefined = reviewer && task.plan && (task.plan.review || task.plan.ci)
      ? { ...cleanCostPlan(task.plan), ...(admission?.ready && admission.head ? { head: admission.head } : {}) } : undefined;
    const routedSummary = selection?.reviewSelection?.blocked ? `${summary ?? ""}\nReview routing: ${this.assignmentNote("pool unavailable", selection)}`.trim() : summary;
    const completedRefs = cleanRefs(refs);
    this.warmRepository({ ...task, refs: { ...task.refs, ...completedRefs } });
    const noWrites = this.noWritesRecorded({ ...task, refs: { ...task.refs, ...completedRefs } });
    const capacity = this.capacityBefore(task);
    const next = this.d.board.update(task.id, by, "done", { codeSymbols: this.observedCodeSymbols({ ...task, refs: { ...task.refs, ...completedRefs } }), state: reviewer ? "in_review" : "approved", ...(selection ? { reviewer: reviewer ?? USER } : {}), ...(task.sdlc ? { sdlc: { ...task.sdlc, stage: lifecycleStage(this.d.sdlc?.config() ?? sdlcConfig(undefined), reviewer ? "review" : "merge") } } : {}), refs: completedRefs }, checkOutput ? `${routedSummary ?? ""}\n${checkOutput}`.trim() : routedSummary, { ...this.planObservation(task), withheld: withheld || undefined, ...(noWrites ? { noWrites: true as const } : {}), ...this.reviewMetadata(selection, { ...task, refs: { ...task.refs, ...completedRefs } }), ...(reviewCost ? { reviewCost } : {}), ...(records ? { deliverables: records } : {}) }, task.history.length, HOST_CODE_SYMBOLS);
    this.queueReviewWritten(next);
    this.writePlannerNotices(next, capacity, next.state === "approved");
    this.ciWatchers.cancel(next.id); this.heldReviews.delete(next.id); // a newer head or a move ends the old head's watcher (#785 P1b)
    this.cohorts.closed(next.id); // its owner's next native turn end settles it in its cohort (issue #107)
    const memorySymbols = this.completionMemorySymbols(next);
    this.note(next, by, "finding", `Task #${next.id} done by ${by}: ${next.title}\nChanged-symbol memory anchors: ${memorySymbols.state === "known" ? memorySymbols.nodes.length : "unknown (no complete code facts)"}\n${summary ?? ""}`, withheld, memorySymbols);
    this.tellCompleted(next, summary, withheld);
    if (!reviewer) {
      this.settleMemory(next);
      if (next.owner) this.d.board.recordOutcome(next.owner, next.class, true); // approved without a review is a success too
      this.releaseNotice(`task ${this.publicTitle(next)} done by ${by}, no reviewer: approved`);
      await this.releaseDependents(next);
    }
    else if (reviewer === USER) this.releaseNotice(`task ${this.publicTitle(next)} done by ${by}: review it in the ahub console (Tasks, select #${next.id}, press r) or with ahub review ${next.id} approved|changes_requested [note]`);
    else this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${reviewer}`, () => this.sendReview(next, reviewer, "", admission));
    if (reviewer && !(admission?.ready && admission.head === this.reviewHead(next))) this.watchCi(next);
    return next;
  }

  /**
   * "Passes alone, fails together": the owners of open tasks on the same places hear what changed under them, once the
   * work is done (after its check, when one runs), and nobody else does (issue #31). A message of its own, not a
   * ride-along line: an owner in the middle of those files needs it before its next task arrives.
   */
  private tellCompleted(task: Task, summary?: string, withheld = false): void {
    const hits = this.overlapHits(task).filter((h) => h.task.owner !== USER && h.task.owner !== HUB);
    const cohort = this.cohorts.of(task.id);
    const silent = this.silentFor(task.id);
    // #713: one notice per recipient per done, naming all of that recipient's overlapping tasks, and only for work the recipient has accepted. An offered or proposed
    // task has nothing to check yet (its offer, or the accept that follows, already shows the current board), and a repeat done replaces the queued notice (see Bus.enqueue).
    const byOwner = new Map<PeerId, typeof hits>();
    for (const hit of hits) {
      // A member of the same silent cohort (issue #107): the member that finishes last integrates instead
      // (Cohorts.completion). The notice is held, so something replaces it if no integration runs. Others hear it.
      if (silent && cohort?.members.has(hit.task.id)) {
        cohort.held.add(task.id);
        continue;
      }
      // Accepted by its own owner since it last changed hands (`ownerAcceptance`, the rule the rest of this class uses), and still in work or review: an offered or proposed task is not.
      if (!["in_progress", "changes_requested", "in_review"].includes(hit.task.state) || !this.ownerAcceptance(hit.task)) continue;
      byOwner.set(hit.task.owner!, [...(byOwner.get(hit.task.owner!) ?? []), hit]);
    }
    for (const [owner, mine] of byOwner) {
      this.releaseNotice(`task ${this.publicTitle(task)}: could not publish the completed-change notice to ${owner}`, () =>
        this.whileOpenFor(owner, task.id, mine.map((h) => h.task.id), this.completedNotice(task, mine, summary, withheld)));
    }
  }

  /** Share the same screened observation rule between completion notices and read-only console detail. */
  private sameFileDifferentSymbols(task: Task, hit: { task: Task; paths: string[] }): boolean {
    const symbolRepository = task.codeSymbols && !this.isPii(task) ? this.codeSymbolsRepository(task) : undefined;
    const otherRepository = hit.task.codeSymbols && !this.isPii(hit.task) ? this.codeSymbolsRepository(hit.task) : undefined;
    return !!symbolRepository && symbolRepository.key === otherRepository?.key && !this.isPii(task) && !this.isPii(hit.task) && taskCodeSymbolsDisjoint(
      task.codeSymbols, hit.task.codeSymbols, this.reviewHead(task), this.reviewHead(hit.task), symbolRepository.key,
      hit.paths, false, this.publicMetadataText);
  }

  /**
   * The completed-change notice: files, signatures and the summary are the owner's own words (paths given at done
   * included), and any item that matches a PII pattern is left out of what other owners get, the summary also when the
   * PII screen did not clear it (`withheld`, #198).
   */
  private completedNotice(task: Task, hitOrHits: { task: Task; paths: string[]; symbols: string[] } | { task: Task; paths: string[]; symbols: string[] }[], summary?: string, withheld = false): string {
    const hits = Array.isArray(hitOrHits) ? hitOrHits : [hitOrHits];
    const paths = this.places(task).paths.filter(this.nameable);
    const signatures = (task.plan?.signatures ?? []).filter(this.nameable);
    const first = (summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
    const line = first && !withheld && this.nameable(first) ? first : undefined;
    // One line per overlapping task of the recipient, so a single notice names all of them (#713).
    const touches = hits.map((hit) => `#${hit.task.id} on ${this.where(hit)}${this.sameFileDifferentSymbols(task, hit) ? " (same file, different symbols; observed names only, deleted definitions may be missing)" : ""}`);
    const open = hits.length > 1 ? `your open tasks ${touches.join("; ")}` : `your open ${touches[0]}`;

    return [
      `Task #${task.id} (owner ${task.owner}) is done and touches ${open}. Check your work against it before you go on.`,
      paths.length ? `Changed files: ${paths.join(", ")}` : "",
      signatures.length ? `New or changed signatures: ${signatures.join("; ")}` : "",
      line ? `Summary: ${line}` : "",
    ].filter(Boolean).join("\n");
  }

  /** The held notices of a cohort, as one list for a member that gets no integration step (issue #107). */
  private heldEvidence(cohort: Cohort, task: Task): string | undefined {
    const lines = [...cohort.held].filter((id) => id !== task.id).flatMap((id) => {
      const t = this.d.board.get(id);
      if (!t || this.isPii(t)) return [];
      const done = [...t.history].reverse().find((h) => h.event === "done");
      const mine = this.places(task), theirs = this.places(t);
      if (mine.repositoryKey !== theirs.repositoryKey) return [];
      return [this.completedNotice(t, { task, paths: mine.paths.filter((p) => theirs.paths.some((q) => samePlace(p, q))), symbols: [] }, done?.note, done?.withheld)];
    });
    return lines.length ? lines.join("\n") : undefined;
  }

  private planGuardItems(task: Task): NativeItem[] {
    if (this.isPii(task)) return [];
    try {
      const items: NativeItem[] = [];
      for (const item of this.d.planFails?.(task) ?? []) {
        const line = sanitize(item.line.replace(/\s+/g, " ").trim());
        if (item.kind === "fail" && this.nameable(line) && !items.some(existing => existing.id === item.id)) items.push({ ...item, line });
        if (items.length === 8) break;
      }
      return items;
    } catch { return []; } // Optional memory cannot refuse an assignment or review.
  }

  /** Current plan advice for an accepted plan's tool result, which has no new assignment envelope. */
  planGuardText(task: Task): string {
    const items = this.planGuardItems(task);
    return items.length ? ["Live fail notes for this plan (advice, not a block):", ...items.map(item => item.line)].join("\n") : "";
  }

  /** The one place a review request is written: the first reviewer and a replacement get the same text, refs and privacy. */
  /** Review admission is separate from brief construction (#228). All refusals precede the requesting done's writes. */
  private async reviewRequestAdmission(task: Task, refs?: TaskRefs, preEffect = true, actor: PeerId = task.owner ?? USER, previous?: PrEvidence, sameRequest?: () => boolean, stage: (task: Task) => Task = task => task, prepareOnly = false): Promise<ReviewReadiness | undefined> {
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (mode === "off" && !this.d.prepareReviewBrief) return undefined;
    let quietDrift = false;
    const guard = () => {
      if (actor !== USER && actor !== task.owner) {
        const holders = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([peer]) => peer);
        if (holders.length !== 1 || holders[0] !== actor) throw new (preEffect ? PreEffectToolRefusal : Error)("review admission authority changed");
      }
      // #694: the board copy seen through the same staged identity link the caller's task carries.
      const current = stage(this.need(task.id, false, preEffect));
      const changed = current.history.length !== task.history.length;
      const quiet = current.history.length > task.history.length && current.history.slice(task.history.length).every(entry => QUIET_EVENTS.has(entry.event));
      const sameHistory = !changed || (mode === "advise" && quiet) || !!sameRequest?.();
      if ((this.d.sdlc?.config().mode ?? "off") !== mode || !sameHistory || current.owner !== task.owner || mode !== "advise" && current.reviewer !== task.reviewer
        || this.isPii(current) !== this.isPii(task) || JSON.stringify(current.sdlc ?? null) !== JSON.stringify(task.sdlc ?? null)
        || mode === "advise" && (current.state !== task.state || current.refs.commit !== task.refs.commit)
        || actor !== USER && this.d.privateTurn?.(actor) && !this.isPii(current)) throw new (preEffect ? PreEffectToolRefusal : Error)("task or authority changed during review admission");
      quietDrift ||= mode === "advise" && changed && quiet;
      return current;
    };
    guard();
    if (!this.isPii(task) && this.d.prepareReviewBrief) {
      try { await this.d.prepareReviewBrief({ ...task, refs: { ...task.refs, ...cleanRefs(refs) } }); }
      catch { /* Optional code facts must not refuse a review. */ }
      guard();
    }
    if (mode === "off" || prepareOnly) return undefined;
    const expected = cleanRefs(refs).commit ?? task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead;
    const read: SdlcGh = (args, timeout, cwd, cap) => {
      guard();
      if (quietDrift) throw new Error("review readiness unknown: task changed during readback");
      return (this.d.sdlc?.gh ?? sdlcGh)(args, timeout, cwd, cap);
    };
    const evidence: ReviewReadiness = this.isPii(task)
      ? { ready: false, blockers: ["private review readiness unavailable"] }
      : task.sdlc ? reviewReadinessFromEvidence(previous, expected, this.d.sdlc?.config().requiredChecks ?? []) ?? await readReviewReadiness(task.sdlc, expected, read, this.d.sdlc?.config().requiredChecks ?? []) : { ready: false, blockers: ["review PR identity missing"] };
    const current = guard();
    const admitted: ReviewReadiness = quietDrift ? { ready: false, blockers: ["review readiness unknown: task changed during readback"] } : evidence;
    if (!admitted.ready) {
      const message = `task ${this.publicTitle(current)}: premature review: ${admitted.blockers.join("; ")}`;
      if (mode === "enforce") throw new (preEffect ? PreEffectToolRefusal : Error)(message);
      this.releaseNotice(message);
    }
    return admitted;
  }

  /**
   * #824: one `Hub-verified at <head>` line from the review admission, for every reviewer. Ready: the required checks that passed at this exact head (and an identical-tree run when the hub
   * reused one) and that no bot review thread is waiting for a reply (the readiness rule: an unresolved thread a person already answered does not block, so the line says exactly that). Not ready (advise mode sends anyway): its blockers. No admission (sdlc off, or a request sent without one) and a PII task: no block, the
   * admission of a PII task being only a stub. Every word comes from the hub's own readiness read; blockers are fixed hub strings, never PR text.
   */
  private hubVerifiedBlock(task: Task, admission?: ReviewReadiness): string {
    if (!admission || this.isPii(task)) return "";
    const head = admission.head ?? this.reviewHead(task) ?? "unknown head";
    if (admission.ready) {
      const names = admission.checks?.length ? admission.checks.join(", ") : "the required checks";
      return `Hub-verified at ${head}: required checks ${names} passed at this exact head${admission.reusedRun !== undefined ? ` via identical-tree run ${admission.reusedRun}` : ""}; no bot review thread is waiting for a reply.\n`;
    }
    return `Hub-verified at ${head}: not ready: ${admission.blockers.join("; ")}.\n`;
  }

  private sendReview(task: Task, reviewer: PeerId, why = "", admission?: ReviewReadiness): boolean {
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (mode === "enforce" && !admission?.ready) {
      // Background roster/quota role changes are retained, but never invent a remotely admitted review request.
      this.releaseNotice(`task ${this.publicTitle(task)}: premature review held; retry the reviewer assignment after current CI and bot replies are verified`);
      this.holdReview(task, reviewer);
      return false;
    }

    const r = task.refs;
    const last = [...task.history].reverse().find((h) => h.event === "done");
    const where = [r.branch ? `branch ${r.branch}` : "", r.commit ? `commit ${r.commit}` : "", r.paths?.length ? `paths ${r.paths.join(", ")}` : ""].filter(Boolean).join("; ");
    // A checklist that maps the change to its contract (issue #35): reviewers who check against the written plan catch more.
    const plan = planText(task.plan);
    const check = [...task.history].reverse().find((h) => h.event === "check passed");
    const cachedPlanRead = this.planReads.get(task.id);
    const planRead = this.planReport(task, cachedPlanRead?.identity === this.planReadIdentity(task) && cachedPlanRead.evidence.head === this.findingHead(task) ? cachedPlanRead.evidence : undefined);
    const conformanceText = mode !== "off" ? this.screen(task, `Plan conformance: ${JSON.stringify(planRead)}`, "plan conformance", reviewer) + "\n" : "";
    const profile = (task.profile ?? "dev") === (this.d.profile ?? "dev") ? profileData(this.d.profileData ?? task.profile ?? "dev") : profileData(task.profile);
    const target = plan ? `the plan (${plan})` : task.detail ? "the task detail above" : "the task title";
    const noCheckWording = profile.name === "research" || profile.name === "writing"
      ? "No check ran for this class: verify the claims and sources yourself."
      : profile.name === "general"
        ? "No check ran for this class: verify the outcome yourself."
        : "No check ran for this class: run the affected tests yourself.";
    // #824: the hub's own exact-head CI evidence, from the admission this request already carries (no new gh call). Nothing here comes from the builder's summary or a recorded claim.
    const codeScoped = this.d.reviewScope?.(reviewer) === "code";
    const verified = codeScoped ? "" : this.hubVerifiedBlock(task, admission);
    const ciPassed = admission?.ready === true && !this.isPii(task);
    // #852 AC2: a code-scope reviewer's sandbox cannot run tests or read CI, so its Hub-verified and check lines are replaced by one fixed line.
    const checkResult = codeScoped ? CODE_SCOPE_LINE
      : check ? `Check result: ${(check.note ?? "").split("\n")[0]}`
      : ciPassed ? "CI passed at this exact head (see the Hub-verified line above); do not list test execution or CI evidence as unmet: name the specific missing test or behaviour instead."
      : noCheckWording;
    const checklistTemplates = profile.review_checklist ?? [
      "Map the changed signatures and call sites to {target}, and name each one that does not match.",
      "{check}",
      "List what is unmet in hub_review's unmet, one item each.",
    ];
    const checklistLines = checklistTemplates.map(template =>
      template.replaceAll("{target}", target).replaceAll("{check}", checkResult)
    );
    // #507b: the task's recorded acceptance criteria (the #481 S8 checklist, ids and all). A PII task shows none: its checklist is private.
    const recorded = this.isPii(task) ? undefined : checklistOf(task.sdlc);
    const criteriaBlock = recorded?.criteria.length
      ? ["Acceptance criteria (name an id at the start of an unmet item, such as \"AC1: what is missing\"):",
        ...recorded.criteria.map(c => `- ${c.id}${c.required ? "" : " (optional)"}: ${c.result}`)].join("\n") + "\n"
      : "";
    // #509a: what was delivered, by id, hash and size. A private record (a PII task, or a path under pii.paths) shows no path.
    const delivered = publicDeliverables(latestDeliverables(task.history), this.nameable);
    const deliverablesBlock = delivered?.length
      ? ["Deliverables (the hub hashed these files when the task was done; approval binds these hashes):",
        ...delivered.map(d => `- ${d.id}: ${d.path ?? "(path withheld)"} [${d.format}${d.version ? ` ${d.version}` : ""}] sha256 ${d.sha256.slice(0, 16)}, ${d.bytes} bytes`)].join("\n") + "\n"
      : "";
    const rulings = this.plannerRulings(task, reviewer);
    const rulingsBlock = rulings.length ? rulings.map(ruling => [
      `Planner rulings (recorded by the configured planner ${ruling.by}; they amend the plan for this review):`,
      `- ${new Date(ruling.at).toISOString()}: ${ruling.note.replace(/[\r\n]+/g, " ")}`,
    ].join("\n")).join("\n") + "\n" : "";
    const checklist = deliverablesBlock + criteriaBlock + [
      "Checklist:",
      ...this.planGuardItems(task).map(item => `- Check the plan against this live fail before the remaining checks: ${item.line}`),
      ...checklistLines.map(line => `- ${line}`),
      ...(rulings.length ? ["- a departure a listed ruling names is not an unmet item by itself; judge its code."] : []),
    ].join("\n");
    // #223 R2: a reviewer-only instance judges from facts; the builder's narrative stays out, earlier findings go in.
    const reviewOnly = this.d.reviewOnly?.(reviewer) === true;
    const summary = reviewOnly ? "(summary withheld from a review-only reviewer; judge the change itself)" : last?.note ? this.screen(task, last.note, "summary", reviewer, last.withheld) : "(no summary)";
    const specRepo = task.sdlc?.repo ?? task.external?.repo, specIssue = task.sdlc?.issue ?? task.external?.issue;
    const spec = reviewOnly && specRepo && specIssue ? `Spec issue: ${specRepo}#${specIssue}\n` : "";
    const findings = reviewOnly ? task.history.filter(h => h.event === "changes_requested" && h.note).map(h => `- ${h.by}: ${this.screen(task, h.note!, "review note", reviewer, h.withheld)}`) : [];
    const carried = findingsForHead(this.reviewFindingSets(task), this.findingHead(task)).filter(item => item.severity === "important" && item.disposition === "open");
    const visible = this.isPii(task) ? [] : carried.filter(item => this.findingTextAllowed(task, [item]) && !task.history.some(entry => entry.withheld && entry.reviewFindings?.items.some(value => value.id === item.id)));
    const carriedText = carried.length ? `Open Important findings carried until explicitly dispositioned: ${carried.length}\n${visible.map(({ id, pass, severity, path }) => JSON.stringify({ id, pass, severity, ...(path ? { path } : {}) })).join("\n")}${visible.length < carried.length ? "\nSome finding details withheld." : ""}\n` : "";
    const guidance = this.roleGuidance(task, reviewer, true);
    let projection = "";
    try { const text = this.d.projectedReview?.(task); if (text) projection = this.screen(task, sanitize(text), "document projection", reviewer); }
    catch { projection = "(document projection unavailable)"; }
    const brief = this.briefText(task);
    // #572 AC3: advisory only, from git state never from task text, so it is safe for a PII task too.
    const checkout = mainCheckoutWarning(this.d.cwd, this.publicMetadataText);
    const body = `Review task #${task.id} [${profileTaskLabel(task)}] ${task.title}\nDone by ${last?.by ?? task.owner}: ${summary}\n${where ? `Where: ${where}\n` : ""}${last?.noWrites ? "no writes recorded since acceptance\n" : ""}${spec}${why ? `${why}\n` : ""}${!plan && task.detail ? `Task detail:\n${task.detail}\n` : ""}${guidance ? guidance + "\n" : ""}${projection ? projection + "\n" : ""}${brief ? brief + "\n" : ""}${checkout ? `Note: ${checkout}.\n` : ""}${findings.length ? `Earlier findings (set a disposition for each):\n${findings.join("\n")}\n` : ""}${carriedText}${conformanceText}${rulingsBlock}${verified}${checklist}\nGive your verdict with hub_review {id: ${task.id}, verdict: "approved" | "changes_requested", note, unmet, findings: [{id, pass: "bugs" | "security" | "compliance", severity: "important" | "nit", path?, disposition: "open" | "fixed" | "false_positive"}]}. Reuse finding ids when updating their disposition; only the person may accept a finding with a rationale.`;
    return this.d.bus.publish(newEnvelope(HUB, body, { to: [reviewer], kind: "review", priority: "important", refs: { ...r, ...(this.reviewHead(task) ? { commit: this.reviewHead(task)! } : {}), task: String(task.id), reviewRevision: String(this.reviewRequestRevision(task)) }, ...(this.isPii(task) ? { private: true } : {}) })).includes(reviewer);
  }

  /** #785 P1b: remember a review the hub held as premature, so a green CI at this exact head can re-offer it once. Also watches that head. */
  private holdReview(task: Task, reviewer: PeerId): void {
    try {
      const head = this.reviewHead(task);
      if (this.isPii(task) || !head || reviewer === USER) return;
      this.heldReviews.set(task.id, { head, reviewer, revision: this.reviewRequestRevision(task) });
      this.watchCi(task);
    } catch { /* optional bookkeeping never fails a review path */ }
  }

  /** #785 P1b AC3: start the one watcher for this task's exact head. Not for private work, an unlinked PR or a lifecycle that is off; never throws. */
  private watchCi(task: Task): void {
    try {
      const head = this.reviewHead(task), repo = task.sdlc?.repo, pr = task.sdlc?.pr;
      if (!this.d.sdlc || this.d.sdlc.config().mode === "off" || this.isPii(task) || task.state !== "in_review" || !head || !/^[0-9a-f]{40}$/.test(head) || !repo || !pr) return;
      this.ciWatchers.start({ id: task.id, head, repo, pr });
    } catch { /* a watcher that cannot start leaves the review path as it was */ }
  }

  /** The watcher's own check before every read and every notice: the task must still be in review at this exact head and PR. */
  private ciWatchCurrent(watch: CiWatch): boolean {
    const task = this.d.board.get(watch.id);
    return !!task && task.state === "in_review" && !this.isPii(task) && this.reviewHead(task) === watch.head && task.sdlc?.repo === watch.repo && task.sdlc?.pr === watch.pr
      && (this.d.sdlc?.config().mode ?? "off") !== "off";
  }

  /**
   * #785 P1b: the result of the exact head's CI, told once to the owner and the reviewer (one ids-only task envelope each, `status` weight: `fyi` is recorded but never delivered to the peer),
   * then a review held as premature is offered once more after a fresh readiness read. A deadline tells the console only.
   */
  private async ciCompleted(watch: CiWatch, outcome: CiOutcome): Promise<void> {
    const task = this.d.board.get(watch.id);
    if (!task || !this.ciWatchCurrent(watch)) return;
    const label = `#${task.id} head ${watch.head.slice(0, 12)}`;
    if (outcome === "deadline") { this.releaseNotice(`task ${label}: CI did not finish within the watch deadline; no further reads`); return; }
    const line = `ci_completed: ${label} ${outcome}`;
    for (const peer of new Set([task.owner, task.reviewer])) {
      if (!peer || peer === HUB) continue;
      if (peer === USER) { this.releaseNotice(`task ${label}: CI ${outcome} at its exact head`); continue; }
      this.releaseNotice(`task ${label}: could not tell ${peer} the CI result`, () => this.d.bus.publish(newEnvelope(HUB, `${line}\nRead hub_task_show for the task before acting.`, { to: [peer], kind: "task", priority: "status", refs: { task: String(task.id), commit: watch.head } })));
    }
    if (outcome === "failed") return;
    await this.reofferHeldReview(task, watch);
  }

  /** The held review of this exact head and request, once: only while it is still the same reviewer, head and revision, and a fresh admission says it is ready. */
  private async reofferHeldReview(task: Task, watch: CiWatch): Promise<void> {
    const held = this.heldReviews.get(task.id);
    if (!held || held.head !== watch.head || task.reviewer !== held.reviewer || this.reviewRequestRevision(task) !== held.revision) return;
    this.heldReviews.delete(task.id); // once: a later hold needs a new head or a new request
    try {
      const admission = await this.reviewRequestAdmission(task, undefined, false, task.owner ?? USER);
      const current = this.d.board.get(task.id);
      if (!admission?.ready || !current || !this.ciWatchCurrent(watch) || current.reviewer !== held.reviewer || this.reviewRequestRevision(current) !== held.revision) return;
      this.releaseNotice(`task ${this.publicTitle(current)}: could not re-offer the held review to ${held.reviewer}`, () => this.sendReview(current, held.reviewer, "(Held earlier because exact-head CI was not green; it is green now.)", admission));
    } catch { /* still not ready: the hold notice already named why; a reviewer reassignment retries it */ }
  }

  /** Daemon shutdown: no watcher outlives the hub. */
  stopCiWatchers(): void { this.ciWatchers.stopAll(); this.heldReviews.clear(); }

  private reviewRequestRevision(task: Task): number {
    // Role changes fence older requests; bookkeeping appended after the request does not.
    return task.history.findLastIndex(entry => ["done", "reviewer changed", "reviewer unavailable"].includes(entry.event) || OWNERSHIP_EVENTS.has(entry.event)) + 1;
  }

  /** Host-only admission for a queued review after asynchronous native preparation. */
  reviewBindingCurrent(by: PeerId, id: number, binding: { head?: string; flowRevision?: number }): boolean {
    requireLocalTaskPeer(by);
    const task = this.d.board.get(id);
    return !!task && task.state === "in_review" && task.reviewer === by && !this.isPii(task)
      && this.reviewRequestRevision(task) === binding.flowRevision && this.reviewHead(task) === binding.head;
  }

  /** Host-only failure report, bound to the exact review request and its still-current child generation. */
  async retryReviewer(id: number, failedPeer: PeerId, failure: { head?: string; flowRevision?: number; cause: "start_failed" | "quota" | "no_verdict" }, current: () => boolean, onReoffered?: () => void): Promise<Task> {
    requireLocalTaskPeer(failedPeer);
    if (!failure || !["start_failed", "quota", "no_verdict"].includes(failure.cause) || !/^[a-z][a-z0-9-]{0,63}$/.test(failedPeer) || !Number.isSafeInteger(failure.flowRevision) || failure.flowRevision! < 1 || failure.head !== undefined && (typeof failure.head !== "string" || text(failure.head) !== failure.head || Buffer.byteLength(failure.head) > 1200 || /\p{Cc}/u.test(failure.head))) throw new PreEffectToolRefusal("invalid reviewer failure binding");
    const valid = () => {
      const task = this.need(id, false, true);
      if (!current() || task.state !== "in_review" || task.reviewer !== failedPeer || this.reviewRequestRevision(task) !== failure.flowRevision || this.reviewHead(task) !== failure.head || this.isPii(task) || this.manuallyNamedReviewer(task) && failure.cause !== "no_verdict") throw new PreEffectToolRefusal("reviewer failure is no longer current");
      return task;
    };
    const before = valid();
    const admission = await this.reviewRequestAdmission(before, undefined, true, before.owner ?? USER, undefined, () => { valid(); return true; });
    const task = valid();
    const options = this.reviewPoolOptions(task);
    // A person-selected reviewer never falls through to an agent the person did not select.
    const manual = this.manuallyNamedReviewer(task);
    const selection = manual ? undefined : assign(task, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), reviewPool: { ...options, failed: [...options.failed, failedPeer] } });
    if (!selection?.reviewSelection && failure.cause !== "no_verdict") throw new PreEffectToolRefusal("no declared reviewer pool can receive the fallback");
    const reviewer = selection?.reviewSelection ? selection.reviewer ?? USER : USER;
    valid();
    const note = manual ? "named reviewer recorded no verdict; the person must review"
      : selection?.reviewSelection ? this.assignmentNote(`reviewer unavailable: ${failure.cause}`, selection) : "no declared reviewer pool can receive the fallback; the person must review";
    const next = this.d.board.update(task.id, HUB, "reviewer unavailable", { reviewer }, note, { ...this.reviewMetadata(selection, task), ...(reviewer === USER ? { reviewBlocked: true } : {}), reviewerFailure: { peer: failedPeer, cause: failure.cause, ...(failure.head ? { head: failure.head } : {}) } }, task.history.length);
    this.queueReviewWritten(next);
    this.releaseNotice(`task ${this.publicTitle(next)}: former review request withdrawal incomplete`, () => this.withdrawRoleRequest(task, next, "reviewer"));
    let offered = false;
    if (reviewer === USER) {
      const notice = `task ${this.publicTitle(next)}: blocked: the person must review`;
      this.releaseNotice(notice, () => { this.d.notify(notice); offered = true; });
    } else this.releaseNotice(`task ${this.publicTitle(next)}: fallback review request unavailable`, () => { offered = this.sendReview(next, reviewer, "", admission); });
    if (offered && current() && this.reviewBindingCurrent(reviewer, next.id, { head: this.reviewHead(next), flowRevision: this.reviewRequestRevision(next) })) {
      try { onReoffered?.(); } catch { /* Unconfirmed host settlement retains the delivery hold. */ }
    }
    return next;
  }

  private codeSymbolsRepository(task: Task) {
    try {
      const repository = this.repositories.scope(task.refs);
      if (task.sdlc?.repo && this.repositories.scope({ repo: task.sdlc.repo }).key !== repository.key) return undefined;
      return repository;
    } catch { return undefined; }
  }

  /** Read-time code advice uses this project's tree only; declared foreign or inconsistent scope is unknown. */
  memoryCodeEligible(task: Task): boolean {
    if (this.isPii(task)) return false;
    const repository = this.codeSymbolsRepository(task);
    return !!repository && repository.key === this.repositories.project.key && !this.repositories.mismatch(task.refs, task.plan);
  }

  /** Read-only host input for exists verification; private/foreign/stale observations supply nothing. */
  memorySymbolCandidates(task: Task): string[] | undefined {
    if (this.isPii(task) || !this.d.store) return undefined;
    const observed = this.observedCodeSymbols(task);
    return observed?.state === "known" ? observed.symbols.map(symbol => symbol.id) : undefined;
  }

  /** Only current host observations and positive exists checks may anchor the completion note. */
  private completionMemorySymbols(task: Task): MemorySymbolNodes {
    const unknown: MemorySymbolNodes = { state: "unknown", nodes: [], unknown: 0, truncated: false };
    if (this.isPii(task) || !this.d.store) return unknown;
    const repository = this.codeSymbolsRepository(task);
    if (!repository || repository.key !== this.repositories.project.key) return unknown;
    const observed = publicTaskCodeSymbols(task.codeSymbols, this.reviewHead(task), repository.key, this.publicMetadataText);
    if (!observed || observed.state !== "known") return unknown;
    try {
      const verified = this.d.memorySymbolNodes?.(task);
      if (!verified) return unknown;
      const context = { cwd: this.d.cwd, project: this.d.store.project, repo: this.d.store.repo, deny: this.d.store.deny, allowed: this.publicMetadataText };
      const actual = new Set(observed.symbols.map(symbol => canonicalMemorySymbolNode(symbol.id, context)).filter(Boolean));
      const nodes = [...new Set(verified.nodes)].filter(node => actual.has(node) && canonicalMemorySymbolNode(node, context) === node).slice(0, MEMORY_SYMBOL_LIMIT);
      const complete = observed.complete && verified.state === "known" && nodes.length === verified.nodes.length;
      return { state: complete ? "known" : "unknown", nodes, unknown: verified.unknown, truncated: verified.truncated || nodes.length !== verified.nodes.length };
    } catch { return unknown; }
  }

  /** Host observations are saved only with an admitted transition, never by an optional read. */
  private observedCodeSymbols(task: Task) {
    if (this.isPii(task) || !task.refs.commit) return undefined;
    const repository = this.codeSymbolsRepository(task);
    // ponytail: the brief analyzes the validated project execution root. Foreign repositories stay unknown
    // until the brief carries independent repository provenance; a model's refs.repo cannot supply that proof.
    if (!repository || repository.key !== this.repositories.project.key) return undefined;
    try {
      const brief = this.d.reviewBrief?.(task);
      const observation = brief && !("unavailable" in brief) ? buildTaskCodeSymbols(brief, repository.key, this.publicMetadataText) : undefined;
      // A resolved short ref or a stale provider result is unknown advice, never a reason to refuse done.
      return observation?.head === task.refs.commit ? observation : undefined;
    } catch { return undefined; } // Optional metadata never costs the admitted result.
  }

  /** #520: the rendered review brief of a non-PII task's commit, or why there is none; empty without a commit. */
  briefText(task: Task): string {
    if (this.isPii(task) || !task.refs.commit) return "";
    try {
      const brief = this.d.reviewBrief?.(task);
      if (!brief) return "";
      return "unavailable" in brief ? `Review brief unavailable: ${brief.unavailable}.` : sanitize(renderReviewBrief(brief));
    } catch { return "Review brief unavailable: it could not be built."; }
  }

  async review(by: PeerId, id: unknown, verdict: unknown, note?: string, unmet?: unknown, head?: unknown, coverage?: unknown, findings?: unknown): Promise<Task> {
    const requestCheck = this.requestCheck(by);
    const authority = by === USER ? undefined : this.d.reviewAuthority?.(by, Number(id));
    let findingGuard: ((task: Task) => void) | undefined;
    // #520: what the coverage was checked against, pinned through every await: the commit and the lifecycle receipt (the
    // inherited reviewedHead lives there).
    let covered: { commit: string | undefined; receipt: string } | undefined;
    let conformanceIdentity: string | undefined;
    let reviewRound: number | undefined;
    const valid = (): Task => {
      requestCheck();
      const refused = authority?.();
      if (refused) throw new PreEffectToolRefusal(refused); // rechecked after every await, right before each write
      const t = this.need(id, false, true);
      if (reviewRound !== undefined && this.reviewRequestRevision(t) !== reviewRound) throw new PreEffectToolRefusal(`task #${t.id}: review request changed during the verdict; review the new head`);
      if (covered && (t.refs.commit !== covered.commit || JSON.stringify(t.sdlc ?? null) !== covered.receipt)) throw new PreEffectToolRefusal(`task #${t.id}'s commit or lifecycle receipt changed during the verdict: review the new head`);
      this.mine(t, by, "reviewer", true);
      if (verdict !== "approved" && verdict !== "changes_requested") throw new PreEffectToolRefusal('verdict must be "approved" or "changes_requested"');
      if (t.state !== "in_review") throw new PreEffectToolRefusal(`task #${t.id} is ${t.state}: cannot move to ${verdict} before its owner calls hub_task_done`);
      if (conformanceIdentity !== undefined && conformanceIdentity !== this.planIdentity(t)) throw new PreEffectToolRefusal("plan conformance identity changed during verdict");
      findingGuard?.(t);
      return t;
    };
    if ((this.d.sdlc?.config().mode ?? "off") !== "off") conformanceIdentity = this.planIdentity(valid());
    const items = textList(unmet);
    if (items.length) note = `${note ?? ""}\nUnmet: ${items.join("; ")}`.trim();
    // #520: an approval accounts for every reviewable path of the brief. enforce refuses before any effect, advise records
    // the gap in the verdict note, off and a person's own verdict skip it.
    const mode = this.d.sdlc?.config().mode ?? "off";
    const initial = valid(), suppliedFindings = findings !== undefined;
    reviewRound = this.reviewRequestRevision(initial);
    let parsed: ReviewFinding[];
    try { parsed = parseReviewFindings(findings, { person: by === USER, maxNits: this.d.sdlc?.config().maxNits ?? DEFAULT_MAX_NITS }); }
    catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "invalid structured findings"); }
    // #852 AC3 (amended): a code-scope reviewer's changes_requested is always recorded, never refused. Without an open structured finding it is
    // evidence-only: it does not count toward rejections or escalation, the task returns to its owner as usual, and the conductor gets one ids-only
    // notice. The rule is structural (a finding with disposition open), never a reading of the unmet text.
    const codeScope = by !== USER && this.d.reviewScope?.(by) === "code";
    const evidenceOnly = codeScope && verdict === "changes_requested" && !parsed.some(finding => finding.disposition === "open");
    const resolvedHead = this.findingHead(initial);
    let findingHead = resolvedHead;
    if (head !== undefined) {
      try { findingHead = sdlcReceipt({ reviewedHead: head }, initial.sdlc, this.d.sdlc?.config() ?? sdlcConfig(undefined)).reviewedHead; }
      catch (error) { throw new PreEffectToolRefusal(error instanceof Error ? error.message : "invalid finding head"); }
    }
    const report: ReviewFindingSet | undefined = suppliedFindings ? { ...(findingHead ? { head: findingHead } : {}), items: parsed } : undefined;
    const proposedSets = (task: Task) => [...this.reviewFindingSets(task), ...(report ? [report] : [])];
    if (head !== undefined || suppliedFindings || this.reviewFindingSets(initial).length) {
      const identity = (task: Task) => JSON.stringify({ owner: task.owner, reviewer: task.reviewer, commit: task.refs.commit, receipt: task.sdlc, resolvedHead: this.findingHead(task), private: this.isPii(task), findings: this.reviewFindingSets(task) });
      const original = identity(initial);
      findingGuard = task => {
        if (identity(task) !== original) throw new PreEffectToolRefusal("task review identity, privacy or findings changed during the verdict; review current work again");
        if (by !== USER && suppliedFindings && this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("structured review of ordinary work is unavailable during a private turn");
        if (parsed.filter(item => item.severity === "nit").length > (this.d.sdlc?.config().maxNits ?? DEFAULT_MAX_NITS)) throw new PreEffectToolRefusal("review nit cap exceeded");
        if (report?.items.length && !report.head && this.d.sdlc?.config().mode === "enforce") throw new PreEffectToolRefusal("a finding report requires a resolvable full reviewed head in enforce");
        const current = findingsForHead(proposedSets(task), findingHead);
        if (current.length > 64) throw new PreEffectToolRefusal("one reviewed head supports at most 64 distinct finding IDs");
        if (verdict === "approved" && this.d.sdlc?.config().mode === "enforce" && findingTally(current).openImportant) throw new PreEffectToolRefusal("approval blocked: open important review findings on this head");
      };
      findingGuard(initial);
    }
    // A Tasks without a brief provider (library use; the daemon always has one) has no coverage gate.
    if (verdict === "approved" && by !== USER && mode !== "off" && this.d.reviewBrief) {
      const t = valid(), enforce = mode === "enforce", list = (paths: string[]) => `${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ", ..." : ""}`;
      // Code work (a commit, branch or PR) needs a brief; work with none of them is exempt and has nothing to account for.
      const code = !this.isPii(t) && !!(t.refs.commit || t.refs.branch || t.sdlc?.pr);
      // The commit under review: the task's, else the head the verdict names, else the lifecycle receipt's.
      const commit = t.refs.commit ?? (typeof head === "string" ? head : undefined) ?? t.sdlc?.reviewedHead ?? t.sdlc?.localHead;
      const brief: ReviewBrief | { unavailable: string } | undefined = !code ? undefined
        : !commit ? { unavailable: "the task links a branch or PR but names no commit" }
        : this.d.reviewBrief({ ...t, refs: { ...t.refs, commit } }) ?? { unavailable: "the review brief could not be built" };
      if (brief && "unavailable" in brief) {
        // An unknown inventory is never an empty one.
        if (enforce) throw new PreEffectToolRefusal(`coverage: the review brief is unavailable (${brief.unavailable}); an approval needs a complete brief of the task's commit`);
        note = `${note ?? ""}\nCoverage unknown: the review brief is unavailable (${brief.unavailable})`.trim();
      } else if (brief) {
        // One head: the brief's, the task's commit, and the head the verdict names or inherits from an earlier review (with a
        // PR, the lifecycle gate binds that head to the PR's).
        const effective = typeof head === "string" ? head : t.sdlc?.reviewedHead;
        if (effective !== undefined && effective !== brief.head && enforce) throw new PreEffectToolRefusal(`coverage: the verdict ${typeof head === "string" ? "names" : "inherits"} head ${effective}, but the review brief is for ${brief.head} (the commit under review)`);
        covered = { commit: t.refs.commit, receipt: JSON.stringify(t.sdlc ?? null) };
        const gap = coverageGap(brief, coverage);
        if (gap.length && enforce) throw new PreEffectToolRefusal(`coverage: ${gap.length} reviewable path(s) of the review brief are not accounted for: ${list(gap)}. Pass coverage {reviewed, skipped: [{path, reason}]}.`);
        if (gap.length) note = `${note ?? ""}\nCoverage gap (${gap.length}): ${list(gap)}`.trim();
      }
    }
    if (head !== undefined && resolvedHead && findingHead !== resolvedHead) throw new PreEffectToolRefusal("supplied review head differs from the task resolved head");
    // The PII screen reads the note of a review that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("review note", parsed.length ? JSON.stringify({ note, findings: parsed }) : note, valid())
      || parsed.length > 0 && !this.findingTextAllowed(initial, parsed);
    let task = valid();
    let reviewedHead: string | undefined;
    if (head !== undefined) {
      const checked = sdlcReceipt({ reviewedHead: head }, task.sdlc, this.d.sdlc?.config() ?? sdlcConfig(undefined));
      reviewedHead = checked.reviewedHead;
    }
    // #509a: an approval binds the bytes that were delivered. The files are read again now: unchanged, their hashes go on the approval; changed,
    // missing or unreadable, a reviewer's approval is refused before any write, and the person may approve the files as they are, saying so.
    let boundDeliverables: DeliverableRecord[] | undefined;
    if (verdict === "approved") {
      const delivered = latestDeliverables(task.history);
      if (delivered) {
        const identity = JSON.stringify(delivered);
        const checks = await this.checkRecords(delivered, task);
        task = valid();
        if (JSON.stringify(latestDeliverables(task.history)) !== identity) throw new PreEffectToolRefusal("the task's deliverables changed during the verdict; review the current work again");
        const drift = checks.filter(check => check.state !== "unchanged");
        if (!drift.length) boundDeliverables = delivered;
        else {
          const text = drift.map(check => `${check.record.id} (${check.state})`).join(", ");
          if (by !== USER) throw new PreEffectToolRefusal(`deliverable changed since it was delivered: ${text}; ask its owner to call hub_task_done again so the current files are reviewed, or a person may approve them as they are`);
          // The person approves what is on disk now: those bytes are measured and bound, and the verdict says the files had moved.
          boundDeliverables = await this.hashClaims(delivered.map(record => ({ path: record.path!, format: record.format, ...(record.version !== undefined ? { version: record.version } : {}) })), task, true);
          task = valid();
          note = `${note ?? ""}\nApproved with the deliverable files changed since delivery: ${text}`.trim();
        }
      }
    }
    if (verdict === "approved" && this.d.sdlc && this.d.sdlc.config().mode !== "off") {
      this.evalRecords.delete(task.id);
      await this.lifecycleGate(task, "approval", reviewedHead, proposedSets(task)); task = valid();
      const record = this.evalRecords.get(task.id); this.evalRecords.delete(task.id);
      if (record) note = `${note ?? ""}\n${record}`.trim();
    }
    let candidate: Extract<CandidateInput, { kind: "fail" }> | undefined;
    if (verdict === "changes_requested" && !evidenceOnly && items.length && this.d.candidates && !withheld && !this.isPii(task) && !this.d.privateTurn?.(by)) {
      const input: CandidateInput = { project: this.d.store?.project ?? this.d.project, kind: "fail", approach: this.publicTitle(task), symptom: items.join("\n"),
        cause: "unknown: review unmet items do not establish a cause", retryWhen: "unknown: a person must review the unmet items before accepting",
        evidenceRefs: [`task:${task.id}`, `reviewed-head:${reviewedHead ?? task.refs.commit ?? "unknown"}`] };
      const context = JSON.stringify({ title: task.title, detail: task.detail, refs: task.refs, plan: task.plan, signals: task.signals });
      const payload = JSON.stringify({ input, note, context });
      const cleared = this.candidateTextAllowed(payload, task) && !await this.withholds("review note", payload, task);
      task = valid();
      if (cleared && context === JSON.stringify({ title: task.title, detail: task.detail, refs: task.refs, plan: task.plan, signals: task.signals })) candidate = input; // Async screening cannot authorize a verdict under an obsolete role/state.
    }
    const pii = this.isPii(task);
    const reviewContext = by === USER ? undefined : this.d.reviewContext?.(by, task.id);
    const poolRequest = task.history.findLast(entry => ["done", "reviewer changed", "reviewer unavailable"].includes(entry.event));
    const family = by === USER ? undefined : (this.d.adapterCatalog?.familyOf ?? familyOf)(by, this.d.instances?.());
    const reviewerFamily = poolRequest?.reviewerFamily === family ? family : undefined;
    const reviewerReason = reviewerFamily ? poolRequest?.reviewerReason : undefined;
    // #507b: unmet items that start with a recorded criterion id name that criterion. The ids come from the checklist on the board as it is at this
    // write (the `task` just rechecked by valid()), never from the caller; a PII task carries none, its checklist being private.
    const unmetCriteria = pii ? [] : unmetCriteriaIds(items, checklistOf(task.sdlc));
    const flag = { ...this.planObservation(task), withheld: withheld || undefined, ...(report ? { reviewFindings: report } : {}), ...(unmetCriteria.length ? { unmetCriteria } : {}), ...(boundDeliverables ? { deliverables: boundDeliverables } : {}), ...(reviewContext ? { reviewContext } : {}), ...(codeScope ? { reviewScope: "code" as const } : {}), ...(evidenceOnly ? { evidenceOnly: true as const } : {}), ...(reviewerFamily ? { reviewerFamily } : {}), ...(reviewerReason ? { reviewerReason } : {}) };
    if (verdict === "approved") {
      const capacity = this.capacityBefore(task);
      this.ciWatchers.cancel(task.id); this.heldReviews.delete(task.id);
      const next = this.d.board.update(task.id, by, "approved", { state: "approved", rejections: 0, ...(reviewedHead && task.sdlc ? { sdlc: { ...task.sdlc, reviewedHead, stage: lifecycleStage(this.d.sdlc?.config() ?? sdlcConfig(undefined), "merge") } } : {}) }, note, flag);
      this.writePlannerNotices(next, capacity, next.state === "approved");
      if (next.owner) {
        this.d.board.recordOutcome(next.owner, next.class, true);
        this.d.board.recordReview({ implementer: next.owner, reviewer: by, class: next.class, kind: "approved", task: next.id });
        // Changes requested on this owner's work and the redo passed: those reviews caught something.
        for (const r of this.requestedChanges(task)) {
          this.d.board.recordReview({ implementer: next.owner, reviewer: r, class: next.class, kind: "caught", task: next.id });
        }
      }
      this.note(next, by, "decision", `Task #${next.id} approved by ${by}: ${next.title}\n${note ?? ""}`, withheld);
      this.settleMemory(next);
      this.releaseNotice(`task ${this.publicTitle(next)}: could not tell ${next.owner ?? "its owner"} it was approved`, () =>
        this.tell(next, `Task #${next.id} approved by ${by}.${note ? ` ${this.screen(next, note, "review note", next.owner, withheld)}` : ""}`, pii));
      await this.releaseDependents(next);
      this.autoMerge(next, this.mirrorVerdict(next, by, "approved", reviewedHead ?? next.sdlc?.reviewedHead, note, withheld));
      // A proposal storage failure cannot roll back the saved verdict; another matching verdict retries it.
      this.releaseNotice(`task #${next.id}: review saved but recurring-finding proposal unavailable`, () => this.proposeRecurringFindings(next, by, parsed, withheld));
      this.releaseNotice(`task #${next.id}: review saved but recurring-criterion proposal unavailable`, () => this.proposeCriterionCandidates(next, by, withheld));
      return next;
    }
    this.ciWatchers.cancel(task.id); this.heldReviews.delete(task.id);
    const rejected = this.d.board.update(task.id, by, "changes_requested", { state: "changes_requested", rejections: evidenceOnly ? task.rejections : task.rejections + 1 }, note, flag);
    void this.mirrorVerdict(rejected, by, "changes_requested", reviewedHead ?? rejected.sdlc?.reviewedHead, note, withheld);
    if (!evidenceOnly) this.releaseNotice(`task #${rejected.id}: review saved but recurring-finding proposal unavailable`, () => this.proposeRecurringFindings(rejected, by, parsed, withheld));
    if (!evidenceOnly) this.releaseNotice(`task #${rejected.id}: review saved but recurring-criterion proposal unavailable`, () => this.proposeCriterionCandidates(rejected, by, withheld));
    if (candidate && !pii && !this.d.privateTurn?.(by) && this.candidateTextAllowed(JSON.stringify({ candidate, refs: rejected.refs, plan: rejected.plan }), rejected)) {
      try { this.d.memoryCheck?.(); this.d.candidates?.put({ ...candidate, evidenceRefs: [...candidate.evidenceRefs, `review:${rejected.id}:${rejected.history.length}`] }, "public"); } catch { /* a saved review remains authoritative if the optional sidecar fails */ }
    }
    this.cohorts.withdraw(rejected.id); // open again: its done intent no longer counts (issue #107)
    // Evidence-only is not a verdict on the owner's work: no failed outcome, no contradiction of an earlier approval, and no escalation count.
    if (rejected.owner && !evidenceOnly) this.d.board.recordOutcome(rejected.owner, rejected.class, false);
    if (!evidenceOnly) this.contradict(rejected);
    this.note(rejected, by, "decision", `Task #${rejected.id} changes requested by ${by}: ${rejected.title}\n${note ?? ""}`, withheld);
    if (evidenceOnly) this.tellConductorEvidenceOnly(rejected, by);
    if (!evidenceOnly && rejected.rejections >= (this.d.escalateAfter?.() ?? ESCALATE_AFTER)) {
      let moved: Task;
      try {
        moved = await this.escalate(HUB, rejected.id, `${rejected.rejections} consecutive changes_requested`, "rejections");
      } catch (e) {
        // The verdict is saved. If the escalation's move was saved too, only its delivery is unconfirmed, and the
        // error carries the saved task (#297); the console notice was printed where the error was thrown. The
        // reviewer gets the saved task back, never a failed tool call (#276). Anything else (the task closed
        // meanwhile (#254), a failed board write, a superseded move) still throws. assignOwner keeps throwing for
        // the ready offer's retry (#231).
        if (!(e instanceof AssignmentUndeliveredError)) throw e;
        return e.task;
      }
      if (moved.owner !== rejected.owner) return moved;
      // Nobody to escalate to: the owner still has to hear the verdict and the note.
      this.releaseNotice(`task ${this.publicTitle(moved)}: could not tell ${moved.owner ?? "its owner"} changes were requested again`, () =>
        this.tell(moved, `Task #${moved.id}: ${by} requests changes again.${note ? ` ${this.screen(moved, note, "review note", moved.owner, withheld)}` : ""} Nobody else can take it; fix it and call hub_task_done again.`, pii));
      return moved;
    }
    const reopened = this.d.board.update(rejected.id, HUB, "reopened", { state: "in_progress" });
    this.releaseNotice(`task ${this.publicTitle(reopened)}: could not tell ${reopened.owner ?? "its owner"} changes were requested`, () =>
      this.tell(reopened, `Task #${reopened.id}: ${by} requests changes.${note ? ` ${this.screen(reopened, note, "review note", reopened.owner, withheld)}` : ""} Fix it and call hub_task_done again.`, pii));
    return reopened;
  }

  /**
   * #852 AC3: one task-weight notice to the configured conductor for a verdict recorded as evidence-only. Ids only (task and reviewer), so nothing of
   * the review or the task reaches it; a PII task's notice is private. With no conductor the person sees one console notice instead.
   */
  private tellConductorEvidenceOnly(task: Task, reviewer: PeerId): void {
    const conductors = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor).filter(actor => actor !== reviewer);
    const text = evidenceOnlyNotice(task.id, reviewer);
    if (!conductors.length) { this.releaseNotice(text); return; }
    this.releaseNotice(`task #${task.id}: could not tell the conductor a code-scope review was evidence-only`, () => {
      this.d.bus.publish(newEnvelope(HUB, sanitize(text), { to: conductors, kind: "task", refs: { task: String(task.id) }, ...(this.isPii(task) ? { private: true } : {}) }));
    });
  }

  /** Task-level escalation: the next attached peer in the class's escalate_to takes over, with the history. */
  async escalate(by: PeerId, id: unknown, why = "by hand", reason: TaskMoveReason | undefined = by === HUB ? undefined : "manual", preEffect = false): Promise<Task> {
    requireLocalTaskPeer(by);
    let task = this.need(id, true, preEffect);
    const list = this.d.routing().classes[task.class]?.escalate_to ?? [];
    if (task.state === "changes_requested") task = this.d.board.update(task.id, HUB, "reopened", { state: "in_progress" });
    const from = task.owner;
    // The hub's own escalations are not counted: after repeated changes_requested each one already was, and after a
    // Pi inference failure the backend failed, not the work. An escalation by hand counts on its own.
    if (from && by !== HUB) this.d.board.recordOutcome(from, task.class, false);
    // Only a reviewer that asked for changes on this work saw it fail: not an escalation of unreviewed work (a Pi failure).
    if (from && task.reviewer && task.reviewer !== USER && this.requestedChanges(task).has(task.reviewer)) this.d.board.recordReview({ implementer: from, reviewer: task.reviewer, class: task.class, kind: "escalated", task: task.id });
    const stopFormerOwner = (moved: Task) => {
      if (from && moved.owner && moved.owner !== from) this.releaseNotice(`task ${this.publicTitle(moved)}: could not tell ${from} it moved to ${moved.owner}`, () =>
        this.tell({ ...moved, owner: from }, `Task #${moved.id} moved to ${moved.owner} (${why}). Stop working on it.`, this.isPii(moved), "withdrawal"));
    };
    // Only our landed move authorizes a success notice and decision note. The former owner's stop
    // message still names the current owner when a later assignment superseded this move.
    const tail = (moved: Task) => {
      this.releaseNotice(`task ${this.publicTitle(moved)} escalated from ${from} to ${moved.owner} (${why})`);
      this.note(moved, by, "decision", `Task #${moved.id} escalated from ${from} to ${moved.owner}: ${why}`);
      stopFormerOwner(moved);
    };
    let next: Task;
    try {
      next = await this.assignOwner(task, by, { candidates: list, event: "escalated", reason, note: `${why}; from ${from ?? "none"}`, context: why });
    } catch (e) {
      // A saved move whose delivery failed arrives as AssignmentUndeliveredError carrying the saved task (#297);
      // the tail still runs on it (its parts are guarded), and the caller still gets the throw. Anything before
      // the write gets neither.
      if (e instanceof AssignmentUndeliveredError && this.ownOwnerMove(task, e.task, by, "escalated")) tail(e.task);
      throw e;
    }
    if (next.owner && next.owner !== from) {
      // The move is on the board (#243): review() reaches here after its changes_requested write.
      if (this.ownOwnerMove(task, next, by, "escalated")) tail(next);
      else stopFormerOwner(next);
    } else this.releaseNotice(`task ${this.publicTitle(task)}: escalation found nobody in [${list.join(", ")}]; it stays with ${from ?? "nobody"}`);
    return this.d.board.get(next.id)!;
  }

  /** Withdraw only a former role's queued request, then tell it that its authority changed. */
  private withdrawRoleRequest(previous: Task, next: Task, role: Exclude<TaskAssignmentRole, "planner">): void {
    const peer = previous[role];
    if (!peer || peer === next[role]) return;
    const kind = role === "owner" ? "task" : "review";
    this.releaseNotice(`task ${this.publicTitle(next)}: could not notify previous ${role} ${peer} that its request is withdrawn`, () => {
      const matches = (env: Envelope) => (role === "reviewer" || env.body.startsWith(`Task #${previous.id} [`)) && env.from === HUB && env.kind === kind && env.refs?.task === String(previous.id);
      const assignment = previous.history.map(entry => OWNERSHIP_EVENTS.has(entry.event)).lastIndexOf(true);
      // A self-claim also records accepted, after assigned. State can belong to an earlier owner.
      const acceptance = previous.history.slice(assignment + 1).some(entry => entry.event === "accepted" && entry.by === peer);
      const boardEvidence = role === "owner" && acceptance;
      const mayHaveReceived = boardEvidence || this.d.bus.lastDeliveredTo(peer).some(matches) || this.d.bus.queueList(peer).some(row => ["dispatching", "accepted", "needs_review", "completed"].includes(row.state) && row.originals.some(matches));
      for (const env of this.d.bus.pendingEnvelopes(peer)) if (matches(env)) this.d.bus.withdraw(env.id);
      if (!mayHaveReceived) return;
      const body = role === "owner"
        ? `Task ${this.publicTitle(next)} is no longer assigned to you${next.owner ? `; its owner is now ${next.owner}` : "; it is unassigned"}. Do not accept or complete it; late calls under your former assignment are refused.`
        : `Review request for task #${previous.id} ${this.publicTitle(next)} is withdrawn: ${next.reviewer ? `its reviewer is now ${next.reviewer}` : "the task has no reviewer"}. Do not review this task; a late verdict from the previous reviewer is refused.`;
      if (peer === USER) this.d.notify(body);
      // An untagged task notice remains needed by a former role until approval; kind review would look moved already.
      else this.d.bus.publish(newEnvelope(HUB, body, { to: [peer], kind: "task", priority: "important", refs: { task: String(previous.id) }, ...(this.isPii(next) ? { private: true } : {}) }));
    });
  }

  /** Preserve explicit intent across a policy reload; recheck conductor authority after every await. */
  private explicitQueueAssignment(by: PeerId, role: Exclude<TaskAssignmentRole, "planner">, preEffect: boolean): { role: "owner" | "reviewer"; current: () => void } | undefined {
    if (by === USER) return { role, current: () => {} };
    const current = () => {
      const holders = Object.entries(this.d.roles ?? {}).filter(([, roles]) => Array.isArray(roles) && roles.includes("conductor")).map(([peer]) => peer);
      return holders.length === 1 && holders[0] === by && this.d.bus.isRostered(by);
    };
    if (!current()) return undefined;
    return { role, current: () => { if (!current()) throw new (preEffect ? PreEffectToolRefusal : Error)("only the current configured conductor may override assignment admission"); } };
  }

  private configuredManualConductor(by: PeerId): boolean {
    if (by === USER || by === HUB || isRemotePeerId(by)) return false;
    const holders = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([peer]) => peer);
    return holders.length === 1 && holders[0] === by;
  }
  private conductorManualCheck(by: PeerId, preEffect: boolean): () => void {
    return () => {
      if (!this.configuredManualConductor(by) || !this.d.bus.isRostered(by)) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the current configured conductor may unassign a task role");
    };
  }

  /** Caller authority is checked by the daemon; keep the real actor in task history. */
  async assignTo(id: unknown, peer: PeerId, by: PeerId = USER, preEffect = false, role: TaskAssignmentRole = "owner", expectedFlowRevision?: number): Promise<Task> {
    requireLocalTaskPeer(by); requireLocalTaskPeer(peer);
    const conductorManual = this.configuredManualConductor(by), manualCurrent = conductorManual ? this.conductorManualCheck(by, preEffect) : undefined;
    manualCurrent?.();
    if (role !== "owner" && role !== "reviewer" && role !== "planner") throw new (preEffect ? PreEffectToolRefusal : Error)("role must be owner, reviewer or planner");
    if (role === "planner") {
      if (by !== USER) throw new PreEffectToolRefusal("only the person may name a task planner");
      const task = this.need(id, false, preEffect);
      this.checkFlowRevision(task, expectedFlowRevision, preEffect);
      if (isClosedTaskState(task.state) || this.isPii(task)) throw new PreEffectToolRefusal("closed or private work cannot name a planner");
      const choice = assign({ ...task, state: "proposed" }, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [], namedPlanner: peer });
      if (choice.planner !== peer) throw new PreEffectToolRefusal("named planner must be a rostered settled planner holder");
      const next = this.d.board.update(task.id, by, "planner changed", { planner: peer }, "named", { plannerReason: "named" }, expectedFlowRevision);
      if (next.state === "backlog") { this.incomingBacklog.add(next.id); this.addPlannerBacklog(peer, [next.id]); }
      return next;
    }
    if (role === "reviewer" && by !== USER) {
      const conductors = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
      if (conductors.length !== 1 || conductors[0] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the configured conductor may name a reviewer");
    }
    const queueAssignment = this.explicitQueueAssignment(by, role, preEffect);
    queueAssignment?.current();
    const task = this.need(id, role === "owner", preEffect);
    this.checkFlowRevision(task, expectedFlowRevision, preEffect);
    if (!this.d.bus.isRostered(peer)) throw new (preEffect ? PreEffectToolRefusal : Error)(`${peer} is off roster; add it to the roster before assigning work`);
    this.requireCapabilities(task, peer, role, preEffect);
    if (role === "reviewer") {
      if (!OPEN.includes(task.state) && task.state !== "in_review") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its reviewer can no longer change`);
      this.ready(task, preEffect);
      const a = assign(task, this.states(), this.d.routing(), { candidates: [], namedReviewer: peer, ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class, task), ...(queueAssignment ? { queueOverride: queueAssignment.role } : {}) });
      if (a.reviewer !== peer) throw new (preEffect ? PreEffectToolRefusal : Error)(`cannot name ${peer} as reviewer: ${a.trace.filter(line => line.includes("reviewer") || line.includes("pii")).join("; ")}`);
      const admission = task.state === "in_review" ? await this.reviewRequestAdmission(task, undefined, preEffect, by) : undefined;
      // Every runtime authority check precedes the final write, including revocations during the metadata await.
      manualCurrent?.();
      queueAssignment?.current();
      const current = this.need(task.id, false, preEffect);
      if (current.history.length !== task.history.length) throw new (preEffect ? PreEffectToolRefusal : Error)("task changed during reviewer admission");
      if (by !== USER) {
        const holders = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => !isRemotePeerId(peer) && Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
        if (holders.length !== 1 || holders[0] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the configured conductor may name a reviewer");
      }
      if (!this.d.bus.isRostered(peer)) throw new (preEffect ? PreEffectToolRefusal : Error)(`${peer} is off roster`);
      this.requireCapabilities(current, peer, role, preEffect);
      const eligible = assign(current, this.states(), this.d.routing(), { candidates: [], namedReviewer: peer, ...(current.owner ? { notReviewer: current.owner } : {}), ...this.weights(current.class, current), ...(queueAssignment ? { queueOverride: queueAssignment.role } : {}) });
      if (eligible.reviewer !== peer) throw new (preEffect ? PreEffectToolRefusal : Error)("reviewer is no longer eligible");
      queueAssignment?.current();
      const next = this.d.board.update(task.id, by, "reviewer changed", { reviewer: peer }, this.assignmentNote(`named reviewer ${peer}`, a), { reason: "manual" }, expectedFlowRevision);
      if (next.state === "in_review" && task.reviewer && task.reviewer !== peer) {
        this.withdrawRoleRequest(task, next, "reviewer");
      }
      if (next.state === "in_review" && peer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${peer}`, () => this.sendReview(next, peer, "", admission));
      return next;
    }
    // Work that waits is handed to nobody yet (issue #207): the peer becomes its reserved owner instead.
    if (!this.waitsFor(task).length) return this.assignOwner(task, by, { candidates: [peer], namedOwner: peer, event: "reassigned", reason: "manual", override: by === USER, expectedFlowRevision, refuseNamed: preEffect ? "pre" : "plain", ...(conductorManual ? { conductorManual: true as const } : {}), ...(queueAssignment ? { queueOverride: "owner" as const } : {}), current: () => { manualCurrent?.(); queueAssignment?.current(); } });
    manualCurrent?.();
    queueAssignment?.current();
    const next = this.d.board.update(task.id, by, "reserved", { reserved: peer }, `for ${peer}`, { reason: "manual", ...(conductorManual ? { conductorManual: true as const } : {}) }, expectedFlowRevision);
    this.releaseNotice(`task ${this.publicTitle(next)} reserved for ${peer} by ${by}; it is offered to ${peer} first once what it waits for is approved`);
    return next;
  }

  /** Explicit removal without routing a replacement; host history preserves manual intent across role changes. */
  async unassign(id: unknown, by: PeerId = USER, preEffect = false, role: TaskAssignmentRole = "owner", expectedFlowRevision?: number): Promise<Task> {
    const authority = by === USER ? undefined : this.conductorManualCheck(by, preEffect);
    const current = authority && (() => {
      authority();
      if (this.d.privateTurn?.(by)) throw new (preEffect ? PreEffectToolRefusal : Error)("conductor task mutations are unavailable during a private turn");
      if (this.d.cancellationHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) throw new (preEffect ? PreEffectToolRefusal : Error)("recovery or shutdown is holding task writes");
    });
    current?.();
    if (role !== "owner" && role !== "reviewer") throw new (preEffect ? PreEffectToolRefusal : Error)("role must be owner or reviewer");
    const task = this.need(id, false, preEffect);
    this.checkFlowRevision(task, expectedFlowRevision, preEffect);
    if (isClosedTaskState(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its ${role} is historical`);
    if (role === "owner") {
      if (!OPEN.includes(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its owner cannot be unassigned`);
      if (!task.owner && !task.reserved) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: no owner or owner reservation to unassign`);
      current?.();
      const next = this.d.board.update(task.id, by, "unassigned", { owner: null, reserved: null, ...(task.state === "proposed" ? {} : { state: "proposed" as const }) }, `${by === USER ? "person" : "conductor"} unassigned ${[task.owner, task.reserved].filter(Boolean).join(" and ")}`, { reason: "manual", ...(current ? { conductorManual: true as const } : {}) }, expectedFlowRevision);
      this.cohorts.leave(task.id);
      this.withdrawRoleRequest(task, next, "owner");
      return next;
    }
    if (!OPEN.includes(task.state) && task.state !== "in_review") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its reviewer cannot be unassigned`);
    if (!task.reviewer) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: no reviewer to unassign`);
    if (task.reviewer === USER && this.isPii(task)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: the human reviewer is required for PII work`);
    current?.();
    const next = this.d.board.update(task.id, by, "reviewer changed", { reviewer: null }, `${by === USER ? "person" : "conductor"} unassigned reviewer ${task.reviewer}`, { reason: "manual", ...(current ? { conductorManual: true as const } : {}) }, expectedFlowRevision);
    this.withdrawRoleRequest(task, next, "reviewer");
    return next;
  }

  /**
   * Budget relay: a paused peer's open work moves on. `local` first (it has no quota), then the class list, all through
   * the usual constraints. Tasks it was reviewing get another reviewer. Moves are reported, never taken back automatically.
   */
  async reassignForPause(peer: PeerId, context: string | undefined, urgentOnly = false): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    requireLocalTaskPeer(peer);
    return this.reassignWork(peer, context, urgentOnly, false);
  }

  /** Read-only preview using the same assignment constraints as the roster relay. */
  rosterPreview(peer: PeerId): { id: number; title: string; role: "owner" | "reviewer"; to: PeerId | null }[] {
    requireLocalTaskPeer(peer);
    const routing = this.d.routing();
    return this.d.board.list().filter(task => !isClosedTaskState(task.state) && (task.owner === peer || task.reviewer === peer)).map(task => {
      const owner = task.owner === peer;
      const weights = this.weights(task.class, task);
      const pii = this.isPii(task);
      const candidates = owner ? relayCandidates(routing.classes[task.class]?.peers ?? [], pii, { ...this.instanceRouting(), states: this.states() }) : [];
      const a = assign(task, this.states(), routing, { ...weights, offRoster: [...(weights.offRoster ?? []), peer], exclude: [peer], excludeOwners: owner && this.plannerPullRecord(task)?.pull ? this.plannerFull(task) : [], candidates, ...(owner ? { waitsFor: this.waitsFor(task) } : task.owner ? { notReviewer: task.owner } : {}) });
      return { id: task.id, title: this.publicTitle(task), role: owner ? "owner" : "reviewer", to: (owner ? a.owner : a.reviewer) ?? null };
    });
  }

  /** A roster removal offers work through the quota relay's constraints, preserving assignments nobody can take. */
  async reassignForRoster(peer: PeerId, current?: () => void): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    requireLocalTaskPeer(peer);
    return this.reassignWork(peer, undefined, false, true, current);
  }

  private async reassignWork(peer: PeerId, context: string | undefined, urgentOnly: boolean, roster: boolean, current?: () => void): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    current?.();
    const moved: { id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[] = [];
    const routing = this.d.routing(), why = roster ? `roster removal of ${peer}` : `budget pause of ${peer}`;
    // Budget context is screened exactly as before; a roster removal supplies no agent-written context.
    const moves = (t: Task) => (!urgentOnly || t.signals.includes("urgent")) && t.owner === peer && OPEN.includes(t.state);
    const contextWithheld = context && this.d.board.list().some((t) => moves(t) && !this.isPii(t)) ? await this.withholds("handoff", context) : false;
    current?.();
    for (const task of this.d.board.list()) {
      current?.();
      if (urgentOnly && !task.signals.includes("urgent")) continue;
      if (task.owner === peer && (OPEN.includes(task.state) || roster && task.state === "in_review")) {
        const pii = this.isPii(task);
        const candidates = relayCandidates(routing.classes[task.class]?.peers ?? [], pii, { ...this.instanceRouting(), states: this.states() });
        if (this.plannerPullRecord(task)?.pull && !assign(task, this.states(), routing, { candidates, exclude: [...this.excluded(task), peer], excludeOwners: this.plannerFull(task), waitsFor: this.waitsFor(task), ...this.weights(task.class, task) }).owner) continue;
        // Budget keeps its original release/unassign behaviour for ordinary work. Roster changes the state in
        // assignOwner's same owner write only after routing has found somebody to take it.
        const back = !roster && task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, why) : task;
        let next: Task;
        try {
          next = await this.assignOwner(back, HUB, { current, candidates, exclude: [peer], event: "reassigned", reason: roster ? "manual" : "budget", note: why, ...(roster ? { roster: true } : { clearOnFail: true }), ...(context ? { context, contextWithheld } : {}) });
        } catch (e) {
          // The move is saved and its central #297 notice already spoke; relay the
          // remaining tasks and run the roster tail on the saved row as on success.
          if (!(e instanceof AssignmentUndeliveredError)) throw e;
          next = e.task;
        }
        // A saved assignment failure is retained, but never permits a revoked initiating operation to continue.
        current?.();
        if (!this.ownOwnerMove(back, next, HUB, "reassigned") && !this.ownOwnerMove(back, next, HUB, "unassigned")) continue;
        if (roster) {
          if (!next.owner || next.owner === peer) continue;
          this.releaseNotice(`task ${this.publicTitle(next)} moved from ${peer} to ${next.owner} (off roster)`);
          if (next.state === "in_review" && next.reviewer && next.reviewer !== task.reviewer && next.reviewer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${next.reviewer}`, () => this.sendReview(next, next.reviewer!, `(${peer} owned this and is off roster.)`));
        }
        current?.();
        moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner, role: "owner" });
      } else if (task.reviewer === peer && !isClosedTaskState(task.state)) {
        const a = assign(task, this.states(), routing, { exclude: [peer], candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class, task) });
        const reviewer = a.reviewer && a.reviewer !== peer && a.reviewer !== task.owner ? a.reviewer : null;
        if (roster && !reviewer) {
          this.releaseNotice(`task ${this.publicTitle(task)}: its reviewer ${peer} is off roster and nobody else can review; the reviewer stays ${peer}; use ahub review ${task.id}`);
          continue;
        }
        current?.();
        const next = this.d.board.update(task.id, HUB, "reviewer changed", { reviewer }, this.assignmentNote(why, a), this.reviewMetadata(a, task));
        this.queueReviewWritten(next);
        moved.push({ id: task.id, title: this.publicTitle(task), to: reviewer, role: "reviewer" });
        current?.();
        if (next.state === "in_review" && reviewer && reviewer !== USER) {
          if (roster) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${reviewer}`, () => this.sendReview(next, reviewer, `(${peer} was reviewing this and is off roster.)`));
          else this.sendReview(next, reviewer, `(${peer} was reviewing this and is paused for quota.)`);
        } else if (next.state === "in_review" && !reviewer) this.d.notify(`task ${this.publicTitle(next)}: its reviewer ${peer} is paused and nobody else can review; use ahub review ${next.id}`);
      }
    }
    return moved;
  }

  /** What the local worker needs to know about the turn it is about to run. */
  turnPolicy(envs: Envelope[]): { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined {
    const found = envs.map((e) => (e.refs?.task ? this.d.board.get(Number(e.refs.task)) : undefined)).filter((t): t is Task => !!t);
    // One PII item makes the whole turn a PII turn: a digest can carry a PII task next to ordinary messages.
    const pii = envs.some((e) => e.private) || found.some((t) => this.isPii(t));
    if (!found.length) return pii ? { pii } : undefined;
    const policy = this.d.routing().classes[found[0]!.class];
    const about = found.find((t) => this.isPii(t)) ?? found[0]!; // the answer is filed under the PII task when there is one
    return { ...(policy?.route ? { route: policy.route } : {}), ...(policy?.fixed_model ? { fixedModel: policy.fixed_model } : {}), pii, task: String(about.id) };
  }

  /**
   * The whole public-text screen for metadata the hub itself reads from outside the board (a git branch name, #572): a PII
   * pattern, a secret shape and a path the project marks private. `nameable` alone is the pattern screen only.
   */
  publicMetadataText = (text: string): boolean => this.nameable(text) && !looksSecret(text) && !this.aboutPrivatePath("", text, undefined);

  private candidateTextAllowed(text: string, task?: Task): boolean {
    return (!task || !this.isPii(task)) && this.nameable(text) && !looksSecret(text) && !this.aboutPrivatePath("", text, task);
  }

  /** Candidate only: the person remains the sole acceptance authority. */
  async correct(by: PeerId, input: unknown): Promise<string> {
    const requestCheck = this.requestCheck(by);
    const args = correctionInput(input);
    const st = this.d.store;
    if (!st || !this.d.candidates) throw new PreEffectToolRefusal("memory correction unavailable");
    const screen: MemoryScreen = rows => this.d.candidateScreen?.(rows) ?? withoutPii(rows, this.d.routing(), this.d.cwd, this.d.piiPaths ?? []);
    const valid = () => {
      requestCheck();
      this.d.memoryCheck?.();
      if (this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("memory correction unavailable during a private turn");
      if (!this.candidateTextAllowed(JSON.stringify(args))) throw new PreEffectToolRefusal("memory correction withheld by privacy policy");
      return resolveVisibleMemory(st.store, st.project, screen, args.id);
    };
    const target = valid(), revision = candidateTargetRevision(target);
    if (await this.withholds("note", `${args.text}\n${args.reason}`)) throw new PreEffectToolRefusal("memory correction withheld by privacy policy");
    const current = valid();
    if (current.id !== target.id || candidateTargetRevision(current) !== revision) throw new PreEffectToolRefusal("memory correction target changed; read it again");
    const id = this.d.candidates.put({ project: st.project, kind: "correction", target: { id: current.id, revision }, proposedText: args.text, reason: args.reason,
      ...(current.kind === "decision" || current.kind === "contract" || current.kind === "fail" ? { noteKind: current.kind } : {}) }, "public");
    return `candidate:${id}; a person reviews it with amem review; memory was not edited`;
  }

  async remember(by: PeerId, input: { text?: string; title?: string; kind?: string; task?: unknown; horizon?: unknown; scope?: unknown; approach?: unknown; symptom?: unknown; cause?: unknown; evidence?: unknown; retry_when?: unknown }): Promise<string> {
    const requestCheck = this.requestCheck(by);
    const text = composeRememberText(input);
    const task = input.task !== undefined ? this.d.board.get(Number(input.task)) : undefined;
    if (task && this.isPii(task)) throw new Error("notes about a PII task are not saved: shared memory excludes private data");
    // Shared with every other peer as well, so text that matches a PII pattern is refused like a note about a PII task.
    const title = String(input.title ?? "").trim();
    if (this.isPii({ signals: detectSignals({ title, detail: text, refs: {} }, this.d.routing(), this.d.cwd) })) throw new Error("this note matches a PII pattern and is not saved: shared memory excludes private data");
    if (input.horizon !== undefined && input.horizon !== "short" && input.horizon !== "long") throw new Error('horizon is "short" or "long"');
    if (input.scope !== undefined && input.scope !== "project" && input.scope !== "shared") throw new Error('scope is "project" or "shared"');
    if (!this.d.memory && !this.d.store) return "memory is disabled; nothing saved";
    // Long-term notes can leave the machine (#258); local storage does not relax secret exclusion.
    if (looksSecret(`${title}\n${text}`)) throw new Error("this note looks like it holds a secret (a key, token or password) and is not saved");
    if (this.aboutPrivatePath(title, text, task)) throw new Error("this note is about a path the project keeps private (pii.paths) and is not saved");
    if (await this.withholds("note", `${title}\n${text}`, task)) throw new Error("the PII screen did not clear this note, so it is not saved: shared memory excludes private data");
    requestCheck();
    const kind = (NOTE_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) as Kind : "finding";
    const native = this.saveNative(by, kind, text, title, task, input.horizon === "long" || input.horizon === "short" ? input.horizon : undefined, input.scope === "shared" ? "shared" : "project");
    if (task && this.d.memory) this.markMemoryReference(task, by);
    const res = !native && this.d.memory ? await this.d.memory.save({ text, ...(title ? { title } : {}), project: this.d.project, metadata: { peer: by, kind, ...(task ? { task: task.id } : {}) } }) : undefined;
    if (!res && !native) return "memory store unavailable; nothing saved";
    if (!native && res && typeof res === "object" && "status" in res && res.status === "candidate") {
      return "saved as a pending memory candidate; a person must review it before it becomes shared evidence";
    }
    const line = noteLine(by, kind, title ? `${title}: ${text}` : text);
    this.d.notify(line);
    // Display identity only: a queued recall may already contain this saved entry. Stored/captured text stays unchanged.
    this.d.share?.(by, native ? noteLine(by, kind, `mem:${native.id} ${title ? `${title}: ` : ""}${text}`) : line);
    return `saved to shared memory${native ? ` (hub memory ${native.id.slice(0, 8)}, ${native.tier}-term)` : ""}; the other agents get it with their next message`;
  }

  /** The task's key in the hub's store: unique across `ahub reset --all`, which restarts the ids. */
  private memoryKey(task: Task): string { return taskKey(this.d.store!.project, task); }

  /**
   * The long-term task a board task may join (#258). A peer names one of this project's; a person may name any (a link
   * across projects is a person's). Refused before any board write.
   */
  private goalFor(by: PeerId, ref: unknown): GoalView {
    if (!this.d.store) throw new PreEffectToolRefusal("goal: hub memory is off for this project");
    try { this.d.memoryCheck?.(); }
    catch { throw new PreEffectToolRefusal("goal: memory profile unavailable; inspect the selector and generation state before linking a long-term task"); }
    const g = typeof ref === "string" && ref.trim() ? this.d.store.store.goalOf(ref.trim().replace(/^goal:/, "")) : undefined;
    if (!g) throw new PreEffectToolRefusal(`goal: no long-term task ${JSON.stringify(ref).slice(0, 40)} (ahub goal list shows them)`);
    if (by !== USER && g.project !== this.d.store.project) throw new PreEffectToolRefusal("goal: that long-term task belongs to another project; linking across projects is a person's");
    if (g.state === "done" || g.state === "dropped") throw new PreEffectToolRefusal(`goal: that long-term task is ${g.state}`);
    return g;
  }
  /** Fence deletion before external memory writes; one marker survives store absence. */
  private markMemoryReference(task: Task, by: PeerId): void {
    if (!this.d.board.get(task.id)?.history.some(entry => entry.event === "memory reference started")) this.d.board.update(task.id, by, "memory reference started", {});
  }
  /** Record a long-term link, never for PII; failures remain notices. */
  private linkNative(task: Task, goal: GoalView, by: PeerId): string {
    if (this.isPii(task)) { this.releaseNotice(`task #${task.id} is not linked to a long-term task: nothing about a PII task enters hub memory`); return "not linked (PII task)"; }
    try { this.d.memoryCheck?.(); this.markMemoryReference(task, by); this.d.store!.store.goalLink(goal.id, this.memoryKey(task), by); return `part of long-term task ${goal.id.slice(0, 8)}`; }
    catch (e) { this.releaseNotice(`task #${task.id}: the link to long-term task ${goal.id.slice(0, 8)} was not saved (${(e as Error).message})`); return "not linked"; }
  }
  /** A person links a board task of this project to a long-term task (`ahub goal link`). */
  linkGoal(by: PeerId, id: unknown, ref: unknown): string {
    requireLocalTaskPeer(by);
    const task = this.d.board.get(Number(id));
    if (!task) throw new Error(`no task #${String(id).slice(0, 12)}`);
    const goal = this.goalFor(by, ref);
    return `task #${task.id}: ${this.linkNative(task, goal, by)}`;
  }

  /**
   * One note in the hub's own store (#258). Short-term while its task is open; on an approved task, or with horizon
   * long, decisions, contracts and fails are long-term. Fail-open: a store that cannot be written costs one notice.
   * The caller has screened the text for PII; never a PII task's.
   */
  private saveNative(by: PeerId, kind: Kind, text: string, title: string, task: Task | undefined, horizon?: Tier, scope: Scope = "project", symbols?: MemorySymbolNodes): { id: string; tier: Tier } | undefined {
    const st = this.d.store;
    if (!st || (task && this.isPii(task))) return undefined;
    try { // never throws: callers run after a board write
      this.d.memoryCheck?.();
      // Approved, or settled in the store already: the snapshot the caller holds can predate an approval made while it awaited.
      const approved = !!task && (task.state === "approved" || st.store.settled(this.memoryKey(task)));
      const tier: Tier = horizon ?? (approved && PROMOTED_KINDS.includes(kind) ? "long" : "short");
      const about = extractNodes(`${title}\n${text}`, { cwd: this.d.cwd, project: st.project, repo: st.repo, deny: st.deny, paths: [...(task?.refs.paths ?? []), ...(task?.plan?.paths ?? [])], symbols: symbols ? [] : task?.plan?.symbols?.map(normalizeMemorySymbolInput), ...(task ? { task: { id: task.id, created: task.created } } : {}) });
      // Existing notes remain immutable; the completion note connects actual symbols through the shared task node.
      if (symbols && task) {
        const taskNode = `task:${this.memoryKey(task)}`;
        about.splice(0, about.length, ...[...new Set([taskNode, ...symbols.nodes, ...about])].slice(0, 64).sort());
      }
      // A short-term note on a task already approved (before hub memory existed, or late): the task is settled first, so
      // the note gets its own deadline and is never taken for a source waiting for promotion.
      if (task && approved && tier === "short" && !st.store.settled(this.memoryKey(task))) st.store.settle(this.memoryKey(task), by);
      if (task) this.markMemoryReference(task, by);
      const id = st.store.note({ op: "note", project: st.project, scope, tier, kind, peer: by, ...(title ? { title } : {}), text, ...(task ? { task: this.memoryKey(task) } : {}), about, source: by === USER ? "person" : "hub" }, horizon === "short");
      st.onNote?.(id);
      return { id, tier };
    } catch (e) {
      this.releaseNotice(`a ${kind} note was not saved to hub memory (${(e as Error).message})`);
      return undefined;
    }
  }

  /** An approved task's decision, contract and fail notes move to long-term; its short-term entries start to expire (#258). */
  /**
   * At hub start: an approved task whose settle entry a crash or a failed write cut off is settled now, so its
   * decisions, contracts and fails still reach long-term memory and its findings get their deadline.
   */
  reconcileMemory(): number {
    if (!this.d.store) return 0;
    let n = 0;
    for (const t of this.d.board.list("approved")) {
      if (this.isPii(t)) continue;
      try { this.d.memoryCheck?.(); const key = this.memoryKey(t); if (this.d.store.store.hasTask(key) && !this.d.store.store.settled(key, { includeLegacy: true })) { this.settleMemory(t); n++; } }
      catch { /* fail-open: tried again at the next start */ }
    }
    return n;
  }

  private settleMemory(task: Task): void {
    if (!this.d.store || this.isPii(task)) return;
    // The store screens each note as it moves to the synced log (the promotion screen the daemon gives it).
    try { this.d.memoryCheck?.(); this.d.store.store.settle(this.memoryKey(task), task.reviewer ?? task.owner ?? HUB); }
    catch (e) { this.releaseNotice(`task #${task.id}: hub memory could not settle its notes (${(e as Error).message})`); }
  }

  /**
   * Whether a note names, or its task touches, a path the current `pii.paths` makes private: checked before either memory
   * backend sees it, whatever the task's signals said when it was proposed.
   */
  private aboutPrivatePath(title: string, text: string, task: Task | undefined): boolean {
    const st = this.d.store;
    // No denylist here: a path the graph leaves out is still checked against the privacy policy.
    const about = extractNodes(`${title}\n${text}`, { cwd: this.d.cwd, project: st?.project ?? this.d.project, repo: st?.repo ?? this.d.project, deny: [],
      paths: [...(task?.refs.paths ?? []), ...(task?.plan?.paths ?? [])], symbols: task?.plan?.symbols });
    return mentionsPrivatePath(`${title}\n${text}`, about, this.d.piiPaths ?? [], this.d.cwd);
  }

  /** Auto notes: only transitions that carry content, never for PII. */
  private note(task: Task, by: PeerId, kind: Kind, text: string, withheld = false, symbols?: MemorySymbolNodes): void {
    if (this.isPii(task) || (!this.d.memory && !this.d.store)) return;
    // Model-written text must clear the host PII screen (#198/#69); long-term memory may sync (#258). No secrets.
    if (withheld || !this.nameable(text)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (${this.whyWithheld(text)})`);
    if (looksSecret(text)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (it looks like it holds a secret)`);
    const title = `agent-hub task #${task.id}: ${task.title}`.slice(0, 120);
    if (this.aboutPrivatePath(title, text, task)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (it is about a private path)`);
    const native = this.saveNative(by, kind, text, title, task, undefined, "project", symbols);
    if (!native && this.d.memory) {
      try { this.markMemoryReference(task, by); } catch { return this.releaseNotice(`task #${task.id}: memory reference could not be recorded; note was not saved`); }
      void this.d.memory.save({ text, title, project: this.d.project, metadata: { peer: by, task: task.id, kind } });
    }
  }

  private tell(task: Task, body: string, pii: boolean, audience: "owner" | "withdrawal" = "owner"): void {
    if (!task.owner || task.owner === USER) return;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner], kind: "task", priority: "important", refs: { task: String(task.id), ...(audience === "owner" ? { taskRecipient: "owner" as const } : {}) }, ...(pii ? { private: true } : {}) }));
  }
}

export { LOCAL } from "./routing.ts";
