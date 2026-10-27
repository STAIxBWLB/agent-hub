import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { realPath } from "../hub/project.ts";
import { decodeBase64url, encodeBase64url } from "../rooms/crypto.ts";
import {
  positiveU64, publicFrameWire, publicRosterWire, verifyPublicFrame, verifyPublicRoster,
  type VerifiedPublicFrame, type VerifiedPublicRoster,
} from "../rooms/wire.ts";

export const BROKER_LIMIT_CEILINGS = Object.freeze({
  rooms: 64, queuedPerRoom: 200, queuedGlobal: 1000, packetBytes: 32 * 1024 * 1024,
  queueTtlMs: 24 * 60 * 60 * 1000,
});
export interface BrokerLimits {
  rooms: number;
  queuedPerRoom: number;
  queuedGlobal: number;
  packetBytes: number;
  queueTtlMs: number;
}
export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = Object.freeze({ ...BROKER_LIMIT_CEILINGS });
export type BrokerStoreCode = "invalid" | "busy" | "corrupt" | "unsupported" | "limit" | "untrusted" | "conflict" | "full" | "expired";
export class BrokerStoreError extends Error {
  constructor(readonly code: BrokerStoreCode) { super(`Broker store: ${code}`); this.name = "BrokerStoreError"; }
}
function fail(code: BrokerStoreCode): never { throw new BrokerStoreError(code); }
const SCHEMA_VERSION = 1;
const GRACE_MS = 60_000;
const DB_NAME = "broker.db";
// Exclusive ownership cannot be shared; keep accidental second starts fail-fast.
const BROKER_DB_BUSY_TIMEOUT_MS = 1;

interface StoredRoom {
  room: string; owner: string; currentEpoch: string; currentDigest: string; currentWire: Uint8Array;
  previousEpoch: string | null; previousDigest: string | null; previousWire: Uint8Array | null; previousExpiresAt: number | null;
}
interface StoredFrame { room: string; sender: string; seq: string; digest: string; wire: Uint8Array; recipients: string; createdAt: number; expiresAt: number }
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

  static async open(input: { stateDir: string; limits?: Partial<BrokerLimits>; clock?: () => number }): Promise<BrokerStore> {
    const limits = positiveLimits(input.limits), clock = input.clock ?? Date.now;
    let dir: string;
    try {
      mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
      dir = realPath(input.stateDir);
      chmodSync(dir, 0o700);
      if ((statSync(dir).mode & 0o077) !== 0) fail("invalid");
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
      db = new Database(file, { create: true, strict: true });
      db.run(`PRAGMA busy_timeout = ${BROKER_DB_BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA locking_mode=EXCLUSIVE;");
      db.exec("BEGIN EXCLUSIVE;");
      const existing = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (existing !== 0 && existing !== SCHEMA_VERSION) fail("unsupported");
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
            wire BLOB NOT NULL, recipients TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            PRIMARY KEY (room, sender, seq), FOREIGN KEY (room) REFERENCES rooms(room) ON DELETE CASCADE
          );
          CREATE INDEX queued_frames_room ON queued_frames(room);
          PRAGMA user_version=${SCHEMA_VERSION};
        `);
      } else {
        const expected = ["rooms", "sender_floors", "queued_frames"];
        const found = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name).sort();
        if (found.join(",") !== expected.slice().sort().join(",")) fail("unsupported");
        const columns: Record<string, string[]> = {
          rooms: ["room", "owner", "current_epoch", "current_digest", "current_wire", "previous_epoch", "previous_digest", "previous_wire", "previous_expires_at"],
          sender_floors: ["room", "sender", "seq", "digest"],
          queued_frames: ["room", "sender", "seq", "digest", "wire", "recipients", "created_at", "expires_at"],
        };
        for (const [table, names] of Object.entries(columns)) {
          const actual = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(column => column.name);
          if (actual.join(",") !== names.join(",")) fail("unsupported");
        }
        const queuedSql = db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='queued_frames'").get()?.sql;
        if (!queuedSql || /WITHOUT\s+ROWID/i.test(queuedSql)) fail("unsupported");
        try { db.query<{ rowid: number }, []>("SELECT rowid FROM queued_frames LIMIT 0").all(); }
        catch { fail("unsupported"); }
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
    const queued = this.db.query<StoredFrame, []>("SELECT room,sender,seq,digest,wire,recipients,created_at AS createdAt,expires_at AS expiresAt FROM queued_frames").all();
    for (const row of queued) {
      try {
        const state = this.rooms.get(row.room);
        if (!state || !(row.wire instanceof Uint8Array) || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt) ||
            row.createdAt < 0 || row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > BROKER_LIMIT_CEILINGS.queueTtlMs) fail("corrupt");
        const frameHeader = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.wire)) as { epoch?: unknown };
        const roster = frameHeader.epoch === state.current.epoch ? state.current : state.previous?.roster;
        if (!roster) fail("corrupt");
        const proof = await verifyPublicFrame({ wire: row.wire, roster });
        const recipients = parseRecipients(row.recipients);
        if (proof.room !== row.room || proof.sender !== row.sender || proof.seq !== row.seq || proof.digest !== row.digest ||
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
    this.assertOpen(); this.sweep();
    const state = this.rooms.get(room);
    return state ? { current: state.current, ...(state.previous ? { previous: { ...state.previous } } : {}) } : undefined;
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
      const roster = this.rosterForProof(state, proof, writeNow);
      if (!state || !roster || !roster.members.some(member => member.fingerprint === proof.sender) || proof.recipients.length === 0 ||
          proof.recipients.some(recipient => !roster.members.some(member => member.fingerprint === recipient))) fail("untrusted");
      const currentKeys = parseMembers(state.current.members);
      const proofKeys = parseMembers(roster.members);
      recipients = [...new Set(proof.recipients)].filter(recipient => currentKeys.has(recipient) && currentKeys.get(recipient) === proofKeys.get(recipient)).sort();
      if (!recipients.length) fail("untrusted");
      if (state?.previous && state.previous.expiresAt <= writeNow) {
        this.db.query("UPDATE rooms SET previous_epoch=NULL,previous_digest=NULL,previous_wire=NULL,previous_expires_at=NULL WHERE room=?").run(proof.room);
        this.purgeInvalidRows(proof.room, { current: state.current }, writeNow);
        state = { current: state.current };
        expiredPrevious = true;
      }
      this.db.query("DELETE FROM queued_frames WHERE expires_at<=?").run(writeNow);
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
      const roomCount = this.countRoom(proof.room);
      if (byteLength > this.limits.packetBytes || roomCount >= this.limits.queuedPerRoom || (counts?.count ?? 0) >= this.limits.queuedGlobal ||
          (counts?.bytes ?? 0) + byteLength > this.limits.packetBytes) fail("full");
      const expiresAt = writeNow + this.limits.queueTtlMs;
      if (!Number.isSafeInteger(expiresAt)) fail("invalid");
      this.db.query("INSERT INTO sender_floors(room,sender,seq,digest) VALUES(?,?,?,?) ON CONFLICT(room,sender) DO UPDATE SET seq=excluded.seq,digest=excluded.digest")
        .run(proof.room, proof.sender, proof.seq, proof.digest);
      this.db.query("INSERT INTO queued_frames(room,sender,seq,digest,wire,recipients,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(proof.room, proof.sender, proof.seq, proof.digest, wire, JSON.stringify(recipients), writeNow, expiresAt);
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
    this.assertOpen(); const now = this.now(); this.sweep();
    const state = this.rooms.get(room);
    if (!state?.current.members.some(member => member.fingerprint === recipient)) return undefined;
    const rows = this.db.query<StoredFrame, [string]>("SELECT room,sender,seq,digest,wire,recipients,created_at AS createdAt,expires_at AS expiresAt FROM queued_frames WHERE room=? ORDER BY rowid").all(room);
    for (const row of rows) {
      if (row.expiresAt <= now) continue;
      if (parseRecipients(row.recipients).includes(recipient)) return { digest: row.digest, wire: new Uint8Array(row.wire) };
    }
    return undefined;
  }

  ack(room: string, recipient: string, digest: string): void {
    this.assertOpen();
    this.sweep();
    if (!this.rooms.get(room)?.current.members.some(member => member.fingerprint === recipient)) fail("untrusted");
    this.transaction(() => {
      const rows = this.db.query<StoredFrame, [string, string]>("SELECT room,sender,seq,digest,wire,recipients,created_at AS createdAt,expires_at AS expiresAt FROM queued_frames WHERE room=? AND digest=?").all(room, digest);
      const row = rows[0]; if (!row) return;
      const recipients = parseRecipients(row.recipients);
      if (!recipients.includes(recipient)) return;
      const remaining = recipients.filter(id => id !== recipient);
      if (remaining.length) this.db.query("UPDATE queued_frames SET recipients=? WHERE room=? AND sender=? AND seq=?").run(JSON.stringify(remaining), room, row.sender, row.seq);
      else this.db.query("DELETE FROM queued_frames WHERE room=? AND sender=? AND seq=?").run(room, row.sender, row.seq);
    });
  }

  sweep(): void {
    this.assertOpen(); const now = this.now();
    this.transaction(() => {
      this.db.query("DELETE FROM queued_frames WHERE expires_at<=?").run(now);
      for (const [room, state] of this.rooms) {
        if (state.previous && state.previous.expiresAt <= now) {
          this.db.query("UPDATE rooms SET previous_epoch=NULL,previous_digest=NULL,previous_wire=NULL,previous_expires_at=NULL WHERE room=?").run(room);
          this.rooms.set(room, { current: state.current });
        }
        const current = this.rooms.get(room)!;
        this.purgeInvalidRows(room, current, now);
      }
    });
  }

  stats(): BrokerStoreStats {
    this.assertOpen();
    const row = this.db.query<{ count: number; bytes: number }, []>("SELECT COUNT(*) AS count, COALESCE(SUM(length(wire)),0) AS bytes FROM queued_frames").get();
    const rooms = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rooms").get();
    return { rooms: rooms?.count ?? 0, queuedFrames: row?.count ?? 0, queuedBytes: row?.bytes ?? 0 };
  }

  close(): void { if (this.closed) return; this.closed = true; this.db.close(); this.rooms.clear(); }

  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail("invalid"); return value; }
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
    const rows = this.db.query<StoredFrame, [string]>("SELECT room,sender,seq,digest,wire,recipients,created_at AS createdAt,expires_at AS expiresAt FROM queued_frames WHERE room=?").all(room);
    for (const row of rows) {
      const recipients = parseRecipients(row.recipients);
      const sender = state.current.members.find(member => member.fingerprint === row.sender);
      let keep: string[] = [];
      try {
        // Queue rows contain public frame headers plus ciphertext. The verified proof is not persisted,
        // so the authenticated header is checked through its retained digest and roster metadata at admission.
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.wire)) as { room?: unknown; epoch?: unknown; sender?: unknown; seq?: unknown; recipients?: unknown };
        if (frame.room !== room || frame.sender !== row.sender || frame.seq !== row.seq || !Array.isArray(frame.recipients)) throw new Error();
        const frameRecipients = frame.recipients.filter((x): x is string => typeof x === "string");
        const oldRoster = state.current.epoch === String(frame.epoch) ? state.current : state.previous?.roster;
        if (oldRoster && (oldRoster === state.current || (state.previous!.expiresAt > now && sameKeys(oldRoster, state.current, [row.sender]))) && sender) {
          keep = recipients.filter(recipient => frameRecipients.includes(recipient) && state.current.members.some(member => member.fingerprint === recipient) &&
            (oldRoster === state.current || sameKeys(oldRoster, state.current, [recipient])));
        }
      } catch { keep = []; }
      if (row.expiresAt <= now || !sender || !keep.length) this.db.query("DELETE FROM queued_frames WHERE room=? AND sender=? AND seq=?").run(room, row.sender, row.seq);
      else if (keep.length !== recipients.length) this.db.query("UPDATE queued_frames SET recipients=? WHERE room=? AND sender=? AND seq=?").run(JSON.stringify(keep), room, row.sender, row.seq);
    }
  }
}
