import type { Task } from "./board.ts";

export type SweepKind = "unaccepted-assignment" | "idle-owner" | "review-pending";
export interface SweepRecord {
  kind: SweepKind;
  /** Index of the last real activity, distinguishing even events at the same time. */
  activity: number;
  step: 1 | 2 | 3;
  at: number;
}
export interface TaskSweepConfig {
  enabled: boolean;
  interval_s: number;
  unaccepted_min: number;
  idle_min: number;
  review_min: number;
  ladder_min: number;
  auto_reassign: boolean;
}
export const DEFAULT_TASK_SWEEP: TaskSweepConfig = {
  enabled: false, interval_s: 300, unaccepted_min: 60, idle_min: 120, review_min: 120, ladder_min: 30, auto_reassign: false,
};

/** Config cannot silently enable a sweep or reassignment through a truthy string. */
export function taskSweepConfig(input: unknown): TaskSweepConfig {
  if (input === undefined) return { ...DEFAULT_TASK_SWEEP };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("task_sweep must be an object");
  const out = { ...DEFAULT_TASK_SWEEP };
  const values = input as Record<string, unknown>;
  for (const key of ["enabled", "auto_reassign"] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== "boolean") throw new Error(`task_sweep.${key} must be a boolean`);
    out[key] = values[key];
  }
  for (const key of ["interval_s", "unaccepted_min", "idle_min", "review_min", "ladder_min"] as const) {
    if (values[key] === undefined) continue;
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value * (key === "interval_s" ? 1000 : 60_000) > 2_147_483_647) throw new Error(`task_sweep.${key} must be a bounded number of at least 1`);
    out[key] = value;
  }
  return out;
}

/** Pure time/kind ladder; Tasks decides whether the responsible peer is available. */
export function nextSweep(task: Task, config: TaskSweepConfig, now: number): SweepRecord | undefined {
  if (!config.enabled || !Number.isFinite(now)) return undefined;
  const kind = task.state === "proposed" && task.owner ? "unaccepted-assignment"
    : task.state === "in_progress" && task.owner ? "idle-owner"
      : task.state === "in_review" && task.reviewer ? "review-pending" : undefined;
  if (!kind) return undefined;
  let activity = task.history.length - 1;
  while (activity >= 0 && task.history[activity]?.sweep) activity--;
  const at = task.history[activity]?.at ?? task.created;
  const threshold = kind === "unaccepted-assignment" ? config.unaccepted_min : kind === "idle-owner" ? config.idle_min : config.review_min;
  if (now - at < threshold * 60_000) return undefined;
  const previous = task.history.flatMap((h) => h.sweep?.kind === kind && h.sweep.activity === activity ? [h.sweep] : []).at(-1);
  if (previous && (previous.step === 3 || now - previous.at < config.ladder_min * 60_000)) return undefined;
  return { kind, activity, step: previous ? (previous.step + 1) as 2 | 3 : 1, at: now };
}
