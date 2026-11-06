import { RoomStoreError } from "./store.ts";

/** Closed diagnostics only; never carry a filesystem error, path or message body. */
export const ROOM_HEALTH_CAUSES = ["invalid", "busy", "corrupt", "unsupported", "limit", "untrusted", "state_changed", "clock_rollback", "closed", "inbox_list_limit", "unavailable", "connecting", "transport_closed", "backpressure", "broker_refused"] as const;
export type RoomHealthCause = typeof ROOM_HEALTH_CAUSES[number];
export function roomHealthCause(error: unknown): RoomHealthCause {
  return error instanceof RoomStoreError && ROOM_HEALTH_CAUSES.includes(error.code) ? error.code : "unavailable";
}
export function roomHealthNextStep(code: RoomHealthCause): string {
  switch (code) {
    case "clock_rollback": return "Correct the system clock to the last recorded room time; room links retry automatically.";
    case "busy": return "Release the competing room store writer; the hub retries automatically.";
    case "corrupt": case "invalid": case "untrusted": return "Inspect local room state and restore a trusted backup before retrying; do not delete replay records.";
    case "unsupported": return "Upgrade agent-hub to a version supporting this room store, then restart the hub.";
    case "limit": case "inbox_list_limit": return "Inspect ahub room status and ahub room inbox; resolve pending work before retrying.";
    case "connecting": return "Wait for the broker connection; inspect ahub room status if it stays connecting.";
    case "backpressure": return "Wait for the broker queue to drain; stored frames retry automatically.";
    case "broker_refused": return "Check broker availability and the signed room membership, then retry.";
    case "transport_closed": return "Check the broker address and network connection; the link retries automatically.";
    case "closed": return "Restart the hub to reopen room storage.";
    case "state_changed": return "Read ahub room status again before retrying the operation.";
    default: return "Check room storage permissions and broker availability; the hub retries store open automatically.";
  }
}
export interface RoomHealth {
  refused: Partial<Record<"invalid_presence" | "wrong_epoch" | "trust_changed" | "stale" | "invalid_frame", number>>;
  outboxDepth: number;
  oldestOutboxAgeMs: number | null;
  lastReceiptAgeMs: number | null;
}
