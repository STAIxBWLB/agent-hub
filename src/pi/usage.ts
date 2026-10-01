/** Pi 0.86 assistant usage, including cache reads/writes. Unknown shapes are not estimates. */
export function assistantTokens(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; usage?: unknown };
  if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") return undefined;
  const u = m.usage as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (count(u.totalTokens)) return u.totalTokens;
  if (!count(u.input) || !count(u.output)) return undefined;
  const parts = [u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0];
  if (!parts.every(count)) return undefined;
  const total = parts.reduce((n, v) => n + v, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}
