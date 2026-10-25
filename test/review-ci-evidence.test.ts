import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { readReviewReadiness, reviewReadinessFromEvidence, sdlcConfig, type PrEvidence, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub#824 (task #492): the review request carries the hub's own exact-head CI evidence, so a fresh reviewer who cannot run tests or read gh judges the change, not missing evidence.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const head = "a".repeat(40), NAMES = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];

class Reviewer extends BasePeer { received: Envelope[] = []; async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(envs: Envelope[]) { this.received.push(...envs); } }
/** The readiness query's reply: every required check at `state`, and a bot thread that a person has (or has not) answered. */
const reply = (state: string, answered = true) => ({ data: { repository: { pullRequest: {
  headRefOid: head, state: "OPEN", commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) },
    statusCheckRollup: { contexts: { nodes: NAMES.map(name => ({ name, status: "COMPLETED", conclusion: state })), pageInfo: { hasNextPage: false } } } } }] },
  reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { __typename: "Bot" }, createdAt: "2026-10-18T01:00:00Z" }, ...(answered ? [{ author: { __typename: "User" }, createdAt: "2026-10-18T02:00:00Z" }] : [])], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } },
} } } });

function rig(mode: "off" | "advise" | "enforce", opts: { ready?: boolean; pii?: boolean; reviewOnly?: boolean; checkPassed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-ci-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const calls: string[][] = [];
  const gh: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    const issueArg = args.find(arg => arg.startsWith("issue=")), body = reply(opts.ready === false ? "PENDING" : "SUCCESS"), data = body.data;
    return { code: 0, stdout: JSON.stringify(issueArg ? { ...body, data: { ...data, repository: { ...data.repository, issue: { number: Number(issueArg.split("=")[1]), labels: { nodes: [], pageInfo: { hasNextPage: false } } } } } } : body) };
  };
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], director: ["conductor"] };
  const tasks = new Tasks({ cwd: dir, board, bus, roles, project: "review-ci", routing: () => loadRouting(dir), reviewOnly: peer => opts.reviewOnly === true && peer === "claude", notify: text => notices.push(text), sdlc: { config: () => sdlcConfig({ mode, required_checks: NAMES }), gh } });
  const task = board.propose("user", { title: opts.pii ? "PRIVATE-TITLE-MARKER" : "finished implementation", class: "implement", ...(opts.pii ? { signals: ["pii"] } : {}) });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress", refs: { commit: head }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  if (opts.checkPassed) board.update(task.id, "hub", "check passed", {}, "scripts/check.sh -> exit 0\ncheck: OK");
  const peer = new Reviewer("claude"); bus.add(peer);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const envelope = async (summary = "BUILDER-NARRATIVE-CANARY: everything is fine") => {
    await peer.start();
    await tasks.done("codex", task.id, summary);
    return peer.received.filter(env => env.kind === "review").at(-1);
  };
  const body = async (summary?: string) => (await envelope(summary))?.body ?? "";
  return { tasks, board, bus, task, notices, calls, body, envelope, peer };
}

test("AC1: a ready admission puts the head, the required check names and the thread state in the review request", async () => {
  const r = rig("enforce");
  const body = await r.body();
  expect(body).toContain(`Hub-verified at ${head}: required checks ${NAMES.join(", ")} passed at this exact head; no bot review thread is waiting for a reply.`);
  expect((body.match(/Hub-verified at/g) ?? []).length).toBe(1);                                    // one block, never repeated
  // It sits before the checklist, and a reviewer reading the checklist is pointed back to it.
  expect(body.indexOf("Hub-verified at")).toBeLessThan(body.indexOf("Checklist:"));
});

test("AC1: an identical-tree run the hub reused is named in the block", async () => {
  const readiness = { head, ready: true, blockers: [], checks: NAMES, reusedRun: 7 };
  const r = rig("advise");
  const hub = r.tasks as unknown as { hubVerifiedBlock(task: unknown, admission: unknown): string };
  expect(hub.hubVerifiedBlock(r.board.get(r.task.id)!, readiness)).toContain("passed at this exact head via identical-tree run 7;");
  // Both producers fill `checks`: the live read and the evidence already in hand.
  const evidence: PrEvidence = { head, state: "OPEN", checks: NAMES.map(name => ({ name, state: "passed" as const })), review: "unknown", unresolved: 0, pendingReviews: 0, paths: [] };
  expect(reviewReadinessFromEvidence(evidence, head, NAMES)).toMatchObject({ ready: true, checks: NAMES });
  expect(await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(reply("SUCCESS")) }), NAMES)).toMatchObject({ ready: true, checks: NAMES });
  // An unknown read carries no check names, and the block then says only what is true.
  expect((await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async () => ({ code: 1, stdout: "" }), NAMES)).checks).toBeUndefined();
  expect(hub.hubVerifiedBlock(r.board.get(r.task.id)!, { head, ready: true, blockers: [] })).toContain("required checks the required checks passed");
});

test("AC2: a not-ready admission in advise mode shows its blockers in the same block, and the request still goes out", async () => {
  const r = rig("advise", { ready: false });
  const body = await r.body();
  expect(body).toContain(`Hub-verified at ${head}: not ready: exact-head full CI is not green.`);
  expect(body).not.toContain("passed at this exact head");
  expect(body).toContain("Review task #");
  // Enforce never sends a premature request at all (unchanged).
  const enforce = rig("enforce", { ready: false });
  await expect(enforce.body()).rejects.toThrow("premature review");
});

test("AC3: ready with no check-passed event: the checklist drops 'run the affected tests yourself' and says test execution and CI evidence are not unmet items", async () => {
  const body = await rig("enforce").body();
  expect(body).not.toContain("run the affected tests yourself");
  expect(body).not.toContain("No check ran for this class");
  expect(body).toContain("CI passed at this exact head (see the Hub-verified line above); do not list test execution or CI evidence as unmet: name the specific missing test or behaviour instead.");
  // Everything else about the checklist is as before.
  expect(body).toContain("Map the changed signatures and call sites to");
  expect(body).toContain("List what is unmet in hub_review's unmet, one item each.");
});

test("AC3: wording is unchanged otherwise: a hub-run check keeps its own line, and a not-ready or absent admission keeps the old sentence", async () => {
  const withCheck = await rig("enforce", { checkPassed: true }).body();
  expect(withCheck).toContain("Check result: scripts/check.sh -> exit 0");
  expect(withCheck).not.toContain("do not list test execution or CI evidence as unmet");
  const notReady = await rig("advise", { ready: false }).body();
  expect(notReady).toContain("No check ran for this class: run the affected tests yourself.");
  const off = await rig("off").body();                                                               // sdlc off: no admission
  expect(off).toContain("No check ran for this class: run the affected tests yourself."); expect(off).not.toContain("Hub-verified");
});

test("AC4: a review-only reviewer still gets no builder summary, and still gets the Hub-verified block", async () => {
  const body = await rig("enforce", { reviewOnly: true }).body();
  expect(body).toContain("(summary withheld from a review-only reviewer; judge the change itself)");
  expect(body).not.toContain("BUILDER-NARRATIVE-CANARY");
  expect(body).toContain("Hub-verified at");
  // An ordinary reviewer sees the summary as before, and the block too.
  const ordinary = await rig("enforce").body();
  expect(ordinary).toContain("BUILDER-NARRATIVE-CANARY"); expect(ordinary).toContain("Hub-verified at");
});

test("AC4: a PII task's request has no Hub-verified block and no new wording, its envelope stays private, and its title never reaches a notice", async () => {
  const r = rig("advise", { pii: true });
  r.board.update(r.task.id, "user", "assigned", { reviewer: "claude" });
  const env = await r.envelope("private result");
  expect(env).toBeDefined();
  const body = env!.body;
  expect(body).not.toContain("Hub-verified"); expect(body).not.toContain("CI passed at this exact head");
  expect(body).toContain("No check ran for this class: run the affected tests yourself.");          // the old sentence, as before
  expect(env!.private).toBe(true);                                                                   // a PII review request is still a private envelope (the existing protection, unchanged)
  expect(r.notices.join("\n")).not.toContain("PRIVATE-TITLE-MARKER");
});

test("AC5: the block makes no gh call of its own: the request reads exactly what the admission already read", async () => {
  const withBlock = rig("enforce");
  await withBlock.body();
  const reads = withBlock.calls.length;
  // Pinned to what the admission path read BEFORE this change (checked on the base source: a PR view and two GraphQL reads). A fourth call, from the block or anywhere, fails here.
  expect(withBlock.calls.map(call => call[0] + ":" + call[1])).toEqual(["pr:view", "api:graphql", "api:graphql"]);
  expect(reads).toBe(3);
  // The same flow with the block's inputs absent (sdlc off, no admission read) makes none, and rendering the block alone makes none.
  const hub = withBlock.tasks as unknown as { hubVerifiedBlock(task: unknown, admission: unknown): string };
  const before = withBlock.calls.length;
  hub.hubVerifiedBlock(withBlock.board.get(withBlock.task.id)!, { head, ready: true, blockers: [], checks: NAMES });
  hub.hubVerifiedBlock(withBlock.board.get(withBlock.task.id)!, { head, ready: false, blockers: ["x"] });
  expect(withBlock.calls.length).toBe(before);
  // Counted against the existing admission path: one request makes the same number of reads whether or not the block renders (the render path is pure).
  const again = rig("enforce");
  await again.body();
  expect(again.calls.length).toBe(reads);
  expect(again.calls.every(call => call[0] === "pr" || call[0] === "api")).toBe(true);              // reads only: no write, no extra endpoint
});
