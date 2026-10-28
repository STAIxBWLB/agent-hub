import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { generateHubIdentity, type HubIdentity } from "../src/rooms/crypto.ts";
import {
  createRoomEpoch, publicRosterWire, sealFrame, verifyPublicFrame, verifyPublicRoster,
  type RoomMember, type VerifiedPublicFrame, type VerifiedPublicRoster,
} from "../src/rooms/wire.ts";
import { BrokerStore, BrokerStoreError } from "../src/broker/store.ts";

const text = new TextEncoder();
const canary = "plaintext-canary-for-broker-store";
function temporary() {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-broker-store-"));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}
const member = (identity: HubIdentity, label: string): RoomMember => ({ ...identity.public, label, exposedPeers: ["codex"] });
async function fixture(now: () => number = () => 10_000) {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] });
  const roster = await verifyPublicRoster({ wire: created.wire, pin: { room: created.epoch.room, owner: owner.public.fingerprint, minEpoch: "0" } });
  let seq = 0;
  const frame = async (sequence = String(++seq)): Promise<{ proof: VerifiedPublicFrame; wire: Uint8Array }> => {
    const wire = await sealFrame({ epoch: created.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: text.encode(canary), sequence: { reserve: async () => sequence, isCurrent: () => true } });
    return { proof: await verifyPublicFrame({ wire, roster }), wire };
  };
  const folder = temporary();
  const store = await BrokerStore.open({ stateDir: folder.stateDir, clock: now });
  return { owner, guest, ...created, roster, frame, ...folder, store };
}

test("broker store persists only sealed frame bytes and restores roster pins and queued delivery", async () => {
  let now = 10_000;
  const f = await fixture(() => now);
  try {
    expect(f.store.install(f.roster, f.owner.public.fingerprint)).toEqual({ changed: true, revoked: [] });
    const packet = await f.frame();
    expect(f.store.enqueue(packet.proof, f.owner.public.fingerprint)).toEqual({ digest: packet.proof.digest, duplicate: false });
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)).toEqual({ digest: packet.proof.digest, wire: packet.wire });
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)?.wire).not.toBe(packet.wire);
    f.store.close();
    const disk = readFileSync(join(f.stateDir, "broker.db"));
    expect(disk.includes(Buffer.from(canary))).toBe(false);
    const restored = await BrokerStore.open({ stateDir: f.stateDir, clock: () => now });
    try {
      expect(restored.current(f.roster.room)?.current.digest).toBe(f.roster.digest);
      expect(restored.next(f.roster.room, f.guest.public.fingerprint)).toEqual({ digest: packet.proof.digest, wire: packet.wire });
      restored.ack(f.roster.room, f.guest.public.fingerprint, packet.proof.digest);
      expect(restored.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
    } finally { restored.close(); }
  } finally { f.store.close(); f.cleanup(); }
});

test("broker store refuses owner and epoch rollback and recognizes an exact duplicate", async () => {
  const f = await fixture();
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    expect(f.store.install(f.roster, f.owner.public.fingerprint)).toEqual({ changed: false, revoked: [] });
    await expect(Promise.resolve().then(() => f.store.install(f.roster, f.guest.public.fingerprint))).rejects.toMatchObject({ code: "untrusted" });
    const packet = await f.frame("1");
    expect(f.store.enqueue(packet.proof, f.owner.public.fingerprint)).toMatchObject({ duplicate: false });
    expect(f.store.enqueue(packet.proof, f.owner.public.fingerprint)).toEqual({ digest: packet.proof.digest, duplicate: true });
  } finally { f.store.close(); f.cleanup(); }
});

test("queued frames retain admission order when sequence numbers have different digit lengths", async () => {
  const f = await fixture(() => 50_000);
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const seq2 = await f.frame("2"), seq10 = await f.frame("10");
    f.store.enqueue(seq2.proof, f.owner.public.fingerprint);
    f.store.enqueue(seq10.proof, f.owner.public.fingerprint);
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)?.digest).toBe(seq2.proof.digest);
    f.store.ack(f.roster.room, f.guest.public.fingerprint, seq2.proof.digest);
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)?.digest).toBe(seq10.proof.digest);
  } finally { f.store.close(); f.cleanup(); }
});

test("broker queue applies per-room, global-byte and TTL bounds", async () => {
  let now = 10_000;
  const f = await fixture(() => now);
  f.store.close();
  try {
    const first = await f.frame("1");
    const second = await f.frame("2");
    f.store = await BrokerStore.open({ stateDir: f.stateDir, limits: { queuedPerRoom: 1, queuedGlobal: 1, packetBytes: first.wire.byteLength, queueTtlMs: 500 }, clock: () => now });
    f.store.install(f.roster, f.owner.public.fingerprint);
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    expect(() => f.store.enqueue(second.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    expect(f.store.stats().queuedFrames).toBe(1);
    now += 500;
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)).toBeUndefined();
    expect(f.store.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
  } finally { f.store.close(); f.cleanup(); }
});

test("per-room byte cap is independent and grandfathered queue data blocks new admission", async () => {
  const f = await fixture();
  f.store.close();
  try {
    const first = await f.frame("1"), second = await f.frame("2"), third = await f.frame("3");
    f.store = await BrokerStore.open({ stateDir: f.stateDir });
    f.store.install(f.roster, f.owner.public.fingerprint);
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    f.store.enqueue(second.proof, f.owner.public.fingerprint);
    f.store.close();
    f.store = await BrokerStore.open({ stateDir: f.stateDir, limits: { queuedBytesPerRoom: first.wire.byteLength } });
    expect(f.store.stats().queuedFrames).toBe(2);
    expect(() => f.store.enqueue(third.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    expect(f.store.stats().queuedFrames).toBe(2);
  } finally { f.store.close(); f.cleanup(); }
});

test("previous epoch grace expires at 60 seconds and cannot be refreshed by a same-epoch replay", async () => {
  let now = 20_000;
  const f = await fixture(() => now);
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const oldPacket = await f.frame("1");
    const rotated = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")], previous: f.epoch });
    const current = await verifyPublicRoster({ wire: rotated.wire, pin: { room: f.roster.room, owner: f.owner.public.fingerprint, minEpoch: f.roster.epoch, digest: f.roster.digest } });
    f.store.install(current, f.owner.public.fingerprint);
    expect(f.store.current(f.roster.room)?.previous?.expiresAt).toBe(now + 60_000);
    now += 59_999;
    expect(f.store.enqueue(oldPacket.proof, f.owner.public.fingerprint).duplicate).toBe(false);
    expect(f.store.install(current, f.owner.public.fingerprint).changed).toBe(false);
    expect(f.store.current(f.roster.room)?.previous?.expiresAt).toBe(80_000);
    now = 80_000;
    expect(() => f.store.enqueue(oldPacket.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    expect(f.store.current(f.roster.room)?.previous).toBeUndefined();
  } finally { f.store.close(); f.cleanup(); }
});

test("restart after previous-epoch grace expires purges stale queued frames without rejecting the store", async () => {
  let now = 30_000;
  const f = await fixture(() => now);
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const packet = await f.frame("1");
    const rotated = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")], previous: f.epoch });
    const current = await verifyPublicRoster({ wire: rotated.wire, pin: { room: f.roster.room, owner: f.owner.public.fingerprint, minEpoch: f.roster.epoch, digest: f.roster.digest } });
    f.store.install(current, f.owner.public.fingerprint);
    f.store.enqueue(packet.proof, f.owner.public.fingerprint);
    now += 60_000;
    f.store.close();
    const restored = await BrokerStore.open({ stateDir: f.stateDir, clock: () => now });
    try {
      expect(restored.current(f.roster.room)?.current.digest).toBe(current.digest);
      expect(restored.current(f.roster.room)?.previous).toBeUndefined();
      expect(restored.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
    } finally { restored.close(); }
  } finally { f.store.close(); f.cleanup(); }
});

test("enqueue rechecks previous-epoch trust at the transactional write time", async () => {
  let now = 40_000, crossGrace = false, clockReads = 0;
  const clock = () => crossGrace ? (++clockReads >= 2 ? 100_000 : 99_999) : now;
  const f = await fixture(clock);
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const packet = await f.frame("1");
    const rotated = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")], previous: f.epoch });
    const current = await verifyPublicRoster({ wire: rotated.wire, pin: { room: f.roster.room, owner: f.owner.public.fingerprint, minEpoch: f.roster.epoch, digest: f.roster.digest } });
    f.store.install(current, f.owner.public.fingerprint);
    crossGrace = true;
    expect(() => f.store.enqueue(packet.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    expect(f.store.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
  } finally { f.store.close(); f.cleanup(); }
});

test("installing a roster purges queued traffic for a removed recipient immediately", async () => {
  const f = await fixture();
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const packet = await f.frame("1");
    f.store.enqueue(packet.proof, f.owner.public.fingerprint);
    const rotated = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner")], previous: f.epoch });
    const current = await verifyPublicRoster({ wire: rotated.wire, pin: { room: f.roster.room, owner: f.owner.public.fingerprint, minEpoch: f.roster.epoch, digest: f.roster.digest } });
    expect(f.store.install(current, f.owner.public.fingerprint)).toEqual({ changed: true, revoked: [f.guest.public.fingerprint] });
    expect(f.store.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)).toBeUndefined();
  } finally { f.store.close(); f.cleanup(); }
});

test("exclusive database ownership releases on close", async () => {
  const f = await fixture();
  try {
    await expect(BrokerStore.open({ stateDir: f.stateDir })).rejects.toMatchObject({ code: "busy" });
    f.store.close();
    const reopened = await BrokerStore.open({ stateDir: f.stateDir });
    reopened.close();
  } finally { f.store.close(); f.cleanup(); }
});

test("dropRoom deletes only the named room and frees a room slot", async () => {
  const f = await fixture();
  f.store.close();
  try {
    f.store = await BrokerStore.open({ stateDir: f.stateDir, limits: { rooms: 2 } });
    f.store.install(f.roster, f.owner.public.fingerprint);
    const secondEpoch = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")] });
    const secondRoster = await verifyPublicRoster({ wire: secondEpoch.wire, pin: { room: secondEpoch.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "0" } });
    f.store.install(secondRoster, f.owner.public.fingerprint);
    const first = await f.frame("1");
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    const secondWire = await sealFrame({ epoch: secondEpoch.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode(canary), sequence: { reserve: async () => "1", isCurrent: () => true } });
    const second = await verifyPublicFrame({ wire: secondWire, roster: secondRoster });
    f.store.enqueue(second, f.owner.public.fingerprint);
    await expect(BrokerStore.open({ stateDir: f.stateDir, create: false })).rejects.toMatchObject({ code: "busy" });
    expect(f.store.dropRoom(f.roster.room)).toEqual({ removed: true });
    expect(() => f.store.dropRoom("not-a-room-id")).toThrow(BrokerStoreError);
    expect(f.store.current(f.roster.room)).toBeUndefined();
    expect(f.store.next(secondRoster.room, f.guest.public.fingerprint)?.digest).toBe(second.digest);
    const thirdEpoch = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")] });
    const thirdRoster = await verifyPublicRoster({ wire: thirdEpoch.wire, pin: { room: thirdEpoch.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "0" } });
    expect(f.store.dropRoom(thirdEpoch.epoch.room)).toEqual({ removed: false });
    expect(() => f.store.install(thirdRoster, f.owner.public.fingerprint)).not.toThrow();
    expect(f.store.stats()).toMatchObject({ rooms: 2, queuedFrames: 1 });
  } finally { f.store.close(); f.cleanup(); }
});

test("a preexisting empty broker database is refused without initialization", async () => {
  const f = temporary();
  const file = join(f.stateDir, "broker.db");
  writeFileSync(file, new Uint8Array());
  try {
    await expect(BrokerStore.open({ stateDir: f.stateDir })).rejects.toMatchObject({ code: "corrupt" });
    expect(readFileSync(file)).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("open refuses a populated non-private state directory without changing it", async () => {
  const f = temporary(), marker = join(f.stateDir, "keep.txt");
  writeFileSync(marker, "keep");
  chmodSync(f.stateDir, 0o755);
  const mode = statSync(f.stateDir).mode & 0o777;
  try {
    await expect(BrokerStore.open({ stateDir: f.stateDir })).rejects.toMatchObject({ code: "invalid" });
    expect(statSync(f.stateDir).mode & 0o777).toBe(mode);
    expect(readFileSync(marker, "utf8")).toBe("keep");
  } finally { chmodSync(f.stateDir, 0o700); f.cleanup(); }
});

test("create:false requires an existing broker directory and database", async () => {
  const missing = join(tmpdir(), `ahub-broker-missing-${crypto.randomUUID()}`);
  await expect(BrokerStore.open({ stateDir: missing, create: false })).rejects.toMatchObject({ code: "invalid" });
  const f = temporary();
  try {
    await expect(BrokerStore.open({ stateDir: f.stateDir, create: false })).rejects.toMatchObject({ code: "invalid" });
    expect(existsSync(join(f.stateDir, "broker.db"))).toBe(false);
  } finally { f.cleanup(); }
});

test("schema v1 migrates queue epochs without dropping roster, floors or ciphertext", async () => {
  const f = await fixture(() => 5_000);
  f.store.close();
  const migration = temporary(), file = join(migration.stateDir, "broker.db");
  try {
    const packet = await f.frame("2"), later = await f.frame("10");
    const rotated = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")], previous: f.epoch });
    const current = await verifyPublicRoster({ wire: rotated.wire, pin: { room: f.roster.room, owner: f.owner.public.fingerprint, minEpoch: f.roster.epoch, digest: f.roster.digest } });
    const db = new Database(file, { create: true });
    db.exec(`
      PRAGMA journal_mode=DELETE;
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
      PRAGMA user_version=1;
    `);
    db.query("INSERT INTO rooms(room,owner,current_epoch,current_digest,current_wire,previous_epoch,previous_digest,previous_wire,previous_expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(current.room, current.owner, current.epoch, current.digest, publicRosterWire(current), f.roster.epoch, f.roster.digest, publicRosterWire(f.roster), 65_000);
    db.query("INSERT INTO sender_floors(room,sender,seq,digest) VALUES(?,?,?,?)")
      .run(f.roster.room, f.owner.public.fingerprint, "10", later.proof.digest);
    for (const queued of [packet, later]) db.query("INSERT INTO queued_frames(room,sender,seq,digest,wire,recipients,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(f.roster.room, queued.proof.sender, queued.proof.seq, queued.proof.digest, queued.wire, JSON.stringify(queued.proof.recipients), 5_000, 86_405_000);
    db.close();

    let now = 5_000;
    f.store = await BrokerStore.open({ stateDir: migration.stateDir, clock: () => now });
    expect(f.store.current(f.roster.room)?.current.digest).toBe(current.digest);
    expect(f.store.current(f.roster.room)?.previous?.expiresAt).toBe(65_000);
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)).toEqual({ digest: packet.proof.digest, wire: packet.wire });
    expect(f.store.stats()).toMatchObject({ queuedFrames: 2, queuedBytes: packet.wire.byteLength + later.wire.byteLength });
    f.store.ack(f.roster.room, f.guest.public.fingerprint, packet.proof.digest);
    expect(f.store.next(f.roster.room, f.guest.public.fingerprint)).toEqual({ digest: later.proof.digest, wire: later.wire });
    f.store.ack(f.roster.room, f.guest.public.fingerprint, later.proof.digest);
    expect(f.store.enqueue(later.proof, f.owner.public.fingerprint)).toMatchObject({ duplicate: true });
    now = 64_000; expect(f.store.install(current, f.owner.public.fingerprint).changed).toBe(false);
    expect(f.store.current(f.roster.room)?.previous?.expiresAt).toBe(65_000);
    now = 65_000; f.store.sweep();
    expect(f.store.current(f.roster.room)?.previous).toBeUndefined();
    expect(() => f.store.enqueue(later.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    f.store.close();
    const migratedDb = new Database(file, { readonly: true });
    try { expect(migratedDb.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2); }
    finally { migratedDb.close(); }
  } finally { f.store.close(); f.cleanup(); migration.cleanup(); }
});


test("queue ACK and restart retain the sender floor without recreating an acknowledged packet", async () => {
  const f = await fixture();
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const first = await f.frame("1");
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    f.store.ack(f.roster.room, f.guest.public.fingerprint, first.proof.digest);
    f.store.close();
    const restored = await BrokerStore.open({ stateDir: f.stateDir });
    try {
      expect(restored.enqueue(first.proof, f.owner.public.fingerprint)).toMatchObject({ duplicate: true });
      expect(restored.stats().queuedFrames).toBe(0);
      const conflicting = await f.frame("1");
      expect(() => restored.enqueue(conflicting.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
      const next = await f.frame("2");
      expect(restored.enqueue(next.proof, f.owner.public.fingerprint)).toMatchObject({ duplicate: false });
    } finally { restored.close(); }
  } finally { f.store.close(); f.cleanup(); }
});


test("global packet and aggregate byte caps operate independently of the per-room cap", async () => {
  for (const cap of ["global", "bytes"] as const) {
    const f = await fixture();
    f.store.close();
    const first = await f.frame("1"), second = await f.frame("2");
    try {
      f.store = await BrokerStore.open({ stateDir: f.stateDir, limits: { queuedPerRoom: 3, queuedGlobal: cap === "global" ? 1 : 3, packetBytes: cap === "bytes" ? first.wire.byteLength : 32 * 1024 * 1024 } });
      f.store.install(f.roster, f.owner.public.fingerprint);
      f.store.enqueue(first.proof, f.owner.public.fingerprint);
      if (cap === "bytes") {
        expect(second.wire.byteLength).toBe(first.wire.byteLength);
        expect(() => f.store.enqueue(second.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
        expect(f.store.stats().queuedBytes).toBe(first.wire.byteLength);
        f.store.ack(f.roster.room, f.guest.public.fingerprint, first.proof.digest);
        expect(f.store.enqueue(second.proof, f.owner.public.fingerprint).duplicate).toBe(false);
      } else {
        const other = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner"), member(f.guest, "guest")] });
        const roster = await verifyPublicRoster({ wire: other.wire, pin: { room: other.epoch.room, owner: f.owner.public.fingerprint, minEpoch: "0" } });
        f.store.install(roster, f.owner.public.fingerprint);
        const wire = await sealFrame({ epoch: other.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("other room"), sequence: { reserve: async () => "1", isCurrent: () => true } });
        const proof = await verifyPublicFrame({ wire, roster });
        expect(() => f.store.enqueue(proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
        expect(f.store.stats().queuedFrames).toBe(1);
      }
    } finally { f.store.close(); f.cleanup(); }
  }
});


test("retained lower-sequence packets deduplicate after a newer floor without inventing removed history", async () => {
  const f = await fixture();
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const first = await f.frame("1"), second = await f.frame("2");
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    f.store.enqueue(second.proof, f.owner.public.fingerprint);
    let duplicate: { digest: string; duplicate: boolean } | undefined;
    expect(() => { duplicate = f.store.enqueue(first.proof, f.owner.public.fingerprint); }).not.toThrow();
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(f.store.stats().queuedFrames).toBe(2);
    f.store.ack(f.roster.room, f.guest.public.fingerprint, first.proof.digest);
    expect(() => f.store.enqueue(first.proof, f.owner.public.fingerprint)).toThrow(BrokerStoreError);
    expect(f.store.stats().queuedFrames).toBe(1);
  } finally { f.store.close(); f.cleanup(); }
});


test("ordinary current, next, ACK and admission do not parse retained frame bodies", async () => {
  const f = await fixture();
  try {
    f.store.install(f.roster, f.owner.public.fingerprint);
    const first = await f.frame("1"), second = await f.frame("2");
    f.store.enqueue(first.proof, f.owner.public.fingerprint);
    const parse = JSON.parse;
    const probe = spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (typeof value === "string" && value.includes('"type":"frame"')) throw new Error("ordinary read decoded a retained packet");
      return parse(value, reviver);
    });
    try {
      expect(f.store.current(f.roster.room)?.current.digest).toBe(f.roster.digest);
      expect(f.store.next(f.roster.room, f.guest.public.fingerprint)?.wire).toEqual(first.wire);
      f.store.ack(f.roster.room, f.guest.public.fingerprint, first.proof.digest);
      expect(f.store.enqueue(second.proof, f.owner.public.fingerprint).duplicate).toBe(false);
      expect(f.store.stats().queuedFrames).toBe(1);
    } finally { probe.mockRestore(); }
  } finally { f.store.close(); f.cleanup(); }
});
