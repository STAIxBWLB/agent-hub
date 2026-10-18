import { definitionOf } from "../adapters/registry.ts";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalDelivery } from "./delivery-journal.ts";

/**
 * Unplanned-crash recovery (issue #37). While the hub runs it keeps `sessions.json`: each attached peer's session
 * identity (the adapters' recovery metadata: ids and launch options, never message text). A clean stop removes the
 * file, so finding it at start means the previous run died.
 */
export interface SessionRecord {
  peer: string;
  /** The adapter's recovery metadata: `launch`, and `sessionId` / `threadId` / `sessionFile` where it has one. */
  meta: Record<string, unknown>;
}
export interface SessionsFile {
  instanceId: string;
  at: number;
  peers: SessionRecord[];
}

const fileOf = (stateDir: string) => join(stateDir, "sessions.json");

export function writeSessions(stateDir: string, s: SessionsFile): void {
  const tmp = `${fileOf(stateDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, fileOf(stateDir));
}

export function readSessions(stateDir: string): SessionsFile | undefined {
  if (!existsSync(fileOf(stateDir))) return undefined;
  try {
    const s = JSON.parse(readFileSync(fileOf(stateDir), "utf8")) as SessionsFile;
    if (!Array.isArray(s.peers)) return undefined;
    // A record without a peer id or metadata says nothing to resume, and reading it would stop recovery for the rest.
    return { ...s, peers: s.peers.filter((p) => !!p && typeof p.peer === "string" && !!p.meta && typeof p.meta === "object") };
  } catch {
    return undefined; // cut short by the crash: nothing to resume from
  }
}

/**
 * Only the run that wrote it removes it: a stop of an older instance must not erase a newer run's record. Without an
 * instance id it goes whatever wrote it (a controlled restart, which has its own record of the peers).
 */
export function removeSessions(stateDir: string, instanceId?: string): void {
  if (instanceId === undefined || readSessions(stateDir)?.instanceId === instanceId) rmSync(fileOf(stateDir), { force: true });
}

export { qwenSessionId } from "../adapters/definitions/qwen-native.ts";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * What can come back after a crash. `resume` holds the start arguments for peers the hub launches itself (Kimi through
 * ACP `session/load`, Pi through its session file, the local worker afresh); the others say what the user has to do.
 */
export function crashPlan(records: SessionRecord[]): { peer: string; resume?: Record<string, string>; how: string; fresh?: Record<string, string>; tui?: true }[] {
  return records.map(({ peer, meta }) => {
    const launch = (meta.launch && typeof meta.launch === "object" ? meta.launch : {}) as Record<string, unknown>;
    const model = str(launch.model);
    const adapter = definitionOf(peer);
    if (adapter?.session.resumeById) {
      const sessionId = adapter.session.crashIdentity?.(meta).sessionId;
      if (!sessionId) return { peer, how: `${peer}: saved ACP session identity unavailable; start it deliberately with ahub ${peer}` };
      return { peer, resume: { sessionId, ...(model ? { model } : {}) }, how: `${peer}: the recorded conversation can be loaded again (ACP session/load)` };
    }
    return { peer, ...(adapter?.session.crashPlan?.(meta) ?? { how: `${peer}: reconnects by itself if its client is still running` }) };
  });
}

/**
 * The loss notice for one peer: the deliveries to it that the crash left in needs_review, with their senders and the
 * tasks they were about. `taskTitle` must return the public title (`#n [pii]` for a PII task). No message text.
 */
export function lossNotice(lost: JournalDelivery[], taskTitle: (id: number) => string | undefined): string {
  const lines = lost.map((d) => {
    const from = [...new Set(d.originals.map((e) => e.from))].join(", ");
    const tasks = [...new Set(d.originals.map((e) => Number(e.refs?.task)).filter((n) => Number.isInteger(n) && n > 0))].map((n) => taskTitle(n) ?? `#${n}`);
    return `- delivery ${d.id} from ${from}${tasks.length ? `, about task ${tasks.join(", ")}` : ""}`;
  });
  return [
    "The hub stopped unexpectedly and was started again. These deliveries to you were in flight when it stopped, so whether you acted on them is not known; the console has since marked each one completed, retried or discarded:",
    ...lines,
    "Check your work against them before you go on.",
  ].join("\n");
}
