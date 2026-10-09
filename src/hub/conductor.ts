import { Database } from "bun:sqlite";
import type { Task } from "./board.ts";
import { CONDUCTOR_TOOL_NAMES } from "./hub-tools.ts";
import { HUB, USER } from "./envelope.ts";
import { OWNERSHIP_EVENTS } from "./tasks.ts";
import type { HubEvent } from "./events.ts";
import type { SupervisionFeed } from "./supervision.ts";
import type { Budget } from "./budget.ts";

/** The production ProgressObserver sink forwards structured verdicts, never its observations/reasoning. */
export function conductorProgressSink(record: (event: HubEvent) => void, feed: Pick<SupervisionFeed, "milestone">): (event: HubEvent) => void {
  return event => { record(event); if (event.type === "stuck") feed.milestone(event.task, "stuck", { reason: event.category }); };
}

export function publicPeerBudget(status: ReturnType<Budget["status"]>, nameable: (text: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(status).map(([peer, value]) => [peer, {
    windows: value.windows.map(window => ({ id: window.id, used: window.used, at: window.at, stale: window.stale,
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      ...(window.windowMins === undefined ? {} : { windowMins: window.windowMins }),
      source: nameable(window.source) ? window.source : "[quota source withheld]",
    })),
    ...(value.paused ? { paused: { since: value.paused.since, resetsAt: value.paused.resetsAt, reason: "quota" } } : {}),
  }]));
}

const PEER = /^[a-z][a-z0-9-]{0,31}$/;
const peerId = (value: unknown): string => {
  if (typeof value !== "string" || /\s/.test(value) || !PEER.test(value) || ["user", "hub", "digest"].includes(value)) throw new Error("peer must be a valid agent peer id");
  return value;
};

/** Validate before listening; missing configuration grants nobody the conductor role. */
export function conductorPeer(roles: unknown): string | null {
  if (roles === undefined) return null;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error("roles must be an object of peer role lists");
  let conductor: string | null = null;
  for (const [peer, list] of Object.entries(roles)) {
    peerId(peer);
    if (!Array.isArray(list) || list.some((r) => typeof r !== "string")) throw new Error(`roles.${peer} must be a list of role names`);
    if (!list.includes("conductor")) continue;
    if (conductor !== null) throw new Error("roles may name at most one conductor peer");
    conductor = peer;
  }
  return conductor;
}

/** The role check always comes first; default-allow capabilities cannot grant a role. */
export function requireConductor(peer: string, roles: unknown, capabilities: Record<string, unknown> = {}, assign = false): void {
  if (conductorPeer(roles) !== peer) throw new Error("this operation requires the explicit conductor role");
  if (assign) requireAssign(peer, capabilities);
}

/** A peer with an explicit capabilities list needs `assign` in it to move work. */
function requireAssign(peer: string, capabilities: Record<string, unknown>): void {
  if (!Object.hasOwn(capabilities, peer)) return;
  const caps = capabilities[peer];
  if (!Array.isArray(caps) || !caps.includes("assign")) throw new Error(`${peer} requires assign capability for this operation`);
}

export interface ConductorHold { peer: string; actor: string; since: number }

/** Actor ownership survives restart. No titles, plans, summaries or memory writes. */
export class ConductorHolds {
  private readonly db: Database;
  constructor(dbPath: string, private readonly now: () => number = Date.now) {
    this.db = new Database(dbPath, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS conductor_holds (peer TEXT PRIMARY KEY, actor TEXT NOT NULL, since INTEGER NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS supervision_rounds (peer TEXT PRIMARY KEY, signature TEXT NOT NULL)");
  }
  get(peer: string): ConductorHold | null {
    return this.db.query("SELECT peer, actor, since FROM conductor_holds WHERE peer = ?").get(peer) as ConductorHold | null;
  }
  has(peer: string): boolean { return this.get(peer) !== null; }
  list(): ConductorHold[] { return this.db.query("SELECT peer, actor, since FROM conductor_holds ORDER BY peer").all() as ConductorHold[]; }
  readRound(peer: string): string | undefined { return (this.db.query("SELECT signature FROM supervision_rounds WHERE peer = ?").get(peer) as { signature: string } | null)?.signature; }
  writeRound(peer: string, signature: string): void { this.db.query("INSERT INTO supervision_rounds (peer, signature) VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET signature = excluded.signature").run(peer, signature); }
  hold(peer: string, actor: string): ConductorHold {
    peerId(peer); peerId(actor);
    // INSERT OR IGNORE cannot take ownership of an earlier conductor's hold.
    this.db.query("INSERT OR IGNORE INTO conductor_holds (peer, actor, since) VALUES (?, ?, ?)").run(peer, actor, this.now());
    const hold = this.get(peer)!;
    if (hold.actor !== actor) throw new Error(`peer ${peer} is held by another conductor`);
    return hold;
  }
  release(peer: string, actor: string): ConductorHold {
    peerId(peer); peerId(actor);
    const hold = this.get(peer);
    if (!hold || hold.actor !== actor) throw new Error("you may release only a conductor hold you placed");
    this.db.query("DELETE FROM conductor_holds WHERE peer = ? AND actor = ?").run(peer, actor);
    return hold;
  }
  /** The daemon must authenticate a human console and check budget/local constraints first. */
  releaseByOperator(peer: string): ConductorHold | null {
    peerId(peer);
    const hold = this.get(peer);
    if (hold) this.db.query("DELETE FROM conductor_holds WHERE peer = ?").run(peer);
    return hold;
  }
  close(): void { this.db.close(); }
}

export type ConductorStart = { peer: "local" | "kimi" | "pi"; mode: "headless" } | { peer: "claude" | "codex" | "pi"; mode: "tui"; command: string };
/** Preview commands come from the same launch planner the CLI uses, never caller-supplied shell text. */
export function conductorStart(peer: unknown, mode: unknown, preview: (peer: "claude" | "codex" | "pi") => string): ConductorStart {
  if (mode !== undefined && mode !== "headless" && mode !== "tui") throw new Error("mode must be headless or tui");
  if (peer === "claude" || peer === "codex" || (peer === "pi" && mode === "tui")) return { peer, mode: "tui", command: preview(peer) };
  if ((peer === "local" || peer === "kimi" || peer === "pi") && mode !== "tui") return { peer, mode: "headless" };
  throw new Error("only local, kimi and headless pi may be started by the conductor");
}

const numberOrNull = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export interface ConductorStatusInput {
  peers: Array<{ peer: string; state?: string; attached?: boolean; queued?: number; needsReview?: number; manualHeld?: boolean; hold?: ConductorHold | null; budgetPause?: { since?: number; resetsAt?: number } | null; windows?: Array<{ id: string; used?: number; resetsAt?: number; at?: number; source?: string }> }>;
  taskCounts: Record<string, number>;
  approvals: Array<{ peer: string; tool?: string; at?: number }>;
}
/** Explicit projection, never spreads a queue, permission request or quota pause containing private text. */
export function publicConductorStatus(input: ConductorStatusInput, now = Date.now()): Record<string, unknown> {
  return {
    peers: input.peers.map((p) => ({
      peer: p.peer, state: p.state ?? "unknown", attached: p.attached ?? null,
      queued: numberOrNull(p.queued), needsReview: numberOrNull(p.needsReview),
      manualHold: p.manualHeld === undefined ? null : { held: p.manualHeld, actor: p.manualHeld ? "user" : null },
      conductorHold: p.hold ? { actor: p.hold.actor, since: numberOrNull(p.hold.since) } : null,
      budgetPause: p.budgetPause ? { since: numberOrNull(p.budgetPause.since), resetsAt: numberOrNull(p.budgetPause.resetsAt) } : null,
      windows: p.windows === undefined ? null : p.windows.map((w) => ({ id: w.id, used: numberOrNull(w.used), resetsAt: numberOrNull(w.resetsAt), at: numberOrNull(w.at), source: w.source ?? null })),
    })),
    taskCounts: Object.fromEntries(Object.entries(input.taskCounts).map(([state, count]) => [state, numberOrNull(count)])),
    approvals: input.approvals.map((a) => ({ peer: a.peer, tool: a.tool ?? null, ageMs: a.at === undefined || !Number.isFinite(a.at) ? null : Math.max(0, now - a.at) })),
  };
}

/** publicView must use Tasks.publicView(task, true), including its screened history. */
export function publicConductorTask(task: Task, publicView: (task: Task) => Record<string, unknown>): Record<string, unknown> {
  const view = publicView(task);
  if (view.title === "[pii]") return { id: task.id, title: "[pii]", detail: "[pii]", class: task.class, state: task.state, owner: task.owner, reviewer: task.reviewer, history: [] };
  return { ...view, history: Array.isArray(view.history) ? view.history : [] };
}

export interface ConductEvent {
  kind: "conduct"; actor: string; action: string; task?: number; peer?: string;
}
export interface ConductorHooks {
  roles(): unknown;
  capabilities(): Record<string, unknown>;
  status(): ConductorStatusInput;
  task(id: number): Task | undefined;
  publicView(task: Task): Record<string, unknown>;
  /** These callbacks must call Tasks, never Board.update. */
  assign(actor: string, id: number, peer: string): Promise<unknown>;
  escalate(actor: string, id: number): Promise<unknown>;
  preview(peer: "claude" | "codex" | "pi"): string;
  start(peer: "local" | "kimi" | "pi"): Promise<unknown>;
  known(peer: string): boolean;
  pause(peer: string): void;
  validateRelease?(peer: string): Promise<void>;
  /** Re-check manual, budget, recovery and remaining conductor holds before Bus.resume. */
  release(peer: string): void;
  /** Log and console notice plus events.jsonl, using this ids-only payload. Must not throw. */
  audit(event: ConductEvent): void;
}

/** A task id as `Tasks.need()` takes it: a whole number or a digit string. */
const taskId = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

export class Conductor {
  constructor(private readonly holds: ConductorHolds, private readonly hooks: ConductorHooks) {}
  async execute(actor: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!CONDUCTOR_TOOL_NAMES.has(tool)) throw new Error("unknown conductor tool");
    if ((tool === "hub_task_show" || tool === "hub_task_assign") && conductorPeer(this.hooks.roles()) !== actor) {
      const id = taskId(args.id);
      const task = id === undefined ? undefined : this.hooks.task(id);
      // A task's current owner and reviewer read its public view without the role (#208); nobody else does.
      if (task && tool === "hub_task_show" && (task.owner === actor || task.reviewer === actor)) return publicConductorTask(task, this.hooks.publicView);
      // Its proposer (the first history entry) redirects it while nobody ever accepted it (#207: a decline or a release puts
      // worked tasks back in proposed); work that waits gets a reserved owner. Never over the person: a console assign or
      // reservation stands until the conductor or the console moves it, also once the hub carried it out (the hub's own
      // moves are not decisions).
      const moved = task?.history.findLast((h) => h.by !== HUB && (OWNERSHIP_EVENTS.has(h.event) || h.event === "reserved"));
      const accepted = task?.history.some((h) => h.event === "accepted");
      if (task && tool === "hub_task_assign" && task.history[0]?.by === actor && task.state === "proposed" && !accepted && moved?.by !== USER) {
        const peer = peerId(args.peer);
        if (peer !== actor) requireAssign(actor, this.hooks.capabilities());
        await this.hooks.assign(actor, task.id, peer);
        const updated = this.hooks.task(task.id);
        return updated ? publicConductorTask(updated, this.hooks.publicView) : { id: task.id };
      }
    }
    requireConductor(actor, this.hooks.roles(), this.hooks.capabilities(), tool === "hub_task_assign" || tool === "hub_task_escalate");
    const action = tool.slice(4);
    const emit = (extra: Pick<ConductEvent, "task" | "peer"> = {}) => {
      try { this.hooks.audit({ kind: "conduct", actor, action, ...extra }); } catch { /* never throw after a task or hold write */ }
    };
    if (tool === "hub_status") { const result = publicConductorStatus(this.hooks.status()); emit(); return result; }
    if (tool.startsWith("hub_task_")) {
      const id = taskId(args.id);
      if (id === undefined) throw new Error("id must be a positive integer");
      const task = this.hooks.task(id);
      if (!task) throw new Error(`no task #${args.id}`);
      if (tool === "hub_task_show") { const result = publicConductorTask(task, this.hooks.publicView); emit({ task: task.id }); return result; }
      if (tool === "hub_task_assign") {
        const peer = peerId(args.peer);
        await this.hooks.assign(actor, task.id, peer); emit({ task: task.id, peer });
      } else { await this.hooks.escalate(actor, task.id); emit({ task: task.id }); }
      // Task callbacks may return raw objects; always re-read and apply the public view.
      const updated = this.hooks.task(task.id);
      return updated ? publicConductorTask(updated, this.hooks.publicView) : { id: task.id };
    }
    if (tool === "hub_peer_start") {
      const start = conductorStart(args.peer, args.mode, this.hooks.preview);
      if (start.mode === "headless") await this.hooks.start(start.peer);
      emit({ peer: start.peer }); return start;
    }
    const peer = peerId(args.peer);
    if (!this.hooks.known(peer)) throw new Error(`unknown peer: ${peer}`);
    if (tool === "hub_peer_hold") { this.holds.hold(peer, actor); this.hooks.pause(peer); }
    else {
      if (this.holds.get(peer)?.actor !== actor) throw new Error("you may release only a conductor hold you placed");
      await this.hooks.validateRelease?.(peer);
      requireConductor(actor, this.hooks.roles(), this.hooks.capabilities());
      this.holds.release(peer, actor); this.hooks.release(peer);
    }
    emit({ peer }); return { peer, held: this.holds.has(peer) };
  }
}
