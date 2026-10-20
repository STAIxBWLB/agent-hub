import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, type Hello } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { processLiveness, processSignature } from "../src/pi/process-signature.ts";
import type { RecordedTerminalLaunch } from "../src/cli/terminal-recovery.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function until(ready: () => boolean, label: string) {
  for (let attempt = 0; attempt < 600 && !ready(); attempt++) await Bun.sleep(5);
  expect(ready(), label).toBe(true);
}

async function fixture(memoryUrl?: string, ignoreQuerySigterm = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-terminal-launch-daemon-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const executable = join(root, "fake-orca.ts"), previousOrca = process.env.ORCA_CLI_COMMAND;
  const gate = join(root, "hold-show"), started = join(root, "show-started"), finished = join(root, "show-finished");
  const terminal = { handle: "term-fixture", incarnationId: "inc-fixture", worktreeId: "wt-fixture", worktreePath: root, connected: true };
  writeFileSync(executable, `#!${process.execPath}\nimport { existsSync, writeFileSync } from "node:fs";
if (process.argv.slice(2).join(" ") !== "terminal show --terminal term-fixture --json") process.exit(2);
${ignoreQuerySigterm ? 'process.on("SIGTERM", () => {});' : ""}
writeFileSync(${JSON.stringify(started)}, String(process.pid));
while (existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
console.log(JSON.stringify({ ok: true, result: { terminal: ${JSON.stringify(terminal)} } }));
writeFileSync(${JSON.stringify(finished)}, "finished");
`);
  chmodSync(executable, 0o700);
  process.env.ORCA_CLI_COMMAND = executable;
  cleanup.push(() => { if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = previousOrca; });
  const daemon = await startDaemon({ cwd: root, stateDir, instanceId: "i-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: !!memoryUrl, ...(memoryUrl ? { worker_url: memoryUrl } : {}) },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  // Unblock an in-flight fake Orca read before stopping this fixture's daemon.
  cleanup.push(() => rmSync(gate, { force: true }));
  const connect = async (hello: Hello) => {
    const client = await ControlClient.connect(stateDir, hello);
    cleanup.push(() => client.close());
    return client;
  };
  const console_ = await connect({ role: "console" });
  const ledger = join(stateDir, "terminal-recovery.json");
  const candidate = (launchId = "launch-fixture"): RecordedTerminalLaunch => ({ peer: "claude", projectRoot: root, stateDir, instanceId: "i-fixture",
    launcherPid: process.pid, launcherSignature: processSignature(process.pid)!, launchId, handle: terminal.handle,
    incarnationId: terminal.incarnationId, worktreeId: terminal.worktreeId, env: {} });
  const rows = (): RecordedTerminalLaunch[] => existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
  return { root, stateDir, daemon, console_, connect, ledger, candidate, rows, gate, started, finished };
}

test("#482 terminal_launch replies to console-only and wrong daemon binding refusals without publishing", async () => {
  const f = await fixture(), row = f.candidate();
  const tools = await f.connect({ role: "tools", peer: "claude" });
  expect(await tools.request({ t: "terminal_launch", launch: row })).toMatchObject({ ok: false, error: "terminal launch registration is console only" });
  for (const launch of [{ ...row, projectRoot: join(f.root, "other-project") }, { ...row, instanceId: "i-older" }, { ...row, stateDir: join(f.root, "other-state") }]) {
    expect(await f.console_.request({ t: "terminal_launch", launch })).toMatchObject({ ok: false, error: "terminal launch identity unavailable" });
  }
  expect((await f.console_.request({ t: "terminal_launch", launch: row })).ok).toBe(true);
  expect(f.rows()).toEqual([]);
  expect(existsSync(f.started)).toBe(false);
});

test("#482 registered terminal launch publishes only after an actual matching attached WsPeer", async () => {
  const f = await fixture(), row = f.candidate();
  expect((await f.console_.request({ t: "terminal_launch", launch: row })).ok).toBe(true);
  for (const launchId of [undefined, "different-launch"]) {
    const peer = await f.connect({ role: "peer", peer: "claude", channel: true, ...(launchId ? { launchId } : {}) });
    await until(() => f.daemon.bus.stateOf("claude") === "idle", "unmatched native peer attached");
    // Observe more than one reconciliation period: an attached peer alone is not this candidate's owner.
    await Bun.sleep(1_100);
    expect(f.rows()).toEqual([]);
    expect(existsSync(f.started)).toBe(false);
    peer.close();
    await until(() => f.daemon.bus.stateOf("claude") === "offline", "unmatched peer detached");
  }
  await f.connect({ role: "peer", peer: "claude", channel: true, launchId: row.launchId });
  await until(() => f.rows().some(saved => saved.launchId === row.launchId), "matching attached native owner published");
  expect(f.rows()).toEqual([row]);
}, 10_000);

test("#482 terminal launch cannot publish during a blocked native preface", async () => {
  let release!: () => void, injecting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
    if (new URL(req.url).pathname === "/api/context/inject") { injecting = true; await gate; }
    return new Response("# claude-mem status\n\nThis project has no memory yet.\n");
  } });
  cleanup.push(() => memory.stop(true));
  const f = await fixture(`http://127.0.0.1:${memory.port}`);
  cleanup.push(() => release());
  const row = f.candidate();
  expect((await f.console_.request({ t: "terminal_launch", launch: row })).ok).toBe(true);
  await f.connect({ role: "peer", peer: "claude", channel: true, launchId: row.launchId });
  await until(() => injecting, "native preface blocked");
  expect(f.daemon.bus.stateOf("claude")).toBe("offline");
  await Bun.sleep(1_100);
  expect(f.rows()).toEqual([]);
  expect(existsSync(f.started)).toBe(false);
  release();
  await until(() => f.rows().some(saved => saved.launchId === row.launchId), "preface-completed native owner published");
}, 10_000);

test("#482 superseded WsPeer generation cannot publish after its delayed Orca read completes", async () => {
  const f = await fixture(), old = f.candidate("launch-old");
  writeFileSync(f.gate, "hold");
  expect((await f.console_.request({ t: "terminal_launch", launch: old })).ok).toBe(true);
  await f.connect({ role: "peer", peer: "claude", channel: true, launchId: old.launchId });
  await until(() => existsSync(f.started), "old owner's Orca publication read blocked");
  const next = f.candidate("launch-current");
  await f.connect({ role: "peer", peer: "claude", channel: true, launchId: next.launchId });
  await until(() => f.daemon.bus.peers.get("claude")?.terminalOwner?.(next.launchId) !== undefined, "replacement native owner attached");
  rmSync(f.gate);
  await until(() => existsSync(f.finished), "old owner's Orca read returned");
  // Let the suspended read continuation and a subsequent reconciliation finish before checking the negative result.
  await Bun.sleep(1_100);
  expect(f.rows()).toEqual([]);
  expect((await f.console_.request({ t: "terminal_launch", launch: next })).ok).toBe(true);
  await until(() => f.rows().some(saved => saved.launchId === next.launchId), "only replacement owner published");
  expect(f.rows()).toEqual([next]);
}, 10_000);

for (const ignoreQuerySigterm of [false, true]) test(`#482 daemon stop awaits termination of its ${ignoreQuerySigterm ? "SIGTERM-ignoring" : "normal"} gated Orca publication query`, async () => {
  const f = await fixture(undefined, ignoreQuerySigterm), row = f.candidate();
  writeFileSync(f.gate, "hold");
  let queryPid: number | undefined, querySignature: string | undefined;
  try {
    expect((await f.console_.request({ t: "terminal_launch", launch: row })).ok).toBe(true);
    await f.connect({ role: "peer", peer: "claude", channel: true, launchId: row.launchId });
    await until(() => existsSync(f.started), "owned Orca publication query started");
    queryPid = Number(readFileSync(f.started, "utf8"));
    expect(Number.isSafeInteger(queryPid) && queryPid > 0).toBe(true);
    expect(queryPid).not.toBe(process.pid);
    querySignature = processSignature(queryPid);
    expect(querySignature).toBeDefined();
    expect(processLiveness(queryPid, querySignature)).toBe("live");
    await f.daemon.stop();
    // Check immediately at stop completion, without a grace-period poll that could hide an unawaited kill.
    expect(processLiveness(queryPid, querySignature)).toBe("gone");
    expect(existsSync(f.ledger)).toBe(false);
    expect(f.rows()).toEqual([]);
  } finally {
    // The red version may leave this fixture child waiting; release it even when the stop assertion fails.
    rmSync(f.gate, { force: true });
    if (queryPid !== undefined && querySignature) await until(() => processLiveness(queryPid, querySignature) === "gone", "fixture query exited after cleanup");
  }
}, 10_000);
