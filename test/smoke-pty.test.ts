import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MAX_PTY_OUTPUT_BYTES, runPty, runPtyWith } from "../src/cli/smoke-pty.ts";

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

// ---- #560: the bridge is stopped with everything it started, and a bridge whose caller died does not run on ----
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
const waitFor = async (what: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end && !what(); ) await Bun.sleep(25); return what(); };
const BRIDGE = join(import.meta.dir, "../src/cli/smoke-pty-bridge.ts");

test("an injected bridge that ignores SIGTERM, never exits and has a descendant is killed with it on timeout, and cleaned is true only then", async () => {
  const cwd = temp(), pids = join(cwd, "pids");
  // The stand-in bridge: a hung process (SIGTERM ignored, no output, no exit) with a child in its own process group and a grandchild in another one. Nothing here depends on host load.
  const stub = join(cwd, "hung-bridge.sh");
  writeFileSync(stub, ["#!/bin/sh", "trap '' TERM", "(trap '' TERM; echo $$ >> \"$PIDS\"; while :; do sleep 1; done) &", "echo $$ >> \"$PIDS\"", "while :; do sleep 1; done", ""].join("\n"));
  chmodSync(stub, 0o755);
  const result = await runPtyWith(() => [stub], ["unused"], options(cwd, { env: { ...options(cwd).env, PIDS: pids }, timeoutMs: 700 }));
  expect(result.outcome).toBe("timeout");
  expect(result.outputBytes).toBe(0);
  expect(result.cleaned).toBe(true);
  const recorded = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  expect(recorded.length).toBe(2);
  // cleaned: true is a claim about every process the bridge started: none of them is alive.
  for (const pid of recorded) expect(alive(pid), `pid ${pid} survived a result that said cleaned`).toBe(false);
}, 20_000);

test("the real bridge stops its terminal child when its caller is killed: neither the bridge nor the child outlives the caller", async () => {
  const cwd = temp(), mark = `pty560-${process.pid}-${Date.now()}`, pidFile = join(cwd, "bridge.pid");
  const caller = [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs')",
    `const p = spawn(process.execPath, [${JSON.stringify(BRIDGE)}, process.execPath, '-e', '/*${mark}*/ setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })`,
    "p.stdout.resume(); p.stderr.resume()",
    `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("; ");
  const callerProc = spawn(process.execPath, ["-e", caller], { stdio: "ignore" });
  const members = () => Bun.spawnSync(["ps", "-eo", "pid=,command="]).stdout.toString().split("\n").filter(line => line.includes(mark) || (existsSync(pidFile) && new RegExp(`^\\s*${readFileSync(pidFile, "utf8")}\\s`).test(line))).map(line => Number(line.trim().split(/\s+/)[0]));
  try {
    // the bridge and its child are up: both are found by the marker or the bridge's own pid
    expect(await waitFor(() => existsSync(pidFile) && members().length >= 2, 10_000)).toBe(true);
    const up = members();
    callerProc.kill("SIGKILL");
    expect(await waitFor(() => !up.some(alive), 10_000), `still alive after the caller died: ${up.filter(alive).join(", ")}`).toBe(true);
  } finally {
    callerProc.kill("SIGKILL");
    for (const pid of members()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}, 40_000);

// The bridge, and so its gate, is the macOS launcher: Linux runs the child under script(1) and never starts the bridge.
test.skipIf(process.platform !== "darwin")("the bridge starts its child behind a gate that is opened once Bun.spawn has returned, keeps a fast child's output and exit code, and removes the gate afterwards", async () => {
  const cwd = temp(), tmp = join(cwd, "tmp");
  mkdirSync(tmp);
  const gates = () => readdirSync(tmp).filter(name => name.startsWith("ahub-pty-gate-"));
  const env = { ...options(cwd).env, TMPDIR: tmp };
  // while a child runs: the gate directory exists and its file is there, so the child was released by the bridge and not by a timeout
  let during: string[] = [], released = false;
  const running = await runPty([process.execPath, "-e", "setInterval(() => {}, 1000)"], options(cwd, { env, ready: async () => {
    // ready fires as soon as the bridge process exists, before Bun has started it: wait for the gate file the bridge writes after Bun.spawn returned
    await waitFor(() => gates().length === 1 && existsSync(join(tmp, gates()[0]!, "open")), 10_000);
    during = gates(); released = during.length === 1 && existsSync(join(tmp, during[0]!, "open"));
  } }));
  expect(running.outcome).toBe("completed");
  expect(during).toHaveLength(1);
  expect(released).toBe(true);
  expect(gates()).toEqual([]);
  // a child that writes and exits at once keeps its output and code through the gate
  for (let i = 0; i < 5; i++) {
    let output = "";
    const result = await runPty(["/bin/sh", "-c", "printf gated; exit 3"], options(cwd, { env, onOutput: chunk => { output += chunk.toString(); } }));
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(3);
    expect(output).toContain("gated");
    expect(result.cleaned).toBe(true);
  }
  expect(gates()).toEqual([]);
}, 40_000);

test("the bridge refuses a missing command with 125 and starts nothing", async () => {
  const cwd = temp();
  const result = await runPtyWith(() => [process.execPath, BRIDGE], ["x"], options(cwd));
  expect(result.outcome).toBe("exited");
  expect(result.exitCode).toBe(125);
  expect(result.cleaned).toBe(true);
});
