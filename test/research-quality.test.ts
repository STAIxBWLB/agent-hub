import { afterEach, expect, test } from "bun:test";
import type { StampedEvent } from "../src/hub/events.ts";
import { taskRecords } from "../src/hub/research.ts";
import { QUOTA_GAP_MS, buildResearchQuality } from "../src/hub/research-quality.ts";
import { NO_EVIDENCE, readEvidence } from "../src/hub/research-record.ts";
import { boardWith, cleanDirs, ev, familyOf, minutes, PROJECT, scenarioBoard, scenarioDeliveries, scenarioEvents, taskEvent, tempDir } from "./helpers/research-fixture.ts";

// #1277 AC4 (#44 AC0): quality.json reports field coverage, quota gaps and staleness, budget pauses, outcomes per family and class, event types seen, and the token attribution share, on a fixture with known gaps.

const dirs: string[] = [];
afterEach(() => cleanDirs(dirs));
const writer = { version: "test", source: "backfill" as const };
const MIN = 60_000;
const quota = (min: number, peer: string, extra: Record<string, unknown> = {}) => ev(min, { type: "quota", peer, windows: [{ id: "5h", used: 10 }], hard: false, ...extra });
const tokens = (min: number, n: number, attribution: string, extra: Record<string, unknown> = {}) => ev(min, { type: "tokens", peer: "codex", n, attribution, ...extra });

/** The scenario plus telemetry with known gaps: codex readings at 0, 30, 150 and 160 minutes, claude readings at 10 and (measured at 20, delivered at 100). */
function events(): StampedEvent[] {
  return [
    ...scenarioEvents(),
    quota(0, "codex"), quota(30, "codex"), quota(150, "codex"), quota(160, "codex"),
    quota(10, "claude"), quota(100, "claude", { measuredAt: new Date(minutes(20)).toISOString() }),
    ev(5, { type: "budget_pause", peer: "codex", reason: "five_hour", window: "5h", resetsAt: 0, by: "hub" }),
    ev(8, { type: "budget_resume", peer: "codex", reason: "five_hour", window: "5h", resetsAt: 0, by: "hub" }),
    ev(9, { type: "budget_pause", peer: "claude", reason: "five_hour", window: "5h", resetsAt: 0, by: "person" }),
    tokens(6, 60, "delivery", { task: 1 }), tokens(6, 30, "single_open", { task: 1 }), tokens(6, 10, "unattributed"),
  ];
}
function records() {
  const stateDir = tempDir(dirs, "state");
  boardWith(stateDir, scenarioBoard(), scenarioDeliveries());
  return taskRecords(events(), PROJECT, writer, { ...readEvidence(stateDir, PROJECT), familyOf });
}

test("AC4: coverage counts each v2 field's records and the unknown ones, as null, absent or the vocabulary's own unknown", () => {
  const q = buildResearchQuality(records(), events(), {}, familyOf);
  expect(q.records).toBe(4);
  expect(q.fields["review.findings"]).toEqual({ n: 4, unknown: 3 });
  expect(q.fields["review.ownerFamily"]).toEqual({ n: 4, unknown: 0 });
  expect(q.fields["review.reviewerFamily"]).toEqual({ n: 4, unknown: 3 });
  expect(q.fields["review.scope"]).toEqual({ n: 4, unknown: 3 });
  expect(q.fields["review.rounds"]).toEqual({ n: 4, unknown: 0 });
  expect(q.fields["merge.ciRuns"]).toEqual({ n: 4, unknown: 3 });
  expect(q.fields["delivery.needsReview"]).toEqual({ n: 4, unknown: 0 });
  expect(q.fields["memory.rendered"]).toEqual({ n: 4, unknown: 4 });
  expect(q.fields["person.permissions"]).toEqual({ n: 4, unknown: 4 });
  expect(q.fields["stalls"]).toEqual({ n: 4, unknown: 0 });
  // Only cancelled records have a cause; two of the three have none the board retains.
  expect(q.fields["cancelCause"]).toEqual({ n: 3, unknown: 2 });
  expect(Object.keys(q.fields)).toEqual([...Object.keys(q.fields)].sort((a, b) => a.localeCompare(b)));
});

test("AC4: without the board and journal the same records are unknown where the board would speak, and nothing reads as zero", () => {
  const bare = taskRecords(events(), PROJECT, writer, NO_EVIDENCE);
  const q = buildResearchQuality(bare, events(), {}, familyOf);
  expect(q.fields["review.rounds"]).toEqual({ n: 4, unknown: 4 });
  expect(q.fields["delivery.needsReview"]).toEqual({ n: 4, unknown: 4 });
  expect(q.fields["stalls"]).toEqual({ n: 4, unknown: 4 });
  expect(q.fields["handoffs.in"]).toEqual({ n: 4, unknown: 4 });
});

test("AC4: quota coverage per family has readings, gaps over an hour, their total, the 95th percentile between readings and the clock each time came from", () => {
  const q = buildResearchQuality(records(), events(), {}, familyOf);
  // codex: readings at 0, 30, 150, 160 min; gaps 30, 120 and 10 min; one is over an hour; p95 by nearest rank of [10, 30, 120] is the largest.
  expect(q.quota.codex).toEqual({ readings: 4, gaps: 1, gapMs: 120 * MIN, stalenessP95Ms: 120 * MIN, clock: { event: 4, measured: 0 } });
  // claude: the second reading carries its own measurement time (20 min), so the gap is 10 min, not 90.
  expect(q.quota.claude).toEqual({ readings: 2, gaps: 0, gapMs: 0, stalenessP95Ms: 10 * MIN, clock: { event: 1, measured: 1 } });
  expect(QUOTA_GAP_MS).toBe(60 * MIN);
});

test("AC4: a family with one reading has readings and no staleness, never a zero gap", () => {
  const q = buildResearchQuality([], [quota(0, "kimi")], {}, familyOf);
  expect(q.quota.kimi).toEqual({ readings: 1, gaps: 0, gapMs: 0, stalenessP95Ms: null, clock: { event: 1, measured: 0 } });
});

test("AC4: budget pauses and resumes are counted per family, and the token attribution share is by rule with null when nothing was counted", () => {
  const q = buildResearchQuality(records(), events(), {}, familyOf);
  expect(q.budget).toEqual({ pauses: 2, resumes: 1, handoffs: 0, byFamily: { claude: { pauses: 1, resumes: 0 }, codex: { pauses: 1, resumes: 1 } } });
  expect(q.tokenAttribution.total).toBe(100);
  expect(q.tokenAttribution.share.delivery).toBeCloseTo(0.6, 10);
  expect(q.tokenAttribution.share.single_open).toBeCloseTo(0.3, 10);
  expect(q.tokenAttribution.share.unattributed).toBeCloseTo(0.1, 10);
  expect(buildResearchQuality([], [], {}, familyOf).tokenAttribution).toEqual({ total: 0, share: { delivery: null, single_open: null, unattributed: null } });
});

test("#802: budget hand-offs count the owner moves a budget pause drove, once per move, and are null, not 0, when the window has no task event", () => {
  const moved = (min: number, id: number, reason?: string, event = "reassigned") => taskEvent(min, id, event, "in_progress", { owner: "kimi", ...(reason ? { reason } : {}) });
  const log = [
    ...events(),
    moved(6, 1, "budget"), moved(7, 2, "budget"), moved(8, 2, "budget"),
    // Not a budget hand-off: another reason, no reason, another event carrying the reason, and a pause that found no taker (an unassigned entry has no owner move).
    moved(9, 3, "offline"), moved(10, 3, "declined"), moved(11, 3), moved(12, 4, "budget", "accepted"),
  ];
  expect(buildResearchQuality(records(), log, {}, familyOf).budget.handoffs).toBe(3);
  // The window decides: only the hand-offs at 6 and 7 minutes sit before 8.
  expect(buildResearchQuality(records(), log, { until: minutes(7.5) }, familyOf).budget.handoffs).toBe(2);
  // Task events inside the window but none of them a hand-off: a known zero.
  expect(buildResearchQuality(records(), events(), {}, familyOf).budget.handoffs).toBe(0);
  // No task event in the window: unknown, even with pauses present, and an empty log likewise.
  expect(buildResearchQuality(records(), [ev(5, { type: "budget_pause", peer: "codex", reason: "five_hour", window: "5h", resetsAt: 0, by: "hub" })], {}, familyOf).budget).toEqual({ pauses: 1, resumes: 0, handoffs: null, byFamily: { codex: { pauses: 1, resumes: 0 } } });
  expect(buildResearchQuality([], [], {}, familyOf).budget.handoffs).toBeNull();
});

test("AC4: outcomes are per family of the last owner and class, and the event types present and absent are named", () => {
  const q = buildResearchQuality(records(), events(), {}, familyOf);
  expect(q.outcomes).toEqual({
    claude: { implement: { approved: 0, cancelled: 1, firstPass: 0, changesRequested: 0 } },
    codex: { implement: { approved: 1, cancelled: 1, firstPass: 0, changesRequested: 1 } },
    kimi: { implement: { approved: 0, cancelled: 1, firstPass: 0, changesRequested: 0 } },
  });
  // Task events: 8 for task 1, 3 for task 2, 5 for task 3, 3 for task 4.
  expect(q.events.present).toMatchObject({ task: 19, envelope: 3, quota: 6, budget_pause: 2, budget_resume: 1, tokens: 3, cohort: 1, memory_brief: 1 });
  expect(q.events.absent).toEqual(["usage", "turn_end", "hub_start"]);
});

test("AC4: a window keeps the records closed inside it and the events at its times", () => {
  const q = buildResearchQuality(records(), events(), { since: minutes(25) }, familyOf);
  expect(q.records).toBe(3);
  expect(q.window.since).toBe(new Date(minutes(25)).toISOString());
  // Readings at 30, 150 and 160 min remain: gaps of 120 and 10 min.
  expect(q.quota.codex).toEqual({ readings: 3, gaps: 1, gapMs: 120 * MIN, stalenessP95Ms: 120 * MIN, clock: { event: 3, measured: 0 } });
  expect(q.budget.pauses).toBe(0);
  expect(q.tokenAttribution.total).toBe(0);
  expect(q.outcomes.codex).toEqual({ implement: { approved: 0, cancelled: 1, firstPass: 0, changesRequested: 0 } });
});

test("the report is text-free: no peer id of a project's own choosing, only families", () => {
  const custom = (peer: string) => peer === "codex-review" ? "codex" : familyOf(peer);
  const q = buildResearchQuality(records(), [...events(), quota(1, "private-instance-7")], {}, custom);
  const text = JSON.stringify(q);
  expect(text).not.toContain("private-instance-7");
  expect(text).not.toContain("codex-review");
  expect(q.quota.unknown).toMatchObject({ readings: 1 });
});

test("the report reads nothing it did not get: building it twice from the same input gives the same bytes", () => {
  const input = records();
  expect(JSON.stringify(buildResearchQuality(input, events(), {}, familyOf))).toBe(JSON.stringify(buildResearchQuality(input, events(), {}, familyOf)));
});
