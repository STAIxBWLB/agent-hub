import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { CODE_SCOPE_LINE, evidenceOnlyNotice, type ReviewScope } from "../src/hub/review-scope.ts";
import { taskSample } from "../src/hub/sdlc-metrics.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub#852 (task #514), AC2 and the amended AC3: a code-scope reviewer's request says what it cannot do, its approval records the scope, and its
// changes_requested is always recorded. Without an open structured finding it is evidence-only: no rejection, no escalation, one conductor notice.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const head = "a".repeat(40);
class Peer extends BasePeer { received: Envelope[] = []; async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(envs: Envelope[]) { this.received.push(...envs); } }

function rig(scope: ReviewScope | undefined, opts: { checkPassed?: boolean; conductor?: boolean; escalateAfter?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-scope-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles: Record<string, string[]> = { codex: ["implementer"], "codex-review": ["reviewer"], ...(opts.conductor === false ? {} : { director: ["conductor"] }) };
  const tasks = new Tasks({ cwd: dir, board, bus, roles, project: "review-scope", routing: () => loadRouting(dir), reviewOnly: peer => peer === "codex-review", ...(scope ? { reviewScope: () => scope } : {}),
    ...(opts.escalateAfter ? { escalateAfter: () => opts.escalateAfter! } : {}), splitProfile: () => "review-scope-fixture", notify: text => notices.push(text) });
  const task = board.propose("user", { title: "finished implementation", class: "implement" });
  board.update(task.id, "user", "assigned", { owner: "codex", reviewer: "codex-review", refs: { commit: head } }, undefined, { profile: "review-scope-fixture" });
  board.update(task.id, "codex", "accepted", { state: "in_progress" });
  if (opts.checkPassed) board.update(task.id, "hub", "check passed", {}, "scripts/check.sh -> exit 0\ncheck: OK");
  const reviewer = new Peer("codex-review"), owner = new Peer("codex"), director = new Peer("director"); bus.add(reviewer); bus.add(owner); bus.add(director);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const body = async () => { await reviewer.start(); await owner.start(); await director.start(); await tasks.done("codex", task.id, "done"); return reviewer.received.filter(env => env.kind === "review").at(-1)?.body ?? ""; };
  const again = async () => { await tasks.done("codex", task.id, "fixed"); };
  const conductorNotices = () => director.received.filter(env => env.from === "hub" && env.kind === "task" && env.body.includes("evidence-only"));
  return { tasks, board, task, notices, body, again, conductorNotices, owner };
}
const OPEN = [{ id: "bug-1", pass: "bugs", severity: "important", disposition: "open" }];
const VERIFICATION = ["Required exact-head CI is not green per hub brief; provide green required checks before merge."];

test("AC2: a code reviewer's request replaces every check and CI line with one fixed line; a full reviewer keeps today's text", async () => {
  const code = await rig("code").body();
  expect(code).toContain(CODE_SCOPE_LINE);
  for (const gone of ["No check ran for this class", "run the affected tests yourself", "Hub-verified", "CI passed at this exact head", "exact-head full CI is not green"]) expect(code, gone).not.toContain(gone);
  expect((code.match(/Your sandbox cannot run tests or read CI/g) ?? []).length).toBe(1);
  expect(code).toContain("structured finding with an id"); // the amendment: report every code defect as a finding
  expect(code).toContain("recorded as evidence-only");
  expect(code).toContain("Findings are only for defects in the reviewed code, docs or tests.");
  expect(code).toContain("A missing check result, CI result, test run or PR/branch identity is an evidence request: put it in unmet, never in findings.");
  expect(code).not.toContain("do not list tests, check output or CI as unmet");
  // Everything else about the checklist is as before.
  expect(code).toContain("Map the changed signatures and call sites to");
  expect(code).toContain("List what is unmet in hub_review's unmet, one item each.");
  for (const scope of ["full", undefined] as const) {
    const full = await rig(scope).body();
    expect(full, String(scope)).toContain("No check ran for this class: run the affected tests yourself.");
    expect(full, String(scope)).not.toContain("Your sandbox cannot run tests or read CI"); expect(full, String(scope)).not.toContain("evidence-only");
  }
  expect(await rig("full", { checkPassed: true }).body()).toContain("Check result: scripts/check.sh -> exit 0");
  const codeWithCheck = await rig("code", { checkPassed: true }).body();
  expect(codeWithCheck).toContain(CODE_SCOPE_LINE); expect(codeWithCheck).not.toContain("Check result:");
});

test("AC3: a code reviewer's approval records scope code in the history, and a full reviewer's verdict records none", async () => {
  const code = rig("code"); await code.body();
  const approved = await code.tasks.review("codex-review", code.task.id, "approved", "the code matches the plan");
  expect(approved.state).toBe("approved");
  expect(approved.history.findLast(entry => entry.event === "approved")).toMatchObject({ by: "codex-review", reviewScope: "code" });
  const full = rig("full"); await full.body();
  expect((await full.tasks.review("codex-review", full.task.id, "approved", "ok")).history.findLast(entry => entry.event === "approved")?.reviewScope).toBeUndefined();
  const none = rig(undefined); await none.body();
  expect((await none.tasks.review("codex-review", none.task.id, "approved", "ok")).history.findLast(entry => entry.event === "approved")?.reviewScope).toBeUndefined();
});

test("AC3: a code reviewer's changes_requested with no open finding is recorded as evidence-only: not counted, the task returns to the owner, the conductor is told once", async () => {
  const f = rig("code"); await f.body();
  const result = await f.tasks.review("codex-review", f.task.id, "changes_requested", "cannot verify", VERIFICATION);
  expect(result.rejections).toBe(0);                                   // not counted
  expect(result.state).toBe("in_progress");                            // returned to the owner as usual
  const entry = result.history.findLast(item => item.event === "changes_requested")!;
  expect(entry).toMatchObject({ by: "codex-review", reviewScope: "code", evidenceOnly: true });  // recorded, never refused
  expect(entry.note).toContain("Unmet:");
  expect(f.conductorNotices()).toHaveLength(1);                        // one task-weight notice to the conductor
  expect(f.conductorNotices()[0]!.body).toBe(evidenceOnlyNotice(f.task.id, "codex-review"));
  expect(f.conductorNotices()[0]!.body).not.toContain("CI is not green");   // ids only: nothing of the review text
  // The owner is still told, as today.
  expect(f.owner.received.some(env => env.body.includes("requests changes"))).toBe(true);
});

test("AC3: an open finding still counts as today: two counted rejections reach an escalate_after of 2, and an evidence-only round in between does not move the count", async () => {
  const f = rig("code", { escalateAfter: 2 }); await f.body();
  const first = await f.tasks.review("codex-review", f.task.id, "changes_requested", "defect one", ["validateInstances does not refuse a non-string model."], undefined, undefined, OPEN);
  expect(first.rejections).toBe(1);
  await f.again();
  const between = await f.tasks.review("codex-review", f.task.id, "changes_requested", "cannot verify", VERIFICATION);
  expect(between.rejections).toBe(1);                                       // evidence-only: neither raised nor reset
  expect(between.history.filter(entry => entry.event === "escalated")).toHaveLength(0);
  await f.again();
  const second = await f.tasks.review("codex-review", f.task.id, "changes_requested", "defect two", ["another real defect"], undefined, undefined, OPEN);
  expect(second.rejections).toBe(2);                                        // the second counted rejection reaches the threshold
  const closing = second.history.filter(entry => entry.event === "changes_requested");
  expect(closing.map(entry => entry.evidenceOnly === true)).toEqual([false, true, false]);
});

test("AC3: three evidence-only verdicts never escalate or count; an open finding then counts as today", async () => {
  const f = rig("code", { escalateAfter: 3 }); await f.body();
  for (let round = 1; round <= 3; round++) {
    const result = await f.tasks.review("codex-review", f.task.id, "changes_requested", `round ${round}`, VERIFICATION);
    expect(result.rejections, `round ${round}`).toBe(0); expect(result.owner).toBe("codex");
    await f.again();
  }
  expect(f.board.get(f.task.id)!.history.filter(entry => entry.event === "escalated")).toHaveLength(0);
  expect(f.board.get(f.task.id)!.history.filter(entry => entry.event === "changes_requested" && entry.evidenceOnly)).toHaveLength(3);
  // An open finding counts as today.
  const counted = await f.tasks.review("codex-review", f.task.id, "changes_requested", "a real defect", ["validateInstances does not refuse a non-string model."], undefined, undefined, OPEN);
  expect(counted.rejections).toBe(1);
  const entry = counted.history.findLast(item => item.event === "changes_requested")!;
  expect(entry.evidenceOnly).toBeUndefined(); expect(entry).toMatchObject({ reviewScope: "code" });
  expect(f.conductorNotices()).toHaveLength(3);                        // one per evidence-only verdict, none for the counted one
});

test("AC3: a code reviewer's fixed or false-positive findings are not open, so that verdict is evidence-only; an open nit still counts", async () => {
  const closed = rig("code"); await closed.body();
  const fixed = await closed.tasks.review("codex-review", closed.task.id, "changes_requested", "ok", [], undefined, undefined, [{ id: "x", pass: "bugs", severity: "important", disposition: "fixed" }]);
  expect(fixed.rejections).toBe(0); expect(fixed.history.findLast(item => item.event === "changes_requested")?.evidenceOnly).toBe(true);
  const nit = rig("code"); await nit.body();
  const counted = await nit.tasks.review("codex-review", nit.task.id, "changes_requested", "a nit", ["a naming nit"], undefined, undefined, [{ id: "n", pass: "compliance", severity: "nit", disposition: "open" }]);
  expect(counted.rejections).toBe(1); expect(counted.history.findLast(item => item.event === "changes_requested")?.evidenceOnly).toBeUndefined();
});

test("AC3: a full reviewer's and a person's changes_requested are never evidence-only, whatever they say", async () => {
  for (const scope of ["full", undefined] as const) {
    const f = rig(scope); await f.body();
    const result = await f.tasks.review("codex-review", f.task.id, "changes_requested", "no tests", VERIFICATION);
    expect(result.rejections, String(scope)).toBe(1); expect(result.history.findLast(item => item.event === "changes_requested")?.evidenceOnly).toBeUndefined();
    expect(f.conductorNotices()).toHaveLength(0);
  }
  const person = rig("code"); await person.body();
  const result = await person.tasks.review("user", person.task.id, "changes_requested", "cannot see CI", VERIFICATION);
  expect(result.rejections).toBe(1); expect(result.history.findLast(item => item.event === "changes_requested")?.evidenceOnly).toBeUndefined();
  expect(person.conductorNotices()).toHaveLength(0);
});

test("AC3: with no conductor the person gets one console notice instead, and the verdict is still recorded", async () => {
  const f = rig("code", { conductor: false }); await f.body();
  const result = await f.tasks.review("codex-review", f.task.id, "changes_requested", "cannot verify", VERIFICATION);
  expect(result.rejections).toBe(0); expect(result.history.findLast(item => item.event === "changes_requested")?.evidenceOnly).toBe(true);
  expect(f.notices.filter(text => text.includes("evidence-only"))).toEqual([evidenceOnlyNotice(f.task.id, "codex-review")]);
});

test("an evidence-only verdict is not a rework round in the SDLC metrics, and an ordinary one still is", () => {
  const history = (rows: { event: string; evidenceOnly?: true }[]) => rows.map((row, index) => ({ at: 1000 + index, ...row }));
  const base = [{ event: "accepted" }, { event: "done" }];
  const approved = { event: "approved" };
  expect(taskSample({ id: 1, history: history([...base, { event: "changes_requested", evidenceOnly: true }, { event: "done" }, approved]) }).rework_rounds).toBe(0);
  expect(taskSample({ id: 2, history: history([...base, { event: "changes_requested" }, { event: "done" }, approved]) }).rework_rounds).toBe(1);
});

const outcomeCases = [
  { name: "code evidence-only", scope: "code", by: "codex-review", findings: undefined, counted: false },
  { name: "code open finding", scope: "code", by: "codex-review", findings: OPEN, counted: true },
  { name: "full reviewer", scope: "full", by: "codex-review", findings: undefined, counted: true },
  { name: "person", scope: "code", by: "user", findings: undefined, counted: true },
] as const;

for (const scenario of outcomeCases) test(`AC3: ${scenario.name} has the correct later caught-review and split outcome`, async () => {
  const f = rig(scenario.scope); await f.body();
  await f.tasks.review(scenario.by, f.task.id, "changes_requested", "review complete", [], undefined, undefined, scenario.findings);
  expect(f.tasks.splitObservations("implement", "codex").map(row => row.outcome)).toEqual(scenario.counted ? ["failed"] : []);
  expect(f.board.outcomes("implement", 0).filter(row => !row.ok)).toHaveLength(scenario.counted ? 1 : 0);
  await f.again();
  await f.tasks.review("codex-review", f.task.id, "approved", "review complete");
  expect(f.board.reviews({ class: "implement" }).filter(row => row.kind === "caught").map(row => row.reviewer)).toEqual(scenario.counted ? [scenario.by] : []);
  expect(f.tasks.splitObservations("implement", "codex").map(row => row.outcome)).toEqual([scenario.counted ? "failed" : "approved"]);
});

for (const scenario of outcomeCases) test(`AC3: ${scenario.name} has the correct reviewer outcome on a later manual escalation`, async () => {
  const f = rig(scenario.scope); await f.body();
  await f.tasks.review(scenario.by, f.task.id, "changes_requested", "review complete", [], undefined, undefined, scenario.findings);
  await f.tasks.escalate("user", f.task.id, "move the work");
  // Only the bound reviewer gets an escalation outcome; a person's verdict does not credit that reviewer.
  const expected = scenario.counted && scenario.by === "codex-review" ? ["codex-review"] : [];
  expect(f.board.reviews({ class: "implement" }).filter(row => row.kind === "escalated").map(row => row.reviewer)).toEqual(expected);
});

test("AC3: an evidence-only fixed report cannot propose a recurring finding from historical open reports; a later open report still can", async () => {
  const f = rig("code"); await f.body();
  // Retained historical reports may predate recurring proposals or an earlier optional proposal failure. They are separate work with no durable marker.
  for (let index = 0; index < 2; index++) {
    const previous = f.board.propose("user", { title: `historical report ${index}`, class: "implement" });
    f.board.update(previous.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "codex-review", refs: { commit: head } });
    f.board.update(previous.id, "codex", "done", { state: "in_review" });
    f.board.update(previous.id, "codex-review", "changes_requested", { state: "changes_requested" }, "historical finding", {
      reviewFindings: { head, items: [{ id: "retained", pass: "bugs", severity: "important", disposition: "open" }] },
    });
  }
  const fixed = [{ id: "retained", pass: "bugs", severity: "important", disposition: "fixed" }];
  const result = await f.tasks.review("codex-review", f.task.id, "changes_requested", "settled earlier finding", [], undefined, undefined, fixed);
  expect(result.history.findLast(row => row.event === "changes_requested")?.evidenceOnly).toBe(true);
  expect(f.board.list("backlog")).toHaveLength(0);
  await f.again();
  await f.tasks.review("codex-review", f.task.id, "changes_requested", "finding is open", [], undefined, undefined, [{ ...fixed[0]!, disposition: "open" }]);
  expect(f.board.list("backlog").map(row => row.detail)).toEqual([expect.stringContaining("Review finding key: bugs:retained")]);
});

test("first-pass approval ignores evidence-only verdicts without changing the actual first-review wait", () => {
  const accepted = { at: 1000, event: "accepted" }, done = { at: 1100, event: "done" };
  const evidence = { at: 1200, event: "changes_requested", evidenceOnly: true as const };
  const sample = (tail: { at: number; event: string; evidenceOnly?: true }[]) => taskSample({ id: 1, history: [accepted, done, evidence, ...tail] });
  const waiting = sample([]);
  expect(waiting.first_pass_approval).toBeNull();
  expect(waiting.acceptance_to_first_review_ms).toBe(200);
  expect(waiting.at).toBe(1200);
  const passed = sample([{ at: 1300, event: "done" }, { at: 1400, event: "approved" }]);
  expect(passed.first_pass_approval).toBe(1);
  expect(passed.acceptance_to_first_review_ms).toBe(200);
  expect(passed.rework_rounds).toBe(0);
  const rejected = sample([{ at: 1300, event: "done" }, { at: 1400, event: "changes_requested" }, { at: 1500, event: "done" }, { at: 1600, event: "approved" }]);
  expect(rejected.first_pass_approval).toBe(0);
  expect(rejected.rework_rounds).toBe(1);
});
