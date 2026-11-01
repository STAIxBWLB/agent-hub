import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageDigest, preserveRuntimePackage, stageCurrentRuntime, verifyPackage } from "../src/cli/recovery-package.ts";
import { realPath } from "../src/hub/project.ts";

const VERSION = "0.99.0", CORE_VERSION = "0.18.0";
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, name: string, body: string): void {
  const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body);
}

/** Tiny data-only package tree. These tests prove preservation, not daemon startup or CLI execution. */
function fixture(withMemory = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-source-preservation-")); temporary.push(root);
  const source = join(root, "global-install"), home = join(root, "hub-home");
  put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION,
    ...(withMemory ? { dependencies: { "@staix/agent-mem": CORE_VERSION } } : {}) }));
  put(source, "src/cli/main.js", "// captured fixture CLI v1\n");
  put(source, "src/marker.ts", "export const marker = 'source-v1';\n");
  put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
  put(source, "plugins/agent-hub/server.js", "// fixture bundle\n");
  put(source, "templates/fixture.txt", "fixture template\n");
  put(source, ".claude-plugin/marketplace.json", "{}\n");
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `fixture ${name}\n`);
  // Deliberately outside the executable asset allowlist.
  put(source, ".agenthub/config.local.json", '{"privateFixture":true}\n');
  put(source, "private-project/notes.txt", "private fixture project\n");
  put(source, ".env", "FIXTURE_VALUE=private\n");
  put(source, "node_modules/unrelated/package.json", '{"name":"unrelated"}\n');
  const memory = join(source, "node_modules/@staix/agent-mem");
  if (withMemory) {
    put(memory, "package.json", JSON.stringify({ name: "@staix/agent-mem", version: CORE_VERSION, main: "src/index.js" }));
    put(memory, "src/index.js", "// captured first-party core v1\n");
    put(memory, "bin/amem.js", "// fixture core entry\n");
    put(memory, "README.md", "fixture core readme\n"); put(memory, "LICENSE", "fixture core license\n");
    put(memory, "private-state.txt", "core private fixture\n");
    put(memory, "node_modules/unrelated/private.txt", "unrelated dependency fixture\n");
  }
  return { root, source, home, memory };
}

test("#607 current runtime is captured under its version and source digest, with cold and warm reuse", () => {
  const f = fixture(), digest = packageDigest(f.source), first = stageCurrentRuntime(f.source, VERSION, f.home);
  expect(first).toEqual({ root: realPath(join(f.home, "releases", VERSION, `source-${digest}`)), digest, version: VERSION });
  expect(first.root).not.toBe(realPath(f.source));
  expect(readFileSync(join(first.root, "src/cli/main.js"), "utf8")).toBe("// captured fixture CLI v1\n");
  expect(verifyPackage(first.root, VERSION, { ownDependencies: true })).toBe(digest);
  const directoryInode = lstatSync(first.root).ino, mainInode = lstatSync(join(first.root, "src/cli/main.js")).ino;
  const second = stageCurrentRuntime(f.source, VERSION, f.home);
  expect(second).toEqual(first);
  expect(lstatSync(second.root).ino).toBe(directoryInode);
  expect(lstatSync(join(second.root, "src/cli/main.js")).ino).toBe(mainInode);
  expect(readdirSync(join(f.home, "releases", VERSION))).toEqual([`source-${digest}`]);
});

test("#607 captured source and exact first-party core survive mutable global install changes", () => {
  const f = fixture(true), captured = stageCurrentRuntime(f.source, VERSION, f.home);
  const ownCore = join(captured.root, "node_modules/@staix/agent-mem");
  expect(readFileSync(join(ownCore, "src/index.js"), "utf8")).toBe("// captured first-party core v1\n");
  expect(JSON.parse(readFileSync(join(ownCore, "package.json"), "utf8")).version).toBe(CORE_VERSION);
  put(f.source, "src/cli/main.js", "// replaced mutable global CLI\n");
  put(f.memory, "src/index.js", "// replaced mutable global core\n");
  expect(packageDigest(f.source)).not.toBe(captured.digest);
  expect(readFileSync(join(captured.root, "src/cli/main.js"), "utf8")).toBe("// captured fixture CLI v1\n");
  expect(readFileSync(join(ownCore, "src/index.js"), "utf8")).toBe("// captured first-party core v1\n");
  expect(verifyPackage(captured.root, VERSION, { ownDependencies: true })).toBe(captured.digest);
  rmSync(f.source, { recursive: true });
  expect(verifyPackage(captured.root, VERSION, { ownDependencies: true })).toBe(captured.digest);
});

test("#607 preservation includes executable assets and only the exact core asset allowlist", () => {
  const f = fixture(true), captured = stageCurrentRuntime(f.source, VERSION, f.home);
  for (const name of ["src/marker.ts", "plugins/agent-hub/server.js", "templates/fixture.txt", ".claude-plugin/marketplace.json", "package.json", "README.md", "LICENSE", "CHANGELOG.md",
    "node_modules/@staix/agent-mem/src/index.js", "node_modules/@staix/agent-mem/bin/amem.js", "node_modules/@staix/agent-mem/package.json", "node_modules/@staix/agent-mem/README.md", "node_modules/@staix/agent-mem/LICENSE"])
    expect(existsSync(join(captured.root, name))).toBe(true);
  for (const name of [".agenthub", "private-project", ".env", "node_modules/unrelated", "node_modules/@staix/agent-mem/private-state.txt", "node_modules/@staix/agent-mem/node_modules"])
    expect(existsSync(join(captured.root, name))).toBe(false);
  expect(readdirSync(join(captured.root, "node_modules"))).toEqual(["@staix"]);
  expect(readdirSync(join(captured.root, "node_modules/@staix"))).toEqual(["agent-mem"]);
});

test("#607 distinct source digests of the same version coexist without changing the prior capture", () => {
  const f = fixture(), first = stageCurrentRuntime(f.source, VERSION, f.home);
  put(f.source, "src/marker.ts", "export const marker = 'source-v2';\n");
  const second = stageCurrentRuntime(f.source, VERSION, f.home);
  expect(second.version).toBe(first.version); expect(second.digest).not.toBe(first.digest); expect(second.root).not.toBe(first.root);
  expect(second.root).toBe(realPath(join(f.home, "releases", VERSION, `source-${second.digest}`)));
  expect(readFileSync(join(first.root, "src/marker.ts"), "utf8")).toContain("source-v1");
  expect(readFileSync(join(second.root, "src/marker.ts"), "utf8")).toContain("source-v2");
  expect(readdirSync(join(f.home, "releases", VERSION)).sort()).toEqual([`source-${first.digest}`, `source-${second.digest}`].sort());
});

test("#607 cache tampering refuses reuse without overwriting the changed cache", () => {
  const f = fixture(true), captured = stageCurrentRuntime(f.source, VERSION, f.home);
  const target = "node_modules/@staix/agent-mem/src/index.js";
  put(captured.root, target, "// changed cache, must remain for inspection\n");
  const inode = lstatSync(join(captured.root, target)).ino;
  expect(() => stageCurrentRuntime(f.source, VERSION, f.home)).toThrow("preserved runtime changed");
  expect(() => preserveRuntimePackage(f.source, captured.root, captured.digest)).toThrow("preserved runtime changed");
  expect(readFileSync(join(captured.root, target), "utf8")).toBe("// changed cache, must remain for inspection\n");
  expect(lstatSync(join(captured.root, target)).ino).toBe(inode);
  expect(readdirSync(join(f.home, "releases", VERSION))).toEqual([`source-${captured.digest}`]);
});

test("#607 preservation refuses a stale source digest before creating the destination", () => {
  const f = fixture(), expected = packageDigest(f.source), destination = join(f.root, "captures", "captured");
  put(f.source, "src/marker.ts", "export const marker = 'changed-before-capture';\n");
  expect(() => preserveRuntimePackage(f.source, destination, expected)).toThrow("source package changed");
  expect(existsSync(dirname(destination))).toBe(false);
});

test("#607 requested and plugin version mismatches refuse before creating a hub home", () => {
  const f = fixture();
  expect(() => stageCurrentRuntime(f.source, "0.99.1", f.home)).toThrow("identity/version mismatch");
  expect(existsSync(f.home)).toBe(false);
  expect(() => stageCurrentRuntime(f.source, "latest", f.home)).toThrow("exact package version");
  expect(existsSync(f.home)).toBe(false);
  put(f.source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ version: "0.99.1" }));
  expect(() => stageCurrentRuntime(f.source, VERSION, f.home)).toThrow("identity/version mismatch");
  expect(existsSync(f.home)).toBe(false);
});

test("#607 symlinked releases and version parents are refused without modifying the target", () => {
  for (const parent of ["releases", "version"] as const) {
    const f = fixture(), external = join(f.root, "external");
    put(external, "marker.txt", "untouched symlink target\n");
    const link = parent === "releases" ? join(f.home, "releases") : join(f.home, "releases", VERSION);
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(external, link, "dir");
    expect(() => stageCurrentRuntime(f.source, VERSION, f.home)).toThrow("real directories");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(external)).toEqual(["marker.txt"]);
    expect(readFileSync(join(external, "marker.txt"), "utf8")).toBe("untouched symlink target\n");
  }
});

test("#607 symlinked cache leaves are refused without replacing the link or following it", () => {
  const f = fixture(), digest = packageDigest(f.source), external = join(f.root, "external");
  const leaf = join(f.home, "releases", VERSION, `source-${digest}`);
  put(external, "marker.txt", "untouched symlink target\n");
  mkdirSync(dirname(leaf), { recursive: true }); symlinkSync(external, leaf, "dir");
  expect(() => stageCurrentRuntime(f.source, VERSION, f.home)).toThrow("preserved runtime changed");
  expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
  expect(readdirSync(external)).toEqual(["marker.txt"]);
  expect(readFileSync(join(external, "marker.txt"), "utf8")).toBe("untouched symlink target\n");
});
