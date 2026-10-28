import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { realPath } from "../hub/project.ts";
import { decodeBase64url, encodeBase64url } from "../rooms/crypto.ts";
import {
  decodeFrame, positiveU64, publicFrameWire, publicRosterWire, verifyPublicFrame, verifyPublicRoster,
  type VerifiedPublicFrame, type VerifiedPublicRoster,
} from "../rooms/wire.ts";

export const BROKER_LIMIT_CEILINGS = Object.freeze({
  rooms: 64, queuedPerRoom: 200, queuedGlobal: 1000, packetBytes: 32 * 1024 * 1024,
  queuedBytesPerRoom: 4 * 1024 * 1024, queueTtlMs: 24 * 60 * 60 * 1000,
});
export interface BrokerLimits {
  rooms: number;
  queuedPerRoom: number;
  queuedGlobal: number;
  packetBytes: number;
  queuedBytesPerRoom: number;
  queueTtlMs: number;
}
export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = Object.freeze({ ...BROKER_LIMIT_CEILINGS });
export type BrokerStoreCode = "invalid" | "busy" | "corrupt" | "unsupported" | "limit" | "untrusted" | "conflict" | "full" | "expired";
export class BrokerStoreError extends Error {
  constructor(readonly code: BrokerStoreCode) { super(`Broker store: ${code}`); this.name = "BrokerStoreError"; }
}
function fail(code: BrokerStoreCode): never { throw new BrokerStoreError(code); }
const SCHEMA_VERSION = 2;
const GRACE_MS = 60_000;
const DB_NAME = "broker.db";
// Exclusive ownership cannot be shared; keep accidental second starts fail-fast.
const BROKER_DB_BUSY_TIMEOUT_MS = 1;

interface StoredRoom {
  room: string; owner: string; currentEpoch: string; currentDigest: string; currentWire: Uint8Array;
  previousEpoch: string | null; previousDigest: string | null; previousWire: Uint8Array | null; previousExpiresAt: number | null;
}
interface StoredFrame { room: string; sender: string; seq: string; digest: string; wire: Uint8Array; recipients: string; createdAt: number; expiresAt: number; epoch: string }
interface StoredFloor { room: string; sender: string; seq: string; digest: string }
export interface BrokerRoomState { current: VerifiedPublicRoster; previous?: { roster: VerifiedPublicRoster; expiresAt: number } }
export interface BrokerStoreStats { rooms: number; queuedFrames: number; queuedBytes: number }

function safeErrorCode(error: unknown): BrokerStoreCode {
  const text = String(error).toLowerCase();
  if (text.includes("busy") || text.includes("locked")) return "busy";
  if (text.includes("malformed") || text.includes("not a database") || text.includes("corrupt")) return "corrupt";
  if (text.includes("no such table") || text.includes("no such column") || text.includes("schema")) return "unsupported";
  return "invalid";
}
function positiveLimits(input: Partial<BrokerLimits> | undefined): BrokerLimits {
  const limits = { ...DEFAULT_BROKER_LIMITS, ...input };
  for (const key of Object.keys(BROKER_LIMIT_CEILINGS) as (keyof BrokerLimits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > BROKER_LIMIT_CEILINGS[key]) fail("limit");
  }
  return limits;
}
function validWire(wire: unknown): wire is Uint8Array { return wire instanceof Uint8Array && wire.length > 0; }
function parseMembers(value: readonly { fingerprint: string; signingKey: string; agreementKey: string }[]): Map<string, string> {
  return new Map(value.map(member => [member.fingerprint, `${member.signingKey}:${member.agreementKey}`]));
}
function checkedProofRoster(proof: VerifiedPublicRoster): Uint8Array {
  let wire: Uint8Array;
  try { wire = publicRosterWire(proof); } catch { return fail("untrusted"); }
  if (!validWire(wire) || typeof proof.room !== "string" || typeof proof.owner !== "string" || typeof proof.epoch !== "string" || typeof proof.digest !== "string" || !Array.isArray(proof.members)) fail("untrusted");
  return wire;
}
function checkedProofFrame(proof: VerifiedPublicFrame): Uint8Array {
  let wire: Uint8Array;
  try { wire = publicFrameWire(proof); } catch { return fail("untrusted"); }
  if (!validWire(wire) || typeof proof.room !== "string" || typeof proof.epoch !== "string" || typeof proof.sender !== "string" || typeof proof.seq !== "string" || typeof proof.digest !== "string" || typeof proof.rosterDigest !== "string" || !Array.isArray(proof.recipients)) fail("untrusted");
  return wire;
}
function sameKeys(a: VerifiedPublicRoster, b: VerifiedPublicRoster, fingerprints: Iterable<string>): boolean {
  const left = parseMembers(a.members), right = parseMembers(b.members);
  for (const fingerprint of fingerprints) if (!left.has(fingerprint) || left.get(fingerprint) !== right.get(fingerprint)) return false;
  return true;
}
function parseRecipients(value: string): string[] {
  try {
    const recipients: unknown = JSON.parse(value);
    if (!Array.isArray(recipients) || recipients.some(x => typeof x !== "string") || new Set(recipients).size !== recipients.length) fail("corrupt");
    return recipients as string[];
  } catch (error) {
    if (error instanceof BrokerStoreError) throw error;
    return fail("corrupt");
  }
}
function validDigest(value: string): boolean {
  try { return encodeBase64url(decodeBase64url(value, 32)) === value; }
  catch { return false; }
}

/** Durable ciphertext-only queue and monotonic public roster pins for one broker process. */
export class BrokerStore {
  private readonly db: Database;
  private readonly limits: BrokerLimits;
  private readonly clock: () => number;
  private readonly rooms = new Map<string, BrokerRoomState>();
  private closed = false;

  private constructor(db: Database, limits: BrokerLimits, clock: () => number) {
    this.db = db; this.limits = limits; this.clock = clock;
  }

  private static validateSchema(db: Database, version: number): void {
    const expected = ["rooms", "sender_floors", "queued_frames"];
    const found = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name).sort();
    if (found.join(",") !== expected.slice().sort().join(",")) fail("unsupported");
    const queuedColumns = ["room", "sender", "seq", "digest", "wire", "recipients", "created_at", "expires_at", ...(version >= 2 ? ["epoch"] : [])];
    const columns: Record<string, string[]> = {
      rooms: ["room", "owner", "current_epoch", "current_digest", "current_wire", "previous_epoch", "previous_digest", "previous_wire", "previous_expires_at"],
      sender_floors: ["room", "sender", "seq", "digest"],
      queued_frames: queuedColumns,
    };
    for (const [table, names] of Object.entries(columns)) {
      const actual = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (actual.join(",") !== names.join(",")) fail("unsupported");
    }
    const queuedSql = db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='queued_frames'").get()?.sql;
    if (!queuedSql || /WITHOUT\s+ROWID/i.test(queuedSql)) fail("unsupported");
    try { db.query<{ rowid: number }, []>("SELECT rowid FROM queued_frames LIMIT 0").all(); }
    catch { fail("unsupported"); }
    if (version >= 2) {
      const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queued_frames'").all().map(row => row.name);
      if (!indexes.includes("queued_frames_room") || !indexes.includes("queued_frames_expiry")) fail("unsupported");
      const roomIndex = db.query<{ name: string }, []>("PRAGMA index_info(queued_frames_room)").all().map(row => row.name);
      const expiryIndex = db.query<{ name: string }, []>("PRAGMA index_info(queued_frames_expiry)").all().map(row => row.name);
      if (roomIndex[0] !== "room" || expiryIndex[0] !== "expires_at") fail("unsupported");
    }
  }

  static async open(input: { stateDir: string; limits?: Partial<BrokerLimits>; clock?: () => number; create?: boolean }): Promise<BrokerStore> {
    const limits = positiveLimits(input.limits), clock = input.clock ?? Date.now, create = input.create ?? true;
    let dir: string;
    try {
      if (existsSync(input.stateDir)) {
        if (lstatSync(input.stateDir).isSymbolicLink() || !statSync(input.stateDir).isDirectory()) fail("invalid");
        dir = realPath(input.stateDir);
        const entries = readdirSync(dir);
        if (entries.length > 0 && entries.some(name => ![DB_NAME, `${DB_NAME}-journal`, `${DB_NAME}-wal`, `${DB_NAME}-shm`].includes(name))) fail("invalid");
        if (entries.length > 0 && !entries.includes(DB_NAME)) fail("corrupt");
        if ((statSync(dir).mode & 0o777) !== 0o700) {
          if (entries.length > 0) fail("invalid");
          chmodSync(dir, 0o700);
        }
      } else {
        if (!create) fail("invalid");
        mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
        dir = realPath(input.stateDir);
        chmodSync(dir, 0o700);
      }
    } catch (error) {
      if (error instanceof BrokerStoreError) throw error;
      fail("invalid");
    }
    const file = join(dir, DB_NAME);
    let createdFile = false;
    try {
      if (existsSync(file)) {
        if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail("invalid");
        chmodSync(file, 0o600);
      } else {
        if (!create) fail("invalid");
        try {
          const descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          closeSync(descriptor);
          createdFile = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail("invalid");
        chmodSync(file, 0o600);
      }
    } catch (error) {
      if (error instanceof BrokerStoreError) throw error;
      fail("invalid");
    }
    let db: Database | undefined;
    try {
      db = new Database(file, { create, strict: true });
      db.run(`PRAGMA busy_timeout = ${BROKER_DB_BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA locking_mode=EXCLUSIVE;");
      db.exec("BEGIN EXCLUSIVE;");
      const existing = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (![0, 1, SCHEMA_VERSION].includes(existing)) fail("unsupported");
      if (existing === 0) {
        if (!createdFile) fail("corrupt");
        const hasUserTables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (hasUserTables.length) fail("unsupported");
        db.exec(`
          CREATE TABLE rooms (
            room TEXT PRIMARY KEY, owner TEXT NOT NULL, current_epoch TEXT NOT NULL, current_digest TEXT NOT NULL,
            current_wire BLOB NOT NULL, previous_epoch TEXT, previous_digest TEXT, previous_wire BLOB,
            previous_expires_at INTEGER, CHECK ((previous_epoch IS NULL AND previous_digest IS NULL AND previous_wire IS NULL AND previous_expires_at IS NULL)
              OR (previous_epoch IS NOT NULL AND previous_digest IS NOT NULL AND previous_wire IS NOT NULL AND previous_expires_at IS NOT NULL))
          ) WITHOUT ROWID;
          CREATE TABLE sender_floors (
            room TEXT NOT NULL, sender TEXT NOT NULL, seq TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY (room, sender), FOREIGN KEY (room) REFERENCES rooms(room) ON DELETE CASCADE
          ) WITHOUT ROWID;
          CREATE TABLE queued_frames (
            room TEXT NOT NULL, sender TEXT NOT NULL, seq TEXT NOT NULL, digest TEXT NOT NULL,
            wire BLOB NOT NULL, recipients TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, epoch TEXT NOT NULL,
            PRIMARY KEY (room, sender, seq), FOREIGN KEY (room) REFERENCES rooms(room) ON DELETE CASCADE
          );
          CREATE INDEX queued_frames_room ON queued_frames(room);
          CREATE INDEX queued_frames_expiry ON queued_frames(expires_at);
          PRAGMA user_version=${SCHEMA_VERSION};
        `);
      } else if (existing === 1) {
        this.validateSchema(db, 1);
        db.exec("ALTER TABLE queued_frames ADD COLUMN epoch TEXT NOT NULL DEFAULT '0';");
        const legacy = db.query<{ room: string; sender: string; seq: string; wire: Uint8Array }, []>("SELECT room,sender,seq,wire FROM queued_frames").all();
        for (const row of legacy) {
          if (!(row.wire instanceof Uint8Array)) fail("corrupt");
          let frame: ReturnType<typeof decodeFrame>;
          try { frame = decodeFrame(row.wire); } catch { fail("corrupt"); }
          if (frame.room !== row.room || frame.sender !== row.sender || frame.seq !== row.seq) fail("corrupt");
          db.query("UPDATE queued_frames SET epoch=? WHERE room=? AND sender=? AND seq=?").run(frame.epoch, row.room, row.sender, row.seq);
        }
        db.exec("CREATE INDEX IF NOT EXISTS queued_frames_room ON queued_frames(room); CREATE INDEX queued_frames_expiry ON queued_frames(expires_at); PRAGMA user_version=2;");
        this.validateSchema(db, 2);
      } else {
        this.validateSchema(db, SCHEMA_VERSION);
      }
      if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().some(row => row.quick_check !== "ok")) fail("corrupt");
      db.exec("COMMIT;");
      chmodSync(file, 0o600);
      const store = new BrokerStore(db, limits, clock);
      await store.restore();
      return store;
    } catch (error) {
      try { db?.close(); } catch { /* close after failed open */ }
      if (error instanceof BrokerStoreError) throw error;
      fail(safeErrorCode(error));
    }
  }

  private assertOpen(): void { if (this.closed) fail("invalid"); }
  private transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE;");
    try { const result = fn(); this.db.exec("COMMIT;"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK;"); } catch { /* preserve original fixed error */ } throw error; }
  }
  private async restore(): Promise<void> {
    let rows: StoredRoom[];
    try { rows = this.db.query<StoredRoom, []>("SELECT room, owner, current_epoch AS currentEpoch, current_digest AS currentDigest, current_wire AS currentWire, previous_epoch AS previousEpoch, previous_digest AS previousDigest, previous_wire AS previousWire, previous_expires_at AS previousExpiresAt FROM rooms ORDER BY room").all(); }
    catch { fail("corrupt"); }
    if (rows.length > this.limits.rooms) fail("corrupt");
    for (const row of rows) {
      try {
        if (!(row.currentWire instanceof Uint8Array) || row.currentWire.length === 0 || (row.previousWire !== null && !(row.previousWire instanceof Uint8Array))) fail("corrupt");
        const current = await verifyPublicRoster({ wire: row.currentWire, pin: { room: row.room, owner: row.owner, minEpoch: row.currentEpoch, digest: row.currentDigest } });
        if (current.digest !== row.currentDigest || current.epoch !== row.currentEpoch) fail("corrupt");
        let previous: BrokerRoomState["previous"];
        if (row.previousWire !== null) {
          if (row.previousEpoch === null || row.previousDigest === null || row.previousExpiresAt === null) fail("corrupt");
          const restoreNow = this.now();
          if (!Number.isSafeInteger(row.previousExpiresAt) || row.previousExpiresAt <= 0 || row.previousExpiresAt > restoreNow + GRACE_MS) fail("corrupt");
          const prior = await verifyPublicRoster({ wire: row.previousWire, pin: { room: row.room, owner: row.owner, minEpoch: row.previousEpoch, digest: row.previousDigest } });
          if (BigInt(prior.epoch) + 1n !== BigInt(current.epoch) || prior.owner !== current.owner || prior.digest !== row.previousDigest) fail("corrupt");
          previous = { roster: prior, expiresAt: row.previousExpiresAt };
        } else if (row.previousEpoch !== null || row.previousDigest !== null || row.previousExpiresAt !== null) fail("corrupt");
        this.rooms.set(row.room, previous ? { current, previous } : { current });
      } catch (error) {
        if (error instanceof BrokerStoreError) throw error;
        fail("corrupt");
      }
    }
    const floors = this.db.query<StoredFloor, []>("SELECT room,sender,seq,digest FROM sender_floors").all();
    const floorBySender = new Map<string, StoredFloor>();
    if (floors.length > this.limits.rooms * 64) fail("corrupt");
    for (const floor of floors) {
      const state = this.rooms.get(floor.room);
      if (!state || !state.current.members.some(member => member.fingerprint === floor.sender) || !validDigest(floor.digest)) fail("corrupt");
      try { positiveU64(floor.seq); } catch { fail("corrupt"); }
      const key = `${floor.room}\0${floor.sender}`;
      if (floorBySender.has(key)) fail("corrupt");
      floorBySender.set(key, floor);
    }
    const queued = this.db.query<StoredFrame, []>("SELECT room,sender,seq,digest,wire,recipients,created_at AS createdAt,expires_at AS expiresAt,epoch FROM queued_frames").all();
    for (const row of queued) {
      try {
        const state = this.rooms.get(row.room);
        if (!state || !(row.wire instanceof Uint8Array) || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt) ||
            row.createdAt < 0 || row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > BROKER_LIMIT_CEILINGS.queueTtlMs) fail("corrupt");
        const frameHeader = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.wire)) as { epoch?: unknown };
        if (frameHeader.epoch !== row.epoch) fail("corrupt");
        const roster = row.epoch === state.current.epoch ? state.current : state.previous?.roster;
        if (!roster) fail("corrupt");
        const proof = await verifyPublicFrame({ wire: row.wire, roster });
        const recipients = parseRecipients(row.recipients);
        if (proof.room !== row.room || proof.epoch !== row.epoch || proof.sender !== row.sender || proof.seq !== row.seq || proof.digest !== row.digest ||
            !validDigest(row.digest) || recipients.length === 0 || recipients.some(recipient => !proof.recipients.includes(recipient))) fail("corrupt");
        try { positiveU64(row.seq); } catch { fail("corrupt"); }
        const floor = floorBySender.get(`${row.room}\0${row.sender}`);
        if (!floor || BigInt(floor.seq) < BigInt(row.seq) || (floor.seq === row.seq && floor.digest !== row.digest)) fail("corrupt");
      } catch (error) {
        if (error instanceof BrokerStoreError) throw error;
        fail("corrupt");
      }
    }
    // Recover only structurally valid public/ciphertext queue rows, then enforce the current caps.
    this.sweep();
    const stats = this.stats();
    if (stats.queuedFrames > this.limits.queuedGlobal || stats.queuedBytes > this.limits.packetBytes) fail("corrupt");
    for (const room of this.rooms.keys()) if (this.countRoom(room) > this.limits.queuedPerRoom) fail("corrupt");
  }

  current(room: string): BrokerRoomState | undefined {
    this.assertOpen();
    const now = this.now();
    const state = this.rooms.get(room);
    const previous = state?.previous && state.previous.expiresAt > now ? state.previous : undefined;
    return state ? { current: state.current, ...(previous ? { previous: { ...previous } } : {}) } : undefined;
  }

  install(proof: VerifiedPublicRoster, authorizedOwner: string): { changed: boolean; revoked: string[] } {
    this.assertOpen();
    const wire = checkedProofRoster(proof);
    if (authorizedOwner !== proof.owner) fail("untrusted");
    const now = this.now();
    const before = this.rooms.get(proof.room);
    if (before) {
      if (proof.owner !== before.current.owner) fail("untrusted");
      const cmp = BigInt(proof.epoch) - BigInt(before.current.epoch);
      if (cmp === 0n) {
        if (proof.digest !== before.current.digest) fail("conflict");
        return { changed: false, revoked: [] };
      }
      if (cmp < 0n) fail("conflict");
    } else if (this.rooms.size >= this.limits.rooms) fail("full");

    const adjacent = before !== undefined && BigInt(proof.epoch) === BigInt(before.current.epoch) + 1n;
    const graceExpiry = now + GRACE_MS;
    if (adjacent && !Number.isSafeInteger(graceExpiry)) fail("invalid");
    const nextState: BrokerRoomState = { current: proof, ...(adjacent && before ? { previous: { roster: before.current, expiresAt: graceExpiry } } : {}) };
    const priorKeys = before ? parseMembers(before.current.members) : new Map<string, string>();
    const nextKeys = parseMembers(proof.members);
    const revoked = before ? [...priorKeys.keys()].filter(id => !nextKeys.has(id) || nextKeys.get(id) !== priorKeys.get(id)).sort() : [];
    this.transaction(() => {
      if (before) {
        this.db.query("UPDATE rooms SET current_epoch=?, current_digest=?, current_wire=?, previous_epoch=?, previous_digest=?, previous_wire=?, previous_expires_at=? WHERE room=?")
          .run(proof.epoch, proof.digest, wire, nextState.previous?.roster.epoch ?? null, nextState.previous?.roster.digest ?? null,
            nextState.previous ? publicRosterWire(nextState.previous.roster) : null, nextState.previous?.expiresAt ?? null, proof.room);
      } else {
        this.db.query("INSERT INTO rooms(room,owner,current_epoch,current_digest,current_wire) VALUES(?,?,?,?,?)").run(proof.room, proof.owner, proof.epoch, proof.digest, wire);
      }
      for (const fingerprint of priorKeys.keys()) if (!nextKeys.has(fingerprint) || nextKeys.get(fingerprint) !== priorKeys.get(fingerprint)) {
        this.db.query("DELETE FROM sender_floors WHERE room=? AND sender=?").run(proof.room, fingerprint);
      }
      this.purgeInvalidRows(proof.room, nextState, now);
    });
    this.rooms.set(proof.room, nextState);
    return { changed: true, revoked };
  }

  enqueue(proof: VerifiedPublicFrame, authorizedSender: string): { digest: string; duplicate: boolean } {
    this.assertOpen();
    const wire = checkedProofFrame(proof);
    if (authorizedSender !== proof.sender) fail("untrusted");
    this.sweep();
    const byteLength = wire.byteLength;
    let recipients: string[] = [];
    let result: { digest: string; duplicate: boolean } | undefined;
    let expiredPrevious = false;
    this.transaction(() => {
      const writeNow = this.now();
      let state = this.rooms.get(proof.room);
      this.db.query("DELETE FROM queued_frames WHERE expires_at<=?").run(writeNow);
      if (state?.previous && state.previous.expiresAt <= writeNow) {
        this.db.query("DELETE FROM queued_frames WHERE room=? AND epoch=?").run(proof.room, state.previous.roster.epoch);
        this.db.query("UPDATE rooms SET previous_epoch=NULL,previous_digest=NULL,previous_wire=NULL,previous_expires_at=NULL WHERE room=?").run(proof.room);
        expiredPrevious = true;
        state = { current: state.current };
      }
      const roster = this.rosterForProof(state, proof, writeNow);
      if (!state || !roster || !roster.members.some(member => member.fingerprint === proof.sender) || proof.recipients.length === 0 ||
          proof.recipients.some(recipient => !roster.members.some(member => member.fingerprint === recipient))) fail("untrusted");
      const currentKeys = parseMembers(state.current.members);
      const proofKeys = parseMembers(roster.members);
      recipients = [...new Set(proof.recipients)].filter(recipient => currentKeys.has(recipient) && currentKeys.get(recipient) === proofKeys.get(recipient)).sort();
      if (!recipients.length) fail("untrusted");
      // A retained older packet is a known accepted outcome even after a newer
      // sequence advanced the compact sender floor. Never recreate or rewrite it.
      const retained = this.db.query<{ digest: string }, [string, string, string]>("SELECT digest FROM queued_frames WHERE room=? AND sender=? AND seq=?").get(proof.room, proof.sender, proof.seq);
      if (retained) {
        if (retained.digest !== proof.digest) fail("conflict");
        result = { digest: proof.digest, duplicate: true };
        return;
      }
      const floor = this.db.query<{ seq: string; digest: string }, [string, string]>("SELECT seq,digest FROM sender_floors WHERE room=? AND sender=?").get(proof.room, proof.sender);
      if (floor) {
        const order = BigInt(proof.seq) - BigInt(floor.seq);
        if (order === 0n) {
          if (floor.digest !== proof.digest) fail("conflict");
          result = { digest: proof.digest, duplicate: true };
          return;
        }
        if (order < 0n) fail("conflict");
      }
      const counts = this.db.query<{ count: number; bytes: number }, []>("SELECT COUNT(*) AS count, COALESCE(SUM(length(wire)),0) AS bytes FROM queued_frames").get();
      const room = this.db.query<{ count: number; bytes: number }, [string]>("SELECT COUNT(*) AS count, COALESCE(SUM(length(wire)),0) AS bytes FROM queued_frames WHERE room=?").get(proof.room);
      if (byteLength > this.limits.packetBytes || byteLength > this.limits.queuedBytesPerRoom || (room?.count ?? 0) >= this.limits.queuedPerRoom ||
          (room?.bytes ?? 0) + byteLength > this.limits.queuedBytesPerRoom || (counts?.count ?? 0) >= this.limits.queuedGlobal ||
          (counts?.bytes ?? 0) + byteLength > this.limits.packetBytes) fail("full");
      const expiresAt = writeNow + this.limits.queueTtlMs;
      if (!Number.isSafeInteger(expiresAt)) fail("invalid");
      this.db.query("INSERT INTO sender_floors(room,sender,seq,digest) VALUES(?,?,?,?) ON CONFLICT(room,sender) DO UPDATE SET seq=excluded.seq,digest=excluded.digest")
        .run(proof.room, proof.sender, proof.seq, proof.digest);
      this.db.query("INSERT INTO queued_frames(room,sender,seq,digest,wire,recipients,created_at,expires_at,epoch) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(proof.room, proof.sender, proof.seq, proof.digest, wire, JSON.stringify(recipients), writeNow, expiresAt, proof.epoch);
      result = { digest: proof.digest, duplicate: false };
    });
    if (expiredPrevious) {
      const state = this.rooms.get(proof.room);
      if (state) this.rooms.set(proof.room, { current: state.current });
    }
    if (result) return result;
    return fail("invalid");
  }

  next(room: string, recipient: string): { digest: string; wire: Uint8Array } | undefined {
    this.assertOpen(); let now = 0;
    let state = this.rooms.get(room);
    if (!state) return undefined;
    this.transaction(() => { now = this.now(); state = this.expireRoom(room, now); });
    if (state) this.rooms.set(room, state);
    if (!state?.current.members.some(member => member.fingerprint === recipient)) return undefined;
    const previous = state.previous && state.previous.expiresAt > now ? state.previous.roster.epoch : state.current.epoch;
    const rows = this.db.query<{ id: number; digest: string; recipients: string }, [string, number, string, string]>(
      "SELECT rowid AS id,digest,recipients FROM queued_frames WHERE room=? AND expires_at>? AND epoch IN (?,?) ORDER BY rowid",
    ).all(room, now, state.current.epoch, previous);
    for (const row of rows) {
      if (!parseRecipients(row.recipients).includes(recipient)) continue;
      const packet = this.db.query<{ wire: Uint8Array }, [number]>("SELECT wire FROM queued_frames WHERE rowid=?").get(row.id);
      if (packet?.wire instanceof Uint8Array) return { digest: row.digest, wire: new Uint8Array(packet.wire) };
    }
    return undefined;
  }

  ack(room: string, recipient: string, digest: string): void {
    this.assertOpen();
    let now = 0;
    let state = this.rooms.get(room);
    if (!state) fail("untrusted");
    this.transaction(() => {
      now = this.now();
      state = this.expireRoom(room, now);
      if (!state?.current.members.some(member => member.fingerprint === recipient)) fail("untrusted");
      const epochs = state.previous && state.previous.expiresAt > now ? [state.current.epoch, state.previous.roster.epoch] : [state.current.epoch, state.current.epoch];
      const rows = this.db.query<{ rowid: number; sender: string; seq: string; digest: string; recipients: string; expiresAt: number; epoch: string }, [string, string, number, string, string]>(
        "SELECT rowid,digest,sender,seq,recipients,expires_at AS expiresAt,epoch FROM queued_frames WHERE room=? AND digest=? AND expires_at>? AND epoch IN (?,?) LIMIT 1",
      ).all(room, digest, now, epochs[0]!, epochs[1]!);
      const row = rows[0]; if (!row) return;
      const recipients = parseRecipients(row.recipients);
      if (!recipients.includes(recipient)) return;
      const remaining = recipients.filter(id => id !== recipient);
      if (remaining.length) this.db.query("UPDATE queued_frames SET recipients=? WHERE rowid=?").run(JSON.stringify(remaining), row.rowid);
      else this.db.query("DELETE FROM queued_frames WHERE rowid=?").run(row.rowid);
    });
    if (state) this.rooms.set(room, state);
  }

  sweep(): void {
    this.assertOpen(); const now = this.now();
    const expired: string[] = [];
    this.transaction(() => {
      this.db.query("DELETE FROM queued_frames WHERE expires_at<=?").run(now);
      for (const [room, state] of this.rooms) {
        if (state.previous && state.previous.expiresAt <= now) {
          this.db.query("DELETE FROM queued_frames WHERE room=? AND epoch=?").run(room, state.previous.roster.epoch);
          this.db.query("UPDATE rooms SET previous_epoch=NULL,previous_digest=NULL,previous_wire=NULL,previous_expires_at=NULL WHERE room=?").run(room);
          expired.push(room);
        }
      }
    });
    for (const room of expired) {
      const state = this.rooms.get(room);
      if (state) this.rooms.set(room, { current: state.current });
    }
  }

  stats(): BrokerStoreStats {
    this.assertOpen();
    const row = this.db.query<{ count: number; bytes: number }, []>("SELECT COUNT(*) AS count, COALESCE(SUM(length(wire)),0) AS bytes FROM queued_frames").get();
    const rooms = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rooms").get();
    return { rooms: rooms?.count ?? 0, queuedFrames: row?.count ?? 0, queuedBytes: row?.bytes ?? 0 };
  }

  dropRoom(room: string): { removed: boolean } {
    this.assertOpen();
    try { if (encodeBase64url(decodeBase64url(room, 32)) !== room) fail("invalid"); }
    catch (error) { if (error instanceof BrokerStoreError) throw error; fail("invalid"); }
    let removed = false;
    this.transaction(() => {
      if (!this.db.query<{ room: string }, [string]>("SELECT room FROM rooms WHERE room=?").get(room)) return;
      this.db.query("DELETE FROM queued_frames WHERE room=?").run(room);
      this.db.query("DELETE FROM sender_floors WHERE room=?").run(room);
      this.db.query("DELETE FROM rooms WHERE room=?").run(room);
      removed = true;
    });
    this.rooms.delete(room);
    return { removed };
  }

  close(): void { if (this.closed) return; this.closed = true; this.db.close(); this.rooms.clear(); }

  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail("invalid"); return value; }
  private expireRoom(room: string, now: number): BrokerRoomState | undefined {
    let state = this.rooms.get(room);
    this.db.query("DELETE FROM queued_frames WHERE room=? AND expires_at<=?").run(room, now);
    if (state?.previous && state.previous.expiresAt <= now) {
      this.db.query("DELETE FROM queued_frames WHERE room=? AND epoch=?").run(room, state.previous.roster.epoch);
      this.db.query("UPDATE rooms SET previous_epoch=NULL,previous_digest=NULL,previous_wire=NULL,previous_expires_at=NULL WHERE room=?").run(room);
      state = { current: state.current };
    }
    return state;
  }
  private countRoom(room: string): number { return this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM queued_frames WHERE room=?").get(room)?.count ?? 0; }
  private rosterForProof(state: BrokerRoomState | undefined, proof: VerifiedPublicFrame, now: number): VerifiedPublicRoster | undefined {
    if (!state) return undefined;
    if (proof.epoch === state.current.epoch && proof.rosterDigest === state.current.digest) return state.current;
    const previous = state.previous;
    if (previous && previous.expiresAt > now && proof.epoch === previous.roster.epoch && proof.rosterDigest === previous.roster.digest &&
        state.current.owner === previous.roster.owner && sameKeys(previous.roster, state.current, [proof.sender])) return previous.roster;
    return undefined;
  }
  private purgeInvalidRows(room: string, state: BrokerRoomState, now: number): void {
    const rows = this.db.query<{ rowid: number; sender: string; recipients: string; expiresAt: number; epoch: string }, [string]>(
      "SELECT rowid,sender,recipients,expires_at AS expiresAt,epoch FROM queued_frames WHERE room=?",
    ).all(room);
    for (const row of rows) {
      const recipients = parseRecipients(row.recipients);
      const sender = state.current.members.find(member => member.fingerprint === row.sender);
      const previous = state.previous && state.previous.expiresAt > now && row.epoch === state.previous.roster.epoch ? state.previous.roster : undefined;
      const isCurrent = row.epoch === state.current.epoch;
      const senderRetained = sender && (!previous || sameKeys(previous, state.current, [row.sender]));
      const keep = row.expiresAt > now && senderRetained ? recipients.filter(recipient =>
        state.current.members.some(member => member.fingerprint === recipient) && (!previous || sameKeys(previous, state.current, [recipient]))) : [];
      if ((!isCurrent && !previous) || !keep.length) this.db.query("DELETE FROM queued_frames WHERE rowid=?").run(row.rowid);
      else if (keep.length !== recipients.length) this.db.query("UPDATE queued_frames SET recipients=? WHERE rowid=?").run(JSON.stringify(keep), row.rowid);
    }
  }
}
