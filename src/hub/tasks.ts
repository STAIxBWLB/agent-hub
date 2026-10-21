import { RELEASE_TRAIN_HISTORY_LIMIT, releaseTrainData, releaseTrainReadiness, releaseMetrics } from "./sdlc-release.ts";
import { cleanCostPlan, costMetrics, type CostPlan, type ReviewCost } from "./cost-governance.ts";
import { specRefs } from "./spec-read.ts";
import type { InstancesConfig } from "./instances.ts";
import { composeRememberText } from "./memory-fail.ts";
import { VERSION } from "../version.ts";
import { NoWriteTurns } from "./no-writes.ts";
import { readGitHubImport, type GitHubSource, type GitHubImportSelection } from "./github-import.ts";
import { BACKLOG_SPLIT_SCREEN_TIMEOUT_MS, actualTaskDates, planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import { readMergeQueue } from "./sdlc-queue.ts";
import { readReleaseReadiness } from "./sdlc-release.ts";
import { loadRoleCatalog, taskRole, taskRoleText, type RoleCatalog } from "./roles.ts";
import { matchesPolicy } from "./path-policy.ts";
import { correctionInput, resolveVisibleMemory } from "./memory-candidates.ts";
import type { MemoryScreen } from "./read-tools.ts";
import { withoutPii, mentionsPrivatePath } from "./memory-policy.ts";
import { profileClass, profileData, profileTaskLabel, projectProfile, type ProfileName, type ProfileSelection, type ProjectProfile } from "./profiles.ts";
import { criteriaView, workflowHash } from "./workflow.ts";
import { isAbsolute, relative } from "node:path";
import type { Briefs, NativeItem } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { candidateTargetRevision, type CandidateInput, type CandidateStore, extractNodes, looksSecret, PROMOTED_KINDS, taskKey, type GoalView, type Kind, type MemoryStore, type Scope, type Tier } from "@staix/agent-mem";
import { CLASSES, OUTCOMES_KEPT_MS, ALL_PLAN_KEYS, TASK_MOVE_REASONS, taskCanPlan, taskHasWorkEvidence, taskHasStarted, planningUndoEntry, isClosedTaskState, type TaskStall, type HistoryEntry, type ReviewerHistory, type Board, type Task, type TaskClass, type TaskMoveReason, type TaskPlan, type TaskRefs } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, NOTE_KINDS, noteLine, sanitize, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import type { PiiVerdict, ScreenItem, ScreenRecord } from "./inference.ts";
import { assign, detectSignals, peerEntry, predictSplit, relayCandidates, type Assignment, type InstanceRoutingOptions, type PeerCapabilities, type Routing, type SplitObservation, type SplitPrediction } from "./routing.ts";
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
import { readPrCostHistory, readReviewReadiness, reviewReadinessFromEvidence, type PrEvidence, type ReviewReadiness, readPlanIssueMetadata, canonicalStage, checklistOf, readSdlcPr, readSpecEdit, sdlcConfig, sdlcReceipt, sdlcStatus, specState, SPEC_STATE_TEXT, stageDefinition, lifecycleStage, type SdlcConfig, type PlanIssueMetadata, sdlcGh, type SdlcGh, type SdlcStatus, type SpecEdit, type SpecState } from "./sdlc.ts";

export type TaskAssignmentRole = "owner" | "reviewer";

export interface ReleaseWindow { at: number; host: boolean; quota: boolean; idle: boolean; reasons: string[]; current?: () => boolean; close?: () => Promise<void>; }

export interface TasksDeps {
  adapterCatalog?: ProjectAdapterCatalog;
  /** Host-bound evidence only; absent/expired observations never admit a release cut. */
  releaseWindow?: () => Promise<ReleaseWindow>;
  /** Effective per-peer planner capacity, taken from the existing settings loader. */
  wipLimit?: (peer: PeerId) => number;
  recordPlanning?: (change: { by: string; task?: number; release?: number; fields: string[]; revision: number }) => void;
  board: Board;
  bus: Bus;
  routing: () => Routing;
  /** Startup-bound project declarations; routing never discovers instances from peer names. */
  instances?: () => InstancesConfig;
  /** Host proof of each live extra runtime's actual isolated execution root; config paths alone are not proof. */
  ownerIsolation?: () => Readonly<Record<string, boolean>>;
  cwd: string;
  project: string;
  profile?: ProfileName;
  profileData?: ProjectProfile;
  piiPaths?: string[];
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
  reviewBrief?: (task: Task) => ReviewBrief | { unavailable: string } | undefined;
  sdlc?: { config: () => SdlcConfig; gh?: SdlcGh };
  briefs?: Briefs;
  /** Screened live fail notes directly intersecting the task plan or refs; read-only advice. */
  planFails?: (task: Task) => NativeItem[];
  candidates?: CandidateStore;
  candidateScreen?: MemoryScreen;
  /** Authenticated live turn context, not a model-supplied flag. */
  privateTurn?: (peer: PeerId) => boolean;
  /** #223 R4: the hub's reading of a verdict's context (`fresh` only for a reviewer session started for this review). */
  reviewContext?: (by: PeerId, task: number) => "fresh" | "continuing" | undefined;
  /** #223 R2: a reviewer-only instance gets review facts, not the builder's done summary. */
  reviewOnly?: (peer: PeerId) => boolean;
  /** #223: captured when a verdict call starts; a non-undefined result refuses the verdict at every later check. */
  reviewAuthority?: (by: PeerId, task: number) => (() => string | undefined) | undefined;
  memory?: MemoryClient;
  /** Captured native profile fence at our memory operation boundaries; no board mutation. */
  memoryCheck?: () => void;
  /** #258: the hub's own store, the project name it files entries under (the git chain) and the repo `#N` issues belong to. */
  store?: { store: MemoryStore; project: string; repo: string; deny?: string[]; onNote?: (id: string) => void };
  /** a line for the human: console tail and hub.log */
  notify: (line: string) => void;
  /** The completion check configured for a class, if any (local config only; issue #7). */
  check?: (cls: TaskClass, task?: Task) => string | undefined;
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
  /** Reviewer choice from recorded review outcomes (issue #35); off unless the project config turns it on. */
  review?: { adaptive: boolean; min_reviews: number; pool?: readonly string[]; rerotate?: boolean };
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
  /** Shutdown or coordinator work holds task sweeps too. */
  sweepHeld?: () => boolean;
  /** Consecutive changes_requested verdicts that move a task to another peer (`tasks.escalate_after`, #488). */
  escalateAfter?: () => number;
}

/** The `tasks.escalate_after` default (#488): the third consecutive changes_requested escalates. */
export const ESCALATE_AFTER = 3;
// Demotion (issue #36): a failure counts half after a day. A peer is demoted for a class once its decayed failures
// reach 1.5 (two within about half a day, three within two days) and outweigh its decayed successes there.
// ponytail: fixed constants; make them config when someone needs to tune them.
const DEMOTION_HALF_LIFE_MS = 24 * 3_600_000;
const DEMOTE_AT = 1.5;
/** An approval counts as contradicted when work on the same places fails within this window (issue #35). */
const CONTRADICTION_WINDOW_MS = 7 * 86_400_000;
const OPEN: Task["state"][] = ["proposed", "in_progress", "changes_requested"];
/** Board events that leave a task where its completion check found it; any other event means it moved on meanwhile. */
const QUIET_EVENTS = new Set(["answer", "reviewer changed", "idle sweep", "memory reference started"]);

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
  let scope: CostPlan;
  try { scope = cleanCostPlan(r); } catch { throw new PreEffectToolRefusal("invalid review or CI cost scope"); }
  return { ...Object.fromEntries((profileData(profile).plan_keys as (keyof TaskPlan)[]).map((k) => [k, k === "paths" ? [...new Set(textList(r[k]).map(normPath))] : textList(r[k])] as const).filter(([, v]) => v.length)), ...scope };
}

/** A plan as one line for other owners; the whole plan is on the board. */
const planText = (plan: TaskPlan = {}) => ALL_PLAN_KEYS.filter((k) => plan[k]?.length).map((k) => `${k.replace("_", " ")}: ${plan[k]!.join("; ")}`).join(" | ");
/** What the PII screen reads of a task (#198): the text the patterns are checked against. */
const screenText = (t: { title: string; detail: string; plan?: TaskPlan; external?: Task["external"] }) => [t.title, t.detail, planText(t.plan), t.external?.repo, t.external?.url].filter(value => value !== undefined).join("\n");
/** Re-screens of one task whose verdict was unknown, per hub run (#198). */
const RESCREEN_MAX = 10;

/**
 * The task flow. Adapters and tools never touch the board: every change comes through here, where assignment,
 * PII handling, envelopes, briefs and memory notes are decided in one place.
 */
export class Tasks {
  private readonly repositories: TaskRepositories;
  private readonly incomingBacklog = new Set<number>();
  private readonly plannerBacklog = new Map<PeerId, Set<number>>();
  private readonly plannerBlockedQueue = new Map<PeerId, string>();
  private readonly knownPlanners = new Set<PeerId>();
  /** Turn-free cohorts (issue #107): who works without messages, and who integrates. */
  readonly cohorts: Cohorts;
  private readonly coordinationModes = new Map<number, boolean>();
  private sweepConfig: TaskSweepConfig;
  private readonly noWriteTurns = new NoWriteTurns();
  private sweeping = false;

  constructor(private readonly d: TasksDeps) {
    this.repositories = new TaskRepositories(d.cwd, d.repository);
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
  private screenOn = (): boolean => {
    const r = this.d.routing();
    return r.signals.pii_screen === "local" && r.constraints.pii === "local_only";
  };

  /** One bounded screen call. A screener that fails is no verdict, handled as PII (fail closed). */
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
          const planners = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => roles.includes("planner") && this.d.bus.isRostered(peer)).map(([peer]) => peer);
          const text = `Task #${task.id}: ready-unassigned, idle escalation ${finding.step}/3.`;
          if (finding.step === 1 || finding.step === 2) {
            if (finding.step === 2 || !planners.length) this.releaseNotice(text);
            for (const peer of planners) this.releaseNotice(`task #${task.id}: sweep notice unavailable`, () => this.sweepNotice(task, peer, `${text} Check the board and assign, re-plan or cancel it.`, "planner"));
          } else {
            const admission = this.plannerPullRecord(task)?.pull ? this.plannerAssignment(task, true) : assign(task, this.states(), this.d.routing(), { exclude: this.excluded(task), ...this.weights(task.class, task) });
            this.releaseNotice(`${text} Owner reassignment suggestion: ${admission.owner ?? "no eligible peer"}.`);
            if (admission.owner && config.auto_reassign && this.sweepAvailable(admission.owner)) {
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
          for (const [peer, roles] of Object.entries(this.d.roles ?? {})) {
            if (peer !== responsible && roles.includes("planner") && this.sweepAvailable(peer)) this.sweepNotice(task, peer, `${message} The assigned ${finding.kind === "review-pending" ? "reviewer" : "owner"} has not recorded fresh task activity; check the board before coordinating.`, "planner");
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
    return this.d.board.list("in_progress").flatMap(task => {
      const accepted = task.owner === peer && ["implement", "bulk_edit"].includes(task.class) ? this.ownerAcceptance(task) : undefined;
      return accepted ? [{ id: task.id, acceptance: accepted.index }] : [];
    });
  }

  recordOwnerTurn(peer: PeerId, bindings: readonly { id: number; acceptance: number }[], changed: boolean | undefined, effect: boolean): void {
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

  /** A task as a cloud peer may see it. */
  publicView(task: Task, fullHistory = false): Record<string, unknown> {
    const { title, detail, history, external, cancelled, ...rest } = task;
    if (this.isPii(task)) return { ...rest, actualDates: actualTaskDates(task), refs: {}, plan: {}, ...(task.sdlc ? { sdlc: { stage: stageDefinition(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc.stage)?.base ?? "unknown" } } : {}), title: "[pii]", detail: "[pii]" };
    const screenHistoryText = (text: string, field: string, withheld = false): string => !withheld && this.nameable(text) ? text : `[history ${field} withheld: ${this.whyWithheld(text)}; ahub task show ${task.id}]`;
    const publicHistory = (fullHistory ? history : history.slice(-5)).map(h => ({
      at: h.at, by: h.by, event: h.event,
      ...(h.note === undefined ? {} : { note: screenHistoryText(h.note, "note", h.withheld) }),
      ...(h.supersededBy === undefined ? {} : { supersededBy: screenHistoryText(h.supersededBy, "supersession", h.withheld) }),
      ...(h.profile === undefined ? {} : { profile: screenHistoryText(h.profile, "profile") }),
      ...(h.owner === undefined ? {} : { owner: h.owner }),
      ...(h.reviewerFamily ? { reviewerFamily: screenHistoryText(h.reviewerFamily, "reviewer family") } : {}),
      ...(h.reviewerReason ? { reviewerReason: h.reviewerReason } : {}),
      ...(h.reviewBlocked ? { reviewBlocked: true } : {}),
      ...(h.reviewerFailure ? { reviewerFailure: { peer: screenHistoryText(h.reviewerFailure.peer, "reviewer"), cause: h.reviewerFailure.cause, ...(h.reviewerFailure.head ? { head: screenHistoryText(h.reviewerFailure.head, "review head") } : {}) } } : {}),
      ...(h.planning ? { planning: { revision: h.planning.revision, fields: h.planning.fields, ...(h.planning.split ? { children: h.planning.split.children.map(child => child.id) } : {}) } } : {}),
      ...(h.reason && TASK_MOVE_REASONS.includes(h.reason) ? { reason: h.reason } : {}),
      ...(h.sweep ? { sweep: { kind: h.sweep.kind, activity: h.sweep.activity, step: h.sweep.step, at: h.sweep.at } } : {}),
    }));
    return { ...rest, ...(cancelled ? { cancelled: { ...cancelled, reason: screenHistoryText(cancelled.reason, "cancellation", cancelled.withheld), ...(cancelled.supersededBy ? { supersededBy: screenHistoryText(cancelled.supersededBy, "supersession", cancelled.withheld) } : {}) } } : {}), ...(external && this.nameable(external.url) ? { external } : {}), actualDates: actualTaskDates(task), ...(((this.d.sdlc?.config().mode ?? "off") !== "off" || this.d.sdlc?.config().workflow === "gsd-lite") ? { lifecycle: sdlcStatus(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc, undefined, this.workflowView(task)) } : {}), title, detail, history: publicHistory };
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
    for (const o of this.d.board.outcomes(cls, now - OUTCOMES_KEPT_MS)) {
      const w = 0.5 ** ((now - o.at) / DEMOTION_HALF_LIFE_MS);
      const s = sums.get(o.peer) ?? { bad: 0, good: 0 };
      if (o.ok) s.good += w;
      else s.bad += w;
      sums.set(o.peer, s);
    }
    return Object.fromEntries([...sums].filter(([, s]) => s.bad >= DEMOTE_AT && s.bad > s.good).map(([p, s]) => [p, s.bad]));
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
    return new Set(task.history.slice(since + 1).filter((h) => h.event === "changes_requested").map((h) => h.by));
  }

  /** Workload is board/queue data only: wip() never calls health() or weights(). */
  private instanceRouting(): InstanceRoutingOptions {
    const instances = this.d.instances?.();
    if (!instances || !Object.keys(instances).length) return { adapterCatalog: this.d.adapterCatalog };
    const peers = [...new Set([...(this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind), ...Object.keys(instances), ...this.d.bus.peers.keys()])];
    return { adapterCatalog: this.d.adapterCatalog, instances, ownerIsolation: this.d.ownerIsolation?.() ?? {}, wip: Object.fromEntries(peers.map(peer => [peer, this.wip(peer)])), load: Object.fromEntries(peers.map(peer => [peer, this.d.bus.queued(peer)])) };
  }

  /** Peer health and roles the daemon feeds routing (issues #89, #90, #92): failing peers are skipped, held queues explained. */
  private health() {
    const failing = this.d.failing?.();
    const held = this.d.held?.();
    const workload = this.instanceRouting();
    const peers = workload.instances ? [...new Set([...(this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind), ...Object.keys(workload.instances), ...this.d.bus.peers.keys()])] : (this.d.adapterCatalog?.definitions ?? ADAPTERS).map(adapter => adapter.kind);
    return { ...workload, reviewPool: { pool: this.d.review?.pool ?? DEFAULT_REVIEW_POOL, rerotate: this.d.review?.rerotate, required: this.d.review?.pool !== undefined }, ...(this.d.capabilities ? { capabilities: this.d.capabilities(), repository: this.d.repository } : {}), pullOnly: [...this.d.bus.peers.values()].filter(peer => (this.d.adapterCatalog?.definitionOf ?? definitionOf)(peer.id, workload.instances)?.attach?.pullOnlyForms?.length && peer.pullOnly).map(peer => peer.id), offRoster: peers.filter(peer => !this.d.bus.isRostered(peer)), ...(failing ? { failing } : {}), ...(held ? { held } : {}), ...(this.d.roles ? { roles: this.d.roles } : {}) };
  }

  private reviewHead(task: Task): string | undefined { return task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead; }

  private reviewPoolOptions(task: Task) {
    const head = this.reviewHead(task);
    const round = task.state === "in_review" ? task.history.slice(task.history.findLastIndex(entry => entry.event === "done") + 1) : [];
    const failed = [...new Set(round.flatMap(entry => entry.reviewerFailure?.head === head && entry.reviewerFailure ? [entry.reviewerFailure.peer] : []))];
    return { pool: this.d.review?.pool ?? DEFAULT_REVIEW_POOL, rerotate: this.d.review?.rerotate, failed, required: this.d.review?.pool !== undefined };
  }

  private manuallyNamedReviewer(task: Task): boolean {
    const event = task.history.findLast(entry => ["reviewer changed", "assigned", "reassigned", "escalated"].includes(entry.event));
    return event?.event === "reviewer changed" && event.reason === "manual";
  }

  private poolReview(task: Task, refs?: TaskRefs): Assignment | undefined {
    if (this.manuallyNamedReviewer(task) || this.isPii(task) || task.class === "review") return undefined;
    const draft = { ...task, refs: { ...task.refs, ...cleanRefs(refs) } };
    const selection = assign(draft, this.states(), this.d.routing(), { ...this.weights(task.class, draft), candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}) });
    return selection.reviewSelection ? selection : undefined;
  }

  private reviewMetadata(assignment?: Assignment): ReviewerHistory {
    const choice = assignment?.reviewSelection;
    const family = choice && assignment?.plannerFallback && assignment.reviewer ? (this.d.adapterCatalog?.familyOf ?? familyOf)(assignment.reviewer, this.d.instances?.()) : choice?.family;
    const reason = choice && assignment?.plannerFallback
      ? assignment.sameFamilyFallback ? "same-family fallback" as const : "unavailable skip" as const
      : choice?.reason;
    return { ...(family ? { reviewerFamily: family } : {}), ...(reason ? { reviewerReason: reason } : {}), ...(assignment?.reviewBlocked ? { reviewBlocked: true } : {}) };
  }

  /** Capability admission precedes explicit assignments/reservations, independent of readiness or transient peer health. */
  private requireCapabilities(task: Parameters<typeof assign>[0], peer: PeerId, role: TaskAssignmentRole = "owner", preEffect = true): void {
    const instances = this.d.instances?.(), adapter = (this.d.adapterCatalog?.definitionOf ?? definitionOf)(peer, instances);
    const declaredExtra = !!adapter && adapter.kind !== peer;
    if ((!this.d.capabilities || this.isPii(task)) && !declaredExtra) return;
    const { state: _state, ...draft } = task; // backlog/readiness must not bypass an explicit reservation's admission
    const admission = assign(draft, this.states(), this.d.routing(), { candidates: role === "owner" ? [peer] : [], ...(role === "owner" ? { namedOwner: peer } : { namedReviewer: peer }), ...this.weights(task.class) });
    const missing = (admission.refusals ?? []).filter(row => row.peer === peer && row.role === role && (row.code === "tests" || row.code === "spec" || declaredExtra && role === "owner" && row.code === "owner-admission")).map(row => `  ${role} candidate ${peer}: skipped, ${row.reason}`);
    if (missing.length) throw new (preEffect ? PreEffectToolRefusal : Error)(`cannot assign ${peer}: ${missing.join("; ")}`);
  }

  /** What assignment weighs besides states and policy: quota, demotion and the review record. */
  private weights(cls: TaskClass, task?: Task) {
    const now = Date.now();
    const quota = this.d.quota?.();
    return { ...this.health(), ...(task ? { reviewPool: this.reviewPoolOptions(task) } : {}), now, demoted: this.demoted(cls, now), reviews: this.reviewRecord(cls), ...(quota ? { quota } : {}), ...(this.d.review?.adaptive ? { adaptive: { min: this.d.review.min_reviews } } : {}) };
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
        if (span.some((h) => failed.includes(h.event))) return [{ outcome: "failed" }];
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
    const mine = this.places(failed);
    for (const t of this.d.board.list("approved")) {
      if (t.id === failed.id || !t.owner || this.isPii(t)) continue;
      const approval = [...t.history].reverse().find((h) => h.event === "approved");
      if (!approval || now - approval.at > CONTRADICTION_WINDOW_MS || approval.by === USER) continue;
      const theirs = this.places(t);
      // Blame needs the same file or symbol: a directory or `.` would contradict every approval under it. Older rows
      // were stored as written, so both sides are compared in one spelling.
      if (mine.repositoryKey !== theirs.repositoryKey) continue;
      const file = (p: string) => normPath(p) !== "." && theirs.paths.some((q) => normPath(q) === normPath(p));
      const same = mine.paths.some(file) || mine.symbols.some((x) => theirs.symbols.includes(x));
      if (!same || this.d.board.reviews({ task: t.id }).some((r) => r.kind === "contradicted")) continue;
      this.d.board.recordReview({ implementer: t.owner, reviewer: approval.by, class: t.class, kind: "contradicted", task: t.id });
    }
  }

  private planningRecorded(change: { by: string; task?: number; release?: number; fields: string[]; revision: number }): void {
    try { this.d.recordPlanning?.(change); } catch { /* telemetry never changes a durable result */ }
  }

  private planningAuthority(by: PeerId): void {
    if (by !== USER && !this.d.roles?.[by]?.includes("planner")) throw new PreEffectToolRefusal("planning requires a person or configured planner role");
  }

  private plannerWriteAuthority(by: PeerId): void {
    if (by !== USER && this.d.privateTurn?.(by)) throw new PreEffectToolRefusal("planner writes are unavailable during a private turn");
    this.planningAuthority(by);
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
    if (excluded.length) parts.push(`${excluded.join(", ")} declined or was escalated away from this task for good; only a person's ahub task assign lifts that`);
    for (const peer of Object.keys(this.states())) {
      if (excluded.includes(peer)) continue;
      const queue = this.d.bus.queueSummary(peer), wip = this.wip(peer, task.id), limit = this.wipLimit(peer);
      if (wip >= limit) parts.push(`${peer} WIP full (${wip}/${limit}); no eligible planner WIP capacity`);
      else if (queue.heldBy) parts.push(`${peer} has a held queue (a delivery is held; resolve it with ahub queue list)`);
      else if (queue.needsReview > 0) parts.push(`${peer} has ${queue.needsReview} delivery(ies) in needs_review`);
    }
    return parts.length ? `no peer can take the planner pull: ${parts.join("; ")}` : "no peer has eligible planner WIP capacity";
  }
  private plannerAssignment(task: Task, reservedOnly = false): Assignment {
    const states = this.states();
    const full = this.plannerFull(task);
    // Preview the To Do transition without routing or offering the persisted backlog row.
    return assign({ ...task, state: "proposed" }, states, this.d.routing(), { exclude: this.excluded(task), excludeOwners: full, ...(reservedOnly && task.reserved && !this.excluded(task).includes(task.reserved) ? { candidates: [task.reserved], namedOwner: task.reserved } : {}), waitsFor: this.waitsFor(task), ...this.weights(task.class, task) });
  }

  async pullPlanned(by: PeerId, input: { id: number; revision: number; reason: string }): Promise<Task> {
    // #455: one authority check, made before the screen and again after it (a person may move the planner meanwhile).
    const authorized = () => this.planningAuthority(by);
    authorized();
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("planner pull needs an id, revision and bounded reason");
    const validate = () => {
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision || task.state !== "backlog" || task.owner || !taskCanPlan(task) || task.pinned) throw new PreEffectToolRefusal("planner pull changed, pinned or already started");
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
      const assignment = this.plannerAssignment(task);
      if (!assignment.owner) throw new PreEffectToolRefusal(this.plannerRefusal(task));
      if (this.hasPersonReservation(task) && assignment.owner !== task.reserved) throw new PreEffectToolRefusal("a person's reservation is retained");
      return { task, owner: assignment.owner };
    };
    const initial = validate(), withheld = await this.withholds("note", input.reason, initial.task);
    authorized();
    const current = validate();
    const pulled = this.d.board.pullPlanned(current.task.id, by, current.owner, input.revision, input.reason.trim(), withheld);
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
    for (const id of ids) if (this.d.board.get(id)?.state === "backlog") pending.add(id);
    if (pending.size) this.plannerBacklog.set(peer, pending);
  }
  private readonly groomingNotified = new Map<string, number>();
  /** One bounded ids-only batch per attached planner; failed or evicted copies stay pending. */
  flushPlannerNotices(): number {
    const configured = Object.entries(this.d.roles ?? {}).filter(([, roles]) => roles.includes("planner")).map(([peer]) => peer);
    for (const peer of this.knownPlanners) if (!configured.includes(peer)) {
      this.knownPlanners.delete(peer); this.plannerBacklog.delete(peer); this.plannerBlockedQueue.delete(peer);
    }
    for (const peer of configured) if (!this.knownPlanners.has(peer)) {
      this.knownPlanners.add(peer);
      const retained = this.d.bus.queuedBacklogIds(peer);
      this.addPlannerBacklog(peer, this.d.board.list("backlog").filter(task => !retained.has(task.id)).map(task => task.id));
    }
    const planners = configured.filter(peer => this.d.bus.isRostered(peer) && this.d.bus.peers.has(peer) && this.d.bus.stateOf(peer) !== "offline");
    if (!planners.length) return 0;
    if ((this.d.sdlc?.config().mode ?? "off") !== "off") {
      const revision = this.d.board.statusRevision();
      const body = "The board changed. Before offering or accepting build work, read hub_planner_groom, consolidate dependencies and priorities, and record hub_plan_review against the current planning revision.";
      for (const peer of planners) if (this.groomingNotified.get(peer) !== revision) {
        const queued = this.d.bus.pendingEnvelopes(peer).some(env => env.from === HUB && env.kind === "task" && env.body === body);
        if (queued) continue;
        this.releaseNotice(`could not notify planner ${peer} about grooming`, () => {
          const recipients = this.d.bus.publish(newEnvelope(HUB, body, { to: [peer], kind: "task" }));
          if (recipients.includes(peer)) this.groomingNotified.set(peer, revision);
        });
      }
    }
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
      const blockedQueue = this.plannerBlockedQueue.get(peer);
      if (blockedQueue !== undefined && blockedQueue === JSON.stringify(this.d.bus.queueIds(peer))) continue;
      this.plannerBlockedQueue.delete(peer);
      for (const id of pending) if (this.d.board.get(id)?.state !== "backlog") pending.delete(id);
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

  async planBacklog(by: PeerId, input: { id: number; revision: number; fields: unknown; reason: string }): Promise<Task> {
    this.planningAuthority(by);
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new PreEffectToolRefusal("invalid planning identity or revision");
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("planning needs a bounded reason");
    let patch: PlanningFields;
    try { patch = planningPatch(input.fields); } catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const validate = () => {
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision) throw new PreEffectToolRefusal("planning revision changed");
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
        if (["shipped", "dropped"].includes(release.state)) throw new PreEffectToolRefusal("settled release scope is final");
        if (by !== USER && release.state === "frozen") throw new PreEffectToolRefusal("frozen release changes require a person");
      }
      return task;
    };
    const task = validate(), withheld = await this.withholds("note", input.reason, task);
    this.planningAuthority(by); // #455: or moved the planner
    validate(); // a person may have changed planning or frozen a release while the screen ran
    const updated = this.d.board.plan(task.id, by, patch, input.revision, input.reason.trim(), withheld);
    this.planningRecorded({ by, task: task.id, fields: Object.keys(patch), revision: updated.planningRevision! });
    return updated; // persistence/readback failures must never claim no effect
  }

  async undoPlanning(by: PeerId, id: number, revision: number): Promise<Task> {
    this.planningAuthority(by);
    const task = this.d.board.get(id), entry = task ? planningUndoEntry(task) : undefined;
    if (!task || !entry?.planning || entry.planning.revision !== revision || (task.planningRevision ?? 0) !== revision || by !== USER && entry.by !== by) throw new PreEffectToolRefusal("planning undo is stale or not owned");
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
      const returned = this.d.board.undoPlannedPull(id, by, revision);
      this.offered.delete(id); this.incomingBacklog.add(id);
      this.planningRecorded({ by, task: id, fields: ["pull", "reserved"], revision: returned.planningRevision! });
      return returned;
    }
    return this.planBacklog(by, { id, revision, fields: entry.planning.previous, reason: `undo planning revision ${revision}` });
  }

  async importGitHub(by: PeerId, input: GitHubImportSelection, run?: SdlcGh): Promise<{ imported: number[]; existing: number[]; partial: boolean; complete: boolean; unconfirmed?: true }> {
    if (by !== USER) throw new PreEffectToolRefusal("GitHub import is a person console command");
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
        const task = await this.propose(USER, { title: issue.title, detail: issue.detail, class: cls, backlog: true }, issue.source, () => { created = true; });
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

  async splitBacklog(by: PeerId, input: { id: number; revision: number; parts: unknown; reason: string }): Promise<{ parent: Task; children: Task[] }> {
    this.planningAuthority(by);
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
    this.planningAuthority(by); // #455: a person may have moved the planner while the screen ran
    const [screenedVerdicts, withheld] = screened, current = validate();
    const finalSignals = current.drafts.map(part => this.signalsFor({ ...part, detail: [part.detail, planText(part.plan)].join("\n") }));
    const deterministicPrivate = finalSignals.map((signals, index) => initialPrivate[index] || this.isPii({ signals }));
    const verdicts = screenedVerdicts.map((verdict, index) => deterministicPrivate[index] ? undefined : verdict);
    const inherited = current.drafts.map((_part, index) => (initialParentPrivate || this.isPii(current.parent)) && !deterministicPrivate[index]);
    const drafts = current.drafts.map((part, index) => ({ ...part, ...(screening ? { screeningNote: inherited[index] ? "pii: inherited" : this.screenNote(verdicts[index]) } : {}), signals: [...new Set([...initialPrivacy[index]!, ...initialParentPrivacy, ...finalSignals[index]!, ...current.parent.signals.filter(signal => ["pii", "pii_path", "urgent"].includes(signal)), ...(verdicts[index] && verdicts[index]!.label !== "clear" ? ["pii"] : [])])] }));
    for (const draft of drafts) this.warmRepository(draft);
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

  /** Release assignment changes no execution role, dependency, reservation or state. */
  async assignRelease(by: PeerId, input: { id: number; revision: number; release: number | null; reason: string }): Promise<Task> {
    this.plannerWriteAuthority(by);
    if (typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason) > 1000) throw new PreEffectToolRefusal("release assignment needs a bounded reason");
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.release !== null && (!Number.isSafeInteger(input.release) || input.release <= 0)) throw new PreEffectToolRefusal("invalid release assignment");
    const validate = () => {
      this.plannerWriteAuthority(by);
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision) throw new PreEffectToolRefusal("release assignment changed");
      if (by !== USER && (this.isPii(task) || task.pinned)) throw new PreEffectToolRefusal("private or pinned release scope requires the person");
      for (const id of new Set([task.release, input.release])) if (id != null) {
        const release = this.d.board.release(id);
        if (!release || ["frozen", "shipped", "dropped"].includes(release.state)) throw new PreEffectToolRefusal("release scope is frozen or final");
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
    const release = this.d.board.newRelease(input.name, input.goal.trim(), input.order);
    this.planningRecorded({ by, release: release.id, fields: ["created"], revision: release.revision });
    return release;
  }

  changeRelease(by: PeerId, input: { id: number; revision: number; state?: ReleaseState; plannedStart?: number | null; cut?: number | null; ship?: number | null }): Release {
    this.planningAuthority(by);
    const release = this.d.board.release(input.id);
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || !release || release.revision !== input.revision) throw new PreEffectToolRefusal("release revision changed");
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

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; role?: unknown; refs?: TaskRefs; plan?: TaskPlan; owner?: PeerId; after?: unknown; urgent?: unknown; backlog?: unknown; goal?: unknown }, external?: GitHubSource, created?: () => void): Promise<Task> {
    external = external ? { ...external } : undefined;
    if (external && (by !== USER || input.backlog !== true)) throw new PreEffectToolRefusal("external intake requires person-owned backlog staging");
    if (input.backlog !== undefined && typeof input.backlog !== "boolean") throw new PreEffectToolRefusal("backlog must be a boolean");
    const backlog = input.backlog === true;
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
    if (screened && screened.label !== "clear") signals.push("pii");
    let cls = baseGiven;
    let triaged = false;
    let fenced = false; // a PII task off campus: triage is not asked
    if (!cls && this.d.triage) {
      // Signals first: a PII task's text may only go to a model that is reached without leaving the campus network.
      const pii = this.isPii({ signals });
      if (!pii || (await this.d.triage.onCampus().catch(() => false))) cls = await this.d.triage.classify(text.title, text.detail).catch(() => undefined);
      else fenced = true;
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
    let task = this.d.board.propose(by, { ...draft, plan, ...(external ? { external } : {}), ...(deps.length ? { deps } : {}), ...(reserved ? { reserved } : {}), signals, ...(backlog ? { backlog: true } : {}) });
    if (repositoryMismatch) this.releaseNotice(`task #${task.id}: refs and plan name different repositories; check refs.repo before editing`);
    if (this.d.coordination) this.coordinationModes.set(task.id, this.d.coordination());
    created?.();
    if (screening) task = this.screenedTask(task, screened);
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
    const returned = this.d.board.update(confirmed.id, by, "backlog returned untouched", { state: "backlog", owner: null, reviewer: null }, input.reason.trim(), { ...(withheld ? { withheld: true } : {}) }, flow);
    this.offered.delete(confirmed.id);
    this.cohorts.leave(confirmed.id);
    this.withdrawRoleRequest(confirmed, returned, "owner");
    this.withdrawRoleRequest(confirmed, returned, "reviewer");
    this.incomingBacklog.add(confirmed.id);
    this.planningRecorded({ by, task: confirmed.id, fields: ["return"], revision: confirmed.planningRevision ?? 0 });
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
    if (task.state !== (pull ? "backlog" : "proposed") || task.owner) throw new PreEffectToolRefusal(`task #${n}: ${pull ? "only backlog may be pulled" : "only ownerless proposed work may return to backlog"}`);
    if (!pull && taskHasStarted(task)) throw new PreEffectToolRefusal(`task #${n}: started work cannot return to backlog`);
    const pulled = task.history.findLast(entry => entry.event === "backlog pulled" || entry.event === "backlog returned");
    const restoreReservation = !pull && pulled?.planning?.pull && !task.history.slice(task.history.lastIndexOf(pulled) + 1).some(entry => entry.event === "reserved" || entry.planning?.fields.includes("reserved"));
    const next = this.d.board.update(n, by, pull ? "backlog pulled" : "backlog returned", { state: pull ? "proposed" : "backlog", owner: null, reviewer: null, ...(restoreReservation ? { reserved: pulled.planning!.previous.reserved ?? null } : {}) });
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
    const task = this.d.board.list("proposed").filter((t) => waiting(t) && tries(t) < RESCREEN_MAX).sort((a, b) => tries(a) - tries(b))[0];
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
  private readonly conditional = new Map<string, { peer: PeerId; task: number; states: Task["state"][] }>();

  /**
   * Publish a notice about `task`, which only matters to `to` while that task is in one of `states` for it (issue
   * #106): open work by default; the conflict notices of #91 count a task in review too.
   */
  whileOpen(to: PeerId, task: number, body: string, states: Task["state"][] = OPEN): void {
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
      const current = ids.filter(id => this.d.board.get(id)?.state === "backlog");
      if (current.length !== ids.length || !this.d.roles?.[peer]?.includes("planner") || !this.d.bus.isRostered(peer)) {
        this.addPlannerBacklog(peer, current);
        return false;
      }
      return true;
    }
    if (env.from === HUB && env.refs?.task) {
      const task = this.d.board.get(Number(env.refs.task));
      if (task?.state === "cancelled") return env.kind === "task" && typeof env.refs.taskCancelled === "number" && env.refs.taskCancelled === task.cancelled?.flowRevision;
    }
    const c = this.conditional.get(env.id);
    if (!c || c.peer !== peer) return true;
    const t = this.d.board.get(c.task);
    return !!t && t.owner === peer && c.states.includes(t.state);
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
    return { repositoryKey: scope.key, paths: [...new Set(paths)], symbols: [...(task.plan?.symbols ?? []), ...(task.plan?.sections ?? []).map(v => `section ${v}`), ...(task.plan?.sources ?? []).map(v => `source ${v}`)] };
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
      const symbols = mine.symbols.filter((x) => theirs.symbols.includes(x));
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
      const a = assign(task, this.states(), routing, { exclude: this.excluded(task), excludeOwners: this.plannerPullRecord(task)?.pull ? this.plannerFull(task) : [], waitsFor: this.waitsFor(task), ...this.weights(task.class, task) });
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

  /** A person's owner removal sticks until a later explicit assignment or reservation, across hub runs. */
  private personUnassigned(task: Task): boolean {
    const removed = task.history.findLastIndex((h) => h.event === "unassigned" && h.by === USER);
    if (removed < 0) return false;
    return !task.history.slice(removed + 1).some((h) => h.by === USER && ["assigned", "reassigned", "escalated", "reserved", "backlog pulled"].includes(h.event));
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
  private async assignOwner(task: Task, by: PeerId, opts: { candidates?: PeerId[]; namedOwner?: PeerId; event?: string; note?: string; reason?: TaskMoveReason; clearOnFail?: boolean; exclude?: PeerId[]; context?: string; contextWithheld?: boolean; claim?: boolean; override?: boolean; roster?: boolean; planner?: boolean; expectedFlowRevision?: number; refuseNamed?: "pre" | "plain" } = {}): Promise<Task> {
    if (task.state === "backlog") throw new PreEffectToolRefusal(`task #${task.id}: pull backlog work before assigning it`);
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    let stagedClaimGap: string | undefined;
    if (mode !== "off" && this.isBuildTask(task)) {
      const gap = task.sdlc?.planReview ? await this.planReviewGap(task) : "plan not reviewed since proposal";
      const current = this.d.board.get(task.id);
      if (!current || !this.ownerAssignmentCurrent(task, current)) return current ?? task;
      task = current; // Reviewer-only and quiet bookkeeping updates do not supersede ownership authority.
      if (gap) {
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
    const a = assign(task, this.states(), this.d.routing(), { exclude: [...(opts.override ? [] : this.excluded(task)), ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], excludeOwners: plannerFull, ...(opts.candidates ? { candidates: opts.candidates } : {}), waitsFor: waits, ...this.weights(task.class, task), ...(opts.namedOwner ? { namedOwner: opts.namedOwner } : {}) });

    if (waits.length) {
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
      if (!task.owner && task.state === "proposed") this.reportStall(task, this.ownerStallCause(task, a));
      this.releaseNotice(opts.roster
        ? `task ${this.publicTitle(task)}: ${task.owner} is off roster and no peer can take it; it stays with ${task.owner} in ${task.state}; assign with: ahub task assign ${task.id} <peer>`
        : `task ${this.publicTitle(task)}: no peer can take it (${a.trace.filter((l) => l.includes("skipped")).length} skipped); assign with: ahub task assign ${task.id} <peer>`);
      // Only a decline takes the task away from its owner; a failed console assign or escalation leaves it where it was.
      if (opts.clearOnFail && task.owner) {
        this.cohorts.leave(task.id);
        return this.d.board.update(task.id, by, "unassigned", { owner: null });
      }
      return task;
    }
    const profile = this.d.splitProfile?.(a.owner);
    // A person's explicit assign replaces an agent's reservation (#207). Only a refusal keeps the owner it moves away from
    // out for good: a reviewer's rejections or an escalation by hand, never the hub's own move after a failed delivery.
    const lasting = opts.event === "escalated" && task.owner && (opts.reason === "rejections" || opts.reason === "manual");
    const next = this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(opts.roster && task.state === "in_progress" ? { state: "proposed" as const } : {}), ...(opts.event === "escalated" ? { rejections: 0 } : {}), ...(opts.override && task.reserved ? { reserved: null } : {}) }, this.assignmentNote(`${opts.note ?? `to ${a.owner}`}${passed}`, a), { ...this.reviewMetadata(a), ...(profile ? { profile } : {}), ...(opts.reason ? { reason: opts.reason } : {}), ...(lasting ? { from: task.owner! } : {}) }, opts.expectedFlowRevision);
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
      if (by === USER && opts.event === "reassigned") this.withdrawRoleRequest(task, next, "owner");
      const hits = this.overlapHits(next);
      this.formCohort(next, hits);
      if (hits.length) {
        this.announceOverlap(next, hits);
        this.tellEarlierOwners(next, hits);
      }
      this.announceRouting(next, a);
      if (!opts.claim || a.owner !== by) await this.sendTask(next, a, opts.context, this.overlaps(next, true, hits), opts.contextWithheld);
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
      const claimed = this.d.board.update(next.id, by, "accepted", { state: "in_progress" });
      this.captureOwnerAcceptance(claimed);
      this.releaseNotice(`task ${this.publicTitle(claimed)} claimed by ${by}`);
      return claimed;
    }
    return next;
  }

  /** Person-only advice changes never change ownership, class or authority. */
  setRole(by: PeerId, id: unknown, raw: unknown): Task {
    if (by !== USER) throw new PreEffectToolRefusal("only the person may change an existing task catalog role");
    if (raw === undefined) throw new PreEffectToolRefusal("name a catalog role id or explicit null to clear it");
    const task = this.need(id, false, true);
    if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal("a closed task's role is historical; propose new work instead");
    let selected;
    try { selected = taskRole(raw === null ? undefined : raw, task.class, this.d.catalog ?? loadRoleCatalog(this.d.cwd)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    if (task.role === selected?.id) return task;
    const next = this.d.board.update(task.id, by, "catalog role changed", { role: selected?.id });
    for (const peer of new Set([next.owner, next.state === "in_review" ? next.reviewer : null])) {
      if (!peer || peer === USER) continue;
      this.releaseNotice(`task ${this.publicTitle(next)}: catalog role update delivery unconfirmed`, () => this.d.bus.publish(newEnvelope(HUB,
        `Task #${next.id}: catalog role changed by the person. ${next.role ? this.roleGuidance(next, peer, peer === next.reviewer) : "Catalog guidance cleared; follow the task's existing plan and requirements."}`,
        { to: [peer], kind: "task", refs: { task: String(next.id), taskRecipient: peer === next.reviewer ? "reviewer" : "owner" }, ...(this.isPii(next) ? { private: true } : {}) })));
    }
    return next;
  }

  /** A self-claim has no assignment envelope; its tool result carries the same bounded guidance. */
  claimRoleGuidance(task: Task, peer: PeerId): string {
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
  private async sendTask(task: Task, a: Assignment, context?: string, overlap = "", contextWithheld = false): Promise<void> {
    const brief = this.isPii(task) ? undefined : await this.d.briefs?.forTask(task.owner!, task, this.planGuardItems(task)).catch(() => undefined);
    const current = this.d.board.get(task.id);
    if (!current || !this.ownerAssignmentCurrent(task, current)) throw new AssignmentSupersededError(current ?? task);
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
    this.d.board.recordTaskOffer(task.id, { envelopeId: env.id, owner, assignmentFlowRevision: task.history.length, ...(this.d.offerPullOnly ? { pullOnly: this.d.offerPullOnly(owner) } : {}) }, task.history.length);
    this.d.bus.publish(env);
    if (idle && this.d.bus.stateOf(owner) === "busy" && !this.d.bus.queueIds(owner).includes(env.id)) this.sent.set(handOver(task, owner), owner);
  }

  /** Nobody, the console user included, works on a task before what it waits for is approved. */
  private ready(task: Task, preEffect = false): void {
    const waits = this.waitsFor(task);
    if (waits.length) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} waits for ${waits.map((id) => `#${id}`).join(", ")}, not approved yet`);
  }

  /** An approved task may be the last thing others waited for: those go through assignment now (issue #34). */
  private async releaseDependents(approved: Task): Promise<void> {
    try {
      for (const t of this.d.board.list("proposed")) {
        if (!t.deps?.includes(approved.id) || t.owner || this.waitsFor(t).length) continue;
        await this.offerReady(t, `#${approved.id} approved`);
      }
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
  stalled(): TaskStall[] {
    const revision = this.d.board.statusRevision();
    if (this.stallCandidates?.revision !== revision) this.stallCandidates = { revision, rows: this.d.board.stalls().flatMap(stall => {
      const task = this.d.board.get(stall.task);
      if (stall.cause.kind === "no-writes") return (this.sweepConfig.no_writes_turns ?? 2) > 0 && task?.state === "in_progress" && ["implement", "bulk_edit"].includes(task.class) && task.owner === stall.cause.peer && this.ownerAcceptance(task)?.index === stall.cause.acceptance ? [{ stall, task, planned: false }] : [];
      if (task?.state !== "proposed" || task.owner || (task.planningRevision ?? 0) !== stall.replanRevision) return [];
      if (stall.cause.kind === "cancelled-dependency") return task.deps?.includes(stall.cause.dependency!) === true && this.d.board.get(stall.cause.dependency!)?.state === "cancelled" ? [{ stall, task, planned: false }] : [];
      return this.waitsFor(task).length ? [] : [{ stall, task, planned: this.plannerPullRecord(task)?.pull === true }];
    }) };
    // Eligibility inputs are live; queue journal writes alone do not re-decode board histories.
    const key = JSON.stringify([revision, this.states(), this.d.routing(), this.health(), [...this.d.bus.peers.keys()].map(peer => {
      const queue = this.d.bus.queueSummary(peer);
      return [peer, this.wipLimit(peer), queue.heldBy, queue.needsReview];
    })]);
    if (this.stallView?.key !== key) this.stallView = { key, stalls: this.stallCandidates.rows.filter(({ stall, task, planned }) => stall.cause.kind === "no-writes" || stall.cause.kind === "cancelled-dependency" || !(planned ? this.plannerAssignment(task, true) : assign(task, this.states(), this.d.routing(), { exclude: this.excluded(task), ...this.health() })).owner).map(({ stall }) => stall) };
    return structuredClone(this.stallView.stalls);
  }
  /** Why a proposal's named owner (a self-claim included) did not get it, from the stall its proposal recorded (#601); undefined when it did. */
  namedOwnerNote(task: Task, named: PeerId | undefined, by: PeerId): string | undefined {
    if (!named || task.owner || task.state !== "proposed") return undefined;
    const stall = this.d.board.stalls().find(row => row.task === task.id);
    if (!stall) return undefined;
    const code = stall.cause.refusals?.find(row => row.peer === named)?.code ?? (stall.cause.peer === named ? stall.cause.code : undefined);
    return `${named} was not assigned${code ? ` (${code})` : ""}: ${stall.cause.kind}; assign it again with hub_task_assign once ${named} can take it`;
  }
  private ownerStallCause(task: Task, admission: Assignment): TaskStall["cause"] {
    const refusal = admission.refusals?.find(row => row.role === "owner" && row.peer === task.reserved);
    // Persist the existing stall vocabulary; the assignment/explain keeps the precise instance/family refusal.
    const persisted = (code: NonNullable<Assignment["refusals"]>[number]["code"]): TaskStall["cause"]["code"] => code === "instance" || code === "family" ? "policy" : code;
    return refusal ? { kind: "reservation", peer: refusal.peer, code: persisted(refusal.code) } : { kind: "no-eligible-peer", code: "unavailable", refusals: admission.refusals?.filter(row => row.role === "owner").map(({ peer, code }) => ({ peer, code: persisted(code) })).sort((a, b) => a.peer.localeCompare(b.peer)) ?? [] };
  }
  private reportStall(task: Task, cause: TaskStall["cause"], now = Date.now(), description?: string): void {
    const stall: TaskStall = { task: task.id, cause, signature: JSON.stringify(cause), replanRevision: task.planningRevision ?? 0, at: now };
    if (!this.d.board.recordStall(stall)) return;
    const text = description ?? `Task #${task.id} stalled: ${cause.kind}${cause.peer ? ` ${cause.peer}` : ""}${cause.dependency ? ` #${cause.dependency}` : ""} (${cause.code}); configure the runner or peer, ahub task assign ${task.id} <peer>, re-plan dependencies, or cancel it.`;
    this.releaseNotice(text);
    try { this.d.stallNotice?.(stall); } catch { /* advisory never changes task authority */ }
    // Advice joins the planner's next delivery; it must not manufacture a turn beside a withheld backlog batch.
    for (const [peer, roles] of Object.entries(this.d.roles ?? {})) if (roles.includes("planner") && this.d.bus.isRostered(peer)) this.releaseNotice(`task #${task.id}: stall notice unavailable`, () => this.d.tell?.(peer, noteLine(HUB, "finding", text)));
  }
  async cancel(id: unknown, by: PeerId, input: { reason: string; supersededBy?: string; expectedFlowRevision?: number }): Promise<Task> {
    if (typeof input.reason !== "string" || !input.reason.trim() || Buffer.byteLength(input.reason) > 4000 || input.supersededBy !== undefined && (typeof input.supersededBy !== "string" || !input.supersededBy.trim() || Buffer.byteLength(input.supersededBy) > 1000)) throw new PreEffectToolRefusal("cancellation needs a bounded reason and supersession reference");
    const validate = () => {
      if (this.d.cancellationHeld?.() || this.d.bus.isRecoveryHeld) throw new PreEffectToolRefusal("recovery or shutdown is holding cancellation");
      const task = this.need(id, false, true, true);
      this.checkFlowRevision(task, input.expectedFlowRevision, true);
      if (isClosedTaskState(task.state)) throw new PreEffectToolRefusal(`task #${task.id} is already ${task.state}`);
      if (by !== USER && this.d.privateTurn?.(by) && !this.isPii(task)) throw new PreEffectToolRefusal("cancellation on ordinary work is unavailable during a private turn");
      if (by !== USER) {
        this.planningAuthority(by);
        const proposer = task.history.find(h => h.event === "proposed" || h.event === "backlogged")?.by;
        if (proposer !== by || !["backlog", "proposed"].includes(task.state) || taskHasStarted(task)) throw new PreEffectToolRefusal("planner may cancel only its own historically unaccepted backlog or proposed work");
      }
      return task;
    };
    const before = validate(), revision = before.history.length;
    const reasonText = [input.reason, input.supersededBy].filter(Boolean).join("\n");
    const withheld = looksSecret(reasonText) || this.aboutPrivatePath("", reasonText, before) || await this.withholds("note", reasonText, before);
    const task = validate();
    if (task.history.length !== revision) throw new PreEffectToolRefusal("task flow revision changed");
    const cancelled = { reason: input.reason.trim(), ...(input.supersededBy ? { supersededBy: input.supersededBy.trim() } : {}), flowRevision: revision + 1, ...(withheld ? { withheld: true as const } : {}) };
    const next = this.d.board.update(task.id, by, "cancelled", { state: "cancelled", reserved: null, cancelled }, cancelled.reason, { ...(withheld ? { withheld: true as const } : {}) }, revision);
    this.releaseNotice(`task #${task.id}: cancellation cohort cleanup unavailable`, () => this.cohorts.leave(task.id));
    this.offered.delete(task.id);
    this.releaseNotice(`task #${task.id}: cancellation stall cleanup unavailable`, () => this.d.board.clearStall(task.id));
    for (const peer of new Set([task.owner, task.reviewer])) if (peer && peer !== USER) this.releaseNotice(`task #${task.id}: cancellation notice unavailable`, () => this.d.bus.publish(newEnvelope(HUB, sanitize(`Task #${task.id} cancelled. Stop working on it. No native turn or working tree was changed.`), { to: [peer], kind: "task", priority: "important", refs: { task: String(task.id), taskCancelled: cancelled.flowRevision }, ...(this.isPii(next) ? { private: true } : {}) })));
    this.releaseNotice(`task #${task.id}: cancellation dependent advice unavailable`, () => {
      for (const dependent of this.d.board.list()) if (!isClosedTaskState(dependent.state) && !dependent.owner && dependent.deps?.includes(task.id)) this.releaseNotice(`task #${dependent.id}: cancellation stall advice unavailable`, () => this.reportStall(dependent, { kind: "cancelled-dependency", dependency: task.id, code: "cancelled" }));
    });
    return next;
  }

  async releaseReady(): Promise<void> {
    for (const t of this.d.board.list("proposed")) {
      if (t.owner) { this.d.board.clearStall(t.id); continue; }
      const cancelledDependency = t.deps?.find(id => this.d.board.get(id)?.state === "cancelled");
      if (cancelledDependency) { this.reportStall(t, { kind: "cancelled-dependency", dependency: cancelledDependency, code: "cancelled" }); continue; }
      const last = t.history.findLast(entry => !QUIET_EVENTS.has(entry.event))?.event, planned = this.plannerPullRecord(t)?.pull === true;
      if (this.personUnassigned(t) || this.offered.has(t.id) || this.waitsFor(t).length) continue;
      const admission = planned ? this.plannerAssignment(t, true) : assign(t, this.states(), this.d.routing(), { exclude: this.excluded(t), ...this.health() });
      if (!admission.owner) {
        this.reportStall(t, this.ownerStallCause(t, admission));
        continue;
      }
      this.d.board.clearStall(t.id);
      if ((!t.deps?.length && !t.history.some(h => h.event === "backlog pulled")) || (!planned && last !== "blocked" && last !== "ready" && last !== "reserved")) continue;
      // ponytail: a reserved owner (#207) that attaches after another peer that can take the task is passed over here like
      // an offline one; hold reserved tasks for a grace period if restarts show that up.
      await this.offerReady(t, "nothing left to wait for");
    }
  }

  /** Callers hold a list read before an await: re-read, or a task the other caller offered meanwhile is offered twice. */
  private async offerReady(stale: Task, why: string): Promise<void> {
    let offering = false, undelivered: AssignmentUndeliveredError | undefined;
    try {
      const t = this.d.board.get(stale.id);
      if (!t || t.state !== "proposed" || t.owner || this.personUnassigned(t) || this.offered.has(t.id)) return;
      const planned = this.plannerPullRecord(t)?.pull === true;
      const selected = planned ? this.plannerAssignment(t, true).owner : undefined;
      if (planned && !selected) return;
      this.offered.add(t.id);
      offering = true;
      const ready = t.history.at(-1)?.event === "ready" ? t : this.d.board.update(t.id, HUB, "ready", {}, why);
      this.releaseNotice(`task ${this.publicTitle(ready)} is ready: what it waited for is approved`);
      await this.assignOwner(ready, HUB, planned ? { candidates: [selected!], namedOwner: selected!, planner: true } : {});
    } catch (e) {
      // A saved move whose delivery failed is not "could not be assigned" (#297); the console notice was printed
      // where the error was thrown. The offer stays consumed by the error's own evidence, without the readback.
      if (e instanceof AssignmentUndeliveredError) undelivered = e;
      else this.releaseNotice(`task ${this.publicTitle(stale)}: could not be assigned: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
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
    if (by !== USER && task[role] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: only its ${role} (${task[role] ?? "none"}) or the console user can do that`);
  }

  private planIssueIdentity(task: Task): { repo: string; issue: number } | undefined {
    const source = task.external ?? task.sdlc;
    if (source?.repo && source.issue) return { repo: source.repo, issue: source.issue };
    const repository = task.refs.repo ?? this.d.repository ?? "";
    let issues: number[];
    try { issues = specRefs(task, repository); }
    catch { throw new PreEffectToolRefusal("plan review issue identity unavailable"); }
    if (issues.length > 1) throw new PreEffectToolRefusal("plan review needs one explicit issue identity");
    return issues[0] ? { repo: repository, issue: issues[0] } : undefined;
  }

  async groomingDigest(by: PeerId): Promise<Record<string, unknown>> {
    this.planningAuthority(by);
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
    const current = this.d.board.list().filter(included), visible = current.filter(task => !this.isPii(task));
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
    const digest = plannerGrooming(visible, { repository: this.d.repository ?? `path:${realPath(this.d.cwd)}`,
      limits: Object.fromEntries(peers.map(peer => [peer, this.wipLimit(peer)])), wip: Object.fromEntries(peers.map(peer => [peer, this.wip(peer)])),
      states, issues, reviewedIssues, acceptedIssues, blockers });
    return { ...digest, truncated: digest.truncated || incomplete, ...(current.some(task => this.isPii(task)) ? { privateTasks: "withheld" } : {}) };
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
    return { ...report, stalls, truncated: report.truncated || incomplete, ...(current.some(task => this.isPii(task)) ? { privateTasks: "withheld" } : {}), bands: "S7 pending" };
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
    if (observed.history.length !== flow || (observed.planningRevision ?? 0) !== revision) throw new PreEffectToolRefusal("plan review changed during readback");
    const identity = this.planIssueIdentity(observed);
    if (identity?.issue && this.isPii(observed)) throw new PreEffectToolRefusal("private issue plan review readback unavailable");
    const issue = identity?.repo && identity.issue ? await readPlanIssueMetadata(identity.repo, identity.issue, this.d.sdlc?.gh ?? sdlcGh) : undefined;
    if (identity?.issue && !issue) throw new PreEffectToolRefusal("plan review issue metadata unavailable");
    if (issue && !this.isPii(task) && !this.nameable(JSON.stringify(issue))) throw new PreEffectToolRefusal("plan review metadata matches a PII pattern");
    this.plannerWriteAuthority(by);
    const current = this.need(task.id, false, true, true);
    if (current.history.length !== flow || (current.planningRevision ?? 0) !== revision) throw new PreEffectToolRefusal("plan review changed during readback");
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const updated = this.d.board.update(current.id, by, "plan reviewed", { ...(Object.keys(scope).length ? { plan: { ...current.plan, ...scope } } : {}), sdlc: { ...current.sdlc, stage: current.sdlc?.stage ?? lifecycleStage(config, "plan"),
      planReview: { planner: by, planningRevision: revision, recordedAt: Date.now(), ...(Object.keys(scope).length ? { scope } : {}), ...(issue ? { issue } : {}) } } }, raw.reason.trim(), { ...(withheld ? { withheld: true } : {}) }, flow);
    if (updated.state === "proposed" && !updated.owner) {
      this.offered.delete(updated.id);
      try { await this.offerReady(updated, "planner review recorded"); }
      catch { this.releaseNotice(`task #${updated.id}: plan review saved; inspect its owner delivery before retrying`); }
    }
    return this.d.board.get(updated.id) ?? updated;
  }

  /** Artifact links and claimed local gates stay on the board; no outside text is accepted. */
  recordLifecycle(by: PeerId, id: unknown, input: unknown): Task {
    const task = this.need(id, false, true);
    if (by !== USER && by !== task.owner && by !== task.reviewer) throw new PreEffectToolRefusal("only the task owner, reviewer or console user may record lifecycle evidence");
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const next = sdlcReceipt(input, task.sdlc, config, VERSION);
    const definition = stageDefinition(config, next.stage);
    // #481 S1: entering a build stage in enforce needs the person's spec acceptance; the person may move any stage.
    if (config.mode === "enforce" && by !== USER && next.stage !== task.sdlc?.stage && definition && canonicalStage(definition.base) === "build" && specState(next, undefined) === "missing") throw new PreEffectToolRefusal(this.specText(task, "missing", "blocked"));
    if (config.mode === "enforce" && config.definitions && input && typeof input === "object" && "stage" in input && next.stage !== task.sdlc?.stage && by !== USER) {
      const actor = definition?.actor;
      const acts = actor === "owner" ? by === task.owner : actor === "reviewer" ? by === task.reviewer : actor === "planner" ? this.d.roles?.[by]?.includes("planner") : actor === "owner/planner" && (by === task.owner || this.d.roles?.[by]?.includes("planner"));
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
    return this.d.board.update(task.id, by, "lifecycle", { sdlc: next });
  }

  async deliveryQueue(repo: string) {
    const before = workflowHash(this.d.board.list().map(t => ({ id: t.id, state: t.state, after: t.deps, sdlc: t.sdlc, history: t.history.length })));
    const links = this.d.board.list().map(t => ({ id: t.id, after: t.deps ?? [], private: this.isPii(t), receipt: t.sdlc, phase: this.isPii(t) ? undefined : this.workflowView(t) }));
    const report = await readMergeQueue(repo, this.d.sdlc?.config() ?? sdlcConfig(undefined), links, this.d.sdlc?.gh);
    // Policy can change across remote awaits without any board write. Never return its stale public projection.
    const currentPrivacy = this.d.board.list().map(task => ({ id: task.id, private: this.isPii(task) }));
    if (workflowHash(links.map(({ id, private: hidden }) => ({ id, private: hidden }))) !== workflowHash(currentPrivacy)) {
      return { ...report, complete: false, rows: [], order: [], unordered: [], conflicts: [] };
    }

    const after = workflowHash(this.d.board.list().map(t => ({ id: t.id, state: t.state, after: t.deps, sdlc: t.sdlc, history: t.history.length })));
    if (before !== after) { report.complete = false; report.order = []; if (report.rows.length) report.unordered = report.rows.map(row => row.pr); for (const row of report.rows) { row.ready = false; row.blockers.push("board changed during delivery readback"); } }
    return report;
  }
  async releaseReadiness(repo: string, liveIssues: number[]) {
    const report = await readReleaseReadiness(this.d.cwd, repo, liveIssues, { gh: this.d.sdlc?.gh });
    if (report.documents) report.documents.documents = report.documents.documents.map(d => {
      if (d.path && (!this.nameable(d.path) || matchesPolicy(this.d.cwd, d.path, this.d.piiPaths ?? [], true))) { const { path: _privatePath, ...metadata } = d; return metadata; }
      return d;
    });
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
  async lifecycleStatus(id: unknown, refresh = true): Promise<SdlcStatus> {
    const task = this.need(id), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const evidence = task.sdlc && !this.isPii(task) && refresh && config.mode !== "off" ? await readSdlcPr(task.sdlc, this.d.sdlc?.gh) : undefined;
    const accepted = task.sdlc?.acceptance;
    const edit = accepted && !this.isPii(task) && refresh && config.mode !== "off" ? await readSpecEdit(accepted.repo, accepted.issue, this.d.sdlc?.gh) : undefined;
    return sdlcStatus(config, task.sdlc, evidence, this.workflowView(task), edit);
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
    const task = this.need(id, false, true);
    if (!this.specGated(task) || task.owner !== by && by !== USER) return; // accept reports its own refusals
    const accepted = task.sdlc?.acceptance;
    const edit = accepted && !this.isPii(task) ? await readSpecEdit(accepted.repo, accepted.issue, this.d.sdlc?.gh) : undefined;
    if (this.specMoved(task)) return;
    this.specVerdict(task, task.sdlc?.issue ? specState(task.sdlc, edit) : "missing");
  }

  /** #481 S1: a build stage change by an agent re-reads the body edit time first, as accept does. */
  async specStageGate(by: PeerId, id: unknown, input: unknown): Promise<void> {
    const task = this.need(id, false, true), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (config.mode === "off" || by === USER || !input || typeof input !== "object" || !("stage" in input)) return;
    let next: ReturnType<typeof sdlcReceipt>;
    try { next = sdlcReceipt(input, task.sdlc, config, VERSION); } catch { return; } // recordLifecycle reports an invalid receipt
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

  private async lifecycleGate(task: Task, transition: "review" | "approval", reviewedHead?: string): Promise<PrEvidence | undefined> {
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (config.mode === "off") return;
    const receipt = task.sdlc && { ...task.sdlc, ...(reviewedHead ? { reviewedHead } : {}) };
    const read: SdlcGh = (args, timeout, cwd, cap) => {
      const current = this.need(task.id, false, true);
      if (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || this.isPii(current) !== this.isPii(task)) return Promise.resolve({ code: 1, stdout: "" });
      return (this.d.sdlc?.gh ?? sdlcGh)(args, timeout, cwd, cap);
    };
    const evidence = receipt && !this.isPii(task) ? await readSdlcPr(receipt, read) : undefined;
    const current = this.need(task.id, false, true);
    if (config.mode === "enforce" && (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || current.state !== task.state)) throw new PreEffectToolRefusal(`task #${task.id}: changed during lifecycle readback; retry on current work`);
    // Advise may continue on the current task, but evidence from its previous link cannot admit that task's review.
    if (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || current.state !== task.state || this.isPii(current) !== this.isPii(task)) return;
    const status = sdlcStatus(config, receipt, evidence, this.workflowView(current));
    const blockers = transition === "review" ? [...new Set([...status.blockers.filter(blocker => ["lifecycle stage definition unknown", "issue identity missing", "PR identity missing", "current PR evidence unknown", "PR is not open", "local gate on current head missing or failed"].includes(blocker)), ...(status.entry ?? []), ...(status.exit ?? [])])] : status.blockers;
    if (config.mode === "enforce" && blockers.length) throw new PreEffectToolRefusal(`task #${task.id}: SDLC ${transition} blocked: ${blockers.join("; ")}`);
    if (config.mode === "advise" && blockers.length) this.d.notify(`task ${this.publicTitle(task)}: SDLC ${transition} advice: ${this.isPii(task) ? "private lifecycle evidence unknown" : blockers.join("; ")}`);
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
    const metadata = acceptRefs(refs);
    const task = this.need(id, false, true);
    this.mine(task, by, "owner", true);
    this.ready(task, true);
    if (task.state !== "proposed" && task.state !== "changes_requested" && task.state !== "in_progress") throw new PreEffectToolRefusal(`task #${task.id} is ${task.state}: cannot move to in_progress`);
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
    const next = this.d.board.update(task.id, by, "accepted", { state: "in_progress", ...(cleaned ? { plan: cleaned } : {}), ...(metadata ? { refs: metadata } : {}) });
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
    const planned = this.plannerPullRecord(task)?.pull === true;
    const back = this.d.board.update(task.id, by, "declined", { ...(["in_progress", "changes_requested"].includes(task.state) ? { state: "proposed" as const } : {}), ...(planned ? { reserved: null } : {}) }, reason, task.owner ? { from: task.owner, ...(capacity === true ? { capacity: true as const } : {}) } : {});
    if (planned) this.offered.delete(task.id);
    this.d.notify(`task ${this.publicTitle(back)} declined${capacity === true ? " (capacity only)" : ""} by ${by}${reason && !this.isPii(back) ? `: ${reason}` : ""}`);
    // A capacity decline is not in excluded(), so this move's own reroute leaves the decliner out explicitly.
    return this.assignOwner(back, HUB, { event: "reassigned", reason: "declined", clearOnFail: true, ...(capacity === true && task.owner ? { exclude: [task.owner] } : {}), ...(planned ? { planner: true } : {}) });
  }

  /** Tasks whose check is queued or running, and the owner it was started for. */
  private readonly checking = new Map<number, PeerId | null>();
  private checkQueue: Promise<void> = Promise.resolve();
  private pendingChecks = 0;
  /** Checks queued or running, until their result is on the board: a recovery commit waits for them. */
  checksPending = () => this.pendingChecks;

  /** Whether a completion check is still running for this task. */
  isChecking = (id: number) => this.checking.has(id);

  private completionCurrent(id: unknown, by: PeerId, preEffect: boolean): Task {
    const t = this.need(id, false, preEffect);
    this.mine(t, by, "owner", preEffect);
    if (t.state === "in_review" || isClosedTaskState(t.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${t.id} is already ${t.state}`);
    this.ready(t, preEffect);
    if (t.state === "proposed" || t.state === "changes_requested") this.acceptanceCapacity(t);
    if (this.checking.has(t.id)) {
      // The result goes only to the owner the check was started for: anyone who took the task since hears nothing.
      throw new (preEffect ? PreEffectToolRefusal : Error)(this.checking.get(t.id) === t.owner ? `task #${t.id}: its check is still running; its result comes as a task message` : `task #${t.id}: a check from before it changed hands is still running; call hub_task_done again in a few minutes`);
    }
    return t;
  }

  async done(by: PeerId, id: unknown, summary?: string, refs?: TaskRefs): Promise<Task> {
    const valid = () => this.completionCurrent(id, by, true);
    // The PII screen reads the summary of a done that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("summary", summary, valid());
    let task = valid();
    // #481 S1: done without a separate accept starts build work too: the same live spec check as accept, before any write.
    if (task.state === "proposed" || task.state === "changes_requested") {
      const admission = task;
      await this.specGate(by, task.id);
      await this.planEntryGate(by, admission);
      task = valid();
    }
    let reviewEvidence: PrEvidence | undefined;
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off") { reviewEvidence = await this.lifecycleGate(task, "review"); task = valid(); }
    const reviewAdmission = task.reviewer ? await this.reviewRequestAdmission(task, refs, true, by, reviewEvidence) : undefined;
    task = valid();
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
        task = this.d.board.update(task.id, HUB, "integration unresolved", {}, r.why);
      } else if (r.integrated) task = this.d.board.update(task.id, HUB, "integrated", {}, `cohort #${cohort!.id}, revision ${cohort!.revision}`);
    } else if (cohort?.held.size && !this.isPii(task)) {
      // No integration step for this member (silence lifted, a PII task open): the notices the silence held stand in
      // for it (issue #107, AC4).
      const evidence = this.heldEvidence(cohort, task);
      if (evidence && by === USER) this.d.notify(`task ${this.publicTitle(task)} done by the console; overlapping work finished meanwhile:\n${evidence}`);
      else if (evidence) this.doneNotes.set(task.id, `Overlapping work finished while you worked (no turn-free integration step ran):\n${evidence}`);
    }
    if (task.state === "proposed" || task.state === "changes_requested") task = this.d.board.update(task.id, by, "accepted", { state: "in_progress" }, WITH_DONE); // done without a separate accept
    const command = this.d.runCheck ? this.d.check?.(task.class, task) : undefined;
    if (!command) return this.complete(task, by, summary, refs, "", withheld, "review", reviewAdmission);
    // The tool call returns now; a check can outlast an agent's tool timeout. The result decides what comes next.
    this.checking.set(task.id, task.owner);
    const checkedRefs = cleanRefs(refs);
    this.warmRepository({ ...task, refs: { ...task.refs, ...checkedRefs } });
    const pending = this.d.board.update(task.id, by, "done (checking)", { refs: checkedRefs }, summary, { withheld: withheld || undefined });
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
        const symbols = mine.symbols.filter((x) => theirs.symbols.includes(x));
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
      this.d.board.update(id, HUB, "check passed", {}, `${outcome}\n${result.tail}`.trim());
      // The output goes to the reviewer with the done note, not into shared memory: nobody screened it.
      await this.complete(this.d.board.get(id)!, by, `${summary ?? ""}\nCheck: ${outcome}`.trim(), undefined, result.tail, withheld);
      return;
    }
    this.d.board.update(id, HUB, "check failed", {}, `${outcome}\n${result.tail}`.trim());
    this.cohorts.withdraw(id); // open again: its done intent no longer counts (issue #107)
    if (task.owner) this.d.board.recordOutcome(task.owner, task.class, false);
    this.contradict(task);
    this.d.notify(`task ${this.publicTitle(task)}: its check failed (${outcome}); it stays with ${task.owner ?? by}`);
    this.tell(task, `Task #${id}: its check failed.\n$ ${outcome}${result.tail ? `\n${result.tail}` : ""}\nFix it and call hub_task_done again.`, pii);
  }

  /** `gated`: the transition `done()` already gated with no await since, so it is not read back twice (#382). */
  private async complete(task: Task, by: PeerId, summary?: string, refs?: TaskRefs, checkOutput = "", withheld = false, gated?: "review", admission?: ReviewReadiness): Promise<Task> {
    let selection = this.poolReview(task, refs);
    let reviewer = selection?.reviewer ?? task.reviewer, reviewEvidence: PrEvidence | undefined;
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off" && gated !== (reviewer ? "review" : "approval")) {
      reviewEvidence = await this.lifecycleGate(task, reviewer ? "review" : "approval");
      task = this.completionCurrent(task.id, by, false);
      selection = this.poolReview(task, refs);
      reviewer = selection?.reviewer ?? task.reviewer;
    }
    // A delayed local check needs a new readback; the immediate done path already admitted before effects.
    if (reviewer && !admission && (this.d.sdlc?.config().mode ?? "off") !== "off") {
      admission = await this.reviewRequestAdmission(task, refs, false, by, reviewEvidence);
      task = this.completionCurrent(task.id, by, false);
    }
    selection = this.poolReview(task, refs);
    reviewer = selection?.reviewer ?? task.reviewer;
    const reviewCost: ReviewCost | undefined = reviewer && task.plan && (task.plan.review || task.plan.ci)
      ? { ...cleanCostPlan(task.plan), ...(admission?.ready && admission.head ? { head: admission.head } : {}) } : undefined;
    const routedSummary = selection?.reviewSelection?.blocked ? `${summary ?? ""}\nReview routing: ${this.assignmentNote("pool unavailable", selection)}`.trim() : summary;
    const completedRefs = cleanRefs(refs);
    this.warmRepository({ ...task, refs: { ...task.refs, ...completedRefs } });
    const noWrites = this.noWritesRecorded({ ...task, refs: { ...task.refs, ...completedRefs } });
    const next = this.d.board.update(task.id, by, "done", { state: reviewer ? "in_review" : "approved", ...(selection ? { reviewer: reviewer ?? USER } : {}), ...(task.sdlc ? { sdlc: { ...task.sdlc, stage: lifecycleStage(this.d.sdlc?.config() ?? sdlcConfig(undefined), reviewer ? "review" : "merge") } } : {}), refs: completedRefs }, checkOutput ? `${routedSummary ?? ""}\n${checkOutput}`.trim() : routedSummary, { withheld: withheld || undefined, ...(noWrites ? { noWrites: true as const } : {}), ...this.reviewMetadata(selection), ...(reviewCost ? { reviewCost } : {}) });
    this.cohorts.closed(next.id); // its owner's next native turn end settles it in its cohort (issue #107)
    this.note(next, by, "finding", `Task #${next.id} done by ${by}: ${next.title}\n${summary ?? ""}`, withheld);
    this.tellCompleted(next, summary, withheld);
    if (!reviewer) {
      this.settleMemory(next);
      if (next.owner) this.d.board.recordOutcome(next.owner, next.class, true); // approved without a review is a success too
      this.releaseNotice(`task ${this.publicTitle(next)} done by ${by}, no reviewer: approved`);
      await this.releaseDependents(next);
    }
    else if (reviewer === USER) this.releaseNotice(`task ${this.publicTitle(next)} done by ${by}: review it with ahub task show ${next.id}, then ahub review ${next.id} approved|changes_requested [note]`);
    else this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${reviewer}`, () => this.sendReview(next, reviewer, "", admission));
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
    for (const hit of hits) {
      // A member of the same silent cohort (issue #107): the member that finishes last integrates instead
      // (Cohorts.completion). The notice is held, so something replaces it if no integration runs. Others hear it.
      if (silent && cohort?.members.has(hit.task.id)) {
        cohort.held.add(task.id);
        continue;
      }
      this.releaseNotice(`task ${this.publicTitle(task)}: could not publish the completed-change notice to ${hit.task.owner}`, () =>
        this.whileOpen(hit.task.owner!, hit.task.id, this.completedNotice(task, hit, summary, withheld)));
    }
  }

  /**
   * The completed-change notice: files, signatures and the summary are the owner's own words (paths given at done
   * included), and any item that matches a PII pattern is left out of what other owners get, the summary also when the
   * PII screen did not clear it (`withheld`, #198).
   */
  private completedNotice(task: Task, hit: { task: Task; paths: string[]; symbols: string[] }, summary?: string, withheld = false): string {
    const paths = this.places(task).paths.filter(this.nameable);
    const signatures = (task.plan?.signatures ?? []).filter(this.nameable);
    const first = (summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
    const line = first && !withheld && this.nameable(first) ? first : undefined;
    return [
      `Task #${task.id} (owner ${task.owner}) is done and touches your open #${hit.task.id} on ${this.where(hit)}. Check your work against it before you go on.`,
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
  private async reviewRequestAdmission(task: Task, refs?: TaskRefs, preEffect = true, actor: PeerId = task.owner ?? USER, previous?: PrEvidence, sameRequest?: () => boolean): Promise<ReviewReadiness | undefined> {
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (mode === "off") return undefined;
    let quietDrift = false;
    const guard = () => {
      if (actor !== USER && actor !== task.owner) {
        const holders = Object.entries(this.d.roles ?? {}).filter(([, roles]) => Array.isArray(roles) && roles.includes("conductor")).map(([peer]) => peer);
        if (holders.length !== 1 || holders[0] !== actor) throw new (preEffect ? PreEffectToolRefusal : Error)("review admission authority changed");
      }
      const current = this.need(task.id, false, preEffect);
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

  private sendReview(task: Task, reviewer: PeerId, why = "", admission?: ReviewReadiness): void {
    const mode = (this.d.sdlc?.config() ?? sdlcConfig(undefined)).mode;
    if (mode === "enforce" && !admission?.ready) {
      // Background roster/quota role changes are retained, but never invent a remotely admitted review request.
      this.releaseNotice(`task ${this.publicTitle(task)}: premature review held; retry the reviewer assignment after current CI and bot replies are verified`);
      return;
    }

    const r = task.refs;
    const last = [...task.history].reverse().find((h) => h.event === "done");
    const where = [r.branch ? `branch ${r.branch}` : "", r.commit ? `commit ${r.commit}` : "", r.paths?.length ? `paths ${r.paths.join(", ")}` : ""].filter(Boolean).join("; ");
    // A checklist that maps the change to its contract (issue #35): reviewers who check against the written plan catch more.
    const plan = planText(task.plan);
    const check = [...task.history].reverse().find((h) => h.event === "check passed");
    const checklist = [
      "Checklist:",
      ...this.planGuardItems(task).map(item => `- Check the plan against this live fail before the remaining checks: ${item.line}`),
      `- Map the changed signatures and call sites to ${plan ? `the plan (${plan})` : task.detail ? "the task detail above" : "the task title"}, and name each one that does not match.`,
      `- ${check ? `Check result: ${(check.note ?? "").split("\n")[0]}` : "No check ran for this class: run the affected tests yourself."}`,
      `- List what is unmet in hub_review's unmet, one item each.`,
    ].join("\n");
    // #223 R2: a reviewer-only instance judges from facts; the builder's narrative stays out, earlier findings go in.
    const reviewOnly = this.d.reviewOnly?.(reviewer) === true;
    const summary = reviewOnly ? "(summary withheld from a review-only reviewer; judge the change itself)" : last?.note ? this.screen(task, last.note, "summary", reviewer, last.withheld) : "(no summary)";
    const specRepo = task.sdlc?.repo ?? task.external?.repo, specIssue = task.sdlc?.issue ?? task.external?.issue;
    const spec = reviewOnly && specRepo && specIssue ? `Spec issue: ${specRepo}#${specIssue}\n` : "";
    const findings = reviewOnly ? task.history.filter(h => h.event === "changes_requested" && h.note).map(h => `- ${h.by}: ${this.screen(task, h.note!, "review note", reviewer, h.withheld)}`) : [];
    const guidance = this.roleGuidance(task, reviewer, true);
    let projection = "";
    try { const text = this.d.projectedReview?.(task); if (text) projection = this.screen(task, sanitize(text), "document projection", reviewer); }
    catch { projection = "(document projection unavailable)"; }
    const brief = this.briefText(task);
    // #572 AC3: advisory only, from git state never from task text, so it is safe for a PII task too.
    const checkout = mainCheckoutWarning(this.d.cwd, this.publicMetadataText);
    const body = `Review task #${task.id} [${profileTaskLabel(task)}] ${task.title}\nDone by ${last?.by ?? task.owner}: ${summary}\n${where ? `Where: ${where}\n` : ""}${last?.noWrites ? "no writes recorded since acceptance\n" : ""}${spec}${why ? `${why}\n` : ""}${!plan && task.detail ? `Task detail:\n${task.detail}\n` : ""}${guidance ? guidance + "\n" : ""}${projection ? projection + "\n" : ""}${brief ? brief + "\n" : ""}${checkout ? `Note: ${checkout}.\n` : ""}${findings.length ? `Earlier findings (set a disposition for each):\n${findings.join("\n")}\n` : ""}${checklist}\nGive your verdict with hub_review {id: ${task.id}, verdict: "approved" | "changes_requested", note, unmet}.`;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [reviewer], kind: "review", priority: "important", refs: { ...r, ...(this.reviewHead(task) ? { commit: this.reviewHead(task)! } : {}), task: String(task.id), reviewRevision: String(this.reviewRequestRevision(task)) }, ...(this.isPii(task) ? { private: true } : {}) }));
  }

  private reviewRequestRevision(task: Task): number {
    // Role changes fence older requests; bookkeeping appended after the request does not.
    return task.history.findLastIndex(entry => ["done", "reviewer changed", "reviewer unavailable"].includes(entry.event) || OWNERSHIP_EVENTS.has(entry.event)) + 1;
  }

  /** Host-only admission for a queued review after asynchronous native preparation. */
  reviewBindingCurrent(by: PeerId, id: number, binding: { head?: string; flowRevision?: number }): boolean {
    const task = this.d.board.get(id);
    return !!task && task.state === "in_review" && task.reviewer === by && !this.isPii(task)
      && this.reviewRequestRevision(task) === binding.flowRevision && this.reviewHead(task) === binding.head;
  }

  /** Host-only failure report, bound to the exact review request and its still-current child generation. */
  async retryReviewer(id: number, failedPeer: PeerId, failure: { head?: string; flowRevision?: number; cause: "start_failed" | "quota" | "no_verdict" }, current: () => boolean): Promise<Task> {
    if (!failure || !["start_failed", "quota", "no_verdict"].includes(failure.cause) || !/^[a-z][a-z0-9-]{0,63}$/.test(failedPeer) || !Number.isSafeInteger(failure.flowRevision) || failure.flowRevision! < 1 || failure.head !== undefined && (typeof failure.head !== "string" || text(failure.head) !== failure.head || Buffer.byteLength(failure.head) > 1200 || /\p{Cc}/u.test(failure.head))) throw new PreEffectToolRefusal("invalid reviewer failure binding");
    const valid = () => {
      const task = this.need(id, false, true);
      if (!current() || task.state !== "in_review" || task.reviewer !== failedPeer || this.reviewRequestRevision(task) !== failure.flowRevision || this.reviewHead(task) !== failure.head || this.isPii(task) || this.manuallyNamedReviewer(task)) throw new PreEffectToolRefusal("reviewer failure is no longer current");
      return task;
    };
    const before = valid();
    const admission = await this.reviewRequestAdmission(before, undefined, true, before.owner ?? USER, undefined, () => { valid(); return true; });
    const task = valid();
    const options = this.reviewPoolOptions(task);
    const selection = assign(task, this.states(), this.d.routing(), { ...this.weights(task.class, task), candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), reviewPool: { ...options, failed: [...options.failed, failedPeer] } });
    if (!selection.reviewSelection) throw new PreEffectToolRefusal("no declared reviewer pool can receive the fallback");
    const reviewer = selection.reviewer ?? USER;
    valid();
    const next = this.d.board.update(task.id, HUB, "reviewer unavailable", { reviewer }, this.assignmentNote(`reviewer unavailable: ${failure.cause}`, selection), { ...this.reviewMetadata(selection), reviewerFailure: { peer: failedPeer, cause: failure.cause, ...(failure.head ? { head: failure.head } : {}) } }, task.history.length);
    this.releaseNotice(`task ${this.publicTitle(next)}: former review request withdrawal incomplete`, () => this.withdrawRoleRequest(task, next, "reviewer"));
    if (reviewer === USER) this.releaseNotice(`task ${this.publicTitle(next)}: blocked: no reviewer can run; the planner or person must review`);
    else this.releaseNotice(`task ${this.publicTitle(next)}: fallback review request unavailable`, () => this.sendReview(next, reviewer, "", admission));
    return next;
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

  async review(by: PeerId, id: unknown, verdict: unknown, note?: string, unmet?: unknown, head?: unknown, coverage?: unknown): Promise<Task> {
    const authority = by === USER ? undefined : this.d.reviewAuthority?.(by, Number(id));
    // #520: what the coverage was checked against, pinned through every await: the commit and the lifecycle receipt (the
    // inherited reviewedHead lives there).
    let covered: { commit: string | undefined; receipt: string } | undefined;
    const valid = (): Task => {
      const refused = authority?.();
      if (refused) throw new PreEffectToolRefusal(refused); // rechecked after every await, right before each write
      const t = this.need(id, false, true);
      if (covered && (t.refs.commit !== covered.commit || JSON.stringify(t.sdlc ?? null) !== covered.receipt)) throw new PreEffectToolRefusal(`task #${t.id}'s commit or lifecycle receipt changed during the verdict: review the new head`);
      this.mine(t, by, "reviewer", true);
      if (verdict !== "approved" && verdict !== "changes_requested") throw new PreEffectToolRefusal('verdict must be "approved" or "changes_requested"');
      if (t.state !== "in_review") throw new PreEffectToolRefusal(`task #${t.id} is ${t.state}: cannot move to ${verdict} before its owner calls hub_task_done`);
      return t;
    };
    const items = textList(unmet);
    if (items.length) note = `${note ?? ""}\nUnmet: ${items.join("; ")}`.trim();
    // #520: an approval accounts for every reviewable path of the brief. enforce refuses before any effect, advise records
    // the gap in the verdict note, off and a person's own verdict skip it.
    const mode = this.d.sdlc?.config().mode ?? "off";
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
    // The PII screen reads the note of a review that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("review note", note, valid());
    let task = valid();
    let reviewedHead: string | undefined;
    if (head !== undefined) {
      const checked = sdlcReceipt({ reviewedHead: head }, task.sdlc, this.d.sdlc?.config() ?? sdlcConfig(undefined));
      reviewedHead = checked.reviewedHead;
    }
    if (verdict === "approved" && this.d.sdlc && this.d.sdlc.config().mode !== "off") { await this.lifecycleGate(task, "approval", reviewedHead); task = valid(); }
    let candidate: Extract<CandidateInput, { kind: "fail" }> | undefined;
    if (verdict === "changes_requested" && items.length && this.d.candidates && !withheld && !this.isPii(task) && !this.d.privateTurn?.(by)) {
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
    const flag = { withheld: withheld || undefined, ...(reviewContext ? { reviewContext } : {}), ...(reviewerFamily ? { reviewerFamily } : {}), ...(reviewerReason ? { reviewerReason } : {}) };
    if (verdict === "approved") {
      const next = this.d.board.update(task.id, by, "approved", { state: "approved", rejections: 0, ...(reviewedHead && task.sdlc ? { sdlc: { ...task.sdlc, reviewedHead, stage: lifecycleStage(this.d.sdlc?.config() ?? sdlcConfig(undefined), "merge") } } : {}) }, note, flag);
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
      return next;
    }
    const rejected = this.d.board.update(task.id, by, "changes_requested", { state: "changes_requested", rejections: task.rejections + 1 }, note, flag);
    if (candidate && !pii && !this.d.privateTurn?.(by) && this.candidateTextAllowed(JSON.stringify({ candidate, refs: rejected.refs, plan: rejected.plan }), rejected)) {
      try { this.d.memoryCheck?.(); this.d.candidates?.put({ ...candidate, evidenceRefs: [...candidate.evidenceRefs, `review:${rejected.id}:${rejected.history.length}`] }, "public"); } catch { /* a saved review remains authoritative if the optional sidecar fails */ }
    }
    this.cohorts.withdraw(rejected.id); // open again: its done intent no longer counts (issue #107)
    if (rejected.owner) this.d.board.recordOutcome(rejected.owner, rejected.class, false);
    this.contradict(rejected);
    this.note(rejected, by, "decision", `Task #${rejected.id} changes requested by ${by}: ${rejected.title}\n${note ?? ""}`, withheld);
    if (rejected.rejections >= (this.d.escalateAfter?.() ?? ESCALATE_AFTER)) {
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

  /** Task-level escalation: the next attached peer in the class's escalate_to takes over, with the history. */
  async escalate(by: PeerId, id: unknown, why = "by hand", reason: TaskMoveReason | undefined = by === HUB ? undefined : "manual", preEffect = false): Promise<Task> {
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
  private withdrawRoleRequest(previous: Task, next: Task, role: TaskAssignmentRole): void {
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

  /** Caller authority is checked by the daemon; keep the real actor in task history. */
  async assignTo(id: unknown, peer: PeerId, by: PeerId = USER, preEffect = false, role: TaskAssignmentRole = "owner", expectedFlowRevision?: number): Promise<Task> {
    if (role !== "owner" && role !== "reviewer") throw new (preEffect ? PreEffectToolRefusal : Error)("role must be owner or reviewer");
    if (role === "reviewer" && by !== USER) {
      const conductors = Object.entries(this.d.roles ?? {}).filter(([, roles]) => Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
      if (conductors.length !== 1 || conductors[0] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the configured conductor may name a reviewer");
    }
    const task = this.need(id, role === "owner", preEffect);
    this.checkFlowRevision(task, expectedFlowRevision, preEffect);
    if (!this.d.bus.isRostered(peer)) throw new (preEffect ? PreEffectToolRefusal : Error)(`${peer} is off roster; add it to the roster before assigning work`);
    this.requireCapabilities(task, peer, role, preEffect);
    if (role === "reviewer") {
      if (!OPEN.includes(task.state) && task.state !== "in_review") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its reviewer can no longer change`);
      this.ready(task, preEffect);
      const a = assign(task, this.states(), this.d.routing(), { candidates: [], namedReviewer: peer, ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class, task) });
      if (a.reviewer !== peer) throw new (preEffect ? PreEffectToolRefusal : Error)(`cannot name ${peer} as reviewer: ${a.trace.filter(line => line.includes("reviewer") || line.includes("pii")).join("; ")}`);
      const admission = task.state === "in_review" ? await this.reviewRequestAdmission(task, undefined, preEffect, by) : undefined;
      // Every runtime authority check precedes the final write, including revocations during the metadata await.
      const current = this.need(task.id, false, preEffect);
      if (current.history.length !== task.history.length) throw new (preEffect ? PreEffectToolRefusal : Error)("task changed during reviewer admission");
      if (by !== USER) {
        const holders = Object.entries(this.d.roles ?? {}).filter(([, roles]) => Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
        if (holders.length !== 1 || holders[0] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the configured conductor may name a reviewer");
      }
      if (!this.d.bus.isRostered(peer)) throw new (preEffect ? PreEffectToolRefusal : Error)(`${peer} is off roster`);
      this.requireCapabilities(current, peer, role, preEffect);
      const eligible = assign(current, this.states(), this.d.routing(), { candidates: [], namedReviewer: peer, ...(current.owner ? { notReviewer: current.owner } : {}), ...this.weights(current.class, current) });
      if (eligible.reviewer !== peer) throw new (preEffect ? PreEffectToolRefusal : Error)("reviewer is no longer eligible");
      const next = this.d.board.update(task.id, by, "reviewer changed", { reviewer: peer }, this.assignmentNote(`named reviewer ${peer}`, a), { reason: "manual" }, expectedFlowRevision);
      if (next.state === "in_review" && task.reviewer && task.reviewer !== peer) {
        this.withdrawRoleRequest(task, next, "reviewer");
      }
      if (next.state === "in_review" && peer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${peer}`, () => this.sendReview(next, peer, "", admission));
      return next;
    }
    // Work that waits is handed to nobody yet (issue #207): the peer becomes its reserved owner instead.
    if (!this.waitsFor(task).length) return this.assignOwner(task, by, { candidates: [peer], namedOwner: peer, event: "reassigned", reason: "manual", override: by === USER, expectedFlowRevision, refuseNamed: preEffect ? "pre" : "plain" });
    const next = this.d.board.update(task.id, by, "reserved", { reserved: peer }, `for ${peer}`, { reason: "manual" }, expectedFlowRevision);
    this.releaseNotice(`task ${this.publicTitle(next)} reserved for ${peer} by ${by}; it is offered to ${peer} first once what it waits for is approved`);
    return next;
  }

  /** Person-only removal without routing a replacement. The history marker suppresses later automatic owner offers. */
  async unassign(id: unknown, by: PeerId = USER, preEffect = false, role: TaskAssignmentRole = "owner", expectedFlowRevision?: number): Promise<Task> {
    if (by !== USER) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user may unassign a task role");
    if (role !== "owner" && role !== "reviewer") throw new (preEffect ? PreEffectToolRefusal : Error)("role must be owner or reviewer");
    const task = this.need(id, false, preEffect);
    this.checkFlowRevision(task, expectedFlowRevision, preEffect);
    if (isClosedTaskState(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its ${role} is historical`);
    if (role === "owner") {
      if (!OPEN.includes(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its owner cannot be unassigned`);
      if (!task.owner && !task.reserved) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: no owner or owner reservation to unassign`);
      const next = this.d.board.update(task.id, by, "unassigned", { owner: null, reserved: null, ...(task.state === "proposed" ? {} : { state: "proposed" as const }) }, `person unassigned ${[task.owner, task.reserved].filter(Boolean).join(" and ")}`, { reason: "manual" }, expectedFlowRevision);
      this.cohorts.leave(task.id);
      this.withdrawRoleRequest(task, next, "owner");
      return next;
    }
    if (!OPEN.includes(task.state) && task.state !== "in_review") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its reviewer cannot be unassigned`);
    if (!task.reviewer) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: no reviewer to unassign`);
    if (task.reviewer === USER && this.isPii(task)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id}: the human reviewer is required for PII work`);
    const next = this.d.board.update(task.id, by, "reviewer changed", { reviewer: null }, `person unassigned reviewer ${task.reviewer}`, { reason: "manual" }, expectedFlowRevision);
    this.withdrawRoleRequest(task, next, "reviewer");
    return next;
  }

  /**
   * Budget relay: a paused peer's open work moves on. `local` first (it has no quota), then the class list, all through
   * the usual constraints. Tasks it was reviewing get another reviewer. Moves are reported, never taken back automatically.
   */
  async reassignForPause(peer: PeerId, context: string | undefined, urgentOnly = false): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    return this.reassignWork(peer, context, urgentOnly, false);
  }

  /** Read-only preview using the same assignment constraints as the roster relay. */
  rosterPreview(peer: PeerId): { id: number; title: string; role: "owner" | "reviewer"; to: PeerId | null }[] {
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
  async reassignForRoster(peer: PeerId): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    return this.reassignWork(peer, undefined, false, true);
  }

  private async reassignWork(peer: PeerId, context: string | undefined, urgentOnly: boolean, roster: boolean): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    const moved: { id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[] = [];
    const routing = this.d.routing(), why = roster ? `roster removal of ${peer}` : `budget pause of ${peer}`;
    // Budget context is screened exactly as before; a roster removal supplies no agent-written context.
    const moves = (t: Task) => (!urgentOnly || t.signals.includes("urgent")) && t.owner === peer && OPEN.includes(t.state);
    const contextWithheld = context && this.d.board.list().some((t) => moves(t) && !this.isPii(t)) ? await this.withholds("handoff", context) : false;
    for (const task of this.d.board.list()) {
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
          next = await this.assignOwner(back, HUB, { candidates, exclude: [peer], event: "reassigned", reason: roster ? "manual" : "budget", note: why, ...(roster ? { roster: true } : { clearOnFail: true }), ...(context ? { context, contextWithheld } : {}) });
        } catch (e) {
          // The move is saved and its central #297 notice already spoke; relay the
          // remaining tasks and run the roster tail on the saved row as on success.
          if (!(e instanceof AssignmentUndeliveredError)) throw e;
          next = e.task;
        }
        if (!this.ownOwnerMove(back, next, HUB, "reassigned") && !this.ownOwnerMove(back, next, HUB, "unassigned")) continue;
        if (roster) {
          if (!next.owner || next.owner === peer) continue;
          this.releaseNotice(`task ${this.publicTitle(next)} moved from ${peer} to ${next.owner} (off roster)`);
          if (next.state === "in_review" && next.reviewer && next.reviewer !== task.reviewer && next.reviewer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${next.reviewer}`, () => this.sendReview(next, next.reviewer!, `(${peer} owned this and is off roster.)`));
        }
        moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner, role: "owner" });
      } else if (task.reviewer === peer && !isClosedTaskState(task.state)) {
        const a = assign(task, this.states(), routing, { exclude: [peer], candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class, task) });
        const reviewer = a.reviewer && a.reviewer !== peer && a.reviewer !== task.owner ? a.reviewer : null;
        if (roster && !reviewer) {
          this.releaseNotice(`task ${this.publicTitle(task)}: its reviewer ${peer} is off roster and nobody else can review; the reviewer stays ${peer}; use ahub review ${task.id}`);
          continue;
        }
        const next = this.d.board.update(task.id, HUB, "reviewer changed", { reviewer }, this.assignmentNote(why, a), this.reviewMetadata(a));
        moved.push({ id: task.id, title: this.publicTitle(task), to: reviewer, role: "reviewer" });
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
    const args = correctionInput(input);
    const st = this.d.store;
    if (!st || !this.d.candidates) throw new PreEffectToolRefusal("memory correction unavailable");
    const screen: MemoryScreen = rows => this.d.candidateScreen?.(rows) ?? withoutPii(rows, this.d.routing(), this.d.cwd, this.d.piiPaths ?? []);
    const valid = () => {
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
    const text = composeRememberText(input);
    const task = input.task !== undefined ? this.d.board.get(Number(input.task)) : undefined;
    if (task && this.isPii(task)) throw new Error("notes about a PII task are not saved: claude-mem processes what it stores with a cloud model");
    // Shared with every other peer as well, so text that matches a PII pattern is refused like a note about a PII task.
    const title = String(input.title ?? "").trim();
    if (this.isPii({ signals: detectSignals({ title, detail: text, refs: {} }, this.d.routing(), this.d.cwd) })) throw new Error("this note matches a PII pattern and is not saved: claude-mem processes what it stores with a cloud model");
    if (input.horizon !== undefined && input.horizon !== "short" && input.horizon !== "long") throw new Error('horizon is "short" or "long"');
    if (input.scope !== undefined && input.scope !== "project" && input.scope !== "shared") throw new Error('scope is "project" or "shared"');
    if (!this.d.memory && !this.d.store) return "memory is disabled; nothing saved";
    // Long-term notes leave the machine (#258), and claude-mem's observer is a cloud model: a secret goes to neither.
    if (looksSecret(`${title}\n${text}`)) throw new Error("this note looks like it holds a secret (a key, token or password) and is not saved");
    if (this.aboutPrivatePath(title, text, task)) throw new Error("this note is about a path the project keeps private (pii.paths) and is not saved");
    if (await this.withholds("note", `${title}\n${text}`, task)) throw new Error("the PII screen did not clear this note, so it is not saved: claude-mem processes what it stores with a cloud model");
    const kind = (NOTE_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) as Kind : "finding";
    const native = this.saveNative(by, kind, text, title, task, input.horizon === "long" || input.horizon === "short" ? input.horizon : undefined, input.scope === "shared" ? "shared" : "project");
    if (task && this.d.memory) this.markMemoryReference(task, by);
    const res = this.d.memory ? await this.d.memory.save({ text, ...(title ? { title } : {}), project: this.d.project, metadata: { peer: by, kind, ...(task ? { task: task.id } : {}) } }) : undefined;
    if (!res && !native) return this.d.memory ? "memory worker unavailable; nothing saved" : "memory store unavailable; nothing saved";
    const line = noteLine(by, kind, title ? `${title}: ${text}` : text);
    this.d.notify(line);
    // Display identity only: a queued recall may already contain this saved entry. Stored/captured text stays unchanged.
    this.d.share?.(by, native ? noteLine(by, kind, `mem:${native.id} ${title ? `${title}: ` : ""}${text}`) : line);
    return `saved to shared memory${native ? ` (hub memory ${native.id.slice(0, 8)}, ${native.tier}-term${this.d.memory && !res ? "; claude-mem unavailable" : ""})` : ""}; the other agents get it with their next message`;
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
  private saveNative(by: PeerId, kind: Kind, text: string, title: string, task: Task | undefined, horizon?: Tier, scope: Scope = "project"): { id: string; tier: Tier } | undefined {
    const st = this.d.store;
    if (!st || (task && this.isPii(task))) return undefined;
    try { // never throws: callers run after a board write
      this.d.memoryCheck?.();
      // Approved, or settled in the store already: the snapshot the caller holds can predate an approval made while it awaited.
      const approved = !!task && (task.state === "approved" || st.store.settled(this.memoryKey(task)));
      const tier: Tier = horizon ?? (approved && PROMOTED_KINDS.includes(kind) ? "long" : "short");
      const about = extractNodes(`${title}\n${text}`, { cwd: this.d.cwd, project: st.project, repo: st.repo, deny: st.deny, paths: [...(task?.refs.paths ?? []), ...(task?.plan?.paths ?? [])], symbols: task?.plan?.symbols, ...(task ? { task: { id: task.id, created: task.created } } : {}) });
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
  private note(task: Task, by: PeerId, kind: Kind, text: string, withheld = false): void {
    if (this.isPii(task) || (!this.d.memory && !this.d.store)) return;
    // claude-mem's observer is a cloud model: model-written text that matches a PII pattern, or that the PII screen did
    // not clear (#198), is not sent (#69). Long-term hub memory leaves the machine (#258): the same rule, and no secrets.
    if (withheld || !this.nameable(text)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (${this.whyWithheld(text)})`);
    if (looksSecret(text)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (it looks like it holds a secret)`);
    const title = `agent-hub task #${task.id}: ${task.title}`.slice(0, 120);
    if (this.aboutPrivatePath(title, text, task)) return this.releaseNotice(`task #${task.id}: a ${kind} note was not saved to shared memory (it is about a private path)`);
    this.saveNative(by, kind, text, title, task);
    if (this.d.memory) {
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
