import { definitionOf } from "../adapters/registry.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, relative, resolve, isAbsolute } from "node:path";
import { realPath } from "./project.ts";

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

/**
 * Executables any peer with a shell can run, and how each is told apart from another program of the same name: the
 * first one on PATH is asked for its version (bounded, no stdin), so Graphviz's `dot` is never resource admission.
 */
const BINARIES: Record<string, { name: AddonName; version?: RegExp }> = { ripwire: { name: "ripwire" }, dot: { name: "dot-admit", version: /^dot version (\S+)/ } };
/** By resolved path and modification time: one version call per binary per process. */
const identities = new Map<string, Promise<string | null | false>>();
const PROBE_MS = 2000, PROBE_BYTES = 4096;

/** `env` supplies CLAUDE_CONFIG_DIR and CODEX_HOME, the runtimes' own config roots (the hub's environment by default). */
export interface ToolingSources { home?: string; cwd?: string; path?: string; env?: Record<string, string | undefined> }

/** A version string as data, never anything longer or stranger. */
const version = (v: unknown): string | null => typeof v === "string" && /^[0-9A-Za-z.+_-]{1,40}$/.test(v) ? v : null;

/** Never throws: a path that cannot be resolved (a project directory that went away) is compared as given. */
const real = (path: string): string => { try { return realPath(path); } catch { return resolve(path); } };
const within = (file: string, dir: string): boolean => { const r = relative(dir, file); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/** The first executable of that name on PATH, relative and empty entries resolved from the peer's working directory. */
function onPath(name: string, path: string, cwd: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    const file = resolve(cwd, dir || ".", name);
    // A shell runs the first executable regular file; a directory of that name is skipped like a missing one.
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* not here */ }
  }
  return undefined;
}
/**
 * The version an executable reports when it is the expected program, `null` when that is unknown, `false` when it is
 * another program or does not answer within PROBE_MS. Asynchronous with a hard deadline: a program that ignores SIGTERM
 * is killed outright and never waited on, so it can never hold up the hub.
 */
function identify(file: string, pattern: RegExp, env: Record<string, string>): Promise<string | null | false> {
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
        // Only PATH (its absolute entries outside the project, so an env-shebang interpreter still resolves), HOME and
        // the C locale reach the probed program: no gateway keys, Access values or agent markers.
        child = spawn(file, ["--version"], { detached: true, stdio: ["ignore", "pipe", "ignore"], env });
        child.unref();
        // A version line is short: a program that keeps writing is not the one asked for, and is not read further.
        child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); if (out.length > PROBE_BYTES) finish(false); });
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
  const env = src.env ?? process.env;
  definitionOf(peer)?.hooks?.pluginInventory?.({ env, home, cwd: src.cwd }).forEach(add);
  const path = src.path ?? process.env.PATH ?? "";
  for (const [bin, spec] of Object.entries(BINARIES)) {
    const file = onPath(bin, path, src.cwd ?? process.cwd());
    if (!file) continue;
    // A program inside the project is the repository's, not an installed tool: it is never run to identify it (opening a
    // checkout must not execute its files), so it does not count where its identity has to be checked.
    const inProject = src.cwd !== undefined && within(real(file), real(src.cwd));
    const probeEnv = { PATH: path.split(delimiter).filter((d) => isAbsolute(d) && !(src.cwd !== undefined && within(real(d), real(src.cwd)))).join(delimiter) || "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C" };
    const v = spec.version ? (inProject ? false : await identify(file, spec.version, probeEnv)) : null;
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
