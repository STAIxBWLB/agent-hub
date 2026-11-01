import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { realPath } from "../src/hub/project.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "../src/hub/registry.ts";
import { projectRuntimeFile, writeProjectRuntimeState } from "../src/hub/project-runtime-state.ts";
import { planRuntimeCapturePrune, pruneRuntimeCaptures, scheduleRuntimeCapturePrune, RUNTIME_PRUNE_INTERVAL_MS, RUNTIME_PRUNE_MAX_BATCH } from "../src/hub/runtime-capture-prune.ts";
import { stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import { createOperation, planFingerprint, type UpgradePlan } from "../src/cli/upgrade.ts";
import { releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { processSignature, processLiveness } from "../src/pi/process-signature.ts";

const VERSION = "0.99.0", CORE = "0.18.0", cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-capture-prune-"))), home = join(root, "home"), source = join(root, "package");
  mkdirSync(home); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION, dependencies: { "@staix/agent-mem": CORE } }));
  put(source, "src/cli/main.js", "// tiny first-party fixture\n");
  put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
  put(source, "plugins/agent-hub/server.js", "// fixture\n"); put(source, "templates/fixture.txt", "fixture\n"); put(source, ".claude-plugin/marketplace.json", "{}\n");
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `fixture ${name}\n`);
  const core = join(source, "node_modules/@staix/agent-mem");
  put(core, "package.json", JSON.stringify({ name: "@staix/agent-mem", version: CORE, main: "src/index.js" }));
  put(core, "src/index.js", "// first-party core fixture\n"); put(core, "bin/amem.js", "// fixture\n"); put(core, "README.md", "fixture\n"); put(core, "LICENSE", "fixture\n");
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  let revision = 0;
  const capture = (version = VERSION) => {
    put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version, dependencies: { "@staix/agent-mem": CORE } }));
    put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version }));
    put(source, "src/revision.ts", `export const revision = ${++revision};\n`);
    const value = stageCurrentRuntime(source, version, home, registry);
    utimesSync(value.root, 1000 + revision, 1000 + revision);
    return value;
  };
  const project = (name = "project") => { const cwd = join(root, name); mkdirSync(cwd); return registry.register(cwd); };
  return { root, home, source, registry, capture, project };
}

function copyPruner(target: string, verifier?: string): string {
  const file = join(target, "src/hub/runtime-capture-prune.ts");
  put(target, "src/hub/runtime-capture-prune.ts", readFileSync(new URL("../src/hub/runtime-capture-prune.ts", import.meta.url), "utf8"));
  const reexport = (relative: string, names: string, actual: string) => put(target, relative, `export { ${names} } from ${JSON.stringify(new URL(actual, import.meta.url).href)};\n`);
  if (verifier) put(target, "src/cli/recovery-package.ts", verifier);
  else reexport("src/cli/recovery-package.ts", "verifyPackage", "../src/cli/recovery-package.ts");
  reexport("src/pi/process-signature.ts", "processLiveness, processSignature", "../src/pi/process-signature.ts");
  reexport("src/hub/project.ts", "hubHome, realPath", "../src/hub/project.ts");
  reexport("src/hub/project-runtime-state.ts", "readProjectRuntimeReference, projectRuntimeFile", "../src/hub/project-runtime-state.ts");
  reexport("src/hub/registry.ts", "Registry, REGISTRY_DB_BUSY_TIMEOUT_MS", "../src/hub/registry.ts");
  reexport("src/hub/child-process.ts", "childEnv", "../src/hub/child-process.ts");
  return file;
}

function managerReference(f: ReturnType<typeof fixture>, runtimeRoot?: string, options: { dead?: boolean; mismatch?: boolean; missingManifest?: boolean; legacyOwner?: boolean } = {}) {
  const manager = join(f.home, "manager"), signature = processSignature(process.pid);
  if (!signature) throw new Error("manager fixture process identity is unavailable");
  mkdirSync(manager);
  const recordedSignature = options.dead ? `retired-${signature}` : signature;
  if (options.dead) expect(processLiveness(process.pid, recordedSignature)).toBe("gone");
  const db = new Database(join(manager, "owner.db"), { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    db.run(`CREATE TABLE owner (slot INTEGER PRIMARY KEY, instance_id TEXT, pid INTEGER${options.legacyOwner ? "" : ", signature TEXT"})`);
    if (options.legacyOwner) db.query("INSERT INTO owner VALUES(1,?,?)").run("manager-fixture", process.pid);
    else db.query("INSERT INTO owner VALUES(1,?,?,?)").run("manager-fixture", process.pid, recordedSignature);
  } finally { db.close(); }
  if (!options.missingManifest) put(manager, "status.json", JSON.stringify({ instanceId: options.mismatch ? "different-manager" : "manager-fixture", pid: process.pid,
    pidSignature: recordedSignature, ...(runtimeRoot === undefined ? {} : { runtimeRoot }) }));
}

test("#610 pruning keeps newest captures per version and only removes verified orphan source captures", () => {
  const f = fixture(), first = f.capture(), second = f.capture(), third = f.capture(), other = f.capture("0.98.0");
  const before = planRuntimeCapturePrune(f.home, 1);
  expect(before.deferred).toBeUndefined(); expect(before.remove.sort()).toEqual([first.root, second.root].sort());
  expect(before.kept.sort()).toEqual([third.root, other.root].sort()); expect(existsSync(first.root)).toBe(true);
  const result = pruneRuntimeCaptures(f.home, 1);
  expect(result.deferred).toBeUndefined(); expect(result.removed.sort()).toEqual(before.remove.sort());
  for (const value of [first, second]) expect(existsSync(value.root)).toBe(false);
  for (const value of [third, other]) expect(existsSync(value.root)).toBe(true);
});

test("#610 one prune call limits deletion work to a small candidate batch", () => {
  const f = fixture(), captures = Array.from({ length: RUNTIME_PRUNE_MAX_BATCH + 2 }, () => f.capture());
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toHaveLength(RUNTIME_PRUNE_MAX_BATCH);
  expect(result.kept).toHaveLength(2);
  expect(captures.filter(row => existsSync(row.root))).toHaveLength(2);
});

test("#610 stopped project pointers and matching live claims retain their captures beyond newest N", () => {
  const f = fixture(), stopped = f.capture(), live = f.capture(), orphan = f.capture();
  const one = f.project("stopped"), two = f.project("live"), instance = "fixture-live";
  f.registry.runtimeCaptureLocked(() => {
    writeProjectRuntimeState(one, { ...stopped, kind: "restart" }, null);
    expect(f.registry.claim(two.id, instance, process.pid, processSignature(process.pid))).toBe(true);
    writeProjectRuntimeState(two, { ...live, kind: "restart" }, instance);
  });
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([orphan.root]);
  expect(result.kept.sort()).toEqual([stopped.root, live.root].sort());
});

test("#610 an owned live manager retains its old capture without retaining unrelated captures", () => {
  const f = fixture(), manager = f.capture(), orphan = f.capture();
  managerReference(f, manager.root);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.kept).toEqual([manager.root]); expect(result.removed).toEqual([orphan.root]);
});

for (const kind of ["legacy", "mismatch", "missing-manifest"] as const) {
  test(`#610 a live manager with ${kind} runtime attribution defers all deletion`, () => {
    const f = fixture(), capture = f.capture();
    managerReference(f, kind === "legacy" ? undefined : capture.root, { mismatch: kind === "mismatch", missingManifest: kind === "missing-manifest", legacyOwner: kind === "legacy" });
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.any(String) });
    expect(existsSync(capture.root)).toBe(true);
  });
}

test("#610 positively gone manager metadata no longer retains its capture", () => {
  const f = fixture(), capture = f.capture();
  managerReference(f, capture.root, { dead: true });
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([capture.root]);
});

test("#610 a mutable ancestor manager runtime does not retain captures beneath it", () => {
  const f = fixture(), capture = f.capture();
  managerReference(f, f.root);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([capture.root]);
});

for (const kind of ["missing", "different-instance", "invalid"] as const) {
  test(`#610 a ${kind} runtime pointer under a live claim defers every deletion`, () => {
    const f = fixture(), capture = f.capture(), project = f.project(), instance = "fixture-live";
    f.registry.runtimeCaptureLocked(() => {
      expect(f.registry.claim(project.id, instance, process.pid, processSignature(process.pid))).toBe(true);
      if (kind === "different-instance") writeProjectRuntimeState(project, { ...capture, kind: "restart" }, "other-instance");
      if (kind === "invalid") put(project.stateDir, "runtime.json", "{");
    });
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.any(String) });
    expect(existsSync(capture.root)).toBe(true);
  });
}

for (const kind of ["missing-capture", "wrong-digest", "linked-root", "noncanonical-root"] as const) {
  test(`#610 a matching live claim with a ${kind} package reference defers every deletion`, () => {
    const f = fixture(), capture = f.capture(), orphan = f.capture(), project = f.project(), instance = "fixture-live";
    f.registry.runtimeCaptureLocked(() => {
      expect(f.registry.claim(project.id, instance, process.pid, processSignature(process.pid))).toBe(true);
      const selected = { ...capture, kind: "restart" as const };
      if (kind === "wrong-digest") selected.digest = capture.digest === "e".repeat(64) ? "f".repeat(64) : "e".repeat(64);
      if (kind === "linked-root") { const link = join(f.root, "capture-alias"); symlinkSync(capture.root, link); selected.root = link; }
      const record = writeProjectRuntimeState(project, selected, instance);
      if (kind === "noncanonical-root") put(project.stateDir, "runtime.json", JSON.stringify({ ...record, root: `${capture.root}/.` }));
      if (kind === "missing-capture") rmSync(capture.root, { recursive: true });
    });
    const result = pruneRuntimeCaptures(f.home, 0);
    expect(result).toMatchObject({ removed: [], deferred: expect.any(String) });
    expect(existsSync(orphan.root)).toBe(true);
  });
}

test("#610 referenced capture contents are retained without hashing or treating their mutation as deletion authority", () => {
  const f = fixture(), capture = f.capture(), orphan = f.capture(), project = f.project();
  f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(project, { ...capture, kind: "restart" }, null));
  put(capture.root, "src/revision.ts", "// referenced capture remains protected despite changed contents\n");
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.kept).toEqual([capture.root]); expect(result.removed).toEqual([orphan.root]);
  expect(readFileSync(join(capture.root, "src/revision.ts"), "utf8")).toContain("remains protected");
});

test("#610 an unverifiable stopped-project package reference also defers pruning", () => {
  const f = fixture(), capture = f.capture(), orphan = f.capture(), project = f.project();
  const digest = capture.digest === "e".repeat(64) ? "f".repeat(64) : "e".repeat(64);
  f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(project, { ...capture, digest, kind: "restart" }, null));
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.any(String) });
  expect(existsSync(capture.root)).toBe(true); expect(existsSync(orphan.root)).toBe(true);
});

function recovery(f: ReturnType<typeof fixture>, source: ReturnType<typeof f.capture>, target: ReturnType<typeof f.capture>) {
  const project = f.project(), body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: target.version,
    sourceRoot: source.root, sourceDigest: source.digest, integrity: "sha512-fixture", scope: { projectRoot: project.root },
    projects: [{ project, source: { state: "running", instanceId: "fixture-source", peers: [], blockers: [] }, terminals: [], blockers: [] }], blockers: [] };
  const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, source.root, f.home, undefined, randomUUID());
  op.targetRoot = target.root; op.targetDigest = target.digest;
  return op;
}

test("#610 every nonterminal recovery defers pruning, and retained terminal receipts protect source and target captures", () => {
  const f = fixture(), source = f.capture(), target = f.capture(), orphan = f.capture(), op = recovery(f, source, target);
  // A retained receipt is independently protective even after its coordinator/hold has gone away.
  releaseRecoveryLock(op.id, f.home, op.plan.scope!.projectRoot);
  for (const phase of ["pending", "running", "blocked"] as const) {
    op.phase = phase; writeOperation(op.id, op, f.home);
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("not terminal") });
    expect(existsSync(orphan.root)).toBe(true);
  }
  op.phase = "completed"; writeOperation(op.id, op, f.home);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([orphan.root]);
  expect(result.kept.sort()).toEqual([source.root, target.root].sort());
});

test("#610 cancelled pre-stage and legacy terminal receipt schemas remain readable retention references", () => {
  const f = fixture(), source = f.capture(), target = f.capture(), orphan = f.capture(), op = recovery(f, source, target);
  releaseRecoveryLock(op.id, f.home, op.plan.scope!.projectRoot);
  const { scope: _scope, fingerprint: _fingerprint, ...legacyBody } = op.plan;
  const legacyPlan = { ...legacyBody, fingerprint: planFingerprint(legacyBody) };
  const legacy = { ...op, schema: 1, phase: "cancelled", plan: legacyPlan, targetRoot: undefined, targetDigest: undefined };
  writeOperation(op.id, legacy, f.home);
  const cancelled = planRuntimeCapturePrune(f.home, 0);
  expect(cancelled.deferred).toBeUndefined(); expect(cancelled.kept).toEqual([source.root]);
  for (const [schema, phase] of [[1, "completed"], [2, "cancelled"], [3, "completed"]] as const) {
    writeOperation(op.id, { ...op, schema, phase, plan: schema === 3 ? op.plan : legacyPlan,
      ...(schema === 2 ? { disposition: { choice: "stop-and-archive", at: 1, projects: {} } } : {}) }, f.home);
    const plan = planRuntimeCapturePrune(f.home, 0);
    expect(plan.deferred).toBeUndefined(); expect(plan.kept.sort()).toEqual([source.root, target.root].sort());
    expect(plan.remove).toEqual([orphan.root]);
  }
});

test("#610 invalid receipt inventory defers all deletion and tampered candidate contents remain inspectable", () => {
  const f = fixture(), first = f.capture(), second = f.capture();
  put(f.home, `recovery/${randomUUID()}.json`, "{");
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.any(String) });
  expect(existsSync(first.root)).toBe(true); expect(existsSync(second.root)).toBe(true);
  rmSync(join(f.home, "recovery"), { recursive: true });
  put(second.root, "src/changed.ts", "// deliberately altered capture\n");
  const before = lstatSync(second.root), result = pruneRuntimeCaptures(f.home, 0);
  // ponytail: Bun 1.4.2 replaces matched array elements; isolate the matcher until the runner preserves its input.
  expect(structuredClone(result)).toMatchObject({ deferred: expect.stringContaining("verification"), quarantined: [expect.any(String)] });
  expect(result.removed).not.toContain(second.root);
  const retained = join(result.quarantined![0]!, "capture"), after = lstatSync(retained);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect(readFileSync(join(retained, "src/changed.ts"), "utf8")).toBe("// deliberately altered capture\n");
});

for (const name of ["README.md", "LICENSE", "CHANGELOG.md"] as const) {
  test(`#610 a ${name} directory with unknown contents defers pruning without removing any capture`, () => {
    const f = fixture(), orphan = f.capture(), capture = f.capture();
    rmSync(join(capture.root, name));
    put(capture.root, `${name}/arbitrary.txt`, "unknown directory contents must remain\n");
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("layout") });
    expect(existsSync(orphan.root)).toBe(true);
    expect(readFileSync(join(capture.root, name, "arbitrary.txt"), "utf8")).toBe("unknown directory contents must remain\n");
  });
}

test("#610 first-party core metadata directories are not valid capture assets", () => {
  const f = fixture(), orphan = f.capture(), capture = f.capture();
  const readme = join(capture.root, "node_modules/@staix/agent-mem/README.md");
  rmSync(readme); put(readme, "arbitrary.txt", "unknown core metadata contents\n");
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("layout") });
  expect(existsSync(orphan.root)).toBe(true); expect(existsSync(join(readme, "arbitrary.txt"))).toBe(true);
});

test("#610 missing required metadata and a source directory replaced by a file both defer pruning", () => {
  for (const name of ["LICENSE", "src"]) {
    const f = fixture(), orphan = f.capture(), capture = f.capture();
    rmSync(join(capture.root, name), { recursive: true });
    if (name === "src") put(capture.root, name, "not a directory\n");
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("layout") });
    expect(existsSync(orphan.root)).toBe(true); expect(existsSync(capture.root)).toBe(true);
  }
});

test("#610 registry installs, legacy sources, temporary directories and capture symlinks are never pruned", () => {
  const f = fixture(), capture = f.capture(), version = join(f.home, "releases", VERSION), outside = join(f.root, "outside");
  mkdirSync(outside); put(outside, "keep.txt", "outside\n");
  const ignored = [join(version, "registry"), join(f.home, "releases", `source-${"a".repeat(64)}`), join(version, ".source-fixture"), join(f.home, "releases", "unknown")];
  ignored.push(join(version, `source-${"e".repeat(64)}\n`), join(f.home, "releases", `${VERSION}\n`, `source-${"d".repeat(64)}`));
  for (const dir of ignored) { mkdirSync(dir, { recursive: true }); put(dir, "keep.txt", "retained\n"); }
  const link = join(version, `source-${"f".repeat(64)}`); symlinkSync(outside, link);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([capture.root]);
  for (const dir of [...ignored, outside, link]) expect(existsSync(join(dir, "keep.txt"))).toBe(true);
});

test("#610 registry locking nests on one connection across capture publication and pointer publication", () => {
  const f = fixture(), project = f.project();
  const captured = f.registry.runtimeCaptureLocked(() => f.registry.runtimeCaptureLocked(() => {
    const runtime = stageCurrentRuntime(f.source, VERSION, f.home, f.registry);
    writeProjectRuntimeState(project, { ...runtime, kind: "restart" }, null); return runtime;
  }));
  expect(existsSync(projectRuntimeFile(project))).toBe(true);
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], kept: [captured.root] });
});

test("#610 a CLI executing from a verified capture protects itself without protecting unrelated captures", async () => {
  const f = fixture();
  // Copy this one production module into a tiny package, with narrow re-exports to its real dependencies.
  copyPruner(f.source);
  const executing = f.capture(), orphan = f.capture();
  const captured = await import(pathToFileURL(join(executing.root, "src/hub/runtime-capture-prune.ts")).href) as typeof import("../src/hub/runtime-capture-prune.ts");
  const result = captured.pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.kept).toEqual([executing.root]); expect(result.removed).toEqual([orphan.root]);
  expect(existsSync(executing.root)).toBe(true);
});

test("#610 pruning waits for an in-flight publisher to commit its capture reference", async () => {
  const f = fixture(), project = f.project(), held = join(f.root, "held"), release = join(f.root, "release"), trying = join(f.root, "trying"), result = join(f.root, "result.json");
  const registryModule = new URL("../src/hub/registry.ts", import.meta.url).pathname, packageModule = new URL("../src/cli/recovery-package.ts", import.meta.url).pathname;
  const stateModule = new URL("../src/hub/project-runtime-state.ts", import.meta.url).pathname, pruneModule = new URL("../src/hub/runtime-capture-prune.ts", import.meta.url).pathname;
  const publisher = join(f.root, "publisher.ts"), pruner = join(f.root, "pruner.ts");
  writeFileSync(publisher, `import { existsSync, writeFileSync } from 'node:fs';
import { Registry } from ${JSON.stringify(registryModule)};
import { stageCurrentRuntime } from ${JSON.stringify(packageModule)};
import { writeProjectRuntimeState } from ${JSON.stringify(stateModule)};
const registry = new Registry(${JSON.stringify(join(f.home, "registry.db"))});
try { registry.runtimeCaptureLocked(() => {
 const runtime = stageCurrentRuntime(${JSON.stringify(f.source)}, ${JSON.stringify(VERSION)}, ${JSON.stringify(f.home)}, registry);
 writeFileSync(${JSON.stringify(held)}, 'held');
 const end = Date.now() + 10000;
 while (!existsSync(${JSON.stringify(release)}) && Date.now() < end) Bun.sleepSync(5);
 if (!existsSync(${JSON.stringify(release)})) throw new Error('publisher barrier not released');
 writeProjectRuntimeState(${JSON.stringify(project)}, { ...runtime, kind: 'restart' }, null);
}); } finally { registry.close(); }
`);
  writeFileSync(pruner, `import { writeFileSync } from 'node:fs';
import { pruneRuntimeCaptures } from ${JSON.stringify(pruneModule)};
writeFileSync(${JSON.stringify(trying)}, 'trying');
writeFileSync(${JSON.stringify(result)}, JSON.stringify(pruneRuntimeCaptures(${JSON.stringify(f.home)}, 0)));
`);
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: f.home };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
  const children: Bun.Subprocess<"ignore", "ignore", "pipe">[] = [];
  const wait = async (file: string) => { for (let i = 0; i < 2000 && !existsSync(file); i++) await Bun.sleep(5); expect(existsSync(file), file).toBe(true); };
  try {
    const writer = Bun.spawn([process.execPath, publisher], { env, stdout: "ignore", stderr: "pipe" }); children.push(writer);
    await wait(held);
    const collector = Bun.spawn([process.execPath, pruner], { env, stdout: "ignore", stderr: "pipe" }); children.push(collector);
    await wait(trying);
    expect(existsSync(result)).toBe(false); // the writer owns the same registry lock before the reference exists
    writeFileSync(release, "release");
    for (const child of children) expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ removed: [], kept: [expect.any(String)] });
    const pointer = JSON.parse(readFileSync(projectRuntimeFile(project), "utf8"));
    expect(existsSync(pointer.root)).toBe(true);
  } finally {
    writeFileSync(release, "release");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited));
  }
}, 20_000);

interface ScheduleRow { id: string; admitted_at: number; phase: string; pid: number | null; outcome: string | null; signature: string | null }
function scheduleRow(home: string): ScheduleRow | undefined {
  const file = join(home, "runtime-prune.db"); if (!existsSync(file)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    return db.query("SELECT id,admitted_at,phase,pid,outcome,signature FROM admission WHERE slot=1").get() as ScheduleRow | undefined;
  } catch { return undefined; } // another process may still be initializing the exclusively created ledger
  finally { db?.close(); }
}

function seedSchedule(home: string, row: Omit<ScheduleRow, "outcome">, legacy = false): void {
  const file = join(home, "runtime-prune.db"); writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  const db = new Database(file, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    db.run(`CREATE TABLE admission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, admitted_at INTEGER NOT NULL, phase TEXT NOT NULL, pid INTEGER, outcome TEXT${legacy ? "" : ", signature TEXT"})`);
    if (legacy) db.query("INSERT INTO admission VALUES(1,?,?,?,?,NULL)").run(row.id, row.admitted_at, row.phase, row.pid);
    else db.query("INSERT INTO admission VALUES(1,?,?,?,?,NULL,?)").run(row.id, row.admitted_at, row.phase, row.pid, row.signature);
  } finally { db.close(); }
}

const workerEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
  return env;
};
const waitForFile = async (file: string) => {
  for (let i = 0; i < 2000 && !existsSync(file); i++) await Bun.sleep(5);
  expect(existsSync(file), file).toBe(true);
};

test("#610 exact legacy ledger schema migrates without treating an unsigned running PID as dead", async () => {
  const f = fixture(), id = randomUUID();
  seedSchedule(f.home, { id, admitted_at: 0, phase: "running", pid: process.pid, signature: null }, true);
  scheduleRuntimeCapturePrune(f.home);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(scheduleRow(f.home)).toMatchObject({ id, phase: "running", pid: process.pid, signature: null });
});

test("#610 a positively gone signed running owner is replaced on next admission, and its old child cannot claim the new token", async () => {
  const f = fixture(); f.capture();
  const signature = processSignature(process.pid); expect(signature).toBeString();
  const retired = `retired-${signature}`, old = randomUUID();
  expect(processLiveness(process.pid, retired)).toBe("gone");
  seedSchedule(f.home, { id: old, admitted_at: Date.now(), phase: "running", pid: process.pid, signature: retired });
  let replacement: ScheduleRow | undefined;
  try {
    scheduleRuntimeCapturePrune(f.home);
    for (let i = 0; i < 2000; i++) {
      const row = scheduleRow(f.home);
      if (row?.id !== old && row?.phase === "complete") { replacement = row; break; }
      await Bun.sleep(5);
    }
    expect(replacement?.phase).toBe("complete"); expect(replacement!.id).not.toBe(old); expect(replacement!.signature).toBeString();
    const module = new URL("../src/hub/runtime-capture-prune.ts", import.meta.url).pathname;
    const stale = Bun.spawn([process.execPath, module, f.home, old], { cwd: f.root, env: workerEnv(f.home), stdout: "ignore", stderr: "pipe" });
    expect(await stale.exited, await new Response(stale.stderr).text()).toBe(0);
    expect(scheduleRow(f.home)).toEqual(replacement);
  } finally {
    const row = scheduleRow(f.home);
    if (row?.id !== old && row?.pid && row.signature && processSignature(row.pid) === row.signature) {
      try { process.kill(row.pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 200 && processLiveness(row.pid, row.signature) !== "gone"; i++) await Bun.sleep(5);
      expect(processLiveness(row.pid, row.signature)).toBe("gone");
    }
  }
}, 20_000);

for (const replace of [false, true]) test(`#610 a busy worker completion ${replace ? "cannot overwrite a replacement token" : "waits for the ledger writer and completes"}`, async () => {
  const f = fixture(); for (let i = 0; i < 4; i++) f.capture();
  const held = join(f.root, "verifier-held"), release = join(f.root, "verifier-release"), attempt = join(f.root, "completion-attempt"), id = randomUUID();
  seedSchedule(f.home, { id, admitted_at: Date.now(), phase: "scheduled", pid: null, signature: null });
  const actual = new URL("../src/cli/recovery-package.ts", import.meta.url).href;
  const verifier = `import { existsSync, writeFileSync } from "node:fs";
import { verifyPackage as actual } from ${JSON.stringify(actual)};
export function verifyPackage(...args: Parameters<typeof actual>) {
 writeFileSync(${JSON.stringify(held)}, "held");
 const deadline = Date.now() + 10000;
 while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Bun.sleepSync(5);
 if (!existsSync(${JSON.stringify(release)})) throw new Error("fixture verifier was never released");
 return actual(...args);
}
`;
  const module = copyPruner(join(f.root, "worker"), verifier), source = readFileSync(module, "utf8");
  const sql = "UPDATE admission SET phase='complete',outcome=? WHERE slot=1 AND id=? AND phase='running'";
  const line = `db.query(${JSON.stringify(sql)}).run(outcome, id);`;
  expect(source.split(line)).toHaveLength(2);
  // A test-only statement adapter marks the exact run call; it changes neither SQL nor its id/phase fence.
  writeFileSync(module, 'import { writeFileSync as fixtureWrite } from "node:fs";\n' + source.replace(line,
    `const fixtureCompletion = db.query(${JSON.stringify(sql)}); fixtureWrite(${JSON.stringify(attempt)}, "attempt"); fixtureCompletion.run(outcome, id);`));
  const worker = Bun.spawn([process.execPath, module, f.home, id], { cwd: f.root, env: workerEnv(f.home), stdout: "ignore", stderr: "pipe" });
  let ledger: Database | undefined, holding = false;
  const next = randomUUID();
  try {
    await waitForFile(held);
    const running = scheduleRow(f.home);
    expect(running).toMatchObject({ id, phase: "running", pid: worker.pid }); expect(running!.signature).toBeString();
    ledger = new Database(join(f.home, "runtime-prune.db"));
    ledger.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    ledger.run("BEGIN IMMEDIATE"); holding = true;
    if (replace) ledger.query("UPDATE admission SET id=?,phase='scheduled',pid=NULL,signature=NULL,outcome='replacement evidence' WHERE slot=1").run(next);
    writeFileSync(release, "release");
    await waitForFile(attempt);
    // After the exact completion run marker, retain contention beyond the former 1ms worker timeout.
    await Bun.sleep(20);
    expect(worker.exitCode).toBeNull();
    ledger.run("COMMIT"); holding = false;
    expect(await worker.exited, await new Response(worker.stderr).text()).toBe(0);
    const completed = scheduleRow(f.home);
    if (replace) expect(completed).toMatchObject({ id: next, phase: "scheduled", signature: null, outcome: "replacement evidence" });
    else {
      expect(completed).toMatchObject({ id, phase: "complete", pid: worker.pid });
      expect(JSON.parse(completed!.outcome!)).toMatchObject({ removed: 1, quarantined: [] });
    }
  } finally {
    writeFileSync(release, "release");
    if (holding) { try { ledger?.run("ROLLBACK"); } catch {} }
    ledger?.close();
    if (worker.exitCode === null) worker.kill("SIGTERM");
    await worker.exited;
  }
}, 20_000);

test("#610 maintenance admits after startup returns, rate-limits across processes and fences stale children", async () => {
  const f = fixture(); f.capture();
  let identity: { pid: number; signature: string } | undefined;
  try {
    scheduleRuntimeCapturePrune(f.home);
    expect(existsSync(join(f.home, "runtime-prune.db"))).toBe(false);
    let completed: ScheduleRow | undefined;
    for (let i = 0; i < 2000; i++) {
      const row = scheduleRow(f.home);
      if (row?.pid && !identity) { const signature = processSignature(row.pid); if (signature) identity = { pid: row.pid, signature }; }
      if (row?.phase === "complete") { completed = row; break; }
      await Bun.sleep(5);
    }
    expect(completed?.phase).toBe("complete");
    expect(lstatSync(join(f.home, "runtime-prune.db")).mode & 0o077).toBe(0);
    expect(JSON.parse(completed!.outcome!)).toMatchObject({ removed: 0, quarantined: [] });
    const module = new URL("../src/hub/runtime-capture-prune.ts", import.meta.url).pathname, caller = join(f.root, "schedule.ts");
    writeFileSync(caller, `import { scheduleRuntimeCapturePrune } from ${JSON.stringify(module)}; scheduleRuntimeCapturePrune(${JSON.stringify(f.home)});\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: f.home };
    for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
    const other = Bun.spawn([process.execPath, caller], { cwd: f.root, env, stdout: "ignore", stderr: "pipe" });
    expect(await other.exited, await new Response(other.stderr).text()).toBe(0);
    expect(scheduleRow(f.home)?.id).toBe(completed!.id);
    const replacement = randomUUID(), db = new Database(join(f.home, "runtime-prune.db"));
    try {
      db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
      db.query("UPDATE admission SET id=?,phase='scheduled' WHERE slot=1").run(replacement);
    } finally { db.close(); }
    const stale = Bun.spawn([process.execPath, module, f.home, completed!.id], { cwd: f.root, env, stdout: "ignore", stderr: "pipe" });
    expect(await stale.exited, await new Response(stale.stderr).text()).toBe(0);
    expect(scheduleRow(f.home)).toMatchObject({ id: replacement, phase: "scheduled" });
    const active = new Database(join(f.home, "runtime-prune.db"));
    try {
      active.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
      const signature = processSignature(process.pid); expect(signature).toBeString();
      active.query("UPDATE admission SET phase='running',admitted_at=?,pid=?,signature=? WHERE slot=1").run(Date.now() - RUNTIME_PRUNE_INTERVAL_MS * 2, process.pid, signature!);
    } finally { active.close(); }
    scheduleRuntimeCapturePrune(f.home);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(scheduleRow(f.home)).toMatchObject({ id: replacement, phase: "running" });
  } finally {
    // Only the worker this private fixture ledger admitted may be signaled; a reused PID never qualifies.
    if (identity && processSignature(identity.pid) === identity.signature) {
      try { process.kill(identity.pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 200 && processLiveness(identity.pid, identity.signature) !== "gone"; i++) await Bun.sleep(5);
      expect(processLiveness(identity.pid, identity.signature)).toBe("gone");
    }
  }
}, 20_000);
