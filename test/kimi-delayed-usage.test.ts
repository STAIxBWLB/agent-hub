import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiUsage, type KimiUsageScheduler } from "../src/hub/kimi-usage.ts";
import type { TaskAttribution } from "../src/hub/attribution.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-delayed-")); dirs.push(root);
  const sessions = join(root, "sessions", "wd_project");
  mkdirSync(sessions, { recursive: true });
  const makeSession = (id = "session_a") => {
    const dir = join(sessions, id), wire = join(dir, "agents", "main", "wire.jsonl");
    mkdirSync(join(wire, ".."), { recursive: true });
    writeFileSync(wire, `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 })}\n`);
    appendFileSync(join(root, "session_index.jsonl"), `${JSON.stringify({ sessionId: id, sessionDir: dir })}\n`);
    return { id, dir, wire };
  };
  return { root, makeSession };
}

const wireRow = (at: number, input = 7, output = 3, extra: object = {}) => `${JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther: input, output, inputCacheRead: 100, inputCacheCreation: 0 }, usageScope: "turn", time: at, ...extra })}\n`;

function scheduler() {
  let seq = 0;
  const pending = new Map<number, { delay: number; run: () => void }>();
  const schedule: KimiUsageScheduler = (delay, run) => {
    const id = ++seq; pending.set(id, { delay, run });
    return () => { pending.delete(id); };
  };
  return {
    schedule,
    delays: () => [...pending.values()].map(item => item.delay),
    size: () => pending.size,
    fire: () => {
      const next = pending.entries().next().value as [number, { delay: number; run: () => void }] | undefined;
      expect(next, "a delayed drain is pending").toBeDefined();
      if (!next) return;
      pending.delete(next[0]); next[1].run();
    },
  };
}

function rig(h: ReturnType<typeof fixture>, options: { failFirstRecord?: boolean; failSecondRecord?: boolean } = {}) {
  let now = 1_790_000_100_000, current: string | undefined, failFirst = options.failFirstRecord === true, failSecond = options.failSecondRecord === true, calls = 0;
  const log = {
    recorded: [] as { id: string; counted: number; attribution: TaskAttribution; turn?: string }[],
    reports: [] as { used: number }[],
    forgot: 0,
    notices: [] as string[],
  };
  const timers = scheduler();
  const usage = new KimiUsage({
    home: h.root,
    now: () => now,
    ceiling: () => 1000,
    session: () => current,
    schedule: timers.schedule,
    record: (_peer, row, counted, attributed) => {
      calls++;
      if (failFirst && calls === 1 || failSecond && calls === 2) throw new Error("injected event commit failure");
      log.recorded.push({ id: row.id, counted, attribution: attributed.attribution, ...(attributed.turn ? { turn: attributed.turn } : {}) });
    },
    report: (_peer, window) => log.reports.push({ used: window.used }),
    forget: () => { log.forgot++; },
    notice: line => log.notices.push(line),
  });
  return {
    usage, log, timers,
    now: () => now,
    bind: (id: string | undefined) => { current = id; },
    turn: (id: string, task: number, startedAt: number, attribution: TaskAttribution["attribution"] = "delivery") => usage.turnStarted("kimi", { id, startedAt, attribution: { task, attribution } }),
    end: (id: string, endedAt: number) => usage.turnEnded("kimi", id, endedAt),
  };
}

test("#1281 AC1/AC4: one pending drain coalesces cues and stops after three bounded follow-ups", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h), t = r.now();
  r.bind(s.id); r.turn("turn-a", 11, t - 10);
  r.usage.collect("kimi");
  expect(r.timers.delays()).toEqual([250]);
  r.usage.collect("kimi");
  expect(r.timers.delays()).toEqual([250]);
  appendFileSync(s.wire, wireRow(t - 5));
  r.timers.fire();
  expect(r.log.recorded).toEqual([{ id: r.log.recorded[0]!.id, counted: 10, attribution: { task: 11, attribution: "delivery" }, turn: "turn-a" }]);
  expect(r.timers.delays()).toEqual([1000]);
  r.timers.fire();
  expect(r.timers.delays()).toEqual([2000]);
  r.timers.fire();
  expect(r.timers.size()).toBe(0);
  expect(r.log.recorded).toHaveLength(1);
  r.usage.collect("kimi");
  expect(r.timers.delays()).toEqual([250]);
  r.usage.stop();
  expect(r.timers.size()).toBe(0);
});

test("#1281 AC2/AC4: only a unique native-time interval attributes a row; overflow and ambiguity degrade to unattributed", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h), t = r.now();
  r.bind(s.id);
  for (let n = 1; n <= 33; n++) {
    const startedAt = t + n * 10;
    r.turn(`turn-${n}`, n, startedAt); r.end(`turn-${n}`, startedAt + 5);
  }
  appendFileSync(s.wire, wireRow(t + 10, 1, 0) + wireRow(t + 330, 2, 0));
  r.turn("overlap-a", 41, t + 500); r.end("overlap-a", t + 520);
  r.turn("overlap-b", 42, t + 510);
  appendFileSync(s.wire, wireRow(t + 515, 4, 0));
  r.usage.collect("kimi");
  expect(r.log.recorded.map(row => row.counted)).toEqual([1, 2, 4]);
  expect(r.log.recorded[0]).toMatchObject({ attribution: { attribution: "unattributed" } });
  expect(r.log.recorded[0]?.turn).toBeUndefined();
  expect(r.log.recorded[1]).toMatchObject({ attribution: { task: 33, attribution: "delivery" }, turn: "turn-33" });
  expect(r.log.recorded[2]).toMatchObject({ attribution: { attribution: "unattributed" } });
  expect(r.log.recorded[2]?.turn).toBeUndefined();
  r.usage.stop();
});

test("#1281 AC4: drop, session replacement and stop cancel delayed work without rebinding the old session", () => {
  const h = fixture(), a = h.makeSession("session_a"), b = h.makeSession("session_b"), r = rig(h);
  r.bind(a.id); r.turn("turn-a", 1, r.now() - 10); r.usage.collect("kimi");
  expect(r.timers.size()).toBe(1);
  r.usage.drop("kimi");
  expect(r.timers.size()).toBe(0);
  r.bind(b.id); r.turn("turn-b", 2, r.now() - 5);
  expect(r.timers.size()).toBe(0);
  r.usage.collect("kimi");
  expect(r.timers.size()).toBe(1);
  r.bind(a.id); r.turn("replacement-a", 3, r.now() - 4);
  expect(r.timers.size()).toBe(0);
  r.usage.stop();
  expect(r.timers.size()).toBe(0);
});

test("#1281 AC5: a partial line at the immediate read is recorded once when a delayed drain completes it", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h), t = r.now();
  r.bind(s.id); r.turn("turn-a", 7, t - 10);
  const complete = wireRow(t - 5, 9, 1);
  appendFileSync(s.wire, complete.trimEnd().slice(0, 60));
  r.usage.collect("kimi");
  expect(r.log.recorded).toHaveLength(0);
  expect(r.log.forgot).toBe(1);
  expect(r.log.reports).toHaveLength(0);
  appendFileSync(s.wire, complete.trimEnd().slice(60) + "\n");
  r.timers.fire();
  expect(r.log.recorded.map(row => row.counted)).toEqual([10]);
  expect(r.log.reports).toHaveLength(1);
  r.usage.collect("kimi"); r.timers.fire(); r.timers.fire();
  expect(r.log.recorded).toHaveLength(1);
  r.usage.stop();
});

test("#1281 AC6: an event commit failure does not advance a reader slice past an unrecorded row", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h, { failFirstRecord: true }), t = r.now();
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  appendFileSync(s.wire, wireRow(t - 5, 12, 3));
  expect(() => r.usage.collect("kimi")).toThrow("injected event commit failure");
  expect(r.log.recorded).toHaveLength(0);
  r.usage.stop();
  expect(r.timers.size()).toBe(0);
  r.usage.collect("kimi");
  expect(r.log.recorded).toEqual([{ id: r.log.recorded[0]!.id, counted: 15, attribution: { task: 8, attribution: "delivery" }, turn: "turn-a" }]);
  r.usage.collect("kimi");
  expect(r.log.recorded).toHaveLength(1);
});

test("#1281 AC7: delayed recording copies counters and attribution only, never native text, paths or session ids", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h), t = r.now(), marker = "DELAYED-SECRET-MARKER-1281";
  r.bind(s.id); r.turn("turn-a", 9, t - 10);
  appendFileSync(s.wire, `${JSON.stringify({ type: "prompt", text: marker })}\n${JSON.stringify({ type: "tool.result", text: marker })}\n`);
  r.usage.collect("kimi");
  appendFileSync(s.wire, wireRow(t - 5, 1, 1, { prompt: marker, answer: marker }));
  r.timers.fire();
  const surfaces = JSON.stringify(r.log) + JSON.stringify(r.timers.delays());
  for (const secret of [marker, h.root, s.dir, s.id]) expect(surfaces).not.toContain(secret);
  expect(r.log.recorded).toHaveLength(1);
  r.usage.stop();
});

test("#1281 AC4: a fresh cue during the last pending follow-up gets its own bounded retry sequence", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h), t = r.now();
  r.bind(s.id); r.turn("turn-a", 1, t - 10); r.end("turn-a", t);
  r.usage.collect("kimi");
  r.timers.fire(); r.timers.fire();
  expect(r.timers.delays()).toEqual([2000]);
  r.turn("turn-b", 2, t + 10);
  r.usage.collect("kimi");
  expect(r.timers.delays()).toEqual([2000]);
  r.timers.fire();
  expect(r.timers.delays()).toEqual([250]);
  appendFileSync(s.wire, wireRow(t + 15, 5, 2));
  r.timers.fire();
  expect(r.log.recorded).toEqual([{ id: r.log.recorded[0]!.id, counted: 7, attribution: { task: 2, attribution: "delivery" }, turn: "turn-b" }]);
  expect(r.timers.delays()).toEqual([1000]);
  r.usage.stop();
});

test("#1281 AC6: a retry after a cache-only row failure still reports earlier positive usage", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h, { failSecondRecord: true }), t = r.now();
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  appendFileSync(s.wire, wireRow(t - 5, 7, 3) + wireRow(t - 4, 0, 0));
  expect(() => r.usage.collect("kimi")).toThrow("injected event commit failure");
  expect(r.log.recorded.map(row => row.counted)).toEqual([10]);
  expect(r.log.reports).toHaveLength(0);
  r.usage.stop();
  r.usage.collect("kimi");
  expect(r.log.recorded.map(row => row.counted)).toEqual([10, 0]);
  expect(r.log.reports).toEqual([{ used: 0.01 }]);
  r.usage.collect("kimi");
  expect(r.log.reports).toHaveLength(1);
});

test("#1283 AC3: cancellation after offset advancement cannot discard the uncommitted slice", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h, { failFirstRecord: true }), t = r.now();
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  appendFileSync(s.wire, wireRow(t - 5, 12, 3));
  expect(() => r.usage.collect("kimi")).toThrow("injected event commit failure");
  expect(r.log.recorded).toHaveLength(0);
  r.usage.drop("kimi");
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  r.usage.collect("kimi");
  expect(r.log.recorded).toEqual([{ id: r.log.recorded[0]!.id, counted: 15, attribution: { task: 8, attribution: "delivery" }, turn: "turn-a" }]);
});

test("#1283: a failed backlog attempt uses bounded backoff instead of a zero-delay retry", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h, { failSecondRecord: true }), t = r.now();
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  const pad = () => `${JSON.stringify({ type: "prompt", text: "x".repeat(70_000) })}\n`;
  appendFileSync(s.wire, pad() + wireRow(t - 5, 7, 3) + pad() + wireRow(t - 4, 3, 1) + pad() + wireRow(t - 3, 5, 1));
  expect(() => r.usage.collect("kimi")).toThrow("injected event commit failure");
  expect(r.log.recorded.map(row => row.counted)).toEqual([10]);
  expect(r.timers.delays()).toEqual([250]);
});

test("#1283: a delayed timer contains an event failure and keeps its bounded retry", () => {
  const h = fixture(), s = h.makeSession(), r = rig(h, { failFirstRecord: true }), t = r.now();
  r.bind(s.id); r.turn("turn-a", 8, t - 10);
  appendFileSync(s.wire, wireRow(t - 5, 12, 3));
  expect(() => r.usage.collect("kimi")).toThrow("injected event commit failure");
  expect(r.timers.size()).toBe(1);
  expect(() => r.timers.fire()).not.toThrow();
  expect(r.log.recorded).toHaveLength(1);
  expect(r.timers.size()).toBe(1);
});
