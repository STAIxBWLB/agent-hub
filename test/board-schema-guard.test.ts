import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertHubDbCompatible, HUB_DB_BASE_SCHEMA, HUB_DB_SCHEMA, HubDbSchemaError, openHubDatabase } from "../src/hub/db-schema.ts";
import { VERSION } from "../src/version.ts";
import { Board } from "../src/hub/board.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { ConductorHolds } from "../src/hub/conductor.ts";
import { InvocationLedger } from "../src/hub/invocations.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { Budget, DEFAULT_BUDGET, type BudgetHooks } from "../src/hub/budget.ts";
import { UsageRollup } from "../src/hub/usage-rollup.ts";
import { Turns } from "../src/hub/snapshots.ts";
import { ScheduleStore } from "../src/hub/schedules.ts";
import { FolderStore } from "../src/hub/folder-trigger.ts";
import { PiToolReceipts } from "../src/pi/tool-receipts.ts";
import { planReset, resetRuntime } from "../src/cli/reset.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-schema-guard-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "hub.db");
}
const fingerprint = (file: string) => [file, `${file}-wal`].map(name => existsSync(name) ? createHash("sha256").update(readFileSync(name)).digest("hex") : null);
function legacy(file: string): Database {
  const db = new Database(file);
  db.run("CREATE TABLE sentinel (id INTEGER PRIMARY KEY,value TEXT NOT NULL)"); db.run("INSERT INTO sentinel VALUES(1,'preserved')");
  return db;
}
function future(file: string, wal = false): Database {
  const db = legacy(file);
  if (wal) { db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA wal_autocheckpoint=0"); }
  db.run("CREATE TABLE hub_schema (id INTEGER PRIMARY KEY,schema INTEGER NOT NULL,required_version TEXT NOT NULL)");
  db.query("INSERT INTO hub_schema VALUES(1,?,?)").run(HUB_DB_SCHEMA + 1, "99.0.0");
  return db;
}
const named = "this project was opened by agent-hub 99.0.0; use 99.0.0 or later";

test("the current guard refuses a future schema before SQL/schema/data or DB/WAL writes", () => {
  const file = fixture(), original = future(file); original.close();
  const before = fingerprint(file);
  for (const open of [() => assertHubDbCompatible(file), () => openHubDatabase(file), () => openHubDatabase(file, { readonly: true })]) {
    expect(open).toThrow(HubDbSchemaError); expect(open).toThrow(named); expect(fingerprint(file)).toEqual(before);
  }
  const db = new Database(file, { readonly: true });
  try { expect(db.query("SELECT * FROM sentinel").all()).toEqual([{ id: 1, value: "preserved" }]); expect(db.query("SELECT schema FROM hub_schema").get()).toEqual({ schema: HUB_DB_SCHEMA + 1 }); }
  finally { db.close(); }
});

test("SQLite case-insensitive marker names cannot bypass the early future-schema check", () => {
  const file = fixture(), db = legacy(file);
  db.run("CREATE TABLE HUB_SCHEMA (id INTEGER PRIMARY KEY,schema INTEGER NOT NULL,required_version TEXT NOT NULL)");
  db.query("INSERT INTO HUB_SCHEMA VALUES(1,?,?)").run(HUB_DB_SCHEMA + 1, "99.0.0"); db.close();
  const before = fingerprint(file);
  expect(() => assertHubDbCompatible(file)).toThrow(named);
  expect(() => openHubDatabase(file)).toThrow(named);
  expect(fingerprint(file)).toEqual(before);
});

test("future metadata visible only through a live WAL is read and refused without changing it", () => {
  const file = fixture(), writer = future(file, true); clean.push(() => writer.close());
  expect(existsSync(`${file}-wal`)).toBe(true);
  const before = fingerprint(file);
  expect(() => assertHubDbCompatible(file)).toThrow(named);
  expect(() => openHubDatabase(file)).toThrow(named);
  expect(fingerprint(file)).toEqual(before);
  expect(writer.query("SELECT * FROM sentinel").all()).toEqual([{ id: 1, value: "preserved" }]);
});

test("an unversioned legacy database keeps its rows and receives one introducing-version marker", () => {
  const file = fixture(), old = legacy(file); old.close();
  const db = openHubDatabase(file);
  try {
    expect(db.query("SELECT * FROM sentinel").all()).toEqual([{ id: 1, value: "preserved" }]);
    expect(db.query("SELECT * FROM hub_schema").all()).toEqual([{ id: 1, schema: HUB_DB_BASE_SCHEMA, required_version: VERSION }]);
  } finally { db.close(); }
  const before = fingerprint(file), compatible = openHubDatabase(file, { reader: { schema: HUB_DB_SCHEMA, version: "99.1.0" } });
  try { expect(compatible.query("SELECT required_version FROM hub_schema").get()).toEqual({ required_version: VERSION }); } finally { compatible.close(); }
  expect(fingerprint(file)).toEqual(before);
});

for (const kind of ["directory", "dangling link"] as const) test(`an existing ${kind} hub.db fails closed before database effects`, () => {
  const file = fixture();
  if (kind === "directory") mkdirSync(file);
  else symlinkSync(join(dirname(file), "absent.db"), file);
  expect(() => assertHubDbCompatible(file)).toThrow(HubDbSchemaError);
  expect(() => openHubDatabase(file)).toThrow(HubDbSchemaError);
  expect(existsSync(`${file}-wal`)).toBe(false);
  expect(existsSync(join(dirname(file), "absent.db"))).toBe(false);
});

test("readonly checks on legacy storage never create schema metadata or an absent database", () => {
  const file = fixture(); assertHubDbCompatible(file); expect(existsSync(file)).toBe(false);
  const old = legacy(file); old.close(); const before = fingerprint(file);
  const db = openHubDatabase(file, { readonly: true });
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name='hub_schema'").all()).toEqual([]); } finally { db.close(); }
  expect(fingerprint(file)).toEqual(before);
});

for (const malformed of ["empty", "multiple", "negative", "fractional", "oversized", "injection", "wrong columns", "view"] as const) test(`malformed ${malformed} schema metadata fails closed without echoing it or writing`, () => {
  const file = fixture(), db = legacy(file);
  if (malformed === "view") db.run("CREATE VIEW hub_schema AS SELECT 1 AS id,1 AS schema,'1.0.0' AS required_version");
  else if (malformed === "wrong columns") db.run("CREATE TABLE hub_schema (alien TEXT)");
  else {
    db.run("CREATE TABLE hub_schema (id INTEGER,schema REAL,required_version TEXT)");
    if (malformed !== "empty") db.query("INSERT INTO hub_schema VALUES(1,?,?)").run(malformed === "negative" ? -1 : malformed === "fractional" ? 1.5 : HUB_DB_SCHEMA,
      malformed === "oversized" ? "PRIVATE_CANARY".repeat(1000) : malformed === "injection" ? "1.0.0\nPRIVATE_CANARY" : "1.0.0");
    if (malformed === "multiple") db.run("INSERT INTO hub_schema VALUES(2,1,'1.0.0')");
  }
  db.close(); const before = fingerprint(file);
  let message = "";
  try { openHubDatabase(file); } catch (error) { expect(error).toBeInstanceOf(HubDbSchemaError); message = (error as Error).message; }
  expect(message).toContain("schema metadata is invalid"); expect(message).not.toContain("PRIVATE_CANARY"); expect(fingerprint(file)).toEqual(before);
});

test("a higher-capability reader leaves a lower compatible format and its introducing version byte-identical", () => {
  const file = fixture(), initial = openHubDatabase(file);
  initial.run("CREATE TABLE sentinel (value TEXT)"); initial.run("INSERT INTO sentinel VALUES('preserved')");
  initial.run("CREATE TRIGGER deny_schema_upgrade BEFORE UPDATE ON hub_schema BEGIN SELECT RAISE(ABORT,'opening must not migrate'); END"); initial.close();
  const before = fingerprint(file), db = openHubDatabase(file, { reader: { schema: HUB_DB_SCHEMA + 1, version: "99.0.0" } });
  try {
    expect(db.query("SELECT * FROM hub_schema").get()).toEqual({ id: 1, schema: HUB_DB_BASE_SCHEMA, required_version: VERSION });
    expect(db.query("SELECT * FROM sentinel").all()).toEqual([{ value: "preserved" }]);
  } finally { db.close(); }
  expect(fingerprint(file)).toEqual(before);
});

test("memory databases use the same guard and marker without filesystem preflight", () => {
  const db = openHubDatabase(":memory:");
  try { expect(db.query("SELECT * FROM hub_schema").get()).toEqual({ id: 1, schema: HUB_DB_BASE_SCHEMA, required_version: VERSION }); } finally { db.close(); }
});

test("SQLite contention keeps its native busy classification instead of becoming schema corruption", () => {
  const file = fixture(), writer = legacy(file);
  writer.run("BEGIN EXCLUSIVE");
  try {
    let refused: unknown;
    try { assertHubDbCompatible(file); } catch (error) { refused = error; }
    expect(refused).toBeDefined(); expect(refused).not.toBeInstanceOf(HubDbSchemaError);
    expect(String((refused as Error).message)).toMatch(/locked|busy/i);
  } finally { writer.run("ROLLBACK"); writer.close(); }
});


const budgetHooks: BudgetHooks = { pause: () => {}, resume: () => {}, requestCheckpoint: async () => undefined, platformContext: async () => undefined,
  attached: () => false, canHandOff: () => false, handoff: async () => [], resumed: () => {}, notify: () => {} };
const writers: [string, (file: string) => { close(): void | Promise<void> }][] = [
  ["Board", file => new Board(file)],
  ["DeliveryJournal", file => new DeliveryJournal({ file, projectRoot: dirname(file), projectId: "schema-fixture", instanceId: "schema-instance" })],
  ["ConductorHolds", file => new ConductorHolds(file)],
  ["InvocationLedger", file => new InvocationLedger(file)],
  ["ExecutionBudget", file => new ExecutionBudget(file)],
  ["Budget", file => new Budget(file, DEFAULT_BUDGET, budgetHooks)],
  ["UsageRollup", file => new UsageRollup(file, join(dirname(file), "events.jsonl"))],
  ["Turns writer", file => new Turns(file)],
  ["Turns readonly", file => new Turns(file, true)],
  ["ScheduleStore", file => new ScheduleStore(file)],
  ["FolderStore", file => new FolderStore(file)],
  ["PiToolReceipts", file => new PiToolReceipts(file)],
];
for (const [name, open] of writers) test(`${name} refuses future hub.db before its constructor migrations or maintenance writes`, async () => {
  const file = fixture(), seed = future(file); seed.close(); const before = fingerprint(file);
  let opened: ReturnType<typeof open> | undefined;
  try {
    expect(() => { opened = open(file); }).toThrow(named);
    expect(fingerprint(file)).toEqual(before);
    const inspect = new Database(file, { readonly: true });
    try { expect(inspect.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "hub_schema" }, { name: "sentinel" }]); }
    finally { inspect.close(); }
  } finally { await opened?.close(); }
});

test("reset preview and runtime refuse future schema before settling deliveries, holds or session pointers", () => {
  const file = fixture(), seed = future(file); seed.close(); const stateDir = dirname(file), before = fingerprint(file);
  const pointer = join(stateDir, "sessions.json"); writeFileSync(pointer, '{"fixture":"preserved"}');
  const project = { id: "schema-fixture", root: stateDir, stateDir, basePort: 4600, instanceId: null, pid: null };
  expect(() => planReset(stateDir, project.id)).toThrow(named);
  expect(() => resetRuntime(stateDir, project)).toThrow(named);
  expect(fingerprint(file)).toEqual(before); expect(readFileSync(pointer, "utf8")).toBe('{"fixture":"preserved"}');
});


function closeCheckpointedWal(file: string, writer: Database): void {
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)"); writer.close();
  // Only this fixture's handles and files exist here; never remove another writer's sidecars.
  for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  expect(existsSync(`${file}-wal`)).toBe(false); expect(existsSync(`${file}-shm`)).toBe(false);
}

test("a closed checkpointed compatible WAL database probes quietly and opens for writing without a metadata restamp", () => {
  const file = fixture(), writer = openHubDatabase(file);
  writer.run("PRAGMA journal_mode=WAL"); writer.run("CREATE TABLE sentinel (value TEXT)"); writer.run("INSERT INTO sentinel VALUES('preserved')");
  closeCheckpointedWal(file, writer);
  const before = fingerprint(file);
  assertHubDbCompatible(file); expect(fingerprint(file)).toEqual(before);
  expect(existsSync(`${file}-shm`)).toBe(false);
  const reopened = openHubDatabase(file);
  try {
    expect(reopened.query("SELECT * FROM sentinel").all()).toEqual([{ value: "preserved" }]);
    expect(reopened.query("SELECT * FROM hub_schema").get()).toEqual({ id: 1, schema: HUB_DB_BASE_SCHEMA, required_version: VERSION });
  } finally { reopened.close(); }
});

test("a closed checkpointed future WAL schema gives its named refusal without creating DB/WAL/SHM files", () => {
  const file = fixture(), writer = future(file, true); closeCheckpointedWal(file, writer);
  const before = fingerprint(file);
  expect(() => assertHubDbCompatible(file)).toThrow(named);
  expect(() => openHubDatabase(file)).toThrow(named);
  expect(() => openHubDatabase(file, { readonly: true })).toThrow(named);
  expect(fingerprint(file)).toEqual(before); expect(existsSync(`${file}-wal`)).toBe(false); expect(existsSync(`${file}-shm`)).toBe(false);
});
