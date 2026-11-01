import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import { comparisonPlanHash, evaluatorIdentityHash, type ComparisonPlanV1, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef", HASH = "a".repeat(64);
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}

async function fixture(privateSource = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-comparison-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); let board = new Board(file); clean.push(() => board.close());
  const budget = new ExecutionBudget(file); clean.push(() => budget.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  const sources = new Map([[SOURCE, { id: SOURCE, sha256: HASH, private: privateSource }]]);
  let now = NOW, screen: ConstructorParameters<typeof Tasks>[0]["piiScreen"];
  const build = () => new Tasks({ board, bus, cwd: dir, project: "comparison-fixture", routing: () => routing, roles, executionBudget: budget, wipLimit: () => 32,
    notify: () => {}, studyNow: () => now, piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }),
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Synthetic comparison campaign", class: "implement", backlog: true });
  const contract: ResearchCampaignContract = { question: "Which fixed synthetic result is compatible?", scope: "No execution", exclusions: [], sourceIds: [SOURCE],
    units: [{ id: "measure", round: 0, question: "Record synthetic measurements", perspective: "measurement", requiredOutput: "Declared evidence", sourceIds: [SOURCE], dependsOn: [], purpose: "analysis" }],
    deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: new Date(NOW + 86_400_000).toISOString() } };
  const draft = await tasks.studyDraft("claude", { parentTaskId: parent.id, contract }), campaign = await tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  const taskId = campaign.units[0]!.taskId, owner = privateSource ? "local" : "codex";
  await tasks.pullPlanned(USER, { id: taskId, revision: 0, reason: "Record the explicitly approved comparison fixture" });
  await tasks.assignTo(taskId, owner, USER); tasks.accept(owner, taskId);
  const protocol = (): ExperimentProtocolContract => ({ campaignId: campaign.id, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: "b".repeat(40) }, environment: { descriptor: "Synthetic CPU fixture" }, method: "Compare fixed synthetic measurements", parameters: { size: 2 }, seeds: [1],
    evaluator: { id: "fixture", version: "v1" }, metrics: [{ name: "score", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"], resourceLimits: [], sealed: false });
  const plan = (): ComparisonPlanV1 => {
    const p = protocol();
    return { campaignId: campaign.id, fixed: { inputs: p.inputs, splits: p.splits, evaluator: p.evaluator, metrics: p.metrics },
      varying: ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value: 0.01 } };
  };
  return { dir, owner, taskId, campaign, sources, routing, protocol, plan, get board() { return board; }, get tasks() { return tasks; },
    setNow(value: number) { now = value; }, setScreen(next: NonNullable<typeof screen>) { screen = next; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function saveProtocol(f: Fixture, p = f.protocol()) {
  return (await f.tasks.experimentRecord(f.owner, { kind: "protocol", taskId: f.taskId, protocol: p })).protocolHash;
}
async function savePlan(f: Fixture, p = f.plan(), by = f.owner) {
  return (await f.tasks.experimentRecord(by, { kind: "plan", taskId: f.taskId, plan: p })).planHash;
}
async function attempt(f: Fixture, hash: string, key: string, extra: { phase?: "development" | "final"; retryOf?: string; reproducesAttemptId?: string } = {}) {
  const result = await f.tasks.experimentRecord(f.owner, { kind: "attempt", attempt: { protocolHash: hash, taskId: f.taskId, phase: "development", idempotencyKey: key, ...extra } });
  if (!result.attemptId) throw new Error("attempt response omitted its identity");
  return result.attemptId;
}
const show = (f: Fixture, id: string) => f.tasks.experimentShow(USER, { attemptId: id });
const pair = (f: Fixture, planHash: string, baselineAttemptId: string, variantAttemptId: string) => f.tasks.experimentShow(USER, { planHash, baselineAttemptId, variantAttemptId });

test("#599 only the person approves exact protocol and evaluator hashes; changed protocols stay unapproved", async () => {
  const f = await fixture(), p = f.protocol(), hash = await saveProtocol(f, p), id = await attempt(f, hash, "original");
  expect((await show(f, id)).attempts[0]!.approval).toBe("unapproved");
  for (const by of [f.owner, "claude", "local"]) await expect(f.tasks.experimentApproveProtocol(by, { hash })).rejects.toThrow();
  await expect(f.tasks.experimentApproveProtocol(USER, { hash: "f".repeat(64) })).rejects.toThrow();
  const approved = await f.tasks.experimentApproveProtocol(USER, { hash });
  expect(approved).toEqual({ protocolHash: hash, evaluatorHash: evaluatorIdentityHash(p), approvedBy: USER, approvedAt: NOW });
  expect((await show(f, id)).attempts[0]!.approval).toBe("approved");
  for (const changed of [{ ...p, code: { commit: "c".repeat(40) } }, { ...p, evaluator: { ...p.evaluator, version: "v2" } }, { ...p, lineage: "different-lineage" }]) {
    const next = await saveProtocol(f, changed); expect(next).not.toBe(hash);
    const other = await attempt(f, next, next);
    expect((await show(f, other)).attempts[0]!.approval).toBe("unapproved");
  }
  f.setNow(NOW + 1000); f.restart();
  expect(await f.tasks.experimentApproveProtocol(USER, { hash })).toEqual(approved);
});

test("#599 plans are immutable and replay by hash; foreign owner, campaign and source references refuse", async () => {
  const f = await fixture(), p = f.plan(), hash = await savePlan(f, p), original = f.board.experimentComparisonPlan(hash);
  expect(hash).toBe(comparisonPlanHash(p)); expect(await savePlan(f, p)).toBe(hash);
  expect(f.board.experimentComparisonPlan(hash)).toEqual(original);
  await expect(savePlan(f, p, "local")).rejects.toThrow(); await expect(savePlan(f, p, USER)).rejects.toThrow();
  for (const bad of [{ ...p, campaignId: "rc-ffffffffffff" }, { ...p, fixed: { ...p.fixed, inputs: [{ sourceId: SOURCE, sha256: "c".repeat(64) }] } },
    { ...p, fixed: { ...p.fixed, inputs: [{ sourceId: "src:ffffffffffffffff", sha256: HASH }] } }]) await expect(savePlan(f, bad)).rejects.toThrow();
  const next = await savePlan(f, { ...p, rule: { kind: "tolerance", value: 0.02 } });
  expect(next).not.toBe(hash); expect(f.board.experimentComparisonPlan(hash)).toEqual(original);
  f.restart(); expect(await savePlan(f, p)).toBe(hash); expect(f.board.experimentComparisonPlan(hash)).toEqual(original);
});

test("#599 compatible and incompatible pairs both stay visible; approvals and compatibility remain separate", async () => {
  const f = await fixture(), baselineHash = await saveProtocol(f), planHash = await savePlan(f), baseline = await attempt(f, baselineHash, "baseline");
  const variantHash = await saveProtocol(f, { ...f.protocol(), role: "variant", variantOf: baselineHash, code: { commit: "c".repeat(40) }, seeds: [2] });
  const variant = await attempt(f, variantHash, "variant");
  const initial = await pair(f, planHash, baseline, variant);
  expect(initial.attempts.map(row => row.id)).toEqual([baseline, variant]);
  expect(initial.comparison).toMatchObject({ planHash, baselineAttemptId: baseline, variantAttemptId: variant, approved: false, private: false,
    projection: { compatibility: { compatible: true }, baseline: { protocolHash: baselineHash, campaignRevision: 1 }, variant: { protocolHash: variantHash, campaignRevision: 1 } } });
  await f.tasks.experimentApproveProtocol(USER, { hash: baselineHash });
  expect((await pair(f, planHash, baseline, variant)).comparison!.approved).toBe(false);
  await f.tasks.experimentApproveProtocol(USER, { hash: variantHash });
  expect((await pair(f, planHash, baseline, variant)).comparison!.approved).toBe(true);
  const incompatibleHash = await saveProtocol(f, { ...f.protocol(), method: "Changed undeclared method" }), incompatible = await attempt(f, incompatibleHash, "incompatible");
  const changed = await pair(f, planHash, baseline, incompatible);
  expect(changed.attempts.map(row => row.id)).toEqual([baseline, incompatible]);
  expect(changed.comparison).toMatchObject({ approved: false, projection: { compatibility: { compatible: false, field: "method", side: "pair" } } });
  expect(changed.comparison!.projection).not.toHaveProperty("winner"); expect(changed.comparison!.projection).not.toHaveProperty("best");
});

test("#599 restart and duplicate recording retain identities; explicit retries and reproduction links stay declarations", async () => {
  const f = await fixture(), hash = await saveProtocol(f), original = await attempt(f, hash, "original");
  await f.tasks.experimentRecord(f.owner, { kind: "event", attemptId: original, idempotencyKey: "original-end", event: { kind: "end", body: { status: "failed" } } });
  const retry = await attempt(f, hash, "retry", { retryOf: original }), reproduction = await attempt(f, hash, "reproduction", { reproducesAttemptId: original });
  expect(new Set([original, retry, reproduction]).size).toBe(3);
  f.restart();
  expect(await attempt(f, hash, "original")).toBe(original); expect(await attempt(f, hash, "retry", { retryOf: original })).toBe(retry);
  const retryRow = (await show(f, retry)).attempts[0]!, reproductionRow = (await show(f, reproduction)).attempts[0]!;
  expect(retryRow).toMatchObject({ id: retry, retryOf: original, independentlyReproduced: false });
  expect(reproductionRow).toMatchObject({ id: reproduction, reproducesAttemptId: original, independentlyReproduced: false });
  expect((await show(f, original)).attempts[0]).toMatchObject({ status: "failed", independentlyReproduced: false });
});

test("#599 post-hoc records follow final-end insertion order, not equal or reversed wall-clock times", async () => {
  const f = await fixture(), firstHash = await saveProtocol(f), final = await attempt(f, firstHash, "final", { phase: "final" });
  const beforeEndHash = await saveProtocol(f, { ...f.protocol(), method: "Declared before final evidence", supersedes: firstHash });
  await f.tasks.experimentRecord(f.owner, { kind: "event", attemptId: final, idempotencyKey: "final-end", event: { kind: "end", body: { status: "failed" } } });
  f.setNow(NOW - 1000);
  const afterEndHash = await saveProtocol(f, { ...f.protocol(), method: "Declared after final evidence", supersedes: beforeEndHash });
  const beforeEnd = await attempt(f, beforeEndHash, "before-end"), afterEnd = await attempt(f, afterEndHash, "after-end");
  expect((await show(f, beforeEnd)).attempts[0]!.postHoc).toBe("predeclared");
  expect((await show(f, afterEnd)).attempts[0]!.postHoc).toBe("post-hoc");
  f.restart();
  expect((await show(f, beforeEnd)).attempts[0]!.postHoc).toBe("predeclared"); expect((await show(f, afterEnd)).attempts[0]!.postHoc).toBe("post-hoc");
});

test("#599 a legacy protocol without insertion context stays unknown instead of gaining invented post-hoc evidence", async () => {
  const f = await fixture(), hash = await saveProtocol(f), id = await attempt(f, hash, "legacy");
  // Isolated legacy fixture only: a pre-context writer had no row to backfill from recording order.
  (f.board as unknown as { db: Database }).db.query("DELETE FROM research_protocol_context WHERE protocol_hash=?").run(hash);
  f.restart(); expect((await show(f, id)).attempts[0]!.postHoc).toBe("unknown");
});

test("#599 a private pair retains both attempt identities while withholding protocol and comparison bodies", async () => {
  const f = await fixture(true), canary = "PRIVATE_COMPARISON_METHOD_CANARY";
  const base = { ...f.protocol(), method: canary }, baselineHash = await saveProtocol(f, base), baseline = await attempt(f, baselineHash, "private-base");
  const variantHash = await saveProtocol(f, { ...base, role: "variant", variantOf: baselineHash, seeds: [2] }), variant = await attempt(f, variantHash, "private-variant");
  const planHash = await savePlan(f);
  const shown = await pair(f, planHash, baseline, variant);
  expect(shown.attempts.map(row => row.id)).toEqual([baseline, variant]); expect(shown.attempts.every(row => row.private)).toBe(true);
  expect(shown.comparison).toMatchObject({ planHash, baselineAttemptId: baseline, variantAttemptId: variant, private: true, projection: "[pii]" });
  expect(JSON.stringify(shown)).not.toContain(canary); expect(JSON.stringify(shown)).not.toContain(SOURCE);
});

test("#599 a source hash change during plan screening refuses the stale immutable record", async () => {
  const f = await fixture(), p = f.plan(); f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.setScreen(async () => { entered(); await gate; return { label: "clear", ms: 0 }; });
  const call = savePlan(f, p), result = call.then(() => undefined, error => error);
  try {
    await Promise.race([started, call.then(() => { throw new Error("plan admission missed the screen barrier"); })]);
    f.sources.get(SOURCE)!.sha256 = "c".repeat(64);
  } finally { release(); }
  expect(await result).toBeInstanceOf(Error); expect(f.board.experimentComparisonPlan(comparisonPlanHash(p))).toBeUndefined();
}, 20_000);


test("#599 corrupt approval or causal context never becomes accepted readback evidence", async () => {
  const f=await fixture(), hash=await saveProtocol(f), id=await attempt(f,hash,"corruption");
  await f.tasks.experimentApproveProtocol(USER,{hash});
  const db=(f.board as unknown as {db:Database}).db;
  db.query("UPDATE research_protocol_approvals SET evaluator_hash=? WHERE protocol_hash=?").run("f".repeat(64),hash);
  await expect(show(f,id)).rejects.toThrow();
  expect(()=>f.board.researchComparisonIntegrity()).toThrow();
  db.query("DELETE FROM research_protocol_approvals WHERE protocol_hash=?").run(hash);
  db.query("UPDATE research_protocol_context SET context_sha256=? WHERE protocol_hash=?").run("e".repeat(64),hash);
  await expect(show(f,id)).rejects.toThrow();
  expect(()=>f.board.researchComparisonIntegrity()).toThrow();
});
