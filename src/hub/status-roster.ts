// No imports: native CLI entries load this from inside the adapter registry's import graph (#484).
/** A peer's membership from a `status` reply: undefined when the hub sends no roster (older than #484), never read as off. */
export function rosterInStatus(status: unknown, peer: string): boolean | undefined {
  const rows = (status as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((r: unknown) => !!r && typeof r === "object" && (r as { peer?: unknown }).peer === peer) as { on?: unknown } | undefined;
  return typeof row?.on === "boolean" ? row.on : undefined;
}
