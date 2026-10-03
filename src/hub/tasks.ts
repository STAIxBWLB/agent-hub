import { isAbsolute, relative } from "node:path";
import type { Briefs } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { CLASSES, OUTCOMES_KEPT_MS, PLAN_KEYS, type Board, type Task, type TaskClass, type TaskPlan, type TaskRefs } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, NOTE_KINDS, noteLine, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import { assign, detectSignals, LOCAL, PI, predictSplit, type Assignment, type Routing, type SplitObservation, type SplitPrediction } from "./routing.ts";
import { ExecutionBudget, type ExecutionBudgetConfig, type ExecutionBudgetDecision, type ExecutionBudgetStatus, type ExecutionUnit } from "./execution-budget.ts";
import { Cohorts, MAX_REQUESTS, type Cohort, type Completion } from "./cohorts.ts";
import { realPath } from "./project.ts";

export interface TasksDeps {
  board: Board;
  bus: Bus;
  routing: () => Routing;
  cwd: string;
  project: string;
  briefs?: Briefs;
  memory?: MemoryClient;
  /** a line for the human: console tail and hub.log */
  notify: (line: string) => void;
  /** The completion check configured for a class, if any (local config only; issue #7). */
  check?: (cls: TaskClass) => string | undefined;
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
const QUIET_EVENTS = new Set(["answer", "reviewer changed"]);

/** A project path as one spelling (#67): no leading `./`, no repeated or trailing `/`; the root is `.`. */
export const normPath = (p: string) => p.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || ".";

/** Same path, or one is a directory of the other; the project root (`.`) holds everything. */
export const samePlace = (a: string, b: string) => {
  const [x, y] = [normPath(a), normPath(b)];
  return x === "." || y === "." || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

/** Events that hand a task to an owner (or take it away); newer history records that owner on them (#67). */
const OWNERSHIP_EVENTS = new Set(["assigned", "escalated", "reassigned", "unassigned"]);
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
function cleanPlan(input: unknown): TaskPlan {
  const r = fields(input);
  return Object.fromEntries(PLAN_KEYS.map((k) => [k, k === "paths" ? [...new Set(textList(r[k]).map(normPath))] : textList(r[k])] as const).filter(([, v]) => v.length));
}

/** A plan as one line for other owners; the whole plan is on the board. */
const planText = (plan: TaskPlan = {}) => PLAN_KEYS.filter((k) => plan[k]?.length).map((k) => `${k.replace("_", " ")}: ${plan[k]!.join("; ")}`).join(" | ");

/**
 * The task flow. Adapters and tools never touch the board: every change comes through here, where assignment,
 * PII handling, envelopes, briefs and memory notes are decided in one place.
 */
export class Tasks {
  /** Turn-free cohorts (issue #107): who works without messages, and who integrates. */
  readonly cohorts: Cohorts;

  constructor(private readonly d: TasksDeps) {
    this.cohorts = new Cohorts({
      silence: (owners) => this.turnFree() && owners.every((p) => p !== USER && p !== HUB && (this.d.capable?.(p) ?? false)),
      idle: (peer) => this.d.idle?.(peer) ?? false,
    });
    // What the on-prem worker says about a PII task is private on the bus (console tail and log show a stub), so the
    // board keeps the text: `ahub task show <id>` is where the console user reads it, a refusal included.
    d.bus.tap((e) => {
      // A turn that ends takes its hand-overs with it: busy later is another turn (#115).
      if (e.t === "state" && e.state !== "busy") for (const [k, p] of this.sent) if (p === e.peer) this.sent.delete(k);
      if (e.t !== "envelope" || !e.env.private || e.env.from === HUB || !e.env.refs?.task) return;
      try {
        d.board.update(Number(e.env.refs.task), e.env.from, "answer", {}, e.env.body.slice(0, 4000));
      } catch {
        // the task is gone: nothing to attach the answer to
      }
    });
  }

  isPii = (task: Pick<Task, "signals">) => task.signals.includes("pii") && this.d.routing().constraints.pii === "local_only";

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
  admitExecutionEnvelopes = (envs: Envelope[], peer: PeerId, unit: ExecutionUnit, amount = 1): ExecutionBudgetDecision[] => {
    const ids = [...new Set(envs.flatMap((e) => {
      const value = e.refs?.task;
      const id = typeof value === "string" ? Number(value) : NaN;
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    }))];
    return this.d.executionBudget?.admitTasks(ids, peer, unit, amount) ?? [];
  };

  /** What peers other than the owner, the console stream and the log may see of a task. */
  publicTitle = (task: Task) => (this.isPii(task) ? `#${task.id} [pii]` : `#${task.id} ${task.title}`);

  /** A task as a cloud peer may see it. */
  publicView(task: Task): Record<string, unknown> {
    const { title, detail, history, ...rest } = task;
    return this.isPii(task) ? { ...rest, refs: {}, plan: {}, title: "[pii]", detail: "[pii]" } : { ...rest, title, detail, history: history.slice(-5) };
  }

  /** Console results expose direct approval and delivery holds, not just the chosen peer ids. */
  resultLine(task: Task): string {
    const base = `task #${task.id}: ${task.state}, owner ${task.owner ?? "none"}, reviewer ${task.reviewer ?? "none"}`;
    const noReview = task.class !== "review" && !task.reviewer && OPEN.includes(task.state) && !this.waitsFor(task).length
      ? this.noReviewer(assign(task, this.states(), this.d.routing(), { candidates: task.owner ? [task.owner] : [], notReviewer: task.owner ?? undefined, ...this.weights(task.class) }))
      : undefined;
    const held = task.owner ? this.d.held?.()[task.owner] : undefined;
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
    return { ...(failing ? { failing } : {}), ...(held ? { held } : {}), ...(this.d.roles ? { roles: this.d.roles } : {}) };
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
      available: Object.fromEntries(peers.map((p) => [p, !failing[p] && (states[p] === "idle" || taking(p))])),
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

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; refs?: TaskRefs; plan?: TaskPlan; owner?: PeerId; after?: unknown; urgent?: unknown }): Promise<Task> {
    // Callers are models: a title is one line (it is part of console and hub.log lines), not a document.
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!title) throw new Error("title is required");
    // Dependencies can only name tasks that exist, so the new task closes no cycle: nothing can depend on it yet.
    // Callers are models: a missing or null `after` is no dependency, and an id is an integer or a digit string.
    let afterIds: unknown[] = [];
    if (Array.isArray(input.after)) afterIds = input.after;
    else if (input.after != null) afterIds = [input.after];
    const deps: number[] = [];
    for (const v of afterIds) {
      const id = typeof v === "number" || (typeof v === "string" && /^\s*\d+\s*$/.test(v)) ? Number(v) : NaN;
      if (!Number.isInteger(id)) throw new Error(`after: ${JSON.stringify(v)} is not a task id`);
      if (!this.d.board.get(id)) throw new Error(`after: no task #${id}`);
      if (!deps.includes(id)) deps.push(id);
    }
    const waits = this.waitsFor({ deps });
    if (waits.length && input.owner) {
      throw new Error(`this task would wait for ${waits.map((id) => `#${id}`).join(", ")}, not approved yet: ${input.owner === by ? "claim it once they are" : "propose it without an owner; routing offers it when they are approved"}`);
    }
    const given = input.class === undefined || input.class === "" ? undefined : input.class;
    if (given !== undefined && !CLASSES.includes(given as TaskClass)) throw new Error(`class must be one of ${CLASSES.join(", ")}`);
    const text = { title, detail: String(input.detail ?? "").slice(0, 8000), refs: cleanRefs(input.refs) };
    const plan = cleanPlan(input.plan);
    // The plan reaches other owners, so a PII pattern in it makes the task a PII task like one in the detail would.
    const signals = detectSignals({ ...text, detail: [text.detail, planText(plan)].join("\n") }, this.d.routing(), this.d.cwd);
    // Urgent work is handed over even when its paused owner's window resets soon (issue #36).
    if (input.urgent === true && !signals.includes("urgent")) signals.push("urgent");
    let cls = given as TaskClass | undefined;
    let triaged = false;
    if (!cls && this.d.triage) {
      // Signals first: a PII task's text may only go to a model that is reached without leaving the campus network.
      const pii = signals.includes("pii") && this.d.routing().constraints.pii === "local_only";
      if (!pii || (await this.d.triage.onCampus().catch(() => false))) cls = await this.d.triage.classify(text.title, text.detail).catch(() => undefined);
      triaged = !!cls;
    }
    // A claim is work the caller will do itself: without a class and a model to name one, it is implementation (#6).
    const defaulted = !cls && input.owner === by;
    if (defaulted) cls = "implement";
    if (!cls) throw new Error(`class is required (one of ${CLASSES.join(", ")}); the hub could not name one for you`);
    const draft = { ...text, class: cls };
    let task = this.d.board.propose(by, { ...draft, plan, ...(deps.length ? { deps } : {}), signals });
    if (triaged) task = this.d.board.update(task.id, "hub", "triaged", {}, `class ${cls} named by the hub's model`);
    if (defaulted) task = this.d.board.update(task.id, "hub", "class defaulted", {}, "class implement for a claim without one");
    this.d.notify(`task ${this.publicTitle(task)} proposed by ${by} [${task.class}]${task.signals.length ? ` signals: ${task.signals.join(", ")}` : ""}`);
    // Re-read: a dependency approved while triage was awaited looked for its dependents before this row existed.
    const still = this.waitsFor(task);
    if (still.length) {
      this.d.notify(`task ${this.publicTitle(task)} waits for ${still.map((id) => `#${id}`).join(", ")}; it is offered once they are approved`);
      return this.d.board.update(task.id, HUB, "blocked", {}, `waits for ${still.map((id) => `#${id}`).join(", ")}`);
    }
    // Naming yourself is a claim: the work is already yours, so no offer comes back to you (paper: Agensh CLAIM, #68).
    return this.assignOwner(task, by, input.owner ? { candidates: [input.owner], claim: input.owner === by } : {});
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
   * `ahub task show`. A PII task's messages are private already.
   */
  private screen(task: Task, text: string, what: string, to: PeerId | null | undefined): string {
    if (!text || this.isPii(task) || to === USER || this.nameable(text)) return text;
    this.d.notify(`task #${task.id}: the ${what} was withheld from ${to ?? "a peer"} (it matches a PII pattern)`);
    return `[${what} withheld: it matches a PII pattern; ahub task show ${task.id}]`;
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
    return { paths: [...new Set(paths)], symbols: task.plan?.symbols ?? [] };
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
      const paths = mine.paths.filter((p) => theirs.paths.some((q) => samePlace(p, q)));
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
        if (!assign(task, this.states(), this.d.routing(), { exclude: [...this.declined(task), peer], ...this.health() }).owner) continue;
        try {
          const back = task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, why) : task;
          const next = await this.assignOwner(back, HUB, { exclude: [peer], event: "reassigned", note: why });
          moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner });
          // The gone owner hears it on its next delivery, if it comes back mid-work.
          if (next.owner && next.owner !== peer) this.d.tell?.(peer, noteLine(HUB, "decision", `task #${task.id} moved to ${next.owner} while you were offline; stop working on it`));
        } catch (e) {
          this.d.notify(`task ${this.publicTitle(task)}: could not be released from ${peer}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.releasing = undefined;
    }
    return moved;
  }

  /** Same code as assignment, without doing it. */
  explain(target: number | { title: string; detail?: string; class: TaskClass; refs?: TaskRefs }): string[] {
    const routing = this.d.routing();
    if (typeof target === "number") {
      const task = this.d.board.get(target);
      if (!task) throw new Error(`no task #${target}`);
      const a = assign(task, this.states(), routing, { exclude: this.declined(task), waitsFor: this.waitsFor(task), ...this.weights(task.class) });
      // The split trace is for the pair the record is about: the task's owner when it has one (issue #109).
      return [`task ${this.publicTitle(task)} (${task.state}, owner ${task.owner ?? "none"})`, "if it were assigned now:", ...a.trace, ...(this.splitShadow(task, task.owner ?? a.owner)?.trace ?? [])];
    }
    const draft = { title: target.title, detail: target.detail ?? "", refs: target.refs ?? {} };
    return assign({ class: target.class, signals: detectSignals(draft, routing, this.d.cwd) }, this.states(), routing, this.weights(target.class)).trace;
  }

  private declined = (task: Task) => task.history.filter((h) => h.event === "declined").map((h) => h.by);

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
    const hold = a.owner ? this.d.held?.()[a.owner] : undefined;
    if (hold) this.d.notify(`task ${this.publicTitle(task)}: ${a.owner}'s queue is held (${hold}); the task arrives once the hold is resolved`);
  }

  private async assignOwner(task: Task, by: PeerId, opts: { candidates?: PeerId[]; event?: string; note?: string; clearOnFail?: boolean; exclude?: PeerId[]; context?: string; claim?: boolean } = {}): Promise<Task> {
    const waits = this.waitsFor(task);
    const a = assign(task, this.states(), this.d.routing(), { exclude: [...this.declined(task), ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], ...(opts.candidates ? { candidates: opts.candidates } : {}), waitsFor: waits, ...this.weights(task.class) });

    if (waits.length) {
      this.d.notify(`task ${this.publicTitle(task)} waits for ${waits.map((id) => `#${id}`).join(", ")}; it is offered once they are approved`);
      return task;
    }
    if (!a.owner) {
      this.d.notify(`task ${this.publicTitle(task)}: no peer can take it (${a.trace.filter((l) => l.includes("skipped")).length} skipped); assign with: ahub task assign ${task.id} <peer>`);
      // Only a decline takes the task away from its owner; a failed console assign or escalation leaves it where it was.
      if (opts.clearOnFail && task.owner) {
        this.cohorts.leave(task.id);
        return this.d.board.update(task.id, by, "unassigned", { owner: null });
      }
      return task;
    }
    const profile = this.d.splitProfile?.(a.owner);
    const next = this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(opts.event === "escalated" ? { rejections: 0 } : {}) }, opts.note ?? `to ${a.owner}`, profile ? { profile } : {});
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
    if (opts.claim && a.owner === by && this.d.bus.stateOf(by) === "busy") this.sent.set(handOver(next, by), by);
    const hits = this.overlapHits(next);
    this.formCohort(next, hits);
    if (hits.length) {
      this.announceOverlap(next, hits);
      this.tellEarlierOwners(next, hits);
    }
    this.announceRouting(next, a);
    if (opts.claim && a.owner === by) {
      const claimed = this.d.board.update(next.id, by, "accepted", { state: "in_progress" });
      this.d.notify(`task ${this.publicTitle(claimed)} claimed by ${by}`);
      return claimed;
    }
    await this.sendTask(next, a, opts.context, this.overlaps(next, true, hits));
    return next;
  }

  private async sendTask(task: Task, a: Assignment, context?: string, overlap = ""): Promise<void> {
    const pii = this.isPii(task);
    const brief = pii ? undefined : await this.d.briefs?.forTask(task.owner!, task).catch(() => undefined);
    const rejected = task.history.filter((h) => h.event === "changes_requested").map((h) => `- ${h.by}: ${this.screen(task, h.note ?? "", "review note", a.owner)}`);
    const facts = [`class ${task.class}`, a.owner === PI ? `backend pi/${a.piBackend ?? "dgx"}` : "", task.refs.paths?.length ? `paths ${task.refs.paths.join(", ")}` : "", task.refs.branch ? `branch ${task.refs.branch}` : "", a.reviewer ? `reviewer ${a.reviewer}` : task.class === "review" ? "no reviewer" : this.noReviewer(a)].filter(Boolean).join("; ");
    const plan = planText(task.plan);
    const body = [
      `Task #${task.id} [${task.class}] ${task.title}`,
      task.detail,
      `Facts: ${facts}`,
      plan ? `Plan so far: ${plan}` : "",
      overlap,
      rejected.length ? `Earlier review notes:\n${rejected.join("\n")}` : "",
      brief ?? "",
      // What the previous owner left behind. Peer-written free text: never attached to a PII task.
      context && !pii ? `Handoff from the previous owner:\n${this.screen(task, context, "handoff", a.owner).slice(0, 3000)}` : "",
      `Take it with hub_task_accept {id: ${task.id}, plan: {paths, symbols, signatures, insertion_points}} (what you will change, before you start${pii ? "" : "; owners of overlapping tasks see it"}) or pass with hub_task_decline. When finished: hub_task_done {id: ${task.id}, summary: what changed, why, and the check you ran with its result, refs}.`,
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
  private ready(task: Task): void {
    const waits = this.waitsFor(task);
    if (waits.length) throw new Error(`task #${task.id} waits for ${waits.map((id) => `#${id}`).join(", ")}, not approved yet`);
  }

  /** An approved task may be the last thing others waited for: those go through assignment now (issue #34). */
  private async releaseDependents(approved: Task): Promise<void> {
    for (const t of this.d.board.list("proposed")) {
      if (!t.deps?.includes(approved.id) || t.owner || this.waitsFor(t).length) continue;
      await this.offerReady(t, `#${approved.id} approved`);
    }
  }

  private readonly offered = new Set<number>(); // ready tasks offered in this hub run
  private readonly sent = new Map<string, PeerId>(); // hand-over (`handOver`) -> owner, for the owner's current turn: its task envelope started it, or it claimed the task in it

  /**
   * A stop between an approval and the assignment of its dependents (both are saved on their own) leaves them ownerless
   * with nothing left to wait for, and no later approval to offer them. The daemon calls this on its release timer:
   * each such task is offered once per hub run, once an attached peer can take it (peers attach one by one).
   */
  async releaseReady(): Promise<void> {
    for (const t of this.d.board.list("proposed")) {
      const last = t.history.at(-1)?.event;
      if (!t.deps?.length || t.owner || this.offered.has(t.id) || (last !== "blocked" && last !== "ready") || this.waitsFor(t).length) continue;
      if (!assign(t, this.states(), this.d.routing(), { exclude: this.declined(t), ...this.health() }).owner) continue; // nobody attached can take it yet
      await this.offerReady(t, "nothing left to wait for");
    }
  }

  /** Callers hold a list read before an await: re-read, or a task the other caller offered meanwhile is offered twice. */
  private async offerReady(stale: Task, why: string): Promise<void> {
    const t = this.d.board.get(stale.id);
    if (!t || t.state !== "proposed" || t.owner || this.offered.has(t.id)) return;
    this.offered.add(t.id);
    const ready = t.history.at(-1)?.event === "ready" ? t : this.d.board.update(t.id, HUB, "ready", {}, why);
    this.d.notify(`task ${this.publicTitle(ready)} is ready: what it waited for is approved`);
    await this.assignOwner(ready, HUB).catch((e: Error) => this.d.notify(`task ${this.publicTitle(ready)}: could not be assigned: ${e.message}`));
  }

  private mine(task: Task, by: PeerId, role: "owner" | "reviewer"): void {
    if (by !== USER && task[role] !== by) throw new Error(`task #${task.id}: only its ${role} (${task[role] ?? "none"}) or the console user can do that`);
  }

  private need(id: unknown, open = false): Task {
    // Callers are models (#70): an id is a whole number or a digit string, never an array that Number() would accept.
    const n = typeof id === "number" ? id : typeof id === "string" && /^\s*\d+\s*$/.test(id) ? Number(id) : NaN;
    if (!Number.isInteger(n)) throw new Error(`id must be a task number, not ${(typeof id === "number" ? String(id) : JSON.stringify(id ?? null)).slice(0, 60)}`);
    const task = this.d.board.get(n);
    if (!task) throw new Error(`no task #${n}`);
    // Handing a task to someone else only makes sense while there is work left on it.
    if (open && !OPEN.includes(task.state)) throw new Error(`task #${task.id} is ${task.state}: it can no longer change hands`);
    return task;
  }

  /**
   * With a plan, the owners of overlapping tasks get it as a ride-along line, and an overlap only the plan reveals is
   * announced like one found at assignment (issue #31).
   */
  accept(by: PeerId, id: unknown, plan?: unknown): Task {
    const task = this.need(id);
    this.mine(task, by, "owner");
    this.ready(task);
    // Models send null or {} for an optional field they leave empty: neither replaces a plan.
    const given = plan == null ? undefined : cleanPlan(plan);
    const cleaned = given && Object.keys(given).length ? given : undefined;
    // A task's signals are fixed when it is proposed: text that matches a PII pattern cannot be let in afterwards.
    if (cleaned && !this.isPii(task) && this.isPii({ signals: detectSignals({ title: "", detail: planText(cleaned), refs: {} }, this.d.routing(), this.d.cwd) })) {
      throw new Error("this plan matches a PII pattern and is not kept: other owners would see it");
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
    const task = this.need(id, true);
    this.mine(task, by, "owner");
    const back = this.d.board.update(task.id, by, "declined", task.state === "in_progress" ? { state: "proposed" } : {}, reason);
    this.d.notify(`task ${this.publicTitle(back)} declined by ${by}${reason && !this.isPii(back) ? `: ${reason}` : ""}`);
    return this.assignOwner(back, HUB, { event: "reassigned", clearOnFail: true });
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
    let task = this.need(id);
    this.mine(task, by, "owner");
    if (task.state === "in_review" || task.state === "approved") throw new Error(`task #${task.id} is already ${task.state}`);
    this.ready(task);
    if (this.checking.has(task.id)) {
      // The result goes only to the owner the check was started for: anyone who took the task since hears nothing.
      throw new Error(this.checking.get(task.id) === task.owner ? `task #${task.id}: its check is still running; its result comes as a task message` : `task #${task.id}: a check from before it changed hands is still running; call hub_task_done again in a few minutes`);
    }
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
    const command = this.d.runCheck ? this.d.check?.(task.class) : undefined;
    if (!command) return this.complete(task, by, summary, refs);
    // The tool call returns now; a check can outlast an agent's tool timeout. The result decides what comes next.
    this.checking.set(task.id, task.owner);
    const pending = this.d.board.update(task.id, by, "done (checking)", { refs: cleanRefs(refs) }, summary);
    this.d.notify(`task ${this.publicTitle(pending)} done by ${by}; its check is queued or running: ${command}`);
    const seen = { events: pending.history.length, owner: pending.owner };
    this.pendingChecks++;
    this.checkQueue = this.checkQueue
      .then(() => this.finishChecked(pending.id, by, summary, command, seen))
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
        const paths = mine.paths.filter((p) => theirs.paths.some((q) => samePlace(p, q)));
        const symbols = mine.symbols.filter((x) => theirs.symbols.includes(x));
        return paths.length || symbols.length ? [this.completedNotice(u, { task: t, paths, symbols }, at.note)] : [];
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
      const first = (doneAt(t)?.note ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
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

  private async finishChecked(id: number, by: PeerId, summary: string | undefined, command: string, seen: { events: number; owner: PeerId | null }): Promise<void> {
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
      await this.complete(this.d.board.get(id)!, by, `${summary ?? ""}\nCheck: ${outcome}`.trim(), undefined, result.tail);
      return;
    }
    this.d.board.update(id, HUB, "check failed", {}, `${outcome}\n${result.tail}`.trim());
    this.cohorts.withdraw(id); // open again: its done intent no longer counts (issue #107)
    if (task.owner) this.d.board.recordOutcome(task.owner, task.class, false);
    this.contradict(task);
    this.d.notify(`task ${this.publicTitle(task)}: its check failed (${outcome}); it stays with ${task.owner ?? by}`);
    this.tell(task, `Task #${id}: its check failed.\n$ ${outcome}${result.tail ? `\n${result.tail}` : ""}\nFix it and call hub_task_done again.`, pii);
  }

  private async complete(task: Task, by: PeerId, summary?: string, refs?: TaskRefs, checkOutput = ""): Promise<Task> {
    const reviewer = task.reviewer;
    const next = this.d.board.update(task.id, by, "done", { state: reviewer ? "in_review" : "approved", refs: cleanRefs(refs) }, checkOutput ? `${summary ?? ""}\n${checkOutput}`.trim() : summary);
    this.cohorts.closed(next.id); // its owner's next native turn end settles it in its cohort (issue #107)
    this.note(next, by, "finding", `Task #${next.id} done by ${by}: ${next.title}\n${summary ?? ""}`);
    this.tellCompleted(next, summary);
    if (!reviewer) {
      if (next.owner) this.d.board.recordOutcome(next.owner, next.class, true); // approved without a review is a success too
      this.d.notify(`task ${this.publicTitle(next)} done by ${by}, no reviewer: approved`);
      await this.releaseDependents(next);
    }
    else if (reviewer === USER) this.d.notify(`task ${this.publicTitle(next)} done by ${by}: review it with ahub task show ${next.id}, then ahub review ${next.id} approved|changes_requested [note]`);
    else this.sendReview(next, reviewer);
    return next;
  }

  /**
   * "Passes alone, fails together": the owners of open tasks on the same places hear what changed under them, once the
   * work is done (after its check, when one runs), and nobody else does (issue #31). A message of its own, not a
   * ride-along line: an owner in the middle of those files needs it before its next task arrives.
   */
  private tellCompleted(task: Task, summary?: string): void {
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
      this.whileOpen(hit.task.owner!, hit.task.id, this.completedNotice(task, hit, summary));
    }
  }

  /**
   * The completed-change notice: files, signatures and the summary are the owner's own words (paths given at done
   * included), and any item that matches a PII pattern is left out of what other owners get.
   */
  private completedNotice(task: Task, hit: { task: Task; paths: string[]; symbols: string[] }, summary?: string): string {
    const paths = this.places(task).paths.filter(this.nameable);
    const signatures = (task.plan?.signatures ?? []).filter(this.nameable);
    const first = (summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
    const line = first && this.nameable(first) ? first : undefined;
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
      return [this.completedNotice(t, { task, paths: this.places(task).paths.filter((p) => this.places(t).paths.some((q) => samePlace(p, q))), symbols: [] }, done?.note)];
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
    const summary = last?.note ? this.screen(task, last.note, "summary", reviewer) : "(no summary)";
    const body = `Review task #${task.id} [${task.class}] ${task.title}\nDone by ${last?.by ?? task.owner}: ${summary}\n${where ? `Where: ${where}\n` : ""}${why ? `${why}\n` : ""}${!plan && task.detail ? `Task detail:\n${task.detail}\n` : ""}${checklist}\nGive your verdict with hub_review {id: ${task.id}, verdict: "approved" | "changes_requested", note, unmet}.`;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [reviewer], kind: "review", priority: "important", refs: { ...r, task: String(task.id) }, ...(this.isPii(task) ? { private: true } : {}) }));
  }

  async review(by: PeerId, id: unknown, verdict: unknown, note?: string, unmet?: unknown): Promise<Task> {
    const task = this.need(id);
    this.mine(task, by, "reviewer");
    if (verdict !== "approved" && verdict !== "changes_requested") throw new Error('verdict must be "approved" or "changes_requested"');
    if (task.state !== "in_review") throw new Error(`task #${task.id} is ${task.state}: cannot move to ${verdict} before its owner calls hub_task_done`);
    const pii = this.isPii(task);
    const items = textList(unmet);
    if (items.length) note = `${note ?? ""}\nUnmet: ${items.join("; ")}`.trim();
    if (verdict === "approved") {
      const next = this.d.board.update(task.id, by, "approved", { state: "approved", rejections: 0 }, note);
      if (next.owner) {
        this.d.board.recordOutcome(next.owner, next.class, true);
        this.d.board.recordReview({ implementer: next.owner, reviewer: by, class: next.class, kind: "approved", task: next.id });
        // Changes requested on this owner's work and the redo passed: those reviews caught something.
        for (const r of this.requestedChanges(task)) {
          this.d.board.recordReview({ implementer: next.owner, reviewer: r, class: next.class, kind: "caught", task: next.id });
        }
      }
      this.note(next, by, "decision", `Task #${next.id} approved by ${by}: ${next.title}\n${note ?? ""}`);
      this.tell(next, `Task #${next.id} approved by ${by}.${note ? ` ${this.screen(next, note, "review note", next.owner)}` : ""}`, pii);
      await this.releaseDependents(next);
      return next;
    }
    const rejected = this.d.board.update(task.id, by, "changes_requested", { state: "changes_requested", rejections: task.rejections + 1 }, note);
    this.cohorts.withdraw(rejected.id); // open again: its done intent no longer counts (issue #107)
    if (rejected.owner) this.d.board.recordOutcome(rejected.owner, rejected.class, false);
    this.contradict(rejected);
    this.note(rejected, by, "decision", `Task #${rejected.id} changes requested by ${by}: ${rejected.title}\n${note ?? ""}`);
    if (rejected.rejections >= ESCALATE_AFTER) {
      const moved = await this.escalate(HUB, rejected.id, `${rejected.rejections} consecutive changes_requested`);
      if (moved.owner !== rejected.owner) return moved;
      // Nobody to escalate to: the owner still has to hear the verdict and the note.
      this.tell(moved, `Task #${moved.id}: ${by} requests changes again.${note ? ` ${this.screen(moved, note, "review note", moved.owner)}` : ""} Nobody else can take it; fix it and call hub_task_done again.`, pii);
      return moved;
    }
    const reopened = this.d.board.update(rejected.id, HUB, "reopened", { state: "in_progress" });
    this.tell(reopened, `Task #${reopened.id}: ${by} requests changes.${note ? ` ${this.screen(reopened, note, "review note", reopened.owner)}` : ""} Fix it and call hub_task_done again.`, pii);
    return reopened;
  }

  /** Task-level escalation: the next attached peer in the class's escalate_to takes over, with the history. */
  async escalate(by: PeerId, id: unknown, why = "by hand"): Promise<Task> {
    let task = this.need(id, true);
    const list = this.d.routing().classes[task.class]?.escalate_to ?? [];
    if (task.state === "changes_requested") task = this.d.board.update(task.id, HUB, "reopened", { state: "in_progress" });
    const from = task.owner;
    // The hub's own escalations are not counted: after repeated changes_requested each one already was, and after a
    // Pi inference failure the backend failed, not the work. An escalation by hand counts on its own.
    if (from && by !== HUB) this.d.board.recordOutcome(from, task.class, false);
    // Only a reviewer that asked for changes on this work saw it fail: not an escalation of unreviewed work (a Pi failure).
    if (from && task.reviewer && task.reviewer !== USER && this.requestedChanges(task).has(task.reviewer)) this.d.board.recordReview({ implementer: from, reviewer: task.reviewer, class: task.class, kind: "escalated", task: task.id });
    const next = await this.assignOwner(task, by, { candidates: list, event: "escalated", note: `${why}; from ${from ?? "none"}`, context: why });
    if (next.owner && next.owner !== from) {
      this.d.notify(`task ${this.publicTitle(next)} escalated from ${from} to ${next.owner} (${why})`);
      this.note(next, by, "decision", `Task #${next.id} escalated from ${from} to ${next.owner}: ${why}`);
      if (from) this.tell({ ...next, owner: from }, `Task #${next.id} moved to ${next.owner} (${why}). Stop working on it.`, this.isPii(next));
    } else this.d.notify(`task ${this.publicTitle(task)}: escalation found nobody in [${list.join(", ")}]; it stays with ${from ?? "nobody"}`);
    return this.d.board.get(next.id)!;
  }

  /** Console only. */
  async assignTo(id: unknown, peer: PeerId): Promise<Task> {
    return this.assignOwner(this.need(id, true), USER, { candidates: [peer], event: "reassigned" });
  }

  /**
   * Budget relay: a paused peer's open work moves on. `local` first (it has no quota), then the class list, all through
   * the usual constraints. Tasks it was reviewing get another reviewer. Moves are reported, never taken back automatically.
   */
  async reassignForPause(peer: PeerId, context: string | undefined, urgentOnly = false): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    const moved: { id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[] = [];
    const routing = this.d.routing();
    for (const task of this.d.board.list()) {
      // Waiting out a window that resets soon (issue #36): only urgent work moves.
      if (urgentOnly && !task.signals.includes("urgent")) continue;
      if (task.owner === peer && OPEN.includes(task.state)) {
        const pii = this.isPii(task);
        const candidates = [pii ? LOCAL : PI, pii ? undefined : LOCAL, ...(routing.classes[task.class]?.peers ?? []).filter((p) => p !== LOCAL && p !== PI)].filter((p): p is PeerId => !!p);
        const back = task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, `budget pause of ${peer}`) : task;
        const next = await this.assignOwner(back, HUB, { candidates, exclude: [peer], event: "reassigned", note: `budget pause of ${peer}`, clearOnFail: true, ...(context ? { context } : {}) });
        moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner, role: "owner" });
      } else if (task.reviewer === peer && task.state !== "approved") {
        // No owner candidates: only the reviewer is wanted, and it must be neither the paused peer nor the task's owner.
        const a = assign(task, this.states(), routing, { exclude: [peer], candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}), ...this.weights(task.class) });
        const reviewer = a.reviewer && a.reviewer !== peer && a.reviewer !== task.owner ? a.reviewer : null;
        const next = this.d.board.update(task.id, HUB, "reviewer changed", { reviewer }, `budget pause of ${peer}`);
        moved.push({ id: task.id, title: this.publicTitle(task), to: reviewer, role: "reviewer" });
        if (next.state === "in_review" && reviewer && reviewer !== USER) this.sendReview(next, reviewer, `(${peer} was reviewing this and is paused for quota.)`);
        else if (next.state === "in_review" && !reviewer) this.d.notify(`task ${this.publicTitle(next)}: its reviewer ${peer} is paused and nobody else can review; use ahub review ${next.id}`);
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

  async remember(by: PeerId, input: { text?: string; title?: string; kind?: string; task?: unknown }): Promise<string> {
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("text is required");
    const task = input.task !== undefined ? this.d.board.get(Number(input.task)) : undefined;
    if (task && this.isPii(task)) throw new Error("notes about a PII task are not saved: claude-mem processes what it stores with a cloud model");
    // Shared with every other peer as well, so text that matches a PII pattern is refused like a note about a PII task.
    const title = String(input.title ?? "").trim();
    if (this.isPii({ signals: detectSignals({ title, detail: text, refs: {} }, this.d.routing(), this.d.cwd) })) throw new Error("this note matches a PII pattern and is not saved: claude-mem processes what it stores with a cloud model");
    if (!this.d.memory) return "memory is disabled; nothing saved";
    const kind = (NOTE_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) : "finding";
    const res = await this.d.memory.save({ text, ...(title ? { title } : {}), project: this.d.project, metadata: { peer: by, kind, ...(task ? { task: task.id } : {}) } });
    if (!res) return "memory worker unavailable; nothing saved";
    const line = noteLine(by, kind, title ? `${title}: ${text}` : text);
    this.d.notify(line);
    this.d.share?.(by, line);
    return "saved to shared memory; the other agents get it with their next message";
  }

  /** Auto notes: only transitions that carry content, never for PII. */
  private note(task: Task, by: PeerId, kind: string, text: string): void {
    if (this.isPii(task) || !this.d.memory) return;
    // claude-mem's observer is a cloud model: model-written text that matches a PII pattern is not sent (#69).
    if (!this.nameable(text)) return this.d.notify(`task #${task.id}: a ${kind} note was not saved to shared memory (it matches a PII pattern)`);
    void this.d.memory.save({ text, title: `agent-hub task #${task.id}: ${task.title}`.slice(0, 120), project: this.d.project, metadata: { peer: by, task: task.id, kind } });
  }

  private tell(task: Task, body: string, pii: boolean): void {
    if (!task.owner || task.owner === USER) return;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner], kind: "task", priority: "important", refs: { task: String(task.id) }, ...(pii ? { private: true } : {}) }));
  }
}

export { LOCAL };
