import { MAX_REVIEW_MINUTES, type ReviewGate, type ReviewUnknownQuota } from "./review-budget.ts";
export interface ReviewerPoolConfig { pool: string[]; rerotate: boolean; sameFamily?: "never"; gate?: ReviewGate; unknownQuota?: ReviewUnknownQuota; maxMinutes?: number }

/** Kind order is project policy; capability and isolation evidence remain host-owned registry facts. */
export function reviewerPoolConfig(raw: unknown, defaults: readonly string[], known: readonly string[]): ReviewerPoolConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("review must be an object");
  const value = raw as Record<string, unknown>;
  const pool = value.pool === undefined ? defaults : value.pool;
  if (!Array.isArray(pool) || pool.length < 1 || pool.length > 16 || pool.some(kind => typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(kind) || !known.includes(kind)) || new Set(pool).size !== pool.length) throw new Error("review.pool must list 1..16 distinct known kinds");
  if (value.rerotate !== undefined && typeof value.rerotate !== "boolean") throw new Error("review.rerotate must be a boolean");
  if (value.same_family !== undefined && value.same_family !== "fallback" && value.same_family !== "never") throw new Error("review.same_family must be \"fallback\" or \"never\"");
  if (value.gate !== undefined && value.gate !== "off" && (typeof value.gate !== "number" || !Number.isFinite(value.gate) || value.gate < 0 || value.gate > 1)) throw new Error('review.gate must be "off" or a finite number in 0..1');
  if (value.unknown_quota !== undefined && value.unknown_quota !== "skip" && value.unknown_quota !== "pass") throw new Error('review.unknown_quota must be "skip" or "pass"');
  if (value.max_minutes !== undefined && (typeof value.max_minutes !== "number" || !Number.isFinite(value.max_minutes) || value.max_minutes <= 0 || value.max_minutes > MAX_REVIEW_MINUTES)) throw new Error("review.max_minutes must be positive and within the timer bound");
  return { pool: [...pool], rerotate: value.rerotate === true, ...(value.same_family === "never" ? { sameFamily: "never" as const } : {}), ...(value.gate === undefined ? {} : { gate: value.gate as ReviewGate }), ...(value.unknown_quota === undefined ? {} : { unknownQuota: value.unknown_quota as ReviewUnknownQuota }), ...(value.max_minutes === undefined ? {} : { maxMinutes: value.max_minutes as number }) };
}
