import { appendNote, DIGEST, frame, HUB, keepNotes, MAX_HOP, mergePrefaces, newEnvelope, noteLine, parseMarker, quoteNotes, replyAudience, uniqueMemoryLines, type Envelope, type EnvelopeOpts, type PeerId, type PeerState, type Priority } from "./envelope.ts";
import type { PeerAdapter, DeliveryReceipt } from "./peers.ts";
import { DeliveryJournal, MAX_ENVELOPE_BODY, type JournalDelivery, type JournalDeliveryState } from "./delivery-journal.ts";
import { DELIVERY_RETRY_WARNING } from "./delivery-hints.ts";
import { MAX_DEFERRED_HUB, RecoveryDeferredHubError, validateDeferredHub } from "./deferred-hub.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";

export type { DeliveryReceipt } from "./peers.ts";

export interface PublishResult {
  targets: PeerId[];
  dropped?: "hop" | "fyi";
}

export type BusEvent =
  | { t: "envelope"; env: Envelope; dropped?: "hop" | "fyi" }
  | { t: "overflow"; env: Envelope; peer: PeerId }
  | { t: "undeliverable"; env: Envelope; peer: PeerId; reason?: string }
  | { t: "stale"; env: Envelope; peer: PeerId; reason: string }
  | { t: "quiet"; env: Envelope; peers: PeerId[]; reason: string }
  | { t: "off_roster"; env: Envelope; peers: PeerId[] }
  | { t: "state"; peer: PeerId; state: PeerState };

export interface BusOptions {
  /** Live project membership; absent preserves the existing audience and delivery behaviour. */
  rostered?: (peer: PeerId) => boolean;
  /** Transient owner lifecycle fence: retain new work without changing console/budget pauses. */
  deliveryHeld?: (peer: PeerId) => boolean;
  /** Observe original envelopes immediately before a transport starts its turn. */
  onDeliver?: (peer: PeerId, originals: Envelope[]) => void;
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
   * as discarded and taps see a `stale` event. A string is false with its own reason (#223, a review-only peer).
   */
  relevant?: (peer: PeerId, env: Envelope) => boolean | string;
  /**
   * Optional: why this recipient does not get this envelope (issue #107, a turn-free cohort). Asked per recipient once
   * the audience is final (implicit replies and `digest` resolved), so the other recipients still get it, unchanged;
   * the console and the log see it as published.
   */
  silence?: (env: Envelope, peer: PeerId) => string | undefined;
  /**
   * Optional: an `important` envelope was just queued for a pull-only peer (issue #398). Advisory only: nothing was
   * dequeued, steered or journaled for it, and the queue still waits for `Bus.pull`; a throw is swallowed.
   */
  onImportantQueued?: (peer: PeerId, counts: { queued: number; important: number }) => void;
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
  /** Hub notices accepted during recovery, durable but outside the carried delivery queues. */
  deferredHub?: Envelope[];
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
// #713: a pull-only peer reads between steps, often minutes apart, so one pull drains its queue up to this many bytes of rendered text instead of ten items.
// Bounded, not unbounded: a queue larger than the budget takes more than one pull, and the reply says how many are still waiting. Push peers keep DIGEST_MAX.
const PULL_BUDGET_BYTES = 64 * 1024;
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
  /** Before deliver's synchronous busy transition, with originals rather than a condensed digest. */
  onDeliver?: (peer: PeerId, originals: Envelope[]) => void;
  /** Final rendered journal payload, and its first positive acknowledgement. Observation cannot alter settlement. */
  onMemoryDelivery?: (peer: PeerId, deliveryId: string, out: Envelope[], field: "rendered" | "delivered") => void;
  /** Synchronous native failure observation, before queue callbacks can finish turn metrics. */
  onDeliveryFailed?: (peer: PeerId) => void;
  private recoveryHeld = false;
  private deferHub = false;
  private readonly deferredHub = new Map<string, Envelope>();
  private flushingHub = false;
  private replayingHub = false;
  private deferredEvents: BusEvent[] = [];
  private deferredNudges: (() => void)[] = [];
  private steering = 0;
  private condensing = 0;
  private closed = false;
  storageError?: string;

  constructor(opts: Partial<BusOptions> = {}) {
    this.opts = { ...DEFAULT_BUS, ...opts };
    this.onDeliver = opts.onDeliver;
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

  /** Apply future batching and admission limits without disturbing queued work or its existing deadline. */
  configureScheduling(config: Pick<BusOptions, "batchMax" | "batchMs" | "queueCap">): void {
    const { batchMax, batchMs, queueCap } = config;
    if (!Number.isSafeInteger(batchMax) || batchMax < 1 || batchMax > 2_147_483_647 ||
        !Number.isFinite(batchMs) || batchMs < 0 || batchMs > 2_147_483_647 ||
        !Number.isSafeInteger(queueCap) || queueCap < 1 || queueCap > 2_147_483_647) {
      throw new Error("invalid bus scheduling configuration");
    }
    Object.assign(this.opts, { batchMax, batchMs, queueCap });
  }

  add(peer: PeerAdapter): void {
    this.peers.set(peer.id, peer);
    if (!this.queues.has(peer.id)) this.queues.set(peer.id, []);
    peer.onDelivery = (receipt) => this.deliveryReceipt(peer.id, receipt);
    peer.onMessage = (text, opts) => {
      if (!this.isRostered(peer.id)) return `off roster: ${peer.id}`;
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
      const offRoster = this.offRosterRecipients(env);
      if (offRoster.length && offRoster.length === new Set(env.to?.filter(id => id !== env.from)).size) {
        const reason = `off roster: ${offRoster.join(", ")}`;
        this.note(peer.id, noteLine(HUB, "decision", `your message was not delivered: ${reason}`));
        return reason; // no publication and no limiter spend for an entirely refused audience
      }
      const admittedEnv = offRoster.length ? { ...env, to: env.to!.filter(id => !offRoster.includes(id)) } : env;
      // Limits count what is sent: the envelope as built (a reply goes to its parent's sender, `digest` is resolved,
      // the priority is capped), never the raw `to`.
      const parent = opts?.inReplyTo?.id;
      // Held back from every recipient (issue #107): nothing goes out, so nothing counts against the sender's limits.
      const hushed = this.hushed(env);
      const heldBack = hushed.length > 0 && hushed.length === this.audience(env).length;
      let refused = heldBack ? undefined : this.opts.admit?.(admittedEnv, parent);
      // A turn answer has no caller to refuse: over its important budget it goes out as status, not at all.
      if (refused && env.priority === "important" && !this.opts.admit?.({ ...admittedEnv, priority: "status" }, parent)) {
        // It went out, so the advice on how to send it does not apply.
        this.note(peer.id, noteLine(HUB, "decision", `your [IMPORTANT] message went out as status: ${refused.replace(/[;:] (retry after \d+ s, or )?send it without \[IMPORTANT\]$/, "")}`));
        env = { ...env, priority: "status" };
        refused = undefined;
      }
      if (refused) {
        this.note(peer.id, noteLine(HUB, "decision", `your message was not delivered: ${refused}`));
        return refused;
      }
      const published = this.publishResult(env);
      if (offRoster.length && published.dropped !== "hop") this.note(peer.id, noteLine(HUB, "decision", `your message is retained off roster for ${offRoster.join(", ")}; delivered to the other recipients`));
      // The sender's result (issue #107): a turn answer has no caller, so it hears it on its next delivery. It counts as
      // not sent only when nobody got it.
      if (hushed.length) this.note(peer.id, noteLine(HUB, "decision", `your message was not delivered to ${hushed.map((h) => h.peer).join(", ")}: ${hushed[0]!.reason}`));
      return heldBack ? hushed[0]!.reason : published.dropped === "hop" ? published : undefined;
    };
    peer.onFailed = (envs, failure) => {
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
      } else this.failed(peer.id, same ? last.originals : envs, undefined, failure?.quota === true);
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

  private durableHandoff(peer: PeerId, deliveryId: string, originals: Envelope[], out: Envelope[], observe = true): void {
    if (!this.journal) return;
    const delivery = { id: deliveryId, peer, state: "dispatching" as const, createdAt: Date.now(), originals, out };
    this.journal.checkpointDelivery(this.snapshotWithoutJournal(), delivery);
    if (observe) this.memoryDelivery(peer, deliveryId, out, "rendered", originals);
  }

  private snapshotWithoutJournal(): BusSnapshot {
    return this.snapshot(false);
  }

  /** Stop new deliveries while a coordinator takes a stable snapshot. Existing adapter turns are left alone. */
  setRecoveryHold(held: boolean, deferHub = false): void {
    if (this.replayingHub) throw new RecoveryDeferredHubError("recovery notice release is already in progress");
    if (held) {
      this.recoveryHeld = true;
      this.deferHub = deferHub;
      // An older target cannot carry this additive field: materialize before commit's expected integrity.
      if (!deferHub) this.flushDeferredHub();
      return;
    }
    // Persist each deferred -> queued transition while deliveries are still fenced. A failed checkpoint
    // leaves the hold and the original pending head intact; a crash after it resumes from the journal.
    this.flushDeferredHub();
    this.deferHub = false;
    this.recoveryHeld = false;
    this.onQueues?.();
    for (const id of this.peers.keys()) void this.drain(id);
  }

  private flushDeferredHub(): void {
    if (this.flushingHub) return;
    if (this.storageError) this.persist();
    this.replayingHub = true;
    try { while (this.deferredHub.size) {
      const env = this.deferredHub.values().next().value!;
      const beforeDeferred = [...this.deferredHub], beforeSeen = [...this.seen], beforeWithdrawn = [...this.withdrawn];
      const affected = new Map(this.audience(env).map(peer => {
        const queue = this.queues.get(peer);
        return [peer, queue ? { queue, contents: [...queue] } : undefined] as const;
      }));
      const outcomes = this.pendingOutcomes.length;
      this.flushingHub = true;
      this.deferredEvents = []; this.deferredNudges = [];
      try {
        this.deferredHub.delete(env.id);
        this.publishNow(env);
      } catch {
        // Only publication state is transactional. A live peer's preface, pauses, attempts and
        // recovery mode are independent state, not something a failed checkpoint may reload.
        this.deferredHub.clear(); for (const [id, pending] of beforeDeferred) this.deferredHub.set(id, pending);
        this.seen.clear(); for (const [id, seen] of beforeSeen) this.seen.set(id, seen);
        this.withdrawn.clear(); for (const id of beforeWithdrawn) this.withdrawn.add(id);
        for (const [peer, queue] of affected) {
          if (queue) { queue.queue.splice(0, queue.queue.length, ...queue.contents); this.queues.set(peer, queue.queue); }
          else this.queues.delete(peer);
        }
        this.pendingOutcomes.length = outcomes;
        this.deferredEvents = []; this.deferredNudges = [];
        throw new RecoveryDeferredHubError("deferred hub notice checkpoint failed; recovery remains held; restore delivery storage, then retry release or abort");
      } finally { this.flushingHub = false; }
      // Publication observers run only after the durable transition. Reentrant notices join the FIFO tail.
      const events = this.deferredEvents; this.deferredEvents = [];
      for (const event of events) this.emit(event);
      const nudges = this.deferredNudges; this.deferredNudges = [];
      for (const nudge of nudges) nudge();
      this.onQueues?.();
    } } finally { this.replayingHub = false; }
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
        if (!heldBefore) this.setRecoveryHold(false);
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
      ...(this.deferredHub.size ? { deferredHub: structuredClone([...this.deferredHub.values()]) } : {}),
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
      const committedQueues = snapshot.queues;
      snapshot = this.journal.snapshot().bus;
      // Offline peers need not reattach. Their empty queue keys still belong to the
      // committed integrity view, even when no delivery ever persisted those keys (#234).
      // The journal remains authoritative for work: never resurrect a non-empty queue.
      for (const [id, queue] of Object.entries(committedQueues)) {
        if (queue.length === 0 && !Object.hasOwn(snapshot.queues, id)) snapshot.queues[id] = [];
      }
    }
    this.loadSnapshot(snapshot);
    this.persist();
  }

  private loadSnapshot(snapshot: BusSnapshot): void {
    const deferred = validateDeferredHub(snapshot.deferredHub, undefined, new Set([...snapshot.seen.map(e => e.id), ...Object.values(snapshot.queues).flat().map(e => e.id)]));
    if (deferred.length) { this.recoveryHeld = true; this.deferHub = true; }
    this.deferredHub.clear();
    for (const env of deferred) this.deferredHub.set(env.id, structuredClone(env));
    this.queues.clear();
    for (const [id, queue] of Object.entries(snapshot.queues ?? {})) this.queues.set(id, queue.map((e) => ({ ...e, ...(e.to ? { to: [...e.to] } : {}) })));
    this.prefaces.clear();
    for (const [id, e] of Object.entries(snapshot.prefaces ?? {})) this.prefaces.set(id, { ...e, body: uniqueMemoryLines(e.body), ...(e.to ? { to: [...e.to] } : {}) });
    this.seen.clear();
    for (const e of snapshot.seen ?? []) this.seen.set(e.id, { ...e, ...(e.to ? { to: [...e.to] } : {}) });
    this.attempts.clear();
    for (const [key, n] of Object.entries(snapshot.attempts ?? {})) if (Number.isInteger(n) && n > 0) this.attempts.set(key, n);
    this.withdrawn.clear();
    for (const id of snapshot.withdrawn ?? []) this.withdrawn.add(id);
    if (snapshot.manualPaused) { this.manualPaused.clear(); this.paused.clear(); for (const id of snapshot.manualPaused) { this.manualPaused.add(id); this.paused.add(id); } }
  }

  knownPeers(): string[] {
    const pending = this.storageError ? [] : this.journal?.pendingPeers() ?? [];
    return [...new Set([...this.peers.keys(), ...[...this.queues].filter(([, queue]) => queue.length).map(([id]) => id), ...pending])].sort();
  }

  queueList(peer?: string, unresolvedOnly = false): JournalDelivery[] {
    if (this.journal) {
      const rows = (unresolvedOnly ? this.journal.unresolved(peer) : this.journal.list(peer)).filter((row) => !row.reason?.startsWith("grouped into delivery "));
      const revision = this.journal.revision();
      const recorded = new Set(rows.filter((r) => ["queued", "dispatching", "accepted", "needs_review"].includes(r.state)).flatMap((r) => (r.originals as Envelope[]).map((e) => `${r.peer}:${e.id}`)));
      const ids = peer ? [peer] : [...this.queues.keys()];
      for (const p of ids) for (const e of this.queues.get(p) ?? []) if (!recorded.has(`${p}:${e.id}`)) rows.push({ id: `q:${p}:${e.id}`, peer: p, state: "queued", revision, createdAt: e.ts, updatedAt: e.ts, originals: [e], out: [e] });
      return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    const ids = peer ? [peer] : [...this.queues.keys()];
    return ids.flatMap((p) => (this.queues.get(p) ?? []).map((e) => ({ id: e.id, peer: p, state: "queued" as const, revision: 0, createdAt: e.ts, updatedAt: e.ts, originals: [e], out: [e] })));
  }

  queueShow(id: string): JournalDelivery | undefined { return this.journal?.get(id) ?? this.queueList().find((d) => d.id === id); }

  heldDeliveryHints(peer: string) { return this.storageError ? undefined : this.journal?.heldDeliveryHints(peer); }

  /** Consent is for this peer's held row only, never authority to complete/discard or release a pause. */
  retryDelivery(peer: string, id: string): void {
    const refuse = () => { throw new PreEffectToolRefusal("recipient retry unavailable; inspect the held delivery or ask the person"); };
    if (this.closed || this.recoveryHeld || this.storageError || peer === "user" || peer === HUB) return refuse();
    const row = this.queueShow(id);
    if (!row || row.peer !== peer || row.state !== "needs_review" || !this.journal || this.journal.retryEvidence(peer, row.originals) !== "unused") return refuse();
    this.resolveDelivery(id, row.revision, "retry", "recipient requested one uncertain redelivery", `peer:${peer}`);
  }

  private retryOut(peer: string, originals: Envelope[], out: Envelope[]): Envelope[] {
    if (!out.length || !this.journal || !this.journal.retryWarning(peer, originals)) return out;
    return out.map((env, index) => {
      if (index !== 0) return env;
      const prefix = `${DELIVERY_RETRY_WARNING}\n\n`, marker = "\n[cut: rendered body exceeds delivery limit]";
      if (prefix.length + env.body.length <= MAX_ENVELOPE_BODY) return { ...env, body: prefix + env.body };
      let end = MAX_ENVELOPE_BODY - prefix.length - marker.length;
      // The journal cap uses UTF-16 length; never cut between a Unicode surrogate pair.
      if (Array.from(env.body.slice(end - 1, end + 1))[0]?.length === 2) end--;
      return { ...env, body: prefix + env.body.slice(0, end) + marker };
    });
  }

  resolveDelivery(id: string, revision: number, action: "completed" | "retry" | "discard", reason: string, actor: string = "user"): void {
    if (!this.journal || this.storageError) throw new Error("delivery journal unavailable");
    const record = this.queueShow(id);
    if (!record) throw new Error("unknown delivery");
    const previous = this.journal.resolution(id);
    if (previous) {
      this.journal.resolve(id, revision, action, reason, revision, actor); // verifies identical request; no second enqueue
      return;
    }
    const recipientConsent = actor === `peer:${record.peer}` && action === "retry" && record.state === "needs_review";
    // #713: a `queued` delivery was never handed to the peer, so nothing is in flight and a busy peer (a pull-only TUI is busy most of the time) does not block
    // discarding it. `dispatching` and `accepted` stay refused, and every other resolution keeps the busy fence.
    if (["dispatching", "accepted"].includes(record.state)) throw new Error("active delivery cannot be resolved");
    const queuedDiscard = record.state === "queued" && action === "discard";
    if (this.peers.get(record.peer)?.state === "busy" && !recipientConsent && !queuedDiscard) throw new Error("peer busy: its delivery cannot be resolved while it works");
    if (record.revision !== revision) throw new Error("stale delivery revision");
    if (record.state === "queued" && action === "retry") throw new Error("queued delivery is already scheduled");
    if (action === "retry" && (this.queues.get(record.peer)?.length ?? 0) + record.originals.length > this.opts.queueCap) throw new Error("recipient queue is full");
    const queue = this.queues.get(record.peer) ?? [];
    const hadQueue = this.queues.has(record.peer);
    const before = [...queue];
    const preface = this.prefaces.get(record.peer);
    try {
      this.journal.transaction(() => {
        if (!this.journal!.get(id)) this.journal!.createDelivery({ ...record });
        const current = this.journal!.get(id)!;
        this.journal!.resolve(id, current.revision, action, reason, revision, actor);
        if (record.state === "queued") {
          const ids = new Set(record.originals.map((env) => env.id));
          queue.splice(0, queue.length, ...queue.filter((env) => !ids.has(env.id)));
        }
        if (action === "retry" || action === "completed" && actor === "hub") {
          for (const env of record.originals) {
            if (env.from === HUB && env.kind === "presence") this.restorePreface(record.peer, env);
            else if (action === "retry" && !queue.some((old) => old.id === env.id)) queue.push(env);
          }
          if (action === "retry") this.queues.set(record.peer, queue);
        }
        this.persist();
      });
    } catch (error) {
      queue.splice(0, queue.length, ...before);
      if (!hadQueue) this.queues.delete(record.peer);
      if (preface) this.prefaces.set(record.peer, preface);
      else this.prefaces.delete(record.peer);
      throw error;
    }
    this.refreshRecoveryHold(record.peer);
    this.onQueues?.();
    void this.drain(record.peer);
  }

  queueSummary(peer: string): { needsReview: number; heldBy?: string; liveAccepted?: string[]; oldestQueuedAt?: number } {
    const rows = this.storageError ? [] : this.queueList(peer, true);
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
    if (state === "completed") this.journal.completeDelivered(id, peer, "adapter", receipt.reason);
    else this.journal.transition(id, state, receipt.reason);
    if (before?.state === "dispatching" && (state === "accepted" || state === "completed")) {
      this.memoryDelivery(peer, id, before.out, "delivered", before.originals);
      this.delivered(peer, before.originals);
    }
    if (state === "failed") {
      if (before) this.failed(peer, before.originals, before.originals.some((e) => e.private) ? "private delivery failed" : receipt.reason, receipt.quota === true && before.state === "dispatching");
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
      if (row?.peer === peer && ["dispatching", "accepted"].includes(row.state) && row.out.some((e) => e.id === envelopeId)) {
        this.journal.completeDelivered(id, peer, "reply", "correlated reply");
        if (row.state === "dispatching") this.memoryDelivery(peer, id, row.out, "delivered", row.originals);
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

  queuedBacklogIds(id: PeerId): Set<number> {
    const ids = new Set<number>();
    const retained = [...this.pendingEnvelopes(id), ...(this.journal?.unresolved(id).filter(row => row.state !== "queued").flatMap(row => row.originals) ?? [])];
    for (const env of retained) {
      const backlog = env.refs?.backlog;
      if (env.from !== HUB || env.kind !== "task" || !Array.isArray(backlog) || backlog.length > 64) continue;
      for (const task of backlog) if (Number.isSafeInteger(task) && task > 0) ids.add(task);
    }
    return ids;
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
    const body = uniqueMemoryLines(quoteNotes(text));
    const existing = this.prefaces.get(id);
    if (existing) {
      // A fresh daemon recalls again after restoring queued context. Merge repeated blocks,
      // retain distinct context and keep the original envelope id/hop for retry bookkeeping.
      this.prefaces.set(id, { ...existing, body: mergePrefaces(existing.body, body) });
      this.persist();
      return;
    }
    this.prefaces.set(id, newEnvelope(HUB, body, { to: [id], kind: "presence" }));
    this.persist();
  }

  /** Another peer's shared note: rides in the preface like recall. The newest NOTES_KEPT stay; older ones remain in amem. */
  note(id: PeerId, line: string): void {
    const existing = this.prefaces.get(id);
    this.prefaces.set(id, existing ? { ...existing, body: keepNotes(uniqueMemoryLines(appendNote(existing.body, line)), NOTES_KEPT) } : newEnvelope(HUB, uniqueMemoryLines(line), { to: [id], kind: "presence" }));
    this.persist();
  }

  /** A preface that went out with a failed delivery comes back ahead of whatever was prefaced meanwhile, instead of replacing it. */
  private restorePreface(id: PeerId, env: Envelope): void {
    const now = this.prefaces.get(id);
    this.prefaces.set(id, !now ? { ...env, body: uniqueMemoryLines(env.body) } : now.id === env.id ? { ...now, body: uniqueMemoryLines(now.body) } : { ...env, body: keepNotes(mergePrefaces(env.body, now.body), NOTES_KEPT) });
  }

  /**
   * Reset only: audit every deferred recipient without publishing or releasing work. The guard below is what it
   * checks: no attached peers, no flush or replay in progress and a readable journal. It cannot see a running
   * daemon, so the caller (`resetRuntime`) must hold the stopped-hub proof; a bare Bus has none.
   */
  discardDeferredHub(reason: string): string[] {
    if (this.peers.size || this.flushingHub || this.replayingHub || !this.journal || this.storageError) throw new Error("deferred reset requires a stopped, readable delivery journal");
    const pending = [...this.deferredHub];
    const settled: string[] = [];
    try {
      this.journal.transaction(() => {
        for (const [, env] of pending) for (const peer of new Set(env.to ?? [])) {
          const id = `q:${peer}:${env.id}`;
          this.journal!.createDelivery({ id, peer, state: "queued", createdAt: env.ts, originals: [env], out: [env] });
          const row = this.journal!.get(id)!;
          this.journal!.resolve(id, row.revision, "discard", reason, row.revision, "user");
          settled.push(id);
        }
        this.deferredHub.clear();
        this.persist();
      });
    } catch (error) {
      this.deferredHub.clear(); for (const [id, env] of pending) this.deferredHub.set(id, env);
      throw error;
    }
    return settled;
  }

  /** Accepted pending work, including notices withheld from the recovery integrity view. */
  pendingEnvelopes(peer: PeerId): Envelope[] {
    return [...(this.queues.get(peer) ?? []), ...[...this.deferredHub.values()].filter(e => e.to?.includes(peer))];
  }

  /** Returns the peers the envelope was accepted for, including durable deferred notices. */
  publish(env: Envelope): PeerId[] {
    return this.publishResult(env).targets;
  }

  /** Publication outcome distinguishes a policy drop from an empty audience. */
  publishResult(env: Envelope): PublishResult {
    if (this.storageError) throw new Error("delivery journal unavailable");
    if (this.seen.has(env.id) || this.deferredHub.has(env.id)) return { targets: [] };
    if (this.recoveryHeld && (this.deferHub || this.replayingHub) && env.from === HUB && env.priority !== "fyi" && env.hop <= MAX_HOP) {
      if (this.deferredHub.size >= MAX_DEFERRED_HUB) throw new RecoveryDeferredHubError();
      const targets = this.audience(env);
      const copy = structuredClone({ ...env, to: targets });
      this.deferredHub.set(copy.id, copy);
      try { this.persist(); }
      catch (error) { this.deferredHub.delete(copy.id); throw error; }
      return { targets };
    }
    return this.publishNow(env);
  }

  private publishNow(env: Envelope): PublishResult {
    if (this.storageError) throw new Error("delivery journal unavailable");
    if (this.seen.has(env.id)) return { targets: [] };
    this.seen.set(env.id, env);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);

    // fyi is for the record (console now, task board from M4), never worth an agent's turn.
    const dropped = env.hop > MAX_HOP ? "hop" : env.priority === "fyi" ? "fyi" : undefined;
    this.emit({ t: "envelope", env, ...(dropped ? { dropped } : {}) });
    if (dropped) { this.persist(); return { targets: [], dropped }; }

    const hushed = this.hushed(env);
    if (hushed.length) this.emit({ t: "quiet", env, peers: hushed.map((h) => h.peer), reason: hushed[0]!.reason });
    const targets = this.audience(env).filter((id) => !hushed.some((h) => h.peer === id) || !this.isRostered(id));
    this.suppressDrain = !!this.journal;
    try { for (const id of targets) {
      const peer = this.peers.get(id);
      if (!peer) { this.enqueue(id, env); continue; }
      if (!this.journal && !this.held(id) && env.priority === "important" && peer.steer && this.stateOf(id) === "busy") {
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
      if (!this.flushingHub) this.onQueues?.();
      for (const id of targets) {
        const peer = this.peers.get(id);
        if (!this.held(id) && env.priority === "important" && peer?.steer && this.stateOf(id) === "busy") void this.steerQueued(id, env);
        else void this.drain(id);
      }
    }
    const offRoster = targets.filter(id => !this.isRostered(id));
    if (offRoster.length) this.emit({ t: "off_roster", env, peers: offRoster });
    return { targets };
  }

  isRostered(peer: PeerId): boolean { return this.opts.rostered?.(peer) ?? true; }

  /** Explicit off-roster recipients, including unattached retained targets; broadcasts have none. */
  offRosterRecipients(env: Envelope): PeerId[] {
    return [...new Set(env.to ?? [])].filter(peer => peer !== env.from && !this.isRostered(peer));
  }

  /** Membership changed externally: reconsider delivery, keeping every independent hold intact. */
  rosterChanged(peer: PeerId): void {
    if (this.closed) return;
    this.onQueues?.();
    void this.drain(peer);
  }

  /** Who an envelope is queued for: its `to`, or every peer but its sender. */
  audience(env: Envelope): PeerId[] {
    const known = new Set([...this.peers.keys(), ...this.queues.keys(), ...(this.journal?.list().map((d) => d.peer) ?? [])]);
    return (env.to ?? [...this.peers.keys()]).filter((id) => id !== env.from && (known.has(id) || !this.isRostered(id)) && (env.to !== undefined || this.isRostered(id)));
  }

  /** The recipients of `env` that the silence policy holds it back from, each with why (issue #107). */
  hushed(env: Envelope): { peer: PeerId; reason: string }[] {
    if (!this.opts.silence || env.hop > MAX_HOP || env.priority === "fyi") return [];
    return this.audience(env).filter(peer => this.isRostered(peer)).flatMap((peer) => {
      const reason = this.opts.silence!(env, peer);
      return reason ? [{ peer, reason }] : [];
    });
  }

  /** A recently published envelope, for resolving `reply_to`. */
  get(id: string): Envelope | undefined {
    return this.seen.get(id) ?? this.deferredHub.get(id);
  }

  /** The envelopes most recently handed to a peer, used to distinguish a received request from an unread queue. */
  lastDeliveredTo(peer: PeerId): Envelope[] {
    return this.lastDelivery.get(peer)?.out ?? [];
  }

  /**
   * Take back an envelope that has not been delivered yet (a request that has expired). True when it was removed from a
   * queue now; an envelope whose steer is still in flight is not in any queue, so its id is remembered and it is
   * dropped if the refused steer tries to queue it later.
   */
  withdraw(envelopeId: string): boolean {
    this.markWithdrawn(envelopeId);
    let removed = this.deferredHub.delete(envelopeId);
    for (const queue of this.queues.values()) {
      const i = queue.findIndex((e) => e.id === envelopeId);
      if (i !== -1) { queue.splice(i, 1); removed = true; }
    }
    if (removed) this.onQueues?.();
    this.persist();
    return removed;
  }

  /** Revoke pending feed copies only; accepted/dispatching journal records and native turns are untouched. */
  revokeSupervision(peer: PeerId): number {
    const queue = this.queues.get(peer);
    let removed = 0;
    for (const [id, env] of this.deferredHub) {
      if (!env.refs?.supervision || !env.to?.includes(peer)) continue;
      const remaining = env.to.filter(target => target !== peer);
      if (remaining.length) this.deferredHub.set(id, { ...env, to: remaining });
      else this.deferredHub.delete(id);
      removed++;
    }
    if (!queue && !this.preparing.has(peer)) { if (removed) this.persist(); return removed; }
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

  private memoryDelivery(peer: PeerId, id: string, out: Envelope[], field: "rendered" | "delivered", originals: Envelope[] = out): void {
    if ([...out, ...originals].some(env => env.private)) return;
    try { this.onMemoryDelivery?.(peer, id, out, field); } catch { /* optional telemetry never alters delivery */ }
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

  /** The oldest `important` envelope still waiting in a queue, for the busy-peer notice (#572 AC1); a read, never a delivery. */
  oldestQueuedImportantAt(id: PeerId): number | undefined {
    return (this.queues.get(id) ?? []).reduce<number | undefined>((oldest, e) => e.priority !== "important" ? oldest : oldest === undefined ? e.ts : Math.min(oldest, e.ts), undefined);
  }

  private enqueue(id: PeerId, env: Envelope, front = false): void {
    if (this.withdrawn.has(env.id)) return;
    const queue = this.queues.get(id) ?? [];
    this.queues.set(id, queue);
    // #713: a newer "task T is done, check your work" notice for this recipient replaces an earlier queued one for the same T: only the newest is useful, and the older
    // one is discarded through the same stale/discard path with a journal outcome. Never one that already failed once or is being prepared, as for supervision.
    const completedFor = env.from === HUB && env.kind === "task" && Number.isSafeInteger(env.refs?.completedFor) ? env.refs!.completedFor : undefined;
    if (!front && completedFor !== undefined) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const old = queue[i]!;
        if (old.from !== HUB || old.refs?.completedFor !== completedFor || this.attempts.has(`${id}:${old.id}`)) continue;
        queue.splice(i, 1);
        this.markWithdrawn(old.id);
        this.discardQueued(id, old, `superseded completed-change notice for task #${completedFor}`);
      }
    }
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
    if (queuedEnv.priority === "important" && this.peers.get(id)?.pullOnly) {
      // Advisory only (issue #398): the envelope stays queued for `pull`; the hook must never affect it.
      const counts = { queued: queue.length, important: queue.filter((e) => e.priority === "important").length };
      const nudge = () => { try { this.opts.onImportantQueued?.(id, counts); } catch { /* a nudge never stops an enqueue */ } };
      if (this.flushingHub) this.deferredNudges.push(nudge); else nudge();
    }
    if (!this.flushingHub) this.onQueues?.();
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
    let removed = false, handedOff = false;
    try {
      const out = this.retryOut(id, [env], [env]);
      queue.splice(index, 1);
      removed = true;
      this.durableHandoff(id, deliveryId, [env], out);
      handedOff = true;
      this.activeDeliveries.set(deliveryId, id);
      try { await peer.steer(out, deliveryId); }
      catch { this.uncertain(id, deliveryId, "steering outcome is uncertain"); }
    } catch {
      if (removed && !handedOff) queue.splice(index, 0, env);
      this.storageError = "delivery journal unavailable";
    } finally { this.steering--; this.onQueues?.(); }
  }

  /** Holds on a peer's queue, for a drain and a pull alike: off roster, recovery, an uncertain delivery, a pause (console, budget, conductor). */
  private held(id: PeerId): boolean {
    return !this.isRostered(id) || this.recoveryHeld || this.recoveryHeldPeers.has(id) || this.paused.has(id) || this.opts.deliveryHeld?.(id) === true;
  }

  /** What a peer was just handed stays resolvable for `reply_to`: moved to the newest end, the stored envelope kept. */
  private remember(envs: Envelope[]): void {
    for (const e of envs) { const kept = this.seen.get(e.id) ?? e; this.seen.delete(e.id); this.seen.set(e.id, kept); }
    while (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value as string);
  }

  /** A push may go out now: nothing holds the queue, the peer is idle, and its session shows pushes (issue #205). */
  private deliverable(id: PeerId): boolean {
    return !this.held(id) && this.stateOf(id) === "idle" && !this.peers.get(id)?.pullOnly;
  }

  /**
   * What one push delivery would take (the preface, then `take`'s batch), explicitly pulled by its attached session and recorded as
   * completed: the tool result that returns it is the readback, so nothing waits for settlement and nothing is ever
   * `accepted` (issue #205). It is checkpointed like a push, so queued rows of the same envelopes (an operator retry)
   * are grouped into it, and registered for `reply_to` like a push. Undefined while held. A failed journal write puts
   * back only this peer's queue and preface (every pause stays) and stops the bus like any other journal failure.
   * ponytail: recorded completed at hand-out, before anything shows the model saw it: a reply lost on the way, a tool
   * call cancelled (Esc) or a plugin that dies loses the batch, and `ahub queue resolve --action retry` refuses a
   * terminal row. The completed row keeps the envelopes (`ahub queue show <id>`) to resend by hand; take/confirm in two
   * steps if loss is ever observed.
   */
  pull(id: PeerId): Envelope[] | undefined {
    if (this.storageError) throw new Error("delivery journal unavailable");
    if (this.held(id)) return undefined;
    const queue = this.queues.get(id) ?? [];
    this.dropIrrelevant(id, queue);
    const preface = this.prefaces.get(id);
    if (!preface && !queue.length) return [];
    const queued = [...queue];
    // A pull-only peer drains within a byte budget (oldest first, important ones marked as they always were); an attached channel session that pulls keeps one push's worth (#493).
    const batch = [...(preface ? [preface] : []), ...(this.peers.get(id)?.pullOnly ? this.takeBudget(id, queue) : this.take(id, queue))];
    let out: Envelope[] = [];
    const deliveryId = crypto.randomUUID();
    try {
      out = this.retryOut(id, batch, batch);
      this.prefaces.delete(id);
      // Before the checkpoint, as in a drain, so the persisted snapshot carries it; a failed policy read rolls back too.
      this.remember(out);
      this.journal?.transaction(() => {
        this.durableHandoff(id, deliveryId, batch, out, false); // observe only after this outer transaction commits
        this.journal!.completeDelivered(deliveryId, id, "pull", "read through hub_inbox");
      });
    } catch (error) {
      queue.splice(0, queue.length, ...queued);
      if (preface) this.prefaces.set(id, preface);
      this.storageError = "delivery journal unavailable";
      throw error;
    }
    if (this.journal) {
      this.memoryDelivery(id, deliveryId, out, "rendered", batch);
      this.memoryDelivery(id, deliveryId, out, "delivered", batch);
    }
    this.failureStreak.delete(id); this.lastFailure.delete(id); // read, as a completed push receipt clears them
    this.onQueues?.();
    return out;
  }

  private async drain(id: PeerId): Promise<void> {
    if (this.storageError || this.draining.has(id) || !this.peers.has(id)) return;
    this.draining.add(id);
    try {
      const peer = this.peers.get(id)!;
      const queue = this.queues.get(id)!;
      while (!this.storageError && queue.length && this.deliverable(id)) {
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
        let out: Envelope[];
        try {
          const condensed = mayCondense ? await this.opts.condense!(delivery).catch(() => delivery) : delivery;
          out = this.retryOut(id, delivery, condensed);
        } finally { this.condensing -= mayCondense ? 1 : 0; }
        // A session that cannot show pushes may have taken the peer while this was condensed (issue #205).
        if (!this.deliverable(id)) {
          if (!this.journal) { if (preface) this.restorePreface(id, preface); queue.unshift(...batch.filter((e) => !this.withdrawn.has(e.id))); }
          break;
        }
        // The final recheck (issue #106): a task can close while the delivery was condensed or prepared.
        if (batch.some((e) => !this.isRelevant(id, e))) {
          if (!this.journal) { if (preface) this.restorePreface(id, preface); queue.unshift(...batch.filter((e) => !this.withdrawn.has(e.id))); }
          this.dropIrrelevant(id, queue);
          continue;
        }
        const deliveryId = crypto.randomUUID();
        if (this.journal) {
          if (this.prefaces.get(id) !== preface || batch.some((e) => !queue.some((item) => item.id === e.id))) continue;
          const queued = [...queue], seen = [...this.seen];
          for (const env of batch) queue.splice(queue.findIndex((item) => item.id === env.id), 1);
          this.prefaces.delete(id);
          this.remember(out); // the checkpoint must retain rendered reply ids across a restart
          try { this.durableHandoff(id, deliveryId, delivery, out); }
          catch (error) {
            queue.splice(0, queue.length, ...queued);
            if (preface) this.prefaces.set(id, preface);
            this.seen.clear();
            for (const [key, env] of seen) this.seen.set(key, env);
            throw error;
          }
          this.activeDeliveries.set(deliveryId, id);
        } else this.remember(out);
        this.lastDelivery.set(id, { out, originals: delivery });
        this.preparing.delete(id); // from here on the transport/journal owns settlement
        try {
          try { this.onDeliver?.(id, delivery); } catch { /* observation must never affect delivery */ }
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
    return this.irrelevance(id, env) === undefined;
  }

  /** Why a queued envelope no longer goes to `id`, or undefined when it still does. */
  private irrelevance(id: PeerId, env: Envelope): string | undefined {
    const verdict = this.withdrawn.has(env.id) ? false : this.opts.relevant?.(id, env) ?? true;
    return verdict === true ? undefined : typeof verdict === "string" ? verdict : `stale: task #${env.refs?.task ?? "?"} is no longer open for ${id}`;
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
      const reason = this.irrelevance(id, env);
      if (reason === undefined) continue;
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

  /**
   * #713: what one pull hands a pull-only peer. Oldest first, so the oldest ordinary item is never kept behind newer important ones (the push order is important
   * first; a pull is a catch-up). The budget counts each item's rendered bytes as the peer will read them (`frame`), and the first item always goes, so one huge
   * envelope cannot stall the queue. An envelope that already failed once still goes alone, as in `take`.
   */
  private takeBudget(id: PeerId, queue: Envelope[]): Envelope[] {
    const batch: Envelope[] = [];
    let bytes = 0;
    for (const env of queue) {
      const failedBefore = this.attempts.has(`${id}:${env.id}`);
      if (failedBefore && batch.length) break;
      const size = Buffer.byteLength(frame(env)) + 2;
      if (batch.length && bytes + size > PULL_BUDGET_BYTES) break;
      batch.push(env); bytes += size;
      if (failedBefore) break;
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
  /** Delivery health is independent of task outcome: only a completed delivery clears the streak. */
  failingPeers(): Record<PeerId, string> {
    return Object.fromEntries([...this.failureStreak].filter(([, n]) => n >= 3).map(([peer]) => [peer, this.lastFailure.get(peer) ?? "delivery retries exhausted"]));
  }

  hasInFlight(peer: PeerId): boolean {
    return [...this.activeDeliveries.values()].includes(peer) || this.draining.has(peer);
  }

  private failed(id: PeerId, envs: Envelope[], reason = "delivery failed without an error detail", quota = false): void {
    if (!this.journal) this.deliveryFailed(id);
    // A quota refusal ran no work. The budget pause fences retries until reset; it is not a poison attempt.
    const quotaPaused = quota && this.paused.has(id);
    this.lastFailure.set(id, reason.replace(/\s+/g, " ").slice(0, 300));
    if (!quotaPaused && envs.some((env) => !(env.from === HUB && env.kind === "presence") && (this.attempts.get(`${id}:${env.id}`) ?? 0) + 1 >= MAX_ATTEMPTS)) {
      this.failureStreak.set(id, (this.failureStreak.get(id) ?? 0) + 1);
    }
    const keep = envs.filter((env) => {
      // Only the recall block is a preface. The hub also sends task and review envelopes, and those are retried like any other.
      if (env.from === HUB && env.kind === "presence") {
        this.restorePreface(id, env); // rides again on the next delivery, without counting as a failed envelope
        return false;
      }
      if (quotaPaused) return true;
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
    if (this.flushingHub) { this.deferredEvents.push(e); return; }
    for (const tap of this.taps) tap(e);
  }
}
