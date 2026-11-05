import type { DoctorCheck } from "./output.ts";
import { parseList, pluginState, type InstalledPlugin } from "./setup.ts";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const version = (value: unknown): string | undefined => typeof value === "string" && value.length <= 64 && VERSION.exec(value)?.[0] === value ? value : undefined;

/** Authenticated daemon status and the existing plugin inventory only. Suggestions never run an update. */
export function runtimeVersionWarnings(daemonVersion: unknown, cliVersion: unknown, pluginVersion: unknown): DoctorCheck[] {
  const running = version(daemonVersion), cli = version(cliVersion), plugin = version(pluginVersion);
  const rows: DoctorCheck[] = [];
  const unknown = (name: string, detail: string) => rows.push({ section: "Hub", level: "unknown", name, detail });
  if (!running) {
    unknown("runtime version comparison", "authenticated daemon version unavailable; CLI and plugin age are unknown");
    return rows;
  }
  let cliOlder = false;
  if (!cli) unknown("CLI versus daemon", "this CLI version is unavailable; its age relative to the daemon is unknown");
  else try {
    cliOlder = Bun.semver.order(cli, running) < 0;
    if (cliOlder) rows.push({ section: "Hub", level: "warn", name: "CLI versus daemon",
      detail: `running daemon ${running} is newer than this CLI ${cli}; update separately: bun add --global @staix/agent-hub@${running}` });
  } catch { unknown("CLI versus daemon", "CLI and daemon versions could not be compared"); }
  if (!plugin) unknown("plugin versus daemon", "installed plugin version unavailable; run ahub setup with an updated CLI to inspect it");
  else try {
    if (Bun.semver.order(plugin, running) < 0) rows.push({ section: "Hub", level: "warn", name: "plugin versus daemon",
      detail: `running daemon ${running} is newer than installed plugin ${plugin}; run ahub setup${cliOlder ? " after the CLI update" : " with a CLI at least as new as the daemon"}` });
  } catch { unknown("plugin versus daemon", "plugin and daemon versions could not be compared"); }
  return rows;
}

/**
 * #718 (#1179): the lines `ahub upgrade` ends with when the global CLI or the shared Claude plugin is older than the daemon it upgraded, or none. `ahub upgrade` upgrades one project's daemon
 * only, so the person must update the CLI and the plugin themselves; without these lines a stale CLI later fails with a message that does not say why.
 *
 * It reuses `runtimeVersionWarnings`, the comparison `ahub doctor` prints, so the two never disagree about what is older. The one difference is a handover: when an older CLI hands the upgrade to the
 * target release's own coordinator (`AGENTHUB_UPGRADE_HANDOVER=1`, set by every release since #272), the process that prints is the target itself and cannot see the CLI that started it, but that
 * CLI is older by construction (it handed over because the target was newer), so `handedOver` stands for it. An unknown plugin (no `claude`, unreadable inventory) is never a claim.
 */
export function globalUpdateAfterUpgrade(target: unknown, cli: unknown, plugin: unknown, handedOver = false): string[] {
  const running = version(target);
  if (!running) return [];
  const warned = new Set(runtimeVersionWarnings(running, handedOver ? undefined : cli, plugin).filter(row => row.level === "warn").map(row => row.name));
  const cliOlder = handedOver || warned.has("CLI versus daemon"), pluginOlder = warned.has("plugin versus daemon");
  if (!cliOlder && !pluginOlder) return [];
  return [
    "ahub upgrade does not update the global CLI or the shared Claude plugin.",
    cliOlder
      ? `${handedOver ? "The CLI that started this upgrade is older than the daemon this upgrade installs" : "The global CLI is older than the daemon this upgrade installs"} (${running}): run \`bun add -g @staix/agent-hub@${running}\` and then \`ahub setup\` yourself.`
      : `The installed plugin is older than the daemon this upgrade installs (${running}): run \`ahub setup\` yourself.`,
  ];
}

export interface GlobalUpdateInputs {
  /** The daemon this upgrade installs. */
  target: string;
  /** This process's own version. */
  cli: string;
  /** True when an older CLI handed the upgrade to this release's coordinator (`AGENTHUB_UPGRADE_HANDOVER=1`). */
  handedOver: boolean;
  /** Where this release's shipped plugin bundle lives, for `pluginState`. */
  packageRoot: string;
  /** The same `claude plugin list --json` probe `ahub doctor` runs. */
  probe: () => { status: number | null; stdout?: string | null };
}

/**
 * #718: `globalUpdateAfterUpgrade` with the plugin version read from the probe. Advice only: a missing `claude`, a probe that throws or times out, a non-zero exit or an unparsable list reads as an
 * unknown plugin, which is never a claim, and nothing here can fail an upgrade.
 */
export function globalUpdateAdvice(input: GlobalUpdateInputs): string[] {
  let plugin: string | undefined;
  try {
    const probed = input.probe();
    const state = pluginState(parseList<InstalledPlugin>(probed.status === 0 ? probed.stdout ?? "" : ""), input.packageRoot);
    plugin = state.state === "missing" ? undefined : state.version;
  } catch { /* an unknown plugin: the CLI half below does not depend on it */ }
  try { return globalUpdateAfterUpgrade(input.target, input.cli, plugin, input.handedOver); } catch { return []; }
}
