import type { Envelope, EnvelopeOpts, PeerId, PeerState } from "./envelope.ts";
import type { PermissionMode } from "./permission-mode.ts";
import type { StartForm } from "../adapters/registry-types.ts";

export interface DeliveryReceipt {
  id: string;
  state: "accepted" | "completed" | "failed_safe" | "needs_review";
  reason?: string;
  /** A provider refused before acceptance for quota; requeue without spending poison retries while paused. */
  quota?: true;
}

/** Host-owned print child authority, revoked before stop/turn settlement. No terminal ownership. */
export interface OwnedToolsLaunch {
  launchId: string; generation: string; sessionId: string; signal: AbortSignal; task?: number; permissionHook: true;
}

export interface PeerAdapter {
  readonly id: PeerId;
  ownedTools?(launchId: unknown): OwnedToolsLaunch | undefined;
  keepApprovalAlive?(): void;
  readonly state: PeerState;
  /** Host-observed native session identity. An absent port permits owner-token fallback; undefined means unknown. */
  readonly sessionGeneration?: string | number;
  /** Defaults to fencing checkpoints when the generation port exists; native legacy exceptions opt out explicitly. */
  readonly checkpointUsesSessionGeneration?: boolean;
  /** Effective native approval state; absent peers retain the hub-managed choice. */
  readonly permissionModeState?: PermissionMode | "unknown" | "unmanaged";
  /** Resolve only after native acknowledgement. This changes approval frequency, never the sandbox. */
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  /** Never offered delivery retry; absent/false permits retry, present undefined refuses it. */
  readonly deliveryOnly?: boolean;
  /** The hub owns this runtime and may stop it; absent or undefined refuses. */
  readonly hubOwned?: boolean;
  /** An owned process remains whose exit is unconfirmed. */
  readonly pendingOwnedProcess?: boolean;
  /** Native running form; absent keeps the site's default, present undefined is unknown. */
  readonly form?: StartForm;
  /** Capture live resume evidence before a requested stop; throws when unavailable. */
  captureResume?(): Promise<Record<string, unknown>>;
  /** Leave the roster without stopping a person's terminal. */
  detachForRoster?(resetMode: PermissionMode): void | Promise<void>;
  /** Return to the roster after detachForRoster. */
  resumeFromRoster?(): Promise<void>;
  /** A peer the hub drives itself (Pi, the local worker). It cannot be trusted to rate its own urgency: the bus caps it. */
  readonly hubNative?: boolean;
  /** Never handed a delivery: its queue waits for `Bus.pull` (a Claude session that cannot show channel pushes, issue #205). */
  readonly pullOnly?: boolean;
  /** Inject now, as one prompt. Only called while `state === "idle"`. Rejecting puts the envelopes back at the queue head. */
  deliver(envs: Envelope[], deliveryId?: string): Promise<void>;
  /** Optional: feed envelopes into the turn that is running now. Only called while `state === "busy"`. */
  steer?(envs: Envelope[], deliveryId?: string): Promise<void>;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  /** Set by the bus. The peer said something worth sharing. */
  onMessage?: (body: string, opts?: EnvelopeOpts) => unknown;
  /** Set by the bus. */
  onState?: (state: PeerState) => void;
  /** Set by the bus. A delivery that had resolved turned out not to reach the agent: put it back. */
  onFailed?: (envs: Envelope[], failure?: { quota?: true }) => void;
  /** Correlated durable-delivery lifecycle, emitted only when the bus supplied an id. */
  onDelivery?: (receipt: DeliveryReceipt) => void;
  /** Safe restart metadata only: ids and launch parameters, never prompt/message text. */
  recoveryMetadata?(): Record<string, unknown>;
  /** Current native TUI ownership, correlated to one launcher. A start acknowledgement is never evidence. */
  terminalOwner?(launchId: string): { generation: string; nativePid?: number } | undefined;
}

export const DEFAULT_WATCHDOG_MS = 300_000;

/** State holder with a per-turn inactivity watchdog: a busy peer that goes silent is forced back to idle. */
export abstract class BasePeer implements PeerAdapter {
  /** Returns a reason (a string) when the hub refused the message (issue #38). */
  onMessage?: (body: string, opts?: EnvelopeOpts) => unknown;
  onState?: (state: PeerState) => void;
  onFailed?: (envs: Envelope[], failure?: { quota?: true }) => void;
  onDelivery?: (receipt: DeliveryReceipt) => void;
  private _state: PeerState = "offline";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextWatchdogMs: number | undefined;

  constructor(
    readonly id: PeerId,
    protected watchdogMs = DEFAULT_WATCHDOG_MS,
  ) {}

  get state(): PeerState {
    return this._state;
  }

  /** Keep the active turn's inactivity bound; a changed setting belongs to the next busy turn. */
  configureWatchdog(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new Error("invalid watchdog interval");
    this.nextWatchdogMs = ms;
  }

  protected setState(next: PeerState): void {
    if (next === "busy") {
      if (this._state !== "busy" && this.nextWatchdogMs !== undefined) this.watchdogMs = this.nextWatchdogMs;
      this.touch();
    }
    else this.clearWatchdog();
    if (next === this._state) return;
    this._state = next;
    this.onState?.(next);
  }

  /** Any sign of life from a busy peer re-arms the watchdog (it measures inactivity, not duration). */
  protected touch(ms = this.watchdogMs): void {
    this.clearWatchdog();
    this.timer = setTimeout(() => {
      if (this._state === "busy") this.onWatchdog();
    }, ms);
    this.timer.unref?.();
  }

  protected onWatchdog(): void {
    this.setState("idle");
  }

  protected delivery(receipt: DeliveryReceipt): void {
    this.onDelivery?.(receipt);
  }

  protected clearWatchdog(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  abstract deliver(envs: Envelope[], deliveryId?: string): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(reason?: string): Promise<void>;
}
