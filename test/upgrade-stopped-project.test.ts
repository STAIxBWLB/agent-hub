import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperation, planFingerprint, registeredProjects, type Inspection, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { makeRecoveryDriver, makeUpgradePlan, PACKAGE_ROOT, preserveSource } from "../src/cli/upgrade-runtime.ts";
import { packageDigest, type RunCommand } from "../src/cli/recovery-package.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import { VERSION } from "../src/version.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const TARGET = "0.26.0", DIGEST = "a".repeat(64), ID = "11111111-1111-1111-1111-111111111111";

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-stopped-upgrade-"))), home = join(root, "home");
  const previousHome = process.env.AGENTHUB_HOME, previousOperation = process.env.AGENTHUB_RECOVERY_OPERATION;
  process.env.AGENTHUB_HOME = home; delete process.env.AGENTHUB_RECOVERY_OPERATION;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    if (previousOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previousOperation;
    rmSync(root, { recursive: true, force: true });
  });
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  const projects = ["project-a", "project-b"].map(name => {
    const dir = join(root, name); mkdirSync(join(dir, ".agenthub"), { recursive: true });
    writeFileSync(join(dir, ".agenthub/config.json"), "{}\n");
    const project = registry.register(dir); mkdirSync(project.stateDir, { recursive: true });
    writeFileSync(join(project.stateDir, "fixture-sentinel.txt"), `${name} state stays here\n`);
    return project;
  });
  const [a, b] = projects;
  if (!a || !b) throw new Error("fixture omitted its project registrations");
  writeFileSync(join(home, "fixture-sentinel.txt"), "home stays unchanged\n");
  const calls: string[][] = [];
  const run: RunCommand = async argv => {
    calls.push([...argv]);
    if (argv.join(" ") !== `npm view @staix/agent-hub@${TARGET} version dist.integrity --json`)
      throw new Error(`unexpected fixture command: ${argv.join(" ")}`);
    return { code: 0, stdout: JSON.stringify({ version: TARGET, "dist.integrity": `sha512-${Buffer.alloc(64).toString("base64")}` }), stderr: "" };
  };
  return { root, home, registry, a, b, calls, run };
}

type Fixture = ReturnType<typeof fixture>;
function stoppedPlan(f: Fixture, sourceRoot: string, scoped = true, sourceDigest = DIGEST): UpgradePlan {
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: TARGET, sourceRoot, sourceDigest,
    ...(scoped ? { scope: { projectRoot: f.a.root } } : {}), projects: [], blockers: [`selected project is not running: ${f.a.root}`] };
  return { ...body, fingerprint: planFingerprint(body) };
}
function noPreservationEffects(f: Fixture) {
  expect(existsSync(join(f.home, "releases"))).toBe(false);
  expect(existsSync(join(f.home, "recovery"))).toBe(false);
  expect(readFileSync(join(f.home, "fixture-sentinel.txt"), "utf8")).toBe("home stays unchanged\n");
  expect(readFileSync(join(f.b.stateDir, "fixture-sentinel.txt"), "utf8")).toBe("project-b state stays here\n");
}

for (const sourceKind of ["missing", "file"] as const) {
  test(`#610 stopped scoped preservation refuses before reading a ${sourceKind} source package`, () => {
    const f = fixture(), source = join(f.root, "invalid-source");
    if (sourceKind === "file") writeFileSync(source, "This is not a runtime directory.\n");
    const plan = stoppedPlan(f, source);
    expect(() => preserveSource(plan, f.home)).toThrow("no running projects");
    noPreservationEffects(f);
    if (sourceKind === "file") expect(readFileSync(source, "utf8")).toBe("This is not a runtime directory.\n");
  });
}

test("#610 stopped preservation refuses before creating a releases directory or evaluating empty recovery scope", () => {
  const f = fixture(), source = join(f.root, "source-package");
  for (const name of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(source, name), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: TARGET }));
  writeFileSync(join(source, "src/fixture.ts"), "export const fixture = true;\n");
  const plan = stoppedPlan(f, source, true, packageDigest(source));
  expect(() => preserveSource(plan, f.home)).toThrow("no running projects");
  noPreservationEffects(f);
  expect(readFileSync(join(source, "src/fixture.ts"), "utf8")).toBe("export const fixture = true;\n");
});

for (const scoped of [false, true]) {
  test(`#610 ${scoped ? "scoped" : "legacy global"} empty recovery names stopped work before generic blockers`, () => {
    const f = fixture(), plan = stoppedPlan(f, join(f.root, "missing-source"), scoped);
    expect(() => createOperation(plan, plan.sourceRoot, f.home, undefined, ID)).toThrow("no running projects");
    noPreservationEffects(f);
  });
}

for (const kind of ["restart", "upgrade"] as const) {
  for (const state of ["stopped", "missing", "unregistered"] as const) {
    test(`#610 ${kind} planning names a ${state} selected project without staging or touching another project`, async () => {
      const f = fixture();
      // An unrelated owned startup claim must not make stopped project A recover project B.
      expect(f.registry.claim(f.b.id, "fixture-other-instance", process.pid)).toBe(true);
      const otherBefore = f.registry.get(f.b.id), registeredBefore = registeredProjects(f.home);
      let selected = f.a.root;
      if (state === "missing") rmSync(f.a.root, { recursive: true, force: true });
      else if (state === "unregistered") selected = join(f.root, "not-registered");
      const plan = await makeUpgradePlan(kind, TARGET, selected, f.run);
      expect(plan.projects).toEqual([]);
      expect(plan.scope).toEqual({ projectRoot: selected });
      expect(plan.blockers).toEqual([`selected project is not running: ${selected}`]);
      expect(() => createOperation(plan, plan.sourceRoot, f.home, undefined, ID)).toThrow("no running projects");
      expect(() => preserveSource(plan, f.home)).toThrow("no running projects");
      expect(f.calls).toEqual(kind === "upgrade" ? [["npm", "view", `@staix/agent-hub@${TARGET}`, "version", "dist.integrity", "--json"]] : []);
      expect(f.registry.get(f.b.id)).toEqual(otherBefore);
      expect(registeredProjects(f.home)).toEqual(registeredBefore);
      noPreservationEffects(f);
    });
  }
}

test("#610 an empty machine restart names no running projects before any preservation effects", async () => {
  const f = fixture(), plan = await makeUpgradePlan("restart", TARGET, undefined, f.run);
  expect(plan.scope).toBeUndefined(); expect(plan.projects).toEqual([]);
  expect(plan.blockers).toEqual(["no running projects to recover"]); expect(f.calls).toEqual([]);
  expect(() => preserveSource(plan, f.home)).toThrow("no running projects");
  expect(() => createOperation(plan, plan.sourceRoot, f.home, undefined, ID)).toThrow("no running projects");
  noPreservationEffects(f);
});


test("#610 a scoped recovery manager refresh never reads the shared target CLI or creates manager state", async () => {
  const f = fixture(), project = { ...f.a, pid: 123, instanceId: "fixture-source-a" };
  const source: Inspection = { state: "running", instanceId: project.instanceId, version: VERSION, protocol: 17, protocolMin: 16, protocolMax: 17, peers: [], blockers: [] };
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: TARGET, scope: { projectRoot: project.root },
    sourceRoot: PACKAGE_ROOT, sourceDigest: packageDigest(PACKAGE_ROOT),
    projects: [{ project, source, terminals: [], blockers: [] }], blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
  const op: RecoveryOperation = { schema: 3, id: ID, plan, createdAt: 1, updatedAt: 1, phase: "running", step: "refresh-manager", sourceRoot: PACKAGE_ROOT,
    targetDigest: DIGEST, projects: [{ id: project.id, phase: "verified", instanceId: "fixture-target-a", terminals: {} }] };
  let targetReads = 0;
  Object.defineProperty(op, "targetRoot", { enumerable: true, get() {
    targetReads++;
    throw new Error("scoped recovery must not construct a shared target CLI");
  } });
  // No manager manifest or real manager PID is installed. The throwing getter also makes the old path stop before any process launch.
  expect(existsSync(join(f.home, "manager"))).toBe(false);
  const driver = makeRecoveryDriver(f.run);
  if (!driver.refreshManager) throw new Error("actual recovery driver omitted its manager hook");
  await expect(driver.refreshManager(op)).resolves.toBeUndefined();
  expect(targetReads).toBe(0); expect(f.calls).toEqual([]);
  expect(existsSync(join(f.home, "manager"))).toBe(false);
  noPreservationEffects(f);
});
