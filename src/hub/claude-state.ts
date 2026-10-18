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
