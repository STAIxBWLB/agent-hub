/** Additive recovery outcome: older clients still receive ok:false and a useful error. */
export class RecoveryDatabaseBusy extends Error {
  readonly code = "database_busy";
  readonly retryable = true;
  constructor() {
    super("database_busy: a database is still busy after its bounded wait; wait for the other connection to settle, then resume this recovery operation");
  }
}

export function isDatabaseBusy(error: unknown): boolean {
  if (error instanceof RecoveryDatabaseBusy) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown };
  return (typeof value.errno === "number" && [5, 6].includes(value.errno & 255))
    || (typeof value.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code));
}
