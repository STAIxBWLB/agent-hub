import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker } from "../src/broker/server.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { RoomLink, type RoomLinkContext } from "../src/rooms/link.ts";
import { encodeRoomMessage, type RoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, openFrame, roomMembers, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class HeldLocalPeer extends BasePeer {
  effects = 0;
  constructor() { super("codex"); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { this.effects++; }
}
async function recoveredIncoming(senderStillExposed: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-recovery-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  expect(Bun.spawnSync(["git", "init", "-q", root], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).exitCode).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: ["codex"] } } }));
  const owner = await RoomStore.open({ stateDir: join(root, "owner") }), guest = await RoomStore.open({ stateDir: join(root, "guest") });
  cleanups.push(() => owner.close(), () => guest.close());
  const first = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["claude"] }] });
  await owner.install({ name: "work", broker: "ws://127.0.0.1:1/", wire: first.wire, expectedDigest: null });
  const token = await createInvite({ owner: owner.identity, epoch: first.epoch, broker: "ws://127.0.0.1:1/", expiresAt: Date.now() + 600000 });
  await owner.saveInvite("work", token);
  const joinRequest = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: ["codex"] });
  guest.savePendingJoin("work", { invite: token, request: joinRequest });
  const enrolled = await owner.enroll("work", joinRequest);
  await guest.install({ name: "work", broker: enrolled.broker, wire: enrolled.wire, expectedDigest: null });
  const message: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "claude", to: "codex", kind: "chat", priority: "status", body: "authenticated before exposure changed", ts: Date.now() } };
  const wire = await sealFrame({ epoch: owner.get("work")!.current, identity: owner.identity, recipients: [guest.identity.public.fingerprint], sequence: owner.sequence, plaintext: encodeRoomMessage(message) });
  const before = guest.get("work")!;
  expect((await openFrame({ wire, identity: guest.identity, current: before.current, replay: guest.replay })).status).toBe("accepted");
  const digest = encodeBase64url(await sha256(wire));
  expect(guest.pendingInbox("work")).toHaveLength(1);
  expect(guest.incomingApplication("work", digest)).toBeUndefined(); // Crypto receive committed before application registration/admission.
  const rotated = await owner.rotate("work", roomMembers(enrolled.current).map(member => member.fingerprint === owner.identity.public.fingerprint
    ? { ...member, exposedPeers: senderStillExposed ? ["claude"] : [] } : member), enrolled.current.digest);
  await guest.install({ name: "work", broker: rotated.broker, wire: rotated.wire, expectedDigest: before.current.digest });
  expect(roomMembers(guest.get("work")!.current).some(member => member.fingerprint === owner.identity.public.fingerprint)).toBe(true);
  const journal = new DeliveryJournal({ file: join(root, "delivery.db"), projectRoot: root, projectId: "room-recovery", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal, batchMs: 0, deliveryHeld: () => true }); cleanups.push(() => bus.closeJournal());
  const peer = new HeldLocalPeer(); bus.add(peer); await peer.start();
  const sent: { message: RoomMessage; recipient: string }[] = [];
  const link = { publishApplication: async (receipt: RoomMessage, recipient: string, _outgoing: unknown, current: () => boolean) => {
    expect(current()).toBe(true); sent.push({ message: structuredClone(receipt), recipient }); return encodeBase64url(new Uint8Array(32));
  } } as unknown as RoomLink;
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  const service = new RoomChat({ bus, cwd: root, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false,
    modelScreenOn: () => false, screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1 });
  cleanups.push(() => service.stop());
  service.bind(guest, "work", link);
  const context: RoomLinkContext = { store: guest, name: "work", link, current: () => guest.get("work")?.current.digest === rotated.current.digest };
  return { owner, guest, service, context, message, digest, bus, peer, sent };
}

test("restored authenticated chat rechecks current sender exposure before local Bus admission", async () => {
  const f = await recoveredIncoming(false);
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  expect(f.bus.queued("codex")).toBe(0); expect(f.peer.effects).toBe(0);
  expect(f.guest.incomingApplication("work", f.digest)).toMatchObject({ state: "failed_safe", sender: f.owner.identity.public.fingerprint });
  expect(f.guest.applicationReceipt("work", f.digest)).toEqual({ v: 1, type: "receipt", frame: f.digest, application: f.message.type === "chat" ? f.message.envelope.id : "", peer: "codex", outcome: "failed_safe", reason: "not_exposed" });
  expect(f.sent).toEqual([{ recipient: f.owner.identity.public.fingerprint, message: f.guest.applicationReceipt("work", f.digest) }]);
  expect(f.guest.pendingInbox("work")).toEqual([]);
});

test("restored chat from a still-exposed sender admits once and returns only completed-admitted evidence", async () => {
  const f = await recoveredIncoming(true);
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  expect(f.bus.queued("codex")).toBe(1); expect(f.peer.effects).toBe(0); // Held native peer has not executed the admitted work.
  expect(f.guest.incomingApplication("work", f.digest)).toMatchObject({ state: "completed" });
  expect(f.guest.applicationReceipt("work", f.digest)).toMatchObject({ outcome: "completed", reason: "admitted" });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]?.message).toMatchObject({ outcome: "completed", reason: "admitted" });
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  expect(f.bus.queued("codex")).toBe(1); expect(f.peer.effects).toBe(0); expect(f.sent).toHaveLength(2);
  expect(f.sent[0]).toEqual(f.sent[1]);
});


test("real room-link recovery quarantines a pending application from a revoked sender before discarding its plaintext", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-recovery-revoked-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  expect(Bun.spawnSync(["git", "init", "-q", root], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).exitCode).toBe(0);
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: ["codex"] } } }));
  const owner = await RoomStore.open({ stateDir: join(root, "owner") }), guest = await RoomStore.open({ stateDir: join(root, "guest") });
  cleanups.push(() => owner.close(), () => guest.close());
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0, owners: [owner.identity.public.fingerprint] });
  cleanups.push(() => broker.stop());
  const initial = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "work", broker: broker.publicUrl, wire: initial.wire, expectedDigest: null });
  const token = await createInvite({ owner: owner.identity, epoch: initial.epoch, broker: broker.publicUrl, expiresAt: Date.now() + 600000 });
  await owner.saveInvite("work", token);
  const request = await createJoin({ invite: token, identity: guest.identity, label: "guest", exposedPeers: ["claude"] });
  guest.savePendingJoin("work", { invite: token, request });
  const enrolled = await owner.enroll("work", request); await guest.install({ name: "work", broker: broker.publicUrl, wire: enrolled.wire, expectedDigest: null });
  const message: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "claude", to: "codex", kind: "chat", priority: "status", body: "pending before sender was revoked", ts: Date.now() } };
  const wire = await sealFrame({ epoch: guest.get("work")!.current, identity: guest.identity, recipients: [owner.identity.public.fingerprint], sequence: guest.sequence, plaintext: encodeRoomMessage(message) });
  expect((await openFrame({ wire, identity: owner.identity, current: owner.get("work")!.current, replay: owner.replay })).status).toBe("accepted");
  const digest = encodeBase64url(await sha256(wire)); await owner.applicationIncoming("work", digest);
  expect(owner.pendingApplications("work")).toEqual([{ digest }]); expect(owner.pendingInbox("work")).toHaveLength(1);
  await owner.rotate("work", roomMembers(enrolled.current).filter(member => member.fingerprint !== guest.identity.public.fingerprint), enrolled.current.digest);
  const journal = new DeliveryJournal({ file: join(root, "delivery.db"), projectRoot: root, projectId: "recovery-revoked", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal, batchMs: 0, deliveryHeld: () => true }); cleanups.push(() => bus.closeJournal());
  const peer = new HeldLocalPeer(); bus.add(peer); await peer.start();
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  const service = new RoomChat({ bus, cwd: root, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false,
    modelScreenOn: () => false, screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1 }); cleanups.push(() => service.stop());
  let online!: () => void, receives = 0;
  const restored = new Promise<void>(resolve => { online = resolve; });
  const link = new RoomLink({ store: owner, name: "work", application: { ...service.application,
    receive: async (context, input) => { receives++; await service.application.receive(context, input); },
    online: async context => { await service.application.online(context); online(); },
  } }); cleanups.push(() => link.stop());
  await link.start();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room recovery online barrier timed out")), 5000);
    restored.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
  expect(link.status().state).toBe("online"); expect(receives).toBe(0);
  expect(bus.queued("codex")).toBe(0); expect(peer.effects).toBe(0);
  expect(owner.pendingInbox("work")).toEqual([]); expect(owner.pendingApplications("work")).toEqual([]);
  expect(owner.incomingApplication("work", digest)).toMatchObject({ state: "needs_review", sender: guest.identity.public.fingerprint });
  expect(owner.applicationStatus("work")).toMatchObject({ pending: 0, needsReview: 1 });
  expect(owner.applicationReceipt("work", digest)).toBeUndefined(); expect(broker.stats().queuedFrames).toBe(0);
  owner.disposeIncoming("work", digest, "discard");
  expect(owner.incomingApplication("work", digest)).toMatchObject({ state: "disposed", disposition: "discard", disposedBy: "user" });
  expect(owner.applicationStatus("work")).toMatchObject({ pending: 0, needsReview: 0 });
  expect(bus.queued("codex")).toBe(0); expect(receives).toBe(0); expect(broker.stats().queuedFrames).toBe(0);
});
