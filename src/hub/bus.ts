import { appendNote, DIGEST, HUB, keepNotes, MAX_HOP, newEnvelope, noteLine, parseMarker, quoteNotes, replyAudience, type Envelope, type EnvelopeOpts, type PeerId, type PeerState, type Priority } from "./envelope.ts";
import type { PeerAdapter } from "./peers.ts";
import { DeliveryJournal, type JournalDelivery, type JournalDeliveryState } from "./delivery-journal.ts";

export interface DeliveryReceipt {
  id: string;
  state: "accepted" | "completed" | "failed_safe" | "needs_review";
  reason?: string;
}

export type BusEvent =
  | { t: "envelope"; env: Envelope; dropped?: "hop" | "fyi" }
  | { t: "overflow"; env: Envelope; peer: PeerId }
  | { t: "undeliverable"; env: Envelope; peer: PeerId; reason?: string }
  | { t: "stale"; env: Envelope; peer: PeerId; reason: string }
  | { t: "quiet"; env: Envelope; peers: PeerId[]; reason: string }
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
  journal?: DeliveryJournal;
  /**
   * Optional: may an agent send this envelope now (issue #38)? `parent` is the id of what it answers. A reason refuses
   * it, and the sender hears it on its next delivery.
   */
  admit?: (env: Envelope, parent?: string) => string | undefined;
  /**
   * Optional: does a queued envelope still matter to this recipient (issue #106)? Asked per recipient when a delivery is
   * built and again right before it is handed over, after condensation. False drops it unsent: the journal records it
   * as discarded and taps see a `stale` event.
   */
  relevant?: (peer: PeerId, env: Envelope) => boolean;
  /**
   * Optional: why this recipient does not get this envelope (issue #107, a turn-free cohort). Asked per recipient once
   * the audience is final (implicit replies and `digest` resolved), so the other recipients still get it, unchanged;
   * the console and the log see it as published.
   */
  silence?: (env: Envelope, peer: PeerId) => string | undefined;
}

/** Serializable delivery state used by the controlled restart coordinator. Bodies stay in the private daemon file. */
export interface BusSnapshot {
  schemaVersion: 1;
  queues: Record<string, Envelope[]>;
  prefaces: Record<string, Envelope>;
  seen: Envelope[];
  attempts: Record<string, number>;
  withdrawn: string[];
  manualPaused?: string[];
  journal?: ReturnType<DeliveryJournal["snapshot"]>;
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
// ponytail: one digest carries at most ten originals; larger supervision windows split into bounded deliveries.
// Revisit this ceiling after measuring native supervision cost, rather than bypassing the delivery limit.
const DIGEST_MAX = 10;
const NOTES_KEPT = 10;

/**
 * N-peer fan-out. Never delivers back to `from`, caps hops, dedupes by id. Each peer has one queue,
 * delivered as a whole (one envelope, or a digest) when the peer is idle and the queue is ready:
 * it holds an `important` envelope, or `batchMax` envelopes, or its oldest one has waited `batchMs`.
 */
export class Bus {
  readonly peers = new Map<PeerId, PeerAdapter>();
  private readonly opts: BusOptions;
  private readonly journal?: DeliveryJournal;
  private readonly queues = new Map<PeerId, Envelope[]>();
  private readonly prefaces = new Map<PeerId, Envelope>();
  private readonly paused = new Set<PeerId>();
  private readonly manualPaused = new Set<PeerId>();
  private readonly timers = new Map<PeerId, ReturnType<typeof setTimeout>>();
  private readonly draining = new Set<PeerId>();
  /** Still pending while an asynchronous condensation runs; never includes native dispatches. */
  private readonly preparing = new Map<PeerId, Envelope[]>();
  private readonly seen = new Map<string, Envelope>();
  private readonly taps = new Set<(e: BusEvent) => void>();
  private readonly withdrawn = new Set<string>();
  /** What each peer was last handed, next to what it stands for: an adapter that reports a failure later hands back the former. */
  private readonly lastDelivery = new Map<PeerId, { out: Envelope[]; originals: Envelope[] }>();
  private readonly failureStreak = new Map<PeerId, number>();
  private readonly lastFailure = new Map<PeerId, string>();
  private readonly attempts = new Map<string, number>(); // `${peer}:${envelope id}` -> failed deliveries
  /** Correlates each native receipt independently; a peer can have a steer and a delivery in flight. */
  private readonly activeDeliveries = new Map<string, PeerId>();
  private readonly pendingOutcomes: Omit<JournalDelivery, "revision" | "updatedAt">[] = [];
  private suppressDrain = false;
  private readonly recoveryHeldPeers = new Set<PeerId>();
  /**
   * The queue lengths changed. `publish` emits its envelope event *before* it enqueues, and a delivery emits
   * nothing at all, so anything that renders `queued` off a bus event records the count from before the change
   * and is never corrected once the queue empties (measured: status.json kept `queued 4` on an empty queue).
   */
  onQueues?: () => void;
  /** Actual transport admission, using originals even when a digest was condensed. Never an enqueue metric. */
  onDelivered?: (peer: PeerId, originals: Envelope[]) => void;
  /** Synchronous native failure observation, before queue callbacks can finish turn metrics. */
  onDeliveryFailed?: (peer: PeerId) => void;
  private recoveryHeld = false;
  private steering = 0;
  private condensing = 0;
  private closed = false;
  storageError?: string;

  constructor(opts: Partial<BusOptions> = {}) {
    this.opts = { ...DEFAULT_BUS, ...opts };
    this.journal = opts.journal;
    if (this.journal) {
      const state = this.journal.snapshot();
      const bus = state.bus as BusSnapshot;
      if (state.revision > 0 && bus && bus.schemaVersion === 1) this.loadSnapshot(bus);
      for (const id of state.manualPaused) { this.manualPaused.add(id); this.paused.add(id); }
      for (const row of this.journal.list()) {
        if (row.state === "needs_review" || row.state === "dispatching" || row.state === "accepted") this.recoveryHeldPeers.add(row.peer);
      }
    }
  }

  add(peer: PeerAdapter): void {
    this.peers.set(peer.id, peer);
    if (!this.queues.has(peer.id)) this.queues.set(peer.id, []);
    peer.onDelivery = (receipt) => this.deliveryReceipt(peer.id, receipt);
    peer.onMessage = (text, opts) => {
      const { priority, body } = parseMarker(text);
      if (!body) return;
      // What the peer was handed differs from what it stands for once a delivery was condensed; both the audience
      // and the priority ceiling are about what it stands for.
      const last = this.lastDelivery.get(peer.id);
      const answers = opts?.inReplyTo?.id !== undefined && last?.out.some((e) => e.id === opts.inReplyTo!.id);
      const originals = answers ? last!.originals : undefined;
      // `digest` in the audience stands for the condensed delivery even when a steer, not the digest, is the parent.
      const condensed = !!last?.out.some((e) => e.from === DIGEST);
      const audienceOriginals = originals ?? (opts?.to?.includes(DIGEST) && condensed ? last?.originals : undefined);
      const to = opts?.to?.length ? resolveTo(opts.to, audienceOriginals) : undefined;
      let env = newEnvelope(peer.id, body, { ...opts, ...(to ? { to } : {}), priority: opts?.priority ?? capPriority(peer, priority, opts?.inReplyTo, originals) });
      // Limits count what is sent: the envelope as built (a reply goes to its parent's sender, `digest` is resolved,
      // the priority is capped), never the raw `to`.
      const parent = opts?.inReplyTo?.id;
      // Held back from every recipient (issue #107): nothing goes out, so nothing counts against the sender's limits.
      const hushed = this.hushed(env);
      const heldBack = hushed.length > 0 && hushed.length === this.audience(env).length;
      let refused = heldBack ? undefined : this.opts.admit?.(env, parent);
      // A turn answer has no caller to refuse: over its important budget it goes out as status, not at all.
      if (refused && env.priority === "important" && !this.opts.admit?.({ ...env, priority: "status" }, parent)) {
        // It went out, so the advice on how to send it does not apply.
        this.note(peer.id, noteLine(HUB, "decision", `your [IMPORTANT] message went out as status: ${refused.replace(/[;:] (retry after \d+ s, or )?send it without \[IMPORTANT\]$/, "")}`));
        env = { ...env, priority: "status" };
        refused = undefined;
      }
      if (refused) {
        this.note(peer.id, noteLine(HUB, "decision", `your message was not delivered: ${refused}`));
        return refused;
      }
      this.publish(env);
      // The sender's result (issue #107): a turn answer has no caller, so it hears it on its next delivery. It counts as
      // not sent only when nobody got it.
      if (hushed.length) this.note(peer.id, noteLine(HUB, "decision", `your message was not delivered to ${hushed.map((h) => h.peer).join(", ")}: ${hushed[0]!.reason}`));
      return heldBack ? hushed[0]!.reason : undefined;
    };
    peer.onFailed = (envs) => {
      // The adapter got the condensed list; what has to come back is what that list replaced.
      const last = this.lastDelivery.get(peer.id);
      const same = !!last && envs.length === last.out.length && envs.every((e, i) => e.id === last.out[i]!.id);
      if (this.journal) {
        for (const [deliveryId, owner] of this.activeDeliveries) {
          if (owner !== peer.id) continue;
          const row = this.journal.get(deliveryId);
          if (row && row.originals.some((e) => envs.some((incoming) => incoming.id === e.id))) {
            this.deliveryReceipt(peer.id, { id: deliveryId, state: "needs_review", reason: "adapter reported delivery failure without safe-failure evidence" });
          }
        }
      } else this.failed(peer.id, same ? last.originals : envs);
    };
    peer.onState = () => {
      if (this.closed) return;
      if (this.peers.get(peer.id) !== peer) return;
      if (peer.state === "offline" && this.journal) {
        for (const [id, owner] of [...this.activeDeliveries]) if (owner === peer.id) this.uncertain(peer.id, id, "peer disconnected before delivery settlement");
      }
      this.emit({ t: "state", peer: peer.id, state: this.stateOf(peer.id) });
      void this.drain(peer.id);
    };
  }

  private persist(): void {
    if (!this.journal) return;
    try {
      this.journal.transaction(() => {
        for (const outcome of this.pendingOutcomes) this.journal!.createDelivery(outcome);
        this.journal!.persistBus(this.snapshotWithoutJournal(), [...this.manualPaused]);
      });
      this.pendingOutcomes.length = 0;
      this.storageError = undefined;
    }
    catch { this.storageError = "delivery journal unavailable"; throw new Error("delivery journal unavailable"); }
  }

  private durableHandoff(peer: PeerId, deliveryId: string, originals: Envelope[], out: Envelope[]): void {
    if (!this.journal) return;
    const delivery = { id: deliveryId, peer, state: "dispatching" as const, createdAt: Date.now(), originals, out };
    this.journal.checkpointDelivery(this.snapshotWithoutJournal(), delivery);
  }

  private snapshotWithoutJournal(): BusSnapshot {
    return this.snapshot(false);
  }

  /** Stop new deliveries while a coordinator takes a stable snapshot. Existing adapter turns are left alone. */
  setRecoveryHold(held: boolean): void {
    this.recoveryHeld = held;
    if (!held) for (const id of this.peers.keys()) void this.drain(id);
  }

  get isRecoveryHeld(): boolean {
    return this.recoveryHeld;
  }

  /**
   * Wait until a hold has fenced condensation, steering and queue drains already in flight.
   * A drain stuck on a peer that never settles must not spin a core forever (issue #56):
   * the wait backs off and gives up, leaving queues, in-flight deliveries and a hold the
   * caller did not set exactly as they were.
   */
  async fenceRecovery(timeoutMs = 5_000): Promise<void> {
    const heldBefore = this.recoveryHeld;
    this.recoveryHeld = true;
    const deadline = Date.now() + timeoutMs;
    let delay = 1;
    while (this.draining.size || this.steering || this.condensing) {
      if (Date.now() >= deadline) {
        this.recoveryHeld = heldBefore;
        throw new Error(`recovery fence timed out after ${timeoutMs} ms with ${this.draining.size + this.steering + this.condensing} deliveries still in flight; retry the operation`);
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 50);
    }
  }

  /** A bounded, JSON-safe representation of queued work and retry/dedupe state. */
  snapshot(includeJournal = true): BusSnapshot {
    const out: BusSnapshot = {
      schemaVersion: 1,
      queues: Object.fromEntries([...this.queues].map(([id, queue]) => [id, queue.map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) }))])),
      prefaces: Object.fromEntries([...this.prefaces].map(([id, e]) => [id, { ...e, ...(e.to ? { to: [...e.to] } : {}) }])),
      seen: [...this.seen.values()].map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) })),
      attempts: Object.fromEntries(this.attempts),
      withdrawn: [...this.withdrawn],
      manualPaused: [...this.manualPaused],
    };
    if (includeJournal && this.journal) out.journal = this.journal.snapshot();
    return out;
  }

  /** Restore state before peers attach. Queues remain held until the coordinator calls setRecoveryHold(false). */
  restore(snapshot: BusSnapshot, _operationId?: string): void {
    if (snapshot.schemaVersion !== 1) throw new Error("unsupported bus recovery snapshot");
    if (_operationId && this.journal) {
      const current = this.journal.snapshot();
      if (current.revision === 0) {
        this.journal.importSnapshot(snapshot.journal ?? { schemaVersion: 1, revision: 1, instanceId: this.journal.instanceId, bus: snapshot, deliveries: [], manualPaused: snapshot.manualPaused ?? [] }, _operationId);
      }
      snapshot = this.journal.snapshot().bus;
    }
    this.loadSnapshot(snapshot);
    this.persist();
  }

  private loadSnapshot(snapshot: BusSnapshot): void {
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
    if (snapshot.manualPaused) { this.manualPaused.clear(); this.paused.clear(); for (const id of snapshot.manualPaused) { this.manualPaused.add(id); this.paused.add(id); } }
  }

  knownPeers(): string[] {
    const pending = this.storageError ? [] : this.journal?.list().filter((row) => ["queued", "dispatching", "accepted", "needs_review"].includes(row.state)).map((row) => row.peer) ?? [];
    return [...new Set([...this.peers.keys(), ...[...this.queues].filter(([, queue]) => queue.length).map(([id]) => id), ...pending])].sort();
  }

  queueList(peer?: string): JournalDelivery[] {
    if (this.journal) {
      const rows = this.journal.list(peer).filter((row) => !row.reason?.startsWith("grouped into delivery "));
      const revision = this.journal.snapshot().revision;
      const recorded = new Set(rows.filter((r) => ["queued", "dispatching", "accepted", "needs_review"].includes(r.state)).flatMap((r) => (r.originals as Envelope[]).map((e) => `${r.peer}:${e.id}`)));
      const ids = peer ? [peer] : [...this.queues.keys()];
      for (const p of ids) for (const e of this.queues.get(p) ?? []) if (!recorded.has(`${p}:${e.id}`)) rows.push({ id: `q:${p}:${e.id}`, peer: p, state: "queued", revision, createdAt: e.ts, updatedAt: e.ts, originals: [e], out: [e] });
      return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    const ids = peer ? [peer] : [...this.queues.keys()];
    return ids.flatMap((p) => (this.queues.get(p) ?? []).map((e) => ({ id: e.id, peer: p, state: "queued" as const, revision: 0, createdAt: e.ts, updatedAt: e.ts, originals: [e], out: [e] })));
  }

  queueShow(id: string): JournalDelivery | undefined { return this.journal?.get(id) ?? this.queueList().find((d) => d.id === id); }

  resolveDelivery(id: string, revision: number, action: "completed" | "retry" | "discard", reason: string): void {
    if (!this.journal || this.storageError) throw new Error("delivery journal unavailable");
    const record = this.queueShow(id);
    if (!record) throw new Error("unknown delivery");
    const previous = this.journal.resolution(id);
    if (previous) {
      this.journal.resolve(id, revision, action, reason); // verifies identical request; no second enqueue
      return;
    }
    if (["dispatching", "accepted"].includes(record.state) || this.peers.get(record.peer)?.state === "busy") throw new Error("active delivery cannot be resolved");
    if (record.revision !== revision) throw new Error("stale delivery revision");
    if (record.state === "queued" && action === "retry") throw new Error("queued delivery is already scheduled");
    if (action === "retry" && (this.queues.get(record.peer)?.length ?? 0) + record.originals.length > this.opts.queueCap) throw new Error("recipient queue is full");
    const before = this.snapshotWithoutJournal();
    try {
      this.journal.transaction(() => {
        if (!this.journal!.get(id)) this.journal!.createDelivery({ ...record });
        const current = this.journal!.get(id)!;
        this.journal!.resolve(id, current.revision, action, reason, revision);
        if (record.state === "queued") {
          const ids = new Set(record.originals.map((env) => env.id));
          this.queues.set(record.peer, (this.queues.get(record.peer) ?? []).filter((env) => !ids.has(env.id)));
        }
        if (action === "retry") {
          const queue = this.queues.get(record.peer) ?? [];
          for (const env of record.originals) {
            if (env.from === HUB && env.kind === "presence") this.restorePreface(record.peer, env);
            else if (!queue.some((old) => old.id === env.id)) queue.push(env);
          }
          this.queues.set(record.peer, queue);
        }
        this.persist();
      });
    } catch (error) { this.loadSnapshot(before); throw error; }
    this.refreshRecoveryHold(record.peer);
    this.onQueues?.();
    void this.drain(record.peer);
  }

  queueSummary(peer: string): { needsReview: number; heldBy?: string; liveAccepted?: string[]; oldestQueuedAt?: number } {
    const rows = this.storageError ? [] : this.queueList(peer);
    const queued = this.queues.get(peer) ?? [];
    const review = rows.filter((r) => r.state === "needs_review");
    const needsReview = review.length;
    const blocked = rows.find((r) => r.state === "needs_review" || (["dispatching", "accepted"].includes(r.state) && !this.activeDeliveries.has(r.id)));
    const liveAccepted = rows.filter((r) => r.state === "accepted" && this.activeDeliveries.get(r.id) === peer).map((r) => r.id);
    const hold = { ...(blocked ? { heldBy: blocked.id } : {}), ...(liveAccepted.length ? { liveAccepted } : {}) };
    const oldest = queued.reduce<number | undefined>((a, r) => a === undefined ? r.ts : Math.min(a, r.ts), undefined);
    return oldest === undefined ? { needsReview, ...hold } : { needsReview, ...hold, oldestQueuedAt: oldest };
  }

  manualPausedPeers(): string[] { return [...this.manualPaused].sort(); }
  setManualPaused(ids: string[]): void { this.manualPaused.clear(); for (const id of ids) this.manualPaused.add(id); this.persist(); }
  closeJournal(): void {
    this.closed = true;
    this.recoveryHeld = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.journal?.close();
  }

  deliveryReceipt(peer: PeerId, receipt: DeliveryReceipt): void {
    if (this.closed) return;
    const owner = this.activeDeliveries.get(receipt.id);
    if (!owner || owner !== peer || !this.journal) return;
    const id = receipt.id;
    const before = this.journal.get(id);
    const state: JournalDeliveryState = receipt.state === "accepted" ? "accepted" : receipt.state === "completed" ? "completed" : receipt.state === "failed_safe" ? "failed" : "needs_review";
    if (state === "failed" || state === "needs_review") this.deliveryFailed(peer);
    this.journal.transition(id, state, receipt.reason);
    if (before?.state === "dispatching" && (state === "accepted" || state === "completed")) this.delivered(peer, before.originals);
    if (state === "failed") {
      if (before) this.failed(peer, before.originals, before.originals.some((e) => e.private) ? "private delivery failed" : receipt.reason);
    }
    if (state === "completed") { this.failureStreak.delete(peer); this.lastFailure.delete(peer); }
    if (state === "completed" || state === "failed" || state === "needs_review") this.activeDeliveries.delete(id);
    if (state === "completed" || state === "failed") { this.refreshRecoveryHold(peer); void this.drain(peer); }
    if (state === "needs_review") this.recoveryHeldPeers.add(peer);
    this.onQueues?.();
  }

  private refreshRecoveryHold(peer: PeerId): void {
    if (!this.journal) return;
    // Live accepted notifications are awaiting explicit correlation, not crash recovery.
    const blocked = this.journal.list(peer).some((r) => r.state === "needs_review" || (["dispatching", "accepted"].includes(r.state) && this.activeDeliveries.get(r.id) !== peer));
    if (blocked) this.recoveryHeldPeers.add(peer); else this.recoveryHeldPeers.delete(peer);
  }

  completeReply(peer: PeerId, envelopeId: string): void {
    if (!this.journal) return;
    for (const [id, owner] of this.activeDeliveries) {
      if (owner !== peer) continue;
      const row = this.journal.get(id);
      if (row?.out.some((e) => e.id === envelopeId)) {
        this.journal.transition(id, "completed", "correlated reply");
        this.activeDeliveries.delete(id);
        this.refreshRecoveryHold(peer);
        this.onQueues?.();
        void this.drain(peer);
        break;
      }
    }
  }

  /** Explicit completion never resolves recovered, unrelated or already uncertain work. */
  completeDelivery(peer: PeerId, deliveryId: string): boolean {
    const row = this.journal?.get(deliveryId);
    // The bridge separately fences socket/generation/handed IDs. Retrying a completed
    // acknowledgement (or acknowledging after a correlated reply) changes nothing.
    if (row?.peer === peer && row.state === "completed") return true;
    if (this.activeDeliveries.get(deliveryId) !== peer || row?.state !== "accepted") return false;
    this.deliveryReceipt(peer, { id: deliveryId, state: "completed", reason: "explicit correlated completion" });
    return true;
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

  /** Paused by the console or the budget relay, whatever the adapter's own state. */
  isPaused(id: PeerId): boolean {
    return this.paused.has(id);
  }

  /** The adapter's state, or `paused` while the peer is held by `pause()`. */
  stateOf(id: PeerId): PeerState {
    const state = this.peers.get(id)?.state ?? "offline";
    return this.paused.has(id) && state !== "offline" ? "paused" : state;
  }

  pause(id: PeerId): void {
    this.paused.add(id);
    this.persist();
    this.emit({ t: "state", peer: id, state: this.stateOf(id) });
  }

  resume(id: PeerId): void {
    if (!this.paused.delete(id)) return;
    this.persist();
    this.emit({ t: "state", peer: id, state: this.stateOf(id) });
    void this.drain(id);
  }

  /** Context the hub wants the peer to see once: it rides in front of the next delivery instead of costing a turn of its own. */
  preface(id: PeerId, text: string): void {
    const body = quoteNotes(text);
    const existing = this.prefaces.get(id);
    if (existing) {
      // Recovery and session recall may both contribute context. Keep the original id/hop so a queued
      // preface remains deduplicated and append the new, separately generated context.
      this.prefaces.set(id, { ...existing, body: `${existing.body}\n\n${body}` });
      this.persist();
      return;
    }
    this.prefaces.set(id, newEnvelope(HUB, body, { to: [id], kind: "presence" }));
    this.persist();
  }

  /** Another peer's shared note: rides in the preface like recall. The newest NOTES_KEPT stay; older ones remain in claude-mem. */
  note(id: PeerId, line: string): void {
    const existing = this.prefaces.get(id);
    this.prefaces.set(id, existing ? { ...existing, body: keepNotes(appendNote(existing.body, line), NOTES_KEPT) } : newEnvelope(HUB, line, { to: [id], kind: "presence" }));
    this.persist();
  }

  /** A preface that went out with a failed delivery comes back ahead of whatever was prefaced meanwhile, instead of replacing it. */
  private restorePreface(id: PeerId, env: Envelope): void {
    const now = this.prefaces.get(id);
    this.prefaces.set(id, !now ? env : now.id === env.id ? now : { ...env, body: keepNotes(`${env.body}\n\n${now.body}`, NOTES_KEPT) });
  }

  /** Returns the peers the envelope was queued for. */
  publish(env: Envelope): PeerId[] {
    if (this.storageError) throw new Error("delivery journal unavailable");
    if (this.seen.has(env.id)) return [];
    this.seen.set(env.id, env);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);

    // fyi is for the record (console now, task board from M4), never worth an agent's turn.
    const dropped = env.hop > MAX_HOP ? "hop" : env.priority === "fyi" ? "fyi" : undefined;
    this.emit({ t: "envelope", env, ...(dropped ? { dropped } : {}) });
    if (dropped) { this.persist(); return []; }

    const hushed = this.hushed(env);
    if (hushed.length) this.emit({ t: "quiet", env, peers: hushed.map((h) => h.peer), reason: hushed[0]!.reason });
    const targets = this.audience(env).filter((id) => !hushed.some((h) => h.peer === id));
    this.suppressDrain = !!this.journal;
    try { for (const id of targets) {
      const peer = this.peers.get(id);
      if (!peer) { this.enqueue(id, env); continue; }
      if (!this.journal && !this.recoveryHeld && !this.recoveryHeldPeers.has(id) && env.priority === "important" && peer.steer && this.stateOf(id) === "busy") {
        // Not queued while the steer is in flight, or an idle transition would deliver it a second time.
        this.steering++;
        const deliveryId = crypto.randomUUID();
        this.activeDeliveries.set(deliveryId, id);
        if (this.journal) this.durableHandoff(id, deliveryId, [env], [env]);
        const steerResult = this.journal ? peer.steer([env], deliveryId) : peer.steer([env]);
        steerResult.then(() => { this.delivered(id, [env]); }).catch(() => {
          this.deliveryFailed(id);
          if (this.journal) this.journal.transition(deliveryId, "needs_review", "adapter steering outcome is uncertain");
          this.activeDeliveries.delete(deliveryId);
          if (!this.journal) this.enqueue(id, env, true);
        }).finally(() => { this.steering--; });
      } else this.enqueue(id, env);
    } } finally { this.suppressDrain = false; }
    if (this.journal) {
      this.persist();
      this.onQueues?.();
      for (const id of targets) {
        const peer = this.peers.get(id);
        if (!this.recoveryHeld && !this.recoveryHeldPeers.has(id) && env.priority === "important" && peer?.steer && this.stateOf(id) === "busy") void this.steerQueued(id, env);
        else void this.drain(id);
      }
    }
    return targets;
  }

  /** Who an envelope is queued for: its `to`, or every peer but its sender. */
  audience(env: Envelope): PeerId[] {
    const known = new Set([...this.peers.keys(), ...this.queues.keys(), ...(this.journal?.list().map((d) => d.peer) ?? [])]);
    return (env.to ?? [...this.peers.keys()]).filter((id) => id !== env.from && known.has(id));
  }

  /** The recipients of `env` that the silence policy holds it back from, each with why (issue #107). */
  hushed(env: Envelope): { peer: PeerId; reason: string }[] {
    if (!this.opts.silence || env.hop > MAX_HOP || env.priority === "fyi") return [];
    return this.audience(env).flatMap((peer) => {
      const reason = this.opts.silence!(env, peer);
      return reason ? [{ peer, reason }] : [];
    });
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
    this.markWithdrawn(envelopeId);
    let removed = false;
    for (const queue of this.queues.values()) {
      const i = queue.findIndex((e) => e.id === envelopeId);
      if (i !== -1) removed = queue.splice(i, 1).length > 0;
    }
    if (removed) this.onQueues?.();
    this.persist();
    return removed;
  }

  /** Revoke pending feed copies only; accepted/dispatching journal records and native turns are untouched. */
  revokeSupervision(peer: PeerId): number {
    const queue = this.queues.get(peer);
    if (!queue && !this.preparing.has(peer)) return 0;
    let removed = 0;
    const discarded = new Set<string>();
    for (let i = (queue?.length ?? 0) - 1; i >= 0; i--) {
      const env = queue![i]!;
      if (env.from !== HUB || !env.refs?.supervision) continue;
      queue!.splice(i, 1);
      removed++;
      discarded.add(env.id);
      this.markWithdrawn(env.id);
      this.discardQueued(peer, env, "supervision role or feed revoked");
    }
    for (const env of this.preparing.get(peer) ?? []) {
      if (env.from !== HUB || !env.refs?.supervision || discarded.has(env.id)) continue;
      this.markWithdrawn(env.id);
      this.discardQueued(peer, env, "supervision role or feed revoked during preparation");
      removed++;
    }
    if (removed) { this.persist(); this.onQueues?.(); }
    return removed;
  }

  private discardQueued(peer: PeerId, env: Envelope, reason: string): void {
    if (this.journal) this.pendingOutcomes.push({ id: crypto.randomUUID(), peer, state: "discarded", createdAt: Date.now(), originals: [env], out: [], reason });
    this.emit({ t: "stale", env, peer, reason });
  }

  private delivered(peer: PeerId, originals: Envelope[]): void {
    try { this.onDelivered?.(peer, originals); } catch { /* observation must never affect delivery settlement */ }
  }

  private deliveryFailed(peer: PeerId): void {
    try { this.onDeliveryFailed?.(peer); } catch { /* observation must never affect delivery settlement */ }
  }

  private markWithdrawn(id: string): void {
    this.withdrawn.add(id);
    if (this.withdrawn.size > 256) this.withdrawn.delete(this.withdrawn.values().next().value as string);
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
    const queue = this.queues.get(id) ?? [];
    this.queues.set(id, queue);
    const key = env.from === HUB && env.refs?.supervision ? env.refs.supervisionKey : undefined;
    const replace = !front && key ? queue.findIndex((old) => old.from === HUB && old.refs?.supervision && old.refs.supervisionKey === key && !this.attempts.has(`${id}:${old.id}`)) : -1;
    const preparing = !front && key ? this.preparing.get(id)?.find((old) => old.from === HUB && old.refs?.supervision && old.refs.supervisionKey === key && !this.attempts.has(`${id}:${old.id}`) && !this.withdrawn.has(old.id)) : undefined;
    let queuedEnv = preparing ? { ...env, ts: Math.min(preparing.ts, env.ts) } : env;
    if (replace >= 0) {
      const old = queue[replace]!;
      // Keep the first milestone's deadline, so continuous updates cannot create another batching window.
      queuedEnv = { ...queuedEnv, ts: Math.min(old.ts, queuedEnv.ts) };
      queue[replace] = queuedEnv;
      this.markWithdrawn(old.id);
      this.discardQueued(id, old, "superseded supervision milestone");
    } else if (front) queue.unshift(queuedEnv);
    else queue.push(queuedEnv);
    if (preparing && !this.withdrawn.has(preparing.id)) {
      this.markWithdrawn(preparing.id);
      this.discardQueued(id, preparing, "superseded supervision milestone during preparation");
    }
    if (queue.length > this.opts.queueCap) {
      const victim = queue.findIndex((e) => e.priority !== "important");
      const [lost] = queue.splice(victim === -1 ? 0 : victim, 1);
      if (this.journal) this.pendingOutcomes.push({ id: crypto.randomUUID(), peer: id, state: "failed", createdAt: Date.now(), originals: [lost!], out: [], reason: "queue capacity exceeded" });
      this.emit({ t: "overflow", env: lost!, peer: id });
    }
    this.onQueues?.();
    if (!this.suppressDrain) this.persist();
    if (!this.suppressDrain) void this.drain(id);
  }

  /** 0 = deliver now; otherwise how long the oldest envelope still has to wait for company. */
  private wait(queue: Envelope[]): number {
    const supervisionOnly = queue.every((e) => e.from === HUB && e.refs?.supervision && e.priority === "status");
    if ((!supervisionOnly && queue.length >= this.opts.batchMax) || queue.some((e) => e.priority === "important")) return 0;
    return Math.max(0, queue[0]!.ts + this.opts.batchMs - Date.now());
  }

  private uncertain(peer: PeerId, deliveryId: string, reason: string): void {
    const row = this.journal?.get(deliveryId);
    if (row && ["dispatching", "accepted"].includes(row.state)) this.deliveryReceipt(peer, { id: deliveryId, state: "needs_review", reason });
  }

  private async steerQueued(id: PeerId, env: Envelope): Promise<void> {
    const peer = this.peers.get(id);
    const queue = this.queues.get(id);
    if (!this.journal || !peer?.steer || !queue || this.storageError) return;
    const index = queue.findIndex((item) => item.id === env.id);
    if (index < 0) return;
    this.steering++;
    const deliveryId = crypto.randomUUID();
    try {
      queue.splice(index, 1);
      this.durableHandoff(id, deliveryId, [env], [env]);
      this.activeDeliveries.set(deliveryId, id);
      try { await peer.steer([env], deliveryId); }
      catch { this.uncertain(id, deliveryId, "steering outcome is uncertain"); }
    } catch { this.storageError = "delivery journal unavailable"; }
    finally { this.steering--; this.onQueues?.(); }
  }

  private async drain(id: PeerId): Promise<void> {
    if (this.storageError || this.draining.has(id) || !this.peers.has(id)) return;
    this.draining.add(id);
    try {
      const peer = this.peers.get(id)!;
      const queue = this.queues.get(id)!;
      while (!this.storageError && !this.recoveryHeld && !this.recoveryHeldPeers.has(id) && queue.length && this.stateOf(id) === "idle") {
        if (this.dropIrrelevant(id, queue) && !queue.length) break;
        const delay = this.wait(queue);
        if (delay > 0) { this.arm(id, delay); break; }
        const preface = this.prefaces.get(id);
        // Durable queues retain the batch while asynchronous condensation runs. Another publish
        // may checkpoint during that wait; it must not checkpoint the batch out of existence.
        if (!this.journal) this.prefaces.delete(id);
        const batch = this.take(id, queue, !this.journal);
        this.preparing.set(id, batch);
        const delivery = preface ? [preface, ...batch] : batch;
        const mayCondense = this.opts.condense && !delivery.some((e) => e.priority === "important");
        this.condensing += mayCondense ? 1 : 0;
        const out = mayCondense ? await this.opts.condense!(delivery).catch(() => delivery) : delivery;
        this.condensing -= mayCondense ? 1 : 0;
        if (this.recoveryHeld || this.recoveryHeldPeers.has(id) || this.stateOf(id) !== "idle") {
          if (!this.journal) { if (preface) this.restorePreface(id, preface); queue.unshift(...batch.filter((e) => !this.withdrawn.has(e.id))); }
          break;
        }
        // The final recheck (issue #106): a task can close while the delivery was condensed or prepared.
        if (batch.some((e) => !this.isRelevant(id, e))) {
          if (!this.journal) { if (preface) this.restorePreface(id, preface); queue.unshift(...batch.filter((e) => !this.withdrawn.has(e.id))); }
          this.dropIrrelevant(id, queue);
          continue;
        }
        if (this.journal) {
          if (this.prefaces.get(id) !== preface || batch.some((e) => !queue.some((item) => item.id === e.id))) continue;
          for (const env of batch) queue.splice(queue.findIndex((item) => item.id === env.id), 1);
          this.prefaces.delete(id);
        }
        for (const e of out) if (!this.seen.has(e.id)) this.seen.set(e.id, e);
        while (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);
        this.lastDelivery.set(id, { out, originals: delivery });
        this.preparing.delete(id); // from here on the transport/journal owns settlement
        const deliveryId = crypto.randomUUID();
        if (this.journal) { this.durableHandoff(id, deliveryId, delivery, out); this.activeDeliveries.set(deliveryId, id); }
        try {
          if (this.journal) await peer.deliver(out, deliveryId);
          else { await peer.deliver(out); this.delivered(id, delivery); }
        } catch {
          if (this.journal) this.uncertain(id, deliveryId, "adapter delivery outcome is uncertain");
          else this.failed(id, delivery);
          break;
        }
      }
    } catch { this.storageError = "delivery journal unavailable"; }
    finally { this.preparing.delete(id); this.draining.delete(id); this.onQueues?.(); }
  }

  private isRelevant(id: PeerId, env: Envelope): boolean {
    return !this.withdrawn.has(env.id) && (this.opts.relevant?.(id, env) ?? true);
  }

  /**
   * A notice about the recipient's open task can wait out a whole Codex turn; once the task is closed it would only
   * start a turn of its own (issue #106). Checked when the delivery is built, not when the notice was published. Only
   * this recipient's copy goes: the other queues keep theirs, and no other delivery record changes.
   */
  private dropIrrelevant(id: PeerId, queue: Envelope[]): boolean {
    if (!this.opts.relevant && !this.withdrawn.size) return false;
    let dropped = false;
    for (let i = queue.length - 1; i >= 0; i--) {
      const env = queue[i]!;
      if (this.isRelevant(id, env)) continue;
      const reason = `stale: task #${env.refs?.task ?? "?"} is no longer open for ${id}`;
      queue.splice(i, 1);
      dropped = true;
      if (this.journal) this.pendingOutcomes.push({ id: crypto.randomUUID(), peer: id, state: "discarded", createdAt: Date.now(), originals: [env], out: [], reason });
      this.emit({ t: "stale", env, peer: id, reason });
    }
    if (dropped) {
      this.persist();
      this.onQueues?.();
    }
    return dropped;
  }

  /**
   * The next delivery: important envelopes first (they are why the queue is ready), then the rest in order.
   * An envelope that already failed once goes alone, so a poison one cannot take a digest down with it.
   */
  private take(id: PeerId, queue: Envelope[], remove = true): Envelope[] {
    const ordered = [...queue.filter((e) => e.priority === "important"), ...queue.filter((e) => e.priority !== "important")];
    const batch: Envelope[] = [];
    for (const env of ordered) {
      const failedBefore = this.attempts.has(`${id}:${env.id}`);
      if (failedBefore && batch.length) break;
      batch.push(env);
      if (failedBefore || batch.length === DIGEST_MAX) break;
    }
    if (remove) for (const env of batch) queue.splice(queue.indexOf(env), 1);
    return batch;
  }

  private arm(id: PeerId, ms: number): void {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => void this.drain(id), ms);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** At-least-once: back to the queue head and retried after a pause; given up after MAX_ATTEMPTS so one poison envelope cannot block the peer. */
  /** Delivery health is independent of task outcome: only a completed delivery clears the streak. */
  failingPeers(): Record<PeerId, string> {
    return Object.fromEntries([...this.failureStreak].filter(([, n]) => n >= 3).map(([peer]) => [peer, this.lastFailure.get(peer) ?? "delivery retries exhausted"]));
  }

  hasInFlight(peer: PeerId): boolean {
    return [...this.activeDeliveries.values()].includes(peer) || this.draining.has(peer);
  }

  private failed(id: PeerId, envs: Envelope[], reason = "delivery failed without an error detail"): void {
    if (!this.journal) this.deliveryFailed(id);
    this.lastFailure.set(id, reason.replace(/\s+/g, " ").slice(0, 300));
    if (envs.some((env) => !(env.from === HUB && env.kind === "presence") && (this.attempts.get(`${id}:${env.id}`) ?? 0) + 1 >= MAX_ATTEMPTS)) {
      this.failureStreak.set(id, (this.failureStreak.get(id) ?? 0) + 1);
    }
    const keep = envs.filter((env) => {
      // Only the recall block is a preface. The hub also sends task and review envelopes, and those are retried like any other.
      if (env.from === HUB && env.kind === "presence") {
        this.restorePreface(id, env); // rides again on the next delivery, without counting as a failed envelope
        return false;
      }
      const key = `${id}:${env.id}`;
      const n = (this.attempts.get(key) ?? 0) + 1;
      if (n < MAX_ATTEMPTS) return this.attempts.set(key, n);
      this.attempts.delete(key);
      this.emit({ t: "undeliverable", env, peer: id, reason: this.lastFailure.get(id) });
      return false;
    });
    this.queues.get(id)!.unshift(...keep);
    this.persist();
    // The idle transition caused by the failure itself may have been swallowed by the `draining` guard.
    this.arm(id, this.opts.retryMs);
  }

  private emit(e: BusEvent): void {
    for (const tap of this.taps) tap(e);
  }
}
