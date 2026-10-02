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

/** One process: its identity is the pid with its start time (`lstart`, which exec keeps); group and command are evidence. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
  command: string;
}

/** `ps -axo pid=,ppid=,pgid=,lstart=,command=` output (unlimited width when not on a terminal), read in the C locale. */
export function parseProcessTable(text: string): ProcRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4]!, command: m[5]! }] : [];
  });
}

/**
 * The process table, or undefined when it cannot be read or does not show this process: a parse that found nothing
 * (a localized `lstart`, a changed `ps`) is not an empty table. Read with LC_ALL=C for that reason.
 */
export function processTable(): ProcRow[] | undefined {
  try {
    const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
    if (r.exitCode !== 0) return undefined;
    const rows = parseProcessTable(r.stdout.toString());
    return rows.some((row) => row.pid === process.pid) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/** Every descendant of `pid` in `rows`, by parent links. */
export function descendantsOf(rows: ProcRow[], pid: number): ProcRow[] {
  const out: ProcRow[] = [];
  const parents = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        out.push(row);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Stop a child owned by this hub and confirm that it exited. A timeout is an
 * incomplete shutdown, even after SIGKILL, because callers must not reuse a
 * port or claim ownership while the old process may still be alive.
 *
 * `group`: the child was spawned `detached` and leads its own process group, and the whole group is signalled. A
 * launcher that forwards signals to a native child (Codex's `codex.js`) otherwise dies alone at SIGKILL while its
 * child, still finishing a turn, is re-parented to init with the launcher's pipes and keeps the hub process alive
 * (issue #113). The group's members can start processes that lead groups of their own (Codex runs its MCP servers and
 * tool commands so): those are found by parent links before anything is signalled and stopped by identity after the
 * group. Done means the group and every one of them is gone.
 */
export async function stopOwnedProcess(proc: ChildProcess, { termMs = 1_000, killMs = 2_000, group = false } = {}): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
  const pid = proc.pid;
  const below = group ? descendantsOf(processTable() ?? [], pid) : [];
  // ESRCH from a group means every member is gone; the leader's exit event may still be on its way.
  const signal = (sig: NodeJS.Signals) => {
    if (!group) return void proc.kill(sig);
    try { process.kill(-pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  /** What is left of the group and of the processes found below it, the same processes (pid and start time). */
  const left = (): ProcRow[] | undefined => {
    const table = processTable();
    if (!table) return undefined;
    return table.filter((row) => row.pgid === pid || below.some((b) => b.pid === row.pid && b.started === row.started));
  };
  // The leader is gone: whatever is left goes too, a group leader with its group, and the readback must show nothing.
  const sweep = async (): Promise<void> => {
    if (!group) return;
    const deadline = Date.now() + killMs;
    for (;;) {
      const rest = left();
      if (rest && !rest.length) break;
      if (Date.now() >= deadline) throw new Error(`owned child ${pid}: ${rest ? `${rest.length} process(es) of its group or below it still running` : "the process table cannot be read to confirm its group is gone"}`);
      for (const row of rest ?? []) {
        try { process.kill(row.pgid === row.pid ? -row.pid : row.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
      }
      signal("SIGKILL");
      await Bun.sleep(50);
    }
    // Nothing of it can write any more: drop the pipes, so a holder that escaped the table cannot keep the hub alive.
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };

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
    if (proc.exitCode !== null || proc.signalCode !== null) return sweep();
    throw new Error(`owned child ${pid} could not be killed`);
  }
  if (proc.exitCode !== null || proc.signalCode !== null || (await waitForExit(killMs))) return sweep();
  throw new Error(`owned child ${pid} shutdown incomplete after SIGKILL`);
}
