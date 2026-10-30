// macOS script(1) requires a terminal on its own stdin, including when its child gets a PTY.
// Keep a real PTY in this owned bridge instead; the outer Node child remains tracked by stopOwnedProcess.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #560: Bun up to 1.4.3 can hang for good inside `Bun.spawn({ terminal })` on macOS when the child writes and starts exiting before the call returns (oven-sh/bun#45300, fixed in 1.4.4): the
 * event loop thread blocks in wait4 while the exiting session leader waits for that same thread to drain its pty. Measured here with a bare Bun script and no agent-hub code: 26 of 96 runs hung
 * at 12 in parallel on 1.4.3 and 0 of 180 on 1.4.4. The child therefore starts behind a gate: a shell that waits for a file the bridge writes right after `Bun.spawn` has returned, then `exec`s the
 * real command (same pid, same session, same terminal). The wait has no bound of its own: a bridge that dies before it opens the gate closes the pty, which hangs the shell up (the trap below), and a bridge
 * that is alive but never opens it is a hung bridge, which `runPty` stops with its group.
 * ponytail: ceiling and upgrade path. The gate exists only because of oven-sh/bun#45300 on Bun up to 1.4.3 (this repo pins 1.4.2 in `.bun-version`); the upgrade path is to delete GATE_SCRIPT, `gate` and `gateDir` once the pinned Bun is 1.4.4 or newer, which is its own task because it
 * touches CI and every OS leg. The parent-death stop below stays whatever the Bun version: an orphaned bridge is this repository's bug, not Bun's. The gate costs about one shell start (a few ms).
 */
// The shell removes its own gate (file, then directory) once released and when it is hung up or terminated (a bridge killed with SIGKILL runs no cleanup, and the pty closing
// sends the shell SIGHUP), so no path leaves a directory behind. `exec` resets the traps for the real command.
const GATE_SCRIPT = 'd=${0%/*}; trap "rm -f \\"$0\\"; rmdir \\"$d\\" 2>/dev/null; exit 125" HUP TERM INT; while [ ! -e "$0" ]; do sleep 0.01; done; rm -f "$0"; rmdir "$d" 2>/dev/null; exec "$@"';
/** A bridge whose caller died is stopped instead of running on: its child holds a terminal nobody reads and, under launchd, nothing else would ever stop it. */
const PARENT_POLL_MS = 250;
const PARENT_TERM_GRACE_MS = 1_000;
const PARENT_HARD_EXIT_MS = 3_000;

// The caller is whoever started this bridge, read before anything that can take time: a caller that dies while `Bun.spawn` runs (the window #45300 widens) has already reparented this process by the
// time the call returns, and a parent read after it would be launchd and never change.
const parent = process.ppid;
const callerGone = (): boolean => process.ppid !== parent;
const argv = process.argv.slice(2);
if (!argv.length) {
  process.exitCode = 125;
} else {
  let streamClosed!: () => void;
  const eof = new Promise<void>(resolve => { streamClosed = resolve; });
  const gateDir = process.platform === "darwin" ? mkdtempSync(join(tmpdir(), "ahub-pty-gate-")) : undefined;
  const gate = gateDir ? join(gateDir, "open") : undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const child = Bun.spawn(gate ? ["/bin/sh", "-c", GATE_SCRIPT, gate, ...argv] : argv, {
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
    let abandoned = false;
    const abandon = () => {
      if (abandoned) return;
      abandoned = true;
      clearInterval(watch);
      stop();
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, PARENT_TERM_GRACE_MS).unref();
      setTimeout(() => process.exit(129), PARENT_HARD_EXIT_MS).unref();
    };
    // A caller that died while Bun.spawn ran never gets its command run: the gate stays shut and the gate shell takes the SIGTERM (its trap removes the gate and exits).
    if (callerGone()) abandon();
    else if (gate) writeFileSync(gate, "");
    watch = setInterval(() => { if (callerGone()) abandon(); }, PARENT_POLL_MS);
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
    if (gateDir) rmSync(gateDir, { recursive: true, force: true });
  }
}
export {};
