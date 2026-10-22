import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageRollup, USAGE_GROUPS } from "../src/hub/usage-rollup.ts";
import { readEvents, type HubEvent } from "../src/hub/events.ts";
import { summarizeByTask } from "../src/hub/report.ts";

// #683 U2: the incremental roll-up. Every test builds its own events.jsonl and hub.db and compares against the existing report code.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-rollup-")); dirs.push(dir);
  const log = join(dir, "events.jsonl");
  let second = 0;
  const line = (e: HubEvent, day = 9) => JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, day, 0, 0, second++)).toISOString(), ...e }) + "\n";
  const write = (events: [HubEvent, number?][]) => appendFileSync(log, events.map(([e, d]) => line(e, d)).join(""));
  const open = (opts?: { maxBytesPerPass?: number }) => new UsageRollup(join(dir, "hub.db"), log, opts);
  return { dir, log, write, open, line };
}
const task = (id: number, state = "in_progress", extra: Record<string, unknown> = {}) => ({ type: "task", id, state, class: "implement", event: state, by: "codex", owner: "codex", reviewer: "claude", pii: false, ...extra }) as HubEvent;
const tokens = (peer: string, n: number, t?: number): HubEvent => ({ type: "tokens", peer, n, ...(t ? { task: t, attribution: "delivery" as const } : { attribution: "unattributed" as const }) });
const usage = (peer: string, id: string, c: Record<string, number>, t?: number, extra: Record<string, unknown> = {}): HubEvent =>
  ({ type: "usage", peer, source: "codex_appserver", id, ...c, ...(t ? { task: t, attribution: "delivery" as const } : { attribution: "unattributed" as const }), ...extra }) as HubEvent;

const sample = (f: ReturnType<typeof fixture>) => f.write([
  [task(1)], [task(2, "in_progress", { pii: true })],
  [tokens("codex", 1050, 1)], [usage("codex", "u1", { inputTokens: 1000, cacheReadTokens: 700, outputTokens: 50, reasoningTokens: 20, totalTokens: 1050 }, 1)],
  [tokens("codex", 530, 2)], [usage("codex", "u2", { inputTokens: 500, cacheReadTokens: 400, outputTokens: 30, totalTokens: 530 }, 2, { pii: true })],
  [tokens("jcode", 77)],                                                       // a peer with a hub count and no usage record
  [usage("local", "u3", { inputTokens: 10, outputTokens: 2 }), 10],            // no total reported
  [usage("codex", "u1", { inputTokens: 9999, totalTokens: 9999 }, 1), 10],      // a replay of u1: counted once
  [{ type: "budget_pause", peer: "codex", reason: "5h window at 95% (x)", window: "5h", resetsAt: 1_900_000_000_000, by: "hub" }, 10],
  [{ type: "budget_resume", peer: "codex", reason: "the window has reset", window: "5h", resetsAt: 1_900_000_000_000, by: "hub" }, 11],
  [{ type: "budget_pause", peer: "claude", reason: "week window at 91% (y)", window: "week", resetsAt: 1_900_100_000_000, by: "hub" }, 11],
  [{ type: "quota_reset", peer: "codex", window: "5h", cause: "resets_at_moved", resetsAt: 1_900_000_100_000, previousResetsAt: 1_900_000_000_000, used: 0.02, previousUsed: 0.95 }, 11],
]);

test("a rebuild from byte 0 equals the incremental roll-up, however the passes are cut (#683 U2)", () => {
  const f = fixture(); sample(f);
  const whole = f.open(); whole.catchUp(); const expected = JSON.stringify(whole.dump()); whole.close();
  for (const cap of [64, 300, 1000, 8192]) {
    const fresh = mkdtempSync(join(tmpdir(), "ahub-rollup-")); dirs.push(fresh);
    const r = new UsageRollup(join(fresh, "hub.db"), f.log, { maxBytesPerPass: cap });
    let passes = 0; while (!r.poll().done) passes++;
    expect(JSON.stringify(r.dump()), `cap ${cap}`).toBe(expected);
    if (cap <= 300) expect(passes, `cap ${cap} needed several bounded passes`).toBeGreaterThan(1);
    r.rebuild(); expect(JSON.stringify(r.dump()), `rebuild after cap ${cap}`).toBe(expected);
    r.close();
  }
});

test("each pass reads at most the cap, a later append is folded from the stored offset, and a half-written last line waits (#683 U2)", () => {
  const f = fixture(); f.write([[task(1)], [tokens("codex", 5, 1)]]);
  const r = f.open({ maxBytesPerPass: 100_000 });
  const first = r.poll(); expect(first.done).toBe(true);
  const before = r.query({ by: "peer" }).throughOffset;
  expect(r.poll()).toEqual({ bytes: 0, done: true });                                  // nothing new: no work
  const inFlight = f.line(tokens("codex", 7, 1));                                        // one line, written in two parts
  appendFileSync(f.log, inFlight.slice(0, 25));                                           // a write in flight: no newline yet
  expect(r.poll().bytes).toBe(0);
  expect(r.query({ by: "peer" }).throughOffset).toBe(before);                              // nothing was folded and the offset did not move
  expect(r.query({ by: "peer" }).rows[0]!.counted).toEqual({ value: 5, source: "count" });
  appendFileSync(f.log, inFlight.slice(25) + f.line(tokens("codex", 11, 1)));              // the rest arrives, and one more line
  r.poll();
  expect(r.query({ by: "peer" }).rows[0]!.counted).toEqual({ value: 5 + 7 + 11, source: "count" }); // the completed line counts exactly once
  r.close();
});

test("a log that was replaced by a shorter one is folded again from the start (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  writeFileSync(f.log, ""); f.write([[tokens("claude", 3)]]);
  r.poll();
  expect(r.query({ by: "peer" }).rows.map(x => x.key)).toEqual(["claude"]);
  r.close();
});

test("usage --by task equals the per-task tokens and totals of `ahub report --by task` on the same events (#683 U2 acceptance)", () => {
  const f = fixture(); sample(f); f.write([[tokens("claude", 40, 1)], [usage("claude", "c1", { inputTokens: 30, cacheReadTokens: 5, outputTokens: 10, totalTokens: 40 }, 1, { source: "claude_transcript" })]]);
  const r = f.open(); r.catchUp();
  const report = summarizeByTask(readEvents(f.log)), q = r.query({ by: "task" });
  const sumPeers = (peers: Record<string, any>, pick: (p: any) => number | null) => Object.values(peers).reduce<number | null>((a, p) => pick(p) === null ? a : (a ?? 0) + pick(p)!, null);
  for (const [id, t] of Object.entries(report.tasks)) {
    const row = q.rows.find(x => x.key === id || x.key === `#${id}`);
    expect(row, `task ${id}`).toBeDefined();
    expect(row!.counted.value, `task ${id} counted`).toBe(sumPeers(t.peers, p => p.tokens));
    expect(row!.total.value, `task ${id} total`).toBe(sumPeers(t.peers, p => p.usage.totalTokens));
    expect(row!.cacheRead.value, `task ${id} cache read`).toBe(sumPeers(t.peers, p => p.usage.cacheReadTokens));
  }
  expect(q.unattributed!.counted.value).toBe(report.unattributed.tokens);
  r.close();
});

test("unknown is never zero: a counter nobody reported is `unknown` with source unknown, and the total is shown with and without cache reads (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  const peers = new Map(r.query({ by: "peer" }).rows.map(x => [x.key, x]));
  const local = peers.get("local")!;
  expect(local.total).toEqual({ value: null, source: "unknown" });                      // no totalTokens was ever reported
  expect(local.reasoning).toEqual({ value: null, source: "unknown" });
  expect(local.input).toEqual({ value: 10, source: "native" });
  const jcode = peers.get("jcode")!;
  expect(jcode.total.source).toBe("unknown"); expect(jcode.counted).toEqual({ value: 77, source: "count" });
  const codex = peers.get("codex")!;
  expect(codex.total).toEqual({ value: 1580, source: "native" });                       // u1 once (the replay is ignored) plus u2
  expect(codex.cacheRead).toEqual({ value: 1100, source: "native" });
  expect(codex.totalWithoutCache).toEqual({ value: 480, source: "native" });
  expect(codex.reasoning).toEqual({ value: 20, source: "native" });
  r.close();
});

test("a private task shows its id and [pii] and nothing else, in every view (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  const byTask = r.query({ by: "task" });
  const secret = byTask.rows.find(x => x.pii);
  expect(secret).toMatchObject({ key: "#2", label: "[pii]", pii: true });
  for (const group of USAGE_GROUPS) {
    const text = JSON.stringify(r.query({ by: group }, id => id === 2 ? { issue: 640, release: 7 } : undefined));
    expect(text).not.toMatch(/title|body|detail":"|summary/i);
  }
  r.close();
});

test("issue, pr and release group the board's current links and leave a task with none under unattributed (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  const links = (id: number) => id === 1 ? { issue: 640, pr: 645, release: 3 } : id === 2 ? { issue: 640 } : undefined;
  const byIssue = r.query({ by: "issue" }, links);
  expect(byIssue.rows.map(x => x.key)).toEqual(["640"]);
  expect(byIssue.rows[0]!.total.value).toBe(1050 + 530);                                // tasks 1 and 2 are one issue
  expect(byIssue.unattributed!.input.value).toBe(10);                                   // the local record has no task
  expect(r.query({ by: "pr" }, links).rows.map(x => x.key)).toEqual(["645"]);
  expect(r.query({ by: "release" }, links).rows.map(x => x.key)).toEqual(["3"]);
  // A task linked after its usage was written is grouped under its issue for the history it already spent.
  expect(r.query({ by: "issue" }, id => id === 1 ? { issue: 700 } : undefined).rows.map(x => x.key)).toEqual(["700"]);
  r.close();
});

test("since and until cut by day, and day and model are groups of their own (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  expect(r.query({ by: "day" }).rows.map(x => x.key)).toEqual(["2026-10-09", "2026-10-10"]);
  const only10 = r.query({ by: "peer", since: Date.UTC(2026, 9, 10) });
  expect(only10.rows.map(x => x.key)).toEqual(["local"]);                                // day 10 held u3 and a replay of u1, which is ignored: codex has no row that day
  expect(r.query({ by: "model" }).rows.map(x => x.key)).toEqual(["unknown"]);
  expect(r.query({ by: "peer", until: Date.UTC(2026, 9, 9) }).rows.map(x => x.key)).toEqual(["codex", "jcode"]);   // until is inclusive of that day, so day 10 is out
  r.close();
});

test("limits keeps every pause, resume and reset, and lists a pause with no later resume as open (#683 U2)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  const limits = r.limits();
  expect(limits.history.map(h => `${h.type}:${h.peer}`)).toEqual(["budget_pause:codex", "budget_resume:codex", "budget_pause:claude", "quota_reset:codex"]);
  expect(limits.open).toEqual([{ peer: "claude", window: "week", since: expect.any(String), resetsAt: 1_900_100_000_000 }]);
  expect(r.limits("codex").history).toHaveLength(3);
  expect(JSON.stringify(limits)).not.toContain("5h window at");                         // the reason text stays out of the roll-up
  r.close();
});

test("lifetime totals name their source: native where the provider reported, a hub count otherwise, unknown with neither (#683 U2)", () => {
  const f = fixture(); sample(f); f.write([[usage("pi", "p1", { inputTokens: 3 })]]);       // pi: usage with no total and no hub count
  const r = f.open(); r.catchUp();
  const total = r.total(), by = new Map(total.peers.map(p => [p.peer, p]));
  expect(by.get("codex")!.tokens).toEqual({ value: 1580, source: "native" });
  expect(by.get("codex")!.withoutCache).toEqual({ value: 480, source: "native" });
  expect(by.get("jcode")!.tokens).toEqual({ value: 77, source: "count" });
  expect(by.get("jcode")!.withoutCache).toEqual({ value: null, source: "unknown" });     // a count has no cache split
  expect(by.get("pi")!.tokens).toEqual({ value: null, source: "unknown" });
  // local (usage with no total) and pi are unknown, so the overall figure is a lower bound: partial, with both named, never a sum that counts them as 0.
  expect(total.overall.tokens).toEqual({ value: 1580 + 77, source: "partial" });
  expect(total.unknownPeers.tokens).toEqual(["local", "pi"]); expect(total.unknownPeers.withoutCache).toEqual(["jcode", "local", "pi"]);
  expect(total.overall.withoutCache).toEqual({ value: null, source: "unknown" });       // one peer has no split, so no understated figure
  expect(total.since).toMatch(/^2026-10-09T/);
  r.close();
});

test("a task event with the private mark keeps the task private for records written before it (#683 U2)", () => {
  const f = fixture();
  f.write([[tokens("codex", 9, 5)], [task(5, "in_progress", { pii: true })]]);
  const r = f.open(); r.catchUp();
  expect(r.query({ by: "task" }).rows[0]).toMatchObject({ key: "#5", label: "[pii]" });
  r.close();
});

test("a corrupt or cut line, an unknown event type and a negative counter are skipped without failing the pass (#683 U2)", () => {
  const f = fixture();
  appendFileSync(f.log, "{not json\n" + JSON.stringify({ v: 1, at: "2026-10-09T00:00:00Z", type: "something_new", x: 1 }) + "\n" + JSON.stringify({ v: 1, at: "2026-10-09T00:00:01Z", type: "tokens", peer: "codex", n: -5 }) + "\n");
  f.write([[tokens("codex", 4)]]);
  const r = f.open(); r.catchUp();
  expect(r.query({ by: "peer" }).rows.map(x => [x.key, x.counted.value])).toEqual([["codex", 4]]);
  r.close(); truncateSync(f.log, 0);
});

// Found when the first version hung: with a cap smaller than one line, a pass could never complete a line and the fold never advanced.
test("a line longer than the pass cap is read whole, and an unbounded line is skipped, so the fold always advances (#683 U2)", () => {
  const f = fixture(); f.write([[tokens("codex", 3)]]);
  const long = JSON.stringify({ v: 1, at: "2026-10-09T01:00:00Z", type: "tokens", peer: "codex", n: 4, attribution: "unattributed", pad: "x".repeat(5_000) }) + "\n";
  appendFileSync(f.log, long); f.write([[tokens("codex", 5)]]);
  const r = f.open({ maxBytesPerPass: 100 });                                        // far below the length of one event
  let passes = 0; while (!r.poll().done && passes < 10_000) passes++;
  expect(passes).toBeLessThan(10_000);
  expect(r.query({ by: "peer" }).rows[0]!.counted).toEqual({ value: 3 + 4 + 5, source: "count" });
  // A line with no end inside the bound is dropped as corrupt and the lines after it are still counted.
  const g = fixture(); g.write([[tokens("claude", 1)]]);
  appendFileSync(g.log, "{" + "y".repeat(4 * 1024 * 1024 + 10) + "\n"); g.write([[tokens("claude", 2)]]);
  const s = g.open({ maxBytesPerPass: 1024 * 1024 });
  let n = 0; while (!s.poll().done && n < 10_000) n++;
  expect(n).toBeLessThan(10_000);
  expect(s.query({ by: "peer" }).rows[0]!.counted).toEqual({ value: 3, source: "count" });
  r.close(); s.close();
});

// Found by running the roll-up on the project's real log: Claude's transcript usage has no totalTokens (5,649 of 5,656 real records), so its total read
// `unknown` although every component was known.
test("Claude's total is the sum of its four counters when none was reported, and no total is invented for sources where cache is part of input (#683 U2)", () => {
  const f = fixture();
  f.write([[usage("claude", "m1", { inputTokens: 2, outputTokens: 789, cacheReadTokens: 26783, cacheWriteTokens: 73159 }, undefined, { source: "claude_transcript" })],
    [usage("claude", "m2", { inputTokens: 10, outputTokens: 5 }, undefined, { source: "claude_transcript" })],           // no cache counters: the sum is input + output
    [usage("claude", "m3", { outputTokens: 5 }, undefined, { source: "claude_transcript" })],                            // no input: nothing to derive from
    [usage("gateway", "g1", { inputTokens: 100, cacheReadTokens: 60, outputTokens: 4 }, undefined, { source: "omniroute" })]]); // cached is inside input: no total
  const r = f.open(); r.catchUp();
  const rows = new Map(r.query({ by: "peer" }).rows.map(x => [x.key, x]));
  const claude = rows.get("claude")!;
  expect(claude.total).toEqual({ value: (2 + 789 + 26783 + 73159) + (10 + 5), source: "native" });
  expect(claude.totalWithoutCache).toEqual({ value: (2 + 789 + 73159) + (10 + 5), source: "native" });
  expect(rows.get("gateway")!.total).toEqual({ value: null, source: "unknown" });
  // An explicit total always wins over the derived one.
  const g = fixture(); g.write([[usage("claude", "m4", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, totalTokens: 50 }, undefined, { source: "claude_transcript" })]]);
  const s = g.open(); s.catchUp(); expect(s.query({ by: "peer" }).rows[0]!.total).toEqual({ value: 50, source: "native" });
  r.close(); s.close();
});

test("two roll-ups on one hub.db fold a byte range once: a pass that started from a stale offset is abandoned", () => {
  // A restart can overlap the old process. Force the worst order: b reads the stored offset, a commits a whole pass, then b folds its stale slice.
  const f = fixture();
  f.write(Array.from({ length: 100 }, () => [tokens("codex", 4)] as [HubEvent]));
  const a = f.open(), b = f.open();
  const real = (b as unknown as { state: () => { offset: number } }).state.bind(b); let armed = true;
  (b as unknown as { state: () => { offset: number } }).state = () => { const s = real(); if (armed) { armed = false; a.poll(); } return s; };
  b.poll();
  const c = f.open(); expect(c.query({ by: "peer" }).rows[0]!.counted).toEqual({ value: 400, source: "count" });
  const fresh = new UsageRollup(join(f.dir, "ref.db"), f.log); fresh.catchUp();
  expect(JSON.stringify(c.dump())).toBe(JSON.stringify(fresh.dump()));
  a.close(); b.close(); c.close(); fresh.close();
});

test("a pass that dies inside its transaction leaves nothing half applied, and the next pass folds the range exactly once", () => {
  const f = fixture();
  f.write(Array.from({ length: 200 }, (_, i) => [tokens("codex", 4, 1 + (i % 3))] as [HubEvent]));
  const r = f.open({ maxBytesPerPass: 5_000 }); r.poll(); const mid = JSON.stringify(r.dump()); r.close();
  const raw = new Database(join(f.dir, "hub.db")); raw.run("BEGIN"); raw.run("UPDATE rollup_state SET byte_offset = byte_offset + 999999 WHERE id = 1"); raw.close();
  const r2 = f.open({ maxBytesPerPass: 5_000 }); expect(JSON.stringify(r2.dump())).toBe(mid);
  r2.catchUp(); const fresh = new UsageRollup(join(f.dir, "ref.db"), f.log); fresh.catchUp();
  expect(JSON.stringify(r2.dump())).toBe(JSON.stringify(fresh.dump())); expect(fresh.query({ by: "peer" }).rows[0]!.counted.value).toBe(800);
  r2.close(); fresh.close();
});

test("the overall total is a lower bound when a peer is unknown, and unknown when every peer is (#683 U2, review)", () => {
  const f = fixture(); f.write([[usage("pi", "p1", { inputTokens: 3 })], [usage("kimi", "k1", { outputTokens: 4 })]]);
  const r = f.open(); r.catchUp();
  const none = r.total();
  expect(none.overall.tokens).toEqual({ value: null, source: "unknown" }); expect(none.unknownPeers.tokens).toEqual(["kimi", "pi"]);
  f.write([[tokens("jcode", 10)]]); r.catchUp();
  const some = r.total();
  expect(some.overall.tokens).toEqual({ value: 10, source: "partial" }); expect(some.unknownPeers.tokens).toEqual(["kimi", "pi"]);
  f.write([[usage("kimi", "k2", { totalTokens: 5 })], [usage("pi", "p2", { totalTokens: 6 })]]); r.catchUp();
  const all = r.total();
  expect(all.unknownPeers.tokens).toEqual([]); expect(all.overall.tokens.source).not.toBe("partial");
  r.close();
});

test("limits: a pause the hub no longer holds is ended with an unknown end, not open forever; a held one stays open (#683 U2, review)", () => {
  const f = fixture(); sample(f);
  f.write([[{ type: "budget_pause", peer: "gemini", reason: "x", window: "5h", resetsAt: 1_900_000_000_000, by: "hub" } as HubEvent]]);
  const r = f.open(); r.catchUp();
  expect(r.limits().open.map(o => o.peer)).toEqual(["claude", "gemini"]);                           // no live set: every event-open pause is open
  const withLive = r.limits(undefined, { live: new Set(["gemini"]) });
  expect(withLive.open.map(o => o.peer)).toEqual(["gemini"]);
  expect(withLive.endedUnknown.map(o => o.peer)).toEqual(["claude"]);                                // ahub reset cleared claude's record and wrote no resume
  expect(r.limits(undefined, { live: new Set() }).open).toEqual([]);
  r.close();
});

test("limits never drops rows silently: a cut says how many are omitted, a bigger limit shows them, and the limit is bounded (#683 U2, review)", () => {
  const f = fixture();
  f.write(Array.from({ length: 30 }, (_, i) => [{ type: "quota_reset", peer: "codex", window: "week", cause: "resets_at_moved", resetsAt: 1_900_000_000_000 + i * 1e9 } as HubEvent] as [HubEvent]));
  const r = f.open(); r.catchUp();
  const cut = r.limits(undefined, { limit: 10 });
  expect(cut).toMatchObject({ total: 30, shown: 10, truncated: true, omitted: 20, limit: 10 }); expect(cut.history).toHaveLength(10);
  expect(cut.history.at(-1)!.detail.resetsAt).toBe(1_900_000_000_000 + 29 * 1e9);                    // the newest are kept
  const all = r.limits(undefined, { limit: 30 });
  expect(all).toMatchObject({ total: 30, shown: 30, truncated: false, omitted: 0 });
  expect(r.limits("nobody")).toMatchObject({ total: 0, shown: 0, truncated: false });
  for (const bad of [0, -1, 1.5, r.limits().maxLimit + 1]) expect(() => r.limits(undefined, { limit: bad })).toThrow(/limit is an integer/);
  r.close();
});

test("a task filter returns that task's tokens per peer, marks a private task, and an unknown task is empty, not zero (#683 U3)", () => {
  const f = fixture(); sample(f);
  const r = f.open(); r.catchUp();
  const one = r.query({ by: "peer", task: 1 });
  expect(one.task).toBe(1); expect(one.taskPii).toBeUndefined();
  expect(one.rows.map(row => row.key)).toEqual(["codex"]);
  expect(one.rows[0]!.total).toEqual({ value: 1050, source: "native" }); expect(one.rows[0]!.counted).toEqual({ value: 1050, source: "count" });
  const pii = r.query({ by: "peer", task: 2 });
  expect(pii.taskPii).toBe(true); expect(pii.rows.map(row => row.key)).toEqual(["codex"]);    // task 2 is private: ids and numbers only
  const none = r.query({ by: "peer", task: 999 });
  expect(none.rows).toEqual([]); expect(none.taskPii).toBeUndefined();
  expect(r.query({ by: "peer", task: 1, since: Date.UTC(2026, 9, 10) }).rows).toEqual([]);   // the filter combines with the period
  r.close();
});

test("catchUp with a time budget says when the roll-up is still behind the log, and finishes when it is not (#683 U3)", () => {
  const f = fixture();
  f.write(Array.from({ length: 400 }, () => [tokens("codex", 4)] as [HubEvent]));
  const r = f.open({ maxBytesPerPass: 2_000 });
  expect(r.catchUp(0)).toBe(false);                                                         // one pass, no time left: behind, and it says so
  expect(r.query({ by: "peer" }).rows[0]!.counted.value).toBeLessThan(1600);
  expect(r.catchUp(5_000)).toBe(true);
  expect(r.query({ by: "peer" }).rows[0]!.counted.value).toBe(1600);
  expect(r.catchUp(0)).toBe(true);                                                          // nothing left to fold: not behind
  r.close();
});
