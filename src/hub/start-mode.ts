import { SUPPORTED_PEERS, isSupportedPeer } from "./peer-catalog.ts";

/**
 * #269: how a peer comes up when the hub starts it: its own TUI in a terminal, or headless. A person who types
 * `ahub <peer>` gets the same default and can override it with a flag.
 */
/** Shared terminal-start guard and dashboard retry hold after an unconfirmed response. */
export const PEER_START_RETRY_MS = 30_000;
export const START_MODES = ["tui", "headless"] as const;
export type StartMode = typeof START_MODES[number];
/** The peers with both forms. Kimi's TUI is pull-only; Claude has only a TUI and local only headless. */
export const START_MODE_PEERS = ["pi", "codex", "kimi"] as const;
/** Every peer the hub can start itself. */
export const STARTABLE_PEERS = SUPPORTED_PEERS;
export type StartablePeer = typeof STARTABLE_PEERS[number];
export const isStartablePeer = (value: unknown): value is StartablePeer => isSupportedPeer(value);

export type PeerStartConfig = Record<string, { start_mode?: StartMode }>;
/** The checked per-peer start modes; only peers with both forms may be configured. */
export function peerStartConfig(value: unknown): PeerStartConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("peers must be an object of per-peer settings");
  const result: PeerStartConfig = {};
  for (const [peer, block] of Object.entries(value)) {
    if (!(START_MODE_PEERS as readonly string[]).includes(peer)) throw new Error(`peers.${peer}: only ${START_MODE_PEERS.join(" and ")} have a start mode`);
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`peers.${peer} must be an object`);
    const mode = (block as { start_mode?: unknown }).start_mode;
    if (mode !== undefined && !(START_MODES as readonly unknown[]).includes(mode)) throw new Error(`peers.${peer}.start_mode must be tui or headless`);
    result[peer] = mode === undefined ? {} : { start_mode: mode as StartMode };
  }
  return result;
}

/** The mode a start of `peer` takes when nothing more specific was asked: `tui` wherever the peer has one. */
export function startModeOf(peers: PeerStartConfig | undefined, peer: string): StartMode {
  if (peer === "claude") return "tui";
  if ((START_MODE_PEERS as readonly string[]).includes(peer)) return peers?.[peer]?.start_mode ?? "tui";
  return "headless";
}

/**
 * The checked `terminal.open` template: an argv in which exactly one element contains `{command}` (replaced by the
 * shell-quoted command the hub assembled); `{title}` and `{cwd}` are replaced too. Empty means no template.
 */
export function terminalTemplate(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string" || !part)) throw new Error("terminal.open must be a list of non-empty strings (an argv with a {command} placeholder)");
  if (value.length && value.filter((part: string) => part.includes("{command}")).length !== 1) throw new Error("terminal.open needs {command} in exactly one element");
  return [...value];
}
