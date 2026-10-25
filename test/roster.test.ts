import { FakeMemoryClient } from "./fakes/mem-worker.ts";
import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { peerRosterConfig, rosterAllows, staleInstanceKey, type PeerRoster } from "../src/hub/roster.ts";
import { KNOWN_PEERS } from "../src/hub/peer-catalog.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";

async function legacyHub(root: string, enabled: boolean, roster: PeerRoster = {}, extra: Partial<HubConfig> = {}, codexAppPort = 0, hooks: { taskSweepNow?: () => number } = {}) {
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ ...(extra.memory?.worker_url ? { memoryClient: new FakeMemoryClient(extra.memory.worker_url) } : {}), boundedTools: emulatedBoundedTools(), ...hooks, cwd: root, stateDir, projectId: "roster-legacy-project", controlPort: 0, codexAppPort, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, ...extra, roster, batch_ms: 0, pi: { ...DEFAULT_CONFIG.pi, enabled, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, ...extra.memory, enabled: extra.memory?.enabled ?? false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
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
    expect(rosterAllows({}, "pi", enabled, undefined, builtinProjectCatalog())).toBe(enabled);
    expect(rosterAllows({ pi: true }, "pi", enabled, undefined, builtinProjectCatalog())).toBe(true);
    expect(rosterAllows({ pi: false }, "pi", enabled, undefined, builtinProjectCatalog())).toBe(false);
    for (const peer of KNOWN_PEERS.filter(p => p !== "pi")) expect(rosterAllows({}, peer, enabled, undefined, builtinProjectCatalog())).toBe(true);
  }
  expect(rosterAllows({ claude: false }, "external", false, undefined, builtinProjectCatalog())).toBe(true);
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
    expect(hub.daemon.bus.queued("claude")).toBe(2);
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
    expect(hub.daemon.bus.queued("claude")).toBe(2); // the independent manual pause still holds
    peer.close(); peer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" });
    expect(hub.daemon.bus.isRostered("claude")).toBe(true);
    expect(hub.daemon.bus.queueList("claude").flatMap(row => row.originals.map(env => env.id))).toContain(original.id);

    // Observe exact-key authority while removal is suspended, before its final reload can repair a broad write.
    let releaseStop!: () => void, stopEntered = false;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    class HeldKimi extends AcpPeer {
      constructor() { super("kimi", { cmd: ["unused-in-process-fixture"], cwd: root }); }
      override async start() { this.setState("idle"); }
      override async deliver(_envelopes: Envelope[]) { throw new Error("the held-stop fixture receives no work"); }
      override async stop() { stopEntered = true; await stopGate; this.setState("offline"); }
    }
    const kimi = new HeldKimi(); hub.daemon.bus.add(kimi); await kimi.start();
    const edited = JSON.parse(readFileSync(path, "utf8")); edited.roster.codex = false;
    writeFileSync(path, JSON.stringify(edited));
    const removal = hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" });
    void removal.catch(() => {}); // Always consume a teardown rejection, including an assertion's early exit.
    let codex: ControlClient | undefined;
    try {
      const deadline = Date.now() + 1500;
      while (!stopEntered && Date.now() < deadline) await hub.client.request({ t: "status" });
      expect(stopEntered).toBe(true);
      expect(hub.daemon.bus.isRostered("codex")).toBe(true);
      codex = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "codex" });
      expect((await codex.request({ t: "status" })).status.projectId).toBe("roster-legacy-project");
    } finally { codex?.close(); releaseStop(); await removal; }
    expect(await removal).toMatchObject({ ok: true });
    expect(hub.daemon.bus.isRostered("codex")).toBe(true);
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
    expect(await privileged({ action: "setting_undo", confirm: "kimi" })).toMatchObject({ ok: true });
    expect(hub.daemon.bus.isRostered("kimi")).toBe(false);
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
    const preview = await hub.client.request({ t: "settings_preview", key: "roster.kimi", value: false });
    expect(preview.lines.join("\n")).toContain("ahub roster remove kimi --now");
    expect(preview.lines.join("\n")).toContain("during the active turn");
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
    const codex = new RosterReplacementPeer("codex"); hub.daemon.bus.add(codex); await codex.start();
    const hostile = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title: "\x1b[31mTerminal hostile title\x1b[0m", class: "implement", owner: "codex" } });
    expect(hostile.ok).toBe(true);
    const preview = await cli(["settings", "set", "roster.codex", "false", "--preview"]);
    expect(preview.code).toBe(0); expect(preview.stdout).toContain("Terminal hostile title"); expect(preview.stdout).not.toContain("\x1b");
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
    // #812 moved the bare roster read to Allowed, so an agent shell no longer refuses `roster --json`; only the writes keep the refusal.
    for (const args of [["roster", "remove", "kimi", "--yes"], ["roster", "add", "kimi"], ["settings", "set", "roster.kimi", "false", "--yes"]]) {
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
    const owner = hub.daemon.bus.peers.get("codex") as unknown as { proxyUrl: string; proc: { pid: number }; thread: string; proxyAttached: boolean }, pid = owner.proc.pid;
    const socket = await attach(owner.proxyUrl), seen: any[] = []; socket.onmessage = event => seen.push(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "daemon-roster-tui" } } }));
    socket.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    for (let n = 0; n < 200 && !seen.some(row => row.id === 2); n++) await hub.client.request({ t: "status" });
    expect(seen.find(row => row.id === 2).result.thread.id).toBe("th1");
    const preview = await hub.client.request({ t: "settings_preview", key: "roster.codex", value: false });
    expect(preview.lines.join("\n")).toContain("Codex 0.146.0 exits its TUI on disconnect and does not reconnect automatically");
    expect(preview.lines.join("\n")).toContain("resume the previous session with ahub codex resume th1");
    const detached = new Promise<number>(resolve => { socket.onclose = event => resolve(event.code); });
    const removed = await hub.client.request({ t: "settings_set", key: "roster.codex", value: false, confirm: "codex" });
    expect(removed).toMatchObject({ ok: true });
    expect(removed.text).toContain("Codex 0.146.0 exits its TUI on disconnect");
    expect(removed.text).toContain("resume the previous session with ahub codex resume th1");
    expect(await detached).toBe(4000); expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await hub.client.request({ t: "status" })).status.peers.codex?.state ?? "offline").toBe("offline");
    const denied = new WebSocket(owner.proxyUrl); sockets.push(denied); expect(await new Promise<number>(resolve => { denied.onclose = event => resolve(event.code); })).toBe(4000);
    const restored = await hub.client.request({ t: "settings_set", key: "roster.codex", value: true });
    expect(restored).toMatchObject({ ok: true });
    expect(restored.text).toContain("resume the previous native session with ahub codex resume th1");
    expect(owner.proxyAttached).toBe(false); expect(hub.daemon.bus.stateOf("codex")).toBe("offline");
    const returned = await attach(owner.proxyUrl), returnedRows: any[] = []; returned.onmessage = event => returnedRows.push(JSON.parse(String(event.data)));
    returned.send(JSON.stringify({ id: 3, method: "initialize", params: { clientInfo: { name: "returned-roster-tui" } } })); returned.send(JSON.stringify({ id: 4, method: "thread/resume", params: { threadId: "th1" } }));
    for (let n = 0; n < 200 && !returnedRows.some(row => row.id === 4); n++) await hub.client.request({ t: "status" });
    expect(returnedRows.find(row => row.id === 4).result.thread.id).toBe("th1"); expect(owner.thread).toBe("th1"); expect(() => process.kill(pid, 0)).not.toThrow();
  } finally { for (const socket of sockets) socket.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});


test("the same Claude channel client retries removal and reconnects by itself after return (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-channel-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false), client = new Client({ name: "roster-channel-fixture", version: "0" }, { capabilities: {} });
  const pushed: any[] = []; client.fallbackNotificationHandler = async notification => { pushed.push(notification); };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../plugins/agent-hub/server.js")], env: { ...(process.env as Record<string, string>), AGENTHUB_STATE_DIR: hub.stateDir, AGENTHUB_PEER_ID: "claude", AGENTHUB_CHANNEL: "1", AGENTHUB_MODE: "peer" }, stderr: "pipe" });
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

class RosterReplacementPeer extends BasePeer {
  got: Envelope[] = [];
  async deliver(envs: Envelope[], deliveryId?: string) { this.got.push(...envs); if (deliveryId) { this.delivery({ id: deliveryId, state: "accepted" }); this.delivery({ id: deliveryId, state: "completed" }); } }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

test("native removal preview and result name the retained terminal and list its saved task handoff (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-stop-text-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const roles = { ...DEFAULT_CONFIG.roles, claude: ["implementer", "reviewer"] };
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roles }));
  const hub = await legacyHub(root, false, {}, { roles }); let actor: ControlClient | undefined;
  try {
    actor = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" });
    const replacement = new RosterReplacementPeer("codex"); hub.daemon.bus.add(replacement); await replacement.start();
    for (let n = 0; n < 100 && hub.daemon.bus.stateOf("claude") !== "idle"; n++) await hub.client.request({ t: "status" });
    expect(hub.daemon.bus.stateOf("claude")).toBe("idle");
    const title = "Move retained terminal work";
    const proposed = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title, class: "implement", owner: "claude" } });
    expect(proposed).toMatchObject({ ok: true }); expect(proposed.text).toContain("owner claude");
    const id = Number(proposed.text.match(/task #(\d+)/)![1]);
    const preview = await hub.client.request({ t: "settings_preview", key: "roster.claude", value: false });
    const instruction = "Stop claude's existing work in its retained terminal; removal detaches the hub connection and does not stop that terminal's work.";
    expect(preview.lines).toContain(instruction); expect(preview.lines.join("\n")).toContain(`task #${id} ${title}`);
    const removed = await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" });
    expect(removed).toMatchObject({ ok: true, handoff: [{ id, title: `#${id} ${title}`, to: "codex", role: "owner" }] });
    expect(removed.text).toContain(instruction); expect(removed.text).toContain(`task #${id} ${title}: owner assignment moved to codex`);
    expect(hub.daemon.bus.stateOf("claude")).toBe("offline");
    const shown = await hub.client.request({ t: "task", op: "task_show", args: { id } }); expect(JSON.parse(shown.text).owner).toBe("codex");
  } finally { actor?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

async function rosterDashboard(hub: Awaited<ReturnType<typeof legacyHub>>, settings = false) {
  const url = new URL((await hub.client.request({ t: "ui", settings })).url);
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
  return { action: (body: unknown) => post("/action", body, cookie).then(response => response.json() as Promise<any>), snapshot: () => post("/snapshot", { after: 0 }, cookie).then(response => response.json() as Promise<any>) };
}

test("existing tools socket, conductor start, dashboard send and empty status all obey removal (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-fences-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const roles = { ...DEFAULT_CONFIG.roles, codex: ["conductor", "implementer"] };
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roles }));
  const hub = await legacyHub(root, false, {}, { roles }); let tools: ControlClient | undefined, conductor: ControlClient | undefined;
  try {
    tools = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "claude" });
    conductor = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "codex" });
    hub.daemon.bus.add(new OfflineLegacyPeer("claude"));
    expect(await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" })).toMatchObject({ ok: true });
    expect(await tools.request({ t: "status" })).toMatchObject({ ok: false, error: "claude is off roster" });
    expect((await hub.client.request({ t: "status" })).status.peers.claude).toBeUndefined();
    const start = await conductor.request({ t: "task", op: "hub_peer_start", args: { peer: "claude" } });
    expect(start.ok).toBe(false); expect(start.text ?? start.error).toContain("off roster");
    const dashboard = await rosterDashboard(hub);
    expect(await dashboard.action({ action: "send", to: ["claude"], body: "dashboard refused" })).toMatchObject({ ok: false, error: "off roster: claude" });
    expect(hub.daemon.bus.queued("claude")).toBe(0);
    expect(await dashboard.action({ action: "start_peer", peer: "claude" })).toMatchObject({ ok: false, error: "claude is off roster; a person can add it with ahub roster add claude" });
  } finally { tools?.close(); conductor?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("mixed console and dashboard audiences retain removed recipients with one public notice and a visible sender result (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-mixed-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false); const permitted = new RosterReplacementPeer("codex"); hub.daemon.bus.add(permitted); await permitted.start();
  try {
    await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" });
    const sent = await hub.client.request({ t: "send", to: ["kimi", "codex"], body: "mixed retained work" });
    expect(sent).toMatchObject({ ok: true, targets: ["kimi", "codex"], notice: "retained off roster for kimi" });
    const dashboard = await rosterDashboard(hub);
    expect(await dashboard.action({ action: "send", to: ["kimi", "codex"], body: "dashboard mixed retained" })).toMatchObject({ ok: true, text: "retained off roster for kimi" });
    expect(hub.daemon.bus.queueList("kimi").flatMap(row => row.originals.map(env => env.body))).toEqual(["mixed retained work", "dashboard mixed retained"]);
    expect((await hub.client.request({ t: "status" })).status.peers.kimi).toMatchObject({ rostered: false, queued: 2 });
    const log = readFileSync(join(hub.stateDir, "hub.log"), "utf8");
    expect(log.split("\n").filter(line => line.includes("Message retained off roster for kimi"))).toHaveLength(2);
    await hub.client.request({ t: "settings_set", key: "roster.kimi", value: true });
    const returned = new RosterReplacementPeer("kimi"); hub.daemon.bus.add(returned); await returned.start();
    await hub.client.request({ t: "status" });
    expect(returned.got.map(env => env.body)).toEqual(["mixed retained work", "dashboard mixed retained"]);
    expect(hub.daemon.bus.queued("kimi")).toBe(0);
  } finally { await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("an irreplaceable removed reviewer retains the later review request and verdict until return (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-review-retained-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const roles = { codex: ["implementer"], claude: ["reviewer"] };
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roles }));
  const hub = await legacyHub(root, false, {}, { roles }); let reviewer: ControlClient | undefined;
  try {
    reviewer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude", channel: false });
    const owner = new RosterReplacementPeer("codex"); hub.daemon.bus.add(owner); await owner.start();
    const proposed = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title: "retained review", class: "implement", owner: "codex" } });
    const id = Number(proposed.text.match(/task #(\d+)/)![1]);
    const removed = await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" });
    expect(removed.text).toContain(`task #${id} retained review stays with claude as reviewer`);
    const actor = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "codex" });
    try {
      expect((await actor.request({ t: "task", op: "hub_task_accept", args: { id } })).ok).toBe(true);
      expect((await actor.request({ t: "task", op: "hub_task_done", args: { id, summary: "complete retained review" } })).ok).toBe(true);
    } finally { actor.close(); }
    const requests = hub.daemon.bus.queueList("claude").flatMap(row => row.originals).filter(env => env.kind === "review" && env.refs?.task === String(id));
    expect(requests).toHaveLength(1);
    await hub.client.request({ t: "settings_set", key: "roster.claude", value: true });
    reviewer.close(); reviewer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude", channel: false });
    const inbox = await reviewer.request({ t: "inbox" }); expect(JSON.stringify(inbox)).toContain(requests[0]!.id);
    expect((await reviewer.request({ t: "task", op: "hub_review", args: { id, verdict: "changes_requested", note: "retained verdict" } })).ok).toBe(true);
    expect(owner.got.some(env => env.body.includes("retained verdict"))).toBe(true);
  } finally { reviewer?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("a late preface completion cannot attach an off-roster claimant (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-preface-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { began = resolve; });
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/context/inject") { began(); await gate; return new Response("# [fixture]\n### Today\ncontext"); }
    return Response.json({ status: "ok" });
  } });
  const hub = await legacyHub(root, false, {}, { memory: { ...DEFAULT_CONFIG.memory, enabled: true, worker_url: `http://127.0.0.1:${memory.port}` } }); let peer: ControlClient | undefined;
  try {
    peer = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" }); await seen;
    const owner = hub.daemon.bus.peers.get("claude")! as any;
    let attached = 0; const attach = owner.attach.bind(owner); owner.attach = (socket: unknown) => { attached++; attach(socket); };
    // Hold transport teardown to isolate the late-admission check from the independent close/claim fences.
    const detach = owner.detachForRoster; owner.detachForRoster = () => {};
    try {
      expect(await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" })).toMatchObject({ ok: true });
      release();
      // The preface is installed synchronously before ensurePreface returns; a subsequent control round trip
      // consumes the continuation too. No timing assumption about the memory HTTP response is needed.
      for (let n = 0; n < 100 && !hub.daemon.bus.snapshot().prefaces.claude; n++) await hub.client.request({ t: "status" });
      expect(hub.daemon.bus.snapshot().prefaces.claude).toBeDefined(); await hub.client.request({ t: "status" });
      expect(attached).toBe(0); expect(owner.state).toBe("offline");
    } finally { owner.detachForRoster = detach; owner.detachForRoster(); }
  } finally { release(); peer?.close(); await hub.close(); memory.stop(true); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("native terminal removal cancels its pending approval before any transport teardown (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-approval-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false, {}, { kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")] }); let terminal: ControlClient | undefined;
  try {
    await hub.client.request({ t: "start", peer: "kimi" });
    terminal = await ControlClient.connect(hub.stateDir, { role: "peer", peer: "claude" });
    for (let n = 0; n < 100 && hub.daemon.bus.stateOf("claude") !== "idle"; n++) await hub.client.request({ t: "status" });
    const callback = (hub.daemon.bus.peers.get("kimi") as any).opts.onPermission;
    // The configured daemon callback is the same approval boundary used by the native adapters.
    const pending = callback({ peer: "claude", title: "approval pending in retained terminal", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] });
    const dashboard = await rosterDashboard(hub); let snapshot: any;
    for (let n = 0; n < 100; n++) { snapshot = await dashboard.snapshot(); if (snapshot.permissions.length) break; }
    expect(snapshot.permissions).toHaveLength(1); const id = snapshot.permissions[0].id;
    const owner = hub.daemon.bus.peers.get("claude")! as any;
    const detach = owner.detachForRoster; owner.detachForRoster = () => {};
    try {
      await hub.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" });
      expect((await dashboard.snapshot()).permissions).toEqual([]);
      expect(await dashboard.action({ action: "permit", id, option: "yes" })).toMatchObject({ ok: false });
      expect(await pending).toBeUndefined();
    } finally { owner.detachForRoster = detach; owner.detachForRoster(); }
  } finally { terminal?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("removal hands over in-review ownership and routes the later verdict to the new owner (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-review-owner-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const roles = { kimi: ["implementer"], codex: ["implementer"], claude: ["reviewer"] };
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roles }));
  const hub = await legacyHub(root, false, {}, { roles, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")] }), actors: ControlClient[] = [];
  try {
    expect((await hub.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
    const replacement = new RosterReplacementPeer("codex");
    for (const peer of [replacement, new RosterReplacementPeer("claude")]) { hub.daemon.bus.add(peer); await peer.start(); }
    const actor = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "kimi" }); actors.push(actor);
    const reviewer = await ControlClient.connect(hub.stateDir, { role: "tools", peer: "claude" }); actors.push(reviewer);
    const proposed = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title: "reviewing owner removal", class: "implement", owner: "kimi" } });
    const id = Number(proposed.text.match(/task #(\d+)/)![1]);
    await actor.request({ t: "task", op: "hub_task_accept", args: { id } });
    expect((await actor.request({ t: "task", op: "hub_task_done", args: { id, summary: "review me" } })).ok).toBe(true);
    expect((await hub.client.request({ t: "settings_preview", key: "roster.kimi", value: false })).lines.join("\n")).toContain(`task #${id} reviewing owner removal: owner offered to codex`);
    for (let n = 0; n < 200 && hub.daemon.bus.peers.get("kimi")!.state !== "idle"; n++) await hub.client.request({ t: "status" });
    expect(hub.daemon.bus.peers.get("kimi")!.state).toBe("idle");
    expect(await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" })).toMatchObject({ ok: true, handoff: [{ id, title: `#${id} reviewing owner removal`, to: "codex", role: "owner" }] });
    expect(JSON.parse((await hub.client.request({ t: "task", op: "task_show", args: { id } })).text)).toMatchObject({ owner: "codex", state: "in_review", reviewer: "claude" });
    expect((await reviewer.request({ t: "task", op: "hub_review", args: { id, verdict: "changes_requested", note: "later verdict for replacement" } })).ok).toBe(true);
    await hub.client.request({ t: "status" });
    expect(replacement.got.filter(env => env.body.includes("later verdict for replacement"))).toHaveLength(1);
    expect(hub.daemon.bus.queueList("kimi").flatMap(row => row.originals).some(env => env.body.includes("later verdict for replacement"))).toBe(false);
  } finally { actors.forEach(actor => actor.close()); await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("an unconfirmed owned stop reports the skipped steps and the saved roster (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-stop-failure-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const hub = await legacyHub(root, false), owner = new RosterReplacementPeer("kimi"); hub.daemon.bus.add(owner); await owner.start();
  const stop = owner.stop.bind(owner); owner.stop = async () => { throw new Error("fixture stop refusal"); };
  try {
    const result = await hub.client.request({ t: "settings_set", key: "roster.kimi", value: false, confirm: "kimi" });
    expect(result).toMatchObject({ ok: false, saved: true });
    expect(result.error).toContain("permission reset and task handoff were not attempted");
    expect(result.error).toContain("reapply roster.kimi false to retry"); expect(hub.daemon.bus.isRostered("kimi")).toBe(false);
  } finally { owner.stop = stop; await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("recovery commit and release preserve an off-roster peer's retained work for one return (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-recovery-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const first = await legacyHub(root, false); let second: Awaited<ReturnType<typeof legacyHub>> | undefined;
  try {
    first.daemon.bus.add(new OfflineLegacyPeer("claude"));
    await first.client.request({ t: "settings_set", key: "roster.claude", value: false, confirm: "claude" });
    const original = newEnvelope("hub", "retained recovery review", { to: ["claude"], kind: "review", priority: "important" }); first.daemon.bus.publish(original);
    const instance = (await first.client.request({ t: "status" })).status.instanceId;
    expect((await first.client.request({ t: "recovery", op: "prepare", operationId: "roster-recovery", expectedInstanceId: instance })).recovery.phase).toBe("prepared");
    expect((await first.client.request({ t: "recovery", op: "commit", operationId: "roster-recovery", expectedInstanceId: instance })).committed).toBe(true);
    await first.daemon.stopped;
    const recovery = process.env.AGENTHUB_RECOVERY_OPERATION;
    try { process.env.AGENTHUB_RECOVERY_OPERATION = "roster-recovery"; second = await legacyHub(root, false, { claude: false }); }
    finally { if (recovery === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = recovery; }
    const targetInstance = (await second.client.request({ t: "status" })).status.instanceId;
    expect((await second.client.request({ t: "recovery", op: "inspect", expectedInstanceId: targetInstance })).recovery.integrity.current).toEqual((await second.client.request({ t: "recovery", op: "inspect", expectedInstanceId: targetInstance })).recovery.integrity.expected);
    expect((await second.client.request({ t: "recovery", op: "release", operationId: "roster-recovery", expectedInstanceId: targetInstance })).released).toBe(true);
    expect((await second.client.request({ t: "status" })).status.peers.claude).toMatchObject({ rostered: false, queued: 1 });
    expect(second.daemon.bus.queueList("claude").flatMap(row => row.originals.map(env => env.id))).toEqual([original.id]);
    await second.client.request({ t: "settings_set", key: "roster.claude", value: true });
    const returned = new RosterReplacementPeer("claude"); second.daemon.bus.add(returned); await returned.start();
    await second.client.request({ t: "status" }); expect(returned.got.filter(env => env.id === original.id)).toHaveLength(1);
    expect(second.daemon.bus.queued("claude")).toBe(0);
  } finally { await second?.close(); await first.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});

test("daemon escalation, idle sweep and digest routing skip an off-roster candidate (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-sweep-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home"); mkdirSync(join(root, ".agenthub"));
  const roles = { claude: ["implementer", "reviewer"], codex: ["implementer"], kimi: ["implementer"], local: ["implementer"] };
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roles }));
  writeFileSync(join(root, ".agenthub/routing.toml"), '[local]\nfixed_model = "dgx/coding"\n[classes.implement]\npeers = ["claude", "kimi", "codex", "local"]\nescalate_to = ["kimi", "local"]\nlocal_allowed = true\n');
  let now = Date.now();
  const sweep = { ...DEFAULT_CONFIG.task_sweep, enabled: true, interval_s: 1, unaccepted_min: 1, ladder_min: 1, auto_reassign: true };
  const hub = await legacyHub(root, false, { kimi: false }, { roles, task_sweep: sweep }, 0, { taskSweepNow: () => now });
  const peers = Object.fromEntries(["claude", "codex", "local", "kimi"].map(id => [id, new RosterReplacementPeer(id)]));
  const view = async (id: number) => JSON.parse((await hub.client.request({ t: "task", op: "task_show", args: { id } })).text);
  try {
    for (const peer of Object.values(peers)) { hub.daemon.bus.add(peer); await peer.start(); }
    const proposed = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title: "escalate away from removed", class: "implement", owner: "claude" } });
    expect(proposed).toMatchObject({ ok: true });
    const id = Number(proposed.text.match(/task #(\d+)/)![1]);
    expect((await hub.client.request({ t: "task", op: "task_escalate", args: { id, reason: "manual roster probe" } })).ok).toBe(true);
    expect((await view(id)).owner).toBe("local");
    // The sweeper runs on its real interval; the supplied clock moves only after its recorded step arrives.
    const offered = await hub.client.request({ t: "task", op: "hub_task_propose", args: { title: "sweep away from removed", class: "implement", owner: "codex" } });
    const sweeping = Number(offered.text.match(/task #(\d+)/)![1]); let shown: any;
    for (const step of [1, 2, 3]) {
      now += 120_000;
      const deadline = Date.now() + 5000;
      do { shown = await view(sweeping); if (shown.history.some((entry: any) => entry.sweep?.step === step)) break; await Bun.sleep(10); } while (Date.now() < deadline);
      expect(shown.history.some((entry: any) => entry.sweep?.step === step)).toBe(true);
    }
    expect((await view(sweeping)).owner).not.toBe("kimi"); expect((await view(sweeping)).owner).not.toBe("codex");
    hub.daemon.bus.pause("claude");
    for (const body of ["digest first", "digest second"]) hub.daemon.bus.publish(newEnvelope(USER, body));
    const before = peers.claude!.got.length; hub.daemon.bus.resume("claude"); await hub.client.request({ t: "status" });
    expect(peers.claude!.got.slice(before).map(env => env.body)).toEqual(["digest first", "digest second"]);
    expect(peers.kimi!.got).toEqual([]); expect(hub.daemon.bus.queued("kimi")).toBe(0);
  } finally { await hub.close(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
}, 20_000);

// #225: an instance that was declared, put on the roster and later undeclared leaves a roster key behind. The config must still load
// (a stale key is inert), a key that never named an instance stays an error, and the key can be removed.
test("a roster key of an undeclared instance loads as inert, a key that never named an instance still fails (#225)", () => {
  const catalog = builtinProjectCatalog();
  const roster = peerRosterConfig({ "codex-2": false, "kimi-a": true, codex: true }, undefined, catalog);
  expect(roster).toEqual({ "codex-2": false, "kimi-a": true, codex: true });
  // Inert: it decides nothing for a peer the project does not declare, so no unrelated id is admitted or refused by it.
  expect(rosterAllows(roster, "codex-2", false, undefined, catalog)).toBe(true);
  for (const bad of ["external-1", "unsupported", "codex-", "codex--", "Codex-2", "codex-2/x", "__proto__", "constructor", "claude-" + "x".repeat(40)]) {
    expect(() => peerRosterConfig({ [bad]: false }, undefined, catalog), bad).toThrow("unsupported peer");
  }
  expect(() => peerRosterConfig({ "codex-2": "false" }, undefined, catalog)).toThrow("must be a boolean");
});

// #225 review: eligibility is the policy validateInstances applies, not "starts with a builtin kind and a dash". A Jcode instance
// (#685) cannot be declared without its own `jcode_home`, and the fixed declaration shapes carry none, so `roster.jcode-worker`
// is still an unsupported peer (a typo) unless the person declared it: a declared one is a declared instance, not a stale key.
test("only a kind that can declare an extra instance makes a stale roster key (#225)", () => {
  const catalog = builtinProjectCatalog();
  for (const kind of ["codex", "kimi", "pi", "local", "qwen", "claude", "agy"]) expect(peerRosterConfig({ [`${kind}-worker`]: true }, undefined, catalog), kind).toEqual({ [`${kind}-worker`]: true });
  expect(() => peerRosterConfig({ "jcode-worker": true }, undefined, catalog)).toThrow("unsupported peer");
  expect(staleInstanceKey("jcode-worker", catalog)).toBe(false);
  expect(staleInstanceKey("codex-worker", catalog)).toBe(true);
});

test("a stale roster key can be previewed and removed through the daemon, and removing it writes nothing else (#225)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-stale-remove-"))), stateDir = join(root, ".agenthub/state"), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  hubGitSync(["init", "-q", root], { encoding: "utf8" }); writeFileSync(join(root, ".gitignore"), ".agenthub/\n"); mkdirSync(join(root, ".agenthub"));
  const file = join(root, ".agenthub/config.local.json");
  const base = { memory: { enabled: false }, pi: { enabled: false, auto_start: false }, snapshots: { enabled: false } };
  writeFileSync(file, JSON.stringify({ ...base, roster: { "codex-2": true, "codex-3": true, kimi: true } }));
  // No embedded config: a real hub reads its roster from the files, which is where the stale key lives.
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  try {
    // The hub started although the file names an instance nobody declares, and the stale key decides nothing.
    const preview: any = await client.request({ t: "settings_preview", key: "roster.codex-2", value: null });
    expect(preview.ok, String(preview.error)).toBe(true);
    expect(preview.lines.join("\n")).toContain("no longer declared");
    const removed: any = await client.request({ t: "settings_set", key: "roster.codex-2", value: null, confirm: "codex-2", now: false });
    expect(removed.ok, String(removed.error)).toBe(true);
    // Only that key left the file; the rest of the roster is as it was, and a second removal has nothing to do.
    expect(JSON.parse(readFileSync(file, "utf8")).roster).toEqual({ "codex-3": true, kimi: true });
    // A key that never named an instance is still an unknown setting.
    expect(((await client.request({ t: "settings_set", key: "roster.external-1", value: null, confirm: "external-1", now: false })) as any).ok).toBe(false);
    // A stale key is removed, never set: there is no peer behind it to switch on or off.
    for (const value of [true, false]) {
      const set: any = await client.request({ t: "settings_set", key: "roster.codex-3", value, confirm: "codex-3", now: false });
      expect(set.ok, "setting a stale key to " + value).toBe(false); expect(String(set.error)).toContain("it can only be removed");
    }
    // Nor can a stale key be turned into a way to widen or narrow a real peer.
    expect(((await client.request({ t: "settings_set", key: "roster.codex", value: null, confirm: "codex", now: false })) as any).error ?? "").not.toContain("no longer declared");
  } finally {
    client.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
}, 30000);

// #225 review: where the stale key lives decides what a removal can do and say.
async function staleHub(shared: object | undefined, local: object | undefined, body: (client: any, files: { shared: string; local: string }) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-stale-layer-"))), stateDir = join(root, ".agenthub/state"), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  hubGitSync(["init", "-q", root], { encoding: "utf8" }); writeFileSync(join(root, ".gitignore"), ".agenthub/\n"); mkdirSync(join(root, ".agenthub"));
  const files = { shared: join(root, ".agenthub/config.json"), local: join(root, ".agenthub/config.local.json") };
  const base = { memory: { enabled: false }, pi: { enabled: false, auto_start: false }, snapshots: { enabled: false } };
  writeFileSync(files.shared, JSON.stringify({ ...base, ...shared })); if (local) writeFileSync(files.local, JSON.stringify(local));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  try { await body(client, files); } finally {
    client.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
}

test("a stale roster key that lives only in the shared config.json is refused with where to edit it, never reported removed (#225)", async () => {
  await staleHub({ roster: { "codex-2": true } }, { roster: { kimi: true } }, async (client, files) => {
    const sharedBefore = readFileSync(files.shared, "utf8"), localBefore = readFileSync(files.local, "utf8");
    for (const t of ["settings_preview", "settings_set"]) {
      const reply: any = await client.request({ t, key: "roster.codex-2", value: null, confirm: "codex-2", now: false });
      expect(reply.ok, t).toBe(false); expect(String(reply.error), t).toContain("edit .agenthub/config.json");
    }
    expect(readFileSync(files.shared, "utf8")).toBe(sharedBefore); expect(readFileSync(files.local, "utf8")).toBe(localBefore);
  });
}, 30000);

test("removing a stale roster key says it was removed, not that the peer is on the roster, and names a copy left in the shared file (#225)", async () => {
  await staleHub(undefined, { roster: { "codex-2": true, "codex-3": true } }, async (client, files) => {
    const removed: any = await client.request({ t: "settings_set", key: "roster.codex-2", value: null, confirm: "codex-2", now: false });
    expect(removed.ok, String(removed.error)).toBe(true);
    expect(String(removed.text)).toContain("stale roster key removed"); expect(String(removed.text)).not.toContain("on roster"); expect(String(removed.text)).not.toContain("off roster");
    expect(JSON.parse(readFileSync(files.local, "utf8")).roster).toEqual({ "codex-3": true });
  });
  await staleHub({ roster: { "codex-2": true } }, { roster: { "codex-2": true } }, async (client, files) => {
    const removed: any = await client.request({ t: "settings_set", key: "roster.codex-2", value: null, confirm: "codex-2", now: false });
    expect(removed.ok, String(removed.error)).toBe(true);
    expect(String(removed.text)).toContain("still set in .agenthub/config.json"); // the same value in both files: the local one goes, the shared one stays and says so
    expect(JSON.parse(readFileSync(files.local, "utf8")).roster).toBeUndefined();
  });
  // A different shared value would show through once the local one is gone, which the reload refuses as setting a stale key: refuse before the write.
  await staleHub({ roster: { "codex-2": false } }, { roster: { "codex-2": true } }, async (client, files) => {
    const before = readFileSync(files.local, "utf8");
    const removed: any = await client.request({ t: "settings_set", key: "roster.codex-2", value: null, confirm: "codex-2", now: false });
    expect(removed.ok).toBe(false); expect(String(removed.error)).toContain("edit .agenthub/config.json first");
    expect(readFileSync(files.local, "utf8")).toBe(before);
  });
}, 40000);

test("ahub roster remove deletes a stale instance key through the real CLI, and refuses an id that never named an instance (#225)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-stale-cli-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  hubGitSync(["init", "-q", root], { encoding: "utf8" }); writeFileSync(join(root, ".gitignore"), ".agenthub/\n"); mkdirSync(join(root, ".agenthub"));
  const file = join(root, ".agenthub/config.local.json");
  writeFileSync(file, JSON.stringify({ memory: { enabled: false }, pi: { enabled: false, auto_start: false }, snapshots: { enabled: false }, roster: { "codex-2": true } }));
  const stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  const cli = async (args: string[]) => {
    const entry = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
    writeFileSync(wrapper, `for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete process.env[key];\nprocess.env.AGENTHUB_HOME = ${JSON.stringify(join(root, "home"))};\nprocess.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(entry)});\n`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, COLUMNS: "80" } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const never = await cli(["roster", "remove", "external-1", "--yes"]);
    expect(never.code).toBe(1); expect(never.stderr).toContain("usage: ahub roster"); // a typo is still a usage error
    const removed = await cli(["roster", "remove", "codex-2", "--yes"]);
    expect(removed.code, removed.stderr).toBe(0);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.roster).toBeUndefined(); // the emptied block goes with its last key
    expect(after.memory).toEqual({ enabled: false }); // and nothing else in the file moved
    // Adding it back is not offered: an instance that is not declared cannot join the roster, and the CLI says usage before asking the hub.
    const added = await cli(["roster", "add", "codex-2"]);
    expect(added.code).toBe(1); expect(added.stderr).toContain("usage: ahub roster");
    expect(JSON.parse(readFileSync(file, "utf8")).roster).toBeUndefined();
  } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
}, 40000);
