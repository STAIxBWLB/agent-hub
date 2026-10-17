import { sanitize, type Kind } from "./envelope.ts";

export const DELIVERY_RETRY_WARNING = sanitize("Hub redelivery warning: An earlier attempt of this delivery is uncertain; check for its effects before acting.");
export interface HeldDeliveryHints {
  count: number;
  rows: { id: string; senders: string[]; kinds: Kind[]; createdAt: number }[];
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
export function renderHeldHint(value: unknown, now = Date.now()): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const held = value as HeldDeliveryHints;
  const kinds = new Set(["chat", "task", "review", "status", "budget", "presence"]);
  try {
    if (!Number.isSafeInteger(held.count) || held.count < 1 || !Array.isArray(held.rows) || held.rows.length > 32 || held.rows.length > held.count || typeof held.truncated !== "boolean" || Buffer.byteLength(JSON.stringify(held), "utf8") > 4096) return "";
    if (held.rows.some(row => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id.length || row.id.length > 256 || !Number.isFinite(row.createdAt) || !Array.isArray(row.senders) || !Array.isArray(row.kinds) || row.senders.some(sender => typeof sender !== "string" || sender.length > 256) || row.kinds.some(kind => !kinds.has(kind)))) return "";
  } catch { return ""; }
  const rows = held.rows.map(row => `${sanitize(row.id)} from ${row.senders.map(sanitize).join(",")} kind ${row.kinds.join(",")} age ${Math.max(0, Math.floor((now - row.createdAt) / 1000))}s`);
  const out = `Held hub deliveries: ${held.count}${held.truncated ? " (metadata truncated)" : ""}\n${rows.join("\n")}\nUse hub_delivery_retry {delivery_id} for one retry of your own uncertain row; check for earlier effects. A repeated uncertain retry needs the person.`;
  return Buffer.byteLength(out, "utf8") <= 4096 ? out : `Held hub deliveries: ${held.count} (metadata truncated; ask the person to inspect the queue).`;
}
