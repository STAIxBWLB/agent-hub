import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type DaemonOptions } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Tools = NonNullable<DaemonOptions["boundedTools"]>;
type Runner = ReturnType<NonNullable<Tools["runner"]>>;
const orphan = "orphan check: unknown owner";

class CheckPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

async function start(sweep: Runner["sweep"], specAvailable: Tools["specAvailable"], run?: Runner["start"], modelUrl?: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-checks-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, "fixture-api-key");
  if (modelUrl) writeFileSync(keyFile, "fixture-only-key");
  const daemon = await startDaemon({
    cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 },
      ...(modelUrl ? { omniroute: { urls: [modelUrl], access_hosts: [], api_key_file: keyFile } } : {}) },
    boundedTools: {
      specAvailable,
      runner: () => ({
        available: async () => ({ available: true }), sweep,
        start: run ?? (() => { throw new Error("unexpected check start"); }),
        stopAll: async () => {}, result: async () => undefined, cancel: async () => {},
        markStale: async () => {}, consumeOutput: async () => {},
      }),
    },
  });
  cleanups.push(() => daemon.stop());
  const console = await ControlClient.connect(root, { role: "console" });
  cleanups.push(() => console.close());
  const projection = async () => {
    const { status } = await console.request({ t: "status" });
    return { isolatedChecks: status.isolatedChecks, spec: status.taskCapabilities.pi.spec };
  };
  return { daemon, root, console, projection };
}

test("ready and the board are served while sweep and spec are pending, then status matches immediate results", async () => {
  const sweep = Promise.withResolvers<string[]>(), spec = Promise.withResolvers<{ available: boolean }>();
  const baseline = await start(async () => [orphan], async () => ({ available: true }));
  let sweepCalls = 0, specCalls = 0;
  const fixture = await start(async signal => {
    sweepCalls++;
    signal?.addEventListener("abort", () => sweep.resolve([]), { once: true });
    return sweep.promise;
  }, async () => { specCalls++; return spec.promise; });
  try {
    const timing = readFileSync(join(fixture.root, "hub.log"), "utf8").split("\n").find(line => line.includes("startup timings ms:"));
    expect(timing).toBeDefined();
    console.log(timing);
    expect(await fixture.console.request({ t: "task", op: "hub_task_list", args: {} })).toMatchObject({ ok: true });
    let statusReturned = false;
    const status = fixture.projection().then(result => { statusReturned = true; return result; });
    await fixture.console.request({ t: "task", op: "hub_task_list", args: {} });
    expect(statusReturned).toBe(false);
    sweep.resolve([orphan]);
    await fixture.console.request({ t: "task", op: "hub_task_list", args: {} });
    expect(statusReturned).toBe(false);
    spec.resolve({ available: true });
    expect(await status).toEqual(await baseline.projection());
    expect(await status).toMatchObject({ isolatedChecks: { orphans: [orphan] }, spec: true });
    expect([sweepCalls, specCalls]).toEqual([1, 1]);
  } finally {
    sweep.resolve([]);
    spec.resolve({ available: false });
  }
});

test("a check request waits until orphan recovery settles", async () => {
  const sweep = Promise.withResolvers<string[]>();
  let swept = false, started = false;
  const fixture = await start(async signal => {
    signal?.addEventListener("abort", () => sweep.resolve([]), { once: true });
    const lines = await sweep.promise;
    swept = true;
    return lines;
  }, undefined, () => {
    started = true;
    if (!swept) throw new Error("check raced orphan recovery");
    return { run: "fixture", done: new Promise(() => {}) };
  });
  const board = new Board(join(fixture.root, "hub.db"));
  cleanups.push(() => board.close());
  const task = board.propose("user", { title: "check fixture", class: "implement", refs: { branch: "main" } });
  board.update(task.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const peer = new CheckPeer("codex");
  fixture.daemon.bus.add(peer);
  await peer.start();
  const client = await ControlClient.connect(fixture.root, { role: "tools", peer: "codex" });
  cleanups.push(() => client.close());
  const check = client.request({ t: "task", op: "hub_check_start", args: { id: task.id, check: "typecheck" } });
  try {
    await client.request({ t: "task", op: "hub_task_list", args: {} });
    expect(started).toBe(false);
  } finally {
    sweep.resolve([]);
  }
  expect(await check).toMatchObject({ ok: true, text: JSON.stringify({ run: "fixture" }) });
});

test("shutdown aborts and drains the outstanding orphan sweep", async () => {
  let running = false;
  const fixture = await start(async signal => {
    running = true;
    await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    running = false;
    return [orphan];
  }, undefined);
  expect(running).toBe(true);
  await fixture.daemon.stop();
  expect(running).toBe(false);
});

test("a peer's spec refresh leaves status and queue rechecks available", async () => {
  const refreshStarted = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<{ available: boolean }>();
  const model = startFakeModelServer({ key: "fixture-only-key" });
  cleanups.push(() => model.stop());
  let calls = 0;
  const fixture = await start(async () => [], async () => {
    if (++calls === 1) return { available: true };
    refreshStarted.resolve();
    return refresh.promise;
  }, undefined, model.url);
  expect(await fixture.projection()).toMatchObject({ spec: true });
  const peer = new CheckPeer("codex");
  fixture.daemon.bus.add(peer);
  const rechecks = spyOn(Tasks.prototype, "scheduleQueuePressureRecheck");
  const starting = fixture.console.request({ t: "start", peer: "local", args: { model: "m" } });
  try {
    await Promise.race([refreshStarted.promise, starting.then(() => { throw new Error("peer start did not refresh spec auth"); })]);
    rechecks.mockClear();
    await peer.start();
    expect(rechecks).toHaveBeenCalled();
    let statusReturned = false;
    const status = fixture.projection().then(result => { statusReturned = true; return result; });
    await fixture.console.request({ t: "task", op: "hub_task_list", args: {} });
    expect(statusReturned).toBe(true);
    expect(await status).toMatchObject({ spec: true });
  } finally {
    rechecks.mockRestore();
    refresh.resolve({ available: false });
    await starting;
  }
  expect(await fixture.projection()).toMatchObject({ spec: false });
});
