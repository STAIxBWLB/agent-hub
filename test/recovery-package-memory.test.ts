import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest, verifyPackage } from "../src/cli/recovery-package.ts";
import { makeRecoveryDriver, preserveSource } from "../src/cli/upgrade-runtime.ts";
import type { RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";
import hubPackage from "../package.json";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(memory = true) {
  const base = mkdtempSync(join(tmpdir(), "ahub-runtime-memory-")); roots.push(base);
  const root = join(base, "runtime"), home = join(base, "home");
  for (const dir of ["src", "plugins", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  const manifest = { name: "@staix/agent-hub", version: "0.0.0", ...(memory ? { dependencies: { "@staix/agent-mem": hubPackage.dependencies["@staix/agent-mem"], "@staix/cli-output": hubPackage.dependencies["@staix/cli-output"] } } : {}) };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) writeFileSync(join(root, name), "fixture\n");
  const dependency = join(root, "node_modules/@staix/agent-mem");
  if (memory) {
    const published = dirname(dirname(fileURLToPath(import.meta.resolve("@staix/agent-mem"))));
    cpSync(published, dependency, { recursive: true });
    cpSync(dirname(dirname(fileURLToPath(import.meta.resolve("@staix/cli-output")))), join(root, "node_modules/@staix/cli-output"), { recursive: true });
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
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ ...f.manifest, dependencies: { ...f.manifest.dependencies, "@staix/agent-mem": `^${hubPackage.dependencies["@staix/agent-mem"].slice(2).split(" ")[0]}` } }));
  expect(() => packageDigest(f.root)).toThrow("unsupported runtime dependencies");
  writeFileSync(join(f.root, "package.json"), JSON.stringify(f.manifest));
  symlinkSync("index.ts", join(f.dependency, "src/linked.ts"));
  expect(() => packageDigest(f.root)).toThrow("must not contain symlinks");
});

test("#1611 a floor range declaration accepts a plain release inside it and refuses one outside it", () => {
  const floor = hubPackage.dependencies["@staix/agent-mem"].slice(2).split(" ")[0] as string, [major, minor, patch] = floor.split(".").map(Number) as [number, number, number];
  const inside = fixture(), insideManifest = join(inside.dependency, "package.json"), published = JSON.parse(readFileSync(insideManifest, "utf8"));
  writeFileSync(insideManifest, JSON.stringify({ ...published, version: `${major}.${minor + 1}.${patch + 1}` }));
  expect(packageDigest(inside.root)).toBeTypeOf("string");
  const outside = fixture(), outsideManifest = join(outside.dependency, "package.json");
  writeFileSync(outsideManifest, JSON.stringify({ ...published, version: `${major + 1}.0.0` }));
  expect(() => packageDigest(outside.root)).toThrow("identity/version mismatch");
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
  cpSync(join(f.root, "node_modules/@staix/cli-output"), join(install, "node_modules/@staix/cli-output"), { recursive: true });
  writeFileSync(join(install, "verified.json"), JSON.stringify({ integrity: "sha512-fixture", digest: verifyPackage(runtime, "0.0.0") }));
  rmSync(memory, { recursive: true });
  // A fresh coordinator must not inherit this process's module-resolution cache.
  const code = `import { stageRelease } from ${JSON.stringify(join(import.meta.dir, "../src/cli/recovery-package.ts"))}; try { await stageRelease("0.0.0", "sha512-fixture", undefined, ${JSON.stringify(home)}); } catch (e) { console.error(e.message); process.exit(1); }`;
  const child = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("memory runtime dependency is unavailable");
});

function setHostApi(dependency: string, min: string | undefined, version: string | undefined) {
  const file = join(dependency, "src/memory/platform.ts");
  const text = readFileSync(file, "utf8").replace(/export const HOST_API_VERSION = \d+ as const;\n?/, version ? `export const HOST_API_VERSION = ${version} as const;\n` : "").replace(/export const HOST_API_MIN = \d+ as const;\n?/, min ? `export const HOST_API_MIN = ${min} as const;\n` : "");
  writeFileSync(file, text);
}

test("#1611 a floor-form staged package needs a host API that intersects the supported range", () => {
  const good = fixture();
  expect(packageDigest(good.root)).toBeTypeOf("string");
  const missing = fixture(); setHostApi(missing.dependency, undefined, undefined);
  expect(() => packageDigest(missing.root)).toThrow("host API missing..missing");
  const far = fixture(); setHostApi(far.dependency, "2", "3");
  expect(() => packageDigest(far.root)).toThrow("host API 2..3 does not intersect the supported 1..1");
});

test("#1611 a legacy ~ staged package keeps its check with no host API requirement", () => {
  const f = fixture(), manifest = join(f.dependency, "package.json"), published = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(manifest, JSON.stringify({ ...published, version: "0.32.1" }));
  setHostApi(f.dependency, undefined, undefined);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ ...f.manifest, dependencies: { ...f.manifest.dependencies, "@staix/agent-mem": "~0.32.1" } }));
  expect(packageDigest(f.root)).toBeTypeOf("string");
});

test("recovery accepts agent-mem declaring exactly the pinned cli-output and refuses anything else (#1664)", () => {
  const f = fixture(), manifest = join(f.dependency, "package.json"), original = JSON.parse(readFileSync(manifest, "utf8"));
  const pin = hubPackage.dependencies["@staix/cli-output"];
  const declare = (dependencies: Record<string, string>) => writeFileSync(manifest, JSON.stringify({ ...original, dependencies }));
  declare({ "@staix/cli-output": pin });
  const before = plan(f.root), preserved = preserveSource(before, f.home);
  expect(packageDigest(preserved)).toBe(before.sourceDigest);
  for (const bad of [{ "@staix/cli-output": "0.0.1" }, { "@staix/cli-output": `^${pin}` }, { "@staix/cli-output": pin, extra: "1.0.0" }] as Record<string, string>[]) {
    declare(bad);
    expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
  }
  declare({ "@staix/cli-output": pin });
  mkdirSync(join(f.dependency, "node_modules/nested"), { recursive: true });
  expect(() => packageDigest(f.root)).toThrow("identity/version mismatch");
});

const MCP_STDIO = "@staix/mcp-stdio", AGENT_HOSTS = "@staix/agent-hosts";
const reviewedPins = { [MCP_STDIO]: "0.2.0", [AGENT_HOSTS]: "0.1.0" } as const;

function declareMemoryPins(root: string, pins: Record<string, string>) {
  const path = join(root, "package.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { "@staix/cli-output": hubPackage.dependencies["@staix/cli-output"], ...pins } }));
}

function installPinnedFixture(root: string, name: string, version: string): string {
  const installed = join(root, "node_modules", name);
  for (const dir of ["src", "fixtures"]) mkdirSync(join(installed, dir), { recursive: true });
  for (const asset of ["src/index.ts", "fixtures/example.json", "README.md", "LICENSE"])
    writeFileSync(join(installed, asset), `fixture ${asset}\n`);
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name, version }));
  return installed;
}

for (const names of [[MCP_STDIO], [AGENT_HOSTS], [MCP_STDIO, AGENT_HOSTS]] as const) {
  test(`recovery stages and hashes agent-mem with ${names.join(" and ")} (#1737)`, () => {
    const f = fixture();
    declareMemoryPins(f.dependency, Object.fromEntries(names.map(name => [name, reviewedPins[name]])));
    for (const name of names) installPinnedFixture(f.root, name, reviewedPins[name]);
    mkdirSync(join(f.root, "plugins/agent-hub/.claude-plugin"), { recursive: true });
    mkdirSync(join(f.root, "src/cli"));
    writeFileSync(join(f.root, "src/cli/main.js"), "// fixture\n");
    writeFileSync(join(f.root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
    const source = plan(f.root);
    const preserved = preserveSource(source, f.home);
    expect(verifyPackage(preserved, "0.0.0", { ownDependencies: true })).toBe(source.sourceDigest);
    const staged = join(f.home, "staged"), hub = join(staged, "node_modules/@staix/agent-hub");
    mkdirSync(hub, { recursive: true });
    for (const asset of ["src", "plugins", "templates", ".claude-plugin", "package.json"])
      cpSync(join(f.root, asset), join(hub, asset), { recursive: true });
    for (const name of ["agent-mem", "cli-output", ...names.map(name => name.slice("@staix/".length))])
      cpSync(join(preserved, "node_modules/@staix", name), join(staged, "node_modules/@staix", name), { recursive: true });
    expect(verifyPackage(hub, "0.0.0", { dependencyRoot: staged })).toBe(source.sourceDigest);
    for (const name of names) {
      const asset = join(staged, "node_modules", name, "fixtures/example.json");
      const original = readFileSync(asset, "utf8");
      writeFileSync(asset, original + "changed");
      expect(verifyPackage(hub, "0.0.0", { dependencyRoot: staged })).not.toBe(source.sourceDigest);
      writeFileSync(asset, original);
    }
  });
}

test("recovery refuses unsupported agent-mem dependency names and non-exact pins (#1737)", () => {
  const f = fixture();
  for (const [name, pin] of [["@staix/unreviewed", "1.0.0"], [MCP_STDIO, "^0.2.0"], [AGENT_HOSTS, "~0.1.0"]] as const) {
    declareMemoryPins(f.dependency, { [name]: pin });
    expect(() => packageDigest(f.root, { ownDependencies: true })).toThrow(`${JSON.stringify(name)} pin ${JSON.stringify(pin)}`);
    expect(() => packageDigest(f.root)).toThrow("upgrade to an agent-hub release that accepts it");
  }
});

for (const [name, pin] of Object.entries(reviewedPins)) {
  test(`recovery refuses mismatched or unsafe installations of ${name} (#1737)`, () => {
    const f = fixture();
    declareMemoryPins(f.dependency, { [name]: pin });
    const installed = installPinnedFixture(f.root, name, pin);
    const manifest = join(installed, "package.json");
    const fail = (cause: string) => {
      expect(() => packageDigest(f.root, { ownDependencies: true })).toThrow(cause);
      expect(() => packageDigest(f.root)).toThrow(`${JSON.stringify(name)} pin ${JSON.stringify(pin)}`);
    };
    writeFileSync(manifest, JSON.stringify({ name, version: "9.9.9" }));
    fail("installed package name, version or declared dependencies");
    writeFileSync(manifest, JSON.stringify({ name, version: pin, dependencies: { extra: "1.0.0" } }));
    fail("installed package name, version or declared dependencies");
    writeFileSync(manifest, JSON.stringify({ name, version: pin }));
    mkdirSync(join(installed, "src/node_modules"));
    fail("nested node_modules");
    rmSync(join(installed, "src/node_modules"), { recursive: true });
    symlinkSync("index.ts", join(installed, "src/linked.ts"));
    fail("symlinks");
    rmSync(installed, { recursive: true });
    symlinkSync(f.dependency, installed);
    fail("real sibling directory");
  });
}
