// No imports: native CLI entries load this from inside the adapter registry's import graph (#484).
/** A peer's membership from a `status` reply: undefined when the hub sends no roster (older than #484), never read as off. */
export function rosterInStatus(status: unknown, peer: string): boolean | undefined {
  const rows = (status as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((r: unknown) => !!r && typeof r === "object" && (r as { peer?: unknown }).peer === peer) as { on?: unknown } | undefined;
  return typeof row?.on === "boolean" ? row.on : undefined;
}

/**
 * The plugin bundle the running daemon verifies Jcode's project MCP entry against. The launcher writes this path rather
 * than its own copy: the CLI on PATH and the daemon can come from different installs, and the daemon compares the whole
 * entry. undefined for a hub that sends none or a path that is not that bundle (an older hub, a malformed reply).
 */
export function bundleInStatus(status: unknown): string | undefined {
  const value = (status as { pluginBundle?: unknown } | undefined)?.pluginBundle;
  return typeof value === "string" && value.startsWith("/") && /[\\/]plugins[\\/]agent-hub[\\/]server\.js$/.test(value) ? value : undefined;
}
