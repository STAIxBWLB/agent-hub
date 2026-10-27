import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as roomCrypto from "../src/rooms/crypto.ts";
import { generateHubIdentity, encodeBase64url, RoomCryptoError, type HubIdentity } from "../src/rooms/crypto.ts";
import { canonicalBytes, createRoomEpoch, decodeFrame, roomMembers, sealFrame, verifyPublicFrame, type VerifiedEpoch, type SequencePort } from "../src/rooms/wire.ts";
import { createBrokerAuth, decodeBrokerChallenge } from "../src/broker/protocol.ts";
import { startBroker, type BrokerPorts, type BrokerRuntime } from "../src/broker/server.ts";
import { FakeBrokerClient, packetObject } from "./fakes/broker-client.ts";

const text = new TextEncoder(), decode = new TextDecoder();
const roots: string[] = [], servers: BrokerRuntime[] = [], clients: FakeBrokerClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) client.close(); for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const member = (id: HubIdentity, label: string) => ({ ...id.public, label, exposedPeers: ["codex"] });
const sequence = (): SequencePort => { let seq = 0; return { reserve: async () => String(++seq), isCurrent: () => true }; };
async function setup(options: { limits?: { queuedPerRoom?: number }; ports?: BrokerPorts; stateDir?: string } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "ahub-broker-")); if (!options.stateDir) roots.push(stateDir);
  const server = await startBroker({ stateDir, port: 0, ...(options.limits ? { limits: options.limits } : {}) }, options.ports); servers.push(server);
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
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "one", f.seq)); await f.ownerClient.take("stored");
  f.ownerClient.send(await seal(f.epoch, f.owner, f.guest.public.fingerprint, "two", f.seq));
  expect(packetObject(await f.ownerClient.take("error")).code).toBe("queue_full"); expect(f.server.stats().queuedFrames).toBe(1);
  f.ownerClient.send(await seal(f.epoch, f.guest, f.owner.public.fingerprint, "forged socket sender"));
  expect((await f.ownerClient.closed).code).toBe(4403);
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
