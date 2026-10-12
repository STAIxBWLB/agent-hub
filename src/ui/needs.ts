export type NeedKind = "approval" | "default" | "storage" | "recovery" | "delivery" | "review" | "message" | "budget" | "offline";
export interface NeedItem { kind: NeedKind; level: "act" | "watch"; peer?: string; id?: string | number; until?: number; since?: number; }
export interface NeedsInput {
  approvals?: readonly { id: string; peer?: string; expiresAt: number; since?: number }[];
  defaults?: readonly { peer: string }[];
  peers?: Readonly<Record<string, { state?: string; attached?: boolean; needsReview?: number; heldBy?: string }>>;
  storageBlocked?: boolean;
  recovery?: { id?: string; running: boolean; since?: number };
  messages?: readonly { id?: string; peer?: string; important: boolean; since?: number }[];
  budget?: Readonly<Record<string, { paused?: { since?: number; resetsAt?: number } }>>;
}
export interface Needs { items: NeedItem[]; act: number; watch: number; state: "waiting" | "blocked" | "review" | "working" | "idle" | "sleeping"; }
/** Self-contained, read-only structural attention model; no source text is copied or inspected. */
export function needs(input: NeedsInput, now: number): Needs {
  const items: NeedItem[] = [];
  const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const add = (kind: NeedKind, level: "act" | "watch", peer?: unknown, identifier?: unknown, until?: unknown, since?: unknown) => items.push({ kind, level, ...(id(peer) ? { peer } : {}), ...(id(identifier) || typeof identifier === "number" && Number.isSafeInteger(identifier) && identifier > 0 ? { id: identifier } : {}), ...(time(until) ? { until } : {}), ...(time(since) ? { since } : {}) });
  for (const request of input.approvals ?? []) if (id(request.id) && time(request.expiresAt) && request.expiresAt > now) add("approval", "act", request.peer, request.id, request.expiresAt, request.since);
  for (const pending of input.defaults ?? []) if (id(pending.peer)) add("default", "act", pending.peer);
  if (input.storageBlocked === true) add("storage", "act");
  if (input.recovery) add("recovery", "watch", undefined, input.recovery.id, undefined, input.recovery.since);
  for (const [peer, status] of Object.entries(input.peers ?? {})) {
    const count = Number.isSafeInteger(status.needsReview) && status.needsReview! > 0 ? Math.min(status.needsReview!, 256) : status.heldBy ? 1 : 0;
    for (let index = 0; index < count; index++) add("delivery", "act", peer, index === 0 ? status.heldBy : undefined);
  }
  for (const message of input.messages ?? []) add("message", message.important ? "act" : "watch", message.peer, message.id, undefined, message.since);
  for (const [peer, budget] of Object.entries(input.budget ?? {})) if (budget.paused) add("budget", "watch", peer, undefined, budget.paused.resetsAt, budget.paused.since);
  const order: Record<NeedKind, number> = { approval: 0, default: 1, storage: 2, recovery: 3, delivery: 4, review: 5, message: 6, budget: 7, offline: 8 };
  items.sort((a,b) => (a.level === "act" ? 0 : 1) - (b.level === "act" ? 0 : 1) || order[a.kind] - order[b.kind] || (a.kind === "approval" ? (a.until ?? Infinity) - (b.until ?? Infinity) : 0) || (a.since ?? 0) - (b.since ?? 0));
  const act = items.filter(item => item.level === "act").length, watch = items.length - act;
  const peers = Object.values(input.peers ?? {}), attached = peers.some(peer => peer.attached !== false && ["idle", "busy", "paused"].includes(peer.state ?? ""));
  const state: Needs["state"] = items.some(item => item.kind === "approval" || item.kind === "default") ? "waiting" : items.some(item => item.level === "act" && ["storage", "delivery"].includes(item.kind)) ? "blocked" : act ? "review" : peers.some(peer => peer.attached !== false && peer.state === "busy") ? "working" : attached ? "idle" : "sleeping";
  return { items, act, watch, state };
}
