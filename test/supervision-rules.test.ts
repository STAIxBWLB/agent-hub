import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_OBSERVATIONS, MAX_PER_REVISION, MAX_RECORDS, REPEAT_FLOOR, SUPERVISION_RULES, ShadowSupervisor, evaluateSupervision, taskRevision, type SupervisionFacts, type SupervisionHistoryFact } from "../src/hub/supervision-rules.ts";
import type { TaskState } from "../src/hub/board.ts";

// #1221 T1: the rules are a pure reading of admitted records, so every proof here is a fixture of records plus a count
// of what the shadow evaluator did with them. Nothing in this file starts a peer, a daemon or a worker.

const BASE = 1_700_000_000_000, STEP = 1_000;
type Item = string | readonly [string, Partial<SupervisionHistoryFact>];
const history = (...items: Item[]): SupervisionHistoryFact[] => items.map((item, index) => typeof item === "string"
  ? { at: BASE + index * STEP, event: item }
  : { at: BASE + index * STEP, event: item[0], ...item[1] });
const task = (id: number, items: readonly Item[], state: TaskState = "in_progress") => ({ id, state, history: history(...items) });

const RECORD = { id: "d-0123456789ab", path: "docs/design/supervision.md", format: "md", sha256: "a".repeat(64), bytes: 4096 };
const delivered = (): readonly Item[] => ["proposed", "assigned", "accepted", ["done", { deliverables: [RECORD] }], ["check passed", { checkKey: "implement" }]];
const failing = (times = 2): readonly Item[] => {
  const items: Item[] = ["proposed", "assigned", "accepted", "done"];
  for (let round = 0; round < times; round += 1) items.push(["check failed", { checkKey: "implement" }], "done");
  return items;
};
const kinds = (facts: SupervisionFacts) => evaluateSupervision(facts).observations.map((observation) => observation.rule);

test("AC1: equal classified failures repeat once per revision, and a replay or a third equal failure adds nothing", () => {
  const facts: SupervisionFacts = { tasks: [task(7, failing())] };
  const shadow = new ShadowSupervisor();
  const first = shadow.observe(facts);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ rule: "repeated_failure", version: 1, task: 7, revision: "1:none", trigger: "failures:check:implement", action: "escalate", reason: "repeated_failure", limits: { records: 5, truncated: false } });
  expect(first[0]!.refs).toEqual(["history:4", "history:6"]);
  expect(Object.keys(first[0]!).sort()).toEqual(["action", "limits", "reason", "refs", "revision", "rule", "task", "trigger", "version"]);
  expect(shadow.observe(facts)).toEqual([]); // the same records read again are the same observation
  expect(evaluateSupervision({ tasks: [task(7, failing(3))] }).observations).toHaveLength(1); // a longer equal run is still one pattern
  expect(shadow.observe({ tasks: [task(7, failing(3))] })).toEqual([]);
  expect(shadow.counts()).toEqual({ evaluations: 3, observations: 1, deduped: 2, suppressed: 0, gap: 0, evaluatedSuppressed: 0, workerTurns: 0, actionWrites: 0, notifications: 0 });
});

test("AC1: ordinary progress, unequal failures and a cleared streak trigger nothing", () => {
  expect(kinds({ tasks: [task(8, ["proposed", "assigned", "accepted", "done", ["check passed", { checkKey: "implement" }]])] })).toEqual([]);
  expect(kinds({ tasks: [task(9, ["proposed", "assigned", "accepted", ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "spec" }]])] })).toEqual([]);
  expect(kinds({ tasks: [task(10, ["proposed", "assigned", "accepted", ["check failed", { checkKey: "implement" }], "done", ["check passed", { checkKey: "implement" }], ["check failed", { checkKey: "implement" }]])] })).toEqual([]);
  // #852: a code-scope rejection that names no finding is not a failure of the work.
  expect(kinds({ tasks: [task(11, ["proposed", "assigned", "accepted", ["changes_requested", { evidenceOnly: true }], ["changes_requested", { evidenceOnly: true }]])] })).toEqual([]);
  expect(kinds({ tasks: [task(12, ["proposed", "assigned", "accepted", ["changes_requested", { evidenceOnly: true }], ["changes_requested", { evidenceOnly: true }]])].map((row) => ({ ...row, state: "approved" as TaskState })) })).toEqual([]);
});

test("elapsed silence alone is never a trigger: the same records a long time later read the same", () => {
  const quiet = { tasks: [{ id: 13, state: "in_progress" as TaskState, history: [{ at: 0, event: "accepted" }, { at: 9_999_999_999_999, event: "assigned" }] }] };
  // Nothing fired, and the coverage says both rules read this revision: "nothing found" is not "nothing looked at".
  expect(evaluateSupervision(quiet)).toEqual({
    observations: [], gap: [],
    evaluated: [{ rule: "deliverable_invalidated_check", task: 13, revision: "1:none" }, { rule: "repeated_failure", task: 13, revision: "1:none" }],
  });
  expect(taskRevision(quiet.tasks[0]!)).toEqual({ revision: "1:none", from: 1, accepted: 0 });
});

test("a changed deliverable invalidates the check recorded on that revision", () => {
  const changed: SupervisionFacts = { tasks: [task(14, delivered())], deliverables: [{ task: 14, checked: true, changed: [RECORD.id] }] };
  const observation = evaluateSupervision(changed).observations[0]!;
  expect(observation).toMatchObject({ rule: "deliverable_invalidated_check", version: 1, task: 14, trigger: `check:${RECORD.id}`, action: "recheck", reason: "stale_check" });
  expect(observation.refs).toEqual(["history:4", `deliverable:${RECORD.id}`]);
  expect(kinds({ tasks: [task(14, delivered())], deliverables: [{ task: 14, checked: true, changed: [], missing: [] }] })).toEqual([]);
  // A file the hub measured but that was never delivered on this revision is not a recorded deliverable.
  expect(kinds({ tasks: [task(14, delivered())], deliverables: [{ task: 14, checked: true, changed: ["d-ffffffffffff"] }] })).toEqual([]);
  expect(evaluateSupervision({ tasks: [task(14, delivered())], deliverables: [{ task: 14, checked: true, changed: [], missing: [RECORD.id] }] }).observations).toHaveLength(1);
});

test("a check whose files were never measured is unknown, not clean and not a trigger", () => {
  const unmeasured: SupervisionFacts = { tasks: [task(15, delivered())] };
  const coverage = [{ rule: "deliverable_invalidated_check", task: 15, revision: "1:none" }, { rule: "repeated_failure", task: 15, revision: "1:none" }] as const;
  expect(evaluateSupervision(unmeasured)).toEqual({ observations: [], gap: [{ rule: "deliverable_invalidated_check", version: 1, task: 15, revision: "1:none", reason: "no-deliverable-measurement" }], evaluated: [...coverage] });
  expect(evaluateSupervision({ tasks: [task(15, delivered())], deliverables: [{ task: 15, checked: false, changed: [RECORD.id] }] })).toEqual({ observations: [], gap: [{ rule: "deliverable_invalidated_check", version: 1, task: 15, revision: "1:none", reason: "no-deliverable-measurement" }], evaluated: [...coverage] });
  // A task that recorded no check at all has nothing to invalidate: no trigger and no gap.
  expect(evaluateSupervision({ tasks: [task(16, ["proposed", "assigned", "accepted", "done"])] })).toEqual({
    observations: [], gap: [],
    evaluated: [{ rule: "deliverable_invalidated_check", task: 16, revision: "1:none" }, { rule: "repeated_failure", task: 16, revision: "1:none" }],
  });
});

test("declared overlap that outlived both acceptances and recorded no integration is observed once per pair", () => {
  const facts: SupervisionFacts = { tasks: [task(20, ["proposed", "assigned", "accepted", "done"]), task(21, ["proposed", "assigned", "accepted"])], overlaps: [{ task: 21, other: 20 }] };
  const [observation, ...rest] = evaluateSupervision(facts).observations;
  expect(rest).toEqual([]);
  expect(observation).toMatchObject({ rule: "declared_overlap_without_integration", version: 1, task: 20, revision: "1:none", trigger: "overlap:20:21", action: "request_integration", reason: "unintegrated_overlap" });
  expect(observation!.refs).toEqual(["task:21", "history:2", "history:2"]);
  // One pair, one observation, whichever side the caller names first.
  const shadow = new ShadowSupervisor();
  expect(shadow.observe(facts)).toHaveLength(1);
  expect(shadow.observe({ tasks: facts.tasks, overlaps: [{ task: 20, other: 21 }] })).toEqual([]);
  expect(shadow.counts()).toMatchObject({ observations: 1, deduped: 1, suppressed: 0 });
});

test("declared overlap with integration evidence, or a side that never accepted, or a closed side triggers nothing", () => {
  expect(kinds({ tasks: [task(22, ["proposed", "assigned", "accepted"]), task(23, ["proposed", "assigned", "accepted", "integration requested"])], overlaps: [{ task: 23, other: 22 }] })).toEqual([]);
  expect(kinds({ tasks: [task(24, ["proposed", "assigned", "accepted"]), task(25, ["proposed", "assigned"])], overlaps: [{ task: 25, other: 24 }] })).toEqual([]);
  expect(kinds({ tasks: [task(26, ["proposed", "assigned", "accepted", "done", "approved"]), task(27, ["proposed", "assigned", "accepted"])].map((row) => ({ ...row, state: (row.id === 26 ? "approved" : "in_progress") as TaskState })), overlaps: [{ task: 27, other: 26 }] })).toEqual([]);
});

test("an overlap whose window is clipped reports unknown coverage instead of assuming no integration", () => {
  const quiet = Array.from({ length: MAX_RECORDS }, () => "done" as const);
  const facts: SupervisionFacts = {
    tasks: [task(70, ["proposed", "assigned", "accepted", ...quiet, "integration requested"]), task(71, ["proposed", "assigned", "accepted"])],
    overlaps: [{ task: 70, other: 71 }],
  };
  const evaluation = evaluateSupervision(facts);
  // The integration request sits one record past the prefix, so the rule cannot decide: a gap, not an observation.
  expect(evaluation.observations.filter((observation) => observation.rule === "declared_overlap_without_integration")).toEqual([]);
  expect(evaluation.gap.filter((gap) => gap.rule === "declared_overlap_without_integration")).toEqual([{ rule: "declared_overlap_without_integration", version: 1, task: 70, revision: "1:none", reason: "history-truncated" }]);
  // The same pair read inside the prefix is decided, so the gap is about coverage and not about the rule.
  expect(kinds({ tasks: [task(70, ["proposed", "assigned", "accepted", "done", "integration requested"]), task(71, ["proposed", "assigned", "accepted"])], overlaps: [{ task: 70, other: 71 }] })).toEqual([]);
});

test("an overlap naming a task outside the fact set is unknown coverage, never a silent pass", () => {
  const facts: SupervisionFacts = { tasks: [task(28, ["proposed", "assigned", "accepted"])], overlaps: [{ task: 28, other: 29 }] };
  expect(evaluateSupervision(facts)).toEqual({
    observations: [], gap: [{ rule: "declared_overlap_without_integration", version: 1, task: 28, revision: "1:none", reason: "no-history" }],
    evaluated: [
      { rule: "declared_overlap_without_integration", task: 28, revision: "1:none" },
      { rule: "deliverable_invalidated_check", task: 28, revision: "1:none" },
      { rule: "repeated_failure", task: 28, revision: "1:none" },
    ],
  });
});

test("an overlap with a closed side is not supervised: no coverage, no gap, no observation", () => {
  const open = task(80, ["proposed", "assigned", "accepted"]);
  const closed = task(81, ["proposed", "assigned", "accepted"], "cancelled" as TaskState);
  const overlapOnly = (facts: SupervisionFacts) => {
    const evaluation = evaluateSupervision(facts);
    return [evaluation.evaluated, evaluation.gap, evaluation.observations].map((list) => list.filter((entry) => entry.rule === "declared_overlap_without_integration"));
  };
  // Either side closed, in either direction, and a closed side whose partner is outside the fact set.
  expect(overlapOnly({ tasks: [open, closed], overlaps: [{ task: 80, other: 81 }] })).toEqual([[], [], []]);
  expect(overlapOnly({ tasks: [closed, task(82, ["proposed", "assigned", "accepted"])], overlaps: [{ task: 82, other: 81 }] })).toEqual([[], [], []]);
  expect(overlapOnly({ tasks: [closed], overlaps: [{ task: 81, other: 90 }] })).toEqual([[], [], []]);
});

test("a hand-over starts a new revision, so the failures before it and after it are two observations", () => {
  const before: SupervisionFacts = { tasks: [task(30, failing())] };
  const after: SupervisionFacts = { tasks: [task(30, [...failing(), "reassigned", "accepted", ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]])] };
  expect(evaluateSupervision(before).observations.map((observation) => observation.revision)).toEqual(["1:none"]);
  // One reading covers the current attempt only: the superseded attempt's failures are not re-reported under the new revision.
  const handed = evaluateSupervision(after).observations;
  expect(handed.map((observation) => observation.revision)).toEqual(["3:none"]);
  expect(handed[0]!.refs).toEqual(["history:10", "history:12"]);
  const shadow = new ShadowSupervisor();
  expect(shadow.observe(before)).toHaveLength(1);
  expect(shadow.observe(before)).toEqual([]); // a replay adds nothing
  expect(shadow.observe(after)).toHaveLength(1); // the new attempt is a new observation, not a duplicate of the old one
  expect(shadow.observations().map((observation) => observation.revision)).toEqual(["1:none", "3:none"]);
  expect(shadow.counts()).toMatchObject({ evaluations: 3, observations: 2, deduped: 1 });
});

test("a plan revision starts an attempt of its own, so the previous plan's failures are not re-emitted", () => {
  const plan = (revision: number) => ({ planRevision: { revision, fingerprint: `f${revision}` } });
  const changed: Item[] = [...failing(), ["planned", plan(2)]];
  // Two failures under plan 1 stay plan 1's: the new revision has no record yet, so it reports nothing instead of them.
  expect(evaluateSupervision({ tasks: [task(61, changed)] }).observations).toEqual([]);
  // The acceptance still governs the attempt even though the plan change moved the window past it.
  expect(taskRevision(task(61, changed))).toEqual({ revision: "1:2", from: 9, accepted: 2 });
  // A failure recorded under the new plan pairs only with one recorded under the new plan.
  const pairing = task(62, [...changed, ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]]);
  const observations = evaluateSupervision({ tasks: [pairing] }).observations;
  expect(observations.map((observation) => observation.revision)).toEqual(["1:2"]);
  expect(observations[0]!.refs).toEqual(["history:9", "history:11"]);
  // And a hand-over still clears the acceptance, so a plan change cannot carry the previous owner's acceptance forward.
  expect(taskRevision(task(63, ["proposed", "assigned", "accepted", "reassigned", ["planned", plan(2)]]))).toEqual({ revision: "2:2", from: 5, accepted: -1 });
});

test("one revision is bounded: the per-revision cap counts what it refused instead of storing it", () => {
  const items: Item[] = ["proposed", "assigned", "accepted"];
  for (const key of ["a", "b", "c", "d"]) items.push(["check failed", { checkKey: key }], ["check failed", { checkKey: key }], "check passed");
  const facts: SupervisionFacts = { tasks: [task(31, items)] };
  expect(evaluateSupervision(facts).observations.map((observation) => observation.trigger)).toEqual(["failures:check:a", "failures:check:b", "failures:check:c", "failures:check:d"]);
  const shadow = new ShadowSupervisor();
  expect(shadow.observe(facts)).toHaveLength(MAX_PER_REVISION);
  expect(shadow.counts()).toMatchObject({ observations: MAX_PER_REVISION, suppressed: 1, deduped: 0 });
});

test("the reading is bounded, ordered and identical for the same facts", () => {
  const facts: SupervisionFacts = {
    tasks: [task(40, delivered()), task(41, failing())],
    deliverables: [{ task: 40, checked: true, changed: [RECORD.id] }],
  };
  const forwards = evaluateSupervision(facts);
  const backwards = evaluateSupervision({ tasks: [...facts.tasks].reverse(), deliverables: facts.deliverables });
  expect(backwards).toEqual(forwards);
  expect(forwards.observations.map((observation) => observation.rule)).toEqual(["deliverable_invalidated_check", "repeated_failure"]);
  expect(SUPERVISION_RULES).toEqual(["repeated_failure", "deliverable_invalidated_check", "declared_overlap_without_integration"]);
  expect(REPEAT_FLOOR).toBeGreaterThan(1);
  // A revision longer than one rule reads is reported as a clipped prefix, not as a clean one.
  const padded: readonly Item[] = ["accepted", ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }], ...Array.from({ length: MAX_RECORDS }, () => "done" as const)];
  const clipped = evaluateSupervision({ tasks: [task(42, padded)] });
  expect(clipped.observations[0]!.limits).toEqual({ records: MAX_RECORDS, truncated: true });
  // Failures that fall entirely past the bound are unknown coverage, never "no pattern".
  const late: readonly Item[] = ["accepted", ...Array.from({ length: MAX_RECORDS }, () => "done" as const), ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]];
  const beyond = evaluateSupervision({ tasks: [task(43, late)] });
  expect(beyond.observations).toEqual([]);
  expect(beyond.gap).toEqual([{ rule: "deliverable_invalidated_check", version: 1, task: 43, revision: "1:none", reason: "history-truncated" }, { rule: "repeated_failure", version: 1, task: 43, revision: "1:none", reason: "history-truncated" }]);
});

test("AC2: shadow mode keeps counts and bounded ids, with zero worker turns, action writes and notifications", () => {
  const shadow = new ShadowSupervisor();
  shadow.observe({ tasks: [task(50, failing()), task(51, delivered())], deliverables: [{ task: 51, checked: true, changed: [RECORD.id] }] });
  expect(shadow.observations().map((observation) => observation.rule)).toEqual(["deliverable_invalidated_check", "repeated_failure"]);
  expect(shadow.counts()).toEqual({ evaluations: 1, observations: 2, deduped: 0, suppressed: 0, gap: 0, evaluatedSuppressed: 0, workerTurns: 0, actionWrites: 0, notifications: 0 });
  expect(MAX_OBSERVATIONS).toBeGreaterThan(MAX_PER_REVISION);
  // Nothing a rule reports can carry a note, a finding or a file body: the record is a closed shape of codes and ids.
  expect(JSON.stringify(shadow.observations())).not.toContain("secret");
  expect(Object.keys(shadow.observations()[0]!).sort()).toEqual(["action", "limits", "reason", "refs", "revision", "rule", "task", "trigger", "version"]);
});

test("AC2: retained gaps are bounded too, and a refused gap is counted instead of stored", () => {
  const tasks = Array.from({ length: MAX_OBSERVATIONS + 1 }, (_, index) => task(200 + index, delivered()));
  const shadow = new ShadowSupervisor();
  expect(shadow.observe({ tasks })).toEqual([]);
  expect(shadow.counts()).toMatchObject({ evaluations: 1, observations: 0, deduped: 0, suppressed: 1, gap: MAX_OBSERVATIONS, workerTurns: 0, actionWrites: 0, notifications: 0 });
  // The one gap that still cannot be retained is refused again rather than silently forgotten.
  shadow.observe({ tasks });
  expect(shadow.counts()).toMatchObject({ suppressed: 2, gap: MAX_OBSERVATIONS });
});

test("AC2: the rule module has no clock, timer, emit path, board write or private-task reader", () => {
  const source = readFileSync(new URL("../src/hub/supervision-rules.ts", import.meta.url), "utf8");
  for (const forbidden of ["Date.now(", "performance.now(", "setTimeout(", "setInterval(", "setImmediate(", "emit(", "notify(", "publish(", "writeFileSync", "process.env", "\"./tasks.ts\"", "\"./bus.ts\"", "\"./daemon.ts\"", "\"./peers.ts\"", "\"./memory/"]) {
    expect(source, forbidden).not.toContain(forbidden);
  }
  // The one import that carries behaviour is the closed-state test; everything else is a type.
  expect(source).toContain("import { isClosedTaskState, type HistoryEntry, type TaskState } from \"./board.ts\";");
  expect(source).toContain("import type { DeliverableRecord } from \"./deliverables.ts\";");
});

test("a note in the facts is never read: the observation is identical with and without private text", () => {
  const plain: SupervisionFacts = { tasks: [task(60, failing())] };
  const withNote = { tasks: [{ ...plain.tasks[0]!, history: plain.tasks[0]!.history.map((entry) => ({ ...entry, note: "secret review words", withheld: true })) }] } as unknown as SupervisionFacts;
  expect(evaluateSupervision(withNote)).toEqual(evaluateSupervision(plain));
  expect(JSON.stringify(evaluateSupervision(withNote))).not.toContain("secret");
});

test("the snapshot is the exported read: observations, gaps in gapKey order, the counts and the coverage, as a copy", () => {
  // Task 71 recorded a check pass over a delivered record the hub never measured, and the declared pair 72/73 is
  // outside the fact set: two gaps, one per rule, in the order gapKey sorts them by.
  const facts: SupervisionFacts = { tasks: [task(70, ["proposed", "assigned", "accepted"]), task(71, delivered())], overlaps: [{ task: 72, other: 73 }] };
  const shadow = new ShadowSupervisor();
  shadow.observe(facts);
  const snapshot = shadow.snapshot();
  expect(Object.keys(snapshot).sort()).toEqual(["counts", "evaluated", "gap", "observations"]);
  expect(snapshot.gap).toEqual([
    { rule: "declared_overlap_without_integration", version: 1, task: 72, revision: "0:none", reason: "no-history" },
    { rule: "deliverable_invalidated_check", version: 1, task: 71, revision: "1:none", reason: "no-deliverable-measurement" },
  ]);
  expect(snapshot.observations).toEqual([]);
  expect(snapshot.counts).toEqual({ evaluations: 1, observations: 0, deduped: 0, suppressed: 0, gap: 2, evaluatedSuppressed: 0, workerTurns: 0, actionWrites: 0, notifications: 0 });
  // Both rules read task 70 even though it fired nothing, and the pair 72/73 is covered as its gap names it.
  expect(snapshot.evaluated).toEqual([
    { rule: "declared_overlap_without_integration", task: 72, revision: "0:none" },
    { rule: "deliverable_invalidated_check", task: 70, revision: "1:none" },
    { rule: "deliverable_invalidated_check", task: 71, revision: "1:none" },
    { rule: "repeated_failure", task: 70, revision: "1:none" },
    { rule: "repeated_failure", task: 71, revision: "1:none" },
  ]);
  // The accessors are reads of the same state, not a second store.
  expect(shadow.gaps()).toEqual(snapshot.gap);
  expect(shadow.evaluated()).toEqual(snapshot.evaluated);
  expect(shadow.counts()).toEqual(snapshot.counts);
  // A snapshot is a copy: a caller that edits its arrays cannot reach the supervisor's state.
  snapshot.observations.push({} as never);
  snapshot.gap.length = 0;
  expect(shadow.gaps()).toHaveLength(2);
  expect(shadow.snapshot().observations).toEqual([]);
  // A second reading of the same facts changes no gap and keeps the counts honest about what it did.
  shadow.observe(facts);
  expect(shadow.gaps()).toHaveLength(2);
  expect(shadow.evaluated()).toHaveLength(5); // coverage dedupes the replay: the same revision is not read twice
  expect(shadow.snapshot().counts).toMatchObject({ evaluations: 2, gap: 2, deduped: 0 });
  // An observation and a gap read together keep their own orders.
  shadow.observe({ tasks: [task(74, failing())] });
  const next = shadow.snapshot();
  expect(next.observations.map((observation) => observation.task)).toEqual([74]);
  // Gaps sort by rule first, then task: the overlap gap of 72 precedes the deliverable gap of 71.
  expect(next.gap.map((gap) => gap.task)).toEqual([72, 71]);
  expect(next.counts).toMatchObject({ observations: 1, gap: 2 });
  expect(next.evaluated.filter((entry) => entry.task === 74)).toHaveLength(2);
});

test("the coverage list is bounded like the rest, and what a bound refused is counted", () => {
  // Two rules read each open task, so 51 tasks are 102 coverage entries: the bound keeps 100 and counts the overflow.
  const tasks = Array.from({ length: MAX_OBSERVATIONS / 2 + 1 }, (_, index) => task(300 + index, ["proposed", "assigned", "accepted"]));
  const shadow = new ShadowSupervisor();
  shadow.observe({ tasks });
  expect(shadow.evaluated()).toHaveLength(MAX_OBSERVATIONS);
  expect(shadow.counts()).toMatchObject({ evaluations: 1, evaluatedSuppressed: 2, suppressed: 0 });
  // A closed task is not read at all: no coverage, no gap and no observation.
  shadow.observe({ tasks: [task(400, ["proposed", "assigned", "accepted"], "cancelled" as TaskState)] });
  expect(shadow.evaluated().some((entry) => entry.task === 400)).toBe(false);
  // A pair named twice in one read is one coverage entry, and its observation is still deduplicated.
  const pair = { tasks: [task(410, ["proposed", "assigned", "accepted"]), task(411, ["proposed", "assigned", "accepted"])], overlaps: [{ task: 410, other: 411 }, { task: 411, other: 410 }] };
  const second = new ShadowSupervisor();
  second.observe(pair);
  expect(second.evaluated().filter((entry) => entry.rule === "declared_overlap_without_integration")).toEqual([{ rule: "declared_overlap_without_integration", task: 410, revision: "1:none" }]);
  expect(second.observations()).toHaveLength(1);
});
