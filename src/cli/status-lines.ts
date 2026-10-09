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

export function peerLine(id: string, p: PeerRow): string {
  return `  ${id.padEnd(8)} ${(p.state ?? "unknown").padEnd(8)} queued ${p.queued ?? 0}` +
    // Which queued messages the peer will not wait out the batch window for (issue #41).
    (p.queuedImportant ? ` (${p.queuedImportant} important)` : "") +
    (p.needsReview ? `  needs review ${p.needsReview}` : "") +
    (p.liveAccepted?.length ? `  awaiting settlement ${p.liveAccepted.join(", ")} (adapter completion; Claude: reply or hub_delivery_done; task state is independent)` : "") +
    (p.heldBy ? `  ${p.holdNote ?? `held by needs_review ${p.heldBy}; ahub queue resolve ${p.heldBy} --action completed|retry|discard --reason <text>`}` : "") +
    (p.oldestQueuedAt !== undefined ? `  oldest ${Math.max(0, Math.floor((Date.now() - p.oldestQueuedAt) / 1000))}s` : "") +
    (p.attached === false ? "  disconnected" : "") +
    (p.toolsOnly ? `  ${p.toolsOnly}` : "") +
    (p.permissionMode && p.permissionMode !== "ask" ? `  permission: ${p.permissionMode}` : "") +
    (p.paused ? `  (${p.paused})` : "") +
    (p.servedBy ? `  last call: ${p.servedBy}` : "") +
    // Which backend the peer asked for on its last turn: without it, telling a Pi DGX turn from an MLX one
    // meant reading status.json by hand.
    (p.requestedModel ? `  model: ${p.requestedModel}` : "") +
    (p.context ? `  ${contextLine(p.context)}` : "");
}

export function backendLine(backend: BackendRow): string {
  return `  model    ${backendLabel(backend)} ${backend.state ?? "unknown"} active ${backend.active ?? 0}` +
    (backend.requestedModel ? ` requested ${backend.requestedModel}` : "") +
    (backend.actualModel ? ` actual ${backend.actualModel}` : "") +
    (backend.provider ? ` provider ${backend.provider}` : "") +
    (backend.coolingUntil ? ` cooling down until ${backend.coolingUntil} after ${backend.failures ?? "?"} failures` : "") +
    (backend.failingUntil ? ` last dispatch failed, no load moves until ${backend.failingUntil}` : "");
}
