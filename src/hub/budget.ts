import { definitionOf, type AdapterDefinition } from "../adapters/registry.ts";
import { Database } from "bun:sqlite";
import type { PeerId } from "./envelope.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";

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
/** No declared source is unknown, not a synthetic empty provider reading. */
export function readNativeQuota(definition: AdapterDefinition | undefined, value: unknown): UsageWindow[] | undefined {
  return definition?.budget?.reader?.read(value);
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
  /** A paused peer whose window resets within this many minutes keeps its work, urgent tasks aside; 0 always hands over (issue #36). */
  wait_max_min: number;
}
// wait_max_min is off here, as approvals.notify is: a project config turns it on (30 unless it says otherwise).
export const DEFAULT_BUDGET: BudgetConfig = { gate: 0.9, stale_min: 30, poll_min: 10, checkpoint_timeout_s: 90, kimi_tokens_5h: 0, wait_max_min: 0 };

export type BudgetLedgerEntry =
  | { type: "budget_pause"; peer: PeerId; reason: string; window: string; resetsAt: number; by: "hub" | "person" }
  | { type: "budget_resume"; peer: PeerId; reason: string; window: string; resetsAt: number; by: "hub" | "person" }
  | { type: "quota_reset"; peer: PeerId; window: string; cause: "resets_at_moved" | "used_dropped"; resetsAt?: number; previousResetsAt?: number; used: number; previousUsed: number; measuredAt?: string };
/** The window a pause record names: the id before ` window at` in its reason (`5h window at 93% (...)`), else unknown. */
const reasonWindow = (reason: string): string => /^(\S+) window at /.exec(reason)?.[1] ?? "unknown";

export interface BudgetHooks {
  /** Startup-bound project resolver; undefined keeps builtin-only compatibility. */
  definitionOf?(peer: PeerId): AdapterDefinition | undefined;
  /** Stable/idempotent for this Budget lifetime. All lifecycle hooks receive this canonical account id. */
  account?(peer: PeerId): PeerId;
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
  /** Move the peer's open work; with `urgentOnly`, only tasks marked urgent (the peer waits for its reset). */
  handoff(peer: PeerId, context: string | undefined, urgentOnly: boolean): Promise<Moved[]>;
  resumed(record: PauseRecord): void;
  /** Every reading as it arrives, with the time it was measured (telemetry, issue #40). */
  reading?(peer: PeerId, windows: UsageWindow[], hard: boolean, at: number): void;
  /**
   * The limit ledger (#683 U1): a pause or resume of the account, and a window reset derived from its readings. Ids, windows and
   * numbers only. Telemetry never costs a pause or a reading, so a throwing hook is ignored.
   */
  ledger?(entry: BudgetLedgerEntry): void;
  notify(line: string): void;
}

const HYSTERESIS = 0.1;
/** A window whose `used` falls by this much inside one window id has been reset (#683 U1). */
const RESET_DROP = 0.5;
/**
 * A provider's `resetsAt` for one window wobbles by seconds between readings (observed on the real log: 25 of 85 first-cut resets were jumps
 * of 1 to 9 s with `used` unchanged, five more of about 10 min) while a real reset moves it by hours (the smallest of the 53 real ones: 2.4 h).
 * A forward move of this much or less is the same window, not a reset (#683 U1).
 */
const RESET_JITTER_MS = 15 * 60_000;
/** Mark a pause whose handoff was a wait, and one whose wait was undone, in its reason (issue #36). */
const WAIT_NOTE = "; keeps its work:";
const WAITED_NOTE = "; waited, then the reset moved to";
const waitedNote = (min: number, max: number) => `${WAITED_NOTE} ${min} min, beyond wait_max_min ${max}`;
const FALLBACK_WINDOW_MINS = 300;

/**
 * Budget relay. Readings come from the adapters (Codex rate limits, Claude's status line, Kimi tokens) or from
 * `ahub budget set`. Over the gate: checkpoint first, pause second, hand the open work over, and resume when the window
 * resets. One open record per peer, kept in hub.db, so repeated readings do nothing and a restart keeps the pause.
 */
export class Budget {
  private readonly db: Database;
  private readonly readings = new Map<PeerId, Map<string, Reading>>();
  private readonly pausing = new Map<PeerId, object>();
  private readonly handingOff = new Set<PeerId>();
  /** The last reading of each window of an account, for the derived `quota_reset` (see `deriveResets`). */
  private readonly lastSeen = new Map<PeerId, Map<string, { used: number; resetsAt?: number; at: number }>>();
  /** `peer|window|resetsAt` of every reset already written this run, so a duplicate reading adds no reset. */
  private readonly resetsRecorded = new Set<string>();
  /** `ahub budget resume`: the owner overrode a pause; readings over the gate are ignored for that peer until then. */
  private readonly ignoreUntil = new Map<PeerId, number>();
  /** Chosen fallback bounds belong to a window, never to every window of the peer. */
  private readonly resetBounds = new Map<PeerId, Map<string, { at: number; explicit: boolean }>>();
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
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.db.run(`CREATE TABLE IF NOT EXISTS budget_pauses (peer TEXT PRIMARY KEY, since INTEGER NOT NULL, resets_at INTEGER NOT NULL,
      reason TEXT NOT NULL, summary TEXT, handed_off INTEGER NOT NULL DEFAULT 0, moved TEXT NOT NULL DEFAULT '[]')`);
    try { this.normalizeStoredPauses(); } catch (error) { this.db.close(); throw error; }
  }

  private account(peer: PeerId): PeerId {
    if (!this.hooks.account) return peer;
    const account = this.hooks.account(peer);
    if (typeof account !== "string" || !account.trim() || this.hooks.account(account) !== account) throw new Error("budget account resolver must return a canonical idempotent id");
    return account;
  }

  /** A newly declared alias must not erase an older custom peer's persisted pause. */
  private normalizeStoredPauses(): void {
    if (!this.hooks.account) return; // identity/default startup leaves existing storage byte-for-byte alone
    this.db.transaction(() => {
      const rows = (this.db.query("SELECT peer FROM budget_pauses ORDER BY peer").all() as { peer: string }[]).map(row => this.readRecord(row.peer)!);
      const groups = new Map<PeerId, PauseRecord[]>();
      for (const row of rows) {
        const account = this.account(row.peer), group = groups.get(account) ?? [];
        group.push(row); groups.set(account, group);
      }
      for (const [peer, group] of groups) {
        if (group.length === 1 && group[0]!.peer === peer) continue;
        // Conservative collision reduction: retain the longest pause, earliest start and every distinct move.
        // Any unfinished handoff stays unfinished so the daemon's account fanout retries remaining open work.
        const summaries = group.filter(row => row.summary !== null).map(row => `[${row.peer}]\n${row.summary}`);
        const moved = [...new Map(group.flatMap(row => row.moved).map(move => [JSON.stringify(move), move])).values()];
        const first = group[0]!;
        const record = group.length === 1 ? { ...first, peer } : {
          peer, since: Math.min(...group.map(row => row.since)), resetsAt: Math.max(...group.map(row => row.resetsAt)),
          reason: [...new Set(group.map(row => row.reason))].join(" | "), summary: summaries.length ? summaries.join("\n\n") : null,
          handedOff: group.every(row => row.handedOff), moved,
        };
        for (const row of group) this.db.query("DELETE FROM budget_pauses WHERE peer = ?").run(row.peer);
        this.db.query("INSERT INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(record.peer, record.since, record.resetsAt, record.reason, record.summary, record.handedOff ? 1 : 0, JSON.stringify(record.moved));
      }
    }).immediate();
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
    return this.readRecord(this.account(peer));
  }

  private readRecord(peer: PeerId): PauseRecord | undefined {
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
    // Execution-budget instrumentation is independent of native quota accounting.
    // Explicit quota exemption or absent budget metadata exempts registered kinds; external ids keep accounting.
    const reporter = peer;
    peer = this.account(peer);
    const resolve = this.hooks.definitionOf ?? definitionOf;
    const adapter = resolve(reporter) ?? resolve(peer);
    if (reporter === "user" || reporter === "hub" || peer === "user" || peer === "hub" || adapter && (!adapter.budget || adapter.budget.quotaExempt === true) || this.closed) return;
    // An override ignores soft readings, not a provider that has actually refused another turn.
    if (hard && this.ignoreUntil.delete(peer)) {
      try { this.hooks.notify(`budget: ${peer} provider refused again; budget override ended`); } catch { /* a notice cannot prevent the hard pause */ }
    }
    try { this.hooks.reading?.(reporter, windows, hard, at); } catch { /* telemetry never costs a reading */ }
    this.deriveResets(peer, windows, at);
    const mine = this.readings.get(peer) ?? new Map<string, Reading>();
    this.readings.set(peer, mine);
    for (const w of windows) mine.set(w.id, { ...w, used: Math.max(0, Math.min(1, w.used)), at });
    if (this.recoveryHeld) { this.deferred = true; if (hard) this.deferredHard.add(peer); return; }
    this.evaluate(peer, hard).catch((e: Error) => this.closed || this.hooks.notify(`budget: evaluating ${peer} failed: ${e.message}`));
  }

  /** A source that can no longer be trusted drops its reading of one window: the window shows unknown, never the last number. */
  forget(peer: PeerId, id: UsageWindow["id"]): void {
    this.readings.get(this.account(peer))?.delete(id);
  }

  /** Readings that still say something: not stale, and not about a window that has reset since they were taken. */
  private fresh(peer: PeerId): Reading[] {
    peer = this.account(peer);
    const staleMs = this.cfg.stale_min * 60_000;
    return [...(this.readings.get(peer)?.values() ?? [])].filter((r) => this.now() - r.at <= staleMs && !(r.resetsAt && r.resetsAt <= this.now()));
  }

  /**
   * `quota_reset` (#683 U1), derived from two readings of one window id of the account: the window's `resetsAt` moved forward (a new
   * window began, by more than RESET_JITTER_MS), or `used` fell by RESET_DROP or more inside one window id (the provider emptied it before its stated reset). The
   * baseline is the last reading seen, kept apart from `readings` (a resume clears those) so a reset that ended a pause is still seen.
   * One entry per peer, window and `resetsAt`: a repeated reading, a replay after a restart of the same value, or a second member of the
   * account adds none. A stale file reading (`at` older than the baseline) never counts: it describes an earlier window.
   */
  private deriveResets(peer: PeerId, windows: UsageWindow[], at: number): void {
    const last = this.lastSeen.get(peer) ?? new Map<string, { used: number; resetsAt?: number; at: number }>();
    this.lastSeen.set(peer, last);
    for (const w of windows) {
      const used = Math.max(0, Math.min(1, w.used)), before = last.get(w.id);
      if (before && at >= before.at) {
        const moved = w.resetsAt !== undefined && before.resetsAt !== undefined && w.resetsAt - before.resetsAt > RESET_JITTER_MS;
        const sameWindow = w.resetsAt === undefined || before.resetsAt === undefined || Math.abs(w.resetsAt - before.resetsAt) <= RESET_JITTER_MS;
        const dropped = !moved && before.used - used >= RESET_DROP && sameWindow;
        if (moved || dropped) {
          const key = `${peer}|${w.id}|${w.resetsAt ?? "none"}`;
          if (!this.resetsRecorded.has(key)) {
            this.resetsRecorded.add(key);
            this.writeLedger({ type: "quota_reset", peer, window: w.id, cause: moved ? "resets_at_moved" : "used_dropped", ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
              ...(before.resetsAt !== undefined ? { previousResetsAt: before.resetsAt } : {}), used, previousUsed: before.used, ...(Math.abs(this.now() - at) > 60_000 ? { measuredAt: new Date(at).toISOString() } : {}) });
          }
        }
      }
      if (!before || at >= before.at) last.set(w.id, { used, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}), at });
    }
  }

  /** The resets already in the ledger from earlier hub runs, so a replayed reading adds none (the daemon reads them from events.jsonl). */
  seedResets(known: Iterable<{ peer: PeerId; window: string; resetsAt?: number }>): void {
    for (const r of known) this.resetsRecorded.add(`${r.peer}|${r.window}|${r.resetsAt ?? "none"}`);
  }

  /** One ledger entry; a failing hook never costs the pause, the resume or the reading it describes. */
  private writeLedger(entry: BudgetLedgerEntry): void {
    try { this.hooks.ledger?.(entry); } catch { /* telemetry */ }
  }

  /** The owner's override: lift the pause now and leave the peer alone until the window that caused it has reset. */
  override(peer: PeerId): boolean {
    peer = this.account(peer);
    const open = this.record(peer);
    if (!open) return false;
    this.ignoreUntil.set(peer, open.resetsAt);
    const bounds = this.resetBounds.get(peer);
    this.resume(peer, "overridden by the console user", "person");
    // A new refusal may end the override before this same window has reset.
    if (bounds) this.resetBounds.set(peer, bounds);
    return true;
  }

  private async evaluate(peer: PeerId, hard: boolean): Promise<void> {
    peer = this.account(peer);
    if (this.recoveryHeld) { this.deferred = true; if (hard) this.deferredHard.add(peer); return; }
    const fresh = this.fresh(peer);
    const over = fresh.filter((r) => r.used >= this.cfg.gate);
    const open = this.record(peer);
    // An expired restored record may be waiting for attachment on an unpaused bus. A new hard refusal
    // starts a fresh pause immediately, retaining its list of moved tasks for the eventual resume notice.
    if (open && !(hard && this.now() >= open.resetsAt)) {
      if (hard && over.length) this.hooks.pause(peer); // confirm the persisted pause on the live bus, too
      // A later reading may finally carry the reset time the first one lacked.
      const bounds = this.resetBounds.get(peer) ?? new Map<string, { at: number; explicit: boolean }>();
      this.resetBounds.set(peer, bounds);
      for (const reading of over) if (reading.resetsAt !== undefined) bounds.set(reading.id, { at: reading.resetsAt, explicit: true });
      const known = Math.max(0, ...over.map((r) => r.resetsAt ?? 0));
      if (known && known !== open.resetsAt) {
        // A wait was decided against the old reset (#36). If the new one is past wait_max_min (a week window crossed
        // the gate meanwhile), the work has to move after all: unmarked, the next tick hands it over in full.
        const waited = open.handedOff && open.reason.includes(WAIT_NOTE);
        const waitMin = Math.ceil((known - this.now()) / 60_000);
        if (waited && waitMin > this.cfg.wait_max_min) {
          const reason = `${open.reason.slice(0, open.reason.indexOf(WAIT_NOTE))}${waitedNote(waitMin, this.cfg.wait_max_min)}`;
          this.db.query("UPDATE budget_pauses SET resets_at = ?, handed_off = 0, reason = ? WHERE peer = ?").run(known, reason, peer);
          this.hooks.notify(`budget: ${peer}'s reset moved to ${waitMin} min, beyond wait_max_min ${this.cfg.wait_max_min}: its work is handed over`);
        } else this.db.query("UPDATE budget_pauses SET resets_at = ? WHERE peer = ?").run(known, peer);
      }
      const newer = fresh.filter((r) => r.at > open.since);
      if (newer.length && fresh.every((r) => r.used < this.cfg.gate - HYSTERESIS)) this.resume(peer, "usage is back under the gate");
      return;
    }
    if (!over.length || (this.pausing.has(peer) && !hard) || this.now() < (this.ignoreUntil.get(peer) ?? 0)) return;
    // A hard refusal supersedes a soft evaluation still awaiting its checkpoint.
    const evaluation = {};
    this.pausing.set(peer, evaluation);
    try {
      const worst = over.reduce((a, b) => (b.used > a.used ? b : a));
      const bounds = this.resetBounds.get(peer) ?? new Map<string, { at: number; explicit: boolean }>();
      this.resetBounds.set(peer, bounds);
      const resetsAt = Math.max(...over.map((r) => {
        const fallback = this.now() + (r.windowMins ?? FALLBACK_WINDOW_MINS) * 60_000;
        const prior = bounds.get(r.id);
        // Preserve an earlier future fallback for this window after an override.
        // A provider's explicit reset, including a later one, remains authoritative.
        const retained = prior !== undefined && prior.at > this.now() ? prior : undefined;
        const reset = r.resetsAt ?? (retained ? retained.explicit ? retained.at : Math.min(retained.at, fallback) : fallback);
        bounds.set(r.id, { at: reset, explicit: r.resetsAt !== undefined || retained?.explicit === true });
        return reset;
      }));
      const reason = `${worst.id} window at ${Math.round(worst.used * 100)}% (${worst.source})`;
      // Checkpoint first, pause second: a paused peer receives nothing, and a turn in flight is never cut by the coordinator.
      const summary = hard ? undefined : await this.hooks.requestCheckpoint(peer).catch(() => undefined);
      if (this.pausing.get(peer) !== evaluation) return; // a later hard evaluation owns this pause
      if (this.recoveryHeld) { this.deferred = true; return; }
      if (this.closed) return; // the hub is shutting down: nothing is recorded, the next run sees the reading again
      this.db.query("INSERT OR REPLACE INTO budget_pauses (peer, since, resets_at, reason, summary, moved) VALUES (?, ?, ?, ?, ?, ?)").run(peer, this.now(), resetsAt, reason, summary ?? null, JSON.stringify(open?.moved ?? []));
      // A new pause that replaces an expired record (its window reset while nobody was attached to be resumed) ends that pause: without this
      // the ledger would hold two open pauses for one peer, and a pause-duration timeline would be wrong (#683 U1).
      if (open) this.writeLedger({ type: "budget_resume", peer, reason: "replaced by a new pause after its window reset", window: reasonWindow(open.reason), resetsAt: open.resetsAt, by: "hub" });
      this.writeLedger({ type: "budget_pause", peer, reason, window: worst.id, resetsAt, by: "hub" });
      this.hooks.pause(peer);
      this.hooks.notify(`budget: ${peer} paused, ${reason}; resumes ${new Date(resetsAt).toLocaleTimeString()}${summary ? "; checkpoint received" : hard ? "; hard limit, no checkpoint" : "; no checkpoint"}`);
      await this.finishHandoff(peer, summary);
    } finally {
      if (this.pausing.get(peer) === evaluation) this.pausing.delete(peer);
    }
  }

  private async finishHandoff(peer: PeerId, summary: string | undefined): Promise<void> {
    peer = this.account(peer);
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
    peer = this.account(peer);
    const context = summary ?? (await this.hooks.platformContext(peer).catch(() => undefined));
    // Wait or hand off (issue #36): a handoff costs the next peer the whole context, so a short wait can be cheaper.
    const resetsAt = this.record(peer)?.resetsAt;
    const waitMin = resetsAt === undefined ? Infinity : Math.max(0, Math.ceil((resetsAt - this.now()) / 60_000));
    const wait = this.cfg.wait_max_min > 0 && waitMin <= this.cfg.wait_max_min;
    let moved: Moved[];
    try {
      moved = await this.hooks.handoff(peer, context, wait);
    } catch (e) {
      // Left unmarked on purpose: the next tick, or the next hub run, tries again. The peer stays paused either way.
      return this.hooks.notify(`budget: handing over ${peer}'s work failed, will retry: ${(e as Error).message}`);
    }
    if (this.closed) return;
    const record = this.record(peer);
    // A wait that was undone hands over a second time: keep what moved the first time (urgent work) on the record too.
    const all = JSON.stringify([...(record?.moved ?? []), ...moved]);
    const nowMin = record ? Math.ceil((record.resetsAt - this.now()) / 60_000) : waitMin;
    if (wait && nowMin > this.cfg.wait_max_min) {
      // A reading moved the reset past the limit while the urgent work moved: no wait after all. Left unmarked, so the
      // next tick hands over the rest.
      this.db.query("UPDATE budget_pauses SET moved = ?, reason = reason || ? WHERE peer = ?").run(all, waitedNote(nowMin, this.cfg.wait_max_min), peer);
      this.hooks.notify(`budget: ${peer}'s reset moved to ${nowMin} min, beyond wait_max_min ${this.cfg.wait_max_min}: its work is handed over`);
    } else {
      let why = "";
      if (wait) why = `${WAIT_NOTE} resets in ${waitMin} min, within wait_max_min ${this.cfg.wait_max_min}`;
      else if (this.cfg.wait_max_min > 0 && waitMin !== Infinity && !record?.reason.includes(WAITED_NOTE)) why = `; handed over: resets in ${waitMin} min, beyond wait_max_min ${this.cfg.wait_max_min}`;
      this.db.query("UPDATE budget_pauses SET handed_off = 1, moved = ?, reason = reason || ? WHERE peer = ?").run(all, why, peer);
      if (wait) this.hooks.notify(`budget: ${peer} keeps its work and waits ${waitMin} min for its reset (wait_max_min ${this.cfg.wait_max_min})${moved.length ? "; urgent work moves" : ""}`);
    }
    if (moved.length) this.hooks.notify(`budget: moved from ${peer}: ${moved.map((m) => `#${m.id} ${m.role} -> ${m.to ?? "nobody"}`).join(", ")}`);
  }

  /** `hub_checkpoint` arrived from a peer. Resolved by the daemon's requestCheckpoint wait; kept on the record for a restart. */
  checkpointed(peer: PeerId, summary: string): void {
    peer = this.account(peer);
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

  private resume(peer: PeerId, why: string, by: "hub" | "person" = "hub"): void {
    peer = this.account(peer);
    const record = this.record(peer);
    if (!record) return;
    this.db.query("DELETE FROM budget_pauses WHERE peer = ?").run(peer);
    this.writeLedger({ type: "budget_resume", peer, reason: why, window: reasonWindow(record.reason), resetsAt: record.resetsAt, by });
    this.readings.get(peer)?.clear(); // the old numbers describe the window that just ended
    this.resetBounds.delete(peer);
    // The notice is queued while the peer is still paused, so it leads the first delivery: the peer learns what moved
    // before it touches anything that was waiting for it.
    this.hooks.resumed(record);
    this.hooks.resume(peer);
    this.hooks.notify(`budget: ${peer} resumed (${why})`);
  }

  /**
   * For routing (issue #36): per peer, the headroom of its most used fresh window and that window's reset. Headroom a
   * week window bounds is not lost when the 5 h window resets, so the reset is the binding window's, the latest on a tie.
   */
  headroom(): Record<PeerId, { headroom: number; resetsAt?: number }> {
    return Object.fromEntries([...this.readings.keys()].flatMap((peer) => {
      const fresh = this.fresh(peer);
      if (!fresh.length) return [];
      const used = Math.max(...fresh.map((r) => r.used));
      const binding = fresh.filter((r) => r.used === used);
      const resetsAt = binding.some((r) => r.resetsAt === undefined) ? undefined : Math.max(...binding.map((r) => r.resetsAt!));
      return [[peer, { headroom: 1 - used, ...(resetsAt !== undefined ? { resetsAt } : {}) }]];
    }));
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

export { codexWindows, claudeWindows } from "../adapters/definitions/native-quota.ts";
