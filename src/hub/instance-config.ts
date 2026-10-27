import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectAdapterCatalog, defaultPeerRoles, definitionOf, type ProjectAdapterCatalog, type AdapterDefinition } from "../adapters/registry.ts";
import { readAdapterModuleDeclarations, type AdapterModuleDeclaration } from "../adapters/external-modules.ts";
import { externalMetadataDefinitions, moduleArray, moduleDataObject, moduleText } from "../adapters/external-metadata.ts";
import { readControl, stateDirFor } from "./control-client.ts";
import { conductorPeer } from "./conductor.ts";
import { configRefusal } from "./config-trust.ts";
import { isPermissionMode } from "./permission-mode.ts";
import { validateInstances, type InstancesConfig } from "./instances.ts";

export const INSTANCE_CONFIG_FILES = ["config.json", "config.local.json"] as const;
export interface InstanceConfigLayer { name: typeof INSTANCE_CONFIG_FILES[number]; raw: Record<string, unknown> }

/** One source capture can feed declaration validation and the ordinary config loader. */
export function readInstanceConfigLayers(cwd: string): InstanceConfigLayer[] {
  return INSTANCE_CONFIG_FILES.flatMap(name => {
    try { return [{ name, raw: JSON.parse(readFileSync(join(cwd, ".agenthub", name), "utf8")) as Record<string, unknown> }]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
}

/** Declaration authority is file provenance, never a suffix or a claim made by a native child. */
export interface DeclaredExternalInstance {
  readonly id: string;
  readonly kind: string;
  readonly availability: "declared-unknown" | "refused";
  readonly refusalCode: "catalog-unavailable" | "module-refused";
}
export interface InstanceRoleConfig {
  adapter_modules?: readonly AdapterModuleDeclaration[];
  adapters?: Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>>;
  instances?: InstancesConfig;
  /** Unresolved or refused module declarations, excluded from executable policy. */
  declaredExternalInstances?: readonly DeclaredExternalInstance[];
  catalog: ProjectAdapterCatalog;
  ignored: string[];
}
/** Keep valid dormant policy on disk, but never admit it through an unavailable module's identity. */
export function withoutInertInstancePolicy(raw: Record<string, unknown>, rows: readonly DeclaredExternalInstance[] = []): Record<string, unknown> {
  if (!rows.length) return raw;
  const ids = new Set(rows.flatMap(row => [row.id, row.kind]));
  const result = { ...raw };
  for (const key of ["permission_modes", "peers"] as const) {
    if (raw[key] === undefined) continue;
    const block = moduleDataObject(raw[key]);
    result[key] = Object.fromEntries(Object.entries(block).filter(([id, value]) => {
      if (!ids.has(id)) return true;
      if (key === "permission_modes") {
        if (!isPermissionMode(value)) throw new Error(`permission_modes.${id}: invalid dormant mode`);
      } else {
        const settings = moduleDataObject(value);
        if (Object.keys(settings).some(field => field !== "start_mode") || settings.start_mode !== undefined && settings.start_mode !== "headless") throw new Error(`peers.${id}: invalid dormant headless setting`);
      }
      return false;
    }));
  }
  return result;
}

export function readInstanceConfig(cwd: string, layers: readonly InstanceConfigLayer[] = readInstanceConfigLayers(cwd), externalDefinitions?: readonly AdapterDefinition[]): InstanceRoleConfig {
  const moduleConfig = readAdapterModuleDeclarations(cwd, layers);
  const ignored: string[] = [...moduleConfig.ignored];
  let adapters: Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>> | undefined, rawInstances: unknown;
  for (const { name, raw } of layers) {
    const keys = ["adapters", "instances"].filter(key => raw[key] !== undefined);
    if (!keys.length) continue;
    const refusal = name !== "config.local.json" ? "declarations are machine-local config.local.json values" : configRefusal(cwd, name);
    if (refusal) { ignored.push(`${keys.join(", ")} in .agenthub/${name} ignored: ${refusal}`); continue; }
    if (raw.adapters !== undefined) adapters = raw.adapters as Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>>;
    if (raw.instances !== undefined) rawInstances = raw.instances;
  }
  let external = externalDefinitions;
  if (external === undefined) {
    // Metadata discovery is optional: retained recovery receipts may name a project that no longer exists.
    let metadata;
    try { metadata = readControl(stateDirFor(cwd))?.externalAdapters; } catch { /* no running catalog available */ }
    external = externalMetadataDefinitions(metadata);
  }
  const catalog = createProjectAdapterCatalog(adapters, external);
  // A descriptor on disk is display evidence only. It cannot turn module kinds into executable
  // definitions or establish live policy. Only the daemon's explicit captured definitions can.
  const runtimeDefinitions = new Set(externalDefinitions?.filter(definition => typeof definition.start.create === "function"));
  const declaredExternalInstances: DeclaredExternalInstance[] = [];
  let executableInstances = rawInstances;
  if (moduleConfig.modules.length && rawInstances !== undefined) {
    const entries = moduleDataObject(rawInstances);
    if (Object.keys(entries).length > 64) throw new Error("instances: at most 64 extra instances are supported");
    const executable: Record<string, unknown> = Object.create(null);
    for (const [id, value] of Object.entries(entries)) {
      const row = moduleDataObject(value), kind = row.kind;
      const definition = typeof kind === "string" ? catalog.definitionOf(kind) : undefined;
      const inert = !definition || catalog.externalDefinitions.includes(definition) && !runtimeDefinitions.has(definition);
      if (!inert) { executable[id] = value; continue; }
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(kind)
        || !id.startsWith(`${kind}-`) || !/^[a-z0-9][a-z0-9-]*$/.test(id.slice(kind.length + 1))) throw new Error("instances: invalid unresolved module instance declaration");
      if (Object.keys(row).some(key => !["kind", "roles", "start_mode", "permission_mode", "worktree", "readOnly"].includes(key))) throw new Error("instances: unsupported external instance field");
      if (Object.hasOwn(row, "roles")) {
        const roles = moduleArray(row.roles, 3);
        if (roles.some(role => typeof role !== "string" || !["implementer", "verifier", "reviewer"].includes(role)) || new Set(roles).size !== roles.length) throw new Error("instances: unsupported external instance role");
      }
      if (Object.hasOwn(row, "start_mode") && row.start_mode !== "headless") throw new Error("instances: external instances require headless mode");
      if (Object.hasOwn(row, "readOnly") && typeof row.readOnly !== "boolean") throw new Error("instances: readOnly must be a boolean");
      if (Object.hasOwn(row, "permission_mode") && (typeof row.permission_mode !== "string" || !["ask", "ask-when-needed", "never-ask"].includes(row.permission_mode))) throw new Error("instances: unknown permission mode");
      if (row.readOnly === true && Object.hasOwn(row, "permission_mode")) throw new Error("instances: read-only instances cannot select a permission mode");
      if (Object.hasOwn(row, "worktree")) moduleText(row.worktree, 4096);
      declaredExternalInstances.push(Object.freeze(externalDefinitions === undefined
        ? { id, kind, availability: "declared-unknown", refusalCode: "catalog-unavailable" }
        : { id, kind, availability: "refused", refusalCode: "module-refused" }));
    }
    executableInstances = executable;
  }
  const instances = validateInstances(executableInstances, catalog);
  return { ...(moduleConfig.modules.length ? { adapter_modules: moduleConfig.modules } : {}), ...(adapters !== undefined ? { adapters } : {}), ...(Object.keys(instances).length ? { instances } : {}), ...(declaredExternalInstances.length ? { declaredExternalInstances: Object.freeze(declaredExternalInstances) } : {}), catalog, ignored };
}

/** Capture ordinary role policy and trusted instance declarations together, without loading daemon configuration. */
export function readInstanceRoleConfig(cwd: string, layers: readonly InstanceConfigLayer[] = readInstanceConfigLayers(cwd)): InstanceRoleConfig & { roles: Record<string, string[]> } {
  const declarationConfig = readInstanceConfig(cwd, layers);
  const roles = defaultPeerRoles(false);
  for (const definition of declarationConfig.catalog.definitions) if (!definitionOf(definition.kind)) roles[definition.kind] = [...definition.roles];
  for (const name of INSTANCE_CONFIG_FILES) {
    const raw = layers.find(layer => layer.name === name)?.raw;
    if (raw?.roles !== undefined) {
      conductorPeer(raw.roles); // Preserve the ordinary loader's ids, role-list and conductor validation exactly.
      for (const [id, list] of Object.entries(raw.roles as Record<string, string[]>)) roles[id] = [...list];
    }
  }
  // Unresolved rows and display-only module definitions grant no roles through id or kind aliases.
  for (const row of declarationConfig.declaredExternalInstances ?? []) { delete roles[row.id]; delete roles[row.kind]; }
  for (const definition of declarationConfig.catalog.externalDefinitions) delete roles[definition.kind];
  conductorPeer(roles);
  return { ...declarationConfig, roles };
}
