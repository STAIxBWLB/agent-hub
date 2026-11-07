import { afterEach } from "bun:test";

// #1262: the two staged-runtime fixtures (test/staged-project-isolation.test.ts, test/staged-runtime-daemon.test.ts) replace `process.env` wholesale for the length of one test (PATH becomes a temp bin of
// shims, HOME and AGENTHUB_HOME become temp dirs) and put it back in their `finally`. When such a test times out, Bun reports the failure and starts the next test, and the next FILE, while the
// abandoned body still runs: 315 and 318 tests failed in the macOS shard 4/4 jobs 126798492283 and 126844290747 after #607's 20 s timeout, with "Executable not found in $PATH: git" and a git that
// could not confirm runtime.json is untracked. Two parts keep that from spreading:
//   1. `restoreOnTestEnd` registers the restore with an `afterEach`, which Bun runs at the timeout, before the next test starts. The body's own `finally` still restores too (idempotent).
//   2. A restore never re-applies a snapshot taken from an environment that was not the clean one. `cleanEnvironment()` captures the environment ONCE, when the file loads, before any test of the file can
//      have run, so a fixture that starts while an earlier body still holds its isolated env restores the file's clean snapshot, not the leaked one it found.
const clean = { ...process.env };

/** The process environment as it was when this test file loaded: before any test in it ran, so never an isolated or half-restored one. */
export function cleanEnvironment(): NodeJS.ProcessEnv { return { ...clean }; }

/** Puts `process.env` back to exactly `snapshot`: keys the snapshot lacks are removed, the rest are set. Idempotent. */
export function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  Object.assign(process.env, snapshot);
}

const pending = new Set<() => void>();
afterEach(() => { for (const restore of [...pending]) { pending.delete(restore); restore(); } });

/**
 * Registers `restore` to run when the current test ends, however it ends (a pass, a failure, or Bun's timeout, which abandons the body). Call it right after the environment is replaced.
 * Returns the function to call from the body's own `finally`, which runs it at most once.
 */
export function restoreOnTestEnd(restore: () => void): () => void {
  let done = false;
  const once = () => { if (done) return; done = true; pending.delete(once); restore(); };
  pending.add(once);
  return once;
}
