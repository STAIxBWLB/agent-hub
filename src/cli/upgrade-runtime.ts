import { authorizeConductorOperation, conductorRecoveryBinding } from "./conductor-recovery.ts";
import { resolveAcceptedBinding } from "./recovery-guidance.ts";
import { claudeStateFile } from "../hub/claude-state.ts";
import { ADAPTERS, definitionOf } from "../adapters/registry.ts";
import { readInstanceConfig, readInstanceConfigLayers } from "../hub/instance-config.ts";
import { readRecoveryWaits } from "./recovery-waits.ts";
import { readAdapterModuleDeclarations } from "../adapters/external-modules.ts";
import { configRefusal } from "../hub/config-trust.ts";
import { validExternalInstanceBinding } from "../hub/external-instance.ts";
import { isDatabaseBusy, isDatabaseBusyReply, RecoveryDatabaseBusy } from "../hub/recovery-error.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { ControlClient, PROTOCOL, PROTOCOL_MIN, controlProtocolWindow, RECOVERY_SOURCE_PROTOCOLS, readControl } from "../hub/control-client.ts";
import { negotiateProtocol, protocolWindow } from "../hub/protocol-window.ts";
import { awaitStopped, inspectProject } from "../hub/lifecycle.ts";
import type { Project } from "../hub/registry.ts";
import { canonicalPath, hubHome } from "../hub/project.ts";
import { packageDigest, preserveRuntimePackage, stageCurrentRuntime, registryRelease, runCommand, stageRelease, verifyPackage, type RunCommand } from "./recovery-package.ts";
import { inspectSavedTerminal, inspectTerminals, closeTerminal, createTerminal, launcherOf, recordPath, waitForIdle, shellQuote, type SessionRef, type TerminalBinding, type TerminalRecoveryOptions } from "./terminal-recovery.ts";
import { ReattachmentRequired, MissingRecordedSession, FinalRefusal, planFingerprint, recoveryScope, registeredProjects, targetReadsWaivers, type Inspection, type PlannedProject, type ProjectProgress, type RecoveryDriver, type RecoveryOperation, type RecoveryPeer, type UpgradePlan } from "./upgrade.ts";
import { SHARED_CHANNEL_VERSION_ARGV, nativeRecordedSessionState } from "../adapters/definitions/native-recovery.ts";
import { refreshManager } from "../hub/manager.ts";
import { abandonRestartSnapshot, readRestartSnapshot, waiveRecoveryPeers } from "../hub/restart.ts";
import { readRecoveryContinuity, retireRecoveryContinuity, writeRecoveryContinuity } from "../hub/recovery-continuity.ts";
import { recoveryLock } from "../hub/recovery-store.ts";
import { decodeRestoreReceipt, restoreTransition, type RestoreReceipt, type RestoreEvidence, type RestoreTransition } from "./upgrade-restore-state.ts";
import { RecoveryDeferredHubError } from "../hub/deferred-hub.ts";
import { RecoveryPreservationError, RecoveryPresentationError, type RecoveryNativeCause } from "./upgrade-presentation-data.ts";

// #489 H4: the reconnect, unmanaged reconnect, control request, terminal idle and shutdown waits are settings now (`recovery.*`, src/hub/operational-settings.ts), read by `readRecoveryWaits` at the start of
// each wait. Their defaults are the constants that stood here: an unmanaged Claude's plugin retries with a backoff of at most 30 s and three of those bound its reconnect wait (#206, 90 s); managed TUI startup
// can include resume and MCP handshakes, so its wait matches createTerminal's ten-minute readiness ceiling (600 s, which is also the setting's floor).
class AttachmentLauncherGone extends Error {
  constructor(readonly transition: RestoreTransition) { super("chosen attachment launcher exited"); }
}
const attachedBinding = (binding: TerminalBinding, sessionId: string): TerminalBinding => ({ ...binding, sessionId });

export const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const orcaExecutable = () => process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" && !process.env.ORCA_TERMINAL_HANDLE ? "orca-ide" : "orca");

/** Definitions are resolved against the owning project's current trusted declarations, never a global instance map. */
const projectDefinition = (peer: string, projectRoot: string) => { const builtin = definitionOf(peer); if (builtin) return builtin; const bound = readInstanceConfig(projectRoot); return bound.catalog.definitionOf(peer, bound.instances); };

const sessionState = (binding: TerminalBinding): "found" | "missing" | "unknown" => {
  const state = projectDefinition(binding.peer, binding.projectRoot)?.session.transcriptExists?.(binding);
  return state === "unknown" ? "unknown" : state === false ? "missing" : "found";
};
const sessionPath = (binding: TerminalBinding) => projectDefinition(binding.peer, binding.projectRoot)?.session.transcriptPath?.(binding);
export const observedSession = (peer: string, value: RecoveryPeer | undefined, projectRoot?: string) => value?.[(projectRoot ? projectDefinition(peer, projectRoot) : definitionOf(peer))?.session.idField ?? "sessionId"];
const nativeZeroTurn = (stateDir: string, binding: TerminalBinding, phase: "plan" | "attach" | "verify") => projectDefinition(binding.peer, binding.projectRoot)?.session.zeroTurn?.({ stateDir, binding, phase }) === true;
const unresumable = (binding: TerminalBinding) => sessionState(binding) === "unknown"
  ? `codex: the session store ${sessionPath(binding)} cannot be read, so whether thread ${binding.sessionId} can resume is unknown`
  : `codex: thread ${binding.sessionId} has no resumable transcript under ${sessionPath(binding)}`;

const closeUnsettled = (binding: TerminalBinding, seen: "listed" | "unreadable") => seen === "listed"
  ? `${binding.peer}: terminal close outcome needs manual reconciliation: Orca still lists terminal ${binding.handle}; close that terminal (the login shell it runs in) by hand in Orca first`
  : `${binding.peer}: Orca's terminal list could not be read, so whether terminal ${binding.handle} is closed is unknown; check it in Orca (close it by hand, with the login shell it runs in, if it is still open) first`;

/** Preserve legacy source-text capability probes; only fixed definition data supplies paths and export names. */
function legacyTargetLists(root: string, probe: { file: string; exportName: string }, kind: string): boolean {
  const file = join(root, probe.file);
  const values = existsSync(file) ? new RegExp(`export const ${probe.exportName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(readFileSync(file, "utf8"))?.[1] : undefined;
  const name = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !!values && new RegExp(`["']${name}["']`).test(values);
}

function terminalOptions(run: RunCommand = runCommand): TerminalRecoveryOptions {
  return { orcaExecutable: orcaExecutable(), runner: async (args) => {
    const result = await run([orcaExecutable(), ...args], { timeoutMs: 610_000 });
    return { status: result.code, stdout: result.stdout, stderr: result.stderr };
  } };
}

/** `fresh` (#215: the operator's choice, or a planned fresh start) starts Codex or Claude without resuming its recorded session. */
export function restoredTerminalArgv(entrypoint: string, projectRoot: string, binding: TerminalBinding, fresh = false): string[] {
  const adapter = projectDefinition(binding.peer, binding.projectRoot);
  const nativeTail = adapter?.session.resumeArgv?.(binding, fresh);
  const tail = nativeTail && adapter ? [nativeTail[0]!, ...(binding.peer !== adapter.kind ? ["--as", binding.peer] : []), ...nativeTail.slice(1)] : undefined;
  if (!tail) throw new Error(`${binding.peer}: no recorded terminal resume adapter`);
  return [process.execPath, entrypoint, "--project", projectRoot, ...tail];
}

/** Recovery alone retains explicit old source wires; ordinary clients use the current supported window. */
function recoveryProtocol(descriptor: { protocol?: unknown; protocolMin?: unknown; protocolMax?: unknown } | undefined): number | undefined {
  if (!descriptor) return undefined;
  if (descriptor.protocol === undefined && descriptor.protocolMin === undefined && descriptor.protocolMax === undefined) return PROTOCOL_MIN;
  const advertised = controlProtocolWindow(descriptor);
  if (!advertised) return undefined;
  const current = negotiateProtocol(protocolWindow(PROTOCOL, PROTOCOL_MIN)!, advertised);
  if (current !== undefined) return current;
  return [...RECOVERY_SOURCE_PROTOCOLS].reverse().find(version => version < PROTOCOL_MIN && version >= advertised.vMin && version <= advertised.v);
}


async function rpc(project: Project, message: Record<string, unknown>, protocol?: number, conductorPeer?: string): Promise<any> {
  const controlTimeoutMs = readRecoveryWaits(project.root).controlTimeoutMs;
  const client = await ControlClient.connect(project.stateDir, { ...(conductorPeer ? { role: "tools" as const, peer: conductorPeer } : { role: "console" as const }), projectRoot: project.root, projectId: project.id }, controlTimeoutMs, protocol);
  try {
    const reply = await client.request(message, controlTimeoutMs);
    if (reply.ok === false) {
      // An older hub has only its exact SQLite message; preserve compatibility without trusting arbitrary text.
      if (isDatabaseBusyReply(reply)) throw new RecoveryDatabaseBusy();
      throw new Error(reply.error ?? "recovery control request failed");
    }
    return reply;
  } finally { client.close(); }
}

/**
 * #272: end one attached agent before an upgrade, for the person who chose it on the plan screen. The plan is what was
 * drawn, so all of it is read again and any difference ends nothing: no operation holds the lock, the hub runs as the
 * instance the plan read with the peer attached, and for a TUI agent the attached session is the one the plan bound and
 * binds again to a terminal with the plan's handle and incarnation. `closeTerminal` itself compares only the terminal's
 * handle, incarnation, worktree and root, never who runs in it. A headless agent is the hub's own process, so the hub
 * is asked to stop it, which a hub older than that request cannot do. `deps` are a test's fakes.
 */
export async function endPlannedPeer(planned: PlannedProject, peer: RecoveryPeer, deps: { run?: RunCommand; inspect?: (project: Project) => Promise<Inspection>; lock?: () => string | undefined } = {}): Promise<string> {
  const { run = runCommand, inspect = inspectRecovery, lock = recoveryLock } = deps;
  const name = `${planned.project.id}/${peer.id}`;
  const binding = (planned.terminals as TerminalBinding[]).find((t) => t.peer === peer.id);
  const refused = (why: string) => `${name}: not ended (${why})`;
  let cut = "", current: TerminalBinding | undefined;
  try {
    const owner = lock();
    if (owner) return refused(`recovery operation ${owner} holds the lock`);
    const hub = await inspect(planned.project);
    if (hub.state !== "running" || hub.instanceId !== planned.source.instanceId) return refused(`its hub reads as ${hub.state === "running" ? `instance ${hub.instanceId}, not the ${planned.source.instanceId} of the plan` : hub.state}`);
    const now = hub.peers.find((p) => p.id === peer.id && p.state !== "offline");
    if (!now) return refused("it is no longer attached to its hub");
    // The hub holds what a peer that goes offline mid-turn was working on (`uncertain` in bus.ts).
    if (now.state === "busy") cut = "; its turn was cut: a delivery it had not settled is held as needs_review, and its queue stays held until ahub queue resolve";
    if (binding) {
      if (observedSession(binding.peer, now, binding.projectRoot) !== binding.sessionId) return refused(`the session attached now is not the one the plan bound to terminal ${binding.handle}`);
      // The same question the plan asked (`makeUpgradePlan`), for this one peer.
      const session = projectDefinition(binding.peer, binding.projectRoot)?.session.crashIdentity ? { sessionId: binding.sessionId, ...(now.sessionFile ? { sessionFile: now.sessionFile } : {}), ...(now.args?.backend ? { backend: now.args.backend } : {}), ...(now.args?.model ? { model: now.args.model } : {}) } : binding.sessionId;
      const found = await inspectTerminals(planned.project.root, { [binding.peer]: session }, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: planned.source.instanceId });
      current = found.byPeer[binding.peer];
      if (found.manualRequired || !current) return refused(`its terminal cannot be bound again: ${found.blockers[0]?.message ?? "no terminal was found"}`);
      if (current.handle !== binding.handle || current.incarnationId !== binding.incarnationId) return refused(`its session is now bound to terminal ${current.handle} (${current.incarnationId}), not the plan's ${binding.handle} (${binding.incarnationId})`);
    }
    // The reads above take a second or more: an operation that took the lock meanwhile still stops this.
    const taken = lock();
    if (taken) return refused(`recovery operation ${taken} holds the lock`);
  } catch (error) { return refused((error as Error).message); } // a lock or a registry that cannot be read throws
  if (current) {
    const result = await closeTerminal(current, 0, terminalOptions(run));
    return result.closed ? `${name}: terminal ${current.handle} closed${cut}` : `${name}: its terminal was not closed (${result.blockers[0]?.message ?? "unknown reason"}); end it in that terminal`;
  }
  try {
    await rpc(planned.project, { t: "peer_stop", peer: peer.id }, planned.source.protocol);
    return `${name}: stopped${cut}`;
  } catch (error) {
    const message = (error as Error).message;
    return /does not know "peer_stop"/.test(message)
      ? `${name}: hub ${planned.source.version ?? "of this version"} cannot end a headless agent by itself; it stops with the old hub at the upgrade and the new hub starts it again (ahub stop ${peer.id} ends it then)`
      : `${name}: not stopped (${message})`;
  }
}

/** No imports or executable catalog reconstruction: unknown kinds are only possible module instances. */
function recoveryDeclarations(projectRoot: string) {
  const layers = readInstanceConfigLayers(projectRoot);
  const modules = readAdapterModuleDeclarations(projectRoot, layers).modules;
  const local = layers.find(layer => layer.name === "config.local.json");
  const raw = local && !configRefusal(projectRoot, local.name) ? local.raw : {};
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const instances = raw.instances === undefined ? {} : raw.instances;
  if (!object(instances) || Object.keys(instances).length > 64) throw new Error("recovery instance declaration inventory unavailable");
  const configured = object(raw.adapters) ? Object.keys(raw.adapters) : [];
  const moduleInstances = Object.entries(instances).filter(([, entry]) => !object(entry) || typeof entry.kind !== "string" || !definitionOf(entry.kind) && !configured.includes(entry.kind));
  return { modules, instances, configured, moduleInstances };
}
const hasRecoveryFeatures = (features: unknown, required: readonly string[]): features is string[] => Array.isArray(features) && features.every(feature => typeof feature === "string") && required.every(feature => features.includes(feature));
const EXTERNAL_INSTANCE_FEATURES = ["external_adapter_modules", "peer_instances", "external_adapter_instances"] as const;

/** Includes offline declarations and retained identities, so a reused target cannot downgrade their meaning. */
export function instanceRecoveryTargetRefusal(projectRoot: string, features: unknown, retainedPeers: readonly RecoveryPeer[] = []): string | undefined {
  const declarations = recoveryDeclarations(projectRoot);
  if ((declarations.moduleInstances.length || retainedPeers.some(peer => Object.hasOwn(peer, "externalInstance"))) && !hasRecoveryFeatures(features, EXTERNAL_INSTANCE_FEATURES)) {
    return "target lacks external_adapter_instances or its external_adapter_modules/peer_instances prerequisites; module instances require a supporting target before recovery effects";
  }
}

/** Declared identities cannot be reinterpreted against an older running source's unbound peer rows. */
export function instanceRecoverySourceRefusal(projectRoot: string, features: unknown, observedPeers?: unknown): string | undefined {
  const inventory = recoveryDeclarations(projectRoot);
  if (inventory.moduleInstances.length) {
    if (!hasRecoveryFeatures(features, EXTERNAL_INSTANCE_FEATURES)) return "source lacks external_adapter_instances or its external_adapter_modules/peer_instances prerequisites; restart with a supporting source before recovering module instances, including offline declarations";
    const rows = observedPeers && typeof observedPeers === "object" && !Array.isArray(observedPeers) ? observedPeers as Record<string, unknown> : undefined;
    for (const [id, declaration] of inventory.moduleInstances) {
      const peer = rows?.[id] as RecoveryPeer | undefined;
      const binding = peer?.externalInstance;
      if (!declaration || typeof declaration !== "object" || !peer || !["idle", "busy", "paused", "offline"].includes(peer.state) || !validExternalInstanceBinding(binding, projectRoot, id) || binding.kind !== (declaration as { kind?: unknown }).kind ||
          !inventory.modules.some(module => module.sha256 === binding.sha256 && relative(projectRoot, resolve(projectRoot, module.path)).split(sep).join("/") === binding.modulePath)) {
        return "source external module instance binding unavailable or changed; a matching authenticated live startup catalog is required before recovery";
      }
    }
    const configuredIds = [...inventory.configured, ...Object.entries(inventory.instances).filter(([, entry]) => entry && typeof entry === "object" && inventory.configured.includes((entry as { kind: string }).kind)).map(([id]) => id)];
    if (configuredIds.length && !hasRecoveryFeatures(features, ["configured_acp"])) {
      if (!rows || !Object.values(rows).every(peer => peer && typeof peer === "object" && typeof (peer as { state?: unknown }).state === "string") || Object.entries(rows).some(([id, peer]) => configuredIds.includes(id) && (peer as { state: string }).state !== "offline")) return "source lacks configured_acp; configured native identities require a supporting source before recovery";
    }
    // The authenticated source owns semantic admission; raw config and cached display metadata cannot reconstruct it.
    return undefined;
  }
  const bound = readInstanceConfig(projectRoot);
  if (bound.adapter_modules?.length && !hasRecoveryFeatures(features, ["external_adapter_modules"])) return "source lacks external_adapter_modules; restart with a supporting source before recovering module peers";
  const configured = Object.keys(bound.adapters ?? {});
  const configuredIds = [...configured, ...Object.entries(bound.instances ?? {}).filter(([, entry]) => configured.includes(entry.kind)).map(([id]) => id)];
  if (configuredIds.length && !(Array.isArray(features) && features.every(feature => typeof feature === "string") && features.includes("configured_acp"))) {
    const rows = observedPeers && typeof observedPeers === "object" && !Array.isArray(observedPeers) ? Object.entries(observedPeers) : undefined;
    if (!rows || !rows.every(([, peer]) => !!peer && typeof peer === "object" && typeof (peer as { state?: unknown }).state === "string") || rows.some(([id, peer]) => configuredIds.includes(id) && (peer as { state: string }).state !== "offline")) return "source lacks configured_acp; configured native identities require a supporting source before recovery";
  }
  const declared = Object.keys(bound.instances ?? {});
  if (!declared.length) return undefined;
  if (Array.isArray(features) && features.every(feature => typeof feature === "string") && features.includes("peer_instances")) return undefined;
  if (observedPeers && typeof observedPeers === "object" && !Array.isArray(observedPeers)) {
    const peers = Object.entries(observedPeers);
    if (peers.every(([, peer]) => !!peer && typeof peer === "object" && typeof (peer as { state?: unknown }).state === "string") &&
      !peers.some(([id, peer]) => declared.includes(id) && (peer as { state: string }).state !== "offline")) return undefined;
  }
  return "source lacks peer_instances support and a declared instance of this project may be live; restart the source with a supporting agent-hub version before retrying recovery; for a first upgrade, end the extra native sessions first (a source whose declared instances are all offline proceeds without further steps); only if one cannot be ended, temporarily remove its declaration, upgrade the source, then declare it again; legacy peer identities were not reinterpreted";
}

export async function inspectRecovery(project: Project, targetFeatures?: readonly string[], purpose?: "cleanup", conductorPeer?: string): Promise<Inspection> {
  // #226: the claim is judged by the registry as it is now, never by the plan's frozen copy, which holds the source's
  // pid from planning time (after a reboot another process may hold it). A registry that cannot be read throws: the
  // caller reads that as not inspected, never as stopped.
  const claim = registeredProjects().find((p) => p.id === project.id);
  const base = await inspectProject({ ...project, instanceId: claim?.instanceId ?? null, pid: claim?.pid ?? null, pidSignature: claim?.pidSignature ?? null }, readRecoveryWaits(project.root).controlTimeoutMs, conductorPeer);
  if (base.failure?.code === "database_busy") throw new RecoveryDatabaseBusy();
  const control = readControl(project.stateDir);
  const sourceProtocol = recoveryProtocol(control);
  const sourceWindow = control && controlProtocolWindow(control);
  const wire = { ...(sourceProtocol === undefined ? {} : { protocol: sourceProtocol }),
    ...(sourceWindow ? { protocolMin: sourceWindow.vMin, protocolMax: sourceWindow.v } : {}) };
  const legacySupported = sourceProtocol !== undefined && RECOVERY_SOURCE_PROTOCOLS.includes(sourceProtocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]);
  // A stopped runtime reports whose unreleased restart snapshot it holds: only that one can start it again (#215).
  let snapshot: string | undefined, snapshotError: Inspection["snapshotError"];
  if (base.state === "stopped") {
    try { snapshot = readRestartSnapshot(project.stateDir, { projectRoot: project.root, projectId: project.id })?.operationId; }
    catch (error) {
      if (!(error instanceof RecoveryDeferredHubError)) throw error;
      // Corruption blocks restore, but cannot erase independently confirmed shutdown or the person's archive exit.
      // Keep diagnostics static: the rejected snapshot may contain forged envelope fields.
      snapshotError = { code: "recovery_deferred_hub", message: "restart snapshot deferred hub notices are invalid; restore is blocked" };
    }
  }
  // A dead pid or a missing project directory is final whatever protocol its manifest names: probing it would read
  // "unavailable" forever and wedge abort, resume and stop-and-archive (#215).
  if (base.state === "stopped" || base.state === "missing" || (base.state !== "running" && !legacySupported)) {
    let blockers: string[];
    if (base.state === "stopped") blockers = snapshotError ? [snapshotError.message] : [];
    else if (base.state === "incompatible") blockers = ["manual-bootstrap-required: source lacks the recovery contract; use its matching CLI"];
    else blockers = [base.error ?? base.state];
    return {
    state: base.state, peers: [], blockers,
    ...(control?.instanceId ? { instanceId: control.instanceId } : {}),
    ...(control?.protocol === undefined ? {} : { protocol: control.protocol }),
    ...(control?.protocolMin === undefined ? {} : { protocolMin: control.protocolMin }),
    ...(control?.protocolMax === undefined ? {} : { protocolMax: control.protocolMax }),
    ...(snapshot ? { snapshot } : {}), ...(snapshotError ? { snapshotError } : {}),
    };
  }
  let status = base.status;
  if (!status && control && sourceProtocol !== undefined && sourceProtocol >= PROTOCOL_MIN) return {
    state: "unavailable", peers: [], blockers: ["runtime changed during recovery inspection"],
    ...(control.instanceId ? { instanceId: control.instanceId } : {}), ...wire,
  };
  if (!status && legacySupported && sourceProtocol < PROTOCOL_MIN) {
    try {
      const readback = await rpc(project, { t: "status" }, sourceProtocol, conductorPeer);
      status = readback.status;
    } catch (error) {
      if (isDatabaseBusy(error)) throw error;
      // server.stop() runs before state-file removal, so a stopping hub briefly refuses
      // connections with its manifest still on disk. Never infer stopped from a connect
      // failure: callers poll again and see "stopped" once the manifest is gone.
      return { state: "unavailable", peers: [], blockers: ["runtime changed during recovery inspection"],
        ...(control?.instanceId ? { instanceId: control.instanceId } : {}), ...wire };
    }
  }
  if (!status || !control) return { state: "unavailable", peers: [], blockers: ["authenticated source status unavailable"] };
  const instanceRefusal = purpose === "cleanup" ? undefined : instanceRecoverySourceRefusal(project.root, status.features, status.peers);
  if (instanceRefusal) return { state: "incompatible", instanceId: status.instanceId, version: status.version, ...wire, peers: [], blockers: [instanceRefusal] };
  let response: any;
  try { response = await rpc(project, { t: "recovery", op: "inspect", expectedInstanceId: status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) }, sourceProtocol, conductorPeer); }
  catch (error) {
    if (isDatabaseBusy(error) || targetFeatures !== undefined) throw error;
    // A stop can complete between authenticated status and the second read. Never infer stopped
    // from a connection failure: the coordinator will inspect the ownership manifest again.
    return { state: "unavailable", instanceId: status.instanceId, version: status.version, ...wire,
      peers: [], blockers: ["runtime changed during recovery inspection"] };
  }
  const peers = Object.values(response.recovery?.peers ?? {}) as any[];
  if (peers.some(peer => peer && Object.hasOwn(peer, "externalInstance") && !validExternalInstanceBinding(peer.externalInstance, project.root, peer.id))) {
    return { state: "incompatible", instanceId: status.instanceId, version: status.version, ...wire, peers: [], blockers: ["source external module instance binding is invalid"] };
  }
  // #272: the hub's own words for what it waits on; shown to the person, never decided on.
  const waiting = (Array.isArray(response.recovery?.blockers) ? response.recovery.blockers : []).filter((b: unknown): b is string => typeof b === "string").slice(0, 20).map((b: string) => b.slice(0, 200));
  return { state: "running", instanceId: status.instanceId, version: status.version, ...wire,
    recovery: { operationId: response.recovery?.operationId, phase: response.recovery?.phase, ready: response.recovery?.ready, ...(waiting.length ? { waiting } : {}) }, peers: peers.map((peer) => ({ id: peer.id, state: peer.state,
      ...(protocolWindow(peer.controlProtocol) ? { controlProtocol: peer.controlProtocol } : {}),
      ...(peer.observation === undefined ? {} : { observation: peer.observation }),
      ...(peer.externalInstance === undefined ? {} : { externalInstance: peer.externalInstance }),
      ...(peer.threadId ? { threadId: peer.threadId } : {}), ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
      ...(typeof (peer.sessionFile ?? peer.launch?.sessionFile) === "string" ? { sessionFile: peer.sessionFile ?? peer.launch.sessionFile } : {}),
      ...(peer.launch ? { args: Object.fromEntries(Object.entries(peer.launch).filter(([k, v]) => ["model", "route", "sessionFile", "mode", "backend"].includes(k) && typeof v === "string")) as Record<string, string> } : {}) })), blockers: [] };
}

export async function makeUpgradePlan(kind: "restart" | "upgrade", version: string, selectedRoot?: string, run: RunCommand = runCommand, conductorPeer?: string): Promise<UpgradePlan> {
  const projects = registeredProjects();
  const selected = selectedRoot === undefined ? undefined : canonicalPath(selectedRoot);
  const sourceDigest = packageDigest(PACKAGE_ROOT);
  const currentVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  const release = kind === "upgrade" ? await registryRelease(version, run) : undefined;
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind, version: kind === "restart" ? currentVersion : version,
    sourceRoot: PACKAGE_ROOT, sourceDigest, ...(release ? { integrity: release.integrity } : {}), ...(selected === undefined ? {} : { scope: { projectRoot: selected } }), projects: [], blockers: [] };
  if (kind === "upgrade" && selected === undefined) {
    try {
      if ((await run([...SHARED_CHANNEL_VERSION_ARGV], { timeoutMs: 10_000 })).code !== 0) body.blockers.push("shared Claude plugin installer is unavailable");
    } catch { body.blockers.push("shared Claude plugin installer is unavailable"); }
  }
  const managerFile = join(hubHome(), "manager/status.json");
  if (existsSync(managerFile)) {
    try {
      const manager = JSON.parse(readFileSync(managerFile, "utf8"));
      if (recoveryProtocol(manager) === undefined) body.blockers.push("manager requires manual bootstrap with its matching CLI before current-protocol recovery");
    } catch { body.blockers.push("manager ownership manifest is unreadable"); }
  }
  for (const project of projects) {
    if (kind === "restart" && selected === undefined || selected !== undefined && project.root !== selected) continue;
    let source: Inspection;
    try { source = await inspectRecovery(project, undefined, undefined, conductorPeer); }
    catch { source = { state: "unavailable", peers: [], blockers: ["source recovery metadata could not be authenticated"] }; }
    if (source.state === "stopped" || source.state === "missing") continue;
    const blockers = [...source.blockers];
    if (!RECOVERY_SOURCE_PROTOCOLS.includes(source.protocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]) || source.state !== "running") blockers.push(`manual-bootstrap-required: an authenticated source overlapping protocols ${PROTOCOL_MIN}..${PROTOCOL}, or an explicit recovery protocol 9..15, is required`);
    if (source.recovery?.operationId && source.recovery.phase !== "released") blockers.push(`existing recovery operation ${source.recovery.operationId} must be resolved first`);
    const sessions: Partial<Record<TerminalBinding["peer"], string | SessionRef>> = {};
    const reconnectOnly: string[] = [];
    const unrecordedTerminals: string[] = [];
    for (const peer of source.peers) {
      if (peer.state === "offline") continue;
      const adapter = projectDefinition(peer.id, project.root);
      const refusal = adapter?.session.recoveryRefusal?.(peer);
      if (refusal) { blockers.push(refusal); continue; }
      if (adapter?.transport === "claude-channel") {
        // #206: managed means a live `ahub claude` launcher recorded for this daemon and a session record written by
        // that launch. Anything else cannot be bound to the attached session, so its record never becomes a target.
        // ponytail: the channel's hello carries no launch id, so a plain `claude` that took the peer id from a live
        // managed session reads as managed; send the launch id at hello (a protocol bump) if that case shows up.
        const recorded = await launcherOf(peer.id as TerminalBinding["peer"], project.root, { ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId });
        if (recorded?.state === "unknown") {
          // An unreadable launcher is never gone (#215): whether the session is managed cannot be told.
          delete peer.sessionId;
          blockers.push(`${peer.id}: ${recorded.record ? `the launcher recorded in terminal ${recorded.record.handle}` : recorded.invalidRow ? "a launch record in terminal-recovery.json that may be its launcher's" : "the launcher record (terminal-recovery.json)"} cannot be read, so whether the attached session is managed is unknown; manual-required; next action: make it readable (or end that session and close its terminal), then make a new plan`);
          continue;
        }
        const launcher = recorded?.state === "live" ? recorded.record! : undefined;
        if (!launcher) {
          unrecordedTerminals.push(peer.id);
          delete peer.sessionId;
          delete peer.args; // An unmanaged channel reconnects itself; its observed identity is not restoration data.
          const sourceWindow = source.protocolMin === undefined || source.protocolMax === undefined ? undefined : controlProtocolWindow(source);
          const pluginProtocol = peer.controlProtocol ?? (sourceWindow?.v === sourceWindow?.vMin ? sourceWindow?.v : undefined);
          if (pluginProtocol !== undefined && negotiateProtocol(protocolWindow(PROTOCOL, PROTOCOL_MIN)!, protocolWindow(pluginProtocol)!) !== undefined) reconnectOnly.push(peer.id);
          else blockers.push(`${peer.id}: unmanaged session (no live ahub claude launcher recorded) has ${pluginProtocol === undefined ? "an unknown attached plugin protocol" : `a protocol-${pluginProtocol} plugin`} and cannot be verified to reconnect to a protocol-${PROTOCOL_MIN}..${PROTOCOL} hub; next action: end that Claude session, or relaunch it with ahub claude in an Orca terminal, then make a new plan`);
          continue;
        }
        let record: { instanceId?: unknown; launchId?: unknown; sessionId?: unknown } | undefined;
        try { record = JSON.parse(readFileSync(join(project.stateDir, claudeStateFile("claude-session", peer.id)), "utf8")); } catch { /* no record: the id check below reports it */ }
        if (peer.sessionId && (record?.instanceId !== source.instanceId || record?.launchId !== launcher.launchId || record?.sessionId !== peer.sessionId)) {
          delete peer.sessionId;
          blockers.push(`${peer.id}: the recorded session was not written by the live launcher in terminal ${launcher.handle}; manual-required; next action: close any other Claude session in this project, send one message in that terminal, then make a new plan`);
          continue;
        }
      }
      if (adapter?.session.launchRecord && (!adapter.session.restoreArgs || peer.args?.mode === "tui")) {
        const session = observedSession(peer.id, peer, project.root);
        if (!session) blockers.push(adapter.session.crashIdentity
          ? `${peer.id}: original session ID is unknown; manual-required; next action: reconnect the original ${adapter.displayName} session and make a new recovery plan`
          : `${peer.id}: original conversation ID is unknown; manual-required; next action: reconnect the original native session and make a new recovery plan`);
        else sessions[peer.id as TerminalBinding["peer"]] = adapter.session.crashIdentity
          ? { sessionId: session, ...(peer.sessionFile ? { sessionFile: peer.sessionFile } : {}), ...(peer.args?.backend ? { backend: peer.args.backend } : {}), ...(peer.args?.model ? { model: peer.args.model } : {}) } : session;
      } else if (adapter?.session.resumeById) {
        const session = adapter.session.crashIdentity?.(peer).sessionId;
        if (!session) blockers.push(`${peer.id}: saved ACP session identity unavailable; end the peer and make a new recovery plan`);
      } else if (!adapter?.session.freshOnRestore && !adapter?.session.restoreArgs) blockers.push(`${peer.id}: no automatic recovery adapter`);
    }
    const terminals = await inspectTerminals(project.root, sessions, {
      ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId,
    });
    blockers.push(...terminals.blockers.map((b) => `${b.message}${b.terminalReference ? ` (terminal ${b.terminalReference})` : ""}${b.nextAction ? `; next action: ${b.nextAction}` : ""}`));
    for (const peer of source.peers) {
      if (peer.state === "offline" || unrecordedTerminals.includes(peer.id) || terminals.bindings.some(binding => binding.peer === peer.id)) continue;
      const unrecorded = projectDefinition(peer.id, project.root)?.session.unrecordedTerminal;
      if (unrecorded !== "always" && !(unrecorded === "tui" && peer.args?.mode === "tui")) continue;
      const recorded = await launcherOf(peer.id, project.root, { ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId });
      // Unknown or unreadable evidence remains unknown; exact Orca ownership above is an independent positive proof.
      if (recorded && recorded.state !== "gone") continue;
      unrecordedTerminals.push(peer.id);
      blockers.push(`${peer.id}: attached, launcher unrecorded; no current live launcher or verified terminal binding; manual-required; next action: end it in its terminal, or resume the original conversation through its native resume flow in an Orca terminal, then make a new plan`);
    }
    const freshStart: string[] = [];
    for (const binding of terminals.bindings) if (projectDefinition(binding.peer, binding.projectRoot)?.session.missingEvidence === "rollout") {
      const transcript = sessionState(binding);
      if (transcript === "found") continue;
      if (transcript === "missing" && nativeZeroTurn(project.stateDir, binding, "plan")) { freshStart.push(binding.peer); continue; }
      blockers.push(transcript === "unknown"
        ? `${unresumable(binding)}; manual-required; next action: make that store readable, then make a new plan`
        : `${unresumable(binding)}, and the hub cannot show that no turn ran on it, so its conversation may not come back after the restart; manual-required; next action: end that Codex session and close its Orca terminal ${binding.handle} (ahub codex starts a new one later), then make a new plan`);
    }
    body.projects.push({ project, source, terminals: terminals.bindings, blockers, ...(reconnectOnly.length ? { reconnectOnly } : {}), ...(unrecordedTerminals.length ? { unrecordedTerminals } : {}), ...(freshStart.length ? { freshStart } : {}) });
  }
  if (!body.projects.length) body.blockers.push("no running registered projects in scope");
  return { ...body, fingerprint: planFingerprint(body) };
}

/** Freeze the coordinator/source package before its mutable global installation is replaced. */
export function preserveSource(plan: UpgradePlan, home = hubHome()): string {
  if (packageDigest(plan.sourceRoot) !== plan.sourceDigest) throw new Error("source package changed since planning");
  const base = join(home, "releases");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return preserveRuntimePackage(plan.sourceRoot, join(base, `source-${plan.sourceDigest}`), plan.sourceDigest).root;
}

const unboundRecoveryInspection = inspectRecovery;

export function makeRecoveryDriver(run: RunCommand = runCommand, liveTestPeer?: string, clock?: Pick<RecoveryDriver, "now" | "sleep">, conductorPeer?: string): RecoveryDriver {
  let authorizedOperation: RecoveryOperation | undefined;
  const recoveryCurrent = async () => { if (conductorPeer) { if (!authorizedOperation) throw new FinalRefusal("conductor recovery authority unavailable"); await authorizeConductorOperation(authorizedOperation, conductorPeer); } };
  const inspectRecovery = (project: Project, features?: readonly string[], purpose?: "cleanup") => unboundRecoveryInspection(project, features, purpose, conductorPeer);
  const now = clock?.now ?? (() => Date.now());
  const sleep = clock?.sleep ?? ((ms: number) => Bun.sleep(ms));
  /** `only`: one binding's native profile, for a command run once per profile (#450 I3: Claude instances may differ). */
  const env = (op: RecoveryOperation, project?: Project, only?: TerminalBinding): NodeJS.ProcessEnv => {
    const value = { ...process.env };
    // Do not carry one project's gateway, auth overrides or unattended mode into another.
    for (const key of Object.keys(value)) if (key.startsWith("AGENTHUB_") || key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_") ||
      (project && /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key))) delete value[key];
    value.AGENTHUB_HOME = hubHome(); value.AGENTHUB_RECOVERY_OPERATION = op.id;
    value.AGENTHUB_UNATTENDED = "0";
    if (liveTestPeer) value.AGENTHUB_PEER_ID = liveTestPeer;
    if (conductorPeer) value.AGENTHUB_PEER_ID = conductorPeer;
    if (project) {
      value.AGENTHUB_PROJECT_DIR = project.root; value.AGENTHUB_STATE_DIR = project.stateDir;
      delete value.CODEX_HOME; delete value.CLAUDE_CONFIG_DIR;
      const bindings = op.plan.projects.find((p) => p.project.id === project.id)?.terminals as TerminalBinding[] | undefined;
      for (const binding of only ? [only] : bindings ?? []) {
        // Preserve the captured legacy profile for terminal bindings without a dedicated native config variable.
        const key = projectDefinition(binding.peer, binding.projectRoot)?.session.configDirEnv ?? "CLAUDE_CONFIG_DIR";
        if (binding.launch.env[key]) value[key] = binding.launch.env[key];
      }
    }
    return value;
  };
  const command = async (op: RecoveryOperation, args: string[], project?: Project, only?: TerminalBinding) => {
    const result = await run([process.execPath, join(op.targetRoot!, "src/cli/main.js"), ...(project ? ["--project", project.root] : []), ...(liveTestPeer ? ["--live-test"] : []), ...args],
      { env: { ...env(op, project, only), ...(conductorPeer ? { AGENTHUB_RECOVERY_CONDUCTOR: conductorPeer, AGENTHUB_RECOVERY_CONTINUATION: op.id } : {}) }, cwd: project?.root ?? op.plan.projects[0]!.project.root, timeoutMs: 180_000 });
    if (result.code !== 0) throw new Error(`target command ${args[0]} failed; inspect recovery state before retrying`);
    return result;
  };
  const control = async (project: Project, op: string, id: string, instance: string, targetFeatures?: readonly string[]) => {
    await recoveryCurrent();
    const protocol = recoveryProtocol(readControl(project.stateDir));
    return rpc(project, { t: "recovery", op, operationId: id, expectedInstanceId: instance, ...(targetFeatures === undefined ? {} : { targetFeatures }), ...(conductorPeer && authorizedOperation ? { authority: conductorRecoveryBinding(authorizedOperation, project, conductorPeer) } : {}) }, protocol, conductorPeer).then(() => {});
  };
  const nativeFailure = (planned: PlannedProject, peer: string, reason: RecoveryNativeCause["reason"], message: string,
    details: Omit<RecoveryNativeCause, "kind" | "reason" | "projectId" | "peer"> = {}) =>
    new RecoveryPresentationError(message, { kind: "native_recovery", reason, projectId: planned.project.id, peer, ...details });
  const revalidateTerminal = async (planned: PlannedProject, progress: ProjectProgress, saved: TerminalBinding, exact: boolean): Promise<TerminalBinding> => {
    const options = { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId };
    const found = await inspectTerminals(planned.project.root, { [saved.peer]: { sessionId: saved.sessionId, sessionFile: saved.sessionFile, backend: saved.backend, model: saved.model } }, options);
    const current = found.byPeer[saved.peer];
    if (found.manualRequired || !current || (exact && (current.handle !== saved.handle || current.incarnationId !== saved.incarnationId || current.worktreeId !== saved.worktreeId || current.projectRoot !== saved.projectRoot))) {
      throw nativeFailure(planned, saved.peer, "terminal_unverified", `${saved.peer}: saved terminal identity changed or is not verified; manual-required`, { handle: saved.handle });
    }
    const idle = await waitForIdle(exact ? saved : current, readRecoveryWaits(planned.project.root).terminalIdleWaitMs, options);
    if (!idle.satisfied) throw nativeFailure(planned, saved.peer, "terminal_unverified", `${saved.peer}: terminal is not idle; manual-required`, { handle: saved.handle });
    const observed = await inspectRecovery(planned.project);
    if (observed.instanceId !== progress.instanceId) throw nativeFailure(planned, saved.peer, "target_unavailable", `${saved.peer}: daemon instance changed during terminal revalidation`, { handle: saved.handle, targetState: observed.state });
    const peer = observed.peers.find((item) => item.id === saved.peer);
    const session = observedSession(saved.peer, peer, saved.projectRoot);
    if (session !== saved.sessionId || projectDefinition(saved.peer, saved.projectRoot)?.session.crashIdentity && progress.reattachments?.[saved.peer] && saved.sessionFile && peer?.sessionFile !== saved.sessionFile) throw nativeFailure(planned, saved.peer, "session_changed", `${saved.peer}: daemon session changed during terminal revalidation; manual-required`, { handle: saved.handle, expectedSession: saved.sessionId, ...(session === undefined ? {} : { observedSession: session }) });
    return current;
  };
  /** Whether Orca's inventory lists the terminal; a failed, not-ok, truncated or non-JSON answer shows nothing. */
  const listed = async (binding: TerminalBinding): Promise<"listed" | "absent" | "unreadable"> => {
    const result = await run([orcaExecutable(), "terminal", "list", "--json"]);
    let inventory: any;
    try { inventory = JSON.parse(result.stdout); } catch { return "unreadable"; }
    const rows = inventory?.result?.terminals;
    if (result.code !== 0 || inventory?.ok !== true || !Array.isArray(rows) || inventory.result?.truncated) return "unreadable";
    return rows.some((t: any) => t.handle === binding.handle || t.incarnationId === binding.incarnationId) ? "listed" : "absent";
  };
  /**
   * #215: what runs for a peer on the target, the one place restore reads it. Only a running target answering as the
   * expected instance can report "gone"; an unreadable target or launcher is unknown and blocks, never gone.
   */
  const peerEvidence = async (planned: PlannedProject, progress: ProjectProgress, peer: TerminalBinding["peer"]):
      Promise<{ state: "live"; session?: string; handle?: string; attached?: true; terminal?: Pick<TerminalBinding, "handle" | "incarnationId" | "worktreeId"> } | { state: "gone"; terminal?: Pick<TerminalBinding, "handle" | "incarnationId" | "worktreeId"> } | { state: "unknown"; why: string; step?: string; idless?: true }> => {
    const target = await inspectRecovery(planned.project);
    if (target.state !== "running" || target.instanceId !== progress.instanceId) {
      // Only a hub that may still answer is waited for; a stopped, missing or other one is settled by the runner's list.
      const settled = ["running", "stopped", "missing"].includes(target.state);
      return { state: "unknown", why: `the target hub reads as ${target.state === "running" ? `instance ${target.instanceId}, not ${progress.instanceId}` : target.state}`, ...(settled ? {} : { step: "wait until the target answers" }) };
    }
    const attached = target.peers.find((p) => p.id === peer && p.state !== "offline");
    const session = observedSession(peer, attached, planned.project.root);
    if (session) return { state: "live", session };
    let endedTerminal: Pick<TerminalBinding, "handle" | "incarnationId" | "worktreeId"> | undefined;
    // #225: the launch records of every instance this operation started for the project, the current one first: a
    // launcher a dead instance recorded may still run (read before the check below, so a block names its terminal).
    for (const instanceId of [progress.instanceId, ...(progress.restarts ?? []).map((r) => r.instanceId)]) {
      if (!instanceId) continue;
      const launch = await launcherOf(peer, planned.project.root, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId });
      if (launch?.state === "live") {
        const record = launch.record!;
        return { state: "live", handle: record.handle, ...(attached ? { attached: true as const } : {}),
          ...(instanceId === progress.instanceId ? { terminal: { handle: record.handle, incarnationId: record.incarnationId, worktreeId: record.worktreeId } } : {}) };
      }
      if (launch?.state === "unknown") {
        return launch.record ? { state: "unknown", why: `its launcher in terminal ${launch.record.handle} cannot be read`, step: `wait until it attaches, or end it and close terminal ${launch.record.handle}` }
          : launch.invalidRow ? { state: "unknown", why: "a launch record that may be its launcher's cannot be evaluated", step: `inspect ${recordPath(planned.project.stateDir)} and fix that row, or end that launcher and remove its row` }
          : { state: "unknown", why: "the launcher records cannot be read", step: `inspect ${recordPath(planned.project.stateDir)} and move it aside (sessions it recorded then count as unmanaged)` };
      }
      if (instanceId === progress.instanceId && launch?.state === "gone" && launch.record) {
        const record = launch.record;
        endedTerminal = { handle: record.handle, incarnationId: record.incarnationId, worktreeId: record.worktreeId };
      }
    }
    // #225: attached with no provable session id (a Claude of a dead instance whose plugin reconnected, or one that has
    // not reported its id yet) is a session of unknown identity, never "nothing attached".
    if (attached) return { state: "unknown", idless: true, why: `a ${peer} session is attached to the target without a session id`, step: `wait until it reports one, or end that ${peer} session` };
    return { state: "gone", ...(endedTerminal ? { terminal: endedTerminal } : {}) };
  };
  /** Only independently confirmed terminal loss plus absent sessions and launchers can arm a repair. */
  const detached = async (planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation,
    binding: TerminalBinding, save?: () => void): Promise<void> => {
    const evidence = await peerEvidence(planned, progress, binding.peer);
    if (evidence.state !== "gone") return;
    const terminal = await inspectSavedTerminal(binding, terminalOptions(run));
    const decision = restoreTransition({ state: "done", binding }, {
      target: "running", launcher: "gone", session: "none", allowOther: false,
      terminal: terminal.state === "missing" || terminal.state === "orphaned" ? "gone" : terminal.state === "present" ? "present" : terminal.state === "changed" ? "changed" : "unknown",
    });
    if (decision.action !== "reattach") return;
    const current = await inspectRecovery(planned.project);
    if (current.state !== "running" || current.instanceId !== progress.instanceId || current.version !== op.plan.version || current.recovery?.operationId !== op.id ||
      (await peerEvidence(planned, progress, binding.peer)).state !== "gone") return;
    const existing = progress.reattachments?.[binding.peer];
    const why = `${binding.peer}: detached after restore; saved terminal ${binding.handle} is ${terminal.state}; recorded session ${binding.sessionId}${binding.sessionFile ? ` (${binding.sessionFile})` : ""}`;
    if (existing) throw new ReattachmentRequired(planned.project.id, binding.peer, `${why}; the one reattachment was already attempted; no second terminal will be created`);
    if (!save) throw new Error(`${why}; a durable coordinator save is required before reattachment`);
    (progress.reattachments ??= {})[binding.peer] = { state: "ready", at: now(), cause: "detached after restore", binding };
    (progress.repairedSessions ??= {})[binding.peer] = true;
    progress.terminals[`restored:${binding.peer}`] = decision.next;
    progress.phase = "started";
    save();
    throw new ReattachmentRequired(planned.project.id, binding.peer, `${why}; resume or use the operation's person-only reattach command`);
  };
  /**
   * #225: the terminal of a done restoration of a target instance that died is closed under the close receipt rules
   * (`closedRetired:<peer>` `pending` until Orca no longer lists it; an unreadable or truncated inventory is unknown and
   * changes nothing) or found absent, before its peer is relaunched against the new instance.
   */
  const closeRetired = async (progress: ProjectProgress, peer: string, save: () => void): Promise<void> => {
    const retired = progress.terminals[`retired:${peer}`] as TerminalBinding | undefined;
    const key = `closedRetired:${peer}`;
    if (!retired || typeof retired !== "object" || progress.terminals[key] === true) return;
    const seen = await listed(retired);
    if (progress.terminals[key] === "pending" || seen !== "listed") {
      if (seen !== "absent") throw new Error(closeUnsettled(retired, seen));
      progress.terminals[key] = true; save(); return;
    }
    const idle = await waitForIdle(retired, readRecoveryWaits(retired.projectRoot).terminalIdleWaitMs, terminalOptions(run));
    if (!idle.satisfied) throw new Error(`${peer}: terminal ${retired.handle} of the stopped target's session is not verified idle; finish or cancel its turn, or close that terminal by hand, first`);
    progress.terminals[key] = "pending"; save();
    await recoveryCurrent();
    const result = await closeTerminal(retired, 0, terminalOptions(run));
    if (result.manualRequired) throw new Error(`${peer}: closing terminal ${retired.handle} of the stopped target's session was not verified; manual-required`);
    progress.terminals[key] = true; save();
  };
  /** #414: an idle terminal is not an authenticated peer. Keep its receipt while waiting, including on resume. */
  const awaitAttachment = async (planned: PlannedProject, progress: ProjectProgress, op: RecoveryOperation, waiting: Extract<RestoreReceipt, { state: "waiting" }>, save: () => void, expectedSession: string | null = waiting.binding.sessionId): Promise<string> => {
    const saveTiming = () => {
      try { save(); }
      catch { console.warn("Recovery timing observation could not be saved; recovery continues"); }
    };
    const binding = waiting.binding;
    const matchesTerminal = (terminal: Pick<TerminalBinding, "handle" | "incarnationId" | "worktreeId">) => terminal.handle === binding.handle && terminal.incarnationId === binding.incarnationId && terminal.worktreeId === binding.worktreeId;
    const reconnectWaitMs = readRecoveryWaits(planned.project.root).reconnectWaitMs; // read once, at the start: a wait already running keeps the deadline the receipt records
    const startedAt = now(), deadline = startedAt + reconnectWaitMs;
    const waitStep = op.step;
    if (waitStep) {
      (op.waits ??= {})[waitStep] = { waitStartedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadline).toISOString() };
      saveTiming();
    }
    let waitFailed = false;
    try {
    let live: Inspection;
    for (;;) {
      live = await inspectRecovery(planned.project);
      if (live.state !== "running") throw nativeFailure(planned, binding.peer, "target_unavailable", `${binding.peer}: target hub reads as ${live.state} while awaiting attachment; saved terminal retained`, { handle: binding.handle, targetState: live.state });
      if (live.instanceId !== progress.instanceId || live.version !== op.plan.version || live.recovery?.operationId !== op.id) throw nativeFailure(planned, binding.peer, "target_unavailable", `${binding.peer}: target identity changed while awaiting attachment`, { handle: binding.handle, targetState: live.state });
      const peer = live.peers.find((p) => p.id === binding.peer && p.state !== "offline");
      const session = observedSession(binding.peer, peer, binding.projectRoot);
      const changed = !!session && expectedSession !== null && session !== expectedSession;
      // #64: only the original zero-turn Claude may change identity without an operator choice. Re-read persistence
      // at attachment, not at the plan or wait start; an already accepted replacement is bound to its own id.
      const zeroTurn = changed && !progress.reattachments?.[binding.peer] && !progress.repairedSessions?.[binding.peer] && (planned.terminals as TerminalBinding[]).some((p) => p.peer === binding.peer && p.sessionId === binding.sessionId) && nativeZeroTurn(planned.project.stateDir, binding, "attach");
      if (changed && !zeroTurn) throw nativeFailure(planned, binding.peer, "session_changed", `${binding.peer}: a different conversation attached while awaiting ${binding.sessionId}`, { handle: binding.handle, expectedSession: expectedSession!, observedSession: session! });
      if (now() > deadline) break;
      const launcher = await launcherOf(binding.peer, planned.project.root, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId });
      const sameTerminal = launcher?.record && matchesTerminal(launcher.record);
      let launchState: RestoreEvidence["launcher"] = !launcher ? "no-record-yet" : launcher.state === "unknown" || !launcher.record ? "unknown"
        : sameTerminal ? launcher.state : launcher.state === "gone" ? "no-record-yet" : "replaced";
      let olderHandle: string | undefined;
      if ((launchState === "gone" || launchState === "no-record-yet") && !session) {
        // An exact exit is not proof while an older launcher or an id-less session may still run.
        const evidence = await peerEvidence(planned, progress, binding.peer);
        if (evidence.state === "gone" && evidence.terminal && matchesTerminal(evidence.terminal)) launchState = "gone";
        else if (evidence.state === "unknown") {
          if (!(launchState === "no-record-yet" && evidence.idless)) launchState = "unknown";
        } else if (evidence.state === "live" && !evidence.session) {
          if (evidence.terminal) launchState = matchesTerminal(evidence.terminal) ? "live" : "replaced";
          else { launchState = "older-instance"; olderHandle = evidence.handle; }
        } else if (evidence.state === "live" && evidence.session) {
          if (now() >= deadline) break;
          await sleep(Math.min(1000, deadline - now()));
          continue;
        }
      }
      const decision = restoreTransition(waiting, { target: "running", launcher: launchState,
        session: session && peer && ["idle", "busy", "paused"].includes(peer.state) ? changed ? "other" : "planned" : "none", allowOther: zeroTurn || expectedSession === null, binding });
      if (decision.action === "settle" && session) {
        await recoveryCurrent();
        if (zeroTurn) waiveRecoveryPeers(planned.project.stateDir, op.id, { [binding.peer]: "zero-turn" });
        return session;
      }
      if (decision.action === "fail" || decision.action === "create") throw new AttachmentLauncherGone(decision);
      if (decision.action === "block") {
        if (launchState === "replaced") throw nativeFailure(planned, binding.peer, "launcher_unverified", `${binding.peer}: saved terminal identity changed while awaiting attachment`, { handle: binding.handle, launcherState: launchState });
        if (launchState === "older-instance") throw nativeFailure(planned, binding.peer, "launcher_unverified", `${binding.peer}: an older target's launcher in terminal ${olderHandle ?? "unknown"} may still run; saved terminal retained; no terminal was created`, { ...(olderHandle ? { handle: olderHandle } : {}), launcherState: launchState });
        throw nativeFailure(planned, binding.peer, "launcher_unverified", `${binding.peer}: the chosen restoration launcher's identity cannot be verified (${launchState}); saved terminal retained; no terminal was created`, { handle: binding.handle, launcherState: launchState });
      }
      if (now() >= deadline) break;
      await sleep(Math.min(1000, deadline - now()));
    }
    const terminal: NonNullable<ProjectProgress["attachmentTimeouts"]>[string]["terminal"] = { handle: binding.handle, incarnationId: binding.incarnationId, state: "unknown" };
    try {
      const result = await run([orcaExecutable(), "terminal", "show", "--terminal", binding.handle, "--json"], { timeoutMs: 3000 });
      const value = JSON.parse(result.stdout), shown = value.result?.terminal;
      if (result.code === 0 && value.ok === true && shown?.handle === binding.handle && shown.incarnationId === binding.incarnationId) {
        if (["idle", "busy", "exited"].includes(shown.state)) terminal.state = shown.state;
        if (typeof shown.connected === "boolean") terminal.connected = shown.connected;
        if (typeof shown.orphaned === "boolean") terminal.orphaned = shown.orphaned;
      }
    } catch { /* unavailable metadata stays unknown; raw output/errors never enter the receipt */ }
    const peer = live.peers.find((p) => p.id === binding.peer);
    const session = peer?.state === "offline" ? undefined : observedSession(binding.peer, peer, binding.projectRoot);
    (progress.attachmentTimeouts ??= {})[binding.peer] = { at: now(), terminal,
      hub: { state: live.state, ...(live.instanceId ? { instanceId: live.instanceId } : {}), ...(peer ? { peerState: peer.state } : {}), ...(session ? { sessionId: session } : {}) },
      lastHubConnectAttempt: "unknown" };
    save();
    throw nativeFailure(planned, binding.peer, "attachment_timeout", `${binding.peer}: attachment not verified within ${reconnectWaitMs / 1000} s; terminal ${binding.handle} retained; resume after it attaches (native-start diagnostic recorded; last hub connect attempt unknown)`, { handle: binding.handle, timeoutMs: reconnectWaitMs });
    } catch (error) { waitFailed = true; throw error; }
    finally {
      const finish = () => {
        if (!waitStep) return;
        op.waits![waitStep] = { ...op.waits![waitStep]!, waitEndedAt: new Date(now()).toISOString() };
        saveTiming();
      };
      // Metadata storage must not hide the attachment failure or change its recovery outcome.
      if (waitFailed) { try { finish(); } catch { /* original attachment failure remains authoritative */ } }
      else finish();
    }
  };
  return {
    ...(liveTestPeer === undefined ? {} : { liveTestPeer }),
    ...(conductorPeer ? { conductorPeer, authorize: async (op: RecoveryOperation) => { await authorizeConductorOperation(op, conductorPeer); authorizedOperation = op; } } : {}),
    now, sleep, inspect: inspectRecovery,
    recordedSessionState: async (binding, kind) => nativeRecordedSessionState(binding, kind),
    stage: async (op) => {
      if (packageDigest(op.sourceRoot, { ownDependencies: true }) !== op.plan.sourceDigest) throw new FinalRefusal("preserved source changed");
      const scoped = recoveryScope(op.plan) !== undefined;
      const staged = op.plan.kind === "restart" ? { root: op.sourceRoot, digest: verifyPackage(op.sourceRoot, op.plan.version, { ownDependencies: true }) }
        : await stageRelease(op.plan.version, op.plan.integrity!, run, hubHome(), scoped);
      const target = scoped && op.plan.kind === "upgrade" ? stageCurrentRuntime(staged.root, op.plan.version) : staged;
      const identityPath = join(target.root, "src/cli/identity.ts");
      if (liveTestPeer && (!existsSync(identityPath) || !readFileSync(identityPath, "utf8").includes("export const LIVE_TEST_SUPPORTED = true;"))) {
        throw new FinalRefusal("target does not support live-test delegation; choose a supporting target before retrying; runtimes unchanged");
      }
      // Reuse capability proof only after verifying the cached root and digest still identify these exact bytes.
      const cached = op.targetDigest === target.digest && op.targetRoot === target.root;
      // Once every source committed, compatibility cannot be re-applied using mutable project declarations.
      // Package identity/hash and live-test authority above still bind these retained bytes.
      const committed = op.projects?.every(project => ["stopped", "started", "peers-restored", "verified"].includes(project.phase));
      // A legacy coordinator already chose and started this target. Resume its retained evidence without retroactive staging gates.
      if (cached && committed && op.schema !== 3) return { ...target, ...(op.targetFeatures === undefined ? {} : { targetFeatures: [...op.targetFeatures] }) };
      if (cached && op.targetFeatures !== undefined && !op.targetFeatures.includes("schema_guard")) throw new FinalRefusal("target lacks schema_guard; choose a supporting target before recovery effects");
      if (cached && committed && op.targetFeatures !== undefined) {
        return { ...target, targetFeatures: [...op.targetFeatures] };
      }
      if (cached && op.targetFeatures !== undefined) {
        for (const planned of op.plan.projects) {
          const refusal = typeof planned.project?.root === "string" ? instanceRecoveryTargetRefusal(planned.project.root, op.targetFeatures, planned.source.peers) : undefined;
          if (refusal) throw new FinalRefusal(refusal);
        }
        if (!op.targetFeatures.includes("external_adapter_modules") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && (readInstanceConfig(planned.project.root).adapter_modules?.length ?? 0) > 0)) throw new FinalRefusal("target lacks external_adapter_modules; module peers require a supporting target before recovery effects");
        if (!op.targetFeatures.includes("configured_acp") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && Object.keys(readInstanceConfig(planned.project.root).adapters ?? {}).length > 0)) throw new FinalRefusal("target lacks configured_acp; configured adapters require a supporting target before recovery effects");
        if (!op.targetFeatures.includes("peer_instances") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && Object.keys(readInstanceConfig(planned.project.root).instances ?? {}).length > 0)) throw new FinalRefusal("target lacks peer_instances; declared project instances require a supporting target before recovery effects");
        return { ...target, targetFeatures: [...op.targetFeatures] };
      }
      // A prepared commitSent receipt remains uncertain and must still obtain proof before a possible commit.
      // Legacy uncommitted receipts acquire verified feature evidence before source compatibility checks.
      const probe = await run([process.execPath, "-e", `import * as target from ${JSON.stringify(join(target.root, "src/hub/control-client.ts"))}; console.log(JSON.stringify({protocol: target.PROTOCOL, protocolMin: target.PROTOCOL_MIN, features: target.DAEMON_FEATURES ?? []}))`]);
      let metadata: { protocol?: unknown; protocolMin?: unknown; features?: unknown } | undefined;
      try { if (probe.code === 0) metadata = JSON.parse(probe.stdout); } catch { /* Unknown metadata refuses before effects. */ }
      if (!metadata || typeof metadata !== "object" || !Number.isInteger(metadata.protocol)) throw new Error(`the staged target's control protocol could not be read (probe exit ${probe.code}); staged package retained, runtimes unchanged; resume again once it can run`);
      if (!Array.isArray(metadata.features) || !metadata.features.every((feature: unknown) => typeof feature === "string" && feature.length > 0)) throw new Error("the staged target features could not be read; staged package retained, runtimes unchanged");
      const targetFeatures: readonly string[] = [...metadata.features];
      const targetWindow = protocolWindow(metadata.protocol, metadata.protocolMin);
      if (!targetWindow || negotiateProtocol(protocolWindow(PROTOCOL, PROTOCOL_MIN)!, targetWindow) === undefined) throw new FinalRefusal("target protocol requires a compatible coordinator; staged package retained, runtimes unchanged");
      if (!targetFeatures.includes("schema_guard")) throw new FinalRefusal("target lacks schema_guard; choose a supporting target before recovery effects");
      const verified = { ...target, targetFeatures };
      if (cached && committed) return verified;
      for (const planned of op.plan.projects) for (const id of planned.reconnectOnly ?? []) {
        const peer = planned.source.peers.find(peer => peer.id === id);
        const sourceWindow = planned.source.protocolMin === undefined || planned.source.protocolMax === undefined ? undefined : controlProtocolWindow(planned.source);
        const pluginProtocol = peer?.controlProtocol ?? (sourceWindow?.v === sourceWindow?.vMin ? sourceWindow?.v : undefined);
        const pluginWindow = protocolWindow(pluginProtocol);
        if (!pluginWindow || negotiateProtocol(targetWindow, pluginWindow) === undefined) throw new FinalRefusal(`${id}: unmanaged plugin protocol cannot reconnect to the staged target; runtimes unchanged`);
      }
      for (const planned of op.plan.projects) {
        const refusal = typeof planned.project?.root === "string" ? instanceRecoveryTargetRefusal(planned.project.root, targetFeatures, planned.source.peers) : undefined;
        if (refusal) throw new FinalRefusal(refusal);
      }
      if (!targetFeatures.includes("external_adapter_modules") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && (readInstanceConfig(planned.project.root).adapter_modules?.length ?? 0) > 0)) throw new FinalRefusal("target lacks external_adapter_modules; module peers require a supporting target before recovery effects");
      if (!targetFeatures.includes("configured_acp") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && Object.keys(readInstanceConfig(planned.project.root).adapters ?? {}).length > 0)) throw new FinalRefusal("target lacks configured_acp; configured adapters require a supporting target before recovery effects");
      if (!targetFeatures.includes("peer_instances") && op.plan.projects.some(planned => typeof planned.project?.root === "string" && Object.keys(readInstanceConfig(planned.project.root).instances ?? {}).length > 0)) throw new FinalRefusal("target lacks peer_instances; declared project instances require a supporting target before recovery effects");
      // Existing peer/waiver compatibility checks remain properties of the already verified bytes.
      if (op.targetDigest && op.targetDigest === target.digest && op.targetRoot === target.root) return verified;
      for (const adapter of ADAPTERS) {
        const probe = adapter.session.legacyTargetSupport;
        if (!probe || !op.plan.projects.some(p => p.source.peers.some(peer => peer.id === adapter.kind && peer.state !== "offline"))) continue;
        if (!legacyTargetLists(target.root, probe, adapter.kind)) throw new FinalRefusal(probe.refusal);
      }
      // Reconnect-only (#206) and fresh sessions (#215) need a target hub that reads recovery-waivers.json.
      if (op.plan.projects.some((p) => p.reconnectOnly?.length || p.freshStart?.length) && !targetReadsWaivers({ targetRoot: target.root })) {
        throw new FinalRefusal(`target ${op.plan.version} predates recovery waivers, so its hub could never accept a reconnect-only Claude or a fresh Codex start; staged package retained, runtimes unchanged; choose a newer target once this operation is cancelled or ended`);
      }
      return verified;
    },
    prepare: (p, id, instance, features) => control(p, "prepare", id, instance, features),
    abort: (p, id, instance) => control(p, "abort", id, instance),
    commit: (p, id, instance, features) => control(p, "commit", id, instance, features),
    release: async (p, id, instance) => {
      // Snapshot before the request: a later writer must never be retired by this older release completion.
      const previous = readRecoveryContinuity(p.stateDir, { projectId: p.id, projectRoot: p.root });
      await control(p, "release", id, instance);
      if (previous.state === "ready" && previous.bookmark.operationId !== id) {
        try { retireRecoveryContinuity(p.stateDir, { projectId: p.id, projectRoot: p.root, operationId: previous.bookmark.operationId, digest: previous.digest }, "recovery_released"); }
        catch { console.error("Pi continuity retirement is unconfirmed after successful recovery release; inspect the retained bookmark before another automatic start"); }
      }
    },
    closeTerminals: async (planned, progress, op, save) => {
      for (const binding of planned.terminals as TerminalBinding[]) {
        const key = `closed:${binding.peer}`;
        if (progress.terminals[key] === true) continue;
        if (progress.terminals[key] === "pending") {
          const seen = await listed(binding);
          if (seen !== "absent") throw new Error(closeUnsettled(binding, seen)); // the receipt stays pending
          progress.terminals[key] = true; save(); continue;
        }
        // A peer whose TUI already exited left nothing to close: the source reports it
        // detached, and inventory silence is the same proof the pending-reconcile path
        // accepts. No mutation is issued for a terminal that no longer exists (#21).
        const sourceNow = await inspectRecovery(planned.project);
        const attached = sourceNow.peers.find((item) => item.id === binding.peer);
        if (attached?.state === "offline") {
          const seen = await listed(binding);
          if (seen !== "absent") throw new Error(closeUnsettled(binding, seen));
          progress.terminals[key] = true; save(); continue;
        }
        // #215: check resume viability again right before the destructive effect (a planned fresh start has none to lose).
        const transcript = projectDefinition(binding.peer, binding.projectRoot)?.session.missingEvidence === "rollout" ? sessionState(binding) : "found";
        if (transcript === "unknown") throw new Error(`${unresumable(binding)}; no terminal was closed; make that store readable first`);
        if (transcript === "missing" && !planned.freshStart?.includes(binding.peer)) {
          throw new Error(`${unresumable(binding)}; no terminal was closed. To continue without its conversation, end that Codex session and close its Orca terminal ${binding.handle} first, then resume`);
        }
        const idle = await waitForIdle(binding, 600_000, terminalOptions(run));
        if (!idle.satisfied) throw new Error(`${binding.peer}: terminal is not verified idle; source retained; finish or cancel its turn first`);
        const source = await inspectRecovery(planned.project);
        if (source.instanceId !== planned.source.instanceId || source.recovery?.operationId !== op.id || !source.recovery.ready) {
          throw new Error(`source preparation expired or changed while waiting for the terminal; no terminal was closed`);
        }
        // Refresh the same prepared lease immediately before the terminal effect. Preserve
        // the original peer roster and verified target features, including after a resume.
        await control(planned.project, "prepare", op.id, planned.source.instanceId!, op.targetFeatures);
        progress.terminals[key] = "pending"; save();
        await recoveryCurrent();
        const result = await closeTerminal(binding, 0, terminalOptions(run));
        if (result.manualRequired) throw new Error(`${binding.peer}: terminal close not verified; manual-required`);
        progress.terminals[key] = true; save();
      }
    },
    start: async (p, op) => {
      const checkpoint = JSON.parse(readFileSync(join(p.stateDir, "restart.json"), "utf8"));
      if (checkpoint.projectId !== p.id || checkpoint.projectRoot !== p.root || checkpoint.operationId !== op.id) {
        throw new Error("committed restart snapshot is missing or belongs to another operation");
      }
      const reconnect = op.plan.projects.find((planned) => planned.project.id === p.id)?.reconnectOnly ?? [];
      await recoveryCurrent();
      if (reconnect.length) waiveRecoveryPeers(p.stateDir, op.id, Object.fromEntries(reconnect.map((peer) => [peer, "reconnect-only"])));
      await command(op, ["up"], p);
    },
    restore: async (planned, progress, op, group, save, onlyPeer) => {
      const live = await inspectRecovery(planned.project);
      if (live.instanceId !== progress.instanceId) throw new Error("target daemon changed before peer restore");
      if (group === "native" && !onlyPeer) {
        for (const peer of planned.source.peers.filter(p => projectDefinition(p.id, planned.project.root)?.session.restoreArgs && p.state !== "offline" && !(projectDefinition(p.id, planned.project.root)?.session.launchRecord && p.args?.mode === "tui"))) {
          const current = live.peers.find((p) => p.id === peer.id);
          if (current && current.state !== "offline") continue;
          const adapter = projectDefinition(peer.id, planned.project.root)!;
          if (conductorPeer) {
            await rpc(planned.project, { t: "recovery_restore", peer: peer.id, authority: conductorRecoveryBinding(op, planned.project, conductorPeer) }, live.protocol, conductorPeer);
            continue;
          }
          const args = [adapter.cli.command, ...(peer.id !== adapter.kind ? ["--as", peer.id] : [])];
          const refusal = adapter.session.recoveryRefusal?.(peer, "restore");
          if (refusal) throw new Error(refusal);
          const captured = adapter.session.restoreArgs!(peer);
          for (const [key, value] of Object.entries(captured)) args.push(`--${key}`, value);
          const legacy = adapter.session.legacyHeadlessArgv;
          if (legacy && legacyTargetLists(op.targetRoot!, legacy, adapter.kind)) args.push(...legacy.argv);
          await command(op, args, planned.project);
        }
      }
      let claudeGroup = false;
      for (const plannedBinding of planned.terminals as TerminalBinding[]) {
        if ((projectDefinition(plannedBinding.peer, plannedBinding.projectRoot)?.transport === "claude-channel") !== (claudeGroup = group !== "native") || onlyPeer && plannedBinding.peer !== onlyPeer) continue;
        const key = `restored:${plannedBinding.peer}`;
        try {
          // #225: after a restart, the stopped target's terminal for this peer goes first; a session it had accepted
          // instead of the planned one (fresh choice, fresh start, zero-turn Claude) is relaunched by that id, which the
          // operation-fenced waiver already covers.
          await closeRetired(progress, plannedBinding.peer, save);
          const retired = progress.terminals[`retired:${plannedBinding.peer}`] as TerminalBinding | undefined;
          const accepted = retired && typeof retired === "object" && retired.sessionId !== plannedBinding.sessionId ? retired.sessionId : undefined;
          const repair = progress.reattachments?.[plannedBinding.peer];
          const recordedOnly = !!repair || progress.repairedSessions?.[plannedBinding.peer] === true && !progress.fresh?.[plannedBinding.peer]?.repaired;
          const retiredReceipt = recordedOnly && retired !== undefined ? decodeRestoreReceipt({ state: "done", binding: retired }) : undefined;
          const recordedBinding = retiredReceipt?.state === "done" && retiredReceipt.binding.peer === plannedBinding.peer && retiredReceipt.binding.projectRoot === planned.project.root ? retiredReceipt.binding : undefined;
          const original = repair?.binding ?? recordedBinding ?? (accepted ? { ...plannedBinding, sessionId: accepted } : plannedBinding);
          // A new session is accepted only by the operator's choice (#215 dispose --fresh-session) or a planned fresh
          // start of a Codex thread with nothing to lose that still has no rollout; an unreadable store is neither.
          const chosen = !recordedOnly && !!progress.fresh?.[original.peer];
          let read: ReturnType<typeof sessionState> | undefined;
          const transcript = () => projectDefinition(original.peer, original.projectRoot)?.session.missingEvidence !== "rollout" || (chosen && !accepted) ? "found" : (read ??= sessionState(original));
          // An accepted session starts new again only when it has nothing to resume: a Codex thread that never got a
          // rollout, or a Claude session with no transcript (`--resume` could never succeed, #21).
          const fresh = () => recordedOnly ? false : accepted
            ? (projectDefinition(original.peer, original.projectRoot)?.session.missingEvidence === "rollout" ? (chosen || !!planned.freshStart?.includes(original.peer)) && transcript() === "missing" : nativeZeroTurn(planned.project.stateDir, original, "attach"))
            : chosen || (!!planned.freshStart?.includes(original.peer) && transcript() === "missing");
          // The runner ends this with the choices `status` shows (nextActions); resume comes first and launches a failed
          // peer again, which helps once its cause (a transient Orca create failure, a fixed store) is gone.
          // The waiver's audit label: the operator's choice, a Claude with nothing to resume, or the plan's Codex fresh start.
          const waiver = () => progress.fresh?.[original.peer] ? "fresh-session" : projectDefinition(original.peer, original.projectRoot)?.transport === "claude-channel" ? "zero-turn" : "fresh-start";
          const notRestored = (why: string) => new Error(fresh()
            ? `${original.peer}: ${why}; read that terminal in Orca for the launcher's error and fix its cause`
            : `${original.peer}: ${why}; session ${original.sessionId} was not restored; resume launches it again once the cause is fixed`);
          // Anything live or unknown blocks a create and keeps the receipt: never decide on evidence that could not be read.
          const blocked = (evidence: Exclude<Awaited<ReturnType<typeof peerEvidence>>, { state: "gone" }>) => evidence.state === "unknown"
            ? new Error(`${original.peer}: whether a ${original.peer} session or launcher is live cannot be told (${evidence.why}); nothing was recorded or created${evidence.step ? `; ${evidence.step} first` : ""}`)
            : nativeFailure(planned, original.peer, evidence.session ? "session_changed" : "launcher_unverified", evidence.session
              ? `${original.peer}: session ${evidence.session} is attached instead of ${original.sessionId}; no terminal was created; end that ${original.peer} session and close its terminal first`
              : `${original.peer}: its launcher in terminal ${evidence.handle} is running but no ${original.peer} session ${evidence.attached ? "with an id " : ""}attached yet; no terminal was created; wait until it attaches, or end it and close terminal ${evidence.handle} first`,
            evidence.session
              ? { expectedSession: original.sessionId, observedSession: evidence.session }
              : { ...(evidence.handle ? { handle: evidence.handle } : {}), launcherState: evidence.terminal ? "live" : "older-instance" });
          const decide = (receipt: RestoreReceipt, evidence: Awaited<ReturnType<typeof peerEvidence>>) => restoreTransition(receipt, {
            target: "running", launcher: evidence.state === "unknown" ? "unknown" : evidence.state === "gone" ? "gone" : evidence.terminal ? "live" : "older-instance",
            session: evidence.state === "live" && evidence.session ? evidence.session === original.sessionId ? "planned" : "other" : "none",
            allowOther: fresh() || (!recordedOnly && nativeZeroTurn(planned.project.stateDir, original, "attach")),
            binding: evidence.state === "live" && evidence.terminal ? { ...original, ...evidence.terminal } : original,
          });
          const receipt = decodeRestoreReceipt(progress.terminals[key]);
          function awaitBound(waiting: Extract<RestoreReceipt, { state: "waiting" }> & { origin: "pending" }, expected: string | null): Promise<string>;
          function awaitBound(waiting: Extract<RestoreReceipt, { state: "waiting" }>, expected: string | null): Promise<string | undefined>;
          async function awaitBound(waiting: Extract<RestoreReceipt, { state: "waiting" }>, expected: string | null): Promise<string | undefined> {
            try { return await awaitAttachment(planned, progress, op, waiting, save, expected); }
            catch (error) {
              if (!(error instanceof AttachmentLauncherGone)) throw error;
              progress.terminals[key] = error.transition.next; save();
              // The table decides whether this failed wait blocks or is eligible for a new launch.
              if (error.transition.action === "create") return undefined;
              throw notRestored(`its launcher no longer runs and no ${original.peer} session attached`);
            }
          }
          // #215: the pending row of the receipt table, used wherever a pending launch meets an attached session.
          const settle = async (attached: string, recovered?: TerminalBinding) => {
            // #21: a Claude session that never got a first turn has no transcript, so `claude --resume S` can never
            // succeed and accepting its fresh attach loses nothing. Otherwise only the planned id, or a new session
            // the operator or the plan accepted, counts as restored.
            await recoveryCurrent();
            if (attached !== original.sessionId && !fresh() && !(!recordedOnly && nativeZeroTurn(planned.project.stateDir, original, "attach"))) {
              throw new Error(`${original.peer}: terminal creation outcome is uncertain: session ${attached} is attached instead of ${original.sessionId}; end that ${original.peer} session and close its terminal first`);
            }
            // Validate the proposed transition before committing continuity/waiver effects or a done receipt.
            const verified = await revalidateTerminal(planned, progress, attachedBinding(recovered ?? original, attached), !!recovered);
            // The planned session came back after all: a fresh session chosen for it lost nothing. Compared with the plan,
            // never with a session accepted after a restart (#225), whose choice must stay on record.
            if (attached === plannedBinding.sessionId && progress.fresh?.[original.peer]?.lost === plannedBinding.sessionId) {
              delete progress.fresh[original.peer];
              if (!Object.keys(progress.fresh).length) delete progress.fresh;
            }
            // Any other accepted session needs the target to waive the saved id, or release would wait for it forever;
            // a launch writes the waiver first, but this must not rely on that.
            // The planned session needs no waiver: the target's snapshot already expects it.
            await recoveryCurrent();
            if (attached !== original.sessionId && attached !== plannedBinding.sessionId) waiveRecoveryPeers(planned.project.stateDir, op.id, { [original.peer]: waiver() });
            if (repair) repair.state = "attempted"; // a verified spontaneous reattachment also closes this repair allowance
            // The person accepted one loss, not a permanent exemption for later repairs of the replacement.
            if (progress.fresh?.[original.peer]?.repaired) delete progress.fresh[original.peer]!.repaired;
            progress.terminals[key] = { state: "done", binding: verified } satisfies RestoreReceipt; save();
          };
          if (receipt?.state === "done") {
            // A completed restoration is never a waiting launch. A closed terminal blocks exact revalidation;
            // it cannot erase continuity or create a fresh-session choice (PROBE-B).
            await detached(planned, progress, op, receipt.binding, save);
            const observed = await peerEvidence(planned, progress, original.peer);
            const decision = restoreTransition(receipt, { target: "running", launcher: "no-record-yet", session: observed.state === "live" && observed.session === receipt.binding.sessionId ? "planned" : observed.state === "live" && observed.session ? "other" : "none", allowOther: false });
            if (decision.action === "block") {
              const condition = observed.state === "unknown" ? `cannot be verified (${observed.why})`
                : observed.state === "live" && observed.session ? `session ${observed.session} is attached instead of ${receipt.binding.sessionId}`
                : observed.state === "live" ? `is not attached; its launcher in terminal ${observed.handle ?? "unknown"} may still run` : "is not attached";
              throw new Error(`${original.peer}: completed restoration ${condition}; saved done receipt retained; resume its recorded conversation`);
            }
            progress.terminals[key] = { state: "done", binding: await revalidateTerminal(planned, progress, receipt.binding, true) } satisfies RestoreReceipt; save();
            continue;
          }
          if (receipt?.state === "waiting") {
            const binding = receipt.binding;
            const sessionId = await awaitBound(receipt, fresh() && binding.sessionId === original.sessionId ? null : binding.sessionId);
            if (sessionId !== undefined) { await settle(sessionId, binding); continue; }
          }
          if (receipt?.state === "pending" || receipt?.state === "failed") {
            const evidence = await peerEvidence(planned, progress, original.peer);
            const decision = decide(receipt, evidence);
            if (decision.action === "settle" && evidence.state === "live" && evidence.session) { await settle(evidence.session); continue; }
            if (decision.action === "poll" && decision.next.state === "waiting") {
              const waiting = decision.next;
              progress.terminals[key] = waiting; save();
              const session = await awaitBound(waiting, fresh() ? null : original.sessionId);
              if (session !== undefined) { await settle(session, waiting.binding); continue; }
            } else if (decision.action === "fail") {
              progress.terminals[key] = decision.next; save();
              throw notRestored(`its launcher no longer runs and no ${original.peer} session attached`);
            } else if (decision.action === "block") {
              if (evidence.state === "live" && evidence.session) {
                throw new Error(`${original.peer}: terminal creation outcome is uncertain: session ${evidence.session} is attached instead of ${original.sessionId}; end that ${original.peer} session and close its terminal first`);
              }
              if (evidence.state !== "gone") throw blocked(evidence);
              throw new Error(`${original.peer}: restoration evidence is not actionable`);
            }
          }
          // Never create beside a live launch, nor on evidence that could not be read: read now, not at restore start.
          // The planned session already attached is the restoration (the table's row for it), not a reason to block.
          const evidence = await peerEvidence(planned, progress, original.peer);
          if (evidence.state === "live" && evidence.session === original.sessionId) {
            if (repair) await settle(evidence.session!); // equality with the recorded string session id above proves this value
            else { progress.terminals[key] = { state: "done", binding: await revalidateTerminal(planned, progress, original, false) } satisfies RestoreReceipt; save(); }
            continue;
          }
          if (evidence.state !== "gone") throw blocked(evidence);
          if (transcript() === "unknown") throw new Error(`${unresumable(original)}; no terminal was created; make that store readable first`);
          if (transcript() === "missing" && !fresh()) {
            progress.terminals[key] = { state: "failed" } satisfies RestoreReceipt; save();
            if (recordedOnly) throw new MissingRecordedSession({ projectId: planned.project.id, peer: original.peer, sessionId: original.sessionId, kind: projectDefinition(original.peer, original.projectRoot)!.session.missingEvidence!, checkedPath: sessionPath(original) });
            throw notRestored(unresumable(original).slice("codex: ".length));
          }
          if (fresh()) {
            if (!targetReadsWaivers(op)) throw new Error(`${original.peer}: target ${op.plan.version} predates recovery waivers, so it cannot accept a new session`);
            // The restored daemon must accept the new session instead of the recorded one.
            await recoveryCurrent();
            waiveRecoveryPeers(planned.project.stateDir, op.id, { [original.peer]: waiver() });
          }
          if (repair) {
            if (repair.state === "attempted") throw new ReattachmentRequired(planned.project.id, original.peer, `${original.peer}: recorded-session reattachment already attempted; no second terminal will be created`);
            repair.state = "attempted"; save(); // durable before any terminal creation, including an uncertain failure
          }
          const entrypoint = join(op.targetRoot!, "src/cli/main.js");
          const argv = restoredTerminalArgv(entrypoint, planned.project.root, original, fresh());
          const assignments = { ...original.launch.env, AGENTHUB_HOME: hubHome(), AGENTHUB_RECOVERY_OPERATION: op.id };
          const launch = { ...original.launch, packageEntrypoint: entrypoint, argv,
            command: ["env", ...Object.entries(assignments).map(([k, v]) => `${k}=${v}`), ...argv].map(shellQuote).join(" ") };
          const binding = { ...original, launch, launchMetadata: launch };
          progress.terminals[key] = { state: "pending" } satisfies RestoreReceipt; save();
          await recoveryCurrent();
          const restored = await createTerminal(binding, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId }, undefined, fresh());
          const exited = restored.blockers.find((b) => b.code === "launcher-exited");
          if (exited) {
            // #215: the launcher's exit alone is not the peer's state (a target that died or flapped also ends it): only
            // nothing live makes it failed; an attached session is settled as the pending row settles it; anything else
            // stays pending.
            const after = await peerEvidence(planned, progress, original.peer);
            const decision = decide({ state: "pending" }, after);
            if (decision.action === "settle" && after.state === "live" && after.session) { await settle(after.session); continue; }
            if (decision.action === "poll" && decision.next.state === "waiting") {
              progress.terminals[key] = decision.next; save();
              const session = await awaitBound(decision.next, fresh() ? null : original.sessionId);
              if (session !== undefined) { await settle(session, decision.next.binding); continue; }
            }
            if (decision.action === "fail") {
              progress.terminals[key] = decision.next; save();
              throw notRestored(exited.message);
            }
            if (after.state !== "gone") throw blocked(after);
          }
          if (restored.manualRequired || !restored.newBinding) {
            const handle = restored.binding?.handle ?? restored.blockers[0]?.handle;
            throw new Error(`${original.peer}: original session restoration needs manual verification${restored.blockers[0] ? ` (${restored.blockers[0].message})` : ""}; wait until it attaches, or end that launch and close its terminal${handle ? ` ${handle}` : ""} first`);
          }
          // The daemon's id is authoritative: a fresh session is recorded under the id it reports once attached.
          const awaiting = { state: "waiting", origin: "pending", binding: restored.newBinding } satisfies RestoreReceipt;
          progress.terminals[key] = awaiting; save();
          const sessionId = await awaitBound(awaiting, fresh() ? null : restored.newBinding.sessionId);
          await settle(sessionId, awaiting.binding);
        } catch (error) {
          if (error instanceof MissingRecordedSession || isDatabaseBusy(error)) throw error;
          // A failed recorded-only Claude launch may prove that its transcript is gone. No error text is evidence.
          if (claudeGroup && progress.repairedSessions?.[plannedBinding.peer] && !progress.fresh?.[plannedBinding.peer]?.repaired) {
            const chosenReceipt = decodeRestoreReceipt(progress.terminals[key]);
            // A bare pending/failed row can hide an uncertain create. Only a durable exact chosen binding
            // can become the terminal that an explicit fresh choice must close before another create.
            const binding = chosenReceipt?.state === "waiting" ? chosenReceipt.binding : undefined;
            if (binding && sessionState(binding) === "missing" && (await peerEvidence(planned, progress, plannedBinding.peer)).state === "gone") {
              // Retain the exact chosen terminal so an explicit later fresh choice closes it before creating again.
              progress.terminals[`retired:${plannedBinding.peer}`] = binding;
              delete progress.terminals[`closedRetired:${plannedBinding.peer}`];
              const marker = progress.reattachments?.[plannedBinding.peer];
              if (marker) marker.binding = binding;
              progress.terminals[key] = { state: "failed" } satisfies RestoreReceipt; save();
              throw new MissingRecordedSession({ projectId: planned.project.id, peer: plannedBinding.peer, sessionId: binding.sessionId, kind: projectDefinition(plannedBinding.peer, plannedBinding.projectRoot)!.session.missingEvidence!, checkedPath: sessionPath(binding) });
            }
          }
          if (error instanceof ReattachmentRequired || isDatabaseBusy(error)) throw error;
          if (progress.reattachments?.[plannedBinding.peer]) throw new ReattachmentRequired(planned.project.id, plannedBinding.peer,
            error instanceof Error ? error.message : `${plannedBinding.peer}: recorded-session reattachment is unconfirmed`, error instanceof RecoveryPresentationError ? error : undefined);
          throw error;
        }
      }
      if (group !== "native" && !onlyPeer) for (const id of planned.reconnectOnly ?? []) {
        // #206: nothing is launched for an unmanaged session; its plugin reconnects by itself, within a bound.
        const unmanagedWaitMs = readRecoveryWaits(planned.project.root).unmanagedReconnectWaitMs;
        const deadline = now() + unmanagedWaitMs;
        while (!(await inspectRecovery(planned.project)).peers.some((p) => p.id === id && p.state !== "offline")) {
          if (now() >= deadline) throw nativeFailure(planned, id, "attachment_timeout", `${id}: the unmanaged session did not reconnect within ${unmanagedWaitMs / 1000} s; if that Claude session was closed, start Claude in the project again (its plugin reconnects) first`, { timeoutMs: unmanagedWaitMs });
          await sleep(1000);
        }
      }
    },
    installPlugin: async (op) => {
      const configured = new Set<string>();
      for (const planned of op.plan.projects) {
        // Every Claude binding (the builtin and each instance), once per distinct profile, each under its own profile.
        for (const binding of (planned.terminals as TerminalBinding[]).filter((t) => projectDefinition(t.peer, t.projectRoot)?.transport === "claude-channel")) {
          const profile = binding.launch.env.CLAUDE_CONFIG_DIR ?? "default";
          if (configured.has(profile)) continue;
          await command(op, ["setup", "--yes"], planned.project, binding);
          configured.add(profile);
        }
      }
      if (!configured.size) await command(op, ["setup", "--yes"]);
    },
    installGlobal: async (op) => {
      await recoveryCurrent();
      const result = await run([process.execPath, "add", "-g", `@staix/agent-hub@${op.plan.version}`, "--ignore-scripts"], { env: env(op), timeoutMs: 180_000 });
      if (result.code !== 0) throw new Error("global installation failed; project runtimes use the retained staged package");
      const readback = await run(["ahub", "--version"], { env: env(op) });
      if (readback.code !== 0 || readback.stdout.trim() !== op.plan.version) throw new Error("global CLI version was not verified");
    },
    stopAndArchive: async (project, op, instance) => {
      if (instance) {
        // #215: a target an older coordinator started speaks its own protocol, which the lifecycle stop's inspection
        // refuses. Ask it to stop at that protocol, fenced by its instance (the daemon refuses another), then wait as
        // the lifecycle stop does until its manifest and registry claim are gone.
        const protocol = recoveryProtocol(readControl(project.stateDir));
        await rpc(project, { t: "kill", instanceId: instance }, protocol);
        await awaitStopped(project, instance);
      }
      abandonRestartSnapshot(project.stateDir, op.id);
      const planned = op.plan.projects?.find(item => item.project.id === project.id);
      const progress = op.projects?.find(item => item.id === project.id);
      const source = planned?.source.peers.find(peer => definitionOf(peer.id)?.start.autoStart && peer.state !== "offline");
      if (source && progress) {
        // abandonRestartSnapshot is deliberately a no-op for another operation or an unreadable snapshot.
        // A continuity bookmark needs positive archival evidence, including when disposal resumes after a crash.
        const archive = join(project.stateDir, `restart.abandoned.${createHash("sha256").update(op.id).digest("hex")}.json`);
        let archived: unknown;
        try { archived = JSON.parse(readFileSync(archive, "utf8")); } catch { return { continuity: "not-archived" }; }
        if (!archived || typeof archived !== "object" || (archived as { operationId?: unknown }).operationId !== op.id) return { continuity: "not-archived" };
        try {
          const continuity = projectDefinition(source.id, project.root)?.session.continuityBookmark;
          if (!continuity) return;
          const binding = planned ? resolveAcceptedBinding(planned, progress, source.id as TerminalBinding["peer"]) : undefined;
          writeRecoveryContinuity(project.stateDir, { schema: 1, operationId: op.id, projectId: project.id, projectRoot: project.root, at: now(),
            ...continuity(source, binding) });
        } catch { return { continuity: "unavailable" }; } // optional metadata must not wedge stop-and-archive
      }
    },
    refreshManager: async (op) => { if (conductorPeer && op.plan.kind === "restart") return; await refreshManager({ home: hubHome(), cli: join(op.targetRoot!, "src/cli/main.ts") }); },
    verify: async (planned, progress, op, save) => {
      const live = await inspectRecovery(planned.project);
      if (live.instanceId !== progress.instanceId || live.version !== op.plan.version || live.recovery?.operationId !== op.id) throw new Error("target identity verification failed");
      for (const old of planned.source.peers.filter((p) => p.state !== "offline")) {
        const peer = live.peers.find((p) => p.id === old.id);
        if (!peer || !["idle", "busy", "paused"].includes(peer.state)) {
          const receipt = decodeRestoreReceipt(progress.terminals[`restored:${old.id}`]);
          if (receipt?.state === "done") await detached(planned, progress, op, receipt.binding, save);
          throw new Error(`${old.id}: peer reattachment not verified`);
        }
        const accepted = decodeRestoreReceipt(progress.terminals[`restored:${old.id}`]);
        const repair = progress.reattachments?.[old.id as "codex" | "pi" | "claude"];
        const recordedOnly = !!repair || progress.repairedSessions?.[old.id as keyof NonNullable<ProjectProgress["repairedSessions"]>] === true && !progress.fresh?.[old.id]?.repaired;
        const retiredValue = progress.terminals[`retired:${old.id}`];
        const retired = retiredValue === undefined ? undefined : decodeRestoreReceipt({ state: "done", binding: retiredValue });
        // A #225 restart clears the old target's repair fence, never its accepted conversation.
        const retained = retired?.state === "done" && accepted?.state === "done" && retired.binding.peer === old.id && retired.binding.projectRoot === planned.project.root && retired.binding.sessionId === accepted.binding.sessionId;
        if ((recordedOnly || retained) && accepted?.state === "done") {
          const session = observedSession(old.id, peer, planned.project.root);
          if (session !== accepted.binding.sessionId || repair && accepted.binding.sessionId !== repair.binding.sessionId ||
              projectDefinition(old.id, planned.project.root)?.session.launchRecord && projectDefinition(old.id, planned.project.root)?.session.crashIdentity && (recordedOnly || old.sessionFile) && accepted.binding.sessionFile && peer.sessionFile !== accepted.binding.sessionFile) throw nativeFailure(planned, old.id, "session_changed", `${old.id}: reattached a different recorded conversation`, { handle: accepted.binding.handle, expectedSession: accepted.binding.sessionId, ...(session === undefined ? {} : { observedSession: session }) });
          continue;
        }
        if (!recordedOnly && (progress.fresh?.[old.id] || planned.freshStart?.includes(old.id))) continue; // #215: a new session was accepted (recorded)
        if (projectDefinition(old.id, planned.project.root)?.session.idField === "threadId" && peer.threadId !== old.threadId) throw nativeFailure(planned, old.id, "session_changed", "Codex resumed a different conversation", { ...(old.threadId ? { expectedSession: old.threadId } : {}), ...(peer.threadId ? { observedSession: peer.threadId } : {}) });
        if (projectDefinition(old.id, planned.project.root)?.transport === "claude-channel" && peer.sessionId !== old.sessionId) {
          // #64: the restore gate already accepted a fresh session when the original never
          // persisted a transcript. Re-derive persistence from the binding exactly like that
          // gate did, so a first turn landing after the plan was made keeps the check strict.
          const binding = (planned.terminals as TerminalBinding[]).find((t) => t.peer === old.id && projectDefinition(t.peer, t.projectRoot)?.transport === "claude-channel");
          if (recordedOnly || !binding || binding.sessionId !== old.sessionId || !nativeZeroTurn(planned.project.stateDir, binding, "verify")) throw nativeFailure(planned, old.id, "session_changed", "Claude resumed a different conversation", { ...(old.sessionId ? { expectedSession: old.sessionId } : {}), ...(peer.sessionId ? { observedSession: peer.sessionId } : {}) });
        }
        if (projectDefinition(old.id, planned.project.root)?.session.launchRecord && projectDefinition(old.id, planned.project.root)?.session.crashIdentity && (peer.sessionId !== old.sessionId || (old.sessionFile && peer.sessionFile !== old.sessionFile))) throw nativeFailure(planned, old.id, "session_changed", "Pi resumed a different conversation", { ...(old.sessionId ? { expectedSession: old.sessionId } : {}), ...(peer.sessionId ? { observedSession: peer.sessionId } : {}) });
      }
      for (const original of planned.terminals as TerminalBinding[]) {
        const saved = decodeRestoreReceipt(progress.terminals[`restored:${original.peer}`]);
        if (saved?.state !== "done") throw new Error(`${original.peer}: restored terminal outcome is not recorded; manual-required`);
        await revalidateTerminal(planned, progress, saved.binding, true);
      }
      const snapshot = await rpc(planned.project, { t: "ui_snapshot", after: 0 });
      if (snapshot.ok === false) throw new Error("dashboard snapshot readback failed");
      const recovery = await rpc(planned.project, { t: "recovery", op: "inspect", expectedInstanceId: progress.instanceId });
      const integrity = recovery.recovery?.integrity;
      if (integrity?.expected && integrity.current) {
        for (const check of ["queues", "manualPaused", "boardDigest", "budgetDigest"] as const) {
          if (JSON.stringify(integrity.current[check]) !== JSON.stringify(integrity.expected[check])) {
            throw new RecoveryPreservationError(check, planned.project.id);
          }
        }
      }
      if (!integrity?.expected || JSON.stringify(integrity.current) !== JSON.stringify(integrity.expected)) {
        throw new Error("queue, manual pause, task board or budget preservation was not verified");
      }
    },
  };
}
