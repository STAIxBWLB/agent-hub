import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { scheduleRuntimeCapturePrune } from "../src/hub/runtime-capture-prune.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const home = () => { const h = realPath(mkdtempSync(join(tmpdir(), "ahub-prune-recovery-"))); cleanup.push(() => rmSync(h, { recursive: true, force: true })); return h; };
const admissionRows = (h: string): number => {
  try { const db = new Database(join(h, "runtime-prune.db"), { readonly: true }); try { return (db.query("SELECT count(*) AS n FROM admission").get() as { n: number }).n; } finally { db.close(); } } catch { return 0; }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test("#1546 a start under a held recovery lock schedules no prune and records no admission", async () => {
  const h = home(); mkdirSync(join(h, "recovery"));
  const db = new Database(join(h, "recovery", "project-locks.db"), { create: true });
  db.run("CREATE TABLE project_locks (project_root TEXT PRIMARY KEY, operation_id TEXT NOT NULL)");
  db.query("INSERT INTO project_locks VALUES('/x','00000000-0000-4000-8000-000000000000')").run(); db.close();
  scheduleRuntimeCapturePrune(h); await settle();
  expect(admissionRows(h)).toBe(0);
});

test("#1546 a legacy machine recovery.lock also schedules nothing", async () => {
  const h = home(); writeFileSync(join(h, "recovery.lock"), JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000000" }));
  scheduleRuntimeCapturePrune(h); await settle();
  expect(admissionRows(h)).toBe(0);
});

test("#1546 a recovery-only deferral starts no cooldown: the next schedule is admitted at once", async () => {
  const h = home();
  const db = new Database(join(h, "runtime-prune.db"), { create: true });
  db.run("CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT, signature TEXT)");
  db.query("INSERT INTO admission VALUES(1,'11111111-1111-4111-8111-111111111111',?,'complete',NULL,?,NULL)").run(Date.now(), JSON.stringify({ removed: 0, quarantined: [], deferred: "runtime capture pruning deferred: project recovery coordination is present" }));
  db.close(); chmodSync(join(h, "runtime-prune.db"), 0o600);
  scheduleRuntimeCapturePrune(h); await settle();
  const read = new Database(join(h, "runtime-prune.db"), { readonly: true });
  try { expect((read.query("SELECT id FROM admission WHERE slot=1").get() as { id: string }).id).not.toBe("11111111-1111-4111-8111-111111111111"); } finally { read.close(); }
});

test("#1546 a real completed pass still holds the one-hour cooldown", async () => {
  const h = home();
  const db = new Database(join(h, "runtime-prune.db"), { create: true });
  db.run("CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT, signature TEXT)");
  db.query("INSERT INTO admission VALUES(1,'22222222-2222-4222-8222-222222222222',?,'complete',NULL,?,NULL)").run(Date.now(), JSON.stringify({ removed: 0, quarantined: [] }));
  db.close(); chmodSync(join(h, "runtime-prune.db"), 0o600);
  scheduleRuntimeCapturePrune(h); await settle();
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
    await settle();
    expect(admissionRows(h)).toBe(0);
    expect(performance.now() - before).toBeLessThan(1500);
  } finally { holder.run("ROLLBACK"); holder.close(); }
});
