import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { bundleInStatus } from "../src/hub/status-roster.ts";
import { realPath } from "../src/hub/project.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

// #502: launchers write the MCP bundle the running daemon reports, because the CLI on PATH and the daemon can come
// from different installs and the daemon compares Jcode's whole entry exactly.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const OWN_BUNDLE = resolve(import.meta.dir, "../plugins/agent-hub/server.js");
const DAEMON_BUNDLE = "/opt/agenthub/releases/9.9.9/node_modules/@staix/agent-hub/plugins/agent-hub/server.js";

function fakeHub(status: Record<string, unknown>) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-bundle-")));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub")); mkdirSync(join(cwd, "state"));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); }, websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw)); requests.push(msg.t);
      if (msg.t === "hello") ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, cwd }));
      else if (msg.t === "status") ws.send(JSON.stringify({ t: "status", rid: msg.rid, status }));
      else ws.send(JSON.stringify({ ok: true, rid: msg.rid }));
    },
  } });
  cleanups.push(() => server.stop(true));
  writeFileSync(join(cwd, "state/status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, cwd }));
  writeFileSync(join(cwd, "state/control-token"), "fixture-token");
  const run = async (...args: string[]) => {
    // Isolated homes: no launcher here may touch the person's real ~/.jcode or ~/.kimi.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(cwd, "home"), JCODE_HOME: join(cwd, "jcode-home"), AGENTHUB_HOME: join(cwd, "home"), AGENTHUB_PROJECT_DIR: cwd, AGENTHUB_STATE_DIR: join(cwd, "state") };
    for (const key of Object.keys(env)) if (/^(AGENTHUB_(PEER_ID|CHANNEL|MODE|RECOVERY_OPERATION|INSTANCE_ID|LAUNCH_ID|DELIVERY_ONLY)|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)$/.test(key)) delete env[key];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  return { cwd, run, requests };
}
const bundleIn = (file: string) => JSON.stringify(JSON.parse(readFileSync(file, "utf8")));

test("bundleInStatus accepts only an absolute path to the plugin bundle", () => {
  expect(bundleInStatus({ pluginBundle: DAEMON_BUNDLE })).toBe(DAEMON_BUNDLE);
  for (const status of [undefined, {}, { pluginBundle: 7 }, { pluginBundle: "plugins/agent-hub/server.js" }, { pluginBundle: "/tmp/evil.js" }, { pluginBundle: "/x/plugins/agent-hub/server.js.bak" }]) expect(bundleInStatus(status)).toBeUndefined();
});

test("the daemon reports its own plugin bundle in status (#502)", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-bundle-daemon-"))), stateDir = join(cwd, "state");
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect(bundleInStatus((await client.request({ t: "status" })).status)).toBe(OWN_BUNDLE);
});

test("ahub jcode writes the bundle the daemon reports, and its own copy only for a hub that reports none", async () => {
  const hub = fakeHub({ roster: [{ peer: "jcode", on: true }], pluginBundle: DAEMON_BUNDLE });
  const first = await hub.run("jcode", "--mode", "headless");
  expect(first.err).not.toContain("off roster"); expect(hub.requests).toContain("start");
  expect(bundleIn(join(hub.cwd, ".jcode/mcp.json"))).toContain(DAEMON_BUNDLE);
  expect(bundleIn(join(hub.cwd, ".jcode/mcp.json"))).not.toContain(OWN_BUNDLE);
  const older = fakeHub({ roster: [{ peer: "jcode", on: true }] });
  await older.run("jcode", "--mode", "headless");
  expect(bundleIn(join(older.cwd, ".jcode/mcp.json"))).toContain(OWN_BUNDLE);
});

test("ahub kimi --mode tui writes the bundle the daemon reports (#502)", async () => {
  const hub = fakeHub({ roster: [{ peer: "kimi", on: true }], peers: {}, pluginBundle: DAEMON_BUNDLE });
  // kimi_cmd is machine-local: honored only from a file git confirms is untracked, so the fixture is a repo.
  expect(Bun.spawnSync(["git", "init", "-q", hub.cwd]).exitCode).toBe(0);
  const stand = join(hub.cwd, "stand-in.sh"), marker = join(hub.cwd, "stand-in-ran");
  writeFileSync(stand, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 }); // a stand-in TUI that exits at once
  writeFileSync(join(hub.cwd, ".agenthub/config.local.json"), JSON.stringify({ kimi_cmd: [stand] }));
  const run = await hub.run("kimi", "--mode", "tui");
  expect(run.code).toBe(0);
  expect(existsSync(marker)).toBe(true); // the stand-in ran, not a real Kimi
  expect(hub.requests).toContain("start");
  expect(bundleIn(join(hub.cwd, ".kimi-code/mcp.json"))).toContain(DAEMON_BUNDLE);
});
