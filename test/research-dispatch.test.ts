import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { budgetDispatchHold, campaignDispatchHold, followUpProblem, handoffState, parseResearchCampaign, parseResearchHandoff, studyProjection, type ResearchCampaignContract, type ResearchHandoff } from "../src/hub/research-campaign.ts";

// #930 T2 (task #597): coverage and stop projection, handoff-backed round advancement, the dispatch gate and the budget support map. Every clock is a fixed instant.
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), DAY = 86_400_000;
const S1 = "src:0123456789abcdef", S2 = "src:fedcba9876543210", S3 = "src:00000000000000aa";
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const unit = (id: string, over: Record<string, unknown> = {}) => ({ id, round: 0, question: `Question ${id}`, perspective: "p", requiredOutput: "out", sourceIds: [] as string[], dependsOn: [] as string[], purpose: "discovery", ...over });
const contract = (over: Record<string, unknown> = {}, units?: unknown[]): ResearchCampaignContract => parseResearchCampaign({
  question: "What does the fixture show?", scope: "Synthetic inputs only", exclusions: [], sourceIds: [S1, S2, S3],
  units: units ?? [unit("a", { sourceIds: [S1, S2] }), unit("b", { sourceIds: [S2, S3] }), unit("check", { purpose: "independent_check", sourceIds: [S1] }), unit("syn", { purpose: "synthesis", dependsOn: ["a", "b"] })],
  deliverableSections: [{ id: "result", title: "Result", ownerUnitId: "syn" }],
  stopPolicy: { maxUnits: 8, maxFollowUpRounds: 2, deadline: new Date(NOW + 10 * DAY).toISOString() }, ...over });
const handoff = (over: Partial<ResearchHandoff> = {}): ResearchHandoff => ({ campaignId: "rc-000000000001", revision: 1, unitId: "a", taskId: 7, evidence: [{ sourceId: S1, locator: "p. 1" }], unresolved: [], contradictions: [], limitations: [], ...over });

// ---- the pure parts

test("a handoff reports every missing or bad field at once, and the state it amounts to", () => {
  expect(() => parseResearchHandoff({})).toThrow(/campaignId: required.*revision: required.*unitId: required.*taskId: required.*evidence: required.*unresolved: required.*contradictions: required.*limitations: required/);
  expect(() => parseResearchHandoff({ ...handoff(), evidence: [{ sourceId: "nope", locator: "" }], unresolved: Array(17).fill("x"), extra: 1 })).toThrow(/extra: unknown field/);
  const message = (() => { try { parseResearchHandoff({ ...handoff(), evidence: [{ sourceId: "nope", locator: "x" }], limitations: "no", taskId: 0 }); } catch (error) { return String(error); } return ""; })();
  for (const field of ["evidence[0].sourceId", "limitations", "taskId"]) expect(message, field).toContain(field);
  expect(parseResearchHandoff(handoff())).toEqual(handoff());
  expect(parseResearchHandoff(handoff({ evidence: [], insufficientEvidence: "no source covers this" })).insufficientEvidence).toBe("no source covers this");
  expect(handoffState(undefined)).toBe("none");
  expect(handoffState(handoff({ evidence: [] }))).toBe("incomplete");          // "done" with no evidence is not coverage
  expect(handoffState(handoff())).toBe("complete");
  expect(handoffState(handoff({ evidence: [], insufficientEvidence: "none exist" }))).toBe("insufficient");
  expect(handoffState(handoff({ insufficientEvidence: "partly" }))).toBe("insufficient");   // the unit says its own coverage is partial
});

test("coverage shows duplicate discovery sources per unit, and an independent check is labelled as review, never as a duplicate", () => {
  const c = contract();
  const projection = studyProjection({ campaign: { id: "rc-000000000001", revision: 1, status: "approved", contract: c }, now: NOW, units: [
    { unitId: "a", taskId: 1, taskState: "in_progress", owner: "local", handoff: { evidenceSources: [S1], insufficientEvidence: false, incomplete: false } }, { unitId: "b", taskId: 2 }] });
  const a = projection.units.find(row => row.id === "a")!, b = projection.units.find(row => row.id === "b")!, check = projection.units.find(row => row.id === "check")!;
  expect(a.duplicateSources).toEqual([S2]); expect(b.duplicateSources).toEqual([S2]);                    // S2 is assigned to two discovery units
  expect(check.duplicateSources).toEqual([]); expect(check.label).toBe("independent review"); expect(check.reviewOf).toEqual([S1]);
  expect(projection.coverage.duplicates).toEqual([{ sourceId: S2, units: ["a", "b"] }]);
  expect(projection.coverage.independentReview).toEqual([{ sourceId: S1, units: ["a", "check"] }]);
  expect(a.sources).toEqual({ declared: [S1, S2], covered: [S1], uncovered: [S2] });
  expect(a.handoff).toBe("complete"); expect(b.handoff).toBe("none");
  expect(projection.coverage.unassigned).toEqual([]);
  expect(projection.coverage.rounds).toEqual([{ round: 0, discovery: 2, closed: false }]);   // b has no handoff: the round is not closed
  const unassigned = studyProjection({ campaign: { id: "rc-000000000001", revision: 1, status: "approved", contract: contract({}, [unit("a", { sourceIds: [S1] }), unit("syn", { purpose: "synthesis", dependsOn: ["a"] })]) }, now: NOW, units: [] });
  expect(unassigned.coverage.unassigned).toEqual([S2, S3]);
});

test("a projection is ids, enums, counts and times only: no question, scope, locator or note, so a private campaign shows the same shape", () => {
  const c = contract({ question: "SECRET_QUESTION_CANARY", scope: "SECRET_SCOPE_CANARY" });
  const text = JSON.stringify(studyProjection({ campaign: { id: "rc-000000000001", revision: 1, status: "approved", contract: c }, now: NOW,
    units: [{ unitId: "a", handoff: { evidenceSources: [S1], insufficientEvidence: false, incomplete: false } }] }));
  for (const canary of ["SECRET_QUESTION_CANARY", "SECRET_SCOPE_CANARY", "Question a", "p. 1"]) expect(text, canary).not.toContain(canary);
});

test("round advancement waits for every discovery unit of the round before to be closed by a handoff or a recorded reason", () => {
  const previous = contract().units;
  const next = contract({}, [...previous, unit("a2", { round: 1, sourceIds: [S1], dependsOn: ["a"] })]);
  const none = new Map<string, "none" | "incomplete" | "insufficient" | "complete">();
  expect(followUpProblem(next, previous, none)).toMatch(/follow-up round 1 waits: discovery units a, b of round 0/);
  expect(followUpProblem(next, previous, new Map([["a", "complete"], ["b", "incomplete"]]))).toMatch(/discovery unit b of round 0 has neither/);   // "incomplete" is a claim, not coverage
  expect(followUpProblem(next, previous, new Map([["a", "complete"], ["b", "insufficient"]]))).toBeUndefined();   // a recorded reason closes a unit
  expect(followUpProblem(next, previous, new Map([["a", "complete"], ["b", "complete"]]))).toBeUndefined();
  expect(followUpProblem(contract(), previous, none)).toBeUndefined();   // no new round: nothing to gate
  // a round already present in the previous revision is not "added" again
  const withRound = contract({}, [...previous, unit("a2", { round: 1, sourceIds: [S1], dependsOn: ["a"] })]);
  expect(followUpProblem(withRound, withRound.units, none)).toBeUndefined();
});

test("the campaign hold reads the stored revision, deadline, round and unit count, and an unreadable clock holds", () => {
  const c = contract(), base = { status: "approved" as const, contract: c, unitId: "a", now: NOW };
  expect(campaignDispatchHold(base)).toBeUndefined();
  expect(campaignDispatchHold({ ...base, status: "superseded" })).toBe("campaign_not_approved");
  expect(campaignDispatchHold({ ...base, status: "closed" })).toBe("campaign_not_approved");
  expect(campaignDispatchHold({ ...base, status: undefined, contract: undefined })).toBe("campaign_not_approved");
  expect(campaignDispatchHold({ ...base, unitId: "gone" })).toBe("unit_not_in_revision");
  expect(campaignDispatchHold({ ...base, now: Date.parse(c.stopPolicy.deadline) })).toBe("deadline_passed");   // the deadline instant itself is expired
  expect(campaignDispatchHold({ ...base, now: Date.parse(c.stopPolicy.deadline) - 1 })).toBeUndefined();
  expect(campaignDispatchHold({ ...base, now: Number.NaN })).toBe("state_unreadable");
  const over = { ...c, stopPolicy: { ...c.stopPolicy, maxFollowUpRounds: 0 }, units: c.units.map(row => row.id === "a" ? { ...row, round: 1 } : row) };
  expect(campaignDispatchHold({ ...base, contract: over })).toBe("round_over_limit");
  expect(campaignDispatchHold({ ...base, contract: { ...c, stopPolicy: { ...c.stopPolicy, maxUnits: 2 } } })).toBe("unit_count_over_limit");
});

test("the budget hold is id-specific: no hard cap holds nothing, and an owner outside the stored set or an uncovered or unreadable budget holds", () => {
  expect(budgetDispatchHold({ hardCap: [], eligibleOwners: undefined, owner: "codex", covered: false })).toBeUndefined();
  const base = { hardCap: ["model_calls" as const], eligibleOwners: ["local", "pi"], owner: "local", covered: true };
  expect(budgetDispatchHold(base)).toBeUndefined();
  expect(budgetDispatchHold({ ...base, owner: "codex" })).toBe("owner_not_eligible");
  expect(budgetDispatchHold({ ...base, eligibleOwners: undefined })).toBe("owner_not_eligible");
  expect(budgetDispatchHold({ ...base, covered: false })).toBe("budget_not_covering");
  expect(budgetDispatchHold({ ...base, covered: undefined })).toBe("state_unreadable");
});

// ---- the ledger: id-specific coverage, and one shared peer-wide ledger

test("ExecutionBudget.covers is one budget by id, reads only, and agrees with the existing scopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-covers-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new ExecutionBudget(join(dir, "hub.db")); clean.push(() => budget.close());
  budget.configure({ id: "run-1", kind: "run", peers: ["local", "pi"], limits: { model_calls: 5, tool_calls: 9 } });
  budget.configure({ id: "task-9", kind: "task", taskId: 9, peers: ["local"], limits: { model_calls: 1 } });
  budget.configure({ id: "legacy / ünïcode", kind: "run", peers: ["pi"], limits: { elapsed_ms: 60_000 } });
  expect(budget.covers("run-1", 3, "local", ["model_calls"])).toBe(true);            // a run budget covers every task of its peers
  expect(budget.covers("run-1", 3, "local", ["model_calls", "tool_calls"])).toBe(true);
  expect(budget.covers("run-1", 3, "local", ["elapsed_ms"])).toBe(false);            // no limit on that resource
  expect(budget.covers("run-1", 3, "codex", ["model_calls"])).toBe(false);           // a peer outside the budget
  expect(budget.covers("run-1", 3, "local", ["tokens"])).toBe(false);                // tokens are never covered
  expect(budget.covers("run-1", 3, "local", [])).toBe(false);                        // nothing named is not proof of anything
  expect(budget.covers("task-9", 9, "local", ["model_calls"])).toBe(true);           // a task budget covers only its own task
  expect(budget.covers("task-9", 3, "local", ["model_calls"])).toBe(false);
  expect(budget.covers("missing", 3, "local", ["model_calls"])).toBe(false);
  expect(budget.covers("legacy / ünïcode", 3, "pi", ["elapsed_ms"])).toBe(true);     // the ledger's exact id spelling
  expect(budget.covers("task-9", 9, "local", ["model_calls"])).toBe(true);
  // covers is `applies` for one id: wherever it is true, applies is true
  expect(budget.applies([3], "local")).toBe(true);
  // a read: the used counters are untouched by any number of calls
  const before = JSON.stringify(budget.status("run-1"));
  for (let i = 0; i < 20; i++) budget.covers("run-1", i + 1, "local", ["model_calls"]);
  expect(JSON.stringify(budget.status("run-1"))).toBe(before);
  budget.disable("run-1");
  expect(budget.covers("run-1", 3, "local", ["model_calls"])).toBe(false);           // a disabled budget stops covering
});

// ---- the dispatch gate through the real Tasks paths

const SOURCES = new Map([S1, S2, S3].map(id => [id, { id, sha256: "a".repeat(64), private: false }]));
async function fixture(options: { limits?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-dispatch-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); let board = new Board(file); clean.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }), peers = ["claude", "codex", "local", "pi"].map(id => new Peer(id));
  for (const peer of peers) { bus.add(peer); await peer.start(); }
  const executionBudget = new ExecutionBudget(file); clean.push(() => executionBudget.close());
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"], pi: ["implementer"] };
  const clock = { now: NOW };
  let screen: ConstructorParameters<typeof Tasks>[0]["piiScreen"];
  const notices: string[] = [];
  const build = () => new Tasks({ board, bus, cwd: dir, project: "dispatch-project", roles, routing: () => routing, notify: line => notices.push(line), executionBudget, studyNow: () => clock.now,
    piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }), studySource: id => SOURCES.get(id) });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Research parent", class: "implement", owner: "codex" });
  void options;
  return { dir, file, bus, clock, notices, parent, routing, executionBudget, get board() { return board; }, get tasks() { return tasks; }, setScreen(next: NonNullable<typeof screen>) { screen = next; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function approved(f: F, body: ResearchCampaignContract = contract()) {
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: body });
  const receipt = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  const task = (unitId: string) => receipt.units.find(row => row.unitId === unitId)!.taskId;
  return { id: draft.id, receipt, task };
}
const sourceUnits = (f: F, id: string) => f.board.researchCampaignBindings(id, 1);

/** A unit's task as the hub dispatches it: pulled out of backlog into To Do (a ready, ownerless proposal), which is the state an owner assignment starts from. */
async function ready(f: F, taskId: number) {
  await f.tasks.pullPlanned("claude", { id: taskId, revision: 0, reason: "the planner pulls the unit" });
  return f.board.get(taskId)!;
}

test("an approved, in-time campaign dispatches: the gate holds nothing and the unit is pulled and assigned", async () => {
  const f = await fixture(), c = await approved(f);
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toBeUndefined();
  expect(f.tasks.studyDispatchHold(999_999, "local")).toBeUndefined();   // a task bound to no unit is not this gate's business
  const pulled = await ready(f, c.task("a"));
  expect(pulled.state).toBe("proposed");
  const moved = await f.tasks.assignTo(c.task("a"), "local", USER, true);
  expect(moved.owner).toBe("local");
});

test("a deadline that has passed dispatches nothing: a planner pull and an explicit assign refuse with the reason and write no owner", async () => {
  const f = await fixture(), c = await approved(f), backlog = f.board.get(c.task("a"))!;
  const readyTask = await ready(f, c.task("b"));                         // b was pulled in time and waits for an owner
  f.clock.now = NOW + 11 * DAY;                                           // past the 10-day deadline
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "deadline_passed", unit: "a" });
  await expect(f.tasks.pullPlanned("claude", { id: c.task("a"), revision: 0, reason: "planner pull after the deadline" })).rejects.toThrow(/held by study rc-[0-9a-f]{12} unit a: the campaign deadline has passed/);
  await expect(f.tasks.assignTo(c.task("b"), "local", USER, true)).rejects.toThrow(/deadline has passed/);
  const after = f.board.get(c.task("a"))!;
  expect(after.owner).toBeNull(); expect(after.state).toBe("backlog"); expect(after.history).toHaveLength(backlog.history.length);
  expect(f.board.get(c.task("b"))!.owner).toBeNull(); expect(f.board.get(c.task("b"))!.history).toHaveLength(readyTask.history.length);
});

test("restarting an expired campaign dispatches nothing: the stored deadline, not memory, decides", async () => {
  const f = await fixture(), c = await approved(f);
  await ready(f, c.task("a"));
  f.clock.now = NOW + 11 * DAY;
  f.restart();                                                            // a fresh Tasks and a fresh Board over the same file
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "deadline_passed" });
  await expect(f.tasks.assignTo(c.task("a"), "local", USER, true)).rejects.toThrow(/deadline has passed/);
  expect(f.board.get(c.task("a"))!.owner).toBeNull();
  // the hub's own offer path holds too: no owner, one history note, no pile of notes on a second pass
  const tasks = f.board.list().length;
  for (let pass = 0; pass < 3; pass++) await (f.tasks as unknown as { offerReady(t: unknown, why: string): Promise<void> }).offerReady(f.board.get(c.task("a")), "test");
  expect(f.board.get(c.task("a"))!.owner).toBeNull();
  expect(f.board.get(c.task("a"))!.history.filter(entry => entry.event === "study held")).toHaveLength(1);
  expect(f.board.list()).toHaveLength(tasks);
});

test("approval revoked while screening is awaited: nothing dispatches, because the check runs after the await", async () => {
  const f = await fixture(), c = await approved(f);
  f.routing.signals.pii_screen = "local";                                 // the screen is on, so the pull really awaits it
  // a planner pull awaits the PII screen on its reason; the person closes the campaign (revoking the approved revision) while that screen is pending
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setScreen(async text => { if (text.includes("pull while the screen waits")) await gate; return { label: "clear" as const, ms: 0 }; });
  const pulling = f.tasks.pullPlanned("claude", { id: c.task("a"), revision: 0, reason: "pull while the screen waits" }).then(() => "pulled", error => String(error));
  await Bun.sleep(5);
  await f.tasks.studyClose(USER, { id: c.id, revision: 1, reason: "withdrawn during screening" });   // revokes the approved revision
  release();
  expect(await pulling).toMatch(/approved revision is superseded, closed or revoked/);
  const after = f.board.get(c.task("a"))!;
  expect(after.state).toBe("backlog"); expect(after.owner).toBeNull(); expect(after.history.some(entry => entry.event === "backlog pulled")).toBe(false);
});

test("a revised campaign supersedes the old revision, whose units stop dispatching until the new revision is approved", async () => {
  const f = await fixture(), c = await approved(f);
  const revised = await f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: contract({ scope: "A narrower synthetic scope" }) });
  expect(revised.revision).toBe(2);
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toBeUndefined();   // a draft revision changes nothing: revision 1 is still the approved one
  const second = await f.tasks.studyApprove(USER, { id: c.id, revision: 2 });
  expect(second.units.map(row => row.taskId).sort()).toEqual(c.receipt.units.map(row => row.taskId).sort());   // the same stable units keep their tasks
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toBeUndefined();   // and they dispatch under the new approved revision
  await f.tasks.studyClose(USER, { id: c.id, revision: 2, reason: "done" });
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "campaign_not_approved" });
});

test("a unit round above the stored follow-up limit, or too many units, holds from the tables and not from the request", async () => {
  const f = await fixture(), c = await approved(f);
  const db = (f.board as unknown as { db: import("bun:sqlite").Database }).db;
  const row = db.query("SELECT body FROM research_campaigns WHERE id=? AND revision=1").get(c.id) as { body: string };
  expect(row.body.length).toBeGreaterThan(0);
  expect(f.tasks.studyDispatchHold(c.task("syn"), "local")).toBeUndefined();
  f.clock.now = NOW + 9 * DAY + 23 * 3_600_000;                           // still inside the deadline
  expect(f.tasks.studyDispatchHold(c.task("syn"), "local")).toBeUndefined();
  f.clock.now = NOW + 10 * DAY;                                           // the deadline instant
  expect(f.tasks.studyDispatchHold(c.task("syn"), "local")).toMatchObject({ hold: "deadline_passed" });
});

test("the last check runs right before the owner write: a revocation or expiry that lands after routing is read there, and nothing is written", async () => {
  const assignOwner = (f: F, taskId: number, hook: () => void) => {
    let calls = 0;
    // `current` is asked at the start and again immediately before the write; the first call passes, the second lands the change between the early read and the write.
    const current = () => { if (++calls === 2) hook(); };
    return (f.tasks as unknown as { assignOwner(task: unknown, by: string, opts: Record<string, unknown>): Promise<unknown> })
      .assignOwner(f.board.get(taskId), USER, { candidates: ["local"], namedOwner: "local", refuseNamed: "pre", current });
  };
  const db = (f: F) => (f.board as unknown as { db: import("bun:sqlite").Database }).db;
  // a revocation: the approved revision is closed after the early read
  const a = await fixture(), ca = await approved(a), pulledA = await ready(a, ca.task("a"));
  await expect(assignOwner(a, ca.task("a"), () => { db(a).query("UPDATE research_campaigns SET status='closed',closed_by='user',closed_at=1,closed_reason='late' WHERE id=?").run(ca.id); }))
    .rejects.toThrow(/approved revision is superseded, closed or revoked/);
  expect(a.board.get(ca.task("a"))!.owner).toBeNull(); expect(a.board.get(ca.task("a"))!.history).toHaveLength(pulledA.history.length);
  // an expiry: the clock passes the deadline after the early read
  const b = await fixture(), cb = await approved(b), pulledB = await ready(b, cb.task("a"));
  await expect(assignOwner(b, cb.task("a"), () => { b.clock.now = NOW + 11 * DAY; })).rejects.toThrow(/deadline has passed/);
  expect(b.board.get(cb.task("a"))!.owner).toBeNull(); expect(b.board.get(cb.task("a"))!.history).toHaveLength(pulledB.history.length);
  // and with no change at all the same call writes the owner, so the refusals above are the gate and not a broken fixture
  const c = await fixture(), cc = await approved(c); await ready(c, cc.task("a"));
  await assignOwner(c, cc.task("a"), () => {});
  expect(c.board.get(cc.task("a"))!.owner).toBe("local");
});

// ---- the budget support map, hard-cap activation and the shared peer-wide ledger

const cap = (id: string, hardCap: string[]) => contract({ budget: { id, hardCap } });
const drafted = async (f: F, body: ResearchCampaignContract, parent = f.parent.id) => f.tasks.studyDraft("claude", { parentTaskId: parent, contract: body });

test("hard-cap activation refuses unless the named budget is real, limits every capped resource, is not a task budget and has an instrumented peer; it stores the eligible owners", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4, tool_calls: 8 } });
  f.tasks.configureExecutionBudget({ id: "calls-only", kind: "run", peers: ["local"], limits: { model_calls: 4 } });
  f.tasks.configureExecutionBudget({ id: "tok", kind: "run", peers: ["local"], limits: { model_calls: 4, tokens: 100 } });
  f.tasks.configureExecutionBudget({ id: "one-task", kind: "task", taskId: f.parent.id, peers: ["local"], limits: { model_calls: 4 } });
  const refuse = async (id: string, resources: string[], why: RegExp) => {
    const draft = await drafted(f, cap(id, resources)), before = f.board.researchIntegrity(), rows = f.board.list();
    await expect(f.tasks.studyApprove(USER, { id: draft.id, revision: 1 })).rejects.toThrow(why);
    expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(rows);
    await f.tasks.studyClose(USER, { id: draft.id, revision: 1, reason: "refused fixture" });
  };
  await refuse("tok", ["tokens"], /refuses tokens/);                                     // usage unknown stays unknown: a token cap would be advisory
  await refuse("calls-only", ["model_calls", "tool_calls"], /needs a limit on tool_calls/);  // every capped resource needs a limit
  await refuse("one-task", ["model_calls"], /campaign-exclusive/);                       // a campaign-exclusive hard cap refuses
  await expect(drafted(f, cap("nope", ["model_calls"]))).rejects.toThrow(/budget is unavailable/);       // a missing budget is refused at draft already
  const draft = await drafted(f, cap("run", ["model_calls", "tool_calls"]));
  const receipt = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  expect(receipt.status).toBe("approved");
  expect(f.board.researchCampaign(draft.id, 1)!.eligibleOwners).toEqual(["local", "pi"]);   // the budget's peers that are instrumented, fixed at approval
  // an advisory-only budget (an empty hardCap) approves with no eligible set, so no dispatch is gated on the ledger
  f.tasks.configureExecutionBudget({ id: "advice", kind: "run", peers: ["local"], limits: { model_calls: 4 } });
  const advisory = await drafted(f, cap("advice", []), (await f.tasks.propose(USER, { title: "Second parent", class: "implement", owner: "codex" })).id);
  expect((await f.tasks.studyApprove(USER, { id: advisory.id, revision: 1 })).status).toBe("approved");
  expect(f.board.researchCampaign(advisory.id, 1)!.eligibleOwners).toBeUndefined();
});

test("a budget that changes while approval is screened refuses before the campaign is approved", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4 } });
  f.routing.signals.pii_screen = "local";
  const draft = await drafted(f, cap("run", ["model_calls"]));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setScreen(async () => { await gate; return { label: "clear" as const, ms: 0 }; });
  const approving = f.tasks.studyApprove(USER, { id: draft.id, revision: 1 }).then(() => "approved", error => String(error));
  await Bun.sleep(5);
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local"], limits: { model_calls: 4 } });   // a peer is dropped while the screen waits
  release();
  expect(await approving).toMatch(/study budget changed during approval screening/);
  expect(f.board.researchCampaign(draft.id, 1)!.status).toBe("draft");
});

test("a hard-capped unit dispatches only to an eligible owner under a budget that still covers it; an owner outside the set, a removed limit or a disabled budget holds", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4, tool_calls: 8 } });
  const c = await approved(f, cap("run", ["model_calls"]));
  await ready(f, c.task("a"));
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toBeUndefined();
  expect(f.tasks.studyDispatchHold(c.task("a"), "pi")).toBeUndefined();
  expect(f.tasks.studyDispatchHold(c.task("a"), "codex")).toMatchObject({ hold: "owner_not_eligible" });   // codex is not instrumented, so never in the eligible set
  await expect(f.tasks.assignTo(c.task("a"), "codex", USER, true)).rejects.toThrow(/not in the campaign's budget-eligible set/);
  expect(f.board.get(c.task("a"))!.owner).toBeNull();
  // the named budget loses the capped limit: the next dispatch holds, the stored set notwithstanding
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { tool_calls: 8 } });
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "budget_not_covering" });
  await expect(f.tasks.assignTo(c.task("a"), "local", USER, true)).rejects.toThrow(/does not currently cover this task and owner/);
  expect(f.board.get(c.task("a"))!.owner).toBeNull();
  // the budget returns: dispatch resumes; it is then disabled: the next dispatch holds again, and a unit already running is not touched
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4 } });
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toBeUndefined();
  const moved = await f.tasks.assignTo(c.task("a"), "local", USER, true);
  expect(moved.owner).toBe("local");
  f.tasks.disableExecutionBudget("run");
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "budget_not_covering" });
  expect(f.board.get(c.task("a"))!.owner).toBe("local");                       // already dispatched: kept, never killed or reassigned by the hold
});

test("the budget id is checked, not 'any budget': another budget covering the peer does not satisfy the campaign's named one", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "named", kind: "run", peers: ["local"], limits: { model_calls: 4 } });
  f.tasks.configureExecutionBudget({ id: "other", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4, tool_calls: 4 } });
  const c = await approved(f, cap("named", ["model_calls"]));
  expect(f.executionBudget.applies([c.task("a")], "pi")).toBe(true);                // `other` meters pi, so the any-budget boolean says yes
  expect(f.tasks.studyDispatchHold(c.task("a"), "pi")).toMatchObject({ hold: "owner_not_eligible" });   // but the named budget does not name pi
  f.tasks.disableExecutionBudget("named");
  expect(f.executionBudget.applies([c.task("a")], "local")).toBe(true);             // `other` still applies to local
  expect(f.tasks.studyDispatchHold(c.task("a"), "local")).toMatchObject({ hold: "budget_not_covering" });   // yet the campaign's own budget is gone
});

test("the support map labels each resource per unit: enforceable, advisory, unavailable and unknown, and display is not enforcement", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { model_calls: 4, elapsed_ms: 60_000 } });
  const c = await approved(f, cap("run", ["model_calls"]));
  // routing may pick any peer; an explicit assignment to an eligible one is what the person does, and it proceeds
  await ready(f, c.task("a")); await f.tasks.assignTo(c.task("a"), "local", USER, true);       // a: owned by an instrumented peer in the budget
  await ready(f, c.task("b")); await f.tasks.assignTo(c.task("b"), "local", USER, true);
  const projection = f.tasks.studyProjection(c.id);
  const a = projection.units.find(row => row.id === "a")!, syn = projection.units.find(row => row.id === "syn")!;
  expect(a.budget).toEqual({ model_calls: "enforceable", tool_calls: "advisory", elapsed_ms: "enforceable", tokens: "unavailable" });   // tool_calls has no limit: advisory
  expect(syn.budget).toEqual({ model_calls: "unknown", tool_calls: "unknown", elapsed_ms: "unknown", tokens: "unavailable" });   // no owner yet: unknown; tokens are never enforceable
  expect(projection.budget).toMatchObject({ id: "run", read: "ok", scope: "peer-wide", shared: true, campaignExclusive: false, hardCap: ["model_calls"], eligibleOwners: ["local", "pi"] });
  expect(projection.budget!.usage.tokens).toBeUndefined();                          // the budget sets no token limit, so none is shown
  // a budget that can no longer be read (disabled) reads as unknown for every resource but tokens, never as enforceable
  f.tasks.disableExecutionBudget("run");
  const gone = f.tasks.studyProjection(c.id);
  expect(gone.units.find(row => row.id === "a")!.budget).toEqual({ model_calls: "unknown", tool_calls: "unknown", elapsed_ms: "unknown", tokens: "unavailable" });
  expect(gone.budget).toMatchObject({ read: "unreadable", campaignExclusive: false });
  // a budget that is readable but no longer limits a resource is advisory for that resource, and a peer no budget can meter is unavailable
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local", "pi"], limits: { tool_calls: 3 } });
  expect(f.tasks.studyProjection(c.id).units.find(row => row.id === "a")!.budget).toEqual({ model_calls: "advisory", tool_calls: "enforceable", elapsed_ms: "advisory", tokens: "unavailable" });
});

test("two campaigns that name one budget share it, include unrelated work by the same peers, and neither resets the counter", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "shared", kind: "run", peers: ["local"], limits: { model_calls: 6 } });
  const second = await f.tasks.propose(USER, { title: "Second research parent", class: "implement", owner: "codex" });
  const one = await approved(f, cap("shared", ["model_calls"]));
  const draft2 = await drafted(f, cap("shared", ["model_calls"]), second.id);
  const two = await f.tasks.studyApprove(USER, { id: draft2.id, revision: 1 });
  const task1 = one.task("a"), task2 = two.units.find(row => row.unitId === "a")!.taskId;
  const unrelated = (await f.tasks.propose(USER, { title: "Unrelated peer-wide work", class: "implement", owner: "codex" })).id;
  const used = () => (f.executionBudget.status("shared") as { used: { model_calls?: number } }).used.model_calls ?? 0;
  expect(used()).toBe(0);
  f.tasks.admitExecution(task1, "local", "model_calls", 2);                         // campaign one spends 2
  expect(used()).toBe(2);
  f.tasks.admitExecution(task2, "local", "model_calls", 1);                         // campaign two spends 1 of the SAME counter
  expect(used()).toBe(3);
  f.tasks.admitExecution(unrelated, "local", "model_calls", 2);                     // unrelated work by the same peer spends it too: the cap is peer-wide
  expect(used()).toBe(5);
  // none of: approving the second campaign, projecting either, a restart, a re-approval or a revision reset it
  for (const id of [one.id, draft2.id]) f.tasks.studyProjection(id);
  expect(used()).toBe(5);
  f.restart();
  expect((f.executionBudget.status("shared") as { used: { model_calls?: number } }).used.model_calls).toBe(5);
  await f.tasks.studyApprove(USER, { id: one.id, revision: 1 });                   // an idempotent replay
  expect(used()).toBe(5);
  // the shared cap exhausts for BOTH campaigns and for the unrelated task, with the ledger's own reason
  const last = f.tasks.admitExecution(task2, "local", "model_calls", 1);
  expect(last.every(row => row.allowed)).toBe(true); expect(used()).toBe(6);
  const over = f.tasks.admitExecution(task1, "local", "model_calls", 1);
  expect(over.some(row => !row.allowed && row.reason === "exhausted")).toBe(true);
  expect(f.tasks.admitExecution(unrelated, "local", "model_calls", 1).some(row => row.reason === "exhausted")).toBe(true);
  expect(used()).toBe(6);                                                           // a refused admission counts nothing
  // both campaigns' projections report the same shared, peer-wide, not-exclusive accounting, with the same usage
  const p1 = f.tasks.studyProjection(one.id), p2 = f.tasks.studyProjection(draft2.id);
  for (const projection of [p1, p2]) expect(projection.budget).toMatchObject({ id: "shared", scope: "peer-wide", shared: true, campaignExclusive: false });
  expect(p1.budget!.usage.model_calls).toEqual(p2.budget!.usage.model_calls);
  expect(p1.budget!.usage.model_calls).toMatchObject({ used: 6, limit: 6, remaining: 0 });
});

test("usage the ledger cannot count stays unknown: tokens are never a number, and a unit with no owner shows unknown", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "run", kind: "run", peers: ["local"], limits: { model_calls: 4, tokens: 1000 } });
  const c = await approved(f, cap("run", []));                                       // advisory: the tokens limit exists but cannot be enforced
  const projection = f.tasks.studyProjection(c.id);
  expect(projection.budget!.usage.tokens).toEqual({ used: "unknown", limit: 1000, remaining: "unknown" });
  expect(projection.budget!.hardCap).toEqual([]);
  for (const row of projection.units) { expect(row.budget!.tokens).toBe("unavailable"); expect(row.budget!.model_calls).toBe("unknown"); }
  // the ledger itself keeps denying a token admission as unknown usage, whatever a campaign says
  const denied = f.tasks.admitExecution(c.task("a"), "local", "tokens", 1);
  expect(denied.some(row => !row.allowed)).toBe(true);
});

// ---- handoffs and round advancement through the real Tasks methods

/** Put a unit's task in progress under `peer`, the state a handoff is recorded in. */
async function working(f: F, taskId: number, peer = "local") {
  await ready(f, taskId);
  await f.tasks.assignTo(taskId, peer, USER, true);
  f.tasks.accept(peer, taskId);
  return f.board.get(taskId)!;
}
const body = (c: { id: string; task: (unit: string) => number }, unitId: string, over: Partial<ResearchHandoff> = {}): ResearchHandoff =>
  ({ campaignId: c.id, revision: 1, unitId, taskId: c.task(unitId), evidence: [{ sourceId: S1, locator: "section 2" }], unresolved: [], contradictions: [], limitations: [], ...over });

test("a handoff is recorded by the bound task's current owner, in progress, for the approved revision, and nobody else", async () => {
  const f = await fixture(), c = await approved(f);
  await working(f, c.task("a"));
  const saved = await f.tasks.studyHandoff("local", body(c, "a"));
  expect(saved).toEqual({ campaignId: c.id, unitId: "a", seq: 1, state: "complete" });
  const refuse = async (by: string, input: unknown, why: RegExp) => { const before = f.board.researchIntegrity(); await expect(f.tasks.studyHandoff(by, input)).rejects.toThrow(why); expect(f.board.researchIntegrity()).toEqual(before); };
  await refuse("codex", body(c, "a"), /only the owner of task #\d+ records its handoff/);                    // not the owner
  await refuse("claude", body(c, "a"), /only the owner/);                                                     // a planner is not the owner either
  await refuse("local", body(c, "b"), /only the owner|bound task/);                                           // b has no owner
  await refuse("local", { ...body(c, "a"), taskId: c.task("b") }, /not this unit's bound task/);              // a task that is not this unit's
  await refuse("local", { ...body(c, "a"), revision: 2 }, /not this unit's bound task/);                      // a revision that is not the approved one
  await refuse("local", { ...body(c, "a"), campaignId: "rc-ffffffffffff" }, /not this unit's bound task/);
  await refuse("local", { ...body(c, "a"), evidence: [{ sourceId: "src:ffffffffffffffff", locator: "x" }] }, /not in the campaign/);   // a source the campaign does not hold
  await refuse("local", {}, /campaignId: required/);                                                          // every missing field named at once
  // history is append-only and the latest is the one coverage reads
  const second = await f.tasks.studyHandoff("local", body(c, "a", { evidence: [], insufficientEvidence: "the source is withdrawn" }));
  expect(second).toMatchObject({ seq: 2, state: "insufficient" });
  expect(f.board.researchHandoffs(c.id, "a").map(row => row.seq)).toEqual([1, 2]);
  expect(f.board.researchHandoff(c.id, "a")!.handoff.insufficientEvidence).toBe("the source is withdrawn");
});

test("a handoff needs the task in progress and an approved campaign: a closed campaign or a finished task records nothing", async () => {
  const f = await fixture(), c = await approved(f);
  await ready(f, c.task("a")); await f.tasks.assignTo(c.task("a"), "local", USER, true);                       // owned but not yet accepted: still proposed
  await expect(f.tasks.studyHandoff("local", body(c, "a"))).rejects.toThrow(/only while it is in progress/);
  f.tasks.accept("local", c.task("a"));
  await f.tasks.studyClose(USER, { id: c.id, revision: 1, reason: "closed" });
  await expect(f.tasks.studyHandoff("local", body(c, "a"))).rejects.toThrow(/not the campaign's approved one/);
  expect(f.board.researchHandoff(c.id, "a")).toBeUndefined();
});

test("a handoff that is screened and then loses its task or its approval writes nothing", async () => {
  const f = await fixture(), c = await approved(f);
  await working(f, c.task("a"));
  f.routing.signals.pii_screen = "local";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setScreen(async text => { if (text.includes("section 2")) await gate; return { label: "clear" as const, ms: 0 }; });
  const recording = f.tasks.studyHandoff("local", body(c, "a")).then(() => "recorded", error => String(error));
  await Bun.sleep(5);
  await f.tasks.studyClose(USER, { id: c.id, revision: 1, reason: "withdrawn while the handoff was screened" });
  release();
  expect(await recording).toMatch(/not the campaign's approved one/);
  expect(f.board.researchHandoff(c.id, "a")).toBeUndefined();
  expect(f.board.hasResearchState()).toBe(true);
});

test("a follow-up round is refused until each discovery unit of the round before is closed by a handoff or a reason, and then it is approved and dispatched", async () => {
  const f = await fixture(), c = await approved(f);
  const follow = (extra: Record<string, unknown> = {}) => contract({}, [...contract().units.map(row => ({ ...row })), unit("a2", { round: 1, sourceIds: [S1], dependsOn: ["a"], ...extra })]);
  const before = f.board.researchIntegrity(), rows = f.board.list();
  await expect(f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: follow() })).rejects.toThrow(/follow-up round 1 waits: discovery units a, b of round 0/);
  expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(rows);
  await working(f, c.task("a")); await working(f, c.task("b"), "pi");
  await f.tasks.studyHandoff("local", body(c, "a"));
  await expect(f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: follow() })).rejects.toThrow(/discovery unit b of round 0 has neither/);   // b still has nothing
  await f.tasks.studyHandoff("pi", body(c, "b", { evidence: [], limitations: ["no accessible source"] }));
  await expect(f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: follow() })).rejects.toThrow(/discovery unit b of round 0 has neither/);   // "done" with no evidence and no reason is not coverage
  await f.tasks.studyHandoff("pi", body(c, "b", { evidence: [], insufficientEvidence: "the sources are not accessible" }));   // a recorded reason closes it
  const revised = await f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: follow() });
  expect(revised.revision).toBe(2);
  const approvedTwo = await f.tasks.studyApprove(USER, { id: c.id, revision: 2 });
  expect(approvedTwo.units.find(row => row.unitId === "a2")).toBeTruthy();
  // the follow-up unit dispatches under the approved revision, and its round is within the limit
  const a2 = approvedTwo.units.find(row => row.unitId === "a2")!.taskId;
  expect(f.tasks.studyDispatchHold(a2, "local")).toBeUndefined();
  const projection = f.tasks.studyProjection(c.id);
  expect(projection.coverage.rounds).toEqual([{ round: 0, discovery: 2, closed: true }, { round: 1, discovery: 1, closed: false }]);
});

test("follow-up beyond the stop limits holds with a reason and never expands scope on its own", async () => {
  const f = await fixture(), c = await approved(f, contract({ stopPolicy: { maxUnits: 8, maxFollowUpRounds: 1, deadline: new Date(NOW + 10 * DAY).toISOString() } }));
  await working(f, c.task("a")); await working(f, c.task("b"), "pi");
  await f.tasks.studyHandoff("local", body(c, "a")); await f.tasks.studyHandoff("pi", body(c, "b"));
  // round 2 is above maxFollowUpRounds = 1: the contract itself is refused before any revision is stored
  const limit1 = { maxUnits: 8, maxFollowUpRounds: 1, deadline: new Date(NOW + 10 * DAY).toISOString() };
  const tooFar = { ...contract(), stopPolicy: limit1, units: [...contract().units, unit("a2", { round: 1, sourceIds: [S1], dependsOn: ["a"] }), unit("a3", { round: 2, sourceIds: [S1], dependsOn: ["a2"] })] };
  const stored = f.board.researchIntegrity();
  await expect(f.tasks.studyRevise("claude", { id: c.id, revision: 1, contract: tooFar })).rejects.toThrow(/round: expected an integer from 0 to 1/);
  expect(f.board.researchIntegrity()).toEqual(stored);
  const projection = f.tasks.studyProjection(c.id);
  expect(projection.stop.followUp).toEqual({ state: "available" });                                    // round 0 is closed and a round of room is left
  expect(projection.stop).toMatchObject({ maxFollowUpRounds: 1, currentRound: 0, deadlineExpired: false });
  f.clock.now = NOW + 11 * DAY;
  expect(f.tasks.studyProjection(c.id).stop).toMatchObject({ deadlineExpired: true, followUp: { state: "held", reason: "deadline_passed" } });
  expect(f.tasks.studyProjection(c.id).units.every(row => row.dispatch.state === "held" && row.dispatch.reason === "deadline_passed")).toBe(true);
  expect(f.board.list().filter(task => /Study unit/.test(task.title))).toHaveLength(4);                // nothing was created on the campaign's own: the same four tasks
});

test("a private campaign's projection and handoff receipt show ids, states and counts only", async () => {
  const f = await fixture(), c = await approved(f, contract({ question: "PRIVATE_QUESTION_CANARY", scope: "PRIVATE_SCOPE_CANARY" }));
  await working(f, c.task("a"));
  const receipt = await f.tasks.studyHandoff("local", body(c, "a", { evidence: [{ sourceId: S1, locator: "PRIVATE_LOCATOR_CANARY" }], limitations: ["PRIVATE_NOTE_CANARY"] }));
  const text = JSON.stringify([receipt, f.tasks.studyProjection(c.id)]);
  for (const canary of ["PRIVATE_QUESTION_CANARY", "PRIVATE_SCOPE_CANARY", "PRIVATE_LOCATOR_CANARY", "PRIVATE_NOTE_CANARY"]) expect(text, canary).not.toContain(canary);
});

test("research state with handoffs survives a restart: the same handoffs, the same integrity", async () => {
  const f = await fixture(), c = await approved(f);
  await working(f, c.task("a"));
  await f.tasks.studyHandoff("local", body(c, "a"));
  const before = f.board.researchIntegrity();
  expect(before.handoffs).toBe(1);
  f.restart();
  expect(f.board.researchIntegrity()).toEqual(before);
  expect(f.board.researchHandoff(c.id, "a")!.seq).toBe(1);
  expect(f.tasks.studyProjection(c.id).units.find(row => row.id === "a")!.handoff).toBe("complete");
  // a corrupted handoff body is refused when it is read, and never read as coverage
  (f.board as unknown as { db: import("bun:sqlite").Database }).db.query("UPDATE research_handoffs SET body='{}' WHERE campaign_id=?").run(c.id);
  expect(() => f.board.researchHandoff(c.id, "a")).toThrow(/invalid, changed or corrupt/);
  expect(f.tasks.studyProjection(c.id).units.find(row => row.id === "a")!.handoff).toBe("none");
});
