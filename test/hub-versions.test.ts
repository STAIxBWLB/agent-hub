import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { VERSION, displayVersion } from "../src/version.ts";
import { consoleVersions, peerHubVersion } from "../src/cli/console-versions.ts";
import { initialConsoleState, renderConsoleLines } from "../src/cli/console-state.ts";

/** An adapter that runs inside the daemon, like Codex's app-server adapter: it has no `hubClient` port. */
class InDaemon extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

// #1385: the agent-hub version each peer loaded, as the daemon reports it and the console shows it.
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(ready: () => boolean | Promise<boolean>, label: string) {
  for (let n = 0; n < 400 && !(await ready()); n++) await Bun.sleep(5);
  expect(await ready(), label).toBe(true);
}

async function daemonFixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-versions-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const token = readFileSync(join(stateDir, "control-token"), "utf8").trim();
  /** A raw hello, so a test can send what an older or a hostile client would. */
  const connect = async (hello: Record<string, unknown>) => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}`), messages: any[] = [];
    cleanup.push(() => socket.close());
    socket.onmessage = event => messages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { socket.onerror = () => reject(new Error("fixture websocket failed")); socket.onopen = () => { socket.send(JSON.stringify({ t: "hello", v: PROTOCOL, token, ...hello })); resolve(); }; });
    await until(() => messages.some(row => row.t === "welcome"), "welcome");
    return socket;
  };
  /** #1385: versions ride in `peerVersions`, beside the peer rows, which keep their legacy shape (#295). */
  const peers = async () => {
    const status = (await person.request({ t: "status" })).status;
    for (const row of Object.values(status.peers) as any[]) expect(row.ahub ?? row.ahubTools).toBeUndefined();
    return status.peerVersions;
  };
  return { daemon, stateDir, connect, peers };
}

test("a channel client's reported version is shown as what it runs; an older client without one is unreported", async () => {
  const f = await daemonFixture();
  const old = await f.connect({ role: "peer", peer: "claude" });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "claude attached");
  expect((await f.peers()).claude.ahub).toEqual({ runs: "client", version: "unreported" });
  old.close();
  await until(async () => (await f.peers()).claude?.ahub === undefined, "detached client shows no version");
  await f.connect({ role: "peer", peer: "claude", clientVersion: "0.35.0" });
  await until(async () => (await f.peers()).claude.ahub?.version === "0.35.0", "reported version");
  expect((await f.peers()).claude.ahub).toEqual({ runs: "client", version: "0.35.0" });
});

test("a malformed or oversized version is dropped, never shown", async () => {
  for (const bad of ["1.2", "v0.36.0", "0.36.0 ; rm -rf", `0.36.0-${"a".repeat(80)}`, 36, null, { v: 1 }]) expect(displayVersion(bad), String(bad)).toBeUndefined();
  for (const good of ["0.36.0", "1.0.0-rc.1", "1.0.0+build.5"]) expect(displayVersion(good)).toBe(good);
  const f = await daemonFixture();
  await f.connect({ role: "peer", peer: "claude", clientVersion: "\u001b[31m0.1.0" });
  await until(() => f.daemon.bus.stateOf("claude") === "idle", "claude attached");
  expect((await f.peers()).claude.ahub).toEqual({ runs: "client", version: "unreported" });
});

test("an in-daemon adapter runs the daemon's own version, and tools connections report theirs until they close", async () => {
  const f = await daemonFixture();
  const codex = new InDaemon("codex"); f.daemon.bus.add(codex); await codex.start();
  expect((await f.peers()).codex).toEqual({ ahub: { runs: "daemon", version: VERSION } });
  const older = await f.connect({ role: "tools", peer: "codex", clientVersion: "0.34.0" });
  const real = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => real.close());
  await until(async () => (await f.peers()).codex.ahubTools?.length === 2, "two tools connections");
  expect((await f.peers()).codex.ahubTools).toEqual(["0.34.0", VERSION].sort());
  older.close();
  await until(async () => (await f.peers()).codex.ahubTools?.length === 1, "closed connection drops out");
  expect((await f.peers()).codex.ahubTools).toEqual([VERSION]);
});

test("the console marks what is older than the daemon and the peers that load another version", () => {
  const v = consoleVersions("0.36.0", "0.35.0", "0.34.0", undefined);
  expect(v).toEqual({ daemon: "0.36.0", cli: "0.35.0", global: "0.34.0", older: ["cli", "global"] });
  expect(consoleVersions("bad", "0.35.0", undefined, undefined).older).toEqual([]); // no daemon version: nothing is claimed
  expect(peerHubVersion({}, "0.36.0")).toEqual({ cell: "-", differs: false }); // an older hub sends neither field
  expect(peerHubVersion({ ahub: { runs: "daemon", version: "0.36.0" } }, "0.36.0").differs).toBe(false);
  const stale = peerHubVersion({ ahub: { runs: "client", version: "0.35.0" }, ahubTools: ["0.36.0"] }, "0.36.0");
  expect(stale.cell).toBe("0.35.0 tools 0.36.0");
  expect(stale.differs).toBe(true);
  expect(stale.detail).toContain("restart that agent's session");
  // An unreported version is unknown: never counted, named or told to update (review of 79fa8077).
  for (const row of [{ ahub: { runs: "client" } }, { ahub: { runs: "client", version: "unreported" } }, { ahub: { runs: "daemon", version: "0.36.0" }, ahubTools: ["unreported"] }]) {
    const hub = peerHubVersion(row, "0.36.0");
    expect(hub.differs, JSON.stringify(row)).toBe(false);
    expect(hub.unknown).toBe(true);
    expect(hub.detail).toContain("unknown");
    expect(hub.detail).not.toContain("ahub setup");
  }
  expect(peerHubVersion({ ahub: { runs: "client" }, ahubTools: ["0.35.0"] }, "0.36.0").differs).toBe(true); // a reported older version still counts

  const s = initialConsoleState(true);
  s.versions = v;
  s.peers = { claude: { state: "idle", ahub: { runs: "client", version: "0.35.0" } }, codex: { state: "idle", ahub: { runs: "daemon", version: "0.36.0" } } };
  const text = renderConsoleLines(s, 160, 30, Date.now()).map(line => line.map(cell => cell.text).join("")).join("\n");
  expect(text).toMatch(/daemon 0\.36\.0 +console 0\.35\.0 \(older\) +global 0\.34\.0 \(older\) +plugin unknown/);
  expect(text).toContain("1 peer on another version: claude");
  expect(text).toMatch(/PEER +STATE +LINK +AHUB/);
  expect(text).toMatch(/claude +idle +attached +0\.35\.0/);
  expect(text).toMatch(/codex +idle +attached +daemon/);
  s.peers.kimi = { state: "idle", ahub: { runs: "client", version: "unreported" } };
  const withUnknown = renderConsoleLines(s, 160, 30, Date.now()).map(line => line.map(cell => cell.text).join("")).join("\n");
  expect(withUnknown).toContain("1 peer on another version: claude");
  expect(withUnknown).toMatch(/kimi +idle +attached +unreported/);
});
