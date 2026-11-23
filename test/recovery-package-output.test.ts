import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest, preserveRuntimeDependencies } from "../src/cli/recovery-package.ts";
import hubPackage from "../package.json";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ahub-runtime-output-")); roots.push(base);
  const root = join(base, "runtime"), target = join(base, "capture");
  for (const dir of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.0.0", dependencies: hubPackage.dependencies }));
  for (const name of ["agent-mem", "cli-output"]) {
    const entry = fileURLToPath(import.meta.resolve(`@staix/${name}`));
    cpSync(dirname(dirname(entry)), join(root, "node_modules", "@staix", name), { recursive: true });
  }
  return { root, target, output: join(root, "node_modules/@staix/cli-output") };
}

test("recovery captures the exact output package and hashes its runtime bytes", () => {
  const f = fixture(), digest = packageDigest(f.root);
  for (const dir of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(f.target, dir), { recursive: true });
  cpSync(join(f.root, "package.json"), join(f.target, "package.json"));
  preserveRuntimeDependencies(f.root, f.target);
  expect(packageDigest(f.target, { ownDependencies: true })).toBe(digest);
  expect(existsSync(join(f.target, "node_modules/@staix/cli-output/fixtures"))).toBe(false);
  const child = Bun.spawnSync([process.execPath, "-e", 'import { resolveColor } from "@staix/cli-output"; if (resolveColor("never", { isTTY: true }, "ahub") !== false) process.exit(1)'], { cwd: f.target, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0); expect(child.stderr.toString()).toBe("");
  const entry = join(f.output, "src/index.ts"), text = readFileSync(entry, "utf8");
  writeFileSync(entry, text + "\n// changed fixture\n");
  expect(packageDigest(f.root)).not.toBe(digest);
  expect(packageDigest(f.target, { ownDependencies: true })).toBe(digest);
  rmSync(join(f.target, "node_modules/@staix/cli-output"), { recursive: true });
  expect(() => packageDigest(f.target, { ownDependencies: true })).toThrow("output runtime dependency is unavailable");
});

test("recovery refuses altered output identity, transitive dependencies and symlinks", () => {
  const f = fixture(), manifest = join(f.output, "package.json"), original = JSON.parse(readFileSync(manifest, "utf8"));
  const hubManifest = join(f.root, "package.json"), hubOriginal = JSON.parse(readFileSync(hubManifest, "utf8"));
  writeFileSync(hubManifest, JSON.stringify({ ...hubOriginal, dependencies: { ...hubOriginal.dependencies, "@staix/cli-output": `^${hubPackage.dependencies["@staix/cli-output"]}` } }));
  expect(() => packageDigest(f.root)).toThrow("output runtime dependency must be an exact version");
  writeFileSync(hubManifest, JSON.stringify(hubOriginal));
  expect(packageDigest(f.root, { dependencyRoot: f.root })).toBe(packageDigest(f.root));
  writeFileSync(manifest, JSON.stringify({ ...original, version: "0.0.0" }));
  expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
  writeFileSync(manifest, JSON.stringify({ ...original, dependencies: { extra: "1.0.0" } }));
  expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
  writeFileSync(manifest, JSON.stringify(original));
  symlinkSync("index.ts", join(f.output, "src/linked.ts"));
  expect(() => packageDigest(f.root)).toThrow("must not contain symlinks");
});
