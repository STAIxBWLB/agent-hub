import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { localGates } from "../src/hub/sdlc-merge.ts";
import { riskMinimum, riskPlanFloor, riskView } from "../src/hub/risk-tier.ts";
import { Tasks } from "../src/hub/tasks.ts";

const HEAD = "a".repeat(40), BASE = "c".repeat(40), BRANCH = "feat/1645-risk-review";
const POLICY = { high: ["src/hub/sdlc-merge.ts"], low: ["docs/**"] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/**
 * #1645 T3: one change filed through `done()` so the tier is the one T2 derives, then the verdict. The gh fake is the
 * shape `test/sdlc-integrity-flow.test.ts` already pins, so the only thing these cases vary is the `[risk]` table.
 */
function rig(options: { mode?: SdlcMode; risk?: object; paths?: string[] } = {}) {
  const mode = options.mode ?? "enforce", paths = options.paths ?? ["src/hub/sdlc-merge.ts"];
  const dir = mkdtempSync(join(tmpdir(), "ahub-risk-review-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const notices: string[] = [], pageInfo = { hasNextPage: false };
  const files = paths.map(path => ({ path, changeType: "MODIFIED" as const }));
  const gh: SdlcGh = async args => {
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    let result: unknown;
    if (args[0] === "pr" && args[1] === "list") result = [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }];
    else if (args[0] === "pr" && args[1] === "view") result = {
      headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: BASE, headRefName: BRANCH,
      reviewDecision: "APPROVED", reviewRequests: [],
      statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], files, changedFiles: files.length,
    };
    else if (query.includes("queue_p")) result = { data: { repository: { pullRequests: { nodes: [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }], pageInfo },
      queue_p1: { headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: BASE, changedFiles: files.length,
        reviewDecision: "APPROVED", reviewRequests: { nodes: [], pageInfo }, reviewThreads: { nodes: [], pageInfo }, statusCheckRollup: { contexts: { nodes: [{ name: "gate", conclusion: "SUCCESS" }], pageInfo } } } } } };
    else if (query.includes("reviewThreads")) result = { data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo } },
      ...(query.includes("issue(number:") ? { issue: { number: 2, state: "OPEN", createdAt: "2026-11-01T00:00:00Z", lastEditedAt: null, labels: { nodes: [{ name: "enhancement" }], pageInfo } } } : {}) } } };
    else if (query.includes("issue(number:")) result = { data: { repository: { issue: { number: 2, state: "OPEN", createdAt: "2026-11-01T00:00:00Z", lastEditedAt: null, labels: { nodes: [{ name: "enhancement" }], pageInfo } } } } };
    else if (query.includes("commits(first:")) result = { data: { repository: { pullRequest: { headRefOid: HEAD, commits: { nodes: [{ commit: { oid: HEAD } }], pageInfo } } } } };
    else if (query.includes("object(expression:")) result = { data: { repository: { object: { oid: HEAD, statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], pageInfo } } } } } };
    else throw new Error(`Unexpected metadata read: ${args.join(" ")}`);
    return { code: 0, stdout: JSON.stringify(result) };
  };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "risk-review", repository: "owner/repo",
    routing: () => loadRouting(dir), notify: message => notices.push(message),
    sdlc: { config: () => sdlcConfig({ mode, required_checks: ["gate"], ...(options.risk ? { risk: options.risk } : {}) }), gh } });
  const task = board.propose(USER, { title: "risk tier change", class: "implement", plan: { paths } });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress", refs: { branch: BRANCH } });
  tasks.recordLifecycle(USER, task.id, { repo: "owner/repo", issue: 2, pr: 1, localHead: HEAD, localResult: "passed", stage: "implement" });
  return { board, tasks, id: task.id, notices };
}

const filed = async (r: ReturnType<typeof rig>) => {
  const task = await r.tasks.done("codex", r.id, "checked", { commit: HEAD });
  expect(task.state).toBe("in_review");
  return task;
};
/** The verifier card #1645 T3 recognises: a `test` card on the same branch at the same head, approved by another peer. */
const verifier = (r: ReturnType<typeof rig>, overrides: { owner?: string; commit?: string; state?: "approved" | "in_review"; branch?: string; repo?: string } = {}) => {
  const card = r.board.propose(USER, { title: "verify the change", class: "test",
    refs: { repo: overrides.repo ?? "owner/repo", branch: overrides.branch ?? BRANCH, commit: overrides.commit ?? HEAD } });
  const owner = overrides.owner ?? "claude";
  let updated = r.board.update(card.id, USER, "accepted", { state: "in_progress", owner });
  if ((overrides.state ?? "approved") === "in_review") return r.board.update(card.id, USER, "done", { state: "in_review" });
  updated = r.board.update(card.id, USER, "done", { state: "in_review" });
  return r.board.update(updated.id, USER, "approved", { state: "approved" });
};

test("AC3 enforce: approving a high task with no verifier card is refused and the refusal names the continuation", async () => {
  const r = rig({ risk: POLICY });
  const task = await filed(r);
  expect(task.sdlc?.risk).toMatchObject({ tier: "high", head: HEAD });
  const review = () => r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD);
  await expect(review()).rejects.toThrow("risk high");
  await expect(review()).rejects.toThrow("a high task needs a verifier card by another peer at this head");
  await expect(review()).rejects.toThrow("hub_task_propose (class test, refs.branch feat/1645-risk-review");
  expect(r.board.get(r.id)?.state).toBe("in_review");
  // T4's display: `hub_task_show` reads the tier and what it still owes, in the same words the verdict uses.
  expect(r.tasks.publicView(r.board.get(r.id)!).risk).toContain("risk high (1 path decided it); minimum one reviewer plus a verifier card");
});

test("AC3 enforce: a verifier card by another peer at the filed head lets the approval through", async () => {
  const r = rig({ risk: POLICY });
  await filed(r);
  verifier(r);
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
});

test("AC3 enforce: a verifier card is not one when it is the implementer's, unapproved, or about another head", async () => {
  for (const overrides of [{ owner: "codex" }, { state: "in_review" as const }, { commit: BASE }, { branch: "feat/other" }]) {
    const r = rig({ risk: POLICY });
    await filed(r);
    verifier(r, overrides);
    await expect(r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("a high task needs a verifier card");
    expect(r.board.get(r.id)?.state).toBe("in_review");
  }
});

test("AC3 advise: the same gap is reported in the verdict's note and the approval stands", async () => {
  const r = rig({ mode: "advise", risk: POLICY });
  await filed(r);
  const approved = await r.tasks.review(USER, r.id, "approved", "looks right", undefined, HEAD);
  expect(approved.state).toBe("approved");
  const note = approved.history.findLast(entry => entry.event === "approved")?.note ?? "";
  expect(note).toContain("risk high");
  expect(note).toContain("verifier card");
  expect(note).toContain("looks right");
});

test("AC3: a low change owes one reviewer and approves without a verifier card", async () => {
  const r = rig({ risk: POLICY, paths: ["docs/a.md"] });
  const task = await filed(r);
  expect(task.sdlc?.risk).toMatchObject({ tier: "low", matched: 1 });
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
});

test("AC4: without a [risk] table the verdict is unchanged, declined or allowed by nothing here", async () => {
  const r = rig({ paths: ["src/hub/sdlc-merge.ts"] });
  const task = await filed(r);
  expect(task.sdlc).not.toHaveProperty("risk");
  const approved = await r.tasks.review(USER, r.id, "approved", "as before", undefined, HEAD);
  expect(approved.state).toBe("approved");
  expect(approved.history.findLast(entry => entry.event === "approved")?.note ?? "").not.toContain("risk ");
  expect(r.tasks.publicView(r.board.get(r.id)!)).not.toHaveProperty("risk");
});

test("AC5: the plan review's own metadata is compared against the floor, and only a [risk] project is checked", () => {
  expect(riskPlanFloor({ scope: "full", reviewers: 0 })).toContain("below the minimum of 1 reviewer");
  expect(riskPlanFloor({ scope: "none" })).toContain("asked for 0 reviewers");
  expect(riskPlanFloor({ scope: "full", reviewers: 2 })).toBeUndefined();
  expect(riskPlanFloor({ scope: "delta" })).toBeUndefined();
  expect(riskPlanFloor({ scope: "full", reviewers: 0 }, riskMinimum("high"))).toContain("plus a verifier card");
});

test("AC5 at the plan review: enforce refuses a review scope below the floor and names hub_plan_review; advise reports it", async () => {
  const enforce = rig({ risk: POLICY, paths: ["docs/a.md"] });
  const review = (r: ReturnType<typeof rig>) => r.tasks.recordPlanReview(USER, r.id, { revision: 0, reason: "plan the work", review: { scope: "none", reviewers: 0 }, ci: "reuse" });
  await expect(review(enforce)).rejects.toThrow("plan review asked for 0 reviewers, below the minimum of 1 reviewer");
  await expect(review(enforce)).rejects.toThrow("hub_plan_review");
  const advise = rig({ mode: "advise", risk: POLICY, paths: ["docs/a.md"] });
  expect((await review(advise)).sdlc?.planReview?.scope).toEqual({ review: { scope: "none", reviewers: 0 }, ci: "reuse" });
  expect(advise.notices.join("\n")).toContain("below the minimum of 1 reviewer");
  // AC4: the same plan review on a project with no `[risk]` table records exactly as before.
  const plain = rig({ paths: ["docs/a.md"] });
  expect((await review(plain)).sdlc?.planReview?.scope).toEqual({ review: { scope: "none", reviewers: 0 }, ci: "reuse" });
});

test("T4 merge gate: enforce names the tier and refuses a plan below it; advise adds no gate", () => {
  const receipt = { stage: "review" as const, reviewedHead: HEAD, risk: { tier: "high" as const, head: HEAD, matched: 3 } };
  const subject = { id: 1, after: [], private: false, receipt, latestHead: HEAD, approval: { head: HEAD, mismatch: false, current: true },
    plan: { revision: 1, fingerprint: "f", accepted: [], planReview: { scope: "none" } } };
  const enforce = localGates({ subject, state: "approved", taskState: () => "approved", config: sdlcConfig({ mode: "enforce", required_checks: [] }), head: HEAD });
  expect(enforce.join(" | ")).toContain("risk high (3 paths decided it): plan review asked for 0 reviewers");
  expect(enforce.join(" | ")).toContain("hub_plan_review");
  const advise = localGates({ subject, state: "approved", taskState: () => "approved", config: sdlcConfig({ mode: "advise", required_checks: [] }), head: HEAD });
  expect(advise.join(" | ")).not.toContain("risk high");
  const met = localGates({ subject: { ...subject, plan: { ...subject.plan, planReview: { scope: "full", reviewers: 2 } } }, state: "approved", taskState: () => "approved", config: sdlcConfig({ mode: "enforce", required_checks: [] }), head: HEAD });
  expect(met.join(" | ")).not.toContain("risk high");
});

test("the verifier identity rule is one function, so a display line and the verdict read the same card", () => {
  const cards = [
    { id: 1, class: "implement", state: "approved", owner: "claude", repo: "owner/repo", branch: BRANCH, commit: HEAD },
    { id: 2, class: "test", state: "approved", owner: "codex", repo: "owner/repo", branch: BRANCH, commit: HEAD },
    { id: 3, class: "test", state: "approved", owner: "claude", repo: "owner/repo", branch: BRANCH, commit: HEAD },
  ];
  // The implementer's own card (2) is not a verifier, the only other `test` card (3) is; a card for another head and a subject without a branch hold none.
  const view = riskView({ tier: "high", head: HEAD, matched: 1 }, cards, { repo: "owner/repo", branch: BRANCH, head: HEAD, implementer: "codex" });
  expect(view).toMatchObject({ tier: "high", minimum: { reviewers: 1, verifier: true }, verifier: { id: 3 } });
  expect(riskView({ tier: "high", head: HEAD, matched: 1 }, cards, { repo: "owner/repo", branch: BRANCH, head: BASE, implementer: "codex" })).toBeUndefined();
  expect(riskView({ tier: "high", head: HEAD, matched: 1 }, cards, { repo: "owner/repo", head: HEAD, implementer: "codex" })?.verifier).toBeUndefined();
  expect(riskView({ tier: "low", head: HEAD, matched: 1 }, cards, { repo: "owner/repo", branch: BRANCH, head: HEAD, implementer: "codex" })?.verifier).toBeUndefined();
});
