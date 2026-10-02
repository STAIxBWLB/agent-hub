import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { stopOwnedProcess } from "../src/hub/child-process.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const ROOT = join(import.meta.dir, "..");

class StubbornPeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { throw new Error("stop refused"); }
}

// issue #56: a peer whose stop rejects must not strand the daemon before state removal.
test("a rejected peer stop still removes state files and resolves stopped", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-shutdown-"));
  const hub = await startDaemon({
    cwd: ROOT,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } },
  });
  const stubborn = new StubbornPeer("kimi");
  hub.bus.add(stubborn);
  await stubborn.start();
  expect(existsSync(join(stateDir, "status.json"))).toBe(true);
  await hub.stop(); // resolves: the refusal is logged, not thrown past cleanup
  await hub.stopped;
  for (const f of ["hub.pid", "status.json", "control-token"]) expect(existsSync(join(stateDir, f))).toBe(false);
});

class QuietPeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
}

async function watchedDaemon(cwd: string, stateDir: string) {
  return startDaemon({
    cwd,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } },
    orphanWatchMs: 50,
  });
}

const bounded = (what: string) => new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`daemon did not stop after ${what}`)), 5_000));

// issue #56: a daemon whose state dir was rmSync'd (the leaked-test scenario) must exit on its own.
test("the watchdog stops a daemon whose state directory vanished", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-orphan-state-"));
  const hub = await watchedDaemon(ROOT, stateDir);
  const quiet = new QuietPeer("kimi");
  hub.bus.add(quiet);
  await quiet.start();
  rmSync(stateDir, { recursive: true, force: true });
  await Promise.race([hub.stopped, bounded("losing its state dir")]);
  expect(quiet.state).toBe("offline");
});

test("the watchdog stops a daemon whose project root vanished", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-orphan-root-"));
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-orphan-state-"));
  const hub = await watchedDaemon(root, stateDir);
  rmSync(root, { recursive: true, force: true });
  await Promise.race([hub.stopped, bounded("losing its project root")]);
  rmSync(stateDir, { recursive: true, force: true });
});

// issue #113: Codex's `codex.js` forwards SIGTERM to its native app-server and waits; mid-turn the app-server does not
// exit, the launcher alone was SIGKILLed, and the app-server was re-parented to init, still running. The app-server in
// turn runs its MCP servers and tool commands in process groups of their own.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50); return !alive(pid); };
const launch = async (script: string, detached: boolean) => {
  const proc = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], detached });
  const child = Number(await new Promise<string>((resolve) => proc.stdout!.once("data", (d) => resolve(String(d)))));
  cleanup.push(() => { try { process.kill(child, "SIGKILL"); } catch { /* gone */ } });
  return { proc, child };
};
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

test("stopping a process group also stops the child its launcher waits for", async () => {
  // Both ignore SIGTERM: the launcher waits for its child, the child is busy.
  const script = 'trap "" TERM; (exec sleep 30) & echo $!; wait';
  const loose = await launch(script, false);
  await stopOwnedProcess(loose.proc, { termMs: 200 });
  expect(alive(loose.child)).toBe(true); // what the hub did before
  const grouped = await launch(script, true);
  await stopOwnedProcess(grouped.proc, { termMs: 200, group: true });
  expect(await gone(grouped.child)).toBe(true);
});

test("a group member that outlives its leader is stopped too, and done means the group is gone", async () => {
  // The leader dies at SIGTERM; its child ignores it.
  const { proc, child } = await launch('(trap "" TERM; exec sleep 30) & echo $!; wait', true);
  await stopOwnedProcess(proc, { termMs: 200, group: true });
  expect(alive(child)).toBe(false); // the readback already waited for it
});

test("a descendant that leads a group of its own is found before the stop and stopped after it", async () => {
  // A child in its own group, as Codex runs a tool command; the launcher ignores SIGTERM.
  const own = `require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); `;
  const { proc, child } = await launch(`trap "" TERM; ${process.execPath} -e '${own}' & sleep 0.5; pgrep -P $! sleep; wait`, true);
  expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child)], { encoding: "utf8" }).trim())).toBe(child);
  await stopOwnedProcess(proc, { termMs: 200, group: true });
  expect(alive(child)).toBe(false);
});
