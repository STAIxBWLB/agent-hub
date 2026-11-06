/** Outbound room transport. The local bus and application delivery boundary belong to X4. */
import { BROKER_CODEC_FEATURES_OPT_IN, createBrokerAuth, decodeBrokerChallenge, encodeBrokerControl } from "../broker/protocol.ts";
import { assertRoomCryptoReady, encodeBase64url, sha256, RoomCryptoError } from "./crypto.ts";
import { brokerUrl, canonicalBytes, decodeFrame, decodeRoster, openFrame, roomMembers, sealFrame, verifyPublicRoster, RoomWireError, type FrameWire, type FrameOpenResult, type VerifiedPublicRoster } from "./wire.ts";
import type { RoomRefusalReason, RoomState, RoomStore } from "./store.ts";
import { RoomUnmatchedReceiptError, RoomFreshChatCapacityError, RoomStoreError, type RoomOutgoingInput } from "./store.ts";
import { ROOM_STOP_TIMEOUT_MS, roomRefreshPeriod } from "./liveness.ts";
import { roomHealthCause, roomHealthNextStep, type RoomHealthCause } from "./health.ts";
import { ROOM_CODEC_FEATURES, roomCodecFeatures, roomRequiredCodecFeature, decodeRoomMessage, encodeRoomMessage, type RoomCodecFeature, type RoomMessage } from "./application.ts";

export type RoomLinkState = "offline" | "connecting" | "online";
export type RoomPresenceState = "idle" | "busy" | "paused" | "offline";
export interface RoomPresencePeer { id: string; state: RoomPresenceState }
export interface RoomLinkOptions {
  store: RoomStore;
  name: string;
  presence?: () => readonly { id: string; state: string }[];
  onPresence?: (value: { member: string; peers: readonly RoomPresencePeer[]; restored?: true }) => void;
  onState?: (state: RoomLinkState) => void;
  application?: RoomLinkApplication;
  refreshMs?: number;
  now?: () => number;
}
/** Host-bound application ports; broker/config data never selects callbacks. */
export interface RoomLinkContext {
  store: RoomStore; name: string; link: RoomLink; current: () => boolean;
}
export interface RoomLinkApplication {
  members(context: RoomLinkContext): void;
  receive(context: RoomLinkContext, input: { digest: string; sender: string; message?: RoomMessage }): Promise<void>;
  online(context: RoomLinkContext): Promise<void>;
  stored(context: RoomLinkContext, input: { digest: string; seq: string }): void;
  /** Fixed transport metadata only; never application completion or authority. */
  transportAck?(context: RoomLinkContext, input: { digest: string }): void;
  receiptTtlMs?(context: RoomLinkContext): number;
  capacityChanged?(context: RoomLinkContext): void;
  codecsChanged?(context: RoomLinkContext, input: { member: string }): void;
}
/** Host port signal: no application claim/effect occurred; the durable plaintext remains pending. */
export class RoomApplicationDeferredError extends Error {
  constructor(readonly code: "capacity" | "journal_unavailable" | "admission_limit") { super(`Room application deferred: ${code}`); this.name = "RoomApplicationDeferredError"; }
}
export class RoomLinkError extends Error {
  constructor(readonly code: "unavailable" | "invalid_wire" | "state_changed" | "untrusted" | "limit") {
    super(`Room link: ${code}`); this.name = "RoomLinkError";
  }
}
/** Only before durable application enqueue: the Bus may retain its original queue item. */
export class RoomCodecUnsupportedError extends Error {
  readonly code = "codec_unsupported";
  constructor(readonly feature: RoomCodecFeature) {
    super(`Room send refused: recipient codec support for ${feature} is unavailable; upgrade both hubs and the broker, reconnect the room, then retry.`);
    this.name = "RoomCodecUnsupportedError";
  }
}
export class RoomNotSentError extends Error {
  readonly code = "not_sent";
  constructor() { super("room application was not queued; retry when the link is ready"); this.name = "RoomNotSentError"; }
}
/** No compatibility observation exists yet; retain work under its original queue deadline. */
export class RoomCodecPendingError extends RoomNotSentError {
  constructor(readonly changed: () => boolean) {
    super(); this.name = "RoomCodecPendingError";
    this.message = "Room codec observation is pending; wait for a signed codec advertisement, then retry.";
  }
}
export type RoomCodecState = "pending" | "supported" | "unsupported";
const RECEIPT_TTL_MS = 24 * 3_600_000;
const LIMITS = Object.freeze({ packets: 8, queuedBytes: 2_097_152, packetBytes: 1_048_576, backpressure: 1_048_576, handshakeMs: 30_000, reconnectMaxMs: 300_000 });
const decoder = new TextDecoder("utf-8", { fatal: true });
const PEER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const STATES: readonly string[] = ["idle", "busy", "paused", "offline"];
interface PendingFrame { wire: Uint8Array; digest: string; presence: boolean; requestReply: boolean; current: () => boolean; retained?: () => boolean; onSent?: () => void; afterInboundAck?: string; codecFeatures?: boolean; supported?: () => boolean; codecPending?: () => boolean; codecTarget?: { member: string; feature: RoomCodecFeature } }
interface Session {
  closingHead?: PendingFrame;
  refresh?: ReturnType<typeof setTimeout>;
  refreshedAt?: number;
  processingFrame?: string;
  acknowledgedFrame?: string;
  pendingPresenceReplies: Set<string>;
  presenceAsked: boolean;
  presenceRoster?: string;
  outbound: PendingFrame[];
  outboundBytes: number;
  frameSent: boolean;
  retryAttempt: number;
  frameRetry?: ReturnType<typeof setTimeout>;
  lastPresence?: string;
  ephemeral?: boolean;
  codecFeatures?: boolean;
  codecSession?: string;
  codecPeers?: Map<string, { session: string | null; supported: boolean }>;
  features?: Map<string, { session: string; features: readonly string[] }>;
  ws: WebSocket;
  generation: number;
  room: string;
  broker: string;
  phase: "challenge" | "roster" | "ready";
  queue: Uint8Array[];
  queuedBytes: number;
  processing: boolean;
  challengeDigest?: string | null;
  initialRoster: boolean;
  roster?: VerifiedPublicRoster;
  handshake: ReturnType<typeof setTimeout>;
  requestPresenceReply: boolean;
  ownerUpgrading?: boolean;
  deferredFrame?: Uint8Array;
}
function fail(code: ConstructorParameters<typeof RoomLinkError>[0] = "invalid_wire"): never { throw new RoomLinkError(code); }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) fail();
  return row;
}
function packet(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const encoded = canonicalBytes(value);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) fail();
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.type !== "string") fail();
  return row;
}
function presence(bytes: Uint8Array, exposed: readonly string[]): RoomPresencePeer[] {
  const decoded = packet(bytes), row = exact(decoded, ["v", "type", "peers", ...(Object.hasOwn(decoded, "requestReply") ? ["requestReply"] : []), ...(Object.hasOwn(decoded, "features") ? ["features", "codecSession"] : [])]);
  if (Object.hasOwn(row, "features")) { roomCodecFeatures(row.features); if (typeof row.codecSession !== "string" || !DIGEST.test(row.codecSession)) fail(); }
  if (row.requestReply !== undefined && typeof row.requestReply !== "boolean") fail();
  if (row.type !== "presence" || !Array.isArray(row.peers) || row.peers.length > 64) fail();
  const peers = row.peers.map(value => {
    const peer = exact(value, ["id", "state"]);
    if (typeof peer.id !== "string" || !PEER_ID.test(peer.id) || !exposed.includes(peer.id) || typeof peer.state !== "string" || !STATES.includes(peer.state)) fail("untrusted");
    return { id: peer.id, state: peer.state as RoomPresenceState };
  });
  if (peers.some((peer, index) => index > 0 && peers[index - 1]!.id >= peer.id)) fail();
  return peers;
}

/** One bounded, generation-fenced outbound connection. No callback receives body text or task data. */
export class RoomLink {
  private running = false;
  private stopping = false;
  private stopWork?: Promise<void>;
  private stoppedFrame?: { digest: string; resolve: () => void };
  private readonly refreshMs: number;
  private readonly applicationPauses = new Set<symbol>();
  private generation = 0;
  private session?: Session;
  private reconnect?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private state: RoomLinkState = "offline";
  private cause?: RoomHealthCause;
  private blockedCodec?: { member: string; feature: RoomCodecFeature };
  private clockHighWater?: number;
  private publishing = false;
  private publishDirty = false;
  private replyPresence = false;
  private inboxRetry?: Promise<void>;
  private inboxRetryDirty = false;
  private retiredPresenceBytes = 0;
  private forcePresenceRequest = false;
  private republish?: ReturnType<typeof setTimeout>;
  private sendTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: RoomLinkOptions) { this.refreshMs = roomRefreshPeriod(options.refreshMs); }

  /** Advisory transport state without copying or decoding a room epoch for a status poll. */
  get connectionState(): RoomLinkState { return this.state; }
  get connectionCause(): RoomHealthCause | undefined { return this.cause; }
  /** Negotiated transport evidence only; unknown until this session is ready. */
  codecState(recipient: string, feature: RoomCodecFeature): RoomCodecState {
    const session = this.session;
    if (!session || session.phase !== "ready") return "pending";
    if (session.codecFeatures !== true) return "unsupported";
    const peer = session.codecPeers?.get(recipient);
    if (!peer || peer.session === null) return "pending";
    if (!peer.supported) return "unsupported";
    const advertised = session.features?.get(recipient);
    if (!advertised || advertised.session !== peer.session) return "pending";
    return advertised.features.includes(feature) ? "supported" : "unsupported";
  }
  codecSupported(recipient: string, feature: RoomCodecFeature): boolean { return this.codecState(recipient, feature) === "supported"; }
  private codecRefusal(recipient: string, feature: RoomCodecFeature): RoomNotSentError | RoomCodecUnsupportedError {
    if (this.codecState(recipient, feature) === "unsupported") return new RoomCodecUnsupportedError(feature);
    const session = this.session, peer = session?.codecPeers?.get(recipient), advertisement = session?.features?.get(recipient);
    return new RoomCodecPendingError(() => this.session !== session || session?.codecPeers?.get(recipient) !== peer
      || session?.features?.get(recipient) !== advertisement || this.codecState(recipient, feature) !== "pending");
  }
  get livenessTracked(): boolean | undefined { return this.session?.phase === "ready" ? this.session.ephemeral : undefined; }
  status(): { state: RoomLinkState; members: number; cause?: RoomHealthCause; nextStep?: string } {
    try {
      const row = this.options.store.get(this.options.name);
      return { state: this.state, members: row && !row.left ? roomMembers(row.current).length : 0,
        ...(this.cause ? { cause: this.cause, nextStep: roomHealthNextStep(this.cause) } : {}) };
    } catch (error) { const cause = roomHealthCause(error); return { state: "offline", members: 0, cause, nextStep: roomHealthNextStep(cause) }; }
  }
  async start(): Promise<void> {
    if (this.running || this.stopping) return;
    this.stopWork = undefined;
    this.running = true;
    const generation = ++this.generation;
    try { await assertRoomCryptoReady(); } catch { this.running = false; throw new RoomLinkError("unavailable"); }
    if (!this.running || generation !== this.generation) return;
    this.connect();
  }
  stop(): Promise<void> {
    if (this.stopWork) return this.stopWork;
    this.running = false; this.stopping = true;
    const session = this.session;
    if (session && (session.frameSent || session.frameRetry)) session.closingHead = session.outbound[0];
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    if (this.republish) clearTimeout(this.republish);
    this.republish = undefined;
    if (session?.refresh) clearTimeout(session.refresh);
    if (session) {
      // A storage control may already be waiting behind a slow application turn.
      // Consume only those controls before sealing the final FIFO observation.
      const queued = session.queue.splice(0); session.queuedBytes = 0;
      for (const bytes of queued) this.receive(session, Uint8Array.from(bytes).buffer);
    }
    this.setState("offline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, ROOM_STOP_TIMEOUT_MS); });
    // Storage controls are consumed directly during shutdown, outside the serial
    // receive lane which may still be awaiting application work being fenced.
    const final = session?.phase === "ready" ? this.finalPresence(session).catch(() => undefined) : Promise.resolve();
    this.stopWork = Promise.race([final, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      this.disconnect(session); this.stoppedFrame?.resolve(); this.stoppedFrame = undefined; this.stopping = false;
    });
    return this.stopWork;
  }
  private async finalPresence(session: Session): Promise<void> {
    await this.serialSend(async () => {
      const row = this.current(session, undefined, true), identity = this.options.store.identity;
      if (session.phase !== "ready" || session.roster?.digest !== row.current.digest) return;
      const own = roomMembers(row.current).find(member => member.fingerprint === identity.public.fingerprint);
      if (!own) fail("untrusted");
      const recipients = roomMembers(row.current).map(member => member.fingerprint).filter(member => member !== identity.public.fingerprint).sort();
      if (!recipients.length) return;
      const peers = this.currentPresence(own.exposedPeers).map(peer => ({ ...peer, state: "offline" as const }));
      const wire = await sealFrame({ epoch: row.current, identity, recipients, plaintext: canonicalBytes({ v: 1, type: "presence", peers }), ...(session.ephemeral ? { ephemeral: true as const } : {}), sequence: this.options.store.sequence });
      this.current(session, row.current.digest, true);
      const digest = await this.frameDigest(wire);
      this.current(session, row.current.digest, true);
      // Unattempted RAM work can be withdrawn; durable application/receipt rows
      // remain owned by the Store. An attempted head keeps its exact FIFO place.
      const attempted = session.closingHead;
      session.outbound = attempted ? [attempted] : [];
      session.outboundBytes = attempted?.wire.byteLength ?? 0;
      const stored = new Promise<void>(resolve => { this.stoppedFrame = { digest, resolve }; });
      this.queueFrame(session, wire, digest, false,
        () => { try { this.current(session, row.current.digest, true); return peers.every(peer => this.currentPresence(own.exposedPeers).some(value => value.id === peer.id)); } catch { return false; } }, true);
      return stored;
    });
  }
  refresh(): void {
    if (this.stopping) return;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.disconnect();
    if (this.running) this.connect();
  }
  private armPresenceRefresh(session: Session): void {
    if (session.refresh) clearTimeout(session.refresh);
    // Legacy brokers retain state-change/dedupe publication without periodic traffic.
    if (!session.ephemeral || !this.running || this.stopping) return;
    session.refreshedAt = this.observationTime();
    session.refresh = setTimeout(() => {
      session.refresh = undefined;
      if (this.session !== session || !this.running || this.stopping || session.phase !== "ready") return;
      const now = this.observationTime();
      if (now !== undefined && session.refreshedAt !== undefined && now - session.refreshedAt >= this.refreshMs) {
        session.pendingPresenceReplies.clear(); session.presenceAsked = false;
        session.requestPresenceReply = true; this.forcePresenceRequest = true;
        void this.publishPresence().catch(() => this.retry(session));
      }
      this.armPresenceRefresh(session);
    }, this.refreshMs);
    session.refresh.unref?.();
  }
  private observationTime(): number | undefined {
    let now: number;
    try { now = (this.options.now ?? Date.now)(); } catch { this.setState(this.state, "unavailable"); return undefined; }
    if (!Number.isSafeInteger(now) || now < 0) { this.setState(this.state, "unavailable"); return undefined; }
    if (this.clockHighWater !== undefined && now < this.clockHighWater) { this.setState(this.state, "clock_rollback"); return undefined; }
    this.clockHighWater = now;
    return now;
  }
  /** Called only after the Store-backed sequence port committed a reservation. */
  private clockRecoveredAfterWrite(): void {
    if (this.cause === "clock_rollback" && this.observationTime() !== undefined) this.setState(this.state);
  }
  private refreshCodecCause(member: string): void {
    const blocked = this.blockedCodec;
    if (!blocked || blocked.member !== member) return;
    const compatibility = this.codecState(member, blocked.feature);
    if (compatibility === "supported") this.setState(this.state);
    else this.setState(this.state, compatibility === "pending" ? "codec_pending" : "codec_unsupported");
  }
  private setState(state: RoomLinkState, cause?: RoomHealthCause): void {
    if (cause !== "codec_pending" && cause !== "codec_unsupported") this.blockedCodec = undefined;
    if (this.state === state && this.cause === cause) return;
    this.state = state; this.cause = cause;
    try { this.options.onState?.(state); } catch { /* observation never changes transport authority */ }
  }
  private current(session: Session, digest?: string, final = false): RoomState {
    if ((!this.running && !(final && this.stopping)) || this.session !== session || session.generation !== this.generation || session.ws.readyState !== WebSocket.OPEN) fail("state_changed");
    let row: RoomState | undefined;
    try { row = this.options.store.get(this.options.name); } catch (error) { this.setState(this.state, roomHealthCause(error)); fail("unavailable"); }
    if (!row || row.left || row.current.room !== session.room || row.broker !== session.broker || (digest !== undefined && row.current.digest !== digest)) fail("state_changed");
    return row;
  }
  private isCurrent(session: Session, digest: string): boolean {
    try { if (this.stopping) return false; this.current(session, digest); return true; } catch { return false; }
  }
  private publicationCurrent(session: Session, digest: string): boolean {
    return session.phase === "ready" && session.roster?.digest === digest && this.isCurrent(session, digest);
  }
  /** A dropped ephemeral observation requests one fresh signed state when its space is available. */
  async refreshPresenceIfCapacityFree(): Promise<void> {
    const session = this.session, bytes = this.retiredPresenceBytes;
    if (!bytes || !session || !this.running) return;
    const row = this.current(session);
    if (!this.publicationCurrent(session, row.current.digest) || !this.options.store.ordinaryInboxAvailable(this.options.name, bytes)) return;
    // Intent survives coalescing, ordinary responses and publication failure.
    // Only an actually sent request with current capacity may clear the numeric flag.
    if (!this.forcePresenceRequest) { session.pendingPresenceReplies.clear(); session.presenceAsked = false; }
    session.requestPresenceReply = true; this.forcePresenceRequest = true;
    try { await this.publishPresence(); }
    catch (error) { this.retry(session); throw error; }
  }
  private capacityChanged(session: Session, digest: string): void {
    try { this.options.application?.capacityChanged?.(this.context(session, digest)); } catch { /* advisory metadata refresh grants nothing */ }
  }
  private context(session: Session, digest: string): RoomLinkContext {
    return { store: this.options.store, name: this.options.name, link: this, current: () => this.isCurrent(session, digest) };
  }
  private async restorePresence(session: Session): Promise<void> {
    const row = this.current(session), members = roomMembers(row.current);
    for (const entry of this.options.store.pendingInbox(this.options.name)) {
      this.current(session, row.current.digest);
      const member = members.find(value => value.fingerprint === entry.sender);
      if (!member) {
        const application = this.options.store.incomingApplication(this.options.name, entry.digest);
        if (application?.state === "pending" || application?.state === "dispatching") this.options.store.quarantineApplication(this.options.name, entry.digest);
      }
      if (member) {
        let application: RoomMessage | undefined;
        try { application = decodeRoomMessage(entry.plaintext); } catch { /* X3 presence has its own strict codec. */ }
        if (application && this.options.application) {
          await this.deliverApplication(session, row.current.digest, { digest: entry.digest, sender: entry.sender, message: application });
          this.current(session, row.current.digest);
          continue;
        }
        let peers: RoomPresencePeer[] | undefined;
        try { peers = presence(entry.plaintext, member.exposedPeers); } catch { /* a rotation may have removed an exposed id since the durable receive */ }
        if (peers) { try { this.options.onPresence?.({ member: entry.sender, peers, restored: true }); } catch { /* observation only */ } }
      }
      // Presence is ephemeral: stale exposure/member metadata is discarded, never
      // replayed after a rotation or left at the head of recovery forever.
      this.current(session, row.current.digest);
      this.options.store.settleInbox(this.options.name, entry.digest);
      this.capacityChanged(session, row.current.digest);
    }
  }
  private async deliverApplication(session: Session, digest: string, input: Parameters<RoomLinkApplication["receive"]>[1]): Promise<void> {
    if (!this.running || this.stopping) fail("state_changed");
    try { await this.options.application?.receive(this.context(session, digest), input); }
    catch (error) { if (!(error instanceof RoomApplicationDeferredError)) throw error; }
    this.current(session, digest);
  }
  /** One bounded pass; repeated external disposition/online notifications coalesce, never poll. */
  retryPendingApplications(): Promise<void> {
    const session = this.session;
    if (!session || session.phase !== "ready" || !this.running) return Promise.resolve();
    if (this.inboxRetry) { this.inboxRetryDirty = true; return this.inboxRetry; }
    const work = Promise.resolve().then(async () => { await this.restorePresence(session); await this.refreshPresenceIfCapacityFree(); });
    this.inboxRetry = work;
    void work.finally(() => {
      if (this.inboxRetry !== work) return;
      this.inboxRetry = undefined;
      const again = this.inboxRetryDirty; this.inboxRetryDirty = false;
      if (again && this.session === session && this.running) void this.retryPendingApplications().catch(() => undefined);
    }).catch(() => undefined);
    return work;
  }
  private disconnect(session = this.session, cause?: RoomHealthCause): void {
    if (session && session !== this.session) return;
    this.generation++;
    this.session = undefined;
    this.publishDirty = false; this.replyPresence = false; this.forcePresenceRequest = false; this.inboxRetryDirty = false;
    this.inboxRetry = undefined; // A new ready session must never await an old generation's restore pass.
    if (this.republish) clearTimeout(this.republish);
    this.republish = undefined;
    if (session) {
      clearTimeout(session.handshake);
      if (session.refresh) clearTimeout(session.refresh);
      if (session.frameRetry) clearTimeout(session.frameRetry);
      session.outbound.length = 0; session.outboundBytes = 0; session.pendingPresenceReplies.clear();
      session.queue.length = 0; session.queuedBytes = 0; session.deferredFrame = undefined;
      try { session.ws.close(1000, "disconnected"); } catch { /* already closed */ }
    }
    this.setState("offline", cause);
  }
  private retry(session?: Session, error?: unknown): void {
    if (this.stopping) return;
    if (session && this.session !== session) return;
    let cause: RoomHealthCause = "transport_closed";
    if (error instanceof RoomStoreError) cause = roomHealthCause(error);
    else if (this.cause === "broker_refused" || this.cause === "clock_rollback") cause = this.cause;
    else if (error instanceof RoomLinkError) {
      if (error.code === "limit") cause = "backpressure";
      else if (error.code === "invalid_wire") cause = "untrusted";
      else cause = error.code;
    } else if (this.cause === "backpressure") cause = this.cause;
    this.disconnect(session, cause);
    if (!this.running || this.reconnect) return;
    const ceiling = Math.min(LIMITS.reconnectMaxMs, 1000 * 2 ** Math.min(this.attempts++, 9));
    const delay = Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
    this.reconnect = setTimeout(() => { this.reconnect = undefined; if (this.running) this.connect(); }, delay);
    this.reconnect.unref?.();
  }
  private connect(): void {
    if (!this.running || this.session) return;
    let row: RoomState | undefined;
    try { row = this.options.store.get(this.options.name); } catch (error) { this.retry(undefined, error); return; }
    if (!row || row.left) { this.setState("offline"); return; }
    let url: URL;
    try {
      url = new URL(brokerUrl(row.broker));
      if (url.pathname !== "/" || url.search) fail("untrusted");
    } catch { this.setState("offline", "untrusted"); return; }
    url.pathname = `/v1/rooms/${row.current.room}`;
    let ws: WebSocket;
    // Preserve the released ephemeral header exactly; old brokers ignore the additional codec token.
    try { ws = new WebSocket(url.href, { headers: { "x-agent-hub-ephemeral": "1", "x-agent-hub-codecs": BROKER_CODEC_FEATURES_OPT_IN } }); } catch { this.retry(); return; }
    ws.binaryType = "arraybuffer";
    const generation = ++this.generation;
    const session: Session = { ws, generation, room: row.current.room, broker: row.broker, phase: "challenge", pendingPresenceReplies: new Set(), presenceAsked: false, outbound: [], outboundBytes: 0, frameSent: false, retryAttempt: 0, queue: [], queuedBytes: 0, processing: false, initialRoster: true, requestPresenceReply: true,
      handshake: setTimeout(() => this.retry(session), LIMITS.handshakeMs) };
    session.handshake.unref?.();
    this.session = session;
    this.setState("connecting", "connecting");
    ws.addEventListener("message", event => this.receive(session, event.data));
    ws.addEventListener("close", () => this.retry(session));
    ws.addEventListener("error", () => this.retry(session));
  }
  private send(session: Session, bytes: Uint8Array): void {
    this.current(session, undefined, this.stopping);
    if (bytes.length > LIMITS.packetBytes || session.ws.bufferedAmount > LIMITS.backpressure) fail("limit");
    session.ws.send(bytes);
  }
  private queueFrame(session: Session, wire: Uint8Array, digest: string, requestReply = false, current: () => boolean = () => true, presence = false, retained?: () => boolean, onSent?: () => void, afterInboundAck?: string, codecFeatures = false, supported?: () => boolean, codecPending?: () => boolean, codecTarget?: { member: string; feature: RoomCodecFeature }): void {
    this.current(session, undefined, this.stopping);
    // Only an unsent observation may be replaced. Never reorder an attempted frame.
    if (presence) {
      const at = session.outbound.findIndex((frame, index) => frame !== session.closingHead && frame.presence && !!frame.codecFeatures === codecFeatures && (!frame.requestReply || requestReply) && (index > 0 || !session.frameSent && !session.frameRetry));
      if (at >= 0) session.outboundBytes -= session.outbound.splice(at, 1)[0]!.wire.byteLength;
    }
    if (session.outbound.length >= LIMITS.packets || session.outboundBytes + wire.byteLength > LIMITS.queuedBytes) fail("limit");
    session.outbound.push({ wire, digest, presence, requestReply, current, retained, onSent, afterInboundAck, codecFeatures, supported, codecPending, codecTarget }); session.outboundBytes += wire.byteLength;
    this.pumpFrames(session);
  }
  private pumpFrames(session: Session): void {
    if (session.frameSent || session.frameRetry || !session.outbound.length) return;
    this.current(session, undefined, this.stopping);
    const frame = session.outbound[0]!;
    // An expired backoff timer is not proof that a pre-stop attempt was stored.
    if (this.stopping && frame === session.closingHead) return;
    if (frame.retained && !frame.retained()) {
      // Disposed/expired intent cannot survive in the transport's RAM queue.
      session.outbound.shift(); session.outboundBytes -= frame.wire.byteLength; session.retryAttempt = 0;
      this.pumpFrames(session); return;
    }
    if (!frame.current()) {
      if (!frame.presence) fail("state_changed");
      session.outbound.shift(); session.outboundBytes -= frame.wire.byteLength; session.lastPresence = undefined;
      this.pumpFrames(session);
      void this.publishPresence().catch(() => this.retry(session));
      return;
    }
    if (frame.supported && !frame.supported()) {
      this.blockedCodec = frame.codecTarget;
      this.setState(this.state, frame.codecPending?.() ? "codec_pending" : "codec_unsupported");
      if (frame.retained) {
        // The durable intent owns retry. Withdraw only this unsent ciphertext so
        // later receipts can progress; a fresh codec observation reseals its retry.
        session.outbound.shift(); session.outboundBytes -= frame.wire.byteLength; session.retryAttempt = 0;
        this.pumpFrames(session);
      }
      return;
    }
    // A foreground receipt follows the chat ACK on the socket. Otherwise broker
    // verification/storage of the receipt can pin the chat's one-packet slot.
    if (frame.afterInboundAck && session.processingFrame === frame.afterInboundAck && session.acknowledgedFrame !== frame.afterInboundAck) return;
    this.send(session, frame.wire); session.frameSent = true;
    if (frame.codecTarget) this.refreshCodecCause(frame.codecTarget.member);
    const onSent = frame.onSent; frame.onSent = undefined; onSent?.();
  }
  private storedFrame(session: Session, digest: string): void {
    if (session.outbound[0]?.digest !== digest) return;
    const frame = session.outbound.shift()!; session.outboundBytes -= frame.wire.byteLength;
    if (session.closingHead === frame) session.closingHead = undefined;
    session.frameSent = false; session.retryAttempt = 0;
    if (session.frameRetry) clearTimeout(session.frameRetry);
    session.frameRetry = undefined;
    if (this.cause === "backpressure") this.setState(this.state);
    if (this.stoppedFrame?.digest === digest) this.stoppedFrame.resolve();
    this.pumpFrames(session);
  }
  private backoffFrame(session: Session, digest: string): void {
    if (session.outbound[0]?.digest !== digest || session.frameRetry) return;
    session.frameSent = false;
    this.setState(this.state, "backpressure");
    const delay = Math.min(30_000, 250 * 2 ** Math.min(session.retryAttempt++, 7));
    session.frameRetry = setTimeout(() => {
      session.frameRetry = undefined;
      if (this.session !== session || !this.running || session.phase !== "ready") return;
      try { this.pumpFrames(session); } catch { this.retry(session); }
    }, delay);
    session.frameRetry.unref?.();
    this.pumpFrames(session);
  }
  private receive(session: Session, data: unknown): void {
    if (this.stopping && this.session === session) {
      if (!(data instanceof ArrayBuffer) || data.byteLength > LIMITS.packetBytes) return;
      try {
        const row = exact(packet(new Uint8Array(data)), ["v", "type", "digest", "seq", "duplicate"]);
        if (row.type === "stored" && typeof row.digest === "string" && DIGEST.test(row.digest)
          && typeof row.seq === "string" && /^[1-9][0-9]{0,19}$/.test(row.seq) && typeof row.duplicate === "boolean") {
          this.current(session, undefined, true);
          if (this.options.store.receiptSendable(this.options.name, row.digest)) {
            this.options.store.markStored(this.options.name, row.digest, row.seq);
            this.options.store.retireStoredReceipt(this.options.name, row.digest);
          }
          this.storedFrame(session, row.digest);
        }
      } catch { /* Invalid controls cannot complete graceful shutdown. */ }
      return;
    }
    if (this.session !== session || !this.running) return;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > LIMITS.packetBytes || session.queue.length + (session.deferredFrame ? 1 : 0) >= LIMITS.packets || session.queuedBytes + (session.deferredFrame?.byteLength ?? 0) + data.byteLength > LIMITS.queuedBytes) { this.retry(session); return; }
    const bytes = new Uint8Array(data).slice();
    session.queue.push(bytes); session.queuedBytes += bytes.length;
    this.drain(session);
  }
  private drain(session: Session): void {
    if (session.processing || this.session !== session || !session.queue.length) return;
    const bytes = session.queue.shift()!; session.queuedBytes -= bytes.length;
    session.processing = true;
    void this.handle(session, bytes).catch(error => this.retry(session, error)).finally(() => {
      session.processing = false;
      this.drain(session);
    });
  }
  private async handle(session: Session, bytes: Uint8Array): Promise<void> {
    const local = this.current(session), message = packet(bytes);
    if (session.phase === "challenge") {
      const challenge = decodeBrokerChallenge(bytes);
      // The broker enforces its own signed challenge deadline. Our local timer
      // bounds this exchange without comparing clocks across hosts (D5).
      session.phase = "roster"; session.challengeDigest = challenge.rosterDigest;
      const owner = decodeRoster(local.wire).owner;
      if (challenge.rosterDigest === null && owner !== this.options.store.identity.public.fingerprint) fail("untrusted");
      const auth = await createBrokerAuth({ challenge, identity: this.options.store.identity, broker: local.broker, room: local.current.room, ...(challenge.rosterDigest === null ? { initialRoster: local.wire } : {}) });
      this.current(session, local.current.digest);
      this.send(session, auth); return;
    }
    if (message.type === "roster") {
      const roster = decodeRoster(bytes), owner = decodeRoster(local.wire).owner;
      const behind = BigInt(roster.epoch) < BigInt(local.current.epoch);
      // An owner may need to publish a locally committed rotation after a disconnect.
      // Verify the old broker roster without ever replacing the local installed pin.
      const proof = await verifyPublicRoster({ wire: bytes, pin: { room: local.current.room, owner, minEpoch: behind ? "0" : local.current.epoch, ...(!behind ? { digest: local.current.digest } : {}) } });
      this.current(session, local.current.digest);
      if (session.initialRoster && proof.digest !== session.challengeDigest && session.challengeDigest !== null) fail("untrusted");
      if (behind) {
        const own = proof.members.find(member => member.fingerprint === this.options.store.identity.public.fingerprint);
        if (owner !== this.options.store.identity.public.fingerprint || !own || own.signingKey !== this.options.store.identity.public.signingKey || own.agreementKey !== this.options.store.identity.public.agreementKey) fail("untrusted");
      } else {
        const installed = await this.options.store.install({ name: this.options.name, broker: local.broker, wire: bytes, expectedDigest: local.current.digest, current: () => this.isCurrent(session, local.current.digest) });
        this.current(session, installed.current.digest);
        this.options.application?.members(this.context(session, installed.current.digest));
      }
      session.initialRoster = false; session.roster = proof;
      session.phase = "roster";
      this.send(session, encodeBrokerControl({ v: 1, type: "roster_ready", digest: proof.digest }));
      return;
    }
    if (message.type === "ready") {
      const ready = exact(message, ["v", "type", "room", "member", "epoch", "digest", ...(Object.hasOwn(message, "ephemeral") ? ["ephemeral"] : []), ...(Object.hasOwn(message, "codecFeatures") ? ["codecFeatures", "codecSession"] : [])]), roster = session.roster;
      if (ready.ephemeral !== undefined && ready.ephemeral !== true || ready.codecFeatures !== undefined && (ready.codecFeatures !== true || ready.ephemeral !== true || typeof ready.codecSession !== "string" || !DIGEST.test(ready.codecSession))) fail();
      if (!roster || ready.room !== local.current.room || ready.member !== this.options.store.identity.public.fingerprint || ready.epoch !== roster.epoch || ready.digest !== roster.digest) fail("untrusted");
      if (roster.digest !== local.current.digest) {
        if (roster.owner !== this.options.store.identity.public.fingerprint || BigInt(roster.epoch) >= BigInt(local.current.epoch)) fail("untrusted");
        session.ownerUpgrading = true;
        this.send(session, local.wire); return;
      }
      if (session.presenceRoster !== roster.digest) {
        if (this.blockedCodec) this.setState(this.state);
        session.presenceRoster = roster.digest; session.features = new Map(); session.codecPeers = new Map(); session.pendingPresenceReplies.clear(); session.presenceAsked = false;
        session.requestPresenceReply = true; session.lastPresence = undefined;
      }
      session.ephemeral = ready.ephemeral === true;
      session.codecFeatures = ready.codecFeatures === true;
      session.codecSession = typeof ready.codecSession === "string" ? ready.codecSession : undefined;
      session.phase = "ready"; session.ownerUpgrading = false; clearTimeout(session.handshake); this.attempts = 0;
      if (session.deferredFrame) {
        session.queue.unshift(session.deferredFrame); session.queuedBytes += session.deferredFrame.byteLength; session.deferredFrame = undefined;
      }
      if (!this.running || this.stopping) return;
      this.setState("online");
      this.armPresenceRefresh(session);
      const context = this.context(session, local.current.digest);
      this.options.application?.members(context);
      this.restoreReceipts(session);
      await this.retryPendingApplications();
      this.current(session, local.current.digest);
      await this.options.application?.online(context);
      this.current(session, local.current.digest);
      void this.publishPresence().catch(() => this.retry(session));
      return;
    }
    if (message.type === "codec_peers") {
      const inventory = exact(message, ["v", "type", "peers", "digest"]);
      if (!Array.isArray(inventory.peers) || inventory.peers.length > 64 || typeof inventory.digest !== "string" || !DIGEST.test(inventory.digest)) fail("untrusted");
      if (inventory.digest !== local.current.digest) return; // A previous-roster observation cannot revoke or grant current support.
      if (!session.codecFeatures || session.phase !== "ready") fail("untrusted");
      const members = roomMembers(local.current), seen = new Set<string>();
      const peers = inventory.peers.map(value => {
        const peer = exact(value, ["member", "session", "supported"]);
        if (typeof peer.member !== "string" || !members.some(member => member.fingerprint === peer.member) || seen.has(peer.member)
          || peer.member === this.options.store.identity.public.fingerprint || typeof peer.supported !== "boolean"
          || peer.session !== null && (typeof peer.session !== "string" || !DIGEST.test(peer.session)) || peer.session === null && peer.supported) fail("untrusted");
        seen.add(peer.member);
        return { member: peer.member, session: peer.session as string | null, supported: peer.supported };
      });
      for (const peer of peers) {
        const previous = session.codecPeers?.get(peer.member);
        if (previous?.session === peer.session && previous.supported === peer.supported) continue;
        (session.codecPeers ??= new Map()).set(peer.member, { session: peer.session, supported: peer.supported });
        session.features?.delete(peer.member);
        this.refreshCodecCause(peer.member);
        try { this.options.application?.codecsChanged?.(this.context(session, local.current.digest), { member: peer.member }); } catch { /* Compatibility evidence grants no authority. */ }
      }
      return;
    }
    if (message.type === "frame") {
      if (session.phase !== "ready") {
        // X2 may already have one ciphertext in flight while this verified owner
        // installs its newer local roster. Let roster/ready controls pass it;
        // never decrypt, advance replay or ACK until the new roster is ready.
        if (!session.ownerUpgrading || !session.roster || session.roster.owner !== this.options.store.identity.public.fingerprint || BigInt(session.roster.epoch) >= BigInt(local.current.epoch) || session.deferredFrame) fail("untrusted");
        const deferred = decodeFrame(bytes); // Still require a canonical bounded room/recipient frame.
        if (deferred.room !== session.room || !deferred.recipients.includes(this.options.store.identity.public.fingerprint)) fail("untrusted");
        session.deferredFrame = Uint8Array.from(bytes);
        return;
      }
      await this.receiveFrame(session, bytes, local);
      return;
    }
    if (message.type === "stored") {
      const row = exact(message, ["v", "type", "digest", "seq", "duplicate"]);
      if (typeof row.digest !== "string" || !DIGEST.test(row.digest) || typeof row.seq !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.seq) || typeof row.duplicate !== "boolean") fail();
      const receipt = this.options.store.receiptSendable(this.options.name, row.digest);
      if (receipt) {
        this.options.store.markStored(this.options.name, row.digest, row.seq);
        this.options.store.retireStoredReceipt(this.options.name, row.digest);
      }
      this.storedFrame(session, row.digest);
      this.options.application?.stored(this.context(session, local.current.digest), { digest: row.digest, seq: row.seq });
      this.restoreReceipts(session);
      return; // Broker storage is not a signed recipient application-completion receipt.
    }
    if (message.type === "queue_ack") {
      const row = exact(message, ["v", "type", "digest"]);
      if (typeof row.digest !== "string" || !DIGEST.test(row.digest)) fail();
      try { this.options.application?.transportAck?.(this.context(session, local.current.digest), { digest: row.digest }); }
      catch { /* A transport observer cannot change delivery or reconnect the link. */ }
      return;
    }
    if (message.type === "roster_installed") {
      const row = exact(message, ["v", "type", "epoch", "digest", "changed"]);
      if (row.epoch !== local.current.epoch || row.digest !== local.current.digest || typeof row.changed !== "boolean") fail("untrusted");
      return;
    }
    if (message.type === "error") {
      const error = exact(message, Object.hasOwn(message, "digest") ? ["v", "type", "code", "digest"] : ["v", "type", "code"]);
      if (error.digest !== undefined && (error.code !== "queue_full" || typeof error.digest !== "string" || !DIGEST.test(error.digest))) fail();
      if (error.code === "queue_full") {
        // Older brokers omit correlation; one frame in flight makes its head unambiguous.
        const digest = typeof error.digest === "string" ? error.digest : session.outbound[0]?.digest;
        if (digest) this.backoffFrame(session, digest);
        return;
      }
      // X2 declares these refusal controls nonterminal. Their unsigned control
      // cannot settle any application; its local ACK deadline records uncertainty.
      if (error.code === "replay_refused" || error.code === "unexpected_ack") return;
      this.setState(this.state, "broker_refused");
      fail("unavailable");
    }
    fail();
  }
  private frameCurrent(session: Session, frame: FrameWire): RoomState {
    const row = this.current(session), identity = this.options.store.identity.public;
    const own = roomMembers(row.current).find(member => member.fingerprint === identity.fingerprint);
    if (frame.room !== session.room || !frame.recipients.includes(identity.fingerprint) || !own || own.signingKey !== identity.signingKey || own.agreementKey !== identity.agreementKey) fail("untrusted");
    return row;
  }
  private isFrameCurrent(session: Session, frame: FrameWire): boolean {
    try { this.frameCurrent(session, frame); return true; } catch { return false; }
  }
  private async receiveFrame(session: Session, bytes: Uint8Array, local: RoomState): Promise<void> {
    // Only a canonical frame addressed to this active room membership is eligible
    // for transport retirement. No malformed/foreign packet earns an ACK.
    const frame = decodeFrame(bytes), digest = local.current.digest;
    this.frameCurrent(session, frame);
    let result: FrameOpenResult | undefined, refused: RoomRefusalReason | undefined, invalidPresence = false, invalidApplication = false, unmatchedReceipt = false, freshChatCapacity = false, presenceCapacity = false;
    let application: RoomMessage | undefined;
    try {
      result = await openFrame({ wire: bytes, identity: this.options.store.identity, current: local.current, ...(local.previous ? { previous: local.previous } : {}), replay: { accept: async input => {
        const latest = this.frameCurrent(session, frame);
        if (latest.current.digest !== digest) return { status: "trust_changed" };
        const sender = roomMembers(latest.current).find(member => member.fingerprint === input.sender);
        if (!sender) return { status: "trust_changed" };
        let validPresence = false;
        try {
          if (packet(input.plaintext).type === "presence") {
            presence(input.plaintext, sender.exposedPeers);
            const features = packet(input.plaintext).features;
            if (frame.codecFeatures === true ? !session.codecFeatures || features === undefined : features !== undefined) fail();
            validPresence = true;
          }
          else {
            invalidApplication = true;
            if (frame.codecFeatures) fail("untrusted");
            if (!this.options.application) fail("untrusted");
            application = decodeRoomMessage(input.plaintext);
            if (application.type === "chat" && application.envelope.from !== "user" && !sender.exposedPeers.includes(application.envelope.from)) fail("untrusted");
            invalidApplication = false;
          }
        } catch (error) { if (!invalidApplication) invalidPresence = true; throw error; }
        // This readonly metadata test stays outside the grammar catch: SQL/runtime
        // errors cannot become safe drops. Only explicit physical-cap false qualifies.
        if (validPresence && !this.options.store.ordinaryInboxAvailable(this.options.name, input.plaintext.byteLength)) {
          presenceCapacity = true; this.retiredPresenceBytes = Math.max(this.retiredPresenceBytes, input.plaintext.byteLength);
          fail("limit");
        }
        try { return await this.options.store.replay.accept(input); }
        catch (error) {
          if (application?.type === "receipt" && error instanceof RoomUnmatchedReceiptError) unmatchedReceipt = true;
          if (application?.type === "chat" && error instanceof RoomFreshChatCapacityError) freshChatCapacity = true;
          throw error;
        }
      } } });
    } catch (error) {
      if (presenceCapacity) refused = "invalid_presence";
      else if (unmatchedReceipt || freshChatCapacity) refused = "invalid_frame";
      else if (invalidApplication) refused = "invalid_frame";
      else if (invalidPresence) refused = "invalid_presence";
      else if (error instanceof RoomWireError) {
        if (error.code === "wrong_epoch") refused = "wrong_epoch";
        else if (error.code === "state_changed" || error.code === "untrusted") refused = "trust_changed";
        else if (error.code === "authentication_failed" || error.code === "invalid_wire" || error.code === "limit") refused = "invalid_frame";
        else throw error; // A durable-state/runtime failure must retain the broker packet.
      } else if (error instanceof RoomCryptoError && error.code === "authentication_failed") refused = "invalid_frame";
      else throw error;
    }
    const acceptedDigest = await this.frameDigest(bytes);
    session.processingFrame = acceptedDigest;
    const latest = this.frameCurrent(session, frame);
    if (latest.current.digest !== digest) refused = "trust_changed";
    if (result?.status === "stale") {
      // A retained authenticated application receipt may outlive the ordinary
      // crypto inbox tombstone. Unknown lower sequences still fabricate nothing.
      await this.deliverApplication(session, digest, { digest: acceptedDigest, sender: frame.sender });
      refused = "stale";
    }
    if (refused) {
      this.options.store.recordRefused(this.options.name, acceptedDigest, refused, () => this.isFrameCurrent(session, frame));
      this.frameCurrent(session, frame);
      this.options.store.settleInbox(this.options.name, acceptedDigest);
      if (result?.status === "accepted") this.capacityChanged(session, digest);
    } else if (result?.status === "accepted") {
      const sender = roomMembers(latest.current).find(member => member.fingerprint === frame.sender);
      if (!sender) fail("untrusted");
      if (application && this.options.application) {
        await this.deliverApplication(session, digest, { digest: acceptedDigest, sender: frame.sender, message: application });
      } else {
        const peers = presence(result.plaintext, sender.exposedPeers);
        this.current(session, digest);
        if (frame.codecFeatures === true) {
          const payload = packet(result.plaintext), peer = session.codecPeers?.get(frame.sender);
          if (frame.epoch === latest.current.epoch && peer?.supported && peer.session !== null && payload.codecSession === peer.session) {
            (session.features ??= new Map()).set(frame.sender, { session: peer.session, features: roomCodecFeatures(payload.features) });
            this.refreshCodecCause(frame.sender);
            this.pumpFrames(session);
            try { this.options.application?.codecsChanged?.(this.context(session, digest), { member: frame.sender }); } catch { /* Compatibility observations cannot change admission. */ }
          }
        } else {
          session.pendingPresenceReplies.delete(frame.sender);
          if (session.presenceAsked && session.pendingPresenceReplies.size === 0) session.requestPresenceReply = false;
          try { this.options.onPresence?.({ member: frame.sender, peers }); } catch { /* validated observation only */ }
        }
        this.current(session, digest);
        this.options.store.settleInbox(this.options.name, acceptedDigest);
        this.capacityChanged(session, digest);
        if (packet(result.plaintext).requestReply === true) {
          this.replyPresence = true;
          void this.publishPresence().catch(() => this.retry(session));
        }
      }
    } else if (result?.status === "duplicate") {
      await this.deliverApplication(session, digest, { digest: acceptedDigest, sender: frame.sender });
    } else fail("unavailable");
    this.frameCurrent(session, frame);
    // This ACK only retires ciphertext from the broker queue. A durable refusal
    // or stale drop is never a signed recipient application-completion receipt.
    this.retireFrame(session, frame, acceptedDigest);
    session.processingFrame = undefined; session.acknowledgedFrame = undefined;
    await this.refreshPresenceIfCapacityFree().catch(() => undefined);
  }
  private retireFrame(session: Session, frame: FrameWire, digest: string): void {
    this.frameCurrent(session, frame);
    // Final admission commits its receipt; deferred admission retains the durable inbox.
    // Waiting for broker storage or deferred admission would pin capacity one indefinitely.
    if (this.options.store.applicationReceipt(this.options.name, digest)
      && !this.options.store.receiptStored(this.options.name, digest)) fail("unavailable");
    this.send(session, encodeBrokerControl({ v: 1, type: "received", digest }));
    session.acknowledgedFrame = digest;
    this.pumpFrames(session);
  }
  private restoreReceipts(session: Session): void {
    if (!this.running || this.stopping) return;
    this.current(session);
    this.options.store.expireReceipts(this.options.name);
    for (const entry of this.options.store.outbox(this.options.name)) {
      if (entry.kind !== "receipt" || session.outbound.some(frame => frame.digest === entry.digest)) continue;
      if (session.outbound.length >= LIMITS.packets || session.outboundBytes + entry.wire.byteLength > LIMITS.queuedBytes) break;
      const roster = this.current(session).current.digest;
      this.queueFrame(session, entry.wire, entry.digest, false, () => this.publicationCurrent(session, roster), false,
        () => this.options.store.receiptSendable(this.options.name, entry.digest), undefined,
        entry.receiptFor === session.processingFrame ? entry.receiptFor : undefined);
    }
  }
  private async frameDigest(bytes: Uint8Array): Promise<string> {
    return encodeBase64url(await sha256(bytes));
  }
  private currentPresence(exposed: readonly string[]): RoomPresencePeer[] {
    const source = this.options.presence?.() ?? [];
    if (!Array.isArray(source) || source.length > 64) fail("limit");
    const peers = source.filter(peer => exposed.includes(peer.id)).map(peer => {
      if (!PEER_ID.test(peer.id) || !STATES.includes(peer.state)) fail();
      return { id: peer.id, state: peer.state as RoomPresenceState };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (peers.some((peer, index) => index > 0 && peers[index - 1]!.id === peer.id)) fail();
    return peers;
  }
  /** Seal and send in reserve order; a concurrent presence must not overtake an application seq. */
  private serialSend<T>(send: () => Promise<T>): Promise<T> {
    const next = this.sendTail.then(send);
    this.sendTail = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Host-only admission pause; trust/current predicates remain independent. */
  async quiesceApplications(): Promise<() => void> {
    const token = Symbol(); this.applicationPauses.add(token);
    await this.sendTail;
    let released = false;
    return () => { if (!released) { released = true; this.applicationPauses.delete(token); } };
  }
  async publishApplication(message: RoomMessage, recipient: string, outgoing?: RoomOutgoingInput, current: () => boolean = () => true): Promise<string> {
    const plaintext = encodeRoomMessage(message), metadata = outgoing ? { ...outgoing } : undefined;
    const session = this.session;
    if (this.stopping || !this.running || !session || session.phase !== "ready") { if (metadata) throw new RoomNotSentError(); fail("unavailable"); }
    if (this.applicationPauses.size) { if (metadata) throw new RoomNotSentError(); fail("state_changed"); }
    const required = roomRequiredCodecFeature(message);
    if (required && !this.codecSupported(recipient, required)) throw this.codecRefusal(recipient, required);
    const digest = this.current(session).current.digest;
    const allowed = () => this.publicationCurrent(session, digest) && current();
    const supported = () => required === undefined || this.codecSupported(recipient, required);
    let codecLost = false;
    const admitted = () => {
      if (!supported()) { codecLost = true; return false; }
      return this.applicationPauses.size === 0 && allowed();
    };
    const assertAdmitted = () => {
      if (admitted()) return;
      if (codecLost && required) throw this.codecRefusal(recipient, required);
      fail("state_changed");
    };
    let queueStarted = false;
    try {
      let presenceWork: Promise<void> | undefined;
      // A chat is the transport barrier for earlier observations. Receipts keep
      // their durable-commit/ACK path and do not wait behind a new observation.
      if (message.type === "chat" && this.republish) {
        clearTimeout(this.republish); this.republish = undefined;
        presenceWork = this.publishPresence();
        // It may fail before reaching the serial lane. Observe rejection now;
        // the reserved chat slot still awaits the original error below.
        void presenceWork.catch(() => undefined);
      }
      // Reserve this chat's FIFO slot before yielding to the earlier observation.
      return await this.serialSend(async () => {
      if (presenceWork) await presenceWork;
      assertAdmitted();
      if (metadata && (session.outbound.length >= LIMITS.packets || session.outboundBytes + plaintext.byteLength > LIMITS.queuedBytes
        || session.ws.bufferedAmount > LIMITS.backpressure)) throw new RoomNotSentError();
      if (message.type === "receipt") {
        const pending = this.options.store.receiptStored(this.options.name, message.frame);
        if (pending?.state === "dispatching") {
          if (!decodeFrame(pending.wire).recipients.includes(recipient)) fail("untrusted");
          this.restoreReceipts(session);
          return pending.digest;
        }
      }
      const row = this.current(session, digest);
      if (!roomMembers(row.current).some(member => member.fingerprint === recipient) || recipient === this.options.store.identity.public.fingerprint) fail("untrusted");
      let wire = await sealFrame({ epoch: row.current, identity: this.options.store.identity, recipients: [recipient], plaintext, sequence: this.options.store.sequence });
      this.clockRecoveredAfterWrite();
      assertAdmitted();
      let frameDigest: string;
      if (metadata) {
        queueStarted = true;
        let record: Awaited<ReturnType<RoomStore["queueApplication"]>>;
        try { record = await this.options.store.queueApplication(this.options.name, wire, metadata, admitted); }
        catch (error) {
          if (codecLost && required && error instanceof RoomStoreError && error.code === "state_changed") {
            // The atomic fence refused this attempt. Positively distinguish a
            // never-admitted application from an earlier durable retry intent.
            if (!this.options.store.applicationOutbox(this.options.name).some(row => row.deliveryId === metadata.deliveryId || row.application === metadata.application)) throw this.codecRefusal(recipient, required);
            if (this.codecState(recipient, required) !== "unsupported") throw this.codecRefusal(recipient, required);
            throw new RoomNotSentError();
          }
          // An explicit atomic refusal plus absent durable intent is positive not-sent evidence.
          if (error instanceof RoomStoreError && ["limit", "invalid", "untrusted", "state_changed"].includes(error.code)
            && !this.options.store.applicationOutbox(this.options.name).some(row => row.deliveryId === metadata.deliveryId || row.application === metadata.application)) throw new RoomNotSentError();
          throw error;
        }
        frameDigest = record.frameDigest ?? record.digest;
      } else if (message.type === "receipt") {
        const ttlMs = this.options.application?.receiptTtlMs?.(this.context(session, digest)) ?? RECEIPT_TTL_MS;
        const receipt = await this.options.store.queueReceipt(this.options.name, message.frame, wire, { ttlMs, replaceExisting: true }, admitted);
        if (!allowed()) fail("state_changed");
        if (receipt.state === "accepted") return receipt.digest; // Existing broker-stored proof needs no pending wire slot.
        frameDigest = receipt.digest; wire = receipt.wire;
      } else frameDigest = await this.frameDigest(wire);
      if (!allowed()) fail("state_changed");
      try {
        this.queueFrame(session, wire, frameDigest, false, allowed, false,
          metadata ? () => this.options.store.applicationSendable(this.options.name, frameDigest)
            : message.type === "receipt" ? () => this.options.store.receiptSendable(this.options.name, frameDigest) : undefined,
          undefined, message.type === "receipt" && message.frame === session.processingFrame ? message.frame : undefined, false, required ? supported : undefined, required ? () => this.codecState(recipient, required) === "pending" : undefined, required ? { member: recipient, feature: required } : undefined);
      } catch (error) {
        // The durable outbox owns retry after local backpressure; this is no uncertainty.
        if (!allowed() || !(error instanceof RoomLinkError) || error.code !== "limit" || !metadata && message.type !== "receipt") throw error;
        if (session.outbound[0]?.digest === frameDigest) this.backoffFrame(session, frameDigest);
      }
      return frameDigest;
    }); } catch (error) {
      if (error instanceof RoomCodecUnsupportedError || error instanceof RoomCodecPendingError) throw error;
      if (metadata && !queueStarted) throw new RoomNotSentError();
      throw error;
    }
  }
  async publishPresence(): Promise<void> {
    const session = this.session;
    if (!this.running || this.stopping || !session || session.phase !== "ready") return;
    if (this.publishing) { this.publishDirty = true; return; }
    // Keep the already scheduled coalesced snapshot. Cancelling it on every
    // state flip turns an awaited burst back into one durable seal per call.
    if (this.republish && !this.replyPresence && !this.forcePresenceRequest) { this.publishDirty = true; return; }
    if (this.republish) clearTimeout(this.republish);
    this.republish = undefined; this.publishDirty = false;
    const forceRequest = this.forcePresenceRequest;
    const response = this.replyPresence;
    if (response) this.replyPresence = false;
    this.forcePresenceRequest = response && forceRequest;
    let sent = false;
    this.publishing = true;
    try {
      const row = this.current(session), identity = this.options.store.identity;
      if (!this.publicationCurrent(session, row.current.digest)) return;
      const own = roomMembers(row.current).find(member => member.fingerprint === identity.public.fingerprint);
      if (!own) fail("untrusted");
      const peers = this.currentPresence(own.exposedPeers);
      const recipients = roomMembers(row.current).map(member => member.fingerprint).filter(member => member !== identity.public.fingerprint).sort();
      if (!recipients.length) return;
      await this.serialSend(async () => {
        if (!this.publicationCurrent(session, row.current.digest)) return;
        const requestReply = !response && session.requestPresenceReply;
        const presenceKey = JSON.stringify([row.current.digest, recipients, peers, requestReply]);
        if (!response && !forceRequest && session.lastPresence === presenceKey) return;
        // Positive codec evidence precedes the peer-state observation on this
        // FIFO lane. Observed idle never races its own pending advertisement.
        if (session.codecFeatures && session.codecSession) {
          const featureWire = await sealFrame({ epoch: row.current, identity, recipients,
            plaintext: canonicalBytes({ v: 1, type: "presence", peers, features: ROOM_CODEC_FEATURES, codecSession: session.codecSession }),
            ephemeral: true, codecFeatures: true, sequence: this.options.store.sequence });
          if (!this.publicationCurrent(session, row.current.digest)) return;
          const featureDigest = await this.frameDigest(featureWire);
          this.queueFrame(session, featureWire, featureDigest, false,
            () => this.publicationCurrent(session, row.current.digest) && peers.every(({ id }) => this.currentPresence(own.exposedPeers).some(value => value.id === id)),
            true, undefined, undefined, undefined, true);
        }
        const wire = await sealFrame({ epoch: row.current, identity, recipients, plaintext: canonicalBytes({ v: 1, type: "presence", peers, ...(requestReply ? { requestReply: true } : {}) }), ...(session.ephemeral ? { ephemeral: true as const } : {}), sequence: this.options.store.sequence });
        this.clockRecoveredAfterWrite();
        if (!this.publicationCurrent(session, row.current.digest)) return;
        // Machine-local exposure can change during reserve/encryption/signing even
        // when the signed roster is unchanged. Never emit an id it now withholds.
        const frameDigest = await this.frameDigest(wire);
        if (!this.publicationCurrent(session, row.current.digest)) return;
        const allowed = new Set(this.currentPresence(own.exposedPeers).map(peer => peer.id));
        if (peers.some(peer => !allowed.has(peer.id))) return;
        this.queueFrame(session, wire, frameDigest, requestReply,
          () => this.publicationCurrent(session, row.current.digest) && peers.every(peer => this.currentPresence(own.exposedPeers).some(value => value.id === peer.id)), true, undefined,
          requestReply ? () => {
            if (!session.presenceAsked) { session.pendingPresenceReplies = new Set(recipients); session.presenceAsked = true; }
            session.requestPresenceReply = session.pendingPresenceReplies.size > 0;
            if (this.retiredPresenceBytes && this.options.store.ordinaryInboxAvailable(this.options.name, this.retiredPresenceBytes)) this.retiredPresenceBytes = 0;
          } : undefined);
        session.lastPresence = presenceKey; sent = true;
      });
    } catch (error) {
      this.retry(session, error); // Existing bounded reconnect, never a self-polling refresh retry.
      throw error;
    } finally {
      this.publishing = false;
      const next = this.session;
      if (sent && response && this.retiredPresenceBytes && session.requestPresenceReply) this.forcePresenceRequest = true;
      const dirty = this.publishDirty || sent && (this.replyPresence || this.forcePresenceRequest);
      this.publishDirty = false;
      if (dirty && this.running && next?.phase === "ready") {
        // Coalesce all changes during one seal into one later fresh snapshot.
        // Capture the target so stop/refresh cannot publish through a stale link.
        this.republish = setTimeout(() => {
          this.republish = undefined;
          if (this.running && this.session === next && next.phase === "ready") void this.publishPresence().catch(() => this.retry(next));
        }, 0);
        this.republish.unref?.();
      }
    }
  }
}
