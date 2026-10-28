/** Machine-local X3 room identity, epoch pins and durable crypto ports. No network or bus effects. */
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { realPath } from "../hub/project.ts";
import { assertRoomCryptoReady, exportHubIdentityForStorage, generateHubIdentity, importHubIdentity, decodeBase64url, encodeBase64url, sha256, type HubIdentity, type LocalIdentityRecord } from "./crypto.ts";
import { acceptJoin, acceptRoomEpoch, brokerUrl, createRoomEpoch, decodeInvite, decodeJoin, decodeRoster, positiveU64, roomMembers, type ReplayCommit, type ReplayPort, type SequenceBinding, type SequencePort, type VerifiedEpoch, type RoomMember, type VerifiedPublicRoster, verifyPublicRoster, verifyPublicFrame } from "./wire.ts";

export const ROOM_STORE_LIMITS = Object.freeze({ rooms: 64, invites: 128, pendingJoins: 64, inboxPerRoom: 200, inboxBytes: 16 * 1024 * 1024, receiptsPerRoom: 1000, outboxPerRoom: 200, outboxBytes: 16 * 1024 * 1024, floorsPerRoom: 256 });
export type RoomStoreCode = "invalid" | "busy" | "corrupt" | "unsupported" | "limit" | "untrusted" | "state_changed" | "clock_rollback" | "closed";
export class RoomStoreError extends Error {
  constructor(readonly code: RoomStoreCode) { super(`Room store: ${code}`); this.name = "RoomStoreError"; }
}
function fail(code: RoomStoreCode): never { throw new RoomStoreError(code); }
const DB_NAME = "rooms.db", SCHEMA = 1, GRACE_MS = 60_000;
// ponytail: keep at most 256 historical sender floors per room; refuse new senders at the ceiling until versioned archival preserves replay proofs.
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
interface Row { name: string; room: string; broker: string; owner: string; epoch: string; digest: string; wire: Uint8Array; previous_wire: Uint8Array | null; previous_digest: string | null; previous_epoch: string | null; previous_expires: number | null; left: number }
interface InviteRow { name: string; id: string; wire: Uint8Array; digest: string; expires: number; request_digest: string | null }
export interface RoomState { name: string; broker: string; current: VerifiedEpoch; wire: Uint8Array; previous?: { epoch: VerifiedEpoch; expiresAt: number }; left: boolean }
export interface RoomInboxEntry { sender: string; seq: string; digest: string; plaintext: Uint8Array; gap: string }
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
      db.exec("PRAGMA busy_timeout=1; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== SCHEMA) fail("unsupported");
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
          PRAGMA user_version=1;
        `);
      }
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 9").all().map(x => x.name).join(",");
      if (tables !== "counters,floors,inbox,invites,meta,outbox,pending_joins,rooms") fail("unsupported");
      const columns: Record<string, string[]> = {
        meta: ["key", "value"],
        rooms: ["name", "room", "broker", "owner", "epoch", "digest", "wire", "previous_wire", "previous_digest", "previous_epoch", "previous_expires", "left"],
        counters: ["room", "seq"], floors: ["room", "sender", "seq", "digest"],
        inbox: ["room", "sender", "seq", "digest", "plaintext", "gap"],
        invites: ["name", "id", "wire", "digest", "expires", "request_digest"],
        outbox: ["room", "digest", "wire", "roster", "state"], pending_joins: ["name", "invite", "request", "selection"],
      };
      for (const [table, names] of Object.entries(columns)) {
        if (db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(x => x.name).join(",") !== names.join(",")) fail("unsupported");
      }
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
    cap("inbox", limits.rooms * (limits.receiptsPerRoom + limits.inboxPerRoom));
    cap("outbox", limits.rooms * limits.outboxPerRoom); cap("invites", limits.invites); cap("pending_joins", limits.pendingJoins);
    const groupCap = (table: string, filter: string, maximum: number) => {
      if (this.db.query<{ room: string }, [number]>(`SELECT room FROM ${table} ${filter} GROUP BY room HAVING COUNT(*)>? LIMIT 1`).get(maximum)) fail("corrupt");
    };
    groupCap("floors", "", limits.floorsPerRoom);
    groupCap("inbox", "WHERE plaintext IS NOT NULL", limits.inboxPerRoom);
    groupCap("inbox", "WHERE plaintext IS NULL", limits.receiptsPerRoom);
    groupCap("outbox", "", limits.outboxPerRoom);
    const metadataBounds: Record<string, string> = {
      counters: "length(room)>43 OR length(seq)>20",
      floors: "length(room)>43 OR length(sender)>64 OR length(seq)>20 OR length(digest)>43",
      inbox: "length(room)>43 OR length(sender)>64 OR length(seq)>20 OR length(digest)>43 OR length(gap)>20",
      invites: "length(name)>32 OR length(id)>43 OR length(digest)>43 OR length(request_digest)>43",
      outbox: "length(room)>43 OR length(digest)>43 OR length(state)>16",
      pending_joins: "length(name)>32",
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
    const bodyBytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox").get()?.n ?? 0;
    const outboxBytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(wire)+length(roster)),0) AS n FROM outbox").get()?.n ?? 0;
    if (bodyBytes > limits.inboxBytes || outboxBytes > limits.outboxBytes) fail("corrupt");
    if (this.db.query("SELECT 1 FROM inbox WHERE length(plaintext)>65536 LIMIT 1").get()
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
    for (const row of this.db.query<{ room: string; sender: string; seq: string; digest: string; plaintext: Uint8Array | null; gap: string }, []>(`SELECT room,sender,seq,digest,plaintext,gap FROM inbox LIMIT ${limits.rooms * (limits.receiptsPerRoom + limits.inboxPerRoom) + 1}`).all()) {
      room(row.room); fp(row.sender); positiveU64(row.seq); hash(row.digest);
      if (typeof row.gap !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(row.gap) || BigInt(row.gap) >= BigInt(row.seq)) fail("corrupt");
      if (row.plaintext !== null && (!(row.plaintext instanceof Uint8Array) || row.plaintext.length > 65536)) fail("corrupt");
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
    for (const row of this.db.query<{ name: string; invite: Uint8Array; request: Uint8Array; selection: string | null }, []>(`SELECT * FROM pending_joins LIMIT ${limits.pendingJoins + 1}`).all()) {
      named(row.name); if (this.rooms.has(row.name)) fail("corrupt");
      const invite = decodeInvite(blob(row.invite, 16384)), request = decodeJoin(blob(row.request, 16384)), own = this.identity.public;
      if (request.room !== invite.room || request.owner !== invite.owner || request.inviteId !== invite.inviteId
        || request.member.fingerprint !== own.fingerprint || request.member.signingKey !== own.signingKey || request.member.agreementKey !== own.agreementKey) fail("corrupt");
      if (!validSelection(row.selection)) fail("corrupt");
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
      if (claim.room !== previous.current.room || claim.owner !== this.identity.public.fingerprint) return "refused";
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
      const floor = this.db.query<{ seq: string; digest: string }, [string, string]>("SELECT seq,digest FROM floors WHERE room=? AND sender=?").get(input.room, input.sender);
      if (floor && BigInt(input.seq) <= BigInt(floor.seq)) return { status: input.seq === floor.seq ? floor.digest === input.frameDigest ? "duplicate" : "conflict" : "stale" };
      if (!floor && (this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM floors WHERE room=?").get(input.room)?.n ?? 0) >= ROOM_STORE_LIMITS.floorsPerRoom) fail("limit");
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM inbox WHERE room=? AND plaintext IS NOT NULL").get(input.room)?.n ?? 0;
      const size = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(plaintext)),0) AS n FROM inbox").get()?.n ?? 0;
      if (!(input.plaintext instanceof Uint8Array) || input.plaintext.length > 65536 || count >= ROOM_STORE_LIMITS.inboxPerRoom || size + input.plaintext.length > ROOM_STORE_LIMITS.inboxBytes) fail("limit");
      const gap = String(BigInt(input.seq) - BigInt(floor?.seq ?? "0") - 1n);
      this.db.query("INSERT INTO inbox(room,sender,seq,digest,plaintext,gap) VALUES(?,?,?,?,?,?)").run(input.room, input.sender, input.seq, input.frameDigest, input.plaintext, gap);
      this.db.query("INSERT INTO floors(room,sender,seq,digest) VALUES(?,?,?,?) ON CONFLICT(room,sender) DO UPDATE SET seq=excluded.seq,digest=excluded.digest").run(input.room, input.sender, input.seq, input.frameDigest);
      return { status: "accepted", gap };
    });
  }
  async enqueue(name: string, wire: Uint8Array, current?: () => boolean): Promise<void> {
    wire = copy(wire);
    const state = this.get(name); if (!state || state.left) fail("untrusted");
    const roster = decodeRoster(state.wire);
    const publicRoster = await verifyPublicRoster({ wire: state.wire, pin: { room: state.current.room, owner: roster.owner, minEpoch: state.current.epoch, digest: state.current.digest } });
    const frame = await verifyPublicFrame({ wire, roster: publicRoster });
    if (frame.sender !== this.identity.public.fingerprint) fail("untrusted");
    this.transaction(() => {
      assertCurrent(current);
      if (!this.isCurrent({ room: frame.room, sender: frame.sender, epoch: frame.epoch, rosterDigest: frame.rosterDigest })) fail("state_changed");
      const existing = this.db.query<{ wire: Uint8Array }, [string]>("SELECT wire FROM outbox WHERE digest=?").get(frame.digest);
      if (existing) {
        if (Buffer.compare(Buffer.from(wire), Buffer.from(existing.wire))) fail("state_changed");
        return;
      }
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outbox WHERE room=?").get(frame.room)?.n ?? 0;
      const bytes = this.db.query<{ n: number }, []>("SELECT COALESCE(SUM(length(wire)+length(roster)),0) AS n FROM outbox").get()?.n ?? 0;
      if (count >= ROOM_STORE_LIMITS.outboxPerRoom || bytes + wire.length + state.wire.length > ROOM_STORE_LIMITS.outboxBytes) fail("limit");
      this.db.query("INSERT INTO outbox(room,digest,wire,roster,state) VALUES(?,?,?,?,'dispatching')").run(frame.room, frame.digest, wire, state.wire);
    });
  }
  outbox(name: string): { digest: string; wire: Uint8Array; state: "dispatching" | "accepted" }[] {
    const room = this.get(name); if (!room || room.left) return [];
    return this.db.query<{ digest: string; wire: Uint8Array; state: "dispatching" | "accepted" }, [string]>("SELECT digest,wire,state FROM outbox WHERE room=? ORDER BY rowid").all(room.current.room).map(row => ({ ...row, wire: copy(row.wire) }));
  }
  markStored(name: string, digestValue: string): void {
    const room = this.get(name); if (!room || room.left) fail("untrusted");
    this.transaction(() => { this.db.query("UPDATE outbox SET state='accepted' WHERE room=? AND digest=?").run(room.current.room, digestValue); });
  }
  pendingInbox(name: string): RoomInboxEntry[] {
    const room = this.get(name); if (!room) return [];
    return this.db.query<{ sender: string; seq: string; digest: string; plaintext: Uint8Array; gap: string }, [string]>("SELECT sender,seq,digest,plaintext,gap FROM inbox WHERE room=? AND plaintext IS NOT NULL ORDER BY rowid").all(room.current.room).map(x => ({ ...x, plaintext: copy(x.plaintext) }));
  }
  settleInbox(name: string, digestValue: string): void {
    const room = this.get(name); if (!room) fail("untrusted");
    this.transaction(() => {
      this.db.query("UPDATE inbox SET plaintext=NULL WHERE room=? AND digest=?").run(room.current.room, digestValue);
      this.db.query("DELETE FROM inbox WHERE room=? AND plaintext IS NULL AND rowid NOT IN (SELECT rowid FROM inbox WHERE room=? ORDER BY rowid DESC LIMIT ?)").run(room.current.room, room.current.room, ROOM_STORE_LIMITS.receiptsPerRoom);
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); this.rooms.clear(); } }
}
