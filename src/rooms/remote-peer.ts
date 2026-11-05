/** A host-owned room transport, never a task owner, reviewer, tool caller or native runtime. */
import { BasePeer, type DeliveryReceipt } from "../hub/peers.ts";
import type { Envelope, PeerState } from "../hub/envelope.ts";
import { encodeRoomMessage, parseRemotePeerId, type RoomChatEnvelope } from "./application.ts";
import { readRoomOutbound, roomBoundary, type RoomBoundaryContext } from "./boundary.ts";
import { RoomNotSentError } from "./link.ts";

export interface RemotePeerPorts {
  member: string;
  context: (env: Envelope) => RoomBoundaryContext;
  send: (env: RoomChatEnvelope, deliveryId: string, expiresAt: number, current: () => boolean, withheld: boolean) => Promise<void>;
  now?: () => number;
  /** Current Bus admission, separate from immutable room trust/exposure proof. */
  ready?: () => boolean;
  /** Record post-publication trust loss locally before any late signed outcome can settle it. */
  quarantine?: (deliveryId: string, reason?: "not_exposed" | "boundary_refused" | "invalid_message") => void;
  /** Requeue a send that the room link proves never reached its durable outbox. */
  notSent?: (deliveryId: string) => boolean;
  /** True for any durable RoomStore row with this Bus delivery ID; false only proves absence. */
  queued?: (deliveryId: string) => boolean | undefined;
  /** Persist a conservative Bus hold when neither requeue nor durable Store retry is available. */
  holdMissing?: (deliveryId: string) => boolean;
  /** Wake host retry scheduling after an active intent meets an external Bus fence. */
  waiting?: () => void;
}

export class RemotePeer extends BasePeer {
  readonly hubNative = true;
  readonly deliveryOnly = true;
  readonly remoteMember: string;
  private generation = 0;
  private running = false;
  private online = false;
  private blockedNotSent = false;
  private observed: PeerState = "offline";
  private readonly pending = new Set<string>();
  private readonly waitingForReady = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  constructor(id: string, readonly remoteRoom: string, readonly remoteQueueTtlMs: number, private readonly ports: RemotePeerPorts) {
    super(id);
    this.remoteMember = ports.member;
    if (!parseRemotePeerId(id) || !remoteRoom || !Number.isSafeInteger(remoteQueueTtlMs) || remoteQueueTtlMs < 1 || remoteQueueTtlMs > 604_800_000) throw new Error("room: invalid_message");
    if (!/^[0-9a-f]{64}$/.test(this.remoteMember)) throw new Error("room: invalid_message");
  }
  // Room ack/TTL deadlines, not the native inactivity watchdog, own transport settlement.
  protected override touch(): void { this.clearWatchdog(); }
  private update(): void { this.setState(this.pending.size ? "busy" : this.running && this.online && !this.blockedNotSent ? this.observed : "offline"); }
  private head(): string | undefined { return this.pending.values().next().value as string | undefined; }
  /** Reserve recovered Store intents synchronously before any proof decrypt/screen await. */
  reservePending(deliveryId: string): void {
    this.pending.add(deliveryId);
    this.waitingForReady.add(deliveryId);
    this.blockedNotSent = false;
    this.update();
  }
  async start(): Promise<void> { this.running = true; this.generation++; this.update(); }
  async stop(): Promise<void> {
    this.running = false; this.generation++;
    // Active journal rows and their sealed room frames survive a sender restart.
    // Stop only fences in-flight callbacks; it is not evidence of an uncertain send.
    this.pending.clear();
    this.waitingForReady.clear();
    this.deadlines.clear(); this.update();
  }
  private quarantine(id: string, reason?: "not_exposed" | "boundary_refused" | "invalid_message"): void { try { this.ports.quarantine?.(id, reason); } catch { /* The durable application remains for TTL review if local storage is unavailable. */ } }
  private ready(): boolean { try { return this.ports.ready?.() !== false; } catch { return false; } }
  waitForReady(deliveryId: string): void {
    this.waitingForReady.add(deliveryId);
    this.pending.add(deliveryId);
    this.blockedNotSent = false;
    this.update();
    try { this.ports.waiting?.(); } catch { /* A future real Bus callback will retry. */ }
  }
  readyToResume(deliveryId: string): boolean {
    return this.waitingForReady.has(deliveryId) && this.head() === deliveryId && this.running && this.online && !this.blockedNotSent && this.ready();
  }
  isPendingHead(deliveryId: string): boolean { return this.head() === deliveryId; }
  private holdMissing(id: string): boolean { try { return this.ports.holdMissing?.(id) === true; } catch { return false; } }
  private notSent(id: string, blockUntilWake = true): void {
    let retained: boolean | undefined;
    try { retained = this.ports.queued?.(id); } catch { retained = undefined; }
    if (retained === true) {
      // A prior attempt is already durable. Never create a second Bus delivery ID.
      if (!blockUntilWake || !this.ready()) this.waitForReady(id);
      else { this.blockedNotSent = true; this.update(); }
      return;
    }
    if (retained === undefined) {
      // Store read failure cannot prove not-sent, so preserve the active RAM fence.
      this.blockedNotSent = true; this.update(); return;
    }
    let requeued = false;
    try { requeued = this.ports.notSent?.(id) === true; } catch { /* Keep uncertainty handling on the state transition below. */ }
    // An expired requeue may have completed the Bus row synchronously. In that
    // case its receipt already removed this ID and drained the following FIFO item.
    if (!this.pending.has(id)) { this.update(); return; }
    if (requeued) {
      this.waitingForReady.delete(id);
      this.blockedNotSent = blockUntilWake;
      this.pending.delete(id);
      this.update();
      return;
    }
    const held = retained === false && this.holdMissing(id);
    if (held) {
      this.waitingForReady.delete(id);
      this.blockedNotSent = false;
      this.pending.delete(id);
    } else this.blockedNotSent = true; // Keep the ID busy if the journal write failed or the actor went stale.
    this.update();
  }
  presence(state: PeerState, online: boolean): void {
    if (online && (!this.online || state !== this.observed)) this.blockedNotSent = false;
    this.observed = state; this.online = online; this.update();
  }
  /** Rehydrate a journal-owned delivery without creating a new bus delivery or application id. */
  async resume(env: Envelope, deliveryId: string, expiresAt: number, immutable: RoomChatEnvelope): Promise<void> {
    if (!this.running || !this.online || !this.ready() || this.blockedNotSent || !deliveryId || this.head() !== deliveryId || !Number.isSafeInteger(expiresAt) || expiresAt <= (this.ports.now?.() ?? Date.now())) return;
    this.waitingForReady.delete(deliveryId);
    this.pending.add(deliveryId); this.update();
    await this.publish(env, deliveryId, expiresAt, this.generation, immutable);
  }
  /** A link becoming ready is an actual wake-up after a typed not-sent refusal. */
  wake(): void { this.blockedNotSent = false; this.update(); }
  setRemoteDeadline(envelopeId: string, expiresAt: number): void {
    if (Number.isSafeInteger(expiresAt) && expiresAt > 0 && this.deadlines.size < 200) this.deadlines.set(envelopeId, expiresAt);
  }
  receipt(receipt: DeliveryReceipt): boolean {
    if (!this.pending.has(receipt.id)) return false;
    if (receipt.state !== "accepted") { this.pending.delete(receipt.id); this.waitingForReady.delete(receipt.id); }
    this.delivery(receipt); // Journal settlement precedes a state transition that may drain the next item.
    this.update();
    return true;
  }
  /** Clear transport wait after the Bus records a signed outcome or durable hold. */
  settled(deliveryId: string): void { this.pending.delete(deliveryId); this.waitingForReady.delete(deliveryId); this.update(); }
  /** Reserve a restart-era active Store delivery before asynchronous proof validation. */
  retainPending(deliveryId: string): void {
    if (this.pending.has(deliveryId)) return;
    this.pending.add(deliveryId);
    this.waitingForReady.add(deliveryId);
    this.update();
  }
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (!deliveryId || envs.length !== 1) throw new Error("room: unavailable");
    if (!this.running || !this.online) { this.notSent(deliveryId); return; }
    if (!this.ready()) { this.notSent(deliveryId, false); return; }
    const env = envs[0]!, generation = this.generation;
    const expiresAt = this.deadlines.get(env.id);
    this.deadlines.delete(env.id);
    if (expiresAt === undefined) throw new Error("room: queued deadline unavailable");
    this.pending.add(deliveryId); this.update();
    await this.publish(env, deliveryId, expiresAt, generation);
  }
  private async publish(env: Envelope, deliveryId: string, expiresAt: number, generation: number, immutable?: RoomChatEnvelope): Promise<void> {
    if (this.sending.has(deliveryId)) return;
    this.sending.add(deliveryId);
    try { await this.publishOnce(env, deliveryId, expiresAt, generation, immutable); }
    finally { this.sending.delete(deliveryId); }
  }
  private async publishOnce(env: Envelope, deliveryId: string, expiresAt: number, generation: number, immutable?: RoomChatEnvelope): Promise<void> {
    let context: RoomBoundaryContext;
    try { context = this.ports.context(env); }
    catch { this.notSent(deliveryId); return; }
    const trusted = () => { try { return context.current() === true; } catch { return false; } };
    let readinessLost = false;
    const current = () => {
      const ready = this.ready();
      if (!ready) readinessLost = true;
      return this.running && this.online && this.generation === generation && ready && trusted();
    };
    const result = await roomBoundary(env, { ...context, current });
    if (!current()) {
      if (!trusted()) { this.quarantine(deliveryId, "boundary_refused"); this.receipt({ id: deliveryId, state: "needs_review", reason: "room trust changed before publication" }); }
      else if (!this.running || !this.online || generation !== this.generation) this.notSent(deliveryId);
      else if (!this.ready()) this.notSent(deliveryId, false);
      return;
    }
    if (readinessLost && result.status === "refused" && trusted()) { this.notSent(deliveryId, false); return; }
    if (result.status === "refused") {
      const reason = result.code === "not_exposed" || result.code === "invalid_message" ? result.code : "boundary_refused";
      if (immutable) {
        this.quarantine(deliveryId, reason);
        this.receipt({ id: deliveryId, state: "needs_review", reason: `room retry refused: ${result.code}` });
      } else this.receipt({ id: deliveryId, state: "failed_safe", reason: `room: ${result.code}` });
      return;
    }
    const view = readRoomOutbound(result.proof);
    if (!view || expiresAt <= (this.ports.now?.() ?? Date.now())) {
      if (immutable) this.quarantine(deliveryId, "boundary_refused");
      this.receipt({ id: deliveryId, state: "needs_review", reason: "room queued deadline unavailable or expired" });
      return;
    }
    if (immutable && Buffer.compare(Buffer.from(encodeRoomMessage({ v: 1, type: "chat", envelope: view })), Buffer.from(encodeRoomMessage({ v: 1, type: "chat", envelope: immutable }))) !== 0) {
      this.quarantine(deliveryId, "boundary_refused");
      this.receipt({ id: deliveryId, state: "needs_review", reason: "room retry privacy proof changed from immutable application" });
      return;
    }
    try {
      await this.ports.send(view, deliveryId, expiresAt, () => current() && readRoomOutbound(result.proof) !== undefined, result.withheld);
      if (!trusted() && this.running && this.online && generation === this.generation) {
        this.quarantine(deliveryId, "boundary_refused"); this.receipt({ id: deliveryId, state: "needs_review", reason: "room trust changed during publication" });
        return;
      }
      if (!this.ready()) {
        let retained: boolean | undefined;
        try { retained = this.ports.queued?.(deliveryId); } catch { retained = undefined; }
        if (immutable || retained === true) this.waitForReady(deliveryId);
        else this.notSent(deliveryId, false);
        return;
      }
    } catch (error) {
      if (error instanceof RoomNotSentError) {
        let retained: boolean | undefined;
        try { retained = this.ports.queued?.(deliveryId); } catch { retained = undefined; }
        if (immutable || retained === true) {
          if (!this.ready()) this.waitForReady(deliveryId);
        } else this.notSent(deliveryId);
        return;
      }
      if (!trusted()) {
        this.quarantine(deliveryId, "boundary_refused");
        this.receipt({ id: deliveryId, state: "needs_review", reason: "room trust changed during publication" });
        return;
      }
      if (!this.running || !this.online || generation !== this.generation) return;
      let retained: boolean | undefined;
      try { retained = this.ports.queued?.(deliveryId); } catch { retained = undefined; }
      if (!this.ready()) {
        if (immutable || retained === true) this.waitForReady(deliveryId);
        else this.notSent(deliveryId, false);
        return;
      }
      if (retained !== true) {
        if (retained === false && this.holdMissing(deliveryId)) {
          this.pending.delete(deliveryId); this.blockedNotSent = false; this.update();
        } else { this.blockedNotSent = true; this.update(); }
      } // A durable intent stays active and retries on its next ACK deadline.
    }
  }
}
