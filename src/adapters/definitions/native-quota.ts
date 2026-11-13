import { quotaAccountUsage, type QuotaAccountUsage } from "../../hub/quota-account.ts";
import { types } from "node:util";
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

/** Closed native failure metadata. No vendor message, account data or credit information leaves the decoder. */
export interface NativeReviewerQuota {
  id: "5h" | "week";
  used: 1;
  windowMins: number;
  source: "Claude reviewer quota" | "Codex reviewer quota" | "Kimi reviewer quota";
  resetsAt?: number;
}
function nativeQuotaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return {};
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return {};
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
/** Revalidate even a backend's typed result before a host callback receives it. */
export function nativeReviewerQuota(value: unknown): NativeReviewerQuota | undefined {
  const row = nativeQuotaObject(value);
  if (row.used !== 1 || row.id !== "5h" && row.id !== "week" || !["Claude reviewer quota", "Codex reviewer quota", "Kimi reviewer quota"].includes(row.source as string)) return;
  const expected = row.id === "week" ? 10_080 : 300;
  if (row.windowMins !== expected) return;
  const resetsAt = typeof row.resetsAt === "number" && Number.isSafeInteger(row.resetsAt) && row.resetsAt > 0 && Number.isFinite(new Date(row.resetsAt).getTime()) ? row.resetsAt : undefined;
  return { id: row.id, used: 1, windowMins: expected, source: row.source as NativeReviewerQuota["source"], ...(resetsAt === undefined ? {} : { resetsAt }) };
}
/** Claude Agent SDK native rate_limit_event uses camelCase inside rate_limit_info, not the SDK's snake_case projection. */
export function claudeReviewerQuota(value: unknown): NativeReviewerQuota | undefined {
  const row = nativeQuotaObject(value), base = { id: "5h" as const, used: 1 as const, windowMins: 300, source: "Claude reviewer quota" as const };
  if (row.type === "assistant" && row.error === "rate_limit") return base;
  if (row.type !== "rate_limit_event") return;
  const info = nativeQuotaObject(row.rate_limit_info);
  if (info.status !== "rejected") return;
  const kind = info.rateLimitType;
  const known = kind === "five_hour" || kind === "seven_day" || kind === "seven_day_opus" || kind === "seven_day_sonnet";
  const id = kind === "five_hour" ? "5h" as const : "week" as const;
  const resetsAt = known ? epochMillis(info.resetsAt) : undefined;
  return known ? { ...base, id, windowMins: id === "week" ? 10_080 : 300, ...(resetsAt === undefined ? {} : { resetsAt }) } : base;
}
/** Codex 0.166.0 exec ThreadErrorEvent is message-only. Never read assistant/item/tool prose or app-server-shaped invented fields. */
export const CODEX_EXEC_QUOTA_PREFIX = "You’ve hit your usage limit.";
const CODEX_EXEC_QUOTA_MESSAGES = [
  "Your workspace is out of credits. Add credits to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
  "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
];
export function codexReviewerQuota(value: unknown): NativeReviewerQuota | undefined {
  const row = nativeQuotaObject(value);
  const message = row.type === "error" ? row.message : row.type === "turn.failed" ? nativeQuotaObject(row.error).message : undefined;
  if (typeof message !== "string" || !(message.startsWith(CODEX_EXEC_QUOTA_PREFIX) || message.startsWith("You’ve hit your usage limit for ") || CODEX_EXEC_QUOTA_MESSAGES.includes(message))) return;
  return { id: "5h", used: 1, windowMins: 300, source: "Codex reviewer quota" };
}

/**
 * ponytail: only the owned nonzero-exit stderr line observed on Kimi 2.2.0 is classified (2026-10-19 receipt).
 * 2.5.2 remains unverified for this diagnostic. Replace with a version-pinned typed native frame when one exists.
 */
export function kimiReviewerQuotaOnExit(value: { exitCode: number | null; stderr: { status: "complete"; text: string } | { status: "unknown" } }): NativeReviewerQuota | undefined {
  if (typeof value.exitCode !== "number" || value.exitCode === 0 || value.stderr.status !== "complete" || !value.stderr.text.endsWith("\n")) return;
  const hit = value.stderr.text.split(/\r?\n/).some(line => line.startsWith("error: failed to run prompt: provider.") && line.includes("usage limit"));
  if (!hit) return;
  // The receipt supplied no exact reset. Its displayed weekly wording supplies no guessed timestamp.
  return { id: "5h", used: 1, windowMins: 300, source: "Kimi reviewer quota" };
}
