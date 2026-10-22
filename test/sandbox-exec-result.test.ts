import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { realPath } from "../src/hub/project.ts";
import { sbplString } from "../src/local/deny.ts";
import type { sandboxedExec } from "../src/local/sandbox.ts";

function execution() {
  const source = readFileSync(join(import.meta.dir, "../src/local/sandbox.ts"), "utf8");
  // Keep the actual availability gate and execution policy; replace only OS/process/clock ports.
  const constants = source.slice(source.indexOf("const SANDBOX_EXEC ="), source.indexOf("const q ="));
  const start = source.indexOf("export function sandboxedExec(");
  const body = source.slice(start, source.indexOf("/** The environment", start));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`${constants}\n${body}`.replace(/export /g, ""));
  const killed: Array<{ pid: number; signal: string }> = [];
  const timers: Array<{ run: () => void; ms: number; cleared: boolean; unref(): unknown }> = [];
  const dirs: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123456789, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(signal: string) { killed.push({ pid: this.pid, signal }); return true; },
  });
  const run = runInNewContext(`${code}\nsandboxedExec`, {
    Buffer, join, homedir, tmpdir, realPath, q: sbplString, rmSync,
    existsSync: (file: string) => file === "/usr/bin/sandbox-exec",
    mkdtempSync: (prefix: string) => { const dir = mkdtempSync(prefix); dirs.push(dir); return dir; },
    process: { platform: "darwin", env: {}, kill: (pid: number, signal: string) => { killed.push({ pid, signal }); } },
    spawn: () => child,
    spawnSync: () => { throw new Error("fixture must not spawn a cleanup command"); },
    setTimeout: (run: () => void, ms: number) => {
      const timer = { run, ms, cleared: false, unref() { return this; } }; timers.push(timer); return timer;
    },
    clearTimeout: (timer: typeof timers[number]) => { timer.cleared = true; },
  }) as typeof sandboxedExec;
  return { run, child, killed, timers, close: () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); } };
}

for (const cause of ["timeout", "abort"] as const) test(`sandbox host ${cause} keeps its marker when bash exits 137 with no signal`, async () => {
  const f = execution(), controller = new AbortController();
  try {
    const result = f.run(["/bin/bash", "-c", "sleep 30"], { cwd: tmpdir(), profile: "(version 1)", timeoutMs: 300, signal: controller.signal });
    if (cause === "timeout") f.timers.find(timer => timer.ms === 300)!.run();
    else controller.abort();
    f.child.stderr.emit("data", Buffer.from("/bin/bash: line 1: 42 Killed: 9 sleep 30"));
    f.child.emit("close", 137, null);
    const stopped = await result;
    expect(stopped.code).toBe(137);
    expect(stopped.output).toContain("Killed: 9 sleep 30");
    expect(stopped.output).toContain("(killed:");
    expect(f.killed).toEqual([{ pid: -f.child.pid, signal: "SIGKILL" }]);
    expect(f.timers.find(timer => timer.ms === 300)?.cleared).toBe(true);
  } finally { f.close(); }
});

test("post-exit pipe cleanup alone does not label a normal exit 137 as a host timeout", async () => {
  const f = execution();
  try {
    const result = f.run(["/bin/bash", "-c", "exit 137"], { cwd: tmpdir(), profile: "(version 1)", timeoutMs: 300 });
    f.child.stderr.emit("data", Buffer.from("normal command output"));
    f.child.emit("exit", 137, null);
    f.timers.find(timer => timer.ms === 500)!.run();
    const finished = await result;
    expect(finished).toEqual({ code: 137, output: "normal command output" });
    expect(f.killed).toEqual([{ pid: -f.child.pid, signal: "SIGKILL" }]);
  } finally { f.close(); }
});
