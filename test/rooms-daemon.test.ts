import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { decodeBase64url } from "../src/rooms/crypto.ts";
import { decodeInvite, decodeJoin, decodeRoster } from "../src/rooms/wire.ts";
import { RoomPolicy } from "../src/rooms/policy.ts";
import { runRoomCommand } from "../src/cli/room.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { RoomCommands } from "../src/rooms/commands.ts";
import { RoomChat } from "../src/rooms/service.ts";
import { RoomStore, type RoomState } from "../src/rooms/store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(conductor = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-daemon-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  const roles = Object.fromEntries(Object.entries(DEFAULT_CONFIG.roles).map(([peer, values]) => [peer, peer === "codex" ? ["conductor"] : values.filter(role => role !== "conductor")]));
  if (conductor) writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roles }));
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      ...(conductor ? { roles } : {}),
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  cleanup.push(() => daemon.stop());
  if (conductor) {
    class ConductorPeer extends BasePeer {
      async start() { this.setState("idle"); }
      async stop() { this.setState("offline"); }
      async deliver() {}
    }
    const peer = new ConductorPeer("codex"); daemon.bus.add(peer); await peer.start();
  }
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  return { root, stateDir, daemon, person };
}
async function mutation(client: ControlClient, action: string, input: Record<string, unknown>) {
  const preview = await client.request({ t: "room", op: "preview", action, input });
  expect(preview.ok).toBe(true);
  expect(preview.owner).toMatch(/^[0-9a-f]{64}$/); expect(preview.member).toMatch(/^[0-9a-f]{64}$/);
  return client.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member });
}

test("X5 status and dashboard reads with rooms disabled create no room identity or database", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) {
    expect((await f.person.request({ t: "status" })).status.rooms).toEqual([]);
    expect((await f.person.request({ t: "ui_snapshot", after: 0 })).rooms).toEqual([]);
  }
  expect(existsSync(join(f.stateDir, "rooms"))).toBe(false);
});

test("X5 live status and dashboard publish only loaded room metadata without body title or detail reads", async () => {
  const f = await fixture(), canary = "X5_REMOTE_BODY_TITLE_SECRET_CANARY";
  expect((await mutation(f.person, "create", { name: "test", broker: "ws://127.0.0.1:1/" })).ok).toBe(true);
  const metadata = RoomStore.prototype.statusMetadata;
  let store: RoomStore | undefined, getterReads = 0;
  const meta = spyOn(RoomStore.prototype, "statusMetadata").mockImplementation(function(this: RoomStore) {
    store = this;
    return metadata.call(this).map(row => Object.defineProperties({ ...row, title: canary, broker: canary, key: canary }, {
      body: { get() { getterReads++; throw new Error(canary); } },
    }));
  });
  const details = spyOn(RoomCommands.prototype, "rows");
  const metrics = spyOn(RoomChat.prototype, "metrics").mockReturnValue({ since: 123456, outbound: 0, inbound: 0, withheld: 0, body: canary, title: canary } as never);
  try {
    for (let index = 0; index < 3; index++) {
      const status = await f.person.request({ t: "status" });
      const snapshot = await f.person.request({ t: "ui_snapshot", after: 0 });
      for (const rows of [status.status.rooms, snapshot.rooms]) {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "test", epoch: "1", memberCount: 1,
          relays: { since: 123456, outbound: 0, inbound: 0, withheld: 0 } });
        expect(Object.keys(rows[0]).sort()).toEqual(["epoch", "link", "member", "memberCount", "name", "owner", "relays", "remotePeers", "room"]);
      }
      expect(JSON.stringify([status, snapshot])).not.toContain(canary);
    }
    expect(details).not.toHaveBeenCalled();
    expect(getterReads).toBe(0);
    expect(store).toBeDefined();
    // The verified-epoch metadata cache makes a warm status read independent of wire copying/decoding.
    const internal = (store as unknown as { rooms: Map<string, RoomState> }).rooms.get("test")!;
    const wire = internal.wire;
    Object.defineProperty(internal, "wire", { configurable: true, get() { getterReads++; throw new Error(canary); } });
    try { expect(metadata.call(store!)[0]?.members).toBe(1); expect(getterReads).toBe(0); }
    finally { Object.defineProperty(internal, "wire", { configurable: true, enumerable: true, writable: true, value: wire }); }
    for (const name of ["status.json", "hub.log", "events.jsonl"]) expect(readFileSync(join(f.stateDir, name), "utf8")).not.toContain(canary);
  } finally { metrics.mockRestore(); details.mockRestore(); meta.mockRestore(); }
});

test("every room rid is answered; tools can read ids but cannot mutate, even as conductor", async () => {
  const f = await fixture(true);
  const status = await f.person.request({ t: "status" });
  expect(status.status.roleInfo.codex.flowRoles).toContain("conductor");
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  for (const op of ["preview", "execute", "create", "invite", "join", "leave", "revoke", "expose", "unknown"]) {
    expect((await tools.request({ t: "room", op, action: "create", input: {name:"test",broker:"ws://127.0.0.1:1/"} })).ok).toBe(false);
  }
  for (const op of ["list", "status"]) expect(await tools.request({ t: "room", op })).toMatchObject({ ok: true, rooms: [] });
  expect((await f.person.request({ t: "room", op: "unknown" })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "status", input: { body: "PRIVATE_CANARY" } })).ok).toBe(false);
  expect(existsSync(join(f.stateDir, "rooms"))).toBe(false);
});

test("room preview tickets are connection-bound, one-use and contain no artifact", async () => {
  const f = await fixture(), other = await ControlClient.connect(f.stateDir, { role: "console" }); cleanup.push(() => other.close());
  const preview = await f.person.request({ t: "room", op: "preview", action: "create", input: { name: "test", broker: "ws://127.0.0.1:1/" } });
  expect(preview).toMatchObject({ ok: true }); expect(preview.artifact).toBeUndefined();
  expect((await f.person.request({ t: "room", op: "list" })).rooms).toEqual([]);
  expect((await other.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member, action: "leave" })).ok).toBe(false);
  expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member })).ok).toBe(false);
  expect((await mutation(f.person, "create", { name: "test", broker: "ws://127.0.0.1:1/" })).ok).toBe(true);
});

test("room execute requires a matching member fingerprint and burns unconfirmed tickets without installing", async () => {
  const f = await fixture();
  for (const mode of ["missing", "boolean", "short", "wrong", "uppercase"]) {
    const preview = await f.person.request({ t: "room", op: "preview", action: "create", input: { name: "test", broker: "ws://127.0.0.1:1/" } });
    expect(preview.ok).toBe(true);
    const wrong = (preview.member.startsWith("f") ? "e" : "f").repeat(16);
    const confirm = mode === "boolean" ? true : mode === "short" ? preview.member.slice(0, 15) : mode === "wrong" ? wrong : mode === "uppercase" ? "A".repeat(16) : undefined;
    const response = await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, ...(confirm !== undefined ? { confirm } : {}) });
    expect({ mode, ok: response.ok }).toEqual({ mode, ok: false });
    expect((await f.person.request({ t: "room", op: "list" })).rooms).toEqual([]);
    expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member })).ok).toBe(false);
  }
  const preview = await f.person.request({ t: "room", op: "preview", action: "create", input: { name: "test", broker: "ws://127.0.0.1:1/" } });
  expect((await f.person.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member.slice(0, 16) })).ok).toBe(true);
  expect((await f.person.request({ t: "room", op: "list" })).rooms).toHaveLength(1);
});

test("saying No leaves an enrollment invite unconsumed and its roster uninstalled", async () => {
  const owner = await fixture(), guest = await fixture();
  expect((await mutation(owner.person, "create", { name: "test", broker: "ws://127.0.0.1:1/" })).ok).toBe(true);
  const token = await mutation(owner.person, "invite", { name: "test" });
  const request = await mutation(guest.person, "join", { name: "test", token: token.artifact });
  const guestFingerprint = decodeJoin(decodeBase64url(request.artifact)).member.fingerprint;
  const wrong = (guestFingerprint.startsWith("f") ? "e" : "f").repeat(16);
  const refused = async (client: ControlClient, args: string[], mode: "no" | "missing" | "mismatch") => {
    const sent: Record<string, unknown>[] = [], lines: string[] = [], original = console.log;
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
    try {
      await expect(runRoomCommand(mode === "mismatch" ? [...args, "--confirm", wrong] : args, message => { sent.push(message); return client.request(message); }, { isTTY: () => mode === "no", answer: async prompt => {
        expect(lines).toHaveLength(2); expect(lines[0]).toStartWith("Owner fingerprint:"); expect(lines[1]).toStartWith("Member fingerprint:");
        expect(prompt).toContain("[y/N]"); return "n";
      } })).rejects.toThrow(mode === "no" ? "not confirmed" : "confirmation");
    } finally { console.log = original; }
    expect(sent.map(message => message.op)).toEqual(["preview"]);
  };
  const bindings = async (client: ControlClient) => (await client.request({ t: "room", op: "list" })).rooms.map(({ state: _state, ...binding }: Record<string, unknown>) => binding);
  const before = await bindings(owner.person);
  for (const mode of ["no", "missing", "mismatch"] as const) {
    await refused(owner.person, ["invite", "test", "--accept", request.artifact], mode);
    expect(await bindings(owner.person)).toEqual(before);
  }
  // The same invite still works after No, proving no one-time enrollment was consumed.
  const accepted = await mutation(owner.person, "invite", { name: "test", request: request.artifact }); expect(accepted.ok).toBe(true);
  for (const mode of ["no", "missing", "mismatch"] as const) {
    await refused(guest.person, ["join", "test", "--roster", accepted.artifact], mode);
    expect((await guest.person.request({ t: "room", op: "list" })).rooms).toEqual([]);
  }
  expect((await mutation(guest.person, "join", { name: "test", roster: accepted.artifact })).ok).toBe(true);
});

test("two person consoles enroll out of band, rotate exposure and revoke without leaking invitation secrets", async () => {
  const owner = await fixture(), guest = await fixture();
  expect((await mutation(owner.person, "create", { name: "test", broker: "ws://127.0.0.1:1/", label: "owner" })).ok).toBe(true);
  const token = await mutation(owner.person, "invite", { name: "test" }); expect(token.ok).toBe(true);
  const invite = decodeInvite(decodeBase64url(token.artifact));
  const request = await mutation(guest.person, "join", { name: "test", token: token.artifact, label: "guest" }); expect(request.ok).toBe(true);
  const joined = decodeJoin(decodeBase64url(request.artifact));
  const retry = await mutation(guest.person, "join", { name: "test", token: token.artifact, label: "guest" });
  expect(retry.artifact).toBe(request.artifact); // Crash after durable save but before printing is recoverable.

  expect(JSON.stringify(joined)).not.toContain(invite.secret);
  const accepted = await mutation(owner.person, "invite", { name: "test", request: request.artifact }); expect(accepted.ok).toBe(true);
  const roster = decodeRoster(decodeBase64url(accepted.artifact)); expect(roster.members).toHaveLength(2);
  expect((await mutation(guest.person, "join", { name: "test", roster: accepted.artifact })).ok).toBe(true);
  const exposed = await mutation(guest.person, "expose", { name: "test", peers: ["codex"] }); expect(exposed.ok).toBe(true);
  expect(exposed.kind).toBe("exposure-request"); expect(exposed.artifact).not.toContain(invite.secret);
  expect(new RoomPolicy(guest.root).get("test")).toEqual(["codex"]);
  const updated = await mutation(owner.person, "invite", { name: "test", request: exposed.artifact }); expect(updated.ok).toBe(true);
  expect((await mutation(guest.person, "join", { name: "test", roster: updated.artifact })).ok).toBe(true);
  const rows = await guest.person.request({ t: "room", op: "list" });
  expect(Object.keys(rows.rooms[0]).sort()).toEqual(["epoch","member","name","owner","room","state"]);
  expect(JSON.stringify(rows)).not.toContain("broker"); expect(JSON.stringify(rows)).not.toContain(invite.secret);
  expect((await mutation(owner.person, "revoke", { name: "test", member: joined.member.fingerprint })).ok).toBe(true);
  const afterRevoke = (await owner.person.request({ t: "room", op: "list" })).rooms[0].epoch;
  const replay = await owner.person.request({ t: "room", op: "preview", action: "invite", input: { name: "test", request: request.artifact } });
  const replayResult = replay.ok ? await owner.person.request({ t: "room", op: "execute", ticket: replay.ticket, confirm: replay.member }) : replay;
  expect(replayResult.ok).toBe(false);
  expect((await owner.person.request({ t: "room", op: "list" })).rooms[0].epoch).toBe(afterRevoke);
  expect((await mutation(guest.person, "leave", { name: "test" })).ok).toBe(true);
  expect((await guest.person.request({ t: "room", op: "status" })).rooms[0].state).toBe("left");
  for (const fixture of [owner, guest]) {
    expect(readFileSync(join(fixture.stateDir, "hub.log"), "utf8")).not.toContain(invite.secret);
    expect(readFileSync(join(fixture.stateDir, "events.jsonl"), "utf8")).not.toContain(invite.secret);
  }
});

test("room exposure is machine-local and a committed local config cannot authorize it", async () => {
  const f = await fixture(), policy = new RoomPolicy(f.root);
  policy.set("test", ["codex"], () => true); expect(policy.get("test")).toEqual(["codex"]);
  expect(Bun.spawnSync(["git", "-C", f.root, "add", "-f", ".agenthub/config.local.json"]).exitCode).toBe(0);
  expect(policy.get("test")).toEqual([]);
  expect(() => policy.set("test", ["claude"], () => true)).toThrow("untrusted_config");
});


test("person inbox operations answer every rid and refuse a tools conductor before body access", async () => {
  const f = await fixture(true), tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" });
  cleanup.push(() => tools.close());
  const list = spyOn(RoomCommands.prototype, "inboxRows"), show = spyOn(RoomCommands.prototype, "inboxShow"), dispose = spyOn(RoomCommands.prototype, "inboxDispose");
  try {
    for (const op of ["inbox_list", "inbox_show", "inbox_done", "inbox_discard"]) {
      const reply = await tools.request({ t: "room", op, input: op === "inbox_list" ? {} : { id: crypto.randomUUID() } });
      expect(reply.ok).toBe(false); expect(reply.error).toBe("room inbox is person-only");
    }
    expect(list).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
    expect(await f.person.request({ t: "room", op: "inbox_list", input: {} })).toMatchObject({ ok: true, inbox: [] });
    expect(await f.person.request({ t: "room", op: "inbox_show", input: { id: crypto.randomUUID() } })).toMatchObject({ ok: false, code: "inbox_not_found" });
    for (const input of [{ id: "../private" }, { id: crypto.randomUUID(), body: "not an input field" }, null]) {
      expect((await f.person.request({ t: "room", op: "inbox_show", input })).ok).toBe(false);
    }
    expect(existsSync(join(f.stateDir, "rooms"))).toBe(false);
  } finally { list.mockRestore(); show.mockRestore(); dispose.mockRestore(); }
});

test("only the person's explicit inbox show reply carries a body, never status snapshot events or logs", async () => {
  const f = await fixture(), canary = "PERSON_INBOX_RPC_BODY_CANARY";
  const item = { id: crypto.randomUUID(), name: "work", room: "A".repeat(43), sender: "a".repeat(64), from: "codex@remote", receivedAt: 1000, expiresAt: 2000, bytes: Buffer.byteLength(canary), state: "unread" as const };
  const list = spyOn(RoomCommands.prototype, "inboxRows").mockResolvedValue([item]);
  const show = spyOn(RoomCommands.prototype, "inboxShow").mockResolvedValue({ ...item, body: canary });
  const dispose = spyOn(RoomCommands.prototype, "inboxDispose").mockResolvedValue({ ...item, state: "done" });
  const events: unknown[] = []; f.daemon.bus.tap(event => events.push(event));
  try {
    expect(await f.person.request({ t: "room", op: "inbox_list", input: {} })).toMatchObject({ ok: true, inbox: [item] });
    expect(await f.person.request({ t: "room", op: "inbox_show", input: { id: item.id } })).toMatchObject({ ok: true, item: { ...item, body: canary } });
    const done = await f.person.request({ t: "room", op: "inbox_done", input: { id: item.id } });
    expect(done.item.state).toBe("done"); expect(done.item).not.toHaveProperty("body");
    const publicReads = [await f.person.request({ t: "status" }), await f.person.request({ t: "ui_snapshot", after: 0 }), events];
    expect(JSON.stringify(publicReads)).not.toContain(canary);
    for (const name of ["status.json", "hub.log", "events.jsonl"]) expect(readFileSync(join(f.stateDir, name), "utf8")).not.toContain(canary);
  } finally { list.mockRestore(); show.mockRestore(); dispose.mockRestore(); }
});

test("inbox show rechecks its socket after await before serializing a body", async () => {
  const f = await fixture();
  let entered!: () => void, release!: (value: never) => void, reads = 0;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const show = spyOn(RoomCommands.prototype, "inboxShow").mockImplementation(async () => { entered(); return new Promise<never>(resolve => { release = resolve; }); });
  try {
    const pending = f.person.request({ t: "room", op: "inbox_show", input: { id: crypto.randomUUID() } }).catch(() => undefined);
    await observed; f.person.close(); await pending;
    release(Object.defineProperty({}, "body", { get() { reads++; return "BODY_MUST_NOT_SERIALIZE"; } }) as never);
    const other = await ControlClient.connect(f.stateDir, { role: "console" }); cleanup.push(() => other.close());
    await other.request({ t: "status" });
    expect(reads).toBe(0);
  } finally { show.mockRestore(); }
});


test("person inbox expiry schedules a retry only after an actual purge and coalesces idle ticks", async () => {
  let changed = false, retries = 0;
  const commands = new RoomCommands({ cwd: tmpdir(), stateDir: tmpdir(), chat: {
    retryPending: async () => { retries++; }, stop: () => {},
  } as unknown as RoomChat });
  Object.assign(commands, { store: { expirePersonInbox: () => changed, close: () => {} } });
  commands.expireInbox(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(retries).toBe(0);
  changed = true; commands.expireInbox(); changed = false; commands.expireInbox();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(retries).toBe(1);
  commands.stop();
});


test("person inbox disposition replies before a blocked network retry and a later socket drop cannot change success", async () => {
  const f = await fixture();
  expect((await mutation(f.person, "create", { name: "test", broker: "ws://127.0.0.1:1/" })).ok).toBe(true);
  const item = { id: crypto.randomUUID(), name: "test", room: "A".repeat(43), sender: "a".repeat(64), from: "codex@remote", receivedAt: 1, expiresAt: 2, bytes: 0, state: "discarded" as const };
  let entered!: () => void, release!: () => void;
  const retryEntered = new Promise<void>(resolve => { entered = resolve; });
  const retryHeld = new Promise<void>(resolve => { release = resolve; });
  const dispose = spyOn(RoomStore.prototype, "disposePersonInbox").mockReturnValue(item);
  const retry = spyOn(RoomChat.prototype, "retryPending").mockImplementation(async () => { entered(); await retryHeld; });
  let response: any;
  const pending = f.person.request({ t: "room", op: "inbox_discard", input: { id: item.id } }).then(value => { response = value; return value; }).catch(() => undefined);
  try {
    await retryEntered;
    // WebSocket FIFO makes this a consumed reply barrier, with no wall-clock assumption.
    await f.person.request({ t: "status" });
    expect(response?.ok).toBe(true);
    expect(response).toMatchObject({ ok: true, item });
    f.person.close();
    expect(response.ok).toBe(true);
  } finally { release(); await pending; retry.mockRestore(); dispose.mockRestore(); }
});
