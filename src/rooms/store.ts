/** Machine-local X3 room identity, epoch pins and durable crypto ports. No network or bus effects. */
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { realPath } from "../hub/project.ts";
import { MAX_HOP, USER } from "../hub/envelope.ts";
import { assertRoomCryptoReady, exportHubIdentityForStorage, generateHubIdentity, importHubIdentity, decodeBase64url, encodeBase64url, sha256, type HubIdentity, type LocalIdentityRecord } from "./crypto.ts";
import { acceptJoin, acceptRoomEpoch, brokerUrl, createRoomEpoch, decodeFrame, decodeInvite, decodeJoin, decodeRoster, positiveU64, roomMembers, type ReplayCommit, type ReplayPort, type SequenceBinding, type SequencePort, type VerifiedEpoch, type RoomMember, type VerifiedPublicRoster, verifyPublicRoster, verifyPublicFrame } from "./wire.ts";
import { decodeRoomMessage, encodeRoomMessage, type RoomChatEnvelope, type RoomMessage, type RoomReceiptReason, parseRemotePeerId } from "./application.ts";

export const ROOM_STORE_LIMITS = Object.freeze({ rooms: 64, invites: 128, pendingJoins: 64, inboxPerRoom: 200, inboxBytes: 16 * 1024 * 1024, receiptsPerRoom: 1000, outboxPerRoom: 200, outboxBytes: 16 * 1024 * 1024, floorsPerRoom: 256, refusedPerRoom: 1000, receiptReservePerRoom: 8, receiptReserveBytes: 1024 });
export type RoomStoreCode = "invalid" | "busy" | "corrupt" | "unsupported" | "limit" | "untrusted" | "state_changed" | "clock_rollback" | "closed" | "inbox_list_limit";
export class RoomStoreError extends Error {
  constructor(readonly code: RoomStoreCode) { super(`Room store: ${code}`); this.name = "RoomStoreError"; }
}
/** Fresh crypto receive reached a physical cap with a canonical receipt that has no outstanding target. */
export class RoomUnmatchedReceiptError extends RoomStoreError {
  constructor() { super("limit"); this.name = "RoomUnmatchedReceiptError"; }
}
/** A fresh authenticated chat reached the ordinary physical cap before any replay or admission write. */
export class RoomFreshChatCapacityError extends RoomStoreError {
  constructor() { super("limit"); this.name = "RoomFreshChatCapacityError"; }
}
export class RoomApplicationLimitError extends RoomStoreError {
  constructor(readonly room: string, readonly count: number) {
    super("limit"); this.name = "RoomApplicationLimitError";
    this.message = `room application cap reached: room ${room}, count ${count}`;
  }
}
function fail(code: RoomStoreCode): never { throw new RoomStoreError(code); }
const DB_NAME = "rooms.db", SCHEMA = 4, GRACE_MS = 60_000;
const ROOM_DB_BUSY_TIMEOUT_MS = 1;
// ponytail: keep at most 256 historical sender floors per room; refuse new senders at the ceiling until versioned archival preserves replay proofs.
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
interface Row { name: string; room: string; broker: string; owner: string; epoch: string; digest: string; wire: Uint8Array; previous_wire: Uint8Array | null; previous_digest: string | null; previous_epoch: string | null; previous_expires: number | null; left: number }
interface InviteRow { name: string; id: string; wire: Uint8Array; digest: string; expires: number; request_digest: string | null }
export interface RoomState { name: string; broker: string; current: VerifiedEpoch; wire: Uint8Array; previous?: { epoch: VerifiedEpoch; expiresAt: number }; left: boolean }
export interface RoomStateMetadata { name: string; room: string; owner: string; member: string; epoch: string; members: number; left: boolean }
export interface RoomInboxEntry { sender: string; seq: string; digest: string; plaintext: Uint8Array; gap: string }
export interface RoomPersonInboxMeta {
  id: string; name: string; room: string; sender: string; from: string; receivedAt: number; expiresAt: number; bytes: number;
  state: "unread" | "done" | "discarded" | "expired";
}
export interface RoomPersonInboxItem extends RoomPersonInboxMeta { body?: string }
export interface RoomPersonInboxAdmission { state: "admitted" | "duplicate" | "refused"; reason: RoomReceiptReason; id?: string }
interface PersonInboxRow {
  id: string; room: string; sender: string; application: string; primary_digest: string; from_peer: string;
  received_at: number; expires_at: number; bytes: number; body: Uint8Array | null;
  state: RoomPersonInboxMeta["state"]; settled_at: number | null;
}
export const ROOM_PERSON_INBOX_LIMITS = Object.freeze({ unreadPerRoom: 100, bodyBytes: 65536, globalBytes: 4 * 1024 * 1024, stubsPerRoom: 1000, ttlMs: 30 * 24 * 60 * 60 * 1000 });
export interface RoomOutgoingInput { deliveryId: string; application: string; remotePeer: string; recipient: string; peer: string; ackTimeoutMs: number; ttlMs: number }
export interface RoomOutgoing {
  digest: string; deliveryId: string; application: string; remotePeer: string; recipient: string; peer: string;
  createdAt: number; expiresAt: number; ackDeadline?: number;
  state: "dispatching" | "accepted" | "completed" | "failed_safe" | "needs_review";
  disposition?: "completed" | "retry" | "discard";
  reason?: RoomReceiptReason; lateReceipt?: { outcome: "completed" | "failed_safe"; reason: RoomReceiptReason };
}
type ApplicationState = "pending" | "dispatching" | "completed" | "failed_safe" | "needs_review" | "disposed";
interface ApplicationRow { room: string; sender: string; application: string; content_hash: string; primary_digest: string; peer: string; trace: string; hop: number; state: ApplicationState; reason: RoomReceiptReason | null; created_at: number; settled_at: number | null; disposition: "accept" | "discard" | null; disposed_at: number | null; disposed_by: "user" | null }
export interface RoomIncomingApplication { sender: string; application: string; peer: string; state: ApplicationState; digest: string; disposition?: "accept" | "discard"; disposedAt?: number; disposedBy?: "user" }
interface OutgoingRow {
  room: string; digest: string; delivery_id: string; application: string; remote_peer: string; recipient: string; peer: string;
  created_at: number; expires_at: number; ack_timeout: number; ack_deadline: number | null; state: RoomOutgoing["state"];
  reason: RoomReceiptReason | null; late_outcome: "completed" | "failed_safe" | null; late_reason: RoomReceiptReason | null; receipt_digest: string | null;
  disposition: "completed" | "retry" | "discard" | null;
}
const APPLICATION_REASONS: readonly RoomReceiptReason[] = ["admitted", "not_exposed", "boundary_refused", "invalid_message", "rate_limited", "hop", "person_inbox_unsupported", "inbox_admitted", "inbox_full", "inbox_oversize", "inbox_expired", "inbox_age_unavailable"];
const APPLICATION_HISTORY_CAP = 1000;
export const ROOM_APPLICATION_RETENTION = Object.freeze({ identitiesPerRoom: 10_000, aliasesPerRoom: 10_000, settledMs: 30 * 24 * 60 * 60 * 1000 });
const isTerminal = (state: string): boolean => state === "completed" || state === "failed_safe";
const isSettledApplication = (state: string): boolean => isTerminal(state) || state === "disposed";
function validOutcome(outcome: unknown, reason: unknown, peer?: string): boolean {
  if (!APPLICATION_REASONS.includes(reason as RoomReceiptReason)) return false;
  if (outcome === "completed") return reason === "inbox_admitted" ? peer === undefined || peer === USER : reason === "admitted" && peer !== USER;
  return outcome === "failed_safe" && reason !== "admitted" && reason !== "inbox_admitted"
    && (!(typeof reason === "string" && reason.startsWith("inbox_")) || peer === undefined || peer === USER);
}
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s|]/.test(value); }
function validUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function outgoing(row: OutgoingRow): RoomOutgoing {
  return { digest: row.digest, deliveryId: row.delivery_id, application: row.application, remotePeer: row.remote_peer, recipient: row.recipient, peer: row.peer,
    createdAt: row.created_at, expiresAt: row.expires_at, ...(row.ack_deadline !== null ? { ackDeadline: row.ack_deadline } : {}), state: row.state,
    ...(row.reason !== null ? { reason: row.reason } : {}), ...(row.disposition !== null ? { disposition: row.disposition } : {}), ...(row.late_outcome !== null ? { lateReceipt: { outcome: row.late_outcome, reason: row.late_reason! } } : {}) };
}
function incomingMetadata(row: ApplicationRow, digestValue = row.primary_digest): RoomIncomingApplication {
  return { sender: row.sender, application: row.application, peer: row.peer, state: row.state, digest: digestValue,
    ...(row.disposition !== null ? { disposition: row.disposition, disposedAt: row.disposed_at!, disposedBy: row.disposed_by! } : {}) };
}
const ROOM_REFUSAL_REASONS = ["invalid_presence", "wrong_epoch", "trust_changed", "stale", "invalid_frame"] as const;
export type RoomRefusalReason = typeof ROOM_REFUSAL_REASONS[number];
export interface RoomRefusal { digest: string; reason: RoomRefusalReason; at: number }
function validDigest(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43) return false;
  try { return encodeBase64url(decodeBase64url(value, 32)) === value; } catch { return false; }
}
function code(error: unknown): RoomStoreCode {
  const value = String(error).toLowerCase();
  return value.includes("locked") || value.includes("busy") ? "busy" : "corrupt";
}
function named(value: string): string { if (!NAME.test(value)) fail("invalid"); return value; }
function assertCurrent(current?: () => boolean): void {
  if (!current) return;
  try { if (current() === true) return; } catch { /* host fence is fail-closed */ }
  fail("state_changed");
}
const copy = (wire: Uint8Array): Uint8Array => Uint8Array.from(wire);
const digest = async (wire: Uint8Array) => encodeBase64url(await sha256(wire));

function validSelection(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const selected: unknown = JSON.parse(value);
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) return false;
    const row = selected as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "label,peers" || typeof row.label !== "string" || !NAME.test(row.label)
      || !Array.isArray(row.peers) || row.peers.length > 64) return false;
    const peers: unknown[] = row.peers;
    return peers.every((peer, index) => typeof peer === "string" && NAME.test(peer) && (index === 0 || String(peers[index - 1]) < peer));
  } catch { return false; }
}

export class RoomStore {
  readonly sequence: SequencePort;
  readonly replay: ReplayPort;
  private readonly rooms = new Map<string, RoomState>();
  private closed = false;
  private constructor(private readonly db: Database, readonly identity: HubIdentity, private readonly clock: () => number) {
    this.sequence = { reserve: async input => this.reserve(input), isCurrent: input => this.isCurrent(input) };
    this.replay = { accept: async input => this.accept(input) };
  }

  static async open(input: { stateDir: string; clock?: () => number }): Promise<RoomStore> {
    await assertRoomCryptoReady();
    const clock = input.clock ?? Date.now;
    let db: Database | undefined;
    try {
      if (existsSync(input.stateDir)) {
        const st = lstatSync(input.stateDir);
        if (!st.isDirectory() || st.isSymbolicLink()) fail("invalid");
        const entries = readdirSync(input.stateDir);
        if (entries.some(x => ![DB_NAME, `${DB_NAME}-journal`].includes(x)) || (entries.length && !entries.includes(DB_NAME))) fail("invalid");
        if ((st.mode & 0o777) !== 0o700 && entries.length) fail("invalid");
      } else mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
      chmodSync(input.stateDir, 0o700);
      const file = join(realPath(input.stateDir), DB_NAME);
      let created = false;
      if (!existsSync(file)) {
        try { const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd); created = true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      }
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) fail("invalid");
      db = new Database(file, { strict: true });
      db.run(`PRAGMA busy_timeout = ${ROOM_DB_BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== SCHEMA) fail("unsupported");
      if (version === 0) {
        if (!created) fail("corrupt");
        db.exec(`
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE rooms (name TEXT PRIMARY KEY, room TEXT NOT NULL UNIQUE, broker TEXT NOT NULL, owner TEXT NOT NULL, epoch TEXT NOT NULL, digest TEXT NOT NULL, wire BLOB NOT NULL, previous_wire BLOB, previous_digest TEXT, previous_epoch TEXT, previous_expires INTEGER, left INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
          CREATE TABLE counters (room TEXT PRIMARY KEY, seq TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE floors (room TEXT NOT NULL, sender TEXT NOT NULL, seq TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(room,sender)) WITHOUT ROWID;
          CREATE TABLE inbox (room TEXT NOT NULL, sender TEXT NOT NULL, seq TEXT NOT NULL, digest TEXT NOT NULL, plaintext BLOB, gap TEXT NOT NULL, UNIQUE(room,sender,seq));
          CREATE INDEX inbox_room ON inbox(room);
          CREATE TABLE invites (name TEXT NOT NULL, id TEXT PRIMARY KEY, wire BLOB NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL, request_digest TEXT) WITHOUT ROWID;
          CREATE TABLE outbox (room TEXT NOT NULL, digest TEXT PRIMARY KEY, wire BLOB NOT NULL, roster BLOB NOT NULL, state TEXT NOT NULL);
          CREATE TABLE pending_joins (name TEXT PRIMARY KEY, invite BLOB NOT NULL, request BLOB NOT NULL, selection TEXT) WITHOUT ROWID;
          CREATE TABLE refusals (room TEXT NOT NULL, digest TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(room,digest));
          PRAGMA user_version=1;
        `);
      }
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 14").all().map(x => x.name).join(",");
      const legacyTables = "counters,floors,inbox,invites,meta,outbox,pending_joins,refusals,rooms";
      if (tables !== (version === 4 ? "application_frames,application_outbox,applications,counters,floors,inbox,invites,meta,outbox,pending_joins,person_inbox,refusals,rooms" : version! >= 2 ? "application_frames,application_outbox,applications," + legacyTables : legacyTables)) fail("unsupported");
      const columns: Record<string, string[]> = {
        meta: ["key", "value"],
        rooms: ["name", "room", "broker", "owner", "epoch", "digest", "wire", "previous_wire", "previous_digest", "previous_epoch", "previous_expires", "left"],
        counters: ["room", "seq"], floors: ["room", "sender", "seq", "digest"],
        inbox: ["room", "sender", "seq", "digest", "plaintext", "gap", ...(version! >= 3 ? ["receipt_reserve"] : []), ...(version === 4 ? ["received_at"] : [])],
        invites: ["name", "id", "wire", "digest", "expires", "request_digest"],
        outbox: ["room", "digest", "wire", "roster", "state"], pending_joins: ["name", "invite", "request", "selection"], refusals: ["room", "digest", "reason", "at"],
      };
      for (const [table, names] of Object.entries(columns)) {
        if (db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(x => x.name).join(",") !== names.join(",")) fail("unsupported");
      }
      if (version! < 2) db.exec(`
        CREATE TABLE application_outbox (room TEXT NOT NULL, digest TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, application TEXT NOT NULL, remote_peer TEXT NOT NULL, recipient TEXT NOT NULL, peer TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ack_timeout INTEGER NOT NULL, ack_deadline INTEGER, state TEXT NOT NULL, reason TEXT, late_outcome TEXT, late_reason TEXT, receipt_digest TEXT, disposition TEXT);
        CREATE INDEX application_outbox_room ON application_outbox(room);
        CREATE UNIQUE INDEX application_outbox_delivery ON application_outbox(room,delivery_id);
        CREATE TABLE applications (room TEXT NOT NULL, sender TEXT NOT NULL, application TEXT NOT NULL, content_hash TEXT NOT NULL, primary_digest TEXT NOT NULL, peer TEXT NOT NULL, trace TEXT NOT NULL, hop INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, settled_at INTEGER, disposition TEXT, disposed_at INTEGER, disposed_by TEXT, PRIMARY KEY(room,sender,application)) WITHOUT ROWID;
        CREATE INDEX applications_retention ON applications(room,settled_at);
        CREATE INDEX applications_trace ON applications(trace,hop);
        CREATE INDEX applications_status ON applications(room,state,created_at,primary_digest);
        CREATE INDEX applications_disposition ON applications(room,state,disposed_at);
        CREATE TABLE application_frames (room TEXT NOT NULL, digest TEXT NOT NULL, sender TEXT NOT NULL, application TEXT NOT NULL, PRIMARY KEY(room,digest)) WITHOUT ROWID;
        PRAGMA user_version=2;
      `);
      const applicationColumns: Record<string, string[]> = {
        application_outbox: ["room", "digest", "delivery_id", "application", "remote_peer", "recipient", "peer", "created_at", "expires_at", "ack_timeout", "ack_deadline", "state", "reason", "late_outcome", "late_reason", "receipt_digest", "disposition"],
        applications: ["room", "sender", "application", "content_hash", "primary_digest", "peer", "trace", "hop", "state", "reason", "created_at", "settled_at", "disposition", "disposed_at", "disposed_by"],
        application_frames: ["room", "digest", "sender", "application"],
      };
      for (const [table, names] of Object.entries(applicationColumns)) {
        if (db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(x => x.name).join(",") !== names.join(",")) fail("unsupported");
      }
      for (const [index, names] of Object.entries({ application_outbox_room: ["room"], application_outbox_delivery: ["room", "delivery_id"], applications_retention: ["room", "settled_at"], applications_trace: ["trace", "hop"], applications_status: ["room", "state", "created_at", "primary_digest"], applications_disposition: ["room", "state", "disposed_at"] })) {
        if (db.query<{ name: string }, []>(`PRAGMA index_info(${index})`).all().map(x => x.name).join(",") !== names.join(",")) fail("unsupported");
      }
      if (db.query<{ name: string; unique: number }, []>("PRAGMA index_list(application_outbox)").all().find(row => row.name === "application_outbox_delivery")?.unique !== 1) fail("unsupported");
      if (version! < 3) {
        // Legacy readers must refuse the extra lane. Legacy payload JSON never manufactures a reserved admission.
        if (db.query("SELECT 1 FROM application_outbox WHERE typeof(created_at)!='integer' OR typeof(ack_timeout)!='integer' OR (ack_deadline IS NOT NULL AND (typeof(ack_deadline)!='integer' OR ack_deadline<created_at)) LIMIT 1").get()) fail("corrupt");
        db.exec("UPDATE application_outbox SET ack_deadline=CASE WHEN ack_deadline IS NULL THEN created_at+ack_timeout ELSE MIN(ack_deadline,created_at+ack_timeout) END;");
        db.exec("ALTER TABLE inbox ADD COLUMN receipt_reserve INTEGER NOT NULL DEFAULT 0 CHECK (receipt_reserve IN (0,1)); PRAGMA user_version=3;");
      }
      if (version! < 4) db.exec(`
        ALTER TABLE inbox ADD COLUMN received_at INTEGER;
        CREATE TABLE person_inbox (id TEXT PRIMARY KEY, room TEXT NOT NULL, sender TEXT NOT NULL, application TEXT NOT NULL, primary_digest TEXT NOT NULL, from_peer TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL, body BLOB, state TEXT NOT NULL, settled_at INTEGER);
        CREATE UNIQUE INDEX person_inbox_identity ON person_inbox(room,sender,application);
        CREATE INDEX person_inbox_room ON person_inbox(room,state,received_at,id);
        CREATE INDEX person_inbox_retention ON person_inbox(state,settled_at);
        PRAGMA user_version=4;
      `);
      const personColumns = ["id", "room", "sender", "application", "primary_digest", "from_peer", "received_at", "expires_at", "bytes", "body", "state", "settled_at"];
      if (db.query<{ name: string }, []>("PRAGMA table_info(person_inbox)").all().map(row => row.name).join(",") !== personColumns.join(",")) fail("unsupported");
      for (const [index, fields] of Object.entries({ person_inbox_room: ["room", "state", "received_at", "id"], person_inbox_retention: ["state", "settled_at"], person_inbox_identity: ["room", "sender", "application"] })) {
        if (db.query<{ name: string }, []>(`PRAGMA index_info(${index})`).all().map(row => row.name).join(",") !== fields.join(",")) fail("unsupported");
      }
      if (db.query<{ name: string; unique: number }, []>("PRAGMA index_list(person_inbox)").all().find(row => row.name === "person_inbox_identity")?.unique !== 1) fail("unsupported");
      if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().some(x => x.quick_check !== "ok")) fail("corrupt");
      const meta = db.query<{ key: string; n: number }, []>("SELECT key,length(value) AS n FROM meta LIMIT 4").all();
      if (meta.length > 2 || meta.some(row => !["identity", "clock"].includes(row.key) || row.n > (row.key === "identity" ? 4096 : 32))) fail("corrupt");
      if (!created && (!meta.some(row => row.key === "identity") || !meta.some(row => row.key === "clock"))) fail("corrupt");
      let identity: HubIdentity;
      const stored = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='identity'").get();
      if (stored) identity = await importHubIdentity(JSON.parse(stored.value) as LocalIdentityRecord);
      else {
        if (!created) fail("corrupt");
        identity = await generateHubIdentity();
        db.query("INSERT INTO meta(key,value) VALUES('identity',?)").run(JSON.stringify(await exportHubIdentityForStorage(identity)));
      }
      db.exec("COMMIT;");
      const store = new RoomStore(db, identity, clock);
      store.transaction(() => undefined);
      if ((db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rooms").get()?.n ?? 0) > ROOM_STORE_LIMITS.rooms
        || db.query("SELECT 1 FROM rooms WHERE length(name)>32 OR length(room)>43 OR length(broker)>2048 OR length(owner)>64 OR length(epoch)>20 OR length(digest)>43 OR length(previous_epoch)>20 OR length(previous_digest)>43 OR length(wire)>524288 OR length(previous_wire)>524288 LIMIT 1").get()) fail("corrupt");
      const rows = db.query<Row, []>("SELECT * FROM rooms ORDER BY name LIMIT 65").all();
      if (rows.length > ROOM_STORE_LIMITS.rooms) fail("corrupt");
      for (const row of rows) {
        named(row.name);
        if (!(row.wire instanceof Uint8Array) || row.wire.length > 524288 || brokerUrl(row.broker) !== row.broker || ![0, 1].includes(row.left)) fail("corrupt");
        const current = await acceptRoomEpoch({ wire: row.wire, identity, pin: { room: row.room, owner: row.owner, minEpoch: row.epoch, digest: row.digest } });
        let previous: RoomState["previous"];
        const fields = [row.previous_wire, row.previous_digest, row.previous_epoch, row.previous_expires];
        if (fields.some(x => x !== null)) {
          if (fields.some(x => x === null) || !Number.isSafeInteger(row.previous_expires) || row.previous_expires! <= 0 || row.previous_expires! > store.now() + GRACE_MS || BigInt(row.previous_epoch!) + 1n !== BigInt(row.epoch)) fail("corrupt");
          const epoch = await acceptRoomEpoch({ wire: row.previous_wire!, identity, pin: { room: row.room, owner: row.owner, minEpoch: row.previous_epoch!, digest: row.previous_digest! } });
          previous = { epoch, expiresAt: row.previous_expires! };
        }
        store.rooms.set(row.name, { name: row.name, broker: row.broker, current, wire: copy(row.wire), ...(previous ? { previous } : {}), left: row.left === 1 });
      }
      try { await store.validateRows(); }
      catch { fail("corrupt"); }
      store.recoverApplications();
      store.expirePersonInbox();
      return store;
    } catch (e) {
      try { db?.exec("ROLLBACK;"); } catch { /* no transaction */ }
      try { db?.close(); } catch { /* preserve fixed refusal */ }
      if (e instanceof RoomStoreError) throw e;
      throw new RoomStoreError(code(e));
    }
  }

  /** Restore validates bounded rows before any sequence, replay or transport port is published. */
  private async validateRows(): Promise<void> {
    const limits = ROOM_STORE_LIMITS;
    const cap = (table: string, maximum: number) => {
      const count = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
      if (!Number.isSafeInteger(count) || count > maximum) fail("corrupt");
    };
    cap("counters", limits.rooms); cap("floors", limits.rooms * limits.floorsPerRoom);
    cap("inbox", limits.rooms * (limits.receiptsPerRoom + limits.inboxPerRoom + limits.receiptReservePerRoom));
    cap("outbox", limits.rooms * limits.outboxPerRoom); cap("invites", limits.invites); cap("pending_joins", limits.pendingJoins); cap("refusals", limits.rooms * limits.refusedPerRoom);
    const groupCap = (table: string, filter: string, maximum: number) => {
      if (this.db.query<{ room: string }, [number]>(`SELECT room FROM ${table} ${filter} GROUP BY room HAVING COUNT(*)>? LIMIT 1`).get(maximum)) fail("corrupt");
    };
    groupCap("floors", "", limits.floorsPerRoom);
    groupCap("inbox", "WHERE plaintext IS NOT NULL AND receipt_reserve=0", limits.inboxPerRoom);
    groupCap("inbox", "WHERE plaintext IS NOT NULL AND receipt_reserve=1", limits.receiptReservePerRoom);
    groupCap("inbox", "WHERE plaintext IS NULL", limits.receiptsPerRoom);
    groupCap("outbox", "", limits.outboxPerRoom);
    groupCap("refusals", "", limits.refusedPerRoom);
    const metadataBounds: Record<string, string> = {
      counters: "length(room)>43 OR length(seq)>20",
      floors: "length(room)>43 OR length(sender)>64 OR length(seq)>20 OR length(digest)>43",
      inbox: "length(room)>43 OR length(sender)>64 OR length(seq)>20 OR length(digest)>43 OR length(gap)>20",
      invites: "length(name)>32 OR length(id)>43 OR length(digest)>43 OR length(request_digest)>43",
      outbox: "length(room)>43 OR length(digest)>43 OR length(state)>16",
      pending_joins: "length(name)>32",
      refusals: "length(room)>43 OR length(digest)>43 OR length(reason)>32",
    };
    for (const [table, condition] of Object.entries(metadataBounds)) {
      if (this.db.query(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get()) fail("corrupt");
    }
    const blob = (value: unknown, maximum: number): Uint8Array => {
      if (!(value instanceof Uint8Array) || value.byteLength > maximum || value.byteLength === 0) fail("corrupt");
      return value;
    };
    const fp = (value: unknown): string => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("corrupt");
      return value;
    };
    const hash = (value: unknown): string => {
      if (typeof value !== "string" || encodeBase64url(decodeBase64url(value, 32)) !== value) fail("corrupt");
      return value;
    };
    const room = (value: string): RoomState => this.byRoom(value) ?? fail("corrupt");
    const bodyBytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox WHERE receipt_reserve=0").get()?.n ?? 0;
    const reservedBytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox WHERE receipt_reserve=1").get()?.n ?? 0;
    const outboxBytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(wire)+length(roster)),0) AS n FROM outbox").get()?.n ?? 0;
    if (bodyBytes > limits.inboxBytes || reservedBytes > limits.rooms * limits.receiptReservePerRoom * limits.receiptReserveBytes || outboxBytes > limits.outboxBytes) fail("corrupt");
    if (this.db.query("SELECT 1 FROM inbox WHERE typeof(receipt_reserve)!='integer' OR receipt_reserve NOT IN (0,1) OR length(plaintext)>65536 OR (receipt_reserve=1 AND length(plaintext)>1024) LIMIT 1").get()
      || this.db.query("SELECT 1 FROM outbox WHERE length(wire)>131072 OR length(roster)>524288 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM invites WHERE length(wire)>16384 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM pending_joins WHERE length(invite)>16384 OR length(request)>16384 OR length(selection)>4096 LIMIT 1").get()) fail("corrupt");
    const counters = new Map<string, string>();
    for (const row of this.db.query<{ room: string; seq: string }, []>("SELECT room,seq FROM counters LIMIT 65").all()) {
      room(row.room); counters.set(row.room, positiveU64(row.seq));
    }
    const floors = new Map<string, { seq: string; digest: string }>();
    for (const row of this.db.query<{ room: string; sender: string; seq: string; digest: string }, []>(`SELECT room,sender,seq,digest FROM floors LIMIT ${limits.rooms * limits.floorsPerRoom + 1}`).all()) {
      room(row.room); fp(row.sender); positiveU64(row.seq); hash(row.digest);
      // Removed senders keep their floor. Current membership is checked at acceptance, not retroactively imposed on history.
      floors.set(`${row.room}|${row.sender}`, { seq: row.seq, digest: row.digest });
    }
    for (const row of this.db.query<{ room: string; sender: string; seq: string; digest: string; plaintext: Uint8Array | null; gap: string; receipt_reserve: number; received_at: number | null }, []>(`SELECT room,sender,seq,digest,plaintext,gap,receipt_reserve,received_at FROM inbox LIMIT ${limits.rooms * (limits.receiptsPerRoom + limits.inboxPerRoom + limits.receiptReservePerRoom) + 1}`).all()) {
      room(row.room); fp(row.sender); positiveU64(row.seq); hash(row.digest);
      if (row.received_at !== null && (!Number.isSafeInteger(row.received_at) || row.received_at <= 0 || row.received_at > this.now())) fail("corrupt");
      if (typeof row.gap !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(row.gap) || BigInt(row.gap) >= BigInt(row.seq)) fail("corrupt");
      if (row.plaintext !== null && (!(row.plaintext instanceof Uint8Array) || row.plaintext.length > 65536)) fail("corrupt");
      // This private host-issued marker is preserved across completion; never reconstruct it from JSON or current outbox state.
      if (row.receipt_reserve === 1 && row.plaintext !== null && decodeRoomMessage(row.plaintext).type !== "receipt") fail("corrupt");
      const floor = floors.get(`${row.room}|${row.sender}`);
      if (!floor || BigInt(floor.seq) < BigInt(row.seq) || (floor.seq === row.seq && floor.digest !== row.digest)) fail("corrupt");
    }
    const proofs = new Map<string, VerifiedPublicRoster>();
    for (const row of this.db.query<{ room: string; digest: string; wire: Uint8Array; roster: Uint8Array; state: string }, []>(`SELECT room,digest,wire,roster,state FROM outbox LIMIT ${limits.rooms * limits.outboxPerRoom + 1}`).all()) {
      const installed = room(row.room), own = this.identity.public;
      hash(row.digest); blob(row.wire, 131072); blob(row.roster, 524288);
      if (!["dispatching", "accepted"].includes(row.state)) fail("corrupt");
      const rosterHash = await digest(row.roster);
      let proof = proofs.get(rosterHash);
      if (!proof) {
        proof = await verifyPublicRoster({ wire: row.roster, pin: { room: row.room, owner: decodeRoster(installed.wire).owner, minEpoch: "0" } });
        proofs.set(rosterHash, proof);
      }
      if (proof.room !== row.room || BigInt(proof.epoch) > BigInt(installed.current.epoch)
        || (proof.epoch === installed.current.epoch && proof.digest !== installed.current.digest)
        || (proof.epoch === installed.previous?.epoch.epoch && proof.digest !== installed.previous.epoch.digest)) fail("corrupt");
      const sender = proof.members.find(member => member.fingerprint === own.fingerprint);
      if (!sender || sender.signingKey !== own.signingKey || sender.agreementKey !== own.agreementKey) fail("corrupt");
      const frame = await verifyPublicFrame({ wire: row.wire, roster: proof });
      const reserved = counters.get(row.room);
      if (frame.digest !== row.digest || frame.sender !== own.fingerprint || !reserved || BigInt(frame.seq) > BigInt(reserved)) fail("corrupt");
    }
    for (const row of this.db.query<InviteRow, []>(`SELECT * FROM invites LIMIT ${limits.invites + 1}`).all()) {
      const installed = this.rooms.get(row.name); if (!installed) fail("corrupt");
      const invite = decodeInvite(blob(row.wire, 16384));
      if (invite.owner !== this.identity.public.fingerprint || invite.owner !== decodeRoster(installed.wire).owner
        || invite.room !== installed.current.room || invite.broker !== installed.broker || invite.inviteId !== row.id || invite.expiresAt !== row.expires || await digest(row.wire) !== hash(row.digest)) fail("corrupt");
      if (row.request_digest !== null) hash(row.request_digest);
    }
    for (const row of this.db.query<{ room: string; digest: string; reason: RoomRefusalReason; at: number }, []>(`SELECT room,digest,reason,at FROM refusals LIMIT ${limits.rooms * limits.refusedPerRoom + 1}`).all()) {
      room(row.room); hash(row.digest);
      if (!ROOM_REFUSAL_REASONS.includes(row.reason) || !Number.isSafeInteger(row.at) || row.at <= 0 || row.at > this.now()) fail("corrupt");
    }
    for (const row of this.db.query<{ name: string; invite: Uint8Array; request: Uint8Array; selection: string | null }, []>(`SELECT * FROM pending_joins LIMIT ${limits.pendingJoins + 1}`).all()) {
      named(row.name); if (this.rooms.has(row.name)) fail("corrupt");
      const invite = decodeInvite(blob(row.invite, 16384)), request = decodeJoin(blob(row.request, 16384)), own = this.identity.public;
      if (request.room !== invite.room || request.owner !== invite.owner || request.inviteId !== invite.inviteId
        || request.member.fingerprint !== own.fingerprint || request.member.signingKey !== own.signingKey || request.member.agreementKey !== own.agreementKey) fail("corrupt");
      if (!validSelection(row.selection)) fail("corrupt");
    }
    await this.validateApplications();
    await this.validatePersonInbox();
  }

  private async validateApplications(): Promise<void> {
    const maximum = ROOM_STORE_LIMITS.rooms, now = this.now();
    const caps = { application_outbox: maximum * (ROOM_STORE_LIMITS.outboxPerRoom + APPLICATION_HISTORY_CAP), applications: maximum * ROOM_APPLICATION_RETENTION.identitiesPerRoom, application_frames: maximum * ROOM_APPLICATION_RETENTION.aliasesPerRoom };
    for (const [table, cap] of Object.entries(caps)) {
      const count = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
      if (!Number.isSafeInteger(count) || count > cap) fail("corrupt");
    }
    for (const [table, maximumPerRoom] of [["application_outbox", ROOM_STORE_LIMITS.outboxPerRoom + APPLICATION_HISTORY_CAP], ["applications", ROOM_APPLICATION_RETENTION.identitiesPerRoom], ["application_frames", ROOM_APPLICATION_RETENTION.aliasesPerRoom]] as const) {
      if (this.db.query<{ room: string }, [number]>(`SELECT room FROM ${table} GROUP BY room HAVING COUNT(*)>? LIMIT 1`).get(maximumPerRoom)) fail("corrupt");
    }
    if (this.db.query("SELECT room FROM application_outbox WHERE state IN ('completed','failed_safe') OR disposition IS NOT NULL GROUP BY room HAVING COUNT(*)>1000 LIMIT 1").get()
      || this.db.query("SELECT room FROM applications WHERE state IN ('pending','dispatching') GROUP BY room HAVING COUNT(*)>200 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM application_outbox WHERE length(room)>43 OR length(digest)>43 OR length(delivery_id)>256 OR length(application)>256 OR length(remote_peer)>65 OR length(recipient)>64 OR length(peer)>32 OR length(state)>16 OR length(reason)>32 OR length(late_outcome)>16 OR length(late_reason)>32 OR length(receipt_digest)>43 OR length(disposition)>16 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM applications WHERE length(room)>43 OR length(sender)>64 OR length(application)>256 OR length(content_hash)>43 OR length(primary_digest)>43 OR length(peer)>32 OR length(trace)>36 OR length(state)>16 OR length(reason)>32 OR length(disposition)>8 OR length(disposed_by)>4 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM application_frames WHERE length(room)>43 OR length(digest)>43 OR length(sender)>64 OR length(application)>256 LIMIT 1").get()) fail("corrupt");
    const applications = new Map<string, ApplicationRow>();
    for (const row of this.db.query<ApplicationRow, []>(`SELECT * FROM applications LIMIT ${caps.applications + 1}`).all()) {
      if (!this.byRoom(row.room) || !/^[a-f0-9]{64}$/.test(row.sender) || !validUuid(row.application) || !validDigest(row.content_hash) || !validDigest(row.primary_digest) || !NAME.test(row.peer)
        || !validUuid(row.trace) || !Number.isSafeInteger(row.hop) || row.hop < 0 || row.hop > MAX_HOP
        || !["pending", "dispatching", "completed", "failed_safe", "needs_review", "disposed"].includes(row.state)
        || !Number.isSafeInteger(row.created_at) || row.created_at <= 0 || row.created_at > now) fail("corrupt");
      if (!this.db.query("SELECT 1 FROM floors WHERE room=? AND sender=?").get(row.room, row.sender)) fail("corrupt");
      if (row.state === "disposed") {
        if (!["accept", "discard"].includes(row.disposition!) || row.disposed_by !== "user" || row.reason !== null || !Number.isSafeInteger(row.disposed_at)
          || row.disposed_at! < row.created_at || row.disposed_at! > now || row.settled_at !== row.disposed_at) fail("corrupt");
      } else if (row.disposition !== null || row.disposed_at !== null || row.disposed_by !== null) fail("corrupt");
      if (isTerminal(row.state)) {
        if (!validOutcome(row.state, row.reason, row.peer) || !Number.isSafeInteger(row.settled_at) || row.settled_at! < row.created_at || row.settled_at! > now) fail("corrupt");
      } else if (row.state !== "disposed" && (row.reason !== null || row.settled_at !== null)) fail("corrupt");
      const entry = this.db.query<RoomInboxEntry, [string, string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND digest=?").get(row.room, row.primary_digest);
      if (row.state === "pending" || row.state === "dispatching") {
        if (!entry || entry.sender !== row.sender || !(entry.plaintext instanceof Uint8Array)) fail("corrupt");
        const message = decodeRoomMessage(entry.plaintext);
        if (message.type !== "chat" || message.envelope.id !== row.application || message.envelope.to !== row.peer || message.envelope.trace !== row.trace || message.envelope.hop !== row.hop || await digest(encodeRoomMessage(message)) !== row.content_hash) fail("corrupt");
      } else if (entry && entry.plaintext !== null) fail("corrupt");
      applications.set(`${row.room}|${row.sender}|${row.application}`, row);
    }
    const primary = new Set<string>();
    for (const row of this.db.query<{ room: string; digest: string; sender: string; application: string }, []>(`SELECT * FROM application_frames LIMIT ${caps.application_frames + 1}`).all()) {
      const app = applications.get(`${row.room}|${row.sender}|${row.application}`);
      if (!app || !validDigest(row.digest)) fail("corrupt");
      const entry = this.db.query<{ sender: string; plaintext: Uint8Array | null }, [string, string]>("SELECT sender,plaintext FROM inbox WHERE room=? AND digest=?").get(row.room, row.digest);
      if (entry && (entry.sender !== row.sender || (isSettledApplication(app.state) || app.state === "needs_review") && entry.plaintext !== null)) fail("corrupt");
      if (app.primary_digest === row.digest) primary.add(`${row.room}|${row.sender}|${row.application}`);
    }
    if (primary.size !== applications.size) fail("corrupt");
    for (const row of this.db.query<OutgoingRow, []>(`SELECT * FROM application_outbox LIMIT ${caps.application_outbox + 1}`).all()) {
      if (!this.byRoom(row.room) || !validDigest(row.digest) || !boundedId(row.delivery_id) || !boundedId(row.application) || !NAME.test(row.peer)
        || typeof row.remote_peer !== "string" || !new RegExp(`^${row.peer}@[a-z][a-z0-9-]{0,31}$`).test(row.remote_peer) || !/^[a-f0-9]{64}$/.test(row.recipient)
        || !["dispatching", "accepted", "completed", "failed_safe", "needs_review"].includes(row.state)
        || !Number.isSafeInteger(row.created_at) || row.created_at <= 0 || row.created_at > now || !Number.isSafeInteger(row.expires_at)
        || row.expires_at <= row.created_at || row.expires_at - row.created_at > 604_800_000
        || !Number.isSafeInteger(row.ack_timeout) || row.ack_timeout < 1 || row.ack_timeout > 86_400_000) fail("corrupt");
      if (!Number.isSafeInteger(row.ack_deadline) || row.ack_deadline! < row.created_at || row.ack_deadline! > row.created_at + row.ack_timeout) fail("corrupt");
      if (isTerminal(row.state) ? !validOutcome(row.state, row.reason, row.peer) : row.reason !== null) fail("corrupt");
      if (row.disposition !== null && (row.state !== "needs_review" || !["completed", "retry", "discard"].includes(row.disposition))) fail("corrupt");
      if (row.late_outcome !== null ? row.state !== "needs_review" || !validOutcome(row.late_outcome, row.late_reason, row.peer) : row.late_reason !== null) fail("corrupt");
      if ((isTerminal(row.state) || row.late_outcome !== null) ? !validDigest(row.receipt_digest) : row.receipt_digest !== null) fail("corrupt");
      const sealed = this.db.query<{ wire: Uint8Array; room: string }, [string]>("SELECT wire,room FROM outbox WHERE digest=?").get(row.digest);
      if (isTerminal(row.state) || row.disposition !== null) { if (sealed) fail("corrupt"); }
      else {
        if (!sealed || sealed.room !== row.room) fail("corrupt");
        const frame = decodeFrame(sealed.wire);
        if (frame.recipients.length !== 1 || frame.recipients[0] !== row.recipient) fail("corrupt");
      }
    }
  }

  private async validatePersonInbox(): Promise<void> {
    const limits = ROOM_PERSON_INBOX_LIMITS, now = this.now(), maximum = ROOM_STORE_LIMITS.rooms * (limits.unreadPerRoom + limits.stubsPerRoom);
    const count = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM person_inbox").get()?.n ?? 0;
    const bytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(bytes),0) AS n FROM person_inbox WHERE body IS NOT NULL").get()?.n ?? 0;
    if (!Number.isSafeInteger(count) || count > maximum || !Number.isSafeInteger(bytes) || bytes > limits.globalBytes
      || this.db.query("SELECT room FROM person_inbox WHERE state='unread' GROUP BY room HAVING COUNT(*)>100 LIMIT 1").get()
      || this.db.query("SELECT room FROM person_inbox WHERE state!='unread' GROUP BY room HAVING COUNT(*)>1000 LIMIT 1").get()
      || this.db.query("SELECT 1 FROM person_inbox WHERE length(id)>36 OR length(room)>43 OR length(sender)>64 OR length(application)>36 OR length(primary_digest)>43 OR length(from_peer)>65 OR length(body)>65536 OR length(state)>9 LIMIT 1").get()) fail("corrupt");
    const ids = new Set<string>(), keys = new Set<string>();
    for (const row of this.db.query<PersonInboxRow, []>(`SELECT * FROM person_inbox LIMIT ${maximum + 1}`).all()) {
      const room = this.byRoom(row.room), from = parseRemotePeerId(row.from_peer), key = `${row.room}|${row.sender}|${row.application}`;
      if (!room || !validUuid(row.id) || ids.has(row.id) || keys.has(key) || !/^[a-f0-9]{64}$/.test(row.sender) || !validUuid(row.application) || !validDigest(row.primary_digest) || !from
        || !Number.isSafeInteger(row.received_at) || row.received_at <= 0 || row.received_at > now || !Number.isSafeInteger(row.expires_at) || row.expires_at !== row.received_at + limits.ttlMs
        || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.bodyBytes || !["unread", "done", "discarded", "expired"].includes(row.state)) fail("corrupt");
      ids.add(row.id); keys.add(key);
      const app = this.applicationFor(row.room, row.primary_digest);
      if (!app || app.primary_digest !== row.primary_digest || app.sender !== row.sender || app.application !== row.application || app.peer !== USER || app.state !== "completed" || app.reason !== "inbox_admitted"
        || row.received_at > app.created_at || app.settled_at === null || app.settled_at >= row.expires_at) fail("corrupt");
      if (row.state === "unread") {
        if (row.settled_at !== null || !(row.body instanceof Uint8Array)) fail("corrupt");
        const message = decodeRoomMessage(row.body);
        if (message.type !== "chat" || message.envelope.to !== USER || message.envelope.id !== app.application || message.envelope.from !== from.peer
          || message.envelope.trace !== app.trace || message.envelope.hop !== app.hop || Buffer.byteLength(message.envelope.body, "utf8") !== row.bytes
          || await digest(encodeRoomMessage(message)) !== app.content_hash) fail("corrupt");
      } else if (row.body !== null || !Number.isSafeInteger(row.settled_at) || row.settled_at! < app.settled_at || row.settled_at! > now
        || (row.state === "expired" ? row.settled_at !== row.expires_at : row.settled_at! >= row.expires_at)) fail("corrupt");
    }
  }

  private assertOpen(): void { if (this.closed) fail("closed"); }
  private now(): number {
    this.assertOpen();
    const now = this.clock();
    const rawLast = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='clock'").get()?.value;
    if (rawLast !== undefined && (typeof rawLast !== "string" || !/^[1-9][0-9]{0,15}$/.test(rawLast))) fail("corrupt");
    const last = Number(rawLast ?? "0");
    if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(last)) fail("invalid");
    if (now < last) fail("clock_rollback");
    return now;
  }
  private transaction<T>(fn: (now: number) => T): T {
    this.assertOpen();
    try { return this.db.transaction(() => {
      const now = this.now();
      const result = fn(now);
      this.db.query("INSERT INTO meta(key,value) VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
      return result;
    })(); } catch (e) { if (e instanceof RoomStoreError) throw e; throw new RoomStoreError(code(e)); }
  }
  private snapshot(value: RoomState): RoomState {
    return { ...value, wire: copy(value.wire), ...(value.previous ? { previous: { ...value.previous } } : {}) };
  }
  private readonly statusEpochs = new WeakMap<VerifiedEpoch, { owner: string; members: number }>();
  /** Loaded identity metadata only. Repeated polling never clones a wire or opens application history. */
  statusMetadata(): RoomStateMetadata[] {
    this.now();
    return [...this.rooms.values()].map(value => {
      let epoch = this.statusEpochs.get(value.current);
      if (!epoch) {
        epoch = { owner: decodeRoster(value.wire).owner, members: roomMembers(value.current).length };
        this.statusEpochs.set(value.current, epoch);
      }
      return { name: value.name, room: value.current.room, owner: epoch.owner, member: this.identity.public.fingerprint,
        epoch: value.current.epoch, members: epoch.members, left: value.left };
    });
  }
  list(): RoomState[] { this.now(); return [...this.rooms.values()].map(x => this.snapshot(x)); }
  get(name: string): RoomState | undefined { this.now(); const state = this.rooms.get(named(name)); return state && this.snapshot(state); }
  private byRoom(room: string): RoomState | undefined { return [...this.rooms.values()].find(x => x.current.room === room); }

  /** Pending enrollment is explicit local person authority; a roster can never establish its own owner pin. */
  savePendingJoin(name: string, input: { invite: Uint8Array; request: Uint8Array; selection?: string }): void {
    named(name); if (!validSelection(input.selection)) fail("invalid");
    const invite = decodeInvite(input.invite), request = decodeJoin(input.request);
    if (request.member.fingerprint !== this.identity.public.fingerprint || request.member.signingKey !== this.identity.public.signingKey || request.member.agreementKey !== this.identity.public.agreementKey || request.room !== invite.room || request.owner !== invite.owner || request.inviteId !== invite.inviteId || this.rooms.has(name)) fail("untrusted");
    this.transaction(now => {
      if (now > invite.expiresAt + 600000) fail("untrusted");
      for (const row of this.db.query<{ name: string; invite: Uint8Array }, []>("SELECT name,invite FROM pending_joins LIMIT 65").all()) {
        if (now > decodeInvite(row.invite).expiresAt + 600000) this.db.query("DELETE FROM pending_joins WHERE name=?").run(row.name);
      }
      const old = this.db.query<{ invite: Uint8Array; request: Uint8Array }, [string]>("SELECT invite,request FROM pending_joins WHERE name=?").get(name);
      if (old) {
        if (Buffer.compare(Buffer.from(old.invite), Buffer.from(input.invite)) || Buffer.compare(Buffer.from(old.request), Buffer.from(input.request))) fail("state_changed");
        return;
      }
      if ((this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pending_joins").get()?.n ?? 0) >= ROOM_STORE_LIMITS.pendingJoins) fail("limit");
      this.db.query("INSERT INTO pending_joins(name,invite,request,selection) VALUES(?,?,?,?)").run(name, input.invite, input.request, input.selection ?? null);
    });
  }
  cancelPendingJoin(name: string): void {
    named(name);
    this.transaction(() => { this.db.query("DELETE FROM pending_joins WHERE name=?").run(name); });
  }
  pendingJoin(name: string): { invite: Uint8Array; request: Uint8Array; selection?: string } | undefined {
    this.now(); named(name);
    const row = this.db.query<{ invite: Uint8Array; request: Uint8Array; selection: string | null }, [string]>("SELECT invite,request,selection FROM pending_joins WHERE name=?").get(name);
    return row ? { invite: copy(row.invite), request: copy(row.request), ...(row.selection !== null ? { selection: row.selection } : {}) } : undefined;
  }

  private prepareInstall(name: string, broker: string, wire: Uint8Array, expectedDigest: string | null): { previous?: RoomState; pin: { room: string; owner: string; minEpoch: string; digest?: string } } {
    named(name); if (brokerUrl(broker) !== broker) fail("invalid");
    const previous = this.rooms.get(name), roster = decodeRoster(wire);
    if ((previous?.current.digest ?? null) !== expectedDigest || (previous && (previous.current.room !== roster.room || previous.broker !== broker))) fail("state_changed");
    if (previous) return { previous, pin: { room: previous.current.room, owner: decodeRoster(previous.wire).owner, minEpoch: previous.current.epoch, digest: previous.current.digest } };
    if (roster.owner !== this.identity.public.fingerprint) {
      const pending = this.pendingJoin(name); if (!pending) fail("untrusted");
      const invite = decodeInvite(pending.invite);
      if (invite.room !== roster.room || invite.owner !== roster.owner || invite.broker !== broker) fail("untrusted");
    }
    if (this.byRoom(roster.room)) fail("untrusted");
    return { pin: { room: roster.room, owner: roster.owner, minEpoch: "0" } };
  }
  private commitInstall(name: string, broker: string, wire: Uint8Array, current: VerifiedEpoch, previous: RoomState | undefined, now: number): RoomState {
    const live = this.rooms.get(name);
    if ((live?.current.digest ?? null) !== (previous?.current.digest ?? null) || (live?.left ?? false) !== (previous?.left ?? false)) fail("state_changed");
    if (!previous && this.rooms.size >= ROOM_STORE_LIMITS.rooms) fail("limit");
    const same = previous?.current.digest === current.digest;
    const prior = same ? previous?.previous : previous && BigInt(previous.current.epoch) + 1n === BigInt(current.epoch) ? { epoch: previous.current, expiresAt: now + GRACE_MS } : undefined;
    if (prior && !Number.isSafeInteger(prior.expiresAt)) fail("invalid");
    const priorWire = same ? this.db.query<{ previous_wire: Uint8Array | null }, [string]>("SELECT previous_wire FROM rooms WHERE name=?").get(name)?.previous_wire : previous?.wire;
    const next: RoomState = { name, broker, current, wire: copy(wire), ...(prior ? { previous: prior } : {}), left: false };
    this.db.query(`INSERT INTO rooms(name,room,broker,owner,epoch,digest,wire,previous_wire,previous_digest,previous_epoch,previous_expires,left) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(name) DO UPDATE SET epoch=excluded.epoch,digest=excluded.digest,wire=excluded.wire,previous_wire=excluded.previous_wire,previous_digest=excluded.previous_digest,previous_epoch=excluded.previous_epoch,previous_expires=excluded.previous_expires,left=0`)
      .run(name, current.room, broker, decodeRoster(wire).owner, current.epoch, current.digest, wire, prior ? priorWire! : null, prior?.epoch.digest ?? null, prior?.epoch.epoch ?? null, prior?.expiresAt ?? null);
    this.db.query("DELETE FROM pending_joins WHERE name=?").run(name);
    return next;
  }
  async install(input: { name: string; broker: string; wire: Uint8Array; expectedDigest: string | null; current?: () => boolean; reactivate?: boolean }): Promise<RoomState> {
    const wire = copy(input.wire), { previous, pin } = this.prepareInstall(input.name, input.broker, wire, input.expectedDigest);
    if (previous?.left && input.reactivate !== true) fail("state_changed");
    const current = await acceptRoomEpoch({ wire, identity: this.identity, pin });
    const next = this.transaction(now => {
      assertCurrent(input.current);
      if (this.rooms.get(input.name)?.left && input.reactivate !== true) fail("state_changed");
      return this.commitInstall(input.name, input.broker, wire, current, previous, now);
    });
    this.rooms.set(input.name, next); return this.snapshot(next);
  }
  async rotate(name: string, members: RoomMember[], expectedDigest: string, current?: () => boolean): Promise<RoomState> {
    const previous = this.get(name);
    if (!previous || previous.left || previous.current.digest !== expectedDigest || decodeRoster(previous.wire).owner !== this.identity.public.fingerprint) fail("untrusted");
    const candidate = await createRoomEpoch({ owner: this.identity, members: structuredClone(members), previous: previous.current });
    return this.install({ name, broker: previous.broker, wire: candidate.wire, expectedDigest, ...(current ? { current } : {}) });
  }
  leave(name: string): void {
    const previous = this.get(name); if (!previous) fail("untrusted");
    this.transaction(() => this.db.query("UPDATE rooms SET left=1 WHERE name=?").run(name));
    this.rooms.set(name, { ...previous, left: true });
  }
  async saveInvite(name: string, wire: Uint8Array, current?: () => boolean): Promise<void> {
    const state = this.get(name), invite = decodeInvite(wire);
    if (!state || state.left || decodeRoster(state.wire).owner !== this.identity.public.fingerprint || invite.owner !== this.identity.public.fingerprint || invite.room !== state.current.room || invite.broker !== state.broker) fail("untrusted");
    wire = copy(wire);
    const hash = await digest(wire);
    this.transaction(now => {
      assertCurrent(current);
      if (invite.expiresAt <= now || this.rooms.get(name)?.current.digest !== state.current.digest || this.rooms.get(name)?.left) fail("untrusted");
      this.db.query("DELETE FROM invites WHERE expires<=?").run(now);
      if ((this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invites").get()?.n ?? 0) >= ROOM_STORE_LIMITS.invites) fail("limit");
      this.db.query("INSERT INTO invites(name,id,wire,digest,expires) VALUES(?,?,?,?,?)").run(name, invite.inviteId, wire, hash, invite.expiresAt);
    });
  }
  async enroll(name: string, request: Uint8Array, current?: () => boolean): Promise<RoomState> {
    const previous = this.get(name), joinRequest = decodeJoin(request);
    const invite = this.db.query<InviteRow, [string, string]>("SELECT * FROM invites WHERE name=? AND id=?").get(name, joinRequest.inviteId);
    if (!previous || previous.left || !invite || decodeRoster(previous.wire).owner !== this.identity.public.fingerprint) fail("untrusted");
    let next: RoomState | undefined;
    await acceptJoin({ issuedInvite: copy(invite.wire), wire: copy(request), owner: this.identity, nowMs: this.now(), enrollment: { consume: async claim => {
      const members = roomMembers(previous.current);
      if (members.some(x => x.fingerprint === claim.member.fingerprint)) {
        assertCurrent(current);
        const stored = this.db.query<{ request_digest: string | null }, [string]>("SELECT request_digest FROM invites WHERE id=?").get(claim.inviteId);
        return stored?.request_digest === claim.requestDigest ? "duplicate" : "refused";
      }
      // A consumed invitation never re-enrolls a subsequently revoked member.
      if (invite.request_digest !== null || claim.room !== previous.current.room || claim.owner !== this.identity.public.fingerprint) return "refused";
      const candidate = await createRoomEpoch({ owner: this.identity, members: [...members, claim.member], previous: previous.current });
      next = this.transaction(now => {
        assertCurrent(current);
        const stored = this.db.query<InviteRow, [string]>("SELECT * FROM invites WHERE id=?").get(claim.inviteId);
        if (!stored || stored.name !== name || stored.digest !== claim.inviteDigest || stored.expires !== claim.expiresAt || now >= stored.expires || stored.request_digest !== null) fail("state_changed");
        const state = this.commitInstall(name, previous.broker, candidate.wire, candidate.epoch, previous, now);
        this.db.query("UPDATE invites SET request_digest=? WHERE id=?").run(claim.requestDigest, claim.inviteId);
        return state;
      });
      this.rooms.set(name, next); return "accepted";
    } } });
    return this.snapshot(next ?? this.rooms.get(name)!);
  }

  private isCurrent(binding: SequenceBinding): boolean {
    this.now(); const state = this.byRoom(binding.room);
    return !!state && !state.left && binding.sender === this.identity.public.fingerprint && state.current.epoch === binding.epoch && state.current.digest === binding.rosterDigest;
  }
  private reserve(binding: SequenceBinding): string {
    return this.transaction(() => {
      if (!this.isCurrent(binding)) fail("state_changed");
      const row = this.db.query<{ seq: string }, [string]>("SELECT seq FROM counters WHERE room=?").get(binding.room);
      const seq = positiveU64(String(BigInt(row?.seq ?? "0") + 1n));
      this.db.query("INSERT INTO counters(room,seq) VALUES(?,?) ON CONFLICT(room) DO UPDATE SET seq=excluded.seq").run(binding.room, seq);
      return seq;
    });
  }
  private accept(input: ReplayCommit): Awaited<ReturnType<ReplayPort["accept"]>> {
    return this.transaction<Awaited<ReturnType<ReplayPort["accept"]>>>(now => {
      const state = this.byRoom(input.room);
      if (!state || state.left || input.recipient !== this.identity.public.fingerprint || state.current.epoch !== input.expectedCurrentEpoch || state.current.digest !== input.expectedCurrentDigest) return { status: "trust_changed" };
      const selected = input.frameEpoch === state.current.epoch ? state.current : state.previous?.epoch;
      if (!selected || selected.epoch !== input.frameEpoch || selected.digest !== input.selectedRosterDigest) return { status: "trust_changed" };
      if (selected !== state.current && (!state.previous || state.previous.expiresAt !== input.previousExpiresAt || now >= state.previous.expiresAt)) return { status: "trust_changed" };
      const currentMembers = roomMembers(state.current), oldMembers = roomMembers(selected);
      for (const fp of [input.sender, input.recipient]) {
        const current = currentMembers.find(x => x.fingerprint === fp), old = oldMembers.find(x => x.fingerprint === fp);
        if (!current || !old || current.signingKey !== old.signingKey || current.agreementKey !== old.agreementKey) return { status: "trust_changed" };
      }
      positiveU64(input.seq);
      const known = this.db.query<{ digest: string }, [string, string, string]>("SELECT digest FROM inbox WHERE room=? AND sender=? AND seq=?").get(input.room, input.sender, input.seq);
      if (known) return { status: known.digest === input.frameDigest ? "duplicate" : "conflict" };
      // An application alias was committed only after crypto replay accepted these exact bytes.
      // Keep its duplicate proof after bounded inbox pruning, without advancing the sender floor.
      const alias = this.db.query("SELECT 1 FROM application_frames f JOIN applications a ON a.room=f.room AND a.sender=f.sender AND a.application=f.application WHERE f.room=? AND f.sender=? AND f.digest=? AND (a.state NOT IN ('completed','failed_safe','disposed') OR a.settled_at>? OR EXISTS (SELECT 1 FROM person_inbox p WHERE p.room=a.room AND p.sender=a.sender AND p.application=a.application))")
        .get(input.room, input.sender, input.frameDigest, now - ROOM_APPLICATION_RETENTION.settledMs);
      if (alias) return { status: "duplicate" };
      const floor = this.db.query<{ seq: string; digest: string }, [string, string]>("SELECT seq,digest FROM floors WHERE room=? AND sender=?").get(input.room, input.sender);
      if (floor && BigInt(input.seq) <= BigInt(floor.seq)) return { status: input.seq === floor.seq ? floor.digest === input.frameDigest ? "duplicate" : "conflict" : "stale" };
      if (!floor && (this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM floors WHERE room=?").get(input.room)?.n ?? 0) >= ROOM_STORE_LIMITS.floorsPerRoom) fail("limit");
      if (!(input.plaintext instanceof Uint8Array) || input.plaintext.length > 65536) fail("limit");
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM inbox WHERE room=? AND plaintext IS NOT NULL AND receipt_reserve=0").get(input.room)?.n ?? 0;
      const size = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox WHERE receipt_reserve=0").get()?.n ?? 0;
      let reserved = false;
      if (count >= ROOM_STORE_LIMITS.inboxPerRoom || size + input.plaintext.length > ROOM_STORE_LIMITS.inboxBytes) {
        let message: RoomMessage | undefined;
        try { message = decodeRoomMessage(input.plaintext); } catch { /* Malformed or non-application payloads get no capacity retirement proof. */ }
        if (message?.type === "chat") throw new RoomFreshChatCapacityError();
        const receipt = input.plaintext.length <= ROOM_STORE_LIMITS.receiptReserveBytes && message?.type === "receipt" ? message : undefined;
        if (!receipt) fail("limit");
        const matched = this.db.query("SELECT 1 FROM application_outbox WHERE room=? AND digest=? AND application=? AND peer=? AND recipient=? AND state IN ('dispatching','accepted','needs_review') AND disposition IS NULL")
          .get(input.room, receipt.frame, receipt.application, receipt.peer, input.sender);
        if (!matched) throw new RoomUnmatchedReceiptError();
        const pending = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM inbox WHERE room=? AND plaintext IS NOT NULL AND receipt_reserve=1").get(input.room)?.n ?? 0;
        const bytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox WHERE receipt_reserve=1").get()?.n ?? 0;
        if (pending >= ROOM_STORE_LIMITS.receiptReservePerRoom || bytes + input.plaintext.length > ROOM_STORE_LIMITS.rooms * ROOM_STORE_LIMITS.receiptReservePerRoom * ROOM_STORE_LIMITS.receiptReserveBytes) fail("limit");
        reserved = true;
      }
      const gap = String(BigInt(input.seq) - BigInt(floor?.seq ?? "0") - 1n);
      this.db.query("INSERT INTO inbox(room,sender,seq,digest,plaintext,gap,receipt_reserve,received_at) VALUES(?,?,?,?,?,?,?,?)").run(input.room, input.sender, input.seq, input.frameDigest, input.plaintext, gap, reserved ? 1 : 0, now);
      this.db.query("INSERT INTO floors(room,sender,seq,digest) VALUES(?,?,?,?) ON CONFLICT(room,sender) DO UPDATE SET seq=excluded.seq,digest=excluded.digest").run(input.room, input.sender, input.seq, input.frameDigest);
      return { status: "accepted", gap };
    });
  }
  async enqueue(name: string, wire: Uint8Array, current?: () => boolean): Promise<void> {
    await this.putOutbox(name, wire, current);
  }
  async queueApplication(name: string, wire: Uint8Array, input: RoomOutgoingInput, current?: () => boolean): Promise<RoomOutgoing> {
    const selected = { ...input };
    if (!boundedId(selected.deliveryId) || !boundedId(selected.application) || !NAME.test(selected.peer)
      || !/^[a-f0-9]{64}$/.test(selected.recipient) || typeof selected.remotePeer !== "string"
      || !new RegExp(`^${selected.peer}@[a-z][a-z0-9-]{0,31}$`).test(selected.remotePeer)
      || !Number.isSafeInteger(selected.ackTimeoutMs) || selected.ackTimeoutMs < 1 || selected.ackTimeoutMs > 86_400_000
      || !Number.isSafeInteger(selected.ttlMs) || selected.ttlMs < 1 || selected.ttlMs > 604_800_000) fail("invalid");
    const result = await this.putOutbox(name, wire, current, selected);
    if (!result) fail("state_changed");
    return result;
  }
  private async putOutbox(name: string, wire: Uint8Array, current?: () => boolean, application?: RoomOutgoingInput): Promise<RoomOutgoing | undefined> {
    wire = copy(wire);
    const state = this.get(name); if (!state || state.left) fail("untrusted");
    const roster = decodeRoster(state.wire);
    const publicRoster = await verifyPublicRoster({ wire: state.wire, pin: { room: state.current.room, owner: roster.owner, minEpoch: state.current.epoch, digest: state.current.digest } });
    const frame = await verifyPublicFrame({ wire, roster: publicRoster });
    if (frame.sender !== this.identity.public.fingerprint) fail("untrusted");
    return this.transaction(now => {
      assertCurrent(current);
      if (!this.isCurrent({ room: frame.room, sender: frame.sender, epoch: frame.epoch, rosterDigest: frame.rosterDigest })) fail("state_changed");
      if (application) {
        const recipient = roomMembers(state.current).find(member => member.fingerprint === application.recipient);
        if (!recipient || application.recipient === this.identity.public.fingerprint || frame.recipients.length !== 1
          || frame.recipients[0] !== application.recipient || application.remotePeer !== `${application.peer}@${recipient.label}`) fail("untrusted");
      }
      const existing = this.db.query<{ wire: Uint8Array }, [string]>("SELECT wire FROM outbox WHERE digest=?").get(frame.digest);
      const saved = this.db.query<OutgoingRow, [string]>("SELECT * FROM application_outbox WHERE digest=?").get(frame.digest);
      if (existing || saved) {
        if (existing && Buffer.compare(Buffer.from(wire), Buffer.from(existing.wire))) fail("state_changed");
        if (!application) { if (saved) fail("state_changed"); return undefined; }
        if (!saved || saved.delivery_id !== application.deliveryId || saved.application !== application.application
          || saved.remote_peer !== application.remotePeer || saved.recipient !== application.recipient || saved.peer !== application.peer
          || saved.ack_timeout !== application.ackTimeoutMs || saved.expires_at - saved.created_at !== application.ttlMs) fail("state_changed");
        return outgoing(saved);
      }
      if (application && this.db.query("SELECT 1 FROM application_outbox WHERE room=? AND delivery_id=?").get(frame.room, application.deliveryId)) fail("state_changed");
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outbox WHERE room=?").get(frame.room)?.n ?? 0;
      const bytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(wire)+length(roster)),0) AS n FROM outbox").get()?.n ?? 0;
      if (count >= ROOM_STORE_LIMITS.outboxPerRoom || bytes + wire.length + state.wire.length > ROOM_STORE_LIMITS.outboxBytes) fail("limit");
      this.db.query("INSERT INTO outbox(room,digest,wire,roster,state) VALUES(?,?,?,?,'dispatching')").run(frame.room, frame.digest, wire, state.wire);
      if (!application) return undefined;
      const expires = now + application.ttlMs, deadline = now + application.ackTimeoutMs;
      if (!Number.isSafeInteger(expires) || !Number.isSafeInteger(deadline)) fail("invalid");
      this.db.query("INSERT INTO application_outbox(room,digest,delivery_id,application,remote_peer,recipient,peer,created_at,expires_at,ack_timeout,ack_deadline,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'dispatching')")
        .run(frame.room, frame.digest, application.deliveryId, application.application, application.remotePeer, application.recipient, application.peer, now, expires, application.ackTimeoutMs, deadline);
      return outgoing(this.db.query<OutgoingRow, [string]>("SELECT * FROM application_outbox WHERE digest=?").get(frame.digest)!);
    });
  }
  outbox(name: string): { digest: string; wire: Uint8Array; state: "dispatching" | "accepted" }[] {
    const room = this.get(name); if (!room || room.left) return [];
    return this.db.query<{ digest: string; wire: Uint8Array; state: "dispatching" | "accepted" }, [string]>("SELECT o.digest,o.wire,o.state FROM outbox o LEFT JOIN application_outbox a ON a.digest=o.digest WHERE o.room=? AND (a.digest IS NULL OR a.state IN ('dispatching','accepted')) ORDER BY o.rowid").all(room.current.room).map(row => ({ ...row, wire: copy(row.wire) }));
  }
  markStored(name: string, digestValue: string): void {
    const room = this.get(name); if (!room || room.left) fail("untrusted");
    if (this.db.query("SELECT 1 FROM application_outbox WHERE digest=?").get(digestValue)) fail("invalid");
    this.transaction(() => { this.db.query("UPDATE outbox SET state='accepted' WHERE room=? AND digest=?").run(room.current.room, digestValue); });
  }
  applicationOutbox(name: string, activeOnly = false): RoomOutgoing[] {
    const state = this.get(name); if (!state) return [];
    const filter = activeOnly ? " AND state IN ('dispatching','accepted','needs_review') AND disposition IS NULL" : "";
    return this.db.query<OutgoingRow, [string]>(`SELECT * FROM application_outbox WHERE room=?${filter} ORDER BY rowid`).all(state.current.room).map(outgoing);
  }
  /** A local send failure after durable enqueue is uncertainty, never evidence of a safe retry. */
  quarantineOutgoing(name: string, deliveryId: string): RoomOutgoing | undefined {
    const state = this.get(name); if (!state) return undefined;
    if (!boundedId(deliveryId)) fail("invalid");
    return this.transaction(() => {
      const row = this.db.query<OutgoingRow, [string, string]>("SELECT * FROM application_outbox WHERE room=? AND delivery_id=?").get(state.current.room, deliveryId);
      if (!row) return undefined;
      if (row.state !== "dispatching" && row.state !== "accepted") return outgoing(row);
      this.db.query("UPDATE application_outbox SET state='needs_review' WHERE digest=?").run(row.digest);
      return outgoing({ ...row, state: "needs_review" });
    });
  }
  markApplicationStored(name: string, digestValue: string, seq: string): RoomOutgoing | undefined {
    const state = this.applicationRoom(name);
    return this.transaction(now => {
      const row = this.db.query<OutgoingRow, [string, string]>("SELECT * FROM application_outbox WHERE room=? AND digest=?").get(state.current.room, digestValue);
      const sealed = this.db.query<{ wire: Uint8Array }, [string]>("SELECT wire FROM outbox WHERE digest=?").get(digestValue);
      if (!row || !sealed || decodeFrame(sealed.wire).seq !== seq) return undefined;
      if (row.state !== "dispatching" && row.state !== "accepted") return outgoing(row);
      if (!Number.isSafeInteger(row.ack_deadline)) fail("corrupt");
      if (now >= row.ack_deadline! || now >= row.expires_at) {
        this.db.query("UPDATE application_outbox SET state='needs_review' WHERE digest=?").run(digestValue);
        return outgoing({ ...row, state: "needs_review" });
      }
      if (row.state === "accepted") return outgoing(row);
      this.db.query("UPDATE application_outbox SET state='accepted' WHERE digest=?").run(digestValue);
      this.db.query("UPDATE outbox SET state='accepted' WHERE digest=?").run(digestValue);
      return outgoing({ ...row, state: "accepted" });
    });
  }
  private applicationRoom(name: string, current?: () => boolean): RoomState {
    assertCurrent(current);
    const state = this.get(name), own = this.identity.public;
    const member = state && roomMembers(state.current).find(row => row.fingerprint === own.fingerprint);
    if (!state || state.left || !member || member.signingKey !== own.signingKey || member.agreementKey !== own.agreementKey) fail("untrusted");
    return state;
  }
  applyApplicationReceipt(name: string, receiptFrameDigest: string, current?: () => boolean): RoomOutgoing | undefined {
    const state = this.applicationRoom(name, current);
    if (!validDigest(receiptFrameDigest)) fail("invalid");
    return this.transaction(now => {
      this.applicationRoom(name, current);
      const entry = this.db.query<RoomInboxEntry, [string, string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND digest=? AND plaintext IS NOT NULL").get(state.current.room, receiptFrameDigest);
      if (!entry) return undefined;
      let message: RoomMessage; try { message = decodeRoomMessage(entry.plaintext); } catch { fail("invalid"); }
      if (message.type !== "receipt") return undefined;
      const row = this.db.query<OutgoingRow, [string, string]>("SELECT * FROM application_outbox WHERE room=? AND digest=?").get(state.current.room, message.frame);
      if (!row || row.application !== message.application || row.peer !== message.peer || row.recipient !== entry.sender
        || !roomMembers(state.current).some(member => member.fingerprint === entry.sender) || !validOutcome(message.outcome, message.reason, row.peer)) return undefined;
      if (isTerminal(row.state) || row.state === "needs_review" && row.late_outcome !== null) return outgoing(row);
      const expired = now >= row.expires_at || row.ack_deadline !== null && now >= row.ack_deadline;
      if (row.state === "needs_review" || expired) {
        this.db.query("UPDATE application_outbox SET state='needs_review',late_outcome=?,late_reason=?,receipt_digest=? WHERE digest=?")
          .run(message.outcome, message.reason, receiptFrameDigest, row.digest);
        return outgoing({ ...row, state: "needs_review", late_outcome: message.outcome, late_reason: message.reason, receipt_digest: receiptFrameDigest });
      }
      this.db.query("UPDATE application_outbox SET state=?,reason=?,receipt_digest=? WHERE digest=?").run(message.outcome, message.reason, receiptFrameDigest, row.digest);
      this.db.query("DELETE FROM outbox WHERE digest=?").run(row.digest);
      this.pruneOutgoingHistory(state.current.room);
      return outgoing({ ...row, state: message.outcome, reason: message.reason, receipt_digest: receiptFrameDigest });
    });
  }
  private pruneOutgoingHistory(room: string): void {
    this.db.query("DELETE FROM application_outbox WHERE room=? AND (state IN ('completed','failed_safe') OR disposition IS NOT NULL) AND rowid NOT IN (SELECT rowid FROM application_outbox WHERE room=? AND (state IN ('completed','failed_safe') OR disposition IS NOT NULL) ORDER BY rowid DESC LIMIT ?)")
      .run(room, room, APPLICATION_HISTORY_CAP);
  }
  /** Local disposition follows a successful person Bus resolution; it is never remote completion proof. */
  disposeApplication(name: string, deliveryId: string, action: "completed" | "retry" | "discard", current?: () => boolean): RoomOutgoing | undefined {
    assertCurrent(current);
    const state = this.get(name); if (!state) return undefined;
    if (!boundedId(deliveryId) || !["completed", "retry", "discard"].includes(action)) fail("invalid");
    return this.transaction(() => {
      assertCurrent(current);
      const row = this.db.query<OutgoingRow, [string, string]>("SELECT * FROM application_outbox WHERE room=? AND delivery_id=?").get(state.current.room, deliveryId);
      if (!row || row.state !== "needs_review") return undefined;
      if (row.disposition !== null) { if (row.disposition !== action) fail("state_changed"); return outgoing(row); }
      this.db.query("UPDATE application_outbox SET disposition=? WHERE digest=?").run(action, row.digest);
      this.db.query("DELETE FROM outbox WHERE digest=?").run(row.digest);
      this.pruneOutgoingHistory(state.current.room);
      return outgoing({ ...row, disposition: action });
    });
  }
  expireApplications(name: string): RoomOutgoing[] {
    const state = this.applicationRoom(name);
    return this.transaction(now => {
      const rows = this.db.query<OutgoingRow, [string, number, number]>("SELECT * FROM application_outbox WHERE room=? AND state IN ('dispatching','accepted') AND (expires_at<=? OR ack_deadline<=?) ORDER BY rowid").all(state.current.room, now, now);
      for (const row of rows) this.db.query("UPDATE application_outbox SET state='needs_review' WHERE digest=?").run(row.digest);
      return rows.map(row => outgoing({ ...row, state: "needs_review" }));
    });
  }
  private applicationFor(room: string, digestValue: string): ApplicationRow | undefined {
    return this.db.query<ApplicationRow, [string, string]>("SELECT a.* FROM applications a JOIN application_frames f ON f.room=a.room AND f.sender=a.sender AND f.application=a.application WHERE f.room=? AND f.digest=?").get(room, digestValue) ?? undefined;
  }
  private personIdentityRetained(row: Pick<ApplicationRow, "room" | "sender" | "application">): boolean {
    return !!this.db.query("SELECT 1 FROM person_inbox WHERE room=? AND sender=? AND application=?").get(row.room, row.sender, row.application);
  }
  private deleteSettledApplication(row: ApplicationRow): void {
    if (this.db.query("SELECT 1 FROM person_inbox WHERE room=? AND sender=? AND application=? AND state='unread'").get(row.room, row.sender, row.application)) return;
    this.db.query("DELETE FROM person_inbox WHERE room=? AND sender=? AND application=?").run(row.room, row.sender, row.application);
    this.db.query("DELETE FROM inbox WHERE room=? AND plaintext IS NULL AND digest IN (SELECT digest FROM application_frames WHERE room=? AND sender=? AND application=?)")
      .run(row.room, row.room, row.sender, row.application);
    this.db.query("DELETE FROM application_frames WHERE room=? AND sender=? AND application=?").run(row.room, row.sender, row.application);
    this.db.query("DELETE FROM applications WHERE room=? AND sender=? AND application=?").run(row.room, row.sender, row.application);
  }
  private applicationCapacity(room: string, now: number, freshIdentity: boolean, retained?: Pick<ApplicationRow, "sender" | "application">): void {
    this.prunePersonInbox(now);
    // Person stubs have their own disposition/expiry horizon. Only the cap walk
    // below may evict a settled stub early; unread identities are never candidates.
    const expired = this.db.query<ApplicationRow, [string, number, string, string]>("SELECT * FROM applications WHERE room=? AND state IN ('completed','failed_safe','disposed') AND settled_at<=? AND NOT (sender=? AND application=?) AND NOT EXISTS (SELECT 1 FROM person_inbox p WHERE p.room=applications.room AND p.sender=applications.sender AND p.application=applications.application)").all(room, now - ROOM_APPLICATION_RETENTION.settledMs, retained?.sender ?? "", retained?.application ?? "");
    for (const row of expired) this.deleteSettledApplication(row);
    for (;;) {
      const identities = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM applications WHERE room=?").get(room)?.n ?? 0;
      const aliases = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM application_frames WHERE room=?").get(room)?.n ?? 0;
      if ((!freshIdentity || identities < ROOM_APPLICATION_RETENTION.identitiesPerRoom) && aliases < ROOM_APPLICATION_RETENTION.aliasesPerRoom) return;
      const settled = this.db.query<ApplicationRow, [string, string, string]>("SELECT * FROM applications WHERE room=? AND state IN ('completed','failed_safe','disposed') AND NOT (sender=? AND application=?) AND NOT EXISTS (SELECT 1 FROM person_inbox p WHERE p.room=applications.room AND p.sender=applications.sender AND p.application=applications.application AND p.state='unread') ORDER BY settled_at,created_at,sender,application LIMIT 1").get(room, retained?.sender ?? "", retained?.application ?? "");
      if (!settled) throw new RoomApplicationLimitError(room, Math.max(identities, aliases));
      this.deleteSettledApplication(settled);
    }
  }
  async applicationIncoming(name: string, digestValue: string, current?: () => boolean): Promise<{ sender: string; chat: RoomChatEnvelope; contentHash: string; primary: boolean; state: ApplicationState }> {
    const state = this.applicationRoom(name, current);
    if (!validDigest(digestValue)) fail("invalid");
    const original = this.db.query<RoomInboxEntry, [string, string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND digest=? AND plaintext IS NOT NULL").get(state.current.room, digestValue);
    if (!original) fail("untrusted");
    const plaintext = copy(original.plaintext);
    let message: RoomMessage; try { message = decodeRoomMessage(plaintext); } catch { fail("invalid"); }
    if (message.type !== "chat") fail("invalid");
    const chat = message.envelope, contentHash = await digest(encodeRoomMessage(message));
    return this.transaction(now => {
      const latest = this.applicationRoom(name, current);
      if (latest.current.digest !== state.current.digest || !roomMembers(latest.current).some(member => member.fingerprint === original.sender)) fail("state_changed");
      const entry = this.db.query<RoomInboxEntry, [string, string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND digest=? AND plaintext IS NOT NULL").get(state.current.room, digestValue);
      if (!entry || entry.sender !== original.sender || Buffer.compare(Buffer.from(entry.plaintext), Buffer.from(plaintext))) fail("state_changed");
      const key = [state.current.room, original.sender, chat.id] as [string, string, string];
      let saved = this.db.query<ApplicationRow, [string, string, string]>("SELECT * FROM applications WHERE room=? AND sender=? AND application=?").get(...key);
      if (saved && saved.settled_at !== null && saved.settled_at <= now - ROOM_APPLICATION_RETENTION.settledMs && isSettledApplication(saved.state)) {
        this.prunePersonInbox(now);
        if (!this.db.query("SELECT 1 FROM person_inbox WHERE room=? AND sender=? AND application=?").get(saved.room, saved.sender, saved.application)) { this.deleteSettledApplication(saved); saved = null; }
      }
      if (saved && (saved.content_hash !== contentHash || saved.peer !== chat.to)) fail("invalid");
      const alias = this.applicationFor(state.current.room, digestValue);
      if (alias && (alias.sender !== original.sender || alias.application !== chat.id)) fail("invalid");
      if (!alias) {
        this.applicationCapacity(state.current.room, now, !saved, saved ?? undefined);
        // The matching retained identity is protected while capacity evicts other settled work.
        saved = this.db.query<ApplicationRow, [string, string, string]>("SELECT * FROM applications WHERE room=? AND sender=? AND application=?").get(...key);
        if (!saved) {
          const pending = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM applications WHERE room=? AND state='pending'").get(state.current.room)?.n ?? 0;
          if (pending >= ROOM_STORE_LIMITS.inboxPerRoom) fail("limit");
          this.db.query("INSERT INTO applications(room,sender,application,content_hash,primary_digest,peer,trace,hop,state,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)")
            .run(...key, contentHash, digestValue, chat.to, chat.trace, chat.hop, now);
          saved = this.db.query<ApplicationRow, [string, string, string]>("SELECT * FROM applications WHERE room=? AND sender=? AND application=?").get(...key)!;
        }
        this.db.query("INSERT INTO application_frames(room,digest,sender,application) VALUES(?,?,?,?)").run(state.current.room, digestValue, original.sender, chat.id);
      }
      if (!saved) fail("corrupt");
      const primary = saved.primary_digest === digestValue;
      if (!primary || isSettledApplication(saved.state) || saved.state === "needs_review") {
        this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest=?").run(state.current.room, digestValue);
        this.pruneInbox(state.current.room);
      }
      return { sender: original.sender, chat, contentHash, primary, state: saved.state };
    });
  }
  private personMeta(row: PersonInboxRow): RoomPersonInboxMeta {
    const state = this.byRoom(row.room); if (!state) fail("corrupt");
    return { id: row.id, name: state.name, room: row.room, sender: row.sender, from: row.from_peer,
      receivedAt: row.received_at, expiresAt: row.expires_at, bytes: row.bytes, state: row.state };
  }
  private prunePersonInbox(now: number): void {
    this.db.query("UPDATE person_inbox SET body=NULL,state='expired',settled_at=expires_at WHERE state='unread' AND expires_at<=?").run(now);
    this.db.query("DELETE FROM person_inbox WHERE state!='unread' AND settled_at<=?").run(now - ROOM_PERSON_INBOX_LIMITS.ttlMs);
    for (const state of this.rooms.values()) this.db.query("DELETE FROM person_inbox WHERE room=? AND state!='unread' AND id NOT IN (SELECT id FROM person_inbox WHERE room=? AND state!='unread' ORDER BY settled_at DESC,id DESC LIMIT ?)")
      .run(state.current.room, state.current.room, ROOM_PERSON_INBOX_LIMITS.stubsPerRoom);
  }
  expirePersonInbox(): void {
    const now = this.now();
    // Idle ticks inspect indexed metadata only, with no transaction or durable clock write.
    const due = this.db.query("SELECT 1 FROM person_inbox WHERE (state='unread' AND expires_at<=?) OR (state!='unread' AND settled_at<=?) LIMIT 1").get(now, now - ROOM_PERSON_INBOX_LIMITS.ttlMs);
    if (!due && !this.db.query("SELECT room FROM person_inbox WHERE state!='unread' GROUP BY room HAVING COUNT(*)>1000 LIMIT 1").get()) return;
    this.transaction(current => this.prunePersonInbox(current));
  }
  /** A person inbox and its immutable admission receipt commit together. No Bus or network effect occurs here. */
  admitPersonInbox(name: string, digestValue: string, current?: () => boolean): RoomPersonInboxAdmission {
    const state = this.applicationRoom(name, current);
    if (!validDigest(digestValue)) fail("invalid");
    return this.transaction(now => {
      const latest = this.applicationRoom(name, current);
      if (latest.current.digest !== state.current.digest) fail("state_changed");
      this.prunePersonInbox(now);
      const row = this.applicationFor(state.current.room, digestValue);
      if (!row || row.peer !== USER) fail("untrusted");
      if (isTerminal(row.state)) {
        if (!validOutcome(row.state, row.reason, row.peer)) fail("corrupt");
        const existing = this.db.query<{ id: string }, [string, string, string]>("SELECT id FROM person_inbox WHERE room=? AND sender=? AND application=?").get(row.room, row.sender, row.application);
        return { state: row.reason === "inbox_admitted" ? "duplicate" : "refused", reason: row.reason!, ...(existing ? { id: existing.id } : {}) };
      }
      if (row.state !== "pending" || row.primary_digest !== digestValue) fail("state_changed");
      const entry = this.db.query<{ plaintext: Uint8Array; received_at: number | null }, [string, string, string]>("SELECT plaintext,received_at FROM inbox WHERE room=? AND digest=? AND sender=? AND plaintext IS NOT NULL").get(row.room, digestValue, row.sender);
      if (!entry) fail("untrusted");
      const message = decodeRoomMessage(entry.plaintext);
      if (message.type !== "chat" || message.envelope.to !== USER || message.envelope.id !== row.application || message.envelope.trace !== row.trace || message.envelope.hop !== row.hop
        || new Bun.CryptoHasher("sha256").update(encodeRoomMessage(message)).digest("base64url") !== row.content_hash) fail("untrusted");
      const member = roomMembers(latest.current).find(value => value.fingerprint === row.sender);
      if (!member || (message.envelope.from !== USER && !member.exposedPeers.includes(message.envelope.from))) fail("untrusted");
      const bytes = Buffer.byteLength(message.envelope.body, "utf8"), received = entry.received_at;
      let reason: RoomReceiptReason | undefined;
      if (received === null) reason = "inbox_age_unavailable";
      else if (!Number.isSafeInteger(received) || received <= 0 || received > now || !Number.isSafeInteger(received + ROOM_PERSON_INBOX_LIMITS.ttlMs)) fail("corrupt");
      else if (received + ROOM_PERSON_INBOX_LIMITS.ttlMs <= now) reason = "inbox_expired";
      else if (bytes > ROOM_PERSON_INBOX_LIMITS.bodyBytes) reason = "inbox_oversize";
      else {
        const unread = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM person_inbox WHERE room=? AND state='unread'").get(row.room)?.n ?? 0;
        const retained = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(bytes),0) AS n FROM person_inbox WHERE body IS NOT NULL").get()?.n ?? 0;
        if (unread >= ROOM_PERSON_INBOX_LIMITS.unreadPerRoom || retained + bytes > ROOM_PERSON_INBOX_LIMITS.globalBytes) reason = "inbox_full";
      }
      assertCurrent(current);
      if (reason) {
        this.finishApplication(name, digestValue, "failed_safe", reason, current);
        return { state: "refused", reason };
      }
      const id = crypto.randomUUID();
      this.db.query("INSERT INTO person_inbox(id,room,sender,application,primary_digest,from_peer,received_at,expires_at,bytes,body,state) VALUES(?,?,?,?,?,?,?,?,?,?,'unread')")
        .run(id, row.room, row.sender, row.application, digestValue, `${message.envelope.from}@${member.label}`, received!, received! + ROOM_PERSON_INBOX_LIMITS.ttlMs, bytes, entry.plaintext);
      this.db.query("UPDATE applications SET state='completed',reason='inbox_admitted',settled_at=? WHERE room=? AND sender=? AND application=?").run(now, row.room, row.sender, row.application);
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest IN (SELECT digest FROM application_frames WHERE room=? AND sender=? AND application=?)").run(row.room, row.room, row.sender, row.application);
      this.pruneInbox(row.room);
      return { state: "admitted", reason: "inbox_admitted", id };
    });
  }
  listPersonInbox(name?: string): RoomPersonInboxMeta[] {
    this.assertOpen(); const now = this.now();
    const state = name === undefined ? undefined : this.get(named(name));
    if (name !== undefined && !state) return [];
    const rows = state ? this.db.query<PersonInboxRow, [string]>("SELECT id,room,sender,application,primary_digest,from_peer,received_at,expires_at,bytes,state,settled_at FROM person_inbox WHERE room=? ORDER BY received_at,id LIMIT 1101").all(state.current.room)
      : this.db.query<PersonInboxRow, []>("SELECT id,room,sender,application,primary_digest,from_peer,received_at,expires_at,bytes,state,settled_at FROM person_inbox ORDER BY received_at,id LIMIT 1101").all();
    // ponytail: one complete bounded room (1100 rows), no global truncation. Add versioned pagination if global inventory is required.
    if (rows.length > 1100) fail("inbox_list_limit");
    // Metadata projection never loads a body; callers cannot infer a fresh unread TTL from a stale row.
    return rows.map(row => this.personMeta(row.state === "unread" && row.expires_at <= now ? { ...row, state: "expired" } : row));
  }
  readPersonInbox(id: string, current: () => boolean): RoomPersonInboxItem | undefined {
    if (typeof current !== "function") fail("untrusted"); assertCurrent(current);
    if (!validUuid(id)) fail("invalid");
    return this.transaction(now => {
      assertCurrent(current); this.prunePersonInbox(now);
      const row = this.db.query<PersonInboxRow, [string]>("SELECT * FROM person_inbox WHERE id=?").get(id);
      if (!row) return undefined;
      const item: RoomPersonInboxItem = this.personMeta(row);
      if (row.body !== null) {
        const message = decodeRoomMessage(row.body); if (message.type !== "chat") fail("corrupt"); item.body = message.envelope.body;
      }
      assertCurrent(current); return item;
    });
  }
  disposePersonInbox(id: string, action: "done" | "discard", current: () => boolean): RoomPersonInboxMeta | undefined {
    if (typeof current !== "function") fail("untrusted"); assertCurrent(current);
    if (!validUuid(id) || action !== "done" && action !== "discard") fail("invalid");
    return this.transaction(now => {
      assertCurrent(current); this.prunePersonInbox(now);
      const row = this.db.query<PersonInboxRow, [string]>("SELECT id,room,sender,application,primary_digest,from_peer,received_at,expires_at,bytes,state,settled_at FROM person_inbox WHERE id=?").get(id);
      if (!row) return undefined;
      const next = action === "done" ? "done" : "discarded";
      if (row.state !== "unread") { if (row.state !== next && row.state !== "expired") fail("state_changed"); return this.personMeta(row); }
      assertCurrent(current);
      this.db.query("UPDATE person_inbox SET body=NULL,state=?,settled_at=? WHERE id=?").run(next, now, id);
      this.prunePersonInbox(now);
      return this.personMeta({ ...row, body: null, state: next, settled_at: now });
    });
  }
  claimApplication(name: string, digestValue: string, current?: () => boolean): boolean {
    const state = this.applicationRoom(name, current);
    return this.transaction(() => {
      this.applicationRoom(name, current);
      const row = this.applicationFor(state.current.room, digestValue);
      if (!row || row.primary_digest !== digestValue || row.state !== "pending") return false;
      if (!roomMembers(state.current).some(member => member.fingerprint === row.sender)) fail("untrusted");
      this.db.query("UPDATE applications SET state='dispatching' WHERE room=? AND sender=? AND application=?").run(row.room, row.sender, row.application);
      return true;
    });
  }
  finishApplication(name: string, digestValue: string, outcome: "completed" | "failed_safe", reason: RoomReceiptReason, current?: () => boolean): void {
    const state = this.applicationRoom(name, current);
    if (!validOutcome(outcome, reason)) fail("invalid");
    this.transaction(now => {
      this.applicationRoom(name, current);
      const row = this.applicationFor(state.current.room, digestValue);
      if (!row || row.primary_digest !== digestValue || row.state === "needs_review" || row.state === "disposed") fail("state_changed");
      if (!validOutcome(outcome, reason, row.peer) || reason === "inbox_admitted") fail("invalid");
      if (isTerminal(row.state)) { if (row.state !== outcome || row.reason !== reason) fail("state_changed"); return; }
      if (outcome === "completed" && row.state !== "dispatching") fail("state_changed");
      this.db.query("UPDATE applications SET state=?,reason=?,settled_at=? WHERE room=? AND sender=? AND application=?").run(outcome, reason, now, row.room, row.sender, row.application);
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest IN (SELECT digest FROM application_frames WHERE room=? AND sender=? AND application=?)")
        .run(row.room, row.room, row.sender, row.application);
      this.pruneInbox(row.room);
    });
  }
  applicationReceipt(name: string, digestValue: string): RoomMessage | undefined {
    const state = this.applicationRoom(name), row = this.applicationFor(state.current.room, digestValue);
    if (!row || !isTerminal(row.state) || !validOutcome(row.state, row.reason, row.peer) || row.settled_at === null || row.settled_at <= this.now() - ROOM_APPLICATION_RETENTION.settledMs && !this.personIdentityRetained(row)) return undefined;
    return { v: 1, type: "receipt", frame: digestValue, application: row.application, peer: row.peer, outcome: row.state as "completed" | "failed_safe", reason: row.reason! };
  }
  pendingApplications(name: string): { digest: string }[] {
    const state = this.applicationRoom(name);
    return this.db.query<{ digest: string }, [string]>("SELECT primary_digest AS digest FROM applications WHERE room=? AND state='pending' ORDER BY created_at,primary_digest").all(state.current.room);
  }
  quarantineApplication(name: string, digestValue: string, current?: () => boolean): void {
    const state = this.applicationRoom(name, current);
    this.transaction(() => {
      this.applicationRoom(name, current);
      const row = this.applicationFor(state.current.room, digestValue);
      if (!row || isSettledApplication(row.state)) fail("state_changed");
      this.db.query("UPDATE applications SET state='needs_review' WHERE room=? AND sender=? AND application=?").run(row.room, row.sender, row.application);
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest IN (SELECT digest FROM application_frames WHERE room=? AND sender=? AND application=?)")
        .run(row.room, row.room, row.sender, row.application);
      this.pruneInbox(row.room);
    });
  }
  incomingApplication(name: string, digestValue: string): RoomIncomingApplication | undefined {
    const state = this.get(name); if (!state) return undefined;
    if (!validDigest(digestValue)) fail("invalid");
    const row = this.applicationFor(state.current.room, digestValue);
    if (!row || isSettledApplication(row.state) && row.settled_at! <= this.now() - ROOM_APPLICATION_RETENTION.settledMs && !this.personIdentityRetained(row)) return undefined;
    return incomingMetadata(row, digestValue);
  }
  /** A person disposes uncertainty locally; accept is not Bus admission or signed remote completion. */
  disposeIncoming(name: string, digestValue: string, action: "accept" | "discard", current?: () => boolean): void {
    assertCurrent(current);
    const state = this.get(name); if (!state) fail("untrusted");
    if (!validDigest(digestValue) || !["accept", "discard"].includes(action)) fail("invalid");
    this.transaction(now => {
      assertCurrent(current);
      const row = this.applicationFor(state.current.room, digestValue);
      if (!row || row.state !== "needs_review") fail("state_changed");
      this.db.query("UPDATE applications SET state='disposed',disposition=?,disposed_at=?,disposed_by='user',settled_at=? WHERE room=? AND sender=? AND application=?")
        .run(action, now, now, row.room, row.sender, row.application);
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest IN (SELECT digest FROM application_frames WHERE room=? AND sender=? AND application=?)")
        .run(row.room, row.room, row.sender, row.application);
      this.pruneInbox(row.room);
    });
  }
  applicationStatus(name: string): { pending: number; needsReview: number; rows: RoomIncomingApplication[]; truncated: boolean } {
    const state = this.get(name);
    if (!state) return { pending: 0, needsReview: 0, rows: [], truncated: false };
    const cutoff = this.now() - ROOM_APPLICATION_RETENTION.settledMs;
    const counts = this.db.query<{ pending: number; needsReview: number; disposed: number }, [number, string]>("SELECT COALESCE(SUM(CASE WHEN state IN ('pending','dispatching') THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN state='needs_review' THEN 1 ELSE 0 END),0) AS needsReview,COALESCE(SUM(CASE WHEN state='disposed' AND disposed_at>? THEN 1 ELSE 0 END),0) AS disposed FROM applications WHERE room=?").get(cutoff, state.current.room)!;
    const rows: RoomIncomingApplication[] = [];
    for (const selected of ["needs_review", "dispatching", "pending"]) {
      if (rows.length === 200) break;
      rows.push(...this.db.query<RoomIncomingApplication, [string, string, number]>("SELECT application,sender,peer,state,primary_digest AS digest FROM applications WHERE room=? AND state=? ORDER BY created_at,primary_digest LIMIT ?").all(state.current.room, selected, 200 - rows.length));
    }
    if (rows.length < 200) rows.push(...this.db.query<ApplicationRow, [string, number, number]>("SELECT * FROM applications WHERE room=? AND state='disposed' AND disposed_at>? ORDER BY disposed_at DESC,primary_digest LIMIT ?").all(state.current.room, cutoff, 200 - rows.length).map(row => incomingMetadata(row)));
    return { pending: counts.pending, needsReview: counts.needsReview, rows, truncated: counts.pending + counts.needsReview + counts.disposed > rows.length };
  }
  /** Same bounded application tombstones, never a separate unbounded trace history. */
  applicationTraceHop(trace: string): number | undefined {
    if (!validUuid(trace)) fail("invalid");
    const now = this.now();
    const row = this.db.query<{ hop: number | null }, [string, number]>("SELECT MAX(hop) AS hop FROM applications WHERE trace=? AND (state NOT IN ('completed','failed_safe','disposed') OR settled_at>? OR EXISTS (SELECT 1 FROM person_inbox p WHERE p.room=applications.room AND p.sender=applications.sender AND p.application=applications.application))").get(trace, now - ROOM_APPLICATION_RETENTION.settledMs);
    if (row?.hop === null || row === null) return undefined;
    if (!Number.isSafeInteger(row.hop) || row.hop! < 0 || row.hop! > MAX_HOP) fail("corrupt");
    return row.hop!;
  }
  private recoverApplications(): void {
    this.transaction(() => {
      this.db.query("UPDATE application_outbox SET state='needs_review' WHERE state IN ('dispatching','accepted')").run();
      this.db.query("UPDATE applications SET state='needs_review' WHERE state='dispatching'").run();
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE EXISTS (SELECT 1 FROM application_frames f JOIN applications a ON a.room=f.room AND a.sender=f.sender AND a.application=f.application WHERE f.room=inbox.room AND f.digest=inbox.digest AND a.state='needs_review')").run();
      for (const state of this.rooms.values()) this.pruneInbox(state.current.room);
    });
  }
  /** Diagnostic transport-drop receipt only. It never advances crypto replay or application-delivery state. */
  recordRefused(name: string, digestValue: string, reason: RoomRefusalReason, current?: () => boolean): void {
    const state = this.get(name);
    if (!state || state.left) fail("untrusted");
    if (!validDigest(digestValue) || !ROOM_REFUSAL_REASONS.includes(reason)) fail("invalid");
    this.transaction(now => {
      assertCurrent(current);
      const latest = this.rooms.get(name);
      if (!latest || latest.left || latest.current.digest !== state.current.digest) fail("state_changed");
      this.db.query("INSERT INTO refusals(room,digest,reason,at) VALUES(?,?,?,?) ON CONFLICT(room,digest) DO NOTHING")
        .run(state.current.room, digestValue, reason, now);
      // These are non-authority diagnostics; evicting them never forgets a replay floor or accepted receipt.
      this.db.query("DELETE FROM refusals WHERE room=? AND rowid NOT IN (SELECT rowid FROM refusals WHERE room=? ORDER BY rowid DESC LIMIT ?)")
        .run(state.current.room, state.current.room, ROOM_STORE_LIMITS.refusedPerRoom);
    });
  }
  refused(name: string): RoomRefusal[] {
    const state = this.get(name); if (!state) return [];
    return this.db.query<RoomRefusal, [string]>("SELECT digest,reason,at FROM refusals WHERE room=? ORDER BY rowid").all(state.current.room);
  }
  /** Read-only physical-cap hint for a validated host payload; no body is loaded and no replay/clock row is written. */
  ordinaryInboxAvailable(name: string, bytes: number): boolean {
    this.now(); named(name);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65536) fail("invalid");
    const state = this.rooms.get(name); if (!state || state.left) fail("untrusted");
    try {
      const pending = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM inbox WHERE room=? AND plaintext IS NOT NULL AND receipt_reserve=0").get(state.current.room);
      const total = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox WHERE receipt_reserve=0").get();
      if (!pending || !total || !Number.isSafeInteger(pending.n) || pending.n < 0 || !Number.isSafeInteger(total.n) || total.n < 0) fail("corrupt");
      return pending.n < ROOM_STORE_LIMITS.inboxPerRoom && total.n + bytes <= ROOM_STORE_LIMITS.inboxBytes;
    } catch (error) { if (error instanceof RoomStoreError) throw error; throw new RoomStoreError(code(error)); }
  }
  pendingInbox(name: string): RoomInboxEntry[] {
    const room = this.get(name); if (!room) return [];
    return this.db.query<{ sender: string; seq: string; digest: string; plaintext: Uint8Array; gap: string }, [string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND plaintext IS NOT NULL ORDER BY rowid").all(room.current.room).map(x => ({ ...x, plaintext: copy(x.plaintext) }));
  }
  private pruneInbox(room: string): void {
    this.db.query("DELETE FROM inbox WHERE room=? AND plaintext IS NULL AND rowid NOT IN (SELECT rowid FROM inbox WHERE room=? ORDER BY rowid DESC LIMIT ?)")
      .run(room, room, ROOM_STORE_LIMITS.receiptsPerRoom);
  }
  settleInbox(name: string, digestValue: string): void {
    const room = this.get(name); if (!room) fail("untrusted");
    this.transaction(() => {
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest=?").run(room.current.room, digestValue);
      this.pruneInbox(room.current.room);
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); this.rooms.clear(); } }
}
