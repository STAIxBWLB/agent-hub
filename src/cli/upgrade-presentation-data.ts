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

/** The failing integrity comparison supplies the cause; presentation never parses the error text. */
export class RecoveryPreservationError extends Error {
  readonly presentationCause: RecoveryPreservationCause;

  constructor(check: RecoveryPreservationCheck, projectId?: string) {
    super("queue, manual pause, task board or budget preservation was not verified");
    this.presentationCause = { kind: "preservation", check, ...(projectId === undefined ? {} : { projectId }) };
  }
}
