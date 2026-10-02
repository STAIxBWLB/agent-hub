import type { ChildProcess } from "node:child_process";

/**
 * Recovery authority belongs to the short-lived ahub wrapper/launcher. Native
 * agents and their long-lived children must never inherit it, or their later
 * lifecycle calls could bypass the machine recovery lock.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.AGENTHUB_RECOVERY_OPERATION;
  return env;
}

/**
 * Stop a child owned by this hub and confirm that it exited. A timeout is an
 * incomplete shutdown, even after SIGKILL, because callers must not reuse a
 * port or claim ownership while the old process may still be alive.
 *
 * `group`: the child was spawned `detached` and leads its own process group, and the whole group is signalled. A
 * launcher that forwards signals to a native child (Codex's `codex.js`) otherwise dies alone at SIGKILL while its
 * child, still finishing a turn, is re-parented to init with the launcher's pipes and keeps the hub process alive
 * (issue #113).
 */
export async function stopOwnedProcess(proc: ChildProcess, { termMs = 1_000, killMs = 2_000, group = false } = {}): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
  const pid = proc.pid;
  // ESRCH from a group means every member is gone; the leader's exit event may still be on its way.
  const signal = (sig: NodeJS.Signals) => {
    if (!group) return void proc.kill(sig);
    try { process.kill(-pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  // A member that outlived the leader goes with it; the group id stays taken while any member lives.
  const sweep = () => { if (group) signal("SIGKILL"); };

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
    signal("SIGTERM");
  } catch {
    if (proc.exitCode !== null || proc.signalCode !== null) return sweep();
    throw new Error(`owned child ${pid} could not be terminated`);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || (await waitForExit(termMs))) return sweep();

  try {
    signal("SIGKILL");
  } catch {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    throw new Error(`owned child ${pid} could not be killed`);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || (await waitForExit(killMs))) return;
  throw new Error(`owned child ${pid} shutdown incomplete after SIGKILL`);
}
