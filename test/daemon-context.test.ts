import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (f: () => boolean) => { for (let n = 0; n < 350 && !f(); n++) await Bun.sleep(10); expect(f()).toBe(true); };
async function fixture(gate = 0.8) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-context-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const mem = startFakeMemWorker(); cleanup.push(mem.stop);
  mkdirSync(join(cwd, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]');
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), routing);
  const daemon = await startDaemon({ cwd, stateDir: cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, instanceId: "context-instance", config: { ...DEFAULT_CONFIG, batch_ms: 0, context: { gate, stale_min: 1 }, memory: { ...DEFAULT_CONFIG.memory, enabled: true, worker_url: mem.url }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, budget: { ...DEFAULT_CONFIG.budget, checkpoint_timeout_s: 5 } } });
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
  expect((await f.console_.request({ t: "status" })).status.peers.claude.context.used).toBeNull();
  f.reading(90, { launchId: "other-launch" }); await Bun.sleep(1100); expect(pressure(f.cwd)).toHaveLength(0);
  f.reading(90, { at: Date.now() - 70_000 }); await Bun.sleep(1100);
  expect((await f.console_.request({ t: "status" })).status.peers.claude.context.freshness).toBe("stale");
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
