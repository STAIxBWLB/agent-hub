/** A fixed host producer's full policy check, never a verdict-authority cache. */
export interface ReviewerPolicyProbe {
  /** Boot/protocol failures revoke even when a child exits before its first periodic poll. */
  readonly failure?: Promise<void>;
  check(): Promise<boolean>;
  stop(): Promise<void>;
}
export interface ReviewerPolicyWatch {
  /** The caller attaches ownership before any timer or notification can run. */
  start(): void;
  /** Only an explicit owner retry may repeat a failed join. */
  stop(retry?: boolean): Promise<void>;
}
export interface ReviewerPolicyWatchClock {
  now(): number;
  schedule(delayMs: number, run: () => void): () => void;
}
const POLICY_POLL_MS = 100;

/** Serialized absolute cadence: an overdue check runs now, coalescing missed slots at its start. */
export function createReviewerPolicyWatch(probe: ReviewerPolicyProbe, changed: () => void,
  clock: Partial<ReviewerPolicyWatchClock> = {}): ReviewerPolicyWatch {
  const now = clock.now ?? (() => performance.now());
  const schedule = clock.schedule ?? ((delayMs: number, run: () => void) => {
    const timer = setTimeout(run, delayMs); timer.unref?.();
    return () => clearTimeout(timer);
  });
  let started = false, stopped = false, due = 0;
  let cancelTimer: (() => void) | undefined, flight: Promise<void> | undefined;
  let stopping: Promise<void> | undefined, stopFailed = false;
  const sample = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new Error("review policy clock unavailable");
    return value;
  };
  const stop = (retry = false): Promise<void> => {
    stopped = true;
    cancelTimer?.(); cancelTimer = undefined;
    if (retry && stopFailed) { stopping = undefined; stopFailed = false; }
    if (!stopping) {
      const pending = flight;
      // Termination must settle a blocked check before joining that check; the reverse order can deadlock.
      stopping = Promise.resolve().then(() => probe.stop()).then(async () => { await pending; });
      void stopping.catch(() => { stopFailed = true; });
    }
    return stopping;
  };
  const fail = () => {
    if (stopped) return;
    void stop().catch(() => {}); // The owner retains and observes the same failed join.
    try { changed(); } catch { /* The probe is already stopping; a notification cannot rearm it. */ }
  };
  const arm = () => {
    if (stopped) return;
    try { cancelTimer = schedule(Math.max(0, due - sample()), tick); }
    catch { fail(); }
  };
  const tick = () => {
    cancelTimer = undefined;
    if (stopped) return;
    if (flight) { fail(); return; }
    try {
      const at = sample();
      if (at > due) due += Math.floor((at - due) / POLICY_POLL_MS) * POLICY_POLL_MS;
    } catch { fail(); return; }
    const pending = (async () => {
      let current = false;
      try { current = await probe.check() === true; } catch { /* A failed check is policy drift. */ }
      if (stopped) return;
      if (!current) { fail(); return; }
      due += POLICY_POLL_MS;
      arm();
    })();
    flight = pending;
    void pending.finally(() => { if (flight === pending) flight = undefined; }).catch(() => {});
  };
  return {
    start: () => {
      if (started || stopped) return;
      started = true;
      if (probe.failure) void probe.failure.then(fail, fail);
      try { due = sample() + POLICY_POLL_MS; arm(); } catch { fail(); }
    },
    stop,
  };
}
