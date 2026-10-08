import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { realPath } from "../src/hub/project.ts";

export interface Seed { id: string; file: string; search: string; replacement: string; testFile: string; testName: string }
const safe = (path: string) => !!path && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === ".git") && !path.includes("\\");
export function readSeeds(text: string): Seed[] {
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || !Array.isArray(value.seeds) || !value.seeds.length) throw new Error("invalid seed manifest");
  const ids = new Set<string>();
  for (const seed of value.seeds) {
    if (!seed || !["id", "file", "search", "replacement", "testFile", "testName"].every((key) => typeof seed[key] === "string" && seed[key].length > 0) || !/^[a-z0-9-]+$/.test(seed.id) || ids.has(seed.id) || !safe(seed.file) || !safe(seed.testFile) || seed.search === seed.replacement) throw new Error("invalid or duplicate seed entry");
    ids.add(seed.id);
  }
  return value.seeds;
}
export function applySeed(text: string, seed: Pick<Seed, "search" | "replacement">): string {
  const matches = text.split(seed.search).length - 1;
  if (matches !== 1) throw new Error(`seed rot: expected one exact source match, found ${matches}`);
  return text.replace(seed.search, () => seed.replacement);
}
export function copyTracked(root: string, destination: string): void {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) throw new Error("cannot enumerate tracked checkout content");
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (!safe(path)) throw new Error(`unsafe tracked path: ${path}`);
    if (path.split("/").some((part) => ["node_modules", ".agenthub", ".worktrees", "state", "dist", "coverage", "output", "outputs"].includes(part))) continue;
    const source = join(root, path);
    if (!existsSync(source)) throw new Error(`tracked file missing: ${path}`);
    if (!lstatSync(source).isFile()) throw new Error(`tracked file is not regular: ${path}`);
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(source, join(destination, path));
  }
  const modules = join(root, "node_modules");
  if (existsSync(modules)) symlinkSync(realPath(modules), join(destination, "node_modules"), "dir");
}
export function classifyRun(output: string, code: number | null, name: string, seeded: boolean): "green" | "detected" {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (/timed out|timeout|check: pid .*still running|SyntaxError|Cannot find module|ModuleNotFound|error: (?!expect\()/im.test(text)) throw new Error("invalid detection: setup, compiler or timeout failure");
  const records = [...text.matchAll(/^\((pass|fail)\) (.+?)(?: \[[^\]]+\])?\r?$/gm)];
  const expected = records.filter((m) => m[2] === name);
  if (expected.length !== 1 || records.length !== 1) throw new Error("invalid detection: named test missing or unrelated test result");
  const verdict = expected[0]![1];
  if (!seeded) {
    if (code !== 0 || verdict !== "pass") throw new Error("unmodified named test is not green");
    return "green";
  }
  if (code === 0 && verdict === "pass") throw new Error("surviving seed: the named test still passes");
  if (code !== 1 || verdict !== "fail" || !/^error: expect\(/m.test(text) || !/^\s*1 fail\s*$/m.test(text)) throw new Error("invalid detection: failure is not the named assertion");
  return "detected";
}

function childEnvironment(home: string, runRoot: string, ledger: string, checkout: string): Record<string, string> {
  // Native tests get a private HOME and registry; no gateway credentials, auth state or recovery authority.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: runRoot, LANG: "C.UTF-8", LC_ALL: "C", TZ: "UTC", TERM: "dumb", NO_COLOR: "1", CI: "true", AGENTHUB_HOME: join(home, ".agenthub"), AHUB_CHECK_RUN_ROOT: dirname(checkout), AHUB_CHECK_PROCESS_LEDGER: ledger, BUN_OPTIONS: `--preload=${join(checkout, "scripts/record-test-process.mjs")}` };
}
async function boundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 70_000);
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      output += decoder.decode(item.value, { stream: true });
      if (output.length > 2_000_000) { await reader.cancel(); return `${output.slice(0, 2_000_000)}\nerror: seed output limit exceeded\n`; }
    }
    return `${output}${decoder.decode()}${expired ? "\nseed output collection timed out\n" : ""}`;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
async function runNamed(checkout: string, seed: Seed, runRoot: string, phase: string): Promise<{ output: string; code: number }> {
  const phaseRoot = join(runRoot, phase); mkdirSync(phaseRoot);
  const home = join(phaseRoot, "home"); mkdirSync(home);
  const ledger = join(phaseRoot, "owned-processes.jsonl"); writeFileSync(ledger, "");
  const env = childEnvironment(home, phaseRoot, ledger, checkout);
  const pattern = `^${seed.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const child = Bun.spawn([process.execPath, "test", seed.testFile, "--test-name-pattern", pattern, "--timeout", "20000"], { cwd: checkout, env, stdout: "pipe", stderr: "pipe" });
  const watch = Bun.spawn(["bash", join(checkout, "scripts/hang-watch.sh"), String(child.pid), "60"], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([boundedOutput(child.stdout), boundedOutput(child.stderr), child.exited]);
  watch.kill("SIGTERM");
  const [watchOut, watchErr] = await Promise.all([boundedOutput(watch.stdout), boundedOutput(watch.stderr), watch.exited]);
  const output = `${stdout}${stderr}${watchOut}${watchErr}`;
  writeFileSync(join(phaseRoot, "test-output.txt"), output);
  const leaks = Bun.spawn(["node", join(checkout, "scripts/check-owned-processes.mjs"), dirname(checkout), ledger], { cwd: checkout, env, stdout: "pipe", stderr: "pipe" });
  const [leakOut, leakErr, leakCode] = await Promise.all([boundedOutput(leaks.stdout), boundedOutput(leaks.stderr), leaks.exited]);
  writeFileSync(join(phaseRoot, "leaks.txt"), `${leakOut}${leakErr}`);
  if (leakCode !== 0) throw new Error(`owned-process check failed: ${leakOut}${leakErr}`);
  if (watchOut || watchErr || code > 1) throw new Error("invalid detection: watchdog or abnormal test termination");
  return { output, code };
}
export async function seededCheck(root: string): Promise<void> {
  const start = performance.now();
  const seeds = readSeeds(readFileSync(join(root, "scripts/seeds.json"), "utf8"));
  for (const seed of seeds) {
    const seedStart = performance.now();
    const own = realPath(mkdtempSync(join(tmpdir(), `ahub-seed-${seed.id}-`)));
    const checkout = join(own, "checkout"); mkdirSync(checkout);
    try {
      copyTracked(root, checkout);
      const source = join(checkout, seed.file);
      if (!source.startsWith(`${checkout}${sep}`)) throw new Error("seed path escapes private checkout");
      const original = readFileSync(source, "utf8");
      const changed = applySeed(original, seed); // rot is checked before either test run
      const green = await runNamed(checkout, seed, own, "green"); classifyRun(green.output, green.code, seed.testName, false);
      writeFileSync(source, changed);
      const red = await runNamed(checkout, seed, own, "seeded"); classifyRun(red.output, red.code, seed.testName, true);
      console.log(`seeded: ${seed.id}: green -> named assertion detected (${((performance.now() - seedStart) / 1000).toFixed(3)} s)`);
      rmSync(own, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`${seed.id}: ${error instanceof Error ? error.message : String(error)}; preserved fixture ${own}`);
    }
  }
  console.log(`seeded: OK (${seeds.length} sequential guards, ${((performance.now() - start) / 1000).toFixed(3)} s)`);
}
if (import.meta.main) {
  try { await seededCheck(resolve(import.meta.dir, "..")); }
  catch (error) { console.error(`seeded: ERROR ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
