/** Host integration for X4. Remote identities carry chat, never local control authority. */
import type { Bus } from "../hub/bus.ts";
import { USER, MAX_HOP, type Envelope, type PeerState } from "../hub/envelope.ts";
import { Limiter, PROJECT_LIMITS, type LimitsConfig } from "../hub/limits.ts";
import type { PiiVerdict } from "../hub/inference.ts";
import type { Routing } from "../hub/routing.ts";
import { roomMembers } from "./wire.ts";
import { RoomStore, RoomStoreError, RoomApplicationLimitError, type RoomOutgoing } from "./store.ts";
import { RoomPolicy } from "./policy.ts";
import { RemotePeer } from "./remote-peer.ts";
import { parseRemotePeerId, roomReceiptReasonText, type RoomMessage, type RoomReceiptReason } from "./application.ts";
import { RoomApplicationDeferredError, type RoomLink, type RoomLinkApplication, type RoomLinkContext, type RoomLinkState, type RoomPresencePeer } from "./link.ts";

export interface RoomChatOptions {
  bus: Bus; cwd: string; now?: () => number;
  routing: () => Routing; piiPaths: () => readonly string[];
  senderPrivate: (peer: string) => boolean | undefined;
  taskPrivate: (id: number) => boolean | undefined;
  modelScreenOn: () => boolean; screen: (text: string) => Promise<PiiVerdict>;
  policyVersion: () => string | number;
  roster?: (ids: readonly string[]) => void;
  changed?: () => void;
  limits?: () => LimitsConfig;
  notice?: (value: { code: "application_capacity"; room: string; count: number } | { code: "sequence_gap"; room: string; sender: string; count: string }) => void;
}
export interface RoomMetrics { since: number; outbound: number | null; inbound: number | null; withheld: number | null }
interface Binding { store: RoomStore; name: string; room: string; link: RoomLink; digest: string; online: boolean; states: Map<string, PeerState> }
interface Target { binding: Binding; member: string; peer: string }
const ACTIVE = new Set(["dispatching", "accepted", "needs_review"]);

export class RoomChat {
  private readonly policy: RoomPolicy;
  private readonly metricsSince: number | null;
  // ponytail: at most 64 room-name session counters, never cross-run totals.
  // If cross-run totals are required, add durable versioned counters at the storage boundary.
  private readonly counts = new Map<string, { room: string; outbound: number | null; inbound: number | null; withheld: number | null }>();
  private readonly bindings = new Map<string, Binding>();
  private readonly targets = new Map<string, Target>();
  private statusTargets = new Map<string, string[] | null>();
  private readonly remotes = new Map<string, RemotePeer>();
  private readonly outgoing = new Map<string, { binding: Binding; row: RoomOutgoing }>();
  private evidenceCache?: Map<string, { peer: string; roomState: string; disposition?: string; lateReceipt?: string; refusalReason?: string }>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private capacityRefreshPending = false;
  private limitKey = "";
  private peerLimiter = new Limiter(PROJECT_LIMITS);
  readonly application: RoomLinkApplication;
  constructor(private readonly options: RoomChatOptions) {
    this.policy = new RoomPolicy(options.cwd);
    let since: number | null = null;
    try { const value = this.now(); if (Number.isSafeInteger(value) && value >= 0) since = value; } catch { /* Observation failure never disables transport construction. */ }
    this.metricsSince = since;
    this.application = {
      members: context => { if (context.current()) this.bind(context.store, context.name, context.link); },
      receive: (context, input) => this.receive(context, input),
      online: async context => { if (context.current()) { this.bind(context.store, context.name, context.link); this.bindings.get(context.name)!.online = true; this.refreshTargets(); this.refreshOutgoing(this.bindings.get(context.name)!); this.queueChanged(); } },
      stored: (context, input) => {
        if (!context.current()) return;
        const row = context.store.markApplicationStored(context.name, input.digest, input.seq);
        if (row) this.outcome(this.bindings.get(context.name)!, row);
      },
      capacityChanged: context => { if (context.current()) this.capacityChanged(); },
      gap: (context, input) => {
        if (context.current()) this.options.notice?.({ code: "sequence_gap", room: context.store.get(context.name)!.current.room, sender: input.sender, count: input.count });
      },
    };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  metrics(name: string, room?: string): RoomMetrics | null {
    const binding = this.bindings.get(name);
    if (this.stopped || !binding || this.metricsSince === null || room !== undefined && binding.room !== room) return null;
    const row = this.counts.get(name);
    return { since: this.metricsSince, outbound: row?.room === binding.room ? row.outbound : null,
      inbound: row?.room === binding.room ? row.inbound : null, withheld: row?.room === binding.room ? row.withheld : null };
  }
  private count(binding: Binding, direction: "outbound" | "inbound", withheld = false): void {
    const row = this.counts.get(binding.name);
    if (!row || row.room !== binding.room) return;
    const increment = (key: "outbound" | "inbound" | "withheld") => {
      const value = row[key]; row[key] = value !== null && value < Number.MAX_SAFE_INTEGER ? value + 1 : null;
    };
    increment(direction); if (direction === "outbound" && withheld) increment("withheld");
    try { this.options.changed?.(); } catch { /* Metrics observation changes no send/admission outcome. */ }
  }
  private valid(binding: Binding): boolean {
    return !this.stopped && this.bindings.get(binding.name) === binding && binding.store.get(binding.name)?.left === false;
  }
  bind(store: RoomStore, name: string, link: RoomLink): void {
    if (this.stopped) return;
    const state = store.get(name), digest = state?.current.digest; if (!digest || !state) return;
    const room = state.current.room, counted = this.counts.get(name);
    if (counted?.room !== room && (counted || this.counts.size < 64)) this.counts.set(name, { room, outbound: 0, inbound: 0, withheld: 0 });
    const saved = this.bindings.get(name);
    const binding = saved?.store === store && saved.link === link && saved.room === room ? saved : { store, name, room, link, digest, online: false, states: new Map<string, PeerState>() };
    if (binding.digest !== digest) { binding.states.clear(); binding.online = false; binding.digest = digest; }
    this.bindings.set(name, binding);
    this.refreshTargets(); this.refreshOutgoing(binding); this.queueChanged();
  }
  private refreshTargets(): void {
    const candidates = new Map<string, Target[]>();
    for (const binding of this.bindings.values()) {
      const state = binding.store.get(binding.name);
      if (!this.valid(binding) || !state) continue;
      for (const member of roomMembers(state.current)) {
        if (member.fingerprint === binding.store.identity.public.fingerprint) continue;
        for (const peer of new Set([...member.exposedPeers, USER])) {
          // USER routes only to the remote hub's signed unsupported-inbox refusal, never a human queue.
          const id = `${peer}@${member.label}`;
          if (!parseRemotePeerId(id)) continue;
          const rows = candidates.get(id) ?? []; rows.push({ binding, member: member.fingerprint, peer }); candidates.set(id, rows);
        }
      }
    }
    this.targets.clear();
    for (const [id, rows] of candidates) {
      // A global peer@label cannot select between rooms. Ambiguous ids stay inert.
      if (rows.length !== 1) continue;
      const target = rows[0]!, room = target.binding.store.get(target.binding.name)!.current.room;
      let remote = this.remotes.get(id);
      if (remote && (remote.remoteRoom !== room || remote.remoteMember !== target.member)) {
        const pending = this.options.bus.queueSummary(id);
        if (this.options.bus.pendingEnvelopes(id).length || pending.needsReview || pending.liveAccepted || remote.state === "busy") continue;
        void remote.stop(); this.remotes.delete(id); remote = undefined;
      }
      if (!remote) {
        let timing: { ackTimeoutMs: number; ttlMs: number }; try { timing = this.policy.timing(); } catch { continue; }
        remote = new RemotePeer(id, room, timing.ttlMs, {
          member: target.member,
          context: env => {
            const selected = this.targets.get(id);
            if (!selected || selected.member !== target.member || selected.peer !== target.peer || selected.binding.store.get(selected.binding.name)?.current.room !== room) throw new Error("room: state_changed");
            const binding = selected.binding, state = binding.store.get(binding.name), version = this.options.policyVersion();
            const digest = state?.current.digest;
            const current = () => this.valid(binding) && this.targets.get(id)?.binding === binding && this.targets.get(id)?.member === target.member && this.options.policyVersion() === version
              && binding.store.get(binding.name)?.current.digest === digest;
            return { cwd: this.options.cwd, target: id, current,
              senderExposed: peer => this.exposed(binding, peer), senderPrivate: this.options.senderPrivate,
              taskPrivate: this.options.taskPrivate, routing: this.options.routing, piiPaths: this.options.piiPaths,
              modelScreenOn: this.options.modelScreenOn, screen: this.options.screen };
          },
          send: async (env, deliveryId, expiresAt, current, withheld) => {
            const selected = this.targets.get(id);
            if (!selected || selected.member !== target.member || selected.peer !== target.peer || selected.binding.store.get(selected.binding.name)?.current.room !== room) throw new Error("room: state_changed");
            const binding = selected.binding;
            if (!current()) throw new Error("room: state_changed");
            const timing = this.policy.timing(), remaining = expiresAt - this.now();
            if (remaining <= 0) throw new Error("room: expired");
            try {
              await binding.link.publishApplication({ v: 1, type: "chat", envelope: env }, target.member, {
                deliveryId, application: env.id, remotePeer: id, recipient: target.member, peer: target.peer,
                ackTimeoutMs: timing.ackTimeoutMs, ttlMs: Math.min(remaining, timing.ttlMs),
              }, current);
              this.count(binding, "outbound", withheld === true);
            } catch (error) { binding.store.quarantineOutgoing(binding.name, deliveryId); throw error; }
            finally { this.refreshOutgoing(binding); this.queueChanged(); }
          }, quarantine: deliveryId => {
            const selected = this.targets.get(id);
            const cached = [...this.outgoing.values()].filter(value => value.row.deliveryId === deliveryId && value.row.remotePeer === id && value.row.recipient === target.member).map(value => value.binding);
            const bindings = [...new Set([...(selected?.member === target.member && selected.peer === target.peer ? [selected.binding] : []), ...cached])];
            for (const binding of bindings) try {
              if (binding.store.get(binding.name)?.current.room !== room) continue;
              const row = binding.store.quarantineOutgoing(binding.name, deliveryId);
              if (row && row.remotePeer === id && row.recipient === target.member) { this.outcome(binding, row); return; }
            } catch { /* A retained old binding may already be closed after an explicit rejoin. */ }
          }, now: () => this.now(),
        });
        try { this.options.bus.add(remote); } catch { continue; }
        this.remotes.set(id, remote); void remote.start();
      }
      this.targets.set(id, target);
    }
    // ponytail: status shows complete peer lists only within 32 per room / 256 total.
    // Larger lists stay unknown here; the explicit room status command remains the detail path.
    const statusTargets = new Map<string, string[] | null>([...this.bindings.keys()].map(name => [name, []]));
    // An exposed candidate that cannot route uniquely is unknown, never an empty exposure list.
    for (const [id, rows] of candidates) if (rows.some(row => row.peer !== USER) && (rows.length !== 1 || !this.targets.has(id))) {
      for (const row of rows) statusTargets.set(row.binding.name, null);
    }
    let shown = 0;
    for (const [id, target] of this.targets) {
      if (target.peer === USER) continue;
      const ids = statusTargets.get(target.binding.name);
      if (!ids) continue;
      if (ids.length >= 32 || shown >= 256) { shown -= ids.length; statusTargets.set(target.binding.name, null); }
      else { ids.push(id); shown++; }
    }
    this.statusTargets = statusTargets;
    for (const [id, remote] of this.remotes) {
      const target = this.targets.get(id);
      remote.presence(target?.peer === USER ? "idle" : target?.binding.states.get(id) ?? "offline", target?.binding.online === true);
    }
    this.options.roster?.([...this.targets.keys()]);
  }
  private exposed(binding: Binding, peer: string): boolean {
    const state = binding.store.get(binding.name);
    return this.valid(binding) && !!state && this.options.bus.peers.has(peer) && this.options.bus.isRostered(peer) && !peer.includes("@")
      && this.policy.get(binding.name).includes(peer)
      && roomMembers(state.current).some(member => member.fingerprint === binding.store.identity.public.fingerprint && member.exposedPeers.includes(peer));
  }
  presence(store: RoomStore, name: string, link: RoomLink, value: { member: string; peers: readonly RoomPresencePeer[] }): void {
    const binding = this.bindings.get(name), state = store.get(name);
    if (!binding || binding.store !== store || binding.link !== link || !state || !this.valid(binding)) return;
    const member = roomMembers(state.current).find(row => row.fingerprint === value.member);
    if (!member) return;
    for (const peer of member.exposedPeers) binding.states.delete(`${peer}@${member.label}`);
    for (const peer of value.peers) if (member.exposedPeers.includes(peer.id)) binding.states.set(`${peer.id}@${member.label}`, peer.state);
    this.refreshTargets();
  }
  linkState(store: RoomStore, name: string, link: RoomLink, state: RoomLinkState): void {
    const binding = this.bindings.get(name);
    if (!binding || binding.store !== store || binding.link !== link) return;
    binding.online = state === "online";
    // A transport blip does not revoke the last authenticated signed state.
    // A new roster digest still clears it in bind(), before target reconstruction.
    if (!this.valid(binding)) {
      try { for (const row of binding.store.applicationOutbox(name, true)) if (row.state === "dispatching" || row.state === "accepted") {
        const unknown = binding.store.quarantineOutgoing(name, row.deliveryId); if (unknown) this.outcome(binding, unknown);
      } } catch { for (const [key, row] of this.outgoing) if (row.binding === binding) this.outgoing.delete(key); }
    }
    this.refreshTargets();
    this.queueChanged();
  }
  private refreshOutgoing(binding: Binding): void {
    this.evidenceCache = undefined;
    for (const [key, value] of this.outgoing) if (value.binding.name === binding.name) this.outgoing.delete(key);
    for (const row of binding.store.applicationOutbox(binding.name, true)) this.outgoing.set(`${binding.name}:${row.digest}`, { binding, row });
  }
  pendingIds(room: string): string[] {
    return [...new Set([...this.outgoing.values()].filter(({ binding, row }) => binding.store.get(binding.name)?.current.room === room && ACTIVE.has(row.state) && !row.disposition).map(({ row }) => row.application))];
  }
  private outcome(binding: Binding, row: RoomOutgoing): void {
    const remote = this.remotes.get(row.remotePeer);
    if (row.lateReceipt) this.options.bus.noteLateRemoteReceipt(row.remotePeer, row.deliveryId, row.lateReceipt.outcome);
    else if (!row.disposition) remote?.receipt({ id: row.deliveryId, state: row.state === "dispatching" ? "needs_review" : row.state, reason: row.state === "completed" ? "room completed (admitted)" : row.state === "failed_safe" ? roomReceiptReasonText(row.reason ?? "invalid_message") : row.state === "accepted" ? "room broker accepted ciphertext" : "room acknowledgement expired or outcome uncertain" });
    this.refreshOutgoing(binding); this.queueChanged(); this.options.changed?.();
  }
  private rate(from: string, member: string, target: string, body: string): boolean {
    const config = this.options.limits?.() ?? PROJECT_LIMITS, key = JSON.stringify(config);
    if (key !== this.limitKey) { this.limitKey = key; this.peerLimiter = new Limiter(config, () => this.now()); }
    return !this.peerLimiter.admit(from, [target], "status", body, "", member);
  }
  private sourceUnambiguous(binding: Binding, member: string, label: string): boolean {
    const owners = new Set<string>();
    for (const room of this.bindings.values()) {
      const state = room.store.get(room.name); if (!this.valid(room) || !state) continue;
      for (const row of roomMembers(state.current)) if (row.fingerprint !== room.store.identity.public.fingerprint && row.label === label) owners.add(row.fingerprint);
    }
    return this.valid(binding) && owners.size === 1 && owners.has(member);
  }
  private async receive(context: RoomLinkContext, input: { digest: string; sender: string; message?: RoomMessage }): Promise<void> {
    if (!context.current() || this.stopped) throw new Error("room: state_changed");
    const binding = this.bindings.get(context.name);
    if (!binding || binding.store !== context.store || binding.link !== context.link) throw new Error("room: unavailable");
    const saved = context.store.applicationReceipt(context.name, input.digest);
    if (saved) { await context.link.publishApplication(saved, input.sender, undefined, context.current); return; }
    if (input.message?.type === "receipt") {
      const row = context.store.applyApplicationReceipt(context.name, input.digest, context.current);
      if (row) this.outcome(binding, row);
      context.store.settleInbox(context.name, input.digest); this.capacityChanged(); return;
    }
    if (!input.message) return; // Exact unknown/stale digest never earns a fabricated application receipt.
    let incoming: Awaited<ReturnType<RoomStore["applicationIncoming"]>>;
    try { incoming = await context.store.applicationIncoming(context.name, input.digest, context.current); }
    catch (error) {
      if (error instanceof RoomApplicationLimitError) try { this.options.notice?.({ code: "application_capacity", room: error.room, count: error.count }); } catch { /* fixed metadata observation only */ }
      if (error instanceof RoomStoreError && error.code === "invalid") { context.store.settleInbox(context.name, input.digest); this.capacityChanged(); return; }
      if (error instanceof RoomApplicationLimitError) throw new RoomApplicationDeferredError("capacity");
      if (error instanceof RoomStoreError && error.code === "limit") throw new RoomApplicationDeferredError("admission_limit");
      throw error;
    }
    if (!context.current() || !this.valid(binding)) throw new Error("room: state_changed");
    this.capacityChanged(); // Registration may have settled a duplicate's retained plaintext.
    const duplicate = context.store.applicationReceipt(context.name, input.digest);
    if (duplicate) { await context.link.publishApplication(duplicate, input.sender, undefined, context.current); return; }
    if (!incoming.primary || incoming.state !== "pending") return;
    if (!this.options.bus.deliveryJournalAvailable()) throw new RoomApplicationDeferredError("journal_unavailable");
    const state = context.store.get(context.name)!, member = roomMembers(state.current).find(row => row.fingerprint === incoming.sender), chat = incoming.chat;
    const from = member ? `${chat.from}@${member.label}` : "";
    const env: Envelope = { ...chat, from, to: [chat.to], priority: chat.priority === "fyi" ? "fyi" : "status" };
    let refusal: RoomReceiptReason | undefined;
    if (!member || !parseRemotePeerId(from) || !this.sourceUnambiguous(binding, incoming.sender, member.label)) refusal = "not_exposed";
    else if (chat.from !== USER && !member.exposedPeers.includes(chat.from)) refusal = "not_exposed";
    else if (chat.to === USER) refusal = "person_inbox_unsupported";
    else if (!this.exposed(binding, chat.to)) refusal = "not_exposed";
    else if (chat.priority === "fyi") refusal = "boundary_refused";
    else if (chat.hop > MAX_HOP || chat.hop < (context.store.applicationTraceHop(chat.trace) ?? 0)) refusal = "hop";
    else if (this.options.bus.hushed(env).some(row => row.peer === chat.to)) refusal = "boundary_refused";
    else if (!this.rate(from, incoming.sender, chat.to, chat.body)) refusal = "rate_limited";
    if (refusal) context.store.finishApplication(context.name, input.digest, "failed_safe", refusal, context.current);
    else if (context.store.claimApplication(context.name, input.digest, context.current)) {
      try {
        if (!context.current() || !this.exposed(binding, chat.to)) throw new Error("room: state_changed");
        const result = this.options.bus.publishResult(env);
        if (!result.targets.length) context.store.finishApplication(context.name, input.digest, "failed_safe", "boundary_refused", context.current);
        else {
          if (result.targets.length !== 1 || result.targets[0] !== chat.to || result.dropped) throw new Error("room: admission unavailable");
          context.store.finishApplication(context.name, input.digest, "completed", "admitted", context.current);
          this.count(binding, "inbound");
        }
      } catch (error) {
        // Revocation removes business authority, but still permits recording uncertainty.
        context.store.quarantineApplication(context.name, input.digest);
        this.capacityChanged();
        this.options.changed?.(); throw error;
      }
    }
    this.capacityChanged();
    const receipt = context.store.applicationReceipt(context.name, input.digest);
    if (receipt) await context.link.publishApplication(receipt, input.sender, undefined, context.current);
    this.options.changed?.();
  }
  queueChanged(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; if (this.stopped || !this.bindings.size) return;
    let next = this.options.bus.nextRemoteExpiry();
    for (const { row } of this.outgoing.values()) if ((row.state === "dispatching" || row.state === "accepted") && !row.disposition) {
      const due = Math.min(row.expiresAt, row.ackDeadline ?? Infinity); next = next === undefined ? due : Math.min(next, due);
    }
    if (next === undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; try { this.tick(); } catch { this.stop(); } }, Math.max(1, Math.min(2_147_483_647, next - this.now())));
    this.timer.unref?.();
  }
  tick(): void {
    if (this.stopped) return;
    this.options.bus.expireRemoteQueues(this.now());
    for (const binding of this.bindings.values()) if (this.valid(binding)) {
      try {
        for (const row of binding.store.expireApplications(binding.name)) this.outcome(binding, row);
        this.reconcileDispositions(binding);
      }
      catch { binding.online = false; for (const [key, entry] of this.outgoing) if (entry.binding === binding) this.outgoing.delete(key); }
    }
    void this.retryPending(); this.queueChanged();
  }
  /** Global byte capacity can be freed by another room. This is event-coalesced, never polled. */
  private capacityChanged(): void {
    if (this.stopped || this.capacityRefreshPending) return;
    this.capacityRefreshPending = true;
    queueMicrotask(() => {
      this.capacityRefreshPending = false;
      if (this.stopped) return;
      for (const binding of this.bindings.values()) try {
        if (binding.online && this.valid(binding)) void binding.link.refreshPresenceIfCapacityFree().catch(() => undefined);
      } catch { /* Retain the numeric pending refresh flag until another actual capacity event. */ }
    });
  }
  /** Explicit disposition/online opportunities only; blocked plaintext is never polled. */
  async retryPending(name?: string): Promise<void> {
    if (this.stopped) return;
    const retries: Promise<void>[] = [];
    for (const binding of this.bindings.values()) try {
      if ((name === undefined || name === binding.name) && this.valid(binding) && binding.online) retries.push(Promise.resolve().then(() => binding.link.retryPendingApplications()));
    } catch { /* A completed person disposition must not fail because another room is unavailable. */ }
    await Promise.allSettled(retries); this.capacityChanged();
  }
  private reconcileDispositions(binding: Binding): void {
    for (const row of binding.store.applicationOutbox(binding.name, true)) if (row.state === "needs_review" && !row.disposition) {
      const action = this.options.bus.remoteDisposition(row.deliveryId);
      if (action) binding.store.disposeApplication(binding.name, row.deliveryId, action, () => !this.stopped);
    }
    this.refreshOutgoing(binding);
  }
  disposition(peer: string, deliveryId: string, action: "completed" | "retry" | "discard"): void {
    if (this.options.bus.remoteDisposition(deliveryId) !== action) return;
    for (const binding of this.bindings.values()) {
      const row = binding.store.applicationOutbox(binding.name, true).find(row => row.deliveryId === deliveryId && row.remotePeer === peer);
      if (!row) continue;
      binding.store.disposeApplication(binding.name, deliveryId, action, () => !this.stopped);
      this.refreshOutgoing(binding); break;
    }
    this.refreshTargets(); this.queueChanged(); void this.retryPending();
  }
  evidence(peer: string, deliveryId: string): { roomState: string; disposition?: string; lateReceipt?: string; refusalReason?: string } | undefined {
    if (!peer.includes("@")) return undefined;
    if (!this.evidenceCache) {
      const cache = new Map<string, { peer: string; roomState: string; disposition?: string; lateReceipt?: string; refusalReason?: string }>();
      for (const binding of this.bindings.values()) for (const row of binding.store.applicationOutbox(binding.name)) cache.set(row.deliveryId, {
        peer: row.remotePeer, roomState: row.state === "completed" ? "completed (admitted)" : row.state,
        ...(row.disposition ? { disposition: row.disposition } : {}),
        ...(row.lateReceipt ? { lateReceipt: row.lateReceipt.outcome === "completed" ? "completed (admitted)" : "failed_safe" } : {}),
        ...(row.reason && row.reason !== "admitted" || row.lateReceipt?.reason && row.lateReceipt.reason !== "admitted" ? { refusalReason: roomReceiptReasonText(row.reason ?? row.lateReceipt!.reason) } : {}),
      });
      this.evidenceCache = cache;
      queueMicrotask(() => { if (this.evidenceCache === cache) this.evidenceCache = undefined; });
    }
    const row = this.evidenceCache.get(deliveryId); if (!row || row.peer !== peer) return undefined;
    const { peer: _peer, ...view } = row; return view;
  }
  rows(name: string): Record<string, unknown>[] {
    const binding = this.bindings.get(name); if (!binding) return [];
    const incoming = binding.store.applicationStatus(name);
    return [...binding.store.applicationOutbox(name).sort((a, b) => Number(!ACTIVE.has(a.state) || !!a.disposition) - Number(!ACTIVE.has(b.state) || !!b.disposition) || b.createdAt - a.createdAt).slice(0, 200).map(row => ({ direction: "outbound", id: row.deliveryId, application: row.application, peer: row.remotePeer, state: row.state === "completed" ? "completed (admitted)" : row.state, ...(row.disposition ? { disposition: row.disposition } : {}), ...(row.lateReceipt ? { lateReceipt: row.lateReceipt.outcome === "completed" ? "completed (admitted)" : "failed_safe" } : {}), ...(row.reason && row.reason !== "admitted" || row.lateReceipt?.reason && row.lateReceipt.reason !== "admitted" ? { refusalReason: row.reason ?? row.lateReceipt!.reason } : {}) })),
      ...incoming.rows.map(row => ({ direction: "inbound", id: row.digest, application: row.application, state: row.state === "disposed" ? `disposed (${row.disposition}, by person)` : row.state, peer: row.peer, ...(row.disposedAt ? { disposedAt: row.disposedAt } : {}) })),
      { direction: "inbound", pending: incoming.pending, needsReview: incoming.needsReview, truncated: incoming.truncated }];
  }
  peers(name: string): { id: string; state: PeerState }[] {
    return [...this.targets].filter(([, target]) => target.binding.name === name && target.peer !== USER).map(([id]) => ({ id, state: this.remotes.get(id)?.state ?? "offline" })).sort((a, b) => a.id.localeCompare(b.id));
  }
  /** A bounded status list, separate from the explicit detail query above. */
  peersForStatus(name: string): { id: string; state: PeerState }[] | null {
    const ids = this.statusTargets.get(name);
    return ids ? ids.map(id => ({ id, state: this.remotes.get(id)?.state ?? "offline" })) : null;
  }
  stop(): void {
    if (this.stopped) return; this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const remote of this.remotes.values()) void remote.stop().catch(() => undefined);
    this.options.roster?.([]);
  }
}
