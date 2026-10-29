import { BasePeer, type PeerAdapter } from "../hub/peers.ts";
import type { Envelope } from "../hub/envelope.ts";
import { definitionOf } from "./registry.ts";
import type { StartForm } from "./registry-types.ts";

/** Only the control socket operations the peer owns; authentication remains in the daemon. */
export interface ChannelSocket {
  readyState: number;
  data: { launchId?: string };
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/** A peer that lives in another process and attaches over the control WS (the Claude channel plugin). */
export class WsPeer extends BasePeer {
  readonly form: StartForm = "tui";
  private generation = crypto.randomUUID();
  // Checkpoints become stale at hello/claim, before asynchronous recall finishes and attach changes delivery generation.
  private claimGeneration = crypto.randomUUID();
  get sessionGeneration(): string { return this.claimGeneration; }
  terminalOwner(launchId: string): { generation: string } | undefined {
    return this.sock?.readyState === WebSocket.OPEN && this.sock.data.launchId === launchId && this.state !== "offline" && !this.claiming
      ? { generation: this.claimGeneration } : undefined;
  }
  private delivered = new Set<string>();
  private sock: ChannelSocket | undefined;
  private claimed: ChannelSocket | undefined;
  private nativeTurnSession: string | undefined;
  private nativeActive = false;
  /** The attached session said it cannot show channel pushes (issue #205): the bus keeps its queue for `inbox`. */
  pullOnly = false;
  steer: PeerAdapter["steer"] = undefined;
  lastInboxAt: number | undefined;
  private claimedPullOnly = false;
  private readonly attachmentWaiters: { generation: string; resolve: (attached: boolean) => void }[] = [];
  private settleAttachmentWaiters(attached: boolean): void {
    for (const waiter of this.attachmentWaiters.splice(0)) waiter.resolve(attached && waiter.generation === this.claimGeneration);
  }
  /** Bounded native-hook observations wait for this exact claim, never a later socket. */
  waitForAttach(generation: string): Promise<boolean> {
    if (generation !== this.claimGeneration || !this.claiming || this.attachmentWaiters.length >= 64) return Promise.resolve(false);
    return new Promise(resolve => { this.attachmentWaiters.push({ generation, resolve }); });
  }
  /** Called at hello, before the async preface: the newest hello wins even if an older one's recall finishes last. */
  claim(sock: ChannelSocket, pullOnly = false): void {
    this.settleAttachmentWaiters(false);
    this.claimGeneration = crypto.randomUUID();
    this.claimed = sock;
    this.claimedPullOnly = pullOnly;
  }
  /** Host transport observation, distinct from the peer's activity state. */
  get attached(): boolean { return !!this.sock && this.sock.readyState === WebSocket.OPEN && !this.claiming; }
  get managedLaunchId(): string | undefined { return this.attached ? this.sock?.data.launchId : undefined; }

  /** A session that shows pushes holds the peer or is arriving: a session without them must not take it (issue #205). */
  get channelHeld(): boolean {
    return (!!this.sock && !this.pullOnly) || (this.claiming && !this.claimedPullOnly);
  }
  /** Status-file observations are advisory; a replaced client cannot evict a live socket or pending claim. */
  standbyHeld(pullOnly: boolean): boolean {
    return this.claiming || (!!this.sock && this.sock.readyState === WebSocket.OPEN && (pullOnly || !this.pullOnly));
  }
  /** A hello that has not finished its preface yet. The peer reads as offline until then, and a session standing by
   *  for the id must not take it from a claimant that is still arriving. */
  get claiming(): boolean {
    return !!this.claimed && this.claimed !== this.sock && this.claimed.readyState === WebSocket.OPEN;
  }
  attach(sock: ChannelSocket): void {
    if (sock !== this.claimed) return void sock.close(4000, "replaced"); // a newer session said hello meanwhile
    if (this.sock) this.setState("offline"); // unresolved work belongs to the previous connection
    this.sock?.close(4000, "replaced");
    this.sock = sock;
    this.generation = crypto.randomUUID();
    this.delivered.clear();
    this.nativeTurnSession = undefined;
    this.nativeActive = false;
    this.pullOnly = this.claimedPullOnly; // before idle: the idle transition drains
    // Native TUI readback in #493 proves important channel input can be consumed before the turn ends.
    // Pull-only transports expose no steer capability; the bus keeps their important work queued.
    this.steer = this.pullOnly ? undefined : async (envs, deliveryId) => {
      if (this.state !== "busy" || !envs.length || envs.some(env => env.priority !== "important")) throw new Error("channel steering requires important work in the current busy turn");
      await this.deliver(envs, deliveryId);
    };
    this.lastInboxAt = undefined;
    this.setState("idle");
    this.settleAttachmentWaiters(true);
  }
  detach(sock: ChannelSocket): void {
    if (this.claimed === sock) { this.claimed = undefined; this.settleAttachmentWaiters(false); }
    if (this.sock !== sock) return;
    this.sock = undefined;
    this.steer = undefined;
    this.nativeActive = false;
    this.pullOnly = false;
    this.setState("offline");
  }
  detachForRoster(): void {
    this.settleAttachmentWaiters(false);
    this.claimed?.close(4000, "peer is off roster; retry when a person adds it");
    this.sock?.close(4000, "peer is off roster; retry when a person adds it");
    this.claimed = undefined;
    this.sock = undefined;
    this.steer = undefined;
    this.nativeActive = false;
    this.pullOnly = false;
    this.setState("offline");
  }
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (!this.sock) throw new Error(`${this.id} is offline`);
    if (deliveryId) this.delivered.add(deliveryId);
    this.sock.send(JSON.stringify({ t: "deliver", envs, generation: this.generation, ...(deliveryId ? { deliveryId } : {}) }));
  }
  /** Advisory nudge (issue #398): important work waits in the pull queue. Not a delivery: nothing to settle or journal. */
  notifyQueued(counts: { queued: number; important: number }): void {
    if (!this.sock || !this.pullOnly) return;
    this.sock.send(JSON.stringify({ t: "queued", queued: counts.queued, important: counts.important }));
  }
  owns(sock: ChannelSocket): boolean { return this.sock === sock; }
  nativeStarted(session: string): void {
    if (!this.sock) return;
    this.nativeTurnSession = session;
    this.nativeActive = true;
    this.setState("busy");
  }
  nativeStopped(session: string): boolean {
    if (!this.sock || (this.nativeTurnSession !== undefined && this.nativeTurnSession !== session)) return false;
    this.nativeTurnSession = session;
    this.nativeActive = false;
    this.setState("idle");
    return true;
  }
  protected override onWatchdog(): void {
    // A silent native model/approval wait does not prove Stop. Retain the observed active turn until Stop/detach.
    if (this.nativeActive) { this.touch(); return; }
    super.onWatchdog();
  }
  ownsDelivery(sock: ChannelSocket, generation: unknown, id: string): boolean { return this.owns(sock) && generation === this.generation && this.delivered.has(id); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.settleAttachmentWaiters(false);
    this.sock?.close();
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: definitionOf(this.id)?.attach?.recoveryLaunch?.(this.id) ?? { kind: "claude-channel", peer: this.id } };
  }
}

export function isWsPeer(value: unknown): value is WsPeer { return value instanceof WsPeer; }
