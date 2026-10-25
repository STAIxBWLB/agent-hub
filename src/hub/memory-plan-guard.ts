import { extractNodes, planGuardNodes } from "@staix/agent-mem";
import type { BriefTask } from "../memory/brief.ts";
export { planGuardNodes, matchingPlanFails, type PlanGuardContext } from "@staix/agent-mem";
import type { PlanGuardContext } from "@staix/agent-mem";

/** Retrieval nodes retain the title/task context as well as the explicit plan query. */
export function taskMemoryQueryNodes(task: BriefTask, context: PlanGuardContext): string[] {
  const ordinary = extractNodes(task.title, { ...context, paths: [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])], ...(task.id !== undefined && task.created !== undefined ? { task: { id: task.id, created: task.created } } : {}) });
  return [...new Set([...ordinary, ...planGuardNodes(task, context)])].sort();
}
