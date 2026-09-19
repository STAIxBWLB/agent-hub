import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { inspectProject } from "../src/hub/lifecycle.ts";

const ROOT = join(import.meta.dir, "..");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function hub(id: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `agent-hub-${id}-`));
  const daemon = await startDaemon({
    projectId: id,
    instanceId: `${id}-instance`,
    cwd: ROOT,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: {
      ...DEFAULT_CONFIG,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")],
    },
  });
  cleanup.push(() => daemon.stop());
  const consoleClient = await ControlClient.connect(stateDir, { role: "console", projectId: id, instanceId: `${id}-instance`, projectRoot: ROOT });
  cleanup.push(() => consoleClient.close());
  return { daemon, stateDir, consoleClient };
}

test("UI RPC is console-only and stale instance mutations are refused", async () => {
  const one = await hub("project-one");
  const tools = await ControlClient.connect(one.stateDir, { role: "tools", peer: "kimi", projectId: "project-one", projectRoot: ROOT });
  expect((await tools.request({ t: "ui_snapshot", after: 0 })).error).toContain("console command");
  expect((await one.consoleClient.request({ t: "ui_snapshot", after: 0 })).projectId).toBe("project-one");
  expect((await one.consoleClient.request({ t: "ui_action", instanceId: "stale", action: { action: "pause", peer: "kimi" } })).error).toContain("restarted");
  tools.close();
});

test("unknown hello roles are rejected", async () => {
  const one = await hub("project-role");
  const status = JSON.parse(await Bun.file(join(one.stateDir, "status.json")).text());
  const token = await Bun.file(join(one.stateDir, "control-token")).text();
  const ws = new WebSocket(`ws://127.0.0.1:${status.controlPort}`);
  const closed = new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", rid: 1, v: PROTOCOL, token: token.trim(), role: "future-role" }));
  expect(await closed).toBe(4403);
});

test("two daemon instances isolate task ids and reject cross-token control", async () => {
  const one = await hub("project-a");
  const two = await hub("project-b");
  expect((await one.consoleClient.request({ t: "task", op: "hub_task_propose", args: { title: "A task", class: "implement" } })).ok).toBe(true);
  expect((await two.consoleClient.request({ t: "task", op: "hub_task_propose", args: { title: "B task", class: "implement" } })).ok).toBe(true);
  expect((await one.consoleClient.request({ t: "task", op: "task_show", args: { id: 1 } })).text).toContain("A task");
  expect((await two.consoleClient.request({ t: "task", op: "task_show", args: { id: 1 } })).text).toContain("B task");

  const status = JSON.parse(await Bun.file(join(two.stateDir, "status.json")).text());
  const tokenA = (await Bun.file(join(one.stateDir, "control-token")).text()).trim();
  const ws = new WebSocket(`ws://127.0.0.1:${status.controlPort}`);
  const closed = new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", rid: 1, v: PROTOCOL, token: tokenA, role: "console", projectId: "project-b", projectRoot: ROOT }));
  expect(await closed).toBe(4401);
});

test("incomplete shutdown stays owned and retryable, never reports a ready running hub", async () => {
  const one = await hub("project-shutdown");
  let fail = true;
  class SlowPeer extends BasePeer {
    async start() {}
    async deliver() {}
    async stop() { if (fail) throw new Error("child exit not confirmed"); }
  }
  one.daemon.bus.add(new SlowPeer("slow"));
  try {
    await expect(one.daemon.stop()).rejects.toThrow("exit not confirmed");
    expect(existsSync(join(one.stateDir, "status.json"))).toBe(true);
    const observed = await inspectProject({ id: "project-shutdown", root: ROOT, stateDir: one.stateDir,
      instanceId: "project-shutdown-instance", pid: process.pid, basePort: one.daemon.port });
    expect(observed.state).toBe("stopping");
    expect(observed.error).toContain("shutdown is pending");
  } finally { fail = false; await one.daemon.stop(); }
  expect(existsSync(join(one.stateDir, "status.json"))).toBe(false);
});
