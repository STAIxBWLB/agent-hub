import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { confirmProjectRuntime, recordProjectRuntime, resolveProjectRuntime, verifyProjectRuntime } from "../src/hub/project-runtime.ts";
import { projectRuntimeFile, readProjectRuntime, writeProjectRuntimeState, type ProjectRuntimeSelection } from "../src/hub/project-runtime-state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

/** Tiny data-only first-party package trees prove updated selector behavior, not published old CLI execution. */
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-project-runtime-"))), home = join(root, "home");
  mkdirSync(home); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const inherited = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = home;
  cleanup.push(() => { if (inherited === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = inherited; });
  let registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  let packages = 0;
  const source = (version = "0.27.0", marker = "original") => {
    const cwd = join(root, `package-${++packages}`);
    put(cwd, "package.json", JSON.stringify({ name: "@staix/agent-hub", version }));
    put(cwd, "src/cli/main.js", `// ${marker} fixture CLI\n`);
    put(cwd, "src/cli/main.ts", `export const marker = ${JSON.stringify(marker)};\n`);
    put(cwd, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version }));
    for (const directory of ["templates", ".claude-plugin"]) mkdirSync(join(cwd, directory));
    for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) put(cwd, file, `fixture ${file}\n`);
    return cwd;
  };
  const project = (name = "project") => {
    const cwd = join(root, name); put(cwd, ".agenthub/config.json", "{}\n");
    return registry.register(cwd);
  };
  const capture = (version = "0.27.0", marker = "original", kind: ProjectRuntimeSelection["kind"] = "restart") => {
    const sourceRoot = source(version, marker);
    return { sourceRoot, selection: { ...stageCurrentRuntime(sourceRoot, version, home, registry), kind } };
  };
  const bind = (p: Project, selection: ProjectRuntimeSelection, instance: string | null = null) => recordProjectRuntime(p, selection, instance, registry);
  return { root, home, source, project, capture, bind, get registry() { return registry; },
    reopen() { registry.close(); registry = new Registry(join(home, "registry.db")); } };
}

const stateBytes = (project: Project) => readFileSync(projectRuntimeFile(project), "utf8");
const retain = (f: ReturnType<typeof fixture>, p: Project, version = "0.27.0", kind: ProjectRuntimeSelection["kind"] = "upgrade") => {
  const runtime = f.capture(version, "retained", kind); f.bind(p, runtime.selection); return runtime;
};

test("#610 first use captures the invoking package and only publication creates a project identity-bound state file", () => {
  const f = fixture(), p = f.project(), source = f.source("0.26.0");
  expect(readProjectRuntime(p)).toBeUndefined();
  const selected = f.registry.runtimeCaptureLocked(() => resolveProjectRuntime(p, "0.26.0", source, f.registry));
  expect(selected).toMatchObject({ version: "0.26.0", kind: "restart" });
  expect(selected.root).not.toBe(source); expect(verifyProjectRuntime(selected)).toEqual(selected);
  expect(existsSync(projectRuntimeFile(p))).toBe(false);
  f.bind(p, selected);
  expect(readProjectRuntime(p)).toEqual({ schema: 1, projectId: p.id, projectRoot: p.root, stateDir: p.stateDir, ...selected, instanceId: null });
  expect(projectRuntimeFile(p)).toBe(join(p.stateDir, "runtime.json"));
});

test("#610 the updated resolver refuses an older invoking version with the retained version and upgrade guidance", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p), before = stateBytes(p);
  const oldSource = f.source("0.26.0");
  expect(() => resolveProjectRuntime(p, "0.26.0", oldSource, f.registry)).toThrow(/this project runs 0\.27\.0; use 0\.27\.0 or later \/ ahub upgrade/);
  expect(stateBytes(p)).toBe(before); expect(verifyProjectRuntime(runtime.selection)).toEqual(runtime.selection);
});

test("#610 updated same or newer invokers retain the selected capture despite a changed or missing invoking installation", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p), before = stateBytes(p);
  put(runtime.sourceRoot, "package.json", "not a package manifest\n");
  for (const version of ["0.27.0", "0.28.0"]) for (const source of [runtime.sourceRoot, join(f.root, "missing-global-install")]) {
    expect(resolveProjectRuntime(p, version, source, f.registry)).toEqual(expect.objectContaining(runtime.selection));
  }
  expect(stateBytes(p)).toBe(before);
});

test("#610 a different source digest at the same version does not replace a retained project selection", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p, "0.27.0", "restart");
  put(runtime.sourceRoot, "src/cli/main.ts", "export const marker = 'new installation';\n");
  const candidate = stageCurrentRuntime(runtime.sourceRoot, "0.27.0", f.home, f.registry), before = stateBytes(p);
  expect(candidate.version).toBe(runtime.selection.version);
  expect(candidate.digest).not.toBe(runtime.selection.digest); expect(candidate.root).not.toBe(runtime.selection.root);
  expect(resolveProjectRuntime(p, "0.27.0", runtime.sourceRoot, f.registry)).toEqual(expect.objectContaining(runtime.selection));
  expect(readFileSync(join(runtime.selection.root, "src/cli/main.ts"), "utf8")).toContain("retained");
  expect(stateBytes(p)).toBe(before);
});

for (const corruption of ["json", "missing-field", "wrong-project", "wrong-project-root", "wrong-state-dir", "unknown-schema", "oversize"] as const) {
  test(`#610 an existing ${corruption} project runtime state refuses selection and overwrite`, () => {
    const f = fixture(), p = f.project(), runtime = retain(f, p), row = JSON.parse(stateBytes(p));
    if (corruption === "missing-field") delete row.digest;
    else if (corruption === "wrong-project") row.projectId = "p_foreign";
    else if (corruption === "wrong-project-root") row.projectRoot = join(f.root, "foreign-project");
    else if (corruption === "wrong-state-dir") row.stateDir = join(f.root, "foreign-state");
    else if (corruption === "unknown-schema") row.schema = 2;
    const body = corruption === "json" ? "{" : corruption === "oversize" ? " ".repeat(16 * 1024 + 1) : JSON.stringify(row);
    writeFileSync(projectRuntimeFile(p), body);
    expect(() => readProjectRuntime(p)).toThrow(/project runtime record is invalid/);
    expect(() => resolveProjectRuntime(p, "0.28.0", runtime.sourceRoot, f.registry)).toThrow(/project runtime record is invalid/);
    expect(() => f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(p, runtime.selection, null))).toThrow(/project runtime record is invalid/);
    expect(stateBytes(p)).toBe(body);
  });
}

test("#610 a linked project state file refuses read, fallback and overwrite without modifying its target", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p), body = stateBytes(p), target = join(f.root, "linked-runtime.json");
  writeFileSync(target, body); rmSync(projectRuntimeFile(p)); symlinkSync(target, projectRuntimeFile(p));
  expect(() => readProjectRuntime(p)).toThrow(/project runtime record is invalid/);
  expect(() => resolveProjectRuntime(p, "0.28.0", runtime.sourceRoot, f.registry)).toThrow(/project runtime record is invalid/);
  expect(() => f.bind(p, runtime.selection)).toThrow(/project runtime record is invalid/);
  expect(readFileSync(target, "utf8")).toBe(body);
});

for (const corruption of ["changed-capture", "missing-capture", "wrong-digest", "linked-capture"] as const) {
  test(`#610 a retained ${corruption} refuses with the selected version rather than using the invoking source`, () => {
    const f = fixture(), p = f.project(), runtime = retain(f, p), source = f.source("0.28.0", "valid fallback must not run");
    if (corruption === "changed-capture") put(runtime.selection.root, "src/cli/main.ts", "export const marker = 'tampered capture';\n");
    else if (corruption === "missing-capture") rmSync(runtime.selection.root, { recursive: true });
    else {
      const row = JSON.parse(stateBytes(p));
      if (corruption === "wrong-digest") row.digest = row.digest === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
      else { const linked = join(f.root, "linked-capture"); symlinkSync(runtime.selection.root, linked, "dir"); row.root = linked; }
      writeFileSync(projectRuntimeFile(p), JSON.stringify(row));
    }
    const before = stateBytes(p);
    expect(() => resolveProjectRuntime(p, "0.28.0", source, f.registry)).toThrow(/this project runs 0\.27\.0; use 0\.27\.0 or later \/ ahub upgrade.*recorded runtime is missing or changed/);
    expect(stateBytes(p)).toBe(before);
  });
}

test("#610 projects retain independent target versions across stop and Registry reopen", () => {
  const f = fixture(), a = f.project("project-a"), b = f.project("project-b");
  const aRuntime = f.capture("0.27.0", "A target", "upgrade"), bRuntime = f.capture("0.26.0", "B target", "restart");
  expect(f.registry.claim(a.id, "instance-a", process.pid)).toBe(true);
  expect(f.registry.claim(b.id, "instance-b", process.pid)).toBe(true);
  f.bind(a, aRuntime.selection, "instance-a"); f.bind(b, bRuntime.selection, "instance-b");
  const aBefore = stateBytes(a), bBefore = stateBytes(b);
  expect(() => resolveProjectRuntime(a, "0.26.0", bRuntime.sourceRoot, f.registry)).toThrow(/this project runs 0\.27\.0/);
  expect(resolveProjectRuntime(b, "0.26.0", bRuntime.sourceRoot, f.registry)).toEqual(expect.objectContaining(bRuntime.selection));
  f.registry.release(a.id, "instance-a"); f.registry.release(b.id, "instance-b"); f.reopen();
  const reopenedA = f.registry.get(a.id)!, reopenedB = f.registry.get(b.id)!;
  expect(reopenedA.instanceId).toBeNull(); expect(reopenedB.instanceId).toBeNull();
  expect(resolveProjectRuntime(reopenedA, "0.28.0", join(f.root, "unavailable"), f.registry)).toEqual(expect.objectContaining(aRuntime.selection));
  expect(resolveProjectRuntime(reopenedB, "0.26.0", bRuntime.sourceRoot, f.registry)).toEqual(expect.objectContaining(bRuntime.selection));
  expect(stateBytes(a)).toBe(aBefore); expect(stateBytes(b)).toBe(bBefore);
});

test("#610 recording a runtime refuses a changed owner instance or registry project binding without changing state", () => {
  const f = fixture(), p = f.project(), runtime = f.capture();
  expect(f.registry.claim(p.id, "current-owner", process.pid)).toBe(true);
  f.bind(p, runtime.selection, "current-owner");
  const before = stateBytes(p), replacement = f.capture("0.27.0", "replacement");
  for (const instance of ["stale-owner", null]) {
    expect(() => f.bind(p, replacement.selection, instance)).toThrow(/project runtime owner changed/);
    expect(stateBytes(p)).toBe(before);
  }
  for (const patch of [{ root: join(f.root, "wrong-root") }, { stateDir: join(f.root, "wrong-state") }]) {
    expect(() => f.bind({ ...p, ...patch }, replacement.selection, "current-owner")).toThrow(/project runtime owner changed/);
    expect(stateBytes(p)).toBe(before);
  }
  f.registry.release(p.id, "current-owner");
  f.bind(p, replacement.selection);
  expect(readProjectRuntime(p)).toMatchObject({ ...replacement.selection, instanceId: null });
});


test("#610 readiness confirmation binds an unchanged pending selection to its observed owner", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p);
  expect(f.registry.claim(p.id, "launched-a", process.pid)).toBe(true);
  confirmProjectRuntime(p, runtime.selection, { version: runtime.selection.version, instanceId: "launched-a" }, f.registry);
  expect(readProjectRuntime(p)).toMatchObject({ ...runtime.selection, instanceId: "launched-a" });
});

test("#610 a replaced pending selection cannot be overwritten by readiness from the earlier same-version capture", () => {
  const f = fixture(), p = f.project(), first = retain(f, p), replacement = f.capture("0.27.0", "later pending selection", "upgrade");
  f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(p, replacement.selection, null));
  expect(f.registry.claim(p.id, "launched-a", process.pid)).toBe(true);
  const before = stateBytes(p);
  expect(replacement.selection.version).toBe(first.selection.version);
  expect(replacement.selection.digest).not.toBe(first.selection.digest);
  expect(() => confirmProjectRuntime(p, first.selection, { version: first.selection.version, instanceId: "launched-a" }, f.registry))
    .toThrow(/runtime selection changed before readiness/);
  expect(stateBytes(p)).toBe(before);
  expect(readProjectRuntime(p)).toMatchObject({ ...replacement.selection, instanceId: null });
});

test("#610 readiness confirmation refuses a missing pending pointer instead of recreating the earlier selection", () => {
  const f = fixture(), p = f.project(), runtime = retain(f, p);
  expect(f.registry.claim(p.id, "launched-a", process.pid)).toBe(true);
  rmSync(projectRuntimeFile(p));
  expect(() => confirmProjectRuntime(p, runtime.selection, { version: runtime.selection.version, instanceId: "launched-a" }, f.registry))
    .toThrow(/runtime selection changed before readiness/);
  expect(existsSync(projectRuntimeFile(p))).toBe(false);
});

for (const change of ["owner-instance", "runtime-kind", "observed-version"] as const) {
  test(`#610 readiness confirmation refuses a changed ${change} without replacing its pending state`, () => {
    const f = fixture(), p = f.project(), runtime = retain(f, p);
    expect(f.registry.claim(p.id, "launched-a", process.pid)).toBe(true);
    if (change === "owner-instance") f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(p, runtime.selection, "other-instance"));
    else if (change === "runtime-kind") f.registry.runtimeCaptureLocked(() => writeProjectRuntimeState(p, { ...runtime.selection, kind: "restart" }, null));
    const before = stateBytes(p);
    expect(() => confirmProjectRuntime(p, runtime.selection, { version: change === "observed-version" ? "0.26.0" : runtime.selection.version,
      instanceId: "launched-a" }, f.registry)).toThrow(/runtime selection changed before readiness/);
    expect(stateBytes(p)).toBe(before);
  });
}
