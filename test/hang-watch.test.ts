import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "..", "scripts", "hang-watch.sh");
const run = (pid: number, seconds: number, progress?: string, quiet?: number) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const argv = [String(pid), String(seconds), ...(progress ? [progress, String(quiet ?? 300)] : [])];
  const p = spawn(script, argv, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p.stderr!.on("data", (d) => (stderr += String(d)));
  p.once("exit", (status) => resolve({ status, stderr }));
});
const exited = (p: ReturnType<typeof spawn>) => new Promise<void>((resolve) => (p.exitCode !== null || p.signalCode !== null ? resolve() : p.once("exit", () => resolve())));

// issue #115: scripts/check.sh runs the test suite under this watchdog.
test("the watchdog says where a run that outlives its bound is and stops it; a run that ends in time is left alone", async () => {
  const hung = spawn("sleep", ["30"], { stdio: "ignore" });
  const watched = await run(hung.pid!, 1);
  await exited(hung);
  expect(hung.signalCode).toBe("SIGTERM");
  expect(watched.stderr).toContain(`pid ${hung.pid} still running after 1s`);

  // A run that ignores SIGTERM is killed. It says so once its trap is set.
  const stubborn = spawn("sh", ["-c", 'trap "" TERM; echo ready; while :; do sleep 1; done'], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve) => stubborn.stdout!.once("data", resolve));
    const forced = await run(stubborn.pid!, 1);
    await exited(stubborn);
    expect([stubborn.signalCode, forced.stderr.includes("still running after 1s")]).toEqual(["SIGKILL", true]);
  } finally {
    if (stubborn.exitCode === null && stubborn.signalCode === null) stubborn.kill("SIGKILL");
  }

  const quick = spawn("sleep", ["0.2"], { stdio: "ignore" });
  const calm = await run(quick.pid!, 30);
  await exited(quick);
  expect([quick.exitCode, calm.status, calm.stderr]).toEqual([0, 0, ""]);
}, 60_000);

// #516: the total-time kill used to be the only bound, so it cut hosted runs that were still passing tests line by line. With a progress file and a quiet bound the watchdog stops a
// run whose progress file has not grown for that long, and SECONDS is only the backstop. scripts/progress-tee.sh writes the progress file: one byte per result line or file header.
const dirOf = () => mkdtempSync(join(tmpdir(), "ahub-hang-watch-"));
const progressFile = () => { const file = join(dirOf(), "progress.txt"); writeFileSync(file, ""); return file; };
const stopped = (p: ReturnType<typeof spawn>) => p.exitCode === null && p.signalCode !== null;
const cleanup = (p: ReturnType<typeof spawn>) => { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); };
// A child that appends one progress byte every second, `count` times, then ends on its own.
const grower = (file: string, count: number) =>
  spawn("sh", ["-c", `i=0; while [ $i -lt ${count} ]; do i=$((i+1)); printf x >> '${file}'; sleep 1; done`], { stdio: "ignore" });
const teeScript = join(import.meta.dir, "..", "scripts", "progress-tee.sh");
// What scripts/check.sh does around bun: a fifo, the filter reading it, the watched runner writing its stderr to it, the watchdog on the runner. `runner` is the shell text of a fake bun.
const gate = (runner: string, quiet: number, total: number) => {
  const dir = dirOf(), fifo = join(dir, "out.fifo"), progress = join(dir, "progress.txt");
  const shell = `set -u; : > '${progress}'; mkfifo '${fifo}'
    '${teeScript}' '${progress}' < '${fifo}' >&2 & tee_pid=$!
    bash -c '${runner}' 2> '${fifo}' & test_pid=$!
    '${script}' $test_pid ${total} '${progress}' ${quiet} & watch_pid=$!
    status=0; wait $test_pid || status=$?
    kill $watch_pid 2>/dev/null; wait $watch_pid 2>/dev/null
    wait $tee_pid 2>/dev/null
    echo "GATE exit=$status progress=$(wc -c < '${progress}' | tr -d ' ')"`;
  return new Promise<{ stderr: string; stdout: string }>((resolve) => {
    const p = spawn("bash", ["-c", shell], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout!.on("data", (d) => (stdout += String(d)));
    p.stderr!.on("data", (d) => (stderr += String(d)));
    p.once("exit", () => resolve({ stdout, stderr }));
  });
};

test("a run whose progress file keeps growing survives many quiet bounds and ends on its own; nothing is printed", async () => {
  const file = progressFile();
  const growing = grower(file, 6);
  try {
    const watched = await run(growing.pid!, 60, file, 3);   // 6 s of progress against a 3 s quiet bound: two bounds crossed in time, never in silence
    await exited(growing);
    expect([growing.exitCode, growing.signalCode, watched.status, watched.stderr]).toEqual([0, null, 0, ""]);
  } finally { cleanup(growing); }
}, 15_000);

test("a run whose progress file stops growing is stopped on the quiet bound, with a process table, long before the total bound", async () => {
  const file = progressFile();
  writeFileSync(file, "xx");
  // A runner with a fixture child below it: the table must show the child, since the hang is often there. Its trap removes the child on SIGTERM, so nothing outlives the test.
  const stalled = spawn("sh", ["-c", "sleep 120 & c=$!; trap 'kill $c' TERM; wait"], { stdio: "ignore" });
  try {
    const began = Date.now();
    const watched = await run(stalled.pid!, 60, file, 2);
    const elapsed = Date.now() - began;
    await exited(stalled);
    expect(stalled.exitCode !== null || stalled.signalCode !== null).toBe(true);   // its trap handled the SIGTERM, so it exits instead of dying by the signal
    expect(watched.stderr).toContain("cause=quiet");
    expect(watched.stderr).toContain("made no progress");
    expect(watched.stderr).toContain(`processes below pid ${stalled.pid}`);
    expect(watched.stderr).toMatch(/sleep 120/);
    expect(elapsed).toBeLessThan(12_000);   // nowhere near the 60 s total bound
  } finally { cleanup(stalled); }
}, 15_000);

test("an empty progress file is stopped on the quiet bound too (a hang before the first result)", async () => {
  const file = progressFile();
  const stalled = spawn("sleep", ["120"], { stdio: "ignore" });
  try {
    const watched = await run(stalled.pid!, 60, file, 2);
    await exited(stalled);
    expect(stalled.signalCode).toBe("SIGTERM");
    expect(watched.stderr).toContain("cause=quiet");
  } finally { cleanup(stalled); }
}, 15_000);

test("the total bound is still the backstop: a run whose progress never stops is stopped there, not on the quiet bound", async () => {
  const file = progressFile();
  const endless = grower(file, 30);
  try {
    const watched = await run(endless.pid!, 4, file, 3);   // 1 s gaps against a 3 s quiet bound (#526): only the total bound may fire
    await exited(endless);
    expect(stopped(endless)).toBe(true);
    expect(watched.stderr).toContain("still running after 4s");
    expect(watched.stderr).toContain("cause=total");
    expect(watched.stderr).not.toContain("cause=quiet");
  } finally { cleanup(endless); }
}, 15_000);

test("progress-tee.sh passes every line through unchanged and counts one byte per result line or file header, the last line without a newline included", () => {
  const file = progressFile();
  const input = "bun test v1\n\ntest/a.test.ts:\n(pass) one [1ms]\nsome log\n(fail) two\n(skip) three\n(todo) four\n  (pass) indented\n(pass) last has no newline";
  const out = Bun.spawnSync([teeScript, file], { stdin: Buffer.from(input) });
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toBe(input + "\n");   // every line, nothing dropped (awk ends the last line with a newline)
  expect(readFileSync(file, "utf8")).toBe("xxxxxx");   // the header, (pass), (fail), (skip), (todo) and the last (pass); not the version line, the log line or the indented one
});

test("through the real fifo, filter and watchdog: a run that keeps passing tests is not stopped and its exit code is kept; the output reaches stderr unchanged", async () => {
  // 5 s of results (a line every 0.5 s) against a 3 s quiet bound: the longest gap is a sixth of the bound, so a loaded runner has 2.5 s of slack (#526). The fake runner fails at the end, and that status must come out of the gate untouched.
  const out = await gate('echo "test/a.test.ts:" >&2; for i in 1 2 3 4 5 6 7 8 9 10; do echo "(pass) t$i" >&2; sleep 0.5; done; echo "(fail) last" >&2; exit 3', 3, 60);
  expect(out.stdout).toContain("GATE exit=3 progress=12");   // a header, ten passes and a fail
  expect(out.stderr).toContain("(pass) t10");
  expect(out.stderr).toContain("(fail) last");
  expect(out.stderr).not.toContain("cause=");
}, 15_000);

test("through the real fifo, filter and watchdog: a run that goes silent after its results is stopped on the quiet bound", async () => {
  const out = await gate('echo "(pass) a" >&2; echo "(pass) b" >&2; exec sleep 60', 2, 60);
  expect(out.stderr).toContain("cause=quiet");
  expect(out.stdout).toMatch(/GATE exit=143 progress=2/);
}, 15_000);

test("through the real fifo, filter and watchdog: a test file header alone is progress (a long file whose results come at its end)", async () => {
  // Headers every 0.5 s keep a 3 s quiet bound satisfied for 5 s without a single result line (gap a sixth of the bound, #526).
  const out = await gate('for i in 1 2 3 4 5 6 7 8 9 10; do echo "test/f$i.test.ts:" >&2; sleep 0.5; done; exit 0', 3, 60);
  expect(out.stdout).toContain("GATE exit=0 progress=10");
  expect(out.stderr).not.toContain("cause=");
}, 15_000);

test("through the real fifo, filter and watchdog: plain log lines are not progress", async () => {
  const out = await gate('for i in $(seq 1 30); do echo "some log line $i" >&2; sleep 1; done', 2, 60);
  expect(out.stderr).toContain("cause=quiet");
  expect(out.stdout).toMatch(/GATE exit=143 progress=0/);
}, 15_000);
