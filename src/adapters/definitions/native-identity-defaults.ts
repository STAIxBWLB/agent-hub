import type { AdapterDefinition } from "../registry-types.ts";

/** Legacy native shell marker defaults; the host validates markers and conflicts before selection. */
export function nativeCliMarkerPeer(channel: boolean, appserver: boolean): string | undefined {
  return channel ? "claude" : appserver ? "codex" : undefined;
}

/** Historical identity for captures whose host did not supply an agent id. */
export function defaultCapturePeer(): string { return "local"; }

/** Released recovery receipts retain their native/channel group vocabulary. */
export function nativeRestoreGroup(transport: AdapterDefinition["transport"] | undefined): "claude" | "native" {
  return transport === "claude-channel" ? "claude" : "native";
}
