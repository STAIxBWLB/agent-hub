import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomApplicationLimitError, RoomStore, ROOM_APPLICATION_RETENTION, type RoomOutgoingInput } from "../src/rooms/store.ts";
import { encodeRoomMessage, type RoomChatEnvelope, type RoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, openFrame, sealFrame } from "../src/rooms/wire.ts";
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
  const outgoing = await f.owner.queueApplication("work", wire, input);
  return { wire, input, outgoing, envelope };
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

test("room application schema2 migrates a v1 identity, pins, counters and legacy outbox in place", async () => {
  const f = await pair(), raw = await sealed(f.owner, f.guest, { v: 1, type: "chat", envelope: chat() });
  await f.owner.enqueue("work", raw);
  const state = f.owner.get("work")!, fingerprint = f.owner.identity.public.fingerprint, dir = locations.get(f.owner)!;
  f.owner.close();
  const db = new Database(join(dir, "rooms.db"));
  db.exec("DROP TABLE application_frames; DROP TABLE applications; DROP TABLE application_outbox; PRAGMA user_version=1;"); db.close();
  const restored = await opened(f.clock, dir);
  expect(restored.identity.public.fingerprint).toBe(fingerprint);
  expect(restored.get("work")!.current.digest).toBe(state.current.digest);
  expect(restored.outbox("work").map(row => row.digest)).toEqual([await hash(raw)]);
  expect(restored.applicationOutbox("work")).toEqual([]);
  expect(await restored.sequence.reserve({ room: state.current.room, sender: fingerprint, epoch: state.current.epoch, rosterDigest: state.current.digest })).toBe("2");
});

test("application outbox and sealed frame commit together; broker seq binds a once-only deadline", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 1000 });
  expect(q.outgoing.state).toBe("dispatching"); expect(f.owner.outbox("work")).toHaveLength(1);
  const frame = JSON.parse(new TextDecoder().decode(q.wire));
  expect(f.owner.markApplicationStored("work", q.outgoing.digest, "999")).toBeUndefined();
  const accepted = f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq)!;
  expect(accepted).toMatchObject({ state: "accepted", ackDeadline: f.now() + 1000 });
  f.advance(10);
  expect(f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq)!.ackDeadline).toBe(accepted.ackDeadline);
  await expect(f.owner.queueApplication("work", q.wire, { ...q.input, application: crypto.randomUUID() })).rejects.toMatchObject({ code: "state_changed" });
  expect(f.owner.applicationOutbox("work")).toHaveLength(1); expect(f.owner.outbox("work")).toHaveLength(1);
});

test("outgoing restart preserves proof but marks active applications uncertain and never exposes them to a drain", async () => {
  const f = await pair(), q = await queued(f), dir = locations.get(f.owner)!;
  const failedSend = await queued(f);
  expect(f.owner.quarantineOutgoing("work", failedSend.input.deliveryId)).toEqual({ ...failedSend.outgoing, state: "needs_review" });
  expect((f.owner as any).db.query("SELECT COUNT(*) AS n FROM outbox").get().n).toBe(2); // Keep ciphertext until a person's disposition.
  f.owner.close(); const restored = await opened(f.clock, dir);
  expect(restored.applicationOutbox("work")).toEqual([{ ...q.outgoing, state: "needs_review" }, { ...failedSend.outgoing, state: "needs_review" }]);
  expect(restored.outbox("work")).toEqual([]);
  restored.leave("work");
  expect(restored.quarantineOutgoing("work", failedSend.input.deliveryId)).toMatchObject({ state: "needs_review" });
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
});

test("ack timeout and queue TTL become needs_review; a late signed receipt remains evidence only", async () => {
  const f = await pair(), q = await queued(f, chat(), { ackTimeoutMs: 100, ttlMs: 1000 });
  const frame = JSON.parse(new TextDecoder().decode(q.wire)); f.owner.markApplicationStored("work", q.outgoing.digest, frame.seq);
  f.advance(100);
  expect(f.owner.expireApplications("work")).toEqual([expect.objectContaining({ digest: q.outgoing.digest, state: "needs_review" })]);
  const late = await receipt(f.guest, f.owner, { v: 1, type: "receipt", frame: q.outgoing.digest, application: q.envelope.id, peer: "claude", outcome: "completed", reason: "admitted" });
  expect(f.owner.applyApplicationReceipt("work", late)).toMatchObject({ state: "needs_review", lateReceipt: { outcome: "completed", reason: "admitted" } });
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
  expect(equal.envelope.hop).toBe(f.guest.applicationTraceHop(trace));
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
  expect(() => f.owner.disposeApplication("work", q.input.deliveryId, "completed", () => false)).toThrow("state_changed");
  expect(f.owner.disposeApplication("work", q.input.deliveryId, "completed")).toMatchObject({ state: "needs_review", disposition: "completed" });
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
