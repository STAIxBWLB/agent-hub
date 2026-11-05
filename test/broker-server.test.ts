import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as roomCrypto from "../src/rooms/crypto.ts";
import { generateHubIdentity, encodeBase64url, RoomCryptoError, type HubIdentity } from "../src/rooms/crypto.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, roomMembers, sealFrame, verifyPublicFrame, type VerifiedEpoch, type SequencePort } from "../src/rooms/wire.ts";
import { createBrokerAuth, decodeBrokerChallenge } from "../src/broker/protocol.ts";
import { BrokerStore } from "../src/broker/store.ts";
import { startBroker, type BrokerPorts, type BrokerRuntime } from "../src/broker/server.ts";
import { FakeBrokerClient, packetObject } from "./fakes/broker-client.ts";

const text = new TextEncoder(), decode = new TextDecoder();
const roots: string[] = [], servers: BrokerRuntime[] = [], clients: FakeBrokerClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) client.close(); for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const member = (id: HubIdentity, label: string) => ({ ...id.public, label, exposedPeers: ["codex"] });
const sequence = (): SequencePort => { let seq = 0; return { reserve: async () => String(++seq), isCurrent: () => true }; };
async function setup(options: { limits?: { queuedPerRoom?: number; rooms?: number; queueTtlMs?: number }; ports?: BrokerPorts; stateDir?: string; owners?: readonly string[] } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ahub-broker-")); if (!options.stateDir) roots.push(stateDir);
  const server = await startBroker({ stateDir, port: 0, ...(options.limits ? { limits: options.limits } : {}), ...(options.owners ? { owners: options.owners } : {}) }, options.ports); servers.push(server);
  return { server, stateDir, url: `ws://127.0.0.1:${server.port}/` };
}
async function connect(url: string, room: string) { const client = await FakeBrokerClient.connect(url, room); clients.push(client); return client; }
async function fixture(options: Parameters<typeof setup>[0] = {}) {
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const created = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(guest, "guest")] });
  const runtime = await setup(options), ownerClient = await connect(runtime.url, created.epoch.room);
  await ownerClient.authenticate(owner, created.wire);
  return { ...runtime, ...created, owner, guest, ownerClient, seq: sequence() };
}
const seal = (epoch: VerifiedEpoch, identity: HubIdentity, recipient: string, content: string, seq = sequence()) => sealFrame({ epoch, identity, recipients: [recipient], plaintext: text.encode(content), sequence: seq });

test("blind broker persists and fans out only sealed canary bytes, with queue ACK separate from completion", async () => {
  const events: unknown[] = [], f = await fixture({ ports: { log: (event, ids) => events.push({ event, ids }) } });
  const canary = "BROKER-PLAINTEXT-CANARY-446";
  const wire = await seal(f.epoch, f.owner, f.guest.public.fingerprint, canary, f.seq);
  f.ownerClient.send(wire);
  const accepted = packetObject(await f.ownerClient.take("stored"));
  expect(accepted.type).toBe("stored"); expect("completed" in accepted).toBe(false);
  expect(f.server.stats().queuedFrames).toBe(1);
  expect(JSON.stringify(events)).not.toContain(canary);
  expect(JSON.stringify(f.server.stats())).not.toContain(canary);
  for (const name of readdirSync(f.stateDir)) expect(readFileSync(join(f.stateDir, name)).includes(Buffer.from(canary))).toBe(false);
  const guest = await connect(f.url, f.epoch.room); await guest.authenticate(f.guest);
  const delivered = await guest.take("frame"); expect(delivered).toEqual(wire);
  expect(decode.decode(delivered)).not.toContain(canary);
  await guest.ack(String(accepted.digest));
  expect(f.server.stats().queuedFrames).toBe(0);
});

test("HTTP and WebSocket browser Origin requests refuse before roster admission", async () => {
  const f = await setup();
  expect((await fetch(f.url.replace("ws:", "http:") + "health", { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
  const owner = await generateHubIdentity(), room = await createRoomEpoch({ owner, members: [member(owner, "owner")] });
  await expect(FakeBrokerClient.connect(f.url, room.epoch.room, { Origin: "https://attacker.example" })).rejects.toThrow("refused");
  expect(f.server.stats().rooms).toBe(0);
});

test("auth rejects nonmembers, cross-socket challenge replay, expired proofs and a second auth", async () => {
  let time = 0;
  const f = await fixture({ ports: { clock: () => time } }), stranger = await generateHubIdentity();
  const outsider = await connect(f.url, f.epoch.room);
  const outsiderChallenge = decodeBrokerChallenge(await outsider.take("challenge"));
  outsider.send(await createBrokerAuth({ challenge: outsiderChallenge, identity: stranger, broker: f.url, room: f.epoch.room }));
  expect((await outsider.closed).code).toBe(4403);
  const a = await connect(f.url, f.epoch.room), b = await connect(f.url, f.epoch.room);
  const challenge = decodeBrokerChallenge(await a.take("challenge")); await b.take("challenge");
  const auth = await createBrokerAuth({ challenge, identity: f.guest, broker: f.url, room: f.epoch.room });
  b.send(auth); expect((await b.closed).code).toBe(4403);
  time = 10_000; a.send(auth); expect((await a.closed).code).toBe(4403);
  const repeat = await connect(f.url, f.epoch.room), c = decodeBrokerChallenge(await repeat.take("challenge"));
  const again = await createBrokerAuth({ challenge: c, identity: f.guest, broker: f.url, room: f.epoch.room });
  repeat.send(again); await repeat.rosterReady(); repeat.send(again);
  expect((await repeat.closed).code).toBe(4403);
});

test("queue capacity refuses without evicting an accepted offline frame and forged sender traffic closes", async () => {
  const f = await fixture({ limits: { queuedPerRoom: 1 } });
  const producer = await FakeBrokerClient.connect(f.url, f.epoch.room, { "x-agent-hub-ephemeral": "1" });
  clients.push(producer); await producer.authenticate(f.owner);
  producer.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "one", f.seq)); await producer.take("stored");
  const refusedWire = await seal(f.epoch, f.owner, f.guest.public.fingerprint, "two", f.seq);
  producer.send(refusedWire);
  const refusal = packetObject(await producer.take("error"));
  expect(refusal.code).toBe("queue_full");
  expect(refusal.digest).toBe(encodeBase64url(await roomCrypto.sha256(refusedWire)));
  expect(f.server.stats().queuedFrames).toBe(1);
  producer.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "forged socket sender"));
  expect((await producer.closed).code).toBe(4403);
  expect(f.server.stats().queuedFrames).toBe(1);
});

test("owner rotation disconnects revoked members, purges their traffic and survives restart with the new pin", async () => {
  const f = await fixture(), guest = await connect(f.url, f.epoch.room); await guest.authenticate(f.guest);
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "queued", f.seq)); await f.ownerClient.take("stored"); await guest.take("frame");
  const next = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner")], previous: f.epoch });
  f.ownerClient.send(next.wire); await f.ownerClient.take("roster_installed");
  expect((await guest.closed).code).toBe(4403); expect(f.server.stats().queuedFrames).toBe(0);
  await f.server.stop();
  const restarted = await setup({ stateDir: f.stateDir });
  const revoked = await connect(restarted.url, f.epoch.room), challenge = decodeBrokerChallenge(await revoked.take("challenge"));
  expect(challenge.rosterDigest).toBe(next.epoch.digest);
  revoked.send(await createBrokerAuth({ challenge, identity: f.guest, broker: restarted.url, room: f.epoch.room }));
  expect((await revoked.closed).code).toBe(4403);
  const owner = await connect(restarted.url, f.epoch.room); await owner.authenticate(f.owner);
  owner.send(f.wire); expect((await owner.closed).code).toBe(4403);
});

test("revocation during an awaited frame verification refuses before queue or fanout effects", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ ports: { verifyFrame: async input => { const proof = await verifyPublicFrame(input); entered(); await held; return proof; } } });
  const guest = await connect(f.url, f.epoch.room); await guest.authenticate(f.guest);
  guest.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "stale"));
  await started;
  const next = await createRoomEpoch({ owner: f.owner, members: [member(f.owner, "owner")], previous: f.epoch });
  f.ownerClient.send(next.wire); await f.ownerClient.take("roster_installed");
  release(); expect((await guest.closed).code).toBe(4403); expect(f.server.stats().queuedFrames).toBe(0);
});


test("an explicit recipient set fans out one sealed packet with independent queue ACKs", async () => {
  const owner = await generateHubIdentity(), a = await generateHubIdentity(), b = await generateHubIdentity();
  const epoch = await createRoomEpoch({ owner, members: [member(owner, "owner"), member(a, "a"), member(b, "b")] });
  const f = await setup(), producer = await connect(f.url, epoch.epoch.room);
  await producer.authenticate(owner, epoch.wire);
  const ca = await connect(f.url, epoch.epoch.room), cb = await connect(f.url, epoch.epoch.room);
  await ca.authenticate(a); await cb.authenticate(b);
  const wire = await sealFrame({ epoch: epoch.epoch, identity: owner, recipients: [a.public.fingerprint, b.public.fingerprint].sort(), plaintext: text.encode("multicast ciphertext"), sequence: sequence() });
  producer.send(wire); const stored = packetObject(await producer.take("stored"));
  expect(await ca.take("frame")).toEqual(wire); expect(await cb.take("frame")).toEqual(wire);
  await ca.ack(String(stored.digest)); expect(f.server.stats().queuedFrames).toBe(1);
  await cb.ack(String(stored.digest)); expect(f.server.stats().queuedFrames).toBe(0);
});

test("bidirectional queue ACKs wait behind an outgoing verification without closing the authenticated socket", async () => {
  let entered!: () => void, release!: () => void, buffered!: () => void;
  let blockedSender: string | undefined, blocking = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const queued = new Promise<void>(resolve => { buffered = resolve; });
  const f = await fixture({ ports: {
    verifyFrame: async input => { const proof = await verifyPublicFrame(input); if (proof.sender === blockedSender) { blocking = true; entered(); await held; } return proof; },
    log: (event, ids) => { if (event === "buffered" && blocking && ids.member === blockedSender) buffered(); },
  } });
  const guest = await connect(f.url, f.epoch.room); await guest.authenticate(f.guest);
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "inbound", f.seq));
  const inbound = packetObject(await f.ownerClient.take("stored")); await guest.take("frame");
  blockedSender = f.guest.public.fingerprint;
  guest.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "outbound"));
  await started;
  try {
    guest.control({ v: 1, type: "received", digest: inbound.digest });
    const admitted = await Promise.race([queued.then(() => true), guest.closed.then(() => false)]);
    expect(admitted).toBe(true);
  } finally { release(); }
  await guest.take("stored"); await guest.take("queue_ack");
  expect(guest.ws.readyState).toBe(WebSocket.OPEN);
  expect(f.server.stats().queuedFrames).toBe(1); // outbound remains until the owner ACKs it.
});


async function settled(server: BrokerRuntime): Promise<void> {
  for (let i = 0; i < 100 && server.stats().verifications !== 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(server.stats().verifications).toBe(0);
}

test("socket replacement and shutdown fence a verified packet waiting before store effects", async () => {
  for (const action of ["replace", "shutdown"] as const) {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ ports: { verifyFrame: async input => { const proof = await verifyPublicFrame(input); entered(); await held; return proof; } } });
    const old = await connect(f.url, f.epoch.room); await old.authenticate(f.guest);
    old.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "late generation"));
    await started;
    try {
      if (action === "replace") { const next = await connect(f.url, f.epoch.room); await next.authenticate(f.guest); }
      else await f.server.stop();
      await old.closed;
    } finally { release(); }
    await settled(f.server);
    expect(f.server.stats().queuedFrames).toBe(0);
  }
});


test("startup crypto refusal precedes broker database and listener effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-broker-refused-")); roots.push(root);
  const stateDir = join(root, "uncreated");
  const probe = spyOn(roomCrypto, "assertRoomCryptoReady").mockRejectedValue(new RoomCryptoError("unavailable"));
  try {
    const attempt = startBroker({ stateDir, port: 0 }).then(server => { servers.push(server); return server; });
    await expect(attempt).rejects.toMatchObject({ code: "unavailable" });
  } finally { probe.mockRestore(); }
  expect(readdirSync(root)).toEqual([]);
});

test("forged frame signatures and non-owner roster publication refuse before retained effects", async () => {
  const f = await fixture();
  const wire = await seal(f.epoch, f.owner, f.guest.public.fingerprint, "signed ciphertext", f.seq);
  f.ownerClient.send(canonicalBytes({ ...decodeFrame(wire), signature: encodeBase64url(new Uint8Array(64)) }));
  const outcome = await Promise.race([f.ownerClient.take("error"), f.ownerClient.take("stored")]);
  expect(packetObject(outcome)).toMatchObject({ type: "error", code: "authentication_failed" });
  expect(f.server.stats().queuedFrames).toBe(0);
  const guest = await connect(f.url, f.epoch.room); await guest.authenticate(f.guest);
  const rotated = await createRoomEpoch({ owner: f.owner, members: roomMembers(f.epoch), previous: f.epoch });
  guest.send(rotated.wire);
  expect(packetObject(await guest.take("error")).code).toBe("not_owner");
  const probe = await connect(f.url, f.epoch.room);
  expect(decodeBrokerChallenge(await probe.take("challenge")).rosterDigest).toBe(f.epoch.digest);
});


test("public audience requires an owner allowlist before state or listener effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-broker-owners-")); roots.push(root);
  const stateDir = join(root, "uncreated");
  const attempt = startBroker({ stateDir, port: 0, publicUrl: "wss://relay.example/" }).then(server => { servers.push(server); return server; });
  await expect(attempt).rejects.toMatchObject({ code: "owner_allowlist_required" });
  expect(readdirSync(root)).toEqual([]);
});

test("unapproved owners consume no room slots and offline drop frees a named slot", async () => {
  const owner = await generateHubIdentity(), attacker = await generateHubIdentity();
  const f = await setup({ owners: [owner.public.fingerprint], limits: { rooms: 1 } });
  for (let i = 0; i < 3; i++) {
    const room = await createRoomEpoch({ owner: attacker, members: [member(attacker, "unapproved")] });
    const client = await connect(f.url, room.epoch.room);
    const challenge = decodeBrokerChallenge(await client.take("challenge"));
    client.send(await createBrokerAuth({ challenge, identity: attacker, broker: f.url, room: room.epoch.room, initialRoster: room.wire }));
    const refused = await Promise.race([client.take("error"), client.take("ready")]);
    expect(packetObject(refused)).toMatchObject({ type: "error", code: "owner_not_allowed" });
    await client.closed;
    expect(f.server.stats().rooms).toBe(0);
  }
  const room = await createRoomEpoch({ owner, members: [member(owner, "approved")] });
  const client = await connect(f.url, room.epoch.room); await client.authenticate(owner, room.wire);
  expect(f.server.stats().rooms).toBe(1);
  await expect(BrokerStore.open({ stateDir: f.stateDir, create: false })).rejects.toMatchObject({ code: "busy" });
  await f.server.stop();
  const offline = await BrokerStore.open({ stateDir: f.stateDir, create: false });
  try { expect(offline.dropRoom(room.epoch.room)).toEqual({ removed: true }); expect(offline.stats().rooms).toBe(0); }
  finally { offline.close(); }
  const next = await setup({ stateDir: f.stateDir, owners: [owner.public.fingerprint], limits: { rooms: 1 } });
  const fresh = await createRoomEpoch({ owner, members: [member(owner, "approved")] });
  const producer = await connect(next.url, fresh.epoch.room); await producer.authenticate(owner, fresh.wire);
  expect(next.server.stats().rooms).toBe(1);
});

test("broker advertises ephemeral only to explicitly opted-in clients and preserves legacy ready keys", async () => {
  const f = await fixture();
  for (const value of [undefined, "0", "1"] as const) {
    const client = await FakeBrokerClient.connect(f.url, f.epoch.room, value === undefined ? undefined : { "x-agent-hub-ephemeral": value });
    clients.push(client);
    const challenge = decodeBrokerChallenge(await client.take("challenge"));
    client.send(await createBrokerAuth({ challenge, identity: f.guest, broker: f.url, room: f.epoch.room }));
    await client.take("roster");
    const ready = packetObject(await client.take("ready"));
    expect(Object.keys(ready).sort()).toEqual(["v", "type", "room", "member", "epoch", "digest", ...(value === "1" ? ["ephemeral"] : [])].sort());
    expect(ready.ephemeral).toBe(value === "1" ? true : undefined);
    client.control({ v: 1, type: "roster_ready", digest: ready.digest });
    client.close();
  }
});


test("legacy broker clients keep the closed queue_full error shape", async () => {
  const f = await fixture({ limits: { queuedPerRoom: 1 } });
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "one", f.seq));
  await f.ownerClient.take("stored");
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "two", f.seq));
  const refusal = packetObject(await f.ownerClient.take("error"));
  expect(refusal).toEqual({ v: 1, type: "error", code: "queue_full" });
  expect(f.ownerClient.ws.readyState).toBe(WebSocket.OPEN);
});


test("replaced ephemeral frames keep a slow recipient's one-packet slot until its ACK", async () => {
  const f = await fixture();
  const guest = await FakeBrokerClient.connect(f.url, f.epoch.room, { "x-agent-hub-ephemeral": "1" });
  clients.push(guest); await guest.authenticate(f.guest);
  const guestSequence = sequence();
  // A signed guest probe follows roster_ready on that socket, proving it is ready.
  guest.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "ready probe", guestSequence));
  const readyProbe = packetObject(await guest.take("stored"));
  await f.ownerClient.take("frame"); await f.ownerClient.ack(String(readyProbe.digest));
  const presenceFrame = () => sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("presence"), ephemeral: true, sequence: f.seq });
  const first = await presenceFrame();
  f.ownerClient.send(first); const firstStored = packetObject(await f.ownerClient.take("stored"));
  expect(await guest.take("frame")).toEqual(first); // Deliberately leave this transport ACK outstanding.
  let latest = first, latestDigest = String(firstStored.digest);
  for (let flip = 0; flip < 12; flip++) {
    latest = await presenceFrame(); f.ownerClient.send(latest);
    latestDigest = String(packetObject(await f.ownerClient.take("stored")).digest);
  }
  const chat = await seal(f.epoch, f.owner, f.guest.public.fingerprint, "chat after presence", f.seq);
  f.ownerClient.send(chat); const chatStored = packetObject(await f.ownerClient.take("stored"));
  // This same-socket response follows all prior broker sends to the guest, so the
  // absence assertion below needs no sleep or negative take() timeout.
  guest.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "delivery barrier", guestSequence));
  const barrier = packetObject(await guest.take("stored"));
  expect(guest.packets.filter(wire => packetObject(wire).type === "frame")).toHaveLength(0);
  expect(guest.ws.readyState).toBe(WebSocket.OPEN);
  await guest.ack(String(firstStored.digest));
  expect(await guest.take("frame")).toEqual(latest);
  await guest.ack(latestDigest);
  expect(await guest.take("frame")).toEqual(chat);
  await guest.ack(String(chatStored.digest));
  await f.ownerClient.take("frame"); await f.ownerClient.ack(String(barrier.digest));
  expect(f.server.stats().queuedFrames).toBe(0);
});


test("a replaced unacknowledged ephemeral slot expires at its original queue deadline", async () => {
  let now = 1_000;
  const f = await fixture({ ports: { clock: () => now }, limits: { queueTtlMs: 500 } });
  const guest = await FakeBrokerClient.connect(f.url, f.epoch.room, { "x-agent-hub-ephemeral": "1" });
  clients.push(guest); await guest.authenticate(f.guest);
  const guestSequence = sequence();
  const barrier = async () => {
    guest.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "signed barrier", guestSequence));
    const stored = packetObject(await guest.take("stored"));
    await f.ownerClient.take("frame"); await f.ownerClient.ack(String(stored.digest));
  };
  await barrier();
  const presenceFrame = () => sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint], plaintext: text.encode("presence"), ephemeral: true, sequence: f.seq });
  const first = await presenceFrame();
  f.ownerClient.send(first); await f.ownerClient.take("stored");
  expect(await guest.take("frame")).toEqual(first); // No ACK: this slot's original deadline is 1_500.
  now = 1_200;
  const latest = await presenceFrame();
  f.ownerClient.send(latest); const latestStored = packetObject(await f.ownerClient.take("stored"));
  now = 1_300;
  const chat = await seal(f.epoch, f.owner, f.guest.public.fingerprint, "queued chat", f.seq);
  f.ownerClient.send(chat); const chatStored = packetObject(await f.ownerClient.take("stored"));
  now = 1_499; f.server.sweep(); await barrier();
  expect(guest.packets.filter(wire => packetObject(wire).type === "frame")).toHaveLength(0);
  expect(f.server.stats().queuedFrames).toBe(2);
  now = 1_500; f.server.sweep();
  expect(await guest.take("frame")).toEqual(latest);
  expect(f.server.stats().queuedFrames).toBe(2); // Slot expiry never evicts the retained replacement or chat.
  await guest.ack(String(latestStored.digest));
  expect(await guest.take("frame")).toEqual(chat);
  await guest.ack(String(chatStored.digest));
  expect(f.server.stats().queuedFrames).toBe(0);
});

test("ephemeral presence is withheld from legacy members while their chat remains usable", async () => {
  const f = await fixture();
  const producer = await FakeBrokerClient.connect(f.url, f.epoch.room, { "x-agent-hub-ephemeral": "1" });
  clients.push(producer); await producer.authenticate(f.owner);
  const legacy = await connect(f.url, f.epoch.room); await legacy.authenticate(f.guest);
  const request = await sealFrame({ epoch: f.epoch, identity: f.guest, recipients: [f.owner.public.fingerprint],
    plaintext: canonicalBytes({ v: 1, type: "presence", peers: [], requestReply: true }), sequence: sequence() });
  legacy.send(request);
  const probe = packetObject(await legacy.take("stored"));
  expect(await producer.take("frame")).toEqual(request); await producer.ack(String(probe.digest));
  // The upgraded member answers the explicit legacy request with its advertised codec.
  producer.send(await sealFrame({ epoch: f.epoch, identity: f.owner, recipients: [f.guest.public.fingerprint],
    plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "idle" }] }), sequence: f.seq, ephemeral: true }));
  await producer.take("stored");
  const chat = await seal(f.epoch, f.owner, f.guest.public.fingerprint, "legacy member chat", f.seq);
  producer.send(chat); const stored = packetObject(await producer.take("stored"));
  expect(await legacy.take("frame")).toEqual(chat);
  await legacy.ack(String(stored.digest));
  expect(legacy.ws.readyState).toBe(WebSocket.OPEN);
  expect(f.server.stats().queuedFrames).toBe(0);
});
