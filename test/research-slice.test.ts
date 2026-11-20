import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StampedEvent } from "../src/hub/events.ts";
import { readEvents, scanEventLines } from "../src/hub/events.ts";
import { ResearchTail, taskRecords, type TaskRecord } from "../src/hub/research.ts";

// #1555 AC5: the live writer reads a slice of events.jsonl; its row must equal the whole-file fold's row for the same task, byte for byte.

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ahub-research-slice-"))); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
let clock = Date.parse("2026-11-01T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const ev = (e: Record<string, unknown>): StampedEvent => ({ v: 1, at: at(), ...e }) as StampedEvent;
const line = (e: StampedEvent) => JSON.stringify(e) + "\n";
const task = (id: number, event: string, state: string, owner: string | null = "worker", by = "hub") => ev({ type: "task", id, event, by, state, owner, reviewer: "claude", class: "implement", pii: false });
const turn = (peer: string, id: number) => ev({ type: "turn_end", peer, turn: `${peer}#${id}`, ms: 1000, task: id, attribution: "delivery", model: "gpt-5.5", modelEvidence: "session" });
const usage = (id: string, n: number, t: number) => ev({ type: "usage", peer: "worker", source: "omniroute", id, totalTokens: n, task: t, attribution: "delivery", servedModel: "gpt-5.5" });
const quota = () => ev({ type: "quota", peer: "claude", windows: [{ id: "5h", used: 0.1 }], hard: false });
const writer = { version: "test", source: "live" as const };
const lifecycle = (id: number, between: StampedEvent[] = []) => [task(id, "proposed", "proposed"), task(id, "assigned", "in_progress"), ...between, task(id, "done", "in_review"), task(id, "approved", "approved", "worker", "claude")];

function scenario(): StampedEvent[] {
  return [
    ev({ type: "hub_start", instance: "a", personAttribution: true }),
    ev({ type: "state", peer: "worker", state: "idle" }), ev({ type: "state", peer: "claude", state: "idle" }),
    ev({ type: "tooling", peer: "worker", addons: [] }),
    ...lifecycle(1, [turn("worker", 1), usage("u1", 10, 1), quota(), quota(), ev({ type: "memory_brief", peer: "worker", task: 1, native: 2, fails: 1, claudeMem: 0 })]),
    // Task 2 is open while task 1 closes; a usage row with the key task 1 already counted is not counted again, and the worker re-attaches in between.
    task(2, "proposed", "proposed"), task(2, "assigned", "in_progress"),
    ev({ type: "state", peer: "worker", state: "offline" }), ev({ type: "state", peer: "worker", state: "idle" }),
    ev({ type: "tooling", peer: "worker", addons: [] }),
    turn("worker", 2), usage("u1", 10, 2), usage("u2", 5, 2), quota(),
    task(2, "done", "in_review"), task(2, "approved", "approved", "worker", "claude"),
    // A restart: a crash writes no offline, a new run is a new attachment.
    ev({ type: "hub_start", instance: "b", personAttribution: true }),
    ev({ type: "state", peer: "worker", state: "idle" }),
    ...lifecycle(3, [turn("worker", 3), usage("u3", 7, 3), ev({ type: "envelope", id: "e1", from: "worker", priority: "normal", hop: 0, task: "3" })]),
    // An id the log starts twice (ahub reset --all kept both): the earlier incarnation's record comes back too.
    ...lifecycle(4, [turn("worker", 4)]), ...lifecycle(4, [turn("worker", 4), usage("u4", 3, 4)]),
    // A cancelled task and one still open.
    task(5, "proposed", "proposed"), task(5, "cancelled", "cancelled"), task(6, "proposed", "proposed"),
  ];
}
const strip = (rows: TaskRecord[]) => JSON.stringify(rows.map(r => ({ ...r, writer: undefined })));

test("the live slice row equals the whole-file row for every closed task, byte for byte", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const events = scenario();
  writeFileSync(file, events.map(line).join(""));
  const tail = new ResearchTail(file);
  const whole = taskRecords(readEvents(file), "p-1", writer);
  expect(whole.length).toBeGreaterThanOrEqual(5);
  for (const id of [1, 2, 3, 4, 5]) {
    const slice = tail.events(id);
    const live = taskRecords(slice.events, "p-1", writer, undefined, slice.start).filter(r => r.task === id);
    expect(live.length).toBeGreaterThan(0);
    expect(strip(live)).toBe(strip(whole.filter(r => r.task === id)));
  }
});

test("a closing task does not read events.jsonl from byte 0, and a later closure reads only what was appended", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const head = scenario();
  writeFileSync(file, head.map(line).join(""));
  const tail = new ResearchTail(file);
  tail.events(3);
  expect(tail.lastRead.from).toBeGreaterThan(0);
  // Task 3 starts after the file's first quarter; the slice is its own part only.
  const slice3 = tail.events(3);
  expect(slice3.events.some(e => e.type === "hub_start")).toBe(false);
  expect(slice3.events.every(e => e.type !== "quota")).toBe(true);
  const more = lifecycle(7, [turn("worker", 7), usage("u7", 1, 7)]);
  appendFileSync(file, more.map(line).join(""));
  const slice7 = tail.events(7);
  expect(slice7.events.map(e => e.type)).toEqual(more.map(e => e.type));
  const live = taskRecords(slice7.events, "p-1", writer, undefined, slice7.start).filter(r => r.task === 7);
  expect(strip(live)).toBe(strip(taskRecords(readEvents(file), "p-1", writer).filter(r => r.task === 7)));
  // A restarted id and a task the tail has no proposal for are read whole, as before.
  expect(tail.events(4).start).toBeUndefined();
  expect(tail.events(99).start).toBeUndefined();
});

test("an archived (shorter) log starts the tail over, and a partial last line waits for its newline", () => {
  const d = dir(), file = join(d, "events.jsonl");
  writeFileSync(file, scenario().map(line).join(""));
  const tail = new ResearchTail(file);
  tail.events(3);
  const fresh = lifecycle(1, [turn("worker", 1)]);
  writeFileSync(file, fresh.map(line).join(""));
  const slice = tail.events(1);
  expect(strip(taskRecords(slice.events, "p-1", writer, undefined, slice.start))).toBe(strip(taskRecords(readEvents(file), "p-1", writer)));
  const seen: string[] = [];
  const cut = JSON.stringify(ev({ type: "stuck", peer: "worker", task: 1 }));
  appendFileSync(file, cut.slice(0, 20));
  const end = scanEventLines(file, 0, l => seen.push(l));
  expect(end).toBe(Buffer.byteLength(fresh.map(line).join("")));
  expect(seen).toHaveLength(fresh.length);
});

test("a multi-byte character across the read chunk boundary does not split a line", () => {
  const d = dir(), file = join(d, "events.jsonl");
  const rows = Array.from({ length: 40 }, (_, i) => JSON.stringify({ i, s: "한".repeat(9000) }) + "\n");
  writeFileSync(file, rows.join(""));
  const got: { i: number; offset: number }[] = [];
  let expected = 0;
  scanEventLines(file, 0, (l, offset) => { got.push({ i: JSON.parse(l).i, offset }); });
  const offsets = rows.map(r => { const o = expected; expected += Buffer.byteLength(r); return o; });
  expect(got.map(g => g.offset)).toEqual(offsets);
  expect(got.map(g => g.i)).toEqual(rows.map((_, i) => i));
});
