import type { Envelope, EnvelopeOpts, PeerId, PeerState } from "./envelope.ts";

export interface DeliveryReceipt {
  id: string;
  state: "accepted" | "completed" | "failed_safe" | "needs_review";
  reason?: string;
}

export interface PeerAdapter {
  readonly id: PeerId;
  readonly state: PeerState;
  /** A peer the hub drives itself (Pi, the local worker). It cannot be trusted to rate its own urgency: the bus caps it. */
  readonly hubNative?: boolean;
  /** Inject now, as one prompt. Only called while `state === "idle"`. Rejecting puts the envelopes back at the queue head. */
  deliver(envs: Envelope[], deliveryId?: string): Promise<void>;
  /** Optional: feed envelopes into the turn that is running now. Only called while `state === "busy"`. */
  steer?(envs: Envelope[], deliveryId?: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Set by the bus. The peer said something worth sharing. */
  onMessage?: (body: string, opts?: EnvelopeOpts) => void;
  /** Set by the bus. */
  onState?: (state: PeerState) => void;
  /** Set by the bus. A delivery that had resolved turned out not to reach the agent: put it back. */
  onFailed?: (envs: Envelope[]) => void;
  /** Correlated durable-delivery lifecycle, emitted only when the bus supplied an id. */
  onDelivery?: (receipt: DeliveryReceipt) => void;
  /** Safe restart metadata only: ids and launch parameters, never prompt/message text. */
  recoveryMetadata?(): Record<string, unknown>;
}

export const DEFAULT_WATCHDOG_MS = 300_000;

/** State holder with a per-turn inactivity watchdog: a busy peer that goes silent is forced back to idle. */
export abstract class BasePeer implements PeerAdapter {
  onMessage?: (body: string, opts?: EnvelopeOpts) => void;
  onState?: (state: PeerState) => void;
  onFailed?: (envs: Envelope[]) => void;
  onDelivery?: (receipt: DeliveryReceipt) => void;
  private _state: PeerState = "offline";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: PeerId,
    protected readonly watchdogMs = DEFAULT_WATCHDOG_MS,
  ) {}

  get state(): PeerState {
    return this._state;
  }

  protected setState(next: PeerState): void {
    if (next === "busy") this.touch();
    else this.clearWatchdog();
    if (next === this._state) return;
    this._state = next;
    this.onState?.(next);
  }

  /** Any sign of life from a busy peer re-arms the watchdog (it measures inactivity, not duration). */
  protected touch(): void {
    this.clearWatchdog();
    this.timer = setTimeout(() => {
      if (this._state === "busy") this.onWatchdog();
    }, this.watchdogMs);
    this.timer.unref?.();
  }

  protected onWatchdog(): void {
    this.setState("idle");
  }

  protected delivery(receipt: DeliveryReceipt): void {
    this.onDelivery?.(receipt);
  }

  private clearWatchdog(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  abstract deliver(envs: Envelope[], deliveryId?: string): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
