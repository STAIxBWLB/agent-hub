import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { linkedReceipt, openPrFor, sdlcConfig, sdlcStatus, type SdlcGh } from "../src/hub/sdlc.ts";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40), REPO = "STAIxBWLB/agent-hub";
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });

const prs = (rows: unknown[]): SdlcGh => async args => args[0] === "pr" && args[1] === "list" ? { code: 0, stdout: JSON.stringify(rows) } : { code: 1, stdout: "" };

test("openPrFor links only the one open PR whose head is the commit, or with no commit whose branch matches (#694)", async () => {
  const rows = [{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }, { number: 693, headRefOid: OTHER, headRefName: "feat/685" }];
  expect(await openPrFor(REPO, { commit: HEAD }, prs(rows))).toBe(692);
  expect(await openPrFor(REPO, { branch: "feat/685" }, prs(rows))).toBe(693);
  expect(await openPrFor(REPO, { commit: "c".repeat(40) }, prs(rows))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: HEAD }, prs([...rows, { number: 700, headRefOid: HEAD, headRefName: "x" }]))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: "short" }, prs(rows))).toBeUndefined();
  expect(await openPrFor("--repo", { commit: HEAD }, prs(rows))).toBeUndefined();
  expect(await openPrFor(REPO, {}, prs(rows))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: HEAD }, async () => ({ code: 0, stdout: "not json" }))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: HEAD }, async () => ({ code: 1, stdout: "" }))).toBeUndefined();
  // A full page may be truncated: a unique hit in it proves nothing, so nothing is linked.
  const page = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, headRefOid: i === 0 ? HEAD : OTHER, headRefName: `b${i}` }));
  expect(await openPrFor(REPO, { commit: HEAD }, prs(page))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: HEAD }, prs(page.slice(0, 99)))).toBe(1);
  // One malformed row makes the whole inventory unknown.
  expect(await openPrFor(REPO, { commit: HEAD }, prs([...rows, { number: "x", headRefOid: OTHER, headRefName: "y" }]))).toBeUndefined();
  expect(await openPrFor(REPO, { commit: HEAD }, prs([...rows, { number: 9, headRefOid: "short", headRefName: "y" }]))).toBeUndefined();
});

test("a first link keeps what the receipt holds; an existing or foreign identity is never relinked (#694)", () => {
  const config = sdlcConfig({ mode: "advise" });
  const previous = { stage: "build" as const, localHead: HEAD, localResult: "passed" as const };
  expect(linkedReceipt(previous, { repo: REPO, issue: 691 }, config)).toEqual({ ...previous, repo: REPO, issue: 691 });
  expect(linkedReceipt({ ...previous, repo: REPO, issue: 691 }, { repo: REPO, pr: 692 }, config)).toEqual({ ...previous, repo: REPO, issue: 691, pr: 692 });
  expect(linkedReceipt({ stage: "build", repo: REPO, issue: 5 }, { repo: REPO, issue: 691 }, config)).toBeUndefined();
  expect(linkedReceipt({ stage: "build", repo: REPO, pr: 5 }, { repo: REPO, pr: 692 }, config)).toBeUndefined();
  expect(linkedReceipt({ stage: "build", repo: "other/repo" }, { repo: REPO, issue: 691 }, config)).toBeUndefined();
  expect(linkedReceipt(undefined, { repo: "not a repo", issue: 691 }, config)).toBeUndefined();
  expect(linkedReceipt(undefined, { repo: REPO, issue: 691 }, config)).toEqual({ stage: config.stages[0]!, repo: REPO, issue: 691 });
});

function rig(gh: SdlcGh, mode: "advise" | "enforce" = "advise") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-identity-link-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"] };
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", repository: REPO, routing: () => loadRouting(cwd), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode }), gh } };
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks: new Tasks(deps) };
}
const metadata = { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 691, state: "OPEN", createdAt: "2026-10-22T00:00:00Z", lastEditedAt: null } } } }) };

test("plan review links the one issue the task title names; done links the PR whose head is its commit (#694)", async () => {
  let listReads = 0;
  const gh: SdlcGh = async args => {
    if (args[0] === "api") return metadata;
    if (args[0] === "pr" && args[1] === "list") { listReads++; return { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) }; }
    return { code: 1, stdout: "" };
  };
  const { board, tasks } = rig(gh);
  const task = board.propose("claude", { title: "Fix #691: one version policy", class: "implement" });
  expect(task.sdlc?.issue).toBeUndefined();
  const reviewed = await tasks.recordPlanReview("claude", task.id, { revision: task.planningRevision ?? 0, reason: "scoped" });
  expect(reviewed.sdlc).toMatchObject({ repo: REPO, issue: 691 });
  expect(reviewed.history.some(entry => entry.event === "lifecycle linked")).toBe(true);
  board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  const done = await tasks.done("codex", task.id, "PR up", { commit: HEAD, branch: "feat/691" });
  expect(done.sdlc).toMatchObject({ repo: REPO, issue: 691, pr: 692 });
  expect(listReads).toBe(1);
});

test("a PII task is never linked and gets no GitHub read; an explicit receipt is untouched (#694)", async () => {
  let reads = 0;
  const gh: SdlcGh = async () => { reads++; return { code: 1, stdout: "" }; };
  const { board, tasks } = rig(gh);
  const pii = board.propose("claude", { title: "Fix #691: private", class: "implement" });
  board.update(pii.id, "user", "screened", { signals: ["pii"] });
  board.update(pii.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  const done = await tasks.done("codex", pii.id, "done", { commit: HEAD });
  expect(done.sdlc?.issue).toBeUndefined();
  expect(done.sdlc?.pr).toBeUndefined();
  expect(reads).toBe(0);
  const explicit = board.propose("claude", { title: "Fix #691: explicit", class: "implement" });
  board.update(explicit.id, "user", "lifecycle", { sdlc: { stage: "build", repo: REPO, issue: 600, pr: 601 } });
  board.update(explicit.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  const kept = await tasks.done("codex", explicit.id, "done", { commit: HEAD });
  expect(kept.sdlc).toMatchObject({ repo: REPO, issue: 600, pr: 601 });
});

test("groom backfills every open task across calls, 32 per call, past the metadata-read budget (#694)", async () => {
  const gh: SdlcGh = async args => args[0] === "api" ? metadata : { code: 1, stdout: "" };
  const { board, tasks } = rig(gh);
  const ids = Array.from({ length: 40 }, (_, i) => board.propose("claude", { title: `Fix #${700 + i}: backfill`, class: "implement" }).id);
  await tasks.groomingDigest("claude");
  expect(ids.filter(id => board.get(id)!.sdlc?.issue).length).toBe(32);
  await tasks.groomingDigest("claude");
  expect(ids.every(id => board.get(id)!.sdlc?.issue === 700 + ids.indexOf(id))).toBe(true);
});

test("a done the gates refuse writes no link and stays a pre-effect refusal; a task turned private during the read gets no link (#694)", async () => {
  const { PreEffectToolRefusal } = await import("../src/hub/tool-refusal.ts");
  const gh: SdlcGh = async args => args[0] === "pr" && args[1] === "list" ? { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) } : { code: 1, stdout: "" };
  const enforced = rig(gh, "enforce");
  const refused = enforced.board.propose("claude", { title: "Fix #691: refused", class: "implement" });
  enforced.board.update(refused.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  const before = enforced.board.get(refused.id)!.history.length;
  const error = await enforced.tasks.done("codex", refused.id, "PR up", { commit: HEAD }).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(PreEffectToolRefusal);
  const after = enforced.board.get(refused.id)!;
  expect(after.history.length).toBe(before);
  expect(after.sdlc?.issue).toBeUndefined();
  expect(after.sdlc?.pr).toBeUndefined();

  let board!: Board, turn = 0;
  const privateDuringRead: SdlcGh = async args => {
    if (args[0] === "pr" && args[1] === "list") { if (turn) board.update(turn, "user", "screened", { signals: ["pii"] }); return { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) }; }
    return { code: 1, stdout: "" };
  };
  const advised = rig(privateDuringRead); board = advised.board;
  const raced = board.propose("claude", { title: "Fix #691: raced", class: "implement" });
  board.update(raced.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  turn = raced.id;
  const done = await advised.tasks.done("codex", raced.id, "PR up", { commit: HEAD });
  expect(done.sdlc?.pr).toBeUndefined();
  expect(done.sdlc?.issue).toBeUndefined();
});

test("the missing-issue next step says how to supply one; the blocker text stays for gate matching (#694)", () => {
  const status = sdlcStatus(sdlcConfig({ mode: "advise" }), undefined);
  expect(status.blockers).toContain("issue identity missing");
  expect(status.next).toBe("issue identity missing: name one issue (title #N, refs or hub_sdlc_record)");
});

test("a PR read for one head is never linked to a task whose commit changed during the read; the issue still links (#694)", async () => {
  let board!: Board, task = 0;
  const gh: SdlcGh = async args => {
    if (args[0] === "pr" && args[1] === "list") {
      if (task) board.update(task, "codex", "refs moved", { refs: { commit: OTHER } });
      return { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) };
    }
    return { code: 1, stdout: "" };
  };
  const made = rig(gh); board = made.board;
  const drifting = board.propose("claude", { title: "Fix #691: drifting", class: "implement" });
  board.update(drifting.id, "codex", "accepted", { state: "in_progress", owner: "codex", refs: { commit: HEAD } });
  task = drifting.id;
  const done = await made.tasks.done("codex", drifting.id, "PR up");
  expect(done.sdlc?.pr).toBeUndefined();
  expect(done.sdlc).toMatchObject({ repo: REPO, issue: 691 });
});

test("a PR staged for one repository is never linked after the task's repository changed during the read (#694)", async () => {
  let board!: Board, task = 0;
  const gh: SdlcGh = async args => {
    if (args[0] === "pr" && args[1] === "list") {
      if (task) board.update(task, "codex", "repo moved", { refs: { repo: "other/repo", commit: HEAD } });
      return { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) };
    }
    return { code: 1, stdout: "" };
  };
  const made = rig(gh); board = made.board;
  const moving = board.propose("claude", { title: "no issue named here", class: "implement" });
  board.update(moving.id, "codex", "accepted", { state: "in_progress", owner: "codex", refs: { commit: HEAD } });
  task = moving.id;
  const done = await made.tasks.done("codex", moving.id, "PR up");
  expect(done.sdlc?.pr).toBeUndefined();
});

test("an assigned reviewer's done admits the staged link and persists it with the review request (#694)", async () => {
  const gh: SdlcGh = async args => args[0] === "pr" && args[1] === "list" ? { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: HEAD, headRefName: "feat/691" }]) } : { code: 1, stdout: "" };
  const { board, tasks } = rig(gh);
  const reviewed = board.propose("claude", { title: "Fix #691: reviewed", class: "implement" });
  board.update(reviewed.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
  const done = await tasks.done("codex", reviewed.id, "PR up", { commit: HEAD });
  expect(done.state).toBe("in_review");
  expect(done.sdlc).toMatchObject({ repo: REPO, issue: 691, pr: 692 });
});
