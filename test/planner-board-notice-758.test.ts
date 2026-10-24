import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope } from "../src/hub/envelope.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import * as lifecycle from "../src/hub/sdlc.ts";

// #758: the planner's "the board changed" notice. It skips the peer whose own write changed the board, keeps one unsettled copy per planner at the
// latest revision, and costs a turn only when a card's planning revision or dependencies changed.
class Planner extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("busy"); }   // busy: an envelope for it stays queued, which is what "unsettled" means
  async stop() { this.setState("offline"); }
  idle() { this.setState("idle"); }
  busy() { this.setState("busy"); }
}
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); });

async function rig(roles: Record<string, string[]> = { claude: ["planner"], pi: ["planner"], codex: ["implementer"] }) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-planner-board-notice-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const clock = { now: 1_000_000 };
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: () => {}, now: () => clock.now, sdlc: { config: () => lifecycle.sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) } };
  const tasks = new Tasks(deps);
  board.proposalPlanner = () => ({ planner: null, plannerReason: "none" });   // legacy unbound cards: every planner holder plans them
  const taps: { env: Envelope; dropped?: string }[] = [];
  bus.tap(event => { if (event.t === "envelope" && event.env.body.startsWith("The board changed")) taps.push({ env: event.env, dropped: event.dropped }); });
  const peers: Record<string, Planner> = {};
  for (const id of Object.keys(roles).filter(peer => roles[peer]!.includes("planner"))) { peers[id] = new Planner(id); bus.add(peers[id]!); await peers[id]!.start(); }
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const pending = (peer: string) => bus.pendingEnvelopes(peer).filter(env => env.body.startsWith("The board changed"));
  const card = () => board.propose("user", { title: "planned work", class: "implement", backlog: true });
  return { board, bus, tasks, clock, taps, peers, pending, card };
}

test("the first flush tells each attached planner once, as before, and an unchanged board tells nobody again", async () => {
  const r = await rig(); r.card();
  r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(1);
  expect(r.pending("claude")[0]).toMatchObject({ kind: "task", priority: "status" });
  expect(r.pending("claude")[0]!.body).toContain("hub_planner_groom");
});

test("AC1: a planner's own plan, pull, review or assignment produces no notice to that planner, and still reaches the other planner", async () => {
  const r = await rig(); const task = r.card();
  r.tasks.flushPlannerNotices();
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);     // both have settled the first notice
  r.taps.length = 0;
  r.board.plan(task.id, "claude", { priority: 1 }, 0, "claude's own plan");                           // a planning-revision change written by claude
  r.board.update(task.id, "claude", "reviewed", { signals: ["x"] });                                  // and another write of claude's
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0);                                                       // nothing for the author
  expect(r.taps.filter(tap => tap.env.to?.includes("claude"))).toHaveLength(0);
  expect(r.pending("pi")).toHaveLength(1);                                                           // the other planner meets the planning change
  expect(r.pending("pi")[0]).toMatchObject({ priority: "status" });
});

test("AC2: N planning-revision changes while a notice is unsettled leave one notice per planner, at the latest revision", async () => {
  const r = await rig(); const task = r.card();
  r.tasks.flushPlannerNotices();
  const first = r.pending("claude")[0]!;
  for (let revision = 0; revision < 6; revision++) {
    r.board.plan(task.id, "user", { priority: revision % 2 + 1 }, revision, `change ${revision}`);
    r.tasks.flushPlannerNotices();
    expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(1);              // never more than one unsettled copy each
  }
  const latest = r.pending("claude")[0]!;
  expect(latest.id).not.toBe(first.id);                                                              // the earlier copy was replaced, not kept
  expect(latest.body).toContain(`revision ${r.board.statusRevision()}`);
  expect(r.bus.pendingEnvelopes("claude").filter(env => env.body.startsWith("The board changed"))).toHaveLength(1);
});

test("a settled notice is not replaced: a later planning change queues a new one", async () => {
  const r = await rig(); const task = r.card();
  r.tasks.flushPlannerNotices();
  r.peers.claude!.idle(); await Bun.sleep(5);                                                        // delivered
  expect(r.pending("claude")).toHaveLength(0);
  r.peers.claude!.busy();
  r.board.plan(task.id, "user", { priority: 1 }, 0, "change");
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1);
});

test("AC3: state moves, reviews and assignments cost no turn (fyi, recorded), a planning-revision or dependency change does", async () => {
  const r = await rig(); const task = r.card(), other = r.card();
  r.tasks.flushPlannerNotices();
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  r.taps.length = 0;
  r.board.update(task.id, "user", "assigned", { state: "proposed", owner: "codex" });                 // a state move and an assignment
  r.board.update(task.id, "user", "accepted", { state: "in_progress" });
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0); expect(r.pending("pi")).toHaveLength(0);              // no turn for either planner
  expect(r.taps.map(tap => [tap.env.to?.[0], tap.env.priority, tap.dropped]).sort()).toEqual([["claude", "fyi", "fyi"], ["pi", "fyi", "fyi"]]);   // recorded, not delivered
  expect(r.taps[0]!.env.body).toContain("No plan review is needed");
  r.board.plan(other.id, "user", { deps: [task.id] }, 0, "dependency");                               // a dependency change on a card
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(1);              // a turn
  expect(r.pending("claude")[0]).toMatchObject({ kind: "task", priority: "status" });
});

test("review weight for new work: a peer-proposed card with `after` is one task notice, a plain assignment of that card is fyi (claude round 1)", async () => {
  const r = await rig(); const base = r.card();
  r.tasks.flushPlannerNotices();
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  r.taps.length = 0;
  const proposed = r.board.propose("codex", { title: "an implementer's follow-up", class: "implement", deps: [base.id] });   // a peer's propose with `after`
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(1);              // new work and its dependencies need consolidating: a turn
  expect(r.pending("claude")[0]).toMatchObject({ kind: "task", priority: "status" });
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  r.taps.length = 0;
  r.board.update(proposed.id, "user", "assigned", { state: "proposed", owner: "codex" });             // a plain assignment of that card
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0); expect(r.pending("pi")).toHaveLength(0);
  expect(r.taps.map(tap => [tap.env.priority, tap.dropped])).toEqual([["fyi", "fyi"], ["fyi", "fyi"]]);
});

test("a new card with no deps, and a deps change written outside a planning entry, are both review weight; the author is still skipped", async () => {
  const r = await rig(); const base = r.card();
  r.tasks.flushPlannerNotices();
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  const plain = r.board.propose("claude", { title: "planner's own new card", class: "implement", backlog: true });
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0); expect(r.pending("pi")).toHaveLength(1);              // created by claude: only pi is told, at task weight
  for (const env of r.pending("pi")) r.bus.withdraw(env.id);
  (r.board as unknown as { db: { run(sql: string, ...args: unknown[]): void } }).db.run("UPDATE tasks SET deps=? WHERE id=?", JSON.stringify([base.id]), plain.id);   // a deps write with no planning entry
  (r.board as unknown as { db: { run(sql: string): void } }).db.run("UPDATE board_status_revision SET revision=revision+1 WHERE id=1");
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(1);
});

test("the hub's own bookkeeping entries tell nobody and spend no fyi window", async () => {
  const r = await rig({ claude: ["planner"], codex: ["implementer"] }); const task = r.card();
  r.tasks.flushPlannerNotices();
  for (const env of r.pending("claude")) r.bus.withdraw(env.id);
  r.taps.length = 0;
  r.board.update(task.id, "hub", "lifecycle linked", { signals: ["x"] });
  r.board.update(task.id, "hub", "idle sweep", { signals: ["y"] });
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0); expect(r.taps).toHaveLength(0);                       // nothing recorded, nothing delivered
  r.board.update(task.id, "user", "assigned", { state: "proposed", owner: "codex" });                 // the window is still open for a real change
  r.tasks.flushPlannerNotices();
  expect(r.taps).toHaveLength(1);
});

test("the fyi record is bounded to one per planner per ten minutes, and the clock decides", async () => {
  const r = await rig({ claude: ["planner"], codex: ["implementer"] }); const task = r.card();
  r.tasks.flushPlannerNotices();
  for (const env of r.pending("claude")) r.bus.withdraw(env.id);
  r.taps.length = 0;
  const move = (event: string, state: "proposed" | "in_progress") => r.board.update(task.id, "user", event, { state, owner: "codex" });
  move("assigned", "proposed"); r.tasks.flushPlannerNotices();
  expect(r.taps).toHaveLength(1);                                                                    // the first state change is recorded
  r.clock.now += 5 * 60_000; move("accepted", "in_progress"); r.tasks.flushPlannerNotices();
  expect(r.taps).toHaveLength(1);                                                                    // five minutes later: inside the window, so nothing new
  r.clock.now += 6 * 60_000; move("reassigned", "proposed"); r.tasks.flushPlannerNotices();
  expect(r.taps).toHaveLength(2);                                                                    // eleven minutes after the first: recorded again
  expect(r.pending("claude")).toHaveLength(0);                                                       // and never a turn
});

test("a planner that was offline during a planning change is told when it is back, and one that plans another card is not", async () => {
  const r = await rig(); const task = r.card();
  r.tasks.flushPlannerNotices();
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  await r.peers.pi!.stop();                                                                          // offline: not attached
  r.board.plan(task.id, "user", { priority: 1 }, 0, "change while pi is away");
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1);
  await r.peers.pi!.start(); r.bus.add(r.peers.pi!);
  r.tasks.flushPlannerNotices();
  expect(r.pending("pi")).toHaveLength(1);                                                           // the change was kept for it
  const bound = r.board.propose("user", { title: "claude's card", class: "implement", backlog: true, planner: "claude", plannerReason: "rotation" });
  for (const peer of ["claude", "pi"]) for (const env of r.pending(peer)) r.bus.withdraw(env.id);
  r.board.plan(bound.id, "user", { priority: 2 }, 0, "change on a card pi does not plan");
  r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(1); expect(r.pending("pi")).toHaveLength(0);              // the task_planners scoping (#525-2) holds
});

test("with the lifecycle off no board-changed notice is sent at all", async () => {
  const r = await rig();
  (r.tasks as unknown as { d: TasksDeps }).d.sdlc = { config: () => lifecycle.sdlcConfig({ mode: "off" }), gh: async () => ({ code: 1, stdout: "" }) };
  const task = r.card(); r.tasks.flushPlannerNotices();
  r.board.plan(task.id, "user", { priority: 1 }, 0, "change"); r.tasks.flushPlannerNotices();
  expect(r.pending("claude")).toHaveLength(0); expect(r.taps).toHaveLength(0);
});
