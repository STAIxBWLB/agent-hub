import { constants, Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "../version.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";

/** Bump only for an incompatible hub.db format; compatible releases keep the introducing version. */
export const HUB_DB_SCHEMA = 1;
/** schema is the maximum supported format, never a request to migrate an existing compatible database. */
export interface HubDbSchemaReader { schema: number; version: string }
export interface HubDatabaseOptions {
  readonly?: boolean;
  create?: boolean;
  reader?: HubDbSchemaReader;
  busyTimeoutMs?: number;
}
export class HubDbSchemaError extends Error {
  readonly code = "HUB_DB_SCHEMA";
  constructor(message: string, readonly requiredVersion?: string) { super(message); this.name = "HubDbSchemaError"; }
}
interface HubDbSchema { schema: number; requiredVersion: string }
const VERSION_TEXT = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const safeVersion = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && VERSION_TEXT.exec(value)?.[0] === value;
const defaultReader = (): HubDbSchemaReader => ({ schema: HUB_DB_SCHEMA, version: VERSION });
const invalidSchema = () => new HubDbSchemaError("this project's hub.db schema metadata is invalid; inspect or restore the database before starting agent-hub");
const busy = (error: unknown): boolean => {
  const value = error as { code?: unknown; message?: unknown } | null;
  return typeof value?.code === "string" && /^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(value.code)
    || typeof value?.message === "string" && /database (?:is )?(?:locked|busy)|database table is locked/i.test(value.message);
};
function readerValue(reader: HubDbSchemaReader): HubDbSchemaReader {
  if (!reader || !Number.isSafeInteger(reader.schema) || reader.schema < 1 || !safeVersion(reader.version)) throw invalidSchema();
  return { schema: reader.schema, version: reader.version };
}

/** No persistent PRAGMA or schema/data write runs while reading the marker. */
function schemaOn(db: Database): HubDbSchema | undefined {
  try {
    const entries = db.query("SELECT type FROM sqlite_master WHERE name='hub_schema' COLLATE NOCASE LIMIT 2").all() as { type: string }[];
    if (!entries.length) return undefined;
    if (entries.length !== 1 || entries[0]!.type !== "table") throw invalidSchema();
    const rows = db.query("SELECT id,schema,CASE WHEN typeof(required_version)='text' AND length(CAST(required_version AS BLOB))<=64 THEN required_version END AS required_version FROM hub_schema LIMIT 2")
      .all() as { id: number; schema: number; required_version: string | null }[];
    const row = rows[0];
    if (rows.length !== 1 || !row || row.id !== 1 || !Number.isSafeInteger(row.schema) || row.schema < 1 || !safeVersion(row.required_version)) throw invalidSchema();
    return { schema: row.schema, requiredVersion: row.required_version };
  } catch (error) {
    if (error instanceof HubDbSchemaError || busy(error)) throw error;
    throw invalidSchema();
  }
}
function checkOn(db: Database, reader: HubDbSchemaReader): HubDbSchema | undefined {
  const stored = schemaOn(db);
  if (stored && stored.schema > reader.schema) throw new HubDbSchemaError(`this project was opened by agent-hub ${stored.requiredVersion}; use ${stored.requiredVersion} or later`, stored.requiredVersion);
  return stored;
}
function existingFile(file: string): boolean {
  if (file === ":memory:") return false;
  try { return statSync(file).isFile(); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; }
}

/** Closed, checkpointed WAL files need a quiet metadata probe on macOS; unknown file/mode state never qualifies. */
function checkpointedWal(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const header = Buffer.alloc(20);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.toString("ascii", 0, 15) === "SQLite format 3"
      && header[15] === 0 && header[18] === 2 && header[19] === 2;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function noSidecars(file: string): boolean {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { lstatSync(`${file}${suffix}`); return false; }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") return false; }
  }
  return true;
}
function probeCompatible(file: string, reader: HubDbSchemaReader, quiet: boolean): void {
  const uri = pathToFileURL(file); uri.searchParams.set("immutable", "1");
  const db = quiet ? new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI) : new Database(file, { readonly: true, create: false });
  try {
    db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`); // connection-local, not persisted
    checkOn(db, reader);
  } finally { db.close(); }
}

/** Live WAL reads may take SHM read locks. Refusal performs no SQL/schema/data or DB/WAL write; SHM locks are SQLite's ceiling. */
export function assertHubDbCompatible(file: string, reader: HubDbSchemaReader = defaultReader()): void {
  const supported = readerValue(reader);
  if (!existingFile(file)) return;
  if (checkpointedWal(file) && noSidecars(file)) {
    // This handle is short-lived and never escapes. A live returned handle must continue observing later WAL commits.
    let failure: unknown, failed = false;
    try { probeCompatible(file, supported, true); } catch (error) { failure = error; failed = true; }
    if (!noSidecars(file)) { probeCompatible(file, supported, false); return; }
    if (failed) throw failure;
    return;
  }
  probeCompatible(file, supported, false);
}

/** Every hub.db writer enters here before its own persistent PRAGMAs, migrations or maintenance writes. */
export function openHubDatabase(file: string, options: HubDatabaseOptions = {}): Database {
  const reader = readerValue(options.reader ?? defaultReader()), timeout = options.busyTimeoutMs ?? HUB_DB_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > HUB_DB_BUSY_TIMEOUT_MS) throw new Error("invalid hub database busy timeout");
  // Refuse a future file without opening a writable connection, which can perform SQLite recovery work itself.
  assertHubDbCompatible(file, reader);
  const db = new Database(file, options.readonly ? { readonly: true, create: false } : { readwrite: true, create: options.create ?? true });
  try {
    db.run(`PRAGMA busy_timeout = ${timeout}`);
    if (options.readonly) { checkOn(db, reader); return db; }
    // The second read and legacy baseline stamp share the writer lock, without filesystem work in SQL.
    // Existing compatible markers never advance here; an incompatible migration must advance its marker with its actual DDL/data transaction.
    db.transaction(() => {
      const stored = checkOn(db, reader);
      if (!stored) {
        db.run("CREATE TABLE hub_schema (id INTEGER PRIMARY KEY CHECK(id=1),schema INTEGER NOT NULL,required_version TEXT NOT NULL)");
        db.query("INSERT INTO hub_schema(id,schema,required_version) VALUES(1,?,?)").run(HUB_DB_SCHEMA, VERSION);
      }
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}
