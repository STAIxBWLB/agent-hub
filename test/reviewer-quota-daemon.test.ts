import { Database } from "bun:sqlite";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { reviewerAccountingIntegrity } from "../src/hub/review-budget.ts";
import { taskSweepConfig } from "../src/hub/task-sweep.ts";
import { parseRouting } from "../src/hub/routing.ts";
import type { Envelope } from "../src/hub/envelope.ts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Peer extends BasePeer {
  seen: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.seen.push(...envs); }
}
async function fixture(extra: Partial<TasksDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-quota-task-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const clock = { now: Date.now() }, reset = clock.now + 600_000;
  let readings: Record<string, { headroom: number; resetsAt?: number }> = { "claude-review": { headroom: 0.1, resetsAt: reset } };
  let paused: Record<string, { resetsAt?: number }> = {};
  const make = () => new Tasks({ cwd: root, board, bus, project: "fixture", now: () => clock.now,
    instances: () => ({ "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const } }),
    roles: { "claude-review": ["reviewer"] }, notify: () => {}, reviewOnly: () => true,
    review: { adaptive: false, min_reviews: 5, pool: ["claude"], gate: 0.8 }, quota: () => readings, reviewBudget: () => ({ paused }),
    sweep: taskSweepConfig({ review_min: 2 }), routing: () => parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n'), ...extra } satisfies TasksDeps);
  let tasks = make();
  const peers: Record<string, Peer> = {};
  for (const id of ["codex", "claude-review"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); peers[id] = peer; }
  board.onChange = task => tasks.reviewQuotaTaskChanged(task);
  const task = board.propose("user", { title: "quota fixture", class: "summarize" });
  board.update(task.id, "codex", "accepted", { owner: "codex", state: "in_progress", refs: { commit: "a".repeat(40) } });
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  return { board, bus, task, peers, clock, reset, get tasks() { return tasks; }, restart() { tasks.stopCiWatchers(); tasks = make(); tasks.refreshReviewerQuotaWaits(); }, readings(value: typeof readings) { readings = value; }, paused(value: typeof paused) { paused = value; } };
}
const drain = async () => { for (let i = 0; i < 8; i++) await Bun.sleep(1); };
test("known floor waits only to the first review_min deadline, restart and later reset cannot extend it", async () => {
  const f = await fixture(), done = await f.tasks.done("codex", f.task.id, "ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: null });
  const wait = done.history.at(-1)!.reviewerQuotaWait!; expect(wait.deadline).toBe(f.clock.now + 120_000);
  expect(done.history.at(-1)!.note).toContain("claude-review floor, reset");
  f.clock.now += 30_000; f.readings({ "claude-review": { headroom: 0.1, resetsAt: f.reset + 600_000 } });
  f.restart(); await drain(); expect(f.board.get(done.id)!.history.at(-1)!.reviewerQuotaWait?.deadline).toBe(wait.deadline);
  f.clock.now = wait.deadline; f.tasks.refreshReviewerQuotaWaits(); await drain();
  expect(f.board.get(done.id)).toMatchObject({ state: "in_review", reviewer: "user" });
});
test("attached-account fresh reading wakes wait; unknown or a manual blocker uses fallback", async () => {
  const f = await fixture(); await f.tasks.done("codex", f.task.id, "ready");
  f.readings({ "claude-review": { headroom: 0.5, resetsAt: f.reset } }); f.tasks.refreshReviewerQuotaWaits(); await drain();
  expect(f.board.get(f.task.id)?.reviewer).toBe("claude-review");
  const g = await fixture(); await g.tasks.done("codex", g.task.id, "ready");
  g.readings({}); g.tasks.refreshReviewerQuotaWaits(); await drain(); expect(g.board.get(g.task.id)?.reviewer).toBe("user");
});
test("changed head cancels an old wait and an unknown reset cannot create a new wait", async () => {
  const f = await fixture(); await f.tasks.done("codex", f.task.id, "ready");
  const saved = f.board.get(f.task.id)!;
  f.board.update(saved.id, "user", "fixture head changed", { refs: { commit: "b".repeat(40) } });
  f.clock.now += 300_000; f.tasks.refreshReviewerQuotaWaits(); await drain();
  expect(f.board.get(saved.id)!.history.at(-1)!.event).toBe("fixture head changed");
  const g = await fixture(); g.paused({ "claude-review": {} });
  expect((await g.tasks.done("codex", g.task.id, "ready")).reviewer).toBe("user");
});

test("a proven reset wakes recheck without ending the original cap while Budget still owns the grace pause", async () => {
  const f = await fixture();
  const reset = f.clock.now + 30_000;
  f.readings({ "claude-review": { headroom: 0.1, resetsAt: reset } }); f.paused({ "claude-review": { resetsAt: reset } });
  const done = await f.tasks.done("codex", f.task.id, "ready"), deadline = done.history.at(-1)!.reviewerQuotaWait!.deadline;
  expect(deadline).toBe(f.clock.now + 120_000);
  f.clock.now = reset; f.tasks.refreshReviewerQuotaWaits(); await drain();
  expect(f.board.get(done.id)?.reviewer).toBeNull(); expect(f.board.get(done.id)!.history.at(-1)!.reviewerQuotaWait!.deadline).toBe(deadline);
  f.clock.now = reset + 61_000; f.tasks.refreshReviewerQuotaWaits(); await drain(); expect(f.board.get(done.id)?.reviewer).toBeNull();
  // This port represents Budget having resumed after its own proven expiry or fresh reading; Tasks never resumes it.
  f.paused({}); f.readings({ "claude-review": { headroom: 0.5, resetsAt: reset + 600_000 } });
  f.clock.now = reset + 70_000; f.tasks.refreshReviewerQuotaWaits(); await drain(); expect(f.board.get(done.id)?.reviewer).toBe("claude-review");
});


test("real daemon admits only actual fake Codex refusal, pauses canonical account and fans out without retaining raw prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-quota-daemon-")), repo = join(root, "repo"), bin = join(root, "bin"), home = join(root, "home"), stateDir = join(repo, "state");
  mkdirSync(repo); mkdirSync(bin); mkdirSync(home); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const prior = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; process.env.CODEX_HOME = join(home, ".codex");
  cleanup.push(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const executable = join(bin, "codex"), fake = resolve(import.meta.dir, "fakes/fake-codex-reviewer.ts");
  writeFileSync(executable, `#!/bin/sh\nexport FAKE_CODEX_REVIEW_QUOTA=1\nunset FAKE_CODEX_REVIEW_LOG\nexec '${process.execPath}' '${fake}' "$@"\n`); chmodSync(executable, 0o755);
  const daemon = await startDaemon({ cwd: repo, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, codex_bin: executable, batch_ms: 0,
      instances: { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } },
      roles: { ...DEFAULT_CONFIG.roles, builder: ["implementer"] }, review: { ...DEFAULT_CONFIG.review, pool: ["codex"] },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  // A synthetic attached sibling, not a native Codex/account transport.
  const sibling = new Peer("codex"); await sibling.start(); daemon.bus.add(sibling);
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  expect(await person.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
  expect(daemon.bus.isPaused("codex")).toBe(false); // Startup proofs never emit the opt-in exec quota frame.
  expect(await person.request({ t: "budget", set: { peer: "codex-review", used: 0.1, resetsInMs: 600_000 } })).toMatchObject({ ok: true });
  const builder = await ControlClient.connect(stateDir, { role: "peer", peer: "builder", channel: true }); cleanup.push(() => builder.close());
  const until = async (ok: () => boolean) => { for (let i = 0; i < 1000 && !ok(); i++) await Bun.sleep(10); expect(ok()).toBe(true); };
  await until(() => daemon.bus.stateOf("builder") === "idle");
  const invoke = async (op: string, args: Record<string, unknown>) => { const reply = await builder.request({ t: "task", op, args }); expect(reply.ok).toBe(true); return String(reply.text); };
  const proposed = await invoke("hub_task_propose", { title: "synthetic quota review", class: "implement", owner: "builder" });
  const id = Number(/#(\d+)/.exec(proposed)![1]);
  await invoke("hub_task_accept", { id }); await invoke("hub_task_done", { id, summary: "synthetic implementation" });
  await until(() => daemon.bus.isPaused("codex-review") && daemon.bus.isPaused("codex"));
  const shown = await person.request({ t: "budget" });
  expect(shown.budget.codex.paused).toBeDefined(); expect(shown.budget["codex-review"]).toBeUndefined();
  expect(shown.budget.codex.windows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "5h", used: 1, source: "Codex reviewer quota" })]));
  const status = (await person.request({ t: "status" })).status;
  expect(status.peers["codex-review"].paused).toContain("budget:"); expect(status.peers.codex.paused).toContain("budget:");
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const current = () => db.query("SELECT state, reviewer, history FROM tasks WHERE id = ?").get(id) as { state: string; reviewer: string; history: string };
  await until(() => current().reviewer === "user"); // Pinned exec frame has UNKNOWN reset, so no Q5 wait.
  expect(current().state).toBe("in_review"); expect(JSON.parse(current().history).some((entry: { reviewerQuotaWait?: unknown }) => entry.reviewerQuotaWait)).toBe(false);
  const route = await person.request({ t: "task", op: "route_explain", args: { id } }); expect(route.ok).toBe(true); expect(route.text).toContain("codex-review"); expect(route.text).toContain("paused");
  const events = readFileSync(join(stateDir, "events.jsonl"), "utf8");
  expect(events).toContain('"type":"quota"'); expect(events).toContain('"type":"budget_pause"');
  const publicReceipt = JSON.stringify([shown, status, route]) + events + (existsSync(join(stateDir, "hub.log")) ? readFileSync(join(stateDir, "hub.log"), "utf8") : "");
  expect(publicReceipt).not.toContain("RAW-QUOTA-MARKER"); expect(publicReceipt).not.toContain("You’ve hit your usage limit");
}, 20_000);


test("enforce CI deteriorating during quota wait cannot extend original deadline or send native review", async () => {
  let ready = true, reads = 0;
  const head = "a".repeat(40), names = ["fixture-check"];
  const gh: SdlcGh = async args => {
    reads++;
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 1, labels: { nodes: [], pageInfo: { hasNextPage: false } } }, pullRequest: {
      headRefOid: head, state: "OPEN", commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) }, statusCheckRollup: { contexts: { nodes: names.map(name => ({ name, status: "COMPLETED", conclusion: ready ? "SUCCESS" : "FAILURE" })), pageInfo: { hasNextPage: false } } } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } }) };
  };
  const f = await fixture({ sdlc: { config: () => sdlcConfig({ mode: "enforce", required_checks: names }), gh } });
  f.board.update(f.task.id, "user", "fixture PR", { sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  const done = await f.tasks.done("codex", f.task.id, "ready"), deadline = done.history.at(-1)!.reviewerQuotaWait!.deadline;
  expect(reads).toBeGreaterThan(0); expect(done.reviewer).toBeNull();
  ready = false; f.clock.now = deadline; f.tasks.refreshReviewerQuotaWaits(); await drain();
  expect(f.board.get(done.id)).toMatchObject({ state: "in_review", reviewer: "user" });
  expect(f.peers["claude-review"]!.seen.filter(env => env.kind === "review")).toHaveLength(0);
});

test("accounting recovery commitment distinguishes missing, changed, incomplete, pending and unknown journal state", () => {
  const start = { type: "reviewer_accounting", peer: "kimi", attempt: "a".repeat(32), outcome: "started" };
  const terminal = { ...start, outcome: "complete" };
  const full = reviewerAccountingIntegrity([start, terminal], true);
  expect(full).toMatchObject({ rows: 2, completed: 1, pending: 0, unknown: 0, complete: true });
  expect(reviewerAccountingIntegrity([start], true)).toMatchObject({ pending: 1 });
  expect(reviewerAccountingIntegrity([start, { ...terminal, outcome: "unknown" }], true)).toMatchObject({ unknown: 1 });
  for (const changed of [reviewerAccountingIntegrity([], true), reviewerAccountingIntegrity([start, { ...terminal, outcome: "unknown" }], true), reviewerAccountingIntegrity([start, terminal], false)]) expect(changed.digest).not.toBe(full.digest);
  expect(JSON.stringify(full)).not.toContain("kimi"); expect(JSON.stringify(full)).not.toContain(start.attempt);
});

async function recoveryFixture(journal: string = "", explicit = false, ceiling = 0) {
  const root = mkdtempSync(join(tmpdir(), "ahub-quota-recovery-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  if (journal) writeFileSync(join(stateDir, "events.jsonl"), journal);
  if (explicit) { mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ review: { gate: 0.8 } })); }
  const options: Parameters<typeof startDaemon>[0] = { cwd: root, stateDir, projectId: "quota-recovery-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: ceiling }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } };
  const daemon = await startDaemon(options); cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const status = (await person.request({ t: "status" })).status, operationId = "reviewer-quota-proof";
  const request = (op: string, features = status.features) => person.request({ t: "recovery", op, operationId, expectedInstanceId: status.instanceId, targetFeatures: features });
  return { root, stateDir, options, daemon, person, status, operationId, request, oldFeatures: status.features.filter((feature: string) => feature !== "reviewer_quota") };
}
const accountingJournal = (outcome: string) => JSON.stringify({ v: 1, at: "2026-11-14T00:00:00.000Z", type: "reviewer_accounting", peer: "kimi", attempt: "c".repeat(32), outcome }) + "\n";

test("older recovery target is allowed for legacy empty state but refused for retained accounting, waits and explicit policy", async () => {
  const empty = await recoveryFixture();
  expect(await empty.request("prepare", empty.oldFeatures)).toMatchObject({ ok: true }); expect(await empty.request("abort", empty.oldFeatures)).toMatchObject({ ok: true });
  const retained = await recoveryFixture(accountingJournal("started"));
  expect(await retained.request("prepare", retained.oldFeatures)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks reviewer_quota") });
  expect((await retained.person.request({ t: "status" })).status.stopping).toBe(false);
  const policy = await recoveryFixture("", true);
  expect(await policy.request("prepare", policy.oldFeatures)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks reviewer_quota") });
  const wait = await recoveryFixture(), board = new Board(join(wait.stateDir, "hub.db")); cleanup.push(() => board.close());
  const task = board.propose("user", { title: "retained quota deadline", class: "summarize" });
  board.update(task.id, "user", "accepted", { state: "in_progress", owner: "user" });
  board.update(task.id, "hub", "done", { state: "in_review", reviewer: null }, undefined, { reviewerQuotaWait: { created: task.created, binding: "a".repeat(64), since: Date.now(), deadline: Date.now() + 60_000, resetAt: Date.now() + 30_000 } });
  expect(await wait.request("prepare", wait.oldFeatures)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks reviewer_quota") });
}, 20_000);

test("controlled recovery refuses a missing or changed accounting journal before restoring optimistic counts", async () => {
  const usage = JSON.stringify({ v: 1, at: "2026-11-14T00:00:00.000Z", type: "usage", source: "kimi_wire", peer: "kimi-review", id: "d".repeat(32),
    measuredAt: "2026-11-14T00:00:00.000Z", inputTokens: 7, cacheWriteTokens: 2, outputTokens: 3, cacheReadTokens: 0, totalTokens: 12 }) + "\n";
  const f = await recoveryFixture(accountingJournal("started") + usage + accountingJournal("complete"));
  expect(await f.request("prepare")).toMatchObject({ ok: true }); expect(await f.request("commit")).toMatchObject({ ok: true, committed: true }); await f.daemon.stopped;
  const original = readFileSync(join(f.stateDir, "events.jsonl"), "utf8"), previous = process.env.AGENTHUB_RECOVERY_OPERATION;
  process.env.AGENTHUB_RECOVERY_OPERATION = f.operationId;
  try {
    writeFileSync(join(f.stateDir, "events.jsonl"), "");
    await expect(startDaemon(f.options)).rejects.toThrow("reviewer accounting recovery binding changed");
    writeFileSync(join(f.stateDir, "events.jsonl"), original.replace('"outcome":"complete"', '"outcome":"unknown"'));
    await expect(startDaemon(f.options)).rejects.toThrow("reviewer accounting recovery binding changed");
    writeFileSync(join(f.stateDir, "events.jsonl"), original.split("\n").filter(line => !line.includes('"source":"kimi_wire"')).join("\n"));
    await expect(startDaemon(f.options)).rejects.toThrow("reviewer accounting recovery binding changed");
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(true);
  } finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
}, 20_000);


test("unchanged malformed replay has a deterministic UNKNOWN commitment independent of sticky incomplete input", () => {
  const invalid = [{ type: "usage", source: "kimi_wire", peer: "kimi", id: "e".repeat(32), at: "2026-11-14T00:00:00Z", measuredAt: "2026-11-14T00:00:00Z",
    inputTokens: "invalid", cacheWriteTokens: 0, outputTokens: 1, cacheReadTokens: 0, totalTokens: 1 }];
  const initial = reviewerAccountingIntegrity(invalid, true), sticky = reviewerAccountingIntegrity(invalid, false);
  expect(initial).toEqual(sticky); expect(initial.complete).toBe(false); expect(initial.unknown).toBeGreaterThan(0);
  expect(reviewerAccountingIntegrity([], true).digest).not.toBe(initial.digest);
});

test("compatible controlled recovery of unchanged malformed parseable journal preserves UNKNOWN soft usage", async () => {
  const malformed = JSON.stringify({ v: 1, at: "2026-11-14T00:00:00.000Z", type: "usage", source: "kimi_wire", peer: "kimi", id: "e".repeat(32),
    measuredAt: "2026-11-14T00:00:00.000Z", inputTokens: "invalid", cacheWriteTokens: 0, outputTokens: 1, cacheReadTokens: 0, totalTokens: 1 }) + "\n";
  const f = await recoveryFixture(accountingJournal("started") + malformed + accountingJournal("complete"), false, 100);
  expect((await f.person.request({ t: "budget" })).kimiSource.state).toBe("unreadable");
  expect(await f.request("prepare")).toMatchObject({ ok: true }); expect(await f.request("commit")).toMatchObject({ ok: true, committed: true }); await f.daemon.stopped;
  const previous = process.env.AGENTHUB_RECOVERY_OPERATION; process.env.AGENTHUB_RECOVERY_OPERATION = f.operationId;
  let target: Awaited<ReturnType<typeof startDaemon>>;
  try { target = await startDaemon(f.options); }
  finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
  cleanup.push(() => target.stop());
  const person = await ControlClient.connect(f.stateDir, { role: "console" }); cleanup.push(() => person.close());
  const status = (await person.request({ t: "status" })).status;
  const inspect = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId });
  expect(inspect.recovery.integrity.current.reviewerQuota).toMatchObject({ complete: false, completed: 1, pending: 0 });
  expect(inspect.recovery.integrity.current.reviewerQuota.unknown).toBeGreaterThan(0);
  expect(await person.request({ t: "recovery", op: "release", operationId: f.operationId, expectedInstanceId: status.instanceId })).toMatchObject({ ok: true, released: true });
  const shown = await person.request({ t: "budget" }); expect(shown.kimiSource.state).toBe("unreadable");
  expect(shown.budget.kimi?.windows ?? []).toEqual([]);
}, 20_000);
