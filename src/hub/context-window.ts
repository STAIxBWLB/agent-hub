/** Native active-context occupancy, separate from accumulated billable usage (#185). */
export interface ContextReading {
  source: "claude_statusline" | "codex_token_usage" | "acp_usage_update";
  sessionId: string;
  measuredAt: number;
  tokens: number | null;
  window: number | null;
  used: number | null;
}
export interface ContextView {
  source: string | null;
  measuredAt: number | null;
  tokens: number | null;
  window: number | null;
  used: number | null;
  freshness: "fresh" | "stale" | "unknown";
}
export interface ContextConfig { gate: number; stale_min: number }
export const DEFAULT_CONTEXT: ContextConfig = { gate: 0, stale_min: 30 };
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const positive = (n: unknown): n is number => nonnegative(n) && n > 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const object = (v: unknown): Record<string, unknown> => record(v) ? v : {};
export function claudeContext(value: unknown, sessionId: string, measuredAt: number): ContextReading {
  const c = object(value);
  const current = object(c.current_usage);
  const parts = [current.input_tokens, current.cache_creation_input_tokens, current.cache_read_input_tokens];
  const window = positive(c.context_window_size) ? c.context_window_size : null;
  const sum = c.current_usage != null && parts.every(nonnegative) ? parts.reduce<number>((sum, n) => sum + (n as number), 0) : null;
  const tokens = nonnegative(sum) ? sum : null;
  const used = record(c.current_usage) && tokens !== null && nonnegative(c.used_percentage) && c.used_percentage <= 100 && window !== null ? c.used_percentage / 100 : null;
  return { source: "claude_statusline", sessionId, measuredAt, tokens, window, used };
}
export function codexContext(value: unknown, sessionId: string, measuredAt: number): ContextReading {
  const c = object(value), last = object(c.last);
  const window = positive(c.modelContextWindow) ? c.modelContextWindow : null;
  const tokens = nonnegative(last.totalTokens) ? last.totalTokens : null;
  return { source: "codex_token_usage", sessionId, measuredAt, tokens, window, used: tokens !== null && window !== null ? Math.min(1, tokens / window) : null };
}
/** An ACP `usage_update` of the `{ used, size }` shape (Kimi 2.x): context occupancy, not consumption (#167, #285). */
export function acpContext(usage: { used: number; size: number }, sessionId: string, measuredAt: number): ContextReading {
  const window = positive(usage.size) ? usage.size : null;
  const tokens = nonnegative(usage.used) ? usage.used : null;
  // used > size is a real state (an over-full session before compaction): `used` clamps so a bar renders, `tokens`
  // stays truthful above the window.
  return { source: "acp_usage_update", sessionId, measuredAt, tokens, window, used: tokens !== null && window !== null ? Math.min(1, tokens / window) : null };
}
export const unknownContext = (): ContextView => ({ source: null, measuredAt: null, tokens: null, window: null, used: null, freshness: "unknown" });
/** Invalid/stale readings hide the value but never rearm a threshold already crossed. */
export class ContextWindows {
  private readings = new Map<string, ContextReading>();
  private high = new Map<string, { sessionId: string; crossed: boolean }>();
  constructor(private cfg: ContextConfig, private crossing: (peer: string, reading: ContextReading) => unknown, private now: () => number = Date.now) {
    if (!Number.isFinite(cfg.gate) || cfg.gate < 0 || cfg.gate > 1 || !Number.isFinite(cfg.stale_min) || cfg.stale_min <= 0) throw new Error("context: gate must be 0..1 and stale_min positive");
  }
  report(peer: string, reading: ContextReading, currentSession: string | undefined): void {
    if (!currentSession || reading.sessionId !== currentSession) return;
    const previous = this.readings.get(peer);
    if (previous?.sessionId === reading.sessionId && positive(previous.measuredAt) && previous.measuredAt <= this.now() && positive(reading.measuredAt) && reading.measuredAt <= this.now() && previous.measuredAt > reading.measuredAt) return;
    this.readings.set(peer, reading);
    if (!positive(reading.measuredAt) || reading.measuredAt > this.now() || reading.used === null || !nonnegative(reading.used) || reading.used > 1 || this.now() - reading.measuredAt > this.cfg.stale_min * 60_000 || !this.cfg.gate) return;
    const state = this.high.get(peer);
    const crossed = state?.sessionId === reading.sessionId && state.crossed;
    const over = reading.used >= this.cfg.gate;
    if (over && !crossed && this.crossing(peer, reading) === false) return;
    this.high.set(peer, { sessionId: reading.sessionId, crossed: over });
  }
  /** Reconsider a held crossing after release, using only the still-fresh reading and current native session. */
  retry(peer: string, currentSession: string | undefined): void {
    const reading = this.readings.get(peer);
    if (reading) this.report(peer, reading, currentSession);
  }
  view(peer: string, currentSession: string | undefined, attached: boolean): ContextView {
    const r = this.readings.get(peer);
    if (!r) return unknownContext();
    const stale = this.now() - r.measuredAt > this.cfg.stale_min * 60_000;
    const valid = positive(r.measuredAt) && r.measuredAt <= this.now() && attached && !!currentSession && r.sessionId === currentSession && !stale;
    return { source: r.source, measuredAt: positive(r.measuredAt) ? r.measuredAt : null, tokens: valid ? r.tokens : null, window: r.window, used: valid ? r.used : null, freshness: !valid ? stale ? "stale" : "unknown" : r.used === null ? "unknown" : "fresh" };
  }
}
