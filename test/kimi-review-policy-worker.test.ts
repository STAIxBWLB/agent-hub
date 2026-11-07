import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { checkKimiReviewPolicy, kimiReviewFingerprint, projectKimiReviewPolicyBinding, type KimiReviewPolicyBinding } from "../src/adapters/kimi-review-policy.ts";
import { startKimiReviewPolicyWatch, type KimiReviewPolicyFactory } from "../src/adapters/kimi-review-policy-worker.ts";
import { prepareKimiReviewer } from "../src/adapters/kimi-review.ts";
import type { ReviewerPolicyProbe } from "../src/adapters/reviewer-policy-watch.ts";
import type { ReviewerPrepareContext } from "../src/adapters/reviewer-print.ts";

const drops: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const drop of drops.splice(0).reverse()) await drop(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-policy-worker-")));
  drops.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "native"), tool = join(root, "private"), cwd = join(root, "workspace");
  for (const directory of [source, tool, cwd, join(source, "credentials"), join(source, "oauth")]) mkdirSync(directory);
  writeFileSync(join(source, "device_id"), "synthetic-device");
  writeFileSync(join(source, "config.toml"), "synthetic-source-config");
  const authTargets = ["credentials", "oauth", "device_id"].map(name => join(source, name));
  for (const [index, name] of ["credentials", "oauth", "device_id"].entries()) symlinkSync(authTargets[index]!, join(tool, name), index < 2 ? "dir" : "file");
  const files = [join(tool, "config.toml"), join(tool, "mcp.json"), join(cwd, "reviewer.md")];
  for (const file of files) writeFileSync(file, "SYNTHETIC-PRIVATE-CONTENT");
  const timestamp = new Date("2026-11-07T00:00:00Z");
  for (const file of [join(source, "config.toml"), ...files]) utimesSync(file, timestamp, timestamp);
  const executable = join(root, "native-command"); writeFileSync(executable, "synthetic-binary");
  const stat = lstatSync(executable);
  const binding = projectKimiReviewPolicyBinding({ lexicalCwd: cwd, physicalCwd: cwd, sourcePath: source, source,
    sourceConfig: join(source, "config.toml"), sourceConfigHash: kimiReviewFingerprint(readFileSync(join(source, "config.toml"), "utf8")),
    executable, executableStat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
    privateFiles: files.map(path => ({ path, hash: kimiReviewFingerprint(readFileSync(path, "utf8")) })), tool, authTargets });
  const watch = (value: KimiReviewPolicyBinding = binding, gate?: SharedArrayBuffer) => {
    const probe = startKimiReviewPolicyWatch(value, gate ? { gate } : {}); drops.push(() => probe.stop()); return probe;
  };
  return { root, source, tool, cwd, executable, files, binding, watch };
}
async function entered(gate: Int32Array): Promise<void> {
  if (Atomics.load(gate, 0) === 0) {
    const wait = Atomics.waitAsync(gate, 0, 0);
    if (wait.async) await wait.value;
  }
  expect(Atomics.load(gate, 0)).toBe(1);
}

async function preparedFixture(factory?: KimiReviewPolicyFactory) {
  const f = fixture(), old = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = f.source;
  drops.push(() => { if (old === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = old; });
  writeFileSync(join(f.source, "config.toml"), 'default_model="fixture"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\n[models.fixture]\nprovider="managed:kimi-code"\nmodel="fixture"\n');
  const fake = join(f.root, "version.ts"); writeFileSync(fake, 'console.log("2.3.0");');
  const cancellation = new AbortController();
  const context: ReviewerPrepareContext = { peer: "kimi-review", cwd: f.cwd, sessionId: "fixture-session", task: 7,
    mcpConfig: JSON.stringify({ mcpServers: { "agent-hub": { transport: "http", url: "http://127.0.0.1:12345/mcp", headers: { Authorization: "Bearer SYNTHETIC-MCP-TOKEN" } } } }),
    systemPrompt: "SYNTHETIC-SYSTEM-TEXT", input: "SYNTHETIC-TASK-TEXT", privatePaths: [], command: [process.execPath, fake], signal: cancellation.signal };
  const launch = await prepareKimiReviewer(context, factory);
  if ("unavailable" in launch) throw new Error("synthetic reviewer preparation failed");
  drops.push(() => launch.cleanup?.());
  return { ...f, launch, context, cancellation };
}

test("actual Kimi policy worker uses an empty env and only a closed immutable binding", async () => {
  const f = fixture(), before = process.env.KIMI_POLICY_SECRET_SENTINEL;
  process.env.KIMI_POLICY_SECRET_SENTINEL = "MUST-NOT-INHERIT";
  drops.push(() => { if (before === undefined) delete process.env.KIMI_POLICY_SECRET_SENTINEL; else process.env.KIMI_POLICY_SECRET_SENTINEL = before; });
  const hostile = Object.assign({}, f.binding, { input: "TASK-TEXT-MUST-NOT-CROSS", env: { SECRET: "MUST-NOT-CROSS" },
    privateFiles: f.binding.privateFiles.map(file => Object.assign({}, file, { input: "PRIVATE-TEXT-MUST-NOT-CROSS" })),
    executableStat: Object.assign({}, f.binding.executableStat, { input: "EXTRA-TEXT-MUST-NOT-CROSS" }) });
  const projected = projectKimiReviewPolicyBinding(hostile);
  const encoded = JSON.stringify(projected);
  expect(encoded).not.toContain("MUST-NOT-CROSS"); expect(encoded).not.toContain("SYNTHETIC-PRIVATE-CONTENT");
  expect(Object.isFrozen(projected)).toBe(true); expect(Object.isFrozen(projected.privateFiles)).toBe(true);
  expect(Object.isFrozen(projected.privateFiles[0])).toBe(true); expect(Object.isFrozen(projected.executableStat)).toBe(true);
  // An accidental structuredClone of arbitrary input would invoke this getter and fail.
  Object.defineProperty(hostile, "extra", { enumerable: true, get() { throw new Error("extra fields must not be serialized"); } });
  const worker = f.watch(hostile);
  expect(await worker.check()).toBe(true); expect(await worker.check()).toBe(true);
});

for (const marker of [".git", ".kimi-code", "AGENTS.md"]) test(`worker and synchronous fence refuse added cwd ancestor ${marker}`, async () => {
  const f = fixture(), worker = f.watch(); expect(await worker.check()).toBe(true);
  writeFileSync(join(f.root, marker), "synthetic-ambient");
  expect(checkKimiReviewPolicy(f.binding)).toBe(false); expect(await worker.check()).toBe(false);
});

test("worker checks the lexical ancestor even when the physical cwd remains clean", async () => {
  const f = fixture(), lexical = join(f.root, "alias-parent"); mkdirSync(lexical);
  const alias = join(lexical, "workspace"); symlinkSync(f.cwd, alias, "dir");
  const binding = projectKimiReviewPolicyBinding({ ...f.binding, lexicalCwd: alias });
  const worker = f.watch(binding); expect(await worker.check()).toBe(true);
  writeFileSync(join(lexical, "AGENTS.md"), "synthetic-ambient");
  expect(checkKimiReviewPolicy(binding)).toBe(false); expect(await worker.check()).toBe(false);
});

test("worker and synchronous fence reject native executable replacement", async () => {
  const f = fixture(), worker = f.watch(); expect(await worker.check()).toBe(true);
  renameSync(f.executable, `${f.executable}.old`); writeFileSync(f.executable, "synthetic-binary");
  expect(checkKimiReviewPolicy(f.binding)).toBe(false); expect(await worker.check()).toBe(false);
});

for (const index of [0, 1, 2, 3]) test(`worker full hash catches equal-size restored-mtime content tampering in file ${index}`, async () => {
  const f = fixture(), worker = f.watch(); expect(await worker.check()).toBe(true);
  const file = index === 0 ? f.binding.sourceConfig : f.files[index - 1]!;
  const original = readFileSync(file, "utf8"), stat = lstatSync(file);
  writeFileSync(file, `X${original.slice(1)}`); utimesSync(file, stat.atime, stat.mtime);
  expect(lstatSync(file).size).toBe(stat.size); expect(lstatSync(file).mtimeMs).toBeCloseTo(stat.mtimeMs, 2);
  expect(checkKimiReviewPolicy(f.binding)).toBe(false); expect(await worker.check()).toBe(false);
});

for (const name of ["credentials", "oauth", "device_id"]) for (const side of ["native", "private"]) test(`worker fences ${side} ${name} auth target changes`, async () => {
  const f = fixture(), worker = f.watch(); expect(await worker.check()).toBe(true);
  const target = join(f.root, `replacement-${name}`);
  if (name === "device_id") writeFileSync(target, "new-device"); else mkdirSync(target);
  const changed = join(side === "native" ? f.source : f.tool, name);
  if (side === "native") renameSync(changed, `${changed}.old`); else unlinkSync(changed);
  symlinkSync(target, changed, name === "device_id" ? "file" : "dir");
  expect(checkKimiReviewPolicy(f.binding)).toBe(false); expect(await worker.check()).toBe(false);
});

test("native OAuth atomic refresh within the bound directory does not invalidate the worker", async () => {
  const f = fixture(), worker = f.watch(); expect(await worker.check()).toBe(true);
  const token = join(f.source, "oauth", "kimi-code"), next = `${token}.next`;
  writeFileSync(token, "synthetic-old-token"); writeFileSync(next, "synthetic-refreshed-token"); renameSync(next, token);
  expect(checkKimiReviewPolicy(f.binding)).toBe(true); expect(await worker.check()).toBe(true);
});

test("one in-flight worker check is bounded and overlap fails closed", async () => {
  const f = fixture(), shared = new SharedArrayBuffer(8), gate = new Int32Array(shared), worker = f.watch(f.binding, shared);
  const pending = worker.check(); await entered(gate);
  const failure = worker.failure; expect(failure).toBeDefined();
  expect(await worker.check()).toBe(false); expect(await pending).toBe(false);
  await failure; expect(await worker.check()).toBe(false);
  await worker.stop(); expect(Atomics.load(gate, 0)).toBe(1);
});

test("stop joins a real worker blocked in its fixture gate and settles its pending check false", async () => {
  const f = fixture(), shared = new SharedArrayBuffer(8), gate = new Int32Array(shared), worker = f.watch(f.binding, shared);
  const pending = worker.check(); await entered(gate);
  const stop = worker.stop(); expect(worker.stop()).toBe(stop);
  expect(await pending).toBe(false); await stop; expect(worker.stop()).toBe(stop);
  expect(await worker.check()).toBe(false); expect(Atomics.load(gate, 0)).toBe(1);
});

test("a released fixture gate still runs the actual full policy checker", async () => {
  const f = fixture(), shared = new SharedArrayBuffer(8), gate = new Int32Array(shared), worker = f.watch(f.binding, shared);
  const pending = worker.check(); await entered(gate);
  writeFileSync(f.files[2]!, "TAMPERED-PRIVATE-CONTENT");
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  expect(await pending).toBe(false);
});

test("trusted policy factory receives no task text and cannot mutate synchronous authority expectations", async () => {
  let observed = false;
  const probe: ReviewerPolicyProbe = { check: async () => true, stop: async () => {} };
  const { launch } = await preparedFixture(binding => {
    observed = true;
    expect(JSON.stringify(binding)).not.toContain("SYNTHETIC-TASK-TEXT"); expect(JSON.stringify(binding)).not.toContain("SYNTHETIC-SYSTEM-TEXT");
    expect(JSON.stringify(binding)).not.toContain("SYNTHETIC-MCP-TOKEN");
    expect(Reflect.set(binding, "sourceConfigHash", "mutated")).toBe(false);
    expect(Reflect.set(binding.privateFiles[0]!, "hash", "mutated")).toBe(false);
    return probe;
  });
  expect(launch.current?.()).toBe(true);
  const wrapped = launch.startPolicyWatch?.(); expect(wrapped).toBeDefined(); expect(launch.startPolicyWatch?.()).toBe(wrapped);
  expect(await wrapped?.check()).toBe(true); expect(observed).toBe(true);
  expect(launch.current?.()).toBe(true);
  await launch.cleanup?.(); expect(launch.current?.()).toBe(false); expect(() => launch.startPolicyWatch?.()).toThrow();
});


test("parent abort fences an already pending real worker result without weakening its filesystem check", async () => {
  const shared = new SharedArrayBuffer(8), gate = new Int32Array(shared);
  const { launch, cancellation } = await preparedFixture(binding => startKimiReviewPolicyWatch(binding, { gate: shared }));
  const probe = launch.startPolicyWatch!(), pending = probe.check(); await entered(gate);
  cancellation.abort();
  Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
  expect(await pending).toBe(false); expect(await probe.check()).toBe(false); expect(launch.current?.()).toBe(false);
});

test("cleanup joins a blocked real policy worker before removing its private profile", async () => {
  const shared = new SharedArrayBuffer(8), gate = new Int32Array(shared);
  const { launch } = await preparedFixture(binding => startKimiReviewPolicyWatch(binding, { gate: shared }));
  const probe = launch.startPolicyWatch!(), pending = probe.check(); await entered(gate);
  const cleanup = launch.cleanup!();
  expect(existsSync(launch.cwd!)).toBe(true); expect(await pending).toBe(false);
  await cleanup; expect(existsSync(launch.cwd!)).toBe(false); expect(await probe.check()).toBe(false);
});

test("a failed policy worker join preserves the profile and supports explicit cleanup retry", async () => {
  let stops = 0;
  const { launch } = await preparedFixture(() => ({ check: async () => true, stop: async () => { if (++stops === 1) throw new Error("synthetic unconfirmed join"); } }));
  launch.startPolicyWatch!();
  await expect(Promise.resolve(launch.cleanup!())).rejects.toThrow("synthetic unconfirmed join");
  expect(existsSync(launch.cwd!)).toBe(true); expect(launch.current?.()).toBe(true); expect(stops).toBe(1);
  await launch.cleanup!(); expect(stops).toBe(2); expect(existsSync(launch.cwd!)).toBe(false); expect(launch.current?.()).toBe(false);
});

test("cleanup without a started policy probe remains synchronous", async () => {
  const { launch } = await preparedFixture(() => { throw new Error("unused factory must not start"); });
  expect(launch.cleanup!()).toBeUndefined(); expect(existsSync(launch.cwd!)).toBe(false);
});


test("the default factory forwards a real worker's immediate policy failure signal", async () => {
  const { launch } = await preparedFixture();
  const probe = launch.startPolicyWatch!(), failure = probe.failure;
  expect(failure).toBeDefined(); expect(await probe.check()).toBe(true);
  writeFileSync(launch.args[launch.args.indexOf("--agent-file") + 1]!, "synthetic-policy-tamper");
  expect(await probe.check()).toBe(false);
  await failure;
  await probe.stop();
});
