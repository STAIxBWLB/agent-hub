import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, HOST_ROADMAP_DRAFT } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { buildDecomposePrompt, parseDecomposition } from "../src/hub/roadmap-decompose.ts";

// R2 (#1480) part 1: the read-only proposal over a fake model. No real `gh` is called and nothing is intaken, linked or published.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

type Spec = { id: string; title: string; status: string | null; type?: string; paths?: string[] };
type Gh = (args: string[]) => Promise<{ code: number; stdout: string }>;
const issueRow = (number: number, title = `Export issue ${number}`) => ({ number, title, url: `https://github.com/example/repo/issues/${number}`, pr: false, milestone: null });
function fakeGh(state: { issues: unknown[] }): Gh {
  return async args => {
    if (args[0] === "repo") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "example/repo" }) };
    const path = args[1] ?? "";
    return { code: 0, stdout: JSON.stringify(/[?&]page=1(?:&|$)/.test(path) ? state.issues : []) };
  };
}

function fixture(model?: (system: string, user: string) => Promise<string | undefined>, opts: { cwd?: string; piiPaths?: string[] } = {}) {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "ahub-roadmap-decompose-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const roles: Record<string, string[]> = { claude: ["conductor"], kimi: ["planner"], codex: ["implementer"] };
  const control = { private: false, screening: false, screenLabel: "clear" as "clear" | "pii", notices: [] as string[], prompts: [] as { system: string; user: string }[], specs: undefined as undefined | { specs: Spec[]; errors: number; truncated: boolean } };
  const routing = loadRouting(cwd);
  const tasks = new Tasks({ board, bus, cwd, project: "roadmap-decompose", repository: "example/repo", roles, notify: (line: string) => { control.notices.push(line); },
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: control.screening ? "local" : "off" }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => control.private, operational: by => by === "claude", piiPaths: opts.piiPaths ?? [],
    piiScreen: async () => ({ label: control.screenLabel, ms: 0 }),
    specsList: () => { if (!control.specs) throw new Error("specs are off"); return control.specs; },
    roadmapModel: model ? (system, user) => { control.prompts.push({ system, user }); return model(system, user); } : undefined,
    specsRead: action => action === "check" ? { specCount: 0, errors: 0, warnings: 0, stale: 0, truncated: false, freshness: [], items: [] } : { specs: [], errors: 0, truncated: false, items: [] },
    sdlc: { config: () => sdlcConfig(undefined) } });
  for (const id of ["claude", "kimi", "codex"]) bus.add({ id, state: "idle", attached: true, rostered: true } as never);
  return { cwd, board, bus, tasks, control };
}
const milestone = (f: ReturnType<typeof fixture>, title = "Export surface", outcome = "People can export the roadmap") => f.board.newMilestone({ title, outcome, state: "active" }, "kimi", 1000);
const context = (f: ReturnType<typeof fixture>, m: number) => { f.tasks.milestoneLink("kimi", m, "spec", "agent-hub-architecture"); f.tasks.milestoneLink("kimi", m, "issue", "example/repo#1"); };
const architecture = { id: "agent-hub-architecture", title: "Agent hub architecture", status: "active", type: "architecture", paths: ["src/hub"] };

test("the split reader keeps only a cited, schema-valid part and caps the answer at eight (AC1)", () => {
  const prompt = buildDecomposePrompt({ milestone: { id: 1, title: "Export", outcome: "Ship export" },
    specs: [{ ref: "spec-a", label: "spec spec-a", text: "Alpha" }], issues: [{ ref: "example/repo#1", label: "issue example/repo#1", text: "Issue one" }] });
  expect([...prompt.offered.keys()]).toEqual(["spec-a", "example/repo#1"]);
  expect(prompt.user).toContain("spec spec-a: Alpha");
  const parsed = parseDecomposition(JSON.stringify([
    { title: "Keep", detail: "A part that cites what it was shown", class: "implement", needs_spec: true, cites: ["spec-a", "spec-a", "not-offered"] },
    { title: "No cite", detail: "Cites an id it was never shown", class: "implement", needs_spec: true, cites: ["not-offered"] },
    { title: "No intake", detail: "Says nothing about needing a spec", class: "test", cites: ["spec-a"] },
    { title: "Bad class", detail: "Not a hub task class", class: "deploy", needs_spec: false, cites: ["spec-a"] },
    { title: "Keep", detail: "Repeats a title already taken", class: "test", needs_spec: false, cites: ["spec-a"] },
  ]), prompt);
  expect(parsed.parts).toEqual([{ title: "Keep", detail: "A part that cites what it was shown", class: "implement", intake: "spec", cites: ["spec-a"] }]);
  expect(parsed.dropped).toBe(4);
  const nine = Array.from({ length: 9 }, (_, index) => ({ title: `Part ${index}`, detail: `Detail ${index}`, class: "test", needs_spec: false, cites: ["example/repo#1"] }));
  expect(parseDecomposition(JSON.stringify(nine), prompt).parts).toHaveLength(8);
  expect(parseDecomposition("no JSON here", prompt)).toEqual({ parts: [], dropped: 0 });
});

test("a cited decomposition is saved as a hub-attributed pending model answer and writes nothing else (AC1)", async () => {
  const f = fixture(async () => JSON.stringify([
    { title: "Split the export surface", detail: "Move rendering behind one seam and cover it", class: "implement", needs_spec: true, cites: ["agent-hub-architecture", "example/repo#1"] },
    { title: "Drop the legacy flag", detail: "Remove --legacy from the command and its tests", class: "bulk_edit", needs_spec: false, cites: ["example/repo#1"] },
  ]));
  f.control.specs = { specs: [architecture, { id: "unlinked-goal", title: "Another goal", status: "active", type: "goal", paths: [] }], errors: 0, truncated: false };
  const m = milestone(f), other = milestone(f, "Other milestone", "Not part of this one");
  context(f, m.id);
  const result = await f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(1)] }));
  expect(result).toMatchObject({ milestone: m.id, dropped: 0, unavailable: null });
  expect(result.parts).toEqual([
    { title: "Split the export surface", detail: "Move rendering behind one seam and cover it", class: "implement", intake: "spec", cites: ["agent-hub-architecture", "example/repo#1"] },
    { title: "Drop the legacy flag", detail: "Remove --legacy from the command and its tests", class: "bulk_edit", intake: "task", cites: ["example/repo#1"] },
  ]);
  expect(result.saved).toMatchObject({ milestone: m.id, state: "pending", by: "hub" });
  expect(f.board.decomposition(result.saved!.id)).toEqual(result.saved!);
  expect(f.board.decompositions("pending")).toHaveLength(1);
  // Nothing is intaken, linked, proposed or published: still two milestones, the same two links, no task.
  expect(f.board.milestones().map(row => row.id).sort()).toEqual([m.id, other.id].sort());
  expect(f.board.milestoneLinks().map(link => [link.kind, link.ref])).toEqual([["issue", "example/repo#1"], ["spec", "agent-hub-architecture"]]);
  expect(f.board.list()).toEqual([]);
  // The model saw this milestone's public text and its own links, and no other milestone or unlinked work.
  const prompt = f.control.prompts[0]!;
  expect(prompt.user).toContain("Export surface"); expect(prompt.user).toContain("People can export the roadmap");
  expect(prompt.user).toContain("agent-hub-architecture: Agent hub architecture (architecture, active) covers: src/hub");
  expect(prompt.user).toContain("issue example/repo#1: Export issue 1");
  expect(prompt.user).not.toContain("Other milestone"); expect(prompt.user).not.toContain("unlinked-goal");
  expect(prompt.system).toContain("needs_spec");
});

test("an answer citing nothing it was shown is not saved, and the drop is reported (AC1)", async () => {
  const f = fixture(async () => JSON.stringify([
    { title: "Invented source", detail: "Plans work from an id the hub never gave it", class: "implement", needs_spec: true, cites: ["invented-spec"] },
    { title: "No evidence", detail: "A part with no citation at all", class: "test", needs_spec: false, cites: [] },
  ]));
  f.control.specs = { specs: [architecture], errors: 0, truncated: false };
  const m = milestone(f);
  context(f, m.id);
  const result = await f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(1)] }));
  expect(result.parts).toEqual([]); expect(result.saved).toBeNull(); expect(result.dropped).toBe(2);
  expect(f.board.decompositions()).toEqual([]);
});

test("an item whose text is not public never reaches the prompt, and a private milestone is refused before the call (AC4)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-roadmap-decompose-"));
  const f = fixture(async () => JSON.stringify([{ title: "Public part", detail: "Cites the public spec", class: "implement", needs_spec: true, cites: ["agent-hub-architecture"] }]),
    { cwd, piiPaths: [join(cwd, "private")] });
  f.control.specs = { specs: [architecture, { id: "private-spec", title: "Notes in private/CANARY-SPEC.md", status: "active", type: "architecture", paths: ["private/CANARY-SPEC.md"] }], errors: 0, truncated: false };
  const m = milestone(f);
  f.tasks.milestoneLink("kimi", m.id, "spec", "agent-hub-architecture");
  f.tasks.milestoneLink("kimi", m.id, "spec", "private-spec");
  f.tasks.milestoneLink("kimi", m.id, "issue", "example/repo#2");
  const result = await f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(2, "Draft in private/CANARY-ISSUE.md")] }));
  expect(result.parts).toHaveLength(1);
  const prompt = f.control.prompts[0]!;
  expect(prompt.user).toContain("agent-hub-architecture");
  expect(prompt.user).not.toContain("private-spec"); expect(prompt.user).not.toContain("CANARY");
  // The linked issue is still offered by ref, with no title: an unreadable or private title is not an absent issue.
  expect(prompt.user.split("\n").find(row => row.includes("example/repo#2"))).toBe("- issue example/repo#2: ");
  const secret = milestone(f, "Notes in private/CANARY-MILESTONE.md", "Outcome in private/CANARY-OUTCOME.md");
  context(f, secret.id);
  await expect(f.tasks.roadmapDecompose("kimi", secret.id, fakeGh({ issues: [issueRow(1)] }))).rejects.toThrow("not cleared for public planning");
  expect(f.control.prompts).toHaveLength(1);
});

test("a second run supersedes the pending answer instead of doubling it", async () => {
  let runs = 0;
  const f = fixture(async () => JSON.stringify([{ title: `Part ${++runs}`, detail: "A part of the outcome", class: "test", needs_spec: false, cites: ["example/repo#1"] }]));
  const m = milestone(f);
  context(f, m.id);
  const first = await f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(1)] }));
  const second = await f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(1)] }));
  expect(f.board.decompositions("pending")).toHaveLength(1);
  expect(f.board.decompositions("pending")[0]!.id).toBe(second.saved!.id);
  expect(f.board.decomposition(first.saved!.id)).toMatchObject({ state: "superseded" });
});

test("an ordinary agent, a private turn, a milestone with nothing linked and a missing model each say so without a row", async () => {
  const f = fixture(async () => JSON.stringify([{ title: "Part", detail: "A part of the outcome", class: "test", needs_spec: false, cites: ["example/repo#1"] }]));
  const m = milestone(f), empty = milestone(f, "Bare milestone", "Nothing is linked yet");
  context(f, m.id);
  await expect(f.tasks.roadmapDecompose("codex", m.id, fakeGh({ issues: [issueRow(1)] }))).rejects.toThrow("planner");
  expect(f.control.prompts).toEqual([]);
  f.control.private = true;
  await expect(f.tasks.roadmapDecompose("kimi", m.id, fakeGh({ issues: [issueRow(1)] }))).rejects.toThrow("private");
  f.control.private = false;
  expect(await f.tasks.roadmapDecompose("kimi", empty.id)).toMatchObject({ parts: [], saved: null, unavailable: expect.stringContaining("links no spec or issue") });
  const noModel = fixture();
  const bare = milestone(noModel);
  context(noModel, bare.id);
  expect(await noModel.tasks.roadmapDecompose("kimi", bare.id, fakeGh({ issues: [issueRow(1)] }))).toMatchObject({ saved: null, unavailable: expect.stringContaining("no hub model is configured") });
  await expect(f.tasks.roadmapDecompose("kimi", 999, fakeGh({ issues: [issueRow(1)] }))).rejects.toThrow("does not exist");
  expect(f.board.decompositions()).toEqual([]); expect(noModel.board.decompositions()).toEqual([]);
});

// R2 (#1480) part 2, AC2: accepting one part holds the existing intake draft. No model call is made on this path.
const heldPart = (title = "Split the export surface", intake: "spec" | "task" = "spec") =>
  ({ title, detail: `What ${title} changes and how it is verified`, class: "implement", intake, cites: ["example/repo#1"] });

test("accepting a part holds exactly one intake draft linked to the milestone, and a repeat returns it (AC2)", async () => {
  const f = fixture();
  const m = milestone(f), answer = f.board.addDecomposition({ milestone: m.id, parts: [heldPart(), heldPart("Drop the legacy flag", "task")] }, "hub", 2000);
  const first = await f.tasks.roadmapDecomposePart("kimi", m.id, 1);
  expect(first).toMatchObject({ milestone: m.id, part: 1, intake: "spec", created: true });
  const draft = f.board.get(Number(first.task.id))!;
  // The existing hold, not a new state: a backlog draft with no owner and no reservation, so nothing offers or pulls it.
  expect(draft).toMatchObject({ state: "backlog", draft: true, owner: null, title: "Split the export surface" });
  expect(draft.reserved ?? null).toBeNull();
  expect(draft.detail).toContain("needs its own spec issue before implementation");
  expect(draft.detail).toContain("Milestone " + m.id + " part 1 of 2");
  // The milestone link is the one R1's own writer makes, and the part's kind is recorded beside the draft.
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task").map(link => link.ref)).toEqual([String(draft.id)]);
  expect(f.board.decompositionAccept(answer.id, 1)).toMatchObject({ milestone: m.id, part: 1, task: draft.id, intake: "spec" });
  expect(first.task.title).toBe("Split the export surface");
  // The same part again is the same draft: no second task, no second link.
  const again = await f.tasks.roadmapDecomposePart("kimi", m.id, 1);
  expect(again).toMatchObject({ created: false, part: 1, intake: "spec" });
  expect(Number(again.task.id)).toBe(draft.id);
  expect(f.board.list()).toHaveLength(1);
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task")).toHaveLength(1);
  // Each part is accepted on its own.
  expect(await f.tasks.roadmapDecomposePart("kimi", m.id, 2)).toMatchObject({ created: true, intake: "task" });
  expect(f.board.list()).toHaveLength(2);
  // The reply is one notice naming the draft and its part, never the part's text, and the answer stays one pending row.
  expect(f.control.notices.some(line => line.includes(`task #${draft.id}: milestone ${m.id} part 1 accepted as a held intake draft`))).toBe(true);
  expect(f.board.decompositions("pending")).toHaveLength(1);
});

test("accepting refuses before any write with no pending answer, a part outside it, or an ordinary agent (AC2)", async () => {
  const f = fixture();
  const m = milestone(f);
  await expect(f.tasks.roadmapDecomposePart("kimi", m.id, 1)).rejects.toThrow("no pending decomposition");
  f.board.addDecomposition({ milestone: m.id, parts: [heldPart()] }, "hub", 2000);
  await expect(f.tasks.roadmapDecomposePart("kimi", m.id, 2)).rejects.toThrow("holds 1 proposed part");
  await expect(f.tasks.roadmapDecomposePart("kimi", m.id, 0)).rejects.toThrow("roadmap id");
  await expect(f.tasks.roadmapDecomposePart("codex", m.id, 1)).rejects.toThrow("planner");
  f.control.private = true;
  await expect(f.tasks.roadmapDecomposePart("kimi", m.id, 1)).rejects.toThrow("private");
  f.control.private = false;
  // The capability is rechecked where the draft gate is: an agent that is not the planner stages no held draft, whatever it passes.
  await expect(f.tasks.propose("codex", { [HOST_ROADMAP_DRAFT]: true, title: "Hidden draft", class: "implement", backlog: true, draft: true })).rejects.toThrow("configured planner");
  await expect(f.tasks.propose("codex", { title: "Hidden draft", class: "implement", backlog: true, draft: true })).rejects.toThrow("only the person's intake");
  expect(f.board.list()).toEqual([]);
  expect(f.board.decompositionAccept(1, 1)).toBeUndefined();
});

test("a part the screen refuses is held privately, and neither the reply nor the notice repeats its words (AC2)", async () => {
  const f = fixture();
  const m = milestone(f);
  f.board.addDecomposition({ milestone: m.id, parts: [{ title: "Private rollup notes", detail: "Rewrite the private rollup by hand", class: "implement", intake: "spec", cites: ["example/repo#1"] }] }, "hub", 2000);
  f.control.screening = true; f.control.screenLabel = "pii";
  const accepted = await f.tasks.roadmapDecomposePart("kimi", m.id, 1);
  expect(accepted.task.title).toBe("[pii]");
  expect(accepted.task.detail).toBe("[pii]");
  const draft = f.board.get(Number(accepted.task.id))!;
  expect(f.tasks.publicTitle(draft)).toBe(`#${draft.id} [pii]`);
  // The held row keeps the text for the person who releases it; only what the accept returns and says is redacted.
  expect(draft.title).toBe("Private rollup notes");
  expect("Private rollup notes").not.toBe(accepted.task.title);
  for (const line of f.control.notices) expect(line).not.toContain("Private rollup");
});

test("a milestone settled between the answer and the accept refuses before any write (AC2)", async () => {
  const f = fixture();
  const m = milestone(f), answer = f.board.addDecomposition({ milestone: m.id, parts: [heldPart()] }, "hub", 2000);
  // The person settles the milestone while its answer is still pending, so the accept is a refusal, not a write.
  f.tasks.milestoneState("user", m.id, "done");
  await expect(f.tasks.roadmapDecomposePart("kimi", m.id, 1)).rejects.toThrow("settled milestone");
  expect(f.board.list()).toEqual([]);
  expect(f.board.decompositionAccept(answer.id, 1)).toBeUndefined();
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task")).toEqual([]);
  expect(f.board.decompositions("pending")).toHaveLength(1);
});

test("the retry path records a milestone link an interrupted tail lost (AC2)", async () => {
  const f = fixture();
  const m = milestone(f);
  f.board.addDecomposition({ milestone: m.id, parts: [heldPart()] }, "hub", 2000);
  const first = await f.tasks.roadmapDecomposePart("kimi", m.id, 1);
  const draft = f.board.get(Number(first.task.id))!;
  // A tail that lost its link leaves the draft and its accept row behind; the retry reads that draft and heals the link.
  f.tasks.milestoneUnlink("kimi", m.id, "task", String(draft.id));
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task")).toEqual([]);
  const again = await f.tasks.roadmapDecomposePart("kimi", m.id, 1);
  expect(again).toMatchObject({ created: false });
  expect(Number(again.task.id)).toBe(draft.id);
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task").map(link => link.ref)).toEqual([String(draft.id)]);
  expect(f.board.list()).toHaveLength(1);
});

test("two concurrent accepts of one part make one draft and one accept row (AC2)", async () => {
  const f = fixture();
  const m = milestone(f), answer = f.board.addDecomposition({ milestone: m.id, parts: [heldPart()] }, "hub", 2000);
  // Screening makes the proposal await, which is where a second accept would otherwise read no accept row and make its own draft.
  f.control.screening = true; f.control.screenLabel = "clear";
  const [one, two] = await Promise.all([f.tasks.roadmapDecomposePart("kimi", m.id, 1), f.tasks.roadmapDecomposePart("kimi", m.id, 1)]);
  expect(Number(two.task.id)).toBe(Number(one.task.id));
  expect([one.created, two.created].filter(Boolean)).toHaveLength(1);
  expect(f.board.list()).toHaveLength(1);
  expect(f.board.decompositionAccept(answer.id, 1)).toMatchObject({ task: Number(one.task.id) });
  expect(f.board.milestoneLinks(m.id).filter(link => link.kind === "task")).toHaveLength(1);
});
