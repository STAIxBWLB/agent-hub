import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #548: the macOS CI leg is shards of the full suite. The partition itself is Bun's (`bun test --shard=i/n --timings=...`); what the repository owns, and what is pinned here, is that
// the workflow keeps the names the merge gate reads, that every shard runs under the Linux hang bound, that the once-only steps run exactly once, and that check.sh refuses a bad shard.
type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { name?: string; needs?: string | string[]; if?: string; "runs-on"?: string; "timeout-minutes"?: number; strategy?: { matrix: Record<string, unknown[]> }; steps: Step[] };
const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;
const needs = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
const gateEnv = (job: Job) => job.steps.find(step => step.run?.trim() === "scripts/check.sh")?.env ?? {};

/** The job names a pull request shows, resolving the one matrix name template this workflow uses. */
function shownNames(): string[] {
  return Object.values(jobs).flatMap(job => {
    const name = job.name;
    if (!name) return [];
    const matrix = job.strategy?.matrix ?? {};
    const keys = Object.keys(matrix);
    if (!name.includes("${{ matrix.")) return [name];
    return keys.length === 1 ? matrix[keys[0]!]!.map(value => name.replace(/\$\{\{ matrix\.\w+ \}\}/g, String(value))) : [name];
  });
}

test("#548 the names the merge gate and the reuse proof read are all still produced: check (ubuntu-latest), check (macos-latest) and seeded guards", () => {
  const names = shownNames();
  for (const required of ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"]) expect(names.filter(name => name === required)).toHaveLength(1);
  // the sources of the two platform names: one real Linux job, and an aggregator over the macOS shards (the same shape as `seeded` over `seeded-shard`)
  expect(jobs.check!.strategy!.matrix.os).toEqual(["ubuntu-latest"]);
  expect(jobs.macos!.name).toBe("check (macos-latest)");
  expect(needs(jobs.macos!)).toEqual(["decision", "macos-shard"]);
  expect(needs(jobs.seeded!)).toEqual(["decision", "seeded-shard"]);
});

test("#548 the macOS aggregator fails unless every shard succeeded, and carries the identical-tree reuse marker like the other gate jobs", () => {
  const steps = jobs.macos!.steps;
  const reuse = steps.find(step => step.name === "Reuse verified identical-tree full gate");
  expect(reuse?.if).toBe("needs.decision.outputs.admission == 'reuse'");
  expect(reuse?.run).toContain("Reused identical-tree full gate run");
  const all = steps.find(step => step.name === "Every macOS shard passed");
  expect(all?.if).toBe("needs.decision.outputs.run_gate == 'true'");
  expect(all?.env?.SHARDS).toBe("${{ needs.macos-shard.result }}");
  expect(all?.run).toContain('test "$SHARDS" = success');
  // it must still run when a shard failed or was skipped, or the failure would read as "check (macos-latest)" missing instead of failed
  expect(jobs.macos!.if).toContain("always()");
  expect(jobs["macos-shard"]!.if).toBe("needs.decision.outputs.run_gate == 'true'");
});

test("#548 every macOS shard runs on macOS under the Linux hang bound and the same quiet bound, with a job limit that fits a shard", () => {
  const shard = jobs["macos-shard"]!, linux = jobs.check!;
  expect(shard["runs-on"]).toBe("macos-latest");
  expect(needs(shard)).toEqual(["decision"]);
  const mac = gateEnv(shard), lin = gateEnv(linux);
  expect(mac.AHUB_CHECK_HANG_S).toBe("1500"); expect(mac.AHUB_CHECK_HANG_S).toBe(lin.AHUB_CHECK_HANG_S); // the third raise (2400) is retired: Linux's bound
  expect(mac.AHUB_CHECK_QUIET_S).toBe(lin.AHUB_CHECK_QUIET_S); expect(mac.AHUB_CHECK_QUIET_S).toBe("300");
  expect(shard["timeout-minutes"]!).toBeLessThanOrEqual(25); // a shard is expected well under 15 minutes
  expect(linux["timeout-minutes"]).toBe(35); // Linux is untouched
  expect(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")).not.toContain("'2400'");
});

test("#548 the shard matrix covers 1..N exactly and N is the denominator every shard passes to check.sh", () => {
  const shard = jobs["macos-shard"]!;
  const count = shard.strategy!.matrix.shard!.length;
  expect(shard.strategy!.matrix.shard).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  expect(count).toBeGreaterThanOrEqual(2);
  expect(gateEnv(shard).AHUB_CHECK_SHARD).toBe(`\${{ matrix.shard }}/${count}`);
  expect(shard.name).toBe(`check (macos-latest) shard \${{ matrix.shard }}/${count}`);
  expect(shard.steps.some(step => step.uses?.startsWith("actions/checkout@"))).toBe(true);
});

test("#548 the committed per-file timings have bun's shape, name only test files, and positive whole milliseconds", () => {
  const timings = JSON.parse(readFileSync(new URL("../scripts/test-timings.json", import.meta.url), "utf8")) as { version: number; files: Record<string, number> };
  expect(timings.version).toBe(1);
  const entries = Object.entries(timings.files);
  expect(entries.length).toBeGreaterThan(300);
  for (const [file, ms] of entries) { expect(file).toMatch(/^test\/.+\.test\.ts$/); expect(Number.isInteger(ms) && ms >= 1).toBe(true); }
  // slowest first, as bun writes it: the file doubles as a slow-test report
  expect(entries.map(([, ms]) => ms)).toEqual([...entries.map(([, ms]) => ms)].sort((a, b) => b - a));
});

test("#548 bun's shard contract on the pinned Bun: every file runs in exactly one shard, with and without timings, and a file with no timing entry still runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-shard-contract-"));
  try {
    mkdirSync(join(dir, "test/nested"), { recursive: true });
    const files = Array.from({ length: 11 }, (_, index) => (index % 4 === 3 ? `test/nested/n${index}.test.ts` : `test/t${index}.test.ts`));
    for (const file of files) writeFileSync(join(dir, file), `import { test } from "bun:test";\ntest("${file}", () => {});\n`);
    // weights chosen so one file dominates, and two files have no entry at all
    const weights: Record<string, number> = { [files[0]!]: 9000, [files[1]!]: 400, [files[2]!]: 400, [files[4]!]: 50, [files[5]!]: 50 };
    writeFileSync(join(dir, "timings.json"), JSON.stringify({ version: 1, files: weights }));
    for (const withTimings of [false, true]) for (const n of [2, 3, 4]) {
      const seen: string[] = [];
      for (let index = 1; index <= n; index++) {
        const xml = join(dir, `s-${withTimings}-${n}-${index}.xml`);
        const run = Bun.spawnSync(["bun", "test", `--shard=${index}/${n}`, ...(withTimings ? ["--timings=timings.json"] : []), "--reporter=junit", `--reporter-outfile=${xml}`], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
        expect(run.exitCode).toBe(0);
        seen.push(...[...readFileSync(xml, "utf8").matchAll(/<testsuite name="(test\/[^"]+\.test\.ts)"/g)].map(match => match[1]!));
      }
      expect([...seen].sort(), `n=${n} timings=${withTimings}`).toEqual([...files].sort());
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// check.sh from a copy in a scratch repo, as test/check-lock.test.ts does: the gate holds the real repo's slot, and nothing after the first steps exists here.
function checkSh(env: Record<string, string>, ...args: string[]) {
  const repo = mkdtempSync(join(tmpdir(), "ahub-check-shard-"));
  try {
    mkdirSync(join(repo, "scripts"));
    copyFileSync(join(import.meta.dir, "../scripts/check.sh"), join(repo, "scripts/check.sh"));
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    const run = Bun.spawnSync(["bash", "scripts/check.sh", ...args], { cwd: repo, env: { ...process.env, AHUB_CHECK_LOCK_WAIT_S: "0", AHUB_CHECK_SHARD: "", ...env } });
    return { code: run.exitCode, err: run.stderr.toString() };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

test("#548 check.sh refuses a malformed, out-of-range or --changed-combined shard before any work, with exit 2", () => {
  for (const bad of ["x", "1", "1/", "/4", "0/4", "5/4", "a/4", "1/b", "1/4/2", "01/4", "-1/4"]) {
    const run = checkSh({ AHUB_CHECK_SHARD: bad });
    expect(run.code, bad).toBe(2);
    expect(run.err, bad).toContain("AHUB_CHECK_SHARD");
    expect(run.err, bad).not.toContain("check-docs.mjs"); // refused before the first step
  }
  const combined = checkSh({ AHUB_CHECK_SHARD: "1/4" }, "--changed");
  expect(combined.code).toBe(2);
  expect(combined.err).toContain("cannot be combined");
});

/**
 * check.sh run for real against a scratch repo: every step script is a stub that logs its name, and `bun` is a fake that logs its arguments and passes, so what is asserted is which steps
 * ran, with which test arguments, and what the last line says, for each shard. progress-tee.sh and hang-watch.sh are the real ones.
 */
function runGate(env: Record<string, string>, ...args: string[]) {
  const repo = mkdtempSync(join(tmpdir(), "ahub-check-shard-run-")), log = join(repo, "steps.log"), bin = join(repo, "bin");
  try {
    mkdirSync(join(repo, "scripts")); mkdirSync(bin);
    for (const real of ["check.sh", "progress-tee.sh", "hang-watch.sh"]) copyFileSync(join(import.meta.dir, "../scripts", real), join(repo, "scripts", real));
    writeFileSync(join(repo, "scripts/test-timings.json"), JSON.stringify({ version: 1, files: {} }));
    for (const name of ["check-docs.mjs", "check-package.mjs", "check-owned-processes.mjs"]) writeFileSync(join(repo, "scripts", name), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});\n`);
    writeFileSync(join(repo, "scripts/record-test-process.mjs"), "");
    writeFileSync(join(bin, "warm-git"), `#!/bin/sh\necho "warm-git $*" >> ${JSON.stringify(log)}\nexit ${env.WARM_GIT_EXIT ?? "0"}\n`, { mode: 0o755 });
    // the fake bun: logs `bun <args>`; a `test` run prints one result line on stderr, which check.sh routes through its progress filter
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "bun $*" >> ${JSON.stringify(log)}\ncase "$1" in test) echo "bun-test-sees AHUB_CHECK_SHARD=\${AHUB_CHECK_SHARD-unset}" >> ${JSON.stringify(log)}; echo "(pass) fake [1ms]" >&2 ;; esac\nexit 0\n`, { mode: 0o755 });
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    const run = Bun.spawnSync(["bash", "scripts/check.sh", ...args], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AHUB_CHECK_LOCK_WAIT_S: "0", AHUB_CHECK_SHARD: "", AHUB_CHECK_HANG_S: "60", AHUB_CHECK_WARM_GIT: join(bin, "warm-git"), ...env } });
    const all = (() => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return [] as string[]; } })();
    // `steps` are the commands run; `seen` are the observations the fake bun made about its environment (kept apart so the step-order tests stay about order)
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString(), steps: all.filter(line => !line.startsWith("bun-test-sees")), seen: all.filter(line => line.startsWith("bun-test-sees")) };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
const ONCE = ["check-docs.mjs", "bun x tsc --noEmit", "bun scripts/check-roles.ts", "bun scripts/build.mjs --check", "check-package.mjs"];

test("#548 an unsharded gate runs every step once, in order, then the whole suite, and ends `check: OK`, as before", () => {
  const run = runGate({});
  expect(run.code).toBe(0);
  expect(run.steps.filter(step => !step.startsWith("check-owned"))).toEqual(["check-docs.mjs", "bun install --frozen-lockfile", "bun x tsc --noEmit", "bun scripts/check-roles.ts", "bun scripts/build.mjs --check", "check-package.mjs", "bun test --timeout 20000"]);
  expect(run.out).toContain("check: OK");
  expect(run.out).not.toContain("shard");
});

test("#548 shard 1 runs the once-only steps and its slice of the suite on the committed timings; its last line names the shard", () => {
  const run = runGate({ AHUB_CHECK_SHARD: "1/4" });
  expect(run.code).toBe(0);
  const steps = run.steps.filter(step => !step.startsWith("check-owned"));
  expect(steps).toEqual(["check-docs.mjs", "bun install --frozen-lockfile", "bun x tsc --noEmit", "bun scripts/check-roles.ts", "bun scripts/build.mjs --check", "check-package.mjs", "warm-git --version", "bun test --timeout 20000 --shard=1/4 --timings=scripts/test-timings.json"]);
  expect(run.out.trim().split("\n").at(-1)).toBe("check: OK (shard 1/4)");
});

for (const index of [2, 3, 4]) test(`#548 shard ${index} installs and tests its slice and runs none of the once-only steps`, () => {
  const run = runGate({ AHUB_CHECK_SHARD: `${index}/4` });
  expect(run.code).toBe(0);
  const steps = run.steps.filter(step => !step.startsWith("check-owned"));
  expect(steps).toEqual(["bun install --frozen-lockfile", "warm-git --version", `bun test --timeout 20000 --shard=${index}/4 --timings=scripts/test-timings.json`]);
  for (const once of ONCE) expect(steps).not.toContain(once);
  expect(run.out.trim().split("\n").at(-1)).toBe(`check: OK (shard ${index}/4)`);
});

test("#548 across the four shards each once-only step runs exactly once", () => {
  const all = [1, 2, 3, 4].flatMap(index => runGate({ AHUB_CHECK_SHARD: `${index}/4` }).steps);
  for (const once of ONCE) expect(all.filter(step => step === once), once).toHaveLength(1);
});

// A shard starts the suite cold: on a fresh hosted macOS runner the first execs of the system git exceed the 1000 ms timeout several tests give it (hosted shards 3 and 4 of PR #954),
// so one unbounded exec of it runs before the tests. It is an advice, never a gate: its failure or absence does not fail the shard, and an unsharded gate does not run it.
test("#548 a shard warms the system git once before its tests, and a failing or absent warm-up never fails the shard; an unsharded gate does not warm", () => {
  for (const index of [1, 3]) { // the first (which also runs the once-only steps) and one other; shards 2 to 4 share a path and test/macos-shard.test.ts runs them all above
    const run = runGate({ AHUB_CHECK_SHARD: `${index}/4` });
    const steps = run.steps.filter(step => !step.startsWith("check-owned"));
    expect(steps.filter(step => step === "warm-git --version"), `shard ${index}`).toHaveLength(1);
    expect(steps.indexOf("warm-git --version")).toBe(steps.findIndex(step => step.startsWith("bun test")) - 1); // immediately before the tests
  }
  const failing = runGate({ AHUB_CHECK_SHARD: "2/4", WARM_GIT_EXIT: "7" });
  expect(failing.code).toBe(0);
  expect(failing.out.trim().split("\n").at(-1)).toBe("check: OK (shard 2/4)");
  const absent = runGate({ AHUB_CHECK_SHARD: "2/4", AHUB_CHECK_WARM_GIT: "/nonexistent/git" });
  expect(absent.code).toBe(0);
  expect(absent.steps.filter(step => step.startsWith("warm-git"))).toHaveLength(0);
  expect(runGate({}).steps.filter(step => step.startsWith("warm-git"))).toHaveLength(0);
}, 20_000); // five real check.sh runs against stubs: the gate's own limit (scripts/check.sh --timeout 20000), not Bun's 5 s default

// The shard belongs to check.sh: the test runner, and every scratch check.sh a test spawns with { ...process.env } (test/check-lock.test.ts), must not inherit it. Inherited, a shard other than 1
// would skip the docs step that test expects and fail, and a rebalance of the timings would turn the macOS gate red (connector review of PR #954).
test("#548 the shard is not exported to the test runner, in any shard, and the unsharded gate sees none either", () => {
  for (const index of [1, 2, 3, 4]) {
    const run = runGate({ AHUB_CHECK_SHARD: `${index}/4` });
    expect(run.code, `shard ${index}`).toBe(0);
    expect(run.seen, `shard ${index}`).toEqual(["bun-test-sees AHUB_CHECK_SHARD=unset"]);
    expect(run.out.trim().split("\n").at(-1)).toBe(`check: OK (shard ${index}/4)`); // the shard is still known to check.sh itself
  }
  expect(runGate({}).seen).toEqual(["bun-test-sees AHUB_CHECK_SHARD=unset"]);
}, 30_000);

test("#548 a scratch check.sh spawned from a test in a sharded gate runs its own steps as an unsharded gate (the check-lock case)", () => {
  // what a sharded run's test environment is: AHUB_CHECK_SHARD removed by check.sh. The scratch run below inherits that environment, so it behaves as an unsharded gate and its docs step runs.
  const inherited = checkSh({ AHUB_CHECK_SHARD: "" });
  expect(inherited.err).toContain("check-docs.mjs");
  // and the contrary, the leak this fixes: the same scratch run with the shard still in its environment skips the docs step
  const leaked = checkSh({ AHUB_CHECK_SHARD: "2/4" });
  expect(leaked.err).not.toContain("check-docs.mjs");
});
