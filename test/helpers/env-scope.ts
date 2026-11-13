import { afterEach } from "bun:test";

// #1262: the two staged-runtime fixtures (test/staged-project-isolation.test.ts, test/staged-runtime-daemon.test.ts) replace `process.env` wholesale for the length of one test (PATH becomes a temp bin of
// shims, HOME and AGENTHUB_HOME become temp dirs) and put it back in their `finally`. When such a test times out, Bun reports the failure and starts the next test, and the next FILE, while the
// abandoned body still runs: 315 and 318 tests failed in the macOS shard 4/4 jobs 126798492283 and 126844290747 after #607's 20 s timeout, with "Executable not found in $PATH: git" and a git that
// could not confirm runtime.json is untracked. Two parts keep that from spreading:
//   1. A restore registered with an `afterEach` runs at the timeout, before the next test starts. The body's own `finally` still restores too (idempotent).
//   2. A restore never re-applies a snapshot taken from an environment that was not the clean one: `cleanEnvironment()` is captured ONCE, when the module first loads.
//
// A module is evaluated once per process and shared by every test file of a `bun test` run, so an `afterEach` registered as an import side effect binds to the scope of the FIRST file that imports it.
// The shard imports this helper from test/env-scope.test.ts before the staged files, so a hook registered here would never run for them (a three-file child run in test/env-scope.test.ts pins this).
// Each file that uses the helper therefore calls `useEnvironmentScope()` at its own top level, which registers the hook in that file's own scope.
const clean = { ...process.env };

/** The process environment as it was when this module first loaded: before any test that uses it ran, so never an isolated or half-restored one. */
export function cleanEnvironment(): NodeJS.ProcessEnv { return { ...clean }; }

/** Puts `process.env` back to exactly `snapshot`: keys the snapshot lacks are removed, the rest are set. Idempotent. */
export function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  Object.assign(process.env, snapshot);
}

const pending = new Set<() => void>();

/**
 * Call once at the top level of every test file that calls `restoreOnTestEnd`: it registers the `afterEach` in THIS file's scope, so a test of this file that times out has its environment restored
 * before the next test or file starts. Without it `restoreOnTestEnd` throws on first use, so a file cannot forget it silently.
 */
export function useEnvironmentScope(): void {
  afterEach(() => { for (const restore of [...pending]) { pending.delete(restore); restore(); } });
  registered.add(callerFile());
}

const registered = new Set<string>();
function callerFile(): string { return new Error().stack?.split("\n").map(line => /\(?((?:file:\/\/)?\/[^():]+\.test\.ts)/.exec(line)?.[1]).find(Boolean) ?? "unknown"; }

/**
 * Registers `restore` to run when the current test ends, however it ends (a pass, a failure, or Bun's timeout, which abandons the body). Call it right after the environment is replaced.
 * Returns the function to call from the body's own `finally`, which runs it at most once.
 */
export function restoreOnTestEnd(restore: () => void): () => void {
  if (!registered.has(callerFile())) throw new Error("restoreOnTestEnd needs useEnvironmentScope() at the top level of this test file: a hook registered by another file's import does not run for this file's timeouts (#1262)");
  let done = false;
  const once = () => { if (done) return; done = true; pending.delete(once); restore(); };
  pending.add(once);
  return once;
}
