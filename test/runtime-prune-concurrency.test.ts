import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageCurrentRuntime, verifyPackage } from "../src/cli/recovery-package.ts";
import { realPath } from "../src/hub/project.ts";
import { recordProjectRuntime } from "../src/hub/project-runtime.ts";
import { readProjectRuntime } from "../src/hub/project-runtime-state.ts";
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from "../src/hub/registry.ts";

const VERSION = "0.99.0";
const put = (root: string, name: string, body: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
type Child = Bun.Subprocess<"ignore", "ignore", "pipe">;
interface Capture { root: string; digest: string; version: string; source: string; tag: string }
interface Verification { name: string; root: string; tag: string }

/** Package fixtures contain data only; only the copied production pruner and narrow dependency exports execute. */
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-prune-concurrency-"))), home = join(root, "hub-home");
  mkdirSync(home);
  const registry = new Registry(join(home, "registry.db"));
  let revision = 0;
  const capture = (tag: string): Capture => {
    const source = join(root, `package-${++revision}`);
    put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION, fixtureTag: tag }));
    put(source, "src/cli/main.js", "// data-only synthetic entry\n");
    put(source, "src/value.ts", `export const marker = ${JSON.stringify(tag)};\n`);
    put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
    put(source, "templates/fixture.txt", "fixture\n"); put(source, ".claude-plugin/marketplace.json", "{}\n");
    for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `synthetic ${name}\n`);
    const runtime = stageCurrentRuntime(source, VERSION, home, registry);
    utimesSync(runtime.root, 1000 + revision, 1000 + revision);
    return { ...runtime, source, tag };
  };
  const project = (name: string) => {
    const cwd = join(root, name); put(cwd, ".agenthub/config.json", "{}\n"); return registry.register(cwd);
  };
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || key.startsWith("AGENTHUB_") || key.startsWith("AMEM_") || key.startsWith("OMNIROUTE_")
    || key.startsWith("CF_ACCESS_") || /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key)) delete env[key];
  env.AGENTHUB_HOME = home; env.HOME = join(root, "home"); env.AMEM_HOME = join(root, "memory-home");
  mkdirSync(env.HOME); mkdirSync(env.AMEM_HOME);
  return { root, home, registry, capture, project, env };
}

/** Readiness is a file barrier; the deadline only bounds a broken fixture, never supplies test ordering. */
async function marker(file: string, child: Child) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(file) && child.exitCode !== null) throw new Error(`owned subprocess exited before ${basename(file)}: ${await new Response(child.stderr).text()}`);
  expect(existsSync(file), `owned subprocess missed ${basename(file)}`).toBe(true);
}

function copiedPruner(f: ReturnType<typeof fixture>, held: string, release: string, calls: string): string {
  const coordinator = join(f.root, "coordinator"), actual = (file: string) => new URL(file, import.meta.url).href;
  const module = join(coordinator, "src/hub/runtime-capture-prune.ts");
  // The production module is copied unchanged. Dependency wiring is the same narrow pattern used by capture-prune's executing-root fixture.
  put(coordinator, "src/hub/runtime-capture-prune.ts", readFileSync(new URL("../src/hub/runtime-capture-prune.ts", import.meta.url), "utf8"));
  const reexport = (file: string, names: string, dependency: string) => put(coordinator, file, `export { ${names} } from ${JSON.stringify(actual(dependency))};\n`);
  reexport("src/pi/process-signature.ts", "processLiveness", "../src/pi/process-signature.ts");
  reexport("src/hub/project.ts", "hubHome, realPath", "../src/hub/project.ts");
  reexport("src/hub/project-runtime-state.ts", "readProjectRuntime, readProjectRuntimeReference, projectRuntimeFile", "../src/hub/project-runtime-state.ts");
  reexport("src/hub/registry.ts", "Registry, REGISTRY_DB_BUSY_TIMEOUT_MS", "../src/hub/registry.ts");
  reexport("src/hub/child-process.ts", "childEnv", "../src/hub/child-process.ts");
  put(coordinator, "src/cli/recovery-package.ts", `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPackage as realVerifyPackage, verifyRecoveryTarget as realVerifyRecoveryTarget } from ${JSON.stringify(actual("../src/cli/recovery-package.ts"))};
function observe(name, root) {
 const tag = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).fixtureTag;
 appendFileSync(${JSON.stringify(calls)}, JSON.stringify({name, root, tag}) + '\\n');
 if (name === 'verifyPackage' && tag.startsWith('orphan-') && !existsSync(${JSON.stringify(held)})) {
  writeFileSync(${JSON.stringify(held)}, JSON.stringify({root, tag}), {flag:'wx'});
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Bun.sleepSync(5);
  if (!existsSync(${JSON.stringify(release)})) throw new Error('candidate verifier barrier was not released');
 }
}
export function verifyPackage(root, version, options) { observe('verifyPackage', root); return realVerifyPackage(root, version, options); }
export function verifyRecoveryTarget(kind, root, version) { observe('verifyRecoveryTarget', root); return realVerifyRecoveryTarget(kind, root, version); }
`);
  return module;
}

test("#610 candidate hashing does not starve registry publication and cannot remove a recreated original capture", async () => {
  const f = fixture(), children: Child[] = [], held = join(f.root, "verifier-held.json"), release = join(f.root, "release-verifier");
  const calls = join(f.root, "verifier-calls.jsonl"), resultFile = join(f.root, "prune-result.json"), published = join(f.root, "published.json");
  try {
    const protectedCaptures = [f.capture("protected-a"), f.capture("protected-b")];
    for (const [index, capture] of protectedCaptures.entries()) {
      const project = f.project(`protected-project-${index}`);
      recordProjectRuntime(project, { ...capture, kind: "restart" }, null, f.registry);
    }
    const orphans = [f.capture("orphan-a"), f.capture("orphan-b")];
    const newest = [f.capture("newest-a"), f.capture("newest-b"), f.capture("newest-c")];
    const originalIdentities = new Map(orphans.map(capture => [capture.tag, lstatSync(capture.root)]));
    const module = copiedPruner(f, held, release, calls), driver = join(f.root, "collector.ts");
    writeFileSync(driver, `import { writeFileSync } from 'node:fs';
import { pruneRuntimeCaptures } from ${JSON.stringify(module)};
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(pruneRuntimeCaptures(${JSON.stringify(f.home)}, 3)));
`);
    const collector = Bun.spawn([process.execPath, driver], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(collector);
    await marker(held, collector);
    const collectorErrors = new Response(collector.stderr).text();
    const observed = JSON.parse(readFileSync(held, "utf8")) as { root: string; tag: string };
    const old = orphans.find(capture => capture.tag === observed.tag);
    if (!old) throw new Error("verifier barrier did not name an orphan fixture");
    expect(basename(observed.root)).toBe("capture");
    expect(basename(dirname(observed.root))).toMatch(/^\.runtime-prune-/);
    expect(existsSync(old.root)).toBe(false);
    const oldIdentity = originalIdentities.get(old.tag)!;
    expect(lstatSync(observed.root)).toMatchObject({ dev: oldIdentity.dev, ino: oldIdentity.ino });

    const writerProject = join(f.root, "new-project"); put(writerProject, ".agenthub/config.json", "{}\n");
    const writerScript = join(f.root, "publisher.ts"), registryModule = fileURLToPath(new URL("../src/hub/registry.ts", import.meta.url));
    const packageModule = fileURLToPath(new URL("../src/cli/recovery-package.ts", import.meta.url));
    const runtimeModule = fileURLToPath(new URL("../src/hub/project-runtime.ts", import.meta.url));
    const stateModule = fileURLToPath(new URL("../src/hub/project-runtime-state.ts", import.meta.url));
    writeFileSync(writerScript, `import { writeFileSync } from 'node:fs';
import { Registry, REGISTRY_DB_BUSY_TIMEOUT_MS } from ${JSON.stringify(registryModule)};
import { stageCurrentRuntime } from ${JSON.stringify(packageModule)};
import { recordProjectRuntime } from ${JSON.stringify(runtimeModule)};
import { createProjectRuntimeAccess } from ${JSON.stringify(stateModule)};
const registry = new Registry(${JSON.stringify(join(f.home, "registry.db"))});
try {
 const project = registry.register(${JSON.stringify(writerProject)}), access = createProjectRuntimeAccess(project);
 registry.runtimeCaptureLocked(() => {
  const capture = stageCurrentRuntime(${JSON.stringify(old.source)}, ${JSON.stringify(VERSION)}, ${JSON.stringify(f.home)}, registry);
  recordProjectRuntime(project, {...capture, kind:'restart'}, null, registry, access);
  writeFileSync(${JSON.stringify(published)}, JSON.stringify({project, capture, busyTimeout:REGISTRY_DB_BUSY_TIMEOUT_MS}));
 });
} finally { registry.close(); }
`);
    const writer = Bun.spawn([process.execPath, writerScript], { env: f.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); children.push(writer);
    const completed = await Promise.race([
      writer.exited.then(code => ({ code, stderr: new Response(writer.stderr).text() })),
      collector.exited.then(async () => { throw new Error(`collector exited before verifier release: ${await collectorErrors}`); }),
    ]);
    expect(completed.code, await completed.stderr).toBe(0);
    // A contended writer would fail at Registry's existing busy timeout. It must succeed while hashing is still blocked, with no extended budget.
    expect(collector.exitCode).toBeNull(); expect(existsSync(release)).toBe(false);
    expect(existsSync(resultFile)).toBe(false);
    const publication = JSON.parse(readFileSync(published, "utf8")) as { project: Parameters<typeof readProjectRuntime>[0]; capture: {root:string;digest:string}; busyTimeout:number };
    expect(publication.busyTimeout).toBe(REGISTRY_DB_BUSY_TIMEOUT_MS);
    expect(publication.capture).toMatchObject({ root: old.root, digest: old.digest });
    expect(readProjectRuntime(publication.project)?.root).toBe(old.root);
    expect(lstatSync(old.root).ino).not.toBe(oldIdentity.ino);

    writeFileSync(release, "verify now\n");
    expect(await collector.exited, await collectorErrors).toBe(0);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as { removed: string[]; kept: string[]; deferred?: string };
    expect(result.deferred).toBeUndefined();
    expect(result.removed).toContain(old.root);
    expect(existsSync(observed.root)).toBe(false);
    expect(existsSync(dirname(observed.root))).toBe(false);
    expect(existsSync(old.root)).toBe(true);
    expect(verifyPackage(old.root, VERSION, { ownDependencies: true })).toBe(old.digest);
    for (const capture of [...protectedCaptures, ...newest]) {
      expect(result.kept).toContain(capture.root); expect(existsSync(capture.root)).toBe(true);
    }
    const verified = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as Verification);
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every(row => row.name === "verifyPackage" && row.tag.startsWith("orphan-"))).toBe(true);
    expect(verified.some(row => [...protectedCaptures, ...newest].some(capture => capture.tag === row.tag))).toBe(false);
  } finally {
    writeFileSync(release, "release owned verifier\n");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited));
    f.registry.close(); rmSync(f.root, { recursive: true, force: true });
  }
}, 20_000);
