import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageDigest, preserveRuntimeDependencies, recoveryPackageOptions, recoveryTargetDigest, stageRelease, verifyRecoveryTarget } from "../src/cli/recovery-package.ts";
import { realPath } from "../src/hub/project.ts";

const roots: string[] = [], version = "0.0.1", integrity = "sha512-fixture";
const memoryVersion: string = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")).dependencies["@staix/agent-mem"];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function app(root: string): void {
  for (const folder of ["src/cli", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version, dependencies: { "@staix/agent-mem": memoryVersion } }));
  writeFileSync(join(root, "src/cli/main.js"), "// fixture runtime only\n");
  writeFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version }));
}
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-package-"))); roots.push(root);
  const source = join(root, "preserved-source"), home = join(root, "home"); app(source);
  const memory = join(source, "node_modules/@staix/agent-mem");
  mkdirSync(join(memory, "src"), { recursive: true }); mkdirSync(join(memory, "bin"));
  writeFileSync(join(memory, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: memoryVersion, exports: "./src/index.ts" }));
  writeFileSync(join(memory, "src/index.ts"), "export const fixture = true;\n");
  writeFileSync(join(memory, "bin/amem.js"), "// fixture CLI\n");
  for (const name of ["README.md", "LICENSE"]) writeFileSync(join(memory, name), "fixture\n");
  const stage = () => stageRelease(version, integrity, async (args) => {
    const installRoot = args[args.indexOf("--cwd") + 1];
    if (!args.includes("--cwd") || !installRoot) throw new Error("fixture requires the staged install root");
    app(join(installRoot, "node_modules/@staix/agent-hub"));
    // Copy only this small first-party fixture package, never an installed dependency tree.
    preserveRuntimeDependencies(source, installRoot);
    writeFileSync(join(installRoot, "bun.lock"), JSON.stringify({ packages: { "@staix/agent-hub": [integrity] } }));
    return { code: 0, stdout: "", stderr: "" };
  }, home);
  return { root, source, home, memory, stage };
}

test("a real staged upgrade shape verifies its hoisted first-party runtime with the stageRelease digest", async () => {
  const f = fixture(), staged = await f.stage(), release = join(f.home, "releases", version);
  expect(JSON.parse(readFileSync(join(f.source, "package.json"), "utf8")).dependencies).toEqual({ "@staix/agent-mem": memoryVersion });
  expect(recoveryPackageOptions("upgrade", staged.root)).toEqual({ dependencyRoot: release });
  expect(recoveryTargetDigest("upgrade", staged.root)).toBe(staged.digest);
  expect(verifyRecoveryTarget("upgrade", staged.root, version)).toBe(staged.digest);
  expect(packageDigest(f.source, { ownDependencies: true })).toBe(staged.digest);
  // The old authority check looked below agent-hub and failed despite the verified hoisted runtime.
  expect(() => packageDigest(staged.root, { ownDependencies: true })).toThrow("memory runtime dependency is unavailable");
  expect((await f.stage()).digest).toBe(staged.digest); // Cached-release verification uses the same binding.
});

test("a missing or wrong-version hoisted dependency cannot pass target verification", async () => {
  for (const mutation of ["missing", "version"] as const) {
    const f = fixture(), staged = await f.stage(), memory = join(f.home, "releases", version, "node_modules/@staix/agent-mem");
    if (mutation === "missing") rmSync(memory, { recursive: true });
    else writeFileSync(join(memory, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "999.0.0", exports: "./src/index.ts" }));
    expect(() => recoveryTargetDigest("upgrade", staged.root)).toThrow();
    expect(() => verifyRecoveryTarget("upgrade", staged.root, version)).toThrow();
  }
});

test("tampering hoisted runtime bytes changes the target binding and refuses the cached release", async () => {
  const f = fixture(), staged = await f.stage();
  writeFileSync(join(f.home, "releases", version, "node_modules/@staix/agent-mem/src/index.ts"), "export const fixture = false;\n");
  expect(recoveryTargetDigest("upgrade", staged.root)).not.toBe(staged.digest);
  expect(verifyRecoveryTarget("upgrade", staged.root, version)).not.toBe(staged.digest);
  await expect(f.stage()).rejects.toThrow("cached release changed");
});

test("restart targets and preserved sources still require their own dependency instead of borrowing the upgrade's hoist", async () => {
  const f = fixture(), staged = await f.stage();
  expect(recoveryPackageOptions("restart", f.source)).toEqual({ ownDependencies: true });
  expect(recoveryTargetDigest("restart", f.source)).toBe(packageDigest(f.source, { ownDependencies: true }));
  expect(verifyRecoveryTarget("restart", f.source, version)).toBe(staged.digest);
  expect(() => recoveryTargetDigest("restart", staged.root)).toThrow("memory runtime dependency is unavailable");
  rmSync(f.memory, { recursive: true });
  expect(() => packageDigest(f.source, { ownDependencies: true })).toThrow("memory runtime dependency is unavailable");
});

test("upgrade dependency resolution refuses a noncanonical root or a package outside the staged suffix", async () => {
  const f = fixture(), staged = await f.stage();
  expect(() => recoveryPackageOptions("upgrade", f.source)).toThrow("invalid staged recovery package path");
  expect(() => recoveryPackageOptions("upgrade", `${staged.root}/.`)).toThrow("invalid staged recovery package path");
});
