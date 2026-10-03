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

/**
 * `ps -axo pid=,ppid=,pgid=,stat=,lstart=,command=` output (unlimited width when not on a terminal), read in the C
 * locale. A zombie is left out: it has exited, and only its parent's wait is missing.
 */
export function parseProcessTable(text: string): ProcRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    return m && !m[4]!.startsWith("Z") ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[5]!, command: m[6]! }] : [];
  });
}

const PS = ["ps", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="];
// `lstart` is local time: one zone for every reader, or a reader in another zone sees every identity as changed.
const PS_OPTIONS = { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, detached: true } as const;
/** The rows of one read, or undefined when they do not show the reader: a parse that found nothing is not a table. */
const own = (text: string) => { const rows = parseProcessTable(text); return rows.some((row) => row.pid === process.pid) ? rows : undefined; };

/**
 * The process table, or undefined when it cannot be read or does not show this process: a parse that found nothing
 * (a localized `lstart`, a changed `ps`) is not an empty table. Read with LC_ALL=C for that reason (and TZ=UTC, so
 * start times compare across readers), by a `ps` in a
 * process group of its own (a Ctrl-C to the caller's group would kill it), bounded, and tried twice.
 */
export function processTable(): ProcRow[] | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = Bun.spawnSync(PS, { ...PS_OPTIONS, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const rows = r.exitCode === 0 ? own(r.stdout.toString()) : undefined;
      if (rows) return rows;
    } catch {
      // tried again below
    }
  }
  return undefined;
}

/** `processTable`, without blocking the event loop: a hub stop reads the table many times while it keeps serving. */
export async function readProcessTable(): Promise<ProcRow[] | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const p = Bun.spawn(PS, { ...PS_OPTIONS, stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill("SIGKILL"), 10_000);
      const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]).finally(() => clearTimeout(timer));
      const rows = code === 0 ? own(text) : undefined;
      if (rows) return rows;
    } catch {
      // tried again below
    }
  }
  return undefined;
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
 * `group`: the child was spawned `detached` and leads its own process group; see `stopGroup`. `table` replaces the
 * process table read (tests).
 */
export async function stopOwnedProcess(proc: ChildProcess, { termMs = 1_000, killMs = 2_000, group = false, table = readProcessTable }: { termMs?: number; killMs?: number; group?: boolean; table?: () => ProcRow[] | undefined | Promise<ProcRow[] | undefined> } = {}): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) {
    // ponytail: a leader that exited before the stop (its launcher killed from outside) is not swept, as its pid may be
    // reused once its group empties; its pipes are dropped so a survivor cannot keep the hub alive, and a group that
    // still has members fails the stop instead of reading as done. Record the leader's start time at spawn to sweep it.
    if (proc.pid === undefined) return;
    dropPipes(proc); // whatever it left cannot keep the hub alive through them
    if (!group) return;
    if (emptied.has(proc)) return; // its group was seen gone since: the id may be someone else's now
    // A pid is not given out while a group with that id exists: a live process with the leader's pid means the group was
    // emptied and the id is someone else's now. Members without it are what the leader left (zombies are not listed).
    // Members still finishing their own exit get up to `killMs` before the stop fails.
    for (const end = Date.now() + killMs; ; await Bun.sleep(100)) {
      const rows = await table();
      const members = rows ? (rows.some((r) => r.pid === proc.pid) ? [] : rows.filter((r) => r.pgid === proc.pid)) : undefined;
      if (members ? !members.length : groupGone(proc.pid)) return;
      if (Date.now() >= end) throw new Error(`owned child ${proc.pid} exited before the stop and its process group still has members${members ? ` (${members.map((r) => r.pid).join(", ")})` : ""}: not signalled; stop them to restart it`);
    }
  }
  if (group) return stopGroup(proc, proc.pid, termMs, killMs, table);
  try {
    await stopAlone(proc, termMs, killMs);
  } finally {
    dropPipes(proc); // a process it started and left may still hold them: it must not keep the hub alive
  }
}

/** SIGTERM, then SIGKILL, to the child alone, each confirmed by its exit. */
async function stopAlone(proc: ChildProcess, termMs: number, killMs: number): Promise<void> {
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

const dropPipes = (proc: ChildProcess) => {
  proc.stdout?.destroy();
  proc.stderr?.destroy();
};

const emptied = new WeakSet<ChildProcess>();
/**
 * Follows the group of a child spawned `detached` after the child exits, until the group is gone: a later stop then
 * never inspects the group id, which can be reused once the group is empty (issue #113).
 */
export function trackGroup(proc: ChildProcess): void {
  proc.once("exit", () => {
    const pid = proc.pid;
    if (pid === undefined) return;
    const check = () => { if (groupGone(pid)) emptied.add(proc); else setTimeout(check, 1_000).unref(); };
    check();
  });
}

/** Whether no process is left in group `pgid` (macOS answers EPERM for a group of zombies). */
function groupGone(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" || (code === "EPERM" && process.platform === "darwin");
  }
}

/**
 * Stops a child that leads its own process group, with everything it started (issue #113). A launcher that forwards
 * signals to a native child (Codex's `codex.js`) otherwise dies alone at SIGKILL while its child, still at work, is
 * re-parented to init with the launcher's pipes and keeps the hub alive; and the native child starts processes that
 * lead groups of their own (Codex's MCP servers and tool commands), which no group signal reaches.
 *
 * SIGTERM to the group, a grace period in which what the tree starts is recorded while its parent still runs, then
 * freeze, enumerate, kill: what is left is stopped (SIGSTOP) before the table is read again, because a stopped process
 * starts nothing, so that read sees all of it; then SIGKILL. A snapshot taken while the tree runs misses what it starts
 * next (three review rounds found such a gap). Done means the table shows none of it; without any table, the group's
 * own answer (ESRCH, or EPERM on macOS for a group of zombies) is used, which cannot see groups below it.
 */
async function stopGroup(proc: ChildProcess, pid: number, termMs: number, killMs: number, table: () => ProcRow[] | undefined | Promise<ProcRow[] | undefined>): Promise<void> {
  const key = (r: { pid: number; started: string }) => `${r.pid}@${r.started}`;
  const found = new Map<string, ProcRow>();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  let leader: ProcRow | undefined;
  const live = (rows: ProcRow[], f: ProcRow) => rows.some((r) => r.pid === f.pid && r.started === f.started);
  /** Reads the table and records what runs below the leader or anything recorded that still runs. */
  const look = async (): Promise<ProcRow[] | undefined> => {
    const rows = await table();
    if (!rows) return undefined;
    if (!leader && !exited()) leader = rows.find((r) => r.pid === pid); // never a pid taken over after the leader exited
    const roots = [...(leader && live(rows, leader) ? [leader] : []), ...[...found.values()].filter((f) => live(rows, f))];
    for (const root of roots) for (const r of descendantsOf(rows, root.pid)) found.set(key(r), r);
    // A group is followed while it is known to be the same one: its leader or a recorded member still in it.
    for (const id of [pid, ...[...found.values()].filter((f) => f.pgid === f.pid).map((f) => f.pid)]) {
      // Current rows, never a recorded pgid: a member may have left the group since it was recorded.
      const known = (id === pid && leader && live(rows, leader)) || rows.some((r) => r.pgid === id && r.pid !== id && found.has(key(r))) || rows.some((r) => r.pid === id && r.pgid === id && found.has(key(r)));
      if (known) for (const r of rows) if (r.pgid === id && r.pid !== pid) found.set(key(r), r);
    }
    return rows;
  };
  const left = (rows: ProcRow[]) => [...found.values()].filter((f) => live(rows, f));
  /**
   * Running in the leader's group, or the group of a recorded process, without being recorded: after an empty moment the
   * group id can be someone else's, so it is never signalled, but the stop is not done while it runs.
   */
  const unproven = (rows: ProcRow[]) => {
    const ids = new Set([pid, ...[...found.values()].filter((f) => f.pgid === f.pid).map((f) => f.pid)]);
    return rows.filter((r) => ids.has(r.pgid) && r.pid !== process.pid && !found.has(key(r)) && !(leader && r.pid === leader.pid && r.started === leader.started));
  };
  // Errors are not results here: the table read back decides. A sent signal says the target existed at that moment.
  const signal = (target: number, sig: NodeJS.Signals) => { try { process.kill(target, sig); return true; } catch { return false; } };
  const each = (rows: ProcRow[], sig: NodeJS.Signals) => rows.filter((r) => signal(r.pgid === r.pid ? -r.pid : r.pid, sig));
  /** A read that takes longer than `ms` is given up: a frozen tree must not wait on a slow `ps` for its SIGKILL. */
  const within = (ms: number) => Promise.race([look(), Bun.sleep(ms).then(() => undefined)]);
  // What leads a group of its own (an MCP server, a tool command) gets a SIGTERM of its own and the same grace period:
  // a git process stopped by SIGKILL leaves its index lock behind.
  const termed = new Set<string>();
  const term = (rows: ProcRow[] | undefined) => {
    for (const r of rows ? left(rows) : []) if (r.pgid === r.pid && !termed.has(key(r))) { termed.add(key(r)); signal(-r.pid, "SIGTERM"); }
  };
  try {
    const first = await look();
    if (!exited()) signal(-pid, "SIGTERM"); // a reaped leader's group id is not proven any more
    term(first);
    // The grace period, for the leader and for what it started: what they start meanwhile is recorded while its parent
    // still runs.
    const leaderGone = new Promise<void>((resolve) => (exited() ? resolve() : proc.once("exit", () => resolve())));
    for (const end = Date.now() + termMs; Date.now() < end; ) {
      // The leader's exit ends a wait at once (a stop is usually that quick); after it, the table is read every 100 ms.
      await (exited() ? Bun.sleep(100) : Promise.race([leaderGone, Bun.sleep(100)]));
      const rows = await look();
      term(rows);
      if (exited() && rows && !left(rows).length) {
        if (!unproven(rows).length) return; // done: this read shows none of it
        break;
      }
    }
    // Freeze, enumerate, kill: a stopped process starts nothing, so a read after the freeze sees all of it.
    for (const end = Date.now() + killMs; ; ) {
      const rows = await look();
      const rest = rows ? left(rows) : undefined;
      const strangers = rows ? unproven(rows) : [];
      if (exited() && !strangers.length && (rest ? !rest.length : !found.size && groupGone(pid))) return;
      if (Date.now() >= end) {
        throw new Error(`owned child ${pid}: ${rest ? `${rest.length + strangers.length} process(es) of its group or below it still running${strangers.length ? `, ${strangers.length} not proven its own and left alone` : ""}` : "the process table cannot be read to confirm what it started is gone"}`);
      }
      // What is stopped is killed or continued, never left frozen: the group by whether its STOP was sent (its id stays
      // reserved while a member lives), each process by whether the read after the freeze still shows it. What a read
      // after the freeze shows for the first time (started between the read and the STOPs, in a group of its own) is
      // frozen too, and read again, before anything is killed.
      const groupStopped = !exited() && signal(-pid, "SIGSTOP");
      const stopped = new Map<string, ProcRow>();
      let frozen: ProcRow[] | undefined;
      for (let todo = rest ?? [], round = 0; ; round++) {
        for (const r of each(todo, "SIGSTOP")) stopped.set(key(r), r);
        frozen = await within(1_000);
        todo = frozen ? left(frozen).filter((r) => !stopped.has(key(r))) : [];
        if (!todo.length || round >= 4) break;
      }
      // Without a read after the freeze, only what the STOP reached is killed: a stopped process keeps its pid.
      const kill = frozen ? left(frozen) : [...stopped.values()];
      each(kill, "SIGKILL");
      if (groupStopped) signal(-pid, "SIGKILL");
      for (const r of stopped.values()) if (!kill.some((k) => k.pid === r.pid && k.started === r.started)) signal(r.pgid === r.pid ? -r.pid : r.pid, "SIGCONT");
      await Bun.sleep(50);
    }
  } finally {
    dropPipes(proc); // a process that left the tree between two reads may still hold them: it must not keep the hub alive
  }
}
