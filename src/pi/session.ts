import { readFileSync, openSync, closeSync, fsyncSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { realPath } from "../hub/project.ts";
import { atomicPrivateJSON } from "../hub/recovery-store.ts";

/** One validation boundary for ordinary starts and explicit preserved-history selection. */
export function validatePiSession(stateDir: string, cwd: string, sessionFile: string, sessionId?: string): { sessionFile: string; sessionId: string } {
  const file = realPath(sessionFile), sessions = realPath(join(stateDir, "pi-sessions"));
  const rel = relative(sessions, file);
  if (!rel || rel.startsWith("..") || resolve(sessions, rel) !== file) throw new Error("Pi session file is outside the managed project session directory");
  const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!);
  if (header.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || realPath(header.cwd) !== realPath(cwd) || (sessionId && header.id !== sessionId)) throw new Error("Pi session header does not match the requested project/session");
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
