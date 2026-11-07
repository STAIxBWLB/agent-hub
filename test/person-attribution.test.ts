import { expect, test } from "bun:test";
import { summarizeByTask, formatTaskReport } from "../src/hub/report.ts";
import { addPersonEvent, emptyPersonCounts, personFigures, UNKNOWN_PERSON_FIGURES, type PersonEvent } from "../src/hub/person-figures.ts";
import { taskRecords } from "../src/hub/research.ts";
import { ev, taskEvent, PROJECT } from "./helpers/research-fixture.ts";

// #1278: person interactions attributed to tasks by the token rule, with minutes from recorded latencies only. Every expected number below is counted by hand from the event list.

const writer = { version: "test", source: "backfill" as const };
const perm = (min: number, extra: Record<string, unknown>) => ev(min, { type: "permission", id: `p${min}`, peer: "codex", ...extra });
const question = (min: number, extra: Record<string, unknown>) => ev(min, { type: "question", set: `q${min}`, peer: "codex", ...extra });

/**
 * Two open tasks, #1 and #2, both started at minute 1. Person events:
 *  - a permission asked during a delivery of task 1, answered by the console with allow_once after 120 s;
 *  - a question asked during task 2 (the peer's single open task), answered after 60 s;
 *  - a permission answered by the dashboard with NO latency reading;
 *  - an automatic answer (no surface), an expiry, and a CLI refusal for task 1;
 *  - a permission outside both (the peer holds two open tasks and no delivery): unattributed.
 */
function events() {
  return [
    ev(-1, { type: "hub_start", instance: "run-1", personAttribution: true }),
    taskEvent(0, 1, "proposed", "proposed"), taskEvent(1, 1, "accepted", "in_progress", { owner: "codex" }),
    taskEvent(0, 2, "proposed", "proposed"), taskEvent(1, 2, "accepted", "in_progress", { owner: "claude" }),
    perm(2, { event: "requested", task: 1, attribution: "delivery" }),
    perm(4, { event: "answered", latencyMs: 120_000, surface: "console", option: "allow_once", task: 1, attribution: "delivery" }),
    question(5, { event: "asked", questions: 1, task: 2, attribution: "single_open" }),
    question(6, { event: "answered", latencyMs: 60_000, surface: "terminal", task: 2, attribution: "single_open" }),
    perm(7, { event: "requested", task: 1, attribution: "delivery" }),
    perm(8, { event: "answered", surface: "dashboard", option: "reject_once", task: 1, attribution: "delivery" }),
    perm(9, { event: "requested", task: 1, attribution: "delivery" }),
    perm(10, { event: "answered", latencyMs: 5, option: "allow_once", task: 1, attribution: "delivery" }),
    perm(11, { event: "requested", task: 1, attribution: "delivery" }),
    perm(12, { event: "expired", latencyMs: 600_000, task: 1, attribution: "delivery" }),
    ev(13, { type: "agent_cli", peer: "codex", command: "task", refused: true, task: 1, attribution: "delivery" }),
    ev(13, { type: "agent_cli", peer: "codex", command: "task", refused: false, task: 1, attribution: "delivery" }),
    ev(14, { type: "completion", id: "c1", peer: "codex", outcome: "done", ms: 1000, task: 1, attribution: "delivery" }),
    perm(15, { event: "requested", attribution: "unattributed" }),
    perm(16, { event: "answered", latencyMs: 30_000, surface: "console", option: "allow_once", attribution: "unattributed" }),
    taskEvent(20, 1, "approved", "approved", { owner: "codex" }), taskEvent(21, 2, "approved", "approved", { owner: "claude" }),
  ];
}

test("AC1: a permission in a delivery counts for that delivery's task, a question in a single open task for that task, and one outside both is unattributed", () => {
  const r = summarizeByTask(events());
  expect(r.tasks["1"]!.person.permissions).toEqual({ asked: 4, allowed: 2, denied: 1, expired: 1 });
  expect(r.tasks["1"]!.person.questions).toEqual({ asked: 0, answered: 0, expired: 0 });
  expect(r.tasks["2"]!.person.questions).toEqual({ asked: 1, answered: 1, expired: 0 });
  expect(r.tasks["2"]!.person.permissions).toEqual({ asked: 0, allowed: 0, denied: 0, expired: 0 });
  // The unattributed permission is counted apart and never folded into either task.
  expect(r.person.unattributed.permissions).toMatchObject({ asked: 1, allowed: 1 });
  expect(r.tasks["1"]!.person.permissions!.asked + r.tasks["2"]!.person.permissions!.asked).toBe(4);
});

test("AC2: minutes sum only recorded latencies of person answers; a person answer without a latency raises n and unknown, not the sum", () => {
  const r = summarizeByTask(events());
  // Task 1: the console answer (120 s) and the dashboard answer with no reading are the person's. The automatic answer (no surface) and the expiry are not the person's minutes.
  expect(r.tasks["1"]!.person.latencyMs).toEqual({ sum: 120_000, n: 2, unknown: 1 });
  expect(r.tasks["2"]!.person.latencyMs).toEqual({ sum: 60_000, n: 1, unknown: 0 });
  expect(r.person.unattributed.latencyMs).toEqual({ sum: 30_000, n: 1, unknown: 0 });
});

test("a CLI refusal counts, a run does not, and a completion counts for its task", () => {
  const p = summarizeByTask(events()).tasks["1"]!.person;
  expect(p.cliRefusals).toBe(1);
  expect(p.completions).toBe(1);
  expect(p.consoleConfirmations).toBeNull();
});

test("AC4: ahub report --by task and the research record show the same numbers", () => {
  const record = taskRecords(events(), PROJECT, writer).find(r => r.task === 1)!;
  expect(record.person!).toEqual(summarizeByTask(events()).tasks["1"]!.person);
  const two = taskRecords(events(), PROJECT, writer).find(r => r.task === 2)!;
  expect(two.person).toEqual(summarizeByTask(events()).tasks["2"]!.person);
  expect(record.person!.latencyMs).toEqual({ sum: 120_000, n: 2, unknown: 1 });
});

test("AC4: a log from before this version has no attributed person event, so every figure is unknown, never 0, and old events read as before", () => {
  // The same log as an older hub wrote it: no start marker, and no task or attribution on a person event.
  const old = events().filter(e => e.type !== "hub_start").map(e => e.type === "task" ? e : (({ task: _t, attribution: _a, ...rest }) => rest as typeof e)(e as typeof e & { task?: number; attribution?: string }));
  const r = summarizeByTask(old);
  expect(r.tasks["1"]!.person).toEqual(UNKNOWN_PERSON_FIGURES);
  expect(r.person.beforeAttribution.permissions.asked).toBeGreaterThan(0);
  expect(taskRecords(old, PROJECT, writer).find(x => x.task === 1)!.person).toEqual(UNKNOWN_PERSON_FIGURES);
});

test("a task that began before the first attributing hub run is unknown, a later one is known, and a later one with no interaction is a known 0", () => {
  const log = [
    taskEvent(0, 1, "proposed", "proposed"), taskEvent(1, 1, "accepted", "in_progress", { owner: "codex" }),
    perm(2, { event: "requested" }),
    ev(4, { type: "hub_start", instance: "run-2", personAttribution: true }),
    taskEvent(5, 3, "proposed", "proposed"), taskEvent(6, 3, "accepted", "in_progress", { owner: "codex" }), taskEvent(8, 3, "approved", "approved"),
    taskEvent(5, 2, "proposed", "proposed"), taskEvent(6, 2, "accepted", "in_progress", { owner: "codex" }),
    perm(7, { event: "requested", task: 2, attribution: "single_open" }),
    taskEvent(9, 1, "approved", "approved"), taskEvent(10, 2, "approved", "approved"),
  ];
  const records = taskRecords(log, PROJECT, writer);
  expect(records.find(r => r.task === 1)!.person).toEqual(UNKNOWN_PERSON_FIGURES);
  expect(records.find(r => r.task === 2)!.person!.permissions).toEqual({ asked: 1, allowed: 0, denied: 0, expired: 0 });
  // No interaction at all after the marker: the log would have shown one, so this is a known 0, the best outcome and the one a null must not hide.
  expect(records.find(r => r.task === 3)!.person).toMatchObject({ permissions: { asked: 0 }, questions: { asked: 0 }, completions: 0, cliRefusals: 0, latencyMs: { sum: 0, n: 0, unknown: 0 } });
});

test("AC3: a PII task's interactions count in its record and report without any text", () => {
  const log = [
    ev(-1, { type: "hub_start", instance: "run-1", personAttribution: true }),
    taskEvent(0, 5, "proposed", "proposed", { pii: true }), taskEvent(1, 5, "accepted", "in_progress", { owner: "local", pii: true }),
    perm(2, { event: "requested", task: 5, attribution: "delivery", pii: true }),
    perm(3, { event: "answered", latencyMs: 1000, surface: "console", option: "allow_once", task: 5, attribution: "delivery", pii: true }),
    taskEvent(4, 5, "approved", "approved", { pii: true }),
  ];
  const record = taskRecords(log, PROJECT, writer)[0]!;
  expect(record.pii).toBe(true);
  expect(record.person!.permissions).toEqual({ asked: 1, allowed: 1, denied: 0, expired: 0 });
  const report = summarizeByTask(log);
  expect(report.tasks["5"]).toMatchObject({ pii: true });
  const text = formatTaskReport(report).join("\n") + JSON.stringify(report) + JSON.stringify(record);
  // Only ids, counts and closed words: the events hold no title, option label or command, and neither do the outputs.
  expect(text).not.toMatch(/title|prompt|command text/i);
  for (const value of Object.values(record.person!)) expect(JSON.stringify(value)).not.toMatch(/[a-z]{12,}/);
});

test("a person interaction does not make its peer a worker on the task", () => {
  const record = taskRecords(events(), PROJECT, writer).find(r => r.task === 2)!;
  expect(record.owners).toEqual(["claude"]);
  expect(record.peers ?? []).not.toContain("codex");
});

test("the text report names each task's person line and the unattributed remainder", () => {
  const text = formatTaskReport(summarizeByTask(events())).join("\n");
  expect(text).toContain("person: permissions 4 asked (2 allowed, 1 denied, 1 expired), questions 0 asked (0 answered, 0 expired), completions 1, CLI refusals 1, 2.0 min over 1/2 recorded");
  expect(text).toContain("person unattributed: 1 permissions asked, 0 questions asked, 0 completions, 0 CLI refusals, never counted for a task");
});

test("addPersonEvent and personFigures keep unobserved as null", () => {
  const counts = emptyPersonCounts();
  addPersonEvent(counts, { v: 1, at: "2026-10-10T00:00:00.000Z", type: "permission", id: "x", peer: "codex", event: "answered", surface: "console", option: "allow_once", latencyMs: 1500 } as PersonEvent);
  expect(personFigures(counts, true).latencyMs).toEqual({ sum: 1500, n: 1, unknown: 0 });
  expect(personFigures(counts, false)).toEqual(UNKNOWN_PERSON_FIGURES);
  expect(personFigures(undefined, true)).toEqual(UNKNOWN_PERSON_FIGURES);
});
