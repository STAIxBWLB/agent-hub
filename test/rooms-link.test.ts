import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { canonicalBytes, createInvite, createJoin, createRoomEpoch, roomMembers, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, generateHubIdentity, randomBytes } from "../src/rooms/crypto.ts";
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
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-link-")); roots.push(root);
  const owner = await storeAt(root, "owner"), guest = await storeAt(root, "guest");
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0, owners: [owner.identity.public.fingerprint] }); brokers.push(broker);
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


test("a signed presence naming an unexposed peer is refused before replay-inbox commit or observation", async () => {
  const f = await fixture(); let observed = 0;
  const owner = linked(f.owner, { onPresence: () => { observed++; } });
  await owner.link.start(); await owner.online();
  const row = f.guest.get("test")!;
  const guest = await FakeBrokerClient.connect(f.broker.publicUrl, row.current.room); clients.push(guest);
  await guest.authenticate(f.guest.identity);
  const wire = await sealFrame({ epoch: row.current, identity: f.guest.identity, recipients: [f.owner.identity.public.fingerprint], plaintext: canonicalBytes({ v: 1, type: "presence", peers: [{ id: "unexposed", state: "busy" }] }), sequence: f.guest.sequence });
  guest.send(wire); await guest.take("stored"); await owner.offline();
  expect(observed).toBe(0);
  expect(f.owner.pendingInbox("test")).toEqual([]);
});
