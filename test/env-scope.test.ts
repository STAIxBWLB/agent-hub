import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnvironment, restoreEnvironment, restoreOnTestEnd, useEnvironmentScope } from "./helpers/env-scope.ts";
useEnvironmentScope();

// #1262. Bun starts the next test (and the next file) while a timed-out test's body still runs. A fixture that replaces process.env must therefore be undone at the timeout, and a second fixture
// that starts meanwhile must not snapshot the first one's isolated environment as if it were the real one. Each test below fails without the helper's half of that contract.
// The child runs print their own test output, which the assertions read. Under GitHub Actions Bun switches to annotation output ("::group::a-first.test.ts:", "::error ..."), so the runner's markers are
// removed from the child's environment: the parsing then holds on every runner and on a developer's machine alike (CI run 42358240689 failed here with GITHUB_ACTIONS=true).
const childEnv = (): NodeJS.ProcessEnv => { const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" }; for (const key of ["GITHUB_ACTIONS", "CI", "GITHUB_STEP_SUMMARY", "BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD"]) delete env[key]; return env; };
const marker = "ahub-env-scope-leak";
const poisoned = () => String(process.env.PATH).includes(marker);
const poison = () => { const bin = join(mkdtempSync(join(tmpdir(), `${marker}-`)), "bin"); mkdirSync(bin); process.env.PATH = bin; process.env.AGENTHUB_HOME = bin; };

test("the file's clean snapshot is the environment from before any test ran", () => {
  const clean = cleanEnvironment();
  expect(String(clean.PATH)).not.toContain(marker);
  const copy = cleanEnvironment(); copy.PATH = "changed";
  expect(cleanEnvironment().PATH).toBe(clean.PATH!);                     // a copy: editing one never changes the next
});

test("restoreEnvironment removes keys the snapshot lacks, resets the rest, and is idempotent", () => {
  const before = { ...process.env };
  process.env.AHUB_ENV_SCOPE_EXTRA = "1"; process.env.PATH = "/x";
  restoreEnvironment(before); restoreEnvironment(before);
  expect(process.env.AHUB_ENV_SCOPE_EXTRA).toBeUndefined();
  expect(process.env.PATH).toBe(before.PATH!);
});

test("1 a fixture whose body outlives its timeout: the env is restored when the test ends, not when the body does", async () => {
  const restore = restoreOnTestEnd(() => restoreEnvironment(cleanEnvironment()));
  poison();
  expect(poisoned()).toBe(true);
  void restore;                                                          // the test ends here without calling restore: as a timeout abandons the body before its `finally`
});

test("2 the next test sees the clean environment, and git still resolves (this is what failed 315 tests in CI)", () => {
  expect(poisoned()).toBe(false);
  expect(process.env.AGENTHUB_HOME).not.toContain(marker);
  expect(Bun.spawnSync(["git", "--version"], { env: process.env }).exitCode).toBe(0);
});

test("3 a second fixture that starts while the first body still holds its env restores the clean snapshot, never the leaked one", async () => {
  poison();                                                              // the first fixture's isolated env, still held by an abandoned body
  const secondBefore = cleanEnvironment();                               // what the fixed fixtures snapshot: the file's clean environment
  const leakedBefore = { ...process.env };                               // what the old fixtures snapshotted: whatever process.env held
  restoreEnvironment(cleanEnvironment());                                // the first body finishes and restores
  restoreEnvironment(leakedBefore);                                      // the OLD second fixture's restore: re-applies the leak
  expect(poisoned()).toBe(true);                                         // this is the old behaviour: the environment stays poisoned
  restoreEnvironment(secondBefore);                                      // the fixed second fixture's restore
  expect(poisoned()).toBe(false);
  expect(Bun.spawnSync(["git", "--version"], { env: process.env }).exitCode).toBe(0);
});

test("restoreOnTestEnd runs its restore once, whether the body's finally or the test end gets there first", async () => {
  let runs = 0;
  const done = restoreOnTestEnd(() => { runs++; });
  done(); done();
  expect(runs).toBe(1);
  let late = 0; restoreOnTestEnd(() => { late++; });                     // never called by the body: the afterEach below this file's last test is the only caller
  expect(late).toBe(0);
});

test("the abandoned-body shape: a real timeout in a child test run restores before the next test starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-env-scope-child-"));
  const helper = join(import.meta.dir, "helpers/env-scope.ts");
  writeFileSync(join(dir, "child.test.ts"), `import { expect, test } from "bun:test";
import { restoreEnvironment, cleanEnvironment, restoreOnTestEnd, useEnvironmentScope } from ${JSON.stringify(helper)};
useEnvironmentScope();
test("holder: replaces PATH, is abandoned at its 300 ms timeout, body would restore at 1500 ms", async () => {
  const restore = restoreOnTestEnd(() => restoreEnvironment(cleanEnvironment()));
  process.env.PATH = "/nonexistent-ahub-env-scope";
  try { await Bun.sleep(1500); } finally { restore(); }
}, 300);
test("next: sees the clean PATH at once", () => {
  expect(process.env.PATH).not.toContain("nonexistent-ahub-env-scope");
  expect(Bun.spawnSync(["git", "--version"], { env: process.env }).exitCode).toBe(0);
});
`);
  // A temp dir has no bunfig.toml, so no preload applies to the child run.
  const run = Bun.spawnSync([process.execPath, "test", join(dir, "child.test.ts")], { cwd: dir, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toMatch(/\(fail\) holder/);                                // the holder really times out
  expect(out).toMatch(/\(pass\) next/);                                  // and the next test is clean
}, 30_000);

test("#1262 across files: a helper already imported by an earlier file still binds its afterEach to the holder file, so the next FILE sees the clean PATH", async () => {
  // The leak in CI crossed into the next file. The helper registers its afterEach as an import side effect and captures its clean snapshot at import, so whether Bun re-evaluates the module per test file or
  // caches it for the process decides whether the hook reaches the holder's own tests. Three files in this order: (a) imports the helper and passes, (b) imports it, replaces PATH and is abandoned at its
  // timeout, (c) spawns git. (c) must see the clean PATH, and (b)'s timeout must be the real one.
  const dir = mkdtempSync(join(tmpdir(), "ahub-env-scope-files-"));
  const helper = JSON.stringify(join(import.meta.dir, "helpers/env-scope.ts"));
  writeFileSync(join(dir, "a-first.test.ts"), `import { expect, test } from "bun:test";
import { cleanEnvironment } from ${helper};
test("a: imports the helper and passes", () => { expect(String(cleanEnvironment().PATH)).not.toContain("nonexistent-ahub-env-scope"); });
`);
  writeFileSync(join(dir, "b-holder.test.ts"), `import { test } from "bun:test";
import { cleanEnvironment, restoreEnvironment, restoreOnTestEnd, useEnvironmentScope } from ${helper};
useEnvironmentScope();
test("b: replaces PATH and is abandoned at its 300 ms timeout; its body would restore at 2500 ms", async () => {
  const restore = restoreOnTestEnd(() => restoreEnvironment(cleanEnvironment()));
  process.env.PATH = "/nonexistent-ahub-env-scope";
  try { await Bun.sleep(2500); } finally { restore(); }
}, 300);
`);
  writeFileSync(join(dir, "c-victim.test.ts"), `import { expect, test } from "bun:test";
test("c: the next file sees the clean PATH and can spawn git", () => {
  expect(process.env.PATH).not.toContain("nonexistent-ahub-env-scope");
  expect(Bun.spawnSync(["git", "--version"], { env: process.env }).exitCode).toBe(0);
});
`);
  // A temp dir has no bunfig.toml, so no preload applies. The three paths are given in order; Bun runs them in the order of the paths it is given.
  const run = Bun.spawnSync([process.execPath, "test", join(dir, "a-first.test.ts"), join(dir, "b-holder.test.ts"), join(dir, "c-victim.test.ts")], { cwd: dir, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString() + run.stderr.toString();
  const order = [...out.matchAll(/^(a-first|b-holder|c-victim)\.test\.ts:/gm)].map(match => match[1]);
  expect(order).toEqual(["a-first", "b-holder", "c-victim"]);              // the three files ran in the intended order
  expect(out).toMatch(/\(pass\) a: imports the helper/);
  expect(out).toMatch(/\(fail\) b: replaces PATH/);                        // the holder really times out
  expect(out).toMatch(/\(pass\) c: the next file sees the clean PATH/);   // and the next FILE is clean
}, 30_000);

test("#1262 a file that uses restoreOnTestEnd without useEnvironmentScope() fails loudly, never silently loses the hook", async () => {
  // Two files, the second forgets to register: its first use must throw, naming the missing call, instead of leaving the leak to be found in a later shard.
  const dir = mkdtempSync(join(tmpdir(), "ahub-env-scope-forgot-"));
  const helper = JSON.stringify(join(import.meta.dir, "helpers/env-scope.ts"));
  writeFileSync(join(dir, "a-first.test.ts"), `import { test } from "bun:test";
import { cleanEnvironment } from ${helper};
test("a: imports the helper first", () => { void cleanEnvironment(); });
`);
  writeFileSync(join(dir, "b-forgot.test.ts"), `import { test } from "bun:test";
import { restoreOnTestEnd } from ${helper};
test("b: forgot useEnvironmentScope", () => { restoreOnTestEnd(() => {}); });
`);
  const run = Bun.spawnSync([process.execPath, "test", join(dir, "a-first.test.ts"), join(dir, "b-forgot.test.ts")], { cwd: dir, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toMatch(/\(fail\) b: forgot useEnvironmentScope/);
  expect(out).toContain("restoreOnTestEnd needs useEnvironmentScope() at the top level of this test file");
}, 30_000);

test("#1262 the two staged fixtures each register their own scope at the top level", () => {
  for (const file of ["staged-project-isolation.test.ts", "staged-runtime-daemon.test.ts"]) {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    expect(source, file).toMatch(/^useEnvironmentScope\(\);/m);
  }
});
