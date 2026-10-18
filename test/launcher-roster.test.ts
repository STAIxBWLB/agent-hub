import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { rosterInStatus } from "../src/hub/status-roster.ts";

// #484: launchers read roster membership from the status reply; an older hub without it is unknown, never off.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const fake = [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], fakeJcode = [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts")];

async function rig(roster: Record<string, boolean>) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-launcher-roster-"))), stateDir = join(cwd, "state");
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roster, batch_ms: 0, kimi_cmd: fake, jcode_cmd: fakeJcode, jcode_home: join(cwd, "jcode-home"),
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  const run = async (...args: string[]) => {
    // Isolated homes: no launcher here may touch the person's real ~/.jcode or ~/.kimi.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(cwd, "home"), JCODE_HOME: join(cwd, "jcode-home"), AGENTHUB_HOME: join(cwd, "home"), AGENTHUB_PROJECT_DIR: cwd, AGENTHUB_STATE_DIR: stateDir };
    for (const key of Object.keys(env)) if (/^(AGENTHUB_(PEER_ID|CHANNEL|MODE|RECOVERY_OPERATION|INSTANCE_ID|LAUNCH_ID|DELIVERY_ONLY)|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)$/.test(key)) delete env[key];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  return { cwd, daemon, console_, run };
}

test("status carries every supported peer's roster membership; a reply without one reads as unknown (#484)", async () => {
  const hub = await rig({ jcode: true, kimi: false });
  const status = (await hub.console_.request({ t: "status" })).status;
  expect(rosterInStatus(status, "jcode")).toBe(true);
  expect(rosterInStatus(status, "kimi")).toBe(false);
  expect(rosterInStatus(status, "codex")).toBe(true);
  for (const old of [undefined, {}, { roster: "jcode" }, { roster: [{ peer: "jcode" }] }]) expect(rosterInStatus(old, "jcode")).toBeUndefined();
});

test("ahub jcode starts on the roster and is refused off it (#484)", async () => {
  const off = await rig({});
  const refused = await off.run("jcode", "--mode", "headless");
  expect(refused.code).not.toBe(0); expect(refused.err).toContain("jcode is off roster");
  expect(off.daemon.bus.peers.get("jcode")).toBeUndefined();
  const on = await rig({ jcode: true });
  expect(existsSync(join(off.cwd, ".jcode/mcp.json"))).toBe(false); // refused before the MCP write
  // On the roster the launcher passes its guard and writes the MCP entry; whether this machine can verify a
  // native Jcode start afterwards is outside #484.
  const started = await on.run("jcode", "--mode", "headless");
  expect(started.err).not.toContain("off roster"); expect(started.err).not.toContain("cannot read jcode's roster");
  expect(existsSync(join(on.cwd, ".jcode/mcp.json"))).toBe(true);
});

test("ahub kimi --mode tui is refused off the roster before any terminal or MCP write (#484)", async () => {
  const hub = await rig({ kimi: false });
  const refused = await hub.run("kimi", "--mode", "tui");
  expect(refused.code).not.toBe(0); expect(refused.err).toContain("kimi is off roster");
  expect(hub.daemon.bus.peers.get("kimi")).toBeUndefined();
});
