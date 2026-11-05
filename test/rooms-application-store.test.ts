import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomApplicationLimitError, RoomUnmatchedReceiptError, RoomStoreError, RoomStore, ROOM_APPLICATION_RETENTION, ROOM_STORE_LIMITS, type RoomOutgoingInput, type RoomOutgoing } from "../src/rooms/store.ts";
import { encodeRoomMessage, type RoomChatEnvelope, type RoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, decodeFrame, openFrame, roomMembers, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";

const roots: string[] = [], stores: RoomStore[] = [];
const locations = new WeakMap<RoomStore, string>();
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function opened(clock: () => number, directory?: string) {
  if (!directory) { const root = mkdtempSync(join(tmpdir(), "ahub-room-app-")); roots.push(root); directory = join(root, "state"); }
  const store = await RoomStore.open({ stateDir: directory, clock }); stores.push(store); locations.set(store, directory); return store;
}
async function enroll(owner: RoomStore, guest: RoomStore, label: string, now: number, name = "work") {
  const old = owner.get(name)!;
  const token = await createInvite({ owner: owner.identity, epoch: old.current, broker: old.broker, expiresAt: now + 600000, nowMs: now });
  await owner.saveInvite(name, token);
  const request = await createJoin({ invite: token, identity: guest.identity, label, exposedPeers: ["claude"], nowMs: now });
  guest.savePendingJoin(name, { invite: token, request });
  const state = await owner.enroll(name, request);
  await guest.install({ name, broker: state.broker, wire: state.wire, expectedDigest: null });
}
async function pair() {
  let now = 1_800_000_000_000;
  const clock = () => now, owner = await opened(clock), guest = await opened(clock);
  const initial = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "work", broker: "ws://127.0.0.1:8788/", wire: initial.wire, expectedDigest: null });
  await enroll(owner, guest, "guest", now);
  return { owner, guest, clock, now: () => now, advance: (ms: number) => { now += ms; } };
}
function chat(body = "public chat", id: string = crypto.randomUUID()): RoomChatEnvelope {
  return { id, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "claude", kind: "chat", priority: "status", body, ts: 1_800_000_000_000 };
}
const hash = async (wire: Uint8Array) => encodeBase64url(await sha256(wire));
async function sealed(sender: RoomStore, recipient: RoomStore, message: RoomMessage, name = "work") {
  return sealFrame({ epoch: sender.get(name)!.current, identity: sender.identity, recipients: [recipient.identity.public.fingerprint], plaintext: encodeRoomMessage(message), sequence: sender.sequence });
}
async function receive(recipient: RoomStore, wire: Uint8Array, name = "work") {
  const state = recipient.get(name)!;
  return openFrame({ wire, identity: recipient.identity, current: state.current, ...(state.previous ? { previous: state.previous } : {}), replay: recipient.replay });
}
async function queued(f: Awaited<ReturnType<typeof pair>>, envelope = chat(), times: Partial<Pick<RoomOutgoingInput, "ackTimeoutMs" | "ttlMs">> = {}) {
  const wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  const input: RoomOutgoingInput = { deliveryId: crypto.randomUUID(), application: envelope.id, remotePeer: "claude@guest", recipient: f.guest.identity.public.fingerprint, peer: "claude", ackTimeoutMs: 600000, ttlMs: 86400000, ...times };
  const result = await f.owner.queueApplication("work", wire, input), outgoing = { ...result }, frameDigest = result.frameDigest!;
  delete outgoing.frameDigest;
  return { wire, input, outgoing, frameDigest, envelope };
}
async function incoming(f: Awaited<ReturnType<typeof pair>>, envelope = chat(), name = "work") {
  const wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope }, name), digest = await hash(wire);
  expect((await receive(f.guest, wire, name)).status).toBe("accepted");
  const application = await f.guest.applicationIncoming(name, digest);
  return { wire, digest, application, envelope };
}
async function receipt(recipient: RoomStore, sender: RoomStore, message: RoomMessage) {
  const wire = await sealed(recipient, sender, message); expect((await receive(sender, wire)).status).toBe("accepted"); return hash(wire);
}

test("room application schema3 migrates a v1 identity, pins, counters and legacy outbox in place", async () => {
  const f = await pair(), raw = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: chat() });
  await f.owner.enqueue("work", raw);
  const state = f.owner.get("work")!, fingerprint = f.owner.identity.public.fingerprint, dir = locations.get(f.owner)!;
  f.owner.close();
  const db = new Database(join(dir, "rooms.db"));
  db.exec("DROP TABLE receipt_outbox; DROP TABLE application_attempts; DROP TABLE person_inbox; ALTER TABLE inbox DROP COLUMN received_at; DROP TABLE application_frames; DROP TABLE applications; DROP TABLE application_outbox; ALTER TABLE inbox DROP COLUMN receipt_reserve; PRAGMA user_version=1;"); db.close();
  const restored = await opened(f.clock, dir);
  expect(restored.identity.public.fingerprint).toBe(fingerprint);
  expect(restored.get("work")!.current.digest).toBe(state.current.digest);
  expect(restored.outbox("work").map(row => row.digest)).toEqual([await hash(raw)]);
  expect(restored.applicationOutbox("work")).toEqual([]);
  expect(await restored.sequence.reserve({ room: state.current.room, sender: fingerprint, epoch: state.current.epoch, rosterDigest: state.current.digest })).toBe("2");
});

test("application outbox and sealed frame commit together; broker storage preserves the handoff deadline", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 1000 });
  expect(q.outgoing).toMatchObject({ state: "dispatching", ackDeadline: f.now() + 1000 }); expect(f.owner.outbox("work")).toHaveLength(1);
  const deadline = q.outgoing.ackDeadline!; f.advance(10);
  const frame = JSON.parse(new TextDecoder().decode(q.wire));
  expect(f.owner.markApplicationStored("work", q.outgoing.digest, "999")).toBeUndefined();
  const accepted = f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq)!;
  expect(accepted).toMatchObject({ state: "accepted", ackDeadline: deadline });
  f.advance(10);
  expect(f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq)!.ackDeadline).toBe(accepted.ackDeadline);
  await expect(f.owner.queueApplication("work", q.wire, { ...q.input, application: crypto.randomUUID() })).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.applicationOutbox("work")).toHaveLength(1); expect(f.owner.outbox("work")).toHaveLength(1);
});

test("retry uses a fresh cipher frame, keeps its canonical delivery and settles a signed old-frame receipt", async () => {
  const f = await pair(), envelope = chat(), first = await queued(f, envelope, { ackTimeoutMs: 100, ttlMs: 1000 });
  expect(f.owner.applicationSendable("work", first.frameDigest)).toBe(true);
  expect(await f.owner.outgoingMessage("work", envelope.id)).toEqual({ v: 1, type: "chat", envelope });
  f.advance(100);
  expect(f.owner.dueApplicationRetries("work")).toEqual([expect.objectContaining({ digest: first.outgoing.digest, state: "dispatching", ackDeadline: f.now() + 100 })]);
  const retryWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  const retry = await f.owner.queueApplication("work", retryWire, first.input);
  expect(retry).toMatchObject({ digest: first.outgoing.digest, deliveryId: first.outgoing.deliveryId, application: envelope.id, frameDigest: await hash(retryWire) });
  expect(retry.frameDigest).not.toBe(first.frameDigest);
  expect(f.owner.applicationSendable("work", first.frameDigest)).toBe(false);
  expect(f.owner.applicationSendable("work", retry.frameDigest!)).toBe(true);
  expect(f.owner.outbox("work").map(row => row.digest)).toEqual([retry.frameDigest!]);
  const dir = locations.get(f.owner)!; f.owner.close(); f.owner = await opened(f.clock, dir);
  expect(f.owner.applicationOutbox("work")).toMatchObject([expect.objectContaining({ digest: first.outgoing.digest, state: "dispatching", ackDeadline: f.now() + 100 })]);
  expect(await f.owner.outgoingMessage("work", envelope.id)).toEqual({ v: 1, type: "chat", envelope });
  expect(f.owner.markApplicationStored("work", first.frameDigest, decodeFrame(first.wire).seq)).toBeUndefined();
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: first.frameDigest, application: envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ digest: first.outgoing.digest, state: "completed", reason: "admitted" });
  expect(f.owner.applicationSendable("work", retry.frameDigest!)).toBe(false);
  expect(f.owner.outbox("work")).toEqual([]);
});

test("a new root delivery ID reuses only the same immutable application before its original TTL", async () => {
  const f = await pair(), envelope = chat(), original = await queued(f, envelope, { ackTimeoutMs: 100, ttlMs: 1000 });
  const signed = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: original.frameDigest, application: envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", signed)).toMatchObject({ state: "completed" });
  f.advance(10);
  const duplicateWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  const duplicateInput = { ...original.input, deliveryId: crypto.randomUUID() };
  const duplicate = await f.owner.queueApplication("work", duplicateWire, duplicateInput);
  expect(duplicate).toMatchObject({ deliveryId: duplicateInput.deliveryId, application: envelope.id, createdAt: original.outgoing.createdAt, expiresAt: original.outgoing.expiresAt, frameDigest: await hash(duplicateWire) });
  expect(f.owner.outbox("work").map(row => row.digest)).toEqual([duplicate.frameDigest!]);
  const changedWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: { ...envelope, body: "changed body" } });
  await expect(f.owner.queueApplication("work", changedWire, { ...duplicateInput, deliveryId: crypto.randomUUID() })).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.applicationOutbox("work").find(row => row.deliveryId === duplicateInput.deliveryId)).toMatchObject({ state: "dispatching", expiresAt: original.outgoing.expiresAt });
  f.owner.quarantineOutgoingPermanent("work", duplicateInput.deliveryId, "boundary_refused", () => true);
  const laterWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  await expect(f.owner.queueApplication("work", laterWire, { ...duplicateInput, deliveryId: crypto.randomUUID() })).rejects.toMatchObject({ code: "state_changed" });
});

test("legacy null content hash permits same-delivery reseal only when retained wire proves the payload", async () => {
  const f = await pair(), envelope = chat(), original = await queued(f, envelope, { ackTimeoutMs: 100, ttlMs: 1000 }), room = f.owner.get("work")!.current.room;
  const dir = locations.get(f.owner)!; f.owner.close();
  const db = new Database(join(dir, "rooms.db"));
  db.query("UPDATE application_outbox SET content_hash=NULL WHERE room=? AND delivery_id=?").run(room, original.input.deliveryId);
  db.close();
  f.owner = await opened(f.clock, dir);
  const retryWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  const retry = await f.owner.queueApplication("work", retryWire, original.input);
  expect(retry).toMatchObject({ digest: original.outgoing.digest, deliveryId: original.input.deliveryId, application: envelope.id, frameDigest: await hash(retryWire) });
});

test("legacy null content hash refuses cross-delivery reuse after its ciphertext is retired", async () => {
  const f = await pair(), envelope = chat(), original = await queued(f, envelope, { ackTimeoutMs: 100, ttlMs: 1000 }), room = f.owner.get("work")!.current.room;
  const signed = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: original.frameDigest, application: envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", signed)).toMatchObject({ state: "completed" });
  const dir = locations.get(f.owner)!; f.owner.close();
  const db = new Database(join(dir, "rooms.db"));
  db.query("UPDATE application_outbox SET content_hash=NULL WHERE room=? AND delivery_id=?").run(room, original.input.deliveryId);
  db.close();
  f.owner = await opened(f.clock, dir);
  const duplicateWire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  await expect(f.owner.queueApplication("work", duplicateWire, { ...original.input, deliveryId: crypto.randomUUID() })).rejects.toMatchObject({ code: "state_changed" });
});

test("receipt ciphertext commits before chat ACK, replays until stored and retires on its own queue ACK", async () => {
  const f = await pair(), item = await incoming(f), dir = locations.get(f.guest)!;
  expect(f.guest.claimApplication("work", item.digest)).toBe(true);
  f.guest.finishApplication("work", item.digest, "completed", "admitted");
  const message = f.guest.applicationReceipt("work", item.digest)!;
  if (message.type !== "receipt") throw new Error("expected application receipt");
  const forgedWire = await sealed(f.guest, f.owner, { ...message, peer: "codex" });
  await expect(f.guest.queueReceipt("work", item.digest, forgedWire, { ttlMs: 1000 })).rejects.toMatchObject({ code: "untrusted" });
  expect(f.guest.outbox("work")).toEqual([]);
  const firstWire = await sealed(f.guest, f.owner, message);
  const first = await f.guest.queueReceipt("work", item.digest, firstWire, { ttlMs: 1000 });
  expect(first).toMatchObject({ kind: "receipt", receiptFor: item.digest, state: "dispatching", expiresAt: f.now() + 1000 });
  expect(f.guest.receiptStored("work", item.digest)).toMatchObject({ digest: first.digest, state: "dispatching", wire: firstWire });
  expect(f.guest.outbox("work")).toContainEqual(expect.objectContaining({ digest: first.digest, kind: "receipt", receiptFor: item.digest, wire: firstWire }));
  const replacement = await sealed(f.guest, f.owner, message);
  const same = await f.guest.queueReceipt("work", item.digest, replacement, { ttlMs: 5000 });
  expect(same).toMatchObject({ digest: first.digest, expiresAt: first.expiresAt, wire: firstWire });
  const refreshed = await f.guest.queueReceipt("work", item.digest, replacement, { ttlMs: 5000, replaceExisting: true });
  expect(refreshed).toMatchObject({ digest: await hash(replacement), expiresAt: first.expiresAt, wire: replacement, state: "dispatching" });
  f.guest.markStored("work", refreshed.digest, decodeFrame(replacement).seq);
  expect(f.guest.receiptStored("work", item.digest)).toMatchObject({ digest: refreshed.digest, state: "accepted", expiresAt: first.expiresAt });
  expect(f.guest.outbox("work")).not.toContainEqual(expect.objectContaining({ kind: "receipt" }));
  const reseal = await sealed(f.guest, f.owner, message);
  const pending = await f.guest.queueReceipt("work", item.digest, reseal, { ttlMs: 5000, replaceExisting: true });
  expect(pending).toMatchObject({ digest: await hash(reseal), state: "dispatching", expiresAt: first.expiresAt });
  expect(f.guest.receiptStored("work", item.digest)).toMatchObject({ digest: refreshed.digest, state: "accepted", expiresAt: first.expiresAt });
  f.guest.close();
  const restored = await opened(f.clock, dir);
  expect(restored.receiptStored("work", item.digest)).toMatchObject({ digest: refreshed.digest, state: "accepted", expiresAt: first.expiresAt });
  expect("wire" in restored.receiptStored("work", item.digest)!).toBe(false);
  expect(restored.outbox("work")).toContainEqual(expect.objectContaining({ digest: pending.digest, kind: "receipt", receiptFor: item.digest, wire: reseal }));
  expect(restored.retireStoredReceipt("work", refreshed.digest)).toBe(true);
  expect(restored.receiptStored("work", item.digest)).toMatchObject({ digest: pending.digest, state: "dispatching", expiresAt: first.expiresAt });
  expect(restored.retireStoredReceipt("work", pending.digest)).toBe(false);
  restored.markStored("work", pending.digest, decodeFrame(reseal).seq);
  expect(restored.retireStoredReceipt("work", pending.digest)).toBe(true);
  expect(restored.receiptStored("work", item.digest)).toBeUndefined();
});

test("a stored receipt for a member removed by roster rotation is not sendable on reconnect", async () => {
  const f = await pair(), envelope = chat(), wire = await sealed(f.guest, f.owner, { v: 1, type: "chat", envelope }), digest = await hash(wire);
  expect((await receive(f.owner, wire)).status).toBe("accepted");
  expect((await f.owner.applicationIncoming("work", digest)).state).toBe("pending");
  expect(f.owner.claimApplication("work", digest)).toBe(true);
  f.owner.finishApplication("work", digest, "completed", "admitted");
  const message = f.owner.applicationReceipt("work", digest)!;
  const receiptWire = await sealed(f.owner, f.guest, message), stored = await f.owner.queueReceipt("work", digest, receiptWire, { ttlMs: 1000 });
  expect(f.owner.receiptSendable("work", stored.digest)).toBe(true);
  const current = f.owner.get("work")!;
  const ownMember = roomMembers(current.current).find(member => member.fingerprint === f.owner.identity.public.fingerprint)!;
  await f.owner.rotate("work", [ownMember], current.current.digest);
  expect(f.owner.receiptSendable("work", stored.digest)).toBe(false);
  expect(f.owner.outbox("work").some(row => row.digest === stored.digest)).toBe(false);
});

test("outgoing restart preserves retryable applications and their durable frames", async () => {
  const f = await pair(), q = await queued(f), dir = locations.get(f.owner)!;
  const failedSend = await queued(f);
  expect(f.owner.quarantineOutgoing("work", failedSend.input.deliveryId)).toEqual(failedSend.outgoing);
  expect((f.owner as any).db.query("SELECT COUNT(*) AS n FROM outbox").get().n).toBe(2);
  f.owner.close(); const restored = await opened(f.clock, dir);
  expect(restored.applicationOutbox("work")).toEqual([q.outgoing, failedSend.outgoing]);
  expect(restored.outbox("work").map(row => row.digest)).toEqual([q.frameDigest, failedSend.frameDigest]);
  restored.leave("work");
  expect(restored.quarantineOutgoing("work", failedSend.input.deliveryId)).toMatchObject({ state: "dispatching" });
});

test("permanent boundary refusal holds a delivery across restart and removes its ciphertext", async () => {
  const f = await pair(), q = await queued(f), dir = locations.get(f.owner)!;
  expect(f.owner.quarantineOutgoingPermanent("work", q.input.deliveryId, "not_exposed")).toMatchObject({ state: "needs_review", reason: "not_exposed" });
  expect(f.owner.outbox("work")).toEqual([]);
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: q.frameDigest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ state: "needs_review", reason: "not_exposed", lateReceipt: { outcome: "completed", reason: "admitted" } });
  f.owner.close();
  const restored = await opened(f.clock, dir);
  expect(restored.applicationOutbox("work")).toEqual([expect.objectContaining({ state: "needs_review", reason: "not_exposed", lateReceipt: { outcome: "completed", reason: "admitted" } })]);
  expect(restored.outbox("work")).toEqual([]);
});

test("incoming claim is one-use and a crash after claim becomes needs_review without plaintext or completion", async () => {
  const f = await pair(), item = await incoming(f), dir = locations.get(f.guest)!;
  expect(item.application).toMatchObject({ primary: true, state: "pending" });
  expect(f.guest.pendingApplications("work")).toEqual([{ digest: item.digest }]);
  expect(f.guest.claimApplication("work", item.digest)).toBe(true);
  expect(f.guest.claimApplication("work", item.digest)).toBe(false);
  f.guest.close(); const restored = await opened(f.clock, dir);
  expect(restored.pendingApplications("work")).toEqual([]);
  expect(restored.pendingInbox("work")).toEqual([]);
  expect(restored.claimApplication("work", item.digest)).toBe(false);
  expect(restored.applicationReceipt("work", item.digest)).toBeUndefined();
  expect(() => restored.finishApplication("work", item.digest, "completed", "admitted")).toThrow("state_changed");
});

test("same application and canonical content claims once across new cipher frames and resends exact-frame receipts", async () => {
  const f = await pair(), item = await incoming(f), second = await incoming(f, item.envelope);
  expect(second.application).toMatchObject({ primary: false, state: "pending", contentHash: item.application.contentHash });
  expect(f.guest.claimApplication("work", second.digest)).toBe(false);
  expect(f.guest.claimApplication("work", item.digest)).toBe(true);
  f.guest.finishApplication("work", item.digest, "completed", "admitted");
  expect(f.guest.pendingInbox("work")).toEqual([]);
  for (const digest of [item.digest, second.digest]) expect(f.guest.applicationReceipt("work", digest)).toEqual({ v: 1, type: "receipt", frame: digest, application: item.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  const changed = { ...item.envelope, body: "changed content" }, wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: changed });
  expect((await receive(f.guest, wire)).status).toBe("accepted");
  await expect(f.guest.applicationIncoming("work", await hash(wire))).rejects.toMatchObject({ code: "invalid" });
  expect(f.guest.claimApplication("work", item.digest)).toBe(false);
});

test("only the expected recipient's authenticated inbox receipt settles the exact outbound frame", async () => {
  const f = await pair(), third = await opened(f.clock);
  await enroll(f.owner, third, "third", f.now());
  const updated = f.owner.get("work")!, old = f.guest.get("work")!;
  await f.guest.install({ name: "work", broker: old.broker, wire: updated.wire, expectedDigest: old.current.digest });
  const q = await queued(f), message: RoomMessage = { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" };
  const foreign = await receipt(third, f.owner, message);
  expect(f.owner.applyApplicationReceipt("work", foreign)).toBeUndefined();
  expect(f.owner.applicationOutbox("work")[0]!.state).toBe("dispatching");
  const wrong = await receipt(f.guest, f.owner, { ...message, application: crypto.randomUUID() });
  expect(f.owner.applyApplicationReceipt("work", wrong)).toBeUndefined();
  const good = await receipt(f.guest, f.owner, message);
  expect(f.owner.applyApplicationReceipt("work", good)).toMatchObject({ digest: q.outgoing.digest, state: "completed", reason: "admitted" });
  expect(f.owner.outbox("work")).toEqual([]);
  expect(f.owner.applicationOutbox("work", true)).toEqual([]);
  expect(f.owner.applicationOutbox("work")).toHaveLength(1);
  const person = { ...chat(), to: "user" }, wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: person });
  const unsupported = await f.owner.queueApplication("work", wire, { ...q.input, deliveryId: crypto.randomUUID(), application: person.id, remotePeer: "user@guest", peer: "user" });
  const nack = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: unsupported.digest, application: person.id, peer: "user", outcome: "failed_safe", reason: "person_inbox_unsupported" });
  expect(f.owner.applyApplicationReceipt("work", nack)).toMatchObject({ state: "failed_safe", reason: "person_inbox_unsupported" });
  expect(f.owner.applicationOutbox("work").find(row => row.digest === unsupported.digest)?.state).toBe("failed_safe");
  expect(f.owner.outbox("work")).toEqual([]); // Signed refusal retires ciphertext; it never claims person queue admission.
});

test("ack timeout schedules retry, queue TTL marks needs_review and a late signed receipt settles it", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 100, ttlMs: 1000 });
  const frame = JSON.parse(new TextDecoder().decode(q.wire)); f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq);
  f.advance(100);
  expect(f.owner.dueApplicationRetries("work")).toEqual([expect.objectContaining({ digest: q.outgoing.digest, state: "accepted", ackDeadline: f.now() + 100 })]);
  expect(f.owner.expireApplications("work")).toEqual([]);
  f.advance(900);
  expect(f.owner.expireApplications("work")).toEqual([expect.objectContaining({ digest: q.outgoing.digest, state: "needs_review" })]);
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ state: "completed", lateReceipt: { outcome: "completed", reason: "admitted" } });
  expect(f.owner.outbox("work")).toEqual([]);
  const waiting = await queued(f, chat(), { ackTimeoutMs: 1000, ttlMs: 50 }); f.advance(50);
  expect(f.owner.expireApplications("work")).toEqual([expect.objectContaining({ digest: waiting.outgoing.digest, state: "needs_review" })]);
});

test("application mutation fences run before queue, claim and terminal effects", async () => {
  const f = await pair(), envelope = chat(), wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope });
  await expect(f.owner.queueApplication("work", wire, { deliveryId: crypto.randomUUID(), application: envelope.id, remotePeer: "claude@guest", recipient: f.guest.identity.public.fingerprint, peer: "claude", ackTimeoutMs: 100, ttlMs: 1000 }, () => false)).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.outbox("work")).toEqual([]);
  const item = await incoming(f);
  expect(() => f.guest.claimApplication("work", item.digest, () => false)).toThrow("state_changed");
  expect(f.guest.claimApplication("work", item.digest)).toBe(true);
  expect(() => f.guest.finishApplication("work", item.digest, "completed", "admitted", () => false)).toThrow("state_changed");
  expect(f.guest.applicationReceipt("work", item.digest)).toBeUndefined();
});

function fillIdentities(store: RoomStore, count: number, state: "completed" | "needs_review", now: number) {
  const directory = locations.get(store)!, installed = store.get("work")!;
  const sender = installed.current && JSON.parse(new TextDecoder().decode(installed.wire)).members.find((row: {fingerprint: string}) => row.fingerprint !== store.identity.public.fingerprint).fingerprint;
  store.close();
  const db = new Database(join(directory, "rooms.db"));
  const put = db.query("INSERT INTO applications(room,sender,application,content_hash,primary_digest,peer,trace,hop,state,reason,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const alias = db.query("INSERT INTO application_frames(room,digest,sender,application) VALUES(?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0, i + 1);
      const digest = encodeBase64url(bytes), application = crypto.randomUUID();
      put.run(installed.current.room, sender, application, digest, digest, "claude", crypto.randomUUID(), 0, state, state === "completed" ? "admitted" : null, now, state === "completed" ? now : null);
      alias.run(installed.current.room, digest, sender, application);
    }
  })(); db.close(); return directory;
}

test("tombstones expire after 30 days and new-cipher ids outside retention make no old-frame dedupe claim", async () => {
  const f = await pair(), first = await incoming(f, { ...chat(), hop: 3 }); expect(f.guest.claimApplication("work", first.digest)).toBe(true);
  f.guest.finishApplication("work", first.digest, "completed", "admitted");
  expect(f.guest.applicationTraceHop(first.envelope.trace)).toBe(3);
  f.advance(ROOM_APPLICATION_RETENTION.settledMs + 1);
  expect(f.guest.applicationReceipt("work", first.digest)).toBeUndefined();
  expect(f.guest.applicationTraceHop(first.envelope.trace)).toBeUndefined();
  const replacement = await incoming(f, { ...first.envelope, hop: 0, body: "new content after retention" });
  expect(replacement.application).toMatchObject({ primary: true, state: "pending" });
  expect(f.guest.applicationTraceHop(first.envelope.trace)).toBe(0);
  expect((await receive(f.guest, first.wire)).status).toBe("stale");
});

test("identity pressure evicts oldest settled tombstones and aliases, keeping permanent sender floors", async () => {
  const f = await pair(), first = await incoming(f, { ...chat(), hop: 3 }); expect(f.guest.claimApplication("work", first.digest)).toBe(true);
  f.guest.finishApplication("work", first.digest, "completed", "admitted"); f.advance(1000);
  const dir = fillIdentities(f.guest, ROOM_APPLICATION_RETENTION.identitiesPerRoom - 1, "completed", f.now());
  f.guest = await opened(f.clock, dir);
  expect(f.guest.applicationTraceHop(first.envelope.trace)).toBe(3);
  const later = await incoming(f, { ...chat(), trace: first.envelope.trace, hop: 0 });
  expect(later.application.primary).toBe(true);
  expect(f.guest.applicationReceipt("work", first.digest)).toBeUndefined();
  expect(f.guest.applicationTraceHop(first.envelope.trace)).toBe(0);
  expect((await receive(f.guest, first.wire)).status).toBe("stale");
  expect(f.guest.pendingApplications("work")).toEqual([{ digest: later.digest }]);
});

test("all-unsettled identity capacity refuses with room/count and never evicts uncertainty", async () => {
  const f = await pair(), first = await incoming(f); expect(f.guest.claimApplication("work", first.digest)).toBe(true);
  const dir = fillIdentities(f.guest, ROOM_APPLICATION_RETENTION.identitiesPerRoom - 1, "needs_review", f.now());
  f.guest = await opened(f.clock, dir);
  const wire = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: chat("CAP_BODY_CANARY") });
  expect((await receive(f.guest, wire)).status).toBe("accepted");
  let failure: unknown;
  try { await f.guest.applicationIncoming("work", await hash(wire)); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RoomApplicationLimitError);
  expect((failure as Error).message).toContain(f.guest.get("work")!.current.room);
  expect((failure as Error).message).toContain("10000"); expect((failure as Error).message).not.toContain("CAP_BODY_CANARY");
  expect(f.guest.claimApplication("work", first.digest)).toBe(false);
  expect(f.guest.applicationReceipt("work", first.digest)).toBeUndefined();
  const status = f.guest.applicationStatus("work");
  expect(status).toMatchObject({ pending: 0, needsReview: 10000, truncated: true });
  expect(status.rows).toHaveLength(200);
  expect(Object.keys(status.rows[0]!).sort()).toEqual(["application", "digest", "peer", "sender", "state"]);
  expect(JSON.stringify(status)).not.toContain("CAP_BODY_CANARY");
  f.guest.disposeIncoming("work", first.digest, "discard");
  expect(f.guest.incomingApplication("work", first.digest)).toMatchObject({ state: "disposed", disposition: "discard" });
  expect((await f.guest.applicationIncoming("work", await hash(wire))).primary).toBe(true);
  expect(f.guest.incomingApplication("work", first.digest)).toBeUndefined(); // The only settled identity was evicted to admit new work.
  expect((await receive(f.guest, first.wire)).status).toBe("stale");
});

test("publication failure can quarantine a claimed app without a restart or false completion receipt", async () => {
  const f = await pair(), item = await incoming(f, chat("INBOX_BODY_CANARY"));
  expect(f.guest.claimApplication("work", item.digest)).toBe(true);
  expect(() => f.guest.quarantineApplication("work", item.digest, () => false)).toThrow("state_changed");
  expect(f.guest.applicationStatus("work").pending).toBe(1);
  f.guest.quarantineApplication("work", item.digest);
  expect(f.guest.applicationStatus("work")).toEqual({ pending: 0, needsReview: 1, rows: [{ application: item.envelope.id, sender: f.owner.identity.public.fingerprint, peer: "claude", state: "needs_review", digest: item.digest }], truncated: false });
  expect(f.guest.pendingInbox("work")).toEqual([]);
  expect(f.guest.pendingApplications("work")).toEqual([]);
  expect(f.guest.applicationReceipt("work", item.digest)).toBeUndefined();
  expect(f.guest.claimApplication("work", item.digest)).toBe(false);
  const pending = await incoming(f);
  expect(f.guest.applicationStatus("work").rows.map(row => row.state)).toEqual(["needs_review", "pending"]);
  expect(JSON.stringify(f.guest.applicationStatus("work"))).not.toContain("INBOX_BODY_CANARY");
  expect(pending.application.state).toBe("pending");
});

test("retained trace metadata is global, distinguishes lower/equal/higher and never lifts MAX_HOP", async () => {
  const f = await pair(), trace = crypto.randomUUID();
  await incoming(f, { ...chat(), trace, hop: 2 });
  const lower = await incoming(f, { ...chat(), trace, hop: 1 });
  expect(lower.envelope.hop).toBeLessThan(f.guest.applicationTraceHop(trace)!);
  const equal = await incoming(f, { ...chat(), trace, hop: 2 });
  expect(equal.envelope.hop).toBe(f.guest.applicationTraceHop(trace)!);
  const other = await createRoomEpoch({ owner: f.owner.identity, members: [{ ...f.owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await f.owner.install({ name: "other", broker: "ws://127.0.0.1:8788/", wire: other.wire, expectedDigest: null });
  await enroll(f.owner, f.guest, "guest", f.now(), "other");
  const higher = await incoming(f, { ...chat(), trace, hop: 3 }, "other");
  expect(f.guest.applicationTraceHop(trace)).toBe(higher.envelope.hop);
  expect(() => encodeRoomMessage({ v: 1, type: "chat", envelope: { ...chat(), trace, hop: 4 } })).toThrow("invalid_message");
});

test("person disposition frees uncertain outbox capacity without claiming signed completion", async () => {
  const f = await pair(), q = await queued(f, chat(), { ttlMs: 1 }); f.advance(1);
  f.owner.expireApplications("work");
  expect(f.owner.applicationOutbox("work", true)).toHaveLength(1);
  const count = () => (f.owner as any).db.query("SELECT COUNT(*) AS n FROM outbox").get().n;
  expect(count()).toBe(1);
  expect(() => f.owner.disposeApplication("work", q.input.deliveryId, "completed", true, () => false)).toThrow("state_changed");
  expect(f.owner.disposeApplication("work", q.input.deliveryId, "completed", true, () => true)).toMatchObject({ state: "needs_review", disposition: "completed" });
  expect(count()).toBe(0); expect(f.owner.applicationOutbox("work", true)).toEqual([]);
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ state: "needs_review", disposition: "completed", lateReceipt: { outcome: "completed", reason: "admitted" } });
  expect(f.owner.applicationOutbox("work")[0]!.reason).toBeUndefined();
  expect(f.owner.applicationOutbox("work", true)).toEqual([]);
  const directory = locations.get(f.owner)!; f.owner.close();
  const restored = await opened(f.clock, directory);
  expect(restored.applicationOutbox("work")[0]).toMatchObject({ state: "needs_review", disposition: "completed", lateReceipt: { outcome: "completed", reason: "admitted" } });
  expect(restored.applicationOutbox("work", true)).toEqual([]);
});

test("authoritative person disposition flags active rows and preserves signed terminal rows across reopen", async () => {
  const f = await pair(), active = await queued(f), dir = locations.get(f.owner)!;
  expect(f.owner.disposeApplication("work", active.input.deliveryId, "completed", true, () => true)).toMatchObject({ state: "needs_review", disposition: "completed" });
  expect(f.owner.outbox("work")).toEqual([]);
  const terminal = await queued(f);
  const signed = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: terminal.frameDigest, application: terminal.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", signed)).toMatchObject({ state: "completed", reason: "admitted" });
  expect(f.owner.disposeApplication("work", terminal.input.deliveryId, "discard", true, () => true)).toMatchObject({ state: "completed", reason: "admitted", disposition: "discard" });
  f.owner.close();
  const restored = await opened(f.clock, dir);
  expect(restored.applicationOutbox("work")).toMatchObject([
    expect.objectContaining({ deliveryId: active.input.deliveryId, state: "needs_review", disposition: "completed" }),
    expect.objectContaining({ deliveryId: terminal.input.deliveryId, state: "completed", reason: "admitted", disposition: "discard" }),
  ]);
  expect(restored.outbox("work")).toEqual([]);
});

test("incoming person accept/discard are local settled metadata, never admission or a signed receipt", async () => {
  for (const action of ["accept", "discard"] as const) {
    const f = await pair(), item = await incoming(f, { ...chat("DISPOSED_BODY_CANARY"), hop: 2 });
    expect(f.guest.claimApplication("work", item.digest)).toBe(true);
    f.guest.quarantineApplication("work", item.digest);
    expect(() => f.guest.disposeIncoming("work", item.digest, action, () => false)).toThrow("state_changed");
    expect(f.guest.incomingApplication("work", item.digest)?.state).toBe("needs_review");
    f.guest.disposeIncoming("work", item.digest, action);
    const metadata = { sender: f.owner.identity.public.fingerprint, application: item.envelope.id, peer: "claude", state: "disposed" as const, digest: item.digest, disposition: action, disposedAt: f.now(), disposedBy: "user" as const };
    expect(f.guest.incomingApplication("work", item.digest)).toEqual(metadata);
    expect(f.guest.claimApplication("work", item.digest)).toBe(false);
    expect(f.guest.applicationReceipt("work", item.digest)).toBeUndefined();
    expect(() => f.guest.finishApplication("work", item.digest, "failed_safe", "boundary_refused")).toThrow("state_changed");
    expect(() => f.guest.quarantineApplication("work", item.digest)).toThrow("state_changed");
    const duplicate = await incoming(f, item.envelope);
    expect(duplicate.application).toMatchObject({ primary: false, state: "disposed" });
    expect(f.guest.claimApplication("work", duplicate.digest)).toBe(false);
    expect(f.guest.applicationReceipt("work", duplicate.digest)).toBeUndefined();
    expect(f.guest.pendingInbox("work")).toEqual([]);
    expect(f.guest.applicationStatus("work")).toEqual({ pending: 0, needsReview: 0, rows: [metadata], truncated: false });
    expect(JSON.stringify(f.guest.applicationStatus("work"))).not.toContain("DISPOSED_BODY_CANARY");
    expect(f.guest.applicationTraceHop(item.envelope.trace)).toBe(2);
    const other = await incoming(f); f.guest.quarantineApplication("work", other.digest);
    f.guest.leave("work"); // Disposition is local bookkeeping even when the room is left.
    f.guest.disposeIncoming("work", other.digest, "discard");
    expect(f.guest.incomingApplication("work", other.digest)).toMatchObject({ state: "disposed", disposedBy: "user" });
    const directory = locations.get(f.guest)!; f.guest.close();
    const restored = await opened(f.clock, directory);
    expect(restored.incomingApplication("work", item.digest)).toEqual(metadata);
    expect(restored.applicationReceipt.bind(restored, "work", item.digest)).toThrow("untrusted");
    f.advance(ROOM_APPLICATION_RETENTION.settledMs + 1);
    expect(restored.applicationTraceHop(item.envelope.trace)).toBeUndefined();
    expect(restored.incomingApplication("work", item.digest)).toBeUndefined();
    expect(restored.applicationStatus("work").rows).toEqual([]);
  }
});


test("a dispatching application without any broker stored ACK expires at its durable handoff deadline", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 100, ttlMs: 1000 }), deadline = f.now() + 100;
  expect(q.outgoing).toMatchObject({ state: "dispatching", ackDeadline: deadline });
  f.advance(99); expect(f.owner.expireApplications("work")).toEqual([]);
  f.advance(1);
  expect(f.owner.dueApplicationRetries("work")).toEqual([expect.objectContaining({ digest: q.outgoing.digest, state: "dispatching", ackDeadline: f.now() + 100 })]);
  expect(f.owner.expireApplications("work")).toEqual([]);
  f.advance(900);
  expect(f.owner.expireApplications("work")).toEqual([expect.objectContaining({ digest: q.outgoing.digest, state: "needs_review", ackDeadline: deadline + 100 })]);
  expect(f.owner.outbox("work")).toEqual([]);
});

test("a broker storage ACK after the resend deadline leaves the delivery retryable", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 100, ttlMs: 1000 });
  f.advance(100);
  const due = f.owner.dueApplicationRetries("work")[0]!;
  expect(f.owner.markApplicationStored("work", q.frameDigest, decodeFrame(q.wire).seq)).toMatchObject({ state: "accepted", ackDeadline: due.ackDeadline });
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ state: "completed", ackDeadline: due.ackDeadline });
});

test("alias capacity cannot evict the retained settled identity that matched this exact application content", async () => {
  const f = await pair(), first = await incoming(f); expect(f.guest.claimApplication("work", first.digest)).toBe(true);
  f.guest.finishApplication("work", first.digest, "completed", "admitted"); f.advance(1);
  const dir = fillIdentities(f.guest, ROOM_APPLICATION_RETENTION.aliasesPerRoom - 1, "completed", f.now());
  f.guest = await opened(f.clock, dir);
  const duplicate = await incoming(f, first.envelope);
  expect(duplicate.application).toMatchObject({ primary: false, state: "completed" });
  expect(f.guest.claimApplication("work", duplicate.digest)).toBe(false);
  expect(f.guest.applicationReceipt("work", first.digest)).toMatchObject({ outcome: "completed", reason: "admitted" });
  expect(f.guest.applicationReceipt("work", duplicate.digest)).toMatchObject({ outcome: "completed", reason: "admitted" });
  expect(f.guest.pendingApplications("work")).toEqual([]);
});

test("settled chat prunes null inbox receipts without presence traffic and retained aliases still prove exact duplicates after reopen", async () => {
  const f = await pair(), first = await incoming(f); expect(f.guest.claimApplication("work", first.digest)).toBe(true);
  f.guest.finishApplication("work", first.digest, "completed", "admitted");
  for (let n = 0; n <= ROOM_STORE_LIMITS.receiptsPerRoom; n++) {
    const duplicate = await incoming(f, first.envelope);
    expect(duplicate.application).toMatchObject({ state: "completed", primary: false });
  }
  const directory = locations.get(f.guest)!; f.guest.close();
  const db = new Database(join(directory, "rooms.db"));
  let floor: string;
  try {
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox WHERE plaintext IS NULL").get()?.n).toBe(ROOM_STORE_LIMITS.receiptsPerRoom);
    expect(db.query("SELECT 1 FROM inbox WHERE digest=?").get(first.digest)).toBeNull();
    floor = db.query<{ seq: string }, []>("SELECT seq FROM floors").get()!.seq;
  } finally { db.close(); }
  f.guest = await opened(f.clock, directory);
  expect((await receive(f.guest, first.wire)).status).toBe("duplicate");
  expect(f.guest.applicationReceipt("work", first.digest)).toMatchObject({ outcome: "completed", reason: "admitted" });
  expect(f.guest.pendingInbox("work")).toEqual([]);
  f.guest.close();
  const check = new Database(join(directory, "rooms.db"));
  try { expect(check.query<{ seq: string }, []>("SELECT seq FROM floors").get()?.seq).toBe(floor!); } finally { check.close(); }
  f.guest = await opened(f.clock, directory);
  for (let n = 0; n < 2; n++) {
    const item = await incoming(f); expect(f.guest.claimApplication("work", item.digest)).toBe(true);
    f.guest.finishApplication("work", item.digest, "completed", "admitted");
  }
  f.guest.close();
  const final = new Database(join(directory, "rooms.db"));
  try { expect(final.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox WHERE plaintext IS NULL").get()?.n).toBe(ROOM_STORE_LIMITS.receiptsPerRoom); } finally { final.close(); }
  f.guest = await opened(f.clock, directory); expect(f.guest.pendingApplications("work")).toEqual([]);
});


test("schema3 migrates v2 handoff deadlines conservatively and never infers receipt reserve from legacy plaintext", async () => {
  for (const previous of ["missing", "late", "earlier"] as const) {
    const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 100, ttlMs: 1000 }), fingerprint = f.owner.identity.public.fingerprint, current = f.owner.get("work")!;
    const message: RoomMessage = { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" };
    const wire = await sealed(f.guest, f.owner, message); expect((await receive(f.owner, wire)).status).toBe("accepted");
    const frame = await hash(wire), directory = locations.get(f.owner)!; f.owner.close();
    const legacy = new Database(join(directory, "rooms.db"));
    try {
      legacy.exec("DROP TABLE receipt_outbox; DROP TABLE application_attempts; DROP TABLE person_inbox; ALTER TABLE inbox DROP COLUMN received_at; ALTER TABLE inbox DROP COLUMN receipt_reserve; PRAGMA user_version=2;");
      legacy.query("UPDATE application_outbox SET ack_deadline=?").run(previous === "missing" ? null : q.outgoing.createdAt + (previous === "late" ? 1000 : 50));
    } finally { legacy.close(); }
    const restored = await opened(f.clock, directory);
    expect(restored.identity.public.fingerprint).toBe(fingerprint); expect(restored.get("work")?.current.digest).toBe(current.current.digest);
    expect(restored.applicationOutbox("work")[0]).toMatchObject({ state: "dispatching", ackDeadline: q.outgoing.createdAt + (previous === "earlier" ? 50 : 100) });
    expect(restored.pendingInbox("work").map(row => row.digest)).toContain(frame);
    restored.close();
    const migrated = new Database(join(directory, "rooms.db"));
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(5);
      expect(migrated.query<{ receipt_reserve: number }, [string]>("SELECT receipt_reserve FROM inbox WHERE digest=?").get(frame)?.receipt_reserve).toBe(0);
      expect(migrated.query<{ wire: Uint8Array }, [string]>("SELECT wire FROM outbox WHERE digest=?").get(q.outgoing.digest)?.wire).toEqual(q.wire);
      expect(migrated.query<{ seq: string }, [string]>("SELECT seq FROM counters WHERE room=?").get(current.current.room)?.seq).toBe(decodeFrame(q.wire).seq);
    } finally { migrated.close(); }
  }
});

async function capturedReceiptFailure(recipient: RoomStore, wire: Uint8Array): Promise<unknown> {
  let failure: unknown;
  const state = recipient.get("work")!;
  await expect(openFrame({ wire, identity: recipient.identity, current: state.current, ...(state.previous ? { previous: state.previous } : {}), replay: { accept: async input => {
    try { return await recipient.replay.accept(input); } catch (error) { failure = error; throw error; }
  } } })).rejects.toThrow();
  return failure;
}

async function fillPendingChatInbox(f: Awaited<ReturnType<typeof pair>>): Promise<void> {
  for (let n = 0; n < ROOM_STORE_LIMITS.inboxPerRoom; n++) {
    const message: RoomMessage = { v: 1, type: "chat", envelope: { ...chat(), from: "claude", to: "codex" } };
    const wire = await sealed(f.guest, f.owner, message); expect((await receive(f.owner, wire)).status).toBe("accepted");
    await f.owner.applicationIncoming("work", await hash(wire));
  }
}

test("200 pending chats cannot block a matching authenticated receipt and unmatched receipts reserve no slot or replay floor", async () => {
  const f = await pair(), q = await queued(f); await fillPendingChatInbox(f);
  expect(f.owner.pendingInbox("work")).toHaveLength(200);
  const matched: Extract<RoomMessage, { type: "receipt" }> = { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" };
  const unmatched: RoomMessage[] = [{ ...matched, frame: encodeBase64url(new Uint8Array(32)) }, { ...matched, application: crypto.randomUUID() }, { ...matched, peer: "codex" }];
  for (const message of unmatched) {
    const wire = await sealed(f.guest, f.owner, message);
    expect(await capturedReceiptFailure(f.owner, wire)).toBeInstanceOf(RoomUnmatchedReceiptError);
    expect(f.owner.pendingInbox("work")).toHaveLength(200);
  }
  const wrongSender = await sealed(f.owner, f.owner, matched);
  expect(await capturedReceiptFailure(f.owner, wrongSender)).toBeInstanceOf(RoomUnmatchedReceiptError);
  const wire = await sealed(f.guest, f.owner, matched), frame = await hash(wire);
  expect(await receive(f.owner, wire)).toMatchObject({ status: "accepted", gap: "3" });
  expect(f.owner.pendingInbox("work")).toHaveLength(201);
  expect(f.owner.applyApplicationReceipt("work", frame)).toMatchObject({ state: "completed" });
  // Crash between business settlement and inbox cleanup must not reclassify the durable reserved admission as an ordinary row.
  const directory = locations.get(f.owner)!; f.owner.close(); f.owner = await opened(f.clock, directory);
  expect(f.owner.pendingInbox("work")).toHaveLength(201);
  expect(f.owner.applyApplicationReceipt("work", frame)).toMatchObject({ state: "completed" });
  f.owner.settleInbox("work", frame);
  expect(f.owner.pendingInbox("work")).toHaveLength(200); expect(f.owner.pendingApplications("work")).toHaveLength(200);
});

test("the receipt reserve admits eight pending matches, refuses the ninth without dropping it and frees a slot only after settlement", async () => {
  const f = await pair(), pending: { outgoing: RoomOutgoing; message: Extract<RoomMessage, { type: "receipt" }>; wire: Uint8Array; digest: string }[] = [];
  await fillPendingChatInbox(f);
  for (let n = 0; n < ROOM_STORE_LIMITS.receiptReservePerRoom + 1; n++) {
    const q = await queued(f), message: Extract<RoomMessage, { type: "receipt" }> = { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" };
    const wire = await sealed(f.guest, f.owner, message); pending.push({ outgoing: q.outgoing, message, wire, digest: await hash(wire) });
    if (n < ROOM_STORE_LIMITS.receiptReservePerRoom) expect((await receive(f.owner, wire)).status).toBe("accepted");
  }
  expect(f.owner.pendingInbox("work")).toHaveLength(208);
  const ninth = pending[8]!, error = await capturedReceiptFailure(f.owner, ninth.wire);
  expect(error).toBeInstanceOf(RoomStoreError); expect(error).not.toBeInstanceOf(RoomUnmatchedReceiptError); expect(error).toMatchObject({ code: "limit" });
  expect(f.owner.pendingInbox("work")).toHaveLength(208);
  const first = pending[0]!; f.owner.applyApplicationReceipt("work", first.digest); f.owner.settleInbox("work", first.digest);
  expect(await receive(f.owner, ninth.wire)).toMatchObject({ status: "accepted", gap: "0" });
  expect(f.owner.pendingInbox("work")).toHaveLength(208);
  const directory = locations.get(f.owner)!; f.owner.close();
  const corrupted = new Database(join(directory, "rooms.db"));
  try { corrupted.query("UPDATE inbox SET plaintext=? WHERE digest=?").run(encodeRoomMessage(first.message), first.digest); } finally { corrupted.close(); }
  await expect(RoomStore.open({ stateDir: directory, clock: f.clock })).rejects.toMatchObject({ code: "corrupt" });
});


test("matching receipts use ordinary inbox space below its cap instead of exhausting the eight-slot overflow reserve", async () => {
  const f = await pair();
  for (let n = 0; n < ROOM_STORE_LIMITS.receiptReservePerRoom + 1; n++) {
    const q = await queued(f), message: RoomMessage = { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" };
    const wire = await sealed(f.guest, f.owner, message); expect((await receive(f.owner, wire)).status).toBe("accepted");
  }
  expect(f.owner.pendingInbox("work")).toHaveLength(9);
  const directory = locations.get(f.owner)!; f.owner.close();
  const db = new Database(join(directory, "rooms.db"));
  try { expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox WHERE receipt_reserve=1").get()?.n).toBe(0); } finally { db.close(); }
  f.owner = await opened(f.clock, directory); expect(f.owner.pendingInbox("work")).toHaveLength(9);
});


test("ordinary inbox capacity is a read-only metadata hint and becomes available after pending chat settlement", async () => {
  const f = await pair();
  expect(f.owner.ordinaryInboxAvailable("work", 0)).toBe(true); expect(f.owner.ordinaryInboxAvailable("work", 65536)).toBe(true);
  expect(() => f.owner.ordinaryInboxAvailable("unknown", 1)).toThrow("untrusted");
  for (const bytes of [-1, 65537, 0.5, NaN, Infinity]) expect(() => f.owner.ordinaryInboxAvailable("work", bytes)).toThrow("invalid");
  await fillPendingChatInbox(f);
  const before = f.owner.pendingInbox("work"), pending = f.owner.pendingApplications("work");
  expect(f.owner.ordinaryInboxAvailable("work", 0)).toBe(false); expect(f.owner.ordinaryInboxAvailable("work", 1)).toBe(false);
  expect(f.owner.pendingInbox("work")).toEqual(before); expect(f.owner.pendingApplications("work")).toEqual(pending);
  f.owner.quarantineApplication("work", before[0]!.digest);
  expect(f.owner.pendingInbox("work")).toHaveLength(199);
  expect(f.owner.ordinaryInboxAvailable("work", 1)).toBe(true); expect(f.owner.ordinaryInboxAvailable("work", 65536)).toBe(true);
  expect(f.owner.pendingApplications("work")).toHaveLength(199);
  f.owner.leave("work"); expect(() => f.owner.ordinaryInboxAvailable("work", 1)).toThrow("untrusted");
  f.owner.close(); expect(() => f.owner.ordinaryInboxAvailable("work", 1)).toThrow("closed");
});
