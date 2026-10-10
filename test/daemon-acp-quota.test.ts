import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../src/hub/db-timeout.ts";
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

async function fixture(args: string[] = [], recordProtocol = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-acp-quota-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"')
    .replace('[classes.implement]\npeers = ["pi", "local", "codex", "kimi"]', '[classes.implement]\npeers = ["kimi", "codex"]');
  writeFileSync(join(dir, ".agenthub/routing.toml"), routing);
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts"), "--quota-refusal", ...args, ...(recordProtocol ? ["--record-protocol", join(dir, "protocol.jsonl")] : [])],
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
  return { dir, daemon, console_, implementer, tools };
}

test("a Kimi quota refusal pauses before safe requeue and automatically relays tasks and routing (#306)", async () => {
  const { dir, daemon, console_, implementer, tools } = await fixture();
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
  await (daemon.bus.peers.get("kimi") as AcpPeer).setPermissionMode("ask"); // consume all earlier native replies
  const db = new Database(join(dir, "hub.db"), { readonly: true });
  try {
    db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    await until(() => (db.query("SELECT handed_off FROM budget_pauses WHERE peer = ?").get("kimi") as { handed_off: number } | null)?.handed_off === 1);
  } finally { db.close(); }
  // An acknowledged control request plus completed receiver turns is the barrier for exact-once assertions.
  expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === "1")).toHaveLength(1);
  expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === "2")).toHaveLength(1);
}, 20_000);

test("a refusal after a console override pauses again, keeps all messages and relays new work (#306)", async () => {
  const { daemon, console_, implementer } = await fixture();
  const dropped: string[] = [];
  daemon.bus.tap(event => { if (event.t === "undeliverable") dropped.push(event.env.id); });
  const first = newEnvelope("user", "QUOTA_REFUSAL first", { to: ["kimi"] }); daemon.bus.publish(first);
  await until(() => daemon.bus.isPaused("kimi") && daemon.bus.queueIds("kimi").includes(first.id));
  daemon.bus.setRecoveryHold(true); // hold dispatch, not the daemon's operation authority, while arranging this race
  const second = newEnvelope("user", "QUOTA_REFUSAL second", { to: ["kimi"] });
  const third = newEnvelope("user", "QUOTA_REFUSAL third", { to: ["kimi"] });
  try {
    expect((await console_.request({ t: "budget", resume: "kimi" })).ok).toBe(true);
    daemon.bus.publish(second); daemon.bus.publish(third);
    expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: "QUOTA_REFUSAL work", class: "implement" } })).ok).toBe(true);
  } finally { daemon.bus.setRecoveryHold(false); }
  await until(() => daemon.bus.isPaused("kimi") && implementer.received.some(env => env.kind === "task" && env.refs?.task === "1"));
  await (daemon.bus.peers.get("kimi") as AcpPeer).setPermissionMode("ask");
  const shown = await console_.request({ t: "budget" });
  expect(shown.budget.kimi.paused.reason).toContain("kimi ACP usage-limit refusal");
  for (const env of [first, second, third]) expect(daemon.bus.queueIds("kimi").filter(id => id === env.id)).toHaveLength(1);
  expect(dropped).toEqual([]); expect(daemon.bus.queueSummary("kimi").needsReview).toBe(0);
  expect(implementer.received.filter(env => env.kind === "task" && env.refs?.task === "1")).toHaveLength(1);
  expect((await console_.request({ t: "task", op: "route_explain", args: { title: "more work", class: "implement" } })).text).toContain("owner candidate kimi: skipped, paused");
}, 20_000);

test("a hard refusal supersedes the daemon's pending soft checkpoint before confirming safe requeue (#306)", async () => {
  const { daemon, console_ } = await fixture();
  const original = newEnvelope("user", "QUOTA_REFUSAL_OCCUPANCY_HELD", { to: ["kimi"] }); daemon.bus.publish(original);
  let consumed = false;
  for (let i = 0; i < 100 && !consumed; i++) {
    consumed = (await console_.request({ t: "status" })).status.peers.kimi.context?.used === 0.1;
    if (!consumed) await Bun.sleep(10);
  }
  expect(consumed).toBe(true); // native occupancy ACK, not a guess about process readiness
  expect((await console_.request({ t: "budget", set: { peer: "kimi", used: 0.95, resetsInMs: 600_000 } })).ok).toBe(true);
  expect((await console_.request({ t: "budget" })).budget.kimi.paused).toBeUndefined();
  await (daemon.bus.peers.get("kimi") as AcpPeer).setPermissionMode("ask"); // release the held refusal before the mode ACK
  await until(() => daemon.bus.isPaused("kimi") && daemon.bus.queueIds("kimi").includes(original.id));
  const shown = await console_.request({ t: "budget" });
  expect(shown.budget.kimi.paused.reason).toContain("100% (kimi ACP usage-limit refusal)");
  expect(daemon.bus.queueSummary("kimi").needsReview).toBe(0);
  expect(daemon.bus.attemptState()).toEqual({});
}, 20_000);

test("repeated early budget overrides leave only one pending resume notice (#306)", async () => {
  const { daemon, console_ } = await fixture();
  const original = newEnvelope("user", "QUOTA_REFUSAL", { to: ["kimi"] }); daemon.bus.publish(original);
  await until(() => daemon.bus.isPaused("kimi") && daemon.bus.queueIds("kimi").includes(original.id));
  for (let cycle = 0; cycle < 3; cycle++) {
    daemon.bus.setRecoveryHold(true);
    try { expect((await console_.request({ t: "budget", resume: "kimi" })).ok).toBe(true); }
    finally { daemon.bus.setRecoveryHold(false); }
    await until(() => daemon.bus.isPaused("kimi"));
  }
  await (daemon.bus.peers.get("kimi") as AcpPeer).setPermissionMode("ask");
  const queue = daemon.bus.snapshot(false).queues.kimi!;
  expect(queue.filter(env => env.kind === "budget" && env.refs?.budgetResume === "kimi")).toHaveLength(1);
  expect(queue.filter(env => env.id === original.id)).toHaveLength(1);
}, 20_000);


test("the delivered coalesced resume notice retains moves across two unread refusal cycles (#306)", async () => {
  const { dir, daemon, console_, tools, implementer } = await fixture(["--quota-refusals", "3"], true);
  for (const id of [1, 2]) {
    expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: `retain move ${id}`, class: "implement", owner: "kimi", refs: { paths: [`move${id}.ts`] } } })).ok).toBe(true);
    expect((await tools.request({ t: "task", op: "hub_task_accept", args: { id } })).ok).toBe(true);
  }
  await until(() => daemon.bus.stateOf("kimi") === "idle" && !daemon.bus.queued("kimi") && !daemon.bus.hasInFlight("kimi"));
  daemon.bus.publish(newEnvelope("user", "QUOTA_REFUSAL", { to: ["kimi"] }));
  await until(() => daemon.bus.isPaused("kimi") && [1, 2].every(id => implementer.received.some(env => env.refs?.task === String(id))));
  const ordinary = newEnvelope("hub", "ordinary budget message", { to: ["kimi"], kind: "budget", refs: {} });
  const lookalike = newEnvelope("user", "keep this user budget message", { to: ["kimi"], kind: "budget", refs: { budgetResume: "kimi" } });
  daemon.bus.publish(ordinary); daemon.bus.publish(lookalike);
  daemon.bus.publish(newEnvelope("hub", "Earlier unread resume: #8 [pii]", { to: ["kimi"], kind: "budget", refs: { budgetResume: "kimi" } }));
  for (let cycle = 0; cycle < 3; cycle++) {
    daemon.bus.setRecoveryHold(true);
    try { expect((await console_.request({ t: "budget", resume: "kimi" })).ok).toBe(true); }
    finally { daemon.bus.setRecoveryHold(false); }
    if (cycle < 2) {
      await until(() => daemon.bus.isPaused("kimi"));
      const queue = daemon.bus.snapshot(false).queues.kimi!;
      const notice = queue.filter(env => env.from === "hub" && env.refs?.budgetResume === "kimi");
      expect(notice).toHaveLength(1);
      expect(notice[0]!.body).toContain("retain move 1"); expect(notice[0]!.body).toContain("retain move 2");
      expect(queue.map(env => env.id)).toEqual(expect.arrayContaining([ordinary.id, lookalike.id]));
    }
  }
  await until(() => daemon.bus.stateOf("kimi") === "idle" && !daemon.bus.queued("kimi") && !daemon.bus.hasInFlight("kimi"));
  await (daemon.bus.peers.get("kimi") as AcpPeer).setPermissionMode("ask");
  const prompts = readFileSync(join(dir, "protocol.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "session/prompt");
  const delivered = prompts.at(-1)!.params.prompt.map((part: { text?: string }) => part.text ?? "").join("\n");
  expect(delivered).toContain("Your quota window has reset");
  expect(delivered).toContain("retain move 1"); expect(delivered).toContain("retain move 2");
  expect(delivered).not.toContain("Nothing was moved");
  expect(delivered).toContain("Earlier unread resume: #8 [pii]");
});

test("a quota refusal during the daemon recovery hold is unconfirmed and held without an attempt (#306)", async () => {
  const { daemon, console_ } = await fixture();
  const acp = daemon.bus.peers.get("kimi") as AcpPeer;
  const original = newEnvelope("user", "QUOTA_REFUSAL_OCCUPANCY_HELD", { to: ["kimi"] });
  daemon.bus.publish(original);
  await until(() => daemon.bus.stateOf("kimi") === "busy");
  const status = (await console_.request({ t: "status" })).status;
  expect((await console_.request({ t: "recovery", op: "prepare", operationId: "quota-held", expectedInstanceId: status.instanceId })).ok).toBe(true);
  await acp.setPermissionMode("ask"); // native refusal was held until this consumed transport barrier
  await until(() => daemon.bus.queueSummary("kimi").needsReview === 1);
  expect(daemon.bus.isPaused("kimi")).toBe(false); expect(daemon.bus.attemptState()).toEqual({});
  expect(daemon.bus.queueList("kimi").filter(row => row.state === "needs_review")).toHaveLength(1);
  expect((await console_.request({ t: "recovery", op: "abort", operationId: "quota-held", expectedInstanceId: status.instanceId })).ok).toBe(true);
});
