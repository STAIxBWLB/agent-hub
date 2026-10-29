import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PTY_OUTPUT_BYTES, runPty } from "../src/cli/smoke-pty.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-smoke-pty-")); dirs.push(dir); return dir; };
/**
 * #559: on macOS the PTY bridge (src/cli/smoke-pty-bridge.ts) is a Bun process that calls `Bun.spawn` with a `terminal`. Under load that process sometimes never gets past the spawn: it sits in
 * wait4 before the child exists (no output, no child process, no marker after the spawn call), so `runPty` ends at its own timeout with `outcome: "timeout"` and `outputBytes: 0` however long that
 * timeout is. Measured on a 18-core Mac: 0 of 60 runs hang at 4 parallel, 13 of 60 at 12 parallel (60 s later it is still hung), and a plain no-op bun script never hangs at 40 parallel, so it is the
 * spawn-with-terminal path and not process startup in general; the hosted macOS shards (about 1.5 times slower than the old single leg) hit it once in PR #960 run 40856337158. A longer timeout cannot
 * help a process that never starts. So a run that ended as `timeout` having produced NO output at all is run once more: for the commands these tests run (echo, a node one-liner that prints, a
 * child that must start before `ready` fires) a timeout with zero output is never the outcome under test. The timeout tests do not use this: their property is the timeout.
 * ponytail: a second attempt, not a fix of the bridge. The upgrade path is the product: find and remove the hang in the bridge or in Bun, then delete this helper.
 */
type PtyRun = typeof runPty;
async function runStarted(argv: readonly string[], patch: Parameters<PtyRun>[1], run: PtyRun = runPty): Promise<Awaited<ReturnType<PtyRun>>> {
  const first = await run(argv, patch);
  if (first.outcome !== "timeout" || first.outputBytes !== 0) return first;
  // The discarded attempt keeps the cleanup guarantee: `runPty` may report a timeout with `cleaned: false` (its owned process group not confirmed stopped), and a successful second attempt must not hide that.
  expect(first.cleaned, "the first attempt's owned process group must be confirmed stopped before a retry").toBe(true);
  return run(argv, patch);
}
const options = (cwd: string, patch: Partial<Parameters<typeof runPty>[1]> = {}) => ({
  cwd,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C", TERM: "dumb" },
  timeoutMs: 5_000,
  ...patch,
});

test("PTY runner captures output and returns a completed exit", async () => {
  const cwd = temp(), chunks: Buffer[] = [];
  const result = await runStarted([process.execPath, "-e", "process.stdout.write('pty-ready'); process.exit(0)"], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(0);
  expect(result.outputBytes).toBeGreaterThan(0);
  expect(Buffer.concat(chunks).toString()).toContain("pty-ready");
  expect(result.cleaned).toBe(true);
});

test("ready callback completion stops the process group and reports completed", async () => {
  const cwd = temp();
  const result = await runStarted([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, { ready: async () => {} }));
  expect(result.outcome).toBe("completed");
  expect(result.cleaned).toBe(true);
});

test("timeout cleans up a child and its detached descendant", async () => {
  const cwd = temp(), pidFile = join(cwd, "descendant.pid");
  const code = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
    "writeFileSync(process.env.PTY_DESCENDANT_PID, String(child.pid))",
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const result = await runPty([process.execPath, "-e", code], options(cwd, {
    env: { ...options(cwd).env, PTY_DESCENDANT_PID: pidFile },
    timeoutMs: 500,
    ready: async () => {
      const end = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      await new Promise<void>(() => {});
    },
  }));
  expect(result.outcome).toBe("timeout");
  expect(result.cleaned).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
  expect(alive).toBe(false);
});

test("argv metacharacters stay literal inside the PTY", async () => {
  const cwd = temp(), marker = join(cwd, "executed");
  let output = "";
  const literal = `; touch ${marker}; echo 'quoted'`;
  const result = await runStarted(["/bin/echo", literal], options(cwd, { onOutput: chunk => { output += chunk.toString(); } }));
  expect(result.outcome).toBe("exited");
  expect(result.cleaned).toBe(true);
  expect(output).toContain(literal);
  expect(existsSync(marker)).toBe(false);
});

test("output over the bounded callback cap fails after cleanup", async () => {
  const cwd = temp();
  let delivered = 0;
  const code = `process.stdout.write('x'.repeat(${MAX_PTY_OUTPUT_BYTES + 1}))`;
  const result = await runStarted([process.execPath, "-e", code], options(cwd, { onOutput: chunk => { delivered += chunk.length; } }));
  expect(result.outcome).toBe("failed");
  expect(result.cleaned).toBe(true);
  expect(delivered).toBeLessThanOrEqual(MAX_PTY_OUTPUT_BYTES);
});

test("output callback failure returns a cleaned failed result without exposing its error", async () => {
  const cwd = temp();
  const result = await runStarted(["/bin/echo", "data"], options(cwd, { onOutput: () => { throw new Error("private callback detail"); } }));
  expect(result.outcome).toBe("failed");
  expect(result.cleaned).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private callback detail");
});

test("invalid timeout is refused before the command starts", async () => {
  const cwd = temp(), marker = join(cwd, "started");
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  await expect(runPty([process.execPath, "-e", code], options(cwd, { timeoutMs: 99 }))).rejects.toThrow("invalid PTY timeout");
  expect(existsSync(marker)).toBe(false);
});

test("an abort signal stops the owned process group", async () => {
  const cwd = temp(), controller = new AbortController();
  const resultPromise = runPty([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, {
    signal: controller.signal,
    ready: async () => { controller.abort(); },
  }));
  const result = await resultPromise;
  expect(result.outcome).toBe("aborted");
  expect(result.cleaned).toBe(true);
});

test("PTY gives the child a real fixed-size terminal and preserves a nonzero exit code", async () => {
  const cwd = temp(), chunks: Buffer[] = [];
  const code = "console.log(JSON.stringify({tty:!!process.stdin.isTTY&&!!process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows}));process.exit(7)";
  const result = await runStarted([process.execPath, "-e", code], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(7);
  expect(result.cleaned).toBe(true);
  expect(JSON.parse(Buffer.concat(chunks).toString().trim())).toEqual({ tty: true, cols: 120, rows: 40 });
});

// runStarted's own contract (#559): a retry only for a timeout with no output, and never past a first attempt whose owned process group was not confirmed stopped.
test("runStarted retries a no-output timeout once, keeps every other result, and refuses to retry past an unconfirmed cleanup", async () => {
  const result = (patch: Partial<Awaited<ReturnType<PtyRun>>>) => ({ outcome: "exited" as const, exitCode: 0, outputBytes: 1, elapsedMs: 1, cleaned: true, ...patch });
  const script = (...results: ReturnType<typeof result>[]) => { const calls: number[] = []; const run = (async () => { calls.push(calls.length); return results[calls.length - 1]!; }) as PtyRun; return { run, calls }; };
  const opts = options("/tmp");
  // a normal result is returned as it is, with one call
  let s1 = script(result({}));
  expect((await runStarted(["x"], opts, s1.run)).outcome).toBe("exited"); expect(s1.calls).toHaveLength(1);
  // a timeout that produced output is a real timeout: not retried
  s1 = script(result({ outcome: "timeout", outputBytes: 5 }), result({}));
  expect((await runStarted(["x"], opts, s1.run)).outcome).toBe("timeout"); expect(s1.calls).toHaveLength(1);
  // a timeout with no output and a confirmed cleanup is retried exactly once, and the second result is returned
  s1 = script(result({ outcome: "timeout", outputBytes: 0 }), result({ outcome: "exited", exitCode: 3 }));
  expect(await runStarted(["x"], opts, s1.run)).toMatchObject({ outcome: "exited", exitCode: 3 }); expect(s1.calls).toHaveLength(2);
  // the second attempt's own timeout is returned, not retried again
  s1 = script(result({ outcome: "timeout", outputBytes: 0 }), result({ outcome: "timeout", outputBytes: 0 }), result({}));
  expect((await runStarted(["x"], opts, s1.run)).outcome).toBe("timeout"); expect(s1.calls).toHaveLength(2);
  // a no-output timeout whose cleanup was NOT confirmed is never retried: the unconfirmed process group would be hidden by a clean second attempt
  s1 = script(result({ outcome: "timeout", outputBytes: 0, cleaned: false }), result({}));
  await expect(runStarted(["x"], opts, s1.run)).rejects.toThrow("owned process group must be confirmed stopped"); expect(s1.calls).toHaveLength(1);
});
