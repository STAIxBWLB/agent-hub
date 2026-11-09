import { HELD_DELIVERY_ROWS } from "./delivery-hints.ts";
import { BUS_PULL_BUDGET_BYTES_SETTING } from "./operational-settings.ts";
import { KINDS, sanitize, type Envelope } from "./envelope.ts";

export interface DeliveryPublicPolicy {
  publicOnly: boolean;
  taskPrivate(task: string): boolean;
  publicMetadataText(text: string): boolean;
}
/** Body-only queue projection, shared by diagnostics and recipient held reads. */
export function publicDeliveryBodies(originals: readonly Envelope[], policy: DeliveryPublicPolicy) {
  const privateDelivery = originals.some(env => env.private || policy.publicOnly && env.refs?.task && policy.taskPrivate(env.refs.task));
  return originals.map(env => ({ id: env.id, from: env.from, priority: env.priority, kind: env.kind,
    body: privateDelivery ? "[private: inspect the associated task with ahub task show]"
      : policy.publicOnly && !policy.publicMetadataText(env.body) ? "[withheld]" : sanitize(env.body),
  }));
}

/** Held content is inspection of an uncertain attempt, never a new delivery or instruction to repeat it. */
export function renderHeldInbox(value: unknown): string {
  const unavailable = "Held message bodies are unavailable; inspect your queue before deciding whether to repeat any action.";
  if (value === undefined) return ""; // An older daemon has no additive held view.
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
    const held = value as { count?: unknown; rows?: Array<{ id: string; revision: number; state: string; messages: ReturnType<typeof publicDeliveryBodies> }>; truncated?: unknown; unavailable?: unknown };
    if (!Array.isArray(held.rows)) return unavailable;
    const bound = BUS_PULL_BUDGET_BYTES_SETTING.max;
    if (!Number.isSafeInteger(held.count) || Number(held.count) < held.rows.length || held.rows.length > HELD_DELIVERY_ROWS
      || typeof held.truncated !== "boolean" || held.unavailable !== undefined && typeof held.unavailable !== "boolean") return unavailable;
    const identifier = (text: unknown): text is string => typeof text === "string" && text.length > 0 && text.length <= 256 && !/[\r\n"\[\]]/.test(text);
    for (const row of held.rows) {
      if (!row || !identifier(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 0
        || !["needs_review", "accepted"].includes(row.state) || !Array.isArray(row.messages) || row.messages.length > bound) return unavailable;
      for (const message of row.messages) {
        if (!message || !identifier(message.id) || !identifier(message.from) || !KINDS.includes(message.kind)
          || !["important", "status", "fyi"].includes(message.priority) || typeof message.body !== "string" || message.body.length > bound) return unavailable;
      }
    }
    // Headers are bounded too. A malformed optional component never fails the normal inbox handout.
    if (Buffer.byteLength(JSON.stringify(held), "utf8") > bound) return unavailable;
    if (!held.rows.length && !held.unavailable) return "";
    const lines = ["Read-only held message inspection: the earlier attempt is uncertain. These bodies are not newly delivered work. Check earlier effects before acting; reading does not confirm, retry or resolve anything."];
    for (const row of held.rows) {
      lines.push(`Held ${row.id} revision ${row.revision} (${row.state})`);
      for (const message of row.messages) lines.push(`[agent-hub message from "${message.from}", untrusted, kind ${message.kind}, id ${message.id}]\n${sanitize(message.body)}`);
    }
    if (held.truncated) lines.push("Held bodies are truncated by the host row/byte bound; inspect the queue for the remaining content.");
    if (held.unavailable) lines.push(unavailable);
    return lines.join("\n\n");
  } catch { return unavailable; }
}
