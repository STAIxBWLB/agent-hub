import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #1577 entry 3: a red shard names the step that ended it. scripts/check.sh runs from a copy in a scratch repo with a fake `bun` and stub steps,
// so each path (a once-only step, a runner that exits with no (fail) line, a signal, a (fail) line, a leak scan) is reached on demand.

function scratch(bunBody: string, stubs: { docs?: number; leaks?: number } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "ahub-check-names-"));
  mkdirSync(join(repo, "scripts")); mkdirSync(join(repo, "fakebin"));
  for (const file of ["check.sh", "progress-tee.sh", "hang-watch.sh"]) { copyFileSync(join(import.meta.dir, "../scripts", file), join(repo, "scripts", file)); chmodSync(join(repo, "scripts", file), 0o755); }
  writeFileSync(join(repo, "scripts/check-docs.mjs"), `process.exit(${stubs.docs ?? 0});\n`);
  writeFileSync(join(repo, "scripts/check-owned-processes.mjs"), `process.exit(${stubs.leaks ?? 0});\n`);
  writeFileSync(join(repo, "scripts/record-test-process.mjs"), "");
  writeFileSync(join(repo, "fakebin/bun"), `#!/usr/bin/env bash\nif [ "$1" = install ]; then exit 0; fi\nif [ "$1" = test ]; then\n${bunBody}\nfi\nexit 0\n`);
  chmodSync(join(repo, "fakebin/bun"), 0o755);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
  const run = (shard = "2/4") => {
    const env = { ...process.env, PATH: `${join(repo, "fakebin")}:${process.env.PATH}`, AHUB_CHECK_SHARD: shard, AHUB_CHECK_LOCK_WAIT_S: "0", AHUB_CHECK_WARM_GIT: "/nonexistent" } as Record<string, string>;
    delete env.GITHUB_ACTIONS;
    const result = Bun.spawnSync(["bash", "scripts/check.sh"], { cwd: repo, env });
    return { code: result.exitCode, err: result.stderr.toString(), out: result.stdout.toString() };
  };
  return { repo, run };
}

test("a once-only step that fails is named, with its own exit status", () => {
  const f = scratch("exit 0", { docs: 7 });
  try {
    const r = f.run("1/4");
    expect(r.code).toBe(7);
    expect(r.err).toContain("check: FAILED step 'docs check' (exit 7)");
  } finally { rmSync(f.repo, { recursive: true, force: true }); }
});

// Bun repeats every failing test in a `N tests failed:` recap after the last file, byte for byte (the recorded duration included),
// and that recap carries no file header. This body copies that shape, measured on Bun 1.4.4 with two failing files.
test("a runner that fails with (fail) lines counts each test once although bun repeats them in its recap, and names the first failure and the last file", () => {
  const f = scratch(`echo "test/a.test.ts:" >&2; echo "(pass) one [1ms]" >&2; echo "test/b.test.ts:" >&2; echo "(fail) second breaks [5ms]" >&2; echo "(fail) third breaks [5ms]" >&2; echo "" >&2; echo "2 tests failed:" >&2; echo "(fail) second breaks [5ms]" >&2; echo "(fail) third breaks [5ms]" >&2; exit 1`);
  try {
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("check: FAILED step 'bun test' (exit 1): 2 failing test(s), first: (fail) second breaks [5ms]; last test file started: test/b.test.ts:");
  } finally { rmSync(f.repo, { recursive: true, force: true }); }
});

test("a runner that exits non-zero with no (fail) line is named as such, with the last file started", () => {
  const f = scratch(`echo "test/c.test.ts:" >&2; echo "(pass) ok [1ms]" >&2; exit 3`);
  try {
    const r = f.run();
    expect(r.code).toBe(3);
    expect(r.err).toContain("check: FAILED step 'bun test' (exit 3): the test runner exited with no failing test line");
    expect(r.err).toContain("last test file started: test/c.test.ts:");
  } finally { rmSync(f.repo, { recursive: true, force: true }); }
});

test("a runner stopped by a signal is named with the signal", () => {
  const f = scratch(`echo "test/d.test.ts:" >&2; kill -KILL $$`);
  try {
    const r = f.run();
    expect(r.code).toBe(137);
    expect(r.err).toContain("check: FAILED step 'bun test' (exit 137): the test runner was stopped by signal 9");
    expect(r.err).toContain("last test file started: test/d.test.ts:");
  } finally { rmSync(f.repo, { recursive: true, force: true }); }
});

test("a leak scan failure after passing tests is named", () => {
  const f = scratch(`echo "test/e.test.ts:" >&2; echo "(pass) ok [1ms]" >&2; exit 0`, { leaks: 1 });
  try {
    const r = f.run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("check: FAILED step 'leaked process scan' (exit 1)");
    expect(r.err).not.toContain("step 'bun test'");
  } finally { rmSync(f.repo, { recursive: true, force: true }); }
});

test("a passing run prints no FAILED line, and under GitHub Actions a failure also prints an annotation", () => {
  const ok = scratch(`echo "(pass) ok [1ms]" >&2; exit 0`);
  try { const r = ok.run(); expect(r.code).toBe(0); expect(r.err).not.toContain("FAILED"); expect(r.out).toContain("check: OK (shard 2/4)"); }
  finally { rmSync(ok.repo, { recursive: true, force: true }); }
  const bad = scratch(`exit 5`);
  try {
    const result = Bun.spawnSync(["bash", "scripts/check.sh"], { cwd: bad.repo, env: { ...process.env, PATH: `${join(bad.repo, "fakebin")}:${process.env.PATH}`, AHUB_CHECK_SHARD: "2/4", AHUB_CHECK_LOCK_WAIT_S: "0", AHUB_CHECK_WARM_GIT: "/nonexistent", GITHUB_ACTIONS: "true" } as Record<string, string> });
    expect(result.exitCode).toBe(5);
    expect(result.stdout.toString()).toContain("::error title=check failed::step 'bun test' (exit 5)");
  } finally { rmSync(bad.repo, { recursive: true, force: true }); }
});
