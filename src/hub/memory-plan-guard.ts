import { extractNodes, nodePath, type View } from "@staix/agent-mem";
import type { BriefTask } from "../memory/brief.ts";

export interface PlanGuardContext { cwd: string; project: string; repo: string; deny?: string[] }

/** Explicit plan/ref names only, with no filesystem probes or free-text inference. */
export function planGuardNodes(task: BriefTask, context: PlanGuardContext): string[] {
  return extractNodes("", { ...context, paths: [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])], symbols: task.plan?.symbols, checkExists: false });
}
const samePath = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Fail.about is the source of the graph's rules_out edges in v1; there is no additional stored rules_out field. */
export function matchingPlanFails<T extends Pick<View, "kind" | "about" | "supersededBy">>(task: BriefTask, notes: readonly T[], context: PlanGuardContext): T[] {
  const nodes = planGuardNodes(task, context);
  if (!nodes.length) return [];
  return notes.filter(note => note.kind === "fail" && !note.supersededBy && note.about.some(about => nodes.some(node => {
    if (node === about) return true;
    if (node.startsWith("symbol:") && about.startsWith("symbol:")) return false; // Qualified symbols require both name and file identity.
    const path = nodePath(node), other = nodePath(about);
    // File/directory scope intersects at a whole path component, never a lexical substring.
    return !!path && !!other && samePath(path, other);
  })));
}
