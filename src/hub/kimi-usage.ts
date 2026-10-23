import { KimiWireReader, kimiCountedTokens, type KimiWireReason, type KimiWireRow } from "../adapters/kimi-wire-usage.ts";
import { TokenWindow } from "./token-window.ts";

/**
 * The hub's own count of Kimi's consumption (#285 phase 2): the wire-log rows of the session the adapter owns become `usage` and
 * `tokens` events and a rolling 5 h window against `budget.kimi_tokens_5h`. Read at a turn end and when a `usage_update` arrives:
 * no watcher, no timer. The ports keep the event log, the budget and the clock in the daemon.
 */
export const KIMI_WINDOW_MS = 5 * 3_600_000;
/** A turn's rows are written after it starts: a row older than the hub's first sight of the session (less this slack) is history. */
const FLOOR_SLACK_MS = 1000;
const PASSES = 16;
/** Failures a retry can cure: the log was not there yet, or was cut mid-write. Anything else says the count no longer matches the log. */
const TRANSIENT: ReadonlySet<KimiWireReason> = new Set(["no-index", "io-error", "partial-line"]);

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
  /** One usage event and its counted tokens (`counted` is the one rule in `kimiCountedTokens`). */
  record(peer: string, row: KimiWireRow, counted: number): void;
  /** The window as a reading: `used` is not clamped here. */
  report(peer: string, window: { used: number; resetsAt: number; ceiling: number }): void;
  /** The count cannot be trusted now: the peer's `tokens` reading is dropped, so it shows unknown rather than a short number. */
  forget(peer: string): void;
  /** One line per peer and reason; carries no path, id or text from the log. */
  notice(line: string): void;
}

interface Bound { session: string; reader: KimiWireReader; floor: number; unknown?: KimiWireReason; noticed?: KimiWireReason }

export class KimiUsage {
  private readonly bound = new Map<string, Bound>();
  private readonly window = new TokenWindow(KIMI_WINDOW_MS);
  private readonly seen = new Set<string>();
  /** A log that stopped matching the count leaves the window short of the truth until its rows age out. */
  private readonly taintedUntil = new Map<string, number>();

  constructor(private readonly ports: KimiUsagePorts) {}

  /** Rows an earlier hub run already recorded: never counted twice, and still inside the window. */
  seed(rows: { id: string; at: number; counted: number }[]): void {
    for (const row of rows) {
      this.seen.add(row.id);
      if (row.counted > 0 && this.ports.now() - row.at <= KIMI_WINDOW_MS) this.window.add(row.at, row.counted);
    }
  }

  /** The peer went offline: its log is no longer read, so an unreadable state of it must not hold the other peers' figure unknown. */
  drop(peer: string): void { this.bound.delete(peer); }

  /** A new window: the old counts would pause the peer again at once (after a budget resume). */
  reset(): void { this.window.reset(); this.taintedUntil.clear(); }

  /** Called when a turn starts. It only binds the session and fixes the history floor: nothing is read here, and what the log already holds is not this hub's to count. */
  turnStarted(peer: string): void { this.bind(peer); }

  private bind(peer: string): Bound | undefined {
    const session = this.ports.session(peer);
    if (!session) return undefined;
    const held = this.bound.get(peer);
    if (held?.session === session) return held;
    const next: Bound = { session, reader: new KimiWireReader({ home: this.ports.home, sessionId: session, ...(this.ports.maxBytes ? { maxBytes: this.ports.maxBytes } : {}) }), floor: this.ports.now() - FLOOR_SLACK_MS };
    this.bound.set(peer, next);
    return next;
  }

  collect(peer: string): void {
    const bound = this.bind(peer);
    if (!bound) return;
    let added = 0, more = false;
    for (let pass = 0; pass < PASSES; pass++) {
      const read = bound.reader.read();
      // Each successful pass has already moved the reader's offsets: its rows are recorded now, before a later pass can fail, or they would
      // never be read again and the count would be short.
      if (read.status === "unknown") { this.unknown(peer, bound, read.reason); return; }
      added += this.record(peer, bound, read.rows);
      more = read.more;
      if (!more) break;
    }
    const recovered = bound.unknown !== undefined;
    bound.unknown = undefined;
    // ponytail: PASSES x the reader's per-call bound. A longer unread backlog (a resumed session with a huge log) is finished by the next
    // call, and no figure is reported until it is: a window that is still catching up would be short. Upgrade: seek to the end at bind.
    if (!more && (added > 0 || recovered)) this.report(peer);
  }

  private record(peer: string, bound: Bound, rows: KimiWireRow[]): number {
    let added = 0;
    const now = this.ports.now();
    for (const row of rows) {
      if (this.seen.has(row.id) || row.at < bound.floor) continue;
      this.seen.add(row.id);
      const counted = kimiCountedTokens(row);
      this.ports.record(peer, row, counted);
      this.window.add(Math.min(row.at, now), counted);
      added += counted;
    }
    return added;
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
