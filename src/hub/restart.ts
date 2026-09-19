import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BusSnapshot } from "./bus.ts";
import type { PeerId, PeerState } from "./envelope.ts";

export const RESTART_SCHEMA_VERSION = 1;

export type RecoveryPhase = "preparing" | "prepared" | "restored" | "released";

export interface RestartPeerSnapshot {
  id: PeerId;
  state: PeerState;
  queueIds: string[];
  launch?: Record<string, unknown>;
  /** Safe native correlation metadata. Never include prompt/message text here. */
  threadId?: string;
  sessionId?: string;
}

export interface RestartSnapshot {
  schemaVersion: 1;
  projectRoot: string;
  projectId: string;
  sourceInstanceId: string;
  operationId: string;
  committedAt: number;
  bus: BusSnapshot;
  manualPaused: PeerId[];
  peers: RestartPeerSnapshot[];
  integrity?: {
    queues: Record<string, string[]>;
    manualPaused: PeerId[];
    boardDigest: string;
    budgetDigest: string;
  };
}

export interface RestartReadExpectation {
  projectRoot: string;
  projectId: string;
  operationId?: string;
}

export function restartPath(stateDir: string): string {
  return join(stateDir, "restart.json");
}

/** Read only a matching controlled-restart snapshot. Unknown or malformed state is ignored and must block recovery upstream. */
export function readRestartSnapshot(stateDir: string, expected: RestartReadExpectation): RestartSnapshot | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(restartPath(stateDir), "utf8")); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const s = parsed as Partial<RestartSnapshot>;
  if (s.schemaVersion !== RESTART_SCHEMA_VERSION || s.projectRoot !== expected.projectRoot || s.projectId !== expected.projectId || typeof s.operationId !== "string" || !s.operationId || typeof s.sourceInstanceId !== "string" || !s.sourceInstanceId || !s.bus) return undefined;
  if (expected.operationId !== undefined && s.operationId !== expected.operationId) return undefined;
  const isEnvelope = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const e = value as Record<string, unknown>;
    return typeof e.id === "string" && typeof e.trace === "string" && typeof e.from === "string" && typeof e.body === "string" && Number.isSafeInteger(e.hop) && typeof e.ts === "number" && typeof e.kind === "string" && typeof e.priority === "string" && (e.to === undefined || (Array.isArray(e.to) && e.to.every((id) => typeof id === "string")));
  };
  const bus = s.bus as Partial<BusSnapshot>;
  if (bus.schemaVersion !== 1 || !bus.queues || typeof bus.queues !== "object" || !bus.prefaces || typeof bus.prefaces !== "object" || !Array.isArray(bus.seen) || !bus.attempts || typeof bus.attempts !== "object" || !Array.isArray(bus.withdrawn)) return undefined;
  if (!Object.values(bus.queues).every((queue) => Array.isArray(queue) && queue.every(isEnvelope)) || !Object.values(bus.prefaces).every(isEnvelope) || !bus.seen.every(isEnvelope) || !bus.withdrawn.every((id) => typeof id === "string") || !Object.values(bus.attempts).every((n) => Number.isSafeInteger(n) && n > 0)) return undefined;
  if (!Array.isArray(s.manualPaused) || !s.manualPaused.every((id) => typeof id === "string") || !Array.isArray(s.peers) || !s.peers.every((peer) => peer && typeof peer === "object" && typeof peer.id === "string" && ["idle", "busy", "paused", "offline"].includes(peer.state as string) && Array.isArray(peer.queueIds) && peer.queueIds.every((id) => typeof id === "string"))) return undefined;
  if (s.integrity !== undefined && (!s.integrity || typeof s.integrity !== "object" || typeof s.integrity.boardDigest !== "string" || typeof s.integrity.budgetDigest !== "string" || !Array.isArray(s.integrity.manualPaused) || !s.integrity.manualPaused.every((id) => typeof id === "string") || !s.integrity.queues || typeof s.integrity.queues !== "object" || !Object.values(s.integrity.queues).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string")))) return undefined;
  return s as RestartSnapshot;
}

/** Atomic, owner-readable recovery state. The file never carries delivery bodies outside this 0600 path. */
export function writeRestartSnapshot(stateDir: string, snapshot: RestartSnapshot): void {
  mkdirSync(stateDir, { recursive: true });
  const file = restartPath(stateDir);
  const tmp = `${file}.${snapshot.sourceInstanceId}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function removeRestartSnapshot(stateDir: string): void {
  try { unlinkSync(restartPath(stateDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
