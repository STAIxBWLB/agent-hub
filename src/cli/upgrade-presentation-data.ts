/** Read-only observations of a coordinator wait, never input to its deadline or decisions. */
export interface RecoveryWaitTiming {
  readonly waitStartedAt: string;
  readonly deadlineAt: string;
  readonly waitEndedAt?: string;
}

export type RecoveryPreservationCheck = "queues" | "manualPaused" | "boardDigest" | "budgetDigest";

export interface RecoveryPreservationCause {
  readonly kind: "preservation";
  readonly check: RecoveryPreservationCheck;
  readonly projectId?: string;
}

export interface RecoveryNativeCause {
  readonly kind: "native_recovery";
  readonly reason: "terminal_unverified" | "session_changed" | "launcher_unverified" | "target_unavailable" | "attachment_timeout";
  readonly projectId: string;
  readonly peer: string;
  readonly handle?: string;
  readonly expectedSession?: string;
  readonly observedSession?: string;
  readonly targetState?: string;
  readonly launcherState?: string;
  readonly timeoutMs?: number;
}

export type RecoveryPresentationCause = RecoveryPreservationCause | RecoveryNativeCause;

/** Only a guard with observed evidence constructs this error; messages are never classification input. */
export class RecoveryPresentationError extends Error {
  constructor(message: string, readonly presentationCause: RecoveryPresentationCause) { super(message); }
}

/** The failing integrity comparison supplies the cause; presentation never parses the error text. */
export class RecoveryPreservationError extends RecoveryPresentationError {
  constructor(check: RecoveryPreservationCheck, projectId?: string) {
    super("queue, manual pause, task board or budget preservation was not verified", { kind: "preservation", check, ...(projectId === undefined ? {} : { projectId }) });
  }
}
