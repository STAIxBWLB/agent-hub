/** Closed public projection. No host, filesystem, process or persistence access. */
export const LIMITS = { timeoutMs: 5000, maxOutputBytes: 262144, maxRows: 256, maxText: 240 } as const;
export type Binding = { root: string; projectId: string };
export type State = "running" | "stale" | "partial" | "offline" | "unavailable_version" | "unknown" | "binding" | "missing_cli" | "timeout" | "nonzero" | "oversized" | "unrecognized";
export type Peer = { id: string; state: string; queued?: number; attached?: boolean; needsReview?: number };
export type Task = { id: number; publicTitle?: string; state?: string };
export type Reading = { state: State; fetchedAt?: number; version?: string; peers?: Peer[]; tasks?: { state: string; count: number }[]; board?: Task[]; missing?: string[] };
export const SENTENCES: Record<State, string> = {
  running: "Hub reading is current.", stale: "Hub reading is older than 60 seconds. Run /hub refresh.",
  partial: "Some public fields are unavailable; unknown values are not zero.",
  offline: "No hub is running for this project. Run ahub up yourself in a terminal.",
  unavailable_version: "This hub version cannot supply the companion's public fields.",
  unknown: "Hub status is unknown. Run /hub refresh.",
  binding: "The session project does not have exactly one matching hub registration. Nothing further was read.",
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
export function parseRegistration(raw: unknown, root: string, expectedId?: string): Binding {
  if (!root.startsWith("/") || !Array.isArray(raw) || raw.length > LIMITS.maxRows) throw new CompanionError("binding");
  const rows = raw.filter(row => object(row) && row.root === root);
  const row = rows[0];
  if (rows.length !== 1 || !object(row) || !scalar(row.id) || expectedId !== undefined && row.id !== expectedId
    || raw.some(other => object(other) && other !== row && other.id === row.id)) throw new CompanionError("binding");
  return { root, projectId: row.id };
}
export function projectReading(raw: unknown, board: unknown, binding: Binding, fetchedAt: number): Reading {
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
      return row;
    });
  } else missing.push("peers");
  if (object(raw.tasks) && Object.keys(raw.tasks).length <= states.length) {
    result.tasks = Object.entries(raw.tasks).map(([state, total]) => {
      if (!states.includes(state) || !count(total)) throw new CompanionError("unrecognized");
      return { state, count: total };
    });
  } else missing.push("tasks");
  if (!Array.isArray(board) || board.length > LIMITS.maxRows) throw new CompanionError("unrecognized");
  result.board = board.map(row => {
    if (!object(row) || !Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !scalar(row.title)) throw new CompanionError("unrecognized");
    if (row.title.includes("[pii]")) return { id: Number(row.id) };
    if (!states.includes(String(row.state))) throw new CompanionError("unrecognized");
    return { id: Number(row.id), publicTitle: row.title, state: String(row.state) };
  });
  // C0 did not establish public budget, permission or held-delivery detail fields.
  missing.push("budget", "permissions", "held delivery detail", "role assignment");
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
    ...(view.board ?? []).map(t => `#${t.id}${t.publicTitle ? ` ${t.publicTitle} (${t.state})` : ""}`),
    ...(view.missing?.length ? [`Unavailable: ${[...new Set(view.missing)].join(", ")}`] : [])];
}
