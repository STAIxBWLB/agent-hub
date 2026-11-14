import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, opendir, open, stat, writeFile, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { realPath } from "../hub/project.ts";
import { stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { InstallPolicyError, parseInstallManifest } from "../hub/install-policy.ts";
import { hubGitEnv, hubGitSync } from "../hub/git.ts";

export const PI_DEPENDENCY_TIMEOUT_MS = 15_000;
/** Safety ceiling on every traversed directory entry, excluding the contents of Git and installed modules. */
export const PI_DEPENDENCY_ENTRY_LIMIT = 10_000;
export const PI_DEPENDENCY_MANIFEST_BYTES = 64 * 1024;
export const PI_DEPENDENCY_INPUT_BYTES = 4 * 1024 * 1024;
export const PI_DEPENDENCY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export type DependencyPreparation = { ready: true } | { ready: false; reason: "missing bun.lock" | "lifecycle script" | "invalid manifest" | "task changed" | "installer unavailable" | "install failed" | "install timed out" | "staging unavailable" | "node_modules exists" | "unsupported workspace layout" | "different filesystem" | "install inputs changed in task" | "unsupported install inputs" };
type DependencyReason = Exclude<DependencyPreparation, { ready: true }>["reason"];
export interface DependencyInstallRequest {
  executable: string; args: readonly ["install", "--frozen-lockfile"]; cwd: string;
  env: { HOME: string; BUN_INSTALL_CACHE_DIR: string }; timeoutMs: number;
}
export type DependencyRunner = (request: DependencyInstallRequest) => Promise<{ code: number | null; timedOut?: boolean }>;
export interface DependencyPublishTarget { cwd: string; dev: number; ino: number; timeoutMs: number }
/** Host-owned test/authority seams only; never populated from peer tool arguments or project config. */
export interface PiDependencyOptions {
  /** Trusted TaskWorktrees record and original repository; never supplied by a peer. */
  base?: string; repositoryRoot?: string;
  /** Parent attests this is hub-owned state denied to the entire peer sandbox, not sibling .worktrees space. */
  stagingParent?: string;
  /** Host publisher must pin CWD to this held identity; absolute target-path rename is not a safe implementation. */
  publish?: (source: string, target: DependencyPublishTarget, current: () => boolean) => Promise<boolean>;
  current?: () => boolean; run?: DependencyRunner; now?: () => number;
}
class PreparationStopped extends Error {
  constructor(readonly reason: DependencyReason) { super(reason); }
}

const install: DependencyRunner = request => new Promise(resolve => {
  const child = spawn(request.executable, [...request.args], { cwd: request.cwd, env: request.env, detached: true, stdio: "ignore" });
  trackGroup(child);
  let settling = false;
  const finish = async (code: number | null, timedOut = false) => {
    if (settling) return; settling = true; clearTimeout(timer);
    try { await stopOwnedProcess(child, { group: true }); resolve({ code, ...(timedOut ? { timedOut: true } : {}) }); }
    catch { resolve({ code: null, ...(timedOut ? { timedOut: true } : {}) }); }
  };
  const timer = setTimeout(() => { void finish(null, true); }, request.timeoutMs);
  child.once("error", () => { void finish(null); });
  child.once("close", code => { void finish(code); });
});

/** Prepare only this worktree. Failure is advisory; acceptance authority remains entirely with Tasks. */
export async function preparePiDependencies(cwd: string, options: PiDependencyOptions = {}): Promise<DependencyPreparation> {
  let home: string | undefined, staging: string | undefined, root: string | undefined, rootFd: FileHandle | undefined;
  const now = options.now ?? (() => performance.now()), deadline = now() + PI_DEPENDENCY_TIMEOUT_MS;
  const current = () => { try { return options.current?.() !== false; } catch { return false; } };
  const check = () => {
    if (!current()) throw new PreparationStopped("task changed");
    if (now() >= deadline) throw new PreparationStopped("install timed out");
    if (rootFd && root) {
      try {
        const held = fstatSync(rootFd.fd), actual = lstatSync(root);
        if (!actual.isDirectory() || actual.isSymbolicLink() || held.dev !== actual.dev || held.ino !== actual.ino) throw new Error("changed");
      } catch { throw new PreparationStopped("task changed"); }
    }
  };
  const input = (name: string) => /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml|\.npmrc)$|(?:^|\/)patches\//.test(name);
  const excluded = (name: string) => name.split("/").some(part => part.toLowerCase() === ".git" || part === "node_modules");
  const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  const byteLimit = (name: string) => name.endsWith("package.json") || name.endsWith("bunfig.toml") || name.endsWith(".npmrc") ? PI_DEPENDENCY_MANIFEST_BYTES : PI_DEPENDENCY_INPUT_BYTES;
  const fail = (reason: DependencyReason): never => { throw new PreparationStopped(reason); };
  try {
    check(); root = realPath(cwd);
    if (root !== cwd) return { ready: false, reason: "task changed" };
    if (!options.base || !/^[0-9a-f]{40}$/.test(options.base) || !options.repositoryRoot) return { ready: false, reason: "unsupported install inputs" };
    if (!options.stagingParent) return { ready: false, reason: "staging unavailable" };
    const repository = realPath(options.repositoryRoot), parent = realPath(options.stagingParent);
    rootFd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); check();
    const target = join(root, "node_modules");
    const targetAbsent = async () => {
      try { await lstat(target); check(); fail("node_modules exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; check(); }
    };
    await targetAbsent();
    staging = mkdtempSync(join(parent, "pi-dependencies-")); staging = realPath(staging);
    const rootInfo = await rootFd.stat(), stagedInfo = await lstat(staging); check();
    if (rootInfo.dev !== stagedInfo.dev) return { ready: false, reason: "different filesystem" };
    const git = (args: string[], limit: number): Buffer => {
      check();
      const timeout = deadline - now(); if (timeout <= 0) fail("install timed out");
      const result = hubGitSync(["-C", repository, ...args], { env: hubGitEnv({}, { repositoryIsolation: true }), timeout, maxBuffer: limit });
      check(); if (result.error || result.status !== 0) fail("unsupported install inputs");
      const data = typeof result.stdout === "string" ? Buffer.from(result.stdout, "utf8") : Buffer.from(result.stdout ?? []);
      if (data.length > limit) fail("unsupported install inputs"); return data;
    };
    const paths = new Map<string, string>();
    const tree = git(["ls-tree", "-r", "-z", "--full-tree", options.base], PI_DEPENDENCY_SNAPSHOT_BYTES).toString("utf8");
    let count = 0;
    for (const entry of tree.split("\0").filter(Boolean)) {
      if (++count > PI_DEPENDENCY_ENTRY_LIMIT) fail("unsupported install inputs");
      const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) fail("unsupported install inputs");
      const name = match![4]!;
      if (excluded(name) || !input(name)) continue;
      if (isAbsolute(name) || name.split("/").some(part => !part || part === "." || part === "..") || match![1] === "120000" || match![2] !== "blob") fail("unsupported install inputs");
      paths.set(name, match![3]!);
    }
    if (!paths.has("bun.lock")) return { ready: false, reason: "missing bun.lock" };
    if (!paths.has("package.json")) return { ready: false, reason: "invalid manifest" };
    let bytes = 0;
    for (const [name, oid] of paths) {
      const data = git(["cat-file", "blob", oid], byteLimit(name) + 1);
      if (data.length > byteLimit(name) || (bytes += data.length) > PI_DEPENDENCY_SNAPSHOT_BYTES) return { ready: false, reason: "invalid manifest" };
      const destination = join(staging, name); await mkdir(dirname(destination), { recursive: true }); check();
      await writeFile(destination, data, { flag: "wx", mode: 0o600 }); check();
    }
    const readBounded = async (file: string, limit: number): Promise<Buffer> => {
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        check(); const info = await fd.stat(); check();
        if (!info.isFile()) throw new InstallPolicyError("invalid manifest");
        const data = Buffer.alloc(limit + 1); let used = 0;
        while (used < data.length) {
          const { bytesRead } = await fd.read(data, used, data.length - used, used); check();
          if (!bytesRead) break; used += bytesRead;
        }
        if (used > limit) throw new InstallPolicyError("invalid manifest");
        return data.subarray(0, used);
      } finally { await fd.close(); }
    };
    const stagedInputs = new Map<string, string>();
    for (const name of paths.keys()) {
      const data = await readBounded(join(staging, name), byteLimit(name)); check(); stagedInputs.set(name, hash(data));
      if (name.endsWith("package.json")) {
        const manifest = parseInstallManifest(data);
        if (Object.hasOwn(manifest, "trustedDependencies")) return { ready: false, reason: "unsupported install inputs" };
      } else if (name.endsWith("bunfig.toml")) {
        const config = Bun.TOML.parse(data.toString("utf8")) as Record<string, unknown>;
        const installKeysUnsafe = (value: unknown): boolean => !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => /preload|lifecycle|script|trustedDependencies/i.test(key) || installKeysUnsafe(item));
        // Test-only preload does not execute during install and stays byte-for-byte in the reviewed snapshot.
        if (Object.hasOwn(config, "preload") || installKeysUnsafe(config.install)) return { ready: false, reason: "unsupported install inputs" };
      }
    }
    const currentInputs = async (): Promise<Map<string, string>> => {
      const result = new Map<string, string>(); let entries = 0, total = 0;
      const walk = async (dir: string, prefix: string): Promise<void> => {
        const children = await opendir(dir);
        for await (const entry of children) {
          check();
          if (++entries > PI_DEPENDENCY_ENTRY_LIMIT) fail("install inputs changed in task");
          if (entry.name === ".git") continue;
          if (entry.name === "node_modules") { if (prefix) fail("unsupported workspace layout"); continue; }
          const file = join(dir, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) {
            if (input(name)) fail("install inputs changed in task");
            const target = await stat(file); check();
            if (target.isDirectory()) fail("install inputs changed in task");
          } else if (entry.isDirectory()) await walk(file, name);
          else if (input(name)) {
            if (!entry.isFile()) fail("install inputs changed in task");
            const data = await readBounded(file, byteLimit(name)); check();
            if ((total += data.length) > PI_DEPENDENCY_SNAPSHOT_BYTES) fail("install inputs changed in task");
            result.set(name, hash(data));
          }
        }
      };
      await walk(root!, ""); check(); return result;
    };
    const unchanged = async () => {
      let actual: Map<string, string>;
      try { actual = await currentInputs(); }
      catch (error) { if (error instanceof PreparationStopped) throw error; fail("install inputs changed in task"); }
      if (actual!.size !== stagedInputs.size || [...stagedInputs].some(([name, digest]) => actual!.get(name) !== digest)) fail("install inputs changed in task");
    };
    await unchanged(); check();
    let executable: string;
    try {
      executable = realPath(process.execPath);
      if (!isAbsolute(executable)) return { ready: false, reason: "installer unavailable" };
    } catch { return { ready: false, reason: "installer unavailable" }; }
    home = mkdtempSync(join(parent, "pi-install-home-")); home = realPath(home);
    const request: DependencyInstallRequest = { executable, args: ["install", "--frozen-lockfile"], cwd: staging,
      env: { HOME: home, BUN_INSTALL_CACHE_DIR: join(homedir(), ".bun", "install", "cache") }, timeoutMs: deadline - now() };
    check(); const result = await (options.run ?? install)(request); check();
    if (result.timedOut) return { ready: false, reason: "install timed out" };
    if (result.code !== 0) return { ready: false, reason: "install failed" };
    let modules;
    try { modules = await lstat(join(staging, "node_modules")); check(); }
    catch (error) { if (error instanceof PreparationStopped) throw error; return { ready: false, reason: "unsupported workspace layout" }; }
    if (!modules.isDirectory() || modules.isSymbolicLink()) return { ready: false, reason: "unsupported workspace layout" };
    let layouts = 0;
    const workspaceLayout = async (dir: string, top = true): Promise<void> => {
      for await (const entry of await opendir(dir)) {
        check(); if (++layouts > PI_DEPENDENCY_ENTRY_LIMIT) fail("unsupported workspace layout");
        if (entry.name === "node_modules") { if (!top) fail("unsupported workspace layout"); continue; }
        if (entry.isDirectory()) await workspaceLayout(join(dir, entry.name), false);
      }
    };
    await workspaceLayout(staging); await unchanged(); await targetAbsent(); check();
    // No cooperative path-based fallback: the daemon supplies the CWD-pinned trusted publisher.
    const publicationCurrent = () => { try { check(); return true; } catch { return false; } };
    try { if (!options.publish || !await options.publish(join(staging, "node_modules"), { cwd: root, dev: rootInfo.dev, ino: rootInfo.ino, timeoutMs: deadline - now() }, publicationCurrent)) return { ready: false, reason: "install failed" }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EXDEV") return { ready: false, reason: "different filesystem" }; throw error; }
    check(); return { ready: true };
  } catch (error) {
    if (!current()) return { ready: false, reason: "task changed" };
    if (error instanceof PreparationStopped) return { ready: false, reason: error.reason };
    if (error instanceof InstallPolicyError) return { ready: false, reason: error.reason };
    return { ready: false, reason: "install failed" };
  } finally {
    await rootFd?.close().catch(() => {});
    for (const own of [home, staging]) if (own) { try { rmSync(own, { recursive: true, force: true }); } catch { /* Advisory cleanup never changes an accepted task. */ } }
  }
}
