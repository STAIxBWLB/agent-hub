import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";

// #1435: a task with an SDLC receipt and changes_requested history at head A, escalated and accepted by the planner (in_progress, reviewer cleared),
// whose PR head then moved to B. The re-file with refs.commit B, the head the refusal names, must be accepted.
const A = "a".repeat(40), B = "b".repeat(40);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function rig(mode: "off" | "advise") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-escalated-refile-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const state = { prHead: B, prState: "OPEN" };
  const gh: SdlcGh = async args => {
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: state.prHead, state: state.prState, statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: state.prHead, state: state.prState, commits: { nodes: [] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
  const tasks = new Tasks({ cwd, board, bus, roles: { codex: ["implementer"], claude: ["reviewer", "planner"] }, project: "fixture", routing: () => loadRouting(cwd), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode }), gh } });
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  // The shape of the report: review at head A, three changes_requested, escalated to the planner who accepted (in_progress, no reviewer), PR head now B.
  const create = () => {
    const task = board.propose("user", { title: "escalated work", class: "implement" });
    board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    board.update(task.id, "codex", "done", { state: "in_review", refs: { commit: A }, sdlc: { stage: "review", repo: "fixture/project", pr: 7, head: A } });
    board.update(task.id, "claude", "changes_requested", { state: "changes_requested" }, "fix it", { reviewedHead: A });
    board.update(task.id, "hub", "escalated", { owner: "claude", reviewer: null, state: "in_progress" }, "rejections");
    return board.get(task.id)!;
  };
  return { board, tasks, state, create };
}

for (const mode of ["off", "advise"] as const) {
  test(`#1435 (${mode}) an escalated owner re-files with the PR head the refusal names and it is accepted`, async () => {
    const r = rig(mode), task = r.create();
    expect(task.reviewer).toBeFalsy();
    expect(task.refs.commit).toBe(A);
    const done = await r.tasks.done("claude", task.id, "pushed one more commit", { commit: B, repo: "fixture/project" });
    expect(["in_review", "approved"]).toContain(done.state);
    expect(r.board.get(task.id)!.refs.commit).toBe(B);
  });
}

test("#1435 a submitted commit that is not the PR head is still refused, naming the PR head", async () => {
  const r = rig("advise"), task = r.create();
  await expect(r.tasks.done("claude", task.id, "wrong head", { commit: "c".repeat(40), repo: "fixture/project" })).rejects.toThrow(new RegExp(`current head of PR ${B}`));
  expect(r.board.get(task.id)!.state).toBe("in_progress");
});

test("#1435 the PR already merged after the owner's last push: the re-file at the PR head is accepted and records that head, never the head-move loop", async () => {
  const r = rig("advise"), task = r.create();
  r.state.prState = "MERGED";
  const done = await r.tasks.done("claude", task.id, "pushed one more commit, PR squash-merged", { commit: B, repo: "fixture/project" });
  expect(done.state).toBe("approved");
  expect(r.board.get(task.id)!.refs.commit).toBe(B);
});
