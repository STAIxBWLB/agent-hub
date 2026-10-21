import type { ChildProcess } from "node:child_process";
import { processSignature } from "@staix/agent-mem/platform";
import { readProcessTable, type ProcRow } from "../hub/child-process.ts";

export interface AcpOwnedGroupPorts {
  table(): readonly ProcRow[] | undefined | Promise<readonly ProcRow[] | undefined>;
  signature(pid: number): string | undefined;
  signal(target: number, signal: NodeJS.Signals): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const PORTS: AcpOwnedGroupPorts = {
  table: readProcessTable, signature: processSignature,
  signal: (target, signal) => { process.kill(target, signal); },
  now: () => performance.now(), sleep: ms => Bun.sleep(ms),
};
const READ_MS = 1_000;
const ownershipError = () => new Error("Configured ACP process ownership could not be verified");
const shutdownError = () => new Error("Configured ACP process group shutdown incomplete");

/** A foreground child and its original group only, never a discovered descendant group. */
export class AcpOwnedGroup {
  private confirmedGone = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly leader: ProcRow,
    private readonly signature: string,
    private readonly ports: AcpOwnedGroupPorts,
  ) {}

  static async capture(proc: ChildProcess, ports: AcpOwnedGroupPorts = PORTS): Promise<AcpOwnedGroup> {
    const pid = proc.pid;
    if (!Number.isSafeInteger(pid) || !pid || pid <= 1 || proc.exitCode !== null || proc.signalCode !== null) throw ownershipError();
    const rows = await AcpOwnedGroup.read(ports);
    const leader = rows.find(row => row.pid === pid);
    if (!leader || leader.pgid !== pid || leader.ppid !== process.pid) throw ownershipError();
    const signature = AcpOwnedGroup.identity(ports, pid);
    if (!signature || proc.pid !== pid || proc.exitCode !== null || proc.signalCode !== null) throw ownershipError();
    return new AcpOwnedGroup(proc, { ...leader }, signature, ports);
  }

  /** Verify before accepting the session, including after an awaited initialize handshake. */
  async verify(): Promise<void> {
    if (this.confirmedGone || !await this.inspect(false)) throw ownershipError();
  }

  async stop({ killMs = 2_000 }: { killMs?: number } = {}): Promise<void> {
    if (this.confirmedGone) return;
    if (!Number.isFinite(killMs) || killMs <= 0 || killMs > 10_000) throw shutdownError();
    if (!await this.inspect(true)) { this.confirmedGone = true; return; }
    this.signal("SIGSTOP");
    // A stopped leader cannot leave the group or start a new child between this proof and SIGKILL.
    if (!await this.inspect(true)) { this.confirmedGone = true; return; }
    this.signal("SIGKILL");
    const end = this.ports.now() + killMs;
    for (;;) {
      const left = end - this.ports.now();
      if (left <= 0) throw shutdownError();
      const rows = await AcpOwnedGroup.read(this.ports, Math.min(READ_MS, left));
      const leader = rows.find(row => row.pid === this.leader.pid);
      // After SIGKILL, an exiting row may be reparented or render a defunct command. No more signals
      // are sent: retain only its original PID/start/group fence while awaiting positive disappearance.
      if (leader && (leader.started !== this.leader.started || leader.pgid !== this.leader.pgid)) throw ownershipError();
      if (!rows.some(row => row.pgid === this.leader.pgid) && !leader) { this.confirmedGone = true; return; }
      if (this.ports.now() >= end) throw shutdownError();
      await this.ports.sleep(Math.min(25, end - this.ports.now()));
    }
  }

  private async inspect(allowGone: boolean): Promise<boolean> {
    const rows = await AcpOwnedGroup.read(this.ports);
    const leader = rows.find(row => row.pid === this.leader.pid);
    const members = rows.some(row => row.pgid === this.leader.pgid);
    if (!leader && !members && allowGone) return false;
    if (!leader || !this.sameLeader(leader) || this.proc.pid !== this.leader.pid
      || this.proc.exitCode !== null || this.proc.signalCode !== null
      || AcpOwnedGroup.identity(this.ports, this.leader.pid) !== this.signature) throw ownershipError();
    return true;
  }

  private sameLeader(row: ProcRow): boolean {
    return row.pid === this.leader.pid && row.pgid === this.leader.pid && row.ppid === process.pid
      && row.started === this.leader.started && row.command === this.leader.command;
  }

  private signal(signal: NodeJS.Signals): void {
    try { this.ports.signal(-this.leader.pgid, signal); }
    catch { throw ownershipError(); }
  }

  private static identity(ports: AcpOwnedGroupPorts, pid: number): string | undefined {
    // ponytail: the shared synchronous signature probe inherits its ps wait ceiling. A bounded async
    // identity port in agent-mem is the upgrade path; do not duplicate the identity implementation here.
    try { return ports.signature(pid); } catch { return undefined; }
  }

  private static async read(ports: AcpOwnedGroupPorts, ms = READ_MS): Promise<readonly ProcRow[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([
        Promise.resolve().then(() => ports.table()),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); }),
      ]);
      if (!rows) throw ownershipError();
      return rows;
    } catch { throw ownershipError(); }
    finally { clearTimeout(timer); }
  }
}
