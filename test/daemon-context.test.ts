import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (f: () => boolean) => { for (let n = 0; n < 350 && !f(); n++) await Bun.sleep(10); expect(f()).toBe(true); };
async function fixture(gate = 0.8, reviewOther = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-context-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const mem = startFakeMemWorker(); cleanup.push(mem.stop);
  mkdirSync(join(cwd, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]');
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), routing);
  const daemon = await startDaemon({ cwd, stateDir: cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, instanceId: "context-instance", config: { ...DEFAULT_CONFIG, batch_ms: 0, ...(reviewOther ? { roles: { ...DEFAULT_CONFIG.roles, other: ["reviewer"] } } : {}), context: { gate, stale_min: 1 }, memory: { ...DEFAULT_CONFIG.memory, enabled: true, worker_url: mem.url }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, budget: { ...DEFAULT_CONFIG.budget, checkpoint_timeout_s: 5 } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(cwd, { role: "console" }); cleanup.push(() => console_.close());
  const pushes: any[] = []; console_.onPush = m => pushes.push(m); console_.send({ t: "tail" });
  const claude = await ControlClient.connect(cwd, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  const other = await ControlClient.connect(cwd, { role: "peer", peer: "other" }); cleanup.push(() => other.close());
  const otherPushes: any[] = []; other.onPush = m => otherPushes.push(m);
  await until(() => daemon.bus.stateOf("claude") === "idle");
  const session = (id = "native-1", launchId = "launch-1") => writeFileSync(join(cwd, "claude-session.json"), JSON.stringify({ instanceId: "context-instance", sessionId: id, launchId }));
  session();
  const reading = (used = 90, fields: Record<string, unknown> = {}) => writeFileSync(join(cwd, "claude-context.json"), JSON.stringify({ instanceId: "context-instance", sessionId: "native-1", launchId: "launch-1", at: Date.now(), context: { context_window_size: 200_000, used_percentage: used, current_usage: { input_tokens: used * 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, ...fields }));
  const tasks = await console_.request({ t: "task", op: "hub_task_propose", args: { title: "implement parser", owner: "claude", class: "implement" } }); expect(tasks.ok).toBe(true);
  return { cwd, daemon, console_, claude, mem, pushes, otherPushes, reading, session };
}
const pressure = (cwd: string) => readEvents(join(cwd, "events.jsonl")).filter(e => e.type === "context_pressure");
const request = (pushes: any[]) => pushes.find(p => p.t === "event" && p.e?.env?.body?.startsWith("Checkpoint request: your native context"))?.e.env;

test("native context checkpoint saves a non-private note without pausing or moving tasks, and never broadcasts its body", async () => {
  const f = await fixture(); f.reading(); await until(() => !!request(f.pushes));
  const ask = request(f.pushes), id = /request_id: "([^"]+)"/.exec(ask.body)![1];
  expect(pressure(f.cwd)).toHaveLength(1);
  const bad = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "wrong request", request_id: "wrong" } }); expect(bad.ok).toBe(false);
  const marker = "parser checkpoint UNIQUE-CONTEXT-SUMMARY";
  const saved = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: marker, request_id: id } }); expect(saved.ok).toBe(true); expect(saved.text).toContain("keep your tasks and session");
  expect(JSON.parse(readFileSync(join(f.cwd, "context-checkpoint-claude.json"), "utf8")).summary).toBe(marker); expect(statSync(join(f.cwd, "context-checkpoint-claude.json")).mode & 0o777).toBe(0o600);
  expect(f.daemon.bus.stateOf("claude")).not.toBe("paused");
  const task = await f.console_.request({ t: "task", op: "task_show", args: { id: 1 } }); expect(JSON.parse(task.text).owner).toBe("claude");
  expect(JSON.stringify(f.otherPushes)).not.toContain(marker); expect(readFileSync(join(f.cwd, "hub.log"), "utf8")).not.toContain(marker); expect(readFileSync(join(f.cwd, "events.jsonl"), "utf8")).not.toContain(marker);
  expect(f.mem.calls.some(c => c.path === "/api/memory/save" && JSON.stringify(c.body).includes(marker))).toBe(true);
  f.reading(95); await Bun.sleep(1100); expect(pressure(f.cwd)).toHaveLength(1);
  const shown = await f.console_.request({ t: "status" }); expect(shown.status.peers.claude.context.used).toBe(0.95);
  expect((await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "replay", request_id: id } })).ok).toBe(false);
}, 20_000);

test("context request rejects a replaced session and private text before local persistence or cloud memory", async () => {
  const f = await fixture(); f.reading(); await until(() => !!request(f.pushes));
  const id = /request_id: "([^"]+)"/.exec(request(f.pushes).body)![1];
  f.session("native-replaced");
  const stale = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "old session", request_id: id } }); expect(stale.ok).toBe(false); expect(existsSync(join(f.cwd, "context-checkpoint-claude.json"))).toBe(false);
  f.session(); f.reading(10); await Bun.sleep(1100); f.reading(90); await until(() => pressure(f.cwd).length === 2);
  const requests = f.pushes.filter(p => p.t === "event" && p.e?.env?.body?.startsWith("Checkpoint request: your native context"));
  const nextId = /request_id: "([^"]+)"/.exec(requests.at(-1).e.env.body)![1];
  const denied = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "PRIVATE-MARKER", request_id: nextId } }); expect(denied.ok).toBe(false);
  expect(existsSync(join(f.cwd, "context-checkpoint-claude.json"))).toBe(false); expect(f.mem.calls.some(c => c.path === "/api/memory/save" && JSON.stringify(c.body).includes("PRIVATE-MARKER"))).toBe(false);
}, 20_000);

test("identity-mismatched and stale native files stay unknown; default threshold reports only", async () => {
  const f = await fixture(0); f.reading(90, { instanceId: "previous-daemon" }); await Bun.sleep(1100);
  expect((await f.console_.request({ t: "status" })).status.peers.claude.context).toBeUndefined();
  f.reading(90, { launchId: "other-launch" }); await Bun.sleep(1100); expect(pressure(f.cwd)).toHaveLength(0);
  f.reading(90, { at: Date.now() - 70_000 }); await Bun.sleep(1100);
  const stale = (await f.console_.request({ t: "status" })).status.peers.claude.context;
  expect(stale.freshness).toBe("stale"); expect(stale.used).toBeNull(); expect(stale.source).toBe("claude_statusline"); expect(stale.measuredAt).toBeGreaterThan(0);
  f.reading(); await until(() => f.pushes.some(p => p.t === "context" && p.peer === "claude" && p.reading.used === 0.9));
  expect(pressure(f.cwd)).toHaveLength(0); expect(request(f.pushes)).toBeUndefined();
}, 20_000);

test("connection replacement invalidates a context waiter even when native session id is unchanged", async () => {
  const f = await fixture(); f.reading(); await until(() => !!request(f.pushes));
  const id = /request_id: "([^"]+)"/.exec(request(f.pushes).body)![1];
  const replacement = await ControlClient.connect(f.cwd, { role: "peer", peer: "claude" }); cleanup.push(() => replacement.close());
  await until(() => f.daemon.bus.stateOf("claude") === "idle");
  const rejected = await replacement.request({ t: "task", op: "hub_checkpoint", args: { summary: "old transport checkpoint", request_id: id } });
  expect(rejected.ok).toBe(false); expect(existsSync(join(f.cwd, "context-checkpoint-claude.json"))).toBe(false);
  expect(f.mem.calls.some(c => c.path === "/api/memory/save" && JSON.stringify(c.body).includes("old transport checkpoint"))).toBe(false);
}, 20_000);

test("expired context requests cannot persist a late checkpoint", async () => {
  const f = await fixture(); f.reading(); await until(() => !!request(f.pushes));
  const id = /request_id: "([^"]+)"/.exec(request(f.pushes).body)![1];
  await Bun.sleep(5100);
  const late = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "too late", request_id: id } });
  expect(late.ok).toBe(false); expect(existsSync(join(f.cwd, "context-checkpoint-claude.json"))).toBe(false);
  expect(f.daemon.bus.stateOf("claude")).not.toBe("paused");
  const budget = await f.console_.request({ t: "budget" }); expect(budget.budget.claude?.paused).toBeUndefined();
}, 20_000);


test("dashboard retains a persisted quota pause after restart before its peer attaches, with no journal queue", async () => {
  const f = await fixture(0);
  const paused = await f.console_.request({ t: "budget", set: { peer: "other", used: 0.95, resetsInMs: 3_600_000 } });
  expect(paused.ok).toBe(true);
  await until(() => f.daemon.bus.stateOf("other") === "paused");
  expect(f.daemon.bus.queueList("other")).toHaveLength(0);
  await f.daemon.stop();
  const restarted = await startDaemon({ cwd: f.cwd, stateDir: f.cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, context: { gate: 0, stale_min: 1 }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false } } });
  cleanup.push(() => restarted.stop());
  const console_ = await ControlClient.connect(f.cwd, { role: "console" }); cleanup.push(() => console_.close());
  expect(restarted.bus.peers.has("other")).toBe(false);
  expect(restarted.bus.knownPeers()).not.toContain("other");
  expect(restarted.bus.queueList("other")).toHaveLength(0);
  const quota = await console_.request({ t: "budget" }); expect(quota.budget.other.paused).toBeDefined();
  const opened = await console_.request({ t: "ui" }), url = new URL(opened.url);
  const headers: Record<string, string> = { origin: url.origin, "content-type": "application/json" };
  const session = await fetch(`${url.origin}/session`, { method: "POST", headers, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  expect(session.status).toBe(200); headers.cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(`${url.origin}/snapshot`, { method: "POST", headers, body: JSON.stringify({ after: 0 }) });
  expect(response.status).toBe(200);
  const snapshot = await response.json() as { budget: Record<string, { paused?: unknown; windows: unknown[]; context: { used: number | null; freshness: string } }> };
  expect(snapshot.budget.other!.paused).toEqual(quota.budget.other.paused);
  expect(snapshot.budget.other!.context.used).toBeNull(); expect(snapshot.budget.other!.context.freshness).toBe("unknown");
}, 20_000);


test("paused context pressure is delivered once on release without another native reading", async () => {
  const f = await fixture();
  expect((await f.console_.request({ t: "pause", peer: "claude" })).ok).toBe(true);
  f.reading(); await Bun.sleep(1200);
  expect(pressure(f.cwd)).toHaveLength(0); expect(request(f.pushes)).toBeUndefined();
  const file = readFileSync(join(f.cwd, "claude-context.json"), "utf8");
  expect((await f.console_.request({ t: "resume", peer: "claude" })).ok).toBe(true);
  await until(() => pressure(f.cwd).length === 1 && !!request(f.pushes));
  expect(readFileSync(join(f.cwd, "claude-context.json"), "utf8")).toBe(file);
  await Bun.sleep(1100); expect(pressure(f.cwd)).toHaveLength(1);
  expect(f.pushes.filter(p => p.t === "notice" && p.line.startsWith("context: claude crossed"))).toHaveLength(1);
}, 20_000);

test.each(["owner", "reviewer"] as const)("context request and clean completion refuse a PII task in review associated as %s after a routing-policy change", async role => {
  const f = await fixture(0.8, true);
  f.reading(); await until(() => !!request(f.pushes));
  const firstId = /request_id: "([^"]+)"/.exec(request(f.pushes).body)![1];
  const routePath = join(f.cwd, ".agenthub", "routing.toml");
  const setPolicy = (policy: string, tick: number) => {
    writeFileSync(routePath, readFileSync(routePath, "utf8").replace(/^pii = .*$/m, `pii = "${policy}"`));
    utimesSync(routePath, new Date(tick), new Date(tick));
  };
  const tick = Date.now(); setPolicy("off", tick + 1);
  const owner = role === "owner" ? "claude" : "other";
  const tools = await ControlClient.connect(f.cwd, { role: "tools", peer: owner }); cleanup.push(() => tools.close());
  const proposed = await tools.request({ t: "task", op: "hub_task_propose", args: { title: "PRIVATE-MARKER historical task", owner, class: "implement", plan: { paths: ["src/private.ts"] } } });
  expect(proposed.ok).toBe(true);
  const done = await tools.request({ t: "task", op: "hub_task_done", args: { id: 2, summary: "work complete" } }); expect(done.ok).toBe(true); expect(done.text).toContain("in_review");
  const task = JSON.parse((await f.console_.request({ t: "task", op: "task_show", args: { id: 2 } })).text);
  expect(task.owner).toBe(owner); expect(task.reviewer).toBe(role === "reviewer" ? "claude" : "other"); expect(task.signals).toContain("pii");
  // Settle the explicitly allowed off-policy note before measuring whether the context response leaks another note.
  await until(() => f.mem.calls.some(c => c.path === "/api/memory/save" && JSON.stringify(c.body).includes("PRIVATE-MARKER") && JSON.stringify(c.body).includes("work complete")));
  setPolicy("local_only", tick + 2);
  const savesBefore = f.mem.calls.filter(c => c.path === "/api/memory/save").length;
  const rejected = await f.claude.request({ t: "task", op: "hub_checkpoint", args: { summary: "clean checkpoint with no PII pattern", request_id: firstId } });
  expect(rejected.ok).toBe(false); expect(existsSync(join(f.cwd, "context-checkpoint-claude.json"))).toBe(false);
  expect(f.mem.calls.filter(c => c.path === "/api/memory/save")).toHaveLength(savesBefore);
  const requestsBefore = f.pushes.filter(p => p.t === "event" && p.e?.env?.body?.startsWith("Checkpoint request: your native context")).length;
  f.reading(10); await Bun.sleep(1100); f.reading(90); await until(() => pressure(f.cwd).length === 2);
  expect(f.pushes.filter(p => p.t === "event" && p.e?.env?.body?.startsWith("Checkpoint request: your native context"))).toHaveLength(requestsBefore);
  expect(f.mem.calls.filter(c => c.path === "/api/memory/save")).toHaveLength(savesBefore);
}, 20_000);

/** A daemon with the fake Kimi ACP agent: the occupancy legs of #285 phase 1. */
async function kimiFixture(gate = 0) {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-acp-context-")); cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const daemon = await startDaemon({
    cwd: stateDir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, instanceId: "acp-context",
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")], context: { gate, stale_min: 30 }, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: 800_000 } },
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const pushes: any[] = []; console_.onPush = (m) => pushes.push(m); console_.send({ t: "tail" });
  return { stateDir, daemon, console_, pushes };
}
const kimiContext = (pushes: any[], used: number | null) => pushes.some((p) => p.t === "context" && p.peer === "kimi" && p.reading?.used === used && p.reading?.source === "acp_usage_update");

test("Kimi's ACP usage_update occupancy becomes its context reading in status, the console tail and the UI snapshot, with no tokens event (#285)", async () => {
  const { stateDir, daemon, console_, pushes } = await kimiFixture();
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle");
  // The fake sends the flat {used, size} update 75 ms after the prompt result (2.1.1's source text emits it after
  // the prompt resolves; read from the source, not observed live): the peer is idle by then, deterministically.
  daemon.bus.publish(newEnvelope(USER, "OCCUPANCY: report your context", { to: ["kimi"] }));
  await until(() => kimiContext(pushes, 0.45));
  const shown = await console_.request({ t: "status" });
  expect(shown.status.peers.kimi.context).toMatchObject({ used: 0.45, tokens: 90_000, window: 200_000, source: "acp_usage_update", freshness: "fresh" });
  const ui = await console_.request({ t: "ui_snapshot", after: 0 });
  expect(ui.budget.kimi.context).toMatchObject({ used: 0.45, source: "acp_usage_update", freshness: "fresh" });
  // Occupancy is not consumption (#167): the turn wrote no tokens event and no budget window, ceiling configured or not.
  await until(() => readEvents(join(stateDir, "events.jsonl")).some((e) => e.type === "turn_end" && e.peer === "kimi"));
  expect(readEvents(join(stateDir, "events.jsonl")).some((e) => e.type === "tokens" && e.peer === "kimi")).toBe(false);
  expect(ui.budget.kimi.windows ?? []).toEqual([]);
}, 20_000);

test("an invalid Kimi occupancy update reports unknown instead of keeping the previous reading (#285)", async () => {
  const { daemon, console_, pushes } = await kimiFixture();
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle");
  daemon.bus.publish(newEnvelope(USER, "OCCUPANCY: first", { to: ["kimi"] }));
  await until(() => kimiContext(pushes, 0.45));
  daemon.bus.publish(newEnvelope(USER, "OCCUPANCY_INVALID: then garbage", { to: ["kimi"] }));
  await until(() => pushes.some((p) => p.t === "context" && p.peer === "kimi" && p.reading?.freshness === "unknown" && p.reading?.source === "acp_usage_update"));
  const shown = await console_.request({ t: "status" });
  expect(shown.status.peers.kimi.context).toMatchObject({ used: null, tokens: null, source: "acp_usage_update", freshness: "unknown" });
}, 20_000);

test("a Kimi occupancy reading over context.gate records the crossing and the notice but sends no checkpoint request (#285)", async () => {
  const { stateDir, daemon, console_, pushes } = await kimiFixture(0.8);
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle");
  daemon.bus.publish(newEnvelope(USER, "OCCUPANCY_HIGH: nearly full", { to: ["kimi"] }));
  await until(() => kimiContext(pushes, 0.9));
  await until(() => readEvents(join(stateDir, "events.jsonl")).some((e) => e.type === "context_pressure" && e.peer === "kimi" && e.source === "acp_usage_update"));
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("context: kimi crossed 80%");
  // The checkpoint request stays Claude/Codex-only in this phase: no budget envelope reaches Kimi.
  expect(pushes.some((p) => p.t === "event" && p.e?.env?.to?.includes("kimi") && p.e?.env?.body?.startsWith("Checkpoint request:"))).toBe(false);
  expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).not.toContain("Checkpoint request");
}, 20_000);

test("a usage_update naming a session the adapter did not load is dropped before any reading (#285)", async () => {
  const { stateDir, daemon, console_ } = await kimiFixture();
  // The fake answers session/load but keeps sending updates for "s1": a resumed session "old" never matches.
  expect((await console_.request({ t: "start", peer: "kimi", args: { sessionId: "old" } })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("kimi") === "idle");
  daemon.bus.publish(newEnvelope(USER, "OCCUPANCY: stale session", { to: ["kimi"] }));
  await until(() => readEvents(join(stateDir, "events.jsonl")).some((e) => e.type === "turn_end" && e.peer === "kimi"));
  await Bun.sleep(1200); // past the 1 s context tail: a dropped update shows nothing
  const shown = await console_.request({ t: "status" });
  expect(shown.status.peers.kimi.context?.freshness ?? "unknown").toBe("unknown");
  expect(shown.status.peers.kimi.context?.used ?? null).toBeNull();
}, 20_000);
