import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processSignature } from "../src/pi/process-signature.ts";
import { realPath } from "../src/hub/project.ts";
import { RUNTIME_PRUNE_INTERVAL_MS } from "../src/hub/runtime-capture-prune.ts";
import { REGISTRY_DB_BUSY_TIMEOUT_MS } from "../src/hub/registry.ts";
import { runtimePruneHealth } from "../src/hub/runtime-prune-health.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "ahub-prune-health-"))); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const ledger = join(home, "runtime-prune.db");
  return { home, ledger };
}
function ledger(f: ReturnType<typeof fixture>, options: { legacy?: boolean; phase?: string; pid?: number | null; signature?: string | null; at?: number; outcome?: string | null } = {}) {
  const db = new Database(f.ledger, { create: true });
  try {
    db.run(`CREATE TABLE admission (slot INTEGER PRIMARY KEY,id TEXT,admitted_at INTEGER,phase TEXT,pid INTEGER,outcome TEXT${options.legacy ? "" : ",signature TEXT"})`);
    const values = [randomUUID(), options.at ?? Date.now(), options.phase ?? "complete", options.pid ?? null, options.outcome === undefined ? JSON.stringify({ removed: 0, quarantined: [] }) : options.outcome];
    if (options.legacy) db.query("INSERT INTO admission VALUES(1,?,?,?,?,?)").run(...values);
    else db.query("INSERT INTO admission VALUES(1,?,?,?,?,?,?)").run(...values, options.signature ?? null);
  } finally { db.close(); }
  chmodSync(f.ledger, 0o600);
}
function signature(): string { const value = processSignature(process.pid); if (!value) throw new Error("fixture process signature unavailable"); return value; }

const detail = (checks: ReturnType<typeof runtimePruneHealth>) => checks.map(check => check.detail).join("\n");

test("#610 doctor runtime pruning inspection creates no admission or Registry state when none exists", () => {
  const f = fixture(); expect(runtimePruneHealth(f.home)).toEqual([]); expect(readdirSync(f.home)).toEqual([]);
  expect(existsSync(join(f.home, "registry.db"))).toBe(false); expect(existsSync(f.ledger)).toBe(false);
});

test("#610 healthy completed legacy and signed-schema ledgers are read without migration or byte changes", () => {
  for (const legacy of [true, false]) {
    const f = fixture(); ledger(f, { legacy }); const before = readFileSync(f.ledger), names = readdirSync(f.home);
    expect(runtimePruneHealth(f.home)).toEqual([]); expect(readFileSync(f.ledger)).toEqual(before); expect(readdirSync(f.home)).toEqual(names);
  }
});

test("#610 doctor configures the normal named busy timeout before its first admission statement", () => {
  const f = fixture(); ledger(f); const original = Database.prototype.run, seen: string[] = [];
  const watch = spyOn(Database.prototype, "run").mockImplementation(function(this: Database, sql, ...args) { seen.push(sql); return original.call(this, sql, ...args); });
  try { expect(runtimePruneHealth(f.home)).toEqual([]); } finally { watch.mockRestore(); }
  expect(seen[0]).toBe(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
});

test("#610 signed live maintenance is healthy rather than reported as stuck", () => {
  const f = fixture(); ledger(f, { phase: "running", pid: process.pid, signature: signature(), outcome: null });
  const checks = runtimePruneHealth(f.home); expect(checks).toContainEqual(expect.objectContaining({ ok: true }));
  expect(detail(checks)).toContain("is running"); expect(detail(checks)).toContain(f.ledger); expect(detail(checks)).not.toContain("stuck");
});

test("#610 a signed retired worker and unsigned legacy running claim name the admission inspection path", () => {
  const retired = fixture(); ledger(retired, { phase: "running", pid: process.pid, signature: `retired-${signature()}`, outcome: null });
  const dead = runtimePruneHealth(retired.home); expect(dead).toContainEqual(expect.objectContaining({ ok: false })); expect(detail(dead)).toContain(retired.ledger);
  const legacy = fixture(); ledger(legacy, { legacy: true, phase: "running", pid: process.pid, outcome: null });
  const unknown = runtimePruneHealth(legacy.home); expect(unknown).toContainEqual(expect.objectContaining({ ok: undefined }));
  expect(detail(unknown)).toContain("legacy running admission"); expect(detail(unknown)).toContain(legacy.ledger);
});

test("#610 an old scheduled admission and a final deferred outcome are visible without repair effects", () => {
  const pending = fixture(); ledger(pending, { phase: "scheduled", at: Date.now() - RUNTIME_PRUNE_INTERVAL_MS * 2, outcome: null });
  const before = readFileSync(pending.ledger), checks = runtimePruneHealth(pending.home);
  expect(checks).toContainEqual(expect.objectContaining({ ok: false })); expect(detail(checks)).toContain(pending.ledger); expect(readFileSync(pending.ledger)).toEqual(before);
  const failed = fixture(); ledger(failed, { outcome: JSON.stringify({ removed: 0, quarantined: [], deferred: "fixture validation refused" }) });
  const failure = runtimePruneHealth(failed.home); expect(failure).toContainEqual(expect.objectContaining({ ok: false })); expect(detail(failure)).toContain("fixture validation refused"); expect(detail(failure)).toContain(failed.ledger);
});

for (const unsafe of ["malformed", "symlink", "hardlink", "oversize", "schema", "outcome", "permissions"] as const) {
  test(`#610 an unsafe ${unsafe} admission ledger is unknown and named, never repaired`, () => {
    const f = fixture();
    if (unsafe === "malformed") writeFileSync(f.ledger, "not a SQLite database");
    else if (unsafe === "oversize") writeFileSync(f.ledger, Buffer.alloc(1024 * 1024 + 1));
    else {
      ledger(f, { outcome: unsafe === "outcome" ? "x".repeat(16 * 1024 + 1) : undefined });
      if (unsafe === "symlink") { const target = join(f.home, "actual.db"); writeFileSync(target, readFileSync(f.ledger)); rmSync(f.ledger); symlinkSync(target, f.ledger); }
      else if (unsafe === "hardlink") linkSync(f.ledger, join(f.home, "another.db"));
      else if (unsafe === "permissions") chmodSync(f.ledger, 0o644);
      else if (unsafe === "schema") { const db = new Database(f.ledger); try { db.run("CREATE TABLE unknown (value TEXT)"); } finally { db.close(); } }
    }
    const before = readFileSync(f.ledger), checks = runtimePruneHealth(f.home);
    expect(checks).toContainEqual(expect.objectContaining({ ok: undefined })); expect(detail(checks)).toContain(f.ledger); expect(readFileSync(f.ledger)).toEqual(before);
  });
}

test("#610 reserved quarantine directories are reported by full path without a ledger or recursive traversal", () => {
  const f = fixture(), quarantine = join(f.home, "releases", "0.26.0", ".runtime-prune-fixture"), secret = join(quarantine, "capture", "nested-private-name");
  mkdirSync(secret, { recursive: true }); writeFileSync(join(secret, "data"), "must remain");
  const checks = runtimePruneHealth(f.home);
  expect(detail(checks)).toContain(quarantine); expect(detail(checks)).not.toContain("nested-private-name");
  expect(readFileSync(join(secret, "data"), "utf8")).toBe("must remain"); expect(existsSync(f.ledger)).toBe(false); expect(existsSync(join(f.home, "registry.db"))).toBe(false);
});

test("#610 a reserved quarantine symlink is named without following it", () => {
  const f = fixture(), outside = join(f.home, "outside"), version = join(f.home, "releases", "0.26.0"), path = join(version, ".runtime-prune-linked");
  mkdirSync(outside); mkdirSync(version, { recursive: true }); writeFileSync(join(outside, "retained"), "unchanged"); symlinkSync(outside, path, "dir");
  expect(detail(runtimePruneHealth(f.home))).toContain(path); expect(readFileSync(join(outside, "retained"), "utf8")).toBe("unchanged");
});


test("#610 a retired unsigned legacy worker is diagnosed without rewriting its older ledger schema", async () => {
  const f = fixture(), child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { env: { HOME: f.home, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  ledger(f, { legacy: true, phase: "running", pid: child.pid, outcome: null });
  const before = readFileSync(f.ledger), checks = runtimePruneHealth(f.home);
  expect(checks).toContainEqual(expect.objectContaining({ ok: false }));
  expect(detail(checks)).toContain("PID is gone"); expect(detail(checks)).toContain(f.ledger); expect(readFileSync(f.ledger)).toEqual(before);
});

test("#610 an oversized scheduled outcome remains unknown rather than being mistaken for NULL", () => {
  const f = fixture(); ledger(f, { phase: "scheduled", outcome: "x".repeat(16 * 1024 + 1) });
  const checks = runtimePruneHealth(f.home); expect(checks).toContainEqual(expect.objectContaining({ ok: undefined })); expect(detail(checks)).toContain(f.ledger);
});
