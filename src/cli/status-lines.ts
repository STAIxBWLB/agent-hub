import type { ContextView } from "../hub/context-window.ts";
// What `ahub status` prints for a peer and for a model backend, kept pure so it can be checked.

export interface PeerRow { permissionMode?: string; context?: ContextView; state?: string; queued?: number; queuedImportant?: number; needsReview?: number; heldBy?: string; holdNote?: string; liveAccepted?: string[]; oldestQueuedAt?: number; attached?: boolean; toolsOnly?: string; paused?: string; servedBy?: string; requestedModel?: string }
export interface BackendRow { kind?: string; alias?: string; state?: string; active?: number; requestedModel?: string; actualModel?: string; provider?: string; coolingUntil?: string; failures?: number; failingUntil?: string }

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
