/** Host integration for X4. Remote identities carry chat, never local control authority. */
import { Bus } from "../hub/bus.ts";
import { USER, MAX_HOP, type Envelope, type PeerState } from "../hub/envelope.ts";
import { Limiter, PROJECT_LIMITS, type LimitsConfig } from "../hub/limits.ts";
import type { PiiVerdict } from "../hub/inference.ts";
import type { Routing } from "../hub/routing.ts";
import { roomMembers } from "./wire.ts";
import { RoomStore, RoomStoreError, type RoomOutgoing } from "./store.ts";
import { RoomPolicy } from "./policy.ts";
import { RemotePeer } from "./remote-peer.ts";
import { parseRemotePeerId, type RoomMessage, type RoomReceiptReason } from "./application.ts";
import type { RoomLink, RoomLinkApplication, RoomLinkContext, RoomLinkState, RoomPresencePeer } from "./link.ts";

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
}
interface Binding { store: RoomStore; name: string; link: RoomLink; digest: string; online: boolean; states: Map<string, PeerState> }
interface Target { binding: Binding; member: string; peer: string }
const ACTIVE = new Set(["dispatching", "accepted", "needs_review"]);

export class RoomChat {
  private readonly policy: RoomPolicy;
  private readonly bindings = new Map<string, Binding>();
  private readonly targets = new Map<string, Target>();
  private readonly remotes = new Map<string, RemotePeer>();
  private readonly outgoing = new Map<string, { binding: Binding; row: RoomOutgoing }>();
  private evidenceCache?: Map<string, { peer: string; roomState: string; disposition?: string; lateReceipt?: string }>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private limitKey = "";
  private peerLimiter = new Limiter(PROJECT_LIMITS);
  private hubLimiter = new Limiter(PROJECT_LIMITS);
  readonly application: RoomLinkApplication;
  constructor(private readonly options: RoomChatOptions) {
    this.policy = new RoomPolicy(options.cwd);
    this.application = {
      members: context => { if (context.current()) this.bind(context.store, context.name, context.link); },
      receive: (context, input) => this.receive(context, input),
      online: async context => { if (context.current()) { this.bind(context.store, context.name, context.link); this.bindings.get(context.name)!.online = true; this.refreshTargets(); this.refreshOutgoing(this.bindings.get(context.name)!); this.queueChanged(); } },
      stored: (context, input) => {
        if (!context.current()) return;
        const row = context.store.markApplicationStored(context.name, input.digest, input.seq);
        if (row) this.outcome(this.bindings.get(context.name)!, row);
      },
    };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private valid(binding: Binding): boolean {
    return !this.stopped && this.bindings.get(binding.name) === binding && binding.store.get(binding.name)?.left === false;
  }
  bind(store: RoomStore, name: string, link: RoomLink): void {
    if (this.stopped) return;
    const digest = store.get(name)?.current.digest; if (!digest) return;
    const saved = this.bindings.get(name);
    const binding = saved?.store === store && saved.link === link ? saved : { store, name, link, digest, online: false, states: new Map<string, PeerState>() };
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
        for (const peer of member.exposedPeers) {
          // USER is a sender identity, not a native peer with a durable local queue.
          if (peer === USER) continue;
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
            const binding = target.binding, state = binding.store.get(binding.name), version = this.options.policyVersion();
            const digest = state?.current.digest;
            const current = () => this.valid(binding) && this.targets.get(id)?.binding === binding && this.targets.get(id)?.member === target.member && this.options.policyVersion() === version
              && binding.store.get(binding.name)?.current.digest === digest;
            return { cwd: this.options.cwd, target: id, current,
              senderExposed: peer => this.exposed(binding, peer), senderPrivate: this.options.senderPrivate,
              taskPrivate: this.options.taskPrivate, routing: this.options.routing, piiPaths: this.options.piiPaths,
              modelScreenOn: this.options.modelScreenOn, screen: this.options.screen };
          },
          send: async (env, deliveryId, expiresAt, current) => {
            const binding = target.binding;
            if (!current()) throw new Error("room: state_changed");
            const timing = this.policy.timing(), remaining = expiresAt - this.now();
            if (remaining <= 0) throw new Error("room: expired");
            try {
              await binding.link.publishApplication({ v: 1, type: "chat", envelope: env }, target.member, {
                deliveryId, application: env.id, remotePeer: id, recipient: target.member, peer: target.peer,
                ackTimeoutMs: timing.ackTimeoutMs, ttlMs: Math.min(remaining, timing.ttlMs),
              }, current);
            } catch (error) { binding.store.quarantineOutgoing(binding.name, deliveryId); throw error; }
            finally { this.refreshOutgoing(binding); this.queueChanged(); }
          }, now: () => this.now(),
        });
        try { this.options.bus.add(remote); } catch { continue; }
        this.remotes.set(id, remote); void remote.start();
      }
      this.targets.set(id, target);
    }
    for (const [id, remote] of this.remotes) {
      const target = this.targets.get(id);
      remote.presence(target?.binding.states.get(id) ?? "offline", target?.binding.online === true);
    }
    this.options.roster?.([...this.targets.keys()]);
  }
  private exposed(binding: Binding, peer: string): boolean {
    const state = binding.store.get(binding.name);
    return this.valid(binding) && !!state && this.options.bus.peers.has(peer) && !peer.includes("@")
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
    if (!binding.online) binding.states.clear();
    this.refreshTargets();
  }
  private refreshOutgoing(binding: Binding): void {
    this.evidenceCache = undefined;
    for (const [key, value] of this.outgoing) if (value.binding === binding) this.outgoing.delete(key);
    for (const row of binding.store.applicationOutbox(binding.name, true)) this.outgoing.set(`${binding.name}:${row.digest}`, { binding, row });
  }
  pendingIds(room: string): string[] {
    return [...new Set([...this.outgoing.values()].filter(({ binding, row }) => binding.store.get(binding.name)?.current.room === room && ACTIVE.has(row.state) && !row.disposition).map(({ row }) => row.application))];
  }
  private outcome(binding: Binding, row: RoomOutgoing): void {
    const remote = this.remotes.get(row.remotePeer);
    if (row.lateReceipt) this.options.bus.noteLateRemoteReceipt(row.remotePeer, row.deliveryId, row.lateReceipt.outcome);
    else if (!row.disposition) remote?.receipt({ id: row.deliveryId, state: row.state === "dispatching" ? "needs_review" : row.state, reason: row.state === "completed" ? "room completed (admitted)" : row.state === "failed_safe" ? `room: ${row.reason}` : "room acknowledgement expired or outcome uncertain" });
    this.refreshOutgoing(binding); this.queueChanged(); this.options.changed?.();
  }
  private rate(from: string, member: string, target: string, body: string): boolean {
    const config = this.options.limits?.() ?? PROJECT_LIMITS, key = JSON.stringify(config);
    if (key !== this.limitKey) { this.limitKey = key; this.peerLimiter = new Limiter(config, () => this.now()); this.hubLimiter = new Limiter(config, () => this.now()); }
    return !this.peerLimiter.admit(from, [target], "status", body) && !this.hubLimiter.admit(`room-member:${member}`, [target], "status", body);
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
      context.store.settleInbox(context.name, input.digest); return;
    }
    if (!input.message) return; // Exact unknown/stale digest never earns a fabricated application receipt.
    let incoming: Awaited<ReturnType<RoomStore["applicationIncoming"]>>;
    try { incoming = await context.store.applicationIncoming(context.name, input.digest, context.current); }
    catch (error) {
      if (error instanceof RoomStoreError && error.code === "invalid") { context.store.settleInbox(context.name, input.digest); return; }
      throw error;
    }
    if (!context.current() || !this.valid(binding)) throw new Error("room: state_changed");
    const duplicate = context.store.applicationReceipt(context.name, input.digest);
    if (duplicate) { await context.link.publishApplication(duplicate, input.sender, undefined, context.current); return; }
    if (!incoming.primary || incoming.state !== "pending") return;
    if (!this.options.bus.deliveryJournalAvailable()) throw new Error("room: durable admission unavailable");
    const state = context.store.get(context.name)!, member = roomMembers(state.current).find(row => row.fingerprint === incoming.sender), chat = incoming.chat;
    const from = member ? `${chat.from}@${member.label}` : "";
    let refusal: RoomReceiptReason | undefined;
    if (!member || !parseRemotePeerId(from) || !this.sourceUnambiguous(binding, incoming.sender, member.label)) refusal = "not_exposed";
    else if (!this.exposed(binding, chat.to) || chat.to === USER) refusal = "not_exposed";
    else if (chat.priority === "fyi") refusal = "boundary_refused";
    else if (chat.hop > MAX_HOP || chat.hop < (context.store.applicationTraceHop(chat.trace) ?? 0)) refusal = "hop";
    else if (!this.rate(from, incoming.sender, chat.to, chat.body)) refusal = "rate_limited";
    if (refusal) context.store.finishApplication(context.name, input.digest, "failed_safe", refusal, context.current);
    else if (context.store.claimApplication(context.name, input.digest, context.current)) {
      try {
        if (!context.current() || !this.exposed(binding, chat.to)) throw new Error("room: state_changed");
        const env: Envelope = { ...chat, from, to: [chat.to], priority: chat.priority === "fyi" ? "fyi" : "status" };
        const result = this.options.bus.publishResult(env);
        if (result.targets.length !== 1 || result.targets[0] !== chat.to || result.dropped) throw new Error("room: admission unavailable");
        context.store.finishApplication(context.name, input.digest, "completed", "admitted", context.current);
      } catch (error) {
        // Revocation removes business authority, but still permits recording uncertainty.
        context.store.quarantineApplication(context.name, input.digest);
        this.options.changed?.(); throw error;
      }
    }
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
    this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, Math.max(1, Math.min(2_147_483_647, next - this.now())));
    this.timer.unref?.();
  }
  tick(): void {
    if (this.stopped) return;
    this.options.bus.expireRemoteQueues(this.now());
    for (const binding of this.bindings.values()) if (this.valid(binding)) {
      try { for (const row of binding.store.expireApplications(binding.name)) this.outcome(binding, row); }
      catch { binding.online = false; for (const [key, entry] of this.outgoing) if (entry.binding === binding) this.outgoing.delete(key); }
    }
    this.queueChanged();
  }
  disposition(peer: string, deliveryId: string, action: "completed" | "retry" | "discard"): void {
    if (this.options.bus.remoteDisposition(deliveryId) !== action) return;
    for (const binding of this.bindings.values()) {
      const row = binding.store.applicationOutbox(binding.name, true).find(row => row.deliveryId === deliveryId && row.remotePeer === peer);
      if (!row) continue;
      binding.store.disposeApplication(binding.name, deliveryId, action, () => !this.stopped);
      this.refreshOutgoing(binding); this.queueChanged(); return;
    }
  }
  evidence(peer: string, deliveryId: string): { roomState: string; disposition?: string; lateReceipt?: string } | undefined {
    if (!peer.includes("@")) return undefined;
    if (!this.evidenceCache) {
      const cache = new Map<string, { peer: string; roomState: string; disposition?: string; lateReceipt?: string }>();
      for (const binding of this.bindings.values()) for (const row of binding.store.applicationOutbox(binding.name)) cache.set(row.deliveryId, {
        peer: row.remotePeer, roomState: row.state === "completed" ? "completed (admitted)" : row.state,
        ...(row.disposition ? { disposition: row.disposition } : {}),
        ...(row.lateReceipt ? { lateReceipt: row.lateReceipt.outcome === "completed" ? "completed (admitted)" : "failed_safe" } : {}),
      });
      this.evidenceCache = cache;
      queueMicrotask(() => { if (this.evidenceCache === cache) this.evidenceCache = undefined; });
    }
    const row = this.evidenceCache.get(deliveryId); if (!row || row.peer !== peer) return undefined;
    const { peer: _peer, ...view } = row; return view;
  }
  rows(name: string): Record<string, unknown>[] {
    const binding = this.bindings.get(name); if (!binding) return [];
    const rows = binding.store.applicationOutbox(name);
    for (const row of rows) if (row.state === "needs_review" && !row.disposition) {
      const action = this.options.bus.remoteDisposition(row.deliveryId);
      if (action) this.disposition(row.remotePeer, row.deliveryId, action);
    }
    const incoming = binding.store.applicationStatus(name);
    return [...binding.store.applicationOutbox(name).slice(-200).map(row => ({ direction: "outbound", id: row.deliveryId, application: row.application, peer: row.remotePeer, state: row.state === "completed" ? "completed (admitted)" : row.state, ...(row.disposition ? { disposition: row.disposition } : {}), ...(row.lateReceipt ? { lateReceipt: row.lateReceipt.outcome === "completed" ? "completed (admitted)" : "failed_safe" } : {}) })),
      ...incoming.rows.map(row => ({ direction: "inbound", id: row.digest, application: row.application, state: row.state, peer: row.peer })),
      { direction: "inbound", pending: incoming.pending, needsReview: incoming.needsReview, truncated: incoming.truncated }];
  }
  stop(): void {
    if (this.stopped) return; this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const remote of this.remotes.values()) void remote.stop();
    this.options.roster?.([]);
  }
}
