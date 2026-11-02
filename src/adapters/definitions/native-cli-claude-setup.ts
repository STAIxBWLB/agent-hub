import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "../../hub/project.ts";
import { VERSION } from "../../version.ts";

export const PLUGIN = "agent-hub@agent-hub";
export const CLAUDE_PLUGIN_INVENTORY = Object.freeze({
  plugins: Object.freeze(["claude", "plugin", "list", "--json"]),
  marketplaces: Object.freeze(["claude", "plugin", "marketplace", "list", "--json"]),
});
const MARKETPLACE = "agent-hub";

export interface InstalledPlugin {
  id: string;
  version?: string;
  installPath?: string;
  scope?: string;
  projectPath?: string;
}
export interface Marketplace {
  name: string;
  path?: string;
}

/** `claude plugin list --json` / `claude plugin marketplace list --json`. Anything that does not parse is an empty list. */
export function parseList<T>(json: string): T[] {
  try {
    const d = JSON.parse(json);
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

const real = (p: string) => {
  try {
    return realPath(p);
  } catch {
    return p;
  }
};
const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

export type PluginState =
  | { state: "missing"; notices?: string[] }
  | { state: "current"; version: string; notices?: string[] }
  | { state: "stale"; version: string; why: string; notices?: string[] };

const safeDisplayValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

function nonUserPluginNotices(plugins: InstalledPlugin[]): string[] {
  return plugins.filter(plugin => plugin.id === PLUGIN && plugin.scope !== "user").map(plugin => {
    const scope = plugin.scope === "project" || plugin.scope === "local" ? plugin.scope : "unknown-scope";
    const path = safeDisplayValue(plugin.projectPath) ?? safeDisplayValue(plugin.installPath);
    const version = safeDisplayValue(plugin.version) ?? "unknown";
    return `${scope} plugin row preserved${path ? ` at ${path}` : ""} (version ${version}); setup never removes non-user scopes`;
  });
}

/**
 * Is the installed Claude plugin the one this hub ships? The version is compared, and so is the bundle itself: Claude
 * Code runs a cached copy, and a copy taken from an earlier build of the same version speaks an older wire protocol.
 */
export function pluginState(plugins: InstalledPlugin[], packageRoot: string): PluginState {
  const notices = nonUserPluginNotices(plugins);
  const mine = plugins.find((p) => p.id === PLUGIN && p.scope === "user");
  if (!mine) return { state: "missing", ...(notices.length ? { notices } : {}) };
  const version = mine.version ?? "unknown";
  if (version !== VERSION) return { state: "stale", version, why: `version ${version}, this hub is ${VERSION}`, ...(notices.length ? { notices } : {}) };
  const shipped = read(join(packageRoot, "plugins", "agent-hub", "server.js"));
  const cached = mine.installPath ? read(join(mine.installPath, "server.js")) : undefined;
  if (shipped !== undefined && cached !== undefined && shipped !== cached) return { state: "stale", version, why: "same version, but the cached bundle differs from the one this hub ships", ...(notices.length ? { notices } : {}) };
  return { state: "current", version, ...(notices.length ? { notices } : {}) };
}

export interface SetupStep {
  why: string;
  argv: string[];
  blocked?: true;
}

/**
 * The next thing `ahub setup` has to do, or nothing. One step at a time: the state is read again after every step,
 * because what a step leaves behind is Claude Code's business (removing a marketplace may uninstall its plugins).
 */
export function nextStep(plugins: InstalledPlugin[], marketplaces: Marketplace[], packageRoot: string): SetupStep | undefined {
  const root = real(packageRoot);
  const market = marketplaces.find((m) => m.name === MARKETPLACE);
  if (market && real(market.path ?? "") !== root) {
    if (plugins.some(plugin => plugin.id === PLUGIN && plugin.scope !== "user")) return { why: `the ${MARKETPLACE} marketplace points at another source; removing it may remove non-user plugin rows`, argv: [], blocked: true };
    return { why: `the ${MARKETPLACE} marketplace points at ${market.path ?? "another source"}, not at this package`, argv: ["claude", "plugin", "marketplace", "remove", MARKETPLACE] };
  }
  if (!market) return { why: "register this package as a Claude Code plugin marketplace", argv: ["claude", "plugin", "marketplace", "add", root] };
  const state = pluginState(plugins, root);
  if (state.state === "missing") return { why: "install the user-scope channel plugin", argv: ["claude", "plugin", "install", PLUGIN, "--scope", "user"] };
  // Uninstall rather than update: with an unchanged version number an update has nothing to do.
  if (state.state === "stale") return { why: `replace the installed user-scope plugin (${state.why})`, argv: ["claude", "plugin", "uninstall", PLUGIN, "--scope", "user"] };
  return undefined;
}
