import { expect, test } from "bun:test";
import { aggregateUse, orderByUse, recallMemoryLines, type MemoryUse } from "../src/memory/recall.ts";
import { buildResearchQuality } from "../src/hub/research-quality.ts";
import type { StampedEvent } from "../src/hub/events.ts";

// hub task 976 (#1330): the long-term preface section is ordered by observed use. Ids are 8+ hex characters, as the store's are.
const id = (n: number) => n.toString(16).padStart(8, "0") + "a".repeat(24);
const note = (n: number, kind: "decision" | "contract" | "fail" = "decision", text = `note ${n}`) => ({ id: id(n), kind, tier: "long" as const, title: null, text, peer: "claude", about: [] as string[] });
const row = (n: number, delivered: number | null, cited: number | null, deliveryId = `d${n}`) => ({ key: { entryId: id(n), project: "p", deliveryId }, rendered: delivered === null ? null : 1, delivered, cited });
const ids = (lines: string[]) => lines.map(line => /^mem:([0-9a-f]{8})/.exec(line)![1]);
const short = (n: number) => id(n).slice(0, 8);

test("aggregateUse sums the per-delivery rows of one entry and leaves an entry with no observed row out (unknown is not zero)", () => {
  const use = aggregateUse([row(1, 3, 1, "a"), row(1, 4, null, "b"), row(1, null, 2, "c"), row(2, null, null), row(3, 0, 0)]);
  expect(use.get(id(1))).toEqual({ delivered: 7, cited: 3 });
  expect(use.has(id(2))).toBe(false);
  expect(use.get(id(3))).toEqual({ delivered: 0, cited: 0 });
  // Malformed numbers observe nothing.
  expect(aggregateUse([{ key: { entryId: id(4) }, delivered: -1, cited: Number.NaN }, { key: { entryId: id(5) }, delivered: 1.5, cited: Infinity }]).size).toBe(0);
});

test("AC1: with fixed counters the order is deterministic, cited lines lead by ratio, and unused lines come last", () => {
  const notes = [1, 2, 3, 4, 5, 6].map(n => note(n));
  const usage = aggregateUse([
    row(1, 25, 0),            // unused: delivered at least 20, never cited -> last tier
    row(2, 10, 5),            // ratio 0.5
    row(3, 4, 4),             // ratio 1
    row(4, 19, 0),            // delivered fewer than 20 times: not yet unused, keeps its place
    row(6, 30, 0),            // unused
    // 5 has no row at all: unknown, keeps its place
  ]);
  const once = orderByUse(notes, usage, 20).map(n => n.id), twice = orderByUse(notes, usage, 20).map(n => n.id);
  expect(once).toEqual(twice);
  expect(once).toEqual([id(3), id(2), id(4), id(5), id(1), id(6)]);
  // A permutation of the input with the same counters gives the same tiers: the cited and unused ends do not move.
  const shuffled = orderByUse([...notes].reverse(), usage, 20).map(n => n.id);
  expect(shuffled.slice(0, 2)).toEqual([id(3), id(2)]);
  expect(new Set(shuffled.slice(-2))).toEqual(new Set([id(1), id(6)]));
});

test("AC1: under a small display budget the unused lines are the ones the cap cuts", () => {
  const notes = [1, 2, 3, 4, 5].map(n => note(n));
  const usage = aggregateUse([row(1, 40, 0), row(2, 40, 0), row(3, 6, 3)]);
  const kept = recallMemoryLines(notes, 3, () => false, list => orderByUse(list, usage, 20));
  expect(ids(kept)).toEqual([short(3), short(4), short(5)]);
  // Without the order the same cap would have kept the two unused lines first.
  expect(ids(recallMemoryLines(notes, 3))).toEqual([short(1), short(2), short(3)]);
});

test("AC2: counters that are absent, null or switched off keep today's order exactly", () => {
  const notes = [3, 1, 2].map(n => note(n));
  const today = recallMemoryLines(notes);
  expect(recallMemoryLines(notes, 30, () => false, list => orderByUse(list, undefined, 20))).toEqual(today);
  expect(recallMemoryLines(notes, 30, () => false, list => orderByUse(list, aggregateUse([]), 20))).toEqual(today);
  expect(recallMemoryLines(notes, 30, () => false, list => orderByUse(list, aggregateUse([row(1, null, null), row(2, null, null)]), 20))).toEqual(today);
  // The setting at 0 turns the reorder off even with counters that would move lines.
  expect(recallMemoryLines(notes, 30, () => false, list => orderByUse(list, aggregateUse([row(3, 99, 0)]), 0))).toEqual(today);
  expect(recallMemoryLines(notes)).toEqual(today); // no order function at all
});

test("an entry cited at least once is never in the unused tier, however often it was delivered", () => {
  const usage = new Map<string, MemoryUse>([[id(1), { delivered: 500, cited: 1 }], [id(2), { delivered: 500, cited: 0 }]]);
  expect(orderByUse([note(2), note(1)], usage, 20).map(n => n.id)).toEqual([id(1), id(2)]);
});

test("AC3: the quality report counts prefaces, their bytes and lines and how many were reordered, null when none was recorded", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 16, 0, n)).toISOString();
  const preface = (n: number, bytes: number, lines: number, ordered: boolean): StampedEvent => ({ type: "preface", peer: "codex", bytes, lines, ordered, at: at(n) } as StampedEvent);
  expect(buildResearchQuality([], [], {}, p => p).events.preface).toBeNull();
  const q = buildResearchQuality([], [preface(1, 1200, 10, false), preface(2, 800, 7, true), preface(3, 400, 3, true)], {}, p => p);
  expect(q.events.preface).toEqual({ prefaces: 3, bytes: 2400, lines: 20, ordered: 2 });
  expect(q.events.present).toMatchObject({ preface: 3 });
  // A malformed event counts nowhere.
  expect(buildResearchQuality([], [{ type: "preface", peer: "codex", bytes: -1, lines: 2, ordered: true, at: at(1) } as StampedEvent], {}, p => p).events.preface).toBeNull();
});
