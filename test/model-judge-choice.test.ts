import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { HubEvent, StampedEvent } from "../src/hub/events.ts";
import type { RouteEvent } from "../src/models/route/runtime.ts";
import { summarize, summarizeByTask } from "../src/hub/report.ts";
import { taskRecords } from "../src/hub/research.ts";
import { buildResearchQuality, type QualityReport } from "../src/hub/research-quality.ts";

const stamp = (seconds: number, event: HubEvent): StampedEvent => ({ v: 1, at: new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString(), ...event });
const executor = (): Extract<HubEvent, { type: "route" }> => ({ type: "route", peer: "local", route: "hub/fixture", tier: "fast", source: "default", score: 0, ms: 1 });
const judge = (): Extract<HubEvent, { type: "route" }> => ({ ...executor(), tier: "coding", decisionTarget: "judge", decisionMode: "shadow", chosenAlias: "coding", chosenEffort: "high", margin: 0.8 });

test("judge observations cannot change report time bounds, decisions, switches or task accounting", () => {
  const baseline = [stamp(10, executor()), stamp(20, executor())];
  const observed = [stamp(0, judge()), baseline[0]!, stamp(15, judge()), baseline[1]!, stamp(30, judge())];
  expect(summarize(observed)).toEqual(summarize(baseline));
  expect(summarizeByTask(observed)).toEqual(summarizeByTask(baseline));
  expect(summarize(observed).routes["local hub/fixture"]).toMatchObject({ decisions: 2, switches: 0 });
});

function researchEvents(): StampedEvent[] {
  const task = { type: "task" as const, id: 51, by: "local", owner: "local", reviewer: "claude", class: "implement", pii: false };
  return [stamp(1, { ...task, event: "proposed", state: "proposed" }),
    stamp(2, { ...task, event: "accepted", state: "in_progress" }),
    stamp(3, { ...executor(), task: 51 }),
    stamp(4, { ...task, event: "approved", state: "approved" })];
}

test("even a linked judge row cannot create research peer, model, privacy or cohort credit", () => {
  const events = researchEvents();
  // Defensive reader case: the approved producer omits this task/PII linkage.
  const linked = stamp(3.5, { ...judge(), task: 51, pii: true, peer: "metadata-only", route: "hub/observer-only" });
  const baseline = taskRecords(events, "fixture-project", { version: "0.0.0", source: "backfill" });
  const observed = taskRecords([...events.slice(0, 3), linked, ...events.slice(3)], "fixture-project", { version: "0.0.0", source: "backfill" });
  expect(baseline).toHaveLength(1);
  expect(observed).toEqual(baseline);
});

function businessQuality(value: QualityReport) {
  // Enumerate ALL non-census fields; a future field requires an explicit audit.
  expect(Object.keys(value).sort()).toEqual(["schema", "window", "records", "fields", "quota", "budget", "outcomes", "tokenAttribution", "events"].sort());
  return { schema: value.schema, window: value.window, records: value.records, fields: value.fields, quota: value.quota,
    budget: value.budget, outcomes: value.outcomes, tokenAttribution: value.tokenAttribution };
}

test("quality business fields stay byte-identical while raw route census truthfully includes judge rows", () => {
  const events = researchEvents(), records = taskRecords(events, "fixture-project", { version: "0.0.0", source: "backfill" });
  const observedEvents = [...events, stamp(5, judge()), stamp(6, judge())];
  const baseline = buildResearchQuality(records, events), observed = buildResearchQuality(records, observedEvents);
  expect(JSON.stringify(businessQuality(observed))).toBe(JSON.stringify(businessQuality(baseline)));
  expect(observed.events.absent).toEqual(baseline.events.absent);
  const otherTypes = (value: QualityReport) => Object.fromEntries(Object.entries(value.events.present).filter(([type]) => type !== "route"));
  expect(JSON.stringify(otherTypes(observed))).toBe(JSON.stringify(otherTypes(baseline)));
  expect(observed.events.present.route).toBe((baseline.events.present.route ?? 0) + 2);
});

test("the owned corpus callback retains the last executor observation, not judge metadata", () => {
  const source = readFileSync(new URL("../scripts/benchmarks/model-routing-corpus.ts", import.meta.url), "utf8");
  // ponytail: this owned harness callback is a one-line closure. If it gains dependencies or grows,
  // expose a host callback factory and bind its actual ports instead of widening this extractor.
  const matches = [...source.matchAll(/onRoute:\s*(event\s*=>\s*\{[^\n]*\}),/g)];
  expect(matches).toHaveLength(1);
  const kept: RouteEvent[] = [];
  const collect: (event: RouteEvent) => void = new Function("events", `return (${matches[0]![1]});`)(kept);
  collect({ route: "hub/fixture", tier: "fast", source: "hold", score: 1, ms: 1, staySwitch: "shadow", prefillTokens: 100 });
  collect({ route: "hub/fixture", tier: "coding", source: "default", score: 0, ms: 1, decisionTarget: "judge" });
  expect(kept).toHaveLength(1);
  expect(kept.at(-1)).toMatchObject({ tier: "fast", source: "hold", staySwitch: "shadow", prefillTokens: 100 });
});
