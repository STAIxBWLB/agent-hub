/** Closed public projection. No host, filesystem, process or persistence access. */
export const LIMITS = { timeoutMs: 5000, maxOutputBytes: 262144, maxRows: 256, maxText: 240 } as const;
export type Binding = { root: string; projectId: string };
export type State = "running" | "stale" | "partial" | "offline" | "unavailable_version" | "unknown" | "binding" | "missing_cli" | "timeout" | "nonzero" | "oversized" | "unrecognized";
export type Peer = { id: string; state: string; queued?: number; attached?: boolean; needsReview?: number; budgetPaused?: true };
export type PermissionAttention = { until: number; peer?: string };
export type Reading = { state: State; fetchedAt?: number; version?: string; permission?: PermissionAttention; peers?: Peer[]; tasks?: { state: string; count: number }[]; missing?: string[] };
export const SENTENCES: Record<State, string> = {
  running: "Hub reading is current.", stale: "Hub reading is older than 60 seconds. Run /hub refresh.",
  partial: "Some public fields are unavailable; unknown values are not zero.",
  offline: "No hub is running for this project. Run ahub up yourself in a terminal.",
  unavailable_version: "This hub version cannot supply the companion's public fields.",
  unknown: "Hub status is unknown. Run /hub refresh.",
  binding: "The hub identity does not match the session project binding. Check the selected project and start a new session.",
  missing_cli: "The ahub executable is unavailable.", timeout: "The ahub read timed out.",
  nonzero: "The ahub read failed.", oversized: "The ahub output exceeded the byte limit and was discarded.",
  unrecognized: "The ahub output was not recognized and was discarded.",
};
export class CompanionError extends Error { constructor(readonly state: State) { super(SENTENCES[state]); } }
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.maxText && !/[\p{Cc}\p{Cf}]/u.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const states = ["proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled", "backlog"];
export function parse(raw: string): unknown {
  if (new TextEncoder().encode(raw).length > LIMITS.maxOutputBytes) throw new CompanionError("oversized");
  try { return JSON.parse(raw); } catch { throw new CompanionError("unrecognized"); }
}
/** ponytail: daemon identity only; registry existence/uniqueness needs a separate bounded registration-read task. */
export function bindStatus(raw: unknown, root: string, expectedProjectId?: string): Binding {
  if (!root.startsWith("/") || !object(raw) || raw.cwd !== root || !scalar(raw.projectId)
    || expectedProjectId !== undefined && raw.projectId !== expectedProjectId) throw new CompanionError("binding");
  return { root, projectId: raw.projectId };
}
export function projectReading(raw: unknown, binding: Binding, fetchedAt: number): Reading {
  if (!object(raw)) throw new CompanionError("unrecognized");
  if (raw.cwd !== binding.root || raw.projectId !== binding.projectId) throw new CompanionError("binding");
  const missing: string[] = [];
  const result: Reading = { state: "running", fetchedAt, missing };
  if (typeof raw.version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.version) && raw.version.length <= LIMITS.maxText) result.version = raw.version;
  else missing.push("version");
  if (object(raw.peers) && Object.keys(raw.peers).length <= LIMITS.maxRows) {
    result.peers = Object.entries(raw.peers).map(([id, peer]) => {
      if (!scalar(id) || !object(peer)) throw new CompanionError("unrecognized");
      const row: Peer = { id, state: ["idle", "busy", "paused", "offline"].includes(String(peer.state)) ? String(peer.state) : "unknown" };
      if (row.state === "unknown") missing.push("peer.state");
      if (count(peer.queued)) row.queued = peer.queued; else missing.push("peer.queued");
      if (typeof peer.attached === "boolean") row.attached = peer.attached; else missing.push("peer.attached");
      if (count(peer.needsReview)) row.needsReview = peer.needsReview; else missing.push("peer.needsReview");
      // Producer pausedNote emits this exact prefix only for a retained budget record.
      if (typeof peer.paused === "string" && peer.paused.startsWith("budget: ")) row.budgetPaused = true;
      else if (peer.paused !== "manual") missing.push("peer budget pause");
      return row;
    });
  } else missing.push("peers");
  if (object(raw.tasks) && Object.keys(raw.tasks).length <= states.length) {
    result.tasks = Object.entries(raw.tasks).map(([state, total]) => {
      if (!states.includes(state) || !count(total)) throw new CompanionError("unrecognized");
      return { state, count: total };
    });
  } else missing.push("tasks");
  // needs.first is one closed highest-priority item, never a permission inventory.
  const first = object(raw.needs) && object(raw.needs.first) ? raw.needs.first : undefined;
  if (first?.kind === "approval" && first.level === "act" && count(first.until) && first.until > fetchedAt
    && (first.peer === undefined || scalar(first.peer))) {
    result.permission = { until: first.until, ...(typeof first.peer === "string" ? { peer: first.peer } : {}) };
  }
  missing.push("offline assigned in_progress");
  // Only status counts are admitted. No board or global project inventory is requested.
  missing.push("budget reason/reset time", "full permission inventory", "held delivery detail", "task list", "role-specific task list", "registration inventory");
  result.missing = [...new Set(missing)];
  result.state = !result.version && !result.peers && !result.tasks ? "unavailable_version" : missing.length ? "partial" : "running";
  return result;
}
export function aged(reading: Reading, now: number): Reading {
  if (reading.fetchedAt === undefined) return reading;
  if (!Number.isFinite(now) || now < reading.fetchedAt) return { ...reading, state: "unknown" };
  return now - reading.fetchedAt > 60000 && ["running", "partial"].includes(reading.state) ? { ...reading, state: "stale" } : reading;
}
export const consoleCommand = (root: string): string => `ahub --project '${root.replaceAll("'", "'\\''")}' console`;
export function lines(reading: Reading, now: number): string[] {
  const view = aged(reading, now);
  return [`agent-hub: ${view.state}`, SENTENCES[view.state], ...(view.version ? [`Version: ${view.version}`] : []),
    ...(view.peers ?? []).map(p => `${p.id}: ${p.state}; queue ${p.queued ?? "unknown"}; attached ${p.attached ?? "unknown"}; held ${p.needsReview ?? "unknown"}`),
    ...(view.tasks ?? []).map(t => `${t.state}: ${t.count}`),
    ...(view.missing?.length ? [`Unavailable: ${[...new Set(view.missing)].join(", ")}`] : [])];
}
