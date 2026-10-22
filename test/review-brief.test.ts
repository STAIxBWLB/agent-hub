import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewBrief, coverageGap, renderReviewBrief, withCodeSymbols, type ReviewBrief } from "../src/hub/review-brief.ts";
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

function fixture(opts: { origin?: boolean } = {}): { dir: string; head: string; git: (...args: string[]) => string } {
  const dir = scratch("ahub-review-brief-");
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); expect(r.status).toBe(0); return r.stdout.trim(); };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src")); mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "REVIEW.md"), "# Review\nROOT_RULES\n");
  writeFileSync(join(dir, "docs/src-review.md"), "SRC_RULES\n");
  writeFileSync(join(dir, ".gitattributes"), "gen.js linguist-generated\n*.gen.js linguist-generated\nsrc/** ahub-review-rules=docs/src-review.md\nlib/** ahub-review-rules=docs/lib-review.md\nnew-name.md ahub-review-rules=docs/missing.md\n");
  writeFileSync(join(dir, "docs/lib-review.md"), "LIB_RULES PII_RULE_TEXT\n");
  writeFileSync(join(dir, "old.gen.js"), "generated(1);\n".repeat(8));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/keep.ts"), "export const keep = 'reviewed source that moves under a generated name';\n".repeat(4));
  writeFileSync(join(dir, "old-name.md"), "moved text that stays the same across the rename\n".repeat(4));
  git("add", "."); git("commit", "-qm", "base");
  if (opts.origin !== false) git("update-ref", "refs/remotes/origin/main", "main");
  git("checkout", "-qb", "work");
  // The head tries to lift its own obligations: everything generated, and weaker rules. Both are read from the base.
  writeFileSync(join(dir, ".gitattributes"), "* linguist-generated\n* -diff\n");
  writeFileSync(join(dir, "REVIEW.md"), "# Review\nHEAD_RULES\n");
  mkdirSync(join(dir, "lib")); writeFileSync(join(dir, "lib/x.ts"), "export const x = 1;\n");
  git("mv", "old.gen.js", "new.gen.js");
  git("mv", "src/keep.ts", "keep.gen.js"); // a reviewed, scoped file moved to a generated, unscoped name
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\nexport const b = 3;\n");
  writeFileSync(join(dir, "gen.js"), "generated();\n");
  writeFileSync(join(dir, "bun.lock"), "{}\n");
  writeFileSync(join(dir, "private.txt"), "PRIVATE\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  git("mv", "old-name.md", "new-name.md");
  git("add", "."); git("commit", "-qm", "work");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  return { dir, head, git };
}

test("the brief lists reviewable files, exclusions with reasons, rules per file, and never names a private path", () => {
  const { dir, head, git } = fixture();
  // Built from a checkout at the reviewed head itself, whose `* -diff` would make every file binary to plain git diff.
  git("checkout", "-q", head);
  const brief = buildReviewBrief(dir, head, policy) as ReviewBrief;
  git("checkout", "-q", "main");
  expect("unavailable" in brief).toBe(false);
  expect(brief.base).toBe("origin/main");
  expect(brief.head).toBe(head);
  // The head's own `* linguist-generated` and REVIEW.md edits do not apply: the base's attributes and rules do.
  expect(brief.reviewable.map(f => f.path).sort()).toEqual([".gitattributes", "REVIEW.md", "keep.gen.js", "lib/x.ts", "new-name.md", "src/a.ts"]);
  // The move keeps its source's obligations: still reviewable, under the source's scoped rules.
  expect(brief.reviewable.find(f => f.path === "keep.gen.js")).toMatchObject({ status: "R", oldPath: "src/keep.ts" });
  expect(brief.ruleGroups.find(g => g.paths.includes("keep.gen.js"))!.sources).toEqual(["REVIEW.md", "docs/src-review.md"]);
  expect(brief.reviewable.find(f => f.path === "new-name.md")).toMatchObject({ status: "R", oldPath: "old-name.md" });
  expect(brief.reviewable.find(f => f.path === "src/a.ts")).toMatchObject({ status: "M", insertions: 2, deletions: 1 });
  expect(brief.excluded).toEqual(expect.arrayContaining([{ path: "gen.js", status: "A", reason: "generated (linguist-generated)" }, { path: "bun.lock", status: "A", reason: "lockfile" }, { path: "blob.bin", status: "A", reason: "binary" },
    { path: "new.gen.js", status: "R", oldPath: "old.gen.js", reason: "generated (linguist-generated)" }]));
  expect(brief.withheld).toBe(1);
  expect(brief.ruleGroups).toEqual(expect.arrayContaining([{ sources: ["REVIEW.md", "docs/src-review.md"], paths: expect.arrayContaining(["src/a.ts"]) }, { sources: ["REVIEW.md", "docs/lib-review.md"], paths: ["lib/x.ts"] }, { sources: ["REVIEW.md"], paths: expect.arrayContaining(["new-name.md"]) }]));
  expect(brief.unlisted).toEqual([]);
  const text = renderReviewBrief(brief);
  for (const needle of ["ROOT_RULES", "SRC_RULES", "LIB_RULES", "src/a.ts", "old-name.md -> new-name.md", "old.gen.js -> new.gen.js (R): generated", "1 withheld by the privacy policy", "coverage {reviewed"]) expect(text).toContain(needle);
  expect(text).not.toContain("private.txt");
  expect(text).not.toContain("HEAD_RULES");
  expect(brief.rulesMissing).toEqual([{ source: "docs/missing.md", reason: "not found at the merge base" }]);
  expect(text).toContain("Configured rules not loaded (read them in the repository):\n- docs/missing.md: not found at the merge base");
  // A rule file matching a private-data pattern is screened whole, before any cut, and named only.
  const screened = renderReviewBrief(buildReviewBrief(dir, head, { ...policy, nameable: (t: string) => !t.includes("PII_RULE") }) as ReviewBrief);
  expect(screened).not.toContain("PII_RULE_TEXT");
  expect(screened).toContain("--- docs/lib-review.md ---\n(withheld: it matches a private-data pattern");
  expect(buildReviewBrief(dir, "not-a-commit", policy)).toEqual({ unavailable: "the task names no commit" });
  expect(buildReviewBrief(dir, "a".repeat(40), policy)).toMatchObject({ unavailable: expect.stringContaining("not in this checkout") });
  // No complete inventory, no brief: an unknown default branch, or a head without changes against it.
  const bare = fixture({ origin: false });
  expect(buildReviewBrief(bare.dir, bare.head, policy)).toMatchObject({ unavailable: expect.stringContaining("no default branch") });
  expect(buildReviewBrief(dir, git("rev-parse", "main"), policy)).toMatchObject({ unavailable: expect.stringContaining("has no changes") });
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
    const rest = [".gitattributes", "REVIEW.md", "lib/x.ts", "keep.gen.js"];
    const verdict = tasks.review("claude", t.id, "approved", "looks fine", undefined, undefined, { reviewed: ["src/a.ts", ...rest] });
    if (mode === "enforce") {
      await expect(verdict).rejects.toThrow("coverage: 1 reviewable path(s) of the review brief are not accounted for: new-name.md");
      expect(board.get(t.id)!.history.length).toBe(before);
      const all = { reviewed: ["src/a.ts", ...rest], skipped: [{ path: "new-name.md", reason: "pure rename" }] };
      // The verdict's head must be the brief's.
      await expect(tasks.review("claude", t.id, "approved", "ok", undefined, "b".repeat(40), all)).rejects.toThrow(`but the review brief is for ${head}`);
      // Accounting for the rest clears the coverage gate (other lifecycle gates may still apply).
      const full = await tasks.review("claude", t.id, "approved", "ok", undefined, undefined, all).catch((e: Error) => e);
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

test("enforce refuses an approval when the brief is unavailable, or when the task's commit moves during the verdict", async () => {
  const { dir, head } = fixture();
  const setup = (reviewBrief: ConstructorParameters<typeof Tasks>[0]["reviewBrief"], extra: Partial<ConstructorParameters<typeof Tasks>[0]> = {}) => {
    const board = new Board(join(scratch("ahub-brief-gate-"), "hub.db")); cleanup.push(() => board.close());
    const bus = new Bus({ batchMs: 0 });
    for (const id of ["codex", "claude"]) { const p = new Idle(id, 60_000); bus.add(p); void p.start(); }
    const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode: "enforce" }) }, reviewBrief, ...extra });
    const t = board.propose("codex", { title: "fixture", class: "implement", refs: { commit: head } });
    board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
    board.update(t.id, "codex", "done", { state: "in_review", reviewer: "claude" }, "done");
    return { board, tasks, t };
  };
  const unknown = setup(() => ({ unavailable: "the changes could not be read" }));
  await expect(unknown.tasks.review("claude", unknown.t.id, "approved", "ok", undefined, undefined, { reviewed: [] })).rejects.toThrow("the review brief is unavailable");
  const all = { reviewed: ["src/a.ts", ".gitattributes", "REVIEW.md", "lib/x.ts", "new-name.md", "keep.gen.js"] };
  let moved: ReturnType<typeof setup>;
  moved = setup(task => { const brief = buildReviewBrief(dir, task.refs.commit, policy); moved.board.update(task.id, "codex", "relinked", { refs: { commit: "c".repeat(40) } }); return brief; });
  const before = moved.board.get(moved.t.id)!.history.length;
  await expect(moved.tasks.review("claude", moved.t.id, "approved", "ok", undefined, undefined, all)).rejects.toThrow("commit or lifecycle receipt changed during the verdict");
  expect(moved.board.get(moved.t.id)!.history.length).toBe(before + 1); // only the relink fixture's own write
  // A head inherited from an earlier review must be the brief's too.
  const inherited = setup(task => buildReviewBrief(dir, task.refs.commit, policy));
  inherited.board.update(inherited.t.id, "claude", "relinked", { sdlc: { stage: "review", reviewedHead: "d".repeat(40) } } as never);
  await expect(inherited.tasks.review("claude", inherited.t.id, "approved", "ok", undefined, undefined, all)).rejects.toThrow(`inherits head ${"d".repeat(40)}`);
  // Code work without an inventory is unknown, not empty: a branch with no commit, or a hub without a brief provider.
  const branchOnly = setup(task => buildReviewBrief(dir, task.refs.commit, policy));
  branchOnly.board.update(branchOnly.t.id, "codex", "relinked", { refs: { commit: undefined, branch: "work" } } as never);
  await expect(branchOnly.tasks.review("claude", branchOnly.t.id, "approved", "ok", undefined, undefined, all)).rejects.toThrow("names no commit");
  // A provider that builds nothing is an unknown inventory too.
  const empty = setup(() => undefined);
  await expect(empty.tasks.review("claude", empty.t.id, "approved", "ok", undefined, undefined, all)).rejects.toThrow("could not be built");
  // A PR task without refs.commit is reviewed at the head its receipt names.
  const viaReceipt = setup(task => buildReviewBrief(dir, task.refs.commit, policy));
  viaReceipt.board.update(viaReceipt.t.id, "codex", "relinked", { refs: { commit: undefined }, sdlc: { stage: "review", pr: 2, localHead: head } } as never);
  await expect(viaReceipt.tasks.review("claude", viaReceipt.t.id, "approved", "ok", undefined, undefined, { reviewed: [] })).rejects.toThrow("not accounted for");
  // Work with no commit, branch or PR is exempt: nothing to account for, so no coverage refusal.
  const plain = setup(task => buildReviewBrief(dir, task.refs.commit, policy));
  plain.board.update(plain.t.id, "codex", "relinked", { refs: { commit: undefined } } as never);
  const result = await plain.tasks.review("claude", plain.t.id, "approved", "ok").catch((e: Error) => e);
  if (result instanceof Error) expect(result.message).not.toContain("coverage:");
});

test("an inherited head that moves during the verdict's awaits writes nothing", async () => {
  const { dir, head } = fixture();
  const board = new Board(join(scratch("ahub-brief-await-"), "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["codex", "claude"]) { const p = new Idle(id, 60_000); bus.add(p); await p.start(); }
  const base = loadRouting(dir);
  // The PII screen is the await: it runs after the coverage check and moves the stored receipt meanwhile.
  let id = 0;
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", notify: () => {}, sdlc: { config: () => sdlcConfig({ mode: "enforce" }) },
    routing: () => ({ ...base, signals: { ...base.signals, pii_screen: "local" }, constraints: { ...base.constraints, pii: "local_only" } }) as typeof base,
    reviewBrief: task => buildReviewBrief(dir, task.refs.commit, policy),
    piiScreen: async () => { board.update(id, "codex", "relinked", { sdlc: { stage: "review", reviewedHead: "e".repeat(40), localHead: "e".repeat(40) } } as never); return { label: "clear", ms: 0 } as never; } });
  const t = board.propose("codex", { title: "fixture", class: "implement", refs: { commit: head } }); id = t.id;
  board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  board.update(t.id, "codex", "done", { state: "in_review", reviewer: "claude", sdlc: { stage: "review", reviewedHead: head } } as never, "done");
  const all = { reviewed: ["src/a.ts", ".gitattributes", "REVIEW.md", "lib/x.ts", "new-name.md", "keep.gen.js"] };
  const before = board.get(t.id)!.history.length;
  await expect(tasks.review("claude", t.id, "approved", "covered", undefined, undefined, all)).rejects.toThrow("commit or lifecycle receipt changed during the verdict");
  expect(board.get(t.id)!.history.length).toBe(before + 1); // the screen's own receipt write only, no verdict
  expect(board.get(t.id)!.state).toBe("in_review");
});

test("optional symbol preparation failure never costs the review request", async () => {
  const {dir,head}=fixture(),board=new Board(join(scratch("ahub-symbol-send-"),"hub.db"));cleanup.push(()=>board.close());
  const bus=new Bus({batchMs:0}),got:string[]=[];
  class Seen extends BasePeer {async deliver(envs:{body:string}[]){got.push(...envs.map(e=>e.body));}async start(){this.setState("idle");}async stop(){}}
  for(const id of ["codex","claude"]){const peer=id==="claude"?new Seen(id,60000):new Idle(id,60000);bus.add(peer);await peer.start();}
  let calls=0;
  const tasks=new Tasks({board,bus,cwd:dir,project:"fixture",routing:()=>loadRouting(dir),notify:()=>{},prepareReviewBrief:async()=>{calls++;throw Error("optional failed");},
    reviewBrief:task=>{const brief=buildReviewBrief(dir,task.refs.commit,policy);return "unavailable" in brief?brief:withCodeSymbols(brief,{state:"unknown"},task.plan?.symbols,()=>true);}});
  const t=board.propose("codex",{title:"fixture",class:"implement",refs:{commit:head}});board.update(t.id,"codex","accepted",{state:"in_progress",owner:"codex",reviewer:"claude"});
  await tasks.done("codex",t.id,"done",{commit:head});
  for(let i=0;i<100&&!got.some(b=>b.startsWith("Review task"));i++)await Bun.sleep(10);
  expect(calls).toBeGreaterThan(0);expect(got.find(b=>b.startsWith("Review task"))).toContain("Changed symbols: unknown");expect(board.get(t.id)!.state).toBe("in_review");
});

test("PII tasks never prepare or render symbol queries",async()=>{
  const {dir,head}=fixture(),board=new Board(join(scratch("ahub-symbol-private-"),"hub.db"));cleanup.push(()=>board.close());
  const bus=new Bus({batchMs:0});let calls=0;
  const tasks=new Tasks({board,bus,cwd:dir,project:"fixture",routing:()=>loadRouting(dir),notify:()=>{},prepareReviewBrief:async()=>{calls++;},reviewBrief:()=>{calls++;throw Error();}});
  const t=board.propose("local",{title:"private fixture",class:"implement",signals:["pii_path"],refs:{commit:head}});board.update(t.id,"local","accepted",{state:"in_progress",owner:"local",reviewer:"user"});
  await tasks.done("local",t.id,"private done",{commit:head});expect(calls).toBe(0);expect(tasks.briefText(board.get(t.id)!)).toBe("");expect(board.get(t.id)!.state).toBe("in_review");
});

test("a task changed while optional symbols load is refused before the done write",async()=>{
  const {dir,head}=fixture(),board=new Board(join(scratch("ahub-symbol-drift-"),"hub.db"));cleanup.push(()=>board.close());
  const bus=new Bus({batchMs:0});let id=0;
  const tasks=new Tasks({board,bus,cwd:dir,project:"fixture",routing:()=>loadRouting(dir),notify:()=>{},prepareReviewBrief:async()=>{board.update(id,"codex","relinked",{refs:{commit:"f".repeat(40)}});}});
  const t=board.propose("codex",{title:"fixture",class:"implement",refs:{commit:head}});id=t.id;board.update(t.id,"codex","accepted",{state:"in_progress",owner:"codex",reviewer:"claude"});
  await expect(tasks.done("codex",t.id,"done",{commit:head})).rejects.toThrow("changed during review admission");expect(board.get(t.id)!.state).toBe("in_progress");expect(board.get(t.id)!.history.some(h=>h.event==="done")).toBe(false);
});
