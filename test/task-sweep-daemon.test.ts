import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsHook } from "../src/cli/facts-hook.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 600 && !condition(); i++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
};

test("advisory production daemon: Claude task sweep requires native Stop, not delivery settlement, and active Pre suppresses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-sweep-native-"));
  const stateDir = join(dir, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(dir, ".agenthub/routing.toml"), '[local]\nfixed_model = "candidate"\n[classes.implement]\npeers = ["worker", "claude"]\nlocal_allowed = false\n[classes.review]\npeers = ["claude", "worker"]\nlocal_allowed = false\n');
  let clock = Date.now(), ticks = 0;
  const daemon = await startDaemon({
    cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, coordination: "advisory", memory: { ...DEFAULT_CONFIG.memory, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: true, interval_s: 1, unaccepted_min: 1, idle_min: 1, review_min: 1 } },
    taskSweepNow: () => { ticks++; return clock; },
  });
  const clients: ControlClient[] = [];
  const receipts: Promise<unknown>[] = [];
  const receiptErrors: string[] = [];
  const delivered: { peer: string; body: string }[] = [];
  const db = new Database(join(stateDir, "hub.db"), { readonly: true });
  try {
    const console_ = await ControlClient.connect(stateDir, { role: "console" }); clients.push(console_);
    for (const name of ["claude", "worker"]) {
      const peer = await ControlClient.connect(stateDir, { role: "peer", peer: name }); clients.push(peer);
      peer.onPush = (message) => {
        if (message.t !== "deliver") return;
        delivered.push(...message.envs.map((env: { body: string }) => ({ peer: name, body: env.body })));
        receipts.push((async () => {
          const accepted = await peer.request({ t: "delivery_receipt", deliveryId: message.deliveryId, generation: message.generation, state: "accepted" });
          if (!accepted.ok) throw new Error("accept refused");
          const complete = await peer.request({ t: "delivery_complete", deliveryId: message.deliveryId, generation: message.generation });
          if (!complete.ok) throw new Error("complete refused");
        })().catch(error => { receiptErrors.push(String(error)); }));
      };
    }
    await until(() => daemon.bus.stateOf("claude") === "idle" && daemon.bus.stateOf("worker") === "idle", "native bridge attach");
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); clients.push(tools);
    const worker = await ControlClient.connect(stateDir, { role: "tools", peer: "worker" }); clients.push(worker);
    const op = async (client: ControlClient, name: string, args: Record<string, unknown>) => {
      const result = await client.request({ t: "task", op: name, args });
      expect(result.ok).toBe(true);
      return result.text as string;
    };
    const propose = async (owner: string, path: string) => {
      const result = await op(console_, "hub_task_propose", { title: path, class: "implement", owner, refs: { paths: [path] } });
      return Number(/task #(\d+)/.exec(result)![1]);
    };
    const proposed = await propose("claude", "proposed.ts");
    const active = await propose("claude", "active.ts");
    await op(tools, "hub_task_accept", { id: active });
    const review = await propose("worker", "review.ts");
    await op(worker, "hub_task_accept", { id: review });
    expect(await op(worker, "hub_task_done", { id: review, summary: "ready" })).toContain("reviewer claude");
    await until(() => ["claude", "worker"].every(peer => !daemon.bus.queued(peer) && !daemon.bus.hasInFlight(peer) && !daemon.bus.queueSummary(peer).liveAccepted?.length), "settled delivery receipts");
    await Promise.all(receipts);
    expect(receiptErrors).toEqual([]);
    const records = () => (db.query("SELECT id, state, history FROM tasks ORDER BY id").all() as { id: number; state: string; history: string }[]).map(row => ({ ...row, history: JSON.parse(row.history) as { sweep?: { kind: string; step: number } }[] }));
    const count = () => records().reduce((total, task) => total + task.history.filter(entry => entry.sweep).length, 0);
    expect(records().map(row => row.state)).toEqual(["proposed", "in_progress", "in_review"]);
    clock = Date.now() + 3 * 60 * 60_000;
    let nextTick = ticks + 1;
    await until(() => ticks >= nextTick, "sweep after delivery acknowledgement");
    expect(count()).toBe(0); // delivery_complete is not native turn completion
    expect(await factsHook(JSON.stringify({ hook_event_name: "Stop", session_id: "advisory-session" }), stateDir, "claude")).toBeUndefined();
    await Bun.sleep(2);
    expect(await factsHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "active.ts") }, session_id: "advisory-session" }), stateDir, "claude")).toBeUndefined();
    nextTick = ticks + 1;
    await until(() => ticks >= nextTick, "sweep during active native tool");
    expect(count()).toBe(0); // actual Pre supersedes Stop; advisory never injects facts
    expect(await factsHook(JSON.stringify({ hook_event_name: "Stop", session_id: "advisory-session" }), stateDir, "claude")).toBeUndefined();
    await until(() => [proposed, active, review].every(id => records().find(row => row.id === id)!.history.some(entry => entry.sweep?.step === 1)), "all three native-stopped findings");
    await until(() => delivered.filter(row => row.peer === "claude" && row.body.includes("idle escalation 1/3")).length === 3, "Claude reminders");
    expect(records().flatMap(row => row.history.flatMap(entry => entry.sweep ? [entry.sweep.kind] : []))).toEqual(["unaccepted-assignment", "idle-owner", "review-pending"]);
    expect(receiptErrors).toEqual([]);
  } finally {
    await Promise.all(receipts);
    for (const client of clients.reverse()) client.close();
    db.close();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
