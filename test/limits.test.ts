import { expect, test } from "bun:test";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_LIMITS, Limiter } from "../src/hub/limits.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

// issue #38: limits on what agents send, refused at the sender with the time to retry.
const clock = () => {
  const c = { now: 1_800_000_000_000 };
  return { c, now: () => c.now };
};

test("a burst above the sender limit is refused with the retry time, costs no token, and passes again later", () => {
  const { c, now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, sender_per_min: 3 }, now);
  expect([1, 2, 3].map((i) => l.admit("codex", ["claude"], "status", `m${i}`))).toEqual([undefined, undefined, undefined]);
  expect(l.admit("codex", ["claude"], "status", "m4")).toBe("rate limited: too many messages from codex; retry after 20 s");
  expect(l.admit("kimi", ["claude"], "status", "other sender")).toBeUndefined(); // per sender
  c.now += 20_000;
  expect(l.admit("codex", ["claude"], "status", "m4")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "status", "m5")).toMatch(/retry after 20 s/);
});

test("per recipient: one busy pair does not hold back messages to others; a broadcast is its own recipient", () => {
  const { now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, pair_per_min: 2 }, now);
  expect(l.admit("codex", ["claude"], "status", "a")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "status", "b")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "status", "c")).toMatch(/^rate limited/);
  expect(l.admit("codex", ["kimi"], "status", "c")).toBeUndefined();
  expect(l.admit("codex", undefined, "status", "c")).toBeUndefined();
});

test("important has a budget of its own, and the refusal says how to send it anyway", () => {
  const { now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, important_per_hour: 1 }, now);
  expect(l.admit("codex", ["claude"], "important", "now!")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "important", "again!")).toBe("rate limited: too many important messages from codex; retry after 3600 s, or send it without [IMPORTANT]");
  expect(l.admit("codex", ["claude"], "status", "again")).toBeUndefined();
});

test("the same message to the same recipients within the window is dropped and the sender told; a refusal is not a send", () => {
  const { c, now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, repeat_window_s: 60, sender_per_min: 1 }, now);
  expect(l.admit("codex", ["claude", "kimi"], "status", "tests pass")).toBeUndefined();
  c.now += 5_000;
  expect(l.admit("codex", ["kimi", "claude"], "status", "  tests   pass ")).toBe("the same message went to claude, kimi 5 s ago");
  expect(l.admit("codex", ["claude"], "status", "another")).toMatch(/^rate limited/); // refused, so it may be sent again
  c.now += 60_000;
  expect(l.admit("codex", ["claude"], "status", "another")).toBeUndefined();
  expect(l.admit("codex", ["claude", "kimi"], "status", "tests pass")).toMatch(/^rate limited/); // window over: not a repeat
});

test("duplicate recipients are the same recipients for repeat suppression", () => {
  const { now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, repeat_window_s: 60 }, now);
  expect(l.admit("codex", ["claude"], "status", "done")).toBeUndefined();
  expect(l.admit("codex", ["claude", "claude"], "status", "done")).toMatch(/^the same message went to claude /);
});

test("what a message answers is part of the repeat key, and a broadcast repeat says everyone", () => {
  const { now } = clock();
  const l = new Limiter({ ...DEFAULT_LIMITS, repeat_window_s: 60 }, now);
  expect(l.admit("codex", ["claude"], "status", "Yes.", "q1")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "status", "Yes.", "q2")).toBeUndefined();
  expect(l.admit("codex", ["claude"], "status", "Yes.", "q1")).toMatch(/^the same message went to claude /);
  expect(l.admit("codex", undefined, "status", "all done")).toBeUndefined();
  expect(l.admit("codex", undefined, "status", "all done")).toMatch(/^the same message went to everyone /);
});

test("off by default", () => {
  const l = new Limiter(DEFAULT_LIMITS);
  for (let i = 0; i < 100; i++) expect(l.admit("codex", undefined, "important", "same")).toBeUndefined();
});

test("an adapter's refused message is not published, and the sender hears why on its next delivery", async () => {
  class Peer extends BasePeer {
    got: Envelope[] = [];
    async deliver(envs: Envelope[]) { this.got.push(...envs); }
    async start() { this.setState("idle"); }
    async stop() {}
  }
  const l = new Limiter({ ...DEFAULT_LIMITS, repeat_window_s: 60 });
  const bus = new Bus({ batchMs: 0, admit: (e, parent) => l.admit(e.from, e.to, e.priority, e.body, parent) });
  const [a, b] = [new Peer("codex"), new Peer("claude")];
  for (const p of [a, b]) { bus.add(p); await p.start(); }
  expect(a.onMessage?.("done", { to: ["claude"] })).toBeUndefined();
  expect(a.onMessage?.("done", { to: ["claude"] })).toMatch(/^the same message went to claude/);
  await Bun.sleep(10);
  expect(b.got.map((e) => e.body)).toEqual(["done"]);
  bus.publish({ ...b.got[0]!, id: "x2", from: "claude", to: ["codex"], body: "next" });
  await Bun.sleep(10);
  expect(a.got[0]!.body).toContain("note from hub [decision]: your message was not delivered: the same message went to claude");
});
