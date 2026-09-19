import { MAX_HOP, newEnvelope, type Envelope, type PeerId, type PeerState } from "./envelope.ts";
import type { PeerAdapter } from "./peers.ts";

export type BusEvent =
  | { t: "envelope"; env: Envelope; dropped?: "hop" }
  | { t: "undeliverable"; env: Envelope; peer: PeerId }
  | { t: "state"; peer: PeerId; state: PeerState };

const SEEN_CAP = 2048;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 1000;

/** N-peer fan-out. Never delivers back to `from`, caps hops, dedupes by id, queues per peer until idle. */
export class Bus {
  readonly peers = new Map<PeerId, PeerAdapter>();
  private readonly queues = new Map<PeerId, Envelope[]>();
  private readonly draining = new Set<PeerId>();
  private readonly seen = new Map<string, Envelope>();
  private readonly taps = new Set<(e: BusEvent) => void>();
  private readonly attempts = new Map<string, number>(); // `${peer}:${envelope id}` -> failed deliveries

  constructor(private readonly retryMs = RETRY_MS) {}

  add(peer: PeerAdapter): void {
    this.peers.set(peer.id, peer);
    if (!this.queues.has(peer.id)) this.queues.set(peer.id, []);
    peer.onMessage = (body, opts) => this.publish(newEnvelope(peer.id, body, opts));
    peer.onFailed = (env) => this.failed(peer.id, env);
    peer.onState = (state) => {
      this.emit({ t: "state", peer: peer.id, state });
      if (state === "idle") void this.drain(peer.id);
    };
  }

  tap(fn: (e: BusEvent) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** Returns the peers the envelope was queued for. */
  publish(env: Envelope): PeerId[] {
    if (this.seen.has(env.id)) return [];
    this.seen.set(env.id, env);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);

    if (env.hop > MAX_HOP) {
      this.emit({ t: "envelope", env, dropped: "hop" });
      return [];
    }
    this.emit({ t: "envelope", env });

    const targets = (env.to ?? [...this.peers.keys()]).filter((id) => id !== env.from && this.peers.has(id));
    for (const id of targets) {
      // ponytail: unbounded FIFO. M2 adds the 200 cap, fyi drop and status batching.
      this.queues.get(id)!.push(env);
      void this.drain(id);
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

  private async drain(id: PeerId): Promise<void> {
    if (this.draining.has(id)) return;
    this.draining.add(id);
    try {
      const peer = this.peers.get(id)!;
      const queue = this.queues.get(id)!;
      while (queue.length && peer.state === "idle") {
        const env = queue.shift()!;
        try {
          await peer.deliver(env);
        } catch {
          this.failed(id, env);
          break;
        }
      }
    } finally {
      this.draining.delete(id);
    }
  }

  /** At-least-once: back to the queue head and retried after a pause; given up after MAX_ATTEMPTS so one poison envelope cannot block the peer. */
  private failed(id: PeerId, env: Envelope): void {
    const key = `${id}:${env.id}`;
    const n = (this.attempts.get(key) ?? 0) + 1;
    if (n >= MAX_ATTEMPTS) {
      this.attempts.delete(key);
      this.emit({ t: "undeliverable", env, peer: id });
    } else {
      this.attempts.set(key, n);
      this.queues.get(id)!.unshift(env);
    }
    // The idle transition caused by the failure itself may have been swallowed by the `draining` guard.
    setTimeout(() => void this.drain(id), this.retryMs).unref?.();
  }

  private emit(e: BusEvent): void {
    for (const tap of this.taps) tap(e);
  }
}
