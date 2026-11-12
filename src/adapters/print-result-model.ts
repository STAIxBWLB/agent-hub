import { safeModelLabel } from "../omniroute/usage.ts";

/**
 * #1402 T2: the model a Claude print run served, from the `modelUsage` of its `result` row (keys are the model ids, values the per-model usage). One safe key is that model. Several (a main
 * model plus a helper such as a summarizer) name the one that handled strictly more tokens than every other; a tie or a breakdown with no token counts names none, because guessing which model
 * ran the turn would put a wrong id on the record. Only the usage counters weigh (input, output, cache read and creation); `maxOutputTokens` and `contextWindow` describe the model, not the turn. A key `safeModelLabel` refuses never counts, and nothing but the id is kept. Absent field: no observation.
 */
export function resultModel(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const usage = (row as { modelUsage?: unknown }).modelUsage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const seen: { model: string; weight: number }[] = [];
  for (const key of Object.keys(usage)) {
    const model = safeModelLabel(key);
    if (model === undefined || model.toLowerCase() === "unknown") continue;
    const value = (usage as Record<string, unknown>)[key];
    let weight = 0;
    if (value && typeof value === "object") for (const [name, count] of Object.entries(value)) if (/^(input|output|cacheRead|cacheCreation)[A-Za-z]*tokens$/i.test(name) && typeof count === "number" && Number.isFinite(count) && count > 0) weight += count;
    seen.push({ model, weight });
  }
  if (seen.length === 1) return seen[0]!.model;
  const ranked = seen.sort((a, b) => b.weight - a.weight);
  return ranked.length > 1 && ranked[0]!.weight > ranked[1]!.weight ? ranked[0]!.model : undefined;
}
