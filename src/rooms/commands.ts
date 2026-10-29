/** Host-only room administration. No remote envelope enters the local bus in X3. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertRoomCryptoReady, decodeBase64url, encodeBase64url, signBytes, verifyBytes } from "./crypto.ts";
import { acceptRoomEpoch, brokerUrl, canonicalBytes, createInvite, createJoin, createRoomEpoch, decodeInvite, decodeJoin, decodeRoster, roomMembers } from "./wire.ts";
import { RoomStore, type RoomState, type RoomPersonInboxMeta, type RoomPersonInboxItem } from "./store.ts";
import { RoomLink } from "./link.ts";
import { exposedPeers, roomName, RoomPolicy } from "./policy.ts";
import type { RoomChat } from "./service.ts";
import { projectRoomStatus, type RoomStatusView } from "./status.ts";

export interface RoomCommandResult { kind?: string; artifact?: string; name?: string; room?: string; owner?: string; member?: string }
export interface RoomPreview { owner: string; member: string; commit: () => Promise<RoomCommandResult> }
const FP = /^[0-9a-f]{64}$/;
function refuse(code: string): never { throw new Error(`room: ${code}`); }
function fields(input: unknown, keys: string[], optional: string[] = []): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("invalid_input");
  const row = input as Record<string, any>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(row, key))) refuse("invalid_input");
  return row;
}
function artifact(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3)) refuse("invalid_artifact");
  try { const wire = decodeBase64url(value); if (wire.length > max) refuse("invalid_artifact"); return wire; }
  catch { return refuse("invalid_artifact"); }
}
function audience(raw: unknown): string {
  const value = brokerUrl(raw), url = new URL(value);
  if (url.pathname !== "/" || url.search) refuse("invalid_broker");
  return value;
}
function exposureBytes(request: Omit<ExposureRequest, "signature">): Uint8Array {
  return canonicalBytes(["agent-hub.rooms.exposure.v1", request]);
}
interface ExposureRequest { v: 1; type: "exposure"; room: string; owner: string; member: string; digest: string; peers: string[]; signature: string }
function exposureRequest(wire: Uint8Array): ExposureRequest | undefined {
  let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire)); } catch { return undefined; }
  if ((raw as any)?.type !== "exposure") return undefined;
  const row = fields(raw, ["v", "type", "room", "owner", "member", "digest", "peers", "signature"]);
  if (row.v !== 1 || !FP.test(row.owner) || !FP.test(row.member) || typeof row.room !== "string" || typeof row.digest !== "string" || typeof row.signature !== "string") refuse("invalid_artifact");
  exposedPeers(row.peers);
  const normalized = canonicalBytes(row);
  if (normalized.length !== wire.length || normalized.some((byte, i) => byte !== wire[i])) refuse("invalid_artifact");
  return row as ExposureRequest;
}
export class RoomCommands {
  private pending?: Promise<RoomStore>;
  private store?: RoomStore;
  private stopped = false;
  private readonly links = new Map<string, RoomLink>();
  private readonly policy: RoomPolicy;
  constructor(private readonly options: { stateDir: string; cwd: string; clock?: () => number; presence?: () => readonly {id: string; state: string}[]; chat?: RoomChat }) { this.policy = new RoomPolicy(options.cwd); }
  private async open(): Promise<RoomStore> {
    if (this.stopped) refuse("stopped");
    this.pending ??= RoomStore.open({ stateDir: join(this.options.stateDir, "rooms"), ...(this.options.clock ? { clock: this.options.clock } : {}) }).then(store => {
      if (this.stopped) { store.close(); return refuse("stopped"); }
      this.store = store; return store;
    });
    return this.pending;
  }
  async start(): Promise<void> {
    if (!existsSync(join(this.options.stateDir, "rooms"))) return;
    const store = await this.open();
    if (!this.stopped) for (const state of store.list()) if (!state.left) this.link(state.name);
  }
  stop(): void { this.stopped = true; clearTimeout(this.presenceTimer); this.options.chat?.stop(); for (const link of this.links.values()) link.stop(); this.links.clear(); this.store?.close(); }
  private link(name: string): void {
    if (this.stopped || !this.store || this.store.get(name)?.left) return;
    let link = this.links.get(name);
    if (!link) {
      const store = this.store;
      const created: RoomLink = new RoomLink({ store, name, application: this.options.chat?.application,
        onPresence: value => this.options.chat?.presence(store, name, created, value),
        onState: state => this.options.chat?.linkState(store, name, created, state), presence: () => {
        const allowed = new Set(this.policy.get(name));
        return (this.options.presence?.() ?? []).filter(row => allowed.has(row.id));
      } });
      this.links.set(name, created); link = created;
      this.options.chat?.bind(store, name, created);
      void created.start().catch(() => undefined);
    } else { this.options.chat?.bind(this.store, name, link); link.refresh(); }
  }
  private presenceTimer?: ReturnType<typeof setTimeout>;
  changed(): void {
    if (this.stopped || this.presenceTimer) return;
    // Coalesce peer state bursts; payloads remain the signed ids/state-only presence shape.
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      if (!this.stopped) for (const link of this.links.values()) void link.publishPresence().catch(() => undefined);
    }, 100);
    this.presenceTimer.unref?.();
  }
  private current(check: () => boolean): void { if (this.stopped || !check()) refuse("state_changed"); }
  private active(store: RoomStore, name: string): RoomState {
    const state = store.get(name); if (!state || state.left) refuse("unavailable"); return state;
  }
  private async inboxStore(check: () => boolean): Promise<RoomStore | undefined> {
    this.current(check);
    if (!this.store && !this.pending && !existsSync(join(this.options.stateDir, "rooms", "rooms.db"))) return undefined;
    const store = await this.open(); this.current(check); return store;
  }
  async inboxRows(name: unknown, check: () => boolean): Promise<RoomPersonInboxMeta[]> {
    this.current(check); if (name !== undefined) roomName(name);
    const store = await this.inboxStore(check); this.current(check);
    const rows = store?.listPersonInbox(name as string | undefined) ?? []; this.current(check); return rows;
  }
  async inboxShow(id: unknown, check: () => boolean): Promise<RoomPersonInboxItem | undefined> {
    this.current(check);
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) refuse("invalid_input");
    const store = await this.inboxStore(check); this.current(check);
    const item = store?.readPersonInbox(id, () => { this.current(check); return true; }); this.current(check); return item;
  }
  async inboxDispose(id: unknown, action: "done" | "discard", check: () => boolean): Promise<RoomPersonInboxMeta | undefined> {
    this.current(check);
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) refuse("invalid_input");
    const store = await this.inboxStore(check); this.current(check);
    const item = store?.disposePersonInbox(id, action, () => { this.current(check); return true; }); this.current(check);
    this.current(check); return item;
  }
  /** Host calls this after replying to a committed person disposition. */
  retryInboxPending(): void {
    queueMicrotask(() => {
      if (this.stopped) return;
      try {
        this.store?.expirePersonInbox(); // Consume cleanup signals together with this explicit opportunity.
        void this.options.chat?.retryPending().catch(() => undefined);
      } catch { /* A retry failure cannot change an already committed and acknowledged disposition. */ }
    });
  }
  /** Loaded-state housekeeping only, including rooms that have been left. */
  expireInbox(): void {
    if (this.stopped || !this.store?.expirePersonInbox()) return;
    // Only a real local purge creates this opportunity; idle ticks never poll plaintext.
    queueMicrotask(() => { if (!this.stopped) void this.options.chat?.retryPending().catch(() => undefined); });
  }
  async rows(name?: string, details = name !== undefined): Promise<Record<string, unknown>[]> {
    if (!this.store && !existsSync(join(this.options.stateDir, "rooms"))) return [];
    const store = await this.open(); if (name !== undefined) roomName(name);
    return store.list().filter(row => name === undefined || row.name === name).map(row => ({ name: row.name, room: row.current.room, owner: this.owner(row), member: store.identity.public.fingerprint, epoch: row.current.epoch, state: row.left ? "left" : this.links.get(row.name)?.status().state ?? "offline", ...(details && this.options.chat ? { deliveries: this.options.chat.rows(row.name), remotePeers: this.options.chat.peers(row.name) } : {}) }));
  }
  /** Polling uses only already-loaded public metadata; it never opens room state or reads message rows. */
  statusView(): RoomStatusView[] | null {
    if (this.stopped) return null;
    if (!this.store) return this.pending ? null : [];
    try {
      return projectRoomStatus(this.store.statusMetadata().map(row => ({
        name: row.name, room: row.room, owner: row.owner, member: row.member, epoch: row.epoch,
        state: row.left ? "left" : this.links.get(row.name)?.connectionState ?? "offline", members: row.members,
        remotePeers: this.options.chat?.peersForStatus(row.name) ?? null,
        relays: this.options.chat?.metrics(row.name, row.room) ?? null,
      })));
    } catch { return null; }
  }
  async preview(action: unknown, raw: unknown, check: () => boolean): Promise<RoomPreview> {
    if (typeof action !== "string") refuse("invalid_operation");
    await assertRoomCryptoReady(); this.current(check);
    const store = await this.open(); this.current(check);
    const own = store.identity.public.fingerprint;
    const completed = (state: RoomState): RoomCommandResult => { this.link(state.name); return { name: state.name, room: state.current.room, owner: this.owner(state), member: own }; };
    if (action === "create") {
      const row = fields(raw, ["name", "broker"], ["label"]), name = roomName(row.name), broker = audience(row.broker), label = roomName(row.label ?? `hub-${own.slice(0, 8)}`);
      if (store.get(name)) refuse("already_exists");
      return { owner: own, member: own, commit: async () => {
        this.current(check);
        const candidate = await createRoomEpoch({ owner: store.identity, members: [{ ...store.identity.public, label, exposedPeers: [] }] });
        this.current(check);
        const state = await store.install({ name, broker, wire: candidate.wire, expectedDigest: null, current: check });
        return completed(state);
      } };
    }
    if (action === "join" && Object.hasOwn(fields(raw, [], ["token", "name", "label", "roster"]), "token")) {
      const row = fields(raw, ["token"], ["name", "label"]), inviteWire = artifact(row.token, 16384), invite = decodeInvite(inviteWire);
      const name = roomName(row.name ?? `room-${invite.room.slice(0, 8).toLowerCase().replace(/[^a-z0-9-]/g, "a")}`), label = roomName(row.label ?? `hub-${own.slice(0, 8)}`);
      const peers = this.policy.get(name), selection = JSON.stringify({ label, peers }), saved = store.pendingJoin(name);
      if (Date.now() > invite.expiresAt + 600000) refuse("expired");
      if (saved && (encodeBase64url(saved.invite) !== row.token || saved.selection !== selection)) refuse("pending_join_changed");
      return { owner: invite.owner, member: own, commit: async () => {
        this.current(check);
        if (saved) {
          const latest = store.pendingJoin(name);
          if (!latest || encodeBase64url(latest.request) !== encodeBase64url(saved.request)) refuse("state_changed");
          return { name, owner: invite.owner, member: own, kind: "join-request", artifact: encodeBase64url(saved.request) };
        }
        const request = await createJoin({ invite: inviteWire, identity: store.identity, label, exposedPeers: peers });
        this.current(check); store.savePendingJoin(name, { invite: inviteWire, request, selection });
        return { name, owner: invite.owner, member: own, kind: "join-request", artifact: encodeBase64url(request) };
      } };
    }
    if (action === "join") {
      const row = fields(raw, ["name", "roster"]), name = roomName(row.name), wire = artifact(row.roster, 524288), pending = store.pendingJoin(name), existing = store.get(name);
      if (!pending && !existing) refuse("no_pending_invitation");
      const invitation = pending ? decodeInvite(pending.invite) : undefined;
      const owner = existing ? this.owner(existing) : invitation!.owner;
      const broker = existing?.broker ?? invitation!.broker;
      await acceptRoomEpoch({ wire, identity: store.identity, pin: existing
        ? { room: existing.current.room, owner, minEpoch: existing.current.epoch, digest: existing.current.digest }
        : { room: invitation!.room, owner, minEpoch: "0" } });
      this.current(check);
      return { owner, member: own, commit: async () => {
        this.current(check);
        const state = await store.install({ name, broker, wire, expectedDigest: existing?.current.digest ?? null, current: check, reactivate: true });
        return completed(state);
      } };
    }
    if (action === "resolve") {
      const row = fields(raw, ["name", "frame", "action"]), name = roomName(row.name);
      if (typeof row.frame !== "string" || row.frame.length !== 43 || (row.action !== "accept" && row.action !== "discard")) refuse("invalid_resolution");
      try { decodeBase64url(row.frame, 32); } catch { refuse("invalid_resolution"); }
      // Disposition is metadata-only and remains available after leave or sender revocation.
      const state = store.get(name), incoming = store.incomingApplication(name, row.frame);
      if (!state || !incoming || incoming.state !== "needs_review" || !FP.test(incoming.sender)) refuse("resolution_unavailable");
      const frame = row.frame as string, choice = row.action as "accept" | "discard", owner = this.owner(state), member = incoming.sender;
      const binding = JSON.stringify([incoming.digest, incoming.sender, incoming.application, incoming.peer, incoming.state]);
      const current = () => {
        this.current(check);
        const latest = store.incomingApplication(name, frame);
        return !!latest && JSON.stringify([latest.digest, latest.sender, latest.application, latest.peer, latest.state]) === binding;
      };
      return { owner, member, commit: async () => {
        if (!current()) refuse("state_changed");
        store.disposeIncoming(name, frame, choice, current);
        await this.options.chat?.retryPending();
        return { name, room: state.current.room, owner, member, kind: "disposed" };
      } };
    }
    const row = fields(raw, ["name"], action === "invite" ? ["request"] : action === "revoke" ? ["member"] : action === "expose" ? ["peers"] : []);
    const name = roomName(row.name);
    const pending = action === "leave" && !store.get(name) ? store.pendingJoin(name) : undefined;
    if (pending) return { owner: decodeInvite(pending.invite).owner, member: own, commit: async () => {
      this.current(check);
      const latest = store.pendingJoin(name);
      if (!latest || encodeBase64url(latest.invite) !== encodeBase64url(pending.invite) || encodeBase64url(latest.request) !== encodeBase64url(pending.request)) refuse("state_changed");
      store.cancelPendingJoin(name); return { name, owner: decodeInvite(pending.invite).owner, member: own };
    } };
    const state = this.active(store, name), owner = this.owner(state), digest = state.current.digest;
    if (action === "leave") return { owner, member: own, commit: async () => {
      this.current(check); if (store.get(name)?.current.digest !== digest) refuse("state_changed");
      store.leave(name); this.links.get(name)?.stop(); this.links.delete(name); return { name, room: state.current.room, owner, member: own };
    } };
    if (action === "invite") {
      if (owner !== own) refuse("owner_only");
      if (row.request === undefined) return { owner, member: own, commit: async () => {
        this.current(check);
        const wire = await createInvite({ owner: store.identity, epoch: state.current, broker: state.broker, expiresAt: Date.now() + 15 * 60_000 });
        this.current(check); if (store.get(name)?.current.digest !== digest) refuse("state_changed");
        await store.saveInvite(name, wire, check);
        return { name, owner, member: own, kind: "invitation", artifact: encodeBase64url(wire) };
      } };
      const request = artifact(row.request, 16384), exposure = exposureRequest(request);
      const member = exposure?.member ?? decodeJoin(request).member.fingerprint;
      if (exposure) {
        const { signature, ...body } = exposure;
        const sender = roomMembers(state.current).find(m => m.fingerprint === member);
        if (!sender || exposure.room !== state.current.room || exposure.owner !== owner || exposure.digest !== digest || !await verifyBytes({ fingerprint: sender.fingerprint, signingKey: sender.signingKey, agreementKey: sender.agreementKey }, exposureBytes(body), decodeBase64url(signature, 64))) refuse("untrusted");
      }
      this.current(check);
      return { owner, member, commit: async () => {
        this.current(check);
        const next = exposure ? await store.rotate(name, roomMembers(state.current).map(m => m.fingerprint === member ? { ...m, exposedPeers: exposedPeers(exposure.peers) } : m), digest, check) : await store.enroll(name, request, check);
        this.current(check); completed(next);
        return { name, owner, member, kind: "roster", artifact: encodeBase64url(next.wire) };
      } };
    }
    if (action === "revoke") {
      if (owner !== own) refuse("owner_only");
      if (typeof row.member !== "string" || !FP.test(row.member) || row.member === own || !roomMembers(state.current).some(m => m.fingerprint === row.member)) refuse("invalid_member");
      return { owner, member: row.member, commit: async () => {
        this.current(check); const next = await store.rotate(name, roomMembers(state.current).filter(m => m.fingerprint !== row.member), digest, check); return completed(next);
      } };
    }
    if (action === "expose") {
      const peers = exposedPeers(row.peers ?? []);
      this.policy.assertWritable(name, peers, check);
      return { owner, member: own, commit: async () => {
        this.current(check); this.policy.assertWritable(name, peers, check);
        if (store.get(name)?.current.digest !== digest) refuse("state_changed");
        if (owner === own) {
          const next = await store.rotate(name, roomMembers(state.current).map(m => m.fingerprint === own ? { ...m, exposedPeers: peers } : m), digest, check);
          this.current(check); this.policy.set(name, peers, check); return completed(next);
        }
        const body: Omit<ExposureRequest, "signature"> = { v: 1, type: "exposure", room: state.current.room, owner, member: own, digest, peers };
        const request = canonicalBytes({ ...body, signature: encodeBase64url(await signBytes(store.identity, exposureBytes(body))) });
        this.current(check); if (store.get(name)?.current.digest !== digest) refuse("state_changed");
        this.policy.set(name, peers, check); this.changed();
        return { name, owner, member: own, kind: "exposure-request", artifact: encodeBase64url(request) };
      } };
    }
    return refuse("invalid_operation");
  }
  private owner(state: RoomState): string {
    // The installed, verified signed roster is the authority; never infer owner from array order.
    return decodeRoster(state.wire).owner;
  }
}
