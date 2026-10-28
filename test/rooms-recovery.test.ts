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
import { RoomLink, RoomApplicationDeferredError, type RoomLinkContext } from "../src/rooms/link.ts";
import { encodeRoomMessage, type RoomMessage } from "../src/rooms/application.ts";
import { createInvite, createJoin, createRoomEpoch, openFrame, roomMembers, sealFrame, canonicalBytes } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256, randomBytes } from "../src/rooms/crypto.ts";

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
  const roster = { codex: true };
  const bus = new Bus({ journal, batchMs: 0, deliveryHeld: () => true, rostered: id => id === "codex" && roster.codex }); cleanups.push(() => bus.closeJournal());
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
  return { owner, guest, service, context, message, digest, bus, peer, sent, roster };
}

test("restored authenticated chat rechecks current sender exposure before local Bus admission", async () => {
  const f = await recoveredIncoming(false);
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  expect(f.bus.queued("codex")).toBe(0); expect(f.peer.effects).toBe(0);
  expect(f.guest.incomingApplication("work", f.digest)).toMatchObject({ state: "failed_safe", sender: f.owner.identity.public.fingerprint });
  expect(f.guest.applicationReceipt("work", f.digest)).toEqual({ v: 1, type: "receipt", frame: f.digest, application: f.message.type === "chat" ? f.message.envelope.id : "", peer: "codex", outcome: "failed_safe", reason: "not_exposed" });
  expect(f.sent).toEqual([{ recipient: f.owner.identity.public.fingerprint, message: f.guest.applicationReceipt("work", f.digest)! }]);
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


test("a locally off-roster peer is not a room admission destination despite retained exposure", async () => {
  const f = await recoveredIncoming(true); f.roster.codex = false;
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  expect(f.bus.queued("codex")).toBe(0); expect(f.peer.effects).toBe(0);
  expect(f.guest.applicationReceipt("work", f.digest)).toMatchObject({ outcome: "failed_safe", reason: "not_exposed" });
});


async function fullPhysicalInbox(reserved: number, withPresence = false, junkKind: "receipt" | "chat" = "receipt") {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-receipt-lane-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const receiver = await RoomStore.open({ stateDir: join(root, "receiver") }), sender = await RoomStore.open({ stateDir: join(root, "sender") });
  cleanups.push(() => receiver.close(), () => sender.close());
  let resolveClosed!: () => void, resolveDone!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; }), done = new Promise<void>(resolve => { resolveDone = resolve; });
  let targetWire: Uint8Array, junkWire: Uint8Array | undefined, targetDigest = "", junkDigest = "", retiredPresence: Uint8Array | undefined, retiredPresenceDigest = "", freshPresenceDigest = "";
  let requests = 0, connections = 0, allowFreshPresence = false, firstRequest!: () => void, freshObserved!: () => void;
  let liveSocket: { send(value: Uint8Array): unknown } | undefined;
  const ackWaiters = new Map<string, () => void>();
  const requested = new Promise<void>(resolve => { firstRequest = resolve; }), refreshed = new Promise<void>(resolve => { freshObserved = resolve; });
  const junkApplication = crypto.randomUUID(), junkCanary = "fresh-capacity-chat-canary";
  const receivedChats: string[] = [], signedReceipts: unknown[] = [];
  let counterpartyWork = Promise.resolve();
  const acknowledgements: string[] = [], gaps: string[] = [], observed: { member: string; peers: readonly { id: string; state: string }[] }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, host) { return host.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { connections++; liveSocket = ws; const row = receiver.get("work")!; ws.send(canonicalBytes({ v: 1, type: "challenge", room: row.current.room, broker: row.broker, nonce: encodeBase64url(randomBytes(32)), expiresAt: Date.now() + 10_000, rosterDigest: row.current.digest })); },
      message(ws, data) {
        const message = JSON.parse(String(data)) as { type: string; digest?: string }, row = receiver.get("work")!;
        if (message.type === "auth") { ws.send(row.wire); ws.send(canonicalBytes({ v: 1, type: "ready", room: row.current.room, member: receiver.identity.public.fingerprint, epoch: row.current.epoch, digest: row.current.digest })); }
        else if (message.type === "roster_ready") ws.send(retiredPresence ?? junkWire ?? targetWire);
        else if (message.type === "received") {
          acknowledgements.push(message.digest!); ackWaiters.get(message.digest!)?.(); ackWaiters.delete(message.digest!); ws.send(canonicalBytes({ v: 1, type: "queue_ack", digest: message.digest }));
          if (message.digest === retiredPresenceDigest && retiredPresence) ws.send(junkWire ?? targetWire);
          if (message.digest === junkDigest && junkWire) ws.send(targetWire);
          if (message.digest === targetDigest) resolveDone();
          if (message.digest === freshPresenceDigest) freshObserved();
        } else if (message.type === "frame" && (withPresence || junkKind === "chat")) {
          // The authenticated counterparty consumes a forwarded ciphertext frame;
          // this is separate from the blind relay's queue/ACK fixture above.
          const wire = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
          counterpartyWork = counterpartyWork.then(async () => {
            const opened = await openFrame({ wire, identity: sender.identity, current: sender.get("work")!.current, replay: sender.replay });
            if (opened.status !== "accepted") return;
            sender.settleInbox("work", encodeBase64url(await sha256(wire)));
            const body = JSON.parse(new TextDecoder().decode(opened.plaintext)) as { type?: string; requestReply?: boolean };
            if (body.type === "receipt") signedReceipts.push(body);
            if (body.type !== "presence" || body.requestReply !== true) return;
            requests++; firstRequest();
            if (allowFreshPresence) {
              const reply = await sealFrame({ epoch: sender.get("work")!.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }] }) });
              freshPresenceDigest = encodeBase64url(await sha256(reply)); ws.send(reply);
            }
          }).catch(() => { ws.close(4403, "fixture counterpart failed"); throw new Error("fixture counterpart failed"); });
          void counterpartyWork.catch(() => {});
        }
      }, close() { resolveClosed(); },
    },
  }); cleanups.push(() => server.stop(true));
  const broker = `ws://127.0.0.1:${server.port}/`, first = await createRoomEpoch({ owner: receiver.identity, members: [{ ...receiver.identity.public, label: "receiver", exposedPeers: ["codex"] }] });
  await receiver.install({ name: "work", broker, wire: first.wire, expectedDigest: null });
  const invite = await createInvite({ owner: receiver.identity, epoch: first.epoch, broker, expiresAt: Date.now() + 600_000 }); await receiver.saveInvite("work", invite);
  const request = await createJoin({ invite, identity: sender.identity, label: "sender", exposedPeers: ["codex"] }); sender.savePendingJoin("work", { invite, request });
  const roster = await receiver.enroll("work", request); await sender.install({ name: "work", broker, wire: roster.wire, expectedDigest: null });
  const pairs: { digest: string; delivery: string; receipt: RoomMessage; wire: Uint8Array }[] = [];
  const applications = Array.from({ length: reserved + 1 }, () => crypto.randomUUID());
  for (const application of applications) {
    const delivery = crypto.randomUUID(), chat: RoomMessage = { v: 1, type: "chat", envelope: { id: application, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "outstanding receipt lane fixture", ts: Date.now() } };
    const wire = await sealFrame({ epoch: roster.current, identity: receiver.identity, recipients: [sender.identity.public.fingerprint], sequence: receiver.sequence, plaintext: encodeRoomMessage(chat) });
    const outgoing = await receiver.queueApplication("work", wire, { deliveryId: delivery, application, remotePeer: "codex@sender", recipient: sender.identity.public.fingerprint, peer: "codex", ackTimeoutMs: 600_000, ttlMs: 86_400_000 });
    pairs.push({ digest: outgoing.digest, delivery, receipt: { v: 1, type: "receipt", frame: outgoing.digest, application, peer: "codex", outcome: "failed_safe", reason: "boundary_refused" }, wire: new Uint8Array() });
  }
  for (let n = 0; n < 200; n++) {
    const chat: RoomMessage = { v: 1, type: "chat", envelope: { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: "retained pre-claim chat", ts: Date.now() } };
    const wire = await sealFrame({ epoch: roster.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: encodeRoomMessage(chat) });
    expect((await openFrame({ wire, identity: receiver.identity, current: roster.current, replay: receiver.replay })).status).toBe("accepted");
  }
  for (const pair of pairs.slice(0, reserved)) {
    pair.wire = await sealFrame({ epoch: roster.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: encodeRoomMessage(pair.receipt) });
    expect((await openFrame({ wire: pair.wire, identity: receiver.identity, current: roster.current, replay: receiver.replay })).status).toBe("accepted");
  }
  if (withPresence) {
    retiredPresence = await sealFrame({ epoch: roster.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "busy" }], requestReply: true }) });
    retiredPresenceDigest = encodeBase64url(await sha256(retiredPresence));
  }
  if (!reserved) {
    const junk: RoomMessage = junkKind === "chat"
      ? { v: 1, type: "chat", envelope: { id: junkApplication, trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat", priority: "status", body: junkCanary, ts: Date.now() } }
      : { v: 1, type: "receipt", frame: encodeBase64url(randomBytes(32)), application: crypto.randomUUID(), peer: "codex", outcome: "failed_safe", reason: "boundary_refused" };
    junkWire = await sealFrame({ epoch: roster.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: encodeRoomMessage(junk) });
    junkDigest = encodeBase64url(await sha256(junkWire));
  }
  const target = pairs.at(-1)!;
  targetWire = await sealFrame({ epoch: roster.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: encodeRoomMessage(target.receipt) }); targetDigest = encodeBase64url(await sha256(targetWire));
  const link = new RoomLink({ store: receiver, name: "work", onPresence: value => { observed.push(value); }, application: { members: () => {}, stored: () => {}, online: async () => {}, gap: (_context, input) => { gaps.push(input.count); }, receive: async (context, input) => {
    if (input.message?.type === "chat") receivedChats.push(input.message.envelope.id);
    if (input.message?.type !== "receipt" || input.digest !== targetDigest) throw new RoomApplicationDeferredError("capacity");
    context.store.applyApplicationReceipt("work", input.digest, context.current); context.store.settleInbox("work", input.digest);
  } } }); cleanups.push(() => link.stop());
  const bounded = (promise: Promise<void>, label: string) => new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`receipt lane barrier timed out: ${label}`)), 5000); promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); }); });
  const sendRequest = async () => {
    const wire = await sealFrame({ epoch: sender.get("work")!.current, identity: sender.identity, recipients: [receiver.identity.public.fingerprint], sequence: sender.sequence, plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }], requestReply: true }) });
    const digest = encodeBase64url(await sha256(wire)); liveSocket!.send(wire); return digest;
  };
  return { receiver, sender, pairs, target, targetDigest, junkDigest, junkApplication, junkCanary, receivedChats, signedReceipts, counterpartyIdle: () => counterpartyWork, retiredPresenceDigest, link, acknowledgements, gaps, observed, sendRequest, acknowledged: (digest: string) => bounded(acknowledgements.includes(digest) ? Promise.resolve() : new Promise<void>(resolve => { ackWaiters.set(digest, resolve); }), "incoming request transport ACK"), get connections() { return connections; }, get requests() { return requests; }, allowFresh: () => { allowFreshPresence = true; }, requested: () => bounded(requested, "initial signed presence request"), refreshed: () => bounded(refreshed, "fresh signed state after capacity returns"), closed: () => bounded(closed, "full reserve closes without ACK"), done: () => bounded(done, "matching signed receipt retires") };
}

test("200 retained chats do not let an unmatched receipt poison a matching receipt behind it", async () => {
  const f = await fullPhysicalInbox(0); expect(f.receiver.pendingInbox("work")).toHaveLength(200);
  await f.link.start(); await f.done();
  expect(f.acknowledgements).toEqual([f.junkDigest, f.targetDigest]);
  expect(f.receiver.pendingInbox("work")).toHaveLength(200);
  expect(f.receiver.refused("work")).toContainEqual(expect.objectContaining({ digest: f.junkDigest, reason: "invalid_frame" }));
  expect(f.receiver.applicationOutbox("work").find(row => row.deliveryId === f.target.delivery)?.state).toBe("failed_safe");
  expect(f.gaps).toContain("1"); // The dropped unknown receipt never advanced the replay floor.
}, 20_000);

test("a fresh 201st signed chat is retired without admission so the matching receipt behind it can settle", async () => {
  const f = await fullPhysicalInbox(0, false, "chat");
  expect(f.receiver.pendingInbox("work")).toHaveLength(200);
  await f.link.start();
  const outcome = await Promise.race([f.done().then(() => "settled"), f.closed().then(() => "closed")]);
  expect(outcome).toBe("settled");
  await f.requested(); await f.counterpartyIdle();
  expect(f.acknowledgements).toEqual([f.junkDigest, f.targetDigest]);
  expect(f.link.status().state).toBe("online"); expect(f.connections).toBe(1);
  expect(f.receiver.pendingInbox("work")).toHaveLength(200);
  expect(f.receivedChats).not.toContain(f.junkApplication);
  expect(f.receiver.applicationReceipt("work", f.junkDigest)).toBeUndefined();
  expect(f.signedReceipts).toEqual([]);
  expect(f.receiver.refused("work")).toContainEqual(expect.objectContaining({ digest: f.junkDigest, reason: "invalid_frame" }));
  expect(JSON.stringify(f.receiver.refused("work"))).not.toContain(f.junkCanary);
  expect(JSON.stringify(f.receiver.pendingInbox("work"))).not.toContain(f.junkCanary);
  expect(f.gaps).toEqual(["1"]); // Retiring fresh ciphertext never advances its sender's floor.
  expect(f.receiver.applicationOutbox("work").find(row => row.deliveryId === f.target.delivery)?.state).toBe("failed_safe");
}, 20_000);

test("a matching ninth reserved receipt stays unacknowledged until one real reserved receipt is settled", async () => {
  const f = await fullPhysicalInbox(8); expect(f.receiver.pendingInbox("work")).toHaveLength(208);
  await f.link.start(); await f.closed();
  expect(f.acknowledgements).toEqual([]); expect(f.receiver.refused("work").some(row => row.digest === f.targetDigest)).toBe(false);
  const released = f.pairs[0]!, digest = encodeBase64url(await sha256(released.wire));
  expect(f.receiver.applyApplicationReceipt("work", digest)?.state).toBe("failed_safe"); f.receiver.settleInbox("work", digest);
  await f.done();
  expect(f.acknowledgements).toEqual([f.targetDigest]); expect(f.receiver.pendingInbox("work")).toHaveLength(207);
  expect(f.receiver.applicationOutbox("work").find(row => row.deliveryId === f.target.delivery)?.state).toBe("failed_safe");
}, 20_000);


test("physical capacity retires valid presence ahead of a receipt and asks once for fresh state after space returns", async () => {
  const f = await fullPhysicalInbox(0, true);
  await f.link.start(); await f.done(); await f.requested();
  expect(f.acknowledgements).toEqual([f.retiredPresenceDigest, f.junkDigest, f.targetDigest]);
  expect(f.observed).toEqual([]); expect(f.receiver.pendingInbox("work")).toHaveLength(200);
  expect(f.receiver.refused("work")).toContainEqual(expect.objectContaining({ digest: f.retiredPresenceDigest, reason: "invalid_presence" }));
  expect(f.gaps).toContain("2"); // Neither capacity drop advanced the authenticated sender floor.
  const first = f.receiver.pendingInbox("work")[0]!, before = f.requests;
  let reserved = 0; const reserve = f.receiver.sequence.reserve;
  f.receiver.sequence.reserve = async input => { reserved++; return reserve(input); };
  try {
    f.allowFresh(); f.receiver.settleInbox("work", first.digest);
    await f.link.retryPendingApplications(); await f.refreshed();
    await f.link.refreshPresenceIfCapacityFree(); await f.link.refreshPresenceIfCapacityFree();
    expect(f.requests).toBe(before + 1); expect(reserved).toBe(1);
    expect(f.observed).toEqual([{ member: f.sender.identity.public.fingerprint, peers: [{ id: "codex", state: "idle" }] }]);
    expect(f.receiver.pendingInbox("work")).toHaveLength(199);
  } finally { f.receiver.sequence.reserve = reserve; }
}, 20_000);

test("a real settlement asks every live room binding to refresh global capacity, without a status read", async () => {
  const f = await recoveredIncoming(true), refreshed: string[] = [];
  f.context.link.refreshPresenceIfCapacityFree = async () => { refreshed.push("work"); };
  f.context.link.retryPendingApplications = async () => {};
  const other = await createRoomEpoch({ owner: f.guest.identity, members: [{ ...f.guest.identity.public, label: "guest", exposedPeers: [] }] });
  await f.guest.install({ name: "other", broker: "ws://127.0.0.1:1/", wire: other.wire, expectedDigest: null });
  const second = { publishApplication: async () => "", retryPendingApplications: async () => {}, refreshPresenceIfCapacityFree: async () => { refreshed.push("other"); } } as unknown as RoomLink;
  f.service.bind(f.guest, "other", second);
  await f.service.application.online(f.context);
  await f.service.application.online({ store: f.guest, name: "other", link: second, current: () => true });
  refreshed.length = 0;
  await f.service.application.receive(f.context, { digest: f.digest, sender: f.owner.identity.public.fingerprint, message: f.message });
  await Promise.resolve();
  expect(new Set(refreshed)).toEqual(new Set(["work", "other"]));
  expect(f.guest.pendingInbox("work")).toEqual([]);
});


test("capacity refresh intent survives a held ordinary response and another incoming request", async () => {
  const f = await fullPhysicalInbox(0, true); await f.link.start(); await f.done(); await f.requested();
  const first = f.receiver.pendingInbox("work")[0]!, before = f.requests;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const reserve = f.receiver.sequence.reserve; let blocked = false;
  f.receiver.sequence.reserve = async input => { const seq = await reserve(input); if (!blocked) { blocked = true; enter(); await held; } return seq; };
  try {
    f.allowFresh(); f.receiver.settleInbox("work", first.digest);
    await f.sendRequest();
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("ordinary response seal barrier timed out")), 5000); entered.then(() => { clearTimeout(timer); resolve(); }, reject); });
    await f.link.refreshPresenceIfCapacityFree();
    const second = await f.sendRequest(); await f.acknowledged(second);
    release(); await f.refreshed();
    expect(f.requests).toBe(before + 1);
    expect(f.observed.at(-1)?.peers).toEqual([{ id: "codex", state: "idle" }]);
  } finally { release(); f.receiver.sequence.reserve = reserve; }
}, 20_000);

test("a refresh send failure preserves intent and uses bounded reconnect instead of losing the request", async () => {
  const f = await fullPhysicalInbox(0, true); await f.link.start(); await f.done(); await f.requested();
  const before = f.connections, requests = f.requests, first = f.receiver.pendingInbox("work")[0]!;
  const send = WebSocket.prototype.send; let failed = false;
  WebSocket.prototype.send = function(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    let type: unknown;
    try {
      const bytes = typeof data === "string" ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
      if (bytes !== undefined) type = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)).type;
    } catch { /* Not a fixture frame. */ }
    if (!failed && type === "frame") { failed = true; throw new Error("fixture backpressure send failure"); }
    return send.call(this, data);
  };
  try {
    f.allowFresh(); f.receiver.settleInbox("work", first.digest);
    await f.link.refreshPresenceIfCapacityFree().catch(() => undefined); // Model the host's handled advisory failure.
    await f.refreshed();
    expect(failed).toBe(true); expect(f.connections).toBe(before + 1); expect(f.requests).toBe(requests + 1);
    expect(f.observed.at(-1)?.peers).toEqual([{ id: "codex", state: "idle" }]);
  } finally { WebSocket.prototype.send = send; }
}, 20_000);
