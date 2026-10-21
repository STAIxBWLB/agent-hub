import { AGY_DEFINITION } from "../adapters/agy/definition.ts";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hubGitSync } from "../hub/git.ts";
import { realPath } from "../hub/project.ts";

export interface AgyMcpOptions {
  projectRoot: string;
  stateDir: string;
  serverJs: string;
  hookScript: string;
  instanceId: string;
  launchId: string;
  peer?: string;
}

const PLUGIN_DIR = ".agents/plugins/agent-hub";
const PLUGIN_KEY = "agent-hub";
const MANIFEST_FILE = `${PLUGIN_DIR}/plugin.json`;
const MCP_FILE = `${PLUGIN_DIR}/mcp_config.json`;
const HOOKS_FILE = `${PLUGIN_DIR}/hooks.json`;
const FILES = [MANIFEST_FILE, MCP_FILE, HOOKS_FILE] as const;
export const AGY_PLUGIN_FILES = FILES;
const EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"] as const;
const MANAGED_DESCRIPTION = "Managed by ahub agy launcher.";
const MAX_CONFIG_BYTES = 256 * 1024;
type JsonObject = Record<string, any>;
type Target = { path: string; relative: typeof FILES[number]; current?: Buffer; stat?: Stats; next: Buffer; changed: boolean };
type DirectoryIdentity = { path: string; stat: Stats };
type Plan = { file: string; tracked: boolean; changed: boolean; action: string; root: string; pluginDir: string; canonicalRoot: string; canonicalPluginDir?: string; directories?: DirectoryIdentity[]; targets: Target[] };

function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function jsonFile(value: unknown, name: string): JsonObject {
  if (!object(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}
function parseJson(bytes: Buffer, name: string): JsonObject {
  try { return jsonFile(JSON.parse(bytes.toString("utf8")), name); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`${name} is invalid JSON`); throw error; }
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function shellUnquote(value: string): string | undefined {
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined;
  let out = "";
  for (let index = 1; index < value.length - 1;) {
    if (value.startsWith("'\\''", index)) { out += "'"; index += 4; }
    else if (value[index] === "'") return undefined;
    else out += value[index++];
  }
  return out;
}

function validateOptions(options: AgyMcpOptions) {
  const peer = options.peer ?? AGY_DEFINITION.kind;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(peer)) throw new Error("agy peer id is invalid");
  for (const [name, value] of Object.entries({ projectRoot: options.projectRoot, stateDir: options.stateDir, serverJs: options.serverJs, hookScript: options.hookScript })) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} must be an absolute control-free path`);
  }
  for (const [name, value] of Object.entries({ instanceId: options.instanceId, launchId: options.launchId })) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  }
  const root = resolve(options.projectRoot);
  return { root, peer };
}

function safeDirectory(path: string): Stats | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${path} must be a project directory, not a link`);
  return stat;
}

function safeFile(path: string): { stat: Stats; bytes: Buffer } | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES) throw new Error(`${path} must be a bounded regular file, not a link`);
  const bytes = readFileSync(path);
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error(`${path} exceeds the configuration size limit`);
  return { stat, bytes };
}

function pluginDirectories(root: string): DirectoryIdentity[] {
  const directories: DirectoryIdentity[] = [];
  for (const relative of [".", ".agents", ".agents/plugins", PLUGIN_DIR]) {
    const path = relative === "." ? root : join(root, relative);
    const stat = safeDirectory(path);
    if (!stat) throw new Error(`${path} must be an existing project directory`);
    directories.push({ path, stat });
  }
  return directories;
}

function verifyPluginDirectory(plan: Pick<Plan, "root" | "pluginDir" | "canonicalRoot" | "canonicalPluginDir" | "directories">, target: string): void {
  if (!plan.canonicalPluginDir || !plan.directories) throw new Error("managed agy plugin directory identity is unavailable");
  if (realPath(plan.root) !== plan.canonicalRoot || realPath(plan.pluginDir) !== plan.canonicalPluginDir || plan.canonicalPluginDir !== join(plan.canonicalRoot, PLUGIN_DIR)) {
    throw new Error("managed agy plugin path changed; inspect it before writing");
  }
  for (const expected of plan.directories) {
    const current = safeDirectory(expected.path);
    if (!current || current.dev !== expected.stat.dev || current.ino !== expected.stat.ino) throw new Error("managed agy plugin directory changed; inspect it before writing");
  }
  if (!FILES.some(file => join(plan.root, file) === target)) {
    throw new Error("atomic write target is outside the managed agy plugin files");
  }
}

function hookCommand(phase: typeof EVENTS[number], options: AgyMcpOptions, peer: string): string {
  return `AGENTHUB_HOOK_EVENT='${phase}' AGENTHUB_INSTANCE_ID='${options.instanceId}' AGENTHUB_LAUNCH_ID='${options.launchId}' AGENTHUB_HOOK_PURPOSE='facts' AGENTHUB_PEER_ID=${shellQuote(peer)} AGENTHUB_STATE_DIR=${shellQuote(options.stateDir)} AGENTHUB_PROJECT_DIR=${shellQuote(resolve(options.projectRoot))} bun ${shellQuote(options.hookScript)}`;
}

function desired(options: AgyMcpOptions, root: string, peer: string): Record<typeof FILES[number], JsonObject> {
  const events: JsonObject = {};
  for (const phase of EVENTS) {
    if (phase === "PostInvocation") { events[phase] = []; continue; }
    const command = { type: "command", command: hookCommand(phase, options, peer), timeout: 5 };
    events[phase] = phase === "PreToolUse" || phase === "PostToolUse"
      ? [{ matcher: ".*", hooks: [command] }]
      : [command];
  }
  return {
    [MANIFEST_FILE]: { name: PLUGIN_KEY, description: MANAGED_DESCRIPTION },
    [MCP_FILE]: { mcpServers: { [PLUGIN_KEY]: { command: "bun", args: ["run", options.serverJs], env: { AGENTHUB_PEER_ID: peer, AGENTHUB_STATE_DIR: options.stateDir, AGENTHUB_PROJECT_DIR: root } } } },
    [HOOKS_FILE]: { [PLUGIN_KEY]: events },
  };
}

function parseManagedHookCommand(command: unknown, phase: typeof EVENTS[number], options: AgyMcpOptions, peer: string): { instanceId: string; launchId: string } | undefined {
  if (typeof command !== "string") return undefined;
  const prefix = `AGENTHUB_HOOK_EVENT='${phase}' AGENTHUB_INSTANCE_ID='`;
  const middle = `' AGENTHUB_LAUNCH_ID='`;
  const suffix = `' AGENTHUB_HOOK_PURPOSE='facts' AGENTHUB_PEER_ID=${shellQuote(peer)} AGENTHUB_STATE_DIR=${shellQuote(options.stateDir)} AGENTHUB_PROJECT_DIR=${shellQuote(resolve(options.projectRoot))} bun `;
  if (!command.startsWith(prefix)) return undefined;
  const rest = command.slice(prefix.length);
  const launchSplit = rest.indexOf(middle);
  if (launchSplit < 1) return undefined;
  const instanceId = rest.slice(0, launchSplit);
  const afterInstance = rest.slice(launchSplit + middle.length);
  const pathSplit = afterInstance.indexOf(suffix);
  if (pathSplit < 1) return undefined;
  const launchId = afterInstance.slice(0, pathSplit);
  const hookScript = shellUnquote(afterInstance.slice(pathSplit + suffix.length));
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(instanceId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(launchId) || !hookScript || !isAbsolute(hookScript) || !hookScript.endsWith("/src/cli/facts-hook.ts")) return undefined;
  return { instanceId, launchId };
}

function managedHookLaunch(value: JsonObject, options: AgyMcpOptions, peer: string): { instanceId: string; launchId: string } | undefined {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, PLUGIN_KEY)) return undefined;
  const events = value[PLUGIN_KEY];
  if (!object(events) || Object.keys(events).length !== EVENTS.length || EVENTS.some(phase => !Object.hasOwn(events, phase))) return undefined;
  let identity: { instanceId: string; launchId: string } | undefined;
  for (const phase of EVENTS) {
    const rows = events[phase];
    if (phase === "PostInvocation") { if (!Array.isArray(rows) || rows.length !== 0) return undefined; continue; }
    if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0])) return undefined;
    let command: unknown;
    if (phase === "PreToolUse" || phase === "PostToolUse") {
      const row = rows[0];
      if (Object.keys(row).sort().join(",") !== "hooks,matcher" || row.matcher !== ".*" || !Array.isArray(row.hooks) || row.hooks.length !== 1 || !object(row.hooks[0])) return undefined;
      command = row.hooks[0];
    } else command = rows[0];
    if (!object(command) || Object.keys(command).sort().join(",") !== "command,timeout,type" || command.type !== "command" || command.timeout !== 5) return undefined;
    const found = parseManagedHookCommand(command.command, phase, options, peer);
    if (!found || (identity && (identity.instanceId !== found.instanceId || identity.launchId !== found.launchId))) return undefined;
    identity = found;
  }
  return identity;
}

function nextDocuments(current: Record<typeof FILES[number], JsonObject | undefined>, wanted: Record<typeof FILES[number], JsonObject>): Record<typeof FILES[number], JsonObject> {
  const nextMcp = current[MCP_FILE] ? { ...current[MCP_FILE] } : {};
  const currentServers = nextMcp.mcpServers;
  const servers = currentServers === undefined ? {} : currentServers;
  if (!object(servers)) throw new Error(`${MCP_FILE} mcpServers must be an object`);
  nextMcp.mcpServers = { ...servers, [PLUGIN_KEY]: wanted[MCP_FILE].mcpServers[PLUGIN_KEY] };
  return { [MANIFEST_FILE]: wanted[MANIFEST_FILE], [MCP_FILE]: nextMcp, [HOOKS_FILE]: wanted[HOOKS_FILE] };
}

function internalPlan(options: AgyMcpOptions): Plan {
  const { root, peer } = validateOptions(options);
  const rootStat = safeDirectory(root);
  if (!rootStat) throw new Error("project root must be an existing directory");
  const canonicalRoot = realPath(root);
  const pluginDir = join(root, PLUGIN_DIR);
  let parentsPresent = true;
  for (const relative of [".agents", ".agents/plugins", PLUGIN_DIR]) {
    if (!parentsPresent) break;
    parentsPresent = !!safeDirectory(join(root, relative));
  }
  let directories: DirectoryIdentity[] | undefined;
  let canonicalPluginDir: string | undefined;
  if (parentsPresent) {
    directories = pluginDirectories(root);
    canonicalPluginDir = realPath(pluginDir);
    if (canonicalPluginDir !== join(canonicalRoot, PLUGIN_DIR)) throw new Error("managed agy plugin path traverses a symlink");
  }
  const snapshots = Object.fromEntries(FILES.map(relative => {
    const path = join(root, relative);
    const found = parentsPresent ? safeFile(path) : undefined;
    return [relative, found];
  })) as Record<typeof FILES[number], { stat: Stats; bytes: Buffer } | undefined>;
  const current = {} as Record<typeof FILES[number], JsonObject | undefined>;
  for (const relative of FILES) {
    const found = snapshots[relative];
    current[relative] = found ? parseJson(found.bytes, relative) : undefined;
  }

  const manifest = current[MANIFEST_FILE];
  if (manifest && (Object.keys(manifest).sort().join(",") !== "description,name" || manifest.name !== PLUGIN_KEY || manifest.description !== MANAGED_DESCRIPTION)) {
    throw new Error(`${MANIFEST_FILE} is a foreign agent-hub plugin manifest; it was not changed`);
  }
  const mcp = current[MCP_FILE];
  if (mcp) {
    if (Object.hasOwn(mcp, "mcpServers") && !object(mcp.mcpServers)) throw new Error(`${MCP_FILE} mcpServers must be an object`);
    const entry = mcp.mcpServers?.[PLUGIN_KEY];
    if (entry !== undefined && (!object(entry) || Object.keys(entry).sort().join(",") !== "args,command,env" || entry.command !== "bun" || !Array.isArray(entry.args) || entry.args.length !== 2 || entry.args[0] !== "run" || typeof entry.args[1] !== "string" || !isAbsolute(entry.args[1]) || !object(entry.env) || Object.keys(entry.env).sort().join(",") !== "AGENTHUB_PEER_ID,AGENTHUB_PROJECT_DIR,AGENTHUB_STATE_DIR" || entry.env.AGENTHUB_PEER_ID !== peer || entry.env.AGENTHUB_PROJECT_DIR !== root || entry.env.AGENTHUB_STATE_DIR !== options.stateDir)) {
      throw new Error(`${MCP_FILE} agent-hub is a foreign MCP entry; it was not changed`);
    }
  }
  const hooks = current[HOOKS_FILE];
  const oldLaunch = hooks ? managedHookLaunch(hooks, options, peer) : undefined;
  if (hooks && !oldLaunch) throw new Error(`${HOOKS_FILE} agent-hub is a foreign hooks entry; it was not changed`);

  const wanted = desired(options, root, peer);
  const docs = nextDocuments(current, wanted);
  const targets = FILES.map(relative => {
    const old = snapshots[relative];
    const next = Buffer.from(`${JSON.stringify(docs[relative], null, 2)}\n`);
    return { path: join(root, relative), relative, ...(old ? { current: old.bytes, stat: old.stat } : {}), next, changed: !old || !isDeepStrictEqual(current[relative], docs[relative]) };
  });
  const git = hubGitSync(["ls-files", "--", ...FILES], { cwd: root, encoding: "utf8", timeout: 3000 });
  const tracked = git.status === 0 && !!git.stdout.trim();
  const changed = targets.some(target => target.changed);
  return { file: pluginDir, tracked, changed, action: changed ? "create or update the managed agent-hub plugin" : "keep the managed agent-hub plugin", root, pluginDir, canonicalRoot, ...(canonicalPluginDir ? { canonicalPluginDir } : {}), ...(directories ? { directories } : {}), targets };
}

/** Preview the native plugin's three project-scoped files without writing or exposing foreign contents. */
export function agyMcpPlan(options: AgyMcpOptions): { file: string; tracked: boolean; changed: boolean; action: string } {
  const { file, tracked, changed, action } = internalPlan(options);
  return { file, tracked, changed, action };
}

function identityMatches(path: string, before?: Stats): boolean {
  const now = lstatSync(path, { throwIfNoEntry: false });
  return before ? !!now && now.dev === before.dev && now.ino === before.ino : !now;
}

function atomicWrite(path: string, bytes: Buffer, expected: Stats | undefined, plan: Plan): { dev: number; ino: number } {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let tempIdentity: { dev: number; ino: number } | undefined;
  try {
    verifyPluginDirectory(plan, path);
    fd = openSync(temporary, "wx", 0o600);
    const tempStat = fstatSync(fd);
    tempIdentity = { dev: tempStat.dev, ino: tempStat.ino };
    writeFileSync(fd, bytes);
    closeSync(fd); fd = undefined;
    verifyPluginDirectory(plan, path);
    if (!identityMatches(path, expected)) throw new Error(`${path} changed while the managed plugin was being written`);
    renameSync(temporary, path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${path} changed while the managed plugin was written`);
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      const current = lstatSync(temporary, { throwIfNoEntry: false });
      if (current && tempIdentity && current.dev === tempIdentity.dev && current.ino === tempIdentity.ino) unlinkSync(temporary);
    } catch { /* A temp path that no longer names our file is not ours to remove. */ }
  }
}

function rollback(plan: Plan, written: { target: Target; own: { dev: number; ino: number } }[], createdDirs: { path: string; dev: number; ino: number }[]): void {
  for (const { target, own } of written.reverse()) {
    try {
      const now = lstatSync(target.path, { throwIfNoEntry: false });
      if (!now || now.dev !== own.dev || now.ino !== own.ino) continue;
      if (target.current) atomicWrite(target.path, target.current, now, plan);
      else unlinkSync(target.path);
    } catch { /* Never replace a path whose ownership changed during rollback. */ }
  }
  for (const { path, dev, ino } of createdDirs.reverse()) {
    try { const now = lstatSync(path); if (now.isDirectory() && !now.isSymbolicLink() && now.dev === dev && now.ino === ino) rmdirSync(path); }
    catch { /* Keep a directory that is no longer empty or no longer ours. */ }
  }
}

export function ensureAgyMcp(options: AgyMcpOptions): { changed: boolean; tracked: boolean } {
  const plan = internalPlan(options);
  if (!plan.changed) return { changed: false, tracked: plan.tracked };
  const createdDirs: { path: string; dev: number; ino: number }[] = [];
  const written: { target: Target; own: { dev: number; ino: number } }[] = [];
  try {
    for (const relative of [".agents", ".agents/plugins", PLUGIN_DIR]) {
      const path = join(plan.root, relative);
      const prior = safeDirectory(path);
      if (prior) continue;
      mkdirSync(path, { mode: 0o700 });
      const stat = safeDirectory(path)!;
      createdDirs.push({ path, dev: stat.dev, ino: stat.ino });
    }
    plan.directories = pluginDirectories(plan.root);
    plan.canonicalPluginDir = realPath(plan.pluginDir);
    if (plan.canonicalRoot !== realPath(plan.root) || plan.canonicalPluginDir !== join(plan.canonicalRoot, PLUGIN_DIR)) throw new Error("managed agy plugin path changed; inspect it before writing");
    for (const target of plan.targets) {
      if (!target.changed) continue;
      if (!identityMatches(target.path, target.stat)) throw new Error(`${target.path} changed while the managed plugin was being prepared`);
      const own = atomicWrite(target.path, target.next, target.stat, plan);
      written.push({ target, own });
    }
  } catch (error) {
    rollback(plan, written, createdDirs);
    throw error;
  }
  return { changed: true, tracked: plan.tracked };
}

export function agyMcpReady(options: AgyMcpOptions): boolean {
  return !internalPlan(options).changed;
}

export function cleanupAgyMcp(options: AgyMcpOptions): void {
  const plan = internalPlan(options);
  const present = plan.targets.filter(target => target.current !== undefined);
  if (!present.length) return;
  if (present.length !== FILES.length) throw new Error("managed agy plugin is incomplete; inspect it before cleanup");
  const currentHooks = parseJson(readFileSync(join(plan.root, HOOKS_FILE)), HOOKS_FILE);
  const launch = managedHookLaunch(currentHooks, options, options.peer ?? AGY_DEFINITION.kind);
  if (!launch || launch.instanceId !== options.instanceId || launch.launchId !== options.launchId) return;
  // A stale cleanup never removes files a newer config update has replaced.
  if (plan.changed) return;
  const deleted: { path: string; bytes: Buffer; own?: { dev: number; ino: number } }[] = [];
  try {
    for (const target of plan.targets) {
      const stat = lstatSync(target.path);
      if (!target.stat || stat.dev !== target.stat.dev || stat.ino !== target.stat.ino) throw new Error(`${target.path} changed before agy plugin cleanup`);
    }
    for (const target of plan.targets) {
      if (!identityMatches(target.path, target.stat)) throw new Error(`${target.path} changed before agy plugin cleanup`);
      if (target.relative === MCP_FILE) {
        const currentMcp = parseJson(target.current!, MCP_FILE);
        const servers = { ...currentMcp.mcpServers };
        delete servers[PLUGIN_KEY];
        const nextMcp = { ...currentMcp, mcpServers: servers };
        const retain = Object.keys(servers).length > 0 || Object.keys(currentMcp).some(key => key !== "mcpServers");
        if (retain) {
          const own = atomicWrite(target.path, Buffer.from(`${JSON.stringify(nextMcp, null, 2)}\n`), target.stat, plan);
          deleted.push({ path: target.path, bytes: target.current!, own });
        } else {
          unlinkSync(target.path);
          deleted.push({ path: target.path, bytes: target.current! });
        }
      } else {
        unlinkSync(target.path);
        deleted.push({ path: target.path, bytes: target.current! });
      }
    }
  } catch (error) {
    for (const item of deleted.reverse()) {
      try {
        const current = lstatSync(item.path, { throwIfNoEntry: false });
        if (item.own) {
          if (current?.dev === item.own.dev && current.ino === item.own.ino) atomicWrite(item.path, item.bytes, current, plan);
        } else if (!current) atomicWrite(item.path, item.bytes, undefined, plan);
      } catch { /* Restore only a path still owned by this cleanup or a path that remains missing. */ }
    }
    throw error;
  }
}
