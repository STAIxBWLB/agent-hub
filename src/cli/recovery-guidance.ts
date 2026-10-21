import { ADAPTERS, definitionOf, type AdapterDefinition, type KindMap } from "../adapters/registry.ts";
import { readInstanceConfig } from "../hub/instance-config.ts";
import { recordedFileState } from "./recovery-session-file.ts";
import { decodeRestoreReceipt } from "./upgrade-restore-state.ts";
import { shellQuote } from "./terminal-recovery.ts";
import type { TerminalBinding } from "./terminal-recovery.ts";
import type { Inspection, PlannedProject, ProjectProgress, RecoveryOperation, RecoveryPeer } from "./upgrade.ts";

export type RecoveryNativePeer = string;
export type RecordedSessionOverride = Pick<TerminalBinding, "sessionId" | "sessionFile">;
export interface RecordedPeerGuidance {
  peer: RecoveryNativePeer;
  sessionId?: string;
  sessionFile?: string;
  command?: string;
  reattachCommand?: string;
  note: string;
}
export interface RecoveryGuidanceOptions {
  /** Person-only blocked guidance; no lifecycle action is taken by this projection. */
  stopAndArchiveCommand?: string;
  /** Caller-validated retained repair bindings, including accepted sessions no longer in a done/waiting receipt. */
  recorded?: Partial<Record<RecoveryNativePeer, RecordedSessionOverride>>;
  /** The caller's fixed formatter for this operation's own coordinator, never model-supplied code. */
  reattachCommand?: (peer: RecoveryNativePeer) => string | undefined;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const argv = (...words: string[]): string => words.map(shellQuote).join(" ");
const projectDefinition = (peer: string, root: string) => { const builtin = definitionOf(peer); if (builtin) return builtin; const bound = readInstanceConfig(root); return bound.catalog.definitionOf(peer, bound.instances); };
const peers = (instances: KindMap | undefined): RecoveryNativePeer[] => [...ADAPTERS.map(adapter => adapter.kind), ...Object.keys(instances ?? {})]
  .filter(peer => definitionOf(peer, instances)?.session.launchRecord)
  .sort((a, b) => Number(definitionOf(a, instances)?.transport === "claude-channel") - Number(definitionOf(b, instances)?.transport === "claude-channel"));

function sourceSession(adapter: AdapterDefinition, source: RecoveryPeer | undefined): { sessionId?: string; sessionFile?: string } {
  const sessionId = source?.[adapter.session.idField];
  const sessionFile = adapter.session.crashIdentity ? source?.sessionFile ?? source?.args?.sessionFile : undefined;
  return { ...(text(sessionId) ? { sessionId } : {}), ...(text(sessionFile) ? { sessionFile } : {}) };
}

/** Fixed person commands for the existing Pi archive exit; this helper performs no lifecycle action. */
export function piArchiveExit(planned: PlannedProject, stopAndArchiveCommand: string, peer?: RecoveryNativePeer): string {
  const adapter = peer ? projectDefinition(peer, planned.project.root) : undefined;
  if (peer && (!adapter?.session.launchRecord || adapter.session.personFresh !== false)) throw new Error("recorded archive-exit peer has no current trusted Pi recovery declaration");
  const instance = peer && adapter && peer !== adapter.kind ? ["--as", peer] : [];
  return `Run ${stopAndArchiveCommand}; after stop-and-archive, run ${argv("ahub", "--project", planned.project.root, "pi", ...instance)}. A proven missing archived bookmark is retired by the normal Pi start without a fresh fallback in that same call; repeat the normal start as its notice directs.`;
}

/** Accepted identity outlives an incarnation's repair fence. Malformed evidence never means absence. */
export function resolveAcceptedBinding(planned: PlannedProject, progress: ProjectProgress, peer: RecoveryNativePeer, options: { authority?: "current" | "historical" } = {}): TerminalBinding | undefined {
  if (progress.id !== planned.project.id) throw new Error("recorded binding project mismatch");
  if (options.authority !== "historical" && !projectDefinition(peer, planned.project.root)?.session.launchRecord) throw new Error("recorded binding peer has no current trusted recovery declaration");
  const binding = (value: unknown): TerminalBinding => {
    const receipt = decodeRestoreReceipt({ state: "done", binding: value }, options);
    if (receipt?.state !== "done" || receipt.binding.peer !== peer || receipt.binding.projectRoot !== planned.project.root) throw new Error("recorded binding does not match its peer and project");
    return receipt.binding;
  };
  const restored = decodeRestoreReceipt(progress.terminals[`restored:${peer}`], options);
  if (restored?.state === "done" || restored?.state === "waiting") return binding(restored.binding);
  if (progress.reattachments !== undefined) {
    if (!progress.reattachments || typeof progress.reattachments !== "object" || Array.isArray(progress.reattachments)) throw new Error("invalid recorded reattachment markers");
    if (Object.hasOwn(progress.reattachments, peer)) {
      const marker = progress.reattachments[peer];
      if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).some(key => !["state", "at", "cause", "binding"].includes(key)) ||
          !["ready", "attempted"].includes(marker.state) || marker.cause !== "detached after restore" || !Number.isFinite(marker.at) || marker.at < 0) throw new Error("invalid recorded reattachment marker");
      return binding(marker.binding);
    }
  }
  const retiredKey = `retired:${peer}`;
  if (Object.hasOwn(progress.terminals, retiredKey)) return binding(progress.terminals[retiredKey]);
  const original = planned.terminals.filter(value => !!value && typeof value === "object" && (value as { peer?: unknown }).peer === peer);
  if (original.length > 1) throw new Error("ambiguous planned recorded bindings");
  return original.length ? binding(original[0]) : undefined;
}

/**
 * Person-only projection of recorded identities, never a peer/tool result or evidence of live attachment.
 * A supplied override must already be validated by the recovery coordinator. It deliberately wins over both
 * current receipts and the original plan. A malformed current receipt otherwise stays unavailable.
 */
export function recordedPeerGuidance(planned: PlannedProject, progress: ProjectProgress, options: RecoveryGuidanceOptions = {}): RecordedPeerGuidance[] {
  let instances: KindMap | undefined;
  try { instances = readInstanceConfig(planned.project.root).instances; }
  catch {
    // ponytail: failed-config guidance shows at most 64 recorded extra ids, the declaration ceiling;
    // share an exported instance limit if that ceiling grows. These rows confer no launch authority.
    const base = peers(undefined), recorded = [...planned.terminals.map(value => (value as { peer?: unknown })?.peer),
      ...Object.keys(progress.reattachments ?? {}), ...Object.keys(progress.terminals).filter(key => key.startsWith("restored:")).map(key => key.slice("restored:".length))];
    const extra = [...new Set(recorded.filter((peer): peer is string => typeof peer === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(peer) && !base.includes(peer)))].slice(0, 64);
    return [...base, ...extra].map(peer => ({ peer, note: `${peer}: recorded session identity unavailable; project instance configuration could not be read; inspect the retained recovery receipt before choosing a conversation` }));
  }
  return peers(instances).map(peer => {
    const adapter = definitionOf(peer, instances)!;
    let session: { sessionId?: string; sessionFile?: string } | undefined;
    let unavailable = false;
    const override = options.recorded && Object.hasOwn(options.recorded, peer) ? options.recorded[peer] : undefined;
    if (override !== undefined) session = override;
    else {
      try {
        session = resolveAcceptedBinding(planned, progress, peer)
          ?? sourceSession(adapter, planned.source.peers.find(row => row.id === peer));
      } catch { unavailable = true; }
    }
    const sessionId = text(session?.sessionId) ? session.sessionId : undefined;
    const sessionFile = adapter.session.crashIdentity && text(session?.sessionFile) ? session.sessionFile : undefined;
    if (unavailable || (!sessionId && !sessionFile)) return { peer, note: `${peer}: recorded session identity unavailable; inspect the retained recovery receipt before choosing a conversation` };
    const prefix = ["ahub", "--project", planned.project.root];
    const tail = adapter.session.resumeArgv?.({ sessionId: sessionId ?? "", ...(sessionFile ? { sessionFile } : {}) }, false);
    const start = adapter.cli.startWords("tui");
    // Person guidance preserves its legacy implied startup form; terminal creation pins the explicit form.
    const personTail = tail && start.every((word, index) => tail[index] === word) ? [tail[0]!, ...tail.slice(start.length)] : tail;
    const instanceTail = personTail && peer !== adapter.kind ? [personTail[0]!, "--as", peer, ...personTail.slice(1)] : personTail;
    const command = instanceTail ? argv(...prefix, ...instanceTail) : undefined;
    let note = adapter.transport === "claude-channel"
      ? "The existing Claude channel may reconnect while its native session remains open. Transcript availability is unknown; the recorded resume command is guidance, not proof that the transcript can be resumed."
      : adapter.session.idField === "threadId" ? `Recorded ${adapter.displayName} thread; leave the old native client before resuming this conversation.`
        : `Recorded ${adapter.displayName} conversation; preserve this session when starting ${adapter.displayName} again.`;
    if (sessionFile && options.stopAndArchiveCommand && recordedFileState(sessionFile) === "missing") {
      note = `Recorded Pi session file is positively missing. Fresh-session is not supported for Pi. ${piArchiveExit(planned, options.stopAndArchiveCommand, peer)}`;
    }
    const reattachCommand = command ? options.reattachCommand?.(peer) : undefined;
    return { peer, ...(sessionId ? { sessionId } : {}), ...(sessionFile ? { sessionFile } : {}), ...(command ? { command } : {}), ...(reattachCommand ? { reattachCommand } : {}), note };
  });
}

/** Historical receipt facts only. A stopped/archived target is never described as still running. */
export function stopAndArchiveSummary(op: RecoveryOperation, live: Readonly<Record<string, Inspection | undefined>> = {}): string[] {
  const lines = [op.disposition
    ? `${op.plan.kind} abandoned, not completed; committed transitions were not rolled back.`
    : "Stop-and-archive is not recorded; no abandonment outcome is claimed."];
  for (const progress of op.projects) {
    if (["started", "peers-restored", "verified"].includes(progress.phase) || progress.restarts?.length) lines.push(`${progress.id}: target ${op.plan.version} had started; this is a recorded historical step.`);
    const outcome = op.disposition?.projects[progress.id];
    if (outcome) lines.push(`${progress.id}: ${outcome}`);
    const continuity = op.disposition?.continuity?.[progress.id];
    if (continuity === "not-archived") lines.push(`${progress.id}: no Pi continuity bookmark because the snapshot was not archived by this operation; use the manual recorded-session commands below.`);
    else if (continuity === "unavailable") lines.push(`${progress.id}: Pi continuity bookmark unavailable; automatic session continuity is unconfirmed, so use the manual recorded-session commands below.`);
    const observed = live[progress.id];
    if (observed) lines.push(`${progress.id}: supplied inspection reported ${observed.state}${observed.version ? ` on ${observed.version}` : ""}; it does not change the recorded disposition.`);
    const planned = op.plan.projects.find(project => project.project.id === progress.id);
    if (planned) for (const row of recordedPeerGuidance(planned, progress)) {
      if (row.command) lines.push(`${progress.id} ${row.peer}: ${row.command}`);
      lines.push(`${progress.id} ${row.peer}: ${row.note}`);
    }
  }
  if (op.freshOverride) {
    const { peer, evidence, checked, at } = op.freshOverride;
    lines.push(`Explicit fresh override: ${peer} in ${evidence.projectId}; accepted session ${shellQuote(evidence.sessionId)}, ${evidence.kind}${evidence.checkedPath ? ` at ${shellQuote(evidence.checkedPath)}` : ""} checked ${checked} at ${at}; missing-history replacement was person-authorized.`);
  }
  lines.push(op.pluginInstalled ? "Claude plugin installation recorded." : "Claude plugin installation not recorded.");
  if (op.globalInstalled) lines.push("global CLI installation recorded.");
  else if (op.plan.kind === "upgrade") {
    lines.push("global CLI installation remains; it was not recorded as completed.");
    const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(op.plan.version);
    lines.push(exact ? argv("bun", "add", "-g", `@staix/agent-hub@${op.plan.version}`, "--ignore-scripts") : "Exact target version unavailable; review the retained receipt before installing the global CLI.");
  } else lines.push("global CLI installation not recorded; a restart does not install a new CLI.");
  return lines;
}
