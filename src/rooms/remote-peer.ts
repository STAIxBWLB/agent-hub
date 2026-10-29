/** A host-owned room transport, never a task owner, reviewer, tool caller or native runtime. */
import { BasePeer, type DeliveryReceipt } from "../hub/peers.ts";
import type { Envelope, PeerState } from "../hub/envelope.ts";
import { parseRemotePeerId, type RoomChatEnvelope } from "./application.ts";
import { readRoomOutbound, roomBoundary, type RoomBoundaryContext } from "./boundary.ts";

export interface RemotePeerPorts {
  member: string;
  context: (env: Envelope) => RoomBoundaryContext;
  send: (env: RoomChatEnvelope, deliveryId: string, expiresAt: number, current: () => boolean, withheld: boolean) => Promise<void>;
  now?: () => number;
  /** Record post-publication trust loss locally before any late signed outcome can settle it. */
  quarantine?: (deliveryId: string) => void;
}

export class RemotePeer extends BasePeer {
  readonly hubNative = true;
  readonly deliveryOnly = true;
  readonly remoteMember: string;
  private generation = 0;
  private running = false;
  private online = false;
  private observed: PeerState = "offline";
  private readonly pending = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  constructor(id: string, readonly remoteRoom: string, readonly remoteQueueTtlMs: number, private readonly ports: RemotePeerPorts) {
    super(id);
    this.remoteMember = ports.member;
    if (!parseRemotePeerId(id) || !remoteRoom || !Number.isSafeInteger(remoteQueueTtlMs) || remoteQueueTtlMs < 1 || remoteQueueTtlMs > 604_800_000) throw new Error("room: invalid_message");
    if (!/^[0-9a-f]{64}$/.test(this.remoteMember)) throw new Error("room: invalid_message");
  }
  // Room ack/TTL deadlines, not the native inactivity watchdog, own transport settlement.
  protected override touch(): void { this.clearWatchdog(); }
  private update(): void { this.setState(this.pending.size ? "busy" : this.running && this.online ? this.observed : "offline"); }
  async start(): Promise<void> { this.running = true; this.generation++; this.update(); }
  async stop(): Promise<void> {
    this.running = false; this.generation++;
    for (const id of [...this.pending]) { this.quarantine(id); this.receipt({ id, state: "needs_review", reason: "room transport stopped" }); }
    this.deadlines.clear(); this.update();
  }
  private quarantine(id: string): void { try { this.ports.quarantine?.(id); } catch { /* the Bus still retains uncertainty if room storage is unavailable */ } }
  presence(state: PeerState, online: boolean): void { this.observed = state; this.online = online; this.update(); }
  setRemoteDeadline(envelopeId: string, expiresAt: number): void {
    if (Number.isSafeInteger(expiresAt) && expiresAt > 0 && this.deadlines.size < 200) this.deadlines.set(envelopeId, expiresAt);
  }
  receipt(receipt: DeliveryReceipt): boolean {
    if (!this.pending.has(receipt.id)) return false;
    if (receipt.state !== "accepted") this.pending.delete(receipt.id);
    this.delivery(receipt); // Journal settlement precedes a state transition that may drain the next item.
    this.update();
    return true;
  }
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (!this.running || !this.online || !deliveryId || envs.length !== 1) throw new Error("room: unavailable");
    const env = envs[0]!, generation = this.generation;
    const expiresAt = this.deadlines.get(env.id);
    this.deadlines.delete(env.id);
    const context = this.ports.context(env);
    const current = () => this.running && this.online && this.generation === generation && context.current();
    const result = await roomBoundary(env, { ...context, current });
    if (!current()) throw new Error("room: state_changed");
    if (result.status === "refused") {
      this.delivery({ id: deliveryId, state: "failed_safe", reason: `room: ${result.code}` });
      return;
    }
    const view = readRoomOutbound(result.proof);
    if (!view || expiresAt === undefined || expiresAt <= (this.ports.now?.() ?? Date.now())) {
      this.delivery({ id: deliveryId, state: "needs_review", reason: "room queued deadline unavailable or expired" });
      return;
    }
    this.pending.add(deliveryId); this.update();
    try {
      await this.ports.send(view, deliveryId, expiresAt, () => current() && readRoomOutbound(result.proof) !== undefined, result.withheld);
      if (!current()) { this.quarantine(deliveryId); this.receipt({ id: deliveryId, state: "needs_review", reason: "room trust changed during publication" }); }
    } catch {
      this.quarantine(deliveryId);
      this.receipt({ id: deliveryId, state: "needs_review", reason: "room publication outcome is uncertain" });
    }
  }
}
