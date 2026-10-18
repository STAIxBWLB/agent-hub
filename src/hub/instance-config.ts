import { readFileSync } from "node:fs";
import { join } from "node:path";
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
export function readInstanceConfig(cwd: string, layers: readonly InstanceConfigLayer[] = readInstanceConfigLayers(cwd)): { instances?: InstancesConfig; ignored: string[] } {
  const ignored: string[] = [];
  let instances: InstancesConfig | undefined;
  for (const { name, raw } of layers) {
    const checked = validateInstances(raw.instances);
    if (!Object.keys(checked).length) continue;
    if (name !== "config.local.json") { ignored.push(`instances in .agenthub/${name} ignored: instances are machine-local config.local.json declarations`); continue; }
    const refusal = configRefusal(cwd, name);
    if (refusal) ignored.push(`instances in .agenthub/${name} ignored: ${refusal}`);
    else instances = checked;
  }
  return { ...(instances ? { instances } : {}), ignored };
}
