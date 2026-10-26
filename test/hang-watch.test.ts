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

// #516: the total-time kill used to be the only bound, so it cut hosted runs that were still passing tests line by
// line. With a progress file the quiet bound is the detector and SECONDS is only the backstop.
test("a run that goes quiet is killed on the quiet bound, before the total bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-hang-watch-"));
  const progress = join(dir, "progress.txt");
  writeFileSync(progress, "1 pass\n");
  const stalled = spawn("sleep", ["120"], { stdio: "ignore" });
  const started = Date.now();
  const watched = await run(stalled.pid!, 120, progress, "3");
  const elapsed = Date.now() - started;
  await exited(stalled);
  expect(stalled.signalCode).toBe("SIGTERM");
  expect(watched.stderr).toContain("no test result line for 3s");
  expect(watched.stderr).toContain("cause=quiet");
  expect(elapsed).toBeLessThan(30_000); // nowhere near the 120 s total bound
}, 60_000);

test("a run that keeps printing test results survives the quiet bound; only the total backstop stops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-hang-watch-"));
  const progress = join(dir, "progress.txt");
  // The child writes its own progress lines: a printer that never touches the file is a hang, not a survivor.
  const printing = spawn("sh", ["-c", `for i in $(seq 1 30); do echo "pass $i" >> '${progress}'; sleep 1; done`], { stdio: "ignore" });
  const watched = await run(printing.pid!, 6, progress, "2");
  await exited(printing);
  expect(printing.signalCode).toBe("SIGTERM");
  expect(watched.stderr).toContain("still running after 6s");
  expect(watched.stderr).toContain("cause=total");
  expect(watched.stderr).not.toContain("cause=quiet");
}, 60_000);
