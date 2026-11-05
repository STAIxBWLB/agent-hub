import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, release, totalmem } from "node:os";
import { join } from "node:path";

// #723: a diagnostic for the macOS shard failures of the two fake-ripwire CodeFacts tests. On a hosted PR runner `CodeFacts.neighbours` / `.exists` sometimes answered `unknown` after the
// 5 s per-call cap (or the test hit its 20 s timeout), with the same tests passing on a rerun minutes later. Nothing local reproduced a call near 5 s, so the cause is not named. This helper
// records what would NAME it, and says nothing unless something goes wrong.
//
// What it records for every ripwire call, from marks the fake itself writes (the product is not touched, so the product's own spawn instant is not observable; the marks below bracket it):
//   shim      the `sh` shim began running   (the exec of a freshly written executable has finished: a scan of new files would delay THIS mark)
//   script    the fake's TypeScript began   (Bun's own start-up has finished)
//   output    the fake wrote its first byte (exec-start latency is script -> output; the answer's own work is output -> exit)
//   exit      the fake exited
// and, per call, the gap to the previous call's exit (the product's own work between launches: tree materialization, git) and to `markCall()` for the first call.
// Taken only when something went wrong: a fresh shim of the same shape run twice in a row (first much slower than second = a scan of new executables; both slow = runner load; both fast = the
// stall is not in launching a fresh file), os.loadavg(), cpu count, free memory, the OS release and the Bun version.
//
// The passing path adds nothing visible: one run of the shim by absolute path BEFORE the measured region (the area note's #519 rule; that first exec was already part of the first measured
// call), and four timestamps per call appended to a file in the test's own temp directory. No output, no assertion, no widened bound.

const q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const ms = (value: number) => `${Math.round(value)} ms`;

export interface FixtureProbe {
  /** Directory to prepend to PATH so the product finds the shim. */
  bin: string;
  /** Call right before the product call under test: the first call's lead time is measured from here. */
  markCall(): void;
  /** The text to append to a failure message. Measures the fresh-shim pair only now. */
  diagnose(): Promise<string>;
  /** Arms a timer that prints `diagnose()` to stderr at `afterMs`, before the test's own timeout; returns the disarm function (call it in `finally`). Silent when disarmed in time. */
  watch(afterMs: number, label: string): () => void;
}

/** The verdict line for the fresh-shim pair. Pure, so the discrimination is unit-tested. */
export function freshShimReading(first: number, second: number): string {
  if (first > 3000 && second < 1500) return "the FIRST run of a newly written executable is slow and the second is fast: a scan of newly written executables";
  if (first > 3000 && second >= 1500) return "both runs are slow: runner load or a stalled host";
  if (first < 1500 && second < 1500) return "both runs are fast now: the stall was not in launching a fresh executable; read the recorded calls above (a long shim-to-script gap is Bun's start-up, script-to-output is the fake, a long gap before the shim is the product's own work or the launcher)";
  return "inconclusive: one run between 1.5 s and 3 s";
}

export interface CallMarks { argv: string; shim?: number; script?: number; output?: number; exit?: number }

/** Folds the fake's event log into one record per call. Events of one call arrive shim, script, output, exit in order; calls do not overlap in these fixtures. */
export function foldCalls(events: { event: string; at: number; argv?: string }[]): CallMarks[] {
  const calls: CallMarks[] = [];
  let open: CallMarks | undefined;
  for (const entry of events) {
    if (entry.event === "shim") { open = { argv: "", shim: entry.at }; calls.push(open); continue; }
    if (entry.event === "script") { if (!open || open.script !== undefined) { open = { argv: "" }; calls.push(open); } open.script = entry.at; open.argv = entry.argv ?? ""; continue; }
    if (!open) { open = { argv: entry.argv ?? "" }; calls.push(open); }
    if (entry.event === "output" && open.output === undefined) open.output = entry.at;
    if (entry.event === "exit") { open.exit = entry.at; open = undefined; }
  }
  return calls;
}

/**
 * Write the fake and the shim that runs it, run the shim once by absolute path outside the measured region (#519), and return the probe.
 * `fakeSource` is the fake ripwire's own TypeScript, run UNCHANGED after a few lines that stamp the marks; its output and exit code are what they were (`test/ripwire-probe.test.ts` proves it).
 */
export function installFakeRipwire(root: string, bin: string, fakeSource: string): FixtureProbe {
  const fake = join(root, "fake.ts"), log = join(root, "ripwire-marks.log"), executable = join(bin, "ripwire");
  writeFileSync(fake, `import { appendFileSync } from "node:fs";
const mark = (event) => { try { appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, at: Date.now(), argv: process.argv.slice(2).join(" ").slice(0, 60) }) + "\\n"); } catch {} };
mark("script");
let wrote = false; const note = () => { if (!wrote) { wrote = true; mark("output"); } };
const out = process.stdout.write.bind(process.stdout); process.stdout.write = (...args) => { note(); return out(...args); };
const say = console.log; console.log = (...args) => { note(); return say(...args); };
process.on("exit", () => mark("exit"));
${fakeSource}
`);
  // The shim stamps its own start with the clock of a file it touches: `sh` has no millisecond clock, but the file's mtime does, and it is read back with ms precision below.
  const stampDir = join(root, "shim-stamps");
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(executable, `#!/bin/sh\n: > "${stampDir}/$$"\nexec ${q(process.execPath)} ${q(fake)} "$@"\n`);
  chmodSync(executable, 0o755);
  const wroteAt = Date.now();
  Bun.spawnSync([executable, "--version"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });   // the area note's rule (#519): the first exec of a new file runs outside the measured region
  const firstExecAt = Date.now() + 1;   // +1: a mark stamped in the same millisecond as the warm-up's exit still belongs to the warm-up
  let calledAt: number | undefined, diagnosed: string | undefined;

  const events = async (): Promise<{ event: string; at: number; argv?: string }[]> => {
    const out: { event: string; at: number; argv?: string }[] = [];
    try { for (const line of (await Bun.file(log).text()).split("\n").filter(Boolean)) out.push(JSON.parse(line)); } catch { /* no log yet: the fake never started */ }
    try { const fs = require("node:fs") as typeof import("node:fs"); for (const name of fs.readdirSync(stampDir)) out.push({ event: "shim", at: statSync(join(stampDir, name)).mtimeMs }); } catch { /* none */ }
    // The run by absolute path above is the warm-up (#519), not a call of the test: its marks are dropped.
    return out.filter(entry => entry.at >= firstExecAt).sort((a, b) => a.at - b.at);
  };

  const diagnose = async (): Promise<string> => {
    if (diagnosed !== undefined) return diagnosed;
    const lines: string[] = [];
    const calls = foldCalls(await events());
    lines.push(`[#723 ripwire diagnostics] ${calls.length} fake ripwire launch(es) recorded by the shim and the fake (the product's own spawn instant is not observable, so each phase is the gap between two marks):`);
    let previousExit = calledAt;
    for (const [index, call] of calls.entries()) {
      const gap = (from: number | undefined, to: number | undefined) => from !== undefined && to !== undefined ? ms(to - from) : "never";
      lines.push(`  #${index + 1} ${call.argv || "(unknown args)"}: before-shim ${gap(previousExit, call.shim)} | shim->script (Bun start-up) ${gap(call.shim, call.script)} | script->first output ${gap(call.script, call.output)} | output->exit ${gap(call.output, call.exit)}${call.exit === undefined ? " (no exit mark: it never finished)" : ""}`);
      if (call.exit !== undefined) previousExit = call.exit;
    }
    lines.push(`  the shim was run once by path ${ms(firstExecAt - wroteAt)} after it was written, before the test measured anything`);
    try {
      const probeDir = join(root, "probe-exec");
      mkdirSync(probeDir, { recursive: true });
      const script = join(probeDir, "p.ts"), shim = join(probeDir, "p");
      writeFileSync(script, `console.log("ok");`);
      writeFileSync(shim, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`); chmodSync(shim, 0o755);
      const time = () => { const t = performance.now(); Bun.spawnSync([shim]); return performance.now() - t; };
      const first = time(), second = time();
      lines.push(`  a fresh shim of the same shape, run twice right now: first ${ms(first)}, second ${ms(second)}`);
      lines.push(`  reading: ${freshShimReading(first, second)}`);
    } catch (error) { lines.push(`  fresh-shim probe failed: ${(error as Error).message}`); }
    lines.push(`  loadavg ${loadavg().map(n => n.toFixed(1)).join(" ")} on ${cpus().length} cpus, free ${Math.round(freemem() / 1e6)} of ${Math.round(totalmem() / 1e6)} MB, os ${process.platform} ${release()}, bun ${Bun.version}`);
    diagnosed = lines.join("\n");
    return diagnosed;
  };

  const watch = (afterMs: number, label: string): (() => void) => {
    const timer = setTimeout(() => { void diagnose().then(text => console.error(`${label}: still running ${afterMs} ms in, before the test's own timeout.\n${text}`)); }, afterMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  };
  return { bin, markCall: () => { calledAt = Date.now(); }, diagnose, watch };
}

/**
 * Runs `body`; if it throws, appends the probe's report to the SAME error's message and rethrows that error, so the assertion, its diff and its stack are what they were.
 * A body that passes returns its value and the probe is never asked for anything.
 */
export async function withProbe<T>(probe: FixtureProbe, body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) {
    if (error instanceof Error) {
      try { error.message = `${error.message}\n${await probe.diagnose()}`; } catch { /* diagnostics never replace the failure they describe */ }
    }
    throw error;
  }
}
