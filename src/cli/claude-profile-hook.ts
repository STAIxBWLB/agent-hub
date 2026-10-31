import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalJson } from "../hub/packs.ts";
import { factsHook } from "./facts-hook.ts";
import { shellQuote } from "./shell-quote.ts";
import type { ClaudeHome } from "./claude-homes.ts";

export interface ClaudeProfileHookOptions { script?: string; runtime?: string }
export interface ClaudeProfileHookCheck { state: "installed" | "missing" | "refused"; reason: string }
export interface ClaudeProfileHookInstall extends ClaudeProfileHookCheck { changed: boolean }
const MAX_SETTINGS_BYTES = 1024 * 1024;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const owned = (info: Stats) => !!process.getuid && info.uid === process.getuid() && (info.mode & 0o022) === 0;
const same = (left: Stats | undefined, right: Stats | undefined) => !left && !right || !!left && !!right && left.dev === right.dev && left.ino === right.ino;

interface HookPlan {
  check: ClaudeProfileHookCheck;
  file: string;
  next?: string;
  home?: Stats;
  parent?: Stats;
  source?: { info: Stats; digest: string };
}

function hookEntry(options: ClaudeProfileHookOptions): Record<string, unknown> {
  const script = options.script ?? join(import.meta.dir, "claude-profile-hook.ts"), runtime = options.runtime ?? process.execPath;
  if (!validPath(script) || !validPath(runtime)) throw new Error("invalid profile hook command");
  return { matcher: "*", hooks: [{ type: "command", command: `${shellQuote(runtime)} ${shellQuote(script)} --run`, timeout: 5 }] };
}

function settingsSource(file: string): { value: Record<string, unknown>; source?: HookPlan["source"] } {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !owned(info) || info.size > MAX_SETTINGS_BYTES) throw new Error("unsafe settings");
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_SETTINGS_BYTES) throw new Error("oversized settings");
    const content = bytes.subarray(0, count), value: unknown = JSON.parse(content.toString("utf8"));
    if (!object(value)) throw new Error("invalid settings");
    return { value, source: { info, digest: createHash("sha256").update(content).digest("hex") } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {} };
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** A shared read-only plan keeps inspection and installation's refusal rules identical. */
function planClaudeProfileHook(home: ClaudeHome, options: ClaudeProfileHookOptions): HookPlan {
  const file = validPath(home.path) ? join(home.path, "settings.json") : "";
  const refuse = (reason: string): HookPlan => ({ file, check: { state: "refused", reason } });
  if (!file || !home.sources.length || home.sources.some(source => !["environment", "default", "recorded-launch"].includes(source))) return refuse("No explicitly selected Claude configuration home is available.");
  try {
    const directory = lstatSync(home.path, { throwIfNoEntry: false });
    let parent: Stats | undefined;
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory))) return refuse("The selected Claude home is unsafe or not owned by this user.");
    if (!directory) {
      if (home.exists && !home.sources.some(source => source === "environment" || source === "recorded-launch")) return refuse("The previously observed default Claude home is no longer present.");
      parent = lstatSync(dirname(home.path), { throwIfNoEntry: false });
      if (!parent?.isDirectory() || parent.isSymbolicLink() || !owned(parent)) return refuse("The selected Claude home's parent is unsafe or unavailable.");
    }
    const { value, source } = settingsSource(file);
    if (value.disableAllHooks === true) return refuse("Claude has disableAllHooks enabled; the profile hook cannot be installed.");
    if (value.disableAllHooks !== undefined && typeof value.disableAllHooks !== "boolean") return refuse("Claude's hook enablement setting is malformed.");
    if (value.hooks !== undefined && !object(value.hooks)) return refuse("Claude's hook configuration is malformed.");
    const hooks = value.hooks ?? {}, existing = hooks.PreToolUse ?? [];
    if (!Array.isArray(existing)) return refuse("Claude's PreToolUse hook list is malformed.");
    const entry = hookEntry(options), expected = canonicalJson(entry);
    const matches = existing.filter(candidate => canonicalJson(candidate) === expected).length;
    const next = matches === 1 ? undefined : `${JSON.stringify({ ...value, hooks: { ...hooks, PreToolUse: [...existing.filter(candidate => canonicalJson(candidate) !== expected), entry] } }, null, 2)}\n`;
    if (next !== undefined && Buffer.byteLength(next, "utf8") > MAX_SETTINGS_BYTES) return refuse("Claude's settings would exceed the bounded profile settings size.");
    return { file, home: directory, parent, source, next, check: matches === 1
      ? { state: "installed", reason: "The project-neutral profile hook is configured; this does not prove live permission enforcement." }
      : { state: "missing", reason: matches ? "Duplicate managed profile hooks need normalization." : "The project-neutral profile hook is not configured." } };
  } catch { return refuse("Claude profile settings could not be safely inspected; no settings were changed."); }
}

export function checkClaudeProfileHook(home: ClaudeHome, options: ClaudeProfileHookOptions = {}): ClaudeProfileHookCheck {
  return planClaudeProfileHook(home, options).check;
}

/** Only the selected home is created; unrelated profile directories and settings are never touched. */
export function installClaudeProfileHook(home: ClaudeHome, options: ClaudeProfileHookOptions = {}): ClaudeProfileHookInstall {
  const plan = planClaudeProfileHook(home, options);
  if (plan.check.state !== "missing" || plan.next === undefined) return { ...plan.check, changed: false };
  const temporary = join(home.path, `.agent-hub-profile-hook-${randomUUID()}.tmp`);
  let created: Stats | undefined;
  try {
    if (!plan.home) {
      const current = lstatSync(dirname(home.path));
      if (!same(plan.parent, current) || !owned(current)) throw new Error("parent changed");
      mkdirSync(home.path, { mode: 0o700 });
      created = lstatSync(home.path);
      if (!created.isDirectory() || created.isSymbolicLink() || !owned(created)) throw new Error("home changed");
    }
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let prepared: Stats;
    try { writeFileSync(fd, plan.next); fchmodSync(fd, 0o600); fsyncSync(fd); prepared = fstatSync(fd); }
    finally { closeSync(fd); }
    const current = planClaudeProfileHook(home, options);
    if (current.check.state === "refused" || !same(plan.home ?? created, current.home) || !same(plan.source?.info, current.source?.info) || plan.source?.digest !== current.source?.digest) throw new Error("settings changed");
    const named = lstatSync(temporary);
    if (!same(prepared, named) || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !owned(named)) throw new Error("temporary settings changed");
    renameSync(temporary, plan.file);
    return { state: "installed", changed: true, reason: "The project-neutral profile hook is configured; this does not prove live permission enforcement." };
  } catch { return { state: "refused", changed: false, reason: "Claude profile settings changed or could not be safely written; inspect the selected home before trying again." }; }
  finally { try { rmSync(temporary, { force: true }); } catch { /* Only this invocation's generated temporary name is considered. */ } }
}

export interface ClaudeProfileHookTarget { stateDir: string; peer: string }
export function claudeProfileHookTarget(env: NodeJS.ProcessEnv): ClaudeProfileHookTarget | undefined {
  if (Object.hasOwn(env, "AGENTHUB_LAUNCH_ID") || !validPath(env.AGENTHUB_STATE_DIR) || !/^[a-z][a-z0-9_-]{0,63}$/.test(env.AGENTHUB_PEER_ID ?? "")) return;
  return { stateDir: env.AGENTHUB_STATE_DIR, peer: env.AGENTHUB_PEER_ID! };
}
export type ClaudeProfileHookTransport = (input: string, stateDir: string, peer: string) => Promise<string | undefined>;
export async function runClaudeProfileHook(input: string, env: NodeJS.ProcessEnv, transport: ClaudeProfileHookTransport = factsHook): Promise<string | undefined> {
  const target = claudeProfileHookTarget(env);
  if (!target || Buffer.byteLength(input, "utf8") > MAX_SETTINGS_BYTES) return;
  try { return await transport(input, target.stateDir, target.peer); } catch { return; }
}

// Managed launches inject their own authoritative session hook; ordinary non-hub sessions have no target.
if (import.meta.main && process.argv.length === 3 && process.argv[2] === "--run" && claudeProfileHookTarget(process.env)) {
  try {
    const output = await runClaudeProfileHook(await Bun.stdin.text(), process.env);
    if (output) console.log(output);
  } catch { /* A profile hook never turns a transport failure into a native permission decision. */ }
}
