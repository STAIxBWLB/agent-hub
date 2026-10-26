import { COMPAT, type CompatId } from "../adapters/compat.ts";
import type { AgentVersionRow } from "../cli/agents.ts";
import { HUB, newEnvelope, sanitize, type PeerId } from "./envelope.ts";

/** #843 AC3: an installed gated CLI whose version is not `verified`. Ids, version, state and one receipt path, never output of the CLI. */
export interface DriftedAgent { id: CompatId; version: string; state: "in-line" | "trusted" | "refused"; receipt: string }

/** A version string that is safe to carry in a notice and a marker: what `COMPAT[id].parse` yields for a real CLI. */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * Pure: which rows are drift. A missing executable is not drift (no executable, no version), and a CLI whose
 * version could not be read has no (id, version) to announce, so `unknown` is never drift either.
 */
export function driftedAgents(rows: readonly AgentVersionRow[]): DriftedAgent[] {
  const out: DriftedAgent[] = [];
  for (const row of rows) {
    const { verdict } = row;
    if (!row.executable || verdict.state === "verified" || verdict.state === "unknown") continue;
    const version = verdict.version;
    if (!version || !SAFE_VERSION.test(version)) continue;
    out.push({ id: row.id, version, state: verdict.state, receipt: COMPAT[row.id].receipt });
  }
  return out;
}

/** Durable key of one notice: the (id, version) and the planner it was queued for. */
export const driftMarker = (agent: Pick<DriftedAgent, "id" | "version">, planner: PeerId): string => `${agent.id}:${agent.version}@${planner}`;

export const driftNoticeBody = (agent: DriftedAgent): string =>
  sanitize(`Agent CLI drift: ${agent.id} ${agent.version} ${agent.state}; last receipt ${agent.receipt}`);

export interface DriftDeps {
  /** True when the (id, version, planner) marker is new and now recorded (durable: `Board.recordAgentDriftNotice`). */
  record(marker: string): boolean;
  /** Undo a record whose notice could not be queued, so the next sweep tries again. */
  forget(marker: string): void;
  /** The effective planner holders from the settled role map. */
  planners(): readonly PeerId[];
  isRostered(peer: PeerId): boolean;
  publish(env: ReturnType<typeof newEnvelope>): PeerId[];
}

/**
 * One notice per (id, version) to each effective planner, kept durably per recipient: a planner that was queued is
 * never told again, and one that could not be queued (or was not rostered yet) is retried alone by the next sweep.
 * With no rostered planner nothing is recorded. Returns the notices queued.
 */
export function noticeDrift(drift: readonly DriftedAgent[], deps: DriftDeps): number {
  const planners = deps.planners().filter(peer => deps.isRostered(peer));
  let sent = 0;
  for (const agent of drift) for (const planner of planners) {
    const marker = driftMarker(agent, planner);
    if (!deps.record(marker)) continue;
    try {
      if (!deps.publish(newEnvelope(HUB, driftNoticeBody(agent), { to: [planner], kind: "task" })).includes(planner)) throw new Error("the notice was not queued");
      sent++;
    } catch { deps.forget(marker); }
  }
  return sent;
}
