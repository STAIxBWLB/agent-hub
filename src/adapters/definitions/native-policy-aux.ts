import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Addon, AddonName } from "../../hub/tooling.ts";

/** Native crash recovery keeps each adapter's exact restart and guidance contract. */
interface NativeCrashPlan { resume?: Record<string, string>; how: string; fresh?: Record<string, string>; tui?: true }
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

export function claudeCrashPlan(_meta: Record<string, unknown>): NativeCrashPlan {
  return { how: "claude: the Claude Code plugin reconnects by itself while that session is still open" };
}

export function codexCrashPlan(meta: Record<string, unknown>): NativeCrashPlan {
  return { how: `codex: its app-server died with the hub; run ahub codex again${str(meta.threadId) ? ` (its conversation was thread ${meta.threadId})` : ""}` };
}

export function jcodeCrashPlan(_meta: Record<string, unknown>): NativeCrashPlan {
  return { how: "jcode: native 0.94.0 load does not prove the restored id; reopen the original conversation with its native client, no automatic fresh replacement" };
}

export function kimiCrashPlan(meta: Record<string, unknown>): NativeCrashPlan {
  const launch = (meta.launch && typeof meta.launch === "object" ? meta.launch : {}) as Record<string, unknown>;
  const model = str(launch.model);
  const sessionId = str(meta.sessionId);
  if (!sessionId) return { how: "kimi: no session id was recorded; start it again with ahub kimi" };
  return { resume: { sessionId, ...(model ? { model } : {}) }, how: `kimi: session ${sessionId} can be loaded again (ACP session/load)` };
}

export function piCrashPlan(meta: Record<string, unknown>): NativeCrashPlan {
  const launch = (meta.launch && typeof meta.launch === "object" ? meta.launch : {}) as Record<string, unknown>;
  const model = str(launch.model);
  // `fresh`: what a new headless session keeps of the recorded one (pi.auto_start's fallback, #66).
  const fresh: Record<string, string> = {};
  for (const k of ["backend", "model"] as const) if (str(launch[k])) fresh[k] = str(launch[k])!;
  const sessionFile = str(meta.sessionFile) ?? str(launch.sessionFile);
  // #269: a terminal Pi stays marked as one without a session file too, so nothing headless is started in its place.
  if (!sessionFile) return { fresh, ...(str(launch.mode) === "tui" ? { tui: true } : {}), how: "pi: no session file was recorded; start it again with ahub pi" };
  // A terminal Pi is run by the CLI that launched it, not by the hub: nothing here could start it again.
  if (str(launch.mode) === "tui") return { fresh, tui: true, how: `pi: it ran in a terminal; start it again with ahub pi --mode tui --session-file ${sessionFile}` };
  const args: Record<string, string> = { sessionFile };
  for (const k of ["mode", "backend", "model"] as const) if (str(launch[k])) args[k] = str(launch[k])!;
  return { fresh, resume: args, how: `pi: its session file can be resumed (${sessionFile})` };
}

export function localCrashPlan(meta: Record<string, unknown>): NativeCrashPlan {
  const launch = (meta.launch && typeof meta.launch === "object" ? meta.launch : {}) as Record<string, unknown>;
  const model = str(launch.model);
  // `model` is also recorded as the route's fallback, and a model given at start pins it: pass one or the other.
  const route = str(launch.route);
  const args: Record<string, string> = route ? { route } : model ? { model } : {};
  return { resume: args, how: "local: starts again without its history (the worker keeps none across a hub stop)" };
}

/** Plugin names (before the `@marketplace`) that stand for an add-on. */
// Maps, not objects: a plugin named `constructor` or `toString` must find nothing, not an inherited property.
const PLUGINS = new Map<string, AddonName>([["claude-mem", "claude-mem"], ["ponytail", "ponytail"], ["open-code-review", "open-code-review"]]);
/** Claude Code only: the Codex plugin is a Claude plugin named `codex` from the `openai-codex` marketplace. */
const CLAUDE_ONLY = new Map<string, AddonName>([["codex@openai-codex", "codex-plugin"]]);
/** A regular file of at most 1 MiB, opened without blocking: a FIFO or device under a project's `.claude/` reads as absent. */
const text = (file: string): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) return undefined;
    return readFileSync(fd, "utf8");
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
};
const json = (file: string): Record<string, unknown> | undefined => {
  try { const v = JSON.parse(text(file) ?? ""); return v && typeof v === "object" ? v as Record<string, unknown> : undefined; } catch { return undefined; }
};
const version = (v: unknown): string | null => typeof v === "string" && /^[0-9A-Za-z.+_-]{1,40}$/.test(v) ? v : null;

function claudePlugins(root: string, cwd: string | undefined): Addon[] {
  const enabled = new Map<string, boolean>();
  for (const file of [join(root, "settings.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])]) {
    const map = json(file)?.enabledPlugins;
    if (map && typeof map === "object") for (const [key, on] of Object.entries(map)) enabled.set(key, on === true);
  }
  const installed = (json(join(root, "plugins", "installed_plugins.json"))?.plugins ?? {}) as Record<string, { scope?: string; projectPath?: string; version?: unknown }[]>;
  const out: Addon[] = [];
  for (const [key, on] of enabled) {
    if (!on) continue;
    const name = CLAUDE_ONLY.get(key) ?? PLUGINS.get(key.split("@")[0]!);
    const entries = Array.isArray(installed[key]) ? installed[key]! : [];
    // An install for another project is not this one's.
    const entry = entries.find((e) => e?.scope === "user") ?? entries.find((e) => e?.projectPath === cwd);
    if (name && entry) out.push({ name, version: version(entry.version) });
  }
  return out;
}

function codexPlugins(root: string): Addon[] {
  const config = text(join(root, "config.toml"));
  if (config === undefined) return [];
  const found = new Map<string, string>(), disabled = new Set<string>(); // plugin name -> marketplace
  // `[plugins."name@market"]` with no `enabled = false` below it, and plugins whose hooks Codex was told to trust
  // unless their plugin entry disables them: a trust entry outlives the plugin's own switch.
  for (const m of config.matchAll(/^\[plugins\."([^"@]+)@([^"]+)"\]\s*\n((?:(?!\[)[^\n]*\n?)*)/gm)) if (!/^\s*enabled\s*=\s*false\b/m.test(m[3] ?? "")) found.set(m[1]!, m[2]!); else disabled.add(m[1]! + "@" + m[2]!);
  for (const m of config.matchAll(/^\[hooks\.state\."([^"@]+)@([^":]+):/gm)) if (!disabled.has(m[1]! + "@" + m[2]!)) found.set(m[1]!, m[2]!);
  const out: Addon[] = [];
  for (const [plugin, market] of found) {
    const name = PLUGINS.get(plugin);
    if (!name) continue;
    let versions: string[] = [];
    try { versions = readdirSync(join(root, "plugins", "cache", market, plugin)); } catch { /* no cache: version unknown */ }
    out.push({ name, version: versions.length === 1 ? version(versions[0]) : null });
  }
  return out;
}

interface PluginInventoryContext { home: string; cwd?: string; env: Readonly<Record<string, string | undefined>> }
export const claudePluginInventory = (ctx: PluginInventoryContext): Addon[] => claudePlugins(ctx.env.CLAUDE_CONFIG_DIR?.trim() || join(ctx.home, ".claude"), ctx.cwd);
export const codexPluginInventory = (ctx: PluginInventoryContext): Addon[] => codexPlugins(ctx.env.CODEX_HOME?.trim() || join(ctx.home, ".codex"));

/** A persisted native identity decoder; the coordinator retains envelope, path and operation checks. */
export function parsePiContinuity(value: unknown): { sessionId: string; sessionFile?: string; backend?: "auto" | "dgx" | "mlx"; model?: string } | undefined {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const id = (v: unknown): v is string => text(v, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
  if (!record(value) || Object.keys(value).some(key => !["sessionId", "sessionFile", "backend", "model"].includes(key)) || !id(value.sessionId)
    || value.sessionFile !== undefined && !absoluteContinuityPath(value.sessionFile) || value.backend !== undefined && !["auto", "dgx", "mlx"].includes(String(value.backend))
    || value.model !== undefined && !text(value.model, 4096)) return undefined;
  return { sessionId: value.sessionId, ...(value.sessionFile === undefined ? {} : { sessionFile: value.sessionFile as string }), ...(value.backend === undefined ? {} : { backend: value.backend as "auto" | "dgx" | "mlx" }), ...(value.model === undefined ? {} : { model: value.model as string }) };
}
function absoluteContinuityPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value) && normalize(value) === value;
}

export const codexToolSemantic = (name: string, _command?: string): "edit" | undefined => name.toLowerCase() === "filechange" ? "edit" : undefined;
