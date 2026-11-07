import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { RECEIPT_OUTPUT_MS } from "../scripts/compat-receipts/output.ts";
import { installCompatArtifact } from "../scripts/compat-receipts/install.ts";
import { ReceiptError, type ReceiptContext, type ManifestEntry, type ReceiptCommand, type ReceiptFetch } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry: ManifestEntry = { receipt: "fixture", runnerOS: ["linux"], nativePlatform: "fixture", autoAdmit: false, install: { method: "npm-exact", package: "@openai/codex" }, legs: [] };
async function fixture(run: ReceiptCommand): Promise<ReceiptContext> {
  const root = await mkdtemp(join(tmpdir(), "compat-installer-")); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "cwd");
  for (const dir of [home, prefix, cwd]) await mkdir(dir);
  return { id: "codex-review", version: "0.167.0", root, home, prefix, cwd, env: { PATH: "/usr/bin:/bin", HOME: "/forbidden", npm_config_userconfig: "/forbidden", NPM_TOKEN: "forbidden" }, signal: new AbortController().signal,
    limits: { totalMs: 5000, installMs: 3000, legMs: 1000, outputBytes: 65536, artifactBytes: 65536, expandedBytes: 65536, archiveEntries: 32 }, run };
}
function npmFetch(data: Buffer, overrides: Record<string, unknown> = {}): ReceiptFetch {
  const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  return (async (url: any) => String(url).endsWith("/0.167.0")
    ? Response.json({ name: "@openai/codex", version: "0.167.0", dist: { integrity, tarball: "https://registry.npmjs.org/codex.tgz" }, ...overrides })
    : new Response(data)) as ReceiptFetch;
}
const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false, ownedStopConfirmed: true, processCleanup: "proven" as const, processCleanupReason: "trusted fake runner lifetime ended" };
test("wrong SRI refuses before any file or npm effect", async () => {
  let effects = 0;
  const context = await fixture(async () => { effects++; return ok; });
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package"), { dist: { integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, tarball: "https://registry.npmjs.org/codex.tgz" } }))).rejects.toMatchObject({ causeCode: "integrity" });
  expect(effects).toBe(0);
  expect((await readdir(context.root)).sort()).toEqual(["cwd", "home", "prefix"]);
});
for (const processCleanup of ["proven", "unproven"] as const) {
  test(`exact private npm install verifies bytes with ${processCleanup} runner lifetime`, async () => {
   let context: ReceiptContext;
   context = await fixture(async (argv, options) => {
     expect(argv[0]).toBe("npm"); expect(argv).not.toContain("--ignore-scripts");
     expect(argv).toContain(context.prefix);
     expect(argv.at(-1)).toBe(join(context.root, "verified-package.tgz"));
     expect(options.env.HOME).toBe(context.home); expect(options.env.NPM_TOKEN).toBeUndefined();
     expect(options.env.npm_config_userconfig).toBe(join(context.root, "empty-user.npmrc"));
     expect(options.env.npm_config_globalconfig).toBe(join(context.root, "empty-global.npmrc"));
     expect(options.env.npm_config_cache).toBe(join(context.root, "npm-cache"));
     const packageRoot = join(context.prefix, "node_modules", "@openai", "codex");
     await mkdir(packageRoot, { recursive: true }); await mkdir(join(context.prefix, "node_modules", ".bin"));
     await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: context.version, bin: { codex: "cli.js" } }));
     await writeFile(join(packageRoot, "cli.js"), "fixture", { mode: 0o700 });
     await symlink("../@openai/codex/cli.js", join(context.prefix, "node_modules", ".bin", "codex"));
     return { ...ok, processCleanup, processCleanupReason: processCleanup === "proven" ? "trusted fake runner lifetime ended" : "owned group stopped; lifetime not attested" };
   });
   const result = await installCompatArtifact(context, entry, npmFetch(Buffer.from("package")));
   expect(result.command).toEqual([join(context.prefix, "node_modules", "@openai", "codex", "cli.js")]);
   expect(result.integrity.startsWith("sha512-")).toBe(true);
 });
}

test("metadata exact-version mismatch never invokes npm", async () => {
  let effects = 0; const context = await fixture(async () => { effects++; return ok; });
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package"), { version: "0.167.1" }))).rejects.toBeInstanceOf(ReceiptError);
  expect(effects).toBe(0);
});
test("installed package version mismatch refuses even after successful npm exit", async () => {
  let context: ReceiptContext;
  context = await fixture(async () => {
    const target = join(context.prefix, "node_modules", "@openai", "codex"); await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.167.1" })); return ok;
  });
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package")))).rejects.toMatchObject({ causeCode: "integrity" });
});

// Minimal tar fixtures are bytes, never an external archive or native package install.
function tarMember(name: string, type = "0"): Buffer {
  const header = Buffer.alloc(512); header.write(name); header.write("0000700\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(type === "5" ? "00000000000\0" : "00000000001\0", 124); header.fill(32, 148, 156); header.write(type, 156); if (type === "2") header.write("outside", 157);
  header.write("ustar\0", 257); header.write("00", 263);
  const checksum = header.reduce((sum, value) => sum + value, 0); header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return type === "5" ? header : Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511)]);
}
function archive(name: string, type = "0"): Buffer {
  return gzipSync(Buffer.concat([tarMember(name, type), Buffer.alloc(1024)]));
}
async function releaseFixture(data: Buffer): Promise<{ context: ReceiptContext; releaseEntry: ManifestEntry; fetcher: ReceiptFetch }> {
  const context = await fixture(async (argv, options) => {
    const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ...ok, stdout, stderr, exitCode };
  });
  context.id = "jcode";
  // GHA 42361191648 cold maximum: 2032.190 ms; prior complete CI: 3835.40 ms
  // (the next archive took 454.92 ms in run 42355168440).
  // Reuse one measured helper allowance only for archive fixtures. Generic npm
  // and explicit timeout-control budgets retain their original values.
  context.limits.totalMs = RECEIPT_OUTPUT_MS / 2;
  context.limits.installMs = context.limits.totalMs;
  const hash = createHash("sha256").update(data).digest("hex");
  const releaseEntry = { ...entry, install: { method: "github-release-asset-checksum", repository: "owner/project", tagTemplate: "v{version}", asset: "cli.tar.gz", checksumAsset: "SHA256SUMS" } };
  const fetcher = (async (url: any) => {
    if (String(url).includes("/releases/tags/")) return Response.json({ tag_name: `v${context.version}`, assets: [{ name: "cli.tar.gz", digest: `sha256:${hash}`, url: "https://api.github.com/asset" }, { name: "SHA256SUMS", url: "https://api.github.com/sums" }] });
    return new Response(String(url).endsWith("/sums") ? `${hash}  cli.tar.gz\n` : data);
  }) as ReceiptFetch;
  return { context, releaseEntry, fetcher };
}
for (const [name, type] of [["../escape", "0"], ["/escape", "0"], ["jcode", "2"]]) {
  test(`archive rejects unsafe member ${name} type ${type}`, async () => {
    const { context, releaseEntry, fetcher } = await releaseFixture(archive(name!, type));
    await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
    expect(await readdir(context.prefix)).toEqual([]);
  });
}
test("verified safe archive returns its unique executable", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("dist/jcode"));
  const installed = await installCompatArtifact(context, releaseEntry, fetcher);
  expect(installed.command).toEqual([join(context.prefix, "dist", "jcode")]);
});
test("release metadata negotiates JSON while archive and checksum requests negotiate binary bytes", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("dist/jcode"));
  const seen: string[] = [];
  const strict = (async (...args: Parameters<ReceiptFetch>) => {
    const [url, init] = args;
    const metadata = String(url).includes("/releases/tags/");
    const accept = new Headers(init?.headers).get("accept");
    seen.push(`${metadata ? "metadata" : "asset"}:${accept}`);
    if (accept !== (metadata ? "application/json" : "application/octet-stream")) return new Response(null, { status: 415 });
    return fetcher(...args);
  }) as ReceiptFetch;
  const installed = await installCompatArtifact(context, releaseEntry, strict);
  expect(installed.command).toEqual([join(context.prefix, "dist", "jcode")]);
  expect(seen).toEqual(["metadata:application/json", "asset:application/octet-stream", "asset:application/octet-stream"]);
});
test("release recipe selects its unique platform-qualified executable without rewriting it", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("dist/jcode-linux-x86_64"));
  const installed = await installCompatArtifact(context, { ...releaseEntry, install: { ...releaseEntry.install, executable: "jcode-linux-x86_64" } }, fetcher);
  expect(installed.command).toEqual([join(context.prefix, "dist", "jcode-linux-x86_64")]);
});
for (const executable of ["../jcode", "/jcode", "dir/jcode", "jcode\\escape", "", "."]) {
  test(`unsafe release executable selector ${JSON.stringify(executable)} refuses before effects`, async () => {
    const { context, releaseEntry } = await releaseFixture(archive("jcode"));
    let fetched = false;
    const fetcher = (async () => { fetched = true; throw new Error("must not fetch"); }) as ReceiptFetch;
    await expect(installCompatArtifact(context, { ...releaseEntry, install: { ...releaseEntry.install, executable } }, fetcher)).rejects.toMatchObject({ causeCode: "input" });
    expect(fetched).toBe(false);
    expect((await readdir(context.root)).sort()).toEqual(["cwd", "home", "prefix"]);
  });
}
test("archive expanded-byte ceiling refuses before writes", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("jcode")); context.limits.expandedBytes = 0;
  await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(await readdir(context.prefix)).toEqual([]);
});
test("archive entry ceiling refuses before writes", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("jcode")); context.limits.archiveEntries = 0;
  await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(await readdir(context.prefix)).toEqual([]);
});
test("download byte ceiling refuses before npm", async () => {
  let effects = 0; const context = await fixture(async () => { effects++; return ok; }); context.limits.artifactBytes = 1;
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package")))).rejects.toMatchObject({ causeCode: "integrity" });
  expect(effects).toBe(0);
});
test("owned command cleanup failure cannot produce an installed artifact", async () => {
  const context = await fixture(async () => ({ ...ok, ownedStopConfirmed: false }));
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package")))).rejects.toMatchObject({ causeCode: "cleanup" });
});
test("timed out install reports closed timeout cause", async () => {
  const context = await fixture(async () => ({ ...ok, timedOut: true }));
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package")))).rejects.toMatchObject({ causeCode: "timeout" });
});
test("nonpublic install recipe refuses without fetch or command", async () => {
  let effects = 0; const context = await fixture(async () => { effects++; return ok; });
  const fetcher = (async () => { effects++; return new Response(); }) as ReceiptFetch;
  await expect(installCompatArtifact(context, { ...entry, install: { method: "unavailable" } }, fetcher)).rejects.toMatchObject({ causeCode: "install-unavailable" });
  expect(effects).toBe(0);
});

for (const rootName of [".", "./"]) {
  test(`archive permits ${rootName} root directory with unique CLI`, async () => {
    const data = gzipSync(Buffer.concat([tarMember(rootName, "5"), tarMember("./jcode"), Buffer.alloc(1024)]));
    const { context, releaseEntry, fetcher } = await releaseFixture(data);
    const installed = await installCompatArtifact(context, releaseEntry, fetcher);
    expect(installed.command).toEqual([join(context.prefix, "jcode")]);
  });
}
test("archive root directory still counts against entry ceiling", async () => {
  const data = gzipSync(Buffer.concat([tarMember(".", "5"), tarMember("jcode"), Buffer.alloc(1024)]));
  const { context, releaseEntry, fetcher } = await releaseFixture(data); context.limits.archiveEntries = 1;
  await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(await readdir(context.prefix)).toEqual([]);
});
test("archive duplicate normalized root directories refuse before writes", async () => {
  const data = gzipSync(Buffer.concat([tarMember(".", "5"), tarMember("./", "5"), tarMember("jcode"), Buffer.alloc(1024)]));
  const { context, releaseEntry, fetcher } = await releaseFixture(data);
  await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(await readdir(context.prefix)).toEqual([]);
});
test("archive root regular file remains refused", async () => {
  const { context, releaseEntry, fetcher } = await releaseFixture(archive("."));
  await expect(installCompatArtifact(context, releaseEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(await readdir(context.prefix)).toEqual([]);
});

test("detected survivor cannot produce an installed artifact", async () => {
  const context = await fixture(async () => ({ ...ok, survivorDetected: true }));
  await expect(installCompatArtifact(context, entry, npmFetch(Buffer.from("package")))).rejects.toMatchObject({ causeCode: "cleanup" });
});

test("malformed artifact URL is integrity failure before effects", async () => {
  let effects = 0;
  const context = await fixture(async () => { effects++; return ok; });
  const fetcher = npmFetch(Buffer.from("package"), { dist: { tarball: "malformed URL", integrity: "unused" } });
  await expect(installCompatArtifact(context, entry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
  expect(effects).toBe(0);
  expect((await readdir(context.root)).sort()).toEqual(["cwd", "home", "prefix"]);
});
for (const method of ["npm-exact", "github-release-asset-checksum"]) {
  test(`null ${method} metadata is integrity failure before effects`, async () => {
    let effects = 0;
    const context = await fixture(async () => { effects++; return ok; });
    const metadataEntry = method === "npm-exact" ? entry : { ...entry, install: { method, repository: "owner/project", tagTemplate: "v{version}", asset: "cli.tar.gz", checksumAsset: "SHA256SUMS" } };
    const fetcher = (async () => Response.json(null)) as ReceiptFetch;
    await expect(installCompatArtifact(context, metadataEntry, fetcher)).rejects.toMatchObject({ causeCode: "integrity" });
    expect(effects).toBe(0);
    expect((await readdir(context.root)).sort()).toEqual(["cwd", "home", "prefix"]);
  });
}
