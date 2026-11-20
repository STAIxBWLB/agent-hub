import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StampedEvent } from "../src/hub/events.ts";
import { readEvents, scanEventLines } from "../src/hub/events.ts";
import { readStartupEventSeeds } from "../src/hub/startup-event-seeds.ts";
import { ResearchTail, taskRecords } from "../src/hub/research.ts";
import { UsageRollup } from "../src/hub/usage-rollup.ts";
import { dogfoodLines } from "../src/hub/dogfood-read.ts";
import { reviewerAccountingIntegrity, reviewerAccountingRelevant } from "../src/hub/review-budget.ts";
import { lastEventTime, rotateEventsIfLarge, rotateSegments, rotateTextLogAtStart, segmentsOf, streamEnd, textLogRotator } from "../src/hub/log-rotation.ts";

// #1546: events.jsonl and hub.log rotate by size, and every reader sees the same stream as before: the rotated segments oldest first, then the live file.

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ahub-log-rotation-"))); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
let clock = Date.parse("2026-11-01T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const ev = (e: Record<string, unknown>): StampedEvent => ({ v: 1, at: at(), ...e }) as StampedEvent;
const line = (e: StampedEvent) => JSON.stringify(e) + "\n";
const task = (id: number, event: string, state: string, owner: string | null = "worker", by = "hub") => ev({ type: "task", id, event, by, state, owner, reviewer: "claude", class: "implement", pii: false });
const turn = (peer: string, id: number) => ev({ type: "turn_end", peer, turn: `${peer}#${id}`, ms: 1000, task: id, attribution: "delivery", model: "gpt-5.5", modelEvidence: "session" });
const usage = (id: string, n: number, t: number) => ev({ type: "usage", peer: "worker", source: "omniroute", id, totalTokens: n, task: t, attribution: "delivery", servedModel: "gpt-5.5" });
const tokens = (n: number, t: number) => ev({ type: "tokens", peer: "worker", n, task: t, attribution: "delivery" });
const lifecycle = (id: number, between: StampedEvent[] = []) => [task(id, "proposed", "proposed"), task(id, "assigned", "in_progress"), ...between, task(id, "done", "in_review"), task(id, "approved", "approved", "worker", "claude")];
const writer = { version: "test", source: "live" as const };
const text = (events: StampedEvent[]) => events.map(line).join("");

/** The stream a reader should see: the whole log as one file would have held it. */
function stream(file: string) { return segmentsOf(file).map(segment => readFileSync(segment.path, "utf8")).join(""); }

test("a rotated log reads as the one stream it was: readEvents, scanEventLines and the segment list agree", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const all = [...lifecycle(1, [turn("worker", 1), usage("u1", 10, 1)]), ...lifecycle(2, [turn("worker", 2)])];
  writeFileSync(file, text(all.slice(0, 4)));
  expect(rotateSegments(file, { keep: 3, mode: "rename" }).rotated).toBe(true);
  appendFileSync(file, text(all.slice(4, 8)));
  expect(rotateSegments(file, { keep: 3, mode: "rename" }).rotated).toBe(true);
  appendFileSync(file, text(all.slice(8)));
  const segments = segmentsOf(file);
  expect(segments.map(segment => segment.live)).toEqual([false, false, true]);
  expect(segments.map(segment => segment.start)).toEqual([0, segments[0]!.size, segments[0]!.size + segments[1]!.size]);
  expect(readEvents(file)).toEqual(all);
  const seen: string[] = [], offsets: number[] = [];
  expect(scanEventLines(file, 0, (l, o) => { seen.push(l); offsets.push(o); })).toBe(streamEnd(segments));
  expect(seen.join("\n") + "\n").toBe(stream(file));
  // An offset is a position in the combined stream: scanning from the third line's offset yields the rest, across the segment boundary.
  const rest: string[] = []; scanEventLines(file, offsets[2]!, l => rest.push(l));
  expect(rest).toEqual(seen.slice(2));
});

test("a rotation drops the oldest segment past the bound, and an offset below the oldest kept byte starts at it", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const first = [task(1, "proposed", "proposed"), task(1, "assigned", "in_progress")], second = [turn("worker", 1), usage("u1", 10, 1)], third = [task(1, "done", "in_review")];
  writeFileSync(file, text(first)); rotateSegments(file, { keep: 2, mode: "rename" });
  appendFileSync(file, text(second)); rotateSegments(file, { keep: 2, mode: "rename" });
  appendFileSync(file, text(third));
  const result = rotateSegments(file, { keep: 2, mode: "rename" });
  expect(result.dropped.map(x => x.start)).toEqual([0]);
  expect(segmentsOf(file).filter(segment => !segment.live)).toHaveLength(2);
  expect(readEvents(file)).toEqual([...second, ...third]);
  const lines: string[] = []; scanEventLines(file, 0, l => lines.push(l));
  expect(lines).toHaveLength(3); // from 0 starts at the oldest kept segment
});

test("the oldest segment is kept while it holds an open task's events, and dropped once it does not", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const old = [task(1, "proposed", "proposed"), turn("worker", 1)], mid = [turn("worker", 1)], fresh = [turn("worker", 1)];
  writeFileSync(file, text(old)); rotateSegments(file, { keep: 1, mode: "rename" });
  appendFileSync(file, text(mid));
  const openSince = Date.parse(old[0]!.at);
  const keepWhileOpen = (segment: { path: string }) => { const last = lastEventTime(segment.path); return last === undefined || last >= openSince ? "an open task's events are in it" : undefined; };
  const kept = rotateSegments(file, { keep: 1, mode: "rename", keepOldest: keepWhileOpen });
  expect(kept.kept?.reason).toContain("open task"); expect(kept.dropped).toEqual([]);
  expect(segmentsOf(file).filter(segment => !segment.live)).toHaveLength(2); // grew past the bound rather than dropping
  expect(readEvents(file)).toEqual([...old, ...mid]);
  appendFileSync(file, text(fresh));
  const later = rotateSegments(file, { keep: 1, mode: "rename", keepOldest: segment => lastEventTime(segment.path)! >= Date.now() + 1e12 ? "x" : undefined });
  expect(later.dropped).toHaveLength(2); // every segment past the bound, not one
});

test("rotateEventsIfLarge leaves a small log alone, ends a crash-cut last line before moving it, and refuses to overwrite a segment", () => {
  const d = dir(), file = join(d, "events.jsonl");
  writeFileSync(file, text([task(1, "proposed", "proposed")]));
  expect(rotateEventsIfLarge(file, { maxBytes: 1_000_000 }).rotated).toBe(false);
  appendFileSync(file, '{"v":1,"at":"2026-11-01T00:00:00.000Z","type":"sta'); // cut short by a crash
  expect(rotateEventsIfLarge(file, { maxBytes: 10 }).rotated).toBe(true);
  expect(readFileSync(segmentsOf(file)[0]!.path, "utf8").endsWith("\n")).toBe(true); // no line spans two files
  expect(existsSync(file)).toBe(false);
  // A leftover file already named for the next segment's start offset would be overwritten by the move: refuse, and leave it alone.
  writeFileSync(file, text([task(2, "proposed", "proposed")]));
  // Only an empty file can sit at the live file's own start offset (any bytes in it would move that offset), so the squatter is empty.
  const squatter = `${file}.${segmentsOf(file).at(-1)!.start}`;
  writeFileSync(squatter, "");
  expect(segmentsOf(file).at(-1)!.live).toBe(true);
  expect(() => rotateSegments(file, { keep: 3, mode: "rename" })).toThrow("already exists");
  expect(readFileSync(squatter, "utf8")).toBe("");
  expect(readFileSync(file, "utf8")).toContain('"id":2'); // the live file is untouched
  expect(() => rotateSegments(file, { keep: 0, mode: "rename" })).toThrow("at least one segment");
});

test("hub.log: copy-truncate keeps the writer's descriptor valid, and the start pass moves an oversized log aside", () => {
  const d = dir(), file = join(d, "hub.log");
  const rotate = textLogRotator(file, 200, 2, 1);
  const writeLine = (n: number) => { appendFileSync(file, `${"x".repeat(80)} ${n}\n`); rotate(); };
  for (let n = 0; n < 12; n++) writeLine(n);
  const segments = segmentsOf(file);
  expect(segments.filter(segment => !segment.live).length).toBeLessThanOrEqual(2);
  expect(segments.at(-1)!.live).toBe(true);
  const kept = stream(file).trimEnd().split("\n");
  expect(kept.at(-1)).toContain(" 11"); // the newest line is always in the live file or the newest segment
  expect(kept.every(l => l.startsWith("x".repeat(80)))).toBe(true);
  const start = join(d, "start.log");
  writeFileSync(start, "y".repeat(500) + "\n");
  expect(rotateTextLogAtStart(start, 100, 2)).toBe(true);
  expect(existsSync(start)).toBe(false);
  expect(readFileSync(segmentsOf(start)[0]!.path, "utf8")).toBe("y".repeat(500) + "\n");
  expect(rotateTextLogAtStart(join(d, "missing.log"), 100, 2)).toBe(false);
  expect(dogfoodLines(file).complete).toBe(false); // the tail read says it is not the whole history once the log has rotated
});

test("startup seeds read every kept segment, so a restart keeps every dedupe key", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const a = ev({ type: "native_turn_end", peer: "claude", id: "t1" }), b = ev({ type: "native_turn_end", peer: "claude", id: "t2" });
  writeFileSync(file, text([a])); rotateSegments(file, { keep: 3, mode: "rename" });
  appendFileSync(file, text([b]));
  const seeds = readStartupEventSeeds(file);
  expect(seeds.events.map(e => e.type)).toEqual(["native_turn_end", "native_turn_end"]);
  expect([...seeds.nativeStopsSeen].sort()).toEqual(["t1", "t2"]);
  expect(seeds.complete).toBe(true);
});

test("the usage roll-up folds across a rotation to the same totals as an unrotated log, and its offset survives the move", () => {
  const events = [task(1, "proposed", "proposed"), tokens(100, 1), usage("u1", 10, 1), tokens(50, 1), usage("u2", 5, 1), tokens(25, 1), usage("u3", 7, 1)];
  const plain = dir(), plainFile = join(plain, "events.jsonl"); writeFileSync(plainFile, text(events));
  const expected = new UsageRollup(join(plain, "hub.db"), plainFile); cleanup.push(() => expected.close()); expected.catchUp();
  const d = dir(), file = join(d, "events.jsonl");
  const rollup = new UsageRollup(join(d, "hub.db"), file); cleanup.push(() => rollup.close());
  writeFileSync(file, text(events.slice(0, 3))); rollup.catchUp();               // folded, then rotated away
  rotateSegments(file, { keep: 3, mode: "rename" });
  appendFileSync(file, text(events.slice(3, 5))); rollup.catchUp();              // the live file restarted: the stored offset still means the same bytes
  rotateSegments(file, { keep: 3, mode: "rename" });
  appendFileSync(file, text(events.slice(5))); rollup.catchUp();
  expect(JSON.stringify(rollup.dump())).toBe(JSON.stringify(expected.dump()));
  // A roll-up that was behind when the log rotated folds the rotated segment too, not just the live file.
  const lag = dir(), lagFile = join(lag, "events.jsonl");
  const behind = new UsageRollup(join(lag, "hub.db"), lagFile); cleanup.push(() => behind.close());
  writeFileSync(lagFile, text(events.slice(0, 4))); rotateSegments(lagFile, { keep: 3, mode: "rename" });
  appendFileSync(lagFile, text(events.slice(4))); behind.catchUp();
  expect(JSON.stringify(behind.dump())).toBe(JSON.stringify(expected.dump()));
});

test("research backfill gives the same task records for a log rotated mid-task, and the live tail slices across the rotation", () => {
  const events = [
    ev({ type: "hub_start", instance: "a", personAttribution: true }), ev({ type: "tooling", peer: "worker", addons: [] }),
    ...lifecycle(1, [turn("worker", 1), usage("u1", 10, 1)]),
    task(2, "proposed", "proposed"), task(2, "assigned", "in_progress"),
    turn("worker", 2), usage("u1", 10, 2), usage("u2", 5, 2),
    task(2, "done", "in_review"), task(2, "approved", "approved", "worker", "claude"),
    ...lifecycle(3, [turn("worker", 3), usage("u3", 7, 3)]),
  ];
  const plain = dir(), plainFile = join(plain, "events.jsonl"); writeFileSync(plainFile, text(events));
  const expected = JSON.stringify(taskRecords(readEvents(plainFile), "p", writer));
  const d = dir(), file = join(d, "events.jsonl");
  const cuts = [5, 9, 12];                                                       // task 2 straddles two cuts
  let from = 0;
  for (const cut of cuts) { writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + text(events.slice(from, cut))); rotateSegments(file, { keep: 4, mode: "rename" }); from = cut; }
  appendFileSync(file, text(events.slice(from)));
  expect(segmentsOf(file).filter(segment => !segment.live).length).toBe(3);
  expect(JSON.stringify(taskRecords(readEvents(file), "p", writer))).toBe(expected);
  // The live writer: a tail that caught up before the rotation keeps its offsets after it, and slices a task's events from a rotated segment.
  const tailDir = dir(), tailFile = join(tailDir, "events.jsonl"); writeFileSync(tailFile, text(events.slice(0, 7)));
  const tail = new ResearchTail(tailFile); tail.events(1);                        // caught up to the first 7 lines
  rotateSegments(tailFile, { keep: 4, mode: "rename" });
  appendFileSync(tailFile, text(events.slice(7)));
  const slice = tail.events(2);
  expect(slice.start).toBeDefined();                                              // task 2's start is in the rotated segment, and it still slices from there
  const fromTail = taskRecords(slice.events, "p", writer, undefined, slice.start).find(record => record.task === 2);
  const whole = taskRecords(readEvents(plainFile), "p", writer).find(record => record.task === 2);
  expect(JSON.stringify(fromTail)).toBe(JSON.stringify(whole));
  // Retention that drops the segment holding a task's start makes that task read whole, which is what backfill does with what the log still holds.
  rotateSegments(tailFile, { keep: 1, mode: "rename" });                          // the segment before task 2's start is dropped; its start is still kept
  expect(tail.events(2).start).toBeDefined();
  appendFileSync(tailFile, text([task(9, "proposed", "proposed")]));
  rotateSegments(tailFile, { keep: 1, mode: "rename" });                          // now the segment holding task 2's start is dropped
  expect(segmentsOf(tailFile).filter(segment => !segment.live)).toHaveLength(1);
  const whole2 = tail.events(2);
  expect(whole2.start).toBeUndefined();
  expect(whole2.events.length).toBeGreaterThan(0);
});

test("one rotation brings the count back to the keep limit after a hold ends, and onDrop sees each dropped segment", () => {
  const d = dir(), file = join(d, "events.jsonl");
  let hold = true; const dropped: number[] = [];
  const options = { keep: 3, mode: "rename" as const, keepOldest: () => hold ? "held" : undefined, onDrop: (s: { start: number }) => { dropped.push(s.start); } };
  for (let i = 0; i < 7; i++) { appendFileSync(file, text([turn("worker", 1)])); rotateSegments(file, options); }
  expect(segmentsOf(file).filter(segment => !segment.live)).toHaveLength(7);
  hold = false; appendFileSync(file, text([turn("worker", 1)]));
  const result = rotateSegments(file, options);
  expect(result.dropped).toHaveLength(5); expect(dropped).toHaveLength(5);
  expect(segmentsOf(file).filter(segment => !segment.live)).toHaveLength(3 + 0); // keep-1 older ones plus the one just rotated
});

test("a rotation failure reaches the caller", () => {
  const d = dir(), file = join(d, "events.jsonl");
  writeFileSync(file, text([turn("worker", 1)]));
  chmodSync(d, 0o500); // the rename cannot create the segment name
  try { expect(() => rotateEventsIfLarge(file, { maxBytes: 1 })).toThrow(); } finally { chmodSync(d, 0o700); }
});

test("dropping a segment with accounting rows from the in-memory journal keeps the restart commitment equal to the replay of the kept segments", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const acct = (attempt: string, outcome: string) => ({ v: 1, at: "2026-11-14T00:00:00.000Z", type: "reviewer_accounting", peer: "kimi", attempt: attempt.repeat(32), outcome }) as unknown as StampedEvent;
  const batches = [[acct("a", "started"), acct("a", "complete")], [acct("b", "started")], [acct("c", "started"), acct("c", "unknown")]];
  const journal: unknown[] = [];
  const accountingRows = new Map<string, number>();
  const options = { keep: 2, mode: "rename" as const,
    keepOldest: (segment: { path: string }) => { accountingRows.set(segment.path, readStartupEventSeeds(segment.path).events.filter(row => reviewerAccountingRelevant(row)).length); return undefined; },
    onDrop: (segment: { path: string }) => { journal.splice(0, accountingRows.get(segment.path) ?? 0); } };
  for (const batch of batches) { appendFileSync(file, text(batch)); journal.push(...batch); rotateSegments(file, options); }
  appendFileSync(file, text([acct("d", "started")])); journal.push(acct("d", "started"));
  const replay = readStartupEventSeeds(file).events.filter(row => reviewerAccountingRelevant(row));
  expect(journal.length).toBe(replay.length);
  expect(reviewerAccountingIntegrity(journal, true)).toEqual(reviewerAccountingIntegrity(replay, true));
});
