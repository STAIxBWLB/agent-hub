import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "../../src/hub/project.ts";
import { COMPAT } from "../../src/adapters/compat.ts";
import { ReceiptError, type ReceiptContext, type ManifestEntry, type InstalledArtifact, type ReceiptFetch } from "./types.ts";

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function publicURL(value: unknown, hosts: readonly string[]): string {
  if (typeof value !== "string") throw new ReceiptError("integrity");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new ReceiptError("integrity");
  return url.href;
}
async function bytes(fetcher: ReceiptFetch, url: string, signal: AbortSignal, cap: number): Promise<Buffer> {
  // Public requests never consult account credentials or forward authentication on redirects.
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await fetcher(url, { signal, credentials: "omit", redirect: "manual", headers: { Accept: "application/octet-stream" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 4) throw new ReceiptError("integrity");
    url = publicURL(new URL(location, url).href, ["registry.npmjs.org", "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  }
  if (!response) throw new ReceiptError("install-unavailable");
  if (!response.ok || !response.body) throw new ReceiptError("install-unavailable");
  const size = response.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > cap)) throw new ReceiptError("integrity");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > cap) throw new ReceiptError("integrity");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
interface NpmMetadata { name: string; version: string; dist?: { tarball?: string; integrity?: string } }
interface ReleaseAsset { name: string; url: string; digest?: string }
interface ReleaseMetadata { tag_name: string; assets: ReleaseAsset[] }
// These are public JSON documents; critical identity/URL/digest fields are checked before effects.
async function json<T>(fetcher: ReceiptFetch, url: string, signal: AbortSignal, cap: number): Promise<T> {
  try { return JSON.parse((await bytes(fetcher, url, signal, cap)).toString("utf8")); }
  catch (error) { if (error instanceof ReceiptError) throw error; throw new ReceiptError("integrity"); }
}
function verifySRI(data: Buffer, integrity: unknown): string {
  // Require one strong digest rather than letting a weaker alternate mask a mismatch.
  if (typeof integrity !== "string" || !/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new ReceiptError("integrity");
  const [algorithm, encoded] = integrity.split("-");
  const expected = Buffer.from(encoded!, "base64");
  const actual = createHash(algorithm!).update(data).digest();
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new ReceiptError("integrity");
  return integrity;
}
function privateEnv(context: ReceiptContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: context.home, PATH: context.env.PATH, LANG: "C", LC_ALL: "C" };
  for (const key of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    const value = context.env[key];
    if (value && isAbsolute(value) && inside(realPath(context.root), realPath(value))) env[key] = value;
  }
  return env;
}
async function run(context: ReceiptContext, signal: AbortSignal, argv: string[], env = privateEnv(context), failure: "integrity" | "install-unavailable" = "install-unavailable"): Promise<void> {
  const result = await context.run(argv, { cwd: context.cwd, env, signal, timeoutMs: context.limits.installMs, maxBytes: context.limits.outputBytes });
  if (!result.cleanup) throw new ReceiptError("cleanup");
  if (result.timedOut || signal.aborted) throw new ReceiptError("timeout");
  if (result.exitCode !== 0) throw new ReceiptError(failure);
}
async function privateCommand(prefix: string, candidate: string): Promise<string> {
  const command = realPath(candidate);
  if (!inside(realPath(prefix), command) || !(await lstat(command)).isFile() || !((await lstat(command)).mode & 0o111)) throw new ReceiptError("integrity");
  return command;
}
async function npmArtifact(context: ReceiptContext, entry: ManifestEntry, fetcher: ReceiptFetch, signal: AbortSignal): Promise<InstalledArtifact> {
  const name = entry.install.package;
  if (!name || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new ReceiptError("input");
  const metadata = await json<NpmMetadata>(fetcher, `https://registry.npmjs.org/${name}/${context.version}`, signal, context.limits.outputBytes);
  if (metadata.name !== name || metadata.version !== context.version) throw new ReceiptError("integrity");
  const tarball = publicURL(metadata.dist?.tarball, ["registry.npmjs.org"]);
  const data = await bytes(fetcher, tarball, signal, context.limits.artifactBytes);
  const integrity = verifySRI(data, metadata.dist?.integrity);
  const archive = join(context.root, "verified-package.tgz");
  // No file or command effect precedes exact identity and byte-integrity verification.
  await writeFile(archive, data, { flag: "wx", mode: 0o600 });
  const config = join(context.root, "empty-user.npmrc");
  const globalConfig = join(context.root, "empty-global.npmrc");
  await writeFile(config, "", { flag: "wx", mode: 0o600 });
  await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
  const env = { ...privateEnv(context), npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_cache: join(context.root, "npm-cache"), npm_config_registry: "https://registry.npmjs.org/", npm_config_update_notifier: "false" };
  await run(context, signal, ["npm", "install", "--prefix", context.prefix, "--no-audit", "--no-fund", "--save-exact", archive], env);
  const packageRoot = realPath(join(context.prefix, "node_modules", name));
  if (!inside(realPath(context.prefix), packageRoot)) throw new ReceiptError("integrity");
  const packageJSON = join(packageRoot, "package.json");
  if (!(await lstat(packageJSON)).isFile()) throw new ReceiptError("integrity");
  const installed = JSON.parse(await readFile(packageJSON, "utf8"));
  if (installed.name !== name || installed.version !== context.version) throw new ReceiptError("integrity");
  const cli = COMPAT[context.id].probe[0]!;
  const bin = typeof installed.bin === "string" ? installed.bin : installed.bin?.[cli];
  if (typeof bin !== "string" || !inside(packageRoot, resolve(packageRoot, bin))) throw new ReceiptError("integrity");
  const command = await privateCommand(context.prefix, join(context.prefix, "node_modules", ".bin", cli));
  if (command !== realPath(resolve(packageRoot, bin))) throw new ReceiptError("integrity");
  return { method: entry.install.method, integrity, packageRoot, command: [command] };
}
async function releaseArtifact(context: ReceiptContext, entry: ManifestEntry, fetcher: ReceiptFetch, signal: AbortSignal): Promise<InstalledArtifact> {
  const { repository, tagTemplate, asset, checksumAsset } = entry.install;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tagTemplate?.includes("{version}") || !asset || !checksumAsset || basename(asset) !== asset || basename(checksumAsset) !== checksumAsset) throw new ReceiptError("input");
  const tag = tagTemplate.replace("{version}", context.version);
  const release = await json<ReleaseMetadata>(fetcher, `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, signal, context.limits.outputBytes);
  if (release.tag_name !== tag || !Array.isArray(release.assets)) throw new ReceiptError("integrity");
  const select = (name: string) => {
    const matches = release.assets.filter((item: ReleaseAsset) => item.name === name);
    if (matches.length !== 1) throw new ReceiptError("integrity");
    return matches[0]!;
  };
  const target = select(asset), checksum = select(checksumAsset);
  const download = async (item: any, cap: number) => {
    const url = publicURL(item.url, ["api.github.com"]);
    // Follow public asset redirects only through the closed HTTPS host set.
    return bytes(fetcher, url, signal, cap);
  };
  const data = await download(target, context.limits.artifactBytes);
  const hash = createHash("sha256").update(data).digest("hex");
  if (target.digest !== `sha256:${hash}`) throw new ReceiptError("integrity");
  const lines = (await download(checksum, context.limits.outputBytes)).toString("utf8").trim().split(/\r?\n/);
  const matches = lines.filter(line => {
    const parsed = /^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/.exec(line.trim());
    return parsed && parsed[1]!.toLowerCase() === hash && (parsed[2] === asset || (lines.length === 1 && !parsed[2]));
  });
  if (matches.length !== 1) throw new ReceiptError("integrity");
  const archive = join(context.root, "verified-release.tar.gz");
  await writeFile(archive, data, { flag: "wx", mode: 0o600 });
  await mkdir(context.prefix, { recursive: true, mode: 0o700 });
  const helper = fileURLToPath(new URL("./extract-archive.py", import.meta.url));
  await run(context, signal, ["python3", helper, archive, context.prefix, String(context.limits.archiveEntries), String(context.limits.expandedBytes)], privateEnv(context), "integrity");
  const cli = COMPAT[context.id].probe[0]!;
  const candidates: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const candidate = join(dir, name), stat = await lstat(candidate);
      if (stat.isDirectory()) await walk(candidate);
      else if (!stat.isFile()) throw new ReceiptError("integrity");
      else if (name === cli && (stat.mode & 0o111)) candidates.push(candidate);
    }
  };
  await walk(context.prefix);
  if (candidates.length !== 1) throw new ReceiptError("integrity");
  return { method: entry.install.method, integrity: `sha256:${hash}`, packageRoot: context.prefix, command: [await privateCommand(context.prefix, candidates[0]!)] };
}

/** Acquire only public, exact artifacts; no native CLI is executed here. */
export async function installCompatArtifact(context: ReceiptContext, entry: ManifestEntry, fetcher: ReceiptFetch): Promise<InstalledArtifact> {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(context.version)) throw new ReceiptError("input");
  if (entry.install.method === "unavailable") throw new ReceiptError("install-unavailable");
  const timer = AbortSignal.timeout(context.limits.installMs);
  const signal = AbortSignal.any([context.signal, timer]);
  try {
    if (signal.aborted) throw new ReceiptError("timeout");
    const root = realPath(context.root);
    for (const item of [context.home, context.prefix, context.cwd]) {
      if (!isAbsolute(item) || !inside(root, realPath(item))) throw new ReceiptError("input");
    }
    if (entry.install.method === "npm-exact") return await npmArtifact(context, entry, fetcher, signal);
    if (entry.install.method === "github-release-asset-checksum") return await releaseArtifact(context, entry, fetcher, signal);
    throw new ReceiptError("install-unavailable");
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    if (signal.aborted) throw new ReceiptError("timeout");
    throw new ReceiptError("install-unavailable");
  }
}
