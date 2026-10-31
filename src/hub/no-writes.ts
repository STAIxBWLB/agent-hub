import type { Task } from "./board.ts";

export interface NoWriteObservation {
  task: number;
  /** Opaque binding to the current owner and its latest acceptance. */
  generation: string;
  limit: number;
  changed: boolean | undefined;
  effect: boolean;
}

/** Pure per-task streaks; callers own evidence, privacy and warning delivery. */
export class NoWriteTurns {
  private readonly streaks = new Map<number, { generation: string; count: number; emitted: boolean }>();

  observe({ task, generation, limit, changed, effect }: NoWriteObservation): number | undefined {
    if (!Number.isSafeInteger(limit) || limit <= 0 || changed !== false || effect !== false) {
      this.reset(task);
      return undefined;
    }
    const previous = this.streaks.get(task);
    const streak = previous?.generation === generation ? previous : { generation, count: 0, emitted: false };
    if (streak !== previous) this.streaks.set(task, streak);
    if (streak.emitted) return undefined;
    if (streak.count < Number.MAX_SAFE_INTEGER) streak.count++;
    if (streak.count < limit) return undefined;
    streak.emitted = true;
    return streak.count;
  }

  reset(task: number): void { this.streaks.delete(task); }

  retain(activeTaskIds: readonly number[]): void {
    const active = new Set(activeTaskIds);
    for (const task of this.streaks.keys()) if (!active.has(task)) this.reset(task);
  }
}


const OWNER_TOOL_EFFECTS = new Set(["hub_task_propose", "hub_task_decline", "hub_task_done", "hub_task_cancel", "hub_task_assign", "hub_task_escalate", "hub_review", "hub_checkpoint", "hub_remember", "hub_memory_correct", "hub_check_start", "hub_check_cancel", "hub_sdlc_record", "hub_plan_review", "hub_backlog_plan", "hub_backlog_pull", "hub_backlog_undo", "hub_backlog_split", "hub_backlog_return_untouched", "hub_release_new", "hub_release_configure", "hub_release_assign", "hub_release_cut", "hub_study_handoff"]);
/** A read does not prove progress; failed/pending mutations are handled conservatively by the host. */
export function ownerToolEffect(op: string, input: Record<string, unknown> | undefined): boolean {
  return OWNER_TOOL_EFFECTS.has(op) || op === "hub_task_accept" && !!input?.plan && typeof input.plan === "object" && Object.keys(input.plan).length > 0;
}

/** Canonical snapshots cannot disprove work in the owner's separately recorded checkout/PR. */
export function canonicalWriteUnknown(task: Pick<Task, "refs" | "plan" | "sdlc">): boolean {
  return !!(task.refs.branch || task.refs.commit || task.sdlc?.head || task.sdlc?.localHead || task.sdlc?.pr)
    || [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])].some(path => /(?:^|[\\/])\.worktrees(?:[\\/]|$)/i.test(path));
}
