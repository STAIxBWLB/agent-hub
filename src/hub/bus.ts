import { HUB, MAX_HOP, newEnvelope, parseMarker, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import type { PeerAdapter } from "./peers.ts";

export type BusEvent =
  | { t: "envelope"; env: Envelope; dropped?: "hop" | "fyi" }
  | { t: "overflow"; env: Envelope; peer: PeerId }
  | { t: "undeliverable"; env: Envelope; peer: PeerId }
  | { t: "state"; peer: PeerId; state: PeerState };

export interface BusOptions {
  retryMs: number;
  /** A queue this long is delivered without waiting for the batch window. */
  batchMax: number;
  /** How long a status envelope may wait for company before it is delivered on its own. */
  batchMs: number;
  queueCap: number;
}
export const DEFAULT_BUS: BusOptions = { retryMs: 1000, batchMax: 3, batchMs: 15_000, queueCap: 200 };

const SEEN_CAP = 2048;
const MAX_ATTEMPTS = 3;
const DIGEST_MAX = 10;

/**
 * N-peer fan-out. Never delivers back to `from`, caps hops, dedupes by id. Each peer has one queue,
 * delivered as a whole (one envelope, or a digest) when the peer is idle and the queue is ready:
 * it holds an `important` envelope, or `batchMax` envelopes, or its oldest one has waited `batchMs`.
 */
export class Bus {
  readonly peers = new Map<PeerId, PeerAdapter>();
  private readonly opts: BusOptions;
  private readonly queues = new Map<PeerId, Envelope[]>();
  private readonly prefaces = new Map<PeerId, Envelope>();
  private readonly paused = new Set<PeerId>();
  private readonly timers = new Map<PeerId, ReturnType<typeof setTimeout>>();
  private readonly draining = new Set<PeerId>();
  private readonly seen = new Map<string, Envelope>();
  private readonly taps = new Set<(e: BusEvent) => void>();
  private readonly attempts = new Map<string, number>(); // `${peer}:${envelope id}` -> failed deliveries

  constructor(opts: Partial<BusOptions> = {}) {
    this.opts = { ...DEFAULT_BUS, ...opts };
  }

  add(peer: PeerAdapter): void {
    this.peers.set(peer.id, peer);
    if (!this.queues.has(peer.id)) this.queues.set(peer.id, []);
    peer.onMessage = (text, opts) => {
      const { priority, body } = parseMarker(text);
      if (body) this.publish(newEnvelope(peer.id, body, { priority, ...opts }));
    };
    peer.onFailed = (envs) => this.failed(peer.id, envs);
    peer.onState = () => {
      this.emit({ t: "state", peer: peer.id, state: this.stateOf(peer.id) });
      void this.drain(peer.id);
    };
  }

  tap(fn: (e: BusEvent) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** The adapter's state, or `paused` while the peer is held by `pause()`. */
  stateOf(id: PeerId): PeerState {
    const state = this.peers.get(id)?.state ?? "offline";
    return this.paused.has(id) && state !== "offline" ? "paused" : state;
  }

  pause(id: PeerId): void {
    this.paused.add(id);
    this.emit({ t: "state", peer: id, state: this.stateOf(id) });
  }

  resume(id: PeerId): void {
    if (!this.paused.delete(id)) return;
    this.emit({ t: "state", peer: id, state: this.stateOf(id) });
    void this.drain(id);
  }

  /** Context the hub wants the peer to see once: it rides in front of the next delivery instead of costing a turn of its own. */
  preface(id: PeerId, body: string): void {
    this.prefaces.set(id, newEnvelope(HUB, body, { to: [id], kind: "presence" }));
  }

  /** Returns the peers the envelope was queued for. */
  publish(env: Envelope): PeerId[] {
    if (this.seen.has(env.id)) return [];
    this.seen.set(env.id, env);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);

    // fyi is for the record (console now, task board from M4), never worth an agent's turn.
    const dropped = env.hop > MAX_HOP ? "hop" : env.priority === "fyi" ? "fyi" : undefined;
    this.emit({ t: "envelope", env, ...(dropped ? { dropped } : {}) });
    if (dropped) return [];

    const targets = (env.to ?? [...this.peers.keys()]).filter((id) => id !== env.from && this.peers.has(id));
    for (const id of targets) {
      const peer = this.peers.get(id)!;
      if (env.priority === "important" && peer.steer && this.stateOf(id) === "busy") {
        // Not queued while the steer is in flight, or an idle transition would deliver it a second time.
        peer.steer([env]).catch(() => this.enqueue(id, env, true));
      } else this.enqueue(id, env);
    }
    return targets;
  }

  /** A recently published envelope, for resolving `reply_to`. */
  get(id: string): Envelope | undefined {
    return this.seen.get(id);
  }

  queued(id: PeerId): number {
    return this.queues.get(id)?.length ?? 0;
  }

  private enqueue(id: PeerId, env: Envelope, front = false): void {
    const queue = this.queues.get(id)!;
    if (front) queue.unshift(env);
    else queue.push(env);
    if (queue.length > this.opts.queueCap) {
      const victim = queue.findIndex((e) => e.priority !== "important");
      const [lost] = queue.splice(victim === -1 ? 0 : victim, 1);
      this.emit({ t: "overflow", env: lost!, peer: id });
    }
    void this.drain(id);
  }

  /** 0 = deliver now; otherwise how long the oldest envelope still has to wait for company. */
  private wait(queue: Envelope[]): number {
    if (queue.length >= this.opts.batchMax || queue.some((e) => e.priority === "important")) return 0;
    return Math.max(0, queue[0]!.ts + this.opts.batchMs - Date.now());
  }

  private async drain(id: PeerId): Promise<void> {
    if (this.draining.has(id)) return;
    this.draining.add(id);
    try {
      const peer = this.peers.get(id)!;
      const queue = this.queues.get(id)!;
      while (queue.length && this.stateOf(id) === "idle") {
        const wait = this.wait(queue);
        if (wait > 0) {
          this.arm(id, wait);
          break;
        }
        const preface = this.prefaces.get(id);
        this.prefaces.delete(id);
        const batch = this.take(id, queue);
        const delivery = preface ? [preface, ...batch] : batch;
        try {
          await peer.deliver(delivery);
        } catch {
          this.failed(id, delivery);
          break;
        }
      }
    } finally {
      this.draining.delete(id);
    }
  }

  /**
   * The next delivery: important envelopes first (they are why the queue is ready), then the rest in order.
   * An envelope that already failed once goes alone, so a poison one cannot take a digest down with it.
   */
  private take(id: PeerId, queue: Envelope[]): Envelope[] {
    const ordered = [...queue.filter((e) => e.priority === "important"), ...queue.filter((e) => e.priority !== "important")];
    const batch: Envelope[] = [];
    for (const env of ordered) {
      const failedBefore = this.attempts.has(`${id}:${env.id}`);
      if (failedBefore && batch.length) break;
      batch.push(env);
      if (failedBefore || batch.length === DIGEST_MAX) break;
    }
    for (const env of batch) queue.splice(queue.indexOf(env), 1);
    return batch;
  }

  private arm(id: PeerId, ms: number): void {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => void this.drain(id), ms);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** At-least-once: back to the queue head and retried after a pause; given up after MAX_ATTEMPTS so one poison envelope cannot block the peer. */
  private failed(id: PeerId, envs: Envelope[]): void {
    const keep = envs.filter((env) => {
      // Only the recall block is a preface. The hub also sends task and review envelopes, and those are retried like any other.
      if (env.from === HUB && env.kind === "presence") {
        this.prefaces.set(id, env); // rides again on the next delivery, without counting as a failed envelope
        return false;
      }
      const key = `${id}:${env.id}`;
      const n = (this.attempts.get(key) ?? 0) + 1;
      if (n < MAX_ATTEMPTS) return this.attempts.set(key, n);
      this.attempts.delete(key);
      this.emit({ t: "undeliverable", env, peer: id });
      return false;
    });
    this.queues.get(id)!.unshift(...keep);
    // The idle transition caused by the failure itself may have been swallowed by the `draining` guard.
    this.arm(id, this.opts.retryMs);
  }

  private emit(e: BusEvent): void {
    for (const tap of this.taps) tap(e);
  }
}
