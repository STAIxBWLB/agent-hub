import { extractNodes, planGuardNodes as libraryPlanGuardNodes, matchingPlanFails as libraryMatchingPlanFails, type PlanGuardContext, type View } from "@staix/agent-mem";
import type { BriefTask } from "../memory/brief.ts";
export type { PlanGuardContext } from "@staix/agent-mem";

/** Preserve the hub task-shaped API while the library owns all matching logic. */
export function planGuardNodes(task: BriefTask, context: PlanGuardContext): string[] {
  return libraryPlanGuardNodes(task, context);
}
export function matchingPlanFails<T extends Pick<View, "kind" | "about" | "supersededBy">>(task: BriefTask, notes: readonly T[], context: PlanGuardContext): T[] {
  return libraryMatchingPlanFails(task, notes, context);
}

/** Retrieval nodes retain the title/task context as well as the explicit plan query. */
export function taskMemoryQueryNodes(task: BriefTask, context: PlanGuardContext): string[] {
  const ordinary = extractNodes(task.title, { ...context, paths: [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])], ...(task.id !== undefined && task.created !== undefined ? { task: { id: task.id, created: task.created } } : {}) });
  return [...new Set([...ordinary, ...planGuardNodes(task, context)])].sort();
}
