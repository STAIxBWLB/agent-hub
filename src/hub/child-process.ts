import type { ChildProcess } from "node:child_process";

/**
 * Stop a child owned by this hub and confirm that it exited. A timeout is an
 * incomplete shutdown, even after SIGKILL, because callers must not reuse a
 * port or claim ownership while the old process may still be alive.
 */
export async function stopOwnedProcess(proc: ChildProcess, termMs = 1_000, killMs = 2_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;

  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (exited: boolean) => {
        if (timer) clearTimeout(timer);
        proc.off("exit", onExit);
        proc.off("error", onError);
        resolve(exited);
      };
      const onExit = () => done(true);
      const onError = () => done(true); // spawn errors have no owned process to wait for
      proc.once("exit", onExit);
      proc.once("error", onError);
      timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
    });

  try {
    proc.kill("SIGTERM");
  } catch {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    throw new Error(`owned child ${proc.pid} could not be terminated`);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || (await waitForExit(termMs))) return;

  try {
    proc.kill("SIGKILL");
  } catch {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    throw new Error(`owned child ${proc.pid} could not be killed`);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || (await waitForExit(killMs))) return;
  throw new Error(`owned child ${proc.pid} shutdown incomplete after SIGKILL`);
}
