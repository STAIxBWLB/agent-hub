import { actualTaskDates, planningPatch, type PlanningFields, type Release, type ReleaseState } from "./planning.ts";
import { readMergeQueue } from "./sdlc-queue.ts";
import { readReleaseReadiness } from "./sdlc-release.ts";
import { loadRoleCatalog, taskRole, taskRoleText, type RoleCatalog } from "./roles.ts";
import { matchesPolicy } from "./path-policy.ts";
import { mentionsPrivatePath } from "../memory/recall.ts";
import { profileClass, profileData, profileTaskLabel, projectProfile, type ProfileName, type ProfileSelection, type ProjectProfile } from "./profiles.ts";
import { phaseView, validatePhaseLinks, workflowHash } from "./workflow.ts";
import { isAbsolute, relative } from "node:path";
import type { Briefs } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { extractNodes, looksSecret, PROMOTED_KINDS, taskKey, type GoalView, type Kind, type MemoryStore, type Scope, type Tier } from "../memory/store.ts";
import { CLASSES, OUTCOMES_KEPT_MS, ALL_PLAN_KEYS, TASK_MOVE_REASONS, taskHasStarted, planningUndoEntry, type HistoryEntry, type Board, type Task, type TaskClass, type TaskMoveReason, type TaskPlan, type TaskRefs } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, NOTE_KINDS, noteLine, sanitize, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import type { PiiVerdict, ScreenItem, ScreenRecord } from "./inference.ts";
import { assign, detectSignals, LOCAL, peerEntry, PI, predictSplit, type Assignment, type Routing, type SplitObservation, type SplitPrediction } from "./routing.ts";
import { ExecutionBudget, type ExecutionBudgetConfig, type ExecutionBudgetDecision, type ExecutionBudgetStatus, type ExecutionUnit } from "./execution-budget.ts";
import { Cohorts, MAX_REQUESTS, type Cohort, type Completion } from "./cohorts.ts";
import { realPath } from "./project.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { SUPPORTED_PEERS } from "./peer-catalog.ts";
import { nextSweep, taskSweepConfig, type TaskSweepConfig, type SweepRecord } from "./task-sweep.ts";
import { readSdlcPr, sdlcConfig, sdlcReceipt, sdlcStatus, stageDefinition, lifecycleStage, type SdlcConfig, type SdlcGh, type SdlcStatus } from "./sdlc.ts";

export type TaskAssignmentRole = "owner" | "reviewer";

export interface TasksDeps {
  /** Effective per-peer planner capacity, taken from the existing settings loader. */
  wipLimit?: (peer: PeerId) => number;
  recordPlanning?: (change: { by: string; task?: number; release?: number; fields: string[]; revision: number }) => void;
  board: Board;
  bus: Bus;
  routing: () => Routing;
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
  sdlc?: { config: () => SdlcConfig; gh?: SdlcGh };
  briefs?: Briefs;
  memory?: MemoryClient;
  /** #258: the hub's own store, the project name it files entries under (the git chain) and the repo `#N` issues belong to. */
  store?: { store: MemoryStore; project: string; repo: string; deny?: string[] };
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
  review?: { adaptive: boolean; min_reviews: number };
  /** Peers whose recent deliveries all failed, with the reason (issue #89); routing skips them. */
  failing?: () => Record<PeerId, string>;
  /** Peers whose queue a needs_review delivery holds, with the hold detail (issue #90); routing explains the hold, never rejects. */
  held?: () => Record<PeerId, string>;
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
}

const ESCALATE_AFTER = 2;
// Demotion (issue #36): a failure counts half after a day. A peer is demoted for a class once its decayed failures
// reach 1.5 (two within about half a day, three within two days) and outweigh its decayed successes there.
// ponytail: fixed constants; make them config when someone needs to tune them.
const DEMOTION_HALF_LIFE_MS = 24 * 3_600_000;
const DEMOTE_AT = 1.5;
/** An approval counts as contradicted when work on the same places fails within this window (issue #35). */
const CONTRADICTION_WINDOW_MS = 7 * 86_400_000;
const OPEN: Task["state"][] = ["proposed", "in_progress", "changes_requested"];
/** Board events that leave a task where its completion check found it; any other event means it moved on meanwhile. */
const QUIET_EVENTS = new Set(["answer", "reviewer changed", "idle sweep"]);

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

/** The same for a plan (issue #31): only its four lists, each of short strings. */
function cleanPlan(input: unknown, profile: ProfileSelection = "dev"): TaskPlan {
  const r = fields(input);
  return Object.fromEntries((profileData(profile).plan_keys as (keyof TaskPlan)[]).map((k) => [k, k === "paths" ? [...new Set(textList(r[k]).map(normPath))] : textList(r[k])] as const).filter(([, v]) => v.length));
}

/** A plan as one line for other owners; the whole plan is on the board. */
const planText = (plan: TaskPlan = {}) => ALL_PLAN_KEYS.filter((k) => plan[k]?.length).map((k) => `${k.replace("_", " ")}: ${plan[k]!.join("; ")}`).join(" | ");
/** What the PII screen reads of a task (#198): the text the patterns are checked against. */
const screenText = (t: { title: string; detail: string; plan?: TaskPlan }) => [t.title, t.detail, planText(t.plan)].join("\n");
/** Re-screens of one task whose verdict was unknown, per hub run (#198). */
const RESCREEN_MAX = 10;

/**
 * The task flow. Adapters and tools never touch the board: every change comes through here, where assignment,
 * PII handling, envelopes, briefs and memory notes are decided in one place.
 */
export class Tasks {
  private readonly incomingBacklog = new Set<number>();
  /** Turn-free cohorts (issue #107): who works without messages, and who integrates. */
  readonly cohorts: Cohorts;
  private readonly sweepConfig: TaskSweepConfig;
  private sweeping = false;

  constructor(private readonly d: TasksDeps) {
    for (const task of d.board.list("backlog")) this.incomingBacklog.add(task.id);
    this.sweepConfig = taskSweepConfig(d.sweep);
    this.cohorts = new Cohorts({
      silence: (owners) => this.turnFree() && owners.every((p) => p !== USER && p !== HUB && (this.d.capable?.(p) ?? false)),
      idle: (peer) => this.d.idle?.(peer) ?? false,
    });
    // What the on-prem worker says about a PII task is private on the bus (console tail and log show a stub), so the
    // board keeps the text: `ahub task show <id>` is where the console user reads it, a refusal included.
    d.bus.tap((e) => {
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

  private recordScreen(task: number | undefined, item: ScreenItem, v: PiiVerdict | undefined): void {
    const record: ScreenRecord = !v
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
    if (!this.sweepConfig.enabled || this.sweeping || this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) return recorded;
    this.sweeping = true;
    try {
      for (const task of this.d.board.list()) {
        if (this.d.sweepHeld?.() || this.d.bus.isRecoveryHeld || this.d.bus.storageError) break;
        const finding = nextSweep(task, this.sweepConfig, now);
        if (!finding || this.waitsFor(task).length || this.isChecking(task.id) || this.silentFor(task.id)) continue;
        const responsible = finding.kind === "review-pending" ? task.reviewer! : task.owner!;
        if (responsible !== USER && !this.sweepAvailable(responsible)) continue;
        const title = this.publicTitle(task);
        const message = `Task ${title}: ${finding.kind}, idle escalation ${finding.step}/3.`;
        // Only identifiers, kind and step are kept in the ladder event. A crash after this write and before publish
        // leaves the notice unpublished or uncertain; the durable-delivery journal owns any delivery retries.
        this.d.board.update(task.id, HUB, "idle sweep", {}, undefined, { sweep: finding });
        recorded.push({ task: task.id, finding });
        if (finding.step === 1) {
          this.sweepNotice(task, responsible, `${message} Check its current state with hub_task_list and accept, complete or review your assigned work.`);
        } else if (finding.step === 2) {
          this.d.notify(message);
          for (const [peer, roles] of Object.entries(this.d.roles ?? {})) {
            if (peer !== responsible && roles.includes("planner") && this.sweepAvailable(peer)) this.sweepNotice(task, peer, `${message} The assigned ${finding.kind === "review-pending" ? "reviewer" : "owner"} has not recorded fresh task activity; check the board before coordinating.`);
          }
        } else {
          const reviewer = finding.kind === "review-pending";
          const a = assign(task, this.states(), this.d.routing(), { exclude: [...this.excluded(task), responsible], waitsFor: this.waitsFor(task), ...(reviewer ? { candidates: [], notReviewer: task.owner ?? undefined } : {}), ...this.weights(task.class) });
          const candidate = reviewer ? a.reviewer : a.owner;
          this.passedOver(task, a);
          this.d.notify(`${message} ${reviewer ? "Reviewer" : "Owner"} reassignment suggestion: ${candidate ?? "no eligible peer"}.`);
          if (!reviewer && candidate && this.sweepConfig.auto_reassign && this.sweepAvailable(candidate)) {
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

  private sweepAvailable(peer: PeerId): boolean {
    const bus = this.d.bus;
    return bus.stateOf(peer) === "idle" && (this.d.idle?.(peer) ?? true) && !peerEntry(this.d.held?.(), peer) && !bus.queueSummary(peer).heldBy && !bus.queued(peer) && !bus.hasInFlight(peer);
  }

  private sweepNotice(task: Task, peer: PeerId, body: string): void {
    if (peer === USER) this.d.notify(body);
    else this.d.bus.publish(newEnvelope(HUB, body, { to: [peer], kind: "task", refs: { task: String(task.id) } }));
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
    const { title, detail, history, ...rest } = task;
    if (this.isPii(task)) return { ...rest, actualDates: actualTaskDates(task), refs: {}, plan: {}, ...(task.sdlc ? { sdlc: { stage: stageDefinition(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc.stage)?.base ?? "unknown" } } : {}), title: "[pii]", detail: "[pii]" };
    const screenHistoryText = (text: string, field: string, withheld = false): string => !withheld && this.nameable(text) ? text : `[history ${field} withheld: ${this.whyWithheld(text)}; ahub task show ${task.id}]`;
    const publicHistory = (fullHistory ? history : history.slice(-5)).map(h => ({
      at: h.at, by: h.by, event: h.event,
      ...(h.note === undefined ? {} : { note: screenHistoryText(h.note, "note", h.withheld) }),
      ...(h.profile === undefined ? {} : { profile: screenHistoryText(h.profile, "profile") }),
      ...(h.owner === undefined ? {} : { owner: h.owner }),
      ...(h.planning ? { planning: { revision: h.planning.revision, fields: h.planning.fields, ...(h.planning.split ? { children: h.planning.split.children.map(child => child.id) } : {}) } } : {}),
      ...(h.reason && TASK_MOVE_REASONS.includes(h.reason) ? { reason: h.reason } : {}),
      ...(h.sweep ? { sweep: { kind: h.sweep.kind, activity: h.sweep.activity, step: h.sweep.step, at: h.sweep.at } } : {}),
    }));
    return { ...rest, actualDates: actualTaskDates(task), ...(((this.d.sdlc?.config().mode ?? "off") !== "off" || this.d.sdlc?.config().workflow === "gsd-lite") ? { lifecycle: sdlcStatus(this.d.sdlc?.config() ?? sdlcConfig(undefined), task.sdlc, undefined, this.workflowView(task)) } : {}), title, detail, history: publicHistory };
  }

  /** Console results expose direct approval and delivery holds, not just the chosen peer ids. */
  resultLine(task: Task): string {
    const base = `task #${task.id}: ${task.state}, owner ${task.owner ?? "none"}, reviewer ${task.reviewer ?? "none"}`;
    const noReview = task.class !== "review" && !task.reviewer && OPEN.includes(task.state) && !this.waitsFor(task).length
      ? this.noReviewer(assign(task, this.states(), this.d.routing(), { candidates: task.owner ? [task.owner] : [], notReviewer: task.owner ?? undefined, ...this.weights(task.class) }))
      : undefined;
    const held = task.owner ? peerEntry(this.d.held?.(), task.owner) : undefined;
    const holdText = held ? `${task.owner}'s queue is held (${held}); it receives the task once the hold is resolved` : undefined;
    return [base, noReview, holdText].filter(Boolean).join("; ");
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

  /** Peer health and roles the daemon feeds routing (issues #89, #90, #92): failing peers are skipped, held queues explained. */
  private health() {
    const failing = this.d.failing?.();
    const held = this.d.held?.();
    return { pullOnly: [...this.d.bus.peers.values()].filter(peer => peer.id === "kimi" && peer.pullOnly).map(peer => peer.id), offRoster: SUPPORTED_PEERS.filter(peer => !this.d.bus.isRostered(peer)), ...(failing ? { failing } : {}), ...(held ? { held } : {}), ...(this.d.roles ? { roles: this.d.roles } : {}) };
  }

  /** What assignment weighs besides states and policy: quota, demotion and the review record. */
  private weights(cls: TaskClass) {
    const now = Date.now();
    const quota = this.d.quota?.();
    return { ...this.health(), now, demoted: this.demoted(cls, now), reviews: this.reviewRecord(cls), ...(quota ? { quota } : {}), ...(this.d.review?.adaptive ? { adaptive: { min: this.d.review.min_reviews } } : {}) };
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

  wipLimit(peer: PeerId): number {
    const limit = this.d.wipLimit?.(peer) ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 32) throw new PreEffectToolRefusal("invalid planner WIP capacity");
    return limit;
  }
  private plannerPullRecord(task: Task): HistoryEntry["planning"] {
    return task.history.findLast(entry => entry.event === "backlog pulled" || entry.event === "backlog returned")?.planning;
  }
  wip(peer: PeerId, except?: number): number {
    return this.d.board.list().filter(task => task.id !== except && task.state !== "approved" && task.state !== "backlog" && (task.owner === peer || !task.owner && task.state === "proposed" && task.reserved === peer && this.plannerPullRecord(task)?.pull)).length;
  }
  private prerequisiteOf(task: Task, prerequisite: number): boolean {
    const pending = [...(task.deps ?? [])], seen = new Set<number>();
    while (pending.length) { const id = pending.pop()!; if (id === prerequisite) return true; if (seen.has(id)) continue; seen.add(id); pending.push(...(this.d.board.get(id)?.deps ?? [])); }
    return false;
  }
  private plannerAssignment(task: Task, reservedOnly = false): Assignment {
    const states = this.states();
    const full = Object.keys(states).filter(peer => {
      const queue = this.d.bus.queueSummary(peer);
      return this.wip(peer, task.id) >= this.wipLimit(peer) || !!queue.heldBy || queue.needsReview > 0;
    });
    // Preview the To Do transition without routing or offering the persisted backlog row.
    return assign({ ...task, state: "proposed" }, states, this.d.routing(), { exclude: [...this.excluded(task), ...full], ...(reservedOnly ? { candidates: task.reserved ? [task.reserved] : [], ...(task.reserved ? { namedOwner: task.reserved } : {}) } : {}), waitsFor: this.waitsFor(task), ...this.weights(task.class) });
  }

  async pullPlanned(by: PeerId, input: { id: number; revision: number; reason: string }): Promise<Task> {
    this.planningAuthority(by);
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new PreEffectToolRefusal("planner pull needs an id, revision and bounded reason");
    const validate = () => {
      const task = this.d.board.get(input.id);
      if (!task || (task.planningRevision ?? 0) !== input.revision || task.state !== "backlog" || task.owner || taskHasStarted(task) || task.pinned) throw new PreEffectToolRefusal("planner pull changed, pinned or already started");
      const release = task.release == null ? undefined : this.d.board.release(task.release);
      if (task.release != null && (!release || ["frozen", "shipped", "dropped"].includes(release.state))) throw new PreEffectToolRefusal("planner pull requires unfrozen release scope");
      if (this.waitsFor(task).length) throw new PreEffectToolRefusal("planner pull waits for dependency approval");
      const priority = task.priority ?? (task.signals.includes("urgent") ? 0 : 2);
      if (priority === 0 && this.d.board.list("backlog").some(other => {
        if (other.id === task.id || this.prerequisiteOf(other, task.id) || (other.priority ?? (other.signals.includes("urgent") ? 0 : 2)) !== 0 || other.rank == null || !other.history.some(entry => entry.by === USER && entry.planning?.fields.includes("rank"))) return false;
        const ancestors = this.d.board.list("backlog").filter(goal => this.prerequisiteOf(goal, task.id) && (goal.priority ?? (goal.signals.includes("urgent") ? 0 : 2)) === 0 && goal.rank != null && goal.history.some(entry => entry.by === USER && entry.planning?.fields.includes("rank")));
        const order = [{ rank: task.rank ?? Number.MAX_SAFE_INTEGER, id: task.id }, ...ancestors.map(goal => ({ rank: goal.rank!, id: goal.id }))].sort((a,b) => a.rank-b.rank || a.id-b.id)[0]!;
        return other.rank < order.rank || other.rank === order.rank && other.id < order.id;
      })) throw new PreEffectToolRefusal("a person's P0 backlog order is retained");
      const assignment = this.plannerAssignment(task);
      if (!assignment.owner) throw new PreEffectToolRefusal("no peer has eligible planner WIP capacity");
      const reservation = task.history.findLast(entry => entry.event === "reserved" || entry.planning?.fields.includes("reserved")) ?? (task.history[0]?.event === "backlogged" ? task.history[0] : undefined);
      if (task.reserved && reservation?.by === USER && assignment.owner !== task.reserved) throw new PreEffectToolRefusal("a person's reservation is retained");
      return { task, owner: assignment.owner };
    };
    const initial = validate(), withheld = await this.withholds("note", input.reason, initial.task);
    const current = validate();
    const pulled = this.d.board.pullPlanned(current.task.id, by, current.owner, input.revision, input.reason.trim(), withheld);
    this.planningRecorded({ by, task: pulled.id, fields: ["pull", "reserved"], revision: pulled.planningRevision! });
    return pulled;
  }

  backlogList(by: PeerId): Record<string, unknown>[] {
    this.planningAuthority(by);
    return this.d.board.list("backlog").sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id).map(task => this.publicView(task));
  }
  /** One bounded ids-only notice on the daemon's existing periodic tick. */
  flushPlannerNotices(): number {
    const planners = Object.entries(this.d.roles ?? {}).filter(([peer, roles]) => roles.includes("planner") && this.d.bus.isRostered(peer) && this.d.bus.peers.has(peer) && this.d.bus.stateOf(peer) !== "offline").map(([peer]) => peer);
    if (!planners.length) return 0;
    for (const id of this.incomingBacklog) if (this.d.board.get(id)?.state !== "backlog") this.incomingBacklog.delete(id);
    const ids = [...this.incomingBacklog].sort((a, b) => a - b).slice(0, 64);
    if (!ids.length) return 0;
    const queued = this.d.bus.publish(newEnvelope(HUB, `Backlog items ${ids.map(id => `#${id}`).join(", ")}. Read hub_backlog_list and plan the next work with a reason for each change.`, { to: planners, kind: "task", refs: { backlog: ids } }));
    if (planners.every(peer => queued.includes(peer))) for (const id of ids) this.incomingBacklog.delete(id);
    return ids.length;
  }
  releaseList(by: PeerId): Record<string, unknown>[] {
    this.planningAuthority(by);
    const tasks = this.d.board.list();
    return this.d.board.releases().map(release => ({ ...release,
      name: this.nameable(release.name) ? release.name : "[withheld]",
      goal: this.nameable(release.goal) ? release.goal : "[withheld]",
      tasks: tasks.filter(task => task.release === release.id).map(task => ({ id: task.id, state: task.state, deps: task.deps ?? [] })),
    }));
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
      if (task.state === "approved") throw new PreEffectToolRefusal("approved work is final");
      if (by !== USER && (task.state !== "backlog" || taskHasStarted(task) || task.pinned || Object.hasOwn(patch, "pinned"))) throw new PreEffectToolRefusal("planner changes only unpinned backlog work");
      if (by !== USER && patch.rank !== undefined && task.history.some(entry => entry.by === USER && entry.planning?.fields.includes("rank"))) throw new PreEffectToolRefusal("a person's backlog order is retained");
      if (Object.hasOwn(patch, "deps") || Object.hasOwn(patch, "reserved")) {
        if (task.state !== "backlog" || taskHasStarted(task) || task.owner) throw new PreEffectToolRefusal("dependency and reservation changes require unstarted backlog work");
        if (patch.reserved && !(SUPPORTED_PEERS as readonly string[]).includes(patch.reserved) && !this.d.bus.knownPeers().includes(patch.reserved) && !this.d.routing().classes[task.class]?.peers.includes(patch.reserved)) throw new PreEffectToolRefusal("reserved owner is not a supported or configured peer");
        if (patch.reserved && !this.d.bus.isRostered(patch.reserved)) throw new PreEffectToolRefusal("reserved owner is off roster");
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
      if (task.state !== "backlog" || task.owner || taskHasStarted(task) || by !== USER && (task.pinned || release && ["frozen", "shipped", "dropped"].includes(release.state))) throw new PreEffectToolRefusal("split undo is no longer eligible");
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
      const catalog = this.d.catalog ?? loadRoleCatalog(this.d.cwd), profile = parent.profile ?? this.d.profile ?? "dev";
      const drafts = rows.map((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).some(key => !["title", "detail", "class", "refs", "plan", "after", "afterParts"].includes(key)) || typeof part.title !== "string" || !part.title.trim() || part.title.length > 300 || part.detail !== undefined && (typeof part.detail !== "string" || part.detail.length > 8000) || part.class !== undefined && typeof part.class !== "string") throw new PreEffectToolRefusal("invalid split part");
        const given = part.class ?? parent.profileClass ?? parent.class;
        let cls: TaskClass;
        try { cls = profileClass(given as string, this.d.profileData ?? profile); } catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
        const after = part.after ?? [], afterParts = part.afterParts ?? [];
        if (!Array.isArray(after) || after.length > 64 || after.some(dep => !Number.isSafeInteger(dep) || dep <= 0) || new Set(after).size !== after.length || !Array.isArray(afterParts) || afterParts.length > 8 || afterParts.some(dep => !Number.isSafeInteger(dep) || dep < 0 || dep >= index) || new Set(afterParts).size !== afterParts.length) throw new PreEffectToolRefusal("split dependencies must name existing tasks or earlier parts");
        const deps = [...new Set([...(parent.deps ?? []), ...after as number[]])], pending = [...deps], seen = new Set<number>();
        while (pending.length) { const dependency = pending.pop()!; if (dependency === id) throw new PreEffectToolRefusal("split dependency reaches its parent"); if (seen.has(dependency)) continue; seen.add(dependency); const task = this.d.board.get(dependency); if (!task) throw new PreEffectToolRefusal("split dependency is missing"); pending.push(...(task.deps ?? [])); }
        const refs = part.refs === undefined ? parent.refs : cleanRefs(part.refs), plan = cleanPlan(part.plan, this.d.profileData ?? profile);
        const draft = { title: part.title.replace(/\s+/g, " ").trim(), detail: part.detail as string | undefined ?? "", class: cls, refs, plan, deps, afterParts: afterParts as number[], ...(parent.role && cls === parent.class ? { role: taskRole(parent.role, cls, catalog)?.id } : {}), ...(parent.profile ? { profile: parent.profile, profileClass: given as string } : {}) };
        const fields: PlanningFields = {};
        for (const key of ["priority", "release", "plannedStart", "due"] as const) if (parent[key] !== undefined) fields[key] = parent[key];
        return { ...draft, fields };
      });
      return { parent, drafts };
    };
    const initial = validate(), verdicts: (PiiVerdict | undefined)[] = [];
    for (const part of initial.drafts) verdicts.push(this.screenOn() && !this.isPii(initial.parent) ? await this.screenCall(screenText({ title: part.title, detail: part.detail, plan: part.plan })) : undefined);
    const withheld = await this.withholds("note", reason, initial.parent), current = validate();
    const drafts = current.drafts.map((part, index) => ({ ...part, signals: [...new Set([...this.signalsFor({ ...part, detail: [part.detail, planText(part.plan)].join("\n") }), ...current.parent.signals.filter(signal => ["pii", "pii_path", "urgent"].includes(signal)), ...(verdicts[index] && verdicts[index]!.label !== "clear" ? ["pii"] : [])])] }));
    const result = this.d.board.splitBacklog(id, by, revision, drafts, reason, withheld);
    for (const child of result.children) this.incomingBacklog.add(child.id);
    this.planningRecorded({ by, task: id, fields: ["split", "deps"], revision: result.parent.planningRevision! });
    return result;
  }

  async newRelease(by: PeerId, input: { name: string; goal: string; order: number }): Promise<Release> {
    this.planningAuthority(by);
    if (typeof input.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name) || typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 1000 || !Number.isSafeInteger(input.order) || input.order < 0) throw new PreEffectToolRefusal("invalid release name, goal or order");
    const text = input.name + "\n" + input.goal;
    if (!this.nameable(text) || this.screenOn() && (await this.screenCall(text)).label !== "clear") throw new PreEffectToolRefusal("release text was not cleared for public planning");
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
    if (input.state === "shipped" && this.d.board.list().some(task => task.release === release.id && task.state !== "approved")) throw new PreEffectToolRefusal("every release task must be approved or moved out before ship");
    const { id, revision, ...patch } = input;
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !["state", "plannedStart", "cut", "ship"].includes(key))) throw new PreEffectToolRefusal("unknown or empty release fields");
    const updated = this.d.board.updateRelease(id, patch, revision);
    this.planningRecorded({ by, release: id, fields: Object.keys(patch), revision: updated.revision });
    return updated; // a failed readback may follow a durable release write
  }

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; role?: unknown; refs?: TaskRefs; plan?: TaskPlan; owner?: PeerId; after?: unknown; urgent?: unknown; backlog?: unknown; goal?: unknown }): Promise<Task> {
    if (input.backlog !== undefined && typeof input.backlog !== "boolean") throw new PreEffectToolRefusal("backlog must be a boolean");
    const backlog = input.backlog === true;
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
    const signals = this.signalsFor({ ...text, detail: [text.detail, planText(plan)].join("\n"), plan });
    // Urgent work is handed over even when its paused owner's window resets soon (issue #36).
    if (input.urgent === true && !signals.includes("urgent")) signals.push("urgent");
    // The PII screen (issue #198) reads the same text before anything else does: until its verdict the task is on no
    // board, in no envelope and before no other model. A pattern match is PII without a call; no verdict is PII too.
    const screening = this.screenOn();
    const screened = screening && !signals.includes("pii") ? await this.screenCall(screenText({ ...text, plan })) : undefined;
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
    let selected;
    try { selected = taskRole(input.role, cls, this.d.catalog ?? loadRoleCatalog(this.d.cwd)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    const draft = { ...text, class: cls, ...(selected ? { role: selected.id } : {}), ...(profile !== "dev" || given !== undefined && given !== cls || this.d.profileData && this.d.profileData !== projectProfile("dev") ? { profile, profileClass: given ?? cls, ...(profile === "dev" ? { customProfile: true as const } : {}) } : {}) };
    let task = this.d.board.propose(by, { ...draft, plan, ...(deps.length ? { deps } : {}), ...(reserved ? { reserved } : {}), signals, ...(backlog ? { backlog: true } : {}) });
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
    return this.assignOwner(task, by, input.owner ? { candidates: [input.owner], namedOwner: input.owner, claim: input.owner === by } : {});
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
    const next = this.d.board.update(n, by, pull ? "backlog pulled" : "backlog returned", { state: pull ? "proposed" : "backlog", owner: null, reviewer: null });
    this.offered.delete(n);
    if (!pull) { this.incomingBacklog.add(n); return next; }
    const waits = this.waitsFor(next);
    if (waits.length) return this.d.board.update(n, HUB, "blocked", {}, `waits for ${waits.map(v => `#${v}`).join(", ")}`);
    // This persisted ready marker also lets a restart offer ownerless work once a peer attaches.
    const ready = this.d.board.update(n, HUB, "ready", {}, "pulled from backlog");
    return this.assignOwner(ready, by);
  }

  /** Where a screened task's `pii` signal came from, on its history and in events (issue #198); no verdict is a console line by id. */
  private screenedTask(task: Task, v: PiiVerdict | undefined): Task {
    this.recordScreen(task.id, "task", v);
    if (v?.label === "unknown") this.d.notify(`task #${task.id}: the PII screen gave no verdict (${v.miss}); it is handled as a PII task`);
    const note = !v ? "pii: regex" : v.label === "clear" ? "clear" : v.label === "pii" ? `pii: screen, ${v.category}` : `pii: unknown, ${v.miss}`;
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
    const env = newEnvelope(HUB, body, { to: [to], kind: "task", refs: { task: String(task) } });
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
        for (const id of current) this.incomingBacklog.add(id);
        return false;
      }
      return true;
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
  private places(task: Task): { paths: string[]; symbols: string[] } {
    const paths = [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])].map((p) => this.projectPath(p));
    return { paths: [...new Set(paths)], symbols: [...(task.plan?.symbols ?? []), ...(task.plan?.sections ?? []).map(v => `section ${v}`), ...(task.plan?.sources ?? []).map(v => `source ${v}`)] };
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
        if (!assign(task, this.states(), this.d.routing(), { exclude: [...this.excluded(task), peer], ...this.health() }).owner) continue;
        try {
          const back = task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, why) : task;
          const next = await this.assignOwner(back, HUB, { exclude: [peer], event: "reassigned", reason: "offline", note: why });
          moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner });
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
    const workflow = this.d.sdlc?.config().workflow === "gsd-lite" ? [`workflow: gsd-lite (${this.d.sdlc.config().mode}); checklist guidance, board dependencies authoritative`] : [];
    if (typeof target === "number") {
      const task = this.d.board.get(target);
      if (!task) throw new Error(`no task #${target}`);
      const a = assign(task, this.states(), routing, { exclude: this.excluded(task), waitsFor: this.waitsFor(task), ...this.weights(task.class) });
      // The split trace is for the pair the record is about: the task's owner when it has one (issue #109).
      return [...workflow, `task ${this.publicTitle(task)} (${task.state}, owner ${task.owner ?? "none"}${task.reserved ? `, reserved for ${task.reserved}` : ""})`, ...(task.profileClass ? [`profile class ${profileTaskLabel(task)}`] : []), ...(task.role ? [`task role ${task.role} (guidance only)`] : []), "if it were assigned now:", ...a.trace, ...(this.splitShadow(task, task.owner ?? a.owner)?.trace ?? [])];
    }
    const draft = { title: target.title, detail: target.detail ?? "", refs: target.refs ?? {} };
    const signals = this.signalsFor(draft, routing);
    const base = profileClass(target.class, this.d.profileData ?? this.d.profile);
    const trace = [...(this.d.profile && this.d.profile !== "dev" ? [`profile class ${target.class} (base ${base}, ${this.d.profile})`] : []), ...assign({ class: base, signals }, this.states(), routing, this.weights(base)).trace];
    // A draft is not sent to the PII screen (issue #198): a proposal is, and a pii or unknown verdict adds the pii signal.
    return [...workflow, ...(this.screenOn() && !signals.includes("pii") ? [...trace, "pii_screen is on: at proposal a pii or unknown verdict adds signal pii (local only)"] : trace)];
  }

  /** Public read path: every generated line is screened, including profile/config-derived trace fields. */
  publicExplain(target: number | { title: string; detail?: string; class: TaskClass; refs?: TaskRefs }, routing?: Routing): string[] {
    return this.explain(target, routing).map(line => this.nameable(line) ? line : "[routing explanation withheld: it matches a PII pattern]");
  }

  /**
   * Peers routing leaves out for good (#207): the owners a task was declined for (the console declines for one; older rows
   * name only the decliner) and the owners it was escalated away from, so a reservation never hands it back to them.
   */
  private excluded = (task: Task) => task.history.flatMap((h) => (h.event === "declined" ? [h.from ?? h.by] : h.event === "escalated" && h.from ? [h.from] : []));

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

  /** `override`: a person's explicit assign, which past refusals do not block and which drops an agent's reservation (#207). */
  private async assignOwner(task: Task, by: PeerId, opts: { candidates?: PeerId[]; namedOwner?: PeerId; event?: string; note?: string; reason?: TaskMoveReason; clearOnFail?: boolean; exclude?: PeerId[]; context?: string; contextWithheld?: boolean; claim?: boolean; override?: boolean; roster?: boolean; planner?: boolean } = {}): Promise<Task> {
    if (task.state === "backlog") throw new PreEffectToolRefusal(`task #${task.id}: pull backlog work before assigning it`);
    const waits = this.waitsFor(task);
    const plannerFull = opts.planner ? Object.keys(this.states()).filter(peer => { const queue = this.d.bus.queueSummary(peer); return this.wip(peer, task.id) >= this.wipLimit(peer) || !!queue.heldBy || queue.needsReview > 0; }) : [];
    const a = assign(task, this.states(), this.d.routing(), { exclude: [...(opts.override ? [] : this.excluded(task)), ...plannerFull, ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], ...(opts.candidates ? { candidates: opts.candidates } : {}), waitsFor: waits, ...this.weights(task.class), ...(opts.namedOwner ? { namedOwner: opts.namedOwner } : {}) });

    if (waits.length) {
      this.releaseNotice(`task ${this.publicTitle(task)} waits for ${waits.map((id) => `#${id}`).join(", ")}; it is offered once they are approved`);
      return task;
    }
    const passed = this.passedOver(task, a);
    if (!a.owner) {
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
    const next = this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(opts.roster && task.state === "in_progress" ? { state: "proposed" as const } : {}), ...(opts.event === "escalated" ? { rejections: 0 } : {}), ...(opts.override && task.reserved ? { reserved: null } : {}) }, `${opts.note ?? `to ${a.owner}`}${passed}`, { ...(profile ? { profile } : {}), ...(opts.reason ? { reason: opts.reason } : {}), ...(lasting ? { from: task.owner! } : {}) });
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
      if (moves(saved.history).length !== moves(next.history).length) throw e;
      this.releaseNotice(this.undeliveredNotice(saved, e));
      throw new AssignmentUndeliveredError(saved, e);
    }
    // A claim is its own hand-over, with no delivery: its accepted write and its line stay as they were (#297).
    if (opts.claim && a.owner === by) {
      const claimed = this.d.board.update(next.id, by, "accepted", { state: "in_progress" });
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
    if (task.state === "approved") throw new PreEffectToolRefusal("an approved task's role is historical; propose new work instead");
    let selected;
    try { selected = taskRole(raw === null ? undefined : raw, task.class, this.d.catalog ?? loadRoleCatalog(this.d.cwd)); }
    catch (error) { throw new PreEffectToolRefusal((error as Error).message); }
    if (task.role === selected?.id) return task;
    const next = this.d.board.update(task.id, by, "catalog role changed", { role: selected?.id });
    for (const peer of new Set([next.owner, next.state === "in_review" ? next.reviewer : null])) {
      if (!peer || peer === USER) continue;
      this.releaseNotice(`task ${this.publicTitle(next)}: catalog role update delivery unconfirmed`, () => this.d.bus.publish(newEnvelope(HUB,
        `Task #${next.id}: catalog role changed by the person. ${next.role ? this.roleGuidance(next, peer, peer === next.reviewer) : "Catalog guidance cleared; follow the task's existing plan and requirements."}`,
        { to: [peer], kind: "task", refs: { task: String(next.id) }, ...(this.isPii(next) ? { private: true } : {}) })));
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

  /** `contextWithheld`: the PII screen did not clear a budget hand-off (#198); an escalation's reason is the hub's own words. */
  private async sendTask(task: Task, a: Assignment, context?: string, overlap = "", contextWithheld = false): Promise<void> {
    const pii = this.isPii(task);
    const brief = pii ? undefined : await this.d.briefs?.forTask(task.owner!, task).catch(() => undefined);
    const rejected = task.history.filter((h) => h.event === "changes_requested").map((h) => `- ${h.by}: ${this.screen(task, h.note ?? "", "review note", a.owner, h.withheld)}`);
    const handoff = context && !pii ? this.screen(task, context, "handoff", a.owner, contextWithheld).slice(0, 3000) : "";
    const facts = [`class ${profileTaskLabel(task)}`, a.owner === PI ? `backend pi/${a.piBackend ?? "dgx"}` : "", task.refs.paths?.length ? `paths ${task.refs.paths.join(", ")}` : "", task.refs.branch ? `branch ${task.refs.branch}` : "", a.reviewer ? `reviewer ${a.reviewer}` : task.class === "review" ? "no reviewer" : this.noReviewer(a)].filter(Boolean).join("; ");
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
    const env = newEnvelope(HUB, body, { to: [owner], kind: "task", priority: "important", refs: { ...task.refs, task: String(task.id) }, ...(pii ? { private: true } : {}) });
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
  async releaseReady(): Promise<void> {
    for (const t of this.d.board.list("proposed")) {
      const last = t.history.at(-1)?.event, planned = this.plannerPullRecord(t)?.pull === true;
      if ((!t.deps?.length && !t.history.some(h => h.event === "backlog pulled")) || t.owner || this.offered.has(t.id) || (!planned && last !== "blocked" && last !== "ready" && last !== "reserved") || this.waitsFor(t).length) continue;
      if (planned && !this.plannerAssignment(t, true).owner) continue;
      // ponytail: a reserved owner (#207) that attaches after another peer that can take the task is passed over here like
      // an offline one; hold reserved tasks for a grace period if restarts show that up.
      if (!assign(t, this.states(), this.d.routing(), { exclude: this.excluded(t), ...this.health() }).owner) continue; // nobody attached can take it yet
      await this.offerReady(t, "nothing left to wait for");
    }
  }

  /** Callers hold a list read before an await: re-read, or a task the other caller offered meanwhile is offered twice. */
  private async offerReady(stale: Task, why: string): Promise<void> {
    let offering = false, undelivered: AssignmentUndeliveredError | undefined;
    try {
      const t = this.d.board.get(stale.id);
      if (!t || t.state !== "proposed" || t.owner || this.offered.has(t.id)) return;
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

  /** Artifact links and claimed local gates stay on the board; no outside text is accepted. */
  recordLifecycle(by: PeerId, id: unknown, input: unknown): Task {
    const task = this.need(id, false, true);
    if (by !== USER && by !== task.owner && by !== task.reviewer) throw new PreEffectToolRefusal("only the task owner, reviewer or console user may record lifecycle evidence");
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const next = sdlcReceipt(input, task.sdlc, config);
    const definition = stageDefinition(config, next.stage);
    if (config.mode === "enforce" && config.definitions && input && typeof input === "object" && "stage" in input && next.stage !== task.sdlc?.stage && by !== USER) {
      const actor = definition?.actor;
      const acts = actor === "owner" ? by === task.owner : actor === "reviewer" ? by === task.reviewer : actor === "planner" ? this.d.roles?.[by]?.includes("planner") : actor === "owner/planner" && (by === task.owner || this.d.roles?.[by]?.includes("planner"));
      if (!acts) throw new PreEffectToolRefusal(`lifecycle stage requires its ${actor ?? "unknown"} actor or the person`);
    }
    if (input && typeof input === "object" && "phase" in input) {
      this.mine(task, by, "reviewer", true);
      if (next.phase && !this.isPii(task) && !this.nameable(JSON.stringify(next.phase))) throw new PreEffectToolRefusal("phase metadata matches a PII pattern; use private work");
      if (next.phase) validatePhaseLinks(task, next.phase, id => this.d.board.get(id), t => this.isPii(t));
    }
    if (next.reviewedHead !== task.sdlc?.reviewedHead) this.mine(task, by, "reviewer", true);
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
    return report;
  }

  private workflowView(task: Task) {
    return phaseView(this.d.sdlc?.config() ?? sdlcConfig(undefined), task, id => this.d.board.get(id), t => this.isPii(t));
  }
  workflowExport(id: unknown): Record<string, unknown> {
    const task = this.need(id), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const state = { id: task.id, state: task.state, stage: task.sdlc?.stage ?? config.stages[0] ?? "spec", ...(this.isPii(task) ? { private: true } : { phase: this.workflowView(task) ?? null }) };
    return { schema: 1, workflow: config.workflow ?? "none", state, stateHash: workflowHash(state), sourceHash: workflowHash(config) };
  }
  async lifecycleStatus(id: unknown, refresh = true): Promise<SdlcStatus> {
    const task = this.need(id), config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    const evidence = task.sdlc && !this.isPii(task) && refresh && config.mode !== "off" ? await readSdlcPr(task.sdlc, this.d.sdlc?.gh) : undefined;
    return sdlcStatus(config, task.sdlc, evidence, this.workflowView(task));
  }

  private async lifecycleGate(task: Task, transition: "review" | "approval", reviewedHead?: string): Promise<void> {
    const config = this.d.sdlc?.config() ?? sdlcConfig(undefined);
    if (config.mode === "off") return;
    const receipt = task.sdlc && { ...task.sdlc, ...(reviewedHead ? { reviewedHead } : {}) };
    const evidence = receipt && !this.isPii(task) ? await readSdlcPr(receipt, this.d.sdlc?.gh) : undefined;
    const current = this.need(task.id, false, true);
    if (config.mode === "enforce" && (current.history.length !== task.history.length || current.owner !== task.owner || current.reviewer !== task.reviewer || current.state !== task.state)) throw new PreEffectToolRefusal(`task #${task.id}: changed during lifecycle readback; retry on current work`);
    const status = sdlcStatus(config, receipt, evidence, this.workflowView(current));
    const blockers = transition === "review" ? [...new Set([...status.blockers.filter(blocker => ["lifecycle stage definition unknown", "issue identity missing", "PR identity missing", "current PR evidence unknown", "PR is not open", "local gate on current head missing or failed"].includes(blocker)), ...(status.entry ?? []), ...(status.exit ?? [])])] : status.blockers;
    if (config.mode === "enforce" && blockers.length) throw new PreEffectToolRefusal(`task #${task.id}: SDLC ${transition} blocked: ${blockers.join("; ")}`);
    if (config.mode === "advise" && blockers.length) this.d.notify(`task ${this.publicTitle(task)}: SDLC ${transition} advice: ${this.isPii(task) ? "private lifecycle evidence unknown" : blockers.join("; ")}`);
  }

  private need(id: unknown, open = false, preEffect = false): Task {
    // Callers are models (#70): an id is a whole number or a digit string, never an array that Number() would accept.
    const n = typeof id === "number" ? id : typeof id === "string" && /^\s*\d+\s*$/.test(id) ? Number(id) : NaN;
    if (!Number.isInteger(n)) throw new (preEffect ? PreEffectToolRefusal : Error)(`id must be a task number, not ${(typeof id === "number" ? String(id) : JSON.stringify(id ?? null)).slice(0, 60)}`);
    const task = this.d.board.get(n);
    if (!task) throw new (preEffect ? PreEffectToolRefusal : Error)(`no task #${n}`);
    if (task.state === "backlog") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${n} is backlog: pull it into To Do first`);
    // Handing a task to someone else only makes sense while there is work left on it.
    if (open && !OPEN.includes(task.state)) throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: it can no longer change hands`);
    return task;
  }

  /**
   * With a plan, the owners of overlapping tasks get it as a ride-along line, and an overlap only the plan reveals is
   * announced like one found at assignment (issue #31).
   */
  accept(by: PeerId, id: unknown, plan?: unknown): Task {
    const task = this.need(id, false, true);
    this.mine(task, by, "owner", true);
    this.ready(task, true);
    if (task.state !== "proposed" && task.state !== "changes_requested" && task.state !== "in_progress") throw new PreEffectToolRefusal(`task #${task.id} is ${task.state}: cannot move to in_progress`);
    // Models send null or {} for an optional field they leave empty: neither replaces a plan.
    const given = plan == null ? undefined : cleanPlan(plan, (task.profile ?? "dev") === (this.d.profile ?? "dev") ? this.d.profileData ?? task.profile ?? "dev" : task.profile ?? "dev");
    const cleaned = given && Object.keys(given).length ? given : undefined;
    // A task's signals are fixed when it is proposed: text that matches a PII pattern cannot be let in afterwards.
    if (cleaned && !this.isPii(task) && this.isPii({ signals: this.signalsFor({ title: "", detail: planText(cleaned), refs: {}, plan: cleaned }) })) {
      throw new PreEffectToolRefusal("this plan matches a PII pattern and is not kept: other owners would see it");
    }
    const before = new Set(this.overlapHits(task).map((h) => h.task.id));
    const next = this.d.board.update(task.id, by, "accepted", { state: "in_progress", ...(cleaned ? { plan: cleaned } : {}) });
    this.d.notify(`task ${this.publicTitle(next)} accepted by ${by}`);
    if (cleaned) {
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
    const before = this.cohorts.of(task.id)?.revision;
    const joined = this.cohorts.join(task, hits.map((h) => h.task), ownerGen, handedAt);
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

  async decline(by: PeerId, id: unknown, reason?: string): Promise<Task> {
    const task = this.need(id, true, true);
    this.mine(task, by, "owner", true);
    // The owner it is declined for goes on the entry, also when the console declines for it: `excluded()` keeps it out (#207).
    const back = this.d.board.update(task.id, by, "declined", task.state === "in_progress" ? { state: "proposed" } : {}, reason, task.owner ? { from: task.owner } : {});
    this.d.notify(`task ${this.publicTitle(back)} declined by ${by}${reason && !this.isPii(back) ? `: ${reason}` : ""}`);
    return this.assignOwner(back, HUB, { event: "reassigned", reason: "declined", clearOnFail: true });
  }

  /** Tasks whose check is queued or running, and the owner it was started for. */
  private readonly checking = new Map<number, PeerId | null>();
  private checkQueue: Promise<void> = Promise.resolve();
  private pendingChecks = 0;
  /** Checks queued or running, until their result is on the board: a recovery commit waits for them. */
  checksPending = () => this.pendingChecks;

  /** Whether a completion check is still running for this task. */
  isChecking = (id: number) => this.checking.has(id);

  async done(by: PeerId, id: unknown, summary?: string, refs?: TaskRefs): Promise<Task> {
    const valid = (): Task => {
      const t = this.need(id, false, true);
      this.mine(t, by, "owner", true);
      if (t.state === "in_review" || t.state === "approved") throw new PreEffectToolRefusal(`task #${t.id} is already ${t.state}`);
      this.ready(t, true);
      if (this.checking.has(t.id)) {
        // The result goes only to the owner the check was started for: anyone who took the task since hears nothing.
        throw new PreEffectToolRefusal(this.checking.get(t.id) === t.owner ? `task #${t.id}: its check is still running; its result comes as a task message` : `task #${t.id}: a check from before it changed hands is still running; call hub_task_done again in a few minutes`);
      }
      return t;
    };
    // The PII screen reads the summary of a done that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("summary", summary, valid());
    let task = valid();
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off") { await this.lifecycleGate(task, "review"); task = valid(); }
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
    if (!command) return this.complete(task, by, summary, refs, "", withheld);
    // The tool call returns now; a check can outlast an agent's tool timeout. The result decides what comes next.
    this.checking.set(task.id, task.owner);
    const pending = this.d.board.update(task.id, by, "done (checking)", { refs: cleanRefs(refs) }, summary, { withheld: withheld || undefined });
    this.releaseNotice(`task ${this.publicTitle(pending)} done by ${by}; its check is queued or running: ${command}`);
    const seen = { events: pending.history.length, owner: pending.owner };
    this.pendingChecks++;
    this.checkQueue = this.checkQueue
      .then(() => this.finishChecked(pending.id, by, summary, command, seen, withheld))
      .catch((e: Error) => this.d.notify(`task #${pending.id}: its check result could not be recorded: ${e.message}`))
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

  private async complete(task: Task, by: PeerId, summary?: string, refs?: TaskRefs, checkOutput = "", withheld = false): Promise<Task> {
    let reviewer = task.reviewer;
    if (this.d.sdlc && this.d.sdlc.config().mode !== "off") {
      await this.lifecycleGate(task, reviewer ? "review" : "approval");
      task = this.need(task.id, false, true);
      this.mine(task, by, "owner", true);
      reviewer = task.reviewer;
    }
    const next = this.d.board.update(task.id, by, "done", { state: reviewer ? "in_review" : "approved", ...(task.sdlc ? { sdlc: { ...task.sdlc, stage: lifecycleStage(this.d.sdlc?.config() ?? sdlcConfig(undefined), reviewer ? "review" : "merge") } } : {}), refs: cleanRefs(refs) }, checkOutput ? `${summary ?? ""}\n${checkOutput}`.trim() : summary, { withheld: withheld || undefined });
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
    else this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${reviewer}`, () => this.sendReview(next, reviewer));
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
      return [this.completedNotice(t, { task, paths: this.places(task).paths.filter((p) => this.places(t).paths.some((q) => samePlace(p, q))), symbols: [] }, done?.note, done?.withheld)];
    });
    return lines.length ? lines.join("\n") : undefined;
  }

  /** The one place a review request is written: the first reviewer and a replacement get the same text, refs and privacy. */
  private sendReview(task: Task, reviewer: PeerId, why = ""): void {
    const r = task.refs;
    const last = [...task.history].reverse().find((h) => h.event === "done");
    const where = [r.branch ? `branch ${r.branch}` : "", r.commit ? `commit ${r.commit}` : "", r.paths?.length ? `paths ${r.paths.join(", ")}` : ""].filter(Boolean).join("; ");
    // A checklist that maps the change to its contract (issue #35): reviewers who check against the written plan catch more.
    const plan = planText(task.plan);
    const check = [...task.history].reverse().find((h) => h.event === "check passed");
    const checklist = [
      "Checklist:",
      `- Map the changed signatures and call sites to ${plan ? `the plan (${plan})` : task.detail ? "the task detail above" : "the task title"}, and name each one that does not match.`,
      `- ${check ? `Check result: ${(check.note ?? "").split("\n")[0]}` : "No check ran for this class: run the affected tests yourself."}`,
      `- List what is unmet in hub_review's unmet, one item each.`,
    ].join("\n");
    const summary = last?.note ? this.screen(task, last.note, "summary", reviewer, last.withheld) : "(no summary)";
    const guidance = this.roleGuidance(task, reviewer, true);
    let projection = "";
    try { const text = this.d.projectedReview?.(task); if (text) projection = this.screen(task, sanitize(text), "document projection", reviewer); }
    catch { projection = "(document projection unavailable)"; }
    const body = `Review task #${task.id} [${profileTaskLabel(task)}] ${task.title}\nDone by ${last?.by ?? task.owner}: ${summary}\n${where ? `Where: ${where}\n` : ""}${why ? `${why}\n` : ""}${!plan && task.detail ? `Task detail:\n${task.detail}\n` : ""}${guidance ? guidance + "\n" : ""}${projection ? projection + "\n" : ""}${checklist}\nGive your verdict with hub_review {id: ${task.id}, verdict: "approved" | "changes_requested", note, unmet}.`;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [reviewer], kind: "review", priority: "important", refs: { ...r, task: String(task.id) }, ...(this.isPii(task) ? { private: true } : {}) }));
  }

  async review(by: PeerId, id: unknown, verdict: unknown, note?: string, unmet?: unknown, head?: unknown): Promise<Task> {
    const valid = (): Task => {
      const t = this.need(id, false, true);
      this.mine(t, by, "reviewer", true);
      if (verdict !== "approved" && verdict !== "changes_requested") throw new PreEffectToolRefusal('verdict must be "approved" or "changes_requested"');
      if (t.state !== "in_review") throw new PreEffectToolRefusal(`task #${t.id} is ${t.state}: cannot move to ${verdict} before its owner calls hub_task_done`);
      return t;
    };
    const items = textList(unmet);
    if (items.length) note = `${note ?? ""}\nUnmet: ${items.join("; ")}`.trim();
    // The PII screen reads the note of a review that passes these checks (issue #198); they run again after it.
    const withheld = await this.withholds("review note", note, valid());
    let task = valid();
    let reviewedHead: string | undefined;
    if (head !== undefined) {
      const checked = sdlcReceipt({ reviewedHead: head }, task.sdlc, this.d.sdlc?.config() ?? sdlcConfig(undefined));
      reviewedHead = checked.reviewedHead;
    }
    if (verdict === "approved" && this.d.sdlc && this.d.sdlc.config().mode !== "off") { await this.lifecycleGate(task, "approval", reviewedHead); task = valid(); }
    const pii = this.isPii(task);
    const flag = { withheld: withheld || undefined };
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
    this.cohorts.withdraw(rejected.id); // open again: its done intent no longer counts (issue #107)
    if (rejected.owner) this.d.board.recordOutcome(rejected.owner, rejected.class, false);
    this.contradict(rejected);
    this.note(rejected, by, "decision", `Task #${rejected.id} changes requested by ${by}: ${rejected.title}\n${note ?? ""}`, withheld);
    if (rejected.rejections >= ESCALATE_AFTER) {
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
    // The guarded tail of a landed move: the console notice, the decision note and the old owner's stop message,
    // each behind its own releaseNotice. It runs on the success path and on a saved move whose delivery failed.
    const tail = (moved: Task) => {
      this.releaseNotice(`task ${this.publicTitle(moved)} escalated from ${from} to ${moved.owner} (${why})`);
      this.note(moved, by, "decision", `Task #${moved.id} escalated from ${from} to ${moved.owner}: ${why}`);
      if (from) this.releaseNotice(`task ${this.publicTitle(moved)}: could not tell ${from} it moved to ${moved.owner}`, () =>
        this.tell({ ...moved, owner: from }, `Task #${moved.id} moved to ${moved.owner} (${why}). Stop working on it.`, this.isPii(moved)));
    };
    let next: Task;
    try {
      next = await this.assignOwner(task, by, { candidates: list, event: "escalated", reason, note: `${why}; from ${from ?? "none"}`, context: why });
    } catch (e) {
      // A saved move whose delivery failed arrives as AssignmentUndeliveredError carrying the saved task (#297);
      // the tail still runs on it (its parts are guarded), and the caller still gets the throw. Anything before
      // the write gets neither.
      if (e instanceof AssignmentUndeliveredError) tail(e.task);
      throw e;
    }
    if (next.owner && next.owner !== from) {
      // The move is on the board (#243): review() reaches here after its changes_requested write.
      tail(next);
    } else this.releaseNotice(`task ${this.publicTitle(task)}: escalation found nobody in [${list.join(", ")}]; it stays with ${from ?? "nobody"}`);
    return this.d.board.get(next.id)!;
  }

  /** Caller authority is checked by the daemon; keep the real actor in task history. */
  async assignTo(id: unknown, peer: PeerId, by: PeerId = USER, preEffect = false, role: TaskAssignmentRole = "owner"): Promise<Task> {
    if (role !== "owner" && role !== "reviewer") throw new (preEffect ? PreEffectToolRefusal : Error)("role must be owner or reviewer");
    if (role === "reviewer" && by !== USER) {
      const conductors = Object.entries(this.d.roles ?? {}).filter(([, roles]) => Array.isArray(roles) && roles.includes("conductor")).map(([actor]) => actor);
      if (conductors.length !== 1 || conductors[0] !== by) throw new (preEffect ? PreEffectToolRefusal : Error)("only the console user or the configured conductor may name a reviewer");
    }
    const task = this.need(id, role === "owner", preEffect);
    if (!this.d.bus.isRostered(peer)) throw new (preEffect ? PreEffectToolRefusal : Error)(`${peer} is off roster; add it to the roster before assigning work`);
    if (role === "reviewer") {
      if (!OPEN.includes(task.state) && task.state !== "in_review") throw new (preEffect ? PreEffectToolRefusal : Error)(`task #${task.id} is ${task.state}: its reviewer can no longer change`);
      this.ready(task, preEffect);
      const a = assign(task, this.states(), this.d.routing(), { candidates: [], namedReviewer: peer, ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class) });
      if (a.reviewer !== peer) throw new (preEffect ? PreEffectToolRefusal : Error)(`cannot name ${peer} as reviewer: ${a.trace.filter(line => line.includes("reviewer") || line.includes("pii")).join("; ")}`);
      const next = this.d.board.update(task.id, by, "reviewer changed", { reviewer: peer }, `named reviewer ${peer}`, { reason: "manual" });
      if (next.state === "in_review" && task.reviewer && task.reviewer !== peer) {
        const previous = task.reviewer;
        this.releaseNotice(`task ${this.publicTitle(next)}: could not notify previous reviewer ${previous} that its review request is withdrawn`, () => {
          for (const env of this.d.bus.snapshot(false).queues[previous] ?? []) {
            if (env.from === HUB && env.kind === "review" && env.refs?.task === String(task.id)) this.d.bus.withdraw(env.id);
          }
          const body = `Review request for task #${task.id} ${this.publicTitle(next)} is withdrawn: its reviewer is now ${peer}. Do not review this task; a late verdict from the previous reviewer is refused.`;
          if (previous === USER) this.d.notify(body);
          else this.d.bus.publish(newEnvelope(HUB, body, { to: [previous], kind: "status", priority: "important", refs: { task: String(task.id) }, ...(this.isPii(next) ? { private: true } : {}) }));
        });
      }
      if (next.state === "in_review" && peer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${peer}`, () => this.sendReview(next, peer));
      return next;
    }
    // Work that waits is handed to nobody yet (issue #207): the peer becomes its reserved owner instead.
    if (!this.waitsFor(task).length) return this.assignOwner(task, by, { candidates: [peer], namedOwner: peer, event: "reassigned", reason: "manual", override: by === USER });
    const next = this.d.board.update(task.id, by, "reserved", { reserved: peer }, `for ${peer}`, { reason: "manual" });
    this.releaseNotice(`task ${this.publicTitle(next)} reserved for ${peer} by ${by}; it is offered to ${peer} first once what it waits for is approved`);
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
    return this.d.board.list().filter(task => task.state !== "approved" && (task.owner === peer || task.reviewer === peer)).map(task => {
      const owner = task.owner === peer;
      const weights = this.weights(task.class);
      const pii = this.isPii(task);
      const candidates = owner ? [pii ? LOCAL : PI, pii ? undefined : LOCAL, ...(routing.classes[task.class]?.peers ?? []).filter(p => p !== LOCAL && p !== PI)].filter((p): p is PeerId => !!p) : [];
      const a = assign(task, this.states(), routing, { ...weights, offRoster: [...(weights.offRoster ?? []), peer], exclude: [peer], candidates, ...(owner ? { waitsFor: this.waitsFor(task) } : task.owner ? { notReviewer: task.owner } : {}) });
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
        const candidates = [pii ? LOCAL : PI, pii ? undefined : LOCAL, ...(routing.classes[task.class]?.peers ?? []).filter((p) => p !== LOCAL && p !== PI)].filter((p): p is PeerId => !!p);
        // Budget keeps its original release/unassign behaviour. Roster changes the state in
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
        if (roster) {
          if (!next.owner || next.owner === peer) continue;
          this.releaseNotice(`task ${this.publicTitle(next)} moved from ${peer} to ${next.owner} (off roster)`);
          if (next.state === "in_review" && next.reviewer && next.reviewer !== task.reviewer && next.reviewer !== USER) this.releaseNotice(`task ${this.publicTitle(next)}: could not send the review request to ${next.reviewer}`, () => this.sendReview(next, next.reviewer!, `(${peer} owned this and is off roster.)`));
        }
        moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner, role: "owner" });
      } else if (task.reviewer === peer && task.state !== "approved") {
        const a = assign(task, this.states(), routing, { exclude: [peer], candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class) });
        const reviewer = a.reviewer && a.reviewer !== peer && a.reviewer !== task.owner ? a.reviewer : null;
        if (roster && !reviewer) {
          this.releaseNotice(`task ${this.publicTitle(task)}: its reviewer ${peer} is off roster and nobody else can review; the reviewer stays ${peer}; use ahub review ${task.id}`);
          continue;
        }
        const next = this.d.board.update(task.id, HUB, "reviewer changed", { reviewer }, why);
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

  async remember(by: PeerId, input: { text?: string; title?: string; kind?: string; task?: unknown; horizon?: unknown; scope?: unknown }): Promise<string> {
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("text is required");
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
    const res = this.d.memory ? await this.d.memory.save({ text, ...(title ? { title } : {}), project: this.d.project, metadata: { peer: by, kind, ...(task ? { task: task.id } : {}) } }) : undefined;
    if (!res && !native) return this.d.memory ? "memory worker unavailable; nothing saved" : "memory store unavailable; nothing saved";
    const line = noteLine(by, kind, title ? `${title}: ${text}` : text);
    this.d.notify(line);
    this.d.share?.(by, line);
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
    const g = typeof ref === "string" && ref.trim() ? this.d.store.store.goalOf(ref.trim().replace(/^goal:/, "")) : undefined;
    if (!g) throw new PreEffectToolRefusal(`goal: no long-term task ${JSON.stringify(ref).slice(0, 40)} (ahub goal list shows them)`);
    if (by !== USER && g.project !== this.d.store.project) throw new PreEffectToolRefusal("goal: that long-term task belongs to another project; linking across projects is a person's");
    if (g.state === "done" || g.state === "dropped") throw new PreEffectToolRefusal(`goal: that long-term task is ${g.state}`);
    return g;
  }
  /** Record that a board task is part of a long-term task; never for a PII task. Fail-open after the board write. */
  private linkNative(task: Task, goal: GoalView, by: PeerId): string {
    if (this.isPii(task)) { this.releaseNotice(`task #${task.id} is not linked to a long-term task: nothing about a PII task enters hub memory`); return "not linked (PII task)"; }
    try { this.d.store!.store.goalLink(goal.id, this.memoryKey(task), by); return `part of long-term task ${goal.id.slice(0, 8)}`; }
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
      // Approved, or settled in the store already: the snapshot the caller holds can predate an approval made while it awaited.
      const approved = !!task && (task.state === "approved" || st.store.settled(this.memoryKey(task)));
      const tier: Tier = horizon ?? (approved && PROMOTED_KINDS.includes(kind) ? "long" : "short");
      const about = extractNodes(`${title}\n${text}`, { cwd: this.d.cwd, project: st.project, repo: st.repo, deny: st.deny, paths: [...(task?.refs.paths ?? []), ...(task?.plan?.paths ?? [])], symbols: task?.plan?.symbols, ...(task ? { task: { id: task.id, created: task.created } } : {}) });
      // A short-term note on a task already approved (before hub memory existed, or late): the task is settled first, so
      // the note gets its own deadline and is never taken for a source waiting for promotion.
      if (task && approved && tier === "short" && !st.store.settled(this.memoryKey(task))) st.store.settle(this.memoryKey(task), by);
      const id = st.store.note({ op: "note", project: st.project, scope, tier, kind, peer: by, ...(title ? { title } : {}), text, ...(task ? { task: this.memoryKey(task) } : {}), about, source: by === USER ? "person" : "hub" }, horizon === "short");
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
      try { const key = this.memoryKey(t); if (this.d.store.store.hasTask(key) && !this.d.store.store.settled(key)) { this.settleMemory(t); n++; } }
      catch { /* fail-open: tried again at the next start */ }
    }
    return n;
  }

  private settleMemory(task: Task): void {
    if (!this.d.store || this.isPii(task)) return;
    // The store screens each note as it moves to the synced log (the promotion screen the daemon gives it).
    try { this.d.store.store.settle(this.memoryKey(task), task.reviewer ?? task.owner ?? HUB); }
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
    if (this.d.memory) void this.d.memory.save({ text, title, project: this.d.project, metadata: { peer: by, task: task.id, kind } });
  }

  private tell(task: Task, body: string, pii: boolean): void {
    if (!task.owner || task.owner === USER) return;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner], kind: "task", priority: "important", refs: { task: String(task.id) }, ...(pii ? { private: true } : {}) }));
  }
}

export { LOCAL };
