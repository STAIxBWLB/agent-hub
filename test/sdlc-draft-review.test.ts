import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { readReviewReadiness, reviewReadinessFromEvidence, sdlcConfig, type PrEvidence, type SdlcGh } from "../src/hub/sdlc.ts";

const head = "a".repeat(40), other = "b".repeat(40);
const names = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
const receipt = { stage: "build", repo: "STAIxBWLB/agent-hub", pr: 1 };
const mac = names[1]!;
const row = (name: string, conclusion = "SUCCESS") => ({ name, status: "COMPLETED", conclusion,
  detailsUrl: "https://github.com/STAIxBWLB/agent-hub/actions/runs/12/job/34",
  checkSuite: { workflowRun: { workflow: { resourcePath: "/STAIxBWLB/agent-hub/actions/workflows/check.yml" } } } });
const reply = () => ({ data: { repository: { pullRequest: {
  headRefOid: head, state: "OPEN", isDraft: true, reviewDecision: null as string | null,
  reviewRequests: { nodes: [{ __typename: "ReviewRequest" }], pageInfo: { hasNextPage: false } },
  commits: { nodes: [{ commit: { oid: head, tree: { oid: other }, statusCheckRollup: { contexts: {
    nodes: [row(names[0]!), row(mac, "FAILURE"), row(names[2]!)], pageInfo: { hasNextPage: false },
  } } } }] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
} } } });
const job = () => ({ id: 34, run_id: 12, head_sha: head, name: mac, status: "completed", conclusion: "failure", steps: [
  { name: "Set up job", status: "completed", conclusion: "success" },
  { name: "macOS shards deferred for a stacked PR", status: "completed", conclusion: "skipped" },
  { name: "macOS shards deferred for a draft PR", status: "completed", conclusion: "failure" },
  { name: "Every macOS shard passed", status: "completed", conclusion: "skipped" },
] });
function fake(snapshot = reply(), jobResult = job(), moved = false): SdlcGh {
  let reads = 0;
  return async args => args.includes("graphql")
    ? { code: 0, stdout: JSON.stringify(moved && ++reads > 1 ? { data: { repository: { pullRequest: { headRefOid: other } } } } : snapshot) }
    : { code: 0, stdout: JSON.stringify(jobResult) };
}

test("a proven draft deferral admits review and reports the two passing checks separately", async () => {
  expect(await readReviewReadiness(receipt, head, fake(), names)).toMatchObject({ ready: true, checks: [names[0], names[2]], deferred: [mac], draftApprovalEligible: true });
});

test("draft approval eligibility requires complete review state with no change request or unresolved thread", async () => {
  const requested = reply(); requested.data.repository.pullRequest.reviewDecision = "CHANGES_REQUESTED";
  expect((await readReviewReadiness(receipt, head, fake(requested), names)).draftApprovalEligible).toBe(false);
  const incomplete = reply(); incomplete.data.repository.pullRequest.reviewRequests.pageInfo.hasNextPage = true;
  expect((await readReviewReadiness(receipt, head, fake(incomplete), names)).draftApprovalEligible).toBe(false);
  const thread = reply(); thread.data.repository.pullRequest.reviewThreads.nodes.push({ isResolved: false } as never);
  expect((await readReviewReadiness(receipt, head, fake(thread), names)).draftApprovalEligible).toBe(false);
});

test("a draft failure is not accepted without exact-head job-step evidence", async () => {
  for (const changed of [
    { ...job(), head_sha: other },
    { ...job(), run_id: 13 },
    { ...job(), steps: job().steps.map(step => step.name.includes("draft PR") ? { ...step, conclusion: "skipped" } : step) },
    { ...job(), steps: [...job().steps, { name: "unexpected failure", status: "completed", conclusion: "failure" }] },
  ]) expect((await readReviewReadiness(receipt, head, fake(reply(), changed), names)).ready).toBe(false);
  expect((await readReviewReadiness(receipt, head, fake(reply(), job(), true), names)).ready).toBe(false);
});

test("pending, failing, duplicate, non-draft or wrong-head evidence refuses review", async () => {
  for (const mutate of [
    (p: ReturnType<typeof reply>["data"]["repository"]["pullRequest"]) => { p.isDraft = false; },
    (p: ReturnType<typeof reply>["data"]["repository"]["pullRequest"]) => { p.headRefOid = other; },
    (p: ReturnType<typeof reply>["data"]["repository"]["pullRequest"]) => { p.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!.conclusion = "FAILURE"; },
    (p: ReturnType<typeof reply>["data"]["repository"]["pullRequest"]) => { p.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[2]!.status = "IN_PROGRESS"; },
    (p: ReturnType<typeof reply>["data"]["repository"]["pullRequest"]) => { p.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes.push(row(mac, "FAILURE")); },
  ]) {
    const snapshot = reply(); mutate(snapshot.data.repository.pullRequest);
    expect((await readReviewReadiness(receipt, head, fake(snapshot), names)).ready).toBe(false);
  }
});

test("a cached failed aggregate never supplies the missing draft proof", () => {
  const evidence: PrEvidence = { head, state: "OPEN", draft: true, unresolved: 0, review: "unknown", pendingReviews: 0, checks: names.map(name => ({ name, state: name === mac ? "failed" : "passed" })), paths: [] };
  expect(reviewReadinessFromEvidence(evidence, head, names, receipt.repo)).toBeUndefined();
});

test("the enforce approval gate defers only the draft check and known pending review request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-draft-review-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  let snapshot = reply(), requests: unknown = [{ requestedReviewer: { __typename: "User" } }], decision: string | null = null;
  const gh: SdlcGh = async args => {
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", isDraft: snapshot.data.repository.pullRequest.isDraft,
      reviewDecision: decision, reviewRequests: requests, statusCheckRollup: snapshot.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes,
      files: [{ path: "src/a.ts", changeType: "MODIFIED" }], changedFiles: 1 }) };
    if (args.includes("graphql") && args.some(arg => arg.includes("statusCheckRollup"))) return { code: 0, stdout: JSON.stringify(snapshot) };
    if (args.includes("graphql")) return { code: 0, stdout: JSON.stringify({ data: { repository: {
      pullRequest: { headRefOid: head, reviewThreads: snapshot.data.repository.pullRequest.reviewThreads },
      issue: { number: 1, labels: { nodes: [], pageInfo: { hasNextPage: false } } },
    } } }) };
    return { code: 0, stdout: JSON.stringify(job()) };
  };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "draft-review", repository: receipt.repo, routing: () => loadRouting(dir), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode: "enforce", required_checks: names }), gh } });
  try {
    const proposed = board.propose("user", { title: "draft review", class: "implement", refs: { repo: receipt.repo, commit: head } });
    board.update(proposed.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    const task = board.update(proposed.id, "codex", "done", { state: "in_review",
      plan: { paths: ["src/a.ts"] }, sdlc: { ...receipt, issue: 1, head, reviewedHead: head, localHead: head, localResult: "passed" } });
    const gate = (tasks as unknown as { lifecycleGate(value: typeof task, transition: "approval", head: string): Promise<unknown> }).lifecycleGate.bind(tasks);
    expect(await gate(task, "approval", head)).toBeDefined();
    decision = "CHANGES_REQUESTED"; snapshot.data.repository.pullRequest.reviewDecision = decision;
    await expect(gate(task, "approval", head)).rejects.toThrow("GitHub review approval missing or changes requested");
    decision = null; snapshot = reply(); requests = undefined;
    await expect(gate(task, "approval", head)).rejects.toThrow("review requests pending or unknown");
    requests = []; snapshot.data.repository.pullRequest.isDraft = false;
    await expect(gate(task, "approval", head)).rejects.toThrow("required check check (macos-latest)");
  } finally { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); }
});
