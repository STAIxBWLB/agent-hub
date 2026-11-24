import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { buildReviewBrief, type ReviewBrief } from "../src/hub/review-brief.ts";
import { gitAuditSource, checkoutAuditSource } from "../src/hub/audit-source.ts";

// #1646 T2: a verdict records what the checkout its reviewer read held, and says which checkout that was. The evidence is read
// by the hub, never by the reviewer, and it is stored on the verdict's history entry, out of the `sdlc` receipt the approval's
// coverage pins.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const policy = { privatePath: () => false, nameable: () => true };
const gitAt = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  expect(r.status).toBe(0);
  return r.stdout.trim();
};

/** A checkout left at `main` while `head` is another commit. */
function fixture(): { dir: string; head: string; base: string; git: (...args: string[]) => string } {
  const dir = scratch("ahub-review-checkout-");
  const git = (...args: string[]) => gitAt(dir, ...args);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-qb", "work");
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "new.ts"), "export const n = 0;\n");
  git("add", "."); git("commit", "-qm", "work");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  return { dir, head, base, git };
}

class Idle extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }

async function rig(dir: string, head: string, extra: Partial<TasksDeps> = {}) {
  const board = new Board(join(scratch("ahub-checkout-board-"), "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  for (const id of ["codex", "claude"]) { const p = new Idle(id, 60_000); bus.add(p); await p.start(); }
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode: "advise" }) },
    reviewBrief: task => buildReviewBrief(dir, task.refs.commit, policy), ...extra });
  const t = board.propose("codex", { title: "fixture", class: "implement", refs: { commit: head } });
  board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  board.update(t.id, "codex", "done", { state: "in_review", reviewer: "claude" }, "done");
  return { board, tasks, t };
}

const verdictEntry = (board: Board, id: number) => board.get(id)!.history.findLast(h => h.event === "approved")!;

test("AC1: a dirty reviewed path is stored on the verdict, naming that path and the checkout it was read from", async () => {
  const { dir, head, base, git } = fixture();
  writeFileSync(join(dir, "a.ts"), "export const a = 3;\n"); // uncommitted, on a path the brief reviews
  expect(git("status", "--porcelain")).toBe("M a.ts");
  const f = await rig(dir, head, { auditSource: gitAuditSource(dir) });
  const approved = await f.tasks.review("claude", f.t.id, "approved", "looks fine", undefined, undefined, { reviewed: ["a.ts"] });
  const entry = verdictEntry(f.board, f.t.id);
  // The checkout stands at `base`, not at the reviewed head: the edited file differs, and the head's new file is absent.
  expect(entry.checkout).toEqual({ source: "project-root", head: base, differing: ["a.ts", "new.ts"], untracked: [] });
  expect(approved.state).toBe("approved");
  // The public view carries the same evidence, so a reader sees what was read without opening the board.
  const view = f.tasks.publicView(f.board.get(f.t.id)!, true) as { history: { event: string; checkout?: unknown }[] };
  expect(view.history.findLast(h => h.event === "approved")!.checkout).toEqual({ source: "project-root", head: base, differing: ["a.ts", "new.ts"], untracked: [] });
});

test("the reviewer's own checkout is the one read, and the record says so", async () => {
  const { dir, head } = fixture();
  // A reviewer here reads in its own worktree of this repository, at the reviewed head, with its own uncommitted edit.
  const review = join(scratch("ahub-review-peer-"), "co");
  gitAt(dir, "worktree", "add", "-q", "--detach", review, head);
  writeFileSync(join(review, "a.ts"), "export const a = 9;\n");
  const f = await rig(dir, head, { auditSource: gitAuditSource(dir), reviewerCheckout: () => checkoutAuditSource(dir, review) });
  await f.tasks.review("claude", f.t.id, "approved", "ok", undefined, undefined, { reviewed: ["a.ts"] });
  // The project checkout stands at `base` and would report a.ts and new.ts; the evidence names the reviewer's checkout instead.
  expect(verdictEntry(f.board, f.t.id).checkout).toEqual({ source: "peer-cwd", head, differing: ["a.ts"], untracked: [] });
});

test("a reviewer checkout the hub knows but cannot read records nothing, never the project checkout", async () => {
  const { dir, head } = fixture();
  writeFileSync(join(dir, "a.ts"), "export const a = 5;\n"); // the project checkout would report this path
  const unread = { head: () => undefined, resolve: () => undefined, changed: () => undefined, readsAt: () => undefined };
  const f = await rig(dir, head, { auditSource: gitAuditSource(dir), reviewerCheckout: () => unread });
  await f.tasks.review("claude", f.t.id, "approved", "ok", undefined, undefined, { reviewed: ["a.ts"] });
  expect("checkout" in verdictEntry(f.board, f.t.id)).toBe(false);
});

test("an untracked reviewed path is recorded too, and a path outside the brief is never named", async () => {
  const { dir, head, base } = fixture();
  // The reviewed head adds a.ts and new.ts; the checkout stands at the base, where `new.ts` is a stray untracked copy.
  writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
  writeFileSync(join(dir, "a.ts"), "export const a = 30;\n");
  writeFileSync(join(dir, "c.ts"), "export const c = 1;\n"); // untracked, but the brief does not review it
  const f = await rig(dir, head, { auditSource: gitAuditSource(dir) });
  await f.tasks.review("claude", f.t.id, "approved", "looks fine", undefined, undefined, { reviewed: ["a.ts", "new.ts"] });
  expect(verdictEntry(f.board, f.t.id).checkout).toEqual({ source: "project-root", head: base, differing: ["a.ts"], untracked: ["new.ts"] });
});

test("an unread checkout records no evidence at all, never an empty one", async () => {
  const { dir, head } = fixture();
  // No port, a port without the read, and a read that cannot answer all leave the verdict with nothing claimed.
  for (const extra of [{}, { auditSource: { head: () => undefined, resolve: () => undefined, changed: () => undefined } },
    { auditSource: { head: () => undefined, resolve: () => undefined, changed: () => undefined, readsAt: () => undefined } }] as Partial<TasksDeps>[]) {
    const f = await rig(dir, head, extra);
    await f.tasks.review("claude", f.t.id, "approved", "ok", undefined, undefined, { reviewed: ["a.ts"] });
    expect(verdictEntry(f.board, f.t.id).checkout).toBeUndefined();
    expect("checkout" in verdictEntry(f.board, f.t.id)).toBe(false);
  }
});

test("the checkout read answers only for the caller's own paths, and never for a commit it cannot resolve", () => {
  const { dir, head, base } = fixture();
  const source = gitAuditSource(dir);
  writeFileSync(join(dir, "a.ts"), "export const a = 4;\n");
  writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
  expect(source.readsAt!(head, ["a.ts", "new.ts", "b.ts"])).toEqual({ differing: ["a.ts"], untracked: ["new.ts"] });
  expect(source.readsAt!(head, [])).toEqual({ differing: [], untracked: [] });
  expect(source.readsAt!("f".repeat(40), ["a.ts"])).toBeUndefined();
  expect(source.readsAt!("not-a-sha", ["a.ts"])).toBeUndefined();
  // A clean worktree at the reviewed head differs nowhere.
  expect(source.readsAt!(base, ["b.ts"])).toEqual({ differing: [], untracked: [] });
});

test("a brief with no reviewable file still records the checkout it was read from", async () => {
  const { dir, head, base } = fixture();
  const brief = (readable: ReviewBrief): ReviewBrief => ({ ...readable, reviewable: [], unlisted: [], excluded: [], ruleGroups: [] });
  const f = await rig(dir, head, { auditSource: gitAuditSource(dir), reviewBrief: task => brief(buildReviewBrief(dir, task.refs.commit, policy) as ReviewBrief) });
  await f.tasks.review("claude", f.t.id, "approved", "ok", undefined, undefined, { reviewed: [] });
  expect(verdictEntry(f.board, f.t.id).checkout).toEqual({ source: "project-root", head: base, differing: [], untracked: [] });
});

test("the reader answers only for a worktree of this repository, never the project checkout or another repository", () => {
  const { dir, head } = fixture();
  const review = join(scratch("ahub-review-peer-"), "co");
  gitAt(dir, "worktree", "add", "-q", "--detach", review, head);
  expect(checkoutAuditSource(dir, review)!.head()).toBe(head);
  // The project checkout is read as the project's, and a path that is no worktree of it names no checkout at all.
  expect(checkoutAuditSource(dir, dir)).toBeUndefined();
  expect(checkoutAuditSource(dir, join(dir, "absent"))).toBeUndefined();
  const foreign = scratch("ahub-foreign-checkout-");
  gitAt(foreign, "init", "-q", "-b", "main");
  writeFileSync(join(foreign, "a.ts"), "export const a = 1;\n");
  gitAt(foreign, "add", "."); gitAt(foreign, "commit", "-qm", "foreign");
  expect(checkoutAuditSource(dir, foreign)).toBeUndefined();
});

test("a reviewer reads a brief file at the reviewed head, and only the paths the brief lists", async () => {
  const { dir, head } = fixture();
  // The checkout stands at the base, where the reviewed head's text for a.ts does not exist: only the reader can answer.
  const asked: { scope?: "brief"; requests: readonly { path: string; side?: string }[] }[] = [];
  const materials: NonNullable<TasksDeps["reviewMaterials"]> = async (_task, requests, scope) => {
    asked.push({ ...(scope ? { scope } : {}), requests });
    return { head, materials: requests.map(request => ({ state: "available", path: request.path, side: "head", text: "export const a = 2;\n", rawHash: "a".repeat(64), contentHash: "b".repeat(64) })) };
  };
  const f = await rig(dir, head, { reviewMaterials: materials });
  const read = JSON.parse(await f.tasks.reviewFile("claude", { id: f.t.id, path: "a.ts" })) as Record<string, unknown>;
  expect(read).toMatchObject({ task: f.t.id, head, path: "a.ts", text: "export const a = 2;\n" });
  // The read is brief-scoped, one path at a time, and never a caller-enlarged scope.
  expect(asked).toEqual([{ scope: "brief", requests: [{ path: "a.ts", side: "head" }] }]);
  // A path the brief does not review (a declared one or an escaping one) and a peer the task does not belong to refuse before any read.
  await expect(f.tasks.reviewFile("claude", { id: f.t.id, path: "b.ts" })).rejects.toThrow(/not one of the 2 reviewable path/);
  await expect(f.tasks.reviewFile("pi", { id: f.t.id, path: "a.ts" })).rejects.toThrow(/only its owner or reviewer/);
  await expect(f.tasks.reviewFile("claude", { id: f.t.id, path: "../a.ts" })).rejects.toThrow(/not one of the 2 reviewable path/);
  expect(asked).toHaveLength(1);
});
