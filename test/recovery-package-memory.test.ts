import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest, verifyPackage } from "../src/cli/recovery-package.ts";
import { makeRecoveryDriver, preserveSource } from "../src/cli/upgrade-runtime.ts";
import type { RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(memory = true) {
  const base = mkdtempSync(join(tmpdir(), "ahub-runtime-memory-")); roots.push(base);
  const root = join(base, "runtime"), home = join(base, "home");
  for (const dir of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  const manifest = { name: "@staix/agent-hub", version: "0.0.0", ...(memory ? { dependencies: { "@staix/agent-mem": "0.2.0" } } : {}) };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) writeFileSync(join(root, name), "fixture\n");
  const dependency = join(root, "node_modules/@staix/agent-mem");
  if (memory) {
    const published = dirname(dirname(fileURLToPath(import.meta.resolve("@staix/agent-mem"))));
    cpSync(published, dependency, { recursive: true });
    mkdirSync(join(root, "node_modules/unrelated"));
    writeFileSync(join(root, "node_modules/unrelated/private.txt"), "must not copy");
    writeFileSync(join(dependency, "private-extra.txt"), "not a published runtime asset");
  }
  return { root, home, dependency, manifest };
}
const plan = (root: string) => ({ sourceRoot: root, sourceDigest: packageDigest(root) } as UpgradePlan);

test("recovery preserves the exact memory runtime and hashes its bytes without unrelated dependencies (#412)", () => {
  const f = fixture(), before = plan(f.root), preserved = preserveSource(before, f.home);
  expect(packageDigest(preserved)).toBe(before.sourceDigest);
  expect(existsSync(join(preserved, "node_modules/unrelated"))).toBe(false);
  expect(existsSync(join(preserved, "node_modules/@staix/agent-mem/private-extra.txt"))).toBe(false);
  const child = Bun.spawnSync([process.execPath, "-e", 'import { MemoryStore } from "@staix/agent-mem"; if (typeof MemoryStore !== "function") process.exit(1)'], { cwd: preserved, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe(""); expect(child.exitCode).toBe(0);
  const source = join(f.dependency, "src/index.ts"), original = readFileSync(source, "utf8");
  writeFileSync(source, original + "\n// changed source\n");
  expect(packageDigest(f.root)).not.toBe(before.sourceDigest);
  expect(packageDigest(preserved)).toBe(before.sourceDigest);
  expect(() => preserveSource(before, f.home)).toThrow("source package changed");
  writeFileSync(source, original);
  writeFileSync(join(preserved, "node_modules/@staix/agent-mem/src/index.ts"), original + "\n// changed preserved runtime\n");
  expect(() => preserveSource(before, f.home)).toThrow("preserved source package changed");
});

test("recovery refuses mismatched, ranged, transitive and symlinked memory runtimes (#412)", () => {
  const f = fixture(), manifest = join(f.dependency, "package.json"), original = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(manifest, JSON.stringify({ ...original, version: "0.0.0" }));
  expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
  writeFileSync(manifest, JSON.stringify({ ...original, dependencies: { unexpected: "1.0.0" } }));
  expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
  writeFileSync(manifest, JSON.stringify(original));
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ ...f.manifest, dependencies: { "@staix/agent-mem": "^0.2.0" } }));
  expect(() => packageDigest(f.root)).toThrow("unsupported runtime dependencies");
  writeFileSync(join(f.root, "package.json"), JSON.stringify(f.manifest));
  symlinkSync("index.ts", join(f.dependency, "src/linked.ts"));
  expect(() => packageDigest(f.root)).toThrow("must not contain symlinks");
});

test("legacy dependency-free recovery keeps its historical digest (#412)", () => {
  const f = fixture(false), expected = createHash("sha256").update(readFileSync(join(f.root, "package.json"))).digest("hex");
  expect(packageDigest(f.root)).toBe(expected);
  const preserved = preserveSource(plan(f.root), f.home);
  expect(packageDigest(preserved)).toBe(expected);
  expect(existsSync(join(preserved, "node_modules"))).toBe(false);
});

test("a preserved runtime never falls back to the checkout dependency when its own copy is missing (#412)", async () => {
  const f = fixture(), before = plan(f.root), home = join(f.root, ".agenthub");
  const preserved = preserveSource(before, home);
  rmSync(join(preserved, "node_modules/@staix/agent-mem"), { recursive: true });
  // The original checkout is an ancestor and still has matching bytes; it must not mask the missing copy.
  expect(() => preserveSource(before, home)).toThrow("memory runtime dependency is unavailable");
  const operation = { sourceRoot: preserved, plan: before } as unknown as RecoveryOperation;
  await expect(makeRecoveryDriver().stage(operation)).rejects.toThrow("memory runtime dependency is unavailable");
  symlinkSync(f.dependency, join(preserved, "node_modules/@staix/agent-mem"));
  expect(() => preserveSource(before, home)).toThrow("runtime package must not contain symlinks");
  rmSync(join(preserved, "node_modules"), { recursive: true });
  symlinkSync(join(f.root, "node_modules"), join(preserved, "node_modules"));
  expect(() => preserveSource(before, home)).toThrow("runtime package must not contain symlinks");
});

test("a cached release never resolves a deleted dependency from an ancestor checkout (#412)", async () => {
  const f = fixture(), home = join(f.root, ".agenthub"), install = join(home, "releases/0.0.0");
  const runtime = join(install, "node_modules/@staix/agent-hub"), memory = join(install, "node_modules/@staix/agent-mem");
  mkdirSync(join(f.root, "plugins/agent-hub/.claude-plugin"), { recursive: true });
  mkdirSync(join(f.root, "src/cli"));
  writeFileSync(join(f.root, "src/cli/main.js"), "// fixture\n");
  writeFileSync(join(f.root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
  mkdirSync(runtime, { recursive: true });
  for (const name of ["src", "plugins", "templates", ".claude-plugin", "package.json"]) cpSync(join(f.root, name), join(runtime, name), { recursive: true });
  cpSync(f.dependency, memory, { recursive: true });
  writeFileSync(join(install, "verified.json"), JSON.stringify({ integrity: "sha512-fixture", digest: verifyPackage(runtime, "0.0.0") }));
  rmSync(memory, { recursive: true });
  // A fresh coordinator must not inherit this process's module-resolution cache.
  const code = `import { stageRelease } from ${JSON.stringify(join(import.meta.dir, "../src/cli/recovery-package.ts"))}; try { await stageRelease("0.0.0", "sha512-fixture", undefined, ${JSON.stringify(home)}); } catch (e) { console.error(e.message); process.exit(1); }`;
  const child = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("memory runtime dependency is unavailable");
});
