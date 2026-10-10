import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean): Promise<void> {
  for (let n = 0; n < 400 && !condition(); n++) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

class Implementer extends BasePeer {
  readonly received: Envelope[] = [];
  constructor() { super("codex"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string): Promise<void> {
    this.setState("busy");
    this.received.push(...envs);
    if (id) {
      this.delivery({ id, state: "accepted" });
      this.delivery({ id, state: "completed" });
    }
    this.setState("idle");
  }
}

test("a Kimi quota refusal pauses before safe requeue and automatically relays tasks and routing (#306)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-acp-quota-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"')
    .replace('[classes.implement]\npeers = ["pi", "local", "codex", "kimi"]', '[classes.implement]\npeers = ["kimi", "codex"]');
  writeFileSync(join(dir, ".agenthub/routing.toml"), routing);
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts"), "--quota-refusal"],
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      budget: { ...DEFAULT_CONFIG.budget, wait_max_min: 1 },
    } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(dir, { role: "console" });
  cleanup.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const implementer = new Implementer();
  await implementer.start(); daemon.bus.add(implementer);
  const tools = await ControlClient.connect(dir, { role: "tools", peer: "kimi" });
  cleanup.push(() => tools.close());
  for (const id of [1, 2]) {
    expect((await console_.request({ t: "task", op: "hub_task_propose", args: {
      title: `implement piece ${id}`, class: "implement", owner: "kimi", refs: { paths: [`piece${id}.ts`] },
    } })).ok).toBe(true);
    expect((await tools.request({ t: "task", op: "hub_task_accept", args: { id } })).ok).toBe(true);
  }
  await until(() => daemon.bus.stateOf("kimi") === "idle" && daemon.bus.queued("kimi") === 0 && !daemon.bus.hasInFlight("kimi"));
  const original = newEnvelope("user", "QUOTA_REFUSAL", { to: ["kimi"] });
  daemon.bus.publish(original);
  await until(() => daemon.bus.stateOf("kimi") === "paused" && daemon.bus.queueIds("kimi").includes(original.id));
  const shown = await console_.request({ t: "budget" });
  expect(shown.budget.kimi.windows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "5h", used: 1, source: "kimi ACP usage-limit refusal" })]));
  expect(Math.round((shown.budget.kimi.paused.resetsAt - shown.budget.kimi.paused.since) / 60_000)).toBe(300);
  expect((await console_.request({ t: "status" })).status.peers.kimi.paused).toContain("budget: 5h window at 100% (kimi ACP usage-limit refusal)");
  expect(daemon.bus.queueIds("kimi").filter(id => id === original.id)).toHaveLength(1);
  expect(daemon.bus.queueSummary("kimi")).toMatchObject({ needsReview: 0 });
  expect(daemon.bus.queueSummary("kimi").heldBy).toBeUndefined();
  expect(daemon.bus.queueList("kimi").filter(row => row.state === "needs_review")).toEqual([]);
  await until(() => [1, 2].every(id => implementer.received.some(env => env.kind === "task" && env.refs?.task === String(id))));
  for (const id of [1, 2]) {
    const task = await console_.request({ t: "task", op: "task_show", args: { id } });
    expect(JSON.parse(task.text).owner).toBe("codex");
    expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === String(id))).toHaveLength(1);
  }
  expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: "implement another piece", class: "implement" } })).ok).toBe(true);
  expect(JSON.parse((await console_.request({ t: "task", op: "task_show", args: { id: 3 } })).text).owner).toBe("codex");
  const explanation = await console_.request({ t: "task", op: "route_explain", args: { title: "next piece", class: "implement" } });
  expect(explanation.text).toContain("owner candidate kimi: skipped, paused");
  // An acknowledged control request plus completed receiver turns is the barrier for exact-once assertions.
  expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === "1")).toHaveLength(1);
  expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === "2")).toHaveLength(1);
}, 20_000);
