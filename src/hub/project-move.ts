import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { processLiveness } from "../pi/process-signature.ts";
import { projectRoot, realPath } from "./project.ts";
import { assertHubDbCompatible } from "./db-schema.ts";
import { parseProjectRuntime } from "./project-runtime-state.ts";
import { recoveryLock } from "./recovery-store.ts";
import { idFor, type Project, type Registry } from "./registry.ts";

type Rewrite = { table: string; column: string; count: number; root?: true };
type Store = { project: Project; file: string; rewrites: Rewrite[]; pending: boolean };
type Marker = { file: string; before: string; after?: string };
type Backup = { file: string; backup: string; database: boolean };
type MoveJournal = { before: string; after: string; backups: Backup[] };

const journalPath = (registry: Registry): string => join(dirname(registry.path), "project-move.pending.json");
const ident = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
const fileOrMissing = (file: string): boolean => {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${file} must be a regular unlinked state file`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

function sync(file: string): void {
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function replaceFile(file: string, write: (temporary: string) => void): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    write(temporary);
    sync(temporary);
    renameSync(temporary, file);
    sync(dirname(file));
  } finally { rmSync(temporary, { force: true }); }
}

function marker(file: string, old: Project, next: Project, runtime: boolean): Marker | undefined {
  if (!fileOrMissing(file)) return undefined;
  const before = readFileSync(file, "utf8");
  const input = JSON.parse(before) as Record<string, unknown>;
  const value = runtime ? { ...parseProjectRuntime(old, input) } : { ...input };
  const root = runtime ? "projectRoot" : "root";
  if (value.projectId !== old.id || value[root] !== old.root || (runtime && value.stateDir !== old.stateDir))
    throw new Error(`${file} does not identify the old registration; verify the state directory and retry`);
  value.projectId = next.id;
  value[root] = next.root;
  if (runtime) {
    value.stateDir = next.stateDir;
    value.instanceId = null;
  }
  return { file, before, after: JSON.stringify(value) };
}

function stopped(project: Project): boolean {
  if (project.instanceId && processLiveness(project.pid, project.pidSignature) !== "gone") return false;
  const status = join(project.stateDir, "status.json");
  if (fileOrMissing(status)) {
    try {
      const owner = JSON.parse(readFileSync(status, "utf8")) as { pid?: unknown; pidSignature?: unknown };
      if (typeof owner.pid !== "number" || processLiveness(owner.pid,
        typeof owner.pidSignature === "string" ? owner.pidSignature : undefined) !== "gone") return false;
    } catch { return false; }
  } else if (existsSync(join(project.stateDir, "control-token"))) return false;
  const legacy = join(project.stateDir, "hub.pid");
  return !existsSync(legacy) || processLiveness(Number(readFileSync(legacy, "utf8").trim())) === "gone";
}

function counts(db: Database, id: string, own: boolean): Rewrite[] {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const rewrites: Rewrite[] = [];
  for (const { name } of tables) {
    if (!own && name !== "task_handoff_origin" && name !== "task_handoff_outbound") continue;
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${ident(name)})`).all();
    const column = name === "task_handoff_outbound" ? "remote_project" : "project_id";
    if (!columns.some(item => item.name === column)) continue;
    const count = countRows(db, name, column, id);
    if (own || count) rewrites.push({ table: name, column, count,
      ...(name === "delivery_meta" && columns.some(item => item.name === "project_root") ? { root: true } : {}) });
  }
  return rewrites;
}

function countRows(db: Database, table: string, column: string, id: string): number {
  return db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM ${ident(table)} WHERE ${ident(column)} = ?`).get(id)!.n;
}

function inspectStore(project: Project, old: Project, own: boolean): Store | undefined {
  const file = join(project.stateDir, "hub.db");
  if (!fileOrMissing(file)) {
    if (own) throw new Error(`missing ${file}; select the moved state with --state`);
    return undefined;
  }
  assertHubDbCompatible(file);
  const db = new Database(file, { readonly: true, strict: true });
  try {
    const rewrites = counts(db, old.id, own);
    if (!own && !rewrites.length) return undefined;
    const pending = own && rewrites.some(change => change.table === "deliveries") &&
      !!db.query("SELECT 1 FROM deliveries WHERE state IN ('queued','dispatching','accepted','needs_review') LIMIT 1").get();
    return { project, file, rewrites, pending };
  } finally { db.close(); }
}

function planMove(registry: Registry, oldRef: string, newRoot: string, state?: string, timestamp = new Date().toISOString().replaceAll(":", "-")) {
  const projects = registry.list();
  // Prefer the registered spelling. An old path can now be a symlink to the new path.
  const oldPath = isAbsolute(oldRef) ? oldRef : join(process.cwd(), oldRef);
  const old = projects.find(row => row.id === oldRef || row.root === oldPath);
  if (!old) throw new Error("old registration not found; run ahub projects --full and use its project id");
  const root = realPath(isAbsolute(newRoot) ? newRoot : `${process.cwd()}/${newRoot}`);
  if (projectRoot(root) !== root) throw new Error("new path must be the project root");
  const requestedState = state ?? join(root, ".agenthub", "state");
  const stateDir = realPath(isAbsolute(requestedState) ? requestedState : `${root}/${requestedState}`);
  const next = { ...old, id: idFor(root), root, stateDir, instanceId: null, pid: null, pidSignature: null };
  if (root === old.root) throw new Error("the project is already registered at this root. Move the repository before re-keying it");
  if (projects.some(row => row.id === next.id || row.root === root || (row.id !== old.id && row.stateDir === stateDir)))
    throw new Error("destination is registered; inspect ahub projects --full and remove the duplicate registration before retrying");
  if (existsSync(old.stateDir) && realPath(old.stateDir) !== stateDir)
    throw new Error("the original state directory still exists separately; select it with --state or move it before retrying");
  const moved = { ...old, stateDir };
  const own = inspectStore(moved, old, true)!;
  const peers = projects.filter(row => row.id !== old.id).flatMap(row => inspectStore(row, old, false) ?? []);
  const active = [moved, ...peers.map(item => item.project)].filter(row => !stopped(row));
  if (active.length) throw new Error(`stop the live or uncertain hubs before retrying:\n${active.map(row => `ahub --project ${row.id} kill`).join("\n")}`);
  if (own.pending) throw new Error(`project ${old.id} has pending deliveries; move the repository back, start the old hub, settle its queue and stop it before retrying`);
  const projectFile = marker(join(stateDir, "project.json"), old, next, false);
  if (!projectFile) throw new Error("project.json is missing; select the original state directory with --state");
  const runtime = marker(join(stateDir, "runtime.json"), old, next, true);
  const markers = runtime ? [projectFile, runtime] : [projectFile];
  const continuity = join(stateDir, "recovery-continuity.json");
  if (fileOrMissing(continuity)) markers.push({ file: continuity, before: readFileSync(continuity, "utf8") });
  const stores = [own, ...peers];
  for (const row of [next, ...stores.map(store => store.project)]) {
    const operation = recoveryLock(dirname(registry.path), row.root);
    if (operation) throw new Error(`project ${row.id} has active recovery; run ahub recovery status ${operation} before retrying`);
  }
  const databaseVersions = stores.flatMap(({ file }) => [file, file + "-wal"]).map(file => {
    if (!fileOrMissing(file)) return null;
    const stat = lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  });
  const fingerprint = `${timestamp}.${hash(JSON.stringify({ timestamp, old, next, stores, databaseVersions, markers: markers.map(item => hash(item.before)) }))}`;
  return { old, next, stores, markers, fingerprint, archive: join(root, ".agenthub", "archive", `move-${timestamp}`) };
}

export type ProjectMovePreview = ReturnType<typeof planMove>;
export function previewProjectMove(registry: Registry, oldRef: string, root: string, state?: string): ProjectMovePreview {
  return registry.runtimeCaptureLocked(() => planMove(registry, oldRef, root, state));
}

function backupDatabase(file: string, target: string): void {
  const db = new Database(file, { readonly: true, strict: true });
  try { db.query("VACUUM INTO ?").run(target); } finally { db.close(); }
  sync(target);
}

function rewriteStore(store: Store, old: Project, next: Project): void {
  assertHubDbCompatible(store.file);
  const db = new Database(store.file, { readwrite: true, create: false, strict: true });
  try {
    db.run("PRAGMA synchronous = FULL");
    db.transaction(() => {
      for (const rewrite of store.rewrites) {
        const { table, column, count, root } = rewrite;
        const sql = `UPDATE ${ident(table)} SET ${ident(column)} = ?${root ? ", project_root = ?" : ""} WHERE ${ident(column)} = ?`;
        const args = root ? [next.id, next.root, old.id] : [next.id, old.id];
        if (db.query(sql).run(...args).changes !== count || countRows(db, table, column, old.id))
          throw new Error(`${table} changed during move; preview again`);
      }
    }).immediate();
  } finally { db.close(); }
}

/** Called under the registry write transaction before a new claim or launch can proceed. */
export function recoverProjectMove(registry: Registry): void {
  const file = journalPath(registry);
  if (!fileOrMissing(file)) return;
  const journal = JSON.parse(readFileSync(file, "utf8")) as MoveJournal;
  if (registry.get(journal.before) && !registry.get(journal.after)) {
    for (const backup of journal.backups) {
      if (backup.database) for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(backup.file + suffix, { force: true });
      replaceFile(backup.file, temporary => {
        copyFileSync(backup.backup, temporary);
        chmodSync(temporary, 0o600);
      });
    }
  } else if (registry.get(journal.before) || !registry.get(journal.after)) {
    throw new Error(`ambiguous project move; inspect ${file} before starting a hub`);
  }
  rmSync(file);
  sync(dirname(file));
}

export function applyProjectMove(registry: Registry, oldRef: string, root: string, state: string | undefined, fingerprint: string,
  afterRewrite?: () => void): ProjectMovePreview {
  try {
    return registry.runtimeCaptureLocked(() => {
      const timestamp = /^([0-9-]+T[0-9-]+\.[0-9]+Z)\.[a-f0-9]{64}$/.exec(fingerprint)?.[1];
      if (!timestamp) throw new Error("invalid project move fingerprint; run a new preview");
      const plan = planMove(registry, oldRef, root, state, timestamp);
      if (plan.fingerprint !== fingerprint) throw new Error("project move changed; run a new preview");
      const { archive, old, next, stores, markers } = plan;
      const parent = dirname(archive);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const archivePath = relative(next.root, realPath(parent));
      if (archivePath !== join(".agenthub", "archive")) throw new Error("move archive must be the project's .agenthub/archive directory");
      mkdirSync(archive, { mode: 0o700 });
      backupDatabase(registry.path, join(archive, "registry.db"));
      const backups: Backup[] = stores.map(({ file, project }) => ({ file, backup: join(archive, `${project.id}.db`), database: true }));
      for (const { file, backup } of backups) backupDatabase(file, backup);
      for (const item of markers) {
        const backup = join(archive, basename(item.file));
        writeFileSync(backup, item.before, { mode: 0o600, flag: "wx" });
        sync(backup);
        backups.push({ file: item.file, backup, database: false });
      }
      const restore = join(archive, "restore.json");
      writeFileSync(restore, JSON.stringify({ registry: registry.path, backups }, null, 2), { mode: 0o600, flag: "wx" });
      sync(restore);
      sync(archive);
      sync(parent);
      const journal: MoveJournal = { before: old.id, after: next.id, backups };
      replaceFile(journalPath(registry), temporary => writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" }));
      for (const store of stores) {
        rewriteStore(store, old, next);
        if (store === stores[0]) afterRewrite?.();
      }
      for (const item of markers) {
        const after = item.after;
        if (after === undefined) {
          rmSync(item.file);
          sync(dirname(item.file));
        } else replaceFile(item.file, temporary => writeFileSync(temporary, after, { mode: 0o600, flag: "wx" }));
      }
      registry.replaceMovedProject(old, next);
      return plan;
    });
  } finally {
    // Registry commit or rollback has returned, so the durable registry identity decides recovery.
    registry.runtimeCaptureLocked(() => {});
  }
}
