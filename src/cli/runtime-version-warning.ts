import type { DoctorCheck } from "./output.ts";

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
