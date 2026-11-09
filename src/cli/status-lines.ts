import { projectRoomUnavailable } from "../rooms/status.ts";
import type { ContextView } from "../hub/context-window.ts";
import { memorySyncNextStep, WRITER_CATEGORIES, WRITER_CAUSE_CLASSES, type MemorySyncCause } from "../hub/memory-sync-state.ts";
// What `ahub status` prints for a peer and for a model backend, kept pure so it can be checked.

export interface PeerRow { permissionMode?: string; context?: ContextView; state?: string; queued?: number; queuedImportant?: number; needsReview?: number; heldBy?: string; holdNote?: string; reviewObserverHoldNote?: string; liveAccepted?: string[]; oldestQueuedAt?: number; importantWaitingSince?: number; importantWaitingNote?: string; attached?: boolean; attachMode?: "channel" | "tools-only"; attachEvidence?: string; toolsOnly?: string; pullOnly?: boolean; lastInboxAt?: number | null; permissionNote?: string; reviewerUnavailable?: string; paused?: string; servedBy?: string; requestedModel?: string }
export interface BackendRow { kind?: string; alias?: string; state?: string; active?: number; requestedModel?: string; actualModel?: string; provider?: string; coolingUntil?: string; failures?: number; failingUntil?: string }
export interface MemorySyncRow { state?: string; at?: number; cause?: string; declinedCount?: number; declinedIdsKnown?: false; withheldCount?: number; exportedCount?: number; placementActive?: false; writerCategory?: string; writerCauseClass?: string; nextStep?: string }
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
  if (state === "ok" && Number.isSafeInteger(sync.withheldCount) && sync.withheldCount! >= 0
    && Number.isSafeInteger(sync.exportedCount) && sync.exportedCount! >= 0)
    return `ok${stamp}; ${sync.withheldCount} row${sync.withheldCount === 1 ? "" : "s"} withheld locally; ${sync.exportedCount} exported`;
  if (state !== "failed") return `${state}${stamp}`;
  const causes = ["declined", "remote", "binding", "stopped", "transport", "writer", "unknown"];
  const cause = (causes.includes(sync.cause ?? "") ? sync.cause : "unknown") as MemorySyncCause;
  if (cause === "declined" && sync.placementActive === false) {
    const declined = Number.isSafeInteger(sync.declinedCount) && sync.declinedCount! >= 0 ? String(sync.declinedCount) : "unknown";
    return "machine sync blocked: " + declined + " declined rows; per-row placement is not active on this store. Activation is person-only: preview with `amem migrate --sync-placement --dry-run` and declare every writer via --writer-root. Inspect with `ahub memory declined`.";
  }
  if (cause === "writer") {
    const category = WRITER_CATEGORIES.includes(sync.writerCategory ?? "") ? sync.writerCategory : "unknown", causeClass = WRITER_CAUSE_CLASSES.includes(sync.writerCauseClass ?? "") ? sync.writerCauseClass : "unavailable";
    return `failed (writer attestation refused: ${category}, ${causeClass})${stamp}; next: ${memorySyncNextStep("writer")}`;
  }
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

/** Room failures carry a closed cause and locally generated next step only. */
export function roomsUnavailableLine(value: unknown): string {
  const unavailable = projectRoomUnavailable(value);
  return `rooms: unavailable (${unavailable?.code ?? "unknown"}); next: ${unavailable?.nextStep ?? "Run ahub room status to inspect room storage and broker availability."}`;
}
