import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { definitionOf } from "../src/adapters/registry.ts";
import { ClaudePrintPeer, claudePrintArgs } from "../src/adapters/claude-print.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { instanceLaunchArguments } from "../src/cli/launch.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

// #223: a headless Claude reviewer instance runs one fresh `claude -p` session per review request.
const FAKE = resolve(import.meta.dir, "fakes/fake-claude-print.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const reviewer = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } } as const;
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const setEnv = (values: Record<string, string>) => {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  cleanup.push(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
};
const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const until = async (ok: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await Bun.sleep(10); expect(ok()).toBe(true); };
const review = (task: number, body = `Review task #${task} fixture`): Envelope => newEnvelope(HUB, body, { to: ["claude-review"], kind: "review", refs: { task: String(task) } });

test("a headless Claude instance is the reviewer variant only with roles exactly [reviewer]", () => {
  expect(validateInstances(reviewer)["claude-review"]).toEqual({ kind: "claude", roles: ["reviewer"], start_mode: "headless" });
  const variant = definitionOf("claude-review", reviewer)!;
  expect([variant.transport, variant.start.daemonPort, variant.identity.mcp]).toEqual(["hub-native", "claude-print", "env"]);
  expect(definitionOf("claude")!.start.forms).toEqual(["tui"]);
  expect(definitionOf("claude")!.start.create).toBeUndefined();
  expect(definitionOf("claude-review", { "claude-review": { kind: "claude" } })!.transport).toBe("claude-channel");
  for (const roles of [["planner"], ["reviewer", "planner"], []]) expect(() => validateInstances({ "claude-x": { kind: "claude", roles, start_mode: "headless" } })).toThrow('exactly ["reviewer"]');
  expect(() => validateInstances({ "claude-x": { kind: "claude", roles: ["reviewer"], start_mode: "headless", worktree: "../wt" } })).toThrow("worktree is not supported");
  expect(() => instanceLaunchArguments("claude", ["--as", "claude-review"], validateInstances(reviewer))).toThrow("ahub start claude-review");
});

test("each review runs a new unpersisted session with read-only tools, and settles by the verdict", async () => {
  const dir = scratch("ahub-claude-print-"), log = join(dir, "calls.jsonl");
  setEnv({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "none" });
  const verdicts = new Set<number>([1]);
  const peer = new ClaudePrintPeer("claude-review", { cwd: dir, command: [process.execPath, FAKE], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    facts: env => `facts for ${env.refs?.task}`, verdictSince: task => verdicts.has(task) });
  const receipts: DeliveryReceipt[] = []; peer.onDelivery = r => receipts.push(r);
  await peer.start();
  await peer.deliver([review(1), review(2), newEnvelope(HUB, "task note", { to: ["claude-review"], kind: "task" })], "d1");
  expect(peer.state).toBe("busy");
  await until(() => peer.state === "idle");
  const calls = lines(log);
  expect(calls).toHaveLength(2); // the task notice starts no session
  const sessions = calls.map(call => call.argv[call.argv.indexOf("--session-id") + 1]);
  expect(new Set(sessions).size).toBe(2);
  for (const call of calls) {
    expect(call.argv).not.toContain("--resume");
    expect(call.argv).not.toContain("--continue");
    expect(call.argv).toEqual(claudePrintArgs(call.argv[call.argv.indexOf("--session-id") + 1], "{}", "role"));
    expect(call.peer).toBe("claude-review");
  }
  expect(calls[0].prompt).toContain("Review task #1 fixture");
  expect(calls[0].prompt).toContain("facts for 1");
  expect(calls[1].prompt).not.toContain("#1 fixture"); // one review per session
  expect(receipts.map(r => r.state)).toEqual(["accepted", "needs_review"]);
  expect(receipts[1]!.reason).toContain("no verdict recorded for task #2");
});

test("the watchdog and a requested stop kill the review and hold it for a person", async () => {
  const dir = scratch("ahub-claude-print-hang-");
  setEnv({ FAKE_CLAUDE_LOG: join(dir, "calls.jsonl"), FAKE_CLAUDE_ACTION: "hang" });
  const peer = new ClaudePrintPeer("claude-review", { cwd: dir, command: [process.execPath, FAKE], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 300, verdictSince: () => false });
  const receipts: DeliveryReceipt[] = []; peer.onDelivery = r => receipts.push(r);
  await peer.start();
  await peer.deliver([review(3)], "d1");
  await until(() => receipts.some(r => r.state === "needs_review"));
  expect(receipts.at(-1)!.reason).toBe("review watchdog timeout");
  await until(() => peer.state === "idle");
  await peer.deliver([review(4)], "d2");
  await until(() => peer.reviewing === 4);
  await peer.stop("person stopped it");
  expect(receipts.at(-1)).toEqual({ id: "d2", state: "needs_review", reason: "person stopped it" });
  expect(peer.state).toBe("offline");
});

test("routing prefers a declared reviewer-only instance, busy or not, and marks a planner fallback", () => {
  const routing = parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n`);
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], "claude-review": ["reviewer"] };
  const work = { class: "implement" as const, signals: [] };
  const busy = assign(work, { codex: "idle", claude: "idle", "claude-review": "busy" }, routing, { roles, instances: reviewer });
  expect(busy.reviewer).toBe("claude-review");
  expect(busy.plannerFallback).toBeUndefined();
  const away = assign(work, { codex: "idle", claude: "idle" }, routing, { roles, instances: reviewer });
  expect(away.reviewer).toBe("claude");
  expect(away.plannerFallback).toBe(true);
  expect(away.trace.join("\n")).toContain("planner fallback");
  const none = assign(work, { codex: "idle", claude: "idle" }, routing, { roles: { claude: roles.claude, codex: roles.codex } });
  expect(none.reviewer).toBe("claude");
  expect(none.plannerFallback).toBeUndefined();
  expect(assign({ ...work, title: "x" }, { codex: "idle", claude: "idle", "claude-review": "idle" }, routing, { roles, instances: reviewer, namedReviewer: "claude" }).reviewer).toBe("claude");
});

test("the daemon runs the headless reviewer: review-only delivery, a fresh verdict recorded by the hub", async () => {
  const root = scratch("ahub-claude-review-"), stateDir = join(root, "state"), bin = join(root, "bin"), log = join(root, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(join(bin, "claude"), 0o755);
  setEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "approve" });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, instances: validateInstances(reviewer), roles: { ...DEFAULT_CONFIG.roles, builder: ["implementer"] }, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const c = await ControlClient.connect(stateDir, { ...hello, projectRoot: root }); cleanup.push(() => c.close()); return c; };
  const console_ = await connect({ role: "console" });
  expect(await console_.request({ t: "start", peer: "claude-review" })).toMatchObject({ ok: true });
  expect(daemon.bus.stateOf("claude-review")).toBe("idle");
  expect((await connect({ role: "peer", peer: "claude-review", channel: true }).catch((e: Error) => e)) instanceof Error).toBe(true);
  const builder = await connect({ role: "peer", peer: "builder", channel: true });
  await until(() => daemon.bus.stateOf("builder") === "idle");
  const task = async (op: string, args: Record<string, unknown>) => { const res = await builder.request({ t: "task", op, args }); expect(res).toMatchObject({ ok: true }); return String(res.text); };
  // Agent chat to the reviewer is refused with a reason; a broadcast is dropped for it.
  expect(await builder.request({ t: "send", to: ["claude-review"], body: "here is my reasoning" })).toMatchObject({ ok: false, error: expect.stringContaining("review-only instance") });
  await builder.request({ t: "send", body: "progress: half done" });
  const proposed = await task("hub_task_propose", { title: "fixture change", class: "implement", owner: "builder" });
  expect(proposed).toContain("reviewer claude-review");
  const id = Number(/#(\d+)/.exec(proposed)![1]);
  await task("hub_task_accept", { id });
  await task("hub_task_done", { id, summary: "BUILDER NARRATIVE: trust me", refs: { branch: "x", commit: "abc1234" } });
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const row = () => db.query("SELECT state, reviewer, history FROM tasks WHERE id = ?").get(id) as { state: string; reviewer: string; history: string };
  await until(() => row().state === "approved", 10_000);
  expect(row().reviewer).toBe("claude-review");
  const verdict = JSON.parse(row().history).findLast((h: { event: string }) => h.event === "approved");
  expect(verdict).toMatchObject({ by: "claude-review", reviewContext: "fresh" });
  const calls = lines(log).filter(line => line.argv);
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain(`Review task #${id}`);
  expect(calls[0].prompt).not.toContain("BUILDER NARRATIVE");
  expect(calls[0].prompt).not.toContain("half done");
  expect(calls[0].prompt).not.toContain("my reasoning");
});
