import type { ContextReading } from "../../hub/context-window.ts";

export const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export const positive = (n: unknown): n is number => nonnegative(n) && n > 0;
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
  // If a report ever shows used > size, the fraction clamps so a bar renders; tokens keeps the reported number.
  return { source: "acp_usage_update", sessionId, measuredAt, tokens, window, used: tokens !== null && window !== null ? Math.min(1, tokens / window) : null };
}

/** The coordinator supplies validated occupancy; malformed public input remains unknown. */
export function acpContextValue(value: unknown, sessionId: string, measuredAt: number): ContextReading {
  const raw = object(value);
  return acpContext({ used: raw.used as number, size: raw.size as number }, sessionId, measuredAt);
}
