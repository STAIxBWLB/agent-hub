import type { Envelope } from "./envelope.ts";

export type Attribution = "delivery" | "single_open" | "unattributed";
export interface TaskAttribution { task?: number; attribution: Attribution; pii?: true }

/** Only one distinct positive task id in the original delivery can identify its turn. */
export function deliveryTask(originals: Envelope[]): number | undefined {
  const ids = new Set(originals.flatMap(env => {
    const id = Number(env.refs?.task);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }));
  return ids.size === 1 ? ids.values().next().value : undefined;
}

/** Rule order is deliberate: a delivered review belongs to its task, regardless of ownership. */
export function attribute(delivery: number | undefined, inProgress: number[]): TaskAttribution {
  if (delivery !== undefined && Number.isSafeInteger(delivery) && delivery > 0) return { task: delivery, attribution: "delivery" };
  if (inProgress.length === 1) return { task: inProgress[0]!, attribution: "single_open" };
  return { attribution: "unattributed" };
}
