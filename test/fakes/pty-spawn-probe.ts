// #560: a `bun --preload` probe for the PTY bridge, so a test controls what host load only does by chance. Only code reaches it: runPtyWith's launcher names it.
// PTY_PROBE_LOG: file the probe appends its observations to. PTY_PROBE_MODE:
//   spawn-delay   records whether the bridge's gate file exists when Bun.spawn is ENTERED and when it RETURNED, holds the bridge for PTY_PROBE_DELAY_MS before it can open the gate, then records whether the
//                 child has already created PTY_PROBE_MARKER (a child that did not wait for the gate has)
//   spawn-throws  makes Bun.spawn throw, as a failed spawn does
//   exited-never  makes the spawned process's `exited` never settle, as a lost exit does
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.PTY_PROBE_MODE ?? "", log = process.env.PTY_PROBE_LOG, delay = Number(process.env.PTY_PROBE_DELAY_MS ?? 0);
const note = (line: string) => { if (log) appendFileSync(log, line + "\n"); };
// Only the directory the test handed this run as TMPDIR: a gate directory a different run left behind cannot be mistaken for this one.
const gateOpen = () => { const base = process.env.TMPDIR || tmpdir(); return readdirSync(base).some(name => name.startsWith("ahub-pty-gate-") && existsSync(join(base, name, "open"))); };
const realSpawn = Bun.spawn.bind(Bun) as (...args: unknown[]) => { exited: Promise<number> };

(Bun as unknown as { spawn: unknown }).spawn = (...args: unknown[]) => {
  note(`enter gate=${gateOpen() ? "open" : "absent"}`);
  if (mode === "spawn-throws") throw new Error("simulated spawn failure");
  const proc = realSpawn(...args);
  note(`returned gate=${gateOpen() ? "open" : "absent"}`);
  if (mode === "spawn-delay" && delay > 0) { Bun.sleepSync(delay); note(`after-delay child=${process.env.PTY_PROBE_MARKER && existsSync(process.env.PTY_PROBE_MARKER) ? "ran" : "waiting"}`); }
  if (mode === "exited-never") Object.defineProperty(proc, "exited", { get: () => new Promise<number>(() => {}) });
  return proc;
};
