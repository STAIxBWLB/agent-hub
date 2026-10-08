import type { HistoryEntry, Task } from "./board.ts";
import { sanitize, type Kind, type Priority } from "./envelope.ts";

export type SupervisionScope = "own" | "all" | "off";
export type SupervisionMilestone = "assigned" | "accepted" | "declined" | "done" | "review" | "approved" | "moved" | "escalated" | "stuck" | "sweep";
/** Codes, never free-form notes or check output. */
export type SupervisionReason = "manual" | "budget" | "offline" | "idle" | "rejections" | "repetition" | "false_progress" | "drift" | "desperation" | "capability_gap";
export interface SupervisionFields {
  by?: string;
  owner?: string | null;
  check?: "passed" | "failed" | "unknown";
  verdict?: "approved" | "changes_requested";
  reason?: SupervisionReason;
  sweep?: "unaccepted-assignment" | "idle-owner" | "review-pending";
}
export interface SupervisionNotice {
  peer: string;
  /** Replace only queued entries with this key; accepted/in-flight deliveries stay authoritative. */
  key: string;
  body: string;
  priority: Priority;
  kind: Kind;
  task?: number;
}
export interface SupervisionDeps {
  /** Current role holder; undefined immediately revokes the feed. */
  conductor: () => string | undefined;
  scope: () => SupervisionScope;
  tasks: () => Task[];
  publicTitle: (task: Task) => string;
  isPrivate: (task: Task) => boolean;
  /** false means not admitted, so latches must remain retryable. No separate batching timer. */
  emit: (notice: SupervisionNotice) => boolean | void;
  approvalAgeMs?: number;
  now?: () => number;
  /** Durable round state belongs to the daemon's store, not the controller. */
  readRound?: (peer: string) => string | undefined;
  writeRound?: (peer: string, signature: string) => void;
}

/** Deterministic milestone producer. The Bus alone owns batching, retry and native turns. */
export class SupervisionFeed {
  private readonly approvals = new Set<string>();
  private readonly holds = new Set<string>();
  private readonly rounds = new Map<string, string>();
  constructor(private readonly d: SupervisionDeps) {}

  /** Pending notices may have been withdrawn on role/off change; live requests can notify again on regrant. */
  resetPending(peer: string): void {
    for (const key of this.approvals) if (key.startsWith(`${peer}:`)) this.approvals.delete(key);
    for (const key of this.holds) if (key.startsWith(`${peer}:`)) this.holds.delete(key);
  }

  private recipient(): string | undefined {
    return this.d.scope() === "off" ? undefined : this.d.conductor();
  }

  includes(task: Task): boolean {
    const peer = this.recipient();
    return !!peer && (this.d.scope() === "all" || task.history.some((h) => h.by === peer && ["proposed", "assigned", "reassigned", "escalated"].includes(h.event)));
  }

  private send(key: string, body: string, priority: Priority = "status", task?: number, kind: Kind = "task"): boolean {
    const peer = this.recipient();
    if (!peer) return false;
    try {
      return this.d.emit({ peer, key: `supervision:${peer}:${key}`, body: sanitize(body), priority, kind, ...(task === undefined ? {} : { task }) }) !== false;
    } catch { return false; } // a feed failure must not invalidate a successful board write
  }

  milestone(id: number, milestone: SupervisionMilestone, fields: SupervisionFields = {}): boolean {
    const task = this.d.tasks().find((t) => t.id === id);
    if (!task || !this.includes(task)) return false;
    if (this.d.isPrivate(task)) return this.send(`task:${id}:${milestone}`, `#${id} [pii]: ${milestone}; ahub task show ${id}`, "status", id);
    const bits = [this.d.publicTitle(task), milestone];
    if (fields.by) bits.push(`by ${fields.by}`);
    if ("owner" in fields) bits.push(`owner ${fields.owner ?? "none"}`);
    if (fields.check) bits.push(`check ${fields.check}`);
    if (fields.verdict) bits.push(`verdict ${fields.verdict}`);
    if (fields.reason) bits.push(`reason ${fields.reason}`);
    if (fields.sweep) bits.push(`finding ${fields.sweep}`);
    return this.send(`task:${id}:${milestone}`, bits.join("; "), "status", id);
  }

  /** Only structured history metadata is read; notes may contain private content. */
  taskChanged(task: Task, entry: HistoryEntry, metadata: SupervisionFields = {}): void {
    const fields: SupervisionFields = { by: entry.by, owner: task.owner, ...metadata };
    const event = entry.event;
    if (event === "done" || event === "check failed") {
      const latestCheck = task.history.findLast((h) => ["check passed", "check failed", "check interrupted", "done (checking)", "accepted", "reopened"].includes(h.event));
      fields.check = event === "check failed" ? "failed" : metadata.check ?? (latestCheck?.event === "check passed" ? "passed" : "unknown");
      this.milestone(task.id, "done", fields);
      if (event === "done" && task.state === "approved") this.milestone(task.id, "approved", fields);
    } else if (event === "changes_requested") this.milestone(task.id, "review", { ...fields, verdict: "changes_requested" });
    else if (event === "approved") {
      this.milestone(task.id, "review", { ...fields, verdict: "approved" });
      this.milestone(task.id, "approved", fields);
    } else if (event === "idle sweep" && entry.sweep) this.milestone(task.id, "sweep", { ...fields, sweep: entry.sweep.kind });
    else if (event === "reassigned") this.milestone(task.id, "moved", fields);
    else if (["assigned", "accepted", "declined", "escalated"].includes(event)) this.milestone(task.id, event as SupervisionMilestone, fields);
    this.checkRound();
  }

  peerOffline(peer: string): boolean {
    if (this.d.scope() !== "all" && !this.d.tasks().some((t) => this.includes(t) && t.state !== "approved" && (t.owner === peer || t.reviewer === peer))) return false;
    return this.send(`peer:${peer}:offline`, `${peer}: offline`);
  }

  budgetPaused(peer: string, resetsAt?: number): boolean {
    if (this.d.scope() !== "all" && !this.d.tasks().some((t) => this.includes(t) && t.state !== "approved" && (t.owner === peer || t.reviewer === peer))) return false;
    const resetDate = new Date(resetsAt ?? NaN);
    const reset = Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : "unknown";
    return this.send(`peer:${peer}:budget`, `${peer}: budget paused; reset ${reset}`, "status", undefined, "budget");
  }

  approvalWaiting(request: { id: string; peer: string; tool: string; createdAt: number }): boolean {
    const peer = this.recipient();
    const age = (this.d.now?.() ?? Date.now()) - request.createdAt;
    const key = `${peer}:${request.id}`;
    if (!peer || !Number.isFinite(age) || age < (this.d.approvalAgeMs ?? 60_000) || this.approvals.has(key)) return false;
    const sent = this.send(`approval:${request.id}`, `${request.peer}: approval waiting; tool ${request.tool}; age ${Math.floor(age / 1000)}s; ask the person to answer it in ahub console`, "important");
    if (sent) this.approvals.add(key);
    return sent;
  }

  needsReview(peer: string, deliveryId: string): boolean {
    const conductor = this.recipient();
    const key = `${conductor}:${peer}:${deliveryId}`;
    if (!conductor || this.holds.has(key)) return false;
    const sent = this.send(`hold:${peer}:${deliveryId}`, `${peer}: needs_review hold; delivery ${deliveryId}; ask the person to resolve it with ahub queue resolve`, "important");
    if (sent) this.holds.add(key);
    return sent;
  }

  checkRound(): boolean {
    const peer = this.recipient();
    if (!peer) return false;
    const tasks = this.d.tasks().filter((t) => this.includes(t));
    if (!tasks.length || tasks.some((t) => t.state !== "approved")) return false;
    const signature = tasks.map((t) => t.id).sort((a, b) => a - b).join(",");
    const previous = this.d.readRound?.(peer) ?? this.rounds.get(peer);
    const completed = new Set(previous?.split(",") ?? []);
    const newlyJoined = tasks.filter((t) => !completed.has(String(t.id)));
    if (!newlyJoined.length) return false;
    const sent = this.send("round", `Supervision round complete: ${newlyJoined.length} task${newlyJoined.length === 1 ? "" : "s"} approved; report the results and open decisions to the person.`);
    if (sent) {
      this.rounds.set(peer, signature);
      this.d.writeRound?.(peer, signature);
    }
    return sent;
  }
}
