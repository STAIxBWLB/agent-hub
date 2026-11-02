import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { TASK_TOOLS, TASK_TOOL_NAMES } from "../src/hub/hub-tools.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { WsPeer } from "../src/adapters/channel-peer.ts";

const roots: string[] = [];
const until = async (ready: () => boolean, label: string) => {
  for (let index = 0; index < 200 && !ready(); index++) await Bun.sleep(5);
  expect(ready(), label).toBe(true);
};

class BusyPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  setBusy() { this.setState("busy"); }
  async deliver(_envs: Envelope[]) {}
}

test("the current Bus disposition path reproduces own completed/discard refusal while busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-busy-own-disposition-"));
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "busy-disposition", instanceId: "fixture" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    for (const id of ["own-completed", "own-discard"]) {
      const env = newEnvelope(USER, `synthetic uncertain ${id}`, { to: ["claude"], kind: "task" });
      journal.createDelivery({ id, peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    }
    const peer = new BusyPeer("claude"); bus.add(peer); await peer.start(); peer.setBusy();
    for (const [id, action] of [["own-completed", "completed"], ["own-discard", "discard"]] as const) {
      const row = bus.queueShow(id)!;
      expect(() => bus.resolveDelivery(id, row.revision, action, `synthetic owner disposition ${action}`, "peer:claude")).not.toThrow();
      expect(bus.queueShow(id)?.state).toBe(action === "completed" ? "completed" : "discarded");
    }
  } finally { bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
});

test("busy channel owner settles its own uncertain deliveries and inbox reads queued work behind them", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-owner-delivery-")); roots.push(root);
  const stateDir = join(root, ".agenthub", "state"); mkdirSync(stateDir, { recursive: true });
  const projectId = "owner-delivery-fixture";
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose(USER, { title: "synthetic held delivery task", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
  board.update(task.id, "claude", "accepted", { owner: "claude", reviewer: USER, state: "in_progress" });
  const taskState = board.get(task.id)!.state;
  board.close();

  const seed = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: root, projectId, instanceId: "seed-instance" });
  const heldRows = [
    { id: "claude-complete", peer: "claude" },
    { id: "claude-discard", peer: "claude" },
    { id: "codex-held", peer: "codex" },
  ];
  for (const row of heldRows) {
    const env = newEnvelope(USER, `synthetic uncertain ${row.id}`, { to: [row.peer], kind: "task", refs: { task: String(task.id) } });
    seed.createDelivery({ id: row.id, peer: row.peer, state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  }
  seed.close();

  const daemon = await startDaemon({ cwd: root, stateDir, projectId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } },
  });
  const owner = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: root });
  const other = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root });
  const readback = new Board(join(stateDir, "hub.db"));
  try {
    await until(() => daemon.bus.peers.get("claude")?.state === "idle" && (daemon.bus.peers.get("claude") as WsPeer).attached, "owner channel attaches");
    const peer = daemon.bus.peers.get("claude") as WsPeer;
    peer.nativeStarted("synthetic-busy-turn");
    expect(daemon.bus.stateOf("claude")).toBe("busy");
    const queued = ["queued-after-held-1", "queued-after-held-2", "queued-after-held-3"].map((body) => newEnvelope(USER, body, { to: ["claude"], kind: "task" }));
    for (const env of queued) daemon.bus.publish(env);
    expect(daemon.bus.queued("claude")).toBe(3);

    const revisions = Object.fromEntries(heldRows.filter(row => row.peer === "claude").map(row => [row.id, daemon.bus.queueShow(row.id)!.revision]));
    const inbox = await owner.request({ t: "inbox" });
    expect(inbox.ok).toBe(true);
    expect(inbox.envs.map((env: Envelope) => env.id)).toEqual(queued.map(env => env.id));
    expect(inbox.held.rows.map((row: { id: string }) => row.id)).toEqual(["claude-complete", "claude-discard"]);
    expect(inbox.held.rows.map((row: { revision: number }) => row.revision)).toEqual([revisions["claude-complete"], revisions["claude-discard"]]);
    const definition = TASK_TOOLS.find(tool => tool.name === "hub_delivery_resolve");
    expect(definition).toBeDefined();
    expect(TASK_TOOL_NAMES.has("hub_delivery_resolve")).toBe(true);
    expect(definition!.inputSchema.required).toEqual(["delivery_id", "revision", "action", "reason"]);
    expect(daemon.bus.queueShow("claude-complete")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("claude-discard")?.state).toBe("needs_review");
    expect(daemon.bus.queued("claude")).toBe(0);
    expect(readback.get(task.id)?.state).toBe(taskState);
    expect(daemon.bus.stateOf("claude")).toBe("busy");

    const foreign = await other.request({ t: "task", op: "hub_delivery_resolve", args: {
      delivery_id: "claude-complete", revision: revisions["claude-complete"], action: "completed", reason: "synthetic foreign attempt",
    } });
    expect(foreign.ok).toBe(false);
    expect(daemon.bus.queueShow("claude-complete")?.state).toBe("needs_review");
    const missingReason = await owner.request({ t: "task", op: "hub_delivery_resolve", args: {
      delivery_id: "claude-complete", revision: revisions["claude-complete"], action: "completed",
    } });
    expect(missingReason.ok).toBe(false);
    expect(daemon.bus.queueShow("claude-complete")?.state).toBe("needs_review");

    const completeArgs = { delivery_id: "claude-complete", revision: revisions["claude-complete"], action: "completed", reason: "synthetic owner confirmed handling" };
    const completed = await owner.request({ t: "task", op: "hub_delivery_resolve", args: completeArgs });
    expect(completed.ok).toBe(true);
    const completedRow = daemon.bus.queueShow("claude-complete")!;
    expect(completedRow.state).toBe("completed");
    const settledRevision = completedRow.revision;
    expect((await owner.request({ t: "task", op: "hub_delivery_resolve", args: completeArgs })).ok).toBe(true);
    expect(daemon.bus.queueShow("claude-complete")?.revision).toBe(settledRevision);
    const staleRevision = await owner.request({ t: "task", op: "hub_delivery_resolve", args: { ...completeArgs, revision: settledRevision + 1 } });
    expect(staleRevision.ok).toBe(false);

    const discardArgs = { delivery_id: "claude-discard", revision: revisions["claude-discard"], action: "discard", reason: "synthetic owner discards stale delivery" };
    expect((await owner.request({ t: "task", op: "hub_delivery_resolve", args: discardArgs })).ok).toBe(true);
    expect(daemon.bus.queueShow("claude-discard")?.state).toBe("discarded");
    expect(daemon.bus.queueShow("codex-held")?.state).toBe("needs_review");
    expect(readback.get(task.id)?.state).toBe(taskState);

    const changed = await owner.request({ t: "task", op: "hub_delivery_resolve", args: { ...completeArgs, action: "discard" } });
    expect(changed.ok).toBe(false);
    expect(daemon.bus.queueShow("claude-complete")?.state).toBe("completed");
  } finally { owner.close(); other.close(); readback.close(); await daemon.stop(); }
});
