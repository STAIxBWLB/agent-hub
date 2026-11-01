import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, renameSync, rmSync, type Dirent, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyPackage } from "../cli/recovery-package.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";
import { childEnv } from "./child-process.ts";
import { hubHome, realPath } from "./project.ts";
import { readProjectRuntimeReference, projectRuntimeFile } from "./project-runtime-state.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "./registry.ts";

export interface RuntimeCapturePrunePlan { remove: string[]; kept: string[]; deferred?: string }
export interface RuntimeCapturePruneResult { removed: string[]; kept: string[]; quarantined?: string[]; deferred?: string }
interface Capture { root: string; version: string; digest: string; dev: number; ino: number; modified: number }
interface ManagerOwner { slot: number; instance_id: string; pid: number; signature: string | null }
interface Observation { files: Map<string, string | null>; lists: Map<string, string[]>; projects: string; roots: Set<string>; managerRoot?: string; bytes: number }
interface LockBudget { deadline: number; remaining: number }
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CAPTURE = /^source-([a-f0-9]{64})$/;
const OPERATION = /^[a-f0-9-]{36}\.json$/;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
// ponytail: larger inventories defer; upgrade to indexed/batched reference inventory, never larger lock/busy limits.
const MAX_PROJECTS = 128, MAX_RECEIPTS = 128, MAX_CAPTURE_ENTRIES = 512, MAX_REFERENCE_FILES = 512;
const LOCK_METADATA_MS = 250;
export const RUNTIME_PRUNE_MAX_BATCH = 3;
export const RUNTIME_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RUNTIME_PRUNE_ADMISSION_BUSY_TIMEOUT_MS = 1;
function fail(reason: string): never { throw new Error(reason); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stamp = (info: Stats | undefined): string | null => info ? JSON.stringify([info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs]) : null;
function tick(budget?: LockBudget): void {
  if (budget && (--budget.remaining < 0 || performance.now() > budget.deadline)) fail("runtime retention metadata lock budget exhausted");
}
function remember(observation: Observation | undefined, file: string, value: string | null): void {
  if (!observation) return;
  if (observation.files.has(file) && observation.files.get(file) !== value) fail("runtime reference metadata changed during observation");
  if (!observation.files.has(file) && observation.files.size >= MAX_REFERENCE_FILES) fail("runtime reference inventory exceeds its file bound");
  observation.files.set(file, value);
}
function optionalInfo(file: string, observation?: Observation, budget?: LockBudget): Stats | undefined {
  tick(budget);
  let info: Stats | undefined;
  try { info = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  remember(observation, file, stamp(info)); tick(budget); return info;
}
function directory(file: string, observation?: Observation): boolean {
  const info = optionalInfo(file, observation);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("runtime retention inventory contains a non-directory or symlink");
  return true;
}
function entries(directory: string, observation?: Observation, budget?: LockBudget): Dirent[] {
  const handle = opendirSync(directory), rows: Dirent[] = [];
  try {
    for (;;) {
      tick(budget);
      const entry = handle.readSync();
      if (!entry) break;
      if (rows.length >= MAX_CAPTURE_ENTRIES) fail("runtime retention directory inventory exceeds its bound");
      rows.push(entry);
    }
  } finally { handle.closeSync(); }
  if (observation) {
    const names = rows.map(row => row.name).sort();
    observation.lists.set(directory, names); optionalInfo(directory, observation);
  }
  return rows;
}
function metadata(file: string, observation: Observation): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_METADATA_BYTES || observation.bytes + info.size > MAX_INVENTORY_BYTES)
      fail("runtime retention metadata is unreadable or oversized");
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (count > MAX_METADATA_BYTES || count !== info.size || stamp(after) !== stamp(info)
      || stamp(optionalInfo(file)) !== stamp(after)) fail("runtime retention metadata changed or exceeded its bound");
    observation.bytes += count; remember(observation, file, stamp(after));
    try { return JSON.parse(bytes.subarray(0, count).toString("utf8")); } catch { return fail("runtime retention metadata is invalid"); }
  } finally { closeSync(fd); }
}
function canonicalReference(root: string, observation: Observation): string {
  const canonical = realPath(root); // process-backed platform resolution remains outside the registry writer lock
  const info = optionalInfo(root, observation);
  if (canonical !== root || !info?.isDirectory() || info.isSymbolicLink()) fail("runtime package reference is missing, linked or noncanonical");
  return root;
}
function observeDatabase<T>(file: string, observation: Observation, read: (db: Database) => T): T {
  const names = [file, `${file}-wal`], before = names.map(name => stamp(optionalInfo(name)));
  let value: T;
  const db = new Database(file, { readonly: true });
  try {
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    value = read(db);
  } finally { db.close(); }
  for (const [index, name] of names.entries()) {
    const after = stamp(optionalInfo(name));
    if (before[index] !== after) fail("runtime ownership database changed during observation");
    remember(observation, name, after);
  }
  return value;
}
function managerRuntimeRoot(home: string, observation: Observation): string | undefined {
  const manager = join(home, "manager");
  if (!directory(manager, observation)) return undefined;
  const manifestFile = join(manager, "status.json"), ownerFile = join(manager, "owner.db"), ownerInfo = optionalInfo(ownerFile, observation);
  const manifest = optionalInfo(manifestFile, observation) ? metadata(manifestFile, observation) : undefined;
  if (manifest !== undefined && (!object(manifest) || typeof manifest.instanceId !== "string" || !manifest.instanceId
    || !Number.isSafeInteger(manifest.pid) || (manifest.pid as number) < 1
    || manifest.pidSignature !== undefined && typeof manifest.pidSignature !== "string")) fail("manager manifest runtime identity is invalid");
  let owner: ManagerOwner | undefined;
  if (ownerInfo) {
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) fail("manager ownership inventory is unreadable");
    owner = observeDatabase(ownerFile, observation, db => {
      const signed = (db.query("PRAGMA table_info(owner)").all() as { name: string }[]).some(column => column.name === "signature");
      const rows = db.query(`SELECT slot, instance_id, pid, ${signed ? "signature" : "NULL AS signature"} FROM owner LIMIT 2`).all() as ManagerOwner[];
      if (rows.length > 1 || rows.some(row => row.slot !== 1 || typeof row.instance_id !== "string" || !row.instance_id
        || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.signature !== null && typeof row.signature !== "string")) fail("manager ownership runtime identity is invalid");
      return rows[0];
    });
  }
  const ownerLive = !!owner && processLiveness(owner.pid, owner.signature) !== "gone";
  const manifestLive = object(manifest) && processLiveness(manifest.pid as number, manifest.pidSignature as string | undefined) !== "gone";
  if (!ownerLive && !manifestLive) return undefined;
  if (!owner || !object(manifest) || !ownerLive || !manifestLive || owner.instance_id !== manifest.instanceId || owner.pid !== manifest.pid
    || owner.signature !== null && owner.signature !== manifest.pidSignature) fail("live or uncertain manager runtime identity is missing or mismatched");
  if (typeof manifest.runtimeRoot !== "string" || !isAbsolute(manifest.runtimeRoot)) fail("manager runtime root is unavailable");
  return canonicalReference(manifest.runtimeRoot, observation);
}
/** Expensive process/SQLite/Git-independent reference observations happen without the registry writer lock. */
function observeReferences(home: string, registry: Registry): Observation {
  const projects = registry.list();
  if (projects.length > MAX_PROJECTS) fail("project runtime inventory exceeds its bound");
  const observation: Observation = { files: new Map(), lists: new Map(), projects: JSON.stringify(projects), roots: new Set(), bytes: 0 };
  for (const project of projects) {
    if (typeof project.id !== "string" || !project.id || !isAbsolute(project.root) || !isAbsolute(project.stateDir)
      || project.instanceId !== null && (typeof project.instanceId !== "string" || !project.instanceId)
      || project.pid !== null && (!Number.isSafeInteger(project.pid) || project.pid < 1)) fail("project registry runtime inventory is invalid");
    const file = projectRuntimeFile(project); optionalInfo(file, observation);
    const runtime = readProjectRuntimeReference(project); optionalInfo(file, observation);
    if (runtime) {
      const root = canonicalReference(runtime.root, observation), named = CAPTURE.exec(basename(root)), version = basename(dirname(root));
      if (named?.[0] === basename(root) && VERSION.exec(version)?.[0] === version && basename(dirname(dirname(root))) === "releases"
        && (named[1] !== runtime.digest || version !== runtime.version)) fail("project runtime capture path identity is inconsistent");
      observation.roots.add(root);
    }
    // Retain uncertain claims conservatively, rather than running one process probe per registry row under a writer lock.
    if (project.instanceId !== null && (!runtime || runtime.instanceId !== project.instanceId)) fail("a live or uncertain project has no matching retained runtime identity");
    if (!project.instanceId && optionalInfo(join(project.stateDir, "status.json"), observation)) {
      const status = metadata(join(project.stateDir, "status.json"), observation);
      if (!object(status) || !Number.isSafeInteger(status.pid) || (status.pid as number) < 1) fail("legacy daemon runtime identity is unknown");
      if (processLiveness(status.pid as number, typeof status.pidSignature === "string" ? status.pidSignature : undefined) !== "gone")
        fail("a live or uncertain legacy daemon has no registry-bound runtime identity");
    }
  }
  observation.managerRoot = managerRuntimeRoot(home, observation);
  if (optionalInfo(join(home, "recovery.lock"), observation)) fail("recovery coordination is present");
  const recovery = join(home, "recovery");
  if (!directory(recovery, observation)) return observation;
  const locks = join(recovery, "project-locks.db"), lockInfo = optionalInfo(locks, observation);
  if (lockInfo) {
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) fail("project recovery coordination is unreadable");
    observeDatabase(locks, observation, db => { if (db.query("SELECT 1 FROM project_locks LIMIT 1").get()) fail("project recovery coordination is present"); });
  }
  let receipts = 0;
  for (const entry of entries(recovery, observation)) {
    if (!entry.name.endsWith(".json")) continue;
    if (++receipts > MAX_RECEIPTS) fail("recovery receipt inventory exceeds its bound");
    if (OPERATION.exec(entry.name)?.[0] !== entry.name || !entry.isFile() || entry.isSymbolicLink()) fail("recovery receipt inventory is invalid");
    const record = metadata(join(recovery, entry.name), observation);
    if (!object(record) || ![1, 2, 3].includes(record.schema as number) || `${record.id}.json` !== entry.name
      || !["pending", "running", "blocked", "completed", "cancelled"].includes(record.phase as string)) fail("recovery receipt inventory is invalid");
    if (record.phase !== "completed" && record.phase !== "cancelled") fail("a retained recovery operation is not terminal");
    if (!object(record.plan) || !Array.isArray(record.plan.projects) || !Array.isArray(record.projects)
      || record.plan.projects.length !== record.projects.length || !["restart", "upgrade"].includes(record.plan.kind as string)
      || typeof record.plan.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.plan.sourceDigest)) fail("retained recovery runtime references are incomplete");
    const references = [record.sourceRoot, record.plan.sourceRoot];
    if (record.targetRoot !== undefined) references.push(record.targetRoot);
    for (const value of references) {
      if (typeof value !== "string" || !isAbsolute(value) || value.includes(String.fromCharCode(0))) fail("retained recovery runtime path is invalid");
      // A retired mutable install may be gone; its lexical path still cannot authorize deletion elsewhere.
      let root: string;
      try { root = realPath(value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; root = resolve(value); }
      observation.roots.add(root);
    }
    if (record.targetRoot !== undefined && (typeof record.targetDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.targetDigest))
      || record.targetRoot === undefined && (record.phase === "completed" || record.targetDigest !== undefined)) fail("retained recovery target identity is incomplete");
  }
  return observation;
}
function validateObservation(registry: Registry, observation: Observation, budget: LockBudget): void {
  tick(budget);
  if (JSON.stringify(registry.list()) !== observation.projects) fail("project runtime registry changed before pruning");
  for (const [file, expected] of observation.files) if (stamp(optionalInfo(file, undefined, budget)) !== expected) fail("runtime reference metadata changed before pruning");
  for (const [directory, expected] of observation.lists) if (JSON.stringify(entries(directory, undefined, budget).map(entry => entry.name).sort()) !== JSON.stringify(expected))
    fail("runtime reference directory changed before pruning");
  tick(budget);
}
function scanCaptures(home: string, budget: LockBudget): Capture[] {
  const releases = join(home, "releases"), captures: Capture[] = [];
  const info = optionalInfo(releases, undefined, budget);
  if (!info) return captures;
  if (!info.isDirectory() || info.isSymbolicLink()) fail("runtime release inventory is invalid");
  let count = 0;
  for (const version of entries(releases, undefined, budget)) {
    if (VERSION.exec(version.name)?.[0] !== version.name || !version.isDirectory() || version.isSymbolicLink()) continue;
    for (const entry of entries(join(releases, version.name), undefined, budget)) {
      if (++count > MAX_CAPTURE_ENTRIES) fail("runtime capture inventory exceeds its bound");
      const match = CAPTURE.exec(entry.name);
      if (!match || match[0] !== entry.name || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = join(releases, version.name, entry.name), stat = optionalInfo(root, undefined, budget)!;
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("runtime capture changed during metadata inventory");
      captures.push({ root, version: version.name, digest: match[1]!, dev: stat.dev, ino: stat.ino, modified: stat.mtimeMs });
    }
  }
  return captures;
}
const contains = (parent: string, child: string) => { const inside = relative(parent, child); return inside === "" || inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside); };
function select(captures: Capture[], observation: Observation, keepNewest: number): RuntimeCapturePrunePlan {
  const protectedRoots = new Set<string>(), roots = [...observation.roots], executingRoot = resolve(import.meta.dir, "../..");
  for (const root of [executingRoot, observation.managerRoot]) if (root && captures.some(capture => contains(capture.root, root))) roots.push(root);
  for (const capture of captures) if (roots.some(root => contains(capture.root, root) || contains(root, capture.root))) protectedRoots.add(capture.root);
  for (const version of new Set(captures.map(row => row.version))) for (const capture of captures.filter(row => row.version === version)
    .sort((a, b) => b.modified - a.modified || a.root.localeCompare(b.root)).slice(0, keepNewest)) protectedRoots.add(capture.root);
  const candidates = captures.filter(row => !protectedRoots.has(row.root)).sort((a, b) => a.modified - b.modified || a.root.localeCompare(b.root));
  const remove = candidates.slice(0, RUNTIME_PRUNE_MAX_BATCH).map(row => row.root);
  return { remove, kept: captures.filter(row => !remove.includes(row.root)).map(row => row.root) };
}
function lockedPlan(home: string, registry: Registry, observation: Observation, keepNewest: number): { plan: RuntimeCapturePrunePlan; captures: Capture[] } {
  return registry.runtimeCaptureLocked(() => {
    const budget = { deadline: performance.now() + LOCK_METADATA_MS, remaining: 2048 };
    validateObservation(registry, observation, budget);
    const captures = scanCaptures(home, budget), plan = select(captures, observation, keepNewest); tick(budget);
    return { plan, captures };
  });
}
function knownLayout(root: string, directories: readonly string[], files: readonly string[], optionalDirectories: readonly string[] = []): void {
  const names = readdirSync(root), allowed = new Set([...directories, ...files, ...optionalDirectories]);
  if ([...directories, ...files].some(name => !names.includes(name))) fail("a runtime capture known asset layout is incomplete");
  for (const name of names) {
    const info = lstatSync(join(root, name));
    if (!allowed.has(name) || info.isSymbolicLink() || (files.includes(name) ? !info.isFile() : !info.isDirectory())) fail("a runtime capture contains an unknown asset layout");
  }
}
function captureLayout(root: string): void {
  knownLayout(root, ["src", "plugins", "templates", ".claude-plugin"], ["package.json", "README.md", "LICENSE", "CHANGELOG.md"], ["node_modules"]);
  const modules = join(root, "node_modules");
  if (optionalInfo(modules)) {
    knownLayout(modules, ["@staix"], []); const scope = join(modules, "@staix"); knownLayout(scope, ["agent-mem"], []);
    knownLayout(join(scope, "agent-mem"), ["src", "bin"], ["package.json", "README.md", "LICENSE"]);
  }
}
function verifyQuarantine(root: string, capture: Capture): void {
  captureLayout(root);
  if (verifyPackage(root, capture.version, { ownDependencies: true }) !== capture.digest) fail("a runtime capture failed identity or digest verification");
}
function openRegistry(home: string): { home: string; registry: Registry } {
  if (!directory(home)) fail("runtime retention home is unavailable");
  const canonical = realPath(home), info = optionalInfo(join(canonical, "registry.db"));
  if (!info?.isFile() || info.isSymbolicLink()) fail("runtime retention registry inventory is unavailable");
  return { home: canonical, registry: new Registry(join(canonical, "registry.db")) };
}
const deferred = (error: unknown): string => `runtime capture pruning deferred: ${error instanceof Error ? error.message : "inventory unavailable"}`;
function checkRetention(keepNewest: number): void { if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) fail("runtime capture retention must be a nonnegative integer"); }

/** Metadata preview only; execution always refreshes reference observations before quarantining each candidate. */
export function planRuntimeCapturePrune(home = hubHome(), keepNewest = 3): RuntimeCapturePrunePlan {
  let registry: Registry | undefined;
  try {
    checkRetention(keepNewest); const opened = openRegistry(home); registry = opened.registry;
    return lockedPlan(opened.home, registry, observeReferences(opened.home, registry), keepNewest).plan;
  } catch (error) { return { remove: [], kept: [], deferred: deferred(error) }; }
  finally { registry?.close(); }
}
/** Only the atomic rename is locked. Hashing and recursive removal operate on the reserved quarantine outside it. */
export function pruneRuntimeCaptures(home = hubHome(), keepNewest = 3): RuntimeCapturePruneResult {
  const removed: string[] = [], quarantined: string[] = []; let kept: string[] = [], registry: Registry | undefined;
  try {
    checkRetention(keepNewest); const opened = openRegistry(home); registry = opened.registry; home = opened.home;
    const initial = lockedPlan(home, registry, observeReferences(home, registry), keepNewest); kept = initial.plan.kept;
    // Reject unknown layouts across the small batch before moving any entry; no package contents are hashed here.
    for (const root of initial.plan.remove) captureLayout(root);
    for (const original of initial.plan.remove) {
      const candidate = initial.captures.find(row => row.root === original)!;
      const observation = observeReferences(home, registry);
      const quarantine = registry.runtimeCaptureLocked(() => {
        const budget = { deadline: performance.now() + LOCK_METADATA_MS, remaining: 2048 };
        validateObservation(registry!, observation, budget);
        const fresh = select(scanCaptures(home, budget), observation, keepNewest); tick(budget);
        if (!fresh.remove.includes(candidate.root)) { kept = [...new Set([...kept, candidate.root])]; return undefined; }
        const info = optionalInfo(candidate.root, undefined, budget);
        if (!info?.isDirectory() || info.isSymbolicLink() || info.dev !== candidate.dev || info.ino !== candidate.ino) fail("runtime capture changed before quarantine");
        const root = join(dirname(candidate.root), `.runtime-prune-${randomUUID()}`); tick(budget);
        mkdirSync(root, { mode: 0o700 }); quarantined.push(root);
        const container = lstatSync(root), target = join(root, "capture");
        renameSync(candidate.root, target);
        return { root, target, dev: container.dev, ino: container.ino };
      });
      if (!quarantine) continue;
      const before = lstatSync(quarantine.target);
      if (before.dev !== candidate.dev || before.ino !== candidate.ino || !before.isDirectory() || before.isSymbolicLink()) fail("runtime quarantine identity changed");
      verifyQuarantine(quarantine.target, candidate);
      const container = lstatSync(quarantine.root), after = lstatSync(quarantine.target), names = readdirSync(quarantine.root);
      if (container.dev !== quarantine.dev || container.ino !== quarantine.ino || !container.isDirectory() || container.isSymbolicLink()
        || names.length !== 1 || names[0] !== "capture" || after.dev !== candidate.dev || after.ino !== candidate.ino || !after.isDirectory() || after.isSymbolicLink())
        fail("runtime quarantine identity changed before removal");
      rmSync(quarantine.root, { recursive: true }); quarantined.pop(); removed.push(candidate.root);
    }
    return { removed, kept };
  } catch (error) { return { removed, kept, ...(quarantined.length ? { quarantined } : {}), deferred: deferred(error) }; }
  finally { registry?.close(); }
}

interface Admission { slot: number; id: string; admitted_at: number; phase: "scheduled" | "running" | "complete"; pid: number | null; signature: string | null }
function admissionFile(home: string): { file: string; fresh: boolean } {
  const file = join(home, "runtime-prune.db");
  if (!directory(home)) fail("runtime maintenance admission state is unavailable");
  let fresh = false;
  try { const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); fresh = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = optionalInfo(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) fail("runtime maintenance admission state is unavailable");
  return { file, fresh };
}
function prepareAdmissionDatabase(db: Database, fresh: boolean): void {
  db.transaction(() => {
    if (fresh) db.run("CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT, signature TEXT)");
    const tables = db.query("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all() as { name: string; type: string }[];
    const columns = db.query("PRAGMA table_info(admission)").all() as { name: string }[];
    if (tables.length !== 1 || tables[0]?.name !== "admission" || tables[0]?.type !== "table") fail("runtime maintenance admission schema is invalid");
    const shape = columns.map(column => column.name).join(",");
    if (shape === "slot,id,admitted_at,phase,pid,outcome") db.run("ALTER TABLE admission ADD COLUMN signature TEXT");
    else if (shape !== "slot,id,admitted_at,phase,pid,outcome,signature") fail("runtime maintenance admission schema is invalid");
  }).immediate();
}
function startupAdmissionDatabase(home: string): Database {
  const { file, fresh } = admissionFile(home);
  const db = new Database(file, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${RUNTIME_PRUNE_ADMISSION_BUSY_TIMEOUT_MS}`);
    prepareAdmissionDatabase(db, fresh); return db;
  } catch (error) { db.close(); throw error; }
}
function workerAdmissionDatabase(home: string): Database {
  const { file, fresh } = admissionFile(home);
  const db = new Database(file, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    prepareAdmissionDatabase(db, fresh); return db;
  } catch (error) { db.close(); throw error; }
}
function admissionRow(db: Database): Admission | undefined {
  const rows = db.query("SELECT slot,id,admitted_at,phase,pid,signature FROM admission LIMIT 2").all() as Admission[];
  if (rows.length > 1 || rows.some(row => row.slot !== 1 || typeof row.id !== "string" || !/^[a-f0-9-]{36}$/.exec(row.id)?.[0] || row.id.length !== 36
    || !Number.isSafeInteger(row.admitted_at) || row.admitted_at < 0 || !["scheduled", "running", "complete"].includes(row.phase)
    || row.pid !== null && (!Number.isSafeInteger(row.pid) || row.pid < 1)
    || row.signature !== null && (typeof row.signature !== "string" || !row.signature.trim() || Buffer.byteLength(row.signature) > 1024))) fail("runtime maintenance admission state is invalid");
  return rows[0];
}
function admitSchedule(home: string): string | undefined {
  const db = startupAdmissionDatabase(home);
  try {
    return db.transaction(() => {
      const previous = admissionRow(db), now = Date.now();
      const dead = previous?.phase === "running" && previous.pid !== null && previous.signature !== null
        && processLiveness(previous.pid, previous.signature) === "gone";
      if (previous && (previous.phase === "running" && !dead || !dead && now - previous.admitted_at < RUNTIME_PRUNE_INTERVAL_MS)) return undefined;
      const id = randomUUID();
      db.query("INSERT OR REPLACE INTO admission(slot,id,admitted_at,phase,pid,outcome,signature) VALUES(1,?,?,'scheduled',NULL,NULL,NULL)").run(id, now);
      return id;
    }).immediate();
  } finally { db.close(); }
}
const pendingSchedules = new Set<string>();
/** Startup resolves before this O(1) admission attempt; contention defers without Registry's long busy wait. */
export function scheduleRuntimeCapturePrune(home?: string): void {
  const inheritedHome = process.env.AGENTHUB_HOME, key = home ?? inheritedHome ?? "default";
  if (pendingSchedules.has(key)) return;
  pendingSchedules.add(key);
  setImmediate(() => {
    try {
      const targetHome = home ?? hubHome({ AGENTHUB_HOME: inheritedHome });
      const id = admitSchedule(targetHome); if (!id) return;
      const env = childEnv(process.env);
      for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || ["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CODEX_THREAD_ID"].includes(key)) delete env[key];
      env.AGENTHUB_HOME = targetHome;
      const worker = spawn(process.execPath, [import.meta.path, targetHome, id], { detached: true, stdio: "ignore", env });
      worker.on("error", () => {}); worker.unref();
    } catch { /* Unknown or contended admission does not affect startup and grants no worker. */ }
    finally { pendingSchedules.delete(key); }
  });
}
function runScheduledWorker(home: string, id: string): void {
  const signature = processSignature(process.pid);
  if (!signature) fail("runtime maintenance worker process identity is unavailable");
  const db = workerAdmissionDatabase(home);
  try {
    const admitted = db.transaction(() => {
      const row = admissionRow(db); if (row?.id !== id || row.phase !== "scheduled") return false;
      db.query("UPDATE admission SET phase='running',pid=?,signature=? WHERE slot=1 AND id=? AND phase='scheduled'").run(process.pid, signature, id); return true;
    }).immediate();
    if (!admitted) return;
    const result = pruneRuntimeCaptures(home), outcome = JSON.stringify({ removed: result.removed.length, quarantined: (result.quarantined ?? []).map(root => relative(home, root)), ...(result.deferred ? { deferred: result.deferred.slice(0, 512) } : {}) });
    if (Buffer.byteLength(outcome) > 16384) fail("runtime maintenance outcome exceeds its bound");
    db.query("UPDATE admission SET phase='complete',outcome=? WHERE slot=1 AND id=? AND phase='running'").run(outcome, id);
  } finally { db.close(); }
}
if (import.meta.main) {
  const [home, id] = process.argv.slice(2);
  try { if (!home || !isAbsolute(home) || !id || !/^[a-f0-9-]{36}$/.test(id)) fail("runtime maintenance worker identity is invalid"); runScheduledWorker(home, id); }
  catch { process.exitCode = 1; }
}
