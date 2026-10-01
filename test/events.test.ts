import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLog, parseSince, readEvents, tokenDeltas, type StampedEvent } from "../src/hub/events.ts";
import { formatReport, summarize } from "../src/hub/report.ts";

// issue #40: the report is computed from events.jsonl alone.
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
const ev = (s: number, e: object) => ({ v: 1, at: at(s), ...e }) as StampedEvent;

test("summarize counts turns, tokens, messages, overlaps, task events and quota readings", () => {
  const r = summarize([
    ev(0, { type: "turn_start", peer: "kimi", turn: "kimi#a.1" }),
    ev(1, { type: "tokens", peer: "kimi", n: 120 }),
    ev(30, { type: "turn_end", peer: "kimi", turn: "kimi#a.1", ms: 30_000, tokens: 120 }),
    ev(31, { type: "envelope", id: "e1", from: "user", to: ["kimi"], priority: "status", hop: 0, bytes: 5, task: "3" }),
    ev(32, { type: "envelope", id: "e2", from: "kimi", priority: "fyi", hop: 1, bytes: 9, dropped: "fyi", task: "3" }),
    ev(33, { type: "overflow", id: "e3", from: "codex", peer: "kimi" }),
    ev(34, { type: "overlap", task: 2, owner: "codex", others: [{ task: 1, owner: "kimi", paths: ["src/a.ts"] }] }),
    ev(35, { type: "overlap", task: 2, owner: "local", others: [{ task: 1, owner: "kimi", paths: ["src/a.ts"] }] }),
    ev(36, { type: "task", id: 1, event: "proposed", by: "kimi", state: "proposed", owner: null, reviewer: null, class: "implement", pii: false }),
    ev(37, { type: "quota", peer: "codex", windows: [{ id: "5h", used: 0.95 }], hard: true }),
  ]);
  expect(r.peers.kimi).toEqual({ turns: 1, busyMinutes: 0.5, tokens: 120 });
  expect(r.messages).toEqual({ total: 2, dropped: { fyi: 1 }, overflow: 1, undeliverable: 0, perTask: 2 });
  expect(r.overlaps).toEqual({ warnings: 2, pairs: 1 }); // the same two tasks warned twice
  expect(r.tasks).toEqual({ proposed: 1 });
  expect(r.quota).toEqual({ readings: 1, hard: 1 });
  expect(formatReport(r)[1]).toBe("peer kimi: 1 turn, 0.5 busy minutes, 120 tokens");
});

test("--since takes durations and ISO dates", () => {
  const now = Date.UTC(2026, 9, 8);
  expect(parseSince("7d", now)).toBe(Date.UTC(2026, 9, 1));
  expect(parseSince("90m", now)).toBe(now - 90 * 60_000);
  expect(parseSince("7")).toBeUndefined(); // Date.parse would read a year
  expect(parseSince("10/1")).toBeUndefined();
  expect(parseSince("2026-10-01T00:00:00Z", now)).toBe(Date.UTC(2026, 9, 1));
  expect(parseSince("soon", now)).toBeUndefined();
});

test("token totals become increments per session; a new thread counts from zero whatever its first total", () => {
  const d = tokenDeltas();
  expect([d("codex", 100, "th1"), d("codex", 250, "th1")]).toEqual([100, 150]);
  expect(d("codex", 400, "th2")).toBe(400); // a new thread above the old total is not undercounted
  expect(d("codex", 50, "th2")).toBe(50); // reset within a session
  expect(d("kimi", 30, "s1")).toBe(30); // per peer
});

test("after a crash cut the last line short, the next event still lands on a line of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-events-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, `${JSON.stringify({ v: 1, at: "2026-10-01T00:00:00.000Z", type: "tokens", peer: "kimi", n: 1 })}\n{"v":1,"at":"2026-10-01T00:00:01`);
  const log = eventLog(file);
  log({ type: "tokens", peer: "codex", n: 5 });
  log({ type: "tokens", peer: "codex", n: 6 });
  expect(readEvents(file).map((e) => (e as { n: number }).n)).toEqual([1, 5, 6]);
  rmSync(dir, { recursive: true, force: true });
});
