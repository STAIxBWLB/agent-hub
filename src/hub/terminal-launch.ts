import { MAX_COMMAND_MS, orcaExecutable, type CommandResult, type CommandRunner, type RecordedTerminalLaunch } from "../cli/terminal-recovery.ts";
import { spawn } from "node:child_process";
import { descendantsOf, readProcessTable, stopOwnedProcess, trackGroup } from "./child-process.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";

export interface TerminalOwnerProof {
  generation: string;
  nativePid?: number;
  isCurrent(): boolean;
}

/** Own only the daemon's background read, never the person's native TUI or Orca application. */
export function terminalOwnerReads(executable = orcaExecutable()): { run: CommandRunner; stop(): Promise<void> } {
  let stopped = false;
  const active = new Set<{ stop(): Promise<void>; done: Promise<CommandResult> }>();
  return {
    run(argv) {
      if (stopped) return Promise.reject(new Error("terminal owner reader stopped"));
      const child = spawn(executable, [...argv], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      trackGroup(child);
      let termination: Promise<void> | undefined;
      const terminate = () => termination ??= stopOwnedProcess(child, { group: true }).catch(error => { stopped = true; throw error; });
      let cancel!: (reason: Error) => void;
      const cancelled = new Promise<never>((_, reject) => { cancel = reject; });
      let entry!: { stop(): Promise<void>; done: Promise<CommandResult> };
      const chunks: Buffer[] = []; let bytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // ponytail: show identity must fit 1 MiB; use an identity-only Orca endpoint if terminal payloads exceed it.
        if (bytes > 1024 * 1024) { void entry.stop().catch(() => {}); return; }
        chunks.push(chunk);
      });
      child.stderr.resume(); // Never retain terminal text from a failed read in daemon diagnostics.
      const result = new Promise<CommandResult>((resolve, reject) => {
        child.once("error", () => reject(new Error("terminal owner query could not start")));
        child.once("close", code => resolve({ status: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8"), stderr: "" }));
      });
      const done = (async () => {
        const timer = setTimeout(() => { void entry.stop().catch(() => {}); }, MAX_COMMAND_MS);
        try { return await Promise.race([result, cancelled]); }
        finally {
          clearTimeout(timer);
          try { await terminate(); active.delete(entry); }
          catch { throw new Error("terminal owner query cleanup incomplete"); }
        }
      })();
      entry = { done, stop: () => { cancel(new Error("terminal owner query cancelled")); return terminate(); } };
      active.add(entry);
      return done;
    },
    async stop() {
      stopped = true;
      const jobs = [...active];
      const results = await Promise.allSettled(jobs.map(job => job.stop()));
      await Promise.allSettled(jobs.map(job => job.done));
      if (results.some(result => result.status === "rejected")) throw new Error("terminal owner query cleanup incomplete");
    },
  };
}

/** Pending launch attempts are never recovery ownership. Only a current native owner can publish one. */
export class TerminalLaunches {
  private readonly candidates = new Map<string, { row: RecordedTerminalLaunch; published?: string }>();
  private running = false;
  private stopped = false;
  private readonly settlementWaiters: Array<() => void> = [];
  constructor(private readonly opts: {
    owner(row: RecordedTerminalLaunch): TerminalOwnerProof | undefined;
    publish(row: RecordedTerminalLaunch, current: () => boolean): Promise<boolean>;
    log?(message: string): void;
    signature?: typeof processSignature;
    now?(): number;
  }) {}

  register(row: RecordedTerminalLaunch): void {
    if (this.stopped || processLiveness(row.launcherPid, row.launcherSignature, (this.opts.signature ?? processSignature)) !== "live") throw new Error("terminal launcher identity unavailable");
    const previous = this.candidates.get(row.launchId);
    if (previous) {
      if (JSON.stringify(previous.row) !== JSON.stringify(row)) throw new Error("terminal launch identity changed");
      return;
    }
    if (this.candidates.size >= 64) {
      const states = new Map<string, ReturnType<typeof processLiveness>>();
      for (const [id, candidate] of this.candidates) {
        const key = `${candidate.row.launcherPid}:${candidate.row.launcherSignature}`;
        const state = states.get(key) ?? processLiveness(candidate.row.launcherPid, candidate.row.launcherSignature, (this.opts.signature ?? processSignature));
        states.set(key, state);
        if (state === "gone") this.candidates.delete(id);
      }
    }
    // ponytail: 64 live/unknown launch candidates per daemon. Fail closed at the cap; a durable owner ledger can extend it.
    if (this.candidates.size >= 64) throw new Error("too many pending terminal launches");
    this.candidates.set(row.launchId, { row });
  }

  async reconcile(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const [id, candidate] of this.candidates) {
        const { row } = candidate;
        const liveness = processLiveness(row.launcherPid, row.launcherSignature, (this.opts.signature ?? processSignature));
        if (liveness === "gone") { this.candidates.delete(id); continue; }
        if (liveness !== "live") continue;
        const proof = this.opts.owner(row);
        if (!proof || !proof.isCurrent() || candidate.published === proof.generation) continue;
        if (proof.nativePid !== undefined) {
          const table = await readProcessTable();
          if (!table || !descendantsOf(table, row.launcherPid).some(child => child.pid === proof.nativePid)) continue;
        }
        const current = () => !this.stopped && this.candidates.get(id) === candidate && proof.isCurrent() &&
          processLiveness(row.launcherPid, row.launcherSignature, (this.opts.signature ?? processSignature)) === "live";
        try {
          if (current() && await this.opts.publish(row, current)) candidate.published = proof.generation;
        } catch { if (!this.stopped) this.opts.log?.("terminal owner publication unavailable; inspect recovery terminal evidence"); }
      }
    } finally { this.running = false; for (const done of this.settlementWaiters.splice(0)) done(); }
  }

  clear(): void { this.stopped = true; this.candidates.clear(); }
  settled(): Promise<void> { return this.running ? new Promise(resolve => this.settlementWaiters.push(resolve)) : Promise.resolve(); }
}
