import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { Budget, codexWindows, DEFAULT_BUDGET, type BudgetLedgerEntry } from "../src/hub/budget.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const NORMAL = 424_242;
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2500;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};
function pollClock() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  type Timer = ReturnType<typeof setTimeout>;
  const entries: { timer: Timer; delay: number; active: boolean; run: () => void }[] = [];
  globalThis.setTimeout = ((run: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay !== NORMAL && delay !== 60_000) return set(run, delay, ...args);
    const timer = { unref() { return this; } } as unknown as Timer;
    entries.push({ timer, delay, active: true, run: () => run(...args) });
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    const item = entries.find(row => row.timer === timer);
    if (item) item.active = false; else clear(timer);
  }) as typeof clearTimeout;
  return { entries, active: (delay?: number) => entries.filter(row => row.active && (delay === undefined || row.delay === delay)),
    fire: (entry: (typeof entries)[number]) => { entry.active = false; entry.run(); },
    restore: () => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; } };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "ahub-codex-reset-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: 1_800_000_000_000 }, native = { used: 10, hasCredits: true, unlimited: false };
  const hostFrames: unknown[] = [], ledger: BudgetLedgerEntry[] = [], listeners = new Set<() => void>(), allListeners: (() => void)[] = [];
  let resumed = 0;
  const budget = new Budget(join(root, "hub.db"), DEFAULT_BUDGET, {
    account: peer => peer.startsWith("codex") ? "codex" : peer,
    pause: () => {}, resume: () => { resumed++; }, attached: () => true, canHandOff: () => false,
    requestCheckpoint: async () => undefined, platformContext: async () => undefined, handoff: async () => [], resumed: () => {}, notify: () => {}, ledger: item => ledger.push(item),
  }, () => clock.now);
  cleanup.push(() => budget.close());
  const fake = startFakeAppServer(0, 0, undefined, 100, true, undefined, () => ({
    accountId: "ACCOUNT_ID_CANARY", ordinaryUsageAllowed: false,
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: "CREDIT_ID_CANARY", status: "available", resetType: "codexRateLimits", expiresAt: 1_900_000_000 }] },
    rateLimits: { primary: { usedPercent: native.used, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null,
      rateLimitReachedType: native.used >= 100 ? "rate_limit_reached" : null,
      credits: { hasCredits: native.hasCredits, unlimited: native.unlimited, balance: "BALANCE_CANARY" } },
  }));
  cleanup.push(fake.stop);
  const timers = pollClock(); cleanup.push(timers.restore);
  const peer = new CodexPeer("codex-extra", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: root, usagePollMs: NORMAL,
    usagePause: { current: () => !!budget.record("codex-extra"), subscribe: changed => {
      listeners.add(changed); allListeners.push(changed); const stop = budget.watchPause("codex-extra", changed);
      return () => { listeners.delete(changed); stop(); };
    } },
    onUsage: (raw, hard, info) => { hostFrames.push({ raw, info }); budget.report("codex-extra", codexWindows(raw), hard, clock.now, info); },
  });
  await peer.start(); cleanup.push(() => peer.stop());
  let nextId = 1;
  const attach = async () => {
    const seen: any[] = [], tui = new WebSocket(peer.proxyUrl);
    tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
    await new Promise<void>(resolve => { tui.onopen = () => resolve(); });
    cleanup.push(() => tui.close());
    tui.send(JSON.stringify({ id: nextId++, method: "initialize", params: {} }));
    tui.send(JSON.stringify({ id: nextId++, method: "thread/start", params: {} }));
    await until(() => peer.state === "idle" && listeners.size === 1 && timers.active().length === 1);
    return { tui, seen };
  };
  const client = await attach();
  await until(() => hostFrames.length === 1);
  const reads = () => fake.requests.filter(item => item.method === "account/rateLimits/read").length;
  return { root, clock, native, budget, fake, peer, timers, hostFrames, ledger, listeners, allListeners, client, attach, reads, resumed: () => resumed };
}

test("#1440 paused Codex polls within 60s, resets via Budget.evaluate and returns to the normal interval", async () => {
  const f = await setup();
  expect(f.timers.active(NORMAL)).toHaveLength(1);
  f.native.used = 100;
  // The sibling/account pause arrives after a normal timer was already armed.
  f.budget.report("codex", [{ id: "5h", used: 1, resetsAt: 1_900_000_000_000, source: "codex rateLimits" }], true, f.clock.now);
  await until(() => !!f.budget.record("codex-extra"));
  expect(f.timers.active(NORMAL)).toHaveLength(0); expect(f.timers.active(60_000)).toHaveLength(1);
  f.clock.now += 60_000;
  f.timers.fire(f.timers.active(60_000)[0]!);
  await until(() => f.budget.status().codex?.accountUsage?.at === f.clock.now);
  expect(f.budget.record("codex")).toBeDefined(); expect(f.resumed()).toBe(0); // paid credits cannot lift it
  f.native.used = 20; f.clock.now += 60_000;
  f.timers.fire(f.timers.active(60_000)[0]!);
  await until(() => !f.budget.record("codex"));
  expect(f.resumed()).toBe(1);
  expect(f.ledger.findLast(item => item.type === "budget_resume")).toMatchObject({ type: "budget_resume", by: "hub", reason: "usage is back under the gate" });
  expect(f.timers.active(60_000)).toHaveLength(0); expect(f.timers.active(NORMAL)).toHaveLength(1);
  expect(JSON.stringify(f.hostFrames) + JSON.stringify(f.budget.status())).not.toMatch(/CANARY|balance|accountId|creditId/);
  expect(f.client.seen.some(message => typeof message.id === "number" && message.id < 0)).toBe(false);
  expect(f.fake.requests.filter(item => item.method.startsWith("account/")).every(item => item.method === "account/rateLimits/read")).toBe(true);
});

test("#1440 detach and stop remove polling/subscriptions; stale callbacks cannot retime a replacement attachment", async () => {
  const f = await setup();
  f.budget.report("codex", [{ id: "5h", used: 1, resetsAt: 1_900_000_000_000, source: "codex rateLimits" }], true, f.clock.now);
  await until(() => !!f.budget.record("codex"));
  expect(f.timers.active(60_000)).toHaveLength(1);
  const oldTimer = f.timers.active(60_000)[0]!, oldListener = f.allListeners[0]!;
  f.client.tui.close();
  await until(() => f.peer.state === "offline");
  expect(f.timers.active()).toHaveLength(0); expect(f.listeners.size).toBe(0);
  expect(f.budget.record("codex")).toBeDefined();
  f.clock.now++; // the replacement's fresh native reading can end the existing pause
  const replacement = await f.attach(); await until(() => f.hostFrames.length === 2 && !f.budget.record("codex"));
  const before = f.reads(); oldTimer.run(); oldListener();
  expect(f.timers.active(NORMAL)).toHaveLength(1);
  replacement.tui.send(JSON.stringify({ id: 99, method: "initialize", params: {} }));
  await until(() => replacement.seen.some(message => message.id === 99));
  expect(f.reads()).toBe(before);
  const lastTimer = f.timers.active()[0]!;
  await f.peer.stop();
  expect(f.timers.active()).toHaveLength(0); expect(f.listeners.size).toBe(0);
  lastTimer.run(); expect(f.timers.active()).toHaveLength(0);
});
