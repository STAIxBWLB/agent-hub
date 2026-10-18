import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewBrief, coverageGap, renderReviewBrief, type ReviewBrief } from "../src/hub/review-brief.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// #520: the review brief ahub builds without the ocr CLI.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const policy = { privatePath: (path: string) => path === "private.txt", nameable: () => true };

function fixture(): { dir: string; head: string } {
  const dir = scratch("ahub-review-brief-");
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); expect(r.status).toBe(0); return r.stdout.trim(); };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src")); mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "REVIEW.md"), "# Review\nROOT_RULES\n");
  writeFileSync(join(dir, "docs/src-review.md"), "SRC_RULES\n");
  writeFileSync(join(dir, ".gitattributes"), "gen.js linguist-generated\nsrc/** ahub-review-rules=docs/src-review.md\n");
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "old-name.md"), "moved text that stays the same across the rename\n".repeat(4));
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "work");
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\nexport const b = 3;\n");
  writeFileSync(join(dir, "gen.js"), "generated();\n");
  writeFileSync(join(dir, "bun.lock"), "{}\n");
  writeFileSync(join(dir, "private.txt"), "PRIVATE\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  git("mv", "old-name.md", "new-name.md");
  git("add", "."); git("commit", "-qm", "work");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  return { dir, head };
}

test("the brief lists reviewable files, exclusions with reasons, rules per file, and never names a private path", () => {
  const { dir, head } = fixture();
  const brief = buildReviewBrief(dir, head, policy) as ReviewBrief;
  expect("unavailable" in brief).toBe(false);
  expect(brief.base).toBe("HEAD"); // no origin/HEAD in this fixture
  expect(brief.reviewable.map(f => f.path).sort()).toEqual(["new-name.md", "src/a.ts"]);
  expect(brief.reviewable.find(f => f.path === "new-name.md")).toMatchObject({ status: "R", oldPath: "old-name.md" });
  expect(brief.reviewable.find(f => f.path === "src/a.ts")).toMatchObject({ status: "M", insertions: 2, deletions: 1 });
  expect(brief.excluded).toEqual(expect.arrayContaining([{ path: "gen.js", reason: "generated (linguist-generated)" }, { path: "bun.lock", reason: "lockfile" }, { path: "blob.bin", reason: "binary" }]));
  expect(brief.withheld).toBe(1);
  expect(brief.ruleGroups).toEqual(expect.arrayContaining([{ sources: ["REVIEW.md", "docs/src-review.md"], paths: ["src/a.ts"] }, { sources: ["REVIEW.md"], paths: ["new-name.md"] }]));
  expect(brief.unlisted).toEqual([]);
  const text = renderReviewBrief(brief);
  for (const needle of ["ROOT_RULES", "SRC_RULES", "src/a.ts", "old-name.md -> new-name.md", "gen.js: generated", "1 withheld by the privacy policy", "coverage {reviewed"]) expect(text).toContain(needle);
  expect(text).not.toContain("private.txt");
  expect(buildReviewBrief(dir, "not-a-commit", policy)).toEqual({ unavailable: "the task names no commit" });
  expect(buildReviewBrief(dir, "a".repeat(40), policy)).toMatchObject({ unavailable: expect.stringContaining("not in this checkout") });
});

test("coverage accounts for a reviewable path only when it is reviewed, or skipped with a reason", () => {
  const brief = { reviewable: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }, { path: "c.ts", status: "M" }] } as ReviewBrief;
  expect(coverageGap(brief, undefined)).toEqual(["a.ts", "b.ts", "c.ts"]);
  expect(coverageGap(brief, { reviewed: ["a.ts"], skipped: [{ path: "b.ts", reason: "generated elsewhere" }, { path: "c.ts", reason: " " }] })).toEqual(["c.ts"]);
  expect(coverageGap(brief, { reviewed: ["a.ts", "b.ts", "c.ts"] })).toEqual([]);
  expect(coverageGap(brief, "everything")).toEqual(["a.ts", "b.ts", "c.ts"]);
});

class Idle extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }

test("enforce refuses an approval with unaccounted brief paths before any write; advise records the gap; off skips it", async () => {
  const { dir, head } = fixture();
  for (const mode of ["enforce", "advise", "off"] as const) {
    const board = new Board(join(scratch("ahub-brief-board-"), "hub.db")); cleanup.push(() => board.close());
    const bus = new Bus({ batchMs: 0 });
    for (const id of ["codex", "claude"]) { const p = new Idle(id, 60_000); bus.add(p); await p.start(); }
    const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode }) },
      reviewBrief: task => buildReviewBrief(dir, task.refs.commit, policy) });
    const t = board.propose("codex", { title: "fixture", class: "implement", refs: { commit: head } });
    board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
    board.update(t.id, "codex", "done", { state: "in_review", reviewer: "claude" }, "done");
    const before = board.get(t.id)!.history.length;
    const verdict = tasks.review("claude", t.id, "approved", "looks fine", undefined, undefined, { reviewed: ["src/a.ts"] });
    if (mode === "enforce") {
      await expect(verdict).rejects.toThrow("coverage: 1 reviewable path(s) of the review brief are not accounted for: new-name.md");
      expect(board.get(t.id)!.history.length).toBe(before);
      // Accounting for the rest clears the coverage gate (other lifecycle gates may still apply).
      const full = await tasks.review("claude", t.id, "approved", "ok", undefined, undefined, { reviewed: ["src/a.ts"], skipped: [{ path: "new-name.md", reason: "pure rename" }] }).catch((e: Error) => e);
      if (full instanceof Error) expect(full.message).not.toContain("coverage:");
    } else {
      const done = await verdict;
      const note = done.history.findLast(h => h.event === "approved")!.note ?? "";
      if (mode === "advise") expect(note).toContain("Coverage gap (1): new-name.md");
      else expect(note).not.toContain("Coverage gap");
    }
  }
});

test("the review request carries the rendered brief for a task with a commit", async () => {
  const { dir, head } = fixture();
  const board = new Board(join(scratch("ahub-brief-send-"), "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  const got: string[] = [];
  class Seen extends BasePeer { async deliver(envs: { body: string }[]) { got.push(...envs.map(e => e.body)); } async start() { this.setState("idle"); } async stop() {} }
  for (const id of ["codex", "claude"]) { const p = id === "claude" ? new Seen(id, 60_000) : new Idle(id, 60_000); bus.add(p); await p.start(); }
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {}, reviewBrief: task => buildReviewBrief(dir, task.refs.commit, policy) });
  const t = board.propose("codex", { title: "fixture", class: "implement", refs: { commit: head } });
  board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
  expect(tasks.briefText(board.get(t.id)!)).toContain("Review brief: head");
  await tasks.done("codex", t.id, "done", { commit: head });
  for (let i = 0; i < 100 && !got.some(b => b.includes("Review brief")); i++) await Bun.sleep(10);
  const review = got.find(b => b.startsWith("Review task"))!;
  expect(review).toContain("Review brief: head");
  expect(review).toContain("ROOT_RULES");
  expect(review).not.toContain("private.txt");
});
