import { KINDS, sanitize, type Kind } from "./envelope.ts";

export const DELIVERY_RETRY_WARNING = sanitize("Hub redelivery warning: An earlier attempt of this delivery is uncertain; check for its effects before acting.");
export interface HeldDeliveryHints {
  count: number;
  rows: { id: string; revision?: number; senders: string[]; kinds: Kind[]; createdAt: number; state?: "accepted" | "needs_review" }[];
  truncated: boolean;
}
export function heldDeliveryHints(rows: readonly HeldDeliveryHints["rows"][number][], count = rows.length): HeldDeliveryHints {
  const result: HeldDeliveryHints = { count, rows: [], truncated: count > rows.length };
  for (const row of rows) {
    const value = { ...row, senders: row.senders.map(sanitize) };
    if (result.rows.length >= 32 || Buffer.byteLength(JSON.stringify({ ...result, rows: [...result.rows, value] }), "utf8") > 3500) { result.truncated = true; break; }
    result.rows.push(value);
  }
  return result;
}
export function renderHeldHint(value: unknown, now = Date.now(), recipientRetry = true): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const held = value as HeldDeliveryHints;
  const kinds = new Set<string>(KINDS);
  try {
    if (!Number.isSafeInteger(held.count) || held.count < 1 || !Array.isArray(held.rows) || held.rows.length > 32 || held.rows.length > held.count || typeof held.truncated !== "boolean" || Buffer.byteLength(JSON.stringify(held), "utf8") > 4096) return "";
    if (held.rows.some(row => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id.length || row.id.length > 256 || !Number.isFinite(row.createdAt) || !Array.isArray(row.senders) || !Array.isArray(row.kinds) || row.senders.some(sender => typeof sender !== "string" || sender.length > 256) || row.kinds.some(kind => !kinds.has(kind)))) return "";
  } catch { return ""; }
  if (held.rows.some(row => row.state !== undefined && row.state !== "accepted" && row.state !== "needs_review")) return "";
  const rows = held.rows.map(row => `${sanitize(row.id)}${Number.isSafeInteger(row.revision) && row.revision! >= 0 ? ` revision ${row.revision}` : ""}${row.state === "accepted" ? " accepted" : ""} from ${row.senders.map(sanitize).join(",")} kind ${row.kinds.join(",")} age ${Math.max(0, Math.floor((now - row.createdAt) / 1000))}s`);
  const acceptedRows = held.rows.filter(row => row.state === "accepted");
  const heldRows = held.rows.filter(row => row.state !== "accepted");
  const resolvable = heldRows.some(row => Number.isSafeInteger(row.revision) && row.revision! >= 0);
  const awaiting = acceptedRows.length > 0;
  const action = resolvable
    ? `Use hub_delivery_resolve {delivery_id, revision, action, reason} to confirm completion or discard your own held row. ${recipientRetry ? "Use hub_delivery_retry only to request its one uncertain redelivery; check for earlier effects." : "Retry remains person-only for this delivery mode."}`
    : `Ask the person to resolve these held deliveries because this hint has no usable revision. ${recipientRetry ? "A retry may be requested with hub_delivery_retry {delivery_id}; check for earlier effects." : "Retry remains person-only for this delivery mode."}`;
  const acceptedMissingRevision = acceptedRows.some(row => !Number.isSafeInteger(row.revision) || row.revision! < 0);
  const acceptedGuidance = awaiting
    ? `Accepted rows are unconfirmed; do not retry or replay them. For an accepted row listed above, use hub_delivery_resolve {delivery_id: "<shown id>", revision: <shown revision>, action: "completed" or "discard", reason: "<your reason>"}. This records your disposition only, not native-read or task-approval proof.${acceptedMissingRevision ? " An accepted row without a usable revision must be resolved by the person." : ""}`
    : "";
  const status = `${awaiting ? "Unconfirmed" : "Held"} hub deliveries: ${held.count}${held.truncated ? " (metadata truncated)" : ""}`;
  const guidance = [acceptedGuidance, ...(heldRows.length ? [action] : [])].filter(Boolean).join(" ");
  const out = `${status}\n${rows.join("\n")}\n${guidance}`;
  return Buffer.byteLength(out, "utf8") <= 4096 ? out : `Held hub deliveries: ${held.count} (metadata truncated; ask the person to inspect the queue).`;
}
