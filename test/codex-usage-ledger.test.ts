import { afterEach, expect, test } from "bun:test";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

// #683 U1: Codex's usage breakdown. A fake app-server that reports a distinct, non-zero value for every kind, so a mix-up of
// input, cached input, output and reasoning cannot cancel out (the shared fake reports cached and reasoning as 0).
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); await Bun.sleep(100); /* let a stopped native child report its exit before the next test */ });
const until = async (cond: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 10 && !cond(); i++) await Bun.sleep(10); expect(cond()).toBe(true); };

type Kinds = { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
/** A minimal `codex app-server`: one thread, one turn per prompt, and a `thread/tokenUsage/updated` per turn from `script`. */
function fakeAppServer(script: Kinds[], resumedTotal?: Kinds) {
  let turn = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return new URL(req.url).pathname === "/healthz" ? new Response("ok") : srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { message(ws, data): void {
      const msg = JSON.parse(String(data));
      const reply = (result: unknown): void => { ws.send(JSON.stringify({ id: msg.id, result })); };
      const note = (method: string, params: unknown): void => { ws.send(JSON.stringify({ method, params })); };
      if (msg.method === "initialize") { reply({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" }); return; }
      if (msg.method === "thread/start") { reply({ thread: { id: "th1" } }); return; }
      if (msg.method === "thread/resume") { reply({ thread: { id: "th-old" } }); if (resumedTotal) note("thread/tokenUsage/updated", { threadId: "th-old", turnId: "old", tokenUsage: { total: resumedTotal, last: resumedTotal } }); return; }
      if (msg.method === "account/rateLimits/read") { reply({ rateLimits: { primary: null, secondary: null } }); return; }
      if (msg.method === "turn/start") {
        const id = `turn${++turn}`, thread = msg.params.threadId;
        reply({ turn: { id, status: "inProgress", items: [], error: null } });
        note("turn/started", { threadId: thread, turn: { id, status: "inProgress", items: [], error: null } });
        note("item/completed", { threadId: thread, turnId: id, completedAtMs: Date.now(), item: { type: "agentMessage", id: "m", phase: "final_answer", text: "ok" } });
        const total = script[turn - 1]!;
        note("thread/tokenUsage/updated", { threadId: thread, turnId: id, tokenUsage: { total, last: total } });
        note("turn/completed", { threadId: thread, turn: { id, status: "completed", items: [], error: null } });
      }
    } },
  });
  cleanup.push(() => server.stop(true));
  return `ws://127.0.0.1:${server.port}`;
}

async function rig(script: Kinds[], resumedTotal?: Kinds) {
  const breakdowns: { input: number; cachedInput: number; output: number; reasoning: number; total: number }[] = [], totals: number[] = [];
  const bus = new Bus({ batchMs: 0 });
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fakeAppServer(script, resumedTotal), cwd: process.cwd(),
    onTokens: n => totals.push(n), onTokenBreakdown: delta => breakdowns.push(delta) });
  bus.add(peer); await peer.start(); cleanup.push(() => peer.stop());
  const seen: any[] = [], tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = ev => seen.push(JSON.parse(String(ev.data)));
  await new Promise(resolve => (tui.onopen = resolve)); cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  return { bus, peer, tui, breakdowns, totals };
}
const k = (input: number, cached: number, output: number, reasoning: number): Kinds => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });

test("the breakdown deltas are the growth of each kind and their total equals the growth of totalTokens, next to the unchanged total (#683 U1)", async () => {
  // Codex's own definition: cached input is part of input, reasoning is part of output; totalTokens = input + output.
  const script = [k(1000, 700, 50, 20), k(2500, 2100, 130, 70), k(2500, 2100, 130, 70) /* no growth */];
  const { bus, peer, tui, breakdowns, totals } = await rig(script);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("user", "one", { to: ["codex"] }));
  await until(() => breakdowns.length === 1 && peer.state === "idle");
  bus.publish(newEnvelope("user", "two", { to: ["codex"] }));
  await until(() => breakdowns.length === 2 && peer.state === "idle");
  bus.publish(newEnvelope("user", "three", { to: ["codex"] }));
  await until(() => peer.state === "idle"); await Bun.sleep(60);
  // A fresh thread counts from zero; the second update adds only what grew; an update with no growth adds nothing.
  expect(breakdowns).toEqual([{ input: 1000, cachedInput: 700, output: 50, reasoning: 20, total: 1050 }, { input: 1500, cachedInput: 1400, output: 80, reasoning: 50, total: 1580 }]);
  expect(totals).toEqual([1050, 1580]); // the existing `tokens` increments are unchanged
  for (const d of breakdowns) expect(d.input + d.output).toBe(d.total); // the kinds sum to the totalTokens increment
});

test("a resumed thread's replayed counters are history, not usage, and later growth is split from that baseline (#683 U1)", async () => {
  const { bus, peer, tui, breakdowns, totals } = await rig([k(5400, 5000, 140, 60)], k(5000, 4800, 100, 40));
  tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "th-old" } }));
  await until(() => peer.state === "idle"); await Bun.sleep(60);
  expect(breakdowns).toEqual([]); expect(totals).toEqual([]);
  bus.publish(newEnvelope("user", "after resume", { to: ["codex"] }));
  await until(() => breakdowns.length === 1);
  expect(breakdowns[0]).toEqual({ input: 400, cachedInput: 200, output: 40, reasoning: 20, total: 440 });
  expect(totals).toEqual([440]);
});

// The acceptance path: a real daemon starts a real Codex peer against the shared fake app-server, and the events land in events.jsonl.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

function freePort() { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true); return port; }
const log = (stateDir: string) => { try { return readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

test("the daemon writes a codex_appserver usage event next to the tokens event, with the task, and a pause then resume to the log (#683 U1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-usage-ledger-")), stateDir = join(root, "state"), bin = join(root, "fake-codex");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(bin, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(),
    config: { ...DEFAULT_CONFIG, codex_bin: bin, batch_ms: 0, budget: { ...DEFAULT_CONFIG.budget, checkpoint_timeout_s: 1 }, // a soft pause asks the peer for a checkpoint first memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false } } });
  cleanup.push(async () => { await daemon.stop(); });
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => console_.close());
  const started = await console_.request({ t: "start", peer: "codex" });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const seen: any[] = [], tui = new WebSocket(started.proxyUrl);
  tui.onmessage = ev => seen.push(JSON.parse(String(ev.data))); cleanup.push(() => tui.close());
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake TUI failed")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  await until(() => seen.some(m => m.id === 1));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => daemon.bus.stateOf("codex") === "idle");
  expect((await console_.request({ t: "send", to: ["codex"], body: "one" })).ok).toBe(true);
  await until(() => log(stateDir).some(e => e.type === "usage" && e.source === "codex_appserver"));
  const events = log(stateDir);
  const usage = events.find(e => e.type === "usage" && e.source === "codex_appserver"), tokens = events.find(e => e.type === "tokens" && e.peer === "codex");
  // The shared fake reports a turn of 100 tokens: 90 input and 10 output, no cached or reasoning.
  expect(usage).toMatchObject({ type: "usage", peer: "codex", source: "codex_appserver", inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 100 });
  expect(String(usage.id)).toMatch(/^codex:[a-z0-9]+:codex:\d+$/);
  // Usage telemetry has no session id (docs/events.md): the id names the run, peer and a sequence, never the native thread.
  expect(JSON.stringify(usage)).not.toContain("th1"); expect(JSON.stringify(usage)).not.toMatch(/thread|session/i);
  expect(usage.attribution).toBe("unattributed"); expect(usage.task).toBeUndefined(); // codex owns no open task yet
  // The same peer with exactly one open task: the next update is attributed to it, on both the usage and the tokens event.
  const proposed = await console_.request({ t: "task", op: "hub_task_propose", args: { title: "ledger fixture task", class: "implement", owner: "codex" } });
  expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
  const taskId = Number(String(proposed.text).match(/task #(\d+)/)?.[1]);
  const assigned = await console_.request({ t: "task", op: "task_assign", args: { id: taskId, peer: "codex", role: "owner" } });
  expect(assigned.ok, JSON.stringify(assigned)).toBe(true);
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root }); cleanup.push(() => tools.close());
  const accepted = await tools.request({ t: "task", op: "hub_task_accept", args: { id: taskId } });
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  await until(() => daemon.bus.stateOf("codex") === "idle");
  const countBefore = log(stateDir).filter(e => e.type === "usage" && e.source === "codex_appserver").length;
  expect((await console_.request({ t: "send", to: ["codex"], body: "two" })).ok).toBe(true);
  await until(() => log(stateDir).filter(e => e.type === "usage" && e.source === "codex_appserver").length > countBefore);
  const attributed = log(stateDir).filter(e => e.type === "usage" && e.source === "codex_appserver").at(-1);
  expect(attributed).toMatchObject({ task: taskId, attribution: "single_open", totalTokens: 100 });
  expect(log(stateDir).filter(e => e.type === "tokens" && e.peer === "codex").at(-1)).toMatchObject({ task: taskId, attribution: "single_open", n: 100 });
  expect(new Set(log(stateDir).filter(e => e.type === "usage" && e.source === "codex_appserver").map(e => e.id)).size).toBe(countBefore + 1); // ids are unique
  expect(tokens).toMatchObject({ type: "tokens", peer: "codex", n: 100 }); // the existing event is unchanged
  expect(usage.inputTokens + usage.outputTokens).toBe(tokens.n);
  // A pause and its resume through the console: both are in the log, the second by the person.
  const before = log(stateDir).length;
  expect((await console_.request({ t: "budget", set: { peer: "codex", used: 0.97, window: "5h", resetsInMs: 3_600_000 } })).ok).toBe(true);
  await until(() => log(stateDir).some(e => e.type === "budget_pause"), 8000); // after the checkpoint request times out (1 s)
  expect((await console_.request({ t: "budget", resume: "codex" })).ok).toBe(true);
  await until(() => log(stateDir).some(e => e.type === "budget_resume"));
  const ledger = log(stateDir).slice(before).filter(e => ["budget_pause", "budget_resume", "quota_reset"].includes(e.type));
  expect(ledger.find(e => e.type === "budget_pause")).toMatchObject({ peer: "codex", window: "5h", by: "hub" });
  expect(ledger.find(e => e.type === "budget_resume")).toMatchObject({ peer: "codex", window: "5h", by: "person", reason: "overridden by the console user" });
  for (const e of ledger) expect(JSON.stringify(e)).not.toMatch(/checkpoint|summary|title/);
}, 15_000);
