import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { qualifiedTitleRepos, siblingTitleRefs } from "../src/hub/spec-read.ts";

// #723: the issue identity is linked when a task is written, from its title and refs only, with no GitHub read.
const REPO = "STAIxBWLB/agent-hub", SIBLING = "STAIxBWLB/agent-mem";
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });

function rig(mode: "off" | "advise" | "enforce" = "advise", gh?: SdlcGh) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-issue-link-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const reads: string[][] = [];
  const spy: SdlcGh = gh ?? (async args => { reads.push(args); return { code: 1, stdout: "" }; });
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"] };
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", repository: REPO, routing: () => loadRouting(cwd), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode }), gh: spy } };
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks: new Tasks(deps), reads };
}

test("a proposed task titled Fix #N links its issue on creation with no GitHub read (advise and enforce)", async () => {
  for (const mode of ["advise", "enforce"] as const) {
    const { tasks, reads } = rig(mode);
    const task = await tasks.propose("claude", { title: "Fix #718: reserved pulls", class: "implement", backlog: true });
    expect(task.sdlc, mode).toMatchObject({ repo: REPO, issue: 718 });
    expect(task.history.some(entry => entry.event === "lifecycle linked"), mode).toBe(true);
    expect(reads, mode).toEqual([]);
  }
});

test("mode off links nothing and a PII task is never linked", async () => {
  expect((await rig("off").tasks.propose("claude", { title: "Fix #718: off", class: "implement", backlog: true })).sdlc?.issue).toBeUndefined();
  const { tasks, board } = rig("advise");
  const pii = board.propose("claude", { title: "Fix #719: private", class: "implement" });
  board.update(pii.id, "user", "screened", { signals: ["pii"] });
  board.update(pii.id, "hub", "assigned", { owner: "codex" });
  const accepted = tasks.accept("codex", pii.id);
  expect(accepted.signals).toContain("pii");
  expect(accepted.sdlc?.issue).toBeUndefined();
  expect(tasks.refsRepoHint(board.get(pii.id)!)).toBeUndefined();
});

test("an accepted task links when its title names one issue, including after refs.repo arrives on accept", async () => {
  const { tasks, board } = rig("advise");
  const task = board.propose("claude", { title: "agent-mem#13 P4: use the library", class: "implement", refs: {} });
  board.update(task.id, "hub", "assigned", { owner: "codex" });
  expect(board.get(task.id)!.sdlc?.issue).toBeUndefined();
  const accepted = tasks.accept("codex", task.id, undefined, { repo: SIBLING });
  expect(accepted.sdlc).toMatchObject({ repo: SIBLING, issue: 13 });
});

test("a task titled with the sibling repository links to refs.repo, and without refs.repo it does not and a hint is offered", async () => {
  const { tasks } = rig("advise");
  const linked = await tasks.propose("claude", { title: "agent-mem#13 P3: hooks", class: "implement", refs: { repo: SIBLING }, backlog: true });
  expect(linked.sdlc).toMatchObject({ repo: SIBLING, issue: 13 });
  expect(tasks.refsRepoHint(linked)).toBeUndefined();
  const bare = await tasks.propose("claude", { title: "agent-mem#14 P4: library", class: "implement", backlog: true });
  expect(bare.sdlc?.issue).toBeUndefined();
  expect(tasks.refsRepoHint(bare)).toContain("set refs.repo");
  expect(tasks.refsRepoHint(bare)).toContain("agent-mem");
  const qualified = await tasks.propose("claude", { title: "entelecheia/dotfiles-v2#255 retire claude-mem", class: "implement", backlog: true });
  expect(tasks.refsRepoHint(qualified)).toContain("entelecheia/dotfiles-v2");
  const ordinary = await tasks.propose("claude", { title: "Fix #20: ordinary", class: "implement", backlog: true });
  expect(tasks.refsRepoHint(ordinary)).toBeUndefined();
});

test("owner/repo#N with refs.repo naming that repository links to it, and a different repository stays unlinked", async () => {
  const { tasks } = rig("advise");
  const same = await tasks.propose("claude", { title: "STAIxBWLB/agent-mem#13 P3", class: "implement", refs: { repo: SIBLING }, backlog: true });
  expect(same.sdlc).toMatchObject({ repo: SIBLING, issue: 13 });
  const other = await tasks.propose("claude", { title: "STAIxBWLB/agent-mem#13 P3", class: "implement", refs: { repo: REPO }, backlog: true });
  expect(other.sdlc?.issue).toBeUndefined();
});

test("a failing link never refuses or reverts the write", async () => {
  const { tasks, board } = rig("advise");
  const bad = await tasks.propose("claude", { title: "Fix #1 and #2: two issues", class: "implement", backlog: true });
  expect(board.get(bad.id)).toBeTruthy();
  expect(bad.sdlc?.issue).toBeUndefined();
});

test("the local parsers name only what a title says, and read nothing", () => {
  expect(siblingTitleRefs("agent-mem#13 P4", SIBLING)).toEqual([13]);
  expect(siblingTitleRefs("Agent-Mem#13 and agent-mem#13", SIBLING)).toEqual([13]);
  expect(siblingTitleRefs("agent-mem#13", REPO)).toEqual([]);
  expect(siblingTitleRefs("agent-mem#13", undefined)).toEqual([]);
  expect(siblingTitleRefs("xagent-mem#13", SIBLING)).toEqual([]);
  expect(qualifiedTitleRepos("agent-mem#13 and dotfiles-v2#255")).toEqual(["agent-mem", "dotfiles-v2"]);
  expect(qualifiedTitleRepos("owner/repo#9")).toEqual(["owner/repo"]);
  expect(qualifiedTitleRepos("Fix #718, PR#12 and task#9")).toEqual([]);
  expect(qualifiedTitleRepos("see #5")).toEqual([]);
});

test("a groom on a 400-task board links within its bound before any slow read, and later calls finish the rest", async () => {
  const { tasks, board } = rig("advise");
  const ids = Array.from({ length: 400 }, (_, i) => board.propose("claude", { title: `Fix #${1000 + i}: filler`, class: "implement" }).id);
  const started = performance.now();
  await tasks.groomingDigest("claude");
  expect(performance.now() - started).toBeLessThan(15_000);
  const linkedAfterOne = ids.filter(id => board.get(id)!.sdlc?.issue).length;
  expect(linkedAfterOne).toBe(32);
  for (let i = 0; i < 12; i++) await tasks.groomingDigest("claude");
  expect(ids.every(id => board.get(id)!.sdlc?.issue === 1000 + ids.indexOf(id))).toBe(true);
});

test("the groom links before it reads GitHub metadata, so a failing or hanging read cannot skip the backfill", async () => {
  const order: string[] = [];
  const gh: SdlcGh = async args => { order.push(args[0] ?? ""); return { code: 1, stdout: "" }; };
  const { tasks, board } = rig("advise", gh);
  const id = board.propose("claude", { title: "Fix #77: ordered", class: "implement" }).id;
  const before = board.get(id)!.sdlc?.issue;
  expect(before).toBeUndefined();
  await tasks.groomingDigest("claude");
  expect(board.get(id)!.sdlc?.issue).toBe(77);
  expect(board.get(id)!.history.some(entry => entry.event === "lifecycle linked")).toBe(true);
});

test("a sibling shorthand beside a bare #N is ambiguous and links nothing (#723 review)", async () => {
  const { tasks } = rig("advise");
  const task = await tasks.propose("claude", { title: "agent-mem#13 follow-up for #723", class: "implement", backlog: true, refs: { repo: SIBLING } });
  expect(task.sdlc?.issue).toBeUndefined();
});

test("the refs.repo hint is silent when the lifecycle mode is off (#723 review)", async () => {
  const { tasks } = rig("off");
  const task = await tasks.propose("claude", { title: "agent-mem#13 follow-up", class: "implement", backlog: true });
  expect(tasks.refsRepoHint(task)).toBeUndefined();
  const advise = rig("advise");
  expect(advise.tasks.refsRepoHint(await advise.tasks.propose("claude", { title: "agent-mem#13 follow-up", class: "implement", backlog: true }))).toContain("refs.repo");
});

test("the groom backfill resumes past rows that never link when its time budget runs out (#723 review)", () => {
  const { tasks, board } = rig("off");
  for (let i = 0; i < 10; i++) board.propose("claude", { title: `no issue here ${i}`, class: "implement" });
  const target = board.propose("claude", { title: "Fix #718: late row", class: "implement" });
  (tasks as any).d.sdlc.config = () => sdlcConfig({ mode: "advise" });
  const real = performance.now.bind(performance);
  let t = 0;
  performance.now = () => (t += 300);
  try {
    for (let call = 0; call < 6 && !board.get(target.id)?.sdlc?.issue; call++) (tasks as any).backfillIssueLinks("claude");
  } finally { performance.now = real; }
  expect(board.get(target.id)?.sdlc?.issue).toBe(718);
});
