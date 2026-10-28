/** Outbound room transport. The local bus and application delivery boundary belong to X4. */
import { createBrokerAuth, decodeBrokerChallenge, encodeBrokerControl } from "../broker/protocol.ts";
import { assertRoomCryptoReady, encodeBase64url, sha256, RoomCryptoError } from "./crypto.ts";
import { brokerUrl, canonicalBytes, decodeFrame, decodeRoster, openFrame, roomMembers, sealFrame, verifyPublicRoster, RoomWireError, type FrameWire, type FrameOpenResult, type VerifiedPublicRoster } from "./wire.ts";
import type { RoomRefusalReason, RoomState, RoomStore } from "./store.ts";
import type { RoomOutgoingInput } from "./store.ts";
import { decodeRoomMessage, encodeRoomMessage, type RoomMessage } from "./application.ts";

export type RoomLinkState = "offline" | "connecting" | "online";
export type RoomPresenceState = "idle" | "busy" | "paused" | "offline";
export interface RoomPresencePeer { id: string; state: RoomPresenceState }
export interface RoomLinkOptions {
  store: RoomStore;
  name: string;
  presence?: () => readonly { id: string; state: string }[];
  onPresence?: (value: { member: string; peers: readonly RoomPresencePeer[] }) => void;
  onState?: (state: RoomLinkState) => void;
  application?: RoomLinkApplication;
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
}
export class RoomLinkError extends Error {
  constructor(readonly code: "unavailable" | "invalid_wire" | "state_changed" | "untrusted" | "limit") {
    super(`Room link: ${code}`); this.name = "RoomLinkError";
  }
}
const LIMITS = Object.freeze({ packets: 8, queuedBytes: 2_097_152, packetBytes: 1_048_576, backpressure: 1_048_576, handshakeMs: 30_000, reconnectMaxMs: 300_000 });
const decoder = new TextDecoder("utf-8", { fatal: true });
const PEER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const STATES: readonly string[] = ["idle", "busy", "paused", "offline"];
interface Session {
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
  const row = exact(packet(bytes), ["v", "type", "peers"]);
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
  private generation = 0;
  private session?: Session;
  private reconnect?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private state: RoomLinkState = "offline";
  private publishing = false;
  private publishDirty = false;
  private republish?: ReturnType<typeof setTimeout>;
  private sendTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: RoomLinkOptions) {}

  status(): { state: RoomLinkState; members: number } {
    try {
      const row = this.options.store.get(this.options.name);
      return { state: this.state, members: row && !row.left ? roomMembers(row.current).length : 0 };
    } catch { return { state: "offline", members: 0 }; }
  }
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    try { await assertRoomCryptoReady(); } catch { this.running = false; throw new RoomLinkError("unavailable"); }
    if (!this.running || generation !== this.generation) return;
    this.connect();
  }
  stop(): void {
    this.running = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.disconnect();
  }
  refresh(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.disconnect();
    if (this.running) this.connect();
  }
  private setState(state: RoomLinkState): void {
    if (this.state === state) return;
    this.state = state;
    try { this.options.onState?.(state); } catch { /* observation never changes transport authority */ }
  }
  private current(session: Session, digest?: string): RoomState {
    if (!this.running || this.session !== session || session.generation !== this.generation || session.ws.readyState !== WebSocket.OPEN) fail("state_changed");
    let row: RoomState | undefined;
    try { row = this.options.store.get(this.options.name); } catch { fail("unavailable"); }
    if (!row || row.left || row.current.room !== session.room || row.broker !== session.broker || (digest !== undefined && row.current.digest !== digest)) fail("state_changed");
    return row;
  }
  private isCurrent(session: Session, digest: string): boolean {
    try { this.current(session, digest); return true; } catch { return false; }
  }
  private context(session: Session, digest: string): RoomLinkContext {
    return { store: this.options.store, name: this.options.name, link: this, current: () => this.isCurrent(session, digest) };
  }
  private async restorePresence(session: Session): Promise<void> {
    const row = this.current(session), members = roomMembers(row.current);
    for (const entry of this.options.store.pendingInbox(this.options.name)) {
      this.current(session, row.current.digest);
      const member = members.find(value => value.fingerprint === entry.sender);
      if (member) {
        let application: RoomMessage | undefined;
        try { application = decodeRoomMessage(entry.plaintext); } catch { /* X3 presence has its own strict codec. */ }
        if (application && this.options.application) {
          await this.options.application.receive(this.context(session, row.current.digest), { digest: entry.digest, sender: entry.sender, message: application });
          this.current(session, row.current.digest);
          continue;
        }
        let peers: RoomPresencePeer[] | undefined;
        try { peers = presence(entry.plaintext, member.exposedPeers); } catch { /* a rotation may have removed an exposed id since the durable receive */ }
        if (peers) { try { this.options.onPresence?.({ member: entry.sender, peers }); } catch { /* observation only */ } }
      }
      // Presence is ephemeral: stale exposure/member metadata is discarded, never
      // replayed after a rotation or left at the head of recovery forever.
      this.current(session, row.current.digest);
      this.options.store.settleInbox(this.options.name, entry.digest);
    }
  }
  private disconnect(session = this.session): void {
    if (session && session !== this.session) return;
    this.generation++;
    this.session = undefined;
    this.publishDirty = false;
    if (this.republish) clearTimeout(this.republish);
    this.republish = undefined;
    if (session) {
      clearTimeout(session.handshake);
      session.queue.length = 0; session.queuedBytes = 0;
      try { session.ws.close(1000, "disconnected"); } catch { /* already closed */ }
    }
    this.setState("offline");
  }
  private retry(session?: Session): void {
    if (session && this.session !== session) return;
    this.disconnect(session);
    if (!this.running || this.reconnect) return;
    const ceiling = Math.min(LIMITS.reconnectMaxMs, 1000 * 2 ** Math.min(this.attempts++, 9));
    const delay = Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
    this.reconnect = setTimeout(() => { this.reconnect = undefined; if (this.running) this.connect(); }, delay);
    this.reconnect.unref?.();
  }
  private connect(): void {
    if (!this.running || this.session) return;
    let row: RoomState | undefined;
    try { row = this.options.store.get(this.options.name); } catch { this.setState("offline"); return; }
    if (!row || row.left) { this.setState("offline"); return; }
    let url: URL;
    try {
      url = new URL(brokerUrl(row.broker));
      if (url.pathname !== "/" || url.search) fail("untrusted");
    } catch { this.setState("offline"); return; }
    url.pathname = `/v1/rooms/${row.current.room}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url.href); } catch { this.retry(); return; }
    ws.binaryType = "arraybuffer";
    const generation = ++this.generation;
    const session: Session = { ws, generation, room: row.current.room, broker: row.broker, phase: "challenge", queue: [], queuedBytes: 0, processing: false, initialRoster: true,
      handshake: setTimeout(() => this.retry(session), LIMITS.handshakeMs) };
    session.handshake.unref?.();
    this.session = session;
    this.setState("connecting");
    ws.addEventListener("message", event => this.receive(session, event.data));
    ws.addEventListener("close", () => this.retry(session));
    ws.addEventListener("error", () => this.retry(session));
  }
  private send(session: Session, bytes: Uint8Array): void {
    this.current(session);
    if (bytes.length > LIMITS.packetBytes || session.ws.bufferedAmount > LIMITS.backpressure) fail("limit");
    session.ws.send(bytes);
  }
  private receive(session: Session, data: unknown): void {
    if (this.session !== session || !this.running) return;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > LIMITS.packetBytes || session.queue.length >= LIMITS.packets || session.queuedBytes + data.byteLength > LIMITS.queuedBytes) { this.retry(session); return; }
    const bytes = new Uint8Array(data).slice();
    session.queue.push(bytes); session.queuedBytes += bytes.length;
    this.drain(session);
  }
  private drain(session: Session): void {
    if (session.processing || this.session !== session || !session.queue.length) return;
    const bytes = session.queue.shift()!; session.queuedBytes -= bytes.length;
    session.processing = true;
    void this.handle(session, bytes).catch(() => this.retry(session)).finally(() => {
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
      const ready = exact(message, ["v", "type", "room", "member", "epoch", "digest"]), roster = session.roster;
      if (!roster || ready.room !== local.current.room || ready.member !== this.options.store.identity.public.fingerprint || ready.epoch !== roster.epoch || ready.digest !== roster.digest) fail("untrusted");
      if (roster.digest !== local.current.digest) {
        if (roster.owner !== this.options.store.identity.public.fingerprint || BigInt(roster.epoch) >= BigInt(local.current.epoch)) fail("untrusted");
        this.send(session, local.wire); return;
      }
      session.phase = "ready"; clearTimeout(session.handshake); this.attempts = 0;
      this.setState("online");
      const context = this.context(session, local.current.digest);
      this.options.application?.members(context);
      await this.restorePresence(session);
      this.current(session, local.current.digest);
      await this.options.application?.online(context);
      this.current(session, local.current.digest);
      void this.publishPresence().catch(() => this.retry(session));
      return;
    }
    if (message.type === "frame") {
      if (session.phase !== "ready") fail("untrusted");
      await this.receiveFrame(session, bytes, local);
      return;
    }
    if (message.type === "stored") {
      const row = exact(message, ["v", "type", "digest", "seq", "duplicate"]);
      if (typeof row.digest !== "string" || !DIGEST.test(row.digest) || typeof row.seq !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.seq) || typeof row.duplicate !== "boolean") fail();
      this.options.application?.stored(this.context(session, local.current.digest), { digest: row.digest, seq: row.seq });
      return; // Broker storage is not a signed recipient application-completion receipt.
    }
    if (message.type === "queue_ack") {
      const row = exact(message, ["v", "type", "digest"]);
      if (typeof row.digest !== "string" || !DIGEST.test(row.digest)) fail();
      return;
    }
    if (message.type === "roster_installed") {
      const row = exact(message, ["v", "type", "epoch", "digest", "changed"]);
      if (row.epoch !== local.current.epoch || row.digest !== local.current.digest || typeof row.changed !== "boolean") fail("untrusted");
      return;
    }
    if (message.type === "error") { exact(message, ["v", "type", "code"]); fail("unavailable"); }
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
    let result: FrameOpenResult | undefined, refused: RoomRefusalReason | undefined, invalidPresence = false, invalidApplication = false;
    let application: RoomMessage | undefined;
    try {
      result = await openFrame({ wire: bytes, identity: this.options.store.identity, current: local.current, ...(local.previous ? { previous: local.previous } : {}), replay: { accept: async input => {
        const latest = this.frameCurrent(session, frame);
        if (latest.current.digest !== digest) return { status: "trust_changed" };
        const sender = roomMembers(latest.current).find(member => member.fingerprint === input.sender);
        if (!sender) return { status: "trust_changed" };
        try {
          if (packet(input.plaintext).type === "presence") presence(input.plaintext, sender.exposedPeers);
          else {
            invalidApplication = true;
            if (!this.options.application) fail("untrusted");
            application = decodeRoomMessage(input.plaintext);
            if (application.type === "chat" && application.envelope.from !== "user" && !sender.exposedPeers.includes(application.envelope.from)) fail("untrusted");
            invalidApplication = false;
          }
        } catch (error) { if (!invalidApplication) invalidPresence = true; throw error; }
        return this.options.store.replay.accept(input);
      } } });
    } catch (error) {
      if (invalidApplication) refused = "invalid_frame";
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
    const latest = this.frameCurrent(session, frame);
    if (latest.current.digest !== digest) refused = "trust_changed";
    if (result?.status === "stale") refused = "stale";
    if (refused) {
      this.options.store.recordRefused(this.options.name, acceptedDigest, refused, () => this.isFrameCurrent(session, frame));
      this.frameCurrent(session, frame);
      this.options.store.settleInbox(this.options.name, acceptedDigest);
    } else if (result?.status === "accepted") {
      const sender = roomMembers(latest.current).find(member => member.fingerprint === frame.sender);
      if (!sender) fail("untrusted");
      if (application && this.options.application) {
        await this.options.application.receive(this.context(session, digest), { digest: acceptedDigest, sender: frame.sender, message: application });
        this.current(session, digest);
      } else {
        const peers = presence(result.plaintext, sender.exposedPeers);
        this.current(session, digest);
        try { this.options.onPresence?.({ member: frame.sender, peers }); } catch { /* validated observation only */ }
        this.current(session, digest);
        this.options.store.settleInbox(this.options.name, acceptedDigest);
      }
    } else if (result?.status === "duplicate") {
      await this.options.application?.receive(this.context(session, digest), { digest: acceptedDigest, sender: frame.sender });
      this.current(session, digest);
    } else fail("unavailable");
    this.frameCurrent(session, frame);
    // This ACK only retires ciphertext from the broker queue. A durable refusal
    // or stale drop is never a signed recipient application-completion receipt.
    this.send(session, encodeBrokerControl({ v: 1, type: "received", digest: acceptedDigest }));
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
  async publishApplication(message: RoomMessage, recipient: string, outgoing?: RoomOutgoingInput, current: () => boolean = () => true): Promise<string> {
    const session = this.session;
    if (!session || session.phase !== "ready") fail("unavailable");
    const digest = this.current(session).current.digest;
    const allowed = () => this.isCurrent(session, digest) && current();
    return this.serialSend(async () => {
      if (!allowed()) fail("state_changed");
      const row = this.current(session, digest);
      if (!roomMembers(row.current).some(member => member.fingerprint === recipient) || recipient === this.options.store.identity.public.fingerprint) fail("untrusted");
      const wire = await sealFrame({ epoch: row.current, identity: this.options.store.identity, recipients: [recipient], plaintext: encodeRoomMessage(message), sequence: this.options.store.sequence });
      if (!allowed()) fail("state_changed");
      const record = outgoing ? await this.options.store.queueApplication(this.options.name, wire, outgoing, allowed) : undefined;
      const frameDigest = record?.digest ?? await this.frameDigest(wire);
      if (!allowed()) fail("state_changed");
      this.send(session, wire);
      return frameDigest;
    });
  }
  async publishPresence(): Promise<void> {
    const session = this.session;
    if (!session || session.phase !== "ready") return;
    if (this.publishing) { this.publishDirty = true; return; }
    if (this.republish) clearTimeout(this.republish);
    this.republish = undefined; this.publishDirty = false;
    this.publishing = true;
    try {
      const row = this.current(session), identity = this.options.store.identity;
      const own = roomMembers(row.current).find(member => member.fingerprint === identity.public.fingerprint);
      if (!own) fail("untrusted");
      const peers = this.currentPresence(own.exposedPeers);
      const recipients = roomMembers(row.current).map(member => member.fingerprint).filter(member => member !== identity.public.fingerprint).sort();
      if (!recipients.length) return;
      await this.serialSend(async () => {
        this.current(session, row.current.digest);
        const wire = await sealFrame({ epoch: row.current, identity, recipients, plaintext: canonicalBytes({ v: 1, type: "presence", peers }), sequence: this.options.store.sequence });
        this.current(session, row.current.digest);
        // Machine-local exposure can change during reserve/encryption/signing even
        // when the signed roster is unchanged. Never emit an id it now withholds.
        const allowed = new Set(this.currentPresence(own.exposedPeers).map(peer => peer.id));
        if (peers.some(peer => !allowed.has(peer.id))) return;
        this.send(session, wire);
      });
    } finally {
      this.publishing = false;
      const dirty = this.publishDirty, next = this.session;
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
