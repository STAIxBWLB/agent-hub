import type { Briefs } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { CLASSES, PLAN_KEYS, type Board, type Task, type TaskClass, type TaskPlan, type TaskRefs } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, NOTE_KINDS, noteLine, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import { assign, detectSignals, LOCAL, PI, type Assignment, type Routing } from "./routing.ts";

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
  /** Optional: name a class for a task proposed without one. `onCampus` says whether the model call stays on campus. */
  triage?: { classify: (title: string, detail: string) => Promise<TaskClass | undefined>; onCampus: () => Promise<boolean> };
}

const ESCALATE_AFTER = 2;
const OPEN: Task["state"][] = ["proposed", "in_progress", "changes_requested"];
/** Board events that leave a task where its completion check found it; any other event means it moved on meanwhile. */
const QUIET_EVENTS = new Set(["answer", "reviewer changed"]);

/** Same path, or one is a directory of the other; the project root (`.`) holds everything. */
export const samePlace = (a: string, b: string) => {
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const [x, y] = [norm(a), norm(b)];
  return x === "." || y === "." || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

/** One line of model-written text: whitespace (newlines included) collapses, so it can never start a forged log line. */
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 300) : undefined);
/** A list of short strings; a lone string counts as a list of one. */
const textList = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(text).filter((p): p is string => !!p).slice(0, 50);
const fields = (input: unknown) => (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;

/** Tool callers are models: inputSchema is not enforced on the way in, so refs are normalized before they reach the board. */
function cleanRefs(input: unknown): TaskRefs {
  const r = fields(input);
  const paths = textList(r.paths);
  const out: TaskRefs = {};
  for (const k of ["repo", "branch", "commit"] as const) if (text(r[k])) out[k] = text(r[k])!;
  if (paths.length) out.paths = paths;
  return out;
}

/** The same for a plan (issue #31): only its four lists, each of short strings. */
function cleanPlan(input: unknown): TaskPlan {
  const r = fields(input);
  return Object.fromEntries(PLAN_KEYS.map((k) => [k, textList(r[k])] as const).filter(([, v]) => v.length));
}

/** A plan as one line for other owners; the whole plan is on the board. */
const planText = (plan: TaskPlan = {}) => PLAN_KEYS.filter((k) => plan[k]?.length).map((k) => `${k.replace("_", " ")}: ${plan[k]!.join("; ")}`).join(" | ");

/**
 * The task flow. Adapters and tools never touch the board: every change comes through here, where assignment,
 * PII handling, envelopes, briefs and memory notes are decided in one place.
 */
export class Tasks {
  constructor(private readonly d: TasksDeps) {
    // What the on-prem worker says about a PII task is private on the bus (console tail and log show a stub), so the
    // board keeps the text: `ahub task show <id>` is where the console user reads it, a refusal included.
    d.bus.tap((e) => {
      if (e.t !== "envelope" || !e.env.private || e.env.from === HUB || !e.env.refs?.task) return;
      try {
        d.board.update(Number(e.env.refs.task), e.env.from, "answer", {}, e.env.body.slice(0, 4000));
      } catch {
        // the task is gone: nothing to attach the answer to
      }
    });
  }

  isPii = (task: Pick<Task, "signals">) => task.signals.includes("pii") && this.d.routing().constraints.pii === "local_only";

  /** What peers other than the owner, the console stream and the log may see of a task. */
  publicTitle = (task: Task) => (this.isPii(task) ? `#${task.id} [pii]` : `#${task.id} ${task.title}`);

  /** A task as a cloud peer may see it. */
  publicView(task: Task): Record<string, unknown> {
    const { title, detail, history, ...rest } = task;
    return this.isPii(task) ? { ...rest, refs: {}, plan: {}, title: "[pii]", detail: "[pii]" } : { ...rest, title, detail, history: history.slice(-5) };
  }

  private states(): Record<PeerId, PeerState> {
    return Object.fromEntries([...this.d.bus.peers.keys()].map((id) => [id, this.d.bus.stateOf(id)]));
  }

  /** Dependencies of a task that are not approved yet: while there are any, it is offered to nobody (issue #34). */
  waitsFor = (task: Pick<Task, "deps">): number[] => (task.deps ?? []).filter((id) => this.d.board.get(id)?.state !== "approved");

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; refs?: TaskRefs; plan?: TaskPlan; owner?: PeerId; after?: unknown }): Promise<Task> {
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
    const who = forOwner ? "Settle it with that owner via hub_send before editing those paths." : `${task.owner ?? "Whoever takes it"} is told to settle it.`;
    return `Overlaps ${hits.join("; ")}. ${who}`;
  }

  /** While a gone owner's tasks move, its other tasks are about to move too: they are no one to settle with. */
  private releasing: PeerId | undefined;

  /** Whether a model-written name may be shown to other peers and in the log: one matching a PII pattern may be PII. */
  nameable = (t: string): boolean => !this.isPii({ signals: detectSignals({ title: "", detail: t, refs: {} }, this.d.routing(), this.d.cwd) });

  /** Where two tasks meet: shared paths, then shared symbols, leaving out any name that matches a PII pattern. */
  private where(hit: { paths: string[]; symbols: string[] }): string {
    const shown = [...hit.paths.filter(this.nameable), ...hit.symbols.filter(this.nameable).map((s) => `symbol ${s}`)];
    return shown.length ? shown.join(", ") : "a path whose name is withheld (it matches a PII pattern)";
  }

  /** Paths from refs and plan, symbols from the plan: the places a task says it touches (issue #31). */
  private places(task: Task): { paths: string[]; symbols: string[] } {
    return { paths: [...new Set([...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])])], symbols: task.plan?.symbols ?? [] };
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
      this.d.tell(hit.task.owner!, noteLine(HUB, "finding", `task #${task.id} (owner ${task.owner}) now overlaps your #${hit.task.id} on ${this.where(hit)}; ${task.owner} is told to settle it${plan ? `. Its plan (full: hub_task_list): ${plan}` : ""}`));
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
        if (!assign(task, this.states(), this.d.routing(), { exclude: [...this.declined(task), peer] }).owner) continue;
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
      return [`task ${this.publicTitle(task)} (${task.state}, owner ${task.owner ?? "none"})`, "if it were assigned now:", ...assign(task, this.states(), routing, { exclude: this.declined(task), waitsFor: this.waitsFor(task) }).trace];
    }
    const draft = { title: target.title, detail: target.detail ?? "", refs: target.refs ?? {} };
    return assign({ class: target.class, signals: detectSignals(draft, routing, this.d.cwd) }, this.states(), routing).trace;
  }

  private declined = (task: Task) => task.history.filter((h) => h.event === "declined").map((h) => h.by);

  private async assignOwner(task: Task, by: PeerId, opts: { candidates?: PeerId[]; event?: string; note?: string; clearOnFail?: boolean; exclude?: PeerId[]; context?: string; claim?: boolean } = {}): Promise<Task> {
    const waits = this.waitsFor(task);
    const a = assign(task, this.states(), this.d.routing(), { exclude: [...this.declined(task), ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], ...(opts.candidates ? { candidates: opts.candidates } : {}), waitsFor: waits });
    if (waits.length) {
      this.d.notify(`task ${this.publicTitle(task)} waits for ${waits.map((id) => `#${id}`).join(", ")}; it is offered once they are approved`);
      return task;
    }
    if (!a.owner) {
      this.d.notify(`task ${this.publicTitle(task)}: no peer can take it (${a.trace.filter((l) => l.includes("skipped")).length} skipped); assign with: ahub task assign ${task.id} <peer>`);
      // Only a decline takes the task away from its owner; a failed console assign or escalation leaves it where it was.
      return opts.clearOnFail && task.owner ? this.d.board.update(task.id, by, "unassigned", { owner: null }) : task;
    }
    const next = this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(opts.event === "escalated" ? { rejections: 0 } : {}) }, opts.note ?? `to ${a.owner}`);
    const hits = this.overlapHits(next);
    if (hits.length) {
      this.announceOverlap(next, hits);
      this.tellEarlierOwners(next, hits);
    }
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
    const rejected = task.history.filter((h) => h.event === "changes_requested").map((h) => `- ${h.by}: ${h.note ?? ""}`);
    const facts = [`class ${task.class}`, a.owner === PI ? `backend pi/${a.piBackend ?? "dgx"}` : "", task.refs.paths?.length ? `paths ${task.refs.paths.join(", ")}` : "", task.refs.branch ? `branch ${task.refs.branch}` : "", a.reviewer ? `reviewer ${a.reviewer}` : "no reviewer"].filter(Boolean).join("; ");
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
      context && !pii ? `Handoff from the previous owner:\n${context.slice(0, 3000)}` : "",
      `Take it with hub_task_accept {id: ${task.id}, plan: {paths, symbols, signatures, insertion_points}} (what you will change, before you start${pii ? "" : "; owners of overlapping tasks see it"}) or pass with hub_task_decline. When finished: hub_task_done {id: ${task.id}, summary: what changed, why, and the check you ran with its result, refs}.`,
    ].filter(Boolean).join("\n\n");
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner!], kind: "task", priority: "important", refs: { ...task.refs, task: String(task.id) }, ...(pii ? { private: true } : {}) }));
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

  /**
   * A stop between an approval and the assignment of its dependents (both are saved on their own) leaves them ownerless
   * with nothing left to wait for, and no later approval to offer them. The daemon calls this on its release timer:
   * each such task is offered once per hub run, once an attached peer can take it (peers attach one by one).
   */
  async releaseReady(): Promise<void> {
    for (const t of this.d.board.list("proposed")) {
      const last = t.history.at(-1)?.event;
      if (!t.deps?.length || t.owner || this.offered.has(t.id) || (last !== "blocked" && last !== "ready") || this.waitsFor(t).length) continue;
      if (!assign(t, this.states(), this.d.routing(), { exclude: this.declined(t) }).owner) continue; // nobody attached can take it yet
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
    const task = this.d.board.get(Number(id));
    if (!task) throw new Error(`no task #${id}`);
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
      const fresh = hits.filter((h) => !before.has(h.task.id));
      if (fresh.length) this.announceOverlap(next, fresh);
      this.tellEarlierOwners(next, hits);
    }
    return next;
  }

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
    if (task.state === "proposed" || task.state === "changes_requested") task = this.d.board.update(task.id, by, "accepted", { state: "in_progress" }); // done without a separate accept
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
      this.d.board.update(id, HUB, "check passed", {}, `${outcome}\n${result.tail}`.trim());
      // The output goes to the reviewer with the done note, not into shared memory: nobody screened it.
      await this.complete(this.d.board.get(id)!, by, `${summary ?? ""}\nCheck: ${outcome}`.trim(), undefined, result.tail);
      return;
    }
    this.d.board.update(id, HUB, "check failed", {}, `${outcome}\n${result.tail}`.trim());
    this.d.notify(`task ${this.publicTitle(task)}: its check failed (${outcome}); it stays with ${task.owner ?? by}`);
    this.tell(task, `Task #${id}: its check failed.\n$ ${outcome}${result.tail ? `\n${result.tail}` : ""}\nFix it and call hub_task_done again.`, pii);
  }

  private async complete(task: Task, by: PeerId, summary?: string, refs?: TaskRefs, checkOutput = ""): Promise<Task> {
    const reviewer = task.reviewer;
    const next = this.d.board.update(task.id, by, "done", { state: reviewer ? "in_review" : "approved", refs: cleanRefs(refs) }, checkOutput ? `${summary ?? ""}\n${checkOutput}`.trim() : summary);
    this.note(next, by, "finding", `Task #${next.id} done by ${by}: ${next.title}\n${summary ?? ""}`);
    this.tellCompleted(next, summary);
    if (!reviewer) {
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
    if (!hits.length) return;
    // Files, signatures and the summary are the owner's own words (paths given at done included): any item that
    // matches a PII pattern is left out of what other owners get.
    const paths = this.places(task).paths.filter(this.nameable);
    const signatures = (task.plan?.signatures ?? []).filter(this.nameable);
    const first = (summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 300);
    const line = first && this.nameable(first) ? first : undefined;
    for (const hit of hits) {
      const body = [
        `Task #${task.id} (owner ${task.owner}) is done and touches your open #${hit.task.id} on ${this.where(hit)}. Check your work against it before you go on.`,
        paths.length ? `Changed files: ${paths.join(", ")}` : "",
        signatures.length ? `New or changed signatures: ${signatures.join("; ")}` : "",
        line ? `Summary: ${line}` : "",
      ].filter(Boolean).join("\n");
      this.d.bus.publish(newEnvelope(HUB, body, { to: [hit.task.owner!], kind: "task", refs: { task: String(hit.task.id) } }));
    }
  }

  /** The one place a review request is written: the first reviewer and a replacement get the same text, refs and privacy. */
  private sendReview(task: Task, reviewer: PeerId, why = ""): void {
    const r = task.refs;
    const last = [...task.history].reverse().find((h) => h.event === "done");
    const where = [r.branch ? `branch ${r.branch}` : "", r.commit ? `commit ${r.commit}` : "", r.paths?.length ? `paths ${r.paths.join(", ")}` : ""].filter(Boolean).join("; ");
    const body = `Review task #${task.id} [${task.class}] ${task.title}\nDone by ${last?.by ?? task.owner}: ${last?.note ?? "(no summary)"}\n${where ? `Where: ${where}\n` : ""}${why ? `${why}\n` : ""}Give your verdict with hub_review {id: ${task.id}, verdict: "approved" | "changes_requested", note}.`;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [reviewer], kind: "review", priority: "important", refs: { ...r, task: String(task.id) }, ...(this.isPii(task) ? { private: true } : {}) }));
  }

  async review(by: PeerId, id: unknown, verdict: unknown, note?: string): Promise<Task> {
    const task = this.need(id);
    this.mine(task, by, "reviewer");
    if (verdict !== "approved" && verdict !== "changes_requested") throw new Error('verdict must be "approved" or "changes_requested"');
    if (task.state !== "in_review") throw new Error(`task #${task.id} is ${task.state}: cannot move to ${verdict} before its owner calls hub_task_done`);
    const pii = this.isPii(task);
    if (verdict === "approved") {
      const next = this.d.board.update(task.id, by, "approved", { state: "approved", rejections: 0 }, note);
      this.note(next, by, "decision", `Task #${next.id} approved by ${by}: ${next.title}\n${note ?? ""}`);
      this.tell(next, `Task #${next.id} approved by ${by}.${note ? ` ${note}` : ""}`, pii);
      await this.releaseDependents(next);
      return next;
    }
    const rejected = this.d.board.update(task.id, by, "changes_requested", { state: "changes_requested", rejections: task.rejections + 1 }, note);
    this.note(rejected, by, "decision", `Task #${rejected.id} changes requested by ${by}: ${rejected.title}\n${note ?? ""}`);
    if (rejected.rejections >= ESCALATE_AFTER) {
      const moved = await this.escalate(HUB, rejected.id, `${rejected.rejections} consecutive changes_requested`);
      if (moved.owner !== rejected.owner) return moved;
      // Nobody to escalate to: the owner still has to hear the verdict and the note.
      this.tell(moved, `Task #${moved.id}: ${by} requests changes again.${note ? ` ${note}` : ""} Nobody else can take it; fix it and call hub_task_done again.`, pii);
      return moved;
    }
    const reopened = this.d.board.update(rejected.id, HUB, "reopened", { state: "in_progress" });
    this.tell(reopened, `Task #${reopened.id}: ${by} requests changes.${note ? ` ${note}` : ""} Fix it and call hub_task_done again.`, pii);
    return reopened;
  }

  /** Task-level escalation: the next attached peer in the class's escalate_to takes over, with the history. */
  async escalate(by: PeerId, id: unknown, why = "by hand"): Promise<Task> {
    let task = this.need(id, true);
    const list = this.d.routing().classes[task.class]?.escalate_to ?? [];
    if (task.state === "changes_requested") task = this.d.board.update(task.id, HUB, "reopened", { state: "in_progress" });
    const from = task.owner;
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
  async reassignForPause(peer: PeerId, context: string | undefined): Promise<{ id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[]> {
    const moved: { id: number; title: string; to: PeerId | null; role: "owner" | "reviewer" }[] = [];
    const routing = this.d.routing();
    for (const task of this.d.board.list()) {
      if (task.owner === peer && OPEN.includes(task.state)) {
        const pii = this.isPii(task);
        const candidates = [pii ? LOCAL : PI, pii ? undefined : LOCAL, ...(routing.classes[task.class]?.peers ?? []).filter((p) => p !== LOCAL && p !== PI)].filter((p): p is PeerId => !!p);
        const back = task.state === "in_progress" ? this.d.board.update(task.id, HUB, "released", { state: "proposed" }, `budget pause of ${peer}`) : task;
        const next = await this.assignOwner(back, HUB, { candidates, exclude: [peer], event: "reassigned", note: `budget pause of ${peer}`, clearOnFail: true, ...(context ? { context } : {}) });
        moved.push({ id: task.id, title: this.publicTitle(task), to: next.owner, role: "owner" });
      } else if (task.reviewer === peer && task.state !== "approved") {
        // No owner candidates: only the reviewer is wanted, and it must be neither the paused peer nor the task's owner.
        const a = assign(task, this.states(), routing, { exclude: [peer], candidates: [], ...(task.owner ? { notReviewer: task.owner } : {}) });
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
    void this.d.memory.save({ text, title: `agent-hub task #${task.id}: ${task.title}`.slice(0, 120), project: this.d.project, metadata: { peer: by, task: task.id, kind } });
  }

  private tell(task: Task, body: string, pii: boolean): void {
    if (!task.owner || task.owner === USER) return;
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner], kind: "task", priority: "important", refs: { task: String(task.id) }, ...(pii ? { private: true } : {}) }));
  }
}

export { LOCAL };
