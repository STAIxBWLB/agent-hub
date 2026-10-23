import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";

// #285 phase 2 end to end: the fake ACP agent (session "s1") plus a fixture Kimi home in wire protocol 1.5 (Kimi 2.3.0's format; the issue read 2.1.1).
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let n = 0; n < 500 && !condition(); n++) await Bun.sleep(10);
  expect(condition(), what).toBe(true);
}
const MARKER = "WIRE-PROMPT-MARKER-5521";

async function rig(ceiling: number) {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-wire-daemon-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const kimiHome = join(root, "kimi-home"), dir = join(kimiHome, "sessions", "wd_x_1", "session_s1"), wire = join(dir, "agents", "main", "wire.jsonl"), sub = join(dir, "agents", "agent-0", "wire.jsonl");
  for (const file of [wire, sub]) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 })}\n`); }
  writeFileSync(join(kimiHome, "session_index.jsonl"), `${JSON.stringify({ sessionId: "s1", sessionDir: dir })}\n`);
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, kimiHome, instanceId: "kimi-wire",
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: ceiling, checkpoint_timeout_s: 1 }, // a soft pause asks the peer for a checkpoint first; the fake never answers

      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")] } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const pushes: any[] = []; console_.onPush = m => pushes.push(m); console_.send({ t: "tail" });
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle", "kimi idle");
  const file = join(stateDir, "events.jsonl");
  const row = (to: string, inputOther: number, output: number, cacheRead = 0, cacheWrite = 0) => appendFileSync(to, `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther, output, inputCacheRead: cacheRead, inputCacheCreation: cacheWrite }, usageScope: "turn", time: Date.now() + 2000 })}\n`);
  const turn = async (text: string) => {
    const before = readEvents(file).filter(e => e.type === "turn_end" && (e as any).peer === "kimi").length;
    daemon.bus.publish(newEnvelope(USER, text, { to: ["kimi"] }));
    await until(() => readEvents(file).filter(e => e.type === "turn_end" && (e as any).peer === "kimi").length > before, `turn ${text}`);
  };
  return { root, daemon, console_, pushes, file, wire, sub, row, turn, kimiHome, dir, stateDir };
}
const kimiEvents = (file: string, type: string) => readEvents(file).filter(e => e.type === type && (e as any).peer === "kimi") as any[];

test("AC4/AC5: a Kimi turn writes usage and tokens events and a tokens window; cache reads are recorded, not counted; sub-agents count", async () => {
  const r = await rig(1_000_000);
  r.row(r.wire, 100, 20, 50_000, 30); r.row(r.sub, 10, 5, 7);
  await r.turn("work please");
  const usage = kimiEvents(r.file, "usage");
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({ source: "kimi_wire", inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 0, servedModel: "kimi-code/k3" });
  expect(usage[1]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50_000, cacheWriteTokens: 30, totalTokens: 50_150 });
  expect(kimiEvents(r.file, "tokens").map(e => e.n)).toEqual([15, 150]);
  expect(kimiEvents(r.file, "turn_end").at(-1).tokens).toBe(165);
  const budget = (await r.console_.request({ t: "budget" })).budget.kimi;
  expect(budget.windows).toEqual([expect.objectContaining({ id: "tokens", source: "hub count, kimi wire log, of kimi_tokens_5h 1000000" })]);
  expect(budget.windows[0].used).toBeCloseTo(165 / 1_000_000, 8);
  expect(budget.paused).toBeUndefined();
  // an ACP total from the fake's usage_update adds nothing now
  expect(kimiEvents(r.file, "tokens").reduce((s, e) => s + e.n, 0)).toBe(165);
});

test("AC3: no marker, path or session id from the wire log reaches an event, the status, the budget or the notices", async () => {
  const r = await rig(1_000_000);
  appendFileSync(r.wire, `${JSON.stringify({ type: "prompt", text: MARKER })}\n${JSON.stringify({ type: "tool.result", text: MARKER })}\n`);
  r.row(r.wire, 5, 5);
  await r.turn("work");
  const status = JSON.stringify((await r.console_.request({ t: "status" })).status);
  const budget = JSON.stringify((await r.console_.request({ t: "budget" })).budget);
  const ui = JSON.stringify(await r.console_.request({ t: "ui_snapshot", after: 0 }));
  const events = JSON.stringify(readEvents(r.file).filter(e => e.type === "usage" || e.type === "tokens"));
  const notices = JSON.stringify(r.pushes.filter(p => p.t === "notice"));
  for (const surface of [status, budget, ui, events, notices]) for (const secret of [MARKER, r.kimiHome, r.dir, "session_s1"]) expect(surface).not.toContain(secret);
  expect(events).toContain("kimi_wire");
});

test("AC4: over the gate the budget pauses Kimi; after a resume the count starts from the new window", async () => {
  const r = await rig(100);
  r.row(r.wire, 90, 10); // 100 of 100
  await r.turn("heavy");
  await until(() => !!kimiEvents(r.file, "budget_pause").length, "pause");
  expect(kimiEvents(r.file, "budget_pause")[0]).toMatchObject({ window: "tokens" });
  const shown = await r.console_.request({ t: "status" });
  expect(shown.status.peers.kimi.paused).toContain("hub count, kimi wire log");
  expect((await r.console_.request({ t: "budget", resume: "kimi" })).ok).toBe(true);
  await until(() => r.daemon.bus.stateOf("kimi") === "idle", "idle again");
  expect((await r.console_.request({ t: "budget" })).budget.kimi.windows ?? []).toEqual([]); // the old numbers describe the window that ended
  r.row(r.wire, 10, 5);
  await r.turn("light");
  const budget = (await r.console_.request({ t: "budget" })).budget.kimi;
  expect(budget.windows[0].used).toBeCloseTo(0.15, 6); // 15 of 100: the pre-resume 100 is gone
  expect(budget.paused).toBeUndefined();
});

test("AC2: an unreadable wire log gives unknown and one notice: no window, no count", async () => {
  const r = await rig(1_000_000);
  r.row(r.wire, 10, 10);
  await r.turn("one");
  expect((await r.console_.request({ t: "budget" })).budget.kimi.windows).toHaveLength(1);
  truncateSync(r.wire, 7);
  r.row(r.sub, 99, 99);
  await r.turn("two");
  await r.turn("three");
  expect((await r.console_.request({ t: "budget" })).budget.kimi.windows ?? []).toEqual([]);
  expect(kimiEvents(r.file, "tokens").map(e => e.n)).toEqual([20]);
  expect(r.pushes.filter(p => p.t === "notice" && String(p.line).startsWith("kimi usage unknown"))).toHaveLength(1);
  expect(String(r.pushes.find(p => p.t === "notice" && String(p.line).startsWith("kimi usage unknown"))?.line)).toContain("shrunk");
});

test("with the ceiling off the usage and tokens events still flow and no window is reported", async () => {
  const r = await rig(0);
  r.row(r.wire, 10, 10);
  await r.turn("one");
  expect(kimiEvents(r.file, "tokens").map(e => e.n)).toEqual([20]);
  expect((await r.console_.request({ t: "budget" })).budget.kimi?.windows ?? []).toEqual([]); // no ceiling: no window
});
