import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { processTable, stopOwnedProcess } from "../src/hub/child-process.ts";
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
// turn runs its MCP servers and tool commands in process groups of their own, and keeps starting them while it works.
// Alive means in the process table, which leaves zombies out (`kill(pid, 0)` succeeds on one).
const alive = (pid: number) => {
  const table = processTable();
  if (!table) throw new Error("the process table cannot be read: nothing can be said about pid " + pid);
  return table.some((r) => r.pid === pid);
};
const gone = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50); return !alive(pid); };
const launch = async (script: string, detached: boolean) => {
  const proc = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], detached });
  const child = Number(await new Promise<string>((resolve) => proc.stdout!.once("data", (d) => resolve(String(d)))));
  cleanup.push(() => { try { process.kill(child, "SIGKILL"); } catch { /* gone */ } try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } });
  return { proc, child };
};
// A child in a group of its own, as Codex runs a tool command: the pid is printed once pgrep sees it.
const ownGroup = (delay = 0) => `${process.execPath} -e 'setTimeout(() => require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" }), ${delay}); setTimeout(() => {}, 30000)' & b=$!; for i in $(seq 1 100); do c=$(pgrep -P $b sleep) && break; sleep 0.05; done; echo $c`;
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
  // The launcher ignores SIGTERM.
  const { proc, child } = await launch(`trap "" TERM; ${ownGroup()}; wait`, true);
  expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child)], { encoding: "utf8" }).trim())).toBe(child);
  await stopOwnedProcess(proc, { termMs: 200, group: true });
  expect(alive(child)).toBe(false);
});

test("what the tree starts during the grace period is recorded while its parent runs, and stopped", async () => {
  // The stop begins at once; 300 ms later, inside the grace period, a process that ignores SIGTERM starts a sleep in a
  // group of its own, and exits at 1000 ms: by the end of the grace period nothing links the sleep to the tree any more.
  const dir = mkdtempSync(join(tmpdir(), "agenthub-grace-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "late.pid");
  // Its pid is printed once its handler is installed, and the 300 ms count from then.
  const late = `${process.execPath} -e 'process.on("SIGTERM", () => {}); console.log(process.pid); setTimeout(() => { const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); }, 300); setTimeout(() => process.exit(0), 1000)'`;
  const { proc } = await launch(`trap "" TERM; ${late} & wait`, true);
  await stopOwnedProcess(proc, { termMs: 1500, group: true });
  const child = Number(readFileSync(pidFile, "utf8"));
  cleanup.push(() => { try { process.kill(child, "SIGKILL"); } catch { /* gone */ } });
  expect(alive(child)).toBe(false);
});

test("without any process table the group's own answer decides; a member the table keeps showing is never called gone", async () => {
  const quick = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await stopOwnedProcess(quick, { termMs: 200, group: true, table: () => undefined });
  expect(quick.signalCode).toBe("SIGTERM");
  const held = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const started = processTable()!.find((r) => r.pid === held.pid)!.started;
  // A table that keeps showing the leader's child running: the stop gives up at its deadline, it does not claim done.
  // (99_999_999 is above every platform's pid range: the signals sent to it reach nobody.)
  const fake = () => [{ pid: held.pid!, ppid: 1, pgid: held.pid!, started, command: "sleep 30" }, { pid: process.pid, ppid: 1, pgid: process.pid, started: processTable()!.find((r) => r.pid === process.pid)!.started, command: "bun test" }, { pid: 99_999_999, ppid: held.pid!, pgid: 99_999_999, started, command: "stuck" }];
  await expect(stopOwnedProcess(held, { termMs: 200, killMs: 300, group: true, table: fake })).rejects.toThrow("1 process(es) of its group or below it still running");
});

test("a process left in the leader's group that nothing recorded is never signalled, and the stop is not called done", async () => {
  // The leader exits at SIGTERM; the table then shows a member of its group nobody recorded: after an empty moment a
  // group id can be someone else's, so it is left alone, and the stop gives up instead of claiming done.
  const leader = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const me = processTable()!.find((r) => r.pid === process.pid)!;
  let exited = false;
  leader.once("exit", () => (exited = true));
  const table = () => [me, ...(exited ? [{ pid: 99_999_999, ppid: 1, pgid: leader.pid!, started: me.started, command: "orphan" }] : [])];
  await expect(stopOwnedProcess(leader, { termMs: 200, killMs: 300, group: true, table })).rejects.toThrow("1 not proven its own and left alone");
});

test("a descendant that leads a group of its own gets its own SIGTERM and the grace period", async () => {
  // A tool command in a group of its own needs 300 ms to finish cleanly (git removing its index lock); the leader dies
  // at SIGTERM.
  const dir = mkdtempSync(join(tmpdir(), "agenthub-grace-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "clean"), tool = join(dir, "tool.js");
  writeFileSync(tool, `process.on("SIGTERM", () => setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "clean"); process.exit(0); }, 300)); console.log(process.pid); setTimeout(() => {}, 30000);`);
  const { proc, child } = await launch(`${process.execPath} -e 'require("node:child_process").spawn(process.execPath, [${JSON.stringify(tool)}], { detached: true, stdio: ["ignore", "inherit", "ignore"] }); setTimeout(() => {}, 30000)' & wait`, true);
  expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child)], { encoding: "utf8" }).trim())).toBe(child);
  await stopOwnedProcess(proc, { termMs: 1000, group: true });
  expect(existsSync(marker)).toBe(true); // it ended on its own, not by SIGKILL
  expect(alive(child)).toBe(false);
});

test("a recorded process whose pid shows a different start time later is someone else's: never signalled", async () => {
  // The first read shows pid R below the leader; later reads show R with another start time: the pid was reused.
  const leader = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const reused = spawn("sleep", ["30"], { stdio: "ignore" });
  cleanup.push(() => { try { process.kill(reused.pid!, "SIGKILL"); } catch { /* gone */ } });
  let reads = 0;
  const table = () => {
    const real = processTable()!;
    const row = real.find((r) => r.pid === reused.pid)!;
    return reads++ === 0 ? [...real.filter((r) => r.pid !== reused.pid), { ...row, ppid: leader.pid!, started: "Thu Jan  1 00:00:00 2026" }] : real;
  };
  await stopOwnedProcess(leader, { termMs: 300, killMs: 500, group: true, table });
  expect(alive(reused.pid!)).toBe(true);
});

test("a leader that exited before the stop leaves its group unsignalled, and members still in it fail the stop", async () => {
  // The launcher was killed from outside; the native it started is still in its group.
  const { proc, child } = await launch('(exec sleep 30) & echo $!; wait', true);
  process.kill(proc.pid!, "SIGKILL");
  await new Promise((resolve) => proc.once("exit", resolve));
  await expect(stopOwnedProcess(proc, { group: true })).rejects.toThrow("its process group still has members");
  expect(alive(child)).toBe(true);
  process.kill(child, "SIGKILL");
  expect(await gone(child)).toBe(true);
  await stopOwnedProcess(proc, { group: true }); // an empty group: done
});

test("what the leader started gets the grace period to shut down after the leader is gone", async () => {
  // The leader dies at SIGTERM; its child needs 500 ms to finish cleanly.
  const dir = mkdtempSync(join(tmpdir(), "agenthub-grace-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "clean");
  // It prints its pid only once its handler is installed: a SIGTERM before that would kill it at once.
  const child = `${process.execPath} -e 'process.on("SIGTERM", () => setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "clean"); process.exit(0); }, 500)); console.log(process.pid); setTimeout(() => {}, 30000)'`;
  const { proc } = await launch(`${child} & wait`, true);
  await stopOwnedProcess(proc, { termMs: 1000, group: true });
  expect(existsSync(marker)).toBe(true); // it ended on its own, not by SIGKILL
});
