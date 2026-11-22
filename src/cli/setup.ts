/** Compatibility exports; native plugin policy belongs to its adapter definition leaf. */
export { PLUGIN, CLAUDE_PLUGIN_INVENTORY, parseList, pluginState, nextStep, type InstalledPlugin, type Marketplace, type PluginState, type SetupStep } from "../adapters/definitions/native-cli-claude-setup.ts";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN, type InstalledPlugin } from "../adapters/definitions/native-cli-claude-setup.ts";

export function hubSkillsPresent(plugins: InstalledPlugin[]): boolean {
  const installed = plugins.find(plugin => plugin.id === PLUGIN && plugin.scope === "user");
  return !!installed?.installPath && ["ahub-status", "ahub-manage", "ahub-use", "ahub"].every(name =>
    existsSync(join(installed.installPath!, "skills", name, "SKILL.md")));
}
