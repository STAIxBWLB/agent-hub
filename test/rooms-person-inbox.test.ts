import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, type BrokerRuntime } from "../src/broker/server.ts";
import { Bus, type BusEvent } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { encodeBase64url } from "../src/rooms/crypto.ts";
import { canonicalBytes } from "../src/rooms/wire.ts";
import { decodeRoomMessage, encodeRoomMessage, RoomApplicationError, type RoomChatEnvelope, type RoomMessage } from "../src/rooms/application.ts";
import type { RoomLinkContext } from "../src/rooms/link.ts";
import type { PiiVerdict } from "../src/hub/inference.ts";

const PERSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 64 * 1024;

class LocalPeer extends BasePeer {
  got: Envelope[] = [];
  private releaseTurn?: () => void;
  private turn?: Promise<void>;
  constructor() { super("codex"); }
  async deliver(envs: Envelope[], id?: string): Promise<void> {
    this.got.push(...envs); this.setState("busy");
    if (id) this.delivery({ id, state: "accepted" });
    this.turn = Promise.resolve(); await this.turn;
    if (id) this.delivery({ id, state: "completed" });
    this.setState("idle");
  }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.releaseTurn?.(); await this.turn; this.setState("offline"); }
}

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
        .catch(finish).finally(() => { checking = false; });
    };
    const timer = setTimeout(() => finish(new Error(`person inbox barrier timed out: ${label}`)), 5000);
    listeners.add(inspect); inspect();
  });
  return { notify, wait };
}

type CapturedChat = { context: RoomLinkContext; digest: string; sender: string; message: Extract<RoomMessage, { type: "chat" }> };
type Side = Awaited<ReturnType<typeof side>>;
type SideOptions = { now?: () => number; screen?: (body: string) => Promise<PiiVerdict>; beforeReceive?: () => Promise<void> };
async function side(root: string, label: string, notify: ReturnType<typeof signals>, options: SideOptions = {}) {
  const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: ["codex"] } } }));
  const stateDir = join(cwd, "state"), events: BusEvent[] = [], condensed: Envelope[][] = [], memory: unknown[] = [];
  const roster = new Set(["codex"]), journal = new DeliveryJournal({ file: join(cwd, "hub.db"), projectRoot: cwd, projectId: label, instanceId: crypto.randomUUID() });
  let chat: RoomChat | undefined;
  const bus = new Bus({ journal, batchMs: 0, retryMs: 10, queueCap: 300, rostered: id => roster.has(id), remotePending: room => chat?.pendingIds(room) ?? [], remotePrivate: () => false,
    condense: async envs => { condensed.push(envs); return envs; } });
  const routing = parseRouting('[local]\nfixed_model="fixture"\n');
  let screenCalls = 0;
  chat = new RoomChat({ bus, cwd, ...(options.now ? { now: options.now } : {}), routing: () => routing, piiPaths: () => [], senderPrivate: () => false, taskPrivate: () => false,
    modelScreenOn: () => true, screen: options.screen ?? (async () => { screenCalls++; return { label: "clear", ms: 0 }; }), policyVersion: () => 1,
    roster: ids => { roster.clear(); roster.add("codex"); for (const id of ids) roster.add(id); notify.notify(); }, changed: notify.notify });
  let context: RoomLinkContext | undefined, lastChat: CapturedChat | undefined;
  const members = chat.application.members, receive = chat.application.receive;
  chat.application.members = value => { context = value; members(value); };
  chat.application.receive = async (value, input) => {
    if (input.message?.type === "chat") {
      lastChat = { context: value, digest: input.digest, sender: input.sender, message: input.message };
      notify.notify();
      await options.beforeReceive?.();
    }
    await receive(value, input);
  };
  const peer = new LocalPeer(); bus.add(peer); await peer.start();
  const commands = new RoomCommands({ cwd, stateDir, ...(options.now ? { clock: options.now } : {}), chat, presence: () => [{ id: "codex", state: bus.stateOf("codex") }] });
  bus.onQueues = () => { chat!.queueChanged(); notify.notify(); };
  bus.onMemoryDelivery = (...args) => memory.push(args);
  bus.tap(event => { events.push(event); notify.notify(); });
  const close = async () => { commands.stop(); await peer.stop(); bus.closeJournal(); };
  return { cwd, stateDir, journal, bus, peer, commands, chat, events, condensed, memory, close, get context() { return context; }, get lastChat() { return lastChat; }, get screenCalls() { return screenCalls; }, signals: notify };
}

async function command(side: Side, action: string, input: unknown) { return (await side.commands.preview(action, input, () => true)).commit(); }
async function deliveries(side: Side): Promise<Record<string, unknown>[]> { return ((await side.commands.rows("work"))[0]?.deliveries ?? []) as Record<string, unknown>[]; }
type MeshOptions = SideOptions & { holdFirstA?: () => Promise<void> };
const meshes: { root: string; broker: BrokerRuntime; a: Side; b: Side }[] = [];
afterEach(async () => { for (const f of meshes.splice(0).reverse()) { await f.a.close(); await f.b.close(); await f.broker.stop(); rmSync(f.root, { recursive: true, force: true }); } });
async function mesh(options: MeshOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-person-inbox-")), notify = signals();
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0 });
  let holdFirstA = options.holdFirstA;
  const a = await side(root, "alpha", notify, { now: options.now, screen: options.screen, beforeReceive: async () => {
    if (holdFirstA) { const hold = holdFirstA; holdFirstA = undefined; await hold(); }
  } });
  const b = await side(root, "beta", notify, { now: options.now });
  meshes.push({ root, broker, a, b });
  await command(a, "create", { name: "work", broker: broker.publicUrl, label: "alpha" });
  await command(a, "expose", { name: "work", peers: ["codex"] });
  const token = await command(a, "invite", { name: "work" }), request = await command(b, "join", { name: "work", token: token.artifact, label: "beta" });
  const roster = await command(a, "invite", { name: "work", request: request.artifact }); await command(b, "join", { name: "work", roster: roster.artifact });
  await notify.wait(() => a.bus.stateOf("codex@beta") === "idle" && b.bus.stateOf("codex@alpha") === "idle", "authenticated room links online");
  return { root, broker, a, b, ...notify };
}

function personChat(from: string, body: string, priority: RoomChatEnvelope["priority"] = "status"): Extract<RoomMessage, { type: "chat" }> {
  const base = newEnvelope(from, body, { priority });
  return { v: 1, type: "chat", envelope: { id: base.id, trace: base.trace, hop: base.hop, from, to: USER, kind: "chat", priority, body, ts: base.ts } };
}
async function sendWire(f: Awaited<ReturnType<typeof mesh>>, message: Extract<RoomMessage, { type: "chat" }>): Promise<CapturedChat> {
  const source = f.b.context!, recipient = f.a.context!.store.identity.public.fingerprint;
  await source.link.publishApplication(message, recipient, undefined, source.current);
  await f.a.signals.wait(() => f.a.lastChat?.message.envelope.id === message.envelope.id, `incoming ${message.envelope.id}`);
  return f.a.lastChat!;
}
async function waitReceipt(f: Awaited<ReturnType<typeof mesh>>, captured: CapturedChat, reason: string) {
  await f.a.signals.wait(() => f.a.context!.store.applicationReceipt("work", captured.digest)?.reason === reason, `receipt ${reason}`);
  return f.a.context!.store.applicationReceipt("work", captured.digest)!;
}

test("person inbox receipts are closed and distinguish durable human admission from native admission", () => {
  const application = newEnvelope("codex", "fixture");
  const base = { v: 1 as const, type: "receipt" as const, frame: encodeBase64url(new Uint8Array(32)), application: application.id, peer: USER };
  const admitted = { ...base, outcome: "completed" as const, reason: "inbox_admitted" as const };
  expect(decodeRoomMessage(encodeRoomMessage(admitted))).toEqual(admitted);
  const native = { ...base, peer: "codex", outcome: "completed" as const, reason: "admitted" as const };
  expect(decodeRoomMessage(encodeRoomMessage(native))).toEqual(native);
  for (const reason of ["inbox_full", "inbox_oversize", "inbox_expired", "inbox_age_unavailable", "person_inbox_unsupported"] as const) {
    const receipt = { ...base, outcome: "failed_safe" as const, reason };
    expect(decodeRoomMessage(encodeRoomMessage(receipt))).toEqual(receipt);
  }
  for (const receipt of [
    { ...base, outcome: "completed", reason: "inbox_full" },
    { ...base, outcome: "completed", reason: "inbox_age_unavailable" },
    { ...base, outcome: "failed_safe", reason: "inbox_admitted" },
    { ...base, outcome: "failed_safe", reason: "admitted" },
  ]) {
    expect(() => encodeRoomMessage(receipt as RoomMessage)).toThrow(RoomApplicationError);
    expect(() => decodeRoomMessage(canonicalBytes(receipt))).toThrow(RoomApplicationError);
  }
});

test("a real room chat to user@label is durably admitted once, body-free to observers, and survives reopen", async () => {
  const f = await mesh(), body = "PERSON-INBOX-CANARY private message";
  const env = newEnvelope("codex", body, { to: ["user@alpha"], priority: "status" });
  expect(f.b.bus.publish(env)).toEqual(["user@alpha"]);
  await f.wait(async () => (await deliveries(f.b)).some(row => row.application === env.id && row.state === "completed (inbox)"), "durable person inbox receipt");
  const captured = f.a.lastChat!;
  expect(captured.message.envelope.to).toBe(USER);
  expect(f.a.chat.metrics("work")).toMatchObject({ inbound: 1 });
  expect(f.b.chat.metrics("work")).toMatchObject({ outbound: 1 });
  expect(f.a.peer.got).toEqual([]);
  expect(f.a.memory).toEqual([]);
  expect(JSON.stringify(f.a.events)).not.toContain(body);
  expect(JSON.stringify(f.a.condensed)).not.toContain(body);
  expect(JSON.stringify(f.a.commands.statusView())).not.toContain(body);
  const metadata = f.a.context!.store.listPersonInbox("work");
  expect(metadata).toHaveLength(1);
  expect(JSON.stringify(metadata)).not.toContain(body);
  const item = f.a.context!.store.readPersonInbox(metadata[0]!.id, () => true);
  expect(item?.body).toBe(body);
  expect(f.a.screenCalls).toBe(0);

  await f.a.chat.application.receive(captured.context, { digest: captured.digest, sender: captured.sender });
  expect(f.a.context!.store.listPersonInbox("work")).toHaveLength(1);
  expect(f.a.chat.metrics("work")).toMatchObject({ inbound: 1 });
  expect((await deliveries(f.b)).filter(row => row.application === env.id)).toHaveLength(1);

  f.a.commands.stop();
  const reopened = await RoomStore.open({ stateDir: join(f.a.stateDir, "rooms") });
  try {
    const afterRestart = reopened.listPersonInbox("work");
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]).toMatchObject({ id: metadata[0]!.id, state: "unread" });
    expect(reopened.readPersonInbox(afterRestart[0]!.id, () => true)?.body).toBe(body);
  } finally { reopened.close(); }
});

test("expiry uses first durable arrival time; post-admission expiry purges body without changing its receipt", async () => {
  let now = Date.now();
  const arrived = new Deferred<void>(), release = new Deferred<void>();
  const f = await mesh({ now: () => now, holdFirstA: async () => { arrived.resolve(undefined); await release.promise; } });
  const body = "delayed person inbox admission", env = newEnvelope("codex", body, { to: ["user@alpha"], priority: "status" });
  expect(f.b.bus.publish(env)).toEqual(["user@alpha"]);
  await arrived.promise;
  now += 15 * 24 * 60 * 60 * 1000;
  release.resolve(undefined);
  await f.wait(async () => (await deliveries(f.b)).some(row => row.application === env.id && row.state === "completed (inbox)"), "delayed person admission");
  const captured = f.a.lastChat!, before = f.a.context!.store.applicationReceipt("work", captured.digest)!;
  const meta = f.a.context!.store.listPersonInbox("work")[0]!;
  expect(meta.expiresAt).toBe(meta.receivedAt + PERSON_TTL_MS);
  now = meta.expiresAt + 1;
  f.a.context!.store.expirePersonInbox();
  expect(f.a.context!.store.listPersonInbox("work")[0]?.state).toBe("expired");
  expect(f.a.context!.store.readPersonInbox(meta.id, () => true)?.body).toBeUndefined();
  expect(f.a.context!.store.applicationReceipt("work", captured.digest)).toEqual(before);
  expect(f.a.chat.metrics("work")).toMatchObject({ inbound: 1 });
});

test("pre-admission expiry, unexposed senders, FYI priority and oversized bodies fail safely", async () => {
  let now = Date.now();
  const arrived = new Deferred<void>(), release = new Deferred<void>();
  const f = await mesh({ now: () => now, holdFirstA: async () => { arrived.resolve(undefined); await release.promise; } });
  const expired = personChat("codex", "expired before admission");
  const source = f.b.context!, recipient = f.a.context!.store.identity.public.fingerprint;
  await source.link.publishApplication(expired, recipient, undefined, source.current);
  await arrived.promise;
  const first = f.a.lastChat!;
  now += PERSON_TTL_MS + 1;
  release.resolve(undefined);
  await waitReceipt(f, first, "inbox_expired");
  expect(f.a.context!.store.listPersonInbox("work")).toEqual([]);
  expect(f.a.chat.metrics("work")).toMatchObject({ inbound: 0 });

  for (const [message, reason] of [
    [personChat("qwen", "unexposed sender"), "not_exposed"],
    [personChat("codex", "FYI refusal", "fyi"), "boundary_refused"],
    [personChat("codex", "x".repeat(BODY_LIMIT + 1)), "inbox_oversize"],
  ] as const) {
    const captured = await sendWire(f, message);
    await waitReceipt(f, captured, reason);
  }
  expect(f.a.context!.store.listPersonInbox("work")).toEqual([]);
  expect(f.a.chat.metrics("work")).toMatchObject({ inbound: 0 });
  expect(f.a.peer.got).toEqual([]);
  expect(f.a.memory).toEqual([]);
  expect(f.a.screenCalls).toBe(0);
});

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  constructor() { this.promise = new Promise<T>(resolve => { this.resolve = resolve; }); }
}
