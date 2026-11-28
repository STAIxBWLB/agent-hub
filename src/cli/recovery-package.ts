import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { hubHome, realPath } from "../hub/project.ts";
import { Registry } from "../hub/registry.ts";
import { AGENT_MEM_HOST_API_RANGE, agentMemHostApiOk, agentMemVersionInRange, isAgentMemFloorRange, readHostApiConstants } from "../hub/agent-mem-range.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type RunCommand = (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; pipeExitGraceMs?: number }) => Promise<CommandResult>;
export const runCommand: RunCommand = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(args[0]!, args.slice(1), { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (options.input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(options.input); }
  let stdout = "", stderr = "", exceeded = false;
  const append = (old: string, value: unknown) => {
    const next = old + String(value);
    if (next.length > 2_000_000) { exceeded = true; child.kill("SIGTERM"); }
    return next.slice(-2_000_000);
  };
  child.stdout!.on("data", (v) => { stdout = append(stdout, v); });
  child.stderr!.on("data", (v) => { stderr = append(stderr, v); });
  let timedOut = false, incomplete = false;
  let exitGrace: ReturnType<typeof setTimeout> | undefined;
  // ponytail: a probe descendant may retain a pipe after exit; close bounded readers without signaling an unproven descendant. Upgrade: owned process-group proof, as for native probes.
  if (options.pipeExitGraceMs !== undefined) child.once("exit", () => {
    exitGrace = setTimeout(() => { incomplete = true; child.stdout?.destroy(); child.stderr?.destroy(); }, options.pipeExitGraceMs);
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 60_000);
  const hardTimer = setTimeout(() => child.kill("SIGKILL"), (options.timeoutMs ?? 60_000) + 3000);
  child.on("error", (e) => { clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(exitGrace); reject(e); });
  child.on("close", (code) => {
    clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(exitGrace);
    if (incomplete) return reject(new Error("command output remained open after its process exited; inspect the executable before retrying"));
    if (timedOut || exceeded) reject(new Error(`command ${args[0]} ${timedOut ? "timed out" : "exceeded output limit"}; inspect state before retrying`));
    else resolve({ code: code ?? 1, stdout, stderr });
  });
});

export function exactVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("--to requires an exact package version");
  return version;
}

const MEMORY_ASSETS = ["src", "bin", "package.json", "README.md", "LICENSE"] as const;
// Published top-level assets of the reviewed agent-mem dependencies. Keep the legacy output digest narrower.
const MEMORY_RUNTIME_ASSETS = {
  "@staix/cli-output": ["src", "package.json", "README.md", "LICENSE"],
  "@staix/mcp-stdio": ["src", "fixtures", "package.json", "README.md", "LICENSE"],
  "@staix/agent-hosts": ["src", "fixtures", "package.json", "README.md", "LICENSE"],
} as const;
type RuntimePackage = { source: string; name: string; assets: readonly string[] };

function memoryPinError(name: string, pin: unknown, reason: string): Error {
  const shown = (value: unknown) => JSON.stringify(typeof value === "string" ? value.slice(0, 256) : "<invalid pin>");
  return new Error(`memory runtime dependency identity/version mismatch: ${shown(name)} pin ${shown(pin)}: ${reason}; upgrade to an agent-hub release that accepts it`);
}

function memoryPinnedRuntime(memory: string, name: string, pin: unknown, outputPin: unknown): RuntimePackage {
  if (!Object.hasOwn(MEMORY_RUNTIME_ASSETS, name) || typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin)
    || name === "@staix/cli-output" && pin !== outputPin) throw memoryPinError(name, pin, "unsupported dependency or exact pin");
  const scope = dirname(memory), modules = dirname(scope), source = join(scope, basename(name));
  try {
    if (basename(scope) !== "@staix" || basename(modules) !== "node_modules"
      || [modules, scope, source].some(path => !lstatSync(path).isDirectory())) throw new Error("layout");
  } catch {
    const reason = name === "@staix/cli-output" ? "output runtime dependency is unavailable or is not a real sibling directory"
      : "installed package must be a real sibling directory beside agent-mem";
    throw memoryPinError(name, pin, reason);
  }
  let installed;
  try {
    const manifest = join(source, "package.json");
    if (!lstatSync(manifest).isFile()) throw new Error("manifest");
    installed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch { throw memoryPinError(name, pin, "installed package manifest is unavailable"); }
  if (installed?.name !== name || installed.version !== pin
    || [installed.dependencies, installed.optionalDependencies, installed.peerDependencies].some(dependencies =>
      dependencies !== undefined && (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies) || Object.keys(dependencies).length)))
    throw memoryPinError(name, pin, "installed package name, version or declared dependencies do not match the reviewed layout");
  const inspect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile())
        throw memoryPinError(name, pin, "installed package must not contain symlinks, special files or nested node_modules");
      if (entry.isDirectory()) inspect(join(dir, entry.name));
    }
  };
  inspect(source);
  const assets = MEMORY_RUNTIME_ASSETS[name as keyof typeof MEMORY_RUNTIME_ASSETS];
  if (assets.some(asset => !existsSync(join(source, asset)))) throw memoryPinError(name, pin, "installed package lacks a reviewed runtime asset");
  return { source, name, assets };
}

/** Runtime dependencies are limited to the reviewed first-party packages, never an arbitrary dependency tree. */
function memoryRuntime(root: string, dependencyRoot?: string): RuntimePackage[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  if (!Object.keys(deps).length) return [];
  const declared = deps["@staix/agent-mem"];
  // #1611: a current package declares a floor range `>=X.Y.Z <M.0.0`; a package staged under #1605 declares `~X.Y.Z` and one before it an exact
  // version, so a cached release still verifies (legacy forms need no host API); compound ranges, `^`, `*` and prereleases stay refused.
  if (Object.keys(deps).some(name => !["@staix/agent-mem", "@staix/cli-output"].includes(name)) || typeof declared !== "string" || !(/^~?\d+\.\d+\.\d+$/.test(declared) || isAgentMemFloorRange(declared))) throw new Error("unsupported runtime dependencies in recovery package");
  let dir = dependencyRoot ? join(dependencyRoot, "node_modules/@staix/agent-mem")
    : dirname(createRequire(join(root, "package.json")).resolve("@staix/agent-mem"));
  if (dependencyRoot && !existsSync(dir)) throw new Error("memory runtime dependency is unavailable");
  if (dependencyRoot) for (const name of ["node_modules", "node_modules/@staix", "node_modules/@staix/agent-mem"]) {
    if (lstatSync(join(dependencyRoot, name)).isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
  }
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const memory = JSON.parse(readFileSync(manifest, "utf8"));
      if (memory.name === "@staix/agent-mem") {
        const installed = typeof memory.version === "string" ? memory.version : "";
        const accepted = declared.startsWith("~") || declared.startsWith(">=") ? agentMemVersionInRange(installed, declared) : installed === declared;
        if (accepted && isAgentMemFloorRange(declared)) {
          // #1611: a floor-form package also needs a host API the hub supports, read from the staged package's own platform module.
          let text = "";
          try { text = readFileSync(join(dir, "src/memory/platform.ts"), "utf8"); } catch { /* missing constants refuse below */ }
          const host = readHostApiConstants(text);
          if (!agentMemHostApiOk(host.min, host.version))
            throw new Error(`memory runtime host API ${host.min ?? "missing"}..${host.version ?? "missing"} does not intersect the supported ${AGENT_MEM_HOST_API_RANGE[0]}..${AGENT_MEM_HOST_API_RANGE[1]}`);
        }
        const memoryDeps = Object.entries(memory.dependencies ?? {}), outputPin = deps["@staix/cli-output"];
        // The output package owns the refusal for a ranged hub pin.
        if (memoryDeps.length && typeof outputPin === "string" && !/^\d+\.\d+\.\d+$/.test(outputPin)) throw new Error("output runtime dependency must be an exact version");
        if (!accepted || (memoryDeps.length > 0 && readdirSync(dir).includes("node_modules"))) throw new Error("memory runtime dependency identity/version mismatch");
        const source = realPath(dir);
        return [{ source, name: "@staix/agent-mem", assets: MEMORY_ASSETS },
          ...memoryDeps.sort(([a], [b]) => a.localeCompare(b)).map(([name, pin]) => memoryPinnedRuntime(source, name, pin, outputPin))];
      }
    }
    const parent = dirname(dir);
    if (dependencyRoot || parent === dir) throw new Error("memory runtime dependency is unavailable");
    dir = parent;
  }
}

/** Resolve only the declared exact output package, including in an isolated retained or staged install. */
function outputRuntime(root: string, dependencyRoot?: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = pkg.dependencies?.["@staix/cli-output"];
  if (declared === undefined) return undefined;
  if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/.test(declared)) throw new Error("output runtime dependency must be an exact version");
  let dir = dependencyRoot ? join(dependencyRoot, "node_modules/@staix/cli-output")
    : dirname(createRequire(join(root, "package.json")).resolve("@staix/cli-output"));
  if (dependencyRoot && !existsSync(dir)) throw new Error("output runtime dependency is unavailable");
  if (dependencyRoot) for (const name of ["node_modules", "node_modules/@staix", "node_modules/@staix/cli-output"]) {
    if (lstatSync(join(dependencyRoot, name)).isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
  }
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const output = JSON.parse(readFileSync(manifest, "utf8"));
      if (output.name === "@staix/cli-output") {
        if (output.version !== declared || Object.keys(output.dependencies ?? {}).length) throw new Error("output runtime dependency identity/version mismatch");
        return realPath(dir);
      }
    }
    const parent = dirname(dir);
    if (dependencyRoot || parent === dir) throw new Error("output runtime dependency is unavailable");
    dir = parent;
  }
}

/** Preserve the historical digest order, hashing shared cli-output only once. */
function runtimeDependencies(root: string, dependencyRoot?: string): RuntimePackage[] {
  const [memory, ...pinned] = memoryRuntime(root, dependencyRoot);
  const output = outputRuntime(root, dependencyRoot);
  const shared = pinned.find(pkg => pkg.name === "@staix/cli-output");
  if (shared && shared.source !== output) {
    const pin = JSON.parse(readFileSync(join(shared.source, "package.json"), "utf8")).version;
    throw memoryPinError(shared.name, pin, "agent-mem and the hub must resolve the same cli-output package");
  }
  const packages = memory ? [memory] : [];
  if (output) packages.push({ source: output, name: "@staix/cli-output", assets: MEMORY_RUNTIME_ASSETS["@staix/cli-output"] });
  return packages.concat(pinned.filter(pkg => pkg.name !== "@staix/cli-output"));
}

export function preserveRuntimeDependencies(root: string, destination: string): void {
  for (const { source, name, assets } of runtimeDependencies(root)) {
    const target = join(destination, "node_modules", name);
    mkdirSync(target, { recursive: true });
    for (const asset of assets) {
      if (lstatSync(join(source, asset)).isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
      cpSync(join(source, asset), join(target, asset), { recursive: true, dereference: false });
    }
  }
}

export function packageDigest(root: string, options: { ownDependencies?: boolean; dependencyRoot?: string } = {}): string {
  const hash = createHash("sha256");
  const file = (path: string, name: string) => { hash.update(name); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0"); };
  const visit = (directory: string, prefix = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) visit(join(directory, item.name), `${name}/`);
      else file(join(directory, item.name), name);
    }
  };
  // Only runtime assets and the resolved first-party packages; never private state or unrelated dependencies.
  for (const name of ["src", "plugins", "templates", ".claude-plugin"]) visit(join(root, name), `${name}/`);
  hash.update(readFileSync(join(root, "package.json")));
  for (const { source, name, assets } of runtimeDependencies(root, options.ownDependencies ? root : options.dependencyRoot)) {
    for (const asset of assets) {
      const path = join(source, asset), stat = lstatSync(path), prefix = `node_modules/${name}/${asset}`;
      if (stat.isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
      if (stat.isDirectory()) visit(path, `${prefix}/`); else file(path, prefix);
    }
  }
  return hash.digest("hex");
}

export function verifyPackage(root: string, version: string, options: { ownDependencies?: boolean; dependencyRoot?: string } = {}): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), "utf8"));
  if (pkg.name !== "@staix/agent-hub" || pkg.version !== version || plugin.version !== version ||
      !existsSync(join(root, "src/cli/main.js"))) throw new Error("staged package identity/version mismatch");
  return packageDigest(root, options);
}

/** Preserved restart coordinators own their dependency; staged upgrades use the install's hoisted dependency. */
export function recoveryPackageOptions(kind: "restart" | "upgrade", root: string): { ownDependencies?: boolean; dependencyRoot?: string } {
  if (kind === "restart") return { ownDependencies: true };
  if (kind !== "upgrade") throw new Error("unsupported recovery package kind");
  const canonical = realPath(root);
  // Project captures own their resolved dependencies and keep the registry install separate below this version.
  if (canonical === root && /^source-[a-f0-9]{64}$/.test(basename(canonical)) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(basename(dirname(canonical)))
    && basename(dirname(dirname(canonical))) === "releases") return { ownDependencies: true };
  const dependencyRoot = resolve(canonical, "../../..");
  if (canonical !== root || canonical !== join(dependencyRoot, "node_modules", "@staix", "agent-hub")) throw new Error("invalid staged recovery package path");
  return { dependencyRoot };
}

export function recoveryTargetDigest(kind: "restart" | "upgrade", root: string): string {
  return packageDigest(root, recoveryPackageOptions(kind, root));
}

export function verifyRecoveryTarget(kind: "restart" | "upgrade", root: string, version: string): string {
  return verifyPackage(root, version, recoveryPackageOptions(kind, root));
}

/** #1120: the documentation checker that `ahub sdlc authorize-release` and release readiness spawn. A capture without it can never record release consent. */
export const RELEASE_CHECKER = "scripts/check-docs.mjs";
// ponytail: the checker is copied and kept by prune, but is not in packageDigest. Widening the digest would make every release staged before this change refuse as "cached release changed". Ceiling: a tampered checker in a capture is not detected by the digest. Upgrade path: fold it into packageDigest with a digest-version bump once no pre-#1120 capture or cached release remains.
const RUNTIME_ASSETS = ["src", "plugins", "templates", ".claude-plugin", "package.json", "README.md", "LICENSE", "CHANGELOG.md"] as const;
function runtimeDirectory(directory: string): void {
  let info;
  try { info = lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    info = lstatSync(directory);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime cache must contain real directories");
}

/** Preserve the exact bounded asset set; legacy coordinators need not have a plugin identity manifest. */
function preserveRuntimeAssets(sourceRoot: string, destination: string, expectedDigest: string, version?: string): { root: string; digest: string } {
  const digest = (root: string, ownDependencies = false) => version === undefined
    ? packageDigest(root, { ownDependencies }) : verifyPackage(root, version, { ownDependencies });
  if (digest(sourceRoot) !== expectedDigest) throw new Error("source package changed before preservation");
  runtimeDirectory(dirname(destination));
  const cached = () => {
    let info;
    try { info = lstatSync(destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || digest(destination, true) !== expectedDigest)
      throw new Error(version === undefined ? "preserved source package changed" : "preserved runtime changed; refusing it");
    return { root: realPath(destination), digest: expectedDigest };
  };
  const previous = cached(); if (previous) return previous;
  const temporary = join(dirname(destination), `.source-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const name of RUNTIME_ASSETS) cpSync(join(sourceRoot, name), join(temporary, name), { recursive: true, dereference: false });
    // Absent in a source that predates the checker (a registry package before #1120 ships it): the capture then reports the checker as unavailable, never a stale document.
    if (existsSync(join(sourceRoot, RELEASE_CHECKER))) {
      if (!lstatSync(join(sourceRoot, RELEASE_CHECKER)).isFile()) throw new Error(`${RELEASE_CHECKER} must be a regular file to be preserved in a runtime capture; replace it with a regular file`);
      mkdirSync(join(temporary, dirname(RELEASE_CHECKER)), { recursive: true });
      cpSync(join(sourceRoot, RELEASE_CHECKER), join(temporary, RELEASE_CHECKER), { dereference: false });
    }
    preserveRuntimeDependencies(sourceRoot, temporary);
    if (digest(temporary, true) !== expectedDigest || digest(sourceRoot) !== expectedDigest)
      throw new Error("source package changed while being preserved");
    try { renameSync(temporary, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // A concurrent publisher may have won. Validate its complete bytes; never remove its directory.
      const winner = cached(); if (winner) return winner;
      throw error;
    }
    const published = cached();
    if (!published) throw new Error("preserved runtime vanished after publication");
    return published;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Capture a verified package identity and its exact first-party dependency, never a node_modules tree. */
export function preserveRuntimePackage(sourceRoot: string, destination: string, expectedDigest: string): { root: string; digest: string; version: string } {
  const version = exactVersion(JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version);
  return { ...preserveRuntimeAssets(sourceRoot, destination, expectedDigest, version), version };
}

/** Retained legacy coordinators keep their digest-only contract and still require their own exact dependency. */
export function preserveRuntimeSource(sourceRoot: string, destination: string, expectedDigest: string): string {
  preserveRuntimeAssets(sourceRoot, destination, expectedDigest);
  return destination; // Legacy receipts retain the path spelling their coordinator already bound.
}

/** Ordinary startup preserves the invoking package, including unpublished builds, below its version namespace. */
export function stageCurrentRuntime(sourceRoot: string, version: string, home = hubHome(), registry?: Registry): { root: string; digest: string; version: string } {
  exactVersion(version);
  const digest = verifyPackage(sourceRoot, version);
  const owner = registry ?? new Registry(join(home, "registry.db"));
  try {
    if (realPath(owner.path) !== realPath(join(home, "registry.db"))) throw new Error("runtime capture registry belongs to another home");
    return owner.runtimeCaptureLocked(() => {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const releases = join(realPath(home), "releases"); runtimeDirectory(releases);
      const versionRoot = join(releases, version); runtimeDirectory(versionRoot);
      return preserveRuntimePackage(sourceRoot, join(versionRoot, `source-${digest}`), digest);
    });
  } finally { if (!registry) owner.close(); }
}

/** #1253: npm 12 wraps `npm view --json` output for one package in a one-element array; npm 11 printed the value itself. Anything else is not one release. */
function npmViewJson(stdout: string): unknown {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(value)) return value;
  return value.length === 1 ? value[0] : undefined;
}

export async function registryRelease(version: string, run: RunCommand = runCommand): Promise<{ version: string; integrity: string }> {
  exactVersion(version);
  const result = await run(["npm", "view", `@staix/agent-hub@${version}`, "version", "dist.integrity", "--json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`registry metadata unavailable for @staix/agent-hub@${version}`);
  const data = npmViewJson(result.stdout) as Record<string, unknown> | undefined;
  const integrity = data?.["dist.integrity"];
  if (data?.version !== version || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`registry returned an unexpected release identity for @staix/agent-hub@${version} (expected one release with a sha512 integrity from \`npm view --json\`); check \`npm view @staix/agent-hub@${version} version dist.integrity --json\` and your npm version`);
  }
  return { version, integrity };
}

/** #272: the registry's latest release, the target when `--to` is left out. */
export async function latestRelease(run: RunCommand = runCommand): Promise<string> {
  const result = await run(["npm", "view", "@staix/agent-hub", "version", "--json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error("registry metadata unavailable for @staix/agent-hub; name the release with --to <version>");
  const version = npmViewJson(result.stdout);
  if (typeof version !== "string") throw new Error("registry returned an unexpected latest release (expected one version from `npm view --json`); check `npm view @staix/agent-hub version --json`, or name the release with --to <version>");
  return exactVersion(version);
}

/** ponytail: compares the numeric triple only, so a pre-release never counts as newer than its own release; a semver compare if pre-releases are ever published. */
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split("-")[0]!.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
}

/** Stage outside the mutable global install; retain successful versions for recovery. */
export async function stageRelease(version: string, integrity: string, run: RunCommand = runCommand, home = hubHome(), project = false): Promise<{ root: string; digest: string }> {
  exactVersion(version);
  const base = join(home, "releases");
  const versionRoot = join(base, version);
  // Ordinary startup can create this parent before an unstaged legacy receipt resumes.
  // An actual legacy install (even a damaged one) must retain its original path and validation.
  if (!project && existsSync(versionRoot) && !existsSync(join(versionRoot, "verified.json")) && !existsSync(join(versionRoot, "node_modules"))) {
    runtimeDirectory(versionRoot);
    if (!readdirSync(versionRoot).every(name => name === "registry" || /^source-[a-f0-9]{64}$/.test(name))) throw new Error("cached release state is unknown; refusing it");
    project = true;
  }
  const destination = project ? join(versionRoot, "registry") : versionRoot;
  const root = join(destination, "node_modules/@staix/agent-hub");
  if (existsSync(destination)) {
    const saved = JSON.parse(readFileSync(join(destination, "verified.json"), "utf8"));
    const digest = verifyPackage(root, version, { dependencyRoot: destination });
    if (saved.integrity !== integrity || saved.digest !== digest) throw new Error("cached release changed; refusing it");
    return { root, digest };
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (project) runtimeDirectory(join(base, version));
  const temporary = join(base, `.stage-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, dependencies: { "@staix/agent-hub": version } }));
    const install = await run([process.execPath, "install", "--ignore-scripts", "--cwd", temporary], { timeoutMs: 180_000 });
    if (install.code !== 0) throw new Error("package staging failed; installed runtime was not changed");
    const staged = join(temporary, "node_modules/@staix/agent-hub");
    const digest = verifyPackage(staged, version, { dependencyRoot: temporary });
    // Bun's lock records the registry integrity actually used, not a later metadata query.
    const lock = JSON.parse(readFileSync(join(temporary, "bun.lock"), "utf8").replace(/,\s*([}\]])/g, "$1"));
    const row = lock.packages?.["@staix/agent-hub"];
    if (!Array.isArray(row) || !row.includes(integrity)) throw new Error("staged package integrity differs from the reviewed release");
    writeFileSync(join(temporary, "verified.json"), JSON.stringify({ integrity, digest }), { mode: 0o600 });
    renameSync(temporary, destination);
    return { root, digest };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
