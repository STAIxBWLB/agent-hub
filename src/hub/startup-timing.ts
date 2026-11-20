/** Closed labels only: startup diagnostics must never carry paths, task text or errors. */
export const STARTUP_PHASES = [
  "schema", "source", "configuration", "control", "recovery", "journal", "bus", "memory", "model_runtime", "board",
  "task_checks", "task_ports", "task_board", "task_recovery",
  "task_runtime", "native_stop_seed", "budget", "usage_seed", "usage_rollup", "token_runtime", "token_seed",
  "services", "transcript_usage_seed", "ready",
  // #1445: the steps between ready and the end of start, each its own boundary; `post_ready` keeps what follows the last of them.
  "post_ready_handoff", "post_ready_queue", "post_ready_watch", "post_ready_reconcile", "post_ready_goals", "post_ready_leases", "post_ready_crash", "post_ready_pi", "post_ready_drift", "post_ready",
] as const;
export type StartupPhase = typeof STARTUP_PHASES[number];

/** Exclusive boundary durations; no timers, I/O, wall clock or startup policy changes. */
export class StartupTimings {
  private readonly started: number;
  private last = 0;
  private readonly durations = new Map<StartupPhase, number>();
  private line: string | undefined;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = this.sample();
  }

  private sample(): number {
    try {
      const value = this.clock();
      if (Number.isFinite(value)) this.last = Math.max(this.last, Math.floor(value));
    } catch { /* An unavailable diagnostic clock must never fail startup. */ }
    return this.last;
  }

  mark(phase: StartupPhase): void {
    if (this.line !== undefined || !STARTUP_PHASES.includes(phase)) return;
    const before = this.last, now = this.sample();
    this.durations.set(phase, (this.durations.get(phase) ?? 0) + now - before);
  }

  finish(): string {
    // The final caller mark includes all synchronous work through daemon return.
    return this.line ??= `startup timings ms: ${STARTUP_PHASES.map(phase => `${phase}=${this.durations.get(phase) ?? 0}`).join(" ")} total=${this.last - this.started}`;
  }
}
