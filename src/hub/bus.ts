import { DIGEST, HUB, MAX_HOP, newEnvelope, parseMarker, replyAudience, type Envelope, type EnvelopeOpts, type PeerId, type PeerState, type Priority } from "./envelope.ts";
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
  /** Optional: rewrite a delivery before it goes out (M6 digest condensation). Must return its input on any failure. */
  condense?: (envs: Envelope[]) => Promise<Envelope[]>;
}

/** Serializable delivery state used by the controlled restart coordinator. Bodies stay in the private daemon file. */
export interface BusSnapshot {
  schemaVersion: 1;
  queues: Record<string, Envelope[]>;
  prefaces: Record<string, Envelope>;
  seen: Envelope[];
  attempts: Record<string, number>;
  withdrawn: string[];
}

export const DEFAULT_BUS: BusOptions = { retryMs: 1000, batchMax: 3, batchMs: 15_000, queueCap: 200 };

/**
 * What a peer may claim for its own message. A hub-native peer writes `[IMPORTANT]` on routine status reports
 * (issue #29), and `important` interrupts every recipient at once, so it only keeps it when answering an
 * `important` request that was addressed to it. `fyi` and `status` are never capped.
 */
function capPriority(peer: PeerAdapter, priority: Priority, parent: EnvelopeOpts["inReplyTo"], delivery: Envelope[] | undefined): Priority {
  if (!peer.hubNative || priority !== "important") return priority;
  if (!parent) return "status"; // nothing was asked: an unsolicited report is never urgent enough to interrupt
  // The whole delivery, not just `replyParent`: an important request addressed to the peer can share a hop with a
  // later status item, and then the parent is that status item.
  const asked = delivery ?? [parent];
  return asked.some((e) => e.priority === "important" && !!e.to?.includes(peer.id)) ? "important" : "status";
}

/** `digest` is not a peer. A reply to a condensed delivery is for the senders that condensation replaced. */
function resolveTo(to: PeerId[], originals: Envelope[] | undefined): PeerId[] {
  if (!to.includes(DIGEST)) return to;
  const senders = originals ? replyAudience(originals) : [];
  return [...new Set(to.flatMap((id) => (id === DIGEST ? senders : [id])))];
}

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
  private readonly withdrawn = new Set<string>();
  /** What each peer was last handed, next to what it stands for: an adapter that reports a failure later hands back the former. */
  private readonly lastDelivery = new Map<PeerId, { out: Envelope[]; originals: Envelope[] }>();
  private readonly attempts = new Map<string, number>(); // `${peer}:${envelope id}` -> failed deliveries
  /**
   * The queue lengths changed. `publish` emits its envelope event *before* it enqueues, and a delivery emits
   * nothing at all, so anything that renders `queued` off a bus event records the count from before the change
   * and is never corrected once the queue empties (measured: status.json kept `queued 4` on an empty queue).
   */
  onQueues?: () => void;
  private recoveryHeld = false;
  private steering = 0;
  private condensing = 0;

  constructor(opts: Partial<BusOptions> = {}) {
    this.opts = { ...DEFAULT_BUS, ...opts };
  }

  add(peer: PeerAdapter): void {
    this.peers.set(peer.id, peer);
    if (!this.queues.has(peer.id)) this.queues.set(peer.id, []);
    peer.onMessage = (text, opts) => {
      const { priority, body } = parseMarker(text);
      if (!body) return;
      // What the peer was handed differs from what it stands for once a delivery was condensed; both the audience
      // and the priority ceiling are about what it stands for.
      const last = this.lastDelivery.get(peer.id);
      const answers = opts?.inReplyTo?.id !== undefined && last?.out.some((e) => e.id === opts.inReplyTo!.id);
      const originals = answers ? last!.originals : undefined;
      this.publish(newEnvelope(peer.id, body, {
        ...opts,
        ...(opts?.to?.length ? { to: resolveTo(opts.to, originals) } : {}),
        priority: opts?.priority ?? capPriority(peer, priority, opts?.inReplyTo, originals),
      }));
    };
    peer.onFailed = (envs) => {
      // The adapter got the condensed list; what has to come back is what that list replaced.
      const last = this.lastDelivery.get(peer.id);
      const same = !!last && envs.length === last.out.length && envs.every((e, i) => e.id === last.out[i]!.id);
      this.failed(peer.id, same ? last.originals : envs);
    };
    peer.onState = () => {
      this.emit({ t: "state", peer: peer.id, state: this.stateOf(peer.id) });
      void this.drain(peer.id);
    };
  }

  /** Stop new deliveries while a coordinator takes a stable snapshot. Existing adapter turns are left alone. */
  setRecoveryHold(held: boolean): void {
    this.recoveryHeld = held;
    if (!held) for (const id of this.peers.keys()) void this.drain(id);
  }

  get isRecoveryHeld(): boolean {
    return this.recoveryHeld;
  }

  /** Wait until a hold has fenced condensation, steering and queue drains already in flight. */
  async fenceRecovery(): Promise<void> {
    this.recoveryHeld = true;
    while (this.draining.size || this.steering || this.condensing) await Bun.sleep(0);
  }

  /** A bounded, JSON-safe representation of queued work and retry/dedupe state. */
  snapshot(): BusSnapshot {
    return {
      schemaVersion: 1,
      queues: Object.fromEntries([...this.queues].map(([id, queue]) => [id, queue.map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) }))])),
      prefaces: Object.fromEntries([...this.prefaces].map(([id, e]) => [id, { ...e, ...(e.to ? { to: [...e.to] } : {}) }])),
      seen: [...this.seen.values()].map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) })),
      attempts: Object.fromEntries(this.attempts),
      withdrawn: [...this.withdrawn],
    };
  }

  /** Restore state before peers attach. Queues remain held until the coordinator calls setRecoveryHold(false). */
  restore(snapshot: BusSnapshot): void {
    if (snapshot.schemaVersion !== 1) throw new Error("unsupported bus recovery snapshot");
    this.queues.clear();
    for (const [id, queue] of Object.entries(snapshot.queues ?? {})) this.queues.set(id, queue.map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) })));
    this.prefaces.clear();
    for (const [id, e] of Object.entries(snapshot.prefaces ?? {})) this.prefaces.set(id, { ...e, ...(e.to ? { to: [...e.to] } : {}) });
    this.seen.clear();
    for (const e of snapshot.seen ?? []) this.seen.set(e.id, { ...e, ...(e.to ? { to: [...e.to] } : {}) });
    this.attempts.clear();
    for (const [key, n] of Object.entries(snapshot.attempts ?? {})) if (Number.isInteger(n) && n > 0) this.attempts.set(key, n);
    this.withdrawn.clear();
    for (const id of snapshot.withdrawn ?? []) this.withdrawn.add(id);
  }

  queueIds(id: PeerId): string[] {
    return (this.queues.get(id) ?? []).map((e) => e.id);
  }

  attemptState(): Record<string, number> {
    return Object.fromEntries(this.attempts);
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
    const existing = this.prefaces.get(id);
    if (existing) {
      // Recovery and session recall may both contribute context. Keep the original id/hop so a queued
      // preface remains deduplicated and append the new, separately generated context.
      this.prefaces.set(id, { ...existing, body: `${existing.body}\n\n${body}` });
      return;
    }
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
      if (!this.recoveryHeld && env.priority === "important" && peer.steer && this.stateOf(id) === "busy") {
        // Not queued while the steer is in flight, or an idle transition would deliver it a second time.
        this.steering++;
        peer.steer([env]).catch(() => this.enqueue(id, env, true)).finally(() => { this.steering--; });
      } else this.enqueue(id, env);
    }
    return targets;
  }

  /** A recently published envelope, for resolving `reply_to`. */
  get(id: string): Envelope | undefined {
    return this.seen.get(id);
  }

  /**
   * Take back an envelope that has not been delivered yet (a request that has expired). True when it was removed from a
   * queue now; an envelope whose steer is still in flight is not in any queue, so its id is remembered and it is
   * dropped if the refused steer tries to queue it later.
   */
  withdraw(envelopeId: string): boolean {
    this.withdrawn.add(envelopeId);
    if (this.withdrawn.size > 256) this.withdrawn.delete(this.withdrawn.values().next().value as string);
    let removed = false;
    for (const queue of this.queues.values()) {
      const i = queue.findIndex((e) => e.id === envelopeId);
      if (i !== -1) removed = queue.splice(i, 1).length > 0;
    }
    if (removed) this.onQueues?.();
    return removed;
  }

  queued(id: PeerId): number {
    return this.queues.get(id)?.length ?? 0;
  }

  /**
   * Queued envelopes that skip the batch window (issue #41: `queued 3` hid which ones the peer still waits out).
   * An `important` envelope that is in a queue is one that could not be steered, so it does not interrupt a
   * running turn; it is why the queue is delivered the moment the peer goes idle.
   */
  queuedImportant(id: PeerId): number {
    return (this.queues.get(id) ?? []).filter((e) => e.priority === "important").length;
  }

  private enqueue(id: PeerId, env: Envelope, front = false): void {
    if (this.withdrawn.has(env.id)) return;
    const queue = this.queues.get(id)!;
    if (front) queue.unshift(env);
    else queue.push(env);
    if (queue.length > this.opts.queueCap) {
      const victim = queue.findIndex((e) => e.priority !== "important");
      const [lost] = queue.splice(victim === -1 ? 0 : victim, 1);
      this.emit({ t: "overflow", env: lost!, peer: id });
    }
    this.onQueues?.();
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
      while (!this.recoveryHeld && queue.length && this.stateOf(id) === "idle") {
        const wait = this.wait(queue);
        if (wait > 0) {
          this.arm(id, wait);
          break;
        }
        const preface = this.prefaces.get(id);
        this.prefaces.delete(id);
        const batch = this.take(id, queue);
        const delivery = preface ? [preface, ...batch] : batch;
        // What goes out may be condensed; what comes back on failure is always the originals. An important envelope
        // is why the queue became ready, so it never waits on a model call.
        const mayCondense = this.opts.condense && !delivery.some((e) => e.priority === "important");
        this.condensing += mayCondense ? 1 : 0;
        const out = mayCondense ? await this.opts.condense!(delivery).catch(() => delivery) : delivery;
        this.condensing -= mayCondense ? 1 : 0;
        if (this.recoveryHeld || (mayCondense && this.stateOf(id) !== "idle")) {
          // The peer got busy while the delivery was prepared. Nothing was attempted: back to the head of the queue,
          // without counting against the envelopes.
          if (preface) this.prefaces.set(id, preface);
          queue.unshift(...batch.filter((e) => !this.withdrawn.has(e.id)));
          break;
        }
        // A reply may name any item of `out` as its parent (Claude's reply_to): the digest has to be resolvable too.
        for (const e of out) if (!this.seen.has(e.id)) this.seen.set(e.id, e);
        this.lastDelivery.set(id, { out, originals: delivery });
        try {
          await peer.deliver(out);
        } catch {
          this.failed(id, delivery);
          break;
        }
      }
    } finally {
      this.draining.delete(id);
      this.onQueues?.();
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
