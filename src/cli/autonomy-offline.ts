import { lstatSync } from "node:fs";
import { join } from "node:path";
import { planAutonomy, autonomyRemovalKeys, autonomyStatus, autonomyPreset, type AutonomyOperation, type AutonomyPeer, type AutonomyFloorStatus } from "../hub/autonomy.ts";
import { configFingerprint, configSourceTexts } from "../hub/config-reload.ts";
import { configRefusal } from "../hub/config-trust.ts";
import { loadConfig } from "../hub/daemon.ts";
import { validateEffectiveConfig } from "../hub/config-apply.ts";
import { readInstanceConfigLayers, readInstanceRoleConfig } from "../hub/instance-config.ts";
import { checkSettingValue, settingDef, settingText, writeAutonomyPreset } from "../hub/settings.ts";
import type { Project } from "../hub/registry.ts";

export interface OfflineAutonomyPlan { fingerprint: string; operations: AutonomyOperation[]; lines: string[] }
type Target = Pick<Project, "root" | "stateDir">;
function scopeOf(root: string) {
  const directory = lstatSync(join(root, ".agenthub"), { throwIfNoEntry: false });
  if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) throw new Error("project configuration directory is unsafe; autonomy was not changed");
  const local = lstatSync(join(root, ".agenthub/config.local.json"), { throwIfNoEntry: false });
  if (local && (!local.isFile() || local.isSymbolicLink() || local.nlink !== 1 || local.uid !== process.getuid?.() || (local.mode & 0o022) !== 0)) throw new Error("project config.local.json is unsafe; autonomy was not changed");
  const refusal = configRefusal(root, "config.local.json");
  if (refusal) throw new Error(refusal);
  const scope = readInstanceRoleConfig(root);
  // Runtime module policy is captured only by the daemon, never imported by a file writer.
  if (scope.adapter_modules?.length) throw new Error("this project uses adapter modules; start its hub before applying autonomy");
  const config = loadConfig(root);
  validateEffectiveConfig(config, scope.catalog);
  const ids = [...new Set([...scope.catalog.definitions.map(definition => definition.kind), ...Object.keys(scope.instances ?? {})])]
    .filter(id => scope.catalog.isSupportedPeer(id, scope.instances));
  const peers: AutonomyPeer[] = ids.map(id => {
    const definition = scope.catalog.definitionOf(id, scope.instances)!;
    return { id, kind: definition.kind, unmanaged: !!definition.permission.unmanaged, ...(scope.instances?.[id]?.start_mode ? { form: scope.instances[id]!.start_mode } : {}) };
  });
  return { scope, peers };
}
/** Read-only preview. The caller must hold the stopped project's registry claim while applying it. */
export function planOfflineAutonomy(project: Target, environment: string, enabled: boolean): OfflineAutonomyPlan {
  const { scope, peers } = scopeOf(project.root);
  const operations = enabled ? planAutonomy(environment, key => {
    const def = settingDef(key, scope.instances, scope.catalog);
    return typeof def === "string" || def.store !== "config" ? undefined : { store: def.store, values: def.values, locked: def.locked };
  }, peers) : autonomyRemovalKeys(peers).map(key => ({ key, value: null, store: "config" as const }));
  for (const operation of operations) if (enabled) {
    const def = settingDef(operation.key, scope.instances, scope.catalog);
    if (typeof def === "string") throw new Error(def);
    checkSettingValue(def, operation.value);
  }
  return { fingerprint: configFingerprint(configSourceTexts(project.root)), operations,
    lines: operations.map(operation => `${operation.key}: ${enabled ? settingText(operation.value) : "inherit"} (next hub/peer start)`) };
}
/** No consent or witnesses are created here. A trusted machine opt-in is checked independently by the next daemon. */
export function applyOfflineAutonomy(project: Target, environment: string, enabled: boolean, preview: OfflineAutonomyPlan): string[] {
  const current = planOfflineAutonomy(project, environment, enabled);
  if (preview.fingerprint !== current.fingerprint || JSON.stringify(preview.operations) !== JSON.stringify(current.operations)) throw new Error("project autonomy preview changed; nothing was written");
  const { scope } = scopeOf(project.root);
  const result = writeAutonomyPreset(project.root, project.stateDir, enabled, current.operations, scratch => {
    // Keep original project path/trust semantics while validating the candidate bytes.
    const candidate = loadConfig(project.root, readInstanceConfigLayers(scratch));
    validateEffectiveConfig(candidate, scope.catalog);
  });
  return [`Project autonomy ${enabled ? "on" : "off"}: ${result.changed ? "saved" : "unchanged"}; applies at the next hub/peer start.`,
    "Permission confirmation is checked against the trusted machine default when the hub starts."];
}

/** Stopped-hub status reports preset intent, never a claimed effective native mode or consent. */
export function offlineAutonomyStatus(project: Target, environment: string): Record<string, unknown> {
  try {
    const { peers } = scopeOf(project.root);
    const floorEnforcement = Object.fromEntries(peers.map(peer => [peer.id, Object.fromEntries(autonomyPreset().floorClasses.map(action => [action,
      { class: action, status: "not-enforced", reason: "The hub is stopped; runtime floor enforcement is unverified." } satisfies AutonomyFloorStatus]))]));
    const rows = autonomyStatus({ environment, peers, floorEnforcement });
    return { ok: true, status: { environment, runtime: "stopped", consentState: "unknown", consentedPeers: [], peers: rows },
      lines: ["The hub is stopped; effective runtime modes and retained consent are unknown.", ...rows.map(row => `${row.id}: ${row.effectiveMode}; preset ${row.nextMode ?? "unmanaged"} at ${row.applies}`)] };
  } catch {
    return { ok: true, status: { environment, runtime: "stopped", consentState: "unknown", consentedPeers: [], peers: [], missing: ["Project configuration could not be safely inspected."] }, lines: ["The hub is stopped and its project configuration could not be safely inspected; runtime modes and consent are unknown."] };
  }
}
