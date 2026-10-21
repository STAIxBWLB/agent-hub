import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectAdapterCatalog, defaultPeerRoles, definitionOf, type ProjectAdapterCatalog } from "../adapters/registry.ts";
import { conductorPeer } from "./conductor.ts";
import { configRefusal } from "./config-trust.ts";
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
export interface InstanceRoleConfig {
  adapters?: Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>>;
  instances?: InstancesConfig;
  catalog: ProjectAdapterCatalog;
  ignored: string[];
}
export function readInstanceConfig(cwd: string, layers: readonly InstanceConfigLayer[] = readInstanceConfigLayers(cwd)): InstanceRoleConfig {
  const ignored: string[] = [];
  let adapters: Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>> | undefined, rawInstances: unknown;
  for (const { name, raw } of layers) {
    const keys = ["adapters", "instances"].filter(key => raw[key] !== undefined);
    if (!keys.length) continue;
    const refusal = name !== "config.local.json" ? "declarations are machine-local config.local.json values" : configRefusal(cwd, name);
    if (refusal) { ignored.push(`${keys.join(", ")} in .agenthub/${name} ignored: ${refusal}`); continue; }
    if (raw.adapters !== undefined) adapters = raw.adapters as Readonly<Record<string, import("../adapters/configured-acp.ts").ConfiguredAcpAdapterConfig>>;
    if (raw.instances !== undefined) rawInstances = raw.instances;
  }
  const catalog = createProjectAdapterCatalog(adapters);
  const instances = validateInstances(rawInstances, catalog);
  return { ...(adapters !== undefined ? { adapters } : {}), ...(Object.keys(instances).length ? { instances } : {}), catalog, ignored };
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
  conductorPeer(roles);
  return { ...declarationConfig, roles };
}
