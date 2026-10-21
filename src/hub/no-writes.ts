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
