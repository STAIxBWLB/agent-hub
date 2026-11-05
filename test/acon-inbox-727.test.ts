import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../src/ui/plugin.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

// #727 (#1196): the acon inbox snapshot answers fast, in bounded size, and computes once for concurrent callers. The hubs are scripted: each project's `agents` snapshot takes `delayMs`, as a real
// daemon's did (0.12 to 0.34 s each on the owner's Mac, 2.5 s in all because the projects were asked one after another).
const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Spec { id: string; delayMs?: number; permissions?: number; reviews?: number; hang?: boolean; decisionsAt?: number }
function fleet(specs: Spec[], options: { inboxFreshMs?: number; inboxStaleMs?: number; inboxProjectBudgetMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-inbox727-")); dirs.push(home);
  const asked: Record<string, number> = {};
  const open: Record<string, number> = {}, peak: Record<string, number> = {};   // #730: snapshots a project is answering at once, and the most it ever had
  const listing = { delayMs: 0, asked: 0 };                                    // #730: the project listing (inspectProject) of the lifecycle
  const live: Record<string, { delayMs: number; permissions: number; reviews: number; hang: boolean }> = {};
  const projects: ProjectRecord[] = [];
  for (const spec of specs) {
    live[spec.id] = { delayMs: spec.delayMs ?? 0, permissions: spec.permissions ?? 1, reviews: spec.reviews ?? 0, hang: spec.hang ?? false };
    const project: ProjectRecord = { id: spec.id, root: `/tmp/${spec.id}-project`, stateDir: join(home, spec.id), basePort: 4700, instanceId: `i-${spec.id}`, pid: 42 };
    projects.push(project);
    const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
      async message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: project.instanceId }));
        if (m.t === "ui_snapshot") {
          asked[spec.id] = (asked[spec.id] ?? 0) + 1;
          const state = live[spec.id]!;
          if (state.hang) return;
          open[spec.id] = (open[spec.id] ?? 0) + 1; peak[spec.id] = Math.max(peak[spec.id] ?? 0, open[spec.id]!);
          const { permissions: permissionCount, reviews: reviewCount } = state;   // what the hub knows when the question ARRIVES: an answer delayed past a later change still describes the earlier state
          if (state.delayMs) await Bun.sleep(state.delayMs);
          open[spec.id]!--;
          const permissions = Array.from({ length: permissionCount }, (_, n) => ({ t: "permission", id: `perm-${n}`, peer: "kimi", title: `run ${n}`, createdAt: (spec.decisionsAt ?? 1_790_000_000_000) + n,
            options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Deny" }] }));
          const tasks = Array.from({ length: reviewCount }, (_, n) => ({ id: 100 + n, title: `review ${n}`, state: "in_review", owner: "codex", reviewer: "user" }));
          return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions, tasks, questions: [], status: { peers: {} }, events: [] }));
        }
        if (m.t === "ui_action") return void ws.send(JSON.stringify({ rid: m.rid, ok: true }));
      },
    } });
    servers.push(hub);
    mkdirSync(project.stateDir, { recursive: true });
    writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: project.instanceId }));
    writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  }
  const registry = { get: (id: string) => projects.find((p) => p.id === id), list: () => projects, close() {} } as any;
  const lifecycle: Lifecycle = {
    inspectProject: async (project) => { listing.asked++; if (listing.delayMs) await Bun.sleep(listing.delayMs); return { state: "running", status: { instanceId: (project as ProjectRecord).instanceId, peers: {} } } as any; },
    startProject: async () => ({}), stopProject: async () => {},
  };
  const provider = createProvider({ home, registry, lifecycle, ...options });
  const inbox = async () => await provider.snapshot({ after: 0, panel: "inbox" }) as { items: { id: string; group: string; at: string; project?: string }[]; more: number };
  const total = () => Object.values(asked).reduce((sum, n) => sum + n, 0);
  return { provider, inbox, asked, total, live, peak, listing };
}
const time = async <T,>(work: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const value = await work(); return [value, performance.now() - t]; };

test("the projects are asked at once: five projects of 250 ms each answer in about one project's time, not the sum (the 2.5 s of #1196)", async () => {
  const f = fleet(["a", "b", "c", "d", "e"].map((id) => ({ id, delayMs: 250 })));
  const [reply, ms] = await time(f.inbox);
  expect(reply.items).toHaveLength(5);
  expect(ms).toBeLessThan(900);                                   // sequential would be 1250 ms plus overhead
  expect(f.asked).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 1 });
});

test("concurrent inbox snapshots share one computation: twenty callers, one question per project", async () => {
  const f = fleet(["a", "b", "c"].map((id) => ({ id, delayMs: 150 })));
  const replies = await Promise.all(Array.from({ length: 20 }, () => f.inbox()));
  expect(f.asked).toEqual({ a: 1, b: 1, c: 1 });
  for (const reply of replies) expect(reply.items).toBe(replies[0]!.items);   // the very same computed list, not twenty equal ones
});

test("a reply younger than inboxFreshMs is served from the cache with no hub call; an older one is recomputed", async () => {
  const f = fleet([{ id: "a", delayMs: 20 }], { inboxFreshMs: 150, inboxStaleMs: 150 });
  await f.inbox(); expect(f.total()).toBe(1);
  await f.inbox(); await f.inbox(); expect(f.total()).toBe(1);   // fresh
  await Bun.sleep(200);
  await f.inbox(); expect(f.total()).toBe(2);                    // expired: waits for a fresh computation
});

test("a stale reply is served at once while ONE refresh runs in the background, and the next poll sees the refreshed rows", async () => {
  const f = fleet([{ id: "a", delayMs: 300, permissions: 1 }], { inboxFreshMs: 50, inboxStaleMs: 5_000 });
  await f.inbox();                                                // warm: 300 ms
  f.live.a!.permissions = 2;
  await Bun.sleep(80);                                            // now stale, not expired
  const [stale, ms] = await time(f.inbox);
  expect(ms).toBeLessThan(100);                                   // answered from the cache, not after the 300 ms question
  expect(stale.items).toHaveLength(1);
  await Promise.all([f.inbox(), f.inbox(), f.inbox()]);           // three more polls while the refresh is in flight: they join it, none starts another
  await Bun.sleep(400);                                           // the refresh has landed
  expect(f.asked.a).toBe(2);                                      // the warm-up and ONE refresh, however many polls came in between
  const [fresh] = await time(f.inbox);
  expect(fresh.items).toHaveLength(2);
});

test("nothing runs in the background while nobody polls", async () => {
  const f = fleet([{ id: "a" }], { inboxFreshMs: 20, inboxStaleMs: 40 });
  await f.inbox(); await Bun.sleep(400);
  expect(f.total()).toBe(1);
});

test("an action drops the cache: the approval just given is gone from the very next poll, and a poll started before it does not put the old answer back", async () => {
  const f = fleet([{ id: "a", delayMs: 100, permissions: 1 }], { inboxFreshMs: 60_000, inboxStaleMs: 60_000 });
  expect((await f.inbox()).items).toHaveLength(1);
  const slowPoll = f.inbox();                                     // served from the cache
  const preview = await f.provider.action({ action: "approve", id: "perm:a:perm-0" });
  if (!("needsConfirm" in preview)) throw new Error("expected a preview");
  const done = await f.provider.action({ action: "approve", id: "perm:a:perm-0", confirmed: true, fingerprint: String(preview.fingerprint) });
  expect(done.ok).toBe(true);
  f.live.a!.permissions = 0;                                      // the hub has now settled the approval
  await slowPoll;
  expect((await f.inbox()).items).toEqual([]);
});

test("a computation that started before an action never becomes the cache: the next poll recomputes", async () => {
  const f = fleet([{ id: "a", delayMs: 300, permissions: 1 }], { inboxFreshMs: 60_000, inboxStaleMs: 60_000 });
  const early = f.inbox();                                        // starts a computation that will read permissions = 1
  await Bun.sleep(50);
  f.live.a!.permissions = 0;
  await f.provider.action({ action: "pause", peer: "kimi", projectId: "a", instanceId: "i-a" } as never);   // any action drops the cache
  await early;
  expect((await f.inbox()).items).toEqual([]);                    // had the early result been cached, this would still show the approval
});

test("the reply holds at most 50 items, the most urgent first (decisions, then reviews), and `more` counts the rest", async () => {
  // the decisions are made NEWER than every review (a review's `at` is when it was first seen, now), so only the urgency order, not the age, puts them first
  const f = fleet([{ id: "a", permissions: 40, reviews: 30, decisionsAt: Date.now() + 3_600_000 }, { id: "b", permissions: 5, reviews: 5, decisionsAt: Date.now() + 3_600_000 }]);
  const reply = await f.inbox();
  expect(reply.items).toHaveLength(50);
  expect(reply.more).toBe(40 + 30 + 5 + 5 - 50);
  const groups = reply.items.map((i) => i.group);
  expect(groups.slice(0, 45).every((g) => g === "decision")).toBe(true);   // all 45 decisions come first
  expect(groups.slice(45).every((g) => g === "review")).toBe(true);
  const decisions = reply.items.slice(0, 45);
  expect(decisions.map((i) => i.at)).toEqual([...decisions.map((i) => i.at)].sort());   // oldest waiting first within a group
  expect(new Set(reply.items.map((i) => i.id)).size).toBe(50);
  const small = await fleet([{ id: "c", permissions: 2 }]).inbox();
  expect(small.more).toBe(0);
});

test("an item cut by the cap keeps its `at` when it comes back below it (the bound is applied after the `seen` bookkeeping)", async () => {
  const f = fleet([{ id: "a", permissions: 0, reviews: 60 }], { inboxFreshMs: 0, inboxStaleMs: 0 });
  const first = await f.inbox();
  expect(first.more).toBe(10);
  await Bun.sleep(30);
  const second = await f.inbox();
  const at = new Map(first.items.map((i) => [i.id, i.at]));
  for (const item of second.items) if (at.has(item.id)) expect(item.at).toBe(at.get(item.id)!);
  // reviews have no hub timestamp: the cut ones were first seen on the first poll and must read the same on the second
  f.live.a!.reviews = 40;
  const third = await f.inbox();
  const everything = new Map([...first.items, ...second.items].map((i) => [i.id, i.at]));
  for (const item of third.items) expect(item.at).toBe(everything.get(item.id) ?? item.at);
});

test("a project that does not answer within its budget is left out of this poll but its last rows stay, with the same `at`; the others answer on time", async () => {
  const f = fleet([{ id: "a", delayMs: 10 }, { id: "b", delayMs: 10 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 250 });
  const warm = await f.inbox();
  expect(warm.items.map((i) => i.project).sort()).toEqual(["a-project", "b-project"]);
  f.live.b!.hang = true;
  const [reply, ms] = await time(f.inbox);
  expect(ms).toBeLessThan(700);                                   // budget 250 ms, not the 5 s forward timeout
  expect(reply.items.map((i) => i.project).sort()).toEqual(["a-project", "b-project"]);
  expect(reply.items.find((i) => i.project === "b-project")!.at).toBe(warm.items.find((i) => i.project === "b-project")!.at);
});

test("a project that stopped is dropped from the rows, not kept as a stale ghost", async () => {
  const f = fleet([{ id: "a", permissions: 1 }, { id: "b", permissions: 1 }], { inboxFreshMs: 0, inboxStaleMs: 0 });
  expect((await f.inbox()).items).toHaveLength(2);
  f.live.b!.permissions = 0;
  expect((await f.inbox()).items.map((i) => i.project)).toEqual(["a-project"]);
});

test("p95 of the inbox snapshot over a realistic fleet (five projects at 150 to 350 ms, polled every 300 ms for 5 s, with a second caller each poll) is under 1 s, and the cold first poll too", async () => {
  const f = fleet([150, 200, 250, 300, 350].map((delayMs, n) => ({ id: `p${n}`, delayMs, permissions: 3, reviews: 2 })));
  const samples: number[] = [];
  const [, cold] = await time(f.inbox);
  expect(cold).toBeLessThan(1000);
  for (let poll = 0; poll < 16; poll++) {
    const [, ms] = await time(async () => { const [a] = await Promise.all([f.inbox(), f.inbox()]); return a; });
    samples.push(ms);
    await Bun.sleep(300);
  }
  const p95 = [...samples].sort((x, y) => x - y)[Math.ceil(samples.length * 0.95) - 1]!;
  expect(p95).toBeLessThan(1000);
  // the work is not repeated per request: 17 polls with a second caller each, in about 5 s, asked each project far fewer than 34 times
  expect(Math.max(...Object.values(f.asked))).toBeLessThan(34);
}, 30_000);

// The per-project fallback must not resurrect an approval the person has already given (review of PR #1200).
test("a settled approval does not come back from the per-project fallback when that project's next snapshot is late", async () => {
  const f = fleet([{ id: "a", permissions: 1 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 150 });
  expect((await f.inbox()).items).toHaveLength(1);                // warm: the fallback now holds the approval
  const preview = await f.provider.action({ action: "approve", id: "perm:a:perm-0" });
  if (!("needsConfirm" in preview)) throw new Error("expected a preview");
  expect((await f.provider.action({ action: "approve", id: "perm:a:perm-0", confirmed: true, fingerprint: String(preview.fingerprint) })).ok).toBe(true);
  f.live.a!.permissions = 0; f.live.a!.hang = true;               // settled, and the project is now slow to answer
  expect((await f.inbox()).items).toEqual([]);                    // not the pre-action row
  expect((await f.inbox()).items).toEqual([]);                    // and not on the next slow poll either
});

test("a computation that started before an action cannot repopulate the per-project fallback after it", async () => {
  // the project answers in ~120 ms, inside its 200 ms budget, so the early computation really completes and would store its row
  const f = fleet([{ id: "a", delayMs: 120, permissions: 1 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 200 });
  const early = f.inbox();                                        // asked while the approval exists
  await Bun.sleep(30);
  await f.provider.action({ action: "pause", peer: "kimi", projectId: "a", instanceId: "i-a" } as never);   // an action lands while it is in flight
  f.live.a!.permissions = 0; f.live.a!.hang = true;               // the approval is settled and the project is now slow
  await early;                                                    // finishes in an older generation: it must not write the fallback
  expect((await f.inbox()).items).toEqual([]);                    // the slow project is left out; had the early run stored its row it would come back here
});

test("a slow computation from before an action does not overwrite the newer fallback when it finally finishes", async () => {
  // The early computation reads TWO approvals on arrival and answers after 400 ms. An action lands, the hub settles one approval, and a newer computation stores ONE row.
  // When the early one finishes last it must not replace that entry with its two older rows: the next slow poll must fall back to the newer single row.
  const f = fleet([{ id: "a", delayMs: 400, permissions: 2 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 5_000 });
  const early = f.inbox();
  await Bun.sleep(40);
  await f.provider.action({ action: "pause", peer: "kimi", projectId: "a", instanceId: "i-a" } as never);
  f.live.a!.permissions = 1; f.live.a!.delayMs = 0;
  expect((await f.inbox()).items).toHaveLength(1);                // the newer generation stores one row
  await early;                                                    // the older one ends last
  // a short-budget provider cannot be swapped in, so read the fallback through a poll whose project hangs, bounded by our own timer
  f.live.a!.hang = true;
  const poll = f.inbox();
  const outcome = await Promise.race([poll, Bun.sleep(5_500).then(() => null)]);
  expect(outcome?.items).toHaveLength(1);                         // one row from the newer entry, never the older two
}, 15_000);

// #730 r1200-m1: the project listing is bounded like space()'s, and a slow one falls back to the last listing.
test("a slow project listing is bounded to half the project budget and falls back to the last listing; it is asked once while it is pending", async () => {
  const f = fleet([{ id: "a", delayMs: 10 }, { id: "b", delayMs: 10 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 400 });
  expect((await f.inbox()).items).toHaveLength(2);                // warm: the last listing holds both projects
  f.listing.delayMs = 3_000; f.listing.asked = 0;
  for (let poll = 0; poll < 3; poll++) {
    const [reply, ms] = await time(f.inbox);
    expect(ms).toBeLessThan(900);                                 // listing budget 200 ms plus the snapshots, not the 3 s listing
    expect(reply.items.map((i) => i.project).sort()).toEqual(["a-project", "b-project"]);
  }
  expect(f.listing.asked).toBe(2);                                // one listing in flight (it inspects each of the two projects once), joined by every poll
});

// #730 r1200-m2: a slow project's snapshot in flight is reused, not asked again by every poll.
test("a slow project is asked once while its snapshot is pending, across several polls, and its last rows stay meanwhile", async () => {
  const f = fleet([{ id: "a", delayMs: 0 }, { id: "slow", delayMs: 0 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 100 });
  const warm = await f.inbox();
  expect(warm.items).toHaveLength(2);
  const before = f.asked.slow!;
  f.live.slow!.delayMs = 700;
  for (let poll = 0; poll < 4; poll++) {
    const reply = await f.inbox();
    expect(reply.items.map((i) => i.project).sort()).toEqual(["a-project", "slow-project"]);   // late rows come from the last answer
    await Bun.sleep(50);
  }
  expect(f.asked.slow).toBe(before + 1);                          // four polls, one question
  expect(f.peak.slow).toBe(1);                                    // never two at once
  expect(f.asked.a).toBe(before + 4);                             // a prompt project is still asked on every poll
  await Bun.sleep(700);                                           // the pending one finishes
  f.live.slow!.delayMs = 0;
  await f.inbox();                                                // the next poll asks afresh
  expect(f.asked.slow).toBe(before + 2);
});

test("a slow project's pending snapshot is not joined across an action: the answer that began before it is never served after it", async () => {
  const f = fleet([{ id: "a", delayMs: 600, permissions: 1 }], { inboxFreshMs: 0, inboxStaleMs: 0, inboxProjectBudgetMs: 100 });
  void f.inbox();                                                 // starts the slow snapshot in generation 0
  await Bun.sleep(150);
  await f.provider.action({ action: "pause", peer: "kimi", projectId: "a", instanceId: "i-a" } as never);
  const asked = f.asked.a!;
  f.live.a!.permissions = 0;
  await f.inbox();
  expect(f.asked.a).toBe(asked + 1);                              // a new generation asks again
});
