import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnvironment, restoreEnvironment, restoreOnTestEnd } from "./helpers/env-scope.ts";

// #1262. Bun starts the next test (and the next file) while a timed-out test's body still runs. A fixture that replaces process.env must therefore be undone at the timeout, and a second fixture
// that starts meanwhile must not snapshot the first one's isolated environment as if it were the real one. Each test below fails without the helper's half of that contract.
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
import { restoreEnvironment, cleanEnvironment, restoreOnTestEnd } from ${JSON.stringify(helper)};
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
  const run = Bun.spawnSync([process.execPath, "test", join(dir, "child.test.ts")], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toMatch(/\(fail\) holder/);                                // the holder really times out
  expect(out).toMatch(/\(pass\) next/);                                  // and the next test is clean
}, 30_000);
