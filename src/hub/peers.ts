import type { Envelope, EnvelopeOpts, PeerId, PeerState } from "./envelope.ts";

export interface PeerAdapter {
  readonly id: PeerId;
  readonly state: PeerState;
  /** Inject now. Only called while `state === "idle"`. Rejecting puts the envelope back at the queue head. */
  deliver(env: Envelope): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Set by the bus. The peer said something worth sharing. */
  onMessage?: (body: string, opts?: EnvelopeOpts) => void;
  /** Set by the bus. */
  onState?: (state: PeerState) => void;
  /** Set by the bus. A delivery that had resolved turned out not to reach the agent: put it back. */
  onFailed?: (env: Envelope) => void;
}

export const DEFAULT_WATCHDOG_MS = 300_000;

/** State holder with a per-turn inactivity watchdog: a busy peer that goes silent is forced back to idle. */
export abstract class BasePeer implements PeerAdapter {
  onMessage?: (body: string, opts?: EnvelopeOpts) => void;
  onState?: (state: PeerState) => void;
  onFailed?: (env: Envelope) => void;
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

  private clearWatchdog(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  abstract deliver(env: Envelope): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
