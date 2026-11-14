// #560: a `bun --preload` probe for the PTY bridge, so a test controls what host load only does by chance. Only code reaches it: runPtyWith's launcher names it.
// PTY_PROBE_MODE:
//   spawn-delay   holds the bridge for PTY_PROBE_DELAY_MS right after Bun.spawn returned (the window in which a caller can die), then records the bridge's parent in PTY_PROBE_PPID_LOG
//   spawn-throws  makes Bun.spawn throw, as a failed spawn does
//   exited-never  makes the spawned process's `exited` never settle, as a lost exit does
import { appendFileSync } from "node:fs";

const mode = process.env.PTY_PROBE_MODE ?? "", delay = Number(process.env.PTY_PROBE_DELAY_MS ?? 0);
const realSpawn = Bun.spawn.bind(Bun) as (...args: unknown[]) => { exited: Promise<number> };

(Bun as unknown as { spawn: unknown }).spawn = (...args: unknown[]) => {
  if (mode === "spawn-throws") throw new Error("simulated spawn failure");
  const proc = realSpawn(...args);
  if (mode === "spawn-delay" && delay > 0) {
    Bun.sleepSync(delay);
    // what a caller that died inside the hold looks like from here: the parent this process has now
    if (process.env.PTY_PROBE_PPID_LOG) appendFileSync(process.env.PTY_PROBE_PPID_LOG, `${process.ppid}\n`);
  }
  if (mode === "exited-never") Object.defineProperty(proc, "exited", { get: () => new Promise<number>(() => {}) });
  return proc;
};
