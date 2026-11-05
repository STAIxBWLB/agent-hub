import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker } from "../src/broker/server.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands, RoomRotationHoldError } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { encodeRoomMessage, type RoomMessage } from "../src/rooms/application.ts";
import { decodeFrame, openFrame, roomMembers, sealFrame } from "../src/rooms/wire.ts";
import { encodeBase64url, sha256 } from "../src/rooms/crypto.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function signals() {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const wait = (check: () => boolean | Promise<boolean>, label: string): Promise<void> => new Promise((resolve, reject) => {
    let checking = false, again = false, done = false;
    const finish = (error?: unknown) => { if (done) return; done = true; clearTimeout(timer); listeners.delete(inspect); error ? reject(error) : resolve(); };
    const inspect = () => {
      if (done) return;
      if (checking) { again = true; return; }
      checking = true;
      void (async () => { do { again = false; if (await check()) return finish(); } while (again && !done); })()
        .catch(finish).finally(() => { checking = false; if (again && !done) inspect(); });
    };
    const timer = setTimeout(() => finish(new Error(`room rotation barrier timed out: ${label}`)), 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}
class LocalPeer extends BasePeer {
  got: Envelope[] = [];
  constructor() { super("codex"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string): Promise<void> {
    this.got.push(...envs); this.setState("busy");
    if (id) this.delivery({ id, state: "completed" });
    this.setState("idle");
  }
}
async function side(root: string, label: string, event: ReturnType<typeof signals>) {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: ["codex"] } } }));
  const journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  const roster = new Set(["codex"]); let chat!: RoomChat, store!: RoomStore;
  const bus = new Bus({ journal, batchMs: 0, rostered: id => roster.has(id), remotePending: room => chat.pendingIds(room), remotePrivate: () => false });
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  chat = new RoomChat({ bus, cwd, routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false,
    modelScreenOn: () => false, screen: async () => ({ label: "clear", ms: 0 }), policyVersion: () => 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); event.notify(); }, changed: event.notify });
  const bind = chat.bind.bind(chat); chat.bind = (value, name, link) => { store = value; bind(value, name, link); };
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const stateDir = join(cwd, "state"), commands = new RoomCommands({ cwd, stateDir, chat, presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  bus.onQueues = () => { chat.queueChanged(); event.notify(); };
  bus.tap(row => { if (row.t === "state" && !row.peer.includes("@")) commands.changed(); event.notify(); });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await commands.stop(); await peer.stop(); bus.closeJournal(); };
  return { label, cwd, stateDir, commands, chat, bus, journal, peer, close, get store() { return store; } };
}
type Side = Awaited<ReturnType<typeof side>>;
async function command(side: Side, action: string, input: unknown) { return (await side.commands.preview(action, input, () => true)).commit(); }
async function fixture(live = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-rotation-")), event = signals();
  const broker = live ? await startBroker({ stateDir: join(root, "broker"), port: 0 }) : undefined;
  const sides: Side[] = [], gates: ReturnType<typeof deferred>[] = [];
  cleanup.push(async () => { for (const gate of gates) gate.release(); for (const value of sides.reverse()) await value.close(); await broker?.stop(); rmSync(root, { recursive: true, force: true }); });
  const add = async (label: string) => { const value = await side(root, label, event); sides.push(value); return value; };
  const a = await add("alpha"), b = await add("beta");
  await command(a, "create", { name: "work", broker: broker?.publicUrl ?? "ws://127.0.0.1:1/", label: "alpha" });
  await command(a, "expose", { name: "work", peers: ["codex"] });
  const token = await command(a, "invite", { name: "work" });
  const request = await command(b, "join", { name: "work", token: token.artifact, label: "beta" });
  const roster = await command(a, "invite", { name: "work", request: request.artifact });
  await command(b, "join", { name: "work", roster: roster.artifact });
  if (live) await event.wait(() => a.bus.stateOf("codex@beta") === "idle" && b.bus.stateOf("codex@alpha") === "idle", "both room transports ready");
  const block = (receiver: Side) => {
    const gate = deferred(); gates.push(gate); const receive = receiver.chat.application.receive;
    receiver.chat.application.receive = async (context, input) => {
      if (input.message?.type === "chat") await gate.promise;
      await receive(context, input); event.notify();
    };
    return gate;
  };
  return { root, a, b, add, block, ...event };
}
async function sealed(sender: Side, recipient: Side, message: RoomMessage) {
  return sealFrame({ identity: sender.store.identity, epoch: sender.store.get("work")!.current,
    recipients: [recipient.store.identity.public.fingerprint], plaintext: encodeRoomMessage(message), sequence: sender.store.sequence });
}
async function queue(sender: Side, recipient: Side, body = "ROTATION-TEXT-CANARY") {
  const envelope = { id: crypto.randomUUID(), trace: crypto.randomUUID(), hop: 0, from: "codex", to: "codex", kind: "chat" as const, priority: "status" as const, body, ts: Date.now() };
  const wire = await sealed(sender, recipient, { v: 1, type: "chat", envelope });
  const outgoing = await sender.store.queueApplication("work", wire, { deliveryId: crypto.randomUUID(), application: envelope.id,
    remotePeer: `codex@${recipient.label}`, recipient: recipient.store.identity.public.fingerprint, peer: "codex", ackTimeoutMs: 600000, ttlMs: 86400000 });
  return { envelope, wire, outgoing };
}
async function settle(sender: Side, recipient: Side, queued: Awaited<ReturnType<typeof queue>>) {
  const wire = await sealed(recipient, sender, { v: 1, type: "receipt", frame: queued.outgoing.digest,
    application: queued.envelope.id, peer: "codex", outcome: "completed", reason: "admitted" });
  expect((await openFrame({ wire, identity: sender.store.identity, current: sender.store.get("work")!.current, replay: sender.store.replay })).status).toBe("accepted");
  return sender.store.applyApplicationReceipt("work", encodeBase64url(await sha256(wire)));
}
async function rotation(f: Awaited<ReturnType<typeof fixture>>, kind: "expose" | "revoke" | "invite") {
  if (kind === "expose") return f.a.commands.preview("expose", { name: "work", peers: ["codex"] }, () => true);
  if (kind === "revoke") return f.a.commands.preview("revoke", { name: "work", member: f.b.store.identity.public.fingerprint }, () => true);
  const c = await f.add("gamma"), token = await command(f.a, "invite", { name: "work" });
  const request = await command(c, "join", { name: "work", token: token.artifact, label: "gamma" });
  return f.a.commands.preview("invite", { name: "work", request: request.artifact }, () => true);
}

for (const kind of ["expose", "revoke", "invite"] as const) {
  test(`${kind} preview lists sorted IDs without text and refuses a new sealed intent before rotation`, async () => {
    const f = await fixture(), first = await queue(f.a, f.b), second = await queue(f.a, f.b);
    const before = f.a.store.get("work")!.current.digest, preview = await rotation(f, kind);
    expect(preview.outstanding).toEqual([first.outgoing.deliveryId, second.outgoing.deliveryId].sort());
    expect(JSON.stringify(preview)).not.toContain(first.envelope.body);
    expect(f.a.store.rotationPending("work")).toHaveLength(2);
    expect(f.a.store.get("work")!.current.digest).toBe(before);
    const fresh = await queue(f.a, f.b);
    await expect(preview.commit()).rejects.toThrow("state_changed");
    expect(f.a.store.get("work")!.current.digest).toBe(before);
    expect(f.a.store.rotationPending("work").map(row => row.deliveryId)).toEqual([first.outgoing.deliveryId, second.outgoing.deliveryId, fresh.outgoing.deliveryId]);
  });
  test(`${kind} preview refuses a signed receipt settling its captured pending ID set`, async () => {
    const f = await fixture(), queued = await queue(f.a, f.b), preview = await rotation(f, kind), before = f.a.store.get("work")!.current.digest;
    expect((await settle(f.a, f.b, queued))?.state).toBe("completed");
    await expect(preview.commit()).rejects.toThrow("state_changed");
    expect(f.a.store.get("work")!.current.digest).toBe(before);
    expect(f.a.store.applicationOutbox("work")[0]?.state).toBe("completed");
  });
}

test("join roster adoption binds the pending ID set as well as the existing epoch", async () => {
  const f = await fixture(), queued = await queue(f.b, f.a);
  const before = f.b.store.get("work")!.current.digest;
  // Seal the receipt before the owner advances its sequence/epoch fence.
  const receipt = await sealed(f.a, f.b, { v: 1, type: "receipt", frame: queued.outgoing.digest,
    application: queued.envelope.id, peer: "codex", outcome: "completed", reason: "admitted" });
  await command(f.a, "expose", { name: "work", peers: ["codex"] });
  const preview = await f.b.commands.preview("join", { name: "work", roster: encodeBase64url(f.a.store.get("work")!.wire) }, () => true);
  expect(preview.outstanding).toEqual([queued.outgoing.deliveryId]);
  expect((await openFrame({ wire: receipt, identity: f.b.store.identity, current: f.b.store.get("work")!.current, replay: f.b.store.replay })).status).toBe("accepted");
  expect(f.b.store.applyApplicationReceipt("work", encodeBase64url(await sha256(receipt)))?.state).toBe("completed");
  await expect(preview.commit()).rejects.toThrow("state_changed");
  expect(f.b.store.get("work")!.current.digest).toBe(before);
});

test("join roster adoption refuses a newly sealed intent after the preview", async () => {
  const f = await fixture();
  await command(f.a, "expose", { name: "work", peers: ["codex"] });
  const before = f.b.store.get("work")!.current.digest;
  const preview = await f.b.commands.preview("join", { name: "work", roster: encodeBase64url(f.a.store.get("work")!.wire) }, () => true);
  expect(preview.outstanding).toEqual([]);
  const fresh = await queue(f.b, f.a);
  await expect(preview.commit()).rejects.toThrow("state_changed");
  expect(f.b.store.get("work")!.current.digest).toBe(before);
  expect(f.b.store.rotationPending("work").map(row => row.deliveryId)).toEqual([fresh.outgoing.deliveryId]);
});

test("an owner preview refuses a changed epoch even when the pending set is still empty", async () => {
  const f = await fixture(), preview = await rotation(f, "expose");
  const state = f.a.store.get("work")!;
  await f.a.store.rotate("work", roomMembers(state.current), state.current.digest);
  const before = f.a.store.get("work")!.current.digest;
  await expect(preview.commit()).rejects.toThrow("state_changed");
  expect(f.a.store.get("work")!.current.digest).toBe(before);
});

test("Store same-epoch install preserves sendability; changed epoch fences only unresolved active intents", async () => {
  const f = await fixture(), active = await queue(f.a, f.b), accepted = await queue(f.a, f.b), terminal = await queue(f.a, f.b), disposed = await queue(f.a, f.b);
  f.a.store.markApplicationStored("work", accepted.outgoing.digest, decodeFrame(accepted.wire).seq);
  await settle(f.a, f.b, terminal);
  f.a.store.quarantineOutgoingPermanent("work", disposed.outgoing.deliveryId);
  f.a.store.disposeApplication("work", disposed.outgoing.deliveryId, "discard", true, () => true);
  const prior = f.a.store.get("work")!, terminalBefore = f.a.store.applicationOutbox("work").find(row => row.deliveryId === terminal.outgoing.deliveryId), disposedBefore = f.a.store.applicationOutbox("work").find(row => row.deliveryId === disposed.outgoing.deliveryId);
  await f.a.store.install({ name: "work", broker: prior.broker, wire: prior.wire, expectedDigest: prior.current.digest });
  for (const value of [active, accepted]) expect(f.a.store.applicationSendable("work", value.outgoing.digest)).toBe(true);
  await f.a.store.rotate("work", roomMembers(prior.current), prior.current.digest);
  for (const value of [active, accepted]) {
    const row = f.a.store.applicationOutbox("work").find(row => row.deliveryId === value.outgoing.deliveryId)!;
    expect(row.state).toBe("needs_review"); expect(row.reason).toBe("boundary_refused");
    expect(f.a.store.applicationSendable("work", value.outgoing.digest)).toBe(false);
    expect(f.a.store.outbox("work").some(row => row.digest === value.outgoing.digest)).toBe(false);
    expect(await f.a.store.outgoingMessage("work", value.envelope.id)).toBeUndefined();
  }
  expect(f.a.store.applicationOutbox("work").find(row => row.deliveryId === terminal.outgoing.deliveryId)).toEqual(terminalBefore);
  expect(f.a.store.applicationOutbox("work").find(row => row.deliveryId === disposed.outgoing.deliveryId)).toEqual(disposedBefore);
  await f.a.close();
  const reopened = await RoomStore.open({ stateDir: join(f.a.stateDir, "rooms") });
  cleanup.push(async () => { reopened.close(); });
  for (const value of [active, accepted]) {
    expect(reopened.applicationOutbox("work").find(row => row.deliveryId === value.outgoing.deliveryId)?.state).toBe("needs_review");
    expect(reopened.applicationSendable("work", value.outgoing.digest)).toBe(false);
    expect(reopened.outbox("work").some(row => row.digest === value.outgoing.digest)).toBe(false);
  }
});

for (const kind of ["expose", "revoke", "invite"] as const) {
  test(`real ${kind} rotation holds the sealed journal row and leaves Bus-only work queued`, async () => {
    const f = await fixture(true), gate = f.block(f.b);
    const sent = newEnvelope("user", "ROTATION-LIVE-TEXT-CANARY", { to: ["codex@beta"] });
    f.a.bus.publish(sent);
    await f.wait(() => f.a.store.rotationPending("work").some(row => row.application === sent.id && row.state === "accepted"), "sealed send accepted by broker before rotation");
    const old = f.a.store.rotationPending("work").find(row => row.application === sent.id)!;
    const fresh = newEnvelope("user", "queued after sealed send", { to: ["codex@beta"] });
    f.a.bus.publish(fresh);
    expect(f.a.bus.queueIds("codex@beta")).toContain(fresh.id);
    const preview = await rotation(f, kind);
    expect(preview.outstanding).toEqual([old.deliveryId]);
    expect(JSON.stringify(preview)).not.toContain(sent.body);
    await preview.commit();
    const journal = f.a.journal.get(old.deliveryId)!;
    expect(journal.state).toBe("needs_review");
    expect(journal.reason).toBe(`room epoch rotated; inspect ahub queue show ${old.deliveryId}`);
    expect(f.a.chat.rows("work").find(row => row.id === old.deliveryId)?.holdReason).toBe("epoch rotated");
    expect(f.a.store.applicationOutbox("work").find(row => row.deliveryId === old.deliveryId)?.state).toBe("needs_review");
    expect(f.a.store.outbox("work").some(row => row.digest === old.digest)).toBe(false);
    expect(f.a.bus.queueIds("codex@beta")).toContain(fresh.id);
    expect(f.a.store.applicationOutbox("work").some(row => row.application === fresh.id)).toBe(false);
    gate.release();
    // An explicit scheduler pass and a clean sender restart must retain the hold,
    // including its operator-facing cause, instead of resealing the old intent.
    f.a.chat.tick();
    const snapshot = f.a.bus.snapshot();
    await f.a.close();
    const restarted = await side(f.root, "alpha", { notify: f.notify, wait: f.wait });
    cleanup.push(restarted.close);
    restarted.bus.restore(snapshot); await restarted.commands.start();
    expect(restarted.journal.get(old.deliveryId)?.state).toBe("needs_review");
    expect(restarted.chat.rows("work").find(row => row.id === old.deliveryId)?.holdReason).toBe("epoch rotated");
    expect(restarted.store.applicationSendable("work", old.digest)).toBe(false);
    expect(await restarted.store.outgoingMessage("work", sent.id)).toBeUndefined();
    expect(f.b.peer.got.filter(row => row.id === sent.id).length).toBeLessThanOrEqual(1);
  });
}

test("an empty live rotation fences every room peer before a Bus-only message can dispatch", async () => {
  const f = await fixture(true);
  await f.wait(() => f.a.bus.peers.get("codex@beta")?.state === "idle", "fresh peer ready before empty rotation");
  const fresh = newEnvelope("user", "Bus-only work at the epoch boundary", { to: ["codex@beta"] });
  f.a.bus.pause("codex@beta");
  f.a.bus.publish(fresh);
  const preview = await rotation(f, "expose");
  expect(preview.outstanding).toEqual([]);
  const epochRotated = f.a.chat.epochRotated.bind(f.a.chat);
  let inspected = false;
  f.a.chat.epochRotated = (...args) => {
    const held = epochRotated(...args);
    expect(f.a.bus.peers.get("codex@beta")?.state).toBe("offline");
    expect(f.a.bus.queueIds("codex@beta")).toEqual([fresh.id]);
    expect(f.a.store.applicationOutbox("work").some(row => row.application === fresh.id)).toBe(false);
    inspected = true;
    return held;
  };
  const previous = f.a.store.get("work")!.current.digest;
  await preview.commit();
  expect(inspected).toBe(true);
  expect(f.a.store.get("work")!.current.digest).not.toBe(previous);
  expect(f.a.bus.queueIds("codex@beta")).toEqual([fresh.id]);
  await command(f.b, "join", { name: "work", roster: encodeBase64url(f.a.store.get("work")!.wire) });
  f.a.bus.resume("codex@beta");
  await f.wait(() => f.b.peer.got.some(row => row.id === fresh.id), "Bus-only work delivered under the new epoch");
  expect(f.b.peer.got.filter(row => row.id === fresh.id)).toHaveLength(1);
});

test("a committed rotation with unavailable journal holds fails closed with the distinct error", async () => {
  const f = await fixture(true), gate = f.block(f.b), env = newEnvelope("user", "journal failure rotation", { to: ["codex@beta"] });
  f.a.bus.publish(env);
  await f.wait(() => f.a.store.rotationPending("work").some(row => row.application === env.id && row.state === "accepted"), "durable intent before journal outage");
  const old = f.a.store.rotationPending("work")[0]!, before = f.a.store.get("work")!.current.digest;
  const preview = await rotation(f, "expose"); f.a.bus.storageError = "fixture unavailable journal";
  await expect(preview.commit()).rejects.toBeInstanceOf(RoomRotationHoldError);
  expect(f.a.store.get("work")!.current.digest).not.toBe(before);
  expect(f.a.store.applicationOutbox("work").find(row => row.deliveryId === old.deliveryId)?.state).toBe("needs_review");
  expect(f.a.store.applicationSendable("work", old.digest)).toBe(false);
  expect(await f.a.store.outgoingMessage("work", env.id)).toBeUndefined();
  gate.release(); f.a.chat.tick();
  expect(f.a.store.outbox("work").some(row => row.digest === old.digest)).toBe(false);
});
