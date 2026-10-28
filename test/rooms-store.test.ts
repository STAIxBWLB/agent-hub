import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore, type RoomRefusalReason } from "../src/rooms/store.ts";
import { createInvite, createJoin, createRoomEpoch, openFrame, roomMembers, sealFrame, type RoomMember } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256, generateHubIdentity, type HubIdentity } from "../src/rooms/crypto.ts";

const dirs: string[] = [], stores: RoomStore[] = [];
const locations = new WeakMap<RoomStore, string>();
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const text = new TextEncoder();
const member = (identity: HubIdentity, label: string): RoomMember => ({ ...identity.public, label, exposedPeers: [] });
function root() { const dir = mkdtempSync(join(tmpdir(), "ahub-room-store-")); dirs.push(dir); return dir; }
async function store(dir = join(root(), "state"), clock?: () => number) {
  const value = await RoomStore.open({ stateDir: dir, ...(clock ? { clock } : {}) }); stores.push(value); locations.set(value, dir); return value;
}
async function created(owner: RoomStore, name = "work") {
  const candidate = await createRoomEpoch({ owner: owner.identity, members: [member(owner.identity, "owner")] });
  return owner.install({ name, broker: "ws://127.0.0.1:8788/", wire: candidate.wire, expectedDigest: null });
}
async function pair(now = () => Date.now()) {
  const owner = await store(undefined, now), guest = await store(undefined, now), initial = await created(owner);
  const token = await createInvite({ epoch: initial.current, owner: owner.identity, broker: initial.broker, expiresAt: now() + 600000, nowMs: now() });
  await owner.saveInvite("work", token);
  const request = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: [], nowMs: now() });
  guest.savePendingJoin("work", { invite: token, request });
  const roster = await owner.enroll("work", request);
  await guest.install({ name: "work", broker: roster.broker, wire: roster.wire, expectedDigest: null });
  return { owner, guest, token, request, initial, roster };
}

test("room store creates private durable identity, refuses unknown/symlink state and holds exclusive ownership", async () => {
  const dir = root(), stateDir = join(dir, "state"), first = await store(stateDir), fp = first.identity.public.fingerprint;
  expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(stateDir, "rooms.db")).mode & 0o777).toBe(0o600);
  await expect(RoomStore.open({ stateDir })).rejects.toMatchObject({ code: "busy" });
  first.close();
  const reopened = await store(stateDir);
  expect(reopened.identity.public.fingerprint).toBe(fp);
  reopened.close();
  const unknown = join(dir, "populated");
  mkdirSync(unknown); await Bun.write(join(unknown, "person.txt"), "untouched"); chmodSync(unknown, 0o755);
  await expect(RoomStore.open({ stateDir: unknown })).rejects.toMatchObject({ code: "invalid" });
  expect(statSync(unknown).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(unknown, "person.txt"), "utf8")).toBe("untouched");
  const linked = join(dir, "linked"); symlinkSync(stateDir, linked);
  await expect(RoomStore.open({ stateDir: linked })).rejects.toMatchObject({ code: "invalid" });
});

test("room first install requires explicit pending invitation owner pin, never broker supplied TOFU", async () => {
  const victim = await store(), attacker = await generateHubIdentity();
  const candidate = await createRoomEpoch({ owner: attacker, members: [member(attacker, "attacker"), member(victim.identity, "victim")] });
  await expect(victim.install({ name: "work", broker: "ws://127.0.0.1:8788/", wire: candidate.wire, expectedDigest: null })).rejects.toMatchObject({ code: "untrusted" });
  expect(victim.list()).toHaveLength(0);
  const trusted = await generateHubIdentity();
  const initial = await createRoomEpoch({ owner: trusted, members: [member(trusted, "trusted")] });
  const invite = await createInvite({ owner: trusted, epoch: initial.epoch, broker: "ws://127.0.0.1:8788/", expiresAt: Date.now() + 60000 });
  const request = await createJoin({ invite, identity: victim.identity, label: "victim", exposedPeers: [] });
  victim.savePendingJoin("work", { invite, request });
  await expect(victim.install({ name: "work", broker: "ws://127.0.0.1:8788/", wire: candidate.wire, expectedDigest: null })).rejects.toMatchObject({ code: "untrusted" });
  expect(victim.list()).toHaveLength(0);
});

test("room sequence counters, adjacent grace and epoch digest pins survive restart without renewal", async () => {
  let now = 100000;
  const dir = join(root(), "state"), owner = await store(dir, () => now), initial = await created(owner);
  const binding = { room: initial.current.room, sender: owner.identity.public.fingerprint, epoch: initial.current.epoch, rosterDigest: initial.current.digest };
  expect(await owner.sequence.reserve(binding)).toBe("1");
  now += 100;
  const rotated = await owner.rotate("work", roomMembers(initial.current), initial.current.digest);
  expect(rotated.previous?.expiresAt).toBe(now + 60000);
  const expiry = rotated.previous!.expiresAt;
  now += 100;
  await owner.install({ name: "work", broker: rotated.broker, wire: rotated.wire, expectedDigest: rotated.current.digest });
  expect(owner.get("work")?.previous?.expiresAt).toBe(expiry);
  owner.close();
  const restored = await store(dir, () => now), current = restored.get("work")!;
  expect(current.previous?.expiresAt).toBe(expiry);
  expect(await restored.sequence.reserve({ ...binding, epoch: current.current.epoch, rosterDigest: current.current.digest })).toBe("2");
  await expect(restored.sequence.reserve(binding)).rejects.toMatchObject({ code: "state_changed" });
  await expect(restored.install({ name: "work", broker: current.broker, wire: initial.wire, expectedDigest: current.current.digest })).rejects.toThrow();
  const competing = await createRoomEpoch({ owner: restored.identity, members: roomMembers(initial.current), previous: initial.current });
  await expect(restored.install({ name: "work", broker: current.broker, wire: competing.wire, expectedDigest: current.current.digest })).rejects.toThrow();
  expect(restored.get("work")?.current.digest).toBe(rotated.current.digest);
  now -= 1000;
  expect(() => restored.get("work")).toThrow("clock_rollback");
});

test("room replay commits plaintext once, preserves exact duplicates across restart and drops unknown lower sequences", async () => {
  const f = await pair(), room = f.guest.get("work")!;
  const wire = await sealFrame({ epoch: f.roster.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("once"), sequence: f.owner.sequence });
  const opens = await Promise.all([1, 2, 3].map(() => openFrame({ wire, identity: f.guest.identity, current: room.current, replay: f.guest.replay })));
  expect(opens.map(x => x.status).sort()).toEqual(["accepted", "duplicate", "duplicate"]);
  expect(f.guest.pendingInbox("work")).toHaveLength(1);
  const entry = f.guest.pendingInbox("work")[0]!;
  f.guest.settleInbox("work", entry.digest);
  expect(f.guest.pendingInbox("work")).toHaveLength(0);
  const stale = await f.guest.replay.accept({ room: room.current.room, sender: f.owner.identity.public.fingerprint, recipient: f.guest.identity.public.fingerprint,
    seq: "1", frameDigest: "different", frameEpoch: room.current.epoch, expectedCurrentEpoch: room.current.epoch, expectedCurrentDigest: room.current.digest,
    selectedRosterDigest: room.current.digest, previousExpiresAt: null, plaintext: text.encode("other") });
  expect(stale.status).toBe("conflict");
  // A sequence gap is accepted, never waited on; only its actual digest is recognized later.
  await f.owner.sequence.reserve({ room: room.current.room, sender: f.owner.identity.public.fingerprint, epoch: room.current.epoch, rosterDigest: room.current.digest });
  const third = await sealFrame({ epoch: f.roster.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("third"), sequence: f.owner.sequence });
  const accepted = await openFrame({ wire: third, identity: f.guest.identity, current: room.current, replay: f.guest.replay });
  expect(accepted).toMatchObject({ status: "accepted", gap: "1" });
  const unknown = await f.guest.replay.accept({ room: room.current.room, sender: f.owner.identity.public.fingerprint, recipient: f.guest.identity.public.fingerprint,
    seq: "2", frameDigest: "not-accepted", frameEpoch: room.current.epoch, expectedCurrentEpoch: room.current.epoch, expectedCurrentDigest: room.current.digest,
    selectedRosterDigest: room.current.digest, previousExpiresAt: null, plaintext: text.encode("never") });
  expect(unknown.status).toBe("stale");
  const directory = locations.get(f.guest)!;
  f.guest.close();
  const restored = await store(directory);
  expect((await openFrame({ wire, identity: restored.identity, current: restored.get("work")!.current, replay: restored.replay })).status).toBe("duplicate");
});

test("room enrollment consumes once atomically with roster publication; substituted and expired requests leave epoch untouched", async () => {
  let now = 100000;
  const f = await pair(() => now);
  expect(f.roster.current.epoch).toBe("2");
  expect((await f.owner.enroll("work", f.request)).current.digest).toBe(f.roster.current.digest);
  const impostor = await generateHubIdentity();
  const changed = await createJoin({ invite: f.token, identity: impostor, label: "other", exposedPeers: [], nowMs: now });
  await expect(f.owner.enroll("work", changed)).rejects.toThrow();
  expect(f.owner.get("work")?.current.digest).toBe(f.roster.current.digest);
  const token = await createInvite({ epoch: f.roster.current, owner: f.owner.identity, broker: f.roster.broker, expiresAt: now + 1, nowMs: now });
  await f.owner.saveInvite("work", token);
  const request = await createJoin({ invite: token, identity: impostor, label: "other", exposedPeers: [], nowMs: now });
  now += 2;
  await expect(f.owner.enroll("work", request)).rejects.toMatchObject({ code: "expired" });
  expect(f.owner.get("work")?.current.digest).toBe(f.roster.current.digest);
});

test("room mutation fences refuse after crypto and a left room cannot be reactivated by an automatic roster", async () => {
  const owner = await store(), initial = await created(owner);
  const next = await createRoomEpoch({ owner: owner.identity, members: roomMembers(initial.current), previous: initial.current });
  await expect(owner.install({ name: "work", broker: initial.broker, wire: next.wire, expectedDigest: initial.current.digest, current: () => false })).rejects.toMatchObject({ code: "state_changed" });
  expect(owner.get("work")?.current.digest).toBe(initial.current.digest);
  const installing = owner.install({ name: "work", broker: initial.broker, wire: next.wire, expectedDigest: initial.current.digest });
  owner.leave("work");
  await expect(installing).rejects.toMatchObject({ code: "state_changed" });
  await expect(owner.install({ name: "work", broker: initial.broker, wire: next.wire, expectedDigest: initial.current.digest })).rejects.toMatchObject({ code: "state_changed" });
  await owner.install({ name: "work", broker: initial.broker, wire: next.wire, expectedDigest: initial.current.digest, reactivate: true });
  expect(owner.get("work")?.left).toBe(false);
});

test("room durable outbox retries identical ciphertext and broker storage never claims application completion", async () => {
  const f = await pair(), room = f.owner.get("work")!;
  const wire = await sealFrame({ epoch: room.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("presence"), sequence: f.owner.sequence });
  await f.owner.enqueue("work", wire);
  await f.owner.enqueue("work", wire);
  expect(f.owner.outbox("work")).toHaveLength(1);
  const entry = f.owner.outbox("work")[0]!;
  expect(entry.state).toBe("dispatching");
  f.owner.markStored("work", entry.digest);
  expect(f.owner.outbox("work")[0]!.state).toBe("accepted");
  expect(f.owner.outbox("work")[0]!.wire).toEqual(wire);
  expect("completed" in f.owner.outbox("work")[0]!).toBe(false);
  const another = await sealFrame({ epoch: room.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("later"), sequence: f.owner.sequence });
  await expect(f.owner.enqueue("work", another, () => false)).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.outbox("work")).toHaveLength(1);
});


test("room pending enrollment can be explicitly cancelled without forgetting an installed room pin", async () => {
  const owner = await store(), guest = await store(), initial = await created(owner);
  const token = await createInvite({ epoch: initial.current, owner: owner.identity, broker: initial.broker, expiresAt: Date.now() + 600000 });
  const request = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: [] });
  guest.savePendingJoin("work", { invite: token, request });
  expect(guest.pendingJoin("work")).toBeDefined();
  guest.cancelPendingJoin("work");
  expect(guest.pendingJoin("work")).toBeUndefined();
  await expect(guest.install({ name: "work", broker: initial.broker, wire: initial.wire, expectedDigest: null })).rejects.toMatchObject({ code: "untrusted" });
  owner.cancelPendingJoin("work");
  expect(owner.get("work")?.current.digest).toBe(initial.current.digest);
});

test("room restore rejects a zero or noncanonical durable sender counter before publishing sequence ports", async () => {
  for (const seq of ["0", "01", "18446744073709551616"]) {
    const dir = join(root(), "state"), owner = await store(dir), state = await created(owner);
    await owner.sequence.reserve({ room: state.current.room, sender: owner.identity.public.fingerprint, epoch: state.current.epoch, rosterDigest: state.current.digest });
    owner.close();
    const db = new Database(join(dir, "rooms.db"));
    try { db.query("UPDATE counters SET seq=?").run(seq); } finally { db.close(); }
    await expect(RoomStore.open({ stateDir: dir })).rejects.toMatchObject({ code: "corrupt" });
  }
});

test("room restore rejects invalid replay floors and never resets them to a permissive default", async () => {
  const f = await pair(), state = f.guest.get("work")!;
  const wire = await sealFrame({ epoch: f.roster.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("committed"), sequence: f.owner.sequence });
  await openFrame({ wire, identity: f.guest.identity, current: state.current, replay: f.guest.replay });
  const directory = locations.get(f.guest)!; f.guest.close();
  const db = new Database(join(directory, "rooms.db"));
  try { db.query("UPDATE floors SET seq='0'").run(); } finally { db.close(); }
  await expect(RoomStore.open({ stateDir: directory })).rejects.toMatchObject({ code: "corrupt" });
});

test("room restore refuses an over-cap pending table of otherwise valid enrollment rows", async () => {
  const dir = join(root(), "state"), value = await store(dir), owner = await store(), state = await created(owner);
  const token = await createInvite({ epoch: state.current, owner: owner.identity, broker: state.broker, expiresAt: Date.now() + 600000 });
  const request = await createJoin({ invite: token, identity: value.identity, label: "pending", exposedPeers: [] });
  value.close();
  const db = new Database(join(dir, "rooms.db"));
  try {
    const insert = db.query("INSERT INTO pending_joins(name,invite,request,selection) VALUES(?,?,?,NULL)");
    for (let i = 0; i < 65; i++) insert.run(`pending-${i}`, token, request);
  } finally { db.close(); }
  await expect(RoomStore.open({ stateDir: dir })).rejects.toMatchObject({ code: "corrupt" });
});

test("room restore authenticates retained historical outbox rosters without lowering the live epoch pin", async () => {
  const f = await pair(), state = f.owner.get("work")!;
  const wire = await sealFrame({ epoch: state.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("retained"), sequence: f.owner.sequence });
  await f.owner.enqueue("work", wire);
  const middle = await f.owner.rotate("work", roomMembers(state.current), state.current.digest);
  const latest = await f.owner.rotate("work", roomMembers(middle.current), middle.current.digest);
  const directory = locations.get(f.owner)!; f.owner.close();
  const restored = await store(directory);
  expect(restored.get("work")?.current.digest).toBe(latest.current.digest);
  expect(restored.outbox("work")[0]?.wire).toEqual(wire);
  restored.close();
  const db = new Database(join(directory, "rooms.db"));
  try { db.query("UPDATE outbox SET digest=?").run(encodeBase64url(new Uint8Array(32))); } finally { db.close(); }
  await expect(RoomStore.open({ stateDir: directory })).rejects.toMatchObject({ code: "corrupt" });
});

test("room restore revalidates stored invitation digests and pending identity metadata", async () => {
  const f = await pair(), directory = locations.get(f.owner)!; f.owner.close();
  const db = new Database(join(directory, "rooms.db"));
  try { db.query("UPDATE invites SET digest=?").run(encodeBase64url(new Uint8Array(32))); } finally { db.close(); }
  await expect(RoomStore.open({ stateDir: directory })).rejects.toMatchObject({ code: "corrupt" });
  const guest = await store(), pendingDir = locations.get(guest)!;
  const request = await createJoin({ invite: f.token, identity: guest.identity, label: "pending", exposedPeers: [] });
  guest.savePendingJoin("pending", { invite: f.token, request, selection: JSON.stringify({ label: "pending", peers: [] }) }); guest.close();
  const pendingDb = new Database(join(pendingDir, "rooms.db"));
  try { pendingDb.query("UPDATE pending_joins SET selection=?").run("x".repeat(4097)); } finally { pendingDb.close(); }
  await expect(RoomStore.open({ stateDir: pendingDir })).rejects.toMatchObject({ code: "corrupt" });
});

test("room transport-drop ledger is durable fixed metadata and never advances replay floors or inbox delivery", async () => {
  let now = 100000;
  const f = await pair(() => now), state = f.guest.get("work")!;
  const wire = await sealFrame({ epoch: f.roster.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: text.encode("not a drop receipt body"), sequence: f.owner.sequence });
  const frameDigest = encodeBase64url(await sha256(wire));
  f.guest.recordRefused("work", frameDigest, "invalid_presence");
  expect(f.guest.refused("work")).toEqual([{ digest: frameDigest, reason: "invalid_presence", at: now }]);
  now += 1;
  f.guest.recordRefused("work", frameDigest, "invalid_frame");
  expect(f.guest.refused("work")).toEqual([{ digest: frameDigest, reason: "invalid_presence", at: now - 1 }]);
  expect(f.guest.pendingInbox("work")).toHaveLength(0);
  const directory = locations.get(f.guest)!; f.guest.close();
  const db = new Database(join(directory, "rooms.db"));
  try {
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM floors").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox").get()?.n).toBe(0);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(refusals)").all().map(row => row.name)).toEqual(["room", "digest", "reason", "at"]);
  } finally { db.close(); }
  const restored = await store(directory, () => now);
  expect(restored.refused("work")).toEqual([{ digest: frameDigest, reason: "invalid_presence", at: now - 1 }]);
  const accepted = await openFrame({ wire, identity: restored.identity, current: restored.get("work")!.current, replay: restored.replay });
  expect(accepted).toMatchObject({ status: "accepted", gap: "0" });
  expect(state.current.digest).toBe(restored.get("work")!.current.digest);
});

test("room transport-drop ledger refuses invalid metadata and stale authority, and evicts only bounded diagnostics", async () => {
  const owner = await store(), state = await created(owner), hash = encodeBase64url(new Uint8Array(32));
  for (const bad of ["", "not-a-digest", `${hash}=`, "A".repeat(42) + "B"]) {
    expect(() => owner.recordRefused("work", bad, "invalid_frame")).toThrow("invalid");
  }
  expect(() => owner.recordRefused("work", hash, "arbitrary" as RoomRefusalReason)).toThrow("invalid");
  expect(() => owner.recordRefused("work", hash, "trust_changed", () => false)).toThrow("state_changed");
  expect(owner.refused("work")).toHaveLength(0);
  const binding = { room: state.current.room, sender: owner.identity.public.fingerprint, epoch: state.current.epoch, rosterDigest: state.current.digest };
  expect(await owner.sequence.reserve(binding)).toBe("1");
  for (let i = 0; i < 1002; i++) {
    const raw = new Uint8Array(32); new DataView(raw.buffer).setUint32(0, i);
    owner.recordRefused("work", encodeBase64url(raw), "stale");
  }
  const rows = owner.refused("work");
  expect(rows).toHaveLength(1000);
  expect(rows.some(row => row.digest === hash)).toBe(false);
  expect(await owner.sequence.reserve(binding)).toBe("2");
  expect(owner.pendingInbox("work")).toHaveLength(0);
  owner.leave("work");
  expect(() => owner.recordRefused("work", hash, "stale")).toThrow("untrusted");
  expect(owner.refused("work")).toHaveLength(1000);
});

test("room restore rejects forged transport-drop metadata or over-cap diagnostic records", async () => {
  for (const mutation of ["reason", "digest", "time", "cap"]) {
    const directory = join(root(), "state"), owner = await store(directory), state = await created(owner);
    owner.recordRefused("work", encodeBase64url(new Uint8Array(32)), "wrong_epoch"); owner.close();
    const db = new Database(join(directory, "rooms.db"));
    try {
      if (mutation === "reason") db.query("UPDATE refusals SET reason='body from model'").run();
      else if (mutation === "digest") db.query("UPDATE refusals SET digest='invalid'").run();
      else if (mutation === "time") db.query("UPDATE refusals SET at=0").run();
      else for (let i = 1; i < 1001; i++) {
        const raw = new Uint8Array(32); new DataView(raw.buffer).setUint32(0, i);
        db.query("INSERT INTO refusals(room,digest,reason,at) VALUES(?,?,?,?)").run(state.current.room, encodeBase64url(raw), "stale", Date.now());
      }
    } finally { db.close(); }
    await expect(RoomStore.open({ stateDir: directory })).rejects.toMatchObject({ code: "corrupt" });
  }
});

test("a consumed JoinWire cannot re-enroll a member after owner revocation", async () => {
  const f = await pair(), guest = f.guest.identity.public.fingerprint;
  const before = f.owner.get("work")!;
  const revoked = await f.owner.rotate("work", roomMembers(before.current).filter(row => row.fingerprint !== guest), before.current.digest);
  await expect(f.owner.enroll("work", f.request)).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.get("work")?.current.digest).toBe(revoked.current.digest);
  expect(roomMembers(f.owner.get("work")!.current).some(row => row.fingerprint === guest)).toBe(false);
  const directory = locations.get(f.owner)!; f.owner.close();
  const db = new Database(join(directory, "rooms.db"));
  try {
    expect(db.query<{ digest: string }, []>("SELECT digest FROM rooms WHERE name='work'").get()?.digest).toBe(revoked.current.digest);
    const rows = db.query<{ request_digest: string | null }, []>("SELECT request_digest FROM invites").all();
    expect(rows).toHaveLength(1); expect(rows[0]?.request_digest).not.toBeNull();
  } finally { db.close(); }
});
