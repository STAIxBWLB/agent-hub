import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { realPath } from "../src/hub/project.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "../src/hub/registry.ts";
import { projectRuntimeFile, writeProjectRuntimeState } from "../src/hub/project-runtime-state.ts";
import { planRuntimeCapturePrune, pruneRuntimeCaptures, retireTerminalReceipts, scheduleRuntimeCapturePrune, RETAINED_TERMINAL_RECEIPTS, RUNTIME_PRUNE_INTERVAL_MS, RUNTIME_PRUNE_MAX_BATCH } from "../src/hub/runtime-capture-prune.ts";
import { stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import hubPackage from "../package.json";
import { createOperation, planFingerprint, type UpgradePlan } from "../src/cli/upgrade.ts";
import { claimRunner, operationPath, releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { runtimePruneHealth } from "../src/hub/runtime-prune-health.ts";
import { processSignature, processLiveness } from "../src/pi/process-signature.ts";

const VERSION = "0.99.0", CORE = "0.18.0", cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
function fixture(pins: Record<string, string> = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-capture-prune-"))), home = join(root, "home"), source = join(root, "package");
  mkdirSync(home); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION, dependencies: { "@staix/agent-mem": CORE } }));
  put(source, "src/cli/main.js", "// tiny first-party fixture\n");
  put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
  put(source, "plugins/agent-hub/server.js", "// fixture\n"); put(source, "templates/fixture.txt", "fixture\n"); put(source, ".claude-plugin/marketplace.json", "{}\n");
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `fixture ${name}\n`);
  const core = join(source, "node_modules/@staix/agent-mem");
  put(core, "package.json", JSON.stringify({ name: "@staix/agent-mem", version: CORE, main: "src/index.js", ...(Object.keys(pins).length ? { dependencies: pins } : {}) }));
  put(core, "src/index.js", "// first-party core fixture\n"); put(core, "bin/amem.js", "// fixture\n"); put(core, "README.md", "fixture\n"); put(core, "LICENSE", "fixture\n");
  for (const [name, version] of Object.entries(pins)) {
    const dependency = join(source, "node_modules", name);
    put(dependency, "package.json", JSON.stringify({ name, version }));
    for (const asset of ["src/index.js", "fixtures/example.json", "README.md", "LICENSE"]) put(dependency, asset, "fixture\n");
  }
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
  reexport("src/hub/runtime-package-assets.ts", "MEMORY_RUNTIME_LAYOUTS", "../src/hub/runtime-package-assets.ts");
  reexport("src/hub/project.ts", "hubHome, realPath", "../src/hub/project.ts");
  reexport("src/hub/project-runtime-state.ts", "readProjectRuntimeReference, projectRuntimeFile", "../src/hub/project-runtime-state.ts");
  reexport("src/hub/registry.ts", "Registry, REGISTRY_DB_BUSY_TIMEOUT_MS", "../src/hub/registry.ts");
  reexport("src/hub/child-process.ts", "childEnv", "../src/hub/child-process.ts");
  reexport("src/hub/recovery-store.ts", "anyRecoveryHold, retireOperation", "../src/hub/recovery-store.ts");
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

const recoveryPins = { "@staix/mcp-stdio": "0.2.0", "@staix/agent-hosts": "0.1.0" };
for (const pins of [Object.fromEntries(Object.entries(recoveryPins).slice(0, 1)), Object.fromEntries(Object.entries(recoveryPins).slice(1)), recoveryPins]) {
  test(`prune verifies and removes captures with ${Object.keys(pins).join(" and ")} (#1737)`, () => {
    const f = fixture(pins), capture = f.capture();
    expect(pruneRuntimeCaptures(f.home, 0)).toEqual({ removed: [capture.root], kept: [] });
    expect(existsSync(capture.root)).toBe(false);
  });
}

test("prune retains captures with unrecognized files or an unknown dependency sibling (#1737)", () => {
  for (const extra of ["@staix/unreviewed/extra.txt", "@staix/mcp-stdio/extra.txt", "@staix/agent-hosts/extra.txt"]) {
    const f = fixture(recoveryPins), capture = f.capture();
    put(capture.root, `node_modules/${extra}`, "not an owned asset");
    const result = pruneRuntimeCaptures(f.home, 0);
    expect(result.removed).toEqual([]);
    expect(result.deferred).toContain("unknown asset layout");
    expect(existsSync(join(capture.root, "node_modules", extra))).toBe(true);
  }
});

test("prune refuses a reviewed sibling that the capture did not hash (#1737)", () => {
  const f = fixture(), capture = f.capture(), name = "@staix/mcp-stdio";
  const extra = join(capture.root, "node_modules", name);
  put(extra, "package.json", JSON.stringify({ name, version: recoveryPins[name] }));
  for (const asset of ["src/index.js", "fixtures/example.json", "README.md", "LICENSE"]) put(extra, asset, "unowned");
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.removed).toEqual([]);
  expect(result.deferred).toContain("undeclared agent-mem dependency");
  expect(existsSync(extra)).toBe(true);
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

test("runtime pruning recognizes an exact output dependency without weakening layout checks", () => {
  const f = fixture(), output = join(f.source, "node_modules/@staix/cli-output");
  put(f.source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION, dependencies: { "@staix/agent-mem": CORE, "@staix/cli-output": hubPackage.dependencies["@staix/cli-output"] } }));
  put(output, "package.json", JSON.stringify({ name: "@staix/cli-output", version: hubPackage.dependencies["@staix/cli-output"], main: "src/index.js" }));
  put(output, "src/index.js", "export const fixture = true;\n"); put(output, "README.md", "fixture\n"); put(output, "LICENSE", "fixture\n");
  const captured = stageCurrentRuntime(f.source, VERSION, f.home, f.registry);
  expect(existsSync(join(captured.root, "node_modules/@staix/cli-output/src/index.js"))).toBe(true);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([captured.root]);
});

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

// #1120: the release checker is a known capture asset. Captures made before it was carried have no scripts directory and must still prune.
test("#1120 a capture that carries the release checker is removed like any verified orphan, and an older capture without it still is", () => {
  const f = fixture(); put(f.source, "scripts/check-docs.mjs", "// checker fixture\n");
  const withChecker = f.capture(), plain = f.capture();
  rmSync(join(plain.root, "scripts"), { recursive: true }); // what a capture made before #1120 looks like
  expect(existsSync(join(withChecker.root, "scripts/check-docs.mjs"))).toBe(true);
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed.sort()).toEqual([withChecker.root, plain.root].sort());
  expect(existsSync(withChecker.root)).toBe(false); expect(existsSync(plain.root)).toBe(false);
});

for (const [name, change] of [
  ["an unknown file beside the checker", (root: string) => put(root, "scripts/extra.mjs", "// unknown\n")],
  ["a checker that is a directory", (root: string) => { rmSync(join(root, "scripts/check-docs.mjs")); put(root, "scripts/check-docs.mjs/arbitrary.txt", "unknown\n"); }],
  ["a checker that is a symlink", (root: string) => { rmSync(join(root, "scripts/check-docs.mjs")); symlinkSync(join(root, "package.json"), join(root, "scripts/check-docs.mjs")); }],
  ["a scripts entry that is a file", (root: string) => { rmSync(join(root, "scripts"), { recursive: true }); put(root, "scripts", "not a directory\n"); }],
  ["an empty scripts directory", (root: string) => rmSync(join(root, "scripts/check-docs.mjs"))],
] as const) {
  test(`#1120 ${name} defers pruning without removing any capture`, () => {
    const f = fixture(); put(f.source, "scripts/check-docs.mjs", "// checker fixture\n");
    const orphan = f.capture(), capture = f.capture();
    change(capture.root);
    expect(pruneRuntimeCaptures(f.home, 0)).toMatchObject({ removed: [], deferred: expect.stringContaining("layout") });
    expect(existsSync(orphan.root)).toBe(true); expect(existsSync(capture.root)).toBe(true);
  });
}

/** #1541: a synthetic receipt of the shape the walk reads; `at` orders it, `age` 0 is the newest. */
function receipt(f: ReturnType<typeof fixture>, sourceRoot: string, options: { phase?: string; at?: number; runnerDb?: boolean } = {}): string {
  const id = randomUUID(), phase = options.phase ?? "completed", terminal = phase === "completed" || phase === "cancelled";
  const body = { schema: 1, id, phase, createdAt: options.at ?? 1, updatedAt: options.at ?? 1, sourceRoot, step: "fixture",
    plan: { schema: 1, kind: "upgrade", version: VERSION, sourceRoot, sourceDigest: "a".repeat(64), projects: [], blockers: [] }, projects: [],
    ...(phase === "completed" ? { targetRoot: sourceRoot, targetDigest: "a".repeat(64) } : {}) };
  void terminal;
  writeOperation(id, body, f.home);
  if (options.runnerDb !== false) { const db = new Database(`${operationPath(id, f.home)}.runner.db`, { create: true }); db.run("CREATE TABLE runner (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL, signature TEXT)"); db.close(); }
  return id;
}
const files = (f: ReturnType<typeof fixture>) => readdirSync(join(f.home, "recovery"));
const receiptsOf = (f: ReturnType<typeof fixture>) => files(f).filter(name => name.endsWith(".json"));
const orphans = (f: ReturnType<typeof fixture>) => files(f).filter(name => name.endsWith(".json.runner.db") && !existsSync(join(f.home, "recovery", name.slice(0, -".runner.db".length))));

test("#1541 AC1 140 terminal receipts and none open: one maintenance pass leaves a bounded set, pruning runs and doctor reads ok", () => {
  const f = fixture(), keep = f.capture(), orphan = f.capture();
  for (let i = 0; i < 140; i++) receipt(f, keep.root, { phase: i % 5 ? "completed" : "cancelled", at: 1000 + i });
  expect(planRuntimeCapturePrune(f.home, 0).deferred).toContain("safety ceiling");
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toBeUndefined(); expect(result.removed).toEqual([orphan.root]);
  expect(receiptsOf(f).length).toBe(RETAINED_TERMINAL_RECEIPTS); expect(orphans(f)).toEqual([]);
  expect(files(f).filter(name => name.endsWith(".runner.db")).length).toBe(RETAINED_TERMINAL_RECEIPTS);
  // The newest are the ones kept.
  const newest = receiptsOf(f).map(name => (JSON.parse(readFileSync(join(f.home, "recovery", name), "utf8")) as { updatedAt: number }).updatedAt);
  expect(Math.min(...newest)).toBe(1000 + 140 - RETAINED_TERMINAL_RECEIPTS);
  expect(runtimePruneHealth(f.home)).toEqual([]);
});

test("#1541 AC2 a non-terminal receipt is never removed, and a terminal receipt whose capture a registered runtime selects stays", () => {
  const f = fixture(), selectedCapture = f.capture(), other = f.capture(), project = f.project();
  writeProjectRuntimeState(project, { ...selectedCapture, kind: "restart" }, null);
  const oldSelected = receipt(f, selectedCapture.root, { at: 1 }), open = receipt(f, other.root, { phase: "blocked", at: 2 });
  const old = Array.from({ length: 40 }, (_, i) => receipt(f, other.root, { at: 10 + i }));
  for (let i = 0; i < RETAINED_TERMINAL_RECEIPTS; i++) receipt(f, other.root, { at: 1000 + i });
  const result = pruneRuntimeCaptures(f.home, 0);
  expect(result.deferred).toContain("not terminal"); expect(result.deferred).toContain(`ahub recovery status ${open}`);
  const left = receiptsOf(f);
  expect(left).toContain(`${open}.json`); expect(left).toContain(`${oldSelected}.json`); expect(existsSync(`${operationPath(open, f.home)}.runner.db`)).toBe(true);
  for (const id of old) { expect(left).not.toContain(`${id}.json`); expect(existsSync(`${operationPath(id, f.home)}.runner.db`)).toBe(false); }
  expect(existsSync(selectedCapture.root)).toBe(true);
});

test("#1541 any recovery hold, and a receipt whose runner is alive, stop retirement", () => {
  const f = fixture(), capture = f.capture(); f.capture();
  const ids = Array.from({ length: RETAINED_TERMINAL_RECEIPTS + 3 }, (_, i) => receipt(f, capture.root, { at: 10 + i }));
  writeFileSync(join(f.home, "recovery.lock"), JSON.stringify({ operationId: randomUUID() }));
  expect(retireTerminalReceipts(f.home, f.registry)).toBe(0); expect(receiptsOf(f).length).toBe(ids.length);
  rmSync(join(f.home, "recovery.lock"));
  const release = claimRunner(ids[0]!, f.home);
  try { expect(retireTerminalReceipts(f.home, f.registry)).toBe(2); expect(receiptsOf(f)).toContain(`${ids[0]}.json`); }
  finally { release(); }
  expect(retireTerminalReceipts(f.home, f.registry)).toBe(1); expect(receiptsOf(f).length).toBe(RETAINED_TERMINAL_RECEIPTS);
});

test("#1541 AC3 a pass interrupted between a receipt and its runner db leaves no orphan after the next pass", () => {
  const f = fixture(), capture = f.capture();
  for (let i = 0; i < RETAINED_TERMINAL_RECEIPTS + 4; i++) receipt(f, capture.root, { at: 10 + i });
  expect(() => retireTerminalReceipts(f.home, f.registry, { betweenPair: () => { throw new Error("simulated crash"); } })).toThrow("simulated crash");
  // The receipt left first, so the stranded half is a runner db; the next pass settles it and finishes the rest.
  expect(orphans(f).length).toBe(1);
  retireTerminalReceipts(f.home, f.registry);
  expect(orphans(f)).toEqual([]); expect(receiptsOf(f).length).toBe(RETAINED_TERMINAL_RECEIPTS);
  expect(files(f).filter(name => name.endsWith(".runner.db")).length).toBe(RETAINED_TERMINAL_RECEIPTS);
});

test("#1541 AC4 more than 128 open receipts, or a ceiling that retention did not clear: the refusal names the cause and a supported command, not runtime-prune.db", () => {
  const f = fixture(), capture = f.capture();
  for (let i = 0; i < 130; i++) receipt(f, capture.root, { phase: "blocked", at: i });
  const open = planRuntimeCapturePrune(f.home, 0);
  expect(open.deferred).toContain("not terminal"); expect(open.deferred).toContain("ahub recovery status "); expect(open.deferred).toContain("resume or abort");
  expect(open.deferred).not.toContain("runtime-prune.db"); expect(receiptsOf(f).length).toBe(130);
  expect(pruneRuntimeCaptures(f.home, 0).deferred).toContain("ahub recovery status ");
  // Terminal receipts above the ceiling (a preview never retires them) say what clears them.
  const g = fixture(), kept = g.capture();
  for (let i = 0; i < 130; i++) receipt(g, kept.root, { at: i });
  const ceiling = planRuntimeCapturePrune(g.home, 0).deferred;
  expect(ceiling).toContain("safety ceiling"); expect(ceiling).toContain("next maintenance pass"); expect(ceiling).not.toContain("runtime-prune.db");
});
