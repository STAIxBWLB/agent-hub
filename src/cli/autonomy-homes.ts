import { readControl } from "../hub/control-client.ts";
import { readInstanceRoleConfig } from "../hub/instance-config.ts";
import type { Registry } from "../hub/registry.ts";
import { checkClaudeHome, discoverClaudeHomes, type ClaudeHomeProject, type ClaudeHomeProbe } from "./claude-homes.ts";
import { checkClaudeProfileHook } from "./claude-profile-hook.ts";

export async function usedClaudeHomes(registry: Registry, home: string, env: NodeJS.ProcessEnv) {
  const projects: ClaudeHomeProject[] = [], notices: string[] = [];
  const registered = registry.list();
  if (registered.length > 256) notices.push("Claude profile discovery is limited to the first 256 registered projects.");
  for (const project of registered.slice(0, 256)) {
    const control = readControl(project.stateDir);
    if (!control?.instanceId) continue;
    try {
      const scope = readInstanceRoleConfig(project.root);
      const ids = [...new Set([...scope.catalog.definitions.map(definition => definition.kind), ...Object.keys(scope.instances ?? {})])];
      const claudePeers = ids.filter(id => scope.catalog.definitionOf(id, scope.instances)?.transport === "claude-channel");
      projects.push({ root: project.root, stateDir: project.stateDir, instanceId: control.instanceId, claudePeers });
    } catch { notices.push(`Claude profile evidence is unavailable for project ${project.id}.`); }
  }
  const found = await discoverClaudeHomes({ home, env, projects });
  return { ...found, complete: found.complete && !notices.length, notices: [...notices, ...found.notices] };
}
export async function autonomyHomeStatus(registry: Registry, home: string, env: NodeJS.ProcessEnv, packageRoot: string, probe: ClaudeHomeProbe) {
  const found = await usedClaudeHomes(registry, home, env);
  // Doctor also inspects the existing default home; setup's selected write inventory stays unchanged.
  const defaults = await discoverClaudeHomes({ home, env: { ...env, CLAUDE_CONFIG_DIR: undefined } });
  // Discovery canonicalizes existing homes through realPath, so lexical aliases share one inspection.
  const inspected = new Map(found.homes.map(selected => [selected.path, selected]));
  for (const selected of defaults.homes.filter(selected => selected.exists)) {
    const previous = inspected.get(selected.path);
    inspected.set(selected.path, previous ? { ...previous, sources: [...new Set([...previous.sources, ...selected.sources])] } : selected);
  }
  const notices = [...new Set([...found.notices, ...defaults.notices])], deadline = performance.now() + 6000;
  const homes = [];
  for (const selected of inspected.values()) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) homes.push({ home: selected, plugin: { state: "unknown", reason: "The machine profile inventory time bound was reached." }, hook: checkClaudeProfileHook(selected) });
    else homes.push(await checkClaudeHome(selected, packageRoot, env, probe, Math.min(remaining, 6000)));
  }
  return { homes, notices, complete: found.complete && defaults.complete && performance.now() <= deadline };
}
