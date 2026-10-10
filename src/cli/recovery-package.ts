import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubHome } from "../hub/project.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type RunCommand = (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<CommandResult>;
export const runCommand: RunCommand = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(args[0]!, args.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exceeded = false;
  const append = (old: string, value: unknown) => {
    const next = old + String(value);
    if (next.length > 2_000_000) { exceeded = true; child.kill("SIGTERM"); }
    return next.slice(-2_000_000);
  };
  child.stdout.on("data", (v) => { stdout = append(stdout, v); });
  child.stderr.on("data", (v) => { stderr = append(stderr, v); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 60_000);
  const hardTimer = setTimeout(() => child.kill("SIGKILL"), (options.timeoutMs ?? 60_000) + 3000);
  child.on("error", (e) => { clearTimeout(timer); clearTimeout(hardTimer); reject(e); });
  child.on("close", (code) => {
    clearTimeout(timer); clearTimeout(hardTimer);
    if (timedOut || exceeded) reject(new Error(`command ${args[0]} ${timedOut ? "timed out" : "exceeded output limit"}; inspect state before retrying`));
    else resolve({ code: code ?? 1, stdout, stderr });
  });
});

export function exactVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("--to requires an exact package version");
  return version;
}

export function packageDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) throw new Error("runtime package must not contain symlinks");
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) visit(join(directory, item.name), `${name}/`);
      else { hash.update(name); hash.update("\0"); hash.update(readFileSync(join(directory, item.name))); hash.update("\0"); }
    }
  };
  // Only runtime assets; never copy or hash a checkout's private state or dependencies.
  for (const name of ["src", "plugins", "templates", ".claude-plugin"]) visit(join(root, name), `${name}/`);
  hash.update(readFileSync(join(root, "package.json")));
  return hash.digest("hex");
}

export function verifyPackage(root: string, version: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), "utf8"));
  if (pkg.name !== "@staix/agent-hub" || pkg.version !== version || plugin.version !== version ||
      !existsSync(join(root, "src/cli/main.js"))) throw new Error("staged package identity/version mismatch");
  return packageDigest(root);
}

export async function registryRelease(version: string, run: RunCommand = runCommand): Promise<{ version: string; integrity: string }> {
  exactVersion(version);
  const result = await run(["npm", "view", `@staix/agent-hub@${version}`, "version", "dist.integrity", "--json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`registry metadata unavailable for @staix/agent-hub@${version}`);
  const data = JSON.parse(result.stdout);
  if (data.version !== version || typeof data["dist.integrity"] !== "string" || !data["dist.integrity"].startsWith("sha512-")) {
    throw new Error("registry returned an unexpected release identity");
  }
  return { version, integrity: data["dist.integrity"] };
}

/** #272: the registry's latest release, the target when `--to` is left out. */
export async function latestRelease(run: RunCommand = runCommand): Promise<string> {
  const result = await run(["npm", "view", "@staix/agent-hub", "version", "--json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error("registry metadata unavailable for @staix/agent-hub; name the release with --to <version>");
  let version: unknown;
  try { version = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (typeof version !== "string") throw new Error("registry returned an unexpected latest release; name the release with --to <version>");
  return exactVersion(version);
}

/** ponytail: compares the numeric triple only, so a pre-release never counts as newer than its own release; a semver compare if pre-releases are ever published. */
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split("-")[0]!.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
}

/** Stage outside the mutable global install; retain successful versions for recovery. */
export async function stageRelease(version: string, integrity: string, run: RunCommand = runCommand, home = hubHome()): Promise<{ root: string; digest: string }> {
  exactVersion(version);
  const base = join(home, "releases");
  const destination = join(base, version);
  const root = join(destination, "node_modules/@staix/agent-hub");
  if (existsSync(destination)) {
    const saved = JSON.parse(readFileSync(join(destination, "verified.json"), "utf8"));
    const digest = verifyPackage(root, version);
    if (saved.integrity !== integrity || saved.digest !== digest) throw new Error("cached release changed; refusing it");
    return { root, digest };
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporary = join(base, `.stage-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, dependencies: { "@staix/agent-hub": version } }));
    const install = await run([process.execPath, "install", "--ignore-scripts", "--cwd", temporary], { timeoutMs: 180_000 });
    if (install.code !== 0) throw new Error("package staging failed; installed runtime was not changed");
    const staged = join(temporary, "node_modules/@staix/agent-hub");
    const digest = verifyPackage(staged, version);
    // Bun's lock records the registry integrity actually used, not a later metadata query.
    const lock = JSON.parse(readFileSync(join(temporary, "bun.lock"), "utf8").replace(/,\s*([}\]])/g, "$1"));
    const row = lock.packages?.["@staix/agent-hub"];
    if (!Array.isArray(row) || !row.includes(integrity)) throw new Error("staged package integrity differs from the reviewed release");
    writeFileSync(join(temporary, "verified.json"), JSON.stringify({ integrity, digest }), { mode: 0o600 });
    renameSync(temporary, destination);
    return { root, digest };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
