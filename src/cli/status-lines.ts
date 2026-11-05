import type { ContextView } from "../hub/context-window.ts";
import { memorySyncNextStep, type MemorySyncCause } from "../hub/memory-sync-state.ts";
// What `ahub status` prints for a peer and for a model backend, kept pure so it can be checked.

export interface PeerRow { permissionMode?: string; context?: ContextView; state?: string; queued?: number; queuedImportant?: number; needsReview?: number; heldBy?: string; holdNote?: string; reviewObserverHoldNote?: string; liveAccepted?: string[]; oldestQueuedAt?: number; importantWaitingSince?: number; importantWaitingNote?: string; attached?: boolean; attachMode?: "channel" | "tools-only"; attachEvidence?: string; toolsOnly?: string; pullOnly?: boolean; lastInboxAt?: number | null; permissionNote?: string; reviewerUnavailable?: string; paused?: string; servedBy?: string; requestedModel?: string }
export interface BackendRow { kind?: string; alias?: string; state?: string; active?: number; requestedModel?: string; actualModel?: string; provider?: string; coolingUntil?: string; failures?: number; failingUntil?: string }
export interface MemorySyncRow { state?: string; at?: number; cause?: string; declinedCount?: number; declinedIdsKnown?: false; nextStep?: string }
export interface ReviewInputHealthRow { state?: string; cause?: string | null }

/** Aliases are already namespaced ("dgx/coding"); only an alias that is not gets its kind in front of it. */
export function backendLabel(backend: BackendRow): string {
  const kind = backend.kind ?? "unknown";
  const alias = backend.alias ?? "unknown";
  return alias.startsWith(`${kind}/`) ? alias : `${kind}/${alias}`;
}

/** `measured` reads as an ISO time unless `time` says otherwise: the console uses local time, as its event headers do. */
export function contextLine(reading: ContextView, time = (at: number) => new Date(at).toISOString()): string {
  return `context ${reading.used === null ? "unknown" : `${Math.round(reading.used * 100)}%`} (${reading.freshness}${reading.source ? `, ${reading.source}` : ""}${reading.measuredAt !== null ? `, measured ${time(reading.measuredAt)}` : ""})`;
}

/** Human status copy for machine-local sync; upstream error text never enters this projection. */
export function memorySyncLine(sync: MemorySyncRow, time = (at: number) => new Date(at).toISOString()): string {
  const allowedStates = ["disabled", "unavailable", "notrun", "not-configured", "stopped", "ok", "failed", "unknown"];
  const state = allowedStates.includes(sync.state ?? "") ? sync.state! : "unknown";
  const hasTimestamp = sync.at !== undefined;
  const validTimestamp = Number.isSafeInteger(sync.at) && Math.abs(sync.at!) <= 8_640_000_000_000_000;
  const stamp = hasTimestamp ? `; automatic, last ${validTimestamp ? time(sync.at!) : "unknown"}` : "";
  if (state === "not-configured" || state === "stopped") return `${state}${stamp}; next: ${memorySyncNextStep(state === "stopped" ? "stopped" : "remote")}`;
  if (state !== "failed") return `${state}${stamp}`;
  const causes = ["declined", "remote", "binding", "stopped", "transport", "unknown"];
  const cause = (causes.includes(sync.cause ?? "") ? sync.cause : "unknown") as MemorySyncCause;
  const count = Number.isSafeInteger(sync.declinedCount) && sync.declinedCount! >= 0 ? `, ${sync.declinedCount} declined` : "";
  const ids = cause === "declined" && sync.declinedIdsKnown === false ? "; declined ID set unknown" : "";
  return `failed (${cause}${count})${stamp}${ids}; next: ${memorySyncNextStep(cause)}`;
}

/** Public-safe status guidance; never print journal exception text or provenance contents. */
export function reviewInputHealthLine(health: ReviewInputHealthRow): string | undefined {
  if (health.state === "healthy") return undefined;
  const cause = health.state === "corrupt" && ["provenance_corrupt", "provenance_incomplete"].includes(health.cause ?? "") ? health.cause!
    : health.state === "corrupt" ? "provenance_corrupt"
    : health.state === "incomplete" && ["provenance_incomplete", "incomplete_markers", "legacy_coverage"].includes(health.cause ?? "") ? health.cause!
    : "unknown";
  const next = cause === "incomplete_markers" ? "verify the peer's next ordinary input or confirmed session change"
    : cause === "legacy_coverage" ? "keep affected work held until review-input coverage is confirmed"
    : "keep affected work held; inspect or repair only review-input provenance, preserving delivery and task state";
  const state = health.state === "incomplete" || health.state === "corrupt" ? health.state : "unknown";
  return `${state} (${cause}); next: ${next}`;
}
