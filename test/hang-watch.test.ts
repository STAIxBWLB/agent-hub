import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "hang-watch.sh");
const run = (pid: number, seconds: number) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const p = spawn(script, [String(pid), String(seconds)], { stdio: ["ignore", "ignore", "pipe"] });
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

  const quick = spawn("sleep", ["0.2"], { stdio: "ignore" });
  const calm = await run(quick.pid!, 30);
  await exited(quick);
  expect([quick.exitCode, calm.status, calm.stderr]).toEqual([0, 0, ""]);
}, 30_000);
