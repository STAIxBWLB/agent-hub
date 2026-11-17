import type { RecoveryOperation } from "./upgrade.ts";

export interface OperationWaitPorts {
  read(id: string): RecoveryOperation;
  /** The claimed runner: a pid, "unknown" when it cannot be told, undefined when none holds the claim. */
  runner(id: string): number | "unknown" | undefined;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A runner claims and writes within a moment of being spawned; this long without either reads as gone. */
export const RUNNER_APPEARS_MS = 10_000;
/**
 * The longest `upgrade --yes` waits for an operation that is still running. A restart waits up to 10 minutes for a quiet hub and each peer restore can wait as long (docs/operations.md), so this is
 * several of those; past it the command fails and names the status command, leaving the operation to its runner.
 * ponytail: a fixed cap; read it from a recovery setting if a longer upgrade needs it.
 */
export const OPERATION_WAIT_MS = 2 * 60 * 60 * 1000;

/**
 * #1540 AC10: wait until a scheduled recovery operation is terminal (completed, cancelled or blocked), so `ahub upgrade --yes; ahub down` no longer races "recovery operation <id> is active".
 * A runner that never shows, or is gone with the receipt still open, returns that open receipt: the caller reads it as a failure, never as success. The receipt is read once more after the runner
 * lets go of its claim, because a runner writes its end state first.
 */
export async function awaitOperationEnd(operation: Pick<RecoveryOperation, "id" | "updatedAt">, ports: OperationWaitPorts): Promise<RecoveryOperation> {
  const started = ports.now();
  let seen = false;
  for (;;) {
    const op = ports.read(operation.id);
    if (op.phase === "completed" || op.phase === "cancelled" || op.phase === "blocked") return op;
    const runner = ports.runner(operation.id);
    if (runner !== undefined || op.updatedAt !== operation.updatedAt) seen = true;
    if (runner === undefined && (seen || ports.now() - started > RUNNER_APPEARS_MS)) return ports.read(operation.id);
    if (ports.now() - started > OPERATION_WAIT_MS) return op;
    await ports.sleep(250);
  }
}
