import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
// exit, the launcher alone is SIGKILLed, and the app-server is re-parented to init, still running.
test("stopping a process group also stops the child its launcher waits for", async () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const launch = async (detached: boolean) => {
    // Both ignore SIGTERM: the launcher waits for its child, the child is busy.
    const proc = spawn("sh", ["-c", 'trap "" TERM; (exec sleep 30) & echo $!; wait'], { stdio: ["ignore", "pipe", "ignore"], detached });
    const child = Number(await new Promise<string>((resolve) => proc.stdout!.once("data", (d) => resolve(String(d)))));
    return { proc, child };
  };
  const loose = await launch(false);
  try {
    await stopOwnedProcess(loose.proc, { termMs: 200 });
    expect(alive(loose.child)).toBe(true); // what the hub did before
  } finally { try { process.kill(loose.child, "SIGKILL"); } catch { /* gone */ } }
  const grouped = await launch(true);
  try {
    await stopOwnedProcess(grouped.proc, { termMs: 200, group: true });
    await Bun.sleep(100);
    expect(alive(grouped.child)).toBe(false);
  } finally { try { process.kill(grouped.child, "SIGKILL"); } catch { /* gone */ } }
});
