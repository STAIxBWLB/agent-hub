import type { RecordedTerminalLaunch } from "../cli/terminal-recovery.ts";
import { descendantsOf, readProcessTable } from "./child-process.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";

export interface TerminalOwnerProof {
  generation: string;
  nativePid?: number;
  isCurrent(): boolean;
}

/** Pending launch attempts are never recovery ownership. Only a current native owner can publish one. */
export class TerminalLaunches {
  private readonly candidates = new Map<string, { row: RecordedTerminalLaunch; published?: string }>();
  private running = false;
  private stopped = false;
  constructor(private readonly opts: {
    owner(row: RecordedTerminalLaunch): TerminalOwnerProof | undefined;
    publish(row: RecordedTerminalLaunch, current: () => boolean): Promise<boolean>;
    log?(message: string): void;
  }) {}

  register(row: RecordedTerminalLaunch): void {
    if (this.stopped || processLiveness(row.launcherPid, row.launcherSignature, processSignature) !== "live") throw new Error("terminal launcher identity unavailable");
    const previous = this.candidates.get(row.launchId);
    if (previous) {
      if (JSON.stringify(previous.row) !== JSON.stringify(row)) throw new Error("terminal launch identity changed");
      return;
    }
    if (this.candidates.size >= 64) {
      const states = new Map<string, ReturnType<typeof processLiveness>>();
      for (const [id, candidate] of this.candidates) {
        const key = `${candidate.row.launcherPid}:${candidate.row.launcherSignature}`;
        const state = states.get(key) ?? processLiveness(candidate.row.launcherPid, candidate.row.launcherSignature, processSignature);
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
        const liveness = processLiveness(row.launcherPid, row.launcherSignature, processSignature);
        if (liveness === "gone") { this.candidates.delete(id); continue; }
        if (liveness !== "live") continue;
        const proof = this.opts.owner(row);
        if (!proof || !proof.isCurrent() || candidate.published === proof.generation) continue;
        if (proof.nativePid !== undefined) {
          const table = await readProcessTable();
          if (!table || !descendantsOf(table, row.launcherPid).some(child => child.pid === proof.nativePid)) continue;
        }
        const current = () => !this.stopped && this.candidates.get(id) === candidate && proof.isCurrent() &&
          processLiveness(row.launcherPid, row.launcherSignature, processSignature) === "live";
        try {
          if (current() && await this.opts.publish(row, current)) candidate.published = proof.generation;
        } catch { this.opts.log?.("terminal owner publication unavailable; inspect recovery terminal evidence"); }
      }
    } finally { this.running = false; }
  }

  clear(): void { this.stopped = true; this.candidates.clear(); }
}
