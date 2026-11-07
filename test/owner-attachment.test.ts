import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsPeer, type ChannelSocket } from "../src/adapters/channel-peer.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { renderStatus } from "../src/cli/output.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(ready: () => boolean, label: string) {
  for (let n = 0; n < 400 && !ready(); n++) await Bun.sleep(5);
  expect(ready(), label).toBe(true);
}
const plain = (rows: { text: string }[][]) => rows.map(row => row.map(cell => cell.text).join("")).join("\n");

// #1310 (task #800): the current owner's attachment facts for display. Driven against the real WsPeer with fake sockets, so every lifecycle rule is the adapter's own.
// The facts are display metadata only: these tests also pin what they are NOT (never derived from a standby, a title, a process name or attach order, never text).
const OPEN = WebSocket.OPEN;
type FakeSocket = Omit<ChannelSocket, "readyState"> & { readyState: number; closed: { code?: number; reason?: string }[]; sent: string[] };
function socket(data: ChannelSocket["data"] = {}): FakeSocket {
  const closed: { code?: number; reason?: string }[] = [], sent: string[] = [];
  const s: FakeSocket = { readyState: OPEN as number, data: { ...data }, closed, sent, send: (text: string) => { sent.push(text); }, close: (code?: number, reason?: string) => { closed.push({ code, reason }); s.readyState = WebSocket.CLOSED; } };
  return s;
}
const attach = (peer: WsPeer, sock: ChannelSocket, pullOnly = false) => { peer.claim(sock, pullOnly); peer.attach(sock); };
const keys = (value: object | undefined) => Object.keys(value ?? {}).sort();

test("AC1: an attached owner reports its bounded pid and the time its attach completed, and nothing else", () => {
  const peer = new WsPeer("kimi");
  const sock = socket({ clientPid: 4242 });
  const before = Date.now();
  attach(peer, sock, true);
  const owner = peer.ownerAttachment!;
  expect(owner.ownerPid).toBe(4242);
  expect(owner.attachedAt).toBeGreaterThanOrEqual(before); expect(owner.attachedAt).toBeLessThanOrEqual(Date.now());
  expect(keys(owner)).toEqual(["attachedAt", "ownerPid"]); // no native session was verified, so none is shown
  expect(peer.attached).toBe(true);
});

test("AC1: attachedAt is when the attach completed, not when the hello claimed the peer", async () => {
  const peer = new WsPeer("kimi");
  const sock = socket({ clientPid: 7 });
  const claimedAt = Date.now();
  peer.claim(sock, true); // the hello
  await Bun.sleep(30);    // the asynchronous preface
  expect(peer.ownerAttachment).toBeUndefined(); // claiming is not attached
  peer.attach(sock);
  expect(peer.ownerAttachment!.attachedAt).toBeGreaterThanOrEqual(claimedAt + 25);
});

test("AC5: a claimant and an offline peer are never shown as attached", () => {
  const peer = new WsPeer("kimi");
  expect(peer.ownerAttachment).toBeUndefined(); // never attached
  const first = socket({ clientPid: 1 });
  attach(peer, first, true);
  expect(peer.ownerAttachment?.ownerPid).toBe(1);
  // a newer hello is claiming while the first is still the socket: the peer reads as claiming, and no owner is shown for it
  const claimant = socket({ clientPid: 2 });
  peer.claim(claimant, true);
  expect(peer.claiming).toBe(true);
  expect(peer.ownerAttachment).toBeUndefined();
  // the claimant never appears under its own pid before its attach completes
  peer.attach(claimant);
  expect(peer.ownerAttachment?.ownerPid).toBe(2);
  peer.detach(claimant);
  expect(peer.state).toBe("offline");
  expect(peer.ownerAttachment).toBeUndefined();
});

test("AC1/AC5: a pid that is missing, zero, negative, fractional, huge or not a number is unknown, never guessed or clamped", () => {
  for (const bad of [undefined, 0, -5, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, "1234" as never, null as never, {} as never]) {
    const peer = new WsPeer("kimi");
    attach(peer, socket({ clientPid: bad as never }), true);
    expect(keys(peer.ownerAttachment), String(bad)).toEqual(["attachedAt"]);
  }
  const peer = new WsPeer("kimi");
  attach(peer, socket({ clientPid: 2_147_483_647 }), true);
  expect(peer.ownerAttachment!.ownerPid).toBe(2_147_483_647);
});

test("AC2: standby rows stay distinct, and a standby id, pid or arrival order is never the owner's identity", () => {
  const peer = new WsPeer("kimi");
  const owner = socket({ clientPid: 100, retainStandby: true }), standbyA = socket({ clientPid: 200, retainStandby: true }), standbyB = socket({ clientPid: 300, retainStandby: true });
  attach(peer, owner, true);
  const a = peer.retainStandby(standbyA, 200)!, b = peer.retainStandby(standbyB, 300)!;
  expect(peer.ownerAttachment).toMatchObject({ ownerPid: 100 });
  expect(peer.standbySessions.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
  expect(JSON.stringify(peer.ownerAttachment)).not.toContain(a.id); expect(JSON.stringify(peer.ownerAttachment)).not.toContain(b.id);
  expect(peer.ownerAttachment!.ownerPid).not.toBe(200); expect(peer.ownerAttachment!.ownerPid).not.toBe(300);
  // the standby pids and ids are untouched by the owner facts
  expect(peer.standbySessions.map(s => s.pid).sort()).toEqual([200, 300]);
});

test("AC3: takeover replaces every owner fact at once: the old pid and time never sit beside the new socket", async () => {
  const peer = new WsPeer("kimi");
  const owner = socket({ clientPid: 100, retainStandby: true }), standby = socket({ clientPid: 200, retainStandby: true });
  attach(peer, owner, true);
  const oldAttachedAt = peer.ownerAttachment!.attachedAt;
  const session = peer.retainStandby(standby, 200)!;
  await Bun.sleep(15);
  const claim = peer.takeover(session.id, () => true)!;
  expect(claim).toBeDefined();
  // the old owner was detached, and until the new one attaches nobody is shown, so no mixed state is readable
  expect(peer.ownerAttachment).toBeUndefined();
  expect(owner.closed.at(-1)).toMatchObject({ code: 4405 });
  expect(claim.attach()).toBe(true);
  const now = peer.ownerAttachment!;
  expect(now.ownerPid).toBe(200);
  expect(now.attachedAt).toBeGreaterThan(oldAttachedAt);
  expect(keys(now)).toEqual(["attachedAt", "ownerPid"]);
  // a standby that was promoted is no longer a standby, and the previous owner is not retained
  expect(peer.standbySessions).toEqual([]);
});

test("AC3: a standby with no pid taking over leaves the new owner's pid unknown, never the previous owner's", async () => {
  const peer = new WsPeer("kimi");
  const owner = socket({ clientPid: 100, retainStandby: true }), standby = socket({ retainStandby: true });
  attach(peer, owner, true);
  const session = peer.retainStandby(standby)!;
  const claim = peer.takeover(session.id, () => true)!;
  expect(claim.attach()).toBe(true);
  expect(keys(peer.ownerAttachment)).toEqual(["attachedAt"]);
  expect(peer.ownerAttachment).not.toHaveProperty("ownerPid");
});

test("AC3: newest-hello replacement (no opt-in) replaces the owner facts, and the replaced socket's facts are gone", () => {
  const peer = new WsPeer("kimi");
  const first = socket({ clientPid: 11 }), second = socket({ clientPid: 22 });
  attach(peer, first, true);
  attach(peer, second, true);
  expect(peer.ownerAttachment?.ownerPid).toBe(22);
  expect(first.closed.at(-1)).toMatchObject({ code: 4000 });
  // a late detach of the replaced socket changes nothing about the current owner
  peer.detach(first);
  expect(peer.ownerAttachment?.ownerPid).toBe(22);
});

test("AC3: detach, roster removal and stop each leave no owner metadata", () => {
  for (const end of ["detach", "roster", "stop"] as const) {
    const peer = new WsPeer("kimi");
    const sock = socket({ clientPid: 55 });
    attach(peer, sock, true);
    peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
    expect(keys(peer.ownerAttachment), end).toEqual(["attachedAt", "nativeSessionId", "ownerPid"]);
    if (end === "detach") peer.detach(sock);
    else if (end === "roster") peer.detachForRoster();
    else void peer.stop();
    expect(peer.ownerAttachment, end).toBeUndefined();
  }
  // a socket that closes without a detach call is not shown either: the readiness of the socket is checked on every read
  const peer = new WsPeer("kimi");
  const sock = socket({ clientPid: 9 });
  attach(peer, sock, true);
  sock.readyState = WebSocket.CLOSED;
  expect(peer.ownerAttachment).toBeUndefined();
});

test("AC3: a re-attach after a detach starts clean: the previous owner's facts and native session do not return", () => {
  const peer = new WsPeer("kimi");
  const first = socket({ clientPid: 31 });
  attach(peer, first, true);
  peer.bindNativeSession("11111111-1111-4111-8111-111111111111");
  peer.detach(first);
  const second = socket({ clientPid: 32 });
  attach(peer, second, true);
  expect(peer.ownerAttachment?.ownerPid).toBe(32);
  expect(peer.ownerAttachment).not.toHaveProperty("nativeSessionId"); // never the previous owner's session
});

test("AC3: the SAME socket object attaching again after a detach or a roster removal is a new attachment: its time and pid are read fresh and nothing of the earlier one returns", async () => {
  // `stop()` is not in this loop: it closes the socket but keeps the peer's `sock` reference (existing behavior, untouched here), so a stopped peer is not re-attached through this path.
  for (const end of ["detach", "roster"] as const) {
    const peer = new WsPeer("kimi");
    const sock = socket({ clientPid: 61 });
    attach(peer, sock, true);
    const first = peer.ownerAttachment!;
    await Bun.sleep(12);
    if (end === "detach") peer.detach(sock);
    else peer.detachForRoster();
    sock.readyState = OPEN; // the same object is reused, as a reconnecting client's wrapper may be
    sock.data.clientPid = 62; // and its reported pid changed
    expect(peer.ownerAttachment, `${end}: nothing is shown between the old attachment and the new one`).toBeUndefined();
    attach(peer, sock, true);
    const second = peer.ownerAttachment!;
    expect(second.ownerPid, end).toBe(62);
    expect(second.attachedAt, end).toBeGreaterThan(first.attachedAt);
  }
});

test("AC3: a new owner without a usable pid never inherits the previous owner's pid, and attach time is never carried over", async () => {
  const peer = new WsPeer("kimi");
  attach(peer, socket({ clientPid: 71 }), true);
  const first = peer.ownerAttachment!;
  await Bun.sleep(12);
  const next = socket({}); // no pid
  attach(peer, next, true);
  const second = peer.ownerAttachment!;
  expect(second).not.toHaveProperty("ownerPid");
  expect(second.attachedAt).toBeGreaterThan(first.attachedAt);
  expect(keys(second)).toEqual(["attachedAt"]);
});

test("AC2/AC4: a standby's id is never reported as the owner's identity or native session, including after takeover", () => {
  const peer = new WsPeer("kimi");
  const owner = socket({ clientPid: 81, retainStandby: true }), standby = socket({ clientPid: 82, retainStandby: true });
  attach(peer, owner, true);
  const session = peer.retainStandby(standby, 82)!;
  expect(standby.data.standbyId).toBe(session.id);
  const claim = peer.takeover(session.id, () => true)!;
  expect(claim.attach()).toBe(true);
  // the promoted socket's hello-time standby id was a connection label; it is never presented as a native session
  const text = JSON.stringify(peer.ownerAttachment);
  expect(text).not.toContain(session.id);
  expect(peer.ownerAttachment).not.toHaveProperty("nativeSessionId");
  peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  expect(peer.ownerAttachment!.nativeSessionId).toBe("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  expect(peer.ownerAttachment!.nativeSessionId).not.toBe(session.id);
});

test("AC3/AC4: a native session bound for one owner is gone when another attaches, even while the peer never went through detach", () => {
  const peer = new WsPeer("kimi");
  attach(peer, socket({ clientPid: 91 }), true);
  peer.bindNativeSession("11111111-1111-4111-8111-111111111111");
  expect(peer.ownerAttachment!.nativeSessionId).toBe("11111111-1111-4111-8111-111111111111");
  // newest-hello replacement: no detach call for the first socket at all
  attach(peer, socket({ clientPid: 92 }), true);
  expect(peer.ownerAttachment!.ownerPid).toBe(92);
  expect(peer.ownerAttachment).not.toHaveProperty("nativeSessionId");
  expect((peer as { nativeSession?: string }).nativeSession).toBeUndefined();
});

test("AC4: nativeSessionId appears only after the host bound a session, and is a short plain token or absent", () => {
  const peer = new WsPeer("kimi");
  attach(peer, socket({ clientPid: 5 }), true);
  expect(peer.ownerAttachment).not.toHaveProperty("nativeSessionId"); // unproven: absent
  peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  expect(peer.ownerAttachment!.nativeSessionId).toBe("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  // a value that is too long, empty or contains anything but a plain token is not shown at all (never trimmed into a valid-looking id)
  for (const bad of ["x".repeat(129), "has space", "line\nbreak", "../../etc/passwd", "a;b", "-leading", "tab\tx", "\u202Eevil", "emoji😀"]) {
    const p = new WsPeer("kimi");
    attach(p, socket({ clientPid: 5 }), true);
    p.bindNativeSession(bad);
    expect(p.ownerAttachment, JSON.stringify(bad)).not.toHaveProperty("nativeSessionId");
    expect(JSON.stringify(p.ownerAttachment), JSON.stringify(bad)).not.toContain(bad); // the odd value appears nowhere in what is reported
  }
  const edge = new WsPeer("kimi"); attach(edge, socket({}), true); edge.bindNativeSession("a".repeat(128));
  expect(edge.ownerAttachment!.nativeSessionId).toBe("a".repeat(128));
});

test("AC4: a native session cannot be bound without an attached socket, and binding does not create an owner", () => {
  const peer = new WsPeer("kimi");
  peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0"); // no socket: ignored by the adapter
  expect(peer.ownerAttachment).toBeUndefined();
  const claimant = socket({ clientPid: 8 });
  peer.claim(claimant, true);
  peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0"); // claiming only: still no socket
  expect(peer.ownerAttachment).toBeUndefined();
});

test("AC6: the facts are display metadata only: no field carries env, argv, cwd, a credential, a prompt, a title or text, and they never change delivery, state or queue behavior", () => {
  const peer = new WsPeer("kimi");
  const sock = socket({ clientPid: 77, cwd: "/secret/work/dir", launchId: "launch-SECRET", channelEvidence: "unknown", protocol: 17, peerGeneration: "gen-SECRET" });
  attach(peer, sock, true);
  peer.bindNativeSession("ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  const text = JSON.stringify(peer.ownerAttachment);
  for (const secret of ["/secret/work/dir", "SECRET", "launch-", "gen-", "unknown"]) expect(text).not.toContain(secret);
  expect(keys(peer.ownerAttachment)).toEqual(["attachedAt", "nativeSessionId", "ownerPid"]);
  expect(typeof peer.ownerAttachment!.attachedAt).toBe("number");
  // reading it changes nothing: the same getter twice, the peer's own state and attach flags untouched
  const state = peer.state, pullOnly = peer.pullOnly, attached = peer.attached;
  void peer.ownerAttachment; void peer.ownerAttachment;
  expect([peer.state, peer.pullOnly, peer.attached]).toEqual([state, pullOnly, attached]);
  // the returned object is a copy: mutating it never reaches the adapter
  const copy = peer.ownerAttachment as { ownerPid?: number };
  copy.ownerPid = 1;
  expect(peer.ownerAttachment!.ownerPid).toBe(77);
});

test("AC5: queue and lastInboxAt behavior is unchanged by the owner facts", () => {
  const peer = new WsPeer("kimi");
  attach(peer, socket({ clientPid: 3 }), true);
  expect(peer.lastInboxAt).toBeUndefined(); // attach still clears it, as before
  peer.lastInboxAt = 12345;
  void peer.ownerAttachment;
  expect(peer.lastInboxAt).toBe(12345);
  const next = socket({ clientPid: 4 });
  attach(peer, next, true);
  expect(peer.lastInboxAt).toBeUndefined(); // a new owner resets it exactly as before this change
});

// ---- the real daemon: a real control socket, the console's detailed status, status.json on disk and the CLI text ----
async function daemonFixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-owner-attachment-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
  const connect = async (hello: Record<string, unknown> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}`), messages: any[] = [];
    cleanup.push(() => socket.close());
    let closeCode: number | undefined, rid = 1;
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    socket.onclose = event => { closeCode = event.code; };
    await new Promise<void>((resolve, reject) => { socket.onerror = () => reject(new Error("fixture websocket failed")); socket.onopen = () => { socket.send(JSON.stringify({ t: "hello", v: PROTOCOL, token, role: "peer", peer: "claude", ...hello })); resolve(); }; });
    await until(() => closeCode !== undefined || messages.some(row => row.t === "welcome"), "hello result");
    return { socket, messages, closed: () => closeCode, request: async (body: Record<string, unknown>) => { const id = ++rid; socket.send(JSON.stringify({ ...body, rid: id })); await until(() => messages.some(row => row.rid === id), `reply ${String(body.t)}`); return messages.find(row => row.rid === id); } };
  };
  const peers = async () => (await person.request({ t: "status" })).status.peers;
  return { root, stateDir, daemon, person, connect, peers };
}

test("the daemon reports the owner in the console's detailed status: pid and attach time, under one object, and the standby rows stay separate", async () => {
  const f = await daemonFixture();
  const before = Date.now();
  const owner = await f.connect({ retainStandby: true, clientPid: 4101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const standby = await f.connect({ retainStandby: true, clientPid: 4202 });
  const standbyId = standby.messages.find(row => row.t === "welcome")?.standbyId;
  expect(typeof standbyId).toBe("string");
  const row = (await f.peers()).claude;
  expect(row.ownerAttachment).toEqual({ ownerPid: 4101, attachedAt: expect.any(Number) });
  expect(row.ownerAttachment.attachedAt).toBeGreaterThanOrEqual(before);
  expect(row.standbySessions).toEqual([{ id: standbyId, pid: 4202, since: expect.any(Number) }]);
  expect(JSON.stringify(row.ownerAttachment)).not.toContain(standbyId);
  expect(owner.closed()).toBeUndefined();
});

test("takeover through the real control path replaces the owner facts: after the new socket attaches, only its pid and its own attach time are reported", async () => {
  const f = await daemonFixture();
  const owner = await f.connect({ retainStandby: true, clientPid: 5101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const firstAttach = (await f.peers()).claude.ownerAttachment.attachedAt;
  const standby = await f.connect({ retainStandby: true, clientPid: 5202 });
  const standbyId = standby.messages.find(row => row.t === "welcome").standbyId;
  await Bun.sleep(20);
  expect(await f.person.request({ t: "peer_takeover", peer: "claude", standbyId })).toMatchObject({ ok: true, outcome: "requested" });
  await until(() => standby.messages.some(row => row.t === "peer_attached"), "new owner attached");
  await until(() => owner.closed() !== undefined, "old owner closed");
  const row = (await f.peers()).claude;
  expect(row.ownerAttachment).toEqual({ ownerPid: 5202, attachedAt: expect.any(Number) });
  expect(row.ownerAttachment.attachedAt).toBeGreaterThan(firstAttach);
  expect(row.standbySessions).toBeUndefined(); // the promoted standby is the owner now, and nothing is left waiting
});

test("detach leaves the peer offline with no owner object, in the reply and in nothing else", async () => {
  const f = await daemonFixture();
  const owner = await f.connect({ clientPid: 6101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  expect((await f.peers()).claude.ownerAttachment?.ownerPid).toBe(6101);
  owner.socket.close();
  await until(() => f.daemon.bus.stateOf("claude") === "offline", "owner detached");
  const row = (await f.peers()).claude;
  expect(row.state).toBe("offline");
  expect(row).not.toHaveProperty("ownerAttachment");
});

test("status.json on disk and every non-console reader never carry the owner pid: only the console's detailed status does", async () => {
  const f = await daemonFixture();
  await f.connect({ clientPid: 7101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  expect((await f.peers()).claude.ownerAttachment?.ownerPid).toBe(7101);
  const onDisk = readFileSync(join(f.stateDir, "status.json"), "utf8");
  expect(onDisk).not.toContain("ownerAttachment"); expect(onDisk).not.toContain("7101"); expect(onDisk).not.toContain("attachedAt");
  // a tools caller's status is the same public projection without the console's attention items
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => tools.close());
  const text = JSON.stringify((await tools.request({ t: "status" })).status.peers);
  expect(text).not.toContain("ownerAttachment"); expect(text).not.toContain("7101");
});

test("a claiming hello is not shown as attached: while a newer hello's preface is pending the peer shows no owner", async () => {
  const f = await daemonFixture();
  await f.connect({ clientPid: 8101 });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const peer = f.daemon.bus.peers.get("claude");
  if (!(peer instanceof WsPeer)) throw new Error("fixture has no channel peer");
  peer.claim({ readyState: WebSocket.OPEN, data: { clientPid: 8999 }, send: () => {}, close: () => {} });
  const row = (await f.peers()).claude;
  expect(row.claiming).toBe(true);
  expect(row).not.toHaveProperty("ownerAttachment");
  expect(JSON.stringify(row)).not.toContain("8999"); expect(JSON.stringify(row)).not.toContain("8101");
});

test("an owner whose hello carried no usable pid is reported with the attach time alone", async () => {
  const f = await daemonFixture();
  await f.connect({ clientPid: "4321", retainStandby: false });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "owner attached");
  const row = (await f.peers()).claude;
  expect(row.ownerAttachment).toEqual({ attachedAt: expect.any(Number) });
});

test("the CLI text shows the owner line and unverified native session, and never from a standby or unusual input", () => {
  const owner = { ownerPid: 4101, attachedAt: 60_000 };
  const out = plain(renderStatus({ peers: { claude: { state: "idle", ownerAttachment: owner, standbySessions: [{ id: "452ad7d7-3430-4b2c-b5be-56d96b54ea36", pid: 4202, since: 90_000 }] } } }, undefined, 120_000));
  expect(out).toContain("claude owner");
  expect(out).toContain("pid 4101");
  expect(out).toContain("native session unverified");
  expect(out).toContain("claude standby");
  expect(out.indexOf("claude owner")).toBeLessThan(out.indexOf("claude standby")); // the owner is stated before the standbys, never inferred from them
  const verified = plain(renderStatus({ peers: { kimi: { state: "idle", ownerAttachment: { ownerPid: 9, attachedAt: 60_000, nativeSessionId: "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0" } } } }, undefined, 120_000));
  expect(verified).toContain("native session ee5ab2ab-7319-4a81-82ca-bf2fc84678d0");
  expect(verified).not.toContain("unverified");
  // a pid-less owner says so, and malformed values are left out or labelled, never printed
  const hostile = plain(renderStatus({ peers: { kimi: { state: "idle", ownerAttachment: { ownerPid: "1; rm -rf /", attachedAt: 60_000, nativeSessionId: "evil\nline with spaces and a title" } } } }, undefined, 120_000));
  expect(hostile).toContain("pid unknown");
  expect(hostile).toContain("native session unverified");
  expect(hostile).not.toContain("rm -rf"); expect(hostile).not.toContain("evil");
  // no owner object, no owner line; a non-finite time is not rendered
  expect(plain(renderStatus({ peers: { kimi: { state: "offline" } } }, undefined, 120_000))).not.toContain("kimi owner");
  expect(plain(renderStatus({ peers: { kimi: { state: "idle", ownerAttachment: { ownerPid: 5, attachedAt: Number.NaN } } } }, undefined, 120_000))).not.toContain("kimi owner");
});

// ---- the verified native session, through the REAL native-facts path (agy): unproven before the host binds it, shown after, and cleared with the owner ----
test("AC4 end to end: nativeSessionId is absent until the daemon verifies the native session through native_facts, then shown, and gone with the owner", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-owner-native-"))), stateDir = join(root, "state"), savedHome = process.env.HOME;
  process.env.HOME = root;
  const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
  const logs = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), transcript = join(logs, "transcript_full.jsonl");
  mkdirSync(logs, { recursive: true }); writeFileSync(transcript, "");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roster: { agy: true }, memory: { enabled: false, native: false }, snapshots: { enabled: false }, pi: { enabled: false, auto_start: false }, inference: { enabled: false, triage: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config: {
    ...DEFAULT_CONFIG, roster: { agy: true }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const person = await ControlClient.connect(stateDir, { role: "console" });
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "agy" });
  let peer: ControlClient | undefined;
  try {
    const admission: any = await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
    expect(admission.ok).toBe(true);
    peer = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false });
    await until(() => daemon.bus.peers.get("agy")?.state === "idle", "agy attached");
    const ownerRow = async () => (await person.request({ t: "status" })).status.peers.agy;
    // attached, but no native session verified yet: the owner is shown without a native session id. This client sends no clientPid (only the channel plugin does), so the pid is unknown and absent.
    const unproven = (await ownerRow()).ownerAttachment;
    expect(unproven).toEqual({ attachedAt: expect.any(Number) });
    expect(unproven).not.toHaveProperty("nativeSessionId");
    // a native fact the daemon REFUSES (another workspace) binds nothing, so the session stays unproven
    const payload = { conversationId: session, transcriptPath: transcript, workspacePaths: [root], invocationNum: 0 };
    const facts = (extra = {}, overrides = {}) => tools.request({ t: "native_facts", event: "PreInvocation", payload: { ...payload, ...extra }, nativeInstanceId: admission.instanceId, nativeLaunchId: admission.launchId, ...overrides });
    expect((await facts({ workspacePaths: ["/outside"] })).ok).toBe(false);
    expect((await facts({}, { nativeLaunchId: "stale" })).ok).toBe(false);
    expect((await ownerRow()).ownerAttachment).not.toHaveProperty("nativeSessionId");
    // a verified native fact binds the session, and only then it is shown
    expect((await facts()).ok).toBe(true);
    const proven = (await ownerRow()).ownerAttachment;
    expect(proven).toEqual({ attachedAt: expect.any(Number), nativeSessionId: session });
    expect(proven.attachedAt).toBe(unproven.attachedAt); // the session binding does not move the attach time
    // the CLI text shows the verified id
    expect(plain(renderStatus({ peers: { agy: { state: "busy", ownerAttachment: proven } } }, undefined, Date.now() + 1000))).toContain(`native session ${session}`);
    // the owner leaves: nothing about it remains
    peer.close();
    await until(() => daemon.bus.stateOf("agy") === "offline", "owner detached");
    expect(await ownerRow()).not.toHaveProperty("ownerAttachment");
    // a new owner starts unproven again: the previous owner's native session never carries over
    peer = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false });
    await until(() => daemon.bus.peers.get("agy")?.state === "idle", "agy re-attached");
    expect((await ownerRow()).ownerAttachment).not.toHaveProperty("nativeSessionId");
  } finally {
    peer?.close(); tools.close(); person.close(); await daemon.stop();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
