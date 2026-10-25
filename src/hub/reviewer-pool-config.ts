export interface ReviewerPoolConfig { pool: string[]; rerotate: boolean; sameFamily?: "never" }

/** Kind order is project policy; capability and isolation evidence remain host-owned registry facts. */
export function reviewerPoolConfig(raw: unknown, defaults: readonly string[], known: readonly string[]): ReviewerPoolConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("review must be an object");
  const value = raw as Record<string, unknown>;
  const pool = value.pool === undefined ? defaults : value.pool;
  if (!Array.isArray(pool) || pool.length < 1 || pool.length > 16 || pool.some(kind => typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(kind) || !known.includes(kind)) || new Set(pool).size !== pool.length) throw new Error("review.pool must list 1..16 distinct known kinds");
  if (value.rerotate !== undefined && typeof value.rerotate !== "boolean") throw new Error("review.rerotate must be a boolean");
  if (value.same_family !== undefined && value.same_family !== "fallback" && value.same_family !== "never") throw new Error("review.same_family must be \"fallback\" or \"never\"");
  return { pool: [...pool], rerotate: value.rerotate === true, ...(value.same_family === "never" ? { sameFamily: "never" as const } : {}) };
}
