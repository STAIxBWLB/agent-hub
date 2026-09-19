import { VERSION } from "../version.ts";

export const PLUGIN = "agent-hub@agent-hub";

/** Version of the installed Claude plugin, from `claude plugin list` output; undefined when it is not installed. */
export function pluginVersion(listOutput: string): string | undefined {
  const at = listOutput.indexOf(PLUGIN);
  if (at === -1) return undefined;
  return /Version:\s*(\S+)/.exec(listOutput.slice(at, at + 300))?.[1] ?? "unknown";
}

export interface SetupStep {
  why: string;
  argv: string[];
}

/** What `ahub setup` would run. Pure, so the plan can be shown before anything happens and tested without Claude Code. */
export function setupPlan(listOutput: string, marketplaces: string, packageRoot: string): SetupStep[] {
  const steps: SetupStep[] = [];
  const installed = pluginVersion(listOutput);
  // The marketplace is this package's own directory: the plugin that gets installed always matches the hub that runs.
  if (!marketplaces.includes(packageRoot)) {
    if (/\bagent-hub\b/.test(marketplaces)) steps.push({ why: "the agent-hub marketplace points somewhere else", argv: ["claude", "plugin", "marketplace", "remove", "agent-hub"] });
    steps.push({ why: "register this package as a Claude Code plugin marketplace", argv: ["claude", "plugin", "marketplace", "add", packageRoot] });
  }
  if (!installed) steps.push({ why: "install the channel plugin", argv: ["claude", "plugin", "install", PLUGIN] });
  else if (installed !== VERSION) steps.push({ why: `update the channel plugin (${installed} -> ${VERSION})`, argv: ["claude", "plugin", "update", PLUGIN] });
  return steps;
}
