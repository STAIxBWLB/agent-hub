import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PTY_OUTPUT_BYTES, runPty } from "../src/cli/smoke-pty.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-smoke-pty-")); dirs.push(dir); return dir; };
const options = (cwd: string, patch: Partial<Parameters<typeof runPty>[1]> = {}) => ({
  cwd,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C", TERM: "dumb" },
  timeoutMs: 5_000,
  ...patch,
});

test("PTY runner captures output and returns a completed exit", async () => {
  const cwd = temp(), chunks: Buffer[] = [];
  const result = await runPty([process.execPath, "-e", "process.stdout.write('pty-ready'); process.exit(0)"], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(0);
  expect(result.outputBytes).toBeGreaterThan(0);
  expect(Buffer.concat(chunks).toString()).toContain("pty-ready");
  expect(result.cleaned).toBe(true);
});

test("ready callback completion stops the process group and reports completed", async () => {
  const cwd = temp();
  const result = await runPty([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, { ready: async () => {} }));
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
  const result = await runPty(["/bin/echo", literal], options(cwd, { onOutput: chunk => { output += chunk.toString(); } }));
  expect(result.outcome).toBe("exited");
  expect(result.cleaned).toBe(true);
  expect(output).toContain(literal);
  expect(existsSync(marker)).toBe(false);
});

test("output over the bounded callback cap fails after cleanup", async () => {
  const cwd = temp();
  let delivered = 0;
  const code = `process.stdout.write('x'.repeat(${MAX_PTY_OUTPUT_BYTES + 1}))`;
  const result = await runPty([process.execPath, "-e", code], options(cwd, { onOutput: chunk => { delivered += chunk.length; } }));
  expect(result.outcome).toBe("failed");
  expect(result.cleaned).toBe(true);
  expect(delivered).toBeLessThanOrEqual(MAX_PTY_OUTPUT_BYTES);
});

test("output callback failure returns a cleaned failed result without exposing its error", async () => {
  const cwd = temp();
  const result = await runPty(["/bin/echo", "data"], options(cwd, { onOutput: () => { throw new Error("private callback detail"); } }));
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
  const result = await runPty([process.execPath, "-e", code], options(cwd, { onOutput: chunk => chunks.push(Buffer.from(chunk)) }));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(7);
  expect(result.cleaned).toBe(true);
  expect(JSON.parse(Buffer.concat(chunks).toString().trim())).toEqual({ tty: true, cols: 120, rows: 40 });
});
