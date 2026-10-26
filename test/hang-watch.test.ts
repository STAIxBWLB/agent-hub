import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "..", "scripts", "hang-watch.sh");
const run = (pid: number, seconds: number, progress?: string, quiet?: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const env = { ...process.env };
  if (progress) delete env.AHUB_CHECK_QUIET_S; // the caller's value must not decide what this test observes
  if (quiet) env.AHUB_CHECK_QUIET_S = quiet;
  const argv = progress ? [String(pid), String(seconds), progress] : [String(pid), String(seconds)];
  const p = spawn(script, argv, { stdio: ["ignore", "ignore", "pipe"], env });
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

// #516: the total-time kill used to be the only bound, so it cut hosted runs that were still passing tests line by line. With a progress file the quiet bound is the
// detector (no new `(pass)`, `(fail)`, `(skip)` or `(todo)` line for AHUB_CHECK_QUIET_S seconds) and SECONDS is only the backstop.
const progressFile = () => join(mkdtempSync(join(tmpdir(), "ahub-hang-watch-")), "progress.txt");
const stopped = (p: ReturnType<typeof spawn>) => p.exitCode === null && p.signalCode !== null;
const cleanup = (p: ReturnType<typeof spawn>) => { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); };
// A child that writes one line to the progress file every second, `lines` times, then ends on its own. `kind` is what it writes.
const writer = (file: string, lines: number, kind: string) =>
  spawn("sh", ["-c", `i=0; while [ $i -lt ${lines} ]; do i=$((i+1)); echo "${kind}" >> '${file}'; sleep 1; done`], { stdio: "ignore" });

test("a run that keeps printing test results survives many quiet bounds and ends on its own; nothing is printed", async () => {
  const file = progressFile();
  const printing = writer(file, 8, "(pass) a test that passes [1.00ms]");
  try {
    const watched = await run(printing.pid!, 120, file, "2");   // 8 s of results against a 2 s quiet bound
    await exited(printing);
    expect([printing.exitCode, printing.signalCode, watched.status, watched.stderr]).toEqual([0, null, 0, ""]);
  } finally { cleanup(printing); }
}, 30_000);

test("a run that goes silent after passing tests is stopped on the quiet bound, with a process table, long before the total bound", async () => {
  const file = progressFile();
  writeFileSync(file, "(pass) one [1ms]\n(pass) two [1ms]\n");
  // A runner with a fixture child below it: the table must show the child, since the hang is often there.
  // Its trap removes the child when the watchdog's SIGTERM arrives, so nothing outlives the test.
  const stalled = spawn("sh", ["-c", "sleep 120 & c=$!; trap 'kill $c' TERM; wait"], { stdio: "ignore" });
  try {
    const began = Date.now();
    const watched = await run(stalled.pid!, 120, file, "3");
    const elapsed = Date.now() - began;
    await exited(stalled);
    expect(stalled.exitCode !== null || stalled.signalCode !== null).toBe(true);   // its trap handled the SIGTERM, so it exits instead of dying by the signal
    expect(watched.stderr).toContain("cause=quiet");
    expect(watched.stderr).toContain("made no progress");
    expect(watched.stderr).toContain(`processes below pid ${stalled.pid}`);
    expect(watched.stderr).toMatch(/sleep 120/);
    expect(elapsed).toBeLessThan(40_000);
  } finally { cleanup(stalled); }
}, 60_000);

test("only result lines are progress: a run that keeps logging but passes no test is stopped on the quiet bound", async () => {
  const file = progressFile();
  const chatty = writer(file, 60, "some log line that is not a test result");
  try {
    const watched = await run(chatty.pid!, 120, file, "3");
    await exited(chatty);
    expect(chatty.signalCode).toBe("SIGTERM");
    expect(watched.stderr).toContain("cause=quiet");
  } finally { cleanup(chatty); }
}, 60_000);

test("a run with an empty progress file is stopped on the quiet bound too (a hang before the first result)", async () => {
  const file = progressFile();
  writeFileSync(file, "");
  const stalled = spawn("sleep", ["120"], { stdio: "ignore" });
  try {
    const watched = await run(stalled.pid!, 120, file, "2");
    await exited(stalled);
    expect(stalled.signalCode).toBe("SIGTERM");
    expect(watched.stderr).toContain("cause=quiet");
  } finally { cleanup(stalled); }
}, 60_000);

test("the total bound is still the backstop: a run that prints results forever is stopped there, not on the quiet bound", async () => {
  const file = progressFile();
  const endless = writer(file, 60, "(pass) hung but printing [1ms]");
  try {
    const watched = await run(endless.pid!, 5, file, "2");
    await exited(endless);
    expect(stopped(endless)).toBe(true);
    expect(watched.stderr).toContain("still running after 5s");
    expect(watched.stderr).toContain("cause=total");
    expect(watched.stderr).not.toContain("cause=quiet");
  } finally { cleanup(endless); }
}, 60_000);
