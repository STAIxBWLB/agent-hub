// No imports: the statusline tee and the CLI load this without the daemon (#450 I3).
const PEER = /^[a-z][a-z0-9-]{0,31}$/;

/** The peer a Claude process writes for: its AGENTHUB_PEER_ID when well formed, otherwise the builtin claude peer. */
export function claudePeer(value: string | undefined): string {
  return value !== undefined && PEER.test(value) ? value : "claude";
}

// Instance ids are always <kind>-<name>, so a Claude peer is the builtin id or a claude-<name> instance.
const CLAUDE_PEER = /^claude(?:-[a-z0-9-]+)?$/;

/** Per-peer Claude state file names. The builtin claude peer keeps its original names, so nothing migrates. */
export function claudeStateFile(base: "claude-launch" | "claude-session" | "claude-context" | "claude-task-sessions", peer: string): string {
  // #624: another kind (agy is a hyphen-free builtin too) must never resolve to Claude's own files.
  if (!CLAUDE_PEER.test(peer) || !PEER.test(peer)) throw new Error(`${peer} is not a Claude peer; Claude state files belong to Claude peers only`);
  return peer.includes("-") ? `${base}.${peer}.json` : `${base}.json`;
}

/** A Claude peer's own row in terminal-recovery.json for this daemon, never a sibling instance's (row order is arbitrary). */
export function ownTerminalRow(records: unknown, peer: string, projectRoot: string, instanceId: string): { launchId?: unknown } | undefined {
  if (!Array.isArray(records)) return undefined;
  return records.find((row) => row?.peer === peer && row?.projectRoot === projectRoot && row?.instanceId === instanceId);
}

/**
 * Whether a Claude session's transcript exists: the path the peer's own status line reported for that session, else
 * the builtin's default location. An instance may run under its own CLAUDE_CONFIG_DIR, which the hub cannot see:
 * without its reported path the answer is unknown, and unknown counts as persisted (it never waives session identity).
 */
export function transcriptPersisted(reported: { sessionId?: string; transcriptPath?: string }, sessionId: string, instance: boolean, fallbackPath: string, exists: (path: string) => boolean | "unknown"): boolean {
  // Only a positive "missing" (ENOENT) is not persisted; an unreadable path is unknown and keeps the identity strict.
  const found = (path: string) => exists(path) !== false;
  if (reported.sessionId === sessionId && reported.transcriptPath) return found(reported.transcriptPath);
  return instance || found(fallbackPath);
}

/** lstat evidence: true when present, false only on ENOENT/ENOTDIR, "unknown" for any other failure (EACCES included). */
export function pathEvidence(path: string, lstat: (path: string) => unknown): boolean | "unknown" {
  try { lstat(path); return true; }
  catch (error) { const code = (error as { code?: string }).code; return code === "ENOENT" || code === "ENOTDIR" ? false : "unknown"; }
}
