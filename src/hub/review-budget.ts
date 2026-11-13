import { createHash } from "node:crypto";
/** Reviewer policy consumes host-projected account observations, never native prose or credit flags. */
export const DEFAULT_REVIEW_GATE = 0.8;
export const DEFAULT_REVIEW_MAX_MINUTES = 20;
/** setTimeout's signed 32-bit millisecond ceiling. */
export const MAX_REVIEW_MINUTES = 2_147_483_647 / 60_000;
export interface ReviewBudgetSnapshot {
  gate: number;
  now: number;
  readings: Readonly<Record<string, { headroom: number; resetsAt?: number }>>;
  /** A present entry means an actual Budget pause. Only a proven native reset belongs in resetsAt. */
  paused: Readonly<Record<string, { resetsAt?: number }>>;
  manualPaused?: readonly string[];
}
export interface ReviewBudgetAdmission {
  state: "available" | "paused" | "floor" | "unknown" | "manual";
  reason?: string;
  resetsAt?: number;
}
const reset = (value: unknown, now: number): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > now && Number.isFinite(new Date(value).getTime()) ? value : undefined;
export function reviewBudgetAdmission(id: string, snapshot: ReviewBudgetSnapshot): ReviewBudgetAdmission {
  if (snapshot.manualPaused?.includes(id)) return { state: "manual", reason: "manual pause" };
  if (!Number.isFinite(snapshot.now) || !Number.isFinite(snapshot.gate) || snapshot.gate < 0 || snapshot.gate > 1) return { state: "unknown", reason: "review quota unknown" };
  const reading = snapshot.readings[id], pause = snapshot.paused[id];
  const resetsAt = pause ? reset(pause.resetsAt, 0) : reset(reading?.resetsAt, snapshot.now);
  const suffix = resetsAt === undefined ? "; reset unknown" : `; resets ${new Date(resetsAt).toISOString()}`;
  if (pause) return { state: "paused", reason: `quota paused${suffix}`, ...(resetsAt === undefined ? {} : { resetsAt }) };
  if (!reading || (!Number.isFinite(reading.headroom) || reading.headroom < 0 || reading.headroom > 1)) return { state: "unknown", reason: "review quota unknown" };
  const used = 1 - reading.headroom;
  if (used >= snapshot.gate) return { state: "floor", reason: `review.gate at ${Math.round(used * 100)}%${suffix}`, ...(resetsAt === undefined ? {} : { resetsAt }) };
  return { state: "available", ...(resetsAt === undefined ? {} : { resetsAt }) };
}


/** Fields that affect owned Kimi replay or its settlement, never model/path/session content. */
export function reviewerAccountingRelevant(row: { type: string; source?: unknown }): boolean {
  return row.type === "reviewer_accounting" || row.type === "budget_resume" || (row.type === "usage" || row.type === "tokens") && row.source === "kimi_wire";
}
/** Safe journal commitment: ordered host accounting and shared counter fields only. */
export function reviewerAccountingIntegrity(events: readonly unknown[], complete: boolean): { rows: number; completed: number; pending: number; unknown: number; complete: boolean; digest: string } {
  const records: unknown[] = [], latest = new Map<string, "started" | "complete" | "unknown">(); let invalid = 0, rows = 0;
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
  for (const value of events) {
    const row = value as Record<string, unknown> | null;
    if (!row || typeof row.type !== "string" || !reviewerAccountingRelevant(row as { type: string; source?: unknown })) continue;
    const peer = typeof row.peer === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(row.peer) ? row.peer : undefined;
    if (row.type === "reviewer_accounting") {
      rows++;
      if (!peer || typeof row.attempt !== "string" || !/^[a-f0-9]{32}$/.test(row.attempt) || !["started", "complete", "unknown"].includes(row.outcome as string)) { records.push(["invalid", invalid++]); continue; }
      records.push([row.type, peer, row.attempt, row.outcome]); latest.set(row.attempt, row.outcome as "started" | "complete" | "unknown");
    } else if (row.type === "budget_resume") {
      const at = time(row.at);
      if (!peer || at === undefined) { records.push(["invalid", invalid++]); continue; }
      records.push([row.type, peer, at]);
    } else {
      const at = time(row.at), measured = time(row.measuredAt) ?? at;
      const counters = row.type === "tokens" ? [row.n] : [row.inputTokens, row.cacheWriteTokens, row.outputTokens, row.cacheReadTokens, row.totalTokens];
      if (!peer || typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id) || at === undefined || measured === undefined || counters.some(value => !count(value))) { records.push(["invalid", invalid++]); continue; }
      records.push([row.type, peer, row.id, at, measured, ...counters]);
    }
  }
  const states = [...latest.values()], valid = complete && invalid === 0;
  return { rows, completed: states.filter(state => state === "complete").length,
    pending: states.filter(state => state === "started").length, unknown: states.filter(state => state === "unknown").length + invalid + (valid ? 0 : 1), complete: valid,
    digest: createHash("sha256").update(JSON.stringify([valid, records])).digest("hex") };
}
