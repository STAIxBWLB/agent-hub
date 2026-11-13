import { spawn, type ChildProcess } from "node:child_process";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import type { Envelope } from "../hub/envelope.ts";

export interface OwnedInputContext { readonly sessionId: string; readonly inputId: string }
export type OwnedInputObserver = (context: OwnedInputContext, envs: readonly Envelope[]) => void;

export class PrintChildCleanupError extends Error {}
export interface OwnedPrintChildOptions {
  peer: string;
  command: readonly string[];
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envMode?: "replace";
  input: string;
  /** Metadata only: fires after stdin has flushed successfully while the owning generation is current. */
  onInputReleased?: () => void;
  /** The peer owns generation and authority; this helper never mints either. */
  current?: () => boolean;
  stop?: (child: ChildProcess) => Promise<void>;
  onSpawn?: () => void;
  onLeaderExit?: () => void;
  onError?: (error: Error) => void;
  /** Bounded plain-text frames, for model-free metadata commands as well as NDJSON. */
  onLine?: (line: string) => void;
  onFrame?: (event: unknown) => void;
  onActivity?: () => void;
  onLimit?: () => void;
  maxFrameBytes?: number;
  maxOutputBytes?: number;
  /** Opt-in host diagnostic only; raw text is never a frame, activity signal or public log. */
  captureStderr?: true;
}
export type OwnedStderrReceipt = { status: "complete"; text: string } | { status: "unknown" };

/** Shared owned print transport, independent of reviewer or implementer lifecycle and MCP authority. */
export class OwnedPrintChild {
  readonly process: ChildProcess;
  /** Resolves only after the leader exited and its owned process group is confirmed gone. */
  readonly done: Promise<number | null>;
  private stopping: Promise<void> | undefined;
  private limited = false;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrEnded = false;
  private stderrUnknown = false;
  private settled = false;
  /** Only the current owned child's complete bounded stream after confirmed group settlement is usable. */
  stderrAfterSettlement(): OwnedStderrReceipt {
    if (!this.options.captureStderr || !this.settled || !this.stderrEnded || this.stderrUnknown || this.options.current?.() === false) return { status: "unknown" };
    try { return { status: "complete", text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.stderrChunks)) }; }
    catch { return { status: "unknown" }; }
  }

  constructor(private readonly options: OwnedPrintChildOptions) {
    const [command, ...prefix] = options.command;
    if (!command) throw new Error("print child command is missing");
    const child = this.process = spawn(command, [...prefix, ...options.args], {
      cwd: options.cwd, detached: true,
      env: peerChildEnv(options.peer, options.envMode === "replace" ? options.env : { ...process.env, ...options.env }),
      stdio: ["pipe", "pipe", options.captureStderr ? "pipe" : "ignore"],
    });
    // ponytail: 256 KiB per NDJSON frame and 4 MiB stdout by default; raise only with native receipts.
    const frameLimit = options.maxFrameBytes ?? 256 * 1024, outputLimit = options.maxOutputBytes ?? 4 * 1024 * 1024;
    let buffer = "", outputBytes = 0;
    let inputFailed = false;
    const current = () => !this.limited && options.current?.() !== false;
    const limit = () => { if (!this.limited) { this.limited = true; options.onLimit?.(); } };
    if (options.captureStderr) {
      child.stderr!.on("data", (chunk: Buffer) => {
        if (this.stderrUnknown) return;
        this.stderrBytes += chunk.length;
        if (options.current?.() === false || this.stderrBytes > 64 * 1024) { this.stderrUnknown = true; this.stderrChunks = []; return; }
        this.stderrChunks.push(Buffer.from(chunk));
      });
      child.stderr!.once("end", () => { this.stderrEnded = true; });
      child.stderr!.once("error", () => { this.stderrUnknown = true; this.stderrChunks = []; });
    }
    this.done = new Promise((resolve, reject) => {
      child.once("error", error => { options.onError?.(error); reject(error); });
      child.stdin!.on("error", () => { inputFailed = true; /* exit, rather than a prompt write, settles the owned child */ });
      child.once("spawn", () => {
        trackGroup(child);
        if (!current()) { child.stdin!.destroy(); return; }
        options.onSpawn?.();
        if (current()) child.stdin!.end(options.input, () => {
          if (inputFailed || !current()) return;
          try { options.onInputReleased?.(); } catch { /* observer failures never change owned process settlement */ }
        });
        else child.stdin!.destroy();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (!current()) return;
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) return limit();
        buffer += chunk.toString("utf8");
        for (let index; (index = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (Buffer.byteLength(line) > frameLimit) return limit();
          try { options.onLine?.(line); } catch { /* a host observer never breaks owned teardown */ }
          if (!current()) return;
          try { options.onFrame?.(JSON.parse(line)); } catch { /* not a stream-json line */ }
          if (!current()) return;
        }
        if (Buffer.byteLength(buffer) > frameLimit) return limit();
        options.onActivity?.();
      });
      child.once("exit", code => {
        options.onLeaderExit?.();
        void this.stop().then(() => { this.settled = true; resolve(code); }, error => reject(new PrintChildCleanupError((error as Error).message)));
      });
    });
  }

  /** Failed stops retain the handle and can be retried by the owning peer; never publish idle on failure. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = Promise.resolve().then(() => this.options.stop ? this.options.stop(this.process) : stopOwnedProcess(this.process, { group: true }));
    this.stopping = stopping;
    void stopping.catch(() => { if (this.stopping === stopping) this.stopping = undefined; });
    return stopping;
  }
}
