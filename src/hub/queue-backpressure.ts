/** Opt-in admission data only. This module never reads a queue, clock or delivery body. */
export interface QueueBackpressurePolicy { max_queued: number; max_oldest_s: number }
export interface QueuePressure {
  queued: number;
  /** null proves an empty queue; absent means the oldest pending timestamp is unknown. */
  oldestQueuedAt?: number | null;
}
export type QueueBackpressureCode = "queue-count" | "queue-age" | "queue-age-unknown";
export interface QueueBackpressureRefusal { peer: string; code: QueueBackpressureCode; reason: string }
export interface QueuePressurePeerStatus {
  queued: number | null;
  oldestQueuedAt: number | null;
  oldestAgeMs: number | null;
  blocked: boolean;
  code?: QueueBackpressureCode;
  reason?: string;
}
export interface QueueBackpressureStatus {
  policy: QueueBackpressurePolicy;
  peers: Record<string, QueuePressurePeerStatus>;
  truncated?: true;
}
export const QUEUE_BACKPRESSURE_LIMITS = Object.freeze({ max_queued: 10_000, max_oldest_s: 604_800 });
const DEFAULT_POLICY: Readonly<QueueBackpressurePolicy> = Object.freeze({ max_queued: 0, max_oldest_s: 0 });
const validLimit = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Config owns validation; omission and each zero preserve the existing disabled behaviour. */
export function queueBackpressurePolicy(raw: unknown): QueueBackpressurePolicy {
  if (raw === undefined) return { ...DEFAULT_POLICY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("tasks.queue_backpressure must be a bounded policy object");
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some(key => !Object.hasOwn(DEFAULT_POLICY, key))) throw new Error("tasks.queue_backpressure contains an unknown field");
  const result = { ...DEFAULT_POLICY };
  for (const key of ["max_queued", "max_oldest_s"] as const) {
    if (!Object.hasOwn(row, key)) continue;
    const value = row[key];
    if (!validLimit(value, QUEUE_BACKPRESSURE_LIMITS[key])) throw new Error(`tasks.queue_backpressure.${key} must be an integer from 0 to ${QUEUE_BACKPRESSURE_LIMITS[key]}`);
    result[key] = value;
  }
  return result;
}

/** A pure admission verdict: thresholds are exceeded strictly; unknown never becomes age zero. */
export function queueBackpressure(peer: string, policy: QueueBackpressurePolicy | undefined, queue: QueuePressure | undefined, now: number): QueueBackpressureRefusal | undefined {
  if (policy === undefined) return undefined;
  const refuse = (code: QueueBackpressureCode, reason: string): QueueBackpressureRefusal => ({ peer, code, reason: `queue backpressure: ${reason}` });
  if (!validLimit(policy.max_queued, QUEUE_BACKPRESSURE_LIMITS.max_queued) || !validLimit(policy.max_oldest_s, QUEUE_BACKPRESSURE_LIMITS.max_oldest_s)) return refuse("queue-count", "policy unavailable");
  if (policy.max_queued === 0 && policy.max_oldest_s === 0) return undefined;
  if (!queue || !Number.isSafeInteger(queue.queued) || queue.queued < 0) return refuse("queue-count", "queued count unknown");
  if (policy.max_queued > 0 && queue.queued > policy.max_queued) return refuse("queue-count", `queued ${queue.queued} exceeds max ${policy.max_queued}`);
  if (policy.max_oldest_s === 0) return undefined;
  if (queue.queued === 0 && queue.oldestQueuedAt === null) return undefined;
  const oldest = queue.oldestQueuedAt;
  if (queue.queued === 0 || typeof oldest !== "number" || !Number.isSafeInteger(oldest) || oldest < 0 || !Number.isSafeInteger(now) || now < oldest) return refuse("queue-age-unknown", "oldest queued age unknown");
  const age = now - oldest, maxAge = policy.max_oldest_s * 1000;
  if (age > maxAge) return refuse("queue-age", `oldest queued age ${age}ms exceeds max ${maxAge}ms`);
  return undefined;
}
