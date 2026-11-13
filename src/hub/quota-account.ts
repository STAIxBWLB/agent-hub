/** Read-only account diagnostics. These fields never participate in quota admission or resume. */
export interface QuotaAccountUsage {
  resetCreditsAvailable?: number;
  resetCreditsExpireAt?: number;
  resetCreditsExpiryKnown?: boolean;
  ordinaryUsageAllowed?: boolean;
  hasCredits?: boolean;
  unlimited?: boolean;
}
export interface QuotaAccountReading extends QuotaAccountUsage { at: number; stale: boolean }

/** Copy only counts, times and flags, even when an internal caller supplies extra native fields. */
export function quotaAccountUsage(value: unknown): QuotaAccountUsage {
  const out: QuotaAccountUsage = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const row = value as Record<string, unknown>;
  if (typeof row.resetCreditsAvailable === "number" && Number.isSafeInteger(row.resetCreditsAvailable) && row.resetCreditsAvailable >= 0) {
    out.resetCreditsAvailable = row.resetCreditsAvailable;
    if (typeof row.resetCreditsExpiryKnown === "boolean") out.resetCreditsExpiryKnown = row.resetCreditsExpiryKnown;
    if (out.resetCreditsExpiryKnown === true && typeof row.resetCreditsExpireAt === "number" && Number.isSafeInteger(row.resetCreditsExpireAt)
      && row.resetCreditsExpireAt > 0 && Number.isFinite(new Date(row.resetCreditsExpireAt).getTime())) out.resetCreditsExpireAt = row.resetCreditsExpireAt;
  }
  for (const field of ["ordinaryUsageAllowed", "hasCredits", "unlimited"] as const) if (typeof row[field] === "boolean") out[field] = row[field];
  return out;
}


/** Public read projection also validates the host timestamp/freshness marker before copying the allowlist. */
export function quotaAccountReading(value: unknown): QuotaAccountReading | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.at !== "number" || !Number.isFinite(row.at) || typeof row.stale !== "boolean") return undefined;
  return { ...quotaAccountUsage(row), at: row.at, stale: row.stale };
}
