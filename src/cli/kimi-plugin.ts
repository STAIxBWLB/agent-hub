import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface KimiPluginOptions { home: string; hookScript: string; launchId: string; replaceStale?: boolean; now?: number }
type JsonObject = Record<string, any>;
type Snapshot = { stat: Stats; bytes: Buffer };
type Target = { path: string; next: Buffer; before?: Snapshot };
type Plan = { root: string; managed: string; installed: string; record?: JsonObject; targets: Target[]; changed: boolean };

const EVENTS = ["TurnStarted", "Stop", "StopFailure", "Interrupt", "SessionEnd", "TaskStarted", "Notification"] as const;
const ID = "agent-hub";
const MAX_INSTALLED = 1024 * 1024;
const MAX_HOOK = 8 * 1024 * 1024;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const directory = (path: string, required = true) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${path} must be a plain directory`);
  if (!stat && required) throw new Error(`${path} must exist`);
  return stat;
};
function file(path: string, cap: number): Snapshot | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > cap) throw new Error(`${path} must be a bounded regular file`);
  return { stat, bytes: readFileSync(path) };
}
function parse(value: Snapshot | undefined, name: string): JsonObject | undefined {
  if (!value) return undefined;
  try {
    const row = JSON.parse(value.bytes.toString("utf8"));
    if (!object(row)) throw new Error("not an object");
    return row;
  } catch { throw new Error(`${name} is not valid JSON`); }
}
function atomic(path: string, bytes: Buffer, before: Stats | undefined): void {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (before ? !current || current.dev !== before.dev || current.ino !== before.ino : current) throw new Error(`${path} changed before its managed write`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* rename consumed it */ }
  }
}
function removeFile(path: string, expected: Buffer): void {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !readFileSync(path).equals(expected)) return;
  unlinkSync(path);
}
function manifest(): JsonObject {
  return { name: ID, version: "1.0.0", description: "Managed by the ahub kimi launcher for this launch only.", hooks: EVENTS.map(event => ({ event, command: `bun ./kimi-hook.js ${event}`, timeout: 5 })) };
}
function plan(options: KimiPluginOptions): Plan {
  if (!isAbsolute(options.home) || !isAbsolute(options.hookScript) || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.launchId)) throw new Error("Kimi home, hook bundle and launch identity must be valid");
  directory(options.home);
  const hook = file(options.hookScript, MAX_HOOK);
  if (!hook) throw new Error("Kimi hook bundle is missing");
  const root = join(options.home, "plugins"), managed = join(root, "managed", ID), installed = join(root, "installed.json");
  const installedBefore = file(installed, MAX_INSTALLED), document = parse(installedBefore, installed);
  if (document && (document.version !== 1 || !Array.isArray(document.plugins))) throw new Error(`${installed} has an unsupported shape`);
  const records = document?.plugins ?? [];
  if (records.some((row: unknown) => !object(row))) throw new Error(`${installed} has an invalid plugin row`);
  const record = records.find((row: JsonObject) => row.id === ID);
  if (record && (record.root !== managed || record.source !== "local-path" || record.origin !== "custom" || record.enabled !== true || typeof record.originalSource !== "string"
    || record.agentHubLaunch !== options.launchId && options.replaceStale !== true)) {
    throw new Error("Kimi's agent-hub plugin belongs to another launch or is disabled; it was not changed");
  }
  const manifestBefore = file(join(managed, "kimi.plugin.json"), MAX_INSTALLED), hookBefore = file(join(managed, "kimi-hook.js"), MAX_HOOK);
  const nextManifest = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`);
  const now = new Date(options.now ?? Date.now()).toISOString();
  const changed = !record || record.agentHubLaunch !== options.launchId || !manifestBefore?.bytes.equals(nextManifest) || !hookBefore?.bytes.equals(hook.bytes) || record.originalSource !== dirname(options.hookScript);
  const nextRecord = {
    id: ID, root: managed, source: "local-path", origin: "custom", enabled: true,
    installedAt: typeof record?.installedAt === "string" ? record.installedAt : now,
    updatedAt: changed ? now : typeof record?.updatedAt === "string" ? record.updatedAt : now,
    originalSource: dirname(options.hookScript), agentHubLaunch: options.launchId,
  };
  const nextDocument = { version: 1, plugins: [...records.filter((row: JsonObject) => row.id !== ID), nextRecord] };
  return { root, managed, installed, ...(record ? { record } : {}), changed,
    targets: [
      { path: join(managed, "kimi.plugin.json"), next: nextManifest, ...(manifestBefore ? { before: manifestBefore } : {}) },
      { path: join(managed, "kimi-hook.js"), next: hook.bytes, ...(hookBefore ? { before: hookBefore } : {}) },
      { path: installed, next: Buffer.from(`${JSON.stringify(nextDocument, null, 2)}\n`), ...(installedBefore ? { before: installedBefore } : {}) },
    ] };
}

export function kimiPluginPreview(home: string, hookScript: string): { file: string; changed: true; action: string } {
  if (!isAbsolute(home) || !isAbsolute(hookScript)) throw new Error("Kimi home and hook bundle must be absolute paths");
  directory(home, false);
  if (!file(hookScript, MAX_HOOK)) throw new Error("Kimi hook bundle is missing");
  return { file: join(home, "plugins", "managed", ID), changed: true, action: "install the launch-scoped native completion plugin and remove it on exit" };
}

export function kimiPluginPlan(options: KimiPluginOptions): { file: string; changed: boolean; action: string } {
  const current = plan(options);
  return { file: current.managed, changed: current.changed, action: current.changed ? "create or update the launch-scoped Kimi plugin" : "keep the launch-scoped Kimi plugin" };
}

export function ensureKimiPlugin(options: KimiPluginOptions): { changed: boolean } {
  const current = plan(options);
  if (!current.changed) return { changed: false };
  for (const path of [join(options.home, "plugins"), join(options.home, "plugins", "managed"), current.managed]) {
    if (!directory(path, false)) mkdirSync(path, { mode: 0o700 });
  }
  for (const target of current.targets) atomic(target.path, target.next, target.before?.stat);
  return { changed: true };
}

export function cleanupKimiPlugin(options: KimiPluginOptions): void {
  const current = plan({ ...options, replaceStale: false });
  const installedBefore = file(current.installed, MAX_INSTALLED), document = parse(installedBefore, current.installed);
  const records = document?.plugins;
  if (!document || !Array.isArray(records) || records.some((row: unknown) => !object(row))) throw new Error(`${current.installed} changed during the launch`);
  const record = records.find((row: JsonObject) => row.id === ID);
  if (!record) return;
  if (record.root !== current.managed || record.enabled !== true) throw new Error("Kimi's agent-hub plugin changed during the launch; leaving it installed");
  const next = { version: 1, plugins: records.filter((row: JsonObject) => row.id !== ID) };
  atomic(current.installed, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), installedBefore?.stat);
  const [manifestTarget, hookTarget] = current.targets;
  removeFile(join(current.managed, "kimi.plugin.json"), manifestTarget!.next);
  removeFile(join(current.managed, "kimi-hook.js"), hookTarget!.next);
  try { rmdirSync(current.managed); } catch { /* foreign or changed files stay */ }
}
