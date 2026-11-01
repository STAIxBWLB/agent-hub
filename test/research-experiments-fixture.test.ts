import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { paint } from "../src/cli/console-state.ts";
import { renderExperiments } from "../src/cli/study-output.ts";
import { parseStudyArgs } from "../src/cli/study.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import type { ComparisonPlanV1, DeclaredExperimentEventInput, ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

// #602 (issue 932 T3, AC5): a synthetic CPU-only receipt fixture. Baseline, variant, failure and changed-protocol cases, a private input and an inaccessible output, read back through
// the same function `ahub study experiments` renders. No account, no GPU, no process is started and no command in a receipt is run.
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef", HASH = "a".repeat(64), COMMIT = "b".repeat(40);
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(_envs: Envelope[]) {}
}
const plain = (view: unknown) => renderExperiments(view, 140).map(line => paint(line, false)).join("\n");

async function fixture(privateSource = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-experiment-fixture-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); const board = new Board(file); clean.push(() => board.close());
  const budget = new ExecutionBudget(file); clean.push(() => budget.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  const sources = new Map([[SOURCE, { id: SOURCE, sha256: HASH, private: privateSource }]]);
  const tasks = new Tasks({ board, bus, cwd: dir, project: "experiment-receipt-fixture", routing: () => routing, roles, executionBudget: budget, wipLimit: () => 32,
    notify: () => {}, studyNow: () => NOW, piiScreen: () => Promise.resolve({ label: "clear" as const, ms: 0 }),
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); }, experimentCheck: async () => undefined });
  const parent = await tasks.propose(USER, { title: "Synthetic receipt campaign", class: "implement", backlog: true });
  const contract: ResearchCampaignContract = { question: "What does the synthetic evidence show?", scope: "Isolated fixture", exclusions: [], sourceIds: [SOURCE],
    units: [{ id: "measure", round: 0, question: "Measure synthetic inputs", perspective: "measurement", requiredOutput: "Metrics and bounded receipts", sourceIds: [SOURCE], dependsOn: [], purpose: "analysis" }],
    deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: new Date(NOW + 86_400_000).toISOString() } };
  const draft = await tasks.studyDraft("claude", { parentTaskId: parent.id, contract }), campaign = await tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  const taskId = campaign.units[0]!.taskId, owner = privateSource ? "local" : "codex";
  await tasks.pullPlanned(USER, { id: taskId, revision: 0, reason: "Start the explicitly approved synthetic unit" });
  await tasks.assignTo(taskId, owner, USER); tasks.accept(owner, taskId);
  const protocol = (): ExperimentProtocolContract => ({ campaignId: campaign.id, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: COMMIT }, environment: { descriptor: "Synthetic CPU fixture with no environment values" }, method: "Compare two fixed synthetic numbers", parameters: { size: 2 }, seeds: [1],
    evaluator: { id: "fixture", version: "v1" }, metrics: [{ name: "score", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"], resourceLimits: [], sealed: false });
  const plan = (): ComparisonPlanV1 => { const p = protocol(); return { campaignId: campaign.id, fixed: { inputs: p.inputs, splits: p.splits, evaluator: p.evaluator, metrics: p.metrics },
    varying: ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value: 0.01 } }; };
  const saveProtocol = async (p = protocol()) => (await tasks.experimentRecord(owner, { kind: "protocol", taskId, protocol: p })).protocolHash;
  const savePlan = async (p = plan()) => (await tasks.experimentRecord(owner, { kind: "plan", taskId, plan: p })).planHash;
  const attempt = async (protocolHash: string, key: string, phase: "development" | "final" = "final") => {
    const r = await tasks.experimentRecord(owner, { kind: "attempt", attempt: { protocolHash, taskId, phase, idempotencyKey: key } });
    if (!("attemptId" in r) || typeof r.attemptId !== "string") throw new Error("no attempt id"); return r.attemptId;
  };
  const add = (attemptId: string, key: string, event: DeclaredExperimentEventInput) => tasks.experimentRecord(owner, { kind: "event", attemptId, idempotencyKey: `${attemptId}:${key}`, event });
  return { dir, tasks, board, campaign, taskId, owner, protocol, plan, saveProtocol, savePlan, attempt, add, sources };
}

test("AC5: a baseline, a variant and a failure are read back with every value's provenance and every status in the counts, and nothing runs", async () => {
  const f = await fixture(), marker = join(f.dir, "must-not-run"), base = f.protocol(); base.method = `touch ${marker}`;
  const baseHash = await f.saveProtocol(base), baseline = await f.attempt(baseHash, "baseline");
  await f.add(baseline, "start", { kind: "start", body: { startedAt: NOW } });
  await f.add(baseline, "metric", { kind: "metric", body: { name: "score", value: 0.8 } });
  await f.add(baseline, "end", { kind: "end", body: { status: "succeeded", exitStatus: 0 } });
  const variantHash = await f.saveProtocol({ ...base, role: "variant", variantOf: baseHash, parameters: { size: 3 } }), variant = await f.attempt(variantHash, "variant");
  await f.add(variant, "metric", { kind: "metric", body: { name: "score", value: 0.9 } });
  await f.add(variant, "end", { kind: "end", body: { status: "succeeded", exitStatus: 0 } });
  const failed = await f.attempt(variantHash, "failure", "development");
  await f.add(failed, "end", { kind: "end", body: { status: "failed", reason: "Synthetic out-of-range input" } });
  const view = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id });
  expect(view.counts).toMatchObject({ all: 3, statuses: { succeeded: 2, failed: 1 } });
  const text = plain(view);
  expect(text).toContain("Experiment attempts (3 of 3 in this campaign)");
  expect(text).toContain("succeeded 2"); expect(text).toContain("failed 1");
  for (const id of [baseline, variant, failed]) expect(text).toContain(id);
  // an agent's number is shown as declared, with sealing and isolation unverified, never as observed
  expect(text).toMatch(/score \(fraction\)\s+0\.8\s+declared/); expect(text).toMatch(/score \(fraction\)\s+0\.9\s+declared/);
  expect(text).toContain("isolation unverified");
  const rows = text.split("\n").filter(line => !line.startsWith("declared values are")), body = rows.join("\n");
  expect(body).not.toMatch(/host-observed|runner-attested|person-attested/);                          // no table row claims a stronger source than declared
  expect(text).toContain("A repeat is never an independent reproduction");
  expect(text).toMatch(/unapproved/);
  expect(JSON.stringify(view)).not.toContain("independentlyReproduced\":true");
  const { existsSync } = await import("node:fs"); expect(existsSync(marker)).toBe(false);
});

test("AC5: a changed protocol is incompatible under the plan and is shown, not ranked", async () => {
  const f = await fixture(), baseHash = await f.saveProtocol(), baseline = await f.attempt(baseHash, "baseline");
  const compatibleHash = await f.saveProtocol({ ...f.protocol(), role: "variant", variantOf: baseHash, parameters: { size: 3 } }), compatible = await f.attempt(compatibleHash, "variant");
  const changedHash = await f.saveProtocol({ ...f.protocol(), role: "variant", variantOf: baseHash, evaluator: { id: "fixture", version: "v2" } }), changed = await f.attempt(changedHash, "changed");
  const planHash = await f.savePlan();
  const ok = plain(await f.tasks.experimentShow(USER, { planHash, baselineAttemptId: baseline, variantAttemptId: compatible }));
  expect(ok).toContain("compatible"); expect(ok).toContain("yes, under this plan");
  expect(ok).toContain(`${baseline} (baseline) and ${compatible} (variant)`);
  const no = plain(await f.tasks.experimentShow(USER, { planHash, baselineAttemptId: baseline, variantAttemptId: changed }));
  expect(no).toContain("no: evaluator differs (variant); shown, not ranked together");
  expect(no).not.toContain("yes, under this plan"); expect(no).toContain("not both approved");
});

test("AC5: a private input blanks the whole view to ids, counts and states, and the CLI text carries none of its content", async () => {
  const f = await fixture(true), canary = "PRIVATE_RECEIPT_TEXT_CANARY", p = f.protocol(); p.method = canary;
  const hash = await f.saveProtocol(p), id = await f.attempt(hash, "private");
  await f.add(id, "note", { kind: "note", body: { text: canary } });
  await f.add(id, "metric", { kind: "metric", body: { name: "score", value: 0.123456 } });
  const view = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id }), text = plain(view);
  expect(view.attempts[0]).toMatchObject({ id, private: true });
  expect(text).toContain("private, details withheld"); expect(text).toContain(id);
  for (const hidden of [canary, "0.123456", "Compare two fixed synthetic numbers"]) { expect(text).not.toContain(hidden); expect(JSON.stringify(view)).not.toContain(hidden); }
  expect(text).not.toContain("Evidence of");                                                                 // no evidence table for a private attempt
  // a comparison over a private source is withheld as a whole
  const other = await f.attempt(await f.saveProtocol({ ...f.protocol(), role: "variant", variantOf: hash, parameters: { size: 3 } }), "other");
  const planHash = await f.savePlan();
  const comparison = plain(await f.tasks.experimentShow(USER, { planHash, baselineAttemptId: id, variantAttemptId: other }));
  expect(comparison).toContain("withheld (a private source or record)"); expect(comparison).not.toContain("compatible");
});

test("AC5: an inaccessible output stays unknown and a supplied hash stays declared; a denied file makes the attempt private", async () => {
  const f = await fixture(); mkdirSync(join(f.dir, "results")); writeFileSync(join(f.dir, ".env"), "SYNTHETIC=private");
  const hash = await f.saveProtocol(), id = await f.attempt(hash, "outputs");
  await f.add(id, "missing", { kind: "output", body: { path: "results/missing.csv", format: "csv" } });
  await f.add(id, "claimed", { kind: "output", body: { id: "d-0123456789ab", sha256: HASH } });
  const row = (await f.tasks.experimentShow(USER, { attemptId: id })).attempts[0]!;
  expect(row.evidence).toMatchObject({ measured: [], declared: { outputs: [{ sha256: { value: null, provenance: "unknown" } }, { sha256: { value: HASH, provenance: "declared" } }] } });
  expect(plain(await f.tasks.experimentShow(USER, { attemptId: id })).split("\n").filter(line => !line.startsWith("declared values are")).join("\n")).not.toMatch(/host-observed/);
  const denied = await f.attempt(hash, "denied");
  await f.add(denied, "denied-file", { kind: "output", body: { path: ".env", format: "txt" } });
  const shown = await f.tasks.experimentShow(USER, { attemptId: denied });
  expect(shown.attempts[0]).toMatchObject({ private: true }); expect(plain(shown)).toContain("private, details withheld"); expect(plain(shown)).not.toContain("SYNTHETIC");
});

test("AC5: duplicate delivery keeps attempt identity, an explicit retry is a new linked attempt, and a repeat is never an independent reproduction (restart identity is pinned in research-experiments.test.ts)", async () => {
  const f = await fixture(), hash = await f.saveProtocol(), first = await f.attempt(hash, "stable");
  expect(await f.attempt(hash, "stable")).toBe(first);
  const retry = (await f.tasks.experimentRecord(f.owner, { kind: "attempt", attempt: { protocolHash: hash, taskId: f.taskId, phase: "final", idempotencyKey: "retry", retryOf: first } }));
  const repeat = (await f.tasks.experimentRecord(f.owner, { kind: "attempt", attempt: { protocolHash: hash, taskId: f.taskId, phase: "final", idempotencyKey: "repeat", reproducesAttemptId: first } }));
  const retryId = (retry as { attemptId: string }).attemptId, repeatId = (repeat as { attemptId: string }).attemptId;
  expect(new Set([first, retryId, repeatId]).size).toBe(3);
  const view = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id }), text = plain(view);
  expect(view.counts.all).toBe(3);
  expect(text).toContain(`retry of ${first}`); expect(text).toContain(`repeat of ${first}, not independent`);
  expect(view.attempts.every(row => row.independentlyReproduced === false)).toBe(true);
});

test("the CLI form is three closed shapes; a stray flag, a missing value, a repeat or a mix is a usage error before anything is sent", () => {
  const ok = (args: string[]) => parseStudyArgs(["experiments", ...args]);
  const campaign = "rc-0123456789ab", attempt = "ra-0123456789ab", other = "ra-abcdef012345", plan = "c".repeat(64);
  expect(ok(["--campaign", campaign])).toEqual({ op: "experiments", campaign });
  expect(ok(["--campaign", campaign, "--after", "50"])).toEqual({ op: "experiments", campaign, after: 50 });
  expect(ok(["--attempt", attempt])).toEqual({ op: "experiments", attempt });
  expect(ok(["--plan", plan, "--baseline", attempt, "--variant", other])).toEqual({ op: "experiments", plan, baseline: attempt, variant: other });
  for (const bad of [[], ["--campaign"], ["--campaign", campaign, "--campaign", campaign], ["--campaign", "rc-bad"], ["--attempt", campaign], ["--campaign", campaign, "--attempt", attempt],
    ["--attempt", attempt, "--after", "1"], ["--plan", plan, "--baseline", attempt], ["--plan", plan, "--baseline", attempt, "--variant", other, "--campaign", campaign],
    ["--plan", "short", "--baseline", attempt, "--variant", other], ["--after", "-1", "--campaign", campaign], ["--evil", "x"], ["stray"], ["--campaign", campaign, "--after"]])
    expect(ok(bad), JSON.stringify(bad)).toHaveProperty("usage");
});
