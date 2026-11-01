import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyPackage } from "../cli/recovery-package.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { hubHome, realPath } from "./project.ts";
import { readProjectRuntime } from "./project-runtime-state.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "./registry.ts";

export interface RuntimeCapturePrunePlan { remove: string[]; kept: string[]; deferred?: string }
export interface RuntimeCapturePruneResult { removed: string[]; kept: string[]; deferred?: string }
interface Capture { root: string; version: string; digest: string; dev: number; ino: number; modified: number }
interface ManagerOwner { slot: number; instance_id: string; pid: number; signature: string | null }
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CAPTURE = /^source-([a-f0-9]{64})$/;
const OPERATION = /^[a-f0-9-]{36}\.json$/;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
function fail(reason: string): never { throw new Error(reason); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const pathValue = (value: unknown): string => {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes(String.fromCharCode(0))) return fail("runtime reference path is invalid");
  try { return realPath(value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(value);
  }
};
function optionalInfo(file: string) {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
function directory(file: string): boolean {
  const info = optionalInfo(file);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("runtime retention inventory contains a non-directory or symlink");
  return true;
}
function metadata(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_METADATA_BYTES) fail("runtime retention metadata is unreadable or oversized");
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (count > MAX_METADATA_BYTES || count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      fail("runtime retention metadata changed or exceeded its bound");
    try { return JSON.parse(bytes.subarray(0, count).toString("utf8")); } catch { return fail("runtime retention metadata is invalid"); }
  } finally { closeSync(fd); }
}
/** A legacy or mismatched active owner has no safely attributable package reference. */
function managerRuntimeRoot(home: string): string | undefined {
  const manager = join(home, "manager");
  if (!directory(manager)) return undefined;
  const manifestFile = join(manager, "status.json"), ownerFile = join(manager, "owner.db"), ownerInfo = optionalInfo(ownerFile);
  const manifest = optionalInfo(manifestFile) ? metadata(manifestFile) : undefined;
  if (manifest !== undefined && (!object(manifest) || typeof manifest.instanceId !== "string" || !manifest.instanceId
    || !Number.isSafeInteger(manifest.pid) || (manifest.pid as number) < 1
    || manifest.pidSignature !== undefined && typeof manifest.pidSignature !== "string")) fail("manager manifest runtime identity is invalid");
  let owner: ManagerOwner | undefined;
  if (ownerInfo) {
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) fail("manager ownership inventory is unreadable");
    const db = new Database(ownerFile, { readonly: true });
    try {
      db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
      const signed = (db.query("PRAGMA table_info(owner)").all() as { name: string }[]).some(column => column.name === "signature");
      const rows = db.query(`SELECT slot, instance_id, pid, ${signed ? "signature" : "NULL AS signature"} FROM owner LIMIT 2`).all() as ManagerOwner[];
      if (rows.length > 1 || rows.some(row => row.slot !== 1 || typeof row.instance_id !== "string" || !row.instance_id
        || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.signature !== null && typeof row.signature !== "string")) fail("manager ownership runtime identity is invalid");
      owner = rows[0];
    } finally { db.close(); }
  }
  const ownerLive = !!owner && processLiveness(owner.pid, owner.signature) !== "gone";
  const manifestLive = object(manifest) && processLiveness(manifest.pid as number, manifest.pidSignature as string | undefined) !== "gone";
  if (!ownerLive && !manifestLive) return undefined;
  if (!owner || !object(manifest) || !ownerLive || !manifestLive || owner.instance_id !== manifest.instanceId || owner.pid !== manifest.pid
    || owner.signature !== null && owner.signature !== manifest.pidSignature) fail("live or uncertain manager runtime identity is missing or mismatched");
  const root = pathValue(manifest.runtimeRoot);
  if (root !== manifest.runtimeRoot || !directory(root)) fail("live or uncertain manager runtime root is unavailable");
  return root;
}
function retainedRoots(home: string, registry: Registry): Set<string> {
  const roots = new Set<string>();
  for (const project of registry.list()) {
    if (typeof project.id !== "string" || !project.id || !isAbsolute(project.root) || !isAbsolute(project.stateDir)
      || project.instanceId !== null && (typeof project.instanceId !== "string" || !project.instanceId)
      || project.pid !== null && (!Number.isSafeInteger(project.pid) || project.pid < 1)) fail("project registry runtime inventory is invalid");
    const runtime = readProjectRuntime(project);
    if (runtime) roots.add(pathValue(runtime.root));
    const active = project.instanceId !== null && (project.pid === null || processLiveness(project.pid, project.pidSignature) !== "gone");
    if (active && (!runtime || runtime.instanceId !== project.instanceId)) fail("a live or uncertain project has no matching retained runtime identity");
    if (!project.instanceId && optionalInfo(join(project.stateDir, "status.json"))) {
      const status = metadata(join(project.stateDir, "status.json"));
      if (!object(status) || !Number.isSafeInteger(status.pid) || (status.pid as number) < 1) fail("legacy daemon runtime identity is unknown");
      if (processLiveness(status.pid as number, typeof status.pidSignature === "string" ? status.pidSignature : undefined) !== "gone")
        fail("a live or uncertain legacy daemon has no registry-bound runtime identity");
    }
  }
  // A lock without a readable, settled operation is never evidence that staging is finished.
  if (optionalInfo(join(home, "recovery.lock"))) fail("recovery coordination is present");
  const recovery = join(home, "recovery");
  if (!directory(recovery)) return roots;
  const locks = join(recovery, "project-locks.db"), lockInfo = optionalInfo(locks);
  if (lockInfo) {
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) fail("project recovery coordination is unreadable");
    const db = new Database(locks, { readonly: true });
    try {
      db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
      if (db.query("SELECT 1 FROM project_locks LIMIT 1").get()) fail("project recovery coordination is present");
    }
    finally { db.close(); }
  }
  for (const entry of readdirSync(recovery, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!OPERATION.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) fail("recovery receipt inventory is invalid");
    const record = metadata(join(recovery, entry.name));
    if (!object(record) || ![1, 2, 3].includes(record.schema as number) || `${record.id}.json` !== entry.name
      || !["pending", "running", "blocked", "completed", "cancelled"].includes(record.phase as string)) fail("recovery receipt inventory is invalid");
    if (record.phase !== "completed" && record.phase !== "cancelled") fail("a retained recovery operation is not terminal");
    if (!object(record.plan) || !Array.isArray(record.plan.projects) || !Array.isArray(record.projects)
      || record.plan.projects.length !== record.projects.length || !["restart", "upgrade"].includes(record.plan.kind as string)
      || typeof record.plan.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.plan.sourceDigest)) fail("retained recovery runtime references are incomplete");
    roots.add(pathValue(record.sourceRoot)); roots.add(pathValue(record.plan.sourceRoot));
    if (record.targetRoot !== undefined) {
      if (typeof record.targetDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.targetDigest)) fail("retained recovery target identity is incomplete");
      roots.add(pathValue(record.targetRoot));
    } else if (record.phase === "completed" || record.targetDigest !== undefined) fail("retained recovery target identity is incomplete");
  }
  return roots;
}
function eligibleCaptures(home: string): Capture[] {
  const releases = join(home, "releases"), captures: Capture[] = [];
  if (!directory(releases)) return captures;
  for (const version of readdirSync(releases, { withFileTypes: true })) {
    if (VERSION.exec(version.name)?.[0] !== version.name || !version.isDirectory() || version.isSymbolicLink()) continue;
    const versionRoot = join(releases, version.name);
    for (const entry of readdirSync(versionRoot, { withFileTypes: true })) {
      const match = CAPTURE.exec(entry.name);
      if (!match || match[0] !== entry.name || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = join(versionRoot, entry.name), info = lstatSync(root), digest = match[1]!;
      if (verifyPackage(root, version.name, { ownDependencies: true }) !== digest) fail("a runtime capture failed identity or digest verification");
      const allowed = new Set(["src", "plugins", "templates", ".claude-plugin", "package.json", "README.md", "LICENSE", "CHANGELOG.md", "node_modules"]);
      if (readdirSync(root).some(name => !allowed.has(name) || lstatSync(join(root, name)).isSymbolicLink())) fail("a runtime capture contains an unknown layout");
      const modules = join(root, "node_modules");
      if (optionalInfo(modules)) {
        if (!directory(modules) || readdirSync(modules).some(name => name !== "@staix")) fail("a runtime capture contains unknown dependencies");
        const scope = join(modules, "@staix"), memory = join(scope, "agent-mem");
        if (!directory(scope) || readdirSync(scope).some(name => name !== "agent-mem") || !directory(memory)
          || readdirSync(memory).some(name => !["src", "bin", "package.json", "README.md", "LICENSE"].includes(name))) fail("a runtime capture contains unknown dependencies");
      }
      captures.push({ root, version: version.name, digest, dev: info.dev, ino: info.ino, modified: info.mtimeMs });
    }
  }
  return captures;
}
function planLocked(home: string, registry: Registry, keepNewest: number): { plan: RuntimeCapturePrunePlan; captures: Capture[] } {
  if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) fail("runtime capture retention must be a nonnegative integer");
  const roots = retainedRoots(home, registry), managerRoot = managerRuntimeRoot(home), captures = eligibleCaptures(home), protectedCaptures = new Set<string>();
  const contains = (parent: string, child: string) => { const inside = relative(parent, child); return inside === "" || inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside); };
  const executingRoot = realPath(resolve(import.meta.dir, "../.."));
  if (captures.some(capture => contains(capture.root, executingRoot))) roots.add(executingRoot);
  if (managerRoot && captures.some(capture => contains(capture.root, managerRoot))) roots.add(managerRoot);
  for (const capture of captures) {
    if ([...roots].some(root => contains(capture.root, root) || contains(root, capture.root))) protectedCaptures.add(capture.root);
  }
  for (const version of new Set(captures.map(row => row.version))) {
    const newest = captures.filter(row => row.version === version).sort((a, b) => b.modified - a.modified || a.root.localeCompare(b.root)).slice(0, keepNewest);
    for (const capture of newest) protectedCaptures.add(capture.root);
  }
  return { plan: { remove: captures.filter(row => !protectedCaptures.has(row.root)).map(row => row.root), kept: captures.filter(row => protectedCaptures.has(row.root)).map(row => row.root) }, captures };
}
function withRegistry<T>(home: string, run: (home: string, registry: Registry) => T): T {
  if (!directory(home)) fail("runtime retention home is unavailable");
  const canonical = realPath(home), file = join(canonical, "registry.db"), info = optionalInfo(file);
  if (!info || !info.isFile() || info.isSymbolicLink()) fail("runtime retention registry inventory is unavailable");
  const registry = new Registry(file);
  try { return registry.runtimeCaptureLocked(() => run(canonical, registry)); }
  finally { registry.close(); }
}
const deferred = (error: unknown): string => `runtime capture pruning deferred: ${error instanceof Error ? error.message : "inventory unavailable"}`;

/** A preview grants no later deletion authority; execution always inventories again under the writer lock. */
export function planRuntimeCapturePrune(home = hubHome(), keepNewest = 3): RuntimeCapturePrunePlan {
  try { return withRegistry(home, (canonical, registry) => planLocked(canonical, registry, keepNewest).plan); }
  catch (error) { return { remove: [], kept: [], deferred: deferred(error) }; }
}

/** Delete only verified versioned source captures after a complete, stable reference inventory. */
export function pruneRuntimeCaptures(home = hubHome(), keepNewest = 3): RuntimeCapturePruneResult {
  const removed: string[] = [];
  try {
    return withRegistry(home, (canonical, registry) => {
      const { plan, captures } = planLocked(canonical, registry, keepNewest);
      for (const root of plan.remove) {
        const capture = captures.find(row => row.root === root)!, current = lstatSync(root);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== capture.dev || current.ino !== capture.ino
          || verifyPackage(root, capture.version, { ownDependencies: true }) !== capture.digest) fail("runtime capture changed before pruning");
        rmSync(root, { recursive: true }); removed.push(root);
      }
      return { removed, kept: plan.kept };
    });
  } catch (error) { return { removed, kept: [], deferred: deferred(error) }; }
}
