import { Database } from "bun:sqlite";
import type { PeerId } from "./envelope.ts";

export interface UsageWindow {
  id: "5h" | "week" | "tokens";
  /** 0..1 */
  used: number;
  /** epoch ms */
  resetsAt?: number;
  /** length of the window, for a fallback reset time */
  windowMins?: number;
  source: string;
}
interface Reading extends UsageWindow {
  at: number;
}

export interface Moved {
  id: number;
  title: string;
  to: PeerId | null;
  role: "owner" | "reviewer";
}
export interface PauseRecord {
  peer: PeerId;
  since: number;
  resetsAt: number;
  reason: string;
  summary: string | null;
  handedOff: boolean;
  moved: Moved[];
}

export interface BudgetConfig {
  gate: number;
  stale_min: number;
  poll_min: number;
  checkpoint_timeout_s: number;
  kimi_tokens_5h: number;
}
export const DEFAULT_BUDGET: BudgetConfig = { gate: 0.9, stale_min: 30, poll_min: 10, checkpoint_timeout_s: 90, kimi_tokens_5h: 0 };

export interface BudgetHooks {
  pause(peer: PeerId): void;
  /** Must leave a manual `ahub pause` in place. */
  resume(peer: PeerId): void;
  /** Ask the peer to checkpoint; resolves with its summary, or undefined on timeout or when it cannot run a turn. */
  requestCheckpoint(peer: PeerId): Promise<string | undefined>;
  /** What memory knows about the peer's recent work, when it left no checkpoint. */
  platformContext(peer: PeerId): Promise<string | undefined>;
  /** Is the peer itself attached? A resume notice published for a peer the bus does not know would be dropped. */
  attached(peer: PeerId): boolean;
  /** Is anybody attached who could take work over? Without one a handoff would only strip the tasks of their owner. */
  canHandOff(peer: PeerId): boolean;
  /** Move the peer's open work. */
  handoff(peer: PeerId, context: string | undefined): Promise<Moved[]>;
  resumed(record: PauseRecord): void;
  notify(line: string): void;
}

const HYSTERESIS = 0.1;
const FALLBACK_WINDOW_MINS = 300;
/** Peers the coordinator never pauses: the local worker has no quota. */
const EXEMPT = new Set<PeerId>(["local", "user", "hub"]);

/**
 * Budget relay. Readings come from the adapters (Codex rate limits, Claude's status line, Kimi tokens) or from
 * `ahub budget set`. Over the gate: checkpoint first, pause second, hand the open work over, and resume when the window
 * resets. One open record per peer, kept in hub.db, so repeated readings do nothing and a restart keeps the pause.
 */
export class Budget {
  private readonly db: Database;
  private readonly readings = new Map<PeerId, Map<string, Reading>>();
  private readonly pausing = new Set<PeerId>();
  private readonly handingOff = new Set<PeerId>();
  /** `ahub budget resume`: the owner overrode a pause; readings over the gate are ignored for that peer until then. */
  private readonly ignoreUntil = new Map<PeerId, number>();
  private closed = false;
  private recoveryHeld = false;
  private deferred = false;
  private readonly deferredHard = new Set<PeerId>();

  constructor(
    dbPath: string,
    private readonly cfg: BudgetConfig,
    private readonly hooks: BudgetHooks,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(dbPath, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS budget_pauses (peer TEXT PRIMARY KEY, since INTEGER NOT NULL, resets_at INTEGER NOT NULL,
      reason TEXT NOT NULL, summary TEXT, handed_off INTEGER NOT NULL DEFAULT 0, moved TEXT NOT NULL DEFAULT '[]')`);
  }

  /** Freeze pause/resume and handoff transitions while a controlled restart is fenced. Readings continue to update. */
  setRecoveryHold(held: boolean): void {
    this.recoveryHeld = held;
    if (!held && this.deferred && !this.closed) {
      this.deferred = false;
      this.tick();
      for (const peer of this.readings.keys()) {
        const hard = this.deferredHard.delete(peer);
        void this.evaluate(peer, hard).catch((e: Error) => this.closed || this.hooks.notify(`budget: evaluating ${peer} failed: ${e.message}`));
      }
    }
  }

  get recoverySettled(): boolean {
    return this.pausing.size === 0 && this.handingOff.size === 0;
  }

  record(peer: PeerId): PauseRecord | undefined {
    const r = this.db.query("SELECT * FROM budget_pauses WHERE peer = ?").get(peer) as Record<string, any> | null;
    return r ? { peer: r.peer, since: r.since, resetsAt: r.resets_at, reason: r.reason, summary: r.summary, handedOff: !!r.handed_off, moved: JSON.parse(r.moved) } : undefined;
  }

  /** Recovery integrity input: persisted pause records only, excluding live usage readings and private summaries. */
  persistedPauseDigestRows(): { peer: PeerId; since: number; resetsAt: number; reason: string }[] {
    return this.records().map(({ peer, since, resetsAt, reason }) => ({ peer, since, resetsAt, reason }));
  }

  private records(): PauseRecord[] {
    return (this.db.query("SELECT peer FROM budget_pauses").all() as { peer: string }[]).map((r) => this.record(r.peer)!);
  }

  /**
   * After a hub restart: open records keep their peers paused. A window that reset while the hub was down is simply
   * lifted. A handoff that was cut short is left to tick(): at start nobody is attached yet, and handing over to
   * nobody would only take the tasks away from their owner.
   */
  restore(): void {
    for (const r of this.records()) {
      if (this.now() >= r.resetsAt) {
        // Not paused again, but the record stays until the peer attaches: tick() then resumes it the usual way, so it
        // still gets the one envelope that says what moved while it was away.
        this.hooks.notify(`budget: ${r.peer}'s window reset while the hub was down; it will be told what moved when it attaches`);
        continue;
      }
      this.hooks.pause(r.peer);
      this.hooks.notify(`budget: ${r.peer} is still paused (${r.reason}), resumes ${new Date(r.resetsAt).toLocaleTimeString()}`);
    }
  }

  /** `hard`: the peer cannot run another turn (its provider refused one), so there is nobody to ask for a checkpoint. */
  /** `at`: when the numbers were measured, for sources that arrive through a file (a leftover file is not a fresh reading). */
  report(peer: PeerId, windows: UsageWindow[], hard = false, at = this.now()): void {
    if (EXEMPT.has(peer) || this.closed) return;
    const mine = this.readings.get(peer) ?? new Map<string, Reading>();
    this.readings.set(peer, mine);
    for (const w of windows) mine.set(w.id, { ...w, used: Math.max(0, Math.min(1, w.used)), at });
    if (this.recoveryHeld) { this.deferred = true; if (hard) this.deferredHard.add(peer); return; }
    this.evaluate(peer, hard).catch((e: Error) => this.closed || this.hooks.notify(`budget: evaluating ${peer} failed: ${e.message}`));
  }

  /** Readings that still say something: not stale, and not about a window that has reset since they were taken. */
  private fresh(peer: PeerId): Reading[] {
    const staleMs = this.cfg.stale_min * 60_000;
    return [...(this.readings.get(peer)?.values() ?? [])].filter((r) => this.now() - r.at <= staleMs && !(r.resetsAt && r.resetsAt <= this.now()));
  }

  /** The owner's override: lift the pause now and leave the peer alone until the window that caused it has reset. */
  override(peer: PeerId): boolean {
    const open = this.record(peer);
    if (!open) return false;
    this.ignoreUntil.set(peer, open.resetsAt);
    this.resume(peer, "overridden by the console user");
    return true;
  }

  private async evaluate(peer: PeerId, hard: boolean): Promise<void> {
    if (this.recoveryHeld) { this.deferred = true; if (hard) this.deferredHard.add(peer); return; }
    const fresh = this.fresh(peer);
    const over = fresh.filter((r) => r.used >= this.cfg.gate);
    const open = this.record(peer);
    if (open) {
      // A later reading may finally carry the reset time the first one lacked.
      const known = Math.max(0, ...over.map((r) => r.resetsAt ?? 0));
      if (known && known !== open.resetsAt) this.db.query("UPDATE budget_pauses SET resets_at = ? WHERE peer = ?").run(known, peer);
      const newer = fresh.filter((r) => r.at > open.since);
      if (newer.length && fresh.every((r) => r.used < this.cfg.gate - HYSTERESIS)) this.resume(peer, "usage is back under the gate");
      return;
    }
    if (!over.length || this.pausing.has(peer) || this.now() < (this.ignoreUntil.get(peer) ?? 0)) return;
    this.pausing.add(peer);
    try {
      const worst = over.reduce((a, b) => (b.used > a.used ? b : a));
      const resetsAt = Math.max(...over.map((r) => r.resetsAt ?? this.now() + (r.windowMins ?? FALLBACK_WINDOW_MINS) * 60_000));
      const reason = `${worst.id} window at ${Math.round(worst.used * 100)}% (${worst.source})`;
      // Checkpoint first, pause second: a paused peer receives nothing, and a turn in flight is never cut by the coordinator.
      const summary = hard ? undefined : await this.hooks.requestCheckpoint(peer).catch(() => undefined);
      if (this.recoveryHeld) { this.deferred = true; return; }
      if (this.closed) return; // the hub is shutting down: nothing is recorded, the next run sees the reading again
      this.db.query("INSERT OR REPLACE INTO budget_pauses (peer, since, resets_at, reason, summary) VALUES (?, ?, ?, ?, ?)").run(peer, this.now(), resetsAt, reason, summary ?? null);
      this.hooks.pause(peer);
      this.hooks.notify(`budget: ${peer} paused, ${reason}; resumes ${new Date(resetsAt).toLocaleTimeString()}${summary ? "; checkpoint received" : hard ? "; hard limit, no checkpoint" : "; no checkpoint"}`);
      await this.finishHandoff(peer, summary);
    } finally {
      this.pausing.delete(peer);
    }
  }

  private async finishHandoff(peer: PeerId, summary: string | undefined): Promise<void> {
    if (this.closed || this.recoveryHeld) { this.deferred = true; return; }
    if (this.handingOff.has(peer) || !this.hooks.canHandOff(peer)) return; // retried by the next tick
    this.handingOff.add(peer);
    try {
      await this.handOff(peer, summary);
      if (this.recoveryHeld) { this.deferred = true; return; }
    } finally {
      this.handingOff.delete(peer);
    }
  }

  private async handOff(peer: PeerId, summary: string | undefined): Promise<void> {
    const context = summary ?? (await this.hooks.platformContext(peer).catch(() => undefined));
    let moved: Moved[];
    try {
      moved = await this.hooks.handoff(peer, context);
    } catch (e) {
      // Left unmarked on purpose: the next tick, or the next hub run, tries again. The peer stays paused either way.
      return this.hooks.notify(`budget: handing over ${peer}'s work failed, will retry: ${(e as Error).message}`);
    }
    if (this.closed) return;
    this.db.query("UPDATE budget_pauses SET handed_off = 1, moved = ? WHERE peer = ?").run(JSON.stringify(moved), peer);
    if (moved.length) this.hooks.notify(`budget: moved from ${peer}: ${moved.map((m) => `#${m.id} ${m.role} -> ${m.to ?? "nobody"}`).join(", ")}`);
  }

  /** `hub_checkpoint` arrived from a peer. Resolved by the daemon's requestCheckpoint wait; kept on the record for a restart. */
  checkpointed(peer: PeerId, summary: string): void {
    if (this.closed) return; // a hub_checkpoint that lands during shutdown
    this.db.query("UPDATE budget_pauses SET summary = ? WHERE peer = ?").run(summary, peer);
  }

  /** Called on a timer. Resumes every peer whose window has reset. */
  tick(): void {
    if (this.recoveryHeld) { this.deferred = true; return; }
    for (const r of this.records()) {
      if (this.now() >= r.resetsAt + 60_000) {
        if (this.hooks.attached(r.peer)) this.resume(r.peer, "the window has reset"); // else: wait, the notice needs somebody to receive it
      }
      else if (!r.handedOff && !this.pausing.has(r.peer)) void this.finishHandoff(r.peer, r.summary ?? undefined);
    }
  }

  private resume(peer: PeerId, why: string): void {
    const record = this.record(peer);
    if (!record) return;
    this.db.query("DELETE FROM budget_pauses WHERE peer = ?").run(peer);
    this.readings.get(peer)?.clear(); // the old numbers describe the window that just ended
    // The notice is queued while the peer is still paused, so it leads the first delivery: the peer learns what moved
    // before it touches anything that was waiting for it.
    this.hooks.resumed(record);
    this.hooks.resume(peer);
    this.hooks.notify(`budget: ${peer} resumed (${why})`);
  }

  status(): Record<PeerId, { windows: (Reading & { stale: boolean })[]; paused?: { reason: string; resetsAt: number; since: number } }> {
    const staleMs = this.cfg.stale_min * 60_000;
    const peers = new Set([...this.readings.keys(), ...this.records().map((r) => r.peer)]);
    return Object.fromEntries(
      [...peers].map((peer) => {
        const open = this.record(peer);
        return [peer, { windows: [...(this.readings.get(peer)?.values() ?? [])].map((r) => ({ ...r, stale: this.now() - r.at > staleMs })), ...(open ? { paused: { reason: open.reason, resetsAt: open.resetsAt, since: open.since } } : {}) }];
      }),
    );
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }
}

/** Codex `rateLimits` snapshot (account/rateLimits/read, account/rateLimits/updated) -> windows. */
export function codexWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  // The slot decides (primary = short window, secondary = long one) and the duration overrides it when present:
  // readings are keyed by window id, so two windows must never both come out as "5h".
  for (const [w, slot] of [[rateLimits?.primary, "5h"], [rateLimits?.secondary, "week"]] as const) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined;
    const id = mins === undefined ? slot : mins > 600 ? "week" : "5h";
    if (out.some((o) => o.id === id)) continue; // both slots claim the same window: keep the first, never overwrite
    out.push({ id, used: w.usedPercent / 100, ...(w.resetsAt ? { resetsAt: w.resetsAt * 1000 } : {}), ...(mins ? { windowMins: mins } : {}), source: "codex rateLimits" });
  }
  if (rateLimits?.rateLimitReachedType && !out.some((w) => w.used >= 1)) out.push({ id: "5h", used: 1, source: `codex ${rateLimits.rateLimitReachedType}` });
  return out;
}

/** Claude Code status line `rate_limits` -> windows. */
export function claudeWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, id, mins] of [["five_hour", "5h", 300], ["seven_day", "week", 10_080]] as const) {
    const w = rateLimits?.[key];
    if (!w || typeof w.used_percentage !== "number") continue;
    const resets = Number(w.resets_at);
    out.push({ id, used: w.used_percentage / 100, ...(resets ? { resetsAt: resets < 1e12 ? resets * 1000 : resets } : {}), windowMins: mins, source: "claude status line" });
  }
  return out;
}
