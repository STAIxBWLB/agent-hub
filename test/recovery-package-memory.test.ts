import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { preserveSource } from "../src/cli/upgrade-runtime.ts";
import type { UpgradePlan } from "../src/cli/upgrade.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(memory = true) {
  const base = mkdtempSync(join(tmpdir(), "ahub-runtime-memory-")); roots.push(base);
  const root = join(base, "runtime"), home = join(base, "home");
  for (const dir of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  const manifest = { name: "@staix/agent-hub", version: "0.0.0", ...(memory ? { dependencies: { "@staix/agent-mem": "0.1.1" } } : {}) };
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
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ ...f.manifest, dependencies: { "@staix/agent-mem": "^0.1.1" } }));
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
