/** Provider usage is optional. Missing counters stay missing; they are never guessed as zero. */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Accept known OpenAI-compatible and Anthropic-compatible counter spellings, dropping malformed fields. */
export function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = count(raw.input_tokens) ?? count(raw.prompt_tokens) ?? count(raw.inputTokens);
  const outputTokens = count(raw.output_tokens) ?? count(raw.completion_tokens) ?? count(raw.outputTokens);
  const cacheReadTokens = count(raw.cache_read_input_tokens) ?? count(raw.cached_read_tokens) ?? count(raw.cacheReadTokens)
    ?? count((raw.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  const cacheWriteTokens = count(raw.cache_creation_input_tokens) ?? count(raw.cache_write_tokens) ?? count(raw.cacheWriteTokens);
  const totalTokens = count(raw.total_tokens) ?? count(raw.totalTokens);
  const result = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** Model/provider labels are metadata, but still untrusted: keep a short printable identifier only. */
export function safeModelLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(label) ? label : undefined;
}
