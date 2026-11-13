import { quotaAccountUsage, type QuotaAccountUsage } from "../../hub/quota-account.ts";
import type { UsageWindow } from "../../hub/budget.ts";

/** Codex `rateLimits` snapshot (account/rateLimits/read, account/rateLimits/updated) -> windows. */
export function codexWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  // The slot decides (primary = short window, secondary = long one) and the duration overrides it when present:
  // readings are keyed by window id, so two windows must never both come out as "5h".
  for (const [w, slot] of [[rateLimits?.primary, "5h"], [rateLimits?.secondary, "week"]] as const) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined;
    const id = mins === undefined ? slot : mins > 600 ? "week" : "5h";
    if (out.some((o) => o.id === id)) continue; // both slots claim the same window: keep the first, never overwrite
    out.push({ id, used: w.usedPercent / 100, ...(w.resetsAt ? { resetsAt: w.resetsAt * 1000 } : {}), ...(mins ? { windowMins: mins } : {}), source: "codex rateLimits" });
  }
  if (rateLimits?.rateLimitReachedType && !out.some((w) => w.used >= 1)) out.push({ id: "5h", used: 1, source: `codex ${rateLimits.rateLimitReachedType}` });
  return out;
}

/** Claude Code status line `rate_limits` -> windows. */
export function claudeWindows(rateLimits: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, id, mins] of [["five_hour", "5h", 300], ["seven_day", "week", 10_080]] as const) {
    const w = rateLimits?.[key];
    if (!w || typeof w.used_percentage !== "number") continue;
    const resets = Number(w.resets_at);
    out.push({ id, used: w.used_percentage / 100, ...(resets ? { resetsAt: resets < 1e12 ? resets * 1000 : resets } : {}), windowMins: mins, source: "claude status line" });
  }
  return out;
}


/** Bounds inspection of native detail rows; the native availableCount remains authoritative. */
const MAX_RESET_CREDIT_DETAILS = 128;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const epochMillis = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  const ms = value * 1000;
  return Number.isSafeInteger(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
};

/** Codex 0.167.2 GetAccountRateLimitsResponse: no balance, account/credit id, title or description escapes. */
export function codexAccountUsage(snapshot: unknown): QuotaAccountUsage {
  const value = record(snapshot), limits = record(value.rateLimits), credits = record(limits.credits), reset = record(value.rateLimitResetCredits);
  const out: QuotaAccountUsage = {};
  if (typeof value.ordinaryUsageAllowed === "boolean") out.ordinaryUsageAllowed = value.ordinaryUsageAllowed;
  if (typeof credits.hasCredits === "boolean") out.hasCredits = credits.hasCredits;
  if (typeof credits.unlimited === "boolean") out.unlimited = credits.unlimited;
  const count = reset.availableCount;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
    out.resetCreditsAvailable = count;
    out.resetCreditsExpiryKnown = count === 0;
    const rows = reset.credits;
    // Native lists may be capped: a partial list cannot prove the earliest expiry across the full count.
    if (count > 0 && Array.isArray(rows) && rows.length === count && rows.length <= MAX_RESET_CREDIT_DETAILS) {
      let complete = true, earliest: number | undefined;
      for (const item of rows) {
        const row = record(item);
        if (row.status !== "available" || row.resetType !== "codexRateLimits") { complete = false; break; }
        if (row.expiresAt === null) continue; // explicitly non-expiring; absence instead means unknown
        const expires = epochMillis(row.expiresAt);
        if (expires === undefined) { complete = false; break; }
        earliest = earliest === undefined ? expires : Math.min(earliest, expires);
      }
      out.resetCreditsExpiryKnown = complete;
      if (complete && earliest !== undefined) out.resetCreditsExpireAt = earliest;
    }
  }
  return quotaAccountUsage(out);
}

/** Preserve the existing window callback shape without forwarding raw account/credit data. */
export function codexQuotaWindowInput(value: unknown): unknown {
  const raw = record(value);
  const window = (value: unknown) => {
    const row = record(value);
    if (typeof row.usedPercent !== "number" || !Number.isFinite(row.usedPercent)) return null;
    return { usedPercent: row.usedPercent,
      ...(typeof row.windowDurationMins === "number" && Number.isFinite(row.windowDurationMins) ? { windowDurationMins: row.windowDurationMins } : {}),
      ...(typeof row.resetsAt === "number" && Number.isFinite(row.resetsAt) ? { resetsAt: row.resetsAt } : {}) };
  };
  const reached = raw.rateLimitReachedType;
  const known = ["usageLimitExceeded", "rate_limit_reached", "workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"];
  return { primary: window(raw.primary), secondary: window(raw.secondary),
    ...(reached ? { rateLimitReachedType: typeof reached === "string" && known.includes(reached) ? reached : "usageLimitExceeded" } : {}) };
}
