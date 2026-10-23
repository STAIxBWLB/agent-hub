import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { readEvents } from "../src/hub/events.ts";
import { renderBudget } from "../src/cli/output.ts";

// #285 phase 4 through the real daemon: the budget reply names each window's kind, a person's value takes precedence over the hub's count,
// a peer without a number says why, and the dashboard snapshot carries the same. Same fixture Kimi home as daemon-kimi-wire.test.ts.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let n = 0; n < 500 && !condition(); n++) await Bun.sleep(10);
  expect(condition(), what).toBe(true);
}
const plain = (lines: { text: string }[][]) => lines.map(line => line.map(span => span.text).join("")).join("\n");

async function rig(ceiling: number, seed: (stateDir: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-budget-sources-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const kimiHome = join(root, "kimi-home"), dir = join(kimiHome, "sessions", "wd_x_1", "session_s1"), wire = join(dir, "agents", "main", "wire.jsonl");
  mkdirSync(join(wire, ".."), { recursive: true }); writeFileSync(wire, `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 })}\n`);
  writeFileSync(join(kimiHome, "session_index.jsonl"), `${JSON.stringify({ sessionId: "s1", sessionDir: dir })}\n`);
  const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true }); seed(stateDir);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, kimiHome, instanceId: "budget-sources",
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: ceiling, checkpoint_timeout_s: 1 }, kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")] } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle", "kimi idle");
  const file = join(stateDir, "events.jsonl");
  const row = (inputOther: number, output: number) => appendFileSync(wire, `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: "turn", time: Date.now() })}\n`);
  const turn = async (text: string) => {
    const before = readEvents(file).filter(e => e.type === "turn_end" && (e as any).peer === "kimi").length;
    daemon.bus.publish(newEnvelope(USER, text, { to: ["kimi"] }));
    await until(() => readEvents(file).filter(e => e.type === "turn_end" && (e as any).peer === "kimi").length > before, `turn ${text}`);
  };
  const budget = async () => await console_.request({ t: "budget" });
  return { daemon, console_, row, turn, budget, wire, kimiHome, dir };
}

test("AC6: with no ceiling, Kimi has no window and says why, in the budget reply and the dashboard snapshot, and ahub budget prints it", async () => {
  const r = await rig(0);
  const reply = await r.budget();
  expect(reply.budget.kimi?.windows ?? []).toEqual([]);
  const note = reply.peers.find((p: any) => p.peer === "kimi");
  expect(note.kind).toBe("no-reading"); expect(note.note).toContain("kimi reports context occupancy only"); // plain checks: Bun's toMatchObject rewrites a received field it matches with an asymmetric matcher
  const snapshot = await r.console_.request({ t: "ui_snapshot", after: 0 });
  expect(snapshot.budget.kimi).toMatchObject({ note: note.note, noteKind: "no-reading" });
  const out = plain(renderBudget({ budget: reply.budget, peers: reply.peers, gate: reply.gate }, 140, Date.now()));
  expect(out).toMatch(/kimi\s+no reading: kimi reports context occupancy only/);
  expect(out).not.toContain("no quota readings yet"); // a peer with a reason is not the empty case
});

test("AC6/AC7: a Kimi turn gives a count window that names its kind and source; the same reaches the dashboard snapshot, and a person's value then outranks it", async () => {
  const r = await rig(1_000_000);
  r.row(100, 20); await r.turn("work please");
  const kimi = (await r.budget()).budget.kimi;
  expect(kimi.windows).toEqual([expect.objectContaining({ id: "tokens", kind: "count", source: "hub count, kimi wire log, of kimi_tokens_5h 1000000" })]);
  expect(kimi.windows[0].superseded).toBe(false);
  expect((await r.budget()).peers.find((p: any) => p.peer === "kimi")).toBeUndefined(); // it has a number, so no note
  const ui = (await r.console_.request({ t: "ui_snapshot", after: 0 })).budget.kimi;
  expect(ui.windows[0]).toMatchObject({ id: "tokens", source: expect.stringContaining("hub count") });
  // AC8 over the real control path: ahub budget set is a person's value, kind manual, and the count turns into information
  const set = await r.console_.request({ t: "budget", set: { peer: "kimi", used: 0.4, window: "5h", resetsInMs: 3_600_000 } });
  expect(set.ok).toBe(true);
  const after = (await r.budget()).budget.kimi.windows as any[];
  expect(after.find(w => w.kind === "manual")).toMatchObject({ id: "5h", used: 0.4, source: "ahub budget set" });
  expect(after.find(w => w.kind === "count")).toMatchObject({ id: "tokens", superseded: true });
  const text = plain(renderBudget({ budget: { kimi: { windows: after } }, gate: 0.9 }, 160, Date.now()));
  expect(text).toMatch(/kimi\s+5h\s+40%.*manual\s+ahub budget set/);
  expect(text).toMatch(/kimi\s+tokens\s+.*count\s+hub count, kimi wire log.*info only/);
});

test("AC8: a manual value under the gate keeps a count over the gate from pausing (the count alone pausing is daemon-kimi-wire.test.ts)", async () => {
  const r = await rig(1000);
  expect((await r.console_.request({ t: "budget", set: { peer: "kimi", used: 0.1, window: "5h", resetsInMs: 3_600_000 } })).ok).toBe(true);
  r.row(900, 90); await r.turn("heavy"); // 99% of the ceiling
  await Bun.sleep(50);
  expect(r.daemon.bus.isPaused("kimi")).toBe(false);
  expect((await r.budget()).budget.kimi.paused).toBeUndefined();
});

test("AC3: the new notes and kinds carry no marker, path or session id from the wire log", async () => {
  const r = await rig(1_000_000);
  appendFileSync(r.wire, `${JSON.stringify({ type: "prompt", text: "BUDGET-MARKER-9917" })}\n`);
  r.row(5, 5); await r.turn("work");
  const surfaces = JSON.stringify([await r.budget(), (await r.console_.request({ t: "ui_snapshot", after: 0 })).budget]);
  for (const secret of ["BUDGET-MARKER-9917", r.kimiHome, r.dir, "session_s1"]) expect(surfaces).not.toContain(secret);
});

test("AC6: Pi and local say no quota with the hub's 5 h count from the event log, and an old row or another peer's is not counted", async () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const r = await rig(0, stateDir => writeFileSync(join(stateDir, "events.jsonl"), [
    { v: 1, at: at(60_000), type: "tokens", peer: "pi", n: 1_000_000 }, { v: 1, at: at(120_000), type: "tokens", peer: "pi", n: 200_000 },
    { v: 1, at: at(6 * 3_600_000), type: "tokens", peer: "pi", n: 9_000_000 },   // outside 5 h
    ...Array.from({ length: 60_000 }, (_, i) => ({ v: 1, at: at(7 * 3_600_000 + i * 1000), type: "tokens", peer: "pi", n: 7 })), // a long-lived project's old log: skipped, never inserted
    { v: 1, at: at(60_000), type: "tokens", peer: "codex", n: 5_000_000 },       // has a quota: no count shown for it
  ].map(e => JSON.stringify(e)).join("\n") + "\n"));
  class Idle extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(_envs: Envelope[]) {} }
  const pi = new Idle("pi"); await pi.start(); r.daemon.bus.add(pi); // Pi is disabled in this rig: an attached stand-in, since a note is for attached peers
  const reply = await r.budget();
  expect(reply.peers.find((p: any) => p.peer === "pi")?.note).toBe("no quota: on-prem backends have no provider quota; 1.2M tokens in 5h (hub count)");
  expect(reply.peers.find((p: any) => p.peer === "codex")?.note ?? "").not.toContain("hub count");
  expect(plain(renderBudget({ budget: reply.budget, peers: reply.peers, gate: reply.gate }, 160, Date.now()))).toMatch(/pi\s+no quota: on-prem backends have no provider quota; 1\.2M tokens in 5h \(hub count\)/);
});
