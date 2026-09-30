import { spawn } from "node:child_process";
import { childEnv } from "./child-process.ts";

export interface CheckResult {
  code: number | null;
  timedOut: boolean;
  /** Killed because the hub stopped: not a verdict on the work. */
  interrupted?: boolean;
  /** The last lines of stdout and stderr together, capped. */
  tail: string;
}

const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
const KEEP_CHARS = 64 * 1024;
/** How long output may still arrive after the command exited; a descendant that left the group can hold the pipes. */
const DRAIN_MS = 500;

/** Runs one check command in the project root, in its own process group so a timeout stops what it started. */
export function runCheck(command: string, cwd: string, timeoutMs: number, running?: Set<() => void>): Promise<CheckResult> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let exited = false;
    const child = spawn("sh", ["-c", command], { cwd, env: childEnv(process.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const stop = () => {
      if (exited) return; // finished before the hub stopped: its own result stands
      interrupted = true;
      killGroup();
    };
    running?.add(stop);
    const keep = (chunk: string) => {
      out += chunk;
      if (out.length > KEEP_CHARS) out = out.slice(-KEEP_CHARS);
    };
    for (const s of [child.stdout, child.stderr]) {
      s?.setEncoding("utf8"); // decodes across chunk edges, so Korean output is not cut into U+FFFD
      s?.on("data", keep);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running?.delete(stop);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const tail = out.replace(/\s+$/, "").split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
      resolve({ code: timedOut || interrupted ? null : code, timedOut, ...(interrupted ? { interrupted } : {}), tail });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("exit", (code) => {
      exited = true;
      clearTimeout(timer); // it finished in time; only its output may still be on the way
      killGroup(); // a background job it left behind (sh has no job control, so it is still in the group)
      setTimeout(() => done(code), DRAIN_MS);
    });
    child.on("close", (code) => done(code));
  });
}
