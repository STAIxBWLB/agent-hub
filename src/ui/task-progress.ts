/** Public structural fields only. Titles, details and history never enter progress calculations. */
export interface PublicProgressTask {
  readonly id: number;
  readonly state: "proposed" | "in_progress" | "in_review" | "changes_requested" | "approved";
  readonly deps?: readonly number[];
}
export interface ProgressStage {
  id: number; stage: number; waiting: boolean; changes: boolean; label: string;
}
export interface TaskProgress {
  total: number;
  approvedFraction: number;
  counts: { proposed: number; waiting: number; in_progress: number; in_review: number; changes_requested: number; approved: number };
  stages: ProgressStage[];
}
/** Self-contained so the dashboard executes this exact function inside its hashed inline script. */
export function taskProgress(tasks: readonly PublicProgressTask[]): TaskProgress {
  const states = new Map(tasks.map(task => [task.id, task.state]));
  const counts = { proposed: 0, waiting: 0, in_progress: 0, in_review: 0, changes_requested: 0, approved: 0 };
  const stages = tasks.map(task => {
    const waiting = task.state === "proposed" && (task.deps ?? []).some(id => states.get(id) !== "approved");
    if (waiting) counts.waiting++; else counts[task.state]++;
    const changes = task.state === "changes_requested";
    const stage = task.state === "approved" ? 4 : task.state === "in_review" ? 3 : task.state === "in_progress" || changes ? 2 : 1;
    const label = waiting ? "waiting on dependencies" : changes ? "changes requested (back in progress)" : task.state.replaceAll("_", " ");
    return { id: task.id, stage, waiting, changes, label };
  });
  return { total: tasks.length, approvedFraction: tasks.length ? counts.approved / tasks.length : 0, counts, stages };
}
