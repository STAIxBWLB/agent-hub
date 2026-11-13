import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { ReviewGate, ReviewUnknownQuota, ReviewBudgetSnapshot } from "../src/hub/review-budget.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Peer extends BasePeer {
  seen: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.seen.push(...envs); if (id) this.delivery({ id, state: "completed" }); }
}
type Policy = { gate?: ReviewGate; unknown_quota?: ReviewUnknownQuota };
async function taskFixture(policy: Policy, readings: ReviewBudgetSnapshot["readings"] = {}, paused: ReviewBudgetSnapshot["paused"] = {}, manualPaused: readonly string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-optout-routing-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const now = Date.now(), reviewer = "claude-review";
  const tasks = new Tasks({ cwd, project: "fixture", board, bus, notify: () => {}, now: () => now,
    instances: () => ({ [reviewer]: { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const } }),
    roles: { codex: ["implementer"], [reviewer]: ["reviewer"] }, reviewOnly: peer => peer === reviewer,
    review: { adaptive: false, min_reviews: 5, pool: ["claude"], gate: 0.8, unknown_quota: "skip", ...policy },
    quota: () => readings, reviewBudget: () => ({ paused, manualPaused }),
    routing: () => parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n') });
  for (const id of ["codex", reviewer]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const task = await tasks.propose("user", { title: "quota admission fixture", class: "summarize", owner: "codex" });
  return { tasks, board, bus, task, reviewer, now };
}

for (const [policy, rule, readings] of [
  [{ gate: "off" }, "review.gate=off", { "claude-review": { headroom: 0 } }],
  [{ unknown_quota: "pass" }, "review.unknown_quota=pass", {}],
] as [Policy, string, ReviewBudgetSnapshot["readings"]][]) test(`Tasks assignment history and route explain name the same ${rule} admission rule`, async () => {
  const f = await taskFixture(policy, readings);
  expect(f.task.reviewer).toBe(f.reviewer);
  const assignment = f.task.history.findLast(row => row.event === "assigned")!;
  expect(assignment.note).toContain(rule);
  const trace = f.tasks.explain(f.task.id).join("\n"); expect(trace).toContain(f.reviewer); expect(trace).toContain(`admitted by ${rule}`);
  f.tasks.accept("codex", f.task.id);
  const done = await f.tasks.done("codex", f.task.id, "fixture ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: f.reviewer }); expect(done.history.at(-1)?.reviewerQuotaWait).toBeUndefined();
});

test("default unknown skip is actionable and opt-outs do not bypass real or manual pause routing", async () => {
  const skipped = await taskFixture({}); expect(skipped.task.reviewer).toBe("user");
  const trace = skipped.tasks.explain(skipped.task.id).join("\n"); expect(trace).toContain("review quota unknown"); expect(trace).toContain("review.unknown_quota=pass"); expect(trace).toContain("review.gate=off");
  for (const [policy, paused, manual] of [
    [{ gate: "off" }, { "claude-review": { resetsAt: Date.now() + 60_000 } }, []],
    [{ unknown_quota: "pass" }, {}, ["claude-review"]],
  ] as [Policy, ReviewBudgetSnapshot["paused"], string[]][]) {
    const held = await taskFixture(policy, {}, paused, manual); expect(held.task.reviewer).toBe("user");
    held.tasks.accept("codex", held.task.id); const done = await held.tasks.done("codex", held.task.id, "fixture ready");
    expect(done.reviewer).toBe("user"); expect(done.history.at(-1)?.reviewerQuotaWait).toBeUndefined();
  }
});

async function daemonFixture(policy: Policy = {}, explicit = false, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-optout-policy-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "AGENTHUB_HOME", "AMEM_HOME"] as const;
  const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { const home = join(root, key.toLowerCase()); mkdirSync(home); process.env[key] = home; }
  cleanup.push(() => { for (const key of envKeys) { const value = original[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  if (explicit) { mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ review: policy })); }
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "optout-policy-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, review: legacy ? { adaptive: false, min_reviews: 5 } : { ...DEFAULT_CONFIG.review, ...policy }, roster: {}, start: { agents: [] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => person.close());
  const status = (await person.request({ t: "status" })).status;
  const features = status.features.filter((feature: string) => feature !== "reviewer_quota"), operationId = "optout-recovery";
  const request = (op: string) => person.request({ t: "recovery", op, operationId, expectedInstanceId: status.instanceId, targetFeatures: features });
  return { daemon, person, request };
}

test("real daemon budget exposes default reviewer policy and compatible legacy empty recovery", async () => {
  const f = await daemonFixture(), shown = await f.person.request({ t: "budget" }); expect(shown.ok).toBe(true);
  const settings = await f.person.request({ t: "settings_get" });
  expect(settings.rows.find((row: { key: string }) => row.key === "review.gate")).toMatchObject({ type: "number-or-off", min: 0, max: 1, risk: "raises" });
  expect(settings.rows.find((row: { key: string }) => row.key === "review.unknown_quota")).toMatchObject({ values: ["skip", "pass"], risk: "raises" });
  expect(shown.review).toMatchObject({ gate: 0.8, unknown_quota: "skip" }); expect(shown.review.rule).toContain("review.gate=0.8"); expect(shown.review.rule).toContain("review.unknown_quota=skip");
  expect(await f.request("prepare")).toMatchObject({ ok: true }); expect(await f.request("abort")).toMatchObject({ ok: true });
});

const explicitPolicies: Policy[] = [{ gate: "off" }, { unknown_quota: "pass" }, { unknown_quota: "skip" }];
for (const policy of explicitPolicies) test(`real daemon publishes and recovery preserves explicit reviewer opt-out policy ${JSON.stringify(policy)}`, async () => {
  const f = await daemonFixture(policy, true), shown = await f.person.request({ t: "budget" }); expect(shown.ok).toBe(true);
  expect(shown.review).toMatchObject({ gate: policy.gate ?? 0.8, unknown_quota: policy.unknown_quota ?? "skip" });
  expect(shown.review.rule).toContain(policy.gate === "off" ? "review.gate=off" : `review.unknown_quota=${policy.unknown_quota}`);
  expect(await f.request("prepare")).toMatchObject({ ok: false, error: expect.stringContaining("target lacks reviewer_quota") });
  expect(f.daemon.bus.isRecoveryHeld).toBe(false);
});


test("legacy embedded host does not describe a reviewer policy it never injects", async () => {
  const f = await daemonFixture({}, false, true), shown = await f.person.request({ t: "budget" });
  expect(shown.ok).toBe(true); expect(shown.review).toBeUndefined();
});
