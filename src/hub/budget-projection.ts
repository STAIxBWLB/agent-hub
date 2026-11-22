// #1513 AC1: when a quota window reaches its limit, at the burn rate seen over a lookback. Pure: the clock, the
// roll-up and the window all arrive as arguments, so a fixture needs no daemon and no database.

/**
 * One hour of burn inside the window. `at` is epoch ms of the bucket's **start**, so a bucket holds everything burned
 * from `at` until the next one and the last bucket is a partial hour; `tokens` is that bucket's whole burn. The rate is
 * therefore measured to `now`, never to the last `at`.
 */
export interface ProjectionPoint {
  at: number;
  tokens: number;
}

/**
 * `projected`: the window reaches its limit at `at`. `basis` says which span the rate was measured over — the whole
 * lookback, or the window itself when it opened inside the lookback (a reset) and only that much history exists.
 * `unknown`: no time is claimed, and `cause` says why. It is never rendered as a date.
 */
export type ExhaustionProjection =
  | { state: "projected"; at: number; basis: "lookback" | "window" }
  | { state: "unknown"; cause: "few_points" | "no_burn" | "reset_first" | "unknown_usage" };

export interface ProjectionInput {
  /** The window's used fraction, 0..1. */
  used: number | null;
  /** When the current window opened, epoch ms. */
  windowStart: number | null;
  /** When it resets, epoch ms; a window without one has no bound to project against. */
  resetsAt: number | null;
  now: number;
  /** How far back the rate is measured; the current window may be shorter than this. */
  lookbackMs: number;
  /** The reading behind this window is older than the hub's freshness bound, so none of these numbers describe it now. */
  stale?: boolean;
  points: readonly ProjectionPoint[];
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A steady burn projects a time; too few points, no burn at all, an unbounded or already stale window, and a
 * projection that lands after the window's own reset each answer `unknown` with the cause named, never a time.
 */
export function projectExhaustion(input: ProjectionInput): ExhaustionProjection {
  const { used, windowStart, resetsAt, now, lookbackMs, points, stale } = input;
  // A stale reading is no usable reading, exactly like a window whose reset has passed: the numbers it still carries
  // describe an earlier window, so no time is claimed from them.
  if (stale === true || !finite(used) || used < 0 || used > 1) return { state: "unknown", cause: "unknown_usage" };
  if (!finite(windowStart) || !finite(resetsAt) || windowStart >= now || resetsAt <= now) return { state: "unknown", cause: "unknown_usage" };
  if (!finite(lookbackMs) || lookbackMs <= 0) return { state: "unknown", cause: "few_points" };
  // A reset inside the lookback: the window opened after the lookback did, so the rate is measured from the window
  // start and never across the reset. The projection says which span it used.
  const lookbackFrom = now - lookbackMs;
  const from = Math.max(windowStart, lookbackFrom);
  const basis: "lookback" | "window" = from > lookbackFrom ? "window" : "lookback";
  const inside = points.filter(p => finite(p.at) && finite(p.tokens) && p.tokens >= 0 && p.at >= from && p.at <= now).sort((a, b) => a.at - b.at);
  const total = points.filter(p => finite(p.at) && finite(p.tokens) && p.tokens > 0 && p.at >= windowStart && p.at <= now).reduce((sum, p) => sum + p.tokens, 0);
  if (used >= 1) return { state: "projected", at: now, basis };
  if (inside.length < 2) return { state: "unknown", cause: "few_points" };
  // The points are buckets stamped at their start, so their burn covers the time from the first bucket's start to `now`,
  // the partial last hour included. Measuring between the two stamps would count n buckets over n-1 hours and overstate
  // the rate (two points, the minimum: doubled, and the forecast an hour early).
  const elapsed = now - inside[0]!.at;
  if (elapsed <= 0) return { state: "unknown", cause: "few_points" };
  const burned = inside.reduce((sum, p) => sum + p.tokens, 0);
  // No tokens at all in the window is no data, not a zero rate: a window nobody used cannot be projected either way.
  if (total <= 0 || burned <= 0) return { state: "unknown", cause: "no_burn" };
  // The window's own numbers give its capacity: what is burnt now is `used` of it.
  const capacity = total / used, remaining = (1 - used) * capacity;
  const at = now + remaining / (burned / elapsed);
  if (!Number.isFinite(at)) return { state: "unknown", cause: "few_points" };
  if (at > resetsAt) return { state: "unknown", cause: "reset_first" };
  return { state: "projected", at: Math.round(at), basis };
}

const CAUSE_TEXT: Record<Extract<ExhaustionProjection, { state: "unknown" }>["cause"], string> = {
  few_points: "too few points yet",
  no_burn: "no burn yet",
  reset_first: "it resets first",
  unknown_usage: "no usable reading",
};

/**
 * #1513 AC2: one sentence every surface renders, so the dashboard, the console and `ahub budget` say the same thing.
 * A projected window names the time; an unknown one names why, never a date.
 */
export function projectionText(projection: ExhaustionProjection, when: (at: number) => string): string {
  return projection.state === "projected"
    ? `reaches its limit ${when(projection.at)}${projection.basis === "window" ? " (rate since the window opened)" : ""}`
    : `no forecast: ${CAUSE_TEXT[projection.cause]}`;
}

/** The window's own length, for the lookback cap: a 5 h window is never measured over more than 5 h. */
export const WINDOW_MINS: Record<string, number> = { "5h": 300, week: 10_080, tokens: 300 };

/** The left fraction of a window, or null when the reading is not a usable number. Never a negative or a faked zero. */
export function windowLeft(used: number | null | undefined): number | null {
  return finite(used) && used >= 0 && used <= 1 ? 1 - used : null;
}
