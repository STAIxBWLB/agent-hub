import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { canonicalBytes, createInvite, createJoin, createRoomEpoch, roomMembers, sealFrame, openFrame, type SequencePort } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, randomBytes, sha256 } from "../src/rooms/crypto.ts";
import { FakeBrokerClient } from "./fakes/broker-client.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { RoomLink, type RoomLinkState, type RoomPresencePeer } from "../src/rooms/link.ts";

const clients: FakeBrokerClient[] = [];
const roots: string[] = [], stores: RoomStore[] = [], links: RoomLink[] = [], brokers: BrokerRuntime[] = [], fakes: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  for (const client of clients.splice(0)) client.close();
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const fake of fakes.splice(0)) await fake.stop(true);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room link test barrier timed out")), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function storeAt(root: string, name: string) {
  const store = await RoomStore.open({ stateDir: join(root, name) }); stores.push(store); return store;
}
async function fixture(brokerOffsetMs = 0) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-link-")); roots.push(root);
  const owner = await storeAt(root, "owner"), guest = await storeAt(root, "guest");
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0, owners: [owner.identity.public.fingerprint] }, { clock: () => Date.now() + brokerOffsetMs }); brokers.push(broker);
  const created = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: ["codex"] }] });
  await owner.install({ name: "test", broker: broker.publicUrl, wire: created.wire, expectedDigest: null });
  const invite = await createInvite({ epoch: created.epoch, owner: owner.identity, broker: broker.publicUrl, expiresAt: Date.now() + 60_000 });
  await owner.saveInvite("test", invite);
  const request = await createJoin({ invite, identity: guest.identity, label: "guest", exposedPeers: ["kimi"] });
  guest.savePendingJoin("test", { invite, request });
  const joined = await owner.enroll("test", request);
  await guest.install({ name: "test", broker: broker.publicUrl, wire: joined.wire, expectedDigest: null });
  return { root, owner, guest, broker };
}
function linked(store: RoomStore, extra: { presence?: () => readonly { id: string; state: string }[]; onPresence?: (value: { member: string; peers: readonly RoomPresencePeer[] }) => void } = {}) {
  const online = deferred(), offline = deferred(), states: RoomLinkState[] = [];
  const link = new RoomLink({ store, name: "test", ...extra, onState: state => { states.push(state); if (state === "online") online.resolve(); if (state === "offline") offline.resolve(); } });
  links.push(link);
  return { link, states, online: () => bounded(online.promise), offline: () => bounded(offline.promise) };
}

test("outbound room links bootstrap the owner and exchange only exposed signed presence", async () => {
  const f = await fixture(), seen = deferred<{ member: string; peers: readonly RoomPresencePeer[] }>();
  const owner = linked(f.owner, { presence: () => [{ id: "codex", state: "busy" }, { id: "unexposed", state: "idle" }] });
  const guest = linked(f.guest, { onPresence: value => { if (value.member === f.owner.identity.public.fingerprint) seen.resolve(value); } });
  await owner.link.start(); await owner.online();
  await guest.link.start(); await guest.online();
  const value = await bounded(seen.promise);
  expect(value).toEqual({ member: f.owner.identity.public.fingerprint, peers: [{ id: "codex", state: "busy" }] });
  expect(owner.link.status()).toEqual({ state: "online", members: 2 });
  expect(guest.link.status()).toEqual({ state: "online", members: 2 });
  expect(JSON.stringify(guest.link.status())).not.toContain("codex");
  expect(f.guest.pendingInbox("test")).toEqual([]);
});

test("an offline owner rotation publishes the newer pin and revokes the guest without rolling back local state", async () => {
  const f = await fixture(), owner = linked(f.owner), guest = linked(f.guest);
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online();
  const before = f.owner.get("test")!, guestDigest = f.guest.get("test")!.current.digest;
  const next = await f.owner.rotate("test", roomMembers(before.current).filter(member => member.fingerprint !== f.guest.identity.public.fingerprint), before.current.digest);
  owner.link.refresh();
  await guest.offline();
  expect(f.owner.get("test")!.current.digest).toBe(next.current.digest);
  expect(f.guest.get("test")!.current.digest).toBe(guestDigest);
  expect(guest.link.status().state).toBe("offline");
  expect(f.broker.stats().authenticated).toBe(1);
});

test("stopping the room link preserves membership and prevents a subsequent refresh from reconnecting", async () => {
  const f = await fixture(), owner = linked(f.owner);
  await owner.link.start(); await owner.online();
  const digest = f.owner.get("test")!.current.digest;
  owner.link.stop(); owner.link.refresh();
  expect(owner.link.status()).toEqual({ state: "offline", members: 2 });
  expect(f.owner.get("test")!.left).toBe(false);
  expect(f.owner.get("test")!.current.digest).toBe(digest);
});

test("a room marked left never opens its outbound link", async () => {
  const f = await fixture(); f.owner.leave("test");
  const owner = linked(f.owner); await owner.link.start();
  expect(owner.link.status()).toEqual({ state: "offline", members: 0 });
  expect(f.broker.stats().connections).toBe(0);
});

test("a hostile broker challenge cannot redirect an identity proof to another audience", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-link-mitm-")); roots.push(root);
  const owner = await storeAt(root, "owner"), refused = deferred();
  const created = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: [] }] });
  const sent: unknown[] = [];
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { ws.send(canonicalBytes({ v: 1, type: "challenge", room: created.epoch.room, broker: "wss://different.example/", nonce: encodeBase64url(randomBytes(32)), expiresAt: Date.now() + 10_000, rosterDigest: null })); },
      message(_ws, data) { sent.push(data); }, close() { refused.resolve(); },
    },
  }); fakes.push(fake);
  await owner.install({ name: "test", broker: `ws://127.0.0.1:${fake.port}/`, wire: created.wire, expectedDigest: null });
  const link = linked(owner); await link.link.start(); await bounded(refused.promise);
  expect(sent).toEqual([]); expect(owner.get("test")!.current.digest).toBe(created.epoch.digest);
});

test("a broker cannot install a substituted owner roster after a valid membership challenge", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-link-roster-")); roots.push(root);
  const owner = await storeAt(root, "owner"), stranger = await generateHubIdentity(), refused = deferred();
  const created = await createRoomEpoch({ owner: owner.identity, members: [{ ...owner.identity.public, label: "owner", exposedPeers: [] }] });
  const forged = await createRoomEpoch({ owner: stranger, members: [{ ...stranger.public, label: "stranger", exposedPeers: [] }] });
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { ws.send(canonicalBytes({ v: 1, type: "challenge", room: created.epoch.room, broker: `ws://127.0.0.1:${fake.port}/`, nonce: encodeBase64url(randomBytes(32)), expiresAt: Date.now() + 10_000, rosterDigest: created.epoch.digest })); },
      message(ws) { ws.send(forged.wire); }, close() { refused.resolve(); },
    },
  }); fakes.push(fake);
  await owner.install({ name: "test", broker: `ws://127.0.0.1:${fake.port}/`, wire: created.wire, expectedDigest: null });
  const link = linked(owner); await link.link.start(); await bounded(refused.promise);
  expect(owner.get("test")!.current.digest).toBe(created.epoch.digest);
  expect(link.link.status().state).toBe("offline");
});


test("a refused signed presence is durably retired so later valid broker traffic is delivered", async () => {
  const f = await fixture(), delivered = deferred(); let observed = 0;
  const owner = linked(f.owner, { onPresence: value => { if (value.member === f.guest.identity.public.fingerprint) { observed++; delivered.resolve(); } } });
  await owner.link.start(); await owner.online();
  const row = f.guest.get("test")!;
  const guest = await FakeBrokerClient.connect(f.broker.publicUrl, row.current.room); clients.push(guest);
  await guest.authenticate(f.guest.identity);
  const wire = await sealFrame({ epoch: row.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "unexposed", state: "busy" }] }), sequence: f.guest.sequence });
  const digest = encodeBase64url(await sha256(wire));
  guest.send(wire); await guest.take("stored");
  const valid = await sealFrame({ epoch: row.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state: "idle" }] }), sequence: f.guest.sequence });
  guest.send(valid); await guest.take("stored"); await bounded(delivered.promise);
  expect(observed).toBe(1);
  expect(owner.link.status().state).toBe("online");
  expect(f.owner.pendingInbox("test")).toEqual([]);
  expect(f.owner.refused("test").map(({ digest, reason }) => ({ digest, reason }))).toEqual([{ digest, reason: "invalid_presence" }]);
  expect(JSON.stringify(f.owner.refused("test"))).not.toContain("unexposed");
  owner.link.stop(); f.owner.close();
  const restored = await storeAt(f.root, "owner");
  expect(restored.refused("test").map(({ digest, reason }) => ({ digest, reason }))).toEqual([{ digest, reason: "invalid_presence" }]);
});


test("broker challenge authentication accepts independent host clocks in either direction", async () => {
  for (const offset of [-60_000, 60_000]) {
    const f = await fixture(offset), owner = linked(f.owner), guest = linked(f.guest);
    await owner.link.start(); await owner.online();
    await guest.link.start(); await guest.online();
    expect(owner.link.status().state).toBe("online");
    expect(guest.link.status().state).toBe("online");
    owner.link.stop(); guest.link.stop();
  }
});

test("a presence exposure removed while encryption waits is withheld before the socket send", async () => {
  const f = await fixture(), initial = deferred(), final = deferred(), entered = deferred(), release = deferred();
  let exposed = false, empty = 0;
  const observations: (readonly RoomPresencePeer[])[] = [];
  const owner = linked(f.owner, { presence: () => exposed ? [{ id: "codex", state: "busy" }] : [] });
  const guest = linked(f.guest, { onPresence: value => {
    if (value.member !== f.owner.identity.public.fingerprint) return;
    observations.push(value.peers);
    if (value.peers.length === 0) { if (++empty === 1) initial.resolve(); else final.resolve(); }
  } });
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online(); await bounded(initial.promise);
  const reserve = f.owner.sequence.reserve;
  f.owner.sequence.reserve = async input => { const seq = await reserve(input); entered.resolve(); await release.promise; return seq; };
  try {
    exposed = true;
    const publishing = owner.link.publishPresence();
    await bounded(entered.promise);
    exposed = false;
    await owner.link.publishPresence(); // Coalesced while the prior snapshot still awaits encryption.
    release.resolve();
    await publishing;
    await bounded(final.promise);
    expect(observations.every(peers => peers.length === 0)).toBe(true);
  } finally { release.resolve(); f.owner.sequence.reserve = reserve; }
});

test("recovery discards and settles presence whose exposed id was removed by a later epoch", async () => {
  const f = await fixture(), before = f.owner.get("test")!, recipient = f.guest.get("test")!;
  const wire = await sealFrame({ epoch: before.current, identity: f.owner.identity, recipients: [f.guest.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "codex", state: "busy" }] }), sequence: f.owner.sequence });
  expect((await openFrame({ wire, identity: f.guest.identity, current: recipient.current, replay: f.guest.replay })).status).toBe("accepted");
  expect(f.guest.pendingInbox("test").length).toBe(1);
  const rotated = await f.owner.rotate("test", roomMembers(before.current).map(member => member.fingerprint === f.owner.identity.public.fingerprint ? { ...member, exposedPeers: [] } : member), before.current.digest);
  await f.guest.install({ name: "test", broker: rotated.broker, wire: rotated.wire, expectedDigest: recipient.current.digest });
  const observations: (readonly RoomPresencePeer[])[] = [];
  const owner = linked(f.owner), guest = linked(f.guest, { onPresence: value => { observations.push(value.peers); } });
  await owner.link.start(); await owner.online(); await guest.link.start(); await guest.online();
  expect(guest.link.status().state).toBe("online");
  expect(f.guest.pendingInbox("test")).toEqual([]);
  expect(observations.every(peers => peers.every(peer => peer.id !== "codex"))).toBe(true);
});


test("a stale valid sequence and an exact replay cannot poison a later presence in the broker queue", async () => {
  const f = await fixture(), recipient = f.owner.get("test")!, sender = f.guest.get("test")!;
  const frames: Uint8Array[] = [];
  for (const state of ["idle", "busy", "paused"]) frames.push(await sealFrame({ epoch: sender.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state }] }), sequence: f.guest.sequence }));
  expect((await openFrame({ wire: frames[1]!, identity: f.owner.identity, current: recipient.current, replay: f.owner.replay })).status).toBe("accepted");
  f.owner.settleInbox("test", encodeBase64url(await sha256(frames[1]!)));
  const delivered = deferred(), seen: (readonly RoomPresencePeer[])[] = [];
  const owner = linked(f.owner, { onPresence: value => { if (value.member === f.guest.identity.public.fingerprint) { seen.push(value.peers); delivered.resolve(); } } });
  await owner.link.start(); await owner.online();
  const guest = await FakeBrokerClient.connect(f.broker.publicUrl, sender.current.room); clients.push(guest); await guest.authenticate(f.guest.identity);
  for (const wire of frames) { guest.send(wire); await guest.take("stored"); }
  await bounded(delivered.promise);
  expect(seen).toEqual([[{ id: "kimi", state: "paused" }]]);
  expect(owner.link.status().state).toBe("online");
  expect(f.owner.pendingInbox("test")).toEqual([]);
  expect(f.owner.refused("test").map(({ digest, reason }) => ({ digest, reason }))).toEqual([{ digest: encodeBase64url(await sha256(frames[0]!)), reason: "stale" }]);
});

test("a broker's expired previous epoch and wrong epoch frames retire durably before its valid later frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-link-expired-")); roots.push(root);
  let now = Date.now() - 120_000;
  const owner = await RoomStore.open({ stateDir: join(root, "owner"), clock: () => now }); stores.push(owner);
  const guest = await generateHubIdentity(), delivered = deferred(), retired: string[] = [];
  const queued: Uint8Array[] = [];
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { const row = owner.get("test")!; ws.send(canonicalBytes({ v: 1, type: "challenge", room: row.current.room, broker: row.broker, nonce: encodeBase64url(randomBytes(32)), expiresAt: Date.now() + 10_000, rosterDigest: row.current.digest })); },
      message(ws, data) {
        const input = JSON.parse(new TextDecoder().decode(typeof data === "string" ? new TextEncoder().encode(data) : data)) as { type: string; digest?: string };
        const row = owner.get("test")!;
        if (input.type === "auth") { ws.send(row.wire); ws.send(canonicalBytes({ v: 1, type: "ready", room: row.current.room, member: owner.identity.public.fingerprint, epoch: row.current.epoch, digest: row.current.digest })); }
        else if (input.type === "roster_ready") { const wire = queued.shift(); if (wire) ws.send(wire); }
        else if (input.type === "received") { retired.push(input.digest!); ws.send(canonicalBytes({ v: 1, type: "queue_ack", digest: input.digest })); const wire = queued.shift(); if (wire) ws.send(wire); }
      },
    },
  }); fakes.push(fake);
  const broker = `ws://127.0.0.1:${fake.port}/`, members = [{ ...owner.identity.public, label: "owner", exposedPeers: [] }, { ...guest.public, label: "guest", exposedPeers: ["kimi"] }];
  const initial = await createRoomEpoch({ owner: owner.identity, members });
  await owner.install({ name: "test", broker, wire: initial.wire, expectedDigest: null });
  let seq = 0; const sequence: SequencePort = { reserve: async () => String(++seq), isCurrent: () => true };
  const payload = canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state: "idle" }] });
  const expired = await sealFrame({ epoch: initial.epoch, identity: guest, recipients: [owner.identity.public.fingerprint], plaintext: payload, sequence });
  const current = await owner.rotate("test", members, initial.epoch.digest);
  const future = await createRoomEpoch({ owner: owner.identity, members, previous: current.current });
  const wrong = await sealFrame({ epoch: future.epoch, identity: guest, recipients: [owner.identity.public.fingerprint], plaintext: payload, sequence });
  const valid = await sealFrame({ epoch: current.current, identity: guest, recipients: [owner.identity.public.fingerprint], plaintext: payload, sequence });
  queued.push(expired, wrong, valid); now = Date.now();
  const observed: (readonly RoomPresencePeer[])[] = [];
  const link = linked(owner, { onPresence: value => { observed.push(value.peers); delivered.resolve(); } });
  await link.link.start(); await link.online(); await bounded(delivered.promise);
  expect(observed).toEqual([[{ id: "kimi", state: "idle" }]]);
  expect(link.link.status().state).toBe("online");
  const digests = await Promise.all([expired, wrong].map(async wire => encodeBase64url(await sha256(wire))));
  expect(retired.slice(0, 2)).toEqual(digests);
  expect(owner.refused("test").map(({ digest, reason }) => ({ digest, reason }))).toEqual(digests.map(digest => ({ digest, reason: "wrong_epoch" })));
});

test("a failed durable refusal write retains the broker packet without transport ACK", async () => {
  const f = await fixture(), owner = linked(f.owner);
  await owner.link.start(); await owner.online();
  const row = f.guest.get("test")!, guest = await FakeBrokerClient.connect(f.broker.publicUrl, row.current.room); clients.push(guest);
  await guest.authenticate(f.guest.identity);
  const initial = await guest.take("frame"); await guest.ack(encodeBase64url(await sha256(initial)));
  expect(f.broker.stats().queuedFrames).toBe(0);
  const record = f.owner.recordRefused;
  f.owner.recordRefused = () => { throw new Error("fixture storage unavailable"); };
  try {
    const wire = await sealFrame({ epoch: row.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "unexposed", state: "busy" }] }), sequence: f.guest.sequence });
    guest.send(wire); await guest.take("stored"); await owner.offline();
    expect(f.broker.stats().queuedFrames).toBe(1);
    expect(f.owner.refused("test")).toEqual([]);
    expect(f.owner.pendingInbox("test")).toEqual([]);
  } finally { f.owner.recordRefused = record; }
});


test("a new local epoch cannot publish ciphertext before that socket verifies the same roster", async () => {
  const f = await fixture(), owner = linked(f.owner); await owner.link.start(); await owner.online();
  const guest = await FakeBrokerClient.connect(f.broker.publicUrl, f.guest.get("test")!.current.room); clients.push(guest); await guest.authenticate(f.guest.identity);
  const initial = await guest.take("frame"); await guest.ack(encodeBase64url(await sha256(initial)));
  const before = f.owner.get("test")!;
  await f.owner.rotate("test", roomMembers(before.current).filter(member => member.fingerprint !== f.guest.identity.public.fingerprint), before.current.digest);
  let reserved = 0; const reserve = f.owner.sequence.reserve;
  f.owner.sequence.reserve = async input => { reserved++; return reserve(input); };
  try { await owner.link.publishPresence(); expect(reserved).toBe(0); }
  finally { f.owner.sequence.reserve = reserve; }
});

test("a runtime capacity metadata failure cannot become a safe presence drop or transport ACK", async () => {
  const f = await fixture(), owner = linked(f.owner); await owner.link.start(); await owner.online();
  const row = f.guest.get("test")!, guest = await FakeBrokerClient.connect(f.broker.publicUrl, row.current.room); clients.push(guest); await guest.authenticate(f.guest.identity);
  const initial = await guest.take("frame"); await guest.ack(encodeBase64url(await sha256(initial)));
  const available = f.owner.ordinaryInboxAvailable;
  f.owner.ordinaryInboxAvailable = () => { throw new Error("fixture metadata read failed"); };
  try {
    const wire = await sealFrame({ epoch: row.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state: "idle" }] }), sequence: f.guest.sequence });
    guest.send(wire); await guest.take("stored"); await owner.offline();
    expect(f.broker.stats().queuedFrames).toBe(1); expect(f.owner.refused("test")).toEqual([]); expect(f.owner.pendingInbox("test")).toEqual([]);
  } finally { f.owner.ordinaryInboxAvailable = available; }
});

/** A real signed old-epoch frame, with broker handshake controls gated independently. */
async function ownerUpgradeBroker(mode: "one" | "two" | "before-ready") {
  const f = await fixture(), before = f.owner.get("test")!;
  const wire = await sealFrame({ epoch: before.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "kimi", state: "idle" }] }), sequence: f.guest.sequence });
  const digest = encodeBase64url(await sha256(wire));
  const next = await f.owner.rotate("test", roomMembers(before.current), before.current.digest);
  await f.broker.stop();
  const reached = deferred(), closed = deferred(), admitted = deferred(), acknowledged = deferred(), online = deferred();
  const acks: string[] = [], observations: unknown[] = [];
  let replayCalls = 0, release: (() => void) | undefined;
  const accept = f.owner.replay.accept;
  f.owner.replay.accept = async input => { replayCalls++; return accept(input); };
  const fake = Bun.serve({ hostname: "127.0.0.1", port: f.broker.port,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { ws.send(canonicalBytes({ v: 1, type: "challenge", room: before.current.room, broker: f.broker.publicUrl, nonce: encodeBase64url(randomBytes(32)), expiresAt: Date.now() + 10_000, rosterDigest: before.current.digest })); },
      message(ws, data) {
        const row = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<string, unknown>;
        if (row.type === "auth") {
          if (mode === "before-ready") { ws.send(wire); return; }
          ws.send(before.wire);
        } else if (row.type === "roster_ready" && row.digest === before.current.digest) {
          ws.send(canonicalBytes({ v: 1, type: "ready", room: before.current.room, member: f.owner.identity.public.fingerprint, epoch: before.current.epoch, digest: before.current.digest }));
        } else if (row.type === "roster") {
          ws.send(wire);
          if (mode === "two") ws.send(wire);
          // This control can pass the held ciphertext. Its host callback is the
          // barrier proving the preceding frame was handled, not merely sent.
          ws.send(canonicalBytes({ v: 1, type: "stored", digest, seq: "1", duplicate: false }));
          release = () => {
            ws.send(next.wire);
            ws.send(canonicalBytes({ v: 1, type: "ready", room: next.current.room, member: f.owner.identity.public.fingerprint, epoch: next.current.epoch, digest: next.current.digest }));
          };
        } else if (row.type === "received") {
          acks.push(String(row.digest)); if (row.digest === digest) acknowledged.resolve();
        }
      },
      close() { closed.resolve(); },
    },
  }); fakes.push(fake);
  const link = new RoomLink({ store: f.owner, name: "test",
    onState: state => { if (state === "online") online.resolve(); },
    onPresence: value => { observations.push(value); admitted.resolve(); },
    application: { members() {}, async receive() {}, async online() {}, stored() { reached.resolve(); } },
  }); links.push(link);
  return { f, link, digest, acks, observations, replayCalls: () => replayCalls,
    reached: () => bounded(reached.promise), closed: () => bounded(closed.promise), online: () => bounded(online.promise),
    admitted: () => bounded(admitted.promise), acknowledged: () => bounded(acknowledged.promise),
    release() { if (!release) throw new Error("upgrade control barrier not reached"); release(); },
  };
}

test("a verified owner upgrade holds one old ciphertext without replay, plaintext or ACK until the new ready", async () => {
  const f = await ownerUpgradeBroker("one"); await f.link.start(); await f.reached();
  expect(f.link.status().state).toBe("connecting");
  expect(f.replayCalls()).toBe(0); expect(f.observations).toEqual([]); expect(f.acks).toEqual([]);
  expect(f.f.owner.pendingInbox("test")).toEqual([]); expect(f.f.owner.refused("test")).toEqual([]);
  f.release(); await f.online(); await f.admitted(); await f.acknowledged();
  expect(f.replayCalls()).toBe(1);
  expect(f.observations).toEqual([{ member: f.f.guest.identity.public.fingerprint, peers: [{ id: "kimi", state: "idle" }] }]);
  expect(f.acks).toEqual([f.digest]);
});

for (const mode of ["before-ready", "two"] as const) {
  test(`owner upgrade deferral refuses ${mode === "two" ? "a second in-flight ciphertext" : "a generic pre-handshake ciphertext"} without replay or ACK`, async () => {
    const f = await ownerUpgradeBroker(mode); await f.link.start(); await f.closed(); f.link.stop();
    expect(f.replayCalls()).toBe(0); expect(f.observations).toEqual([]); expect(f.acks).toEqual([]);
    expect(f.f.owner.pendingInbox("test")).toEqual([]); expect(f.f.owner.refused("test")).toEqual([]);
  });
}
