// What `ahub status` prints for a peer and for a model backend, kept pure so it can be checked.

export interface PeerRow { state?: string; queued?: number; queuedImportant?: number; needsReview?: number; oldestQueuedAt?: number; attached?: boolean; paused?: string; servedBy?: string; requestedModel?: string }
export interface BackendRow { kind?: string; alias?: string; state?: string; active?: number; requestedModel?: string; actualModel?: string; provider?: string }

/** Aliases are already namespaced ("dgx/coding"); only an alias that is not gets its kind in front of it. */
export function backendLabel(backend: BackendRow): string {
  const kind = backend.kind ?? "unknown";
  const alias = backend.alias ?? "unknown";
  return alias.startsWith(`${kind}/`) ? alias : `${kind}/${alias}`;
}

export function peerLine(id: string, p: PeerRow): string {
  return `  ${id.padEnd(8)} ${(p.state ?? "unknown").padEnd(8)} queued ${p.queued ?? 0}` +
    // Which queued messages the peer will not wait out the batch window for (issue #41).
    (p.queuedImportant ? ` (${p.queuedImportant} important)` : "") +
    (p.needsReview ? `  needs review ${p.needsReview}` : "") +
    (p.oldestQueuedAt !== undefined ? `  oldest ${Math.max(0, Math.floor((Date.now() - p.oldestQueuedAt) / 1000))}s` : "") +
    (p.attached === false ? "  disconnected" : "") +
    (p.paused ? `  (${p.paused})` : "") +
    (p.servedBy ? `  last call: ${p.servedBy}` : "") +
    // Which backend the peer asked for on its last turn: without it, telling a Pi DGX turn from an MLX one
    // meant reading status.json by hand.
    (p.requestedModel ? `  model: ${p.requestedModel}` : "");
}

export function backendLine(backend: BackendRow): string {
  return `  model    ${backendLabel(backend)} ${backend.state ?? "unknown"} active ${backend.active ?? 0}` +
    (backend.requestedModel ? ` requested ${backend.requestedModel}` : "") +
    (backend.actualModel ? ` actual ${backend.actualModel}` : "") +
    (backend.provider ? ` provider ${backend.provider}` : "");
}
