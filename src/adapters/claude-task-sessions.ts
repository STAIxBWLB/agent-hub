import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicPrivateJSON } from "../hub/recovery-store.ts";

export interface ClaudeTaskSession {
  sessionId: string;
  resume: boolean;
  persistent: boolean;
}
type Entry = { sessionId: string; started: boolean };
type State = { version: 1; sessions: Record<string, Entry> };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const taskKey = (task: number): string => {
  if (!Number.isSafeInteger(task) || task <= 0) throw new Error("invalid Claude task session task id");
  return String(task);
};
function readState(file: string): State {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
    throw error; // Unknown/unreadable state must never silently reset task continuity.
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Claude task session state");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !state.sessions || typeof state.sessions !== "object" || Array.isArray(state.sessions) || Object.keys(state).some(key => key !== "version" && key !== "sessions")) throw new Error("invalid Claude task session state");
  const sessions: Record<string, Entry> = {};
  for (const [key, raw] of Object.entries(state.sessions)) {
    if (taskKey(Number(key)) !== key || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid Claude task session entry");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.sessionId !== "string" || !UUID.test(entry.sessionId) || typeof entry.started !== "boolean" || Object.keys(entry).some(key => key !== "sessionId" && key !== "started")) throw new Error("invalid Claude task session entry");
    sessions[key] = { sessionId: entry.sessionId, started: entry.started };
  }
  return { version: 1, sessions };
}

/** One daemon-owned store per peer, at a path supplied through claudeStateFile. Never stores task text. */
export class ClaudeTaskSessions {
  private state: State;
  constructor(private readonly file: string) { this.state = readState(file); }

  private write(sessions: Record<string, Entry>): void {
    const next: State = { version: 1, sessions };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    atomicPrivateJSON(this.file, next);
    this.state = next; // A failed durable write cannot advance the in-memory identity.
  }

  /** The host resolves task attribution. No unique task means a fresh, unpersisted one-off child. */
  session(task?: number): ClaudeTaskSession {
    if (task === undefined) return { sessionId: randomUUID(), resume: false, persistent: false };
    const key = taskKey(task);
    let entry = this.state.sessions[key];
    if (!entry) {
      entry = { sessionId: randomUUID(), started: false };
      this.write({ ...this.state.sessions, [key]: entry });
    }
    return { sessionId: entry.sessionId, resume: entry.started, persistent: true };
  }

  /** Called only after that child's native start; an older child cannot alter a replacement session. */
  markStarted(task: number, expectedSessionId: string): boolean {
    const key = taskKey(task), entry = this.state.sessions[key];
    if (!entry || entry.sessionId !== expectedSessionId) return false;
    if (!entry.started) this.write({ ...this.state.sessions, [key]: { ...entry, started: true } });
    return true;
  }

  /** Host-only: call solely after transcriptPersisted positively reports a missing transcript, never on a read error. */
  forgetMissing(task: number, expectedSessionId: string): boolean {
    const key = taskKey(task), entry = this.state.sessions[key];
    if (!entry || entry.sessionId !== expectedSessionId) return false;
    const sessions = { ...this.state.sessions };
    delete sessions[key];
    this.write(sessions);
    return true;
  }
}
