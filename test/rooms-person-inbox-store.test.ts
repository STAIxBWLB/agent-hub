import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore, RoomApplicationLimitError, ROOM_PERSON_INBOX_LIMITS, ROOM_APPLICATION_RETENTION } from "../src/rooms/store.ts";
import { encodeRoomMessage, type RoomChatEnvelope, type RoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, sealFrame, openFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, randomBytes, sha256 } from "../src/rooms/crypto.ts";

const roots: string[] = [], stores: RoomStore[] = [];
const directories = new WeakMap<RoomStore, string>();
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dbOf = (store: RoomStore) => (store as unknown as { db: Database }).db;
async function open(clock: () => number, directory?: string) {
  if (!directory) { const root = mkdtempSync(join(tmpdir(), "ahub-person-inbox-")); roots.push(root); directory = join(root, "state"); }
  const store = await RoomStore.open({ stateDir: directory, clock }); stores.push(store); directories.set(store, directory); return store;
}
async function pair() {
  let now = 1_800_000_000_000;
  const clock = () => now, owner = await open(clock), guest = await open(clock);
  async function addRoom(name: string) {
    const first = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
    await owner.install({ name, broker: "ws://127.0.0.1:8788/", wire: first.wire, expectedDigest: null });
    const invite = await createInvite({ owner: owner.identity, epoch: first.epoch, broker: "ws://127.0.0.1:8788/", expiresAt: now + 600000, nowMs: now });
    await owner.saveInvite(name, invite);
    const request = await createJoin({ invite, identity: guest.identity, label: "guest", exposedPeers: ["codex"], nowMs: now }); guest.savePendingJoin(name, { invite, request });
    const next = await owner.enroll(name, request); await guest.install({ name, broker: next.broker, wire: next.wire, expectedDigest: null });
  }
  await addRoom("work");
  return { owner, guest, clock, addRoom, now: () => now, advance: (ms: number) => { now += ms; } };
}
function chat(body = "PERSON-INBOX-CANARY", fields: Partial<RoomChatEnvelope> = {}): RoomChatEnvelope {
  return { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "user", kind: "chat", priority: "status", body, ts: 1, ...fields };
}
async function incoming(f: Awaited<ReturnType<typeof pair>>, envelope = chat(), name = "work", register = true) {
  const state = f.owner.get(name)!, wire = await sealFrame({ epoch: state.current, identity: f.owner.identity,
    recipients: [f.guest.identity.public.fingerprint], plaintext: encodeRoomMessage({ v: 1, type: "chat", envelope }), sequence: f.owner.sequence });
  const current = f.guest.get(name)!;
  expect((await openFrame({ wire, identity: f.guest.identity, current: current.current, replay: f.guest.replay })).status).toBe("accepted");
  const digest = encodeBase64url(await sha256(wire));
  if (register) await f.guest.applicationIncoming(name, digest);
  return { envelope, wire, digest };
}
async function receiptToOwner(f: Awaited<ReturnType<typeof pair>>, message: RoomMessage) {
  const wire = await sealFrame({ epoch: f.guest.get("work")!.current, identity: f.guest.identity,
    recipients: [f.owner.identity.public.fingerprint], plaintext: encodeRoomMessage(message), sequence: f.guest.sequence });
  expect((await openFrame({ wire, identity: f.owner.identity, current: f.owner.get("work")!.current, replay: f.owner.replay })).status).toBe("accepted");
  return encodeBase64url(await sha256(wire));
}

test("person admission commits body and immutable inbox receipt together, with metadata-only listing", async () => {
  const f = await pair(), item = await incoming(f, chat("한글 PERSON-INBOX-CANARY"));
  const result = f.guest.admitPersonInbox("work", item.digest, () => true);
  expect(result).toMatchObject({ state: "admitted", reason: "inbox_admitted" });
  expect(result.id).toMatch(/^[0-9a-f-]{36}$/); expect(result.id).not.toBe(item.envelope.id);
  expect(f.guest.readPersonInbox(result.id!, () => true)).toMatchObject({ id: result.id, body: item.envelope.body, state: "unread", from: "codex@owner", receivedAt: f.now(), expiresAt: f.now() + ROOM_PERSON_INBOX_LIMITS.ttlMs, bytes: Buffer.byteLength(item.envelope.body) });
  const metadata = f.guest.listPersonInbox("work"); expect(metadata).toHaveLength(1);
  expect(Object.keys(metadata[0]!).sort()).toEqual(["bytes", "expiresAt", "from", "id", "name", "receivedAt", "room", "sender", "state"]);
  expect(JSON.stringify(metadata)).not.toContain(item.envelope.body);
  expect(f.guest.applicationReceipt("work", item.digest)).toMatchObject({ type: "receipt", peer: "user", outcome: "completed", reason: "inbox_admitted" });
  expect(f.guest.pendingInbox("work")).toEqual([]);
  const directory = directories.get(f.guest)!; f.guest.close(); const restored = await open(f.clock, directory);
  expect(restored.readPersonInbox(result.id!, () => true)?.body).toBe(item.envelope.body);
  expect(restored.admitPersonInbox("work", item.digest)).toEqual({ state: "duplicate", reason: "inbox_admitted", id: result.id });
});

test("same-content aliases dedupe across inbox disposition without admitting a second body", async () => {
  const f = await pair(), first = await incoming(f), admitted = f.guest.admitPersonInbox("work", first.digest);
  const alias = await incoming(f, first.envelope);
  expect(f.guest.admitPersonInbox("work", alias.digest)).toEqual({ state: "duplicate", reason: "inbox_admitted", id: admitted.id });
  expect(f.guest.listPersonInbox("work")).toHaveLength(1);
  const receipt = f.guest.applicationReceipt("work", first.digest);
  f.guest.disposePersonInbox(admitted.id!, "done", () => true);
  expect(f.guest.readPersonInbox(admitted.id!, () => true)).toMatchObject({ state: "done" });
  expect(f.guest.readPersonInbox(admitted.id!, () => true)?.body).toBeUndefined();
  expect(f.guest.applicationReceipt("work", first.digest)).toEqual(receipt);
  expect(f.guest.admitPersonInbox("work", alias.digest).state).toBe("duplicate");
  const altered = await incoming(f, { ...first.envelope, body: "changed" }, "work", false);
  await expect(f.guest.applicationIncoming("work", altered.digest)).rejects.toMatchObject({ code: "invalid" });
  expect(f.guest.listPersonInbox("work")).toHaveLength(1);
});

test("person admission rolls back the body if the application receipt update cannot commit", async () => {
  const f = await pair(), item = await incoming(f), db = dbOf(f.guest);
  db.exec("CREATE TEMP TRIGGER person_admission_abort BEFORE UPDATE OF reason ON applications WHEN NEW.reason='inbox_admitted' BEGIN SELECT RAISE(ABORT,'fixture abort'); END;");
  expect(() => f.guest.admitPersonInbox("work", item.digest)).toThrow();
  expect(f.guest.listPersonInbox("work")).toEqual([]); expect(f.guest.applicationReceipt("work", item.digest)).toBeUndefined();
  expect(f.guest.pendingInbox("work")).toHaveLength(1);
  db.exec("DROP TRIGGER person_admission_abort;");
  expect(f.guest.admitPersonInbox("work", item.digest).state).toBe("admitted");
});

test("person read, disposition and admission recheck current authority before returning a body or committing", async () => {
  const f = await pair(), item = await incoming(f); let calls = 0;
  expect(() => f.guest.admitPersonInbox("work", item.digest, () => ++calls < 3)).toThrow("state_changed");
  expect(f.guest.listPersonInbox()).toEqual([]);
  const result = f.guest.admitPersonInbox("work", item.digest);
  expect(() => f.guest.readPersonInbox(result.id!, () => false)).toThrow("state_changed");
  calls = 0;
  expect(() => f.guest.readPersonInbox(result.id!, () => ++calls < 3)).toThrow("state_changed");
  expect(() => f.guest.disposePersonInbox(result.id!, "discard", () => false)).toThrow("state_changed");
  expect(f.guest.readPersonInbox(result.id!, () => true)?.state).toBe("unread");
});

test("100 unread entries refuse the next admission and disposition frees space without changing its old receipt", async () => {
  const f = await pair(); let first: { id: string; digest: string } | undefined;
  for (let n = 0; n < 100; n++) {
    const item = await incoming(f, chat(`small ${n}`)), result = f.guest.admitPersonInbox("work", item.digest);
    expect(result.state).toBe("admitted"); first ??= { id: result.id!, digest: item.digest };
  }
  const extra = await incoming(f), refused = f.guest.admitPersonInbox("work", extra.digest);
  expect(refused).toEqual({ state: "refused", reason: "inbox_full" });
  expect(f.guest.applicationReceipt("work", extra.digest)).toMatchObject({ outcome: "failed_safe", reason: "inbox_full" });
  const before = f.guest.applicationReceipt("work", first!.digest);
  f.guest.disposePersonInbox(first!.id, "discard", () => true);
  expect(f.guest.readPersonInbox(first!.id, () => true)?.body).toBeUndefined();
  expect(f.guest.applicationReceipt("work", first!.digest)).toEqual(before);
  const next = await incoming(f); expect(f.guest.admitPersonInbox("work", next.digest).state).toBe("admitted");
  expect(f.guest.listPersonInbox("work").filter(row => row.state === "unread")).toHaveLength(100);
  expect(f.guest.admitPersonInbox("work", extra.digest)).toEqual(refused);
}, 20_000);

test("the 4MiB person body cap is global across rooms and counts decoded UTF8 bytes", async () => {
  const f = await pair(); await f.addRoom("other");
  const body = "가".repeat(20_000), bytes = Buffer.byteLength(body), accepted = Math.floor(ROOM_PERSON_INBOX_LIMITS.globalBytes / bytes);
  for (let n = 0; n < accepted; n++) {
    const name = n % 2 ? "work" : "other", item = await incoming(f, chat(body), name);
    expect(f.guest.admitPersonInbox(name, item.digest).state).toBe("admitted");
  }
  const next = await incoming(f, chat(body), "other"); expect(f.guest.admitPersonInbox("other", next.digest)).toEqual({ state: "refused", reason: "inbox_full" });
  expect(f.guest.listPersonInbox().reduce((total, row) => total + row.bytes, 0)).toBe(accepted * bytes);
  expect(() => encodeRoomMessage({ v: 1, type: "chat", envelope: chat("가".repeat(22_000)) })).toThrow(); // Whole-wire 64KiB still applies first.
}, 20_000);

test("TTL uses first local crypto receipt, not sender timestamp or delayed application registration", async () => {
  const f = await pair(), item = await incoming(f, chat("expired-before-admission", { ts: f.now() + ROOM_PERSON_INBOX_LIMITS.ttlMs * 10 }), "work", false);
  f.advance(ROOM_PERSON_INBOX_LIMITS.ttlMs); await f.guest.applicationIncoming("work", item.digest);
  expect(f.guest.admitPersonInbox("work", item.digest)).toEqual({ state: "refused", reason: "inbox_expired" });
  expect(f.guest.applicationReceipt("work", item.digest)).toMatchObject({ outcome: "failed_safe", reason: "inbox_expired" });
  expect(f.guest.listPersonInbox()).toEqual([]);
});

test("post-admission expiry purges locally, retains an ids-only stub and never changes the signed outcome", async () => {
  const f = await pair(), item = await incoming(f), result = f.guest.admitPersonInbox("work", item.digest), receipt = f.guest.applicationReceipt("work", item.digest);
  f.advance(10); // A later disposition/expiry must not move the sender's admission time.
  f.advance(ROOM_PERSON_INBOX_LIMITS.ttlMs - 10); f.guest.expirePersonInbox();
  expect(f.guest.readPersonInbox(result.id!, () => true)).toMatchObject({ state: "expired" });
  expect(f.guest.readPersonInbox(result.id!, () => true)?.body).toBeUndefined();
  const raw = dbOf(f.guest).query<{ reason: string; state: string }, [string]>("SELECT state,reason FROM applications WHERE primary_digest=?").get(item.digest);
  expect(raw).toEqual({ state: "completed", reason: "inbox_admitted" });
  // The retained expiry stub keeps its original admission proof, never a replacement outcome.
  expect(f.guest.applicationReceipt("work", item.digest)).toEqual(receipt); expect(receipt).toMatchObject({ outcome: "completed", reason: "inbox_admitted" });
  f.advance(ROOM_PERSON_INBOX_LIMITS.ttlMs); f.guest.expirePersonInbox(); expect(f.guest.listPersonInbox()).toEqual([]);
});

for (const version of [1, 2, 3]) test(`schema${version} migration keeps unknown human age unavailable, preserves native pending work and replay floors`, async () => {
  const f = await pair(), human = await incoming(f), native = await incoming(f, chat("native", { to: "codex" }));
  const directory = directories.get(f.guest)!; f.guest.close();
  const db = new Database(join(directory, "rooms.db"));
  db.exec("DROP TABLE person_inbox; ALTER TABLE inbox DROP COLUMN received_at;");
  if (version < 3) db.exec("ALTER TABLE inbox DROP COLUMN receipt_reserve;");
  if (version < 2) db.exec("DROP TABLE application_frames; DROP TABLE applications; DROP TABLE application_outbox;");
  db.exec(`PRAGMA user_version=${version};`); db.close();
  const restored = await open(f.clock, directory);
  if (version < 2) { await restored.applicationIncoming("work", human.digest); await restored.applicationIncoming("work", native.digest); }
  expect(restored.admitPersonInbox("work", human.digest)).toEqual({ state: "refused", reason: "inbox_age_unavailable" });
  expect(restored.claimApplication("work", native.digest)).toBe(true); restored.finishApplication("work", native.digest, "completed", "admitted");
  expect((await openFrame({ wire: human.wire, identity: restored.identity, current: restored.get("work")!.current, replay: restored.replay })).status).toBe("duplicate");
  expect(restored.pendingInbox("work")).toEqual([]);
});

test("sender accepts inbox completion only for the authenticated user destination, never native admitted", async () => {
  const f = await pair(), item = await incoming(f);
  await f.owner.queueApplication("work", item.wire, { deliveryId: crypto.randomUUID(), application: item.envelope.id, remotePeer: "user@guest", recipient: f.guest.identity.public.fingerprint, peer: "user", ackTimeoutMs: 600000, ttlMs: 86400000 });
  const forged = await receiptToOwner(f, { v: 1, type: "receipt", frame: item.digest, application: item.envelope.id, peer: "user", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", forged)).toBeUndefined(); f.owner.settleInbox("work", forged);
  f.guest.admitPersonInbox("work", item.digest);
  const valid = await receiptToOwner(f, f.guest.applicationReceipt("work", item.digest)!);
  expect(f.owner.applyApplicationReceipt("work", valid)).toMatchObject({ state: "completed", reason: "inbox_admitted" });
});

for (const corrupt of ["bytes", "body", "link", "clock"] as const) test(`person inbox restore refuses corrupt ${corrupt} metadata without publishing body ports`, async () => {
  const f = await pair(), item = await incoming(f); f.guest.admitPersonInbox("work", item.digest);
  const directory = directories.get(f.guest)!; f.guest.close(); const db = new Database(join(directory, "rooms.db"));
  if (corrupt === "bytes") db.exec("UPDATE person_inbox SET bytes=65537;");
  if (corrupt === "body") db.exec("UPDATE person_inbox SET body=x'00';");
  if (corrupt === "link") db.exec("UPDATE person_inbox SET sender='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';");
  if (corrupt === "clock") db.exec("UPDATE person_inbox SET received_at=received_at+1;");
  db.close(); await expect(open(f.clock, directory)).rejects.toMatchObject({ code: "corrupt" });
});

test("unread person identities remain unsettled under shared application-cap pressure", async () => {
  const f = await pair(), item = await incoming(f), result = f.guest.admitPersonInbox("work", item.digest), db = dbOf(f.guest), room = f.guest.get("work")!.current.room;
  // Populate metadata uncertainty as existing application-cap tests do. No fake wire or floor is admitted.
  const app = db.query("INSERT INTO applications(room,sender,application,content_hash,primary_digest,peer,trace,hop,state,created_at) VALUES(?,?,?,?,?,?,?,0,'needs_review',?)");
  const alias = db.query("INSERT INTO application_frames(room,digest,sender,application) VALUES(?,?,?,?)");
  db.transaction(() => { for (let n = 1; n < ROOM_APPLICATION_RETENTION.identitiesPerRoom; n++) {
    const id = crypto.randomUUID(), digest = encodeBase64url(randomBytes(32));
    app.run(room, f.owner.identity.public.fingerprint, id, digest, digest, "codex", crypto.randomUUID(), f.now()); alias.run(room, digest, f.owner.identity.public.fingerprint, id);
  } })();
  const next = await incoming(f, chat("must-not-evict-human"), "work", false);
  await expect(f.guest.applicationIncoming("work", next.digest)).rejects.toBeInstanceOf(RoomApplicationLimitError);
  expect(f.guest.readPersonInbox(result.id!, () => true)?.body).toBe(item.envelope.body);
  expect(f.guest.applicationReceipt("work", item.digest)).toMatchObject({ outcome: "completed", reason: "inbox_admitted" });
});

test("settled person stubs prune oldest first at1000 per room and global metadata listing refuses truncation", async () => {
  const f = await pair(); await f.addRoom("other");
  const first = await incoming(f), admitted = f.guest.admitPersonInbox("work", first.digest);
  f.guest.disposePersonInbox(admitted.id!, "done", () => true); f.advance(1);
  const second = await incoming(f, chat("other"), "other"), admitted2 = f.guest.admitPersonInbox("other", second.digest);
  f.guest.disposePersonInbox(admitted2.id!, "done", () => true);
  const db = dbOf(f.guest);
  const clone = (name: string, primary: string, count: number) => db.transaction(() => {
    // Bounded metadata fixture, not synthetic crypto admission: exercise eviction/listing independently.
    for (let n = 0; n < count; n++) {
      const id = crypto.randomUUID(), application = crypto.randomUUID(), digest = encodeBase64url(randomBytes(32));
      db.query("INSERT INTO applications SELECT room,sender,?,content_hash,?,peer,trace,hop,state,reason,created_at,settled_at,disposition,disposed_at,disposed_by FROM applications WHERE primary_digest=?").run(application, digest, primary);
      const state = f.guest.get(name)!;
      db.query("INSERT INTO application_frames VALUES(?,?,?,?)").run(state.current.room, digest, f.owner.identity.public.fingerprint, application);
      db.query("INSERT INTO person_inbox SELECT ?,room,sender,?,?,from_peer,received_at,expires_at,bytes,NULL,'done',? FROM person_inbox WHERE primary_digest=?").run(id, application, digest, f.now(), primary);
    }
  })();
  clone("work", first.digest, 1000); f.guest.expirePersonInbox();
  expect(f.guest.listPersonInbox("work")).toHaveLength(1000);
  expect(f.guest.readPersonInbox(admitted.id!, () => true)).toBeUndefined();
  clone("other", second.digest, 100);
  expect(() => f.guest.listPersonInbox()).toThrow("inbox_list_limit");
  expect(f.guest.listPersonInbox("other")).toHaveLength(101);
  f.advance(ROOM_PERSON_INBOX_LIMITS.ttlMs); f.guest.expirePersonInbox(); expect(f.guest.listPersonInbox()).toEqual([]);
});

test("an idle person expiry tick changes neither rows nor the durable clock", async () => {
  const f = await pair(), item = await incoming(f); f.guest.admitPersonInbox("work", item.digest);
  const db = dbOf(f.guest), before = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='clock'").get()!.value;
  const writes = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  f.advance(1); f.guest.expirePersonInbox();
  expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='clock'").get()!.value).toBe(before);
  expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(writes);
});


for (const disposition of ["done", "expired"] as const) test(`a ${disposition} person stub retains its own horizon and admission proof past the original application TTL`, async () => {
  const f = await pair(), original = await incoming(f), result = f.guest.admitPersonInbox("work", original.digest);
  const receipt = f.guest.applicationReceipt("work", original.digest), day = 24 * 60 * 60 * 1000;
  if (disposition === "done") { f.advance(29 * day); f.guest.disposePersonInbox(result.id!, "done", () => true); f.advance(day + 1); }
  else { f.advance(30 * day); f.guest.expirePersonInbox(); f.advance(1); }
  // A different message invokes ordinary application expiration, not cap eviction.
  const native = await incoming(f, chat("unrelated native admission", { to: "codex" }));
  expect(f.guest.claimApplication("work", native.digest)).toBe(true); f.guest.finishApplication("work", native.digest, "completed", "admitted");
  expect(f.guest.readPersonInbox(result.id!, () => true)).toMatchObject({ state: disposition });
  expect(f.guest.readPersonInbox(result.id!, () => true)?.body).toBeUndefined();
  expect(f.guest.applicationReceipt("work", original.digest)).toEqual(receipt);
  // Simulate only the existing bounded NULL-crypto-inbox prune: retained aliases
  // must independently prove the exact old ciphertext without advancing a floor.
  dbOf(f.guest).query("DELETE FROM inbox WHERE digest=? AND plaintext IS NULL").run(original.digest);
  expect((await openFrame({ wire: original.wire, identity: f.guest.identity, current: f.guest.get("work")!.current, replay: f.guest.replay })).status).toBe("duplicate");
  const alias = await incoming(f, original.envelope);
  expect(f.guest.admitPersonInbox("work", alias.digest)).toEqual({ state: "duplicate", reason: "inbox_admitted", id: result.id });
  expect(f.guest.applicationReceipt("work", alias.digest)).toMatchObject({ frame: alias.digest, outcome: "completed", reason: "inbox_admitted" });
  expect(f.guest.listPersonInbox("work")).toHaveLength(1);
  const directory = directories.get(f.guest)!; f.guest.close(); const restored = await open(f.clock, directory);
  expect(restored.readPersonInbox(result.id!, () => true)?.state).toBe(disposition);
  expect(restored.applicationReceipt("work", original.digest)).toEqual(receipt);
  f.advance(30 * day); restored.expirePersonInbox();
  expect(restored.listPersonInbox("work")).toEqual([]);
});
