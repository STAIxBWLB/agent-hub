import type { Briefs } from "../memory/brief.ts";
import type { MemoryClient } from "../memory/client.ts";
import { CLASSES, type Board, type Task, type TaskClass, type TaskRefs } from "./board.ts";
import type { Bus } from "./bus.ts";
import { HUB, newEnvelope, USER, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
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
  /** Optional: name a class for a task proposed without one. `onCampus` says whether the model call stays on campus. */
  triage?: { classify: (title: string, detail: string) => Promise<TaskClass | undefined>; onCampus: () => Promise<boolean> };
}

const ESCALATE_AFTER = 2;
const OPEN: Task["state"][] = ["proposed", "in_progress", "changes_requested"];

/** Tool callers are models: inputSchema is not enforced on the way in, so refs are normalized before they reach the board. */
function cleanRefs(input: unknown): TaskRefs {
  const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
  const paths = (Array.isArray(r.paths) ? r.paths : typeof r.paths === "string" ? [r.paths] : []).map(text).filter((p): p is string => !!p).slice(0, 50);
  const out: TaskRefs = {};
  for (const k of ["repo", "branch", "commit"] as const) if (text(r[k])) out[k] = text(r[k])!;
  if (paths.length) out.paths = paths;
  return out;
}

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
    return this.isPii(task) ? { ...rest, refs: {}, title: "[pii]", detail: "[pii]" } : { ...rest, title, detail, history: history.slice(-5) };
  }

  private states(): Record<PeerId, PeerState> {
    return Object.fromEntries([...this.d.bus.peers.keys()].map((id) => [id, this.d.bus.stateOf(id)]));
  }

  async propose(by: PeerId, input: { title?: string; detail?: string; class?: string; refs?: TaskRefs; owner?: PeerId }): Promise<Task> {
    const title = String(input.title ?? "").trim().slice(0, 300); // callers are models: a title is a line, not a document
    if (!title) throw new Error("title is required");
    const given = input.class === undefined || input.class === "" ? undefined : input.class;
    if (given !== undefined && !CLASSES.includes(given as TaskClass)) throw new Error(`class must be one of ${CLASSES.join(", ")}`);
    const text = { title, detail: String(input.detail ?? "").slice(0, 8000), refs: cleanRefs(input.refs) };
    const signals = detectSignals(text, this.d.routing(), this.d.cwd);
    let cls = given as TaskClass | undefined;
    let triaged = false;
    if (!cls && this.d.triage) {
      // Signals first: a PII task's text may only go to a model that is reached without leaving the campus network.
      const pii = signals.includes("pii") && this.d.routing().constraints.pii === "local_only";
      if (!pii || (await this.d.triage.onCampus().catch(() => false))) cls = await this.d.triage.classify(text.title, text.detail).catch(() => undefined);
      triaged = !!cls;
    }
    if (!cls) throw new Error(`class is required (one of ${CLASSES.join(", ")}); the hub could not name one for you`);
    const draft = { ...text, class: cls };
    let task = this.d.board.propose(by, { ...draft, signals });
    if (triaged) task = this.d.board.update(task.id, "hub", "triaged", {}, `class ${cls} named by the hub's model`);
    this.d.notify(`task ${this.publicTitle(task)} proposed by ${by} [${task.class}]${task.signals.length ? ` signals: ${task.signals.join(", ")}` : ""}`);
    return this.assignOwner(task, by, input.owner ? { candidates: [input.owner] } : {});
  }

  /** Same code as assignment, without doing it. */
  explain(target: number | { title: string; detail?: string; class: TaskClass; refs?: TaskRefs }): string[] {
    const routing = this.d.routing();
    if (typeof target === "number") {
      const task = this.d.board.get(target);
      if (!task) throw new Error(`no task #${target}`);
      return [`task ${this.publicTitle(task)} (${task.state}, owner ${task.owner ?? "none"})`, "if it were assigned now:", ...assign(task, this.states(), routing, { exclude: this.declined(task) }).trace];
    }
    const draft = { title: target.title, detail: target.detail ?? "", refs: target.refs ?? {} };
    return assign({ class: target.class, signals: detectSignals(draft, routing, this.d.cwd) }, this.states(), routing).trace;
  }

  private declined = (task: Task) => task.history.filter((h) => h.event === "declined").map((h) => h.by);

  private async assignOwner(task: Task, by: PeerId, opts: { candidates?: PeerId[]; event?: string; note?: string; clearOnFail?: boolean; exclude?: PeerId[]; context?: string } = {}): Promise<Task> {
    const a = assign(task, this.states(), this.d.routing(), { exclude: [...this.declined(task), ...(opts.exclude ?? []), ...(opts.event === "escalated" && task.owner ? [task.owner] : [])], ...(opts.candidates ? { candidates: opts.candidates } : {}) });
    if (!a.owner) {
      this.d.notify(`task ${this.publicTitle(task)}: no peer can take it (${a.trace.filter((l) => l.includes("skipped")).length} skipped); assign with: ahub task assign ${task.id} <peer>`);
      // Only a decline takes the task away from its owner; a failed console assign or escalation leaves it where it was.
      return opts.clearOnFail && task.owner ? this.d.board.update(task.id, by, "unassigned", { owner: null }) : task;
    }
    const next = this.d.board.update(task.id, by, opts.event ?? "assigned", { owner: a.owner, reviewer: a.reviewer ?? null, ...(opts.event === "escalated" ? { rejections: 0 } : {}) }, opts.note ?? `to ${a.owner}`);
    await this.sendTask(next, a, opts.context);
    return next;
  }

  private async sendTask(task: Task, a: Assignment, context?: string): Promise<void> {
    const pii = this.isPii(task);
    const brief = pii ? undefined : await this.d.briefs?.forTask(task.owner!, task).catch(() => undefined);
    const rejected = task.history.filter((h) => h.event === "changes_requested").map((h) => `- ${h.by}: ${h.note ?? ""}`);
    const facts = [`class ${task.class}`, a.owner === PI ? `backend pi/${a.piBackend ?? "dgx"}` : "", task.refs.paths?.length ? `paths ${task.refs.paths.join(", ")}` : "", task.refs.branch ? `branch ${task.refs.branch}` : "", a.reviewer ? `reviewer ${a.reviewer}` : "no reviewer"].filter(Boolean).join("; ");
    const body = [
      `Task #${task.id} [${task.class}] ${task.title}`,
      task.detail,
      `Facts: ${facts}`,
      rejected.length ? `Earlier review notes:\n${rejected.join("\n")}` : "",
      brief ?? "",
      // What the previous owner left behind. Peer-written free text: never attached to a PII task.
      context && !pii ? `Handoff from the previous owner:\n${context.slice(0, 3000)}` : "",
      `Take it with hub_task_accept {id: ${task.id}} or pass with hub_task_decline. When finished: hub_task_done {id: ${task.id}, summary, refs}.`,
    ].filter(Boolean).join("\n\n");
    this.d.bus.publish(newEnvelope(HUB, body, { to: [task.owner!], kind: "task", priority: "important", refs: { ...task.refs, task: String(task.id) }, ...(pii ? { private: true } : {}) }));
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

  accept(by: PeerId, id: unknown): Task {
    const task = this.need(id);
    this.mine(task, by, "owner");
    const next = this.d.board.update(task.id, by, "accepted", { state: "in_progress" });
    this.d.notify(`task ${this.publicTitle(next)} accepted by ${by}`);
    return next;
  }

  async decline(by: PeerId, id: unknown, reason?: string): Promise<Task> {
    const task = this.need(id, true);
    this.mine(task, by, "owner");
    const back = this.d.board.update(task.id, by, "declined", task.state === "in_progress" ? { state: "proposed" } : {}, reason);
    this.d.notify(`task ${this.publicTitle(back)} declined by ${by}${reason && !this.isPii(back) ? `: ${reason}` : ""}`);
    return this.assignOwner(back, HUB, { event: "reassigned", clearOnFail: true });
  }

  async done(by: PeerId, id: unknown, summary?: string, refs?: TaskRefs): Promise<Task> {
    let task = this.need(id);
    this.mine(task, by, "owner");
    if (task.state === "in_review" || task.state === "approved") throw new Error(`task #${task.id} is already ${task.state}`);
    if (task.state === "proposed" || task.state === "changes_requested") task = this.d.board.update(task.id, by, "accepted", { state: "in_progress" }); // done without a separate accept
    const reviewer = task.reviewer;
    const next = this.d.board.update(task.id, by, "done", { state: reviewer ? "in_review" : "approved", refs: cleanRefs(refs) }, summary);
    this.note(next, by, "finding", `Task #${next.id} done by ${by}: ${next.title}\n${summary ?? ""}`);
    if (!reviewer) this.d.notify(`task ${this.publicTitle(next)} done by ${by}, no reviewer: approved`);
    else if (reviewer === USER) this.d.notify(`task ${this.publicTitle(next)} done by ${by}: review it with ahub task show ${next.id}, then ahub review ${next.id} approved|changes_requested [note]`);
    else this.sendReview(next, reviewer);
    return next;
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
    if (!this.d.memory) return "memory is disabled; nothing saved";
    const kind = ["decision", "finding", "contract"].includes(String(input.kind)) ? String(input.kind) : "finding";
    const res = await this.d.memory.save({ text, ...(input.title ? { title: input.title } : {}), project: this.d.project, metadata: { peer: by, kind, ...(task ? { task: task.id } : {}) } });
    return res ? "saved to shared memory" : "memory worker unavailable; nothing saved";
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
