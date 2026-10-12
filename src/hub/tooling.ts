import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * #248: which add-ons a peer works with, from a closed list. Names and versions only, read from the machine's plugin
 * inventory and launch settings (Claude Code's installed plugins and `enabledPlugins`, Codex's `config.toml`) and from
 * the executables on PATH; never a plugin's content, settings values, hooks or paths.
 * ponytail: the inventory is the machine's, not the session's: a session started with its own `--settings` or plugin
 * flags can differ. Reading the launch record of each `ahub claude` / `ahub codex` would make it exact.
 */
export const ADDONS = ["claude-mem", "ponytail", "ripwire", "open-code-review", "codex-plugin", "dot-admit"] as const;
export type AddonName = (typeof ADDONS)[number];
export interface Addon { name: AddonName; version: string | null }

/** Plugin names (before the `@marketplace`) that stand for an add-on. */
// Maps, not objects: a plugin named `constructor` or `toString` must find nothing, not an inherited property.
const PLUGINS = new Map<string, AddonName>([["claude-mem", "claude-mem"], ["ponytail", "ponytail"], ["open-code-review", "open-code-review"]]);
/** Claude Code only: the Codex plugin is a Claude plugin named `codex` from the `openai-codex` marketplace. */
const CLAUDE_ONLY = new Map<string, AddonName>([["codex@openai-codex", "codex-plugin"]]);
/**
 * Executables any peer with a shell can run, and how each is told apart from another program of the same name: the
 * first one on PATH is asked for its version (bounded, no stdin), so Graphviz's `dot` is never resource admission.
 */
const BINARIES: Record<string, { name: AddonName; version?: RegExp }> = { ripwire: { name: "ripwire" }, dot: { name: "dot-admit", version: /^dot version (\S+)/ } };
/** By resolved path and modification time: one version call per binary per process. */
const identities = new Map<string, Promise<string | null | false>>();
const PROBE_MS = 2000;

export interface ToolingSources { home?: string; cwd?: string; path?: string }

const json = (file: string): Record<string, unknown> | undefined => {
  try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" ? v as Record<string, unknown> : undefined; } catch { return undefined; }
};
/** A version string as data, never anything longer or stranger. */
const version = (v: unknown): string | null => typeof v === "string" && /^[0-9A-Za-z.+_-]{1,40}$/.test(v) ? v : null;

function claudePlugins(home: string, cwd: string | undefined): Addon[] {
  const enabled = new Map<string, boolean>();
  for (const file of [join(home, ".claude", "settings.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])]) {
    const map = json(file)?.enabledPlugins;
    if (map && typeof map === "object") for (const [key, on] of Object.entries(map)) enabled.set(key, on === true);
  }
  const installed = (json(join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins ?? {}) as Record<string, { scope?: string; projectPath?: string; version?: unknown }[]>;
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

function codexPlugins(home: string): Addon[] {
  let text: string;
  try { text = readFileSync(join(home, ".codex", "config.toml"), "utf8"); } catch { return []; }
  const found = new Map<string, string>(); // plugin name -> marketplace
  // `[plugins."name@market"]` with no `enabled = false` below it, and plugins whose hooks Codex was told to trust.
  for (const m of text.matchAll(/^\[plugins\."([^"@]+)@([^"]+)"\]\s*\n((?:(?!\[)[^\n]*\n?)*)/gm)) if (!/^\s*enabled\s*=\s*false\b/m.test(m[3] ?? "")) found.set(m[1]!, m[2]!);
  for (const m of text.matchAll(/^\[hooks\.state\."([^"@]+)@([^":]+):/gm)) found.set(m[1]!, m[2]!);
  const out: Addon[] = [];
  for (const [plugin, market] of found) {
    const name = PLUGINS.get(plugin);
    if (!name) continue;
    let versions: string[] = [];
    try { versions = readdirSync(join(home, ".codex", "plugins", "cache", market, plugin)); } catch { /* no cache: version unknown */ }
    out.push({ name, version: versions.length === 1 ? version(versions[0]) : null });
  }
  return out;
}

/** The first executable of that name on PATH. */
function onPath(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* not here */ }
  }
  return undefined;
}
/**
 * The version an executable reports when it is the expected program, `null` when that is unknown, `false` when it is
 * another program or does not answer within PROBE_MS. Asynchronous with a hard deadline: a program that ignores SIGTERM
 * is killed outright and never waited on, so it can never hold up the hub.
 */
function identify(file: string, pattern: RegExp): Promise<string | null | false> {
  let key = file;
  try { key = `${file}:${statSync(file).mtimeMs}`; } catch { /* unreadable: ask anyway */ }
  let found = identities.get(key);
  if (!found) {
    found = new Promise<string | null | false>((resolve) => {
      let out = "", settled = false, child: ChildProcess | undefined;
      // Its own process group, killed as one when the answer is in or the deadline passes: a descendant that kept the
      // pipe open would otherwise outlive the probe and hold up whoever waits on it.
      const finish = (answer: string | null | false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
        child?.stdout?.destroy();
        resolve(answer);
      };
      const timer = setTimeout(() => finish(false), PROBE_MS);
      try {
        child = spawn(file, ["--version"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
        child.unref();
        child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        child.on("error", () => finish(false));
        // The version line is written before the program exits; a moment for the pipe to deliver it.
        child.on("exit", () => setTimeout(() => { const m = pattern.exec(out.trim()); finish(m ? version(m[1]) : false); }, 50));
      } catch { finish(false); }
    });
    identities.set(key, found);
  }
  return found;
}

/** The add-ons a peer works with, sorted by name. Unreadable sources contribute nothing; they never throw. */
export async function detectTooling(peer: string, src: ToolingSources = {}): Promise<Addon[]> {
  const home = src.home ?? homedir();
  const found = new Map<AddonName, Addon>();
  const add = (a: Addon) => { if (!found.has(a.name) || (found.get(a.name)!.version === null && a.version !== null)) found.set(a.name, a); };
  if (peer === "claude") claudePlugins(home, src.cwd).forEach(add);
  if (peer === "codex") codexPlugins(home).forEach(add);
  const path = src.path ?? process.env.PATH ?? "";
  for (const [bin, spec] of Object.entries(BINARIES)) {
    const file = onPath(bin, path);
    if (!file) continue;
    const v = spec.version ? await identify(file, spec.version) : null;
    if (v !== false) add({ name: spec.name, version: v });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `on` when any of the peers has the add-on, `off` when every peer's fingerprint is known and none has it, else unknown. */
export function addonState(name: AddonName, fingerprints: (Addon[] | undefined)[]): "on" | "off" | "unknown" {
  if (fingerprints.some((f) => f?.some((a) => a.name === name))) return "on";
  return fingerprints.length && fingerprints.every((f) => f !== undefined) ? "off" : "unknown";
}

export const isAddon = (name: string): name is AddonName => (ADDONS as readonly string[]).includes(name);
