import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type HistoryEntry } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { candidateCard, criterionKey, groupUnmetCriteria, LEARNING_DEFAULTS, overridesDiff, selectGroups, type CriterionGroup, type LearningRow } from "../src/hub/learning.ts";

// #514a: criteria that reviews keep naming unmet are grouped by profile, class and criterion and filed as ONE backlog candidate for a person, with the
// profile_overrides fragment as text. The hub never applies it.
const A = "a".repeat(40), DAY = 86_400_000, NOW = 1_800_000_000_000, WINDOW = 30 * DAY;
const row = (id: number, unmet: string[][], extra: Partial<LearningRow> = {}): LearningRow => ({
  id, class: "implement", history: unmet.map((criteria, i) => ({ at: NOW - DAY * (i + 1), by: "claude", event: "changes_requested", unmetCriteria: criteria }) as HistoryEntry), ...extra,
});

test("groupUnmetCriteria groups by profile, class and criterion, counts distinct tasks and reviews, and sorts by recurrence", () => {
  const groups = groupUnmetCriteria([
    row(1, [["AC1", "AC2"]]), row(2, [["AC1"], ["AC1"]]), row(3, [["AC1"]], { profile: "research" }), row(4, [["AC1"]], { profileClass: "analysis" }), row(5, [["AC2"]]),
  ], { windowMs: WINDOW, now: NOW });
  expect(groups.map(g => [g.profile, g.class, g.criterion, g.tasks, g.count])).toEqual([
    ["dev", "implement", "AC1", [1, 2], 3], // tasks 1 and 2; task 2 named it in two reviews
    ["dev", "implement", "AC2", [1, 5], 2],
    ["dev", "analysis", "AC1", [4], 1], // a profile class alias is its own group
    ["research", "implement", "AC1", [3], 1], // so is another profile
  ]);
});

test("groupUnmetCriteria counts a criterion once per review, ignores withheld, old and future entries", () => {
  const rows: LearningRow[] = [
    row(1, [["AC1", "AC1"]]),
    { id: 2, class: "implement", history: [
      { at: NOW - 31 * DAY, by: "claude", event: "changes_requested", unmetCriteria: ["AC1"] },
      { at: NOW - DAY, by: "claude", event: "changes_requested", unmetCriteria: ["AC1"], withheld: true },
      { at: NOW + DAY, by: "claude", event: "changes_requested", unmetCriteria: ["AC1"] },
      { at: NOW - DAY, by: "claude", event: "changes_requested" },
    ] as HistoryEntry[] },
  ];
  expect(groupUnmetCriteria(rows, { windowMs: WINDOW, now: NOW }).map(g => [g.criterion, g.tasks, g.count])).toEqual([["AC1", [1], 1]]);
  expect(groupUnmetCriteria(rows, { windowMs: 40 * DAY, now: NOW }).map(g => [g.criterion, g.tasks, g.count])).toEqual([["AC1", [1, 2], 2]]);
  expect(groupUnmetCriteria([], { windowMs: WINDOW, now: NOW })).toEqual([]);
});

test("the override fragment and card are text: ascii, ids and counts only, nothing applied", () => {
  const group = { profile: "dev", class: "implement", criterion: "AC1", tasks: [3, 4, 9], count: 4 };
  expect(overridesDiff(group)).toEqual({ profile_overrides: { review_checklist: ["AC1: confirm this first; it was unmet on 3 implement tasks"] } });
  const card = candidateCard(group, 30, 3);
  expect(card.title).toBe("Review checklist candidate for dev/implement criterion AC1");
  expect(card.detail.split("\n")[0]).toBe(criterionKey(group));
  expect(card.detail).toContain("named unmet 4 time(s) on 3 dev/implement task(s) in the last 30 days (3 separate piece(s) of work): #3, #4, #9.");
  expect(card.detail).toContain("Nothing was applied, and nothing in the hub writes it.");
  expect(card.detail).toContain("not machine-local");
  expect(card.detail).toContain('"review_checklist": [');
  expect(card.detail).toContain("replaces as a unit");
  expect(overridesDiff({ ...group, class: "im\u00e9plement\n#x" }).profile_overrides.review_checklist[0]).toBe("AC1: confirm this first; it was unmet on 3 im plement #x tasks");
});

class Peer extends BasePeer {
  readonly got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const criterion = (id: string) => ({ id, required: true, result: "unverified" as const, refs: [] as string[] });
async function rig(extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-learning-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const peers = { claude: new Peer("claude"), codex: new Peer("codex") };
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const config = sdlcConfig({ mode: "advise", required_checks: [] }, "0.14.0");
  const tasks = new Tasks({ board, bus, cwd: dir, project: "learning", routing: () => loadRouting(dir), roles: { claude: ["planner", "reviewer"] }, notify: (text: string) => notices.push(text), piiScreen: async () => ({ label: "clear", ms: 0 }), sdlc: { config: () => config }, ...extra } as never);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  /** One separate piece of work reviewed once, naming `criteria` unmet. */
  const reject = async (title: string, criteria: string[], extra: object = {}, verdict: "changes_requested" | "approved" = "changes_requested") => {
    const task = await tasks.propose("claude", { title, class: "implement", owner: "codex", ...extra });
    tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: A, criteria: ["AC1", "AC2", "AKIAIOSFODNN7EXAMPLE"].map(criterion) } });
    await tasks.done("codex", task.id, "finished");
    await Bun.sleep(5);
    await tasks.review("claude", task.id, verdict, "gaps", criteria.map(id => `${id}: a gap`));
    if (verdict !== "approved") board.update(task.id, USER, "cancelled", { state: "cancelled" }, "closed so the owner's WIP slot is free; the verdict stays in history");
    return task.id;
  };
  const candidates = () => board.list("backlog").filter(t => t.detail.includes("Criterion candidate key:"));
  return { tasks, board, notices, reject, candidates };
}

test("three separate tasks naming one criterion unmet file ONE candidate with the diff; a fourth review files no second", async () => {
  const r = await rig();
  await r.reject("first source ranking", ["AC1"]); await r.reject("second source ranking", ["AC1"]);
  expect(r.candidates()).toHaveLength(0); // two is below the threshold
  const third = await r.reject("third source ranking", ["AC1", "AC2"]);
  const [card] = r.candidates();
  expect(r.candidates()).toHaveLength(1);
  expect(card!.title).toBe("Review checklist candidate for dev/implement criterion AC1");
  expect(card!.detail).toContain("Criterion candidate key: dev:implement:AC1");
  expect(card!.detail).toContain(`#${third - 2}, #${third - 1}, #${third}`);
  expect(card!.detail).toContain('"review_checklist": [\n      "AC1: confirm this first; it was unmet on 3 implement tasks"');
  expect(card!.class).toBe("plan");
  expect(card!.history[0]!.by).toBe("hub");
  expect(card!.detail).not.toContain("ranking"); // no task title leaks into the card
  await r.reject("fourth source ranking", ["AC1"]);
  expect(r.candidates()).toHaveLength(1); // the dedupe key holds
  expect(r.board.get(third)!.history.find(h => h.event === "changes_requested")!.unmetCriteria).toEqual(["AC1", "AC2"]); // the verdict itself is untouched
});

test("the candidate is a proposal only: the hub writes no config and records no override", async () => {
  const r = await rig();
  const dir = (r.tasks as unknown as { d: { cwd: string } }).d.cwd;
  for (const title of ["one", "two", "three"]) await r.reject(title, ["AC1"]);
  expect(r.candidates()).toHaveLength(1);
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(dir, ".agenthub"))).toBe(false);
});

test("a criterion this review did not name does not file a card even when others recur", async () => {
  const r = await rig();
  await r.reject("one", ["AC2"]); await r.reject("two", ["AC2"]);
  await r.reject("three", ["AC2"]);
  expect(r.candidates().map(t => t.detail.split("\n")[0])).toEqual(["Criterion candidate key: dev:implement:AC2"]);
  await r.reject("four", ["AC1"]); // AC1 is at 1 task: nothing new
  expect(r.candidates()).toHaveLength(1);
});

test("tasks that are one piece of work (same branch) are not a recurrence", async () => {
  const r = await rig();
  const refs = { branch: "feat/same", paths: ["src/x.ts"] };
  for (const title of ["one", "two", "three"]) await r.reject(title, ["AC1"], { refs });
  expect(r.candidates()).toHaveLength(0);
});

test("PII tasks never count and never file: their criteria are not recorded and a verdict on one adds nothing", async () => {
  const r = await rig();
  for (const title of ["one", "two"]) await r.reject(title, ["AC1"]);
  for (let i = 0; i < 3; i++) {
    const task = r.board.propose("claude", { title: `private ${i}`, class: "implement", signals: ["pii_path"] });
    r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    r.tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: A, criteria: [criterion("AC1")] } });
    r.board.update(task.id, "codex", "done", { state: "in_review" }, "finished");
    await r.tasks.review("claude", task.id, "changes_requested", "x", ["AC1: a gap"]);
    r.board.update(task.id, USER, "cancelled", { state: "cancelled" });
  }
  expect(r.candidates()).toHaveLength(0); // 2 ordinary + 3 PII: only the two count
  await r.reject("three", ["AC1"]);
  expect(r.candidates()).toHaveLength(1);
  expect(r.candidates()[0]!.detail).not.toContain("private");
  expect(r.candidates()[0]!.detail).toContain("on 3 dev/implement task(s)");
});

test("a task that became PII after its verdict no longer counts toward a recurrence", async () => {
  const r = await rig();
  const first = await r.reject("one", ["AC1"]); await r.reject("two", ["AC1"]);
  r.board.update(first, USER, "flagged", { signals: ["pii_path"] });
  expect(r.tasks.isPii(r.board.get(first)!)).toBe(true);
  await r.reject("three", ["AC1"]);
  expect(r.candidates()).toHaveLength(0); // 2 ordinary tasks only
  await r.reject("four", ["AC1"]);
  expect(r.candidates()).toHaveLength(1);
});

test("a recurrence that predates this feature files nothing for a criterion the new review did not name, and one card when it names it", async () => {
  const r = await rig();
  // Retained history: three reviews that named AC1 before the hub grouped criteria. Built on the board, so no verdict ran the proposal.
  for (const title of ["old one", "old two", "old three"]) {
    const task = r.board.propose("claude", { title, class: "implement" });
    r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    r.board.update(task.id, "codex", "done", { state: "in_review" }, "finished");
    r.board.update(task.id, "claude", "changes_requested", { state: "changes_requested" }, "gap", { unmetCriteria: ["AC1"] } as never);
    r.board.update(task.id, USER, "cancelled", { state: "cancelled" });
  }
  await r.reject("unrelated", ["AC2"]);
  expect(r.candidates()).toHaveLength(0); // AC2 is at one task, and AC1 was not named by this review
  await r.reject("names it again", ["AC1"]);
  expect(r.candidates().map(t => t.detail.split("\n")[0])).toEqual(["Criterion candidate key: dev:implement:AC1"]);
});

test("a verdict given in a private turn files nothing", async () => {
  const r = await rig({ privateTurn: (peer: string) => peer === "claude" });
  for (const title of ["one", "two", "three"]) await r.reject(title, ["AC1"]);
  expect(r.candidates()).toHaveLength(0);
});

test("an approval that still names unmet criteria counts and can file the candidate", async () => {
  const r = await rig();
  await r.reject("one", ["AC1"]); await r.reject("two", ["AC1"]);
  await r.reject("three", ["AC1"], {}, "approved");
  expect(r.candidates()).toHaveLength(1);
});

test("a card whose text trips the secret screen is not filed, and the next ordinary criterion still is", async () => {
  const r = await rig();
  for (const title of ["one", "two", "three"]) await r.reject(title, ["AKIAIOSFODNN7EXAMPLE"]);
  expect(r.candidates()).toHaveLength(0);
  for (const title of ["four", "five", "six"]) await r.reject(title, ["AC1"]);
  expect(r.candidates().map(t => t.detail.split("\n")[0])).toEqual(["Criterion candidate key: dev:implement:AC1"]);
});

test("a PII task's own verdict never files a card, even if criteria were somehow on its history", async () => {
  const r = await rig();
  // Three ordinary reviews already name AC1 but no verdict ran the proposal (retained history): only a PII verdict could trip it now.
  for (const title of ["old one", "old two", "old three"]) {
    const old = r.board.propose("claude", { title, class: "implement" });
    r.board.update(old.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    r.board.update(old.id, "codex", "done", { state: "in_review" }, "finished");
    r.board.update(old.id, "claude", "changes_requested", { state: "changes_requested" }, "gap", { unmetCriteria: ["AC1"] } as never);
    r.board.update(old.id, USER, "cancelled", { state: "cancelled" });
  }
  const task = r.board.propose("claude", { title: "private", class: "implement", signals: ["pii_path"] });
  r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
  r.board.update(task.id, "codex", "done", { state: "in_review" }, "finished");
  r.board.update(task.id, "claude", "changes_requested", { state: "changes_requested" }, "gap", { unmetCriteria: ["AC1"] } as never);
  expect(r.tasks.isPii(r.board.get(task.id)!)).toBe(true);
  (r.tasks as unknown as { proposeCriterionCandidates(task: unknown, by: string, withheld: boolean): void }).proposeCriterionCandidates(r.board.get(task.id)!, "claude", false);
  expect(r.candidates()).toHaveLength(0);
});

const group = (criterion: string, tasks: number[]): CriterionGroup => ({ profile: "dev", class: "implement", criterion, tasks, count: tasks.length });

test("selectGroups: the cap counts cards to file, so settled groups ahead of a new one never starve it", () => {
  const settled = Array.from({ length: 70 }, (_, i) => group(`A${String(i).padStart(2, "0")}`, [1, 2, 3]));
  const fresh = group("AC1", [1, 2, 3]);
  const all = [...settled, fresh];
  const base = { named: new Set([...settled.map(g => g.criterion), "AC1"]), threshold: 3, max: LEARNING_DEFAULTS.maxGroups, has: (g: CriterionGroup) => g.criterion !== "AC1", units: () => 3 };
  expect(selectGroups(all, base)).toEqual([fresh]); // 70 groups already carded, and the 71st still files
  expect(selectGroups(all, { ...base, has: () => false }).length).toBe(LEARNING_DEFAULTS.maxGroups); // the cap still bounds one pass
  expect(selectGroups(all, { ...base, has: () => false, max: 2 }).map(g => g.criterion)).toEqual(["A00", "A01"]); // in order
});

test("selectGroups skips unnamed, under-threshold, already-carded and single-piece groups before the cap", () => {
  const a = group("A1", [1, 2, 3]), b = group("B1", [1, 2]), c = group("C1", [1, 2, 3]), d = group("D1", [1, 2, 3]), e = group("E1", [1, 2, 3]);
  const pick = (over: object) => selectGroups([a, b, c, d, e], { named: new Set(["A1", "B1", "C1", "D1", "E1"]), threshold: 3, max: 1, has: () => false, units: () => 3, ...over }).map(g => g.criterion);
  expect(pick({})).toEqual(["A1"]);
  expect(pick({ named: new Set(["E1"]) })).toEqual(["E1"]); // A1..D1 not named by this verdict
  expect(pick({ threshold: 3, named: new Set(["B1", "C1"]) })).toEqual(["C1"]); // B1 has 2 tasks
  expect(pick({ has: (g: CriterionGroup) => g.criterion === "A1" })).toEqual(["C1"]);
  expect(pick({ units: (g: CriterionGroup) => g.criterion === "A1" ? 1 : 2 })).toEqual(["C1"]); // A1 is one piece of work
  expect(pick({ max: 0 })).toEqual([]);
});

test("end to end: 70 criteria that already have cards, sorted ahead, do not keep a new recurring criterion from filing", async () => {
  const r = await rig();
  const names = Array.from({ length: 70 }, (_, i) => `A${String(i).padStart(2, "0")}`);
  // Retained history, built on the board: three tasks that each named all 70 criteria (32 at most per verdict, so three verdicts), two of them also AC1.
  const retained: number[] = [];
  for (const title of ["old one", "old two", "old three"]) {
    const task = r.board.propose("claude", { title, class: "implement" });
    r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    r.board.update(task.id, "codex", "done", { state: "in_review" }, "finished");
    const withNew = retained.length < 2 ? ["AC1"] : [];
    for (const chunk of [names.slice(0, 32), names.slice(32, 64), [...names.slice(64), ...withNew]]) r.board.update(task.id, "claude", "changes_requested", { state: "changes_requested" }, "gap", { unmetCriteria: chunk } as never);
    r.board.update(task.id, USER, "cancelled", { state: "cancelled" });
    retained.push(task.id);
  }
  // Each of the 70 already has its card, filed by the hub.
  for (const name of names) r.board.propose("hub", { title: `card ${name}`, detail: `Criterion candidate key: dev:implement:${name}\nfiled earlier`, class: "plan", backlog: true });
  expect(r.candidates()).toHaveLength(70);
  await r.reject("names the new one", ["AC1"]);
  const keys = r.candidates().map(t => t.detail.split("\n")[0]);
  expect(keys).toHaveLength(71);
  expect(keys).toContain("Criterion candidate key: dev:implement:AC1"); // the 71st group filed: the cap did not count the 70 settled ones
  expect(new Set(keys).size).toBe(71); // and none of the 70 was filed twice
});
