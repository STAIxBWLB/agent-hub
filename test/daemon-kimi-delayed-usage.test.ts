import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import type { KimiUsageScheduler } from "../src/hub/kimi-usage.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let n = 0; n < 500 && !condition(); n++) await Bun.sleep(10);
  expect(condition(), what).toBe(true);
}
const events = (file: string, type: string) => readEvents(file).filter(event => event.type === type && (event as any).peer === "kimi") as any[];

function manualScheduler() {
  let seq = 0, size = 0, maxSize = 0;
  const pending = new Map<number, { delay: number; run: () => void }>();
  const schedule: KimiUsageScheduler = (delay, run) => {
    const id = ++seq; pending.set(id, { delay, run }); size = Math.max(size, pending.size); maxSize = Math.max(maxSize, pending.size);
    return () => { pending.delete(id); };
  };
  return {
    schedule,
    maxSize: () => maxSize,
    size: () => pending.size,
    fire: () => {
      const next = pending.entries().next().value as [number, { delay: number; run: () => void }] | undefined;
      expect(next, "a delayed daemon drain is pending").toBeDefined();
      if (!next) return;
      pending.delete(next[0]); next[1].run();
    },
  };
}

async function rig(options: { realTimers?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-delayed-daemon-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const kimiHome = join(root, "kimi-home"), dir = join(kimiHome, "sessions", "wd_x_1", "session_s1"), wire = join(dir, "agents", "main", "wire.jsonl");
  mkdirSync(join(wire, ".."), { recursive: true });
  writeFileSync(wire, `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 })}\n`);
  writeFileSync(join(kimiHome, "session_index.jsonl"), `${JSON.stringify({ sessionId: "s1", sessionDir: dir })}\n`);
  const stateDir = join(root, "state"), timers = manualScheduler();
  const daemon = await startDaemon({
    cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, kimiHome, instanceId: "kimi-delayed-usage",
    ...(options.realTimers ? {} : { kimiUsageScheduler: timers.schedule }),
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: 1_000_000, checkpoint_timeout_s: 1 },
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")] },
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const pushes: any[] = []; console_.onPush = message => pushes.push(message); console_.send({ t: "tail" });
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle", "kimi idle");
  const file = join(stateDir, "events.jsonl");
  const row = (at: number, inputOther: number, output: number, extra: object = {}) => appendFileSync(wire, `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther, output, inputCacheRead: 100, inputCacheCreation: 0 }, usageScope: "turn", time: at, ...extra })}\n`);
  const turn = async (text: string, options: { task?: number; during?: () => void | Promise<void> } = {}) => {
    const beforeStart = events(file, "turn_start").length, beforeEnd = events(file, "turn_end").length;
    daemon.bus.publish(newEnvelope(USER, text, { to: ["kimi"], ...(options.task ? { refs: { task: String(options.task) } } : {}) }));
    await until(() => events(file, "turn_start").length > beforeStart, `turn start ${text}`);
    await options.during?.();
    await until(() => events(file, "turn_end").length > beforeEnd, `turn end ${text}`);
  };
  return { root, daemon, console_, pushes, file, wire, row, turn, timers, kimiHome, dir, stateDir };
}

test("#1281 AC1/AC3/AC7: the production delayed drain records a post-result row once without another turn and without native text", async () => {
  const r = await rig({ realTimers: true }), marker = "DELAYED-DAEMON-SECRET-1281";
  await r.turn("ordinary delayed usage");
  const started = events(r.file, "turn_start").at(-1)!;
  const ended = events(r.file, "turn_end").at(-1)!;
  appendFileSync(r.wire, `${JSON.stringify({ type: "prompt", text: marker })}\n${JSON.stringify({ type: "tool.result", text: marker })}\n`);
  r.row(Date.parse(started.at), 7, 3, { prompt: marker, answer: marker });
  await until(() => events(r.file, "usage").length === 1, "delayed usage.record collected");
  expect(events(r.file, "tokens").map(event => event.n)).toEqual([10]);
  expect(events(r.file, "turn_end").at(-1)).toEqual(ended);
  const budget = (await r.console_.request({ t: "budget" })).budget.kimi;
  expect(budget.windows[0].used).toBeCloseTo(10 / 1_000_000, 8);
  const rolled = await r.console_.request({ t: "usage", by: "peer" });
  expect(rolled.usage.rows.find((row: any) => row.key === "kimi").counted).toEqual({ value: 10, source: "count" });
  const surfaces = JSON.stringify([readEvents(r.file), budget, rolled, r.pushes, await r.console_.request({ t: "status" })]);
  for (const secret of [marker, r.kimiHome, r.dir, "session_s1"]) expect(surfaces).not.toContain(secret);
  await r.daemon.stop();
  expect(events(r.file, "usage")).toHaveLength(1);
  expect(events(r.file, "tokens")).toHaveLength(1);
});

test("#1281 AC2/AC4: a delayed row keeps task A while task B is open, never changes either turn_end, and ambiguity is unattributed", async () => {
  const r = await rig();
  await r.turn("task A", { task: 101 });
  const aStart = events(r.file, "turn_start").at(-1)!, aEnd = events(r.file, "turn_end").at(-1)!;
  await until(() => Date.now() > Date.parse(aEnd.at), "A and B have distinct native-time intervals");
  await r.turn("task B", { task: 202, during: () => {
    r.row(Date.parse(aStart.at), 12, 3);
    r.timers.fire();
    expect(r.daemon.bus.stateOf("kimi")).toBe("busy");
  } });
  const bEnd = events(r.file, "turn_end").at(-1)!;
  expect(events(r.file, "turn_end")).toEqual([aEnd, bEnd]);
  expect(aEnd.tokens).toBeUndefined(); expect(bEnd.tokens).toBeUndefined();
  expect(events(r.file, "usage")).toHaveLength(1);
  expect(events(r.file, "usage")[0]).toMatchObject({ task: 101, attribution: "delivery" });
  expect(events(r.file, "tokens")[0]).toMatchObject({ n: 15, task: 101, attribution: "delivery" });
  expect(events(r.file, "turn_end")[0]).toEqual(aEnd);
  const byTask = await r.console_.request({ t: "usage", by: "task" });
  expect(byTask.usage.rows.find((row: any) => row.key === "101").counted).toEqual({ value: 15, source: "count" });
  expect(byTask.usage.rows.some((row: any) => row.key === "202")).toBe(false);
  await r.turn("task C", { task: 303, during: () => {
    r.row(Date.parse(aStart.at) - 1, 2, 1);
    r.timers.fire();
  } });
  expect(events(r.file, "usage").at(-1)).toMatchObject({ attribution: "unattributed" });
  expect(events(r.file, "usage").at(-1)?.task).toBeUndefined();
  expect(events(r.file, "tokens").at(-1)).toMatchObject({ n: 3, attribution: "unattributed" });
  expect(events(r.file, "tokens").at(-1)?.task).toBeUndefined();
  expect(events(r.file, "turn_end").at(-1)?.tokens).toBeUndefined();
  expect(r.timers.maxSize()).toBe(1);
  await r.daemon.stop();
  expect(r.timers.size()).toBe(0);
  expect(events(r.file, "usage")).toHaveLength(2);
});
