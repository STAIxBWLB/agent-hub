import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";

export const PLUGIN = "agent-hub@agent-hub";
const MARKETPLACE = "agent-hub";

export interface InstalledPlugin {
  id: string;
  version?: string;
  installPath?: string;
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
    return realpathSync(p);
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

export type PluginState = { state: "missing" } | { state: "current"; version: string } | { state: "stale"; version: string; why: string };

/**
 * Is the installed Claude plugin the one this hub ships? The version is compared, and so is the bundle itself: Claude
 * Code runs a cached copy, and a copy taken from an earlier build of the same version speaks an older wire protocol.
 */
export function pluginState(plugins: InstalledPlugin[], packageRoot: string): PluginState {
  const mine = plugins.find((p) => p.id === PLUGIN);
  if (!mine) return { state: "missing" };
  const version = mine.version ?? "unknown";
  if (version !== VERSION) return { state: "stale", version, why: `version ${version}, this hub is ${VERSION}` };
  const shipped = read(join(packageRoot, "plugins", "agent-hub", "server.js"));
  const cached = mine.installPath ? read(join(mine.installPath, "server.js")) : undefined;
  if (shipped !== undefined && cached !== undefined && shipped !== cached) return { state: "stale", version, why: "same version, but the cached bundle differs from the one this hub ships" };
  return { state: "current", version };
}

export interface SetupStep {
  why: string;
  argv: string[];
}

/**
 * The next thing `ahub setup` has to do, or nothing. One step at a time: the state is read again after every step,
 * because what a step leaves behind is Claude Code's business (removing a marketplace may uninstall its plugins).
 */
export function nextStep(plugins: InstalledPlugin[], marketplaces: Marketplace[], packageRoot: string): SetupStep | undefined {
  const root = real(packageRoot);
  const market = marketplaces.find((m) => m.name === MARKETPLACE);
  if (market && real(market.path ?? "") !== root) return { why: `the ${MARKETPLACE} marketplace points at ${market.path ?? "another source"}, not at this package`, argv: ["claude", "plugin", "marketplace", "remove", MARKETPLACE] };
  if (!market) return { why: "register this package as a Claude Code plugin marketplace", argv: ["claude", "plugin", "marketplace", "add", root] };
  const state = pluginState(plugins, root);
  if (state.state === "missing") return { why: "install the channel plugin", argv: ["claude", "plugin", "install", PLUGIN] };
  // Uninstall rather than update: with an unchanged version number an update has nothing to do.
  if (state.state === "stale") return { why: `replace the installed plugin (${state.why})`, argv: ["claude", "plugin", "uninstall", PLUGIN] };
  return undefined;
}
