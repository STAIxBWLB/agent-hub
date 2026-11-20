import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { scheduleRuntimeCapturePrune } from "../src/hub/runtime-capture-prune.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const home = () => { const h = realPath(mkdtempSync(join(tmpdir(), "ahub-prune-recovery-"))); cleanup.push(() => rmSync(h, { recursive: true, force: true })); return h; };
const RECOVERY_ONLY_ID = "11111111-1111-4111-8111-111111111111";
interface AdmissionRow { id: string; phase: string }
/** No pass ever recorded a row is 0; a ledger a writer holds (or cannot be read) is undefined, never a silent 0. */
const admissionRows = (h: string): number | undefined => {
  const file = join(h, "runtime-prune.db");
  if (!existsSync(file)) return 0;
  let db: Database | undefined;
  try { db = new Database(file, { readonly: true }); return (db.query("SELECT count(*) AS n FROM admission").get() as { n: number }).n; }
  catch { return undefined; }
  finally { db?.close(); }
};
const admissionRow = (h: string): AdmissionRow | undefined => {
  const file = join(h, "runtime-prune.db");
  if (!existsSync(file)) return undefined;
  let db: Database | undefined;
  try { db = new Database(file, { readonly: true }); return (db.query("SELECT id, phase FROM admission WHERE slot=1").get() as AdmissionRow | null) ?? undefined; }
  catch { return undefined; } // the admitted worker's write transaction can hold the ledger until it records its terminal phase
  finally { db?.close(); }
};
/**
 * #1546: the schedule spawns a detached worker that writes the admission ledger, so a read has to wait for the pass it
 * admitted to record its terminal phase; a fixed delay raced the worker's write (SQLITE_BUSY). Bounded by a deadline with
 * short sleeps, never by a count of event-loop turns, and the caller asserts on the last observed row after it.
 */
const completedAdmission = async (h: string, previous: string): Promise<AdmissionRow | undefined> => {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const row = admissionRow(h);
    if (row && row.id !== previous && row.phase === "complete") return row;
    if (performance.now() >= deadline) return row;
    await Bun.sleep(5);
  }
};
/** The scheduler decides admission in its own setImmediate, registered first, so this one runs after every scheduling write. */
const attempted = () => new Promise<void>(resolve => setImmediate(resolve));

test("#1546 a start under a held recovery lock schedules no prune and records no admission", async () => {
  const h = home(); mkdirSync(join(h, "recovery"));
  const db = new Database(join(h, "recovery", "project-locks.db"), { create: true });
  db.run("CREATE TABLE project_locks (project_root TEXT PRIMARY KEY, operation_id TEXT NOT NULL)");
  db.query("INSERT INTO project_locks VALUES('/x','00000000-0000-4000-8000-000000000000')").run(); db.close();
  scheduleRuntimeCapturePrune(h); await attempted();
  expect(admissionRows(h)).toBe(0);
});

test("#1546 a legacy machine recovery.lock also schedules nothing", async () => {
  const h = home(); writeFileSync(join(h, "recovery.lock"), JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000000" }));
  scheduleRuntimeCapturePrune(h); await attempted();
  expect(admissionRows(h)).toBe(0);
});

test("#1546 a recovery-only deferral starts no cooldown: the next schedule is admitted at once", async () => {
  const h = home();
  const db = new Database(join(h, "runtime-prune.db"), { create: true });
  db.run("CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT, signature TEXT)");
  db.query("INSERT INTO admission VALUES(1,?,?,'complete',NULL,?,NULL)").run(RECOVERY_ONLY_ID, Date.now(), JSON.stringify({ removed: 0, quarantined: [], deferred: "runtime capture pruning deferred: project recovery coordination is present" }));
  db.close(); chmodSync(join(h, "runtime-prune.db"), 0o600);
  scheduleRuntimeCapturePrune(h); await attempted();
  const admitted = await completedAdmission(h, RECOVERY_ONLY_ID);
  expect(admitted).toMatchObject({ phase: "complete" });
  expect(admitted!.id).not.toBe(RECOVERY_ONLY_ID);
}, 20_000);

test("#1546 a real completed pass still holds the one-hour cooldown", async () => {
  const h = home();
  const db = new Database(join(h, "runtime-prune.db"), { create: true });
  db.run("CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT, signature TEXT)");
  db.query("INSERT INTO admission VALUES(1,'22222222-2222-4222-8222-222222222222',?,'complete',NULL,?,NULL)").run(Date.now(), JSON.stringify({ removed: 0, quarantined: [] }));
  db.close(); chmodSync(join(h, "runtime-prune.db"), 0o600);
  scheduleRuntimeCapturePrune(h); await attempted();
  const read = new Database(join(h, "runtime-prune.db"), { readonly: true });
  try { expect((read.query("SELECT id FROM admission WHERE slot=1").get() as { id: string }).id).toBe("22222222-2222-4222-8222-222222222222"); } finally { read.close(); }
});

test("#1546 a project-locks.db another connection holds a write lock on makes the schedule return at once and record no admission", async () => {
  const h = home(); mkdirSync(join(h, "recovery"));
  const file = join(h, "recovery", "project-locks.db");
  const holder = new Database(file, { create: true });
  holder.run("CREATE TABLE project_locks (project_root TEXT PRIMARY KEY, operation_id TEXT NOT NULL)");
  chmodSync(file, 0o600);
  holder.run("BEGIN EXCLUSIVE");
  try {
    const { anyRecoveryHold } = await import("../src/hub/recovery-store.ts");
    const started = performance.now();
    expect(anyRecoveryHold(h, true)).toBe(true); // busy is a hold
    expect(performance.now() - started).toBeLessThan(500);
    const before = performance.now();
    scheduleRuntimeCapturePrune(h);
    await attempted();
    expect(admissionRows(h)).toBe(0);
    expect(performance.now() - before).toBeLessThan(1500);
  } finally { holder.run("ROLLBACK"); holder.close(); }
});
