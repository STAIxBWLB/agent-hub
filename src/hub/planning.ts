import type { Task } from "./board.ts";

export const PLANNING_FIELDS = ["rank", "priority", "release", "plannedStart", "due", "pinned", "deps", "reserved"] as const;
export interface PlanningFields {
  rank?: number | null;
  priority?: number | null;
  release?: number | null;
  plannedStart?: number | null;
  due?: number | null;
  pinned?: boolean;
  deps?: number[];
  reserved?: string | null;
}
export interface PlanningPatch extends PlanningFields {}
export const RELEASE_STATES = ["planning", "active", "frozen", "shipped", "dropped"] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];
export interface Release {
  id: number; name: string; goal: string; order: number; state: ReleaseState;
  plannedStart: number | null; cut: number | null; ship: number | null;
  activatedAt: number | null; frozenAt: number | null; shippedAt: number | null;
  created: number; updated: number; revision: number;
}

/** Validate the entire planning input before a write; actual dates are never caller input. */
export function planningPatch(input: unknown): PlanningPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("planning fields must be an object");
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).length || Object.keys(fields).some(key => !(PLANNING_FIELDS as readonly string[]).includes(key))) throw new Error("unknown or empty planning fields");
  const result: PlanningPatch = {};
  for (const key of PLANNING_FIELDS) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (key === "deps") {
      if (!Array.isArray(value) || value.length > 64 || value.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(value).size !== value.length) throw new Error("deps must be at most 64 unique positive task ids");
      result.deps = [...value];
    } else if (key === "reserved") {
      const peer = typeof value === "string" ? value.trim().toLowerCase() : null;
      if (value !== null && (!peer || !/^[a-z][a-z0-9-]{0,31}$/.test(peer) || ["user", "hub", "digest"].includes(peer))) throw new Error("reserved must be a valid agent peer id or null");
      result.reserved = peer;
    } else if (key === "pinned") {
      if (typeof value !== "boolean") throw new Error("pinned must be a boolean");
      result.pinned = value;
    } else {
      if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "release" || key === "plannedStart" || key === "due" ? 1 : 0) || (key === "priority" && value > 3) || (["plannedStart", "due"].includes(key) && value > 8_640_000_000_000_000))) throw new Error(`invalid planning field ${key}`);
      result[key] = value as number | null;
    }
  }
  return result;
}

/** Structured lifecycle events only, including reviewerless approval via done. */
export function actualTaskDates(task: Pick<Task, "history" | "state" | "reviewer">) {
  const first = (events: readonly string[]) => task.history.find(entry => events.includes(entry.event))?.at ?? null;
  const approved = first(["approved"]), reviewed = task.reviewer !== null || task.history.some(entry => entry.event === "approved" || entry.event === "changes_requested");
  const reviewerlessDone = task.state === "approved" && !task.reviewer ? [...task.history].reverse().find(entry => entry.event === "done")?.at ?? null : null;
  return { startedAt: first(["accepted"]), reviewAt: reviewed ? first(["done"]) : null, doneAt: approved ?? reviewerlessDone };
}
