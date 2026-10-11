import { sanitize } from "./envelope.ts";

/** Additive recovery outcome: older clients still receive ok:false and a useful error. */
export class RecoveryDatabaseBusy extends Error {
  readonly code = "database_busy";
  readonly retryable = true;
  constructor() {
    super("database_busy: a database is busy; wait for the other connection to settle before retrying the request");
  }
}

export function isDatabaseBusy(error: unknown): boolean {
  if (error instanceof RecoveryDatabaseBusy) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown };
  if (typeof value.code === "string") return /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code);
  return error instanceof Error && error.name === "SQLiteError"
    && typeof value.errno === "number" && value.errno > 0 && [5, 6].includes(value.errno & 255);
}

/** Only exact legacy SQLite refusals are inferred from an authenticated hub reply. */
export function isDatabaseBusyReply(reply: any): boolean {
  return reply?.ok === false && (reply.code === "database_busy"
    || reply.error === "database is locked" || reply.error === "database table is locked");
}

/** Frames only: retain the throw site without carrying a native error's message. */
export function databaseBusySite(error: unknown): string[] {
  const stack = error instanceof Error ? error.stack : undefined;
  return (stack ?? "").split("\n").filter(line => /^\s*at /.test(line)).slice(0, 8).map(line => sanitize(line.trim()).slice(0, 400));
}
