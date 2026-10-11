import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { peerRosterConfig, rosterAllows, type PeerRoster } from "../src/hub/roster.ts";
import { KNOWN_PEERS } from "../src/hub/peer-catalog.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";

async function legacyHub(root: string, enabled: boolean, roster: PeerRoster = {}, extra: Partial<HubConfig> = {}, codexAppPort = 0) {
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roster-legacy-project", controlPort: 0, codexAppPort, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, ...extra, roster, batch_ms: 0, pi: { ...DEFAULT_CONFIG.pi, enabled, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  return { daemon, client, stateDir, async close() { client.close(); await daemon.stop(); } };
}

for (const enabled of [false, true]) test(`no roster preserves lazy status, start catalog and native hello admission with pi.enabled=${enabled} (#315)`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-legacy-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const hub = await legacyHub(root, enabled), peers: ControlClient[] = [];
  try {
    expect(Object.keys((await hub.client.request({ t: "status" })).status.peers)).toEqual([]);
    const url = new URL((await hub.client.request({ t: "ui" })).url);
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST",
      headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
    const snapshot = await (await post("/snapshot", { after: 0 }, cookie)).json() as any;
    expect(snapshot.starts.map((row: any) => row.peer)).toEqual(KNOWN_PEERS.filter(peer => peer !== "pi" || enabled));
    // Claude and unrelated external ids use the existing channel; managed native ids stay reserved.
    for (const peer of KNOWN_PEERS.filter(peer => peer !== "claude")) {
      await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer })).rejects.toMatchObject({ code: 4403 });
    }
    for (const peer of ["claude", "external"]) peers.push(await ControlClient.connect(hub.stateDir, { role: "peer", peer }));
    let status: any;
    for (let n = 0; n < 100; n++) {
      status = (await hub.client.request({ t: "status" })).status;
      if (status.peers.claude?.state === "idle" && status.peers.external?.state === "idle") break;
    }
    expect(status.peers.claude.state).toBe("idle"); expect(status.peers.external.state).toBe("idle");
    expect(Object.keys(status.peers).sort()).toEqual(["claude", "external"]);
  } finally {
    for (const peer of peers) peer.close(); await hub.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

class OfflineLegacyPeer extends BasePeer {
  async deliver(_envs: Envelope[]) { throw new Error("an offline fixture is never dispatched"); }
  async start() {}
  async stop() { this.setState("offline"); }
}

test("no roster keeps a retained Pi queue row visible after restart even when Pi is disabled (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-retained-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const first = await legacyHub(root, true); let second: Awaited<ReturnType<typeof legacyHub>> | undefined;
  try {
    first.daemon.bus.add(new OfflineLegacyPeer("pi"));
    first.daemon.bus.publish(newEnvelope(USER, "retained work", { to: ["pi"] }));
    expect((await first.client.request({ t: "status" })).status.peers.pi.queued).toBe(1);
    await first.close(); second = await legacyHub(root, false);
    const status = (await second.client.request({ t: "status" })).status;
    expect(status.peers.pi).toMatchObject({ state: "offline", queued: 1 });
    expect(status.peers.pi.rostered).toBeUndefined(); // no new label in an unconfigured legacy project
    expect(second.daemon.bus.queueList("pi")).toHaveLength(1);
    expect(await second.client.request({ t: "send", to: ["pi"], body: "legacy retained target" })).toMatchObject({ ok: true });
    expect(second.daemon.bus.queued("pi")).toBe(2);
  } finally {
    await second?.close(); await first.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});


test("roster validates the closed boolean catalog and explicit Pi membership wins its legacy switch (#315)", () => {
  expect(peerRosterConfig(undefined)).toEqual({});
  for (const value of [null, [], true, { external: true }, { kimi: "false" }]) expect(() => peerRosterConfig(value)).toThrow();
  for (const enabled of [true, false]) {
    expect(rosterAllows({}, "pi", enabled)).toBe(enabled);
    expect(rosterAllows({ pi: true }, "pi", enabled)).toBe(true);
    expect(rosterAllows({ pi: false }, "pi", enabled)).toBe(false);
    for (const peer of KNOWN_PEERS.filter(p => p !== "pi")) expect(rosterAllows({}, peer, enabled)).toBe(true);
  }
  expect(rosterAllows({ claude: false }, "external", false)).toBe(true);
});

test("a confirmed live removal fences Claude admission and retains its queue until return without applying file edits (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-live-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false); let peer: ControlClient | undefined;
  try {
    peer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" });
    let status: any;
    for (let n = 0; n < 100; n++) { status = (await hub.client.request({ t: "status" })).status; if (status.peers.claude?.state === "idle") break; }
    expect(status.peers.claude.state).toBe("idle");
    // A pause prevents dispatch, so this original queue row is kept through removal and return.
    hub.daemon.bus.pause("claude");
    const original = newEnvelope(USER, "retained original", { to: ["claude"] }); hub.daemon.bus.publish(original);
    expect(hub.daemon.bus.queued("claude")).toBe(1);
    expect((await hub.client.request({ t: "settings_set", key: "roster.claude", value: false })).ok).toBe(false);
    const preview = await hub.client.request({ t: "settings_preview", key: "roster.claude", value: false });
    expect(preview.lines.join(" ")).toContain("1 queued messages are retained");
    expect(await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" })).toMatchObject({ ok: true });
    status = (await hub.client.request({ t: "status" })).status;
    expect(status.peers.claude).toMatchObject({ state: "offline", rostered: false, queued: 1 });
    expect((await hub.client.request({ t: "queue", op: "list", peer: "claude" })).deliveries[0]).toMatchObject({ rostered: false, holdReason: "off roster" });
    await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" })).rejects.toMatchObject({ code: 4000 });
    await expect(ControlClient.connect(hub.stateDir, { role: "tools", peer: "claude" })).rejects.toMatchObject({ code: 4000 });
    expect((await hub.client.request({ t: "start", peer: "claude" })).error).toContain("off roster");
    hub.daemon.bus.publish(newEnvelope(USER, "off-roster message", { to: ["claude"] }));
    expect(hub.daemon.bus.queued("claude")).toBe(1);
    expect(await hub.client.request({ t: "send", to: ["claude"], body: "refused original" })).toMatchObject({ ok: false, error: "off roster: claude" });
    const path = join(root, ".agenthub/config.local.json"), stored = JSON.parse(readFileSync(path, "utf8"));
    stored.roster.kimi = false; writeFileSync(path, JSON.stringify(stored));
    // Writing Claude's key never adopts the unrelated Kimi file edit.
    expect((await hub.client.request({ t: "settings_set", key: "roster.claude", value: true })).ok).toBe(true);
    const rows = (await hub.client.request({ t: "settings_get" })).rows;
    expect(rows.find((row: any) => row.key === "roster.kimi").value).toBe(true);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
    expect((await hub.client.request({ t: "settings_undo" })).ok).toBe(false); // removal still needs confirmation
    expect(await hub.client.request({ t: "settings_undo", confirm: "claude" })).toMatchObject({ ok: true });
    expect(hub.daemon.bus.isRostered("claude")).toBe(false);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true); // undo did not adopt the other saved key
    expect((await hub.client.request({ t: "settings_set", key: "roster.claude", value: true })).ok).toBe(true);
    expect(hub.daemon.bus.queued("claude")).toBe(1); // the independent manual pause still holds
    peer.close(); peer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" });
    expect(hub.daemon.bus.isRostered("claude")).toBe(true);
    expect(hub.daemon.bus.queueList("claude").flatMap(row => row.originals.map(env => env.id))).toContain(original.id);
  } finally { peer?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("roster writes use the existing human settings fence and dashboard authority (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-authority-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false), actors: ControlClient[] = [];
  try {
    for (const role of ["peer", "tools"] as const) {
      const actor = await ControlClient.connect(hub.stateDir, { role, peer: "external" }); actors.push(actor);
      expect((await actor.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).ok).toBe(false);
      expect((await actor.request({ t: "settings_get" })).ok).toBe(false);
    }
    const post = (origin: string, path: string, body: unknown, cookie?: string) => fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const session = async (settings: boolean) => {
      const url = new URL((await hub.client.request({ t: "ui", settings })).url);
      const cookie = (await post(url.origin, "/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
      return (action: unknown) => post(url.origin, "/action", action, cookie).then(response => response.json() as Promise<Record<string, any>>);
    };
    const ordinary = await session(false), privileged = await session(true);
    expect((await ordinary({ action: "setting", key: "roster.kimi", value: true })).ok).toBe(false);
    expect(await ordinary({ action: "setting", key: "roster.kimi", value: false, confirm: "kimi" })).toMatchObject({ ok: true });
    expect(hub.daemon.bus.isRostered("kimi")).toBe(false);
    expect((await privileged({ action: "setting", key: "roster.kimi", value: true })).ok).toBe(true);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
    const view = await hub.client.request({ t: "settings_get" });
    expect(view.roster.map((row: any) => row.peer)).toEqual(KNOWN_PEERS);
    expect(view.roster.find((row: any) => row.peer === "pi").on).toBe(false);
  } finally { for (const actor of actors) actor.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});


test("busy owned ACP removal is refused until --now stops it, and a conductor holder is never removed (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-owned-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false, {}, { kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")] });
  try {
    expect(await hub.client.request({ t: "start", peer: "kimi" })).toMatchObject({ ok: true });
    const owner = hub.daemon.bus.peers.get("kimi")!, pid = (owner as unknown as { proc: { pid: number } }).proc.pid;
    hub.daemon.bus.publish(newEnvelope(USER, "ACK_SLOW removal fixture", { to: ["kimi"] }));
    for (let n = 0; n < 100 && owner.state !== "busy"; n++) await hub.client.request({ t: "status" });
    expect(owner.state).toBe("busy");
    expect(await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).toMatchObject({ ok: false, error: "kimi is in a turn; retry when it is idle, or pass --now" });
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
    expect(await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi", now: true })).toMatchObject({ ok: true });
    expect(owner.state).toBe("offline");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await hub.client.request({ t: "start", peer: "kimi" })).toMatchObject({ ok: false, error: "kimi is off roster; a person can add it with ahub roster add kimi" });
  } finally { await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }

  const conductorRoot = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-conductor-")));
  process.env.AGENTHUB_HOME = join(conductorRoot, "home"); mkdirSync(join(conductorRoot, ".agenthub")); writeFileSync(join(conductorRoot, ".agenthub/config.json"), JSON.stringify({ roles: { codex: ["conductor", "implementer"] } }));
  const conductorHub = await legacyHub(conductorRoot, false, {}, { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "implementer"] } });
  try {
    expect(await conductorHub.client.request({ t: "settings_set", key: "roster.codex", value: false, confirm: "codex", now: true })).toMatchObject({ ok: false, error: "codex holds the conductor role; move the role before removing it" });
    expect(conductorHub.daemon.bus.isRostered("codex")).toBe(true);
  } finally { await conductorHub.close(); rmSync(conductorRoot, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("the real roster CLI uses settings for live changes, stable JSON, and refuses agent shells (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-cli-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false);
  const cli = async (args: string[], agent = false) => {
    const entry = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
    writeFileSync(wrapper, `for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"]) delete process.env[key];\nprocess.env.AGENTHUB_HOME = ${JSON.stringify(join(root, "home"))};\n${agent ? 'process.env.AGENTHUB_PEER_ID = "codex";' : ''}\nprocess.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(entry)});\n`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, COLUMNS: "80" } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const first = await cli(["roster", "--json"]); expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual((await hub.client.request({ t: "settings_get" })).roster);
    expect(first.stdout).toBe((await cli(["roster", "--json"])).stdout);
    expect((await cli(["roster", "--color=never"])).stdout).toContain("ROSTER");
    expect((await cli(["roster", "remove", "kimi"])).code).toBe(1);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
    expect((await cli(["roster", "remove", "kimi", "--yes"])).code).toBe(0);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(false);
    expect((await cli(["roster", "add", "kimi"])).code).toBe(0);
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
    for (const args of [["roster", "--json"], ["roster", "remove", "kimi", "--yes"], ["roster", "add", "kimi"], ["settings", "set", "roster.kimi", "false", "--yes"]]) {
      const refused = await cli(args, true); expect(refused.code).toBe(1); expect(refused.stderr).toContain("console");
    }
    expect(hub.daemon.bus.isRostered("kimi")).toBe(true);
  } finally { await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("removal clears an ACP runtime permission override and return takes the configured default (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-mode-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false, {}, { kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")] });
  try {
    expect(await hub.client.request({ t: "start", peer: "kimi" })).toMatchObject({ ok: true });
    expect(await hub.client.request({ t: "permission", peer: "kimi", mode: "ask-when-needed" })).toMatchObject({ ok: true, permissionMode: "ask-when-needed" });
    expect(await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).toMatchObject({ ok: true });
    expect(await hub.client.request({ t: "settings_set", key: "roster.kimi", value: true })).toMatchObject({ ok: true });
    expect(await hub.client.request({ t: "start", peer: "kimi" })).toMatchObject({ ok: true });
    expect(await hub.client.request({ t: "permission", peer: "kimi" })).toMatchObject({ ok: true, permissionMode: "ask" });
    expect((hub.daemon.bus.peers.get("kimi") as unknown as { getPermissionMode(): string }).getPermissionMode()).toBe("ask");
  } finally { await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});


test("daemon roster removal detaches Codex without killing its app-server and gates its real proxy until return (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-codex-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const bin = join(root, "codex-fake"), fake = join(import.meta.dir, "fakes/codex-bin.ts");
  writeFileSync(bin, `#!/usr/bin/env bun\nawait import(${JSON.stringify(fake)});\n`, { mode: 0o755 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reservation.port as number; reservation.stop(true);
  const hub = await legacyHub(root, false, {}, { codex_bin: bin }, port), sockets: WebSocket[] = [];
  const attach = async (url: string) => { const socket = new WebSocket(url); sockets.push(socket); await new Promise<void>(resolve => { socket.onopen = () => resolve(); }); return socket; };
  try {
    expect(await hub.client.request({ t: "start", peer: "codex" })).toMatchObject({ ok: true });
    const owner = hub.daemon.bus.peers.get("codex") as unknown as { proxyUrl: string; proc: { pid: number } }, pid = owner.proc.pid;
    const socket = await attach(owner.proxyUrl), seen: any[] = []; socket.onmessage = event => seen.push(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "daemon-roster-tui" } } }));
    socket.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    for (let n = 0; n < 200 && !seen.some(row => row.id === 2); n++) await hub.client.request({ t: "status" });
    expect(seen.find(row => row.id === 2).result.thread.id).toBe("th1");
    const detached = new Promise<number>(resolve => { socket.onclose = event => resolve(event.code); });
    expect(await hub.client.request({ t: "settings_set", key: "roster.codex", value: false, confirm: "codex" })).toMatchObject({ ok: true });
    expect(await detached).toBe(4000); expect(() => process.kill(pid, 0)).not.toThrow();
    const denied = new WebSocket(owner.proxyUrl); sockets.push(denied); expect(await new Promise<number>(resolve => { denied.onclose = event => resolve(event.code); })).toBe(4000);
    expect(await hub.client.request({ t: "settings_set", key: "roster.codex", value: true })).toMatchObject({ ok: true });
    const returned = await attach(owner.proxyUrl), returnedRows: any[] = []; returned.onmessage = event => returnedRows.push(JSON.parse(String(event.data)));
    returned.send(JSON.stringify({ id: 3, method: "initialize", params: { clientInfo: { name: "returned-roster-tui" } } })); returned.send(JSON.stringify({ id: 4, method: "thread/start", params: {} }));
    for (let n = 0; n < 200 && !returnedRows.some(row => row.id === 4); n++) await hub.client.request({ t: "status" });
    expect(returnedRows.find(row => row.id === 4).result.thread.id).toBe("th1"); expect(() => process.kill(pid, 0)).not.toThrow();
  } finally { for (const socket of sockets) socket.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});


test("the same Claude channel client retries removal and reconnects by itself after return (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-channel-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false), client = new Client({ name: "roster-channel-fixture", version: "0" }, { capabilities: {} });
  const pushed: any[] = []; client.fallbackNotificationHandler = async notification => { pushed.push(notification); };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/claude-channel.ts")], env: { ...(process.env as Record<string, string>), AGENTHUB_STATE_DIR: hub.stateDir, AGENTHUB_PEER_ID: "claude", AGENTHUB_CHANNEL: "1", AGENTHUB_MODE: "peer" }, stderr: "pipe" });
  let diagnostics = ""; transport.stderr!.on("data", chunk => { diagnostics += String(chunk); });
  const observed = async (condition: () => boolean) => { const deadline = Date.now() + 10_000; while (!condition() && Date.now() < deadline) await Bun.sleep(10); expect(condition()).toBe(true); };
  try {
    await client.connect(transport); await observed(() => diagnostics.includes('connected to hub as "claude"'));
    expect((await client.listTools()).tools.some(tool => tool.name.includes("roster"))).toBe(false);
    expect(await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" })).toMatchObject({ ok: true });
    await observed(() => diagnostics.includes("standing by: claude is off roster"));
    const refused = await client.callTool({ name: "hub_send", arguments: { text: "must not publish while removed" } });
    expect(JSON.stringify(refused)).toContain("off roster");
    expect(await hub.client.request({ t: "settings_set", key: "roster.claude", value: true })).toMatchObject({ ok: true });
    await observed(() => diagnostics.split('connected to hub as "claude"').length - 1 === 2);
    const message = newEnvelope(USER, "one message after automatic return", { to: ["claude"] }); hub.daemon.bus.publish(message);
    await observed(() => pushed.some(notification => notification.params?.meta?.message_id === message.id));
    expect(pushed.filter(notification => notification.params?.meta?.message_id === message.id)).toHaveLength(1);
    expect((await hub.client.request({ t: "status" })).status.peers.claude).toMatchObject({ state: "idle", queued: 0 });
  } finally { await client.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
}, 20_000); // Covers MCP startup and the channel's existing reconnect backoff; every wait asserts its observed milestone.
