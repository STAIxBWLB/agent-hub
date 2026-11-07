import { KimiWireReader, kimiCountedTokens, type KimiWireReason, type KimiWireRow } from "../adapters/kimi-wire-usage.ts";
import type { TaskAttribution } from "./attribution.ts";
import { TokenWindow } from "./token-window.ts";

/**
 * The hub's own count of Kimi's consumption (#285 phase 2): the wire-log rows of the session the adapter owns become `usage` and
 * `tokens` events and a rolling 5 h window against `budget.kimi_tokens_5h`. Read at a turn end, when a `usage_update` arrives and for
 * a bounded backoff after each cue. The ports keep the event log, the budget, the clock and delayed scheduling in the daemon.
 */
export const KIMI_WINDOW_MS = 5 * 3_600_000;
/** A turn's rows are written after it starts: a row older than the hub's first sight of the session (less this slack) is history. */
const FLOOR_SLACK_MS = 1000;
const PASSES = 16;
const FOLLOW_UP_DELAYS_MS = [250, 1000, 2000] as const;
const TURN_INTERVAL_LIMIT = 32;
/** Failures a retry can cure: the log was not there yet, or was cut mid-write. Anything else says the count no longer matches the log. */
const TRANSIENT: ReadonlySet<KimiWireReason> = new Set(["no-index", "io-error", "partial-line"]);

export type KimiUsageScheduler = (delayMs: number, run: () => void) => () => void;
export interface KimiTurnStart { id: string; startedAt: number; attribution: TaskAttribution }
export interface KimiRowAttribution { attribution: TaskAttribution; turn?: string }
interface KimiTurnInterval extends KimiTurnStart { endedAt?: number }

export interface KimiUsagePorts {
  /** Kimi's data home. */
  home: string;
  /** Per-call byte bound of the reader (its default otherwise); a test shrinks it to force several passes. */
  maxBytes?: number;
  now(): number;
  /** `budget.kimi_tokens_5h`, read live: 0 turns the window off, never the events. */
  ceiling(): number;
  /** The adapter's own session id, undefined when none is bound. */
  session(peer: string): string | undefined;
  /** One delayed drain at a time. Its cancellation leaves no live timer. Production uses an unreferenced timer. */
  schedule?: KimiUsageScheduler;
  /** One usage event and its counted tokens (`counted` is the one rule in `kimiCountedTokens`), with its captured turn attribution. */
  record(peer: string, row: KimiWireRow, counted: number, attributed: KimiRowAttribution): void;
  /** The window as a reading: `used` is not clamped here. */
  report(peer: string, window: { used: number; resetsAt: number; ceiling: number }): void;
  /** The count cannot be trusted now: the peer's `tokens` reading is dropped, so it shows unknown rather than a short number. */
  forget(peer: string): void;
  /** One line per peer and reason; carries no path, id or text from the log. */
  notice(line: string): void;
}

interface Bound {
  session: string;
  reader: KimiWireReader;
  floor: number;
  turns: KimiTurnInterval[];
  followUp: number;
  burst: boolean;
  pending?: () => void;
  unknown?: KimiWireReason;
  noticed?: KimiWireReason;
}

export class KimiUsage {
  private readonly bound = new Map<string, Bound>();
  private readonly window = new TokenWindow(KIMI_WINDOW_MS);
  private readonly seen = new Set<string>();
  /** A log that stopped matching the count leaves the window short of the truth until its rows age out. */
  private readonly taintedUntil = new Map<string, number>();
  private stopped = false;

  constructor(private readonly ports: KimiUsagePorts) {}

  /** Rows an earlier hub run already recorded: never counted twice, and still inside the window. */
  seed(rows: { id: string; at: number; counted: number }[]): void {
    for (const row of rows) {
      this.seen.add(row.id);
      if (row.counted > 0 && this.ports.now() - row.at <= KIMI_WINDOW_MS) this.window.add(row.at, row.counted);
    }
  }

  /**
   * What the count can say now, for `ahub doctor`, the notes under `ahub budget` and the dashboard. Carries a reason code at most (never a path, id or text from the log).
   * `off`: no ceiling, so no window. `unreadable`: a log read unknown or was tainted. `counting`: a clean log is bound. `waiting`: no Kimi session is bound yet.
   */
  status(): { state: "off" | "waiting" | "counting" } | { state: "unreadable"; reason: string } {
    if (!this.ports.ceiling()) return { state: "off" };
    for (const state of this.bound.values()) if (state.unknown) return { state: "unreadable", reason: state.unknown };
    const now = this.ports.now();
    for (const until of this.taintedUntil.values()) if (now < until) return { state: "unreadable", reason: "log changed since it was counted" };
    return { state: this.bound.size ? "counting" : "waiting" };
  }

  /** The peer went offline: its log is no longer read, so an unreadable state of it must not hold the other peers' figure unknown. */
  drop(peer: string): void {
    const held = this.bound.get(peer);
    if (held) this.cancel(held);
    this.bound.delete(peer);
  }

  /** Stop only delayed work. A final synchronous offline read can still use the bound readers. */
  stop(): void {
    this.stopped = true;
    for (const state of this.bound.values()) this.cancel(state);
  }

  /** A new window: the old counts would pause the peer again at once (after a budget resume). */
  reset(): void { this.window.reset(); this.taintedUntil.clear(); }

  /** Called when a turn starts. It binds the session, fixes the history floor and captures this turn's immutable attribution. */
  turnStarted(peer: string, turn?: KimiTurnStart): void {
    const bound = this.bind(peer);
    if (!bound || !turn || bound.turns.some(interval => interval.id === turn.id)) return;
    bound.turns.push({ ...turn, attribution: { ...turn.attribution } });
    if (bound.turns.length > TURN_INTERVAL_LIMIT) bound.turns.splice(0, bound.turns.length - TURN_INTERVAL_LIMIT);
  }

  turnEnded(peer: string, turn: string, endedAt: number): void {
    const bound = this.bound.get(peer);
    const index = bound?.turns.findIndex(interval => interval.id === turn) ?? -1;
    if (!bound || index < 0) return;
    bound.turns[index] = { ...bound.turns[index]!, endedAt };
  }

  private cancel(bound: Bound): void {
    bound.pending?.(); bound.pending = undefined; bound.burst = false; bound.followUp = 0;
  }

  private bind(peer: string): Bound | undefined {
    const session = this.ports.session(peer), held = this.bound.get(peer);
    if (!session) {
      if (held) this.cancel(held);
      this.bound.delete(peer);
      return undefined;
    }
    if (held?.session === session) return held;
    if (held) this.cancel(held);
    const next: Bound = {
      session,
      reader: new KimiWireReader({ home: this.ports.home, sessionId: session, ...(this.ports.maxBytes ? { maxBytes: this.ports.maxBytes } : {}) }),
      floor: this.ports.now() - FLOOR_SLACK_MS,
      turns: [], followUp: 0, burst: false,
    };
    this.bound.set(peer, next);
    return next;
  }

  collect(peer: string): void {
    const bound = this.bind(peer);
    if (!bound) return;
    try {
      let added = 0, more = false;
      for (let pass = 0; pass < PASSES; pass++) {
        const read = bound.reader.readSlice();
        // A successful pass records and commits every row before a later pass can fail. An event failure leaves the slice uncommitted,
        // so the next drain reads it again and the seen set removes only rows whose events already succeeded.
        if (read.status === "unknown") { this.unknown(peer, bound, read.reason); return; }
        added += this.record(peer, bound, read.rows);
        read.commit();
        more = read.more;
        if (!more) break;
      }
      const recovered = bound.unknown !== undefined;
      bound.unknown = undefined;
      // ponytail: PASSES x the reader's per-call bound. A longer unread backlog (a resumed session with a huge log) is finished by the next
      // call, and no figure is reported until it is: a window that is still catching up would be short. Upgrade: seek to the end at bind.
      if (!more && (added > 0 || recovered)) this.report(peer);
    } finally {
      if (this.bound.get(peer) === bound) this.schedule(peer, bound);
    }
  }

  private schedule(peer: string, bound: Bound): void {
    const schedule = this.ports.schedule;
    if (!schedule || this.stopped || bound.pending) return;
    if (!bound.burst) { bound.burst = true; bound.followUp = 0; }
    if (bound.followUp >= FOLLOW_UP_DELAYS_MS.length) { bound.burst = false; bound.followUp = 0; return; }
    const delay = FOLLOW_UP_DELAYS_MS[bound.followUp++]!;
    bound.pending = schedule(delay, () => {
      bound.pending = undefined;
      if (this.bound.get(peer) === bound) this.collect(peer);
    });
  }

  private record(peer: string, bound: Bound, rows: KimiWireRow[]): number {
    let added = 0;
    const now = this.ports.now();
    for (const row of rows) {
      if (this.seen.has(row.id) || row.at < bound.floor) continue;
      const counted = kimiCountedTokens(row), attributed = this.attribute(bound, row.at);
      this.ports.record(peer, row, counted, attributed);
      this.seen.add(row.id);
      this.window.add(Math.min(row.at, now), counted);
      added += counted;
    }
    return added;
  }

  private attribute(bound: Bound, at: number): KimiRowAttribution {
    const matches = bound.turns.filter(interval => at >= interval.startedAt && (interval.endedAt === undefined || at <= interval.endedAt));
    if (matches.length !== 1) return { attribution: { attribution: "unattributed" } };
    const turn = matches[0]!;
    return { attribution: { ...turn.attribution }, turn: turn.id };
  }

  private unknown(peer: string, bound: Bound, reason: KimiWireReason): void {
    bound.unknown = reason;
    try { this.ports.forget(peer); } catch { /* the reading ages out on its own */ }
    if (!TRANSIENT.has(reason)) this.taintedUntil.set(peer, this.ports.now() + KIMI_WINDOW_MS);
    if (bound.noticed === reason) return;
    bound.noticed = reason;
    try { this.ports.notice(`kimi usage unknown (${reason}): the hub counts no Kimi tokens it cannot read cleanly`); } catch { /* a notice never costs a turn */ }
  }

  /** The window as a reading, only while every Kimi peer's log reads cleanly: otherwise the figure is unknown, never a short count. */
  private report(peer: string): void {
    const ceiling = this.ports.ceiling(), now = this.ports.now();
    if (!ceiling) return;
    for (const state of this.bound.values()) if (state.unknown) return;
    for (const until of this.taintedUntil.values()) if (now < until) return;
    const oldest = this.window.oldest(now);
    this.ports.report(peer, { used: this.window.sum(now) / ceiling, resetsAt: (oldest ?? now) + KIMI_WINDOW_MS, ceiling });
  }
}

/**
 * The rows an earlier run recorded, from its `usage` events: their ids are never counted again, and the recent ones refill the window.
 * Only rows recorded after the last `resumedAt` (the newest `budget_resume` of a soft-token peer) refill it: a resume starts a new window
 * (`reset`), and that is not persisted anywhere else, so a restart would otherwise bring the pre-resume rows back and pause the peer again.
 */
export function kimiSeedRows(events: readonly { type: string; source?: unknown; id?: unknown; measuredAt?: unknown; at?: unknown; inputTokens?: unknown; cacheWriteTokens?: unknown; outputTokens?: unknown }[], resumedAt = 0): { id: string; at: number; counted: number }[] {
  const n = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return events.flatMap(e => {
    if (e.type !== "usage" || e.source !== "kimi_wire" || typeof e.id !== "string") return [];
    const measured = Date.parse(typeof e.measuredAt === "string" ? e.measuredAt : typeof e.at === "string" ? e.at : "");
    const recorded = Date.parse(typeof e.at === "string" ? e.at : "");
    if (!Number.isFinite(measured)) return [];
    // A row before the resume keeps its id (never recounted) and counts for nothing: `counted: 0` leaves the window alone.
    const counted = Number.isFinite(recorded) && recorded <= resumedAt ? 0 : kimiCountedTokens({ inputOther: n(e.inputTokens), inputCacheCreation: n(e.cacheWriteTokens), output: n(e.outputTokens) });
    return [{ id: e.id, at: measured, counted }];
  });
}
