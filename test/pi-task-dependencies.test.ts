import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { INSTALL_LIFECYCLE, parseInstallManifest } from "../src/hub/install-policy.ts";
import { dependencyManifest } from "../src/hub/check-runner.ts";
import { PI_DEPENDENCY_MANIFEST_BYTES, PI_DEPENDENCY_TIMEOUT_MS, preparePiDependencies, type DependencyInstallRequest, type DependencyRunner, type PiDependencyOptions } from "../src/pi/task-dependencies.ts";

const roots: string[] = [];
const projects = new Map<string, { base: string; repositoryRoot: string; stagingParent: string }>();
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); projects.clear(); });
function reviewed(cwd: string) {
  for (const args of [["add", "-A"], ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-qm", "reviewed install inputs"]]) {
    const result = hubGitSync(args, { cwd, encoding: "utf8" }); expect(result.status, String(result.stderr)).toBe(0);
  }
  projects.get(cwd)!.base = hubGitSync(["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
}
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-pi-deps-test-"))); roots.push(root);
  const cwd = join(root, "repo"), stagingParent = join(root, "host-state"); mkdirSync(cwd); mkdirSync(stagingParent);
  expect(hubGitSync(["init", "-q"], { cwd }).status).toBe(0);
  projects.set(cwd, { base: "", repositoryRoot: cwd, stagingParent });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "pi-deps-fixture", workspaces: ["packages/*"], scripts: { test: "bun test" } }));
  writeFileSync(join(cwd, "bun.lock"), '{"lockfileVersion":1,"workspaces":{"":{"name":"pi-deps-fixture"}},"packages":{}}\n');
  reviewed(cwd); return cwd;
}
// Test-only publication on fixture-owned paths, not the production race-resistant publisher.
const publish: NonNullable<PiDependencyOptions["publish"]> = async (source, target, current) => {
  expect(current()).toBe(true); expect(statSync(target.cwd).dev).toBe(target.dev); expect(statSync(target.cwd).ino).toBe(target.ino);
  renameSync(source, join(target.cwd, "node_modules")); return true;
};
const prepare = (cwd: string, options: PiDependencyOptions = {}) => preparePiDependencies(cwd, { ...projects.get(cwd)!, publish, ...options });
const neverRun: DependencyRunner = async () => { throw new Error("fixture runner must not be reached"); };
const installed: DependencyRunner = async request => {
  mkdirSync(join(request.cwd, "node_modules")); writeFileSync(join(request.cwd, "node_modules", "fixture-ready"), "prepared from reviewed snapshot"); return { code: 0 };
};
const cleanStage = (cwd: string) => expect(readdirSync(projects.get(cwd)!.stagingParent)).toEqual([]);

test("Pi installs exact argv in private same-volume staging with only fake HOME and explicit shared cache", async () => {
  const cwd = fixture(), manifest = readFileSync(join(cwd, "package.json"), "utf8"); let observed: DependencyInstallRequest | undefined, modulesInode: number | undefined;
  const result = await prepare(cwd, { run: async request => {
    observed = request;
    expect(request.args).toEqual(["install", "--frozen-lockfile"]); expect(request.executable).toBe(realPath(process.execPath)); expect(isAbsolute(request.executable)).toBe(true);
    expect(request.cwd).not.toBe(cwd); expect(request.cwd.startsWith(projects.get(cwd)!.stagingParent + "/")).toBe(true);
    expect(statSync(request.cwd).dev).toBe(statSync(cwd).dev); expect(statSync(request.cwd).mode & 0o777).toBe(0o700);
    expect(request.timeoutMs).toBeGreaterThan(0); expect(request.timeoutMs).toBeLessThanOrEqual(15_000); expect(PI_DEPENDENCY_TIMEOUT_MS).toBe(15_000);
    expect(Object.keys(request.env).sort()).toEqual(["BUN_INSTALL_CACHE_DIR", "HOME"]);
    expect(request.env.BUN_INSTALL_CACHE_DIR).toBe(join(homedir(), ".bun", "install", "cache"));
    expect(statSync(request.env.HOME).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(request.cwd, "package.json"), "utf8")).toBe(manifest);
    const ready = await installed(request); modulesInode = statSync(join(request.cwd, "node_modules")).ino; return ready;
  } });
  expect(result).toEqual({ ready: true }); expect(observed).toBeDefined();
  expect(existsSync(observed!.cwd)).toBe(false); expect(existsSync(observed!.env.HOME)).toBe(false); cleanStage(cwd);
  expect(modulesInode).toBeDefined(); expect(statSync(join(cwd, "node_modules")).ino).toBe(modulesInode!);
  expect(readFileSync(join(cwd, "node_modules", "fixture-ready"), "utf8")).toBe("prepared from reviewed snapshot");
  expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(manifest);
});

test("missing reviewed bun.lock and invalid reviewed manifests refuse before installer admission", async () => {
  const missing = fixture(); rmSync(join(missing, "bun.lock")); reviewed(missing);
  expect(await prepare(missing, { run: neverRun })).toEqual({ ready: false, reason: "missing bun.lock" }); cleanStage(missing);
  for (const value of ["{broken", "null", "[]", '{"scripts":"wrong"}', '{"scripts":{"test":5}}']) {
    const cwd = fixture(); writeFileSync(join(cwd, "package.json"), value); reviewed(cwd);
    expect(await prepare(cwd, { run: neverRun })).toEqual({ ready: false, reason: "invalid manifest" }); cleanStage(cwd);
  }
});

for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) for (const location of ["root", "workspace"] as const)
  test(`Pi refuses reviewed ${location} ${hook} without invoking the installer`, async () => {
    const cwd = fixture(), dir = location === "root" ? cwd : join(cwd, "packages", "one"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-package", scripts: { [hook]: "PRIVATE_INSTALL_OUTPUT_CANARY" } })); reviewed(cwd);
    expect(await prepare(cwd, { run: neverRun })).toEqual({ ready: false, reason: "lifecycle script" });
    await expect(dependencyManifest(cwd)).rejects.toThrow("remote dependencies unavailable"); cleanStage(cwd);
  });

test("shared lifecycle policy preserves legacy remote JSON semantics while native validation remains strict", async () => {
  expect(INSTALL_LIFECYCLE).toEqual(["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]);
  expect(parseInstallManifest('{"scripts":{"build":"bun build","test":"bun test"}}')).toMatchObject({ scripts: { build: "bun build", test: "bun test" } });
  const cwd = fixture(); writeFileSync(join(cwd, "package.json"), "null"); reviewed(cwd);
  expect(await prepare(cwd, { run: neverRun })).toEqual({ ready: false, reason: "invalid manifest" });
  expect(await dependencyManifest(cwd)).toMatch(/^[a-f0-9]{64}$/);
});

test("snapshot preserves every reviewed install input including test-only preload and patches", async () => {
  const cwd = fixture(); mkdirSync(join(cwd, "packages", "one"), { recursive: true }); mkdirSync(join(cwd, "patches"));
  const files = { "packages/one/package.json": '{"name":"workspace-one"}', "bunfig.toml": '[test]\npreload = ["./test/hub-home.ts"]\n', ".npmrc": "registry=https://registry.npmjs.org\n", "patches/one.patch": "reviewed patch bytes\n" };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(cwd, name), data); reviewed(cwd);
  expect(await prepare(cwd, { run: async request => { for (const [name, data] of Object.entries(files)) expect(readFileSync(join(request.cwd, name), "utf8")).toBe(data); return installed(request); } })).toEqual({ ready: true }); cleanStage(cwd);
});

test("reviewed explicit dependency trust and installer-runtime preload/script settings refuse without rewrites", async () => {
  for (const config of ["trustedDependencies", "preload", "install-script"] as const) {
    const cwd = fixture();
    if (config === "trustedDependencies") writeFileSync(join(cwd, "package.json"), '{"name":"fixture","trustedDependencies":[]}');
    else writeFileSync(join(cwd, "bunfig.toml"), config === "preload" ? 'preload = ["./unreviewed.ts"]\n' : '[install]\nignoreScripts = true\n');
    reviewed(cwd); expect(await prepare(cwd, { run: neverRun })).toEqual({ ready: false, reason: "unsupported install inputs" }); cleanStage(cwd);
  }
});

test("post-snapshot task edits never affect staged installation and prevent publication", async () => {
  const cwd = fixture(), manifest = readFileSync(join(cwd, "package.json"), "utf8");
  expect(await prepare(cwd, { run: async request => {
    writeFileSync(join(cwd, "package.json"), '{"scripts":{"postinstall":"UNREVIEWED_LIFECYCLE_CANARY"}}');
    expect(readFileSync(join(request.cwd, "package.json"), "utf8")).toBe(manifest); return installed(request);
  } })).toEqual({ ready: false, reason: "install inputs changed in task" });
  expect(existsSync(join(cwd, "node_modules"))).toBe(false); cleanStage(cwd);
});

test("preexisting node_modules file, directory and symlink are never replaced", async () => {
  for (const kind of ["file", "directory", "symlink"] as const) {
    const cwd = fixture(), target = join(cwd, "node_modules");
    if (kind === "file") writeFileSync(target, "keep"); else if (kind === "directory") mkdirSync(target); else symlinkSync(join(cwd, "missing-target"), target);
    expect(await prepare(cwd, { run: neverRun })).toEqual({ ready: false, reason: "node_modules exists" }); cleanStage(cwd);
  }
});

test("missing, symlinked and per-workspace node_modules layouts remain unpublished", async () => {
  for (const layout of ["missing", "symlink", "nested"] as const) {
    const cwd = fixture();
    expect(await prepare(cwd, { run: async request => {
      if (layout === "symlink") symlinkSync(cwd, join(request.cwd, "node_modules"), "dir");
      if (layout === "nested") { await installed(request); mkdirSync(join(request.cwd, "packages", "one", "node_modules"), { recursive: true }); }
      return { code: 0 };
    } })).toEqual({ ready: false, reason: "unsupported workspace layout" });
    expect(existsSync(join(cwd, "node_modules"))).toBe(false); cleanStage(cwd);
  }
});

test("cross-device publisher failure has a fixed reason and no copy fallback", async () => {
  const cwd = fixture(); expect(await prepare(cwd, { run: installed, publish: async () => { throw Object.assign(new Error("PRIVATE_EXDEV_CANARY"), { code: "EXDEV" }); } })).toEqual({ ready: false, reason: "different filesystem" });
  expect(existsSync(join(cwd, "node_modules"))).toBe(false); cleanStage(cwd);
});

test("missing trusted publisher has no absolute-path rename fallback", async () => {
  const cwd = fixture(); expect(await prepare(cwd, { run: installed, publish: undefined })).toEqual({ ready: false, reason: "install failed" });
  expect(existsSync(join(cwd, "node_modules"))).toBe(false); cleanStage(cwd);
});

test("manifest snapshots enforce the byte ceiling including its overflow byte", async () => {
  const exact = fixture(); writeFileSync(join(exact, "package.json"), "{}" + " ".repeat(PI_DEPENDENCY_MANIFEST_BYTES - 2)); reviewed(exact);
  expect(await prepare(exact, { run: installed })).toEqual({ ready: true });
  const overflow = fixture(); writeFileSync(join(overflow, "package.json"), "{}" + " ".repeat(PI_DEPENDENCY_MANIFEST_BYTES - 1)); reviewed(overflow);
  expect(await prepare(overflow, { run: neverRun })).toEqual({ ready: false, reason: "invalid manifest" }); cleanStage(overflow);
});

test("failure and timeout hide all runner output and clean staging plus HOME", async () => {
  for (const mode of ["exit", "timeout", "throw"] as const) {
    const cwd = fixture(); let request: DependencyInstallRequest | undefined;
    const result = await prepare(cwd, { run: async value => { request = value; if (mode === "throw") throw new Error("PRIVATE_INSTALL_OUTPUT_CANARY"); return mode === "timeout" ? { code: null, timedOut: true } : { code: 1, stderr: "PRIVATE_INSTALL_OUTPUT_CANARY" }; } });
    expect(result).toEqual({ ready: false, reason: mode === "timeout" ? "install timed out" : "install failed" }); expect(JSON.stringify(result)).not.toContain("PRIVATE_INSTALL_OUTPUT_CANARY");
    expect(request).toBeDefined(); expect(existsSync(request!.env.HOME)).toBe(false); expect(existsSync(request!.cwd)).toBe(false); cleanStage(cwd);
  }
});

test("whole deadline and current authority gate preparation and publication", async () => {
  const cwd = fixture(); let clock = 0, current = true, called = false;
  const pending = prepare(cwd, { now: () => clock, run: async () => { called = true; return { code: 0 }; } }); clock = PI_DEPENDENCY_TIMEOUT_MS;
  expect(await pending).toEqual({ ready: false, reason: "install timed out" }); expect(called).toBe(false); cleanStage(cwd);
  const stale = prepare(cwd, { current: () => current, run: neverRun }); current = false;
  expect(await stale).toEqual({ ready: false, reason: "task changed" }); cleanStage(cwd);
  current = true; let started = false;
  expect(await prepare(cwd, { now: () => { if (!started) { started = true; return 0; } return 2000; }, run: async request => { expect(request.timeoutMs).toBe(PI_DEPENDENCY_TIMEOUT_MS - 2000); return installed(request); } })).toEqual({ ready: true });
  const changed = fixture(); expect(await prepare(changed, { current: () => current, run: async request => { current = false; return installed(request); } })).toEqual({ ready: false, reason: "task changed" });
  expect(existsSync(join(changed, "node_modules"))).toBe(false); cleanStage(changed);
});

test("a replaced worktree root identity cannot reach the publisher", async () => {
  const cwd = fixture(); let published = false;
  expect(await prepare(cwd, { run: async request => { renameSync(cwd, cwd + "-moved"); mkdirSync(cwd); return installed(request); }, publish: async () => { published = true; return true; } })).toEqual({ ready: false, reason: "task changed" });
  expect(published).toBe(false); cleanStage(cwd);
});
