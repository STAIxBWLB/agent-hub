import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processLiveness, processSignature } from "../src/pi/process-signature.ts";
import { claimRunner, operationPath, recoveryRunner } from "../src/hub/recovery-store.ts";
import { inspectProject } from "../src/hub/lifecycle.ts";
import { Registry } from "../src/hub/registry.ts";
import { inspectRecovery } from "../src/cli/upgrade-runtime.ts";

// #226: every recorded owner pid is judged by one helper. A pid a reboot handed to another process is gone when the
// record carries the owner's signature; records written by 0.12.20 and older (no signature) answer as they always did.

const dirs: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `ahub-liveness-${name}-`))); dirs.push(dir); return dir; };
/** A live process that is not the recorded owner: what a reused pid points at after a reboot. */
const stranger = () => { const child = Bun.spawn(["sleep", "30"]); children.push(child); return child.pid; };
const dead = () => Bun.spawnSync(["true"]).pid; // reaped: its pid names no process now
const root = process.getuid?.() === 0; // root may signal pid 1, so the EPERM cases do not apply

test("live, reused, dead and unreadable owners, with and without a recorded signature", () => {
  const pid = stranger();
  const own = processSignature(pid)!;
  expect(own).toMatch(/^[0-9a-f]{64}$/);
  expect(processLiveness(pid, own)).toBe("live");
  expect(processLiveness(pid, "another process's signature")).toBe("gone"); // the pid was reused
  expect(processLiveness(pid, own, () => "a later process at this pid")).toBe("gone");
  expect(processLiveness(pid, own, () => undefined)).toBe("unknown"); // exists, identity unreadable: never gone
  expect(processLiveness(pid)).toBe("live"); // unsigned: the pid probe, as before
  expect(processLiveness(dead(), own)).toBe("gone");
  expect(processLiveness(dead())).toBe("gone");
  for (const invalid of [0, -1, 1.5, "12", undefined, null]) expect(processLiveness(invalid)).toBe("unknown");
});

test.skipIf(root)("a pid that cannot be signalled is unknown unsigned, and decided by its signature when one was recorded", () => {
  expect(() => process.kill(1, 0)).toThrow(); // EPERM: not ESRCH, the process exists
  expect(processLiveness(1)).toBe("unknown");
  expect(processLiveness(1, "the recorded owner's signature")).toBe("gone");
  expect(processLiveness(1, processSignature(1)!)).toBe("live");
});

function runnerRow(home: string, id: string, pid: number, signature?: string | null, legacyTable = false): void {
  mkdirSync(join(home, "recovery"), { recursive: true });
  const db = new Database(`${operationPath(id, home)}.runner.db`, { create: true });
  // 0.12.20 and older created the table without a signature column.
  db.run(legacyTable ? "CREATE TABLE runner (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL)"
    : "CREATE TABLE runner (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL, signature TEXT)");
  if (legacyTable) db.query("INSERT INTO runner (slot, pid, nonce) VALUES (1, ?, 'n')").run(pid);
  else db.query("INSERT INTO runner (slot, pid, nonce, signature) VALUES (1, ?, 'n', ?)").run(pid, signature ?? null);
  db.close();
}
const ID = "00000000-0000-4000-8000-000000000226";

test("a runner row whose signature no longer matches is no runner, and is replaced by the next claim", () => {
  const home = temp("runner");
  const pid = stranger();
  runnerRow(home, ID, pid, "the dead runner's signature");
  expect(recoveryRunner(ID, home)).toBeUndefined();
  const release = claimRunner(ID, home);
  const db = new Database(`${operationPath(ID, home)}.runner.db`, { readonly: true });
  expect(db.query("SELECT pid, signature FROM runner WHERE slot = 1").get()).toEqual({ pid: process.pid, signature: processSignature(process.pid)! });
  db.close();
  expect(recoveryRunner(ID, home)).toBe(process.pid);
  release();
  expect(recoveryRunner(ID, home)).toBeUndefined();
});

test("a live or unidentifiable runner is refused with a message, never a raw kill error", () => {
  const home = temp("runner-live");
  const pid = stranger();
  runnerRow(home, ID, pid, processSignature(pid)!);
  expect(recoveryRunner(ID, home)).toBe(pid);
  expect(() => claimRunner(ID, home)).toThrow(`recovery runner ${pid} is still alive`);
  if (!root) {
    runnerRow(temp("runner-eperm"), ID, 1);
    const eperm = dirs.at(-1)!;
    expect(recoveryRunner(ID, eperm)).toBe("unknown");
    expect(() => claimRunner(ID, eperm)).toThrow("recovery runner 1 cannot be identified (its process exists but cannot be inspected); refusing to replace it");
  }
});

test("runner rows written by 0.12.20 (no signature column) give today's answers, and a claim adds the column", () => {
  const home = temp("runner-legacy");
  const pid = stranger();
  runnerRow(home, ID, pid, undefined, true);
  expect(recoveryRunner(ID, home)).toBe(pid);
  expect(() => claimRunner(ID, home)).toThrow(`recovery runner ${pid} is still alive`);
  runnerRow(temp("runner-legacy-dead"), ID, dead(), undefined, true);
  const gone = dirs.at(-1)!;
  expect(recoveryRunner(ID, gone)).toBeUndefined();
  claimRunner(ID, gone)();
  const db = new Database(`${operationPath(ID, gone)}.runner.db`, { readonly: true });
  expect((db.query("PRAGMA table_info(runner)").all() as { name: string }[]).map((c) => c.name)).toContain("signature");
  db.close();
});

/** A crashed hub's manifest, as written by this release (signed) or by 0.12.20 (pid only). */
function manifest(stateDir: string, root: string, pid: number, pidSignature?: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, projectId: "p226", instanceId: "crashed", controlPort: 9, pid, protocol: 16, ...(pidSignature ? { pidSignature } : {}) }));
  writeFileSync(join(stateDir, "control-token"), "stale-token");
}

test("a manifest or claim whose pid was reused reads stopped; unsigned ones read as they did", async () => {
  const root = temp("manifest");
  const stateDir = join(root, ".agenthub", "state");
  const pid = stranger();
  const project = { id: "p226", root, stateDir, basePort: 4600, instanceId: null, pid: null };
  manifest(stateDir, root, pid, "the crashed daemon's signature");
  expect((await inspectProject(project)).state).toBe("stopped");
  manifest(stateDir, root, pid); // 0.12.20: a live pid is a live or uncertain owner
  expect((await inspectProject(project)).state).toBe("unavailable");
  rmSync(join(stateDir, "status.json"));
  writeFileSync(join(stateDir, "hub.pid"), `${pid}\n`); // only daemons up to 0.12.20 wrote it
  expect((await inspectProject(project)).state).toBe("unavailable");
  rmSync(join(stateDir, "hub.pid"));
  expect((await inspectProject({ ...project, instanceId: "crashed", pid, pidSignature: "the crashed daemon's signature" })).state).toBe("stopped");
  expect((await inspectProject({ ...project, instanceId: "crashed", pid })).state).toBe("starting");
  expect((await inspectProject({ ...project, instanceId: "live", pid, pidSignature: processSignature(pid)! })).state).toBe("starting");
});

test("a claim's signature counts only for the instance that wrote it; an older daemon's claim reads unsigned", () => {
  const home = temp("registry");
  const registry = new Registry(join(home, "registry.db"));
  try {
    const root = temp("registry-root");
    const { id } = registry.register(root);
    const pid = stranger();
    expect(registry.claim(id, "first", pid, "the first daemon's signature")).toBe(true);
    expect(registry.get(id)).toMatchObject({ instanceId: "first", pid, pidSignature: "the first daemon's signature" });
    // A reused pid no longer holds the claim: a new daemon takes it.
    expect(registry.claim(id, "second", process.pid, processSignature(process.pid))).toBe(true);
    expect(registry.get(id)?.pidSignature).toBe(processSignature(process.pid));
    // The live claimant keeps it.
    expect(registry.claim(id, "third", pid)).toBe(false);
    // What a 0.12.20 daemon's claim writes: instance and pid, the signature column untouched.
    const db = new Database(join(home, "registry.db"));
    db.query("UPDATE projects SET instance_id = 'older', pid = ? WHERE id = ?").run(pid, id);
    db.close();
    expect(registry.get(id)?.pidSignature).toBeUndefined();
    expect(registry.claim(id, "fourth", process.pid)).toBe(false); // unsigned and live: as today
    expect(() => registry.remove(id)).toThrow("has a live or uncertain claim");
    registry.release(id, "older");
    expect(registry.get(id)).toMatchObject({ instanceId: null, pid: null });
  } finally { registry.close(); }
});

test("recovery judges the claim by the registry as it is now, never by the plan's frozen copy", async () => {
  const home = temp("recovery-home");
  const root = temp("recovery-root");
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  try {
    const registry = new Registry(join(home, "registry.db"));
    const project = registry.register(root);
    registry.close();
    // The plan froze the source's claim; after a reboot that pid belongs to someone else and the registry holds no claim.
    const frozen = { ...project, instanceId: "source", pid: stranger() };
    expect((await inspectProject(frozen)).state).toBe("starting");
    expect((await inspectRecovery(frozen)).state).toBe("stopped");
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

test("the manager's owner row: a reused signed pid is replaced, an unsigned live one still refuses", async () => {
  const { startManager, stopManager } = await import("../src/hub/manager.ts");
  const lifecycle = { inspectProject: async () => ({ state: "stopped" as const }), startProject: async () => ({}), stopProject: async () => {} };
  const registry = { get: () => undefined, list: () => [] } as any;
  const owner = (home: string, pid: number, signature?: string) => {
    mkdirSync(join(home, "manager"), { recursive: true });
    const db = new Database(join(home, "manager", "owner.db"), { create: true });
    // 0.12.20's table has no signature column; this release adds it on the next claim.
    db.run(`CREATE TABLE owner (slot INTEGER PRIMARY KEY CHECK (slot = 1), instance_id TEXT NOT NULL, pid INTEGER NOT NULL${signature ? ", signature TEXT" : ""})`);
    if (signature) db.query("INSERT INTO owner (slot, instance_id, pid, signature) VALUES (1, 'old', ?, ?)").run(pid, signature);
    else db.query("INSERT INTO owner (slot, instance_id, pid) VALUES (1, 'old', ?)").run(pid);
    db.close();
  };
  const legacy = temp("manager-legacy");
  owner(legacy, stranger());
  await expect(startManager({ home: legacy, registry, lifecycle })).rejects.toThrow("manager has a live or uncertain owner");
  const reused = temp("manager-reused");
  owner(reused, stranger(), "the old manager's signature");
  await startManager({ home: reused, registry, lifecycle, orphanWatchMs: 60_000 });
  try {
    const db = new Database(join(reused, "manager", "owner.db"), { readonly: true });
    expect(db.query("SELECT pid, signature FROM owner WHERE slot = 1").get()).toEqual({ pid: process.pid, signature: processSignature(process.pid)! });
    db.close();
  } finally { await stopManager({ home: reused }); }
});
