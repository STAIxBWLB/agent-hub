// No imports: the statusline tee and the CLI load this without the daemon (#450 I3).
const PEER = /^[a-z][a-z0-9-]{0,31}$/;

/** The peer a Claude process writes for: its AGENTHUB_PEER_ID when well formed, otherwise the builtin claude peer. */
export function claudePeer(value: string | undefined): string {
  return value !== undefined && PEER.test(value) ? value : "claude";
}

/** Per-peer Claude state file names. The builtin claude peer keeps its original names, so nothing migrates. */
export function claudeStateFile(base: "claude-launch" | "claude-session" | "claude-context", peer: string): string {
  // Instance ids are always <kind>-<name>; a builtin id has no hyphen.
  return peer.includes("-") && PEER.test(peer) ? `${base}.${peer}.json` : `${base}.json`;
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
export function transcriptPersisted(reported: { sessionId?: string; transcriptPath?: string }, sessionId: string, instance: boolean, fallbackPath: string, exists: (path: string) => boolean): boolean {
  if (reported.sessionId === sessionId && reported.transcriptPath) return exists(reported.transcriptPath);
  return instance || exists(fallbackPath);
}
