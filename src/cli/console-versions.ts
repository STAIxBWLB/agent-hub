import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { join } from "node:path";
import { DOCTOR_PLUGIN_PROBE } from "../adapters/registry.ts";
import { childEnv } from "../hub/child-process.ts";
import { withoutOrcaEnv } from "../hub/orca-env.ts";
import { displayVersion } from "../version.ts";
import { globalCliRoot } from "./install-paths.ts";
import { runtimeVersionWarnings } from "./runtime-version-warning.ts";
import { parseList, pluginState, type InstalledPlugin } from "./setup.ts";

/** #1385: the agent-hub versions the console shows. Every value is display only; a missing one is unknown, never matching. */
export interface ConsoleVersions {
  daemon?: string;
  cli: string;
  global?: string;
  plugin?: string;
  /** The ones older than the running daemon, by the comparison `ahub doctor` prints (`runtimeVersionWarnings`), plus a global install older than it. */
  older: ("cli" | "global" | "plugin")[];
}

// Contract: a package.json is a few KiB; a larger file is not an agent-hub manifest.
const MANIFEST_BYTES = 64 * 1024;
// Contract: the same bound `ahub doctor` and `ahub upgrade` give the plugin listing.
const PLUGIN_PROBE_MS = 10_000;
// Contract: a Claude plugin listing is a few KiB; more is not one.
const PLUGIN_PROBE_BYTES = 256 * 1024;

/** The version in the `package.json` of the `ahub` on PATH, read without running it. Unknown when no `ahub` resolves to a package root or its manifest is unreadable. */
export function globalCliVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = globalCliRoot(env);
  if (!root) return;
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(fd).size;
    if (size > MANIFEST_BYTES) return;
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    const manifest = JSON.parse(buffer.toString("utf8")) as { name?: unknown; version?: unknown };
    return manifest.name === "@staix/agent-hub" ? displayVersion(manifest.version) : undefined;
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The installed Claude plugin's version from the `claude plugin list --json` listing `ahub doctor` reads, once, bounded. A missing `claude`, a failure or an unreadable list is unknown. */
export async function installedPluginVersion(packageRoot: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn([DOCTOR_PLUGIN_PROBE.command, ...DOCTOR_PLUGIN_PROBE.argv], { env: withoutOrcaEnv(childEnv()), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), PLUGIN_PROBE_MS);
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > PLUGIN_PROBE_BYTES) { child.kill(); await reader.cancel(); return; }
        chunks.push(value);
      }
      if (await child.exited !== 0) return;
      const state = pluginState(parseList<InstalledPlugin>(Buffer.concat(chunks).toString("utf8")), packageRoot);
      return state.state === "missing" ? undefined : displayVersion(state.version);
    } finally { clearTimeout(timer); }
  } catch { return; }
}

/** Both readings for `ahub console`, started once at launch so no draw waits on them. */
export async function installedVersions(packageRoot: string): Promise<{ global?: string; plugin?: string }> {
  const global = globalCliVersion(), plugin = await installedPluginVersion(packageRoot);
  return { ...(global ? { global } : {}), ...(plugin ? { plugin } : {}) };
}

export function consoleVersions(daemon: unknown, cli: string, global: string | undefined, plugin: string | undefined): ConsoleVersions {
  const running = displayVersion(daemon);
  const older: ConsoleVersions["older"] = [];
  if (running) {
    const warned = new Set(runtimeVersionWarnings(running, cli, plugin).filter(row => row.level === "warn").map(row => row.name));
    if (warned.has("CLI versus daemon")) older.push("cli");
    try { if (global && Bun.semver.order(global, running) < 0) older.push("global"); } catch { /* not comparable: shown, never flagged */ }
    if (warned.has("plugin versus daemon")) older.push("plugin");
  }
  return { ...(running ? { daemon: running } : {}), cli, ...(global ? { global } : {}), ...(plugin ? { plugin } : {}), older };
}

/** What a peer's AHUB cell and detail say, from its status `ahub`/`ahubTools`; `differs` when any loaded version is not the daemon's. Older hubs send neither: `-`. */
export function peerHubVersion(row: { ahub?: { runs?: unknown; version?: unknown }; ahubTools?: unknown }, daemon: string | undefined): { cell: string; differs: boolean; detail?: string } {
  const runs = row.ahub?.runs, own = displayVersion(row.ahub?.version);
  const tools = Array.isArray(row.ahubTools) ? row.ahubTools.filter((v): v is string => typeof v === "string" && (v === "unreported" || !!displayVersion(v))) : [];
  const parts = [runs === "daemon" ? "daemon" : runs === "client" ? own ?? "unreported" : undefined, ...(tools.length ? [`tools ${tools.join(",")}`] : [])].filter((p): p is string => !!p);
  if (!parts.length) return { cell: "-", differs: false };
  const loaded = [...(runs === "client" ? [own ?? "unreported"] : []), ...tools];
  const differs = !!daemon && loaded.some(v => v !== daemon);
  const detail = `${runs === "daemon" ? `runs inside the daemon (${daemon ?? "unknown"})` : runs === "client" ? `client ${own ?? "unreported"}` : "no client attached"}${tools.length ? `; tools connections ${tools.join(", ")}` : ""}`
    + (differs ? `; differs from the daemon ${daemon}: update the global CLI and run ahub setup, then restart that agent's session to load it` : "");
  return { cell: parts.join(" "), differs, detail };
}
