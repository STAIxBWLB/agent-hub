import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/hub/registry.ts";
import { allocatePorts } from "../src/hub/ports.ts";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-registry-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  return dir;
};

test("registry registers stable projects and allocates unique bases", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ahub-db-")), "registry.db");
  const db = new Registry(file);
  const a = db.register(repo());
  const b = db.register(repo());
  expect(db.register(a.root)).toEqual(a);
  expect(a.id).not.toBe(b.id);
  expect(a.basePort).not.toBe(b.basePort);
  db.close();
});

test("claims reject uncertain/live owners and release only by instance", () => {
  const db = new Registry(join(mkdtempSync(join(tmpdir(), "ahub-db-")), "registry.db"));
  const project = db.register(repo());
  expect(db.claim(project.id, "one", process.pid)).toBe(true);
  expect(db.claim(project.id, "two", process.pid)).toBe(false);
  db.release(project.id, "two");
  expect(db.get(project.id)?.instanceId).toBe("one");
  db.release(project.id, "one");
  expect(db.claim(project.id, "two", process.pid)).toBe(true);
  db.close();
});

test("legacy ports import once and preserves assignments", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-legacy-"));
  const root = repo();
  writeFileSync(join(dir, "ports.json"), JSON.stringify({ [root]: 4700 }));
  const db = new Registry(join(dir, "registry.db"));
  expect(db.register(root).basePort).toBe(4700);
  expect(db.register(repo()).basePort).toBe(4600);
  db.close();
});

test("legacy import retains a reservation for a removed checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-legacy-"));
  const missing = join(dir, "removed-project");
  writeFileSync(join(dir, "ports.json"), JSON.stringify({ [missing]: 4720 }));
  const db = new Registry(join(dir, "registry.db"));
  expect(db.list()[0]).toMatchObject({ root: missing, basePort: 4720 });
  db.close();
});

test("legacy aliases coalesce only when their canonical roots use the same port", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-alias-"));
  const root = repo();
  const alias = join(dir, "alias");
  symlinkSync(root, alias);
  writeFileSync(join(dir, "ports.json"), JSON.stringify({ [root]: 4740, [alias]: 4740 }));
  const db = new Registry(join(dir, "registry.db"));
  expect(db.list().filter((p) => p.root === realpathSync(root))).toHaveLength(1);
  db.close();
});

test("live claims cannot relocate or remove a project", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-live-"));
  const db = new Registry(join(dir, "registry.db"));
  const root = repo();
  const project = db.register(root);
  expect(db.claim(project.id, "live", process.pid)).toBe(true);
  expect(() => db.register(root, join(dir, "other-state"))).toThrow(/live or uncertain/);
  expect(() => db.remove(project.id)).toThrow(/live or uncertain/);
  db.release(project.id, "live");
  db.remove(project.id);
  db.close();
});

test("legacy allocatePorts retains the old custom registry API", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-legacy-"));
  const file = join(dir, "ports.json");
  expect(allocatePorts("/a", file)).toBe(4600);
  expect(allocatePorts("/b", file)).toBe(4610);
  expect(allocatePorts("/a", file)).toBe(4600);
});

test("32 concurrent registrations preserve every project and unique allocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-race-"));
  const db = join(dir, "registry.db");
  const roots = Array.from({ length: 32 }, (_, i) => repo());
  const modulePath = join(import.meta.dir, "..", "src", "hub", "registry.ts");
  const script = `import { Registry } from ${JSON.stringify(modulePath)}; const r = new Registry(process.argv[1]); const p = r.register(process.argv[2]); console.log(JSON.stringify({id:p.id,port:p.basePort})); r.close();`;
  const jobs = roots.map((root) => Bun.spawn([process.execPath, "-e", script, db, root], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(jobs.map(async (job) => ({ code: await job.exited, out: await new Response(job.stdout).text(), err: await new Response(job.stderr).text() })));
  expect(results.every((r) => r.code === 0), results.map((r) => r.err).join("\n")).toBe(true);
  const registry = new Registry(db);
  const rows = registry.list();
  expect(rows).toHaveLength(32);
  expect(new Set(rows.map((r) => r.basePort)).size).toBe(32);
  registry.close();
});

test("same project has one successful concurrent claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claim-race-"));
  const db = join(dir, "registry.db");
  const root = repo();
  const modulePath = join(import.meta.dir, "..", "src", "hub", "registry.ts");
  const script = `import { Registry } from ${JSON.stringify(modulePath)}; const r = new Registry(process.argv[1]); const p = r.register(process.argv[2]); console.log(r.claim(p.id, process.argv[3], Number(process.argv[4])) ? "yes" : "no"); r.close();`;
  const jobs = Array.from({ length: 32 }, (_, i) => Bun.spawn([process.execPath, "-e", script, db, root, `instance-${i}`, String(process.pid)], { stdout: "pipe", stderr: "pipe" }));
  const values = await Promise.all(jobs.map(async (job) => (await new Response(job.stdout).text()).trim()));
  expect(values.filter((v) => v === "yes")).toHaveLength(1);
  new Registry(db).close();
});
