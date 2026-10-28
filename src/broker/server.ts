/** Standalone blind relay. Only public proofs and sealed wire bytes cross this boundary. */
import type { ServerWebSocket } from "bun";
import { assertRoomCryptoReady, decodeBase64url, encodeBase64url, randomBytes } from "../rooms/crypto.ts";
import { brokerUrl, canonicalBytes, decodeFrame, decodeRoster, publicRosterWire, verifyPublicFrame, verifyPublicRoster, type VerifiedPublicRoster } from "../rooms/wire.ts";
import { BROKER_CONTROL_LIMITS, decodeBrokerControl, encodeBrokerChallenge, verifyBrokerAuth, type BrokerChallenge } from "./protocol.ts";
import { BrokerStore, BrokerStoreError, type BrokerLimits } from "./store.ts";

export const BROKER_SOCKET_LIMITS = Object.freeze({ connections: 128, verifications: 16, authMs: 10_000, rosterAckMs: 30_000, backpressureBytes: 1_048_576, queuedMessages: 8, queuedBytes: 2_097_152, globalQueuedBytes: 33_554_432 });
export type BrokerEvent = "started" | "stopped" | "connected" | "buffered" | "disconnected" | "refused" | "roster_installed";
export interface BrokerPorts {
  clock?: () => number;
  log?: (event: BrokerEvent, ids: Readonly<{ room?: string; member?: string; code?: string }>) => void;
  /** Trusted test/host seam: wrappers must return real X1-minted proofs. Never read from config. */
  verifyFrame?: typeof verifyPublicFrame;
}
export interface BrokerOptions {
  stateDir: string;
  hostname?: string;
  port?: number;
  publicUrl?: string;
  /** Controls first-roster admission only; existing roster membership remains authoritative. */
  owners?: readonly string[];
  limits?: Partial<BrokerLimits>;
}
interface Client {
  ws?: ServerWebSocket<Client>;
  room: string;
  challenge: BrokerChallenge;
  phase: "challenge" | "authenticating" | "roster" | "ready" | "closed";
  busy: boolean;
  inbox: Uint8Array[];
  inboxBytes: number;
  member?: string;
  key?: string;
  rosterDigest?: string;
  rosterDeadline?: number;
  inFlight?: string;
}
export interface BrokerRuntime {
  readonly port: number;
  readonly hostname: string;
  readonly publicUrl: string;
  readonly closed: Promise<void>;
  stats(): ReturnType<BrokerStore["stats"]> & { connections: number; authenticated: number; verifications: number };
  sweep(): void;
  stop(): Promise<void>;
}
export class BrokerServerError extends Error {
  constructor(readonly code: string) { super(`Broker: ${code}`); this.name = "BrokerServerError"; }
}
function roomId(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new BrokerServerError("invalid_room");
  try { decodeBase64url(value, 32); } catch { throw new BrokerServerError("invalid_room"); }
  return value;
}
function audience(value: string): string {
  let parsed: URL;
  try { parsed = new URL(brokerUrl(value)); } catch { throw new BrokerServerError("invalid_public_url"); }
  if (parsed.pathname !== "/" || parsed.search) throw new BrokerServerError("invalid_public_url");
  return parsed.href;
}
const identityKey = (member: { signingKey: string; agreementKey: string }) => `${member.signingKey}:${member.agreementKey}`;
function errorCode(error: unknown): string {
  if (error instanceof BrokerStoreError) {
    if (error.code === "full" || error.code === "limit") return "queue_full";
    if (error.code === "conflict") return "replay_refused";
    if (error.code === "untrusted" || error.code === "expired") return error.code;
    return "storage_error";
  }
  if (error instanceof BrokerServerError) return error.code;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["invalid_wire", "limit", "untrusted", "wrong_epoch", "authentication_failed", "expired"].includes(code) ? code : "invalid_wire";
}

export async function startBroker(options: BrokerOptions, ports: BrokerPorts = {}): Promise<BrokerRuntime> {
  // This must precede filesystem, database and listener effects.
  await assertRoomCryptoReady();
  const hostname = options.hostname ?? "127.0.0.1", requestedPort = options.port ?? 8788;
  if (!/^[A-Za-z0-9.:%-]+$/.test(hostname) || !Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new BrokerServerError("invalid_listen");
  const loopback = hostname === "127.0.0.1" || hostname === "::1";
  if (!loopback && options.publicUrl === undefined) throw new BrokerServerError("public_url_required");
  const configuredAudience = options.publicUrl === undefined ? undefined : audience(options.publicUrl);
  if (!loopback && configuredAudience && new URL(configuredAudience).protocol !== "wss:") throw new BrokerServerError("public_url_required");
  let owners: ReadonlySet<string> | undefined;
  if (options.owners !== undefined) {
    if (!Array.isArray(options.owners) || options.owners.length > 64 || options.owners.some(owner => typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))) throw new BrokerServerError("invalid_owner");
    owners = new Set(options.owners);
  }
  if ((!loopback || configuredAudience?.startsWith("wss:")) && !owners?.size) throw new BrokerServerError("owner_allowlist_required");
  const now = () => {
    const value = (ports.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new BrokerServerError("invalid_clock");
    return value;
  };
  const store = await BrokerStore.open({ stateDir: options.stateDir, ...(options.limits ? { limits: options.limits } : {}), clock: now });
  const clients = new Set<Client>(), members = new Map<string, Client>();
  const memberKey = (client: Client) => `${client.room}|${client.member}`;
  let stopping = false, verifications = 0, queuedBytes = 0, publicUrl = configuredAudience ?? "";
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const emit = (event: BrokerEvent, client?: Client, code?: string) => {
    try { ports.log?.(event, { ...(client ? { room: client.room, ...(client.member ? { member: client.member } : {}) } : {}), ...(code ? { code } : {}) }); } catch { /* diagnostics never change admission or delivery */ }
  };
  function close(client: Client, code: string): void {
    if (client.phase === "closed") return;
    client.phase = "closed";
    queuedBytes -= client.inboxBytes; client.inboxBytes = 0; client.inbox.length = 0;
    if (client.member && members.get(memberKey(client)) === client) members.delete(memberKey(client));
    if (client.ws) { try { client.ws.close(4403, code); } catch { /* already closed */ } }
    else clients.delete(client);
  }
  function send(client: Client, wire: Uint8Array): boolean {
    if (stopping || client.phase === "closed" || !client.ws) return false;
    try {
      if (client.ws.send(wire) !== 0) return true; // -1 is queued; never resend on drain.
    } catch { /* a closed transport cannot receive */ }
    close(client, "backpressure"); return false;
  }
  const control = (client: Client, value: unknown) => send(client, canonicalBytes(value));
  function refused(client: Client, code: string, terminal = true): void {
    emit("refused", client, code);
    control(client, { v: 1, type: "error", code });
    if (terminal) close(client, code);
  }
  function active(client: Client): VerifiedPublicRoster {
    if (stopping || client.phase === "closed" || !client.member || members.get(memberKey(client)) !== client) throw new BrokerServerError("state_changed");
    const roster = store.current(client.room)?.current;
    const member = roster?.members.find(row => row.fingerprint === client.member);
    if (!roster || !member || identityKey(member) !== client.key) throw new BrokerServerError("untrusted");
    return roster;
  }
  function sendRoster(client: Client): void {
    const roster = active(client);
    client.phase = "roster"; client.rosterDigest = roster.digest;
    client.rosterDeadline = now() + BROKER_SOCKET_LIMITS.rosterAckMs;
    if (send(client, publicRosterWire(roster))) control(client, { v: 1, type: "ready", room: client.room, member: client.member, epoch: roster.epoch, digest: roster.digest });
  }
  function pump(client: Client): void {
    if (stopping || client.phase === "closed" || !client.member) return;
    active(client);
    const next = store.next(client.room, client.member);
    if (client.inFlight && next?.digest === client.inFlight) return;
    client.inFlight = undefined; // the previous packet may have expired or been purged.
    if (client.phase !== "ready" || !next) return;
    if (send(client, next.wire)) client.inFlight = next.digest;
  }
  function safePump(client: Client): void {
    try { pump(client); } catch (error) { refused(client, errorCode(error)); }
  }
  function announce(room: string): void {
    for (const client of clients) if (client.room === room && client.member && client.phase !== "closed") {
      try { sendRoster(client); } catch (error) { refused(client, errorCode(error)); }
    }
  }
  async function authenticate(client: Client, bytes: Uint8Array): Promise<void> {
    if (client.phase !== "challenge" || now() >= client.challenge.expiresAt) throw new BrokerServerError("expired");
    client.phase = "authenticating"; // consume this socket's one-use challenge before any await.
    const before = store.current(client.room)?.current;
    const auth = await verifyBrokerAuth({ wire: bytes, challenge: client.challenge, ...(before ? { roster: before } : {}) });
    if (stopping || client.phase !== "authenticating" || now() >= client.challenge.expiresAt) throw new BrokerServerError("expired");
    if (auth.initial) {
      if (owners && !owners.has(auth.member)) throw new BrokerServerError("owner_not_allowed");
      store.install(auth.roster, auth.member);
    }
    else if (store.current(client.room)?.current.digest !== auth.roster.digest) throw new BrokerServerError("state_changed");
    const current = store.current(client.room)?.current;
    const member = current?.members.find(row => row.fingerprint === auth.member);
    if (!current || !member || current.digest !== auth.roster.digest) throw new BrokerServerError("untrusted");
    client.member = auth.member; client.key = identityKey(member);
    const previous = members.get(memberKey(client));
    if (previous && previous !== client) close(previous, "replaced");
    members.set(memberKey(client), client);
    client.phase = "roster";
    sendRoster(client);
    emit("connected", client);
  }
  async function message(client: Client, bytes: Uint8Array): Promise<void> {
    if (client.phase === "challenge") return authenticate(client, bytes);
    const current = active(client);
    let type: unknown;
    try { type = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { type?: unknown }).type; } catch { throw new BrokerServerError("invalid_wire"); }
    if (type === "roster") {
      if (client.member !== current.owner) throw new BrokerServerError("not_owner");
      const decoded = decodeRoster(bytes);
      const proof = await verifyPublicRoster({ wire: bytes, pin: { room: current.room, owner: current.owner, minEpoch: current.epoch, digest: current.digest } });
      active(client); // revocation/replacement/shutdown may have happened during verification.
      if (decoded.room !== client.room) throw new BrokerServerError("untrusted");
      const installed = store.install(proof, client.member!);
      if (installed.changed) { announce(client.room); emit("roster_installed", client); }
      control(client, { v: 1, type: "roster_installed", epoch: proof.epoch, digest: proof.digest, changed: installed.changed });
      return;
    }
    if (type === "frame") {
      const header = decodeFrame(bytes), state = store.current(client.room);
      const selected = state && (header.epoch === state.current.epoch ? state.current : state.previous?.roster);
      if (!selected) throw new BrokerServerError("wrong_epoch");
      const proof = await (ports.verifyFrame ?? verifyPublicFrame)({ wire: bytes, roster: selected });
      active(client);
      const result = store.enqueue(proof, client.member!); // latest membership/grace/caps checked transactionally.
      control(client, { v: 1, type: "stored", digest: result.digest, seq: proof.seq, duplicate: result.duplicate });
      for (const recipient of proof.recipients) {
        const target = members.get(`${client.room}|${recipient}`);
        if (target) safePump(target);
      }
      return;
    }
    const packet = decodeBrokerControl(bytes);
    if (packet.type === "auth") throw new BrokerServerError("challenge_used");
    if (packet.type === "roster_ready") {
      const latest = active(client);
      if (packet.digest !== client.rosterDigest || packet.digest !== latest.digest) { sendRoster(client); return; }
      client.phase = "ready"; client.rosterDeadline = undefined;
      safePump(client); return;
    }
    if (packet.digest !== client.inFlight) { refused(client, "unexpected_ack", false); return; }
    active(client);
    store.ack(client.room, client.member!, packet.digest);
    client.inFlight = undefined;
    control(client, { v: 1, type: "queue_ack", digest: packet.digest });
    safePump(client);
  }
  function schedule(client: Client): void {
    if (stopping || client.phase === "closed" || client.busy || !client.inbox.length || verifications >= BROKER_SOCKET_LIMITS.verifications) return;
    const bytes = client.inbox.shift()!;
    client.inboxBytes -= bytes.length; queuedBytes -= bytes.length;
    client.busy = true; verifications++;
    void message(client, bytes).catch(error => {
      if (!stopping && client.phase !== "closed") {
        const code = errorCode(error);
        refused(client, code, !["queue_full", "replay_refused"].includes(code));
      }
    }).finally(() => {
      client.busy = false; verifications--;
      // Bounded per-socket FIFO allows transport ACKs during an awaited outgoing
      // signature check, without concurrent mutation of a socket's auth state.
      for (const waiting of clients) schedule(waiting);
    });
  }
  function receive(client: Client, data: string | Buffer): void {
    if (stopping || client.phase === "closed") return;
    if (typeof data === "string") { refused(client, "binary_required"); return; }
    if (data.byteLength > BROKER_CONTROL_LIMITS.control) { refused(client, "limit"); return; }
    if (client.inbox.length >= BROKER_SOCKET_LIMITS.queuedMessages || client.inboxBytes + data.byteLength > BROKER_SOCKET_LIMITS.queuedBytes || queuedBytes + data.byteLength > BROKER_SOCKET_LIMITS.globalQueuedBytes) { refused(client, "busy"); return; }
    const bytes = Uint8Array.from(data);
    client.inbox.push(bytes); client.inboxBytes += bytes.length; queuedBytes += bytes.length;
    if (client.busy) emit("buffered", client);
    schedule(client);
  }
  let server: ReturnType<typeof Bun.serve<Client>>;
  try {
    server = Bun.serve<Client>({
      hostname, port: requestedPort, maxRequestBodySize: 8192,
      fetch(req, host) {
        try {
          if (req.headers.has("origin")) return new Response("forbidden", { status: 403 });
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname === "/health" && !url.search) return Response.json({ v: 1, status: "ok" });
          if (stopping || req.method !== "GET" || url.search || !url.pathname.startsWith("/v1/rooms/")) return new Response("not found", { status: 404 });
          const room = roomId(url.pathname.slice("/v1/rooms/".length));
          if (clients.size >= BROKER_SOCKET_LIMITS.connections) return new Response("busy", { status: 503 });
          const current = store.current(room)?.current;
          const client: Client = { room, challenge: { v: 1, type: "challenge", room, broker: publicUrl, nonce: encodeBase64url(randomBytes(32)), expiresAt: now() + BROKER_SOCKET_LIMITS.authMs, rosterDigest: current?.digest ?? null }, phase: "challenge", busy: false, inbox: [], inboxBytes: 0 };
          clients.add(client);
          if (host.upgrade(req, { data: client })) return;
          clients.delete(client); return new Response("websocket required", { status: 400 });
        } catch { return new Response("invalid request", { status: 400 }); }
      },
      error() { return new Response("broker error", { status: 500 }); },
      websocket: {
        maxPayloadLength: BROKER_CONTROL_LIMITS.control,
        backpressureLimit: BROKER_SOCKET_LIMITS.backpressureBytes,
        closeOnBackpressureLimit: true, perMessageDeflate: false, idleTimeout: 60, sendPings: true,
        open(ws) { const client = ws.data; client.ws = ws; if (client.phase === "closed") { ws.close(4403, "expired"); return; } send(client, encodeBrokerChallenge(client.challenge)); },
        message(ws, data) { receive(ws.data, data); },
        drain(ws) { if (!stopping && ws.data.phase !== "closed") safePump(ws.data); },
        close(ws) {
          const client = ws.data;
          close(client, "disconnected"); clients.delete(client); emit("disconnected", client);
        },
      },
    });
  } catch { store.close(); throw new BrokerServerError("listen_failed"); }
  publicUrl ||= audience(`ws://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/`);
  let cachedStats = store.stats();
  const stats = () => {
    if (!stopping) cachedStats = store.stats();
    return { ...cachedStats, connections: clients.size, authenticated: members.size, verifications };
  };
  function sweep(): void {
    if (stopping) return;
    try { store.sweep(); } catch { for (const client of clients) close(client, "storage_error"); return; }
    for (const client of clients) {
      if (client.phase === "closed") continue;
      if ((client.phase === "challenge" || client.phase === "authenticating") && now() >= client.challenge.expiresAt) close(client, "expired");
      else if (client.rosterDeadline !== undefined && now() >= client.rosterDeadline) close(client, "roster_timeout");
      else if (client.member) safePump(client);
    }
  }
  const timer = setInterval(sweep, 1000);
  let stoppingPromise: Promise<void> | undefined;
  const stop = () => stoppingPromise ??= (async () => {
    if (stopping) return;
    try { cachedStats = store.stats(); } catch { /* still close a failed store */ }
    stopping = true; clearInterval(timer);
    for (const client of clients) close(client, "stopped");
    try { await server.stop(true); }
    finally {
      try { store.close(); }
      finally { emit("stopped"); resolveClosed(); }
    }
  })();
  emit("started");
  return Object.freeze({ port: server.port!, hostname, publicUrl, closed, stats, sweep, stop });
}
