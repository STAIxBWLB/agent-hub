import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { CompletionStore } from "../src/hub/completions-store.ts";
import { realPath } from "../src/hub/project.ts";
import { readEvents } from "../src/hub/events.ts";
import { readFileSync } from "node:fs";

const session = "session_12345678-1234-1234-1234-123456789abc";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (condition: () => boolean, label: string) => {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) await Bun.sleep(10);
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
};

async function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-completion-"))), stateDir = join(cwd, "state"), home = join(cwd, "kimi-home");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd }); cleanup.push(() => person.close());
  const status = (await person.request({ t: "status" })).status as { instanceId: string };
  const admitted = await person.request({ t: "native_hook_launch", op: "begin", peer: "kimi", nativeHome: home });
  expect(admitted).toMatchObject({ ok: true, instanceId: status.instanceId });
  const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "kimi", channel: false, projectRoot: cwd }); cleanup.push(() => peer.close());
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi", projectRoot: cwd }); cleanup.push(() => tools.close());
  const directory = join(home, "sessions", "wd_fixture", session), main = join(directory, "agents", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: session, sessionDir: directory })}\n`);
  writeFileSync(join(main, "wire.jsonl"), "");
  const old = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = home;
  cleanup.push(() => { if (old === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = old; });
  const payload = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, session_id: session, client_type: "kimi_code_cli", cwd, ...extra });
  const observe = (event: string, extra: Record<string, unknown> = {}, launchId = admitted.launchId) => tools.request({ t: "native_facts", event, payload: payload(event, extra), nativeInstanceId: status.instanceId, nativeLaunchId: launchId });
  const append = (rows: unknown[]) => appendFileSync(join(main, "wire.jsonl"), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  const start = (turnId = 1, origin = "user", withPromptId = true) => { append([{ type: "turn.prompt", agentId: "main", turnId, ...(withPromptId ? { promptId: `msg-${turnId}` } : {}), origin: { kind: origin }, input: [{ type: "text", text: "TOPSECRET-NATIVE-PROMPT" }] }]); return observe("TurnStarted", { turn_id: turnId, origin_kind: origin, prompt: "TOPSECRET-NATIVE-PROMPT" }); };
  const finish = (turnId: number, reason: "completed" | "failed" | "cancelled") => append([
    { type: "turn.ended", agentId: "main", turnId, reason, error: { message: "TOPSECRET-NATIVE-ERROR" } },
    ...(reason === "cancelled" ? [{ type: "prompt.aborted", agentId: "main", promptId: `msg-${turnId}` }] : [{ type: "prompt.completed", agentId: "main", promptId: `msg-${turnId}`, reason }]),
  ]);
  const task = (status: string, endedAt: number | null) => {
    mkdirSync(join(main, "tasks"), { recursive: true });
    writeFileSync(join(main, "tasks", "bash-1.json"), JSON.stringify({ taskId: "bash-1", status, endedAt, command: "TOPSECRET-TASK-COMMAND" }));
  };
  const rows = () => { const store = new CompletionStore(join(stateDir, "hub.db")); try { return store.list(); } finally { store.close(); } };
  const open = () => { const store = new CompletionStore(join(stateDir, "hub.db")); try { return store.openRuns(); } finally { store.close(); } };
  return { cwd, stateDir, home, main, person, admitted, observe, append, start, finish, task, rows, open };
}

test("a native person run settles only after final-turn readback and native-background quiescence, with no text in its sinks", async () => {
  const f = await rig();
  expect(await f.start()).toMatchObject({ ok: true });
  expect(f.open()).toHaveLength(1);
  f.task("running", null);
  f.finish(1, "completed");
  expect(await f.observe("TaskStarted", { task_id: "bash-1" })).toMatchObject({ ok: true });
  await Bun.sleep(100);
  expect(f.rows()).toEqual([]);
  f.task("completed", 20);
  expect(await f.start(2, "task", false)).toMatchObject({ ok: true });
  f.append([{ type: "turn.ended", agentId: "main", turnId: 2, reason: "completed" }]);
  await until(() => f.rows().length === 1, "native completion without Stop or notification hooks");
  expect(f.rows()[0]).toMatchObject({ peer: "kimi", outcome: "done", private: true });
  const events = readEvents(join(f.stateDir, "events.jsonl"));
  expect(events.filter(row => row.type === "completion")).toHaveLength(1);
  for (const sink of [JSON.stringify(events), JSON.stringify(f.rows()), readFileSync(join(f.stateDir, "hub.log"), "utf8")]) {
    expect(sink).not.toContain("TOPSECRET-NATIVE-PROMPT");
    expect(sink).not.toContain("TOPSECRET-NATIVE-ERROR");
    expect(sink).not.toContain("TOPSECRET-TASK-COMMAND");
  }
});

test("StopFailure becomes failed only from the correlated final rows", async () => {
  const f = await rig();
  await f.start();
  expect(await f.observe("StopFailure", { error_type: "internal", error_message: "TOPSECRET-NATIVE-ERROR" })).toMatchObject({ ok: true, pending: true });
  await Bun.sleep(100);
  expect(f.rows()).toEqual([]);
  f.finish(1, "failed");
  await until(() => f.rows().length === 1, "failed completion");
  expect(f.rows()[0]).toMatchObject({ outcome: "failed", private: true });
});

test("Interrupt produces no unread completion and launcher loss produces one interrupted result", async () => {
  const f = await rig();
  await f.start();
  f.finish(1, "cancelled");
  expect(await f.observe("Interrupt", { turn_id: 1, reason: "user_cancelled" })).toMatchObject({ ok: true, pending: true });
  await until(() => f.open().length === 0, "quiet interrupted run");
  expect(f.rows()).toEqual([]);
  expect(await f.start(2)).toMatchObject({ ok: true });
  expect(await f.observe("SessionEnd", { reason: "exit" })).toMatchObject({ ok: true });
  expect(f.rows()).toEqual([]);
  expect(await f.person.request({ t: "native_hook_launch", op: "end", peer: "kimi", launchId: f.admitted.launchId })).toMatchObject({ ok: true });
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ outcome: "interrupted", private: true });
  expect(await f.person.request({ t: "native_hook_launch", op: "end", peer: "kimi", launchId: f.admitted.launchId })).toMatchObject({ ok: false });
  expect(f.rows()).toHaveLength(1);
});

test("task origins, stale turns and wrong-launch, wrong-session or forged observations create no completion", async () => {
  const f = await rig();
  expect(await f.start(1, "task")).toMatchObject({ ok: true });
  expect(f.open()).toEqual([]);
  f.finish(1, "completed");
  expect(await f.observe("Stop")).toMatchObject({ ok: true, pending: true });
  await Bun.sleep(100);
  expect(f.rows()).toEqual([]);
  expect(await f.observe("TurnStarted", { turn_id: 1, origin_kind: "user" }, "wrong-launch")).toMatchObject({ ok: false });
  expect(await f.observe("TurnStarted", { turn_id: 2, origin_kind: "user", session_id: "session_other" })).toMatchObject({ ok: false });
  expect(await f.observe("TurnStarted", { turn_id: 2, origin_kind: "user", cwd: tmpdir() })).toMatchObject({ ok: false });
  expect(await f.start(1)).toMatchObject({ ok: true });
  expect(f.open()).toEqual([]);
  expect(f.rows()).toEqual([]);
});

test("losing the launcher socket settles one interrupted completion without its end call", async () => {
  const f = await rig();
  await f.start();
  f.person.close();
  await until(() => f.rows().length === 1, "interrupted completion after launcher loss");
  expect(f.rows()[0]).toMatchObject({ outcome: "interrupted", private: true });
  expect(f.rows()).toHaveLength(1);
});

test("an unknown background inventory never settles until a later read proves quiescence", async () => {
  const f = await rig();
  await f.start();
  f.task("mystery", null);
  f.finish(1, "completed");
  expect(await f.observe("Stop")).toMatchObject({ ok: true, pending: true });
  await Bun.sleep(350);
  expect(f.rows()).toEqual([]);
  f.task("completed", 20);
  await until(() => f.rows().length === 1, "completion after the inventory becomes readable");
});
