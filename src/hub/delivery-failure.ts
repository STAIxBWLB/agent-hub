/** Public diagnostics only. Causes never encode adapter text or envelope bodies. */
export const DELIVERY_FAILURE_CAUSES = [
  "peer offline",
  "adapter refused",
  "push error",
  "turn aborted",
  "timeout",
] as const;

export type DeliveryFailureCause = (typeof DELIVERY_FAILURE_CAUSES)[number];

export function isDeliveryFailureCause(value: unknown): value is DeliveryFailureCause {
  return typeof value === "string" && DELIVERY_FAILURE_CAUSES.some(cause => cause === value);
}
