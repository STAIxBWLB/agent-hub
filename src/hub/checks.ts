import { childEnv } from "./child-process.ts";

export interface CheckResult {
  code: number | null;
  timedOut: boolean;
  /** Killed because the hub stopped: not a verdict on the work. */
  interrupted?: boolean;
  /** The last lines of stdout and stderr together, capped. */
  tail: string;
}

/** The part of a `Bun.spawn` child a check reads; tests substitute their own. */
export interface CheckProcess {
  pid: number;
  /** Resolves with the exit code once the child is gone (128 + signal for a signalled child). */
  exited: Promise<number>;
  signalCode: string | null;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}
export type CheckSpawn = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CheckProcess;

/**
 * Why this is `Bun.spawn` and not `node:child_process` (#558): under `bun test` on a loaded macOS runner, node's spawn can
 * reap a quick child inside `spawn()` itself and emit its exit and close events (and destroy its pipes, output unread)
 * before any listener exists (oven-sh/bun#45483). The check then waited for events that had come already and returned a
 * timeout, empty tail included, after its limit plus the kill grace. `Bun.spawn` hands over `exited` and the stream
 * readers as values, so an early exit is still there to read. Measured under CPU load, one quick check per test file:
 * node:child_process failed 9 of 300 rounds of 60 files, `Bun.spawn` 0 of 300.
 */
const bunSpawn: CheckSpawn = (argv, options) => Bun.spawn(argv, { cwd: options.cwd, env: options.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });

const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
const KEEP_CHARS = 64 * 1024;
/** How long output may still arrive after the command exited; a descendant that left the group can hold the pipes. */
const DRAIN_MS = 500;
/** How long a killed check may wait for its exit and its pipes before it settles without them (#558). */
const KILL_GRACE_MS = 1000;

/** Runs one check command in the project root, in its own process group so a timeout stops what it started. */
export function runCheck(command: string, cwd: string, timeoutMs: number, running?: Set<() => void>, spawnChild: CheckSpawn = bunSpawn): Promise<CheckResult> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let exited = false;
    const readers: { cancel(): Promise<unknown> }[] = [];
    let grace: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: CheckProcess;
    const stopListening = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(drain);
      for (const reader of readers) reader.cancel().catch(() => {});
    };
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      stopListening();
      running?.delete(stop);
      const tail = out.replace(/\s+$/, "").split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
      resolve({ code: timedOut || interrupted ? null : code, timedOut, ...(interrupted ? { interrupted } : {}), tail });
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    /** A kill that is a verdict (timeout, hub stop) settles even if the child's exit and pipes never report. */
    const killAndSettle = () => {
      killGroup();
      grace ??= setTimeout(() => done(null), KILL_GRACE_MS);
    };
    function stop() {
      if (exited || settled) return; // finished in time or already settled: its result stands and the group may be reused
      interrupted = true;
      killAndSettle();
    }
    try {
      child = spawnChild(["sh", "-c", command], { cwd, env: childEnv(process.env) });
    } catch (e) {
      resolve({ code: null, timedOut: false, tail: (e instanceof Error ? e.message : String(e)).trim() });
      return;
    }
    running?.add(stop);
    const keep = (chunk: string) => {
      out += chunk;
      if (out.length > KEEP_CHARS) out = out.slice(-KEEP_CHARS);
    };
    /** Reads one pipe to its end; resolves when it closes, or when `done` cancels it. */
    const pump = (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      readers.push(reader);
      const decoder = new TextDecoder(); // decodes across chunk edges, so Korean output is not cut into U+FFFD
      return (async () => {
        try {
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            keep(decoder.decode(value, { stream: true }));
          }
          keep(decoder.decode());
        } catch {
          // cancelled or broken: what was read stands
        }
      })();
    };
    const pipes = Promise.all([pump(child.stdout), pump(child.stderr)]);
    timer = setTimeout(() => {
      timedOut = true;
      killAndSettle();
    }, timeoutMs);
    child.exited.then((code) => {
      if (settled) return; // the kill grace settled it: the process group id is no longer ours to signal
      exited = true;
      clearTimeout(timer); // it finished in time; only its output may still be on the way
      killGroup(); // a background job it left behind (sh has no job control, so it is still in the group)
      const result = child.signalCode ? null : code;
      drain = setTimeout(() => done(result), DRAIN_MS);
      void pipes.then(() => done(result)); // every pipe closed: nothing more is coming
    }, (e: unknown) => {
      out += `\n${e instanceof Error ? e.message : String(e)}`;
      done(null);
    });
  });
}
