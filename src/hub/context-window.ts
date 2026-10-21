import { nonnegative, positive } from "../adapters/definitions/native-context.ts";
import type { AdapterDefinition } from "../adapters/registry-types.ts";
export { claudeContext, codexContext, acpContext } from "../adapters/definitions/native-context.ts";

/** The host retains session/time/privacy fences; the declared reader owns normalization. */
export function readNativeContext(definition: AdapterDefinition | undefined, value: unknown, sessionId: string, measuredAt: number): ContextReading | undefined {
  return definition?.budget?.context?.read(value, sessionId, measuredAt);
}

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
