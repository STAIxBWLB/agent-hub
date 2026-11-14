// macOS script(1) requires a terminal on its own stdin, including when its child gets a PTY.
// Keep a real PTY in this owned bridge instead; the outer Node child remains tracked by stopOwnedProcess.

/**
 * #560: the bridge used to hold its child behind a shell until `Bun.spawn` had returned, because Bun up to 1.4.3 could hang for good inside `Bun.spawn({ terminal })` on macOS when the child wrote and
 * started exiting before the call returned (oven-sh/bun#45300, fixed in 1.4.4; 26 of 96 runs hung at 12 in parallel on 1.4.3 and 0 of 180 on 1.4.4). The repository pins Bun 1.4.4 now (`.bun-version`),
 * so the child starts directly. The parent-death stop below stays whatever the Bun version: an orphaned bridge is this repository's bug, not Bun's.
 */
/** A bridge whose caller died is stopped instead of running on: its child holds a terminal nobody reads and, under launchd, nothing else would ever stop it. */
const PARENT_POLL_MS = 250;
const PARENT_TERM_GRACE_MS = 1_000;
const PARENT_HARD_EXIT_MS = 3_000;

// The caller is whoever started this bridge, read before anything that can take time: a caller that dies while `Bun.spawn` runs has already reparented this process by the
// time the call returns, and a parent read after it would be launchd and never change.
const parent = process.ppid;
const callerGone = (): boolean => process.ppid !== parent;
const argv = process.argv.slice(2);
if (!argv.length) {
  process.exitCode = 125;
} else {
  let streamClosed!: () => void;
  const eof = new Promise<void>(resolve => { streamClosed = resolve; });
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const child = Bun.spawn(argv, {
      cwd: process.cwd(), env: process.env,
      terminal: {
        cols: 120, rows: 40, name: "xterm-256color",
        data: (_terminal, data) => { process.stdout.write(data); },
        exit: () => streamClosed(),
      },
    });
    const stop = () => { try { child.kill("SIGTERM"); } catch { /* exit readback decides */ } };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    /** The caller is gone: stop the child now, kill it after a grace period, and exit even if its exit is never reported. */
    const abandon = () => {
      clearInterval(watch);
      stop();
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, PARENT_TERM_GRACE_MS).unref();
      setTimeout(() => process.exit(129), PARENT_HARD_EXIT_MS).unref();
    };
    // A caller that died while Bun.spawn ran has its child stopped at once. Abandoning once is enough: the interval below exists only while the caller is still there, and clears itself the first time it is not.
    if (callerGone()) abandon();
    else watch = setInterval(() => { if (callerGone()) abandon(); }, PARENT_POLL_MS);
    try {
      const code = await child.exited;
      // Drain the PTY before closing it; a descendant holding a slave cannot make the bridge wait forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([eof, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
      if (timer) clearTimeout(timer);
      process.exitCode = code;
    } catch {
      process.exitCode = 125;
    } finally {
      child.terminal?.close();
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    }
  } catch {
    process.exitCode = 125;
  } finally {
    if (watch) clearInterval(watch);
  }
}
export {};
