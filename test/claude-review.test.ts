import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { definitionOf } from "../src/adapters/registry.ts";
import { ClaudePrintPeer, claudePrintArgs, readDenyRules, reviewDiff } from "../src/adapters/claude-print.ts";
import { spawnSync } from "node:child_process";
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
  await until(() => daemon.bus.stateOf("claude-review") === "idle"); // the child has exited and written its log
  // R2 on the read tool too: the reviewer's own hub_task_show carries no builder narrative.
  const shown = lines(log).find(line => line.show)!.show;
  expect(shown).toMatchObject({ ok: true });
  expect(JSON.stringify(shown)).not.toContain("BUILDER NARRATIVE");
  // Its verdict authority ends with its child: a later hub_review from its identity is refused.
  const late = await connect({ role: "tools", peer: "claude-review" });
  expect(await late.request({ t: "task", op: "hub_review", args: { id, verdict: "changes_requested", note: "late" } })).toMatchObject({ ok: false, error: expect.stringContaining(`no review of task #${id} is running`) });
  expect(calls[0].prompt).toContain(`Review task #${id}`);
  expect(calls[0].prompt).not.toContain("BUILDER NARRATIVE");
  expect(calls[0].prompt).not.toContain("half done");
  expect(calls[0].prompt).not.toContain("my reasoning");
});

test("the review diff leaves out private files, both sides of a rename, and a diff matching a private-data pattern", () => {
  const dir = scratch("ahub-review-diff-");
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); expect(r.status).toBe(0); return r.stdout.trim(); };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "public.ts"), "export const a = 1;\n"); writeFileSync(join(dir, "old-secret.txt"), "OLD_PRIVATE_SENTINEL\n");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "work");
  writeFileSync(join(dir, "public.ts"), "export const a = 2;\n"); writeFileSync(join(dir, "private.txt"), "PRIVATE_PATH_SENTINEL\n");
  git("mv", "old-secret.txt", "renamed.txt");
  git("add", "."); git("commit", "-qm", "work");
  const head = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
  const privatePath = (path: string) => path === "private.txt" || path === "old-secret.txt";
  const diff = reviewDiff(dir, head, { privatePath, nameable: () => true })!;
  expect(diff).toContain("export const a = 2");
  expect(diff).not.toContain("PRIVATE_PATH_SENTINEL");
  expect(diff).not.toContain("old-secret.txt");
  expect(diff).toContain("[2 changed file(s) withheld by the project's privacy policy]");
  expect(reviewDiff(dir, head, { privatePath, nameable: () => false })).toContain("withheld: it matches a private-data pattern");
  expect(reviewDiff(dir, head, { privatePath: () => true, nameable: () => true })).toContain("no changed file can be shown");
  expect(reviewDiff(dir, "not-a-commit", { privatePath, nameable: () => true })).toBeUndefined();
  expect(readDenyRules(["secrets", "/abs/x", "**/*.pem"])).toEqual(["Read(./secrets)", "Read(./secrets/**)", "Read(//abs/x)", "Read(//abs/x/**)", "Read(./**/*.pem)"]);
  expect(claudePrintArgs("s", "{}", "r", ["secrets"])).toContain("--disallowedTools");
});

test("a stop before the child starts sends no prompt, and a failed stop keeps the child's handle", async () => {
  const dir = scratch("ahub-claude-print-race-"), log = join(dir, "calls.jsonl");
  setEnv({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "none" });
  const peer = new ClaudePrintPeer("claude-review", { cwd: dir, command: [process.execPath, FAKE], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000, verdictSince: () => true });
  const receipts: DeliveryReceipt[] = []; peer.onDelivery = r => receipts.push(r);
  await peer.start();
  await peer.deliver([review(5)], "d1");
  await peer.stop("stopped at once");
  expect(peer.state).toBe("offline");
  await Bun.sleep(400);
  expect(lines(log).filter(line => line.prompt)).toEqual([]);
  expect(receipts.map(r => r.state)).toEqual(["accepted", "needs_review"]);
});

test("a later start failure after a review ran holds the batch, and throwing callbacks settle once", async () => {
  const dir = scratch("ahub-claude-print-batch-"), log = join(dir, "calls.jsonl"), stand = join(dir, "stand-in");
  writeFileSync(stand, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(stand, 0o755);
  setEnv({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "none" });
  const peer = new ClaudePrintPeer("claude-review", { cwd: dir, command: [stand], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    verdictSince: () => { rmSync(stand); return true; } });
  const receipts: DeliveryReceipt[] = []; peer.onDelivery = r => receipts.push(r);
  await peer.start();
  await peer.deliver([review(6), review(7)], "d1");
  await until(() => peer.state === "idle");
  expect(receipts.map(r => r.state)).toEqual(["accepted", "needs_review"]);
  expect(receipts[1]!.reason).toContain("could not start");

  const thrower = new ClaudePrintPeer("claude-review", { cwd: dir, command: [process.execPath, FAKE], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000,
    facts: () => { throw new Error("git broke"); }, verdictSince: () => { throw new Error("db broke"); } });
  const got: DeliveryReceipt[] = []; thrower.onDelivery = r => got.push(r);
  await thrower.start();
  await thrower.deliver([review(8)], "d2");
  await until(() => thrower.state === "idle");
  expect(got.map(r => r.state)).toEqual(["accepted", "needs_review"]);
  expect(lines(log).some(line => line.prompt?.includes("Review task #8"))).toBe(true);
});

test("a review-only instance is never a task owner, for any class or by nomination", () => {
  const routing = parseRouting(`[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["claude"]\n[classes.review]\npeers=["claude"]\n`);
  const roles = { claude: ["planner", "reviewer"], "claude-review": ["reviewer"] };
  for (const cls of ["summarize", "triage", "implement"] as const) {
    const a = assign({ class: cls, signals: [] }, { claude: "busy", "claude-review": "idle" }, routing, { roles, instances: reviewer, candidates: ["claude", "claude-review"] });
    expect(a.owner).not.toBe("claude-review");
  }
  expect(assign({ class: "summarize", signals: [] }, { claude: "busy", "claude-review": "idle" }, routing, { roles, instances: reviewer, namedOwner: "claude-review" }).owner).not.toBe("claude-review");
});
