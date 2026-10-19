import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig(extra: Partial<TasksDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-release-followup-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd, board, bus, project: "train", routing: () => loadRouting(cwd), roles: { claude: ["planner"], codex: ["implementer"] }, notify: () => {}, releaseWindow: async () => ({ at: Date.now(), host: true, quota: true, idle: true, reasons: [] }), ...extra });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks };
}
function approved(board: Board, pr?: number) {
  const task = board.propose(USER, { title: `completed ${pr ?? "unlinked"}`, class: "implement" });
  board.update(task.id, USER, "accepted", { state: "in_progress" });
  return board.update(task.id, USER, "approved", { state: "approved", ...(pr ? { sdlc: { stage: "review", repo: "owner/repo", pr } } : {}) });
}

test("release-only planning revisions preserve enforce acceptance; mixed changes still invalidate it", async () => {
  const edit = "2026-10-18T01:00:00Z";
  const gh: SdlcGh = async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 481, state: "OPEN", createdAt: edit, lastEditedAt: edit, updatedAt: edit } } } }) });
  const { tasks, board } = rig({ sdlc: { config: () => sdlcConfig({ mode: "enforce" }), gh } });
  const release = await tasks.newRelease(USER, { name: "next", goal: "Scope", order: 1 });
  const task = board.propose(USER, { title: "implementation", class: "implement", backlog: true });
  board.update(task.id, USER, "backlog pulled", { state: "proposed", owner: "codex", sdlc: { stage: "build", repo: "owner/repo", issue: 481 } });
  tasks.acceptSpec(USER, task.id, { issue: 481, edit: { lastEditedAt: edit, updatedAt: edit } });
  await tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "reviewed scope", review: { scope: "full", reviewers: 1 }, ci: "full" });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  await tasks.assignRelease("claude", { id: task.id, revision: 1, release: null, reason: "next train" });
  expect((await tasks.acceptReviewed("codex", task.id)).state).toBe("in_progress");
  board.plan(task.id, USER, { priority: 2, release: release.id }, 2, "priority and scope");
  expect(await tasks.planReviewGap(board.get(task.id)!)).toContain("planning revision");
  const missing: Task = { ...board.get(task.id)!, planningRevision: 2, history: board.get(task.id)!.history.filter(entry => entry.planning?.revision !== 1 && entry.planning?.revision !== 3) };
  expect(await tasks.planReviewGap(missing)).toContain("planning revision");
});

test("cut reads only scoped PRs on a board with more than sixteen older PRs", async () => {
  const requested: number[] = [], head = "a".repeat(40);
  const gh: SdlcGh = async args => {
    if (args.includes("graphql")) {
      const pr = Number(args.find(arg => arg.startsWith("number="))?.slice(7)); requested.push(pr);
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { number: pr, state: "MERGED", mergedAt: new Date(Date.now() + 1000).toISOString(), headRefOid: head, commits: { nodes: [{ commit: { oid: head } }], pageInfo: { hasNextPage: false } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
    }
    return { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, run_attempt: 3, head_sha: head, pull_requests: [99] }] }) };
  };
  const { tasks, board } = rig({ sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh } });
  for (let pr = 1; pr <= 17; pr++) approved(board, pr);
  const task = approved(board, 99), release = await tasks.newRelease(USER, { name: "scoped", goal: "Scope", order: 1 });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  const active = await tasks.configureRelease("claude", { id: release.id, revision: 0, state: "active" });
  const cut = await tasks.cutRelease("claude", { id: release.id, revision: active.revision });
  expect(requested).toEqual([99]);
  expect(cut.train?.history.at(-1)?.ciRuns).toBe(3);
});

test("a failed cost report leaves CI unknown and does not prevent the admitted cut", async () => {
  const { tasks, board } = rig(), task = approved(board, 99), release = await tasks.newRelease(USER, { name: "cost-down", goal: "Scope", order: 1 });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  const active = await tasks.configureRelease("claude", { id: release.id, revision: 0, state: "active" });
  tasks.costReport = async () => { throw new Error("cost unavailable"); };
  const cut = await tasks.cutRelease("claude", { id: release.id, revision: active.revision });
  expect(cut.state).toBe("frozen"); expect(cut.train?.history.at(-1)?.ciRuns).toBeUndefined();
});

test("configuration no-ops keep revision and history, and bounded updates preserve cut and ship slots", async () => {
  const { tasks, board } = rig(), task = approved(board), release = await tasks.newRelease(USER, { name: "bounded", goal: "Scope", order: 1 });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  let active = await tasks.configureRelease("claude", { id: release.id, revision: 0, state: "active" });
  expect(await tasks.configureRelease("claude", { id: release.id, revision: active.revision, state: "active" })).toEqual(active);
  active = board.updateRelease(release.id, { train: { history: Array.from({ length: 254 }, () => ({ at: 1, by: "claude", event: "configured" as const })) } }, active.revision);
  expect(await tasks.configureRelease("claude", { id: release.id, revision: active.revision })).toEqual(active);
  const refusal = await tasks.configureRelease("claude", { id: release.id, revision: active.revision, cut: 1234 }).catch(error => error);
  expect(refusal).toBeInstanceOf(PreEffectToolRefusal); expect(board.release(release.id)).toEqual(active);
  const cut = await tasks.cutRelease("claude", { id: release.id, revision: active.revision });
  expect(cut.train?.history).toHaveLength(255);
  expect(tasks.changeRelease(USER, { id: release.id, revision: cut.revision, state: "shipped" }).train?.history).toHaveLength(256);
});

test("legacy exhausted histories refuse cut and ship before effects with typed refusals", async () => {
  const { tasks, board } = rig(), task = approved(board), release = await tasks.newRelease(USER, { name: "legacy-cap", goal: "Scope", order: 1 });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  const active = board.updateRelease(release.id, { state: "active", train: { history: Array.from({ length: 256 }, () => ({ at: 1, by: "claude", event: "configured" as const })) } }, 0);
  expect(await tasks.cutRelease("claude", { id: release.id, revision: active.revision }).catch(error => error)).toBeInstanceOf(PreEffectToolRefusal);
  expect(board.release(release.id)).toEqual(active);
  let error: unknown; try { tasks.changeRelease(USER, { id: release.id, revision: active.revision, state: "shipped" }); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(PreEffectToolRefusal); expect(board.release(release.id)).toEqual(active);
});
