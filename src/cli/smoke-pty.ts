import { join } from "node:path";
import { spawn } from "node:child_process";
import { shellQuote } from "./shell-quote.ts";
import type { ChildProcess } from "node:child_process";
import { stopOwnedProcess, trackGroup } from "../hub/child-process.ts";

export const MAX_PTY_OUTPUT_BYTES = 1024 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const SCRIPT = "/usr/bin/script";
const PTY_COMMAND = '/bin/stty rows 40 cols 120 || exit 125; exec "$@"';

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  ready?: () => Promise<void>;
}

export interface PtyResult {
  outcome: "exited" | "completed" | "timeout" | "aborted" | "failed";
  exitCode: number | null;
  outputBytes: number;
  elapsedMs: number;
  cleaned: boolean;
}

type Outcome = PtyResult["outcome"];
type Winner = { outcome: Outcome };


function commandFor(argv: readonly string[]): string[] {
  const command = process.platform === "darwin"
    ? [process.execPath, join(import.meta.dir, "smoke-pty-bridge.ts"), ...argv]
    : [SCRIPT, "-q", "-e", "-f", "-c", ["/bin/sh", "-c", PTY_COMMAND, "ahub-pty", ...argv].map(shellQuote).join(" "), "/dev/null"];
  return command;
}

function validate(argv: readonly string[], options: PtyOptions): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || !argv[0]) throw new Error("invalid PTY command");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) throw new Error("invalid PTY timeout");
  if (typeof options.cwd !== "string" || !options.cwd || !options.env || typeof options.env !== "object") throw new Error("invalid PTY environment");
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("PTY smoke runner is unsupported on this platform");
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null }> {
  return new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve({ code: proc.exitCode }); return; }
    proc.once("exit", code => resolve({ code }));
    proc.once("error", () => resolve({ code: null }));
  });
}

/** Run an argv vector inside a fixed-size PTY, always stopping its owned process group before returning. */
export async function runPty(argv: readonly string[], options: PtyOptions): Promise<PtyResult> {
  validate(argv, options);
  const started = Date.now();
  if (options.signal?.aborted) return { outcome: "aborted", exitCode: null, outputBytes: 0, elapsedMs: Date.now() - started, cleaned: true };

  let proc: ChildProcess;
  try {
    const command = commandFor(argv);
    proc = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: { ...options.env, TERM: "xterm-256color" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("PTY process could not be started");
  }
  trackGroup(proc);
  const closed = new Promise<void>(resolve => proc.once("close", () => resolve()));

  let outputBytes = 0, outputFailure: Error | undefined;
  const drain = (chunk: Buffer) => {
    outputBytes += chunk.length;
    const room = Math.max(0, MAX_PTY_OUTPUT_BYTES - (outputBytes - chunk.length));
    if (room > 0 && options.onOutput) {
      try { options.onOutput(chunk.subarray(0, Math.min(room, chunk.length))); }
      catch { outputFailure = new Error("PTY output handler failed"); }
    }
    if (outputBytes > MAX_PTY_OUTPUT_BYTES) outputFailure = new Error("PTY output exceeded 1 MiB");
  };
  proc.stdout?.on("data", drain);
  proc.stderr?.on("data", drain);

  let exitCode: number | null = null;
  const exited = waitForExit(proc).then(value => { exitCode = value.code; return { outcome: "exited" as const }; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<Winner>(resolve => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), options.timeoutMs);
    options.signal?.addEventListener("abort", abortListener = () => resolve({ outcome: "aborted" }), { once: true });
    if (options.signal?.aborted) resolve({ outcome: "aborted" });
  });
  const spawned = new Promise<void>((resolve, reject) => {
    if (proc.pid !== undefined) { resolve(); return; }
    proc.once("spawn", () => resolve());
    proc.once("error", () => reject());
  });

  let winner: Winner;
  let cleaned = false;
  try {
    const beforeStart = await Promise.race([spawned.then(() => ({ outcome: "started" as const })), interrupted]);
    if (beforeStart.outcome !== "started") winner = beforeStart;
    else if (proc.exitCode !== null || proc.signalCode !== null) winner = { outcome: "exited" };
    else {
      const ready = options.ready ? Promise.resolve().then(async (): Promise<Winner> => {
        if (proc.exitCode !== null || proc.signalCode !== null) return { outcome: "exited" as const };
        await options.ready!();
        return { outcome: "completed" };
      }).catch(() => ({ outcome: "failed" as const })) : undefined;
      const failures = new Promise<Winner>(resolve => {
        const check = () => { if (outputFailure) resolve({ outcome: "failed" }); };
        proc.stdout?.on("data", check);
        proc.stderr?.on("data", check);
        check();
      });
      winner = await Promise.race([exited, interrupted, failures, ...(ready ? [ready] : [])]);
    }
  } catch {
    winner = { outcome: "failed" };
  }

  if (timer) clearTimeout(timer);
  if (abortListener) options.signal?.removeEventListener("abort", abortListener);
  if (proc.pid === undefined) await spawned.catch(() => {});
  try {
    await stopOwnedProcess(proc, { group: true });
    cleaned = true;
  } catch {
    cleaned = false;
  }
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closed, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 250); })]);
  if (closeTimer) clearTimeout(closeTimer);
  // The owned-group stop drops pipes, but the close event is only a bounded best-effort drain barrier.
  if (outputFailure) winner = { outcome: "failed" };
  if (!cleaned && winner.outcome !== "timeout" && winner.outcome !== "aborted") winner = { outcome: "failed" };
  return { outcome: winner.outcome, exitCode: exitCode ?? proc.exitCode, outputBytes, elapsedMs: Date.now() - started, cleaned };
}
