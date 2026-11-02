import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { realPath } from "../hub/project.ts";
import { launcherOf, recordPath, MAX_COMMAND_MS, type ProcessIdentity } from "./terminal-recovery.ts";
import { CLAUDE_PLUGIN_INVENTORY, PLUGIN, nextStep, pluginState, type InstalledPlugin, type Marketplace, type PluginState, type SetupStep } from "./setup.ts";
import { checkClaudeProfileHook, type ClaudeProfileHookCheck } from "./claude-profile-hook.ts";

export type ClaudeHomeSource = "environment" | "default" | "recorded-launch";
export interface ClaudeHome { path: string; exists: boolean; sources: ClaudeHomeSource[] }
/** The caller selects Claude channel peers from the resolved project catalog, never from an id spelling. */
export interface ClaudeHomeProject { root: string; stateDir: string; instanceId: string; claudePeers: readonly string[] }
export interface ClaudeHomeDiscovery { homes: ClaudeHome[]; notices: string[]; complete: boolean }
export interface ClaudeHomeDiscoveryInput {
  home: string;
  env: NodeJS.ProcessEnv;
  projects?: readonly ClaudeHomeProject[];
  processIdentity?: ProcessIdentity;
}

// ponytail: 128 live launch candidates and 1 MiB per private record file bound local discovery;
// a larger machine needs a paginated host inventory, never a profile-directory scan.
const MAX_CANDIDATES = 128;
const MAX_RECORD_BYTES = 1024 * 1024;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

/** No credentials, native profile caches or arbitrary profile directories are inspected. */
export async function discoverClaudeHomes(input: ClaudeHomeDiscoveryInput): Promise<ClaudeHomeDiscovery> {
  const homes = new Map<string, ClaudeHome>(), notices: string[] = [];
  let complete = true, candidates = 0;
  const unavailable = (message: string) => { complete = false; if (!notices.includes(message)) notices.push(message); };
  const add = (value: unknown, source: ClaudeHomeSource, requireExisting = false) => {
    if (!validPath(value)) { unavailable("A Claude configuration home path is invalid; no home was selected from that evidence."); return; }
    try {
      const info = statSync(value, { throwIfNoEntry: false });
      if (info && !info.isDirectory()) { unavailable("A selected Claude configuration home is not a directory."); return; }
      if (!info && requireExisting) return;
      const path = info ? realPath(value) : value;
      const previous = homes.get(path);
      if (previous) { if (!previous.sources.includes(source)) previous.sources.push(source); }
      else homes.set(path, { path, exists: !!info, sources: [source] });
    } catch { unavailable("A selected Claude configuration home could not be inspected."); }
  };
  if (input.env.CLAUDE_CONFIG_DIR !== undefined && input.env.CLAUDE_CONFIG_DIR !== "") add(input.env.CLAUDE_CONFIG_DIR, "environment");
  else if (validPath(input.home)) add(join(input.home, ".claude"), "default", true);
  else unavailable("The user home is unavailable; no default Claude home was selected.");

  for (const project of input.projects ?? []) {
    if (++candidates > MAX_CANDIDATES) { unavailable("Claude home discovery reached its live-launch candidate limit."); break; }
    if (!validPath(project.root) || !validPath(project.stateDir) || !project.instanceId || project.instanceId.length > 256) {
      unavailable("A project has invalid live-launch scope; its Claude homes were not selected."); continue;
    }
    try {
      const info = lstatSync(recordPath(project.stateDir), { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RECORD_BYTES || (info.mode & 0o022) !== 0 || !process.getuid || info.uid !== process.getuid()) {
        unavailable("A project launch record is unsafe or exceeds the discovery size limit."); continue;
      }
    } catch { unavailable("A project launch record could not be inspected."); continue; }
    for (const peer of project.claudePeers) {
      if (++candidates > MAX_CANDIDATES) { unavailable("Claude home discovery reached its live-launch candidate limit."); break; }
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(peer)) { unavailable("A project has an invalid Claude peer id."); continue; }
      try {
        const launch = await launcherOf(peer, project.root, { stateDir: project.stateDir, instanceId: project.instanceId, ...(input.processIdentity ? { processIdentity: input.processIdentity } : {}) });
        if (!launch || launch.state === "gone") continue;
        if (launch.state !== "live" || !launch.record) { unavailable("A Claude launch cannot be proven live; its configuration home was not selected."); continue; }
        const profile = launch.record.env.CLAUDE_CONFIG_DIR;
        if (profile !== undefined && profile !== "") add(profile, "recorded-launch");
        else if (validPath(input.home)) add(join(input.home, ".claude"), "recorded-launch", true);
        else unavailable("A live Claude launch has no usable configuration home.");
      } catch { unavailable("A Claude launch could not be inspected; its configuration home was not selected."); }
    }
    if (candidates > MAX_CANDIDATES) break;
  }
  // Claude uses its default home on first launch too; absence is not evidence of an unused profile.
  if (!homes.size && !input.env.CLAUDE_CONFIG_DIR && validPath(input.home)) add(join(input.home, ".claude"), "default");
  return { homes: [...homes.values()], notices, complete };
}

/** A fresh child environment for each home; never mutate process.env while visiting profiles. */
export function claudeHomeEnvironment(home: Pick<ClaudeHome, "path">, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!validPath(home.path)) throw new Error("invalid Claude configuration home");
  return { ...env, CLAUDE_CONFIG_DIR: home.path };
}

export interface ClaudeHomeProbeOptions { env: NodeJS.ProcessEnv; timeoutMs: number }
/** Implementations must enforce timeoutMs at their subprocess boundary. Only the two JSON reads are requested. */
export type ClaudeHomeProbe = (argv: readonly string[], options: ClaudeHomeProbeOptions) => { status: number; stdout: string } | Promise<{ status: number; stdout: string }>;
export interface ClaudeHomeCheck {
  home: ClaudeHome;
  plugin: PluginState | { state: "unknown"; reason: string };
  next?: SetupStep;
  hook: ClaudeProfileHookCheck;
}

/** Read-only per-home plugin inspection. Installation never proves that a live permission hook is present. */
export async function checkClaudeHome(home: ClaudeHome, packageRoot: string, env: NodeJS.ProcessEnv, probe: ClaudeHomeProbe, timeoutMs = MAX_COMMAND_MS, probeMissingDefault = false): Promise<ClaudeHomeCheck> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_MS) throw new Error("invalid Claude plugin probe time bound");
  const hook = checkClaudeProfileHook(home);
  const unknown = (): ClaudeHomeCheck => ({ home, plugin: { state: "unknown", reason: "Claude plugin inventory is unavailable or invalid for this home." }, hook });
  if (hook.state === "refused") return unknown();
  if (!home.exists && !(probeMissingDefault && home.sources.includes("default"))) return { home, plugin: { state: "missing" }, next: nextStep([], [], packageRoot), hook };
  const scoped = claudeHomeEnvironment(home, env), deadline = performance.now() + timeoutMs;
  const read = async (argv: readonly string[]): Promise<unknown[] | undefined> => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) return;
    const result = await probe(argv, { env: scoped, timeoutMs: remaining });
    if (result.status !== 0 || Buffer.byteLength(result.stdout, "utf8") > MAX_RECORD_BYTES || performance.now() > deadline) return;
    const value: unknown = JSON.parse(result.stdout);
    return Array.isArray(value) ? value : undefined;
  };
  try {
    const plugins = await read(CLAUDE_PLUGIN_INVENTORY.plugins);
    if (!plugins) return unknown();
    const marketplaces = await read(CLAUDE_PLUGIN_INVENTORY.marketplaces);
    if (!marketplaces) return unknown();
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    if (!plugins.every(row => object(row) && typeof row.id === "string" && row.id.length <= 256 &&
      (row.version === undefined || typeof row.version === "string" && row.version.length <= 64 && (row.id !== PLUGIN ? !/[\u0000-\u001f\u007f-\u009f]/.test(row.version) : /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(row.version))) &&
      (row.installPath === undefined || validPath(row.installPath))) ||
      !marketplaces.every(row => object(row) && typeof row.name === "string" && row.name.length <= 256 && (row.path === undefined || validPath(row.path)))) return unknown();
    return { home, plugin: pluginState(plugins as InstalledPlugin[], packageRoot), next: nextStep(plugins as InstalledPlugin[], marketplaces as Marketplace[], packageRoot), hook };
  } catch { return unknown(); }
}
