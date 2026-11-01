import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { realPath } from "../src/hub/project.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "../src/hub/registry.ts";
import { projectRuntimeFile, writeProjectRuntimeState } from "../src/hub/project-runtime-state.ts";
import { planRuntimeCapturePrune, pruneRuntimeCaptures } from "../src/hub/runtime-capture-prune.ts";
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

test("#610 invalid receipt inventory or tampered captures defer all deletion", () => {
  const f = fixture(), first = f.capture(), second = f.capture();
  put(f.home, `recovery/${randomUUID()}.json`, "{");
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.any(String) });
  expect(existsSync(first.root)).toBe(true); expect(existsSync(second.root)).toBe(true);
  rmSync(join(f.home, "recovery"), { recursive: true });
  put(second.root, "src/changed.ts", "// deliberately altered capture\n");
  expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("verification") });
  expect(existsSync(first.root)).toBe(true); expect(existsSync(second.root)).toBe(true);
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
  const module = new URL("../src/hub/runtime-capture-prune.ts", import.meta.url);
  // Copy this one production module into a tiny package, with narrow re-exports to its real dependencies.
  put(f.source, "src/hub/runtime-capture-prune.ts", readFileSync(module, "utf8"));
  const reexport = (file: string, names: string, actual: string) => put(f.source, file, `export { ${names} } from ${JSON.stringify(new URL(actual, import.meta.url).href)};\n`);
  reexport("src/cli/recovery-package.ts", "verifyPackage", "../src/cli/recovery-package.ts");
  reexport("src/pi/process-signature.ts", "processLiveness", "../src/pi/process-signature.ts");
  reexport("src/hub/project.ts", "hubHome, realPath", "../src/hub/project.ts");
  reexport("src/hub/project-runtime-state.ts", "readProjectRuntime", "../src/hub/project-runtime-state.ts");
  reexport("src/hub/registry.ts", "Registry, REGISTRY_DB_BUSY_TIMEOUT_MS", "../src/hub/registry.ts");
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
