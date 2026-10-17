import { readFileSync, openSync, closeSync, fsyncSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { realPath } from "../hub/project.ts";
import { atomicPrivateJSON } from "../hub/recovery-store.ts";

export class PiSessionUnresumable extends Error {
  readonly code = "pi_session_unresumable";
  constructor(readonly reason: "missing" | "outside_managed" | "invalid_header", message: string, options?: ErrorOptions) { super(message, options); }
}
export class PiSessionBookmarkMismatch extends Error {
  readonly code = "pi_session_bookmark_mismatch";
  readonly reason = "bookmark_mismatch";
}
function sessionReadFailure(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PiSessionUnresumable("missing", (error as Error).message, { cause: error });
  throw error;
}

/** One validation boundary for ordinary starts and explicit preserved-history selection. */
export function validatePiSession(stateDir: string, cwd: string, sessionFile: string, sessionId?: string): { sessionFile: string; sessionId: string } {
  let file: string, sessions: string;
  try { file = realPath(sessionFile); sessions = realPath(join(stateDir, "pi-sessions")); }
  catch (error) { return sessionReadFailure(error); }
  const rel = relative(sessions, file);
  if (!rel || rel.startsWith("..") || resolve(sessions, rel) !== file) throw new PiSessionUnresumable("outside_managed", "Pi session file is outside the managed project session directory");
  let first: string;
  try { first = readFileSync(file, "utf8").split("\n", 1)[0]!; } catch (error) { return sessionReadFailure(error); }
  let header: { type?: unknown; id?: unknown; cwd?: unknown } | null;
  try { header = JSON.parse(first); } catch (error) { throw new PiSessionUnresumable("invalid_header", (error as Error).message, { cause: error }); }
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || realPath(header.cwd) !== realPath(cwd)) throw new PiSessionUnresumable("invalid_header", "Pi session header does not match the requested project/session");
  if (sessionId && header.id !== sessionId) throw new PiSessionBookmarkMismatch("Pi continuity bookmark does not match the preserved session");
  return { sessionFile: file, sessionId: header.id };
}

/** The private selection record must reach storage before any prior owner is revoked. No transcript bodies. */
export function recordPiReplacement(stateDir: string, instanceId: string, previous: Record<string, unknown>, selected: { sessionFile: string; sessionId: string }): string {
  const directory = join(stateDir, "pi-session-replacements");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomUUID()}.json`);
  atomicPrivateJSON(file, { schema: 1, at: Date.now(), instanceId, previous, selected });
  for (const path of [file, directory, dirname(directory)]) {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return file;
}
