import { expect, test } from "bun:test";
import { checkRoadmap, type RoadmapDriftInput } from "../src/hub/roadmap-check.ts";

test("each drift family is detectable and clean evidence stays clean", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: false,
    milestones: [{ id: 1, state: "done", openItems: true, mergedCode: true, mirrorDiff: true,
      specs: [{ id: "sample", state: "stale" }], tasks: [
        { id: 1, state: "in_progress", issue: "example/repo#1", issueState: "closed", feature: true, mergedAt: null, unchangedSpecs: [] },
        { id: 2, state: "approved", issue: "example/repo#2", issueState: "open", feature: true, mergedAt: 1000, unchangedSpecs: ["sample"] },
        { id: 3, state: "in_progress", issue: null, issueState: "open", feature: true, mergedAt: null, unchangedSpecs: [] },
      ] }] };
  expect([...new Set(checkRoadmap(input).findings.map(row => row.rule))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const clean: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: true,
    milestones: [{ id: 1, state: "active", openItems: true, mergedCode: true, mirrorDiff: false,
      specs: [{ id: "sample", state: "fresh" }], tasks: [{ id: 1, state: "approved", issue: "example/repo#1", issueState: "closed", feature: true, mergedAt: 1000, unchangedSpecs: [] }] }] };
  expect(checkRoadmap(clean)).toEqual({ findings: [], unknown: [] });
});

test("unavailable evidence is unknown and merge close lag suppresses early findings", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: undefined,
    milestones: [{ id: 1, state: "active", openItems: undefined, mergedCode: undefined, mirrorDiff: undefined, specs: [], tasks: [
      { id: 1, state: "approved", issue: "example/repo#1", issueState: "open", feature: true, mergedAt: 9500, unchangedSpecs: [] },
      { id: 2, state: "in_progress", issue: undefined, issueState: "unknown", feature: true, mergedAt: undefined, unchangedSpecs: undefined },
    ] }] };
  expect(checkRoadmap(input)).toEqual({ findings: [], unknown: [1, 2, 3, 4, 5, 6, 7, 8] });
});

test("a task known to have no issue does not need issue state evidence", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: false, exportMatches: true,
    milestones: [{ id: 1, state: "active", openItems: true, mergedCode: false, mirrorDiff: undefined, specs: [], tasks: [
      { id: 1, state: "in_progress", issue: null, issueState: "unknown", feature: false, mergedAt: null, unchangedSpecs: [] },
    ] }] };
  const result = checkRoadmap(input);
  expect(result.unknown).toEqual([]);
  expect(result.findings.map(row => row.rule)).toEqual([6]);
});
