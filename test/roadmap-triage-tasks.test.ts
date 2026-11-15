import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { USER } from "../src/hub/envelope.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

type Gh = (args: string[]) => Promise<{ code: number; stdout: string }>;
const issueRow = (number: number, milestone: number | null = null, title = `Issue ${number} export`) => ({ number, title, url: `https://github.com/example/repo/issues/${number}`, pr: false, milestone });
function fakeGh(state: { issues: unknown[]; milestones?: unknown[]; calls?: string[][] }): Gh {
  return async args => {
    state.calls?.push(args);
    if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "example/repo" }) };
    const path = args[1] ?? "", rows = path.includes("/milestones?") ? state.milestones ?? [] : state.issues;
    return { code: 0, stdout: JSON.stringify(/[?&]page=1(?:&|$)/.test(path) ? rows : []) };
  };
}

function fixture(model?: (system: string, user: string) => Promise<string | undefined>) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-roadmap-r3-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const roles: Record<string, string[]> = { claude: ["conductor"], kimi: ["planner"], codex: ["implementer"] };
  const control = { private: false, screening: false, models: [] as string[], specs: undefined as undefined | { specs: { id: string; title: string; status: string | null }[]; errors: number; truncated: boolean } };
  const routing = loadRouting(cwd);
  const tasks = new Tasks({ board, bus, cwd, project: "roadmap-r3", repository: "example/repo", roles, notify: () => {},
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: control.screening ? "local" : "off" }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => control.private, operational: by => by === "claude",
    piiScreen: async () => ({ label: "clear", ms: 0 }),
    specsList: () => { if (!control.specs) throw new Error("specs are off"); return control.specs; },
    roadmapModel: model ? (system, user) => { control.models.push(user); return model(system, user); } : undefined,
    specsRead: action => action === "check" ? { specCount: 0, errors: 0, warnings: 0, stale: 0, truncated: false, freshness: [], items: [] } : { specs: [], errors: 0, truncated: false, items: [] },
    sdlc: { config: () => sdlcConfig(undefined) } });
  for (const id of ["claude", "kimi", "codex"]) bus.add({ id, state: "idle", attached: true, rostered: true } as never);
  return { cwd, board, bus, tasks, control };
}
const propose = (f: ReturnType<typeof fixture>, title: string, extra: Record<string, unknown> = {}) => f.board.propose(USER, { title, class: "implement", ...extra }) as Task;
const milestone = (f: ReturnType<typeof fixture>, title = "Export surface", outcome = "People can export the roadmap") => f.board.newMilestone({ title, outcome, state: "active" }, "kimi", 1000);

test("unplaced lists open issues, tasks and specs with reasons; private tasks are counted, never named (AC1, AC5)", async () => {
  const f = fixture();
  f.control.specs = { specs: [{ id: "alpha", title: "Alpha spec", status: "active" }, { id: "gone", title: "Old", status: "deprecated" }], errors: 0, truncated: false };
  propose(f, "Plain public task");
  const secret = propose(f, "SECRET-PRIVATE-TITLE", { signals: ["pii"] });
  const calls: string[][] = [];
  const result = await f.tasks.roadmapUnplaced("kimi", {}, fakeGh({ issues: [issueRow(1), issueRow(2)], calls }));
  expect(result.issues.map(row => row.ref)).toEqual(["example/repo#1", "example/repo#2"]);
  expect(result.issues[0]!.reason).toContain("no milestone links it");
  expect(result.tasks.map(row => row.title)).toEqual(["Plain public task"]);
  expect(result.specs.map(row => row.id)).toEqual(["alpha"]);
  expect(result.privateTasks).toBe(1);
  expect(JSON.stringify(result)).not.toContain("SECRET-PRIVATE-TITLE");
  expect(result.partial).toBe(false); expect(result.unavailable).toEqual([]);
  expect(secret.id).toBeGreaterThan(0);
  // GitHub was only read.
  for (const call of calls) expect(call.some(word => /^(-X|--method|-f|-F|--input)$/.test(word))).toBe(false);
});

test("linking an issue places it and drops the inheriting task off the list (AC1)", async () => {
  const f = fixture(), m = milestone(f);
  const task = propose(f, "Imported task", { external: { provider: "github", repo: "example/repo", issue: 1, url: "https://github.com/example/repo/issues/1" }, backlog: true });
  const gh = fakeGh({ issues: [issueRow(1)] });
  const before = await f.tasks.roadmapUnplaced("kimi", {}, gh);
  expect(before.tasks.map(row => row.id)).toEqual([task.id]); expect(before.issues).toEqual([]);
  f.tasks.milestoneLink("kimi", m.id, "issue", "example/repo#1");
  const after = await f.tasks.roadmapUnplaced("kimi", {}, gh);
  expect(after.tasks).toEqual([]); expect(after.issues).toEqual([]);
});

test("an unreadable GitHub or specs source is named unavailable, never an empty all-placed list", async () => {
  const f = fixture();
  const result = await f.tasks.roadmapUnplaced("kimi", {}, async () => ({ code: 1, stdout: "" }));
  expect(result.unavailable).toEqual(["issues", "specs"]); expect(result.issues).toEqual([]);
});

test("a private or review-observer turn cannot read unplaced work", async () => {
  const f = fixture(); f.control.private = true;
  await expect(f.tasks.roadmapUnplaced("kimi", {}, fakeGh({ issues: [] }))).rejects.toThrow("private");
});

test("triage saves cited suggestions as hub-attributed pending answers and links nothing until accept (AC2)", async () => {
  const f = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: 1, new: null, cite_item: "Issue 1 export", cite_milestone: "export the roadmap" }]));
  const m = milestone(f); expect(m.id).toBe(1);
  const result = await f.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }));
  expect(result).toMatchObject({ asked: 1, dropped: 0, unavailable: null });
  expect(result.suggestions).toHaveLength(1);
  expect(result.suggestions[0]).toMatchObject({ kind: "issue", ref: "example/repo#1", milestone: 1, citeItem: "Issue 1 export", citeMilestone: "export the roadmap", state: "pending", by: "hub" });
  expect(f.board.milestoneLinks()).toEqual([]);
  // The model was shown the milestone and the item text, nothing else.
  expect(f.control.models[0]).toContain("Issue 1 export");
  // Accept creates exactly the suggested link.
  const accepted = await f.tasks.roadmapAccept("kimi", result.suggestions[0]!.id);
  expect(accepted.suggestion).toMatchObject({ state: "accepted", settledBy: "kimi" });
  expect(f.board.milestoneLinks().map(link => [link.milestone, link.kind, link.ref])).toEqual([[1, "issue", "example/repo#1"]]);
  await expect(f.tasks.roadmapAccept("kimi", result.suggestions[0]!.id)).rejects.toThrow("already accepted");
});

test("reject drops one without linking; a pending item is not asked about twice; list reads without a model call", async () => {
  const f = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: 1, new: null, cite_item: "Issue 1 export", cite_milestone: "export the roadmap" }]));
  milestone(f);
  const gh = fakeGh({ issues: [issueRow(1)] });
  const first = await f.tasks.roadmapTriage("kimi", {}, gh);
  const again = await f.tasks.roadmapTriage("kimi", {}, gh);
  expect(again.asked).toBe(0); expect(f.control.models).toHaveLength(1);
  expect(f.tasks.milestoneSuggestions("kimi", "pending").map(row => row.id)).toEqual([first.suggestions[0]!.id]);
  expect(f.tasks.roadmapReject("kimi", first.suggestions[0]!.id)).toMatchObject({ state: "rejected" });
  expect(f.board.milestoneLinks()).toEqual([]);
  // A repeat reject is an idempotent replay, but a settled suggestion never changes to another outcome.
  expect(f.tasks.roadmapReject("kimi", first.suggestions[0]!.id)).toMatchObject({ state: "rejected" });
  await expect(f.tasks.roadmapAccept("kimi", first.suggestions[0]!.id)).rejects.toThrow("already rejected");
  expect(f.board.milestoneLinks()).toEqual([]);
  // A rejected item is asked about again, as it is still unplaced.
  expect((await f.tasks.roadmapTriage("kimi", {}, gh)).asked).toBe(1);
});

test("a new-milestone suggestion creates the proposed milestone once even when the link step is retried", async () => {
  const f = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: null, new: { title: "Export work", outcome: "Everything about export" }, cite_item: "Issue 1 export", cite_milestone: null }]));
  const result = await f.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }));
  const id = result.suggestions[0]!.id;
  // Make the link fail once after the milestone was created: a retry must reuse that milestone.
  const link = f.board.linkMilestone.bind(f.board); let failed = false;
  f.board.linkMilestone = (...args) => { if (!failed) { failed = true; throw new Error("storage hiccup"); } return link(...args); };
  await expect(f.tasks.roadmapAccept("kimi", id)).rejects.toThrow("storage hiccup");
  expect(f.board.milestones()).toHaveLength(1);
  await f.tasks.roadmapAccept("kimi", id);
  expect(f.board.milestones()).toHaveLength(1);
  expect(f.board.milestones()[0]).toMatchObject({ title: "Export work", state: "proposed" });
  expect(f.board.milestoneLinks().map(row => row.ref)).toEqual(["example/repo#1"]);
});

test("an unsupported model answer saves nothing and reports what it dropped; no model or a dead one is named, not silent", async () => {
  const bad = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: 77, new: null, cite_item: "Issue 1 export", cite_milestone: "x" }]));
  milestone(bad);
  const dropped = await bad.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }));
  expect(dropped.suggestions).toEqual([]); expect(dropped.dropped).toBe(1);
  const none = fixture(); milestone(none);
  expect((await none.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }))).unavailable).toContain("no hub model");
  const dead = fixture(async () => undefined); milestone(dead);
  expect((await dead.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }))).unavailable).toContain("no answer");
});

test("an ordinary agent cannot triage, accept or reject, and a model answer naming private text is not saved", async () => {
  const f = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: 1, new: null, cite_item: "Issue 1 export", cite_milestone: "export the roadmap" }]));
  milestone(f);
  await expect(f.tasks.roadmapTriage("codex", {}, fakeGh({ issues: [issueRow(1)] }))).rejects.toThrow("planner");
  expect(() => f.tasks.roadmapReject("codex", 1)).toThrow("planner");
  await expect(f.tasks.roadmapAccept("codex", 1)).rejects.toThrow("planner");
  const screened = fixture(async () => JSON.stringify([{ item: "issue example/repo#1", milestone: 1, new: null, cite_item: "Issue 1 export", cite_milestone: "export the roadmap" }]));
  milestone(screened); screened.control.screening = true;
  (screened.tasks as unknown as { d: { piiScreen: () => Promise<unknown> } }).d.piiScreen = async () => ({ label: "pii", category: "name", ms: 0 });
  const result = await screened.tasks.roadmapTriage("kimi", {}, fakeGh({ issues: [issueRow(1)] }));
  expect(result.suggestions).toEqual([]);
  expect(screened.board.suggestions()).toEqual([]);
});

test("import-github is a dry run by default, lists what it would create, and --apply is idempotent (AC4)", async () => {
  const f = fixture();
  const gh = fakeGh({ milestones: [{ number: 2, title: "Beta", description: "Ship the beta", due: "2026-12-31T00:00:00Z", url: "https://github.com/example/repo/milestone/2" }],
    issues: [issueRow(10, 2), issueRow(11, 2), issueRow(12, null)] });
  await expect(f.tasks.roadmapImportGitHub("kimi", {}, gh)).rejects.toThrow("console command");
  const dry = await f.tasks.roadmapImportGitHub(USER, {}, gh);
  expect(dry).toMatchObject({ apply: false, repo: "example/repo", created: 0, linked: 0 });
  expect(dry.milestones).toEqual([{ number: 2, title: "Beta", milestone: null, action: "create", issues: ["example/repo#10", "example/repo#11"], newLinks: 2 }]);
  expect(f.board.milestones()).toEqual([]);
  const applied = await f.tasks.roadmapImportGitHub(USER, { apply: true }, gh);
  expect(applied).toMatchObject({ apply: true, created: 1, linked: 2 });
  expect(f.board.milestones()).toHaveLength(1);
  expect(f.board.milestones()[0]).toMatchObject({ title: "Beta", outcome: "Ship the beta", state: "proposed", target: "2026-12-31" });
  expect(f.board.milestoneLinks().map(link => link.ref)).toEqual(["example/repo#10", "example/repo#11"]);
  const before = JSON.stringify([f.board.milestones(), f.board.milestoneLinks()]);
  const second = await f.tasks.roadmapImportGitHub(USER, { apply: true }, gh);
  expect(second).toMatchObject({ created: 0, linked: 0 });
  expect(second.milestones[0]).toMatchObject({ action: "exists", newLinks: 0 });
  expect(JSON.stringify([f.board.milestones(), f.board.milestoneLinks()])).toBe(before);
  // A person-only command even for the conductor's tool path is refused by authority; apply must be a boolean.
  await expect(f.tasks.roadmapImportGitHub(USER, { apply: "yes" }, gh)).rejects.toThrow("true or false");
});

test("import-github is the console user's alone: the configured conductor is refused before any gh call, dry run and apply (hub task 982)", async () => {
  const f = fixture();
  const calls: string[][] = [];
  const gh = fakeGh({ milestones: [{ number: 2, title: "Beta", description: "Ship the beta", due: "2026-12-31T00:00:00Z", url: "https://github.com/example/repo/milestone/2" }], issues: [issueRow(10, 2)], calls });
  // Control: this fixture's conductor passes a person-or-conductor guard (it reaches the id check), so the refusal below is the import's own.
  await expect(f.tasks.approveIntake("claude", "x")).rejects.toThrow("positive task number");
  for (const input of [{}, { apply: true }]) {
    await expect(f.tasks.roadmapImportGitHub("claude", input, gh)).rejects.toThrow("console command");
  }
  expect(calls).toEqual([]);
  expect(f.board.milestones()).toEqual([]);
  expect(f.board.milestoneLinks()).toEqual([]);
  await f.tasks.roadmapImportGitHub(USER, {}, gh);
  expect(calls.length).toBeGreaterThan(0);
});

test("import never relinks into a settled milestone and withholds text that fails the public screen", async () => {
  const f = fixture();
  const gh = fakeGh({ milestones: [{ number: 2, title: "Beta", description: "d", due: null, url: "https://github.com/example/repo/milestone/2" }, { number: 3, title: "sk-abcdefghijklmnopqrstuvwxyz0123456789 secret", description: "d", due: null, url: "https://github.com/example/repo/milestone/3" }], issues: [issueRow(10, 2)] });
  await f.tasks.roadmapImportGitHub(USER, { apply: true }, gh);
  const made = f.board.milestones()[0]!;
  expect(f.board.milestones()).toHaveLength(1);
  f.tasks.milestoneState(USER, made.id, "done");
  const again = fakeGh({ milestones: [{ number: 2, title: "Beta", description: "d", due: null, url: "https://github.com/example/repo/milestone/2" }], issues: [issueRow(10, 2), issueRow(11, 2)] });
  await f.tasks.roadmapImportGitHub(USER, { apply: true }, again);
  expect(f.board.milestoneLinks().map(link => link.ref)).toEqual(["example/repo#10"]);
});

test("list carries the roll-up tree and the ready-to-close flag, and the flag never changes a state", async () => {
  const f = fixture(), parent = milestone(f, "Parent", "Parent outcome"), child = f.board.newMilestone({ title: "Child", outcome: "Child outcome", state: "active", parent: parent.id }, "kimi", 1001);
  const task = propose(f, "Child work");
  f.board.update(task.id, "user", "started", { state: "in_progress" } as never);
  f.board.update(task.id, "user", "approved by test", { state: "approved" } as never);
  f.tasks.milestoneLink("kimi", child.id, "task", String(task.id));
  const rows = f.tasks.milestoneList("kimi");
  const top = rows.find(row => row.id === parent.id)!, kid = rows.find(row => row.id === child.id)!;
  expect(top.tree).toMatchObject({ tasks: { approved: 1, total: 1 }, children: 1 });
  expect(kid.readyToClose.ready).toBe(true);
  expect(top.readyToClose.ready).toBe(false);
  expect(f.board.milestone(child.id)!.state).toBe("active");
});
